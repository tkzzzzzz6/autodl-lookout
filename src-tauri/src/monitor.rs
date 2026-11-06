//! 后台轮询：库存 → 历史 → 规则 → 通知/自动动作；余额、长时间运行提醒。

use crate::api::{Balance, Client, CreateInstanceReq, StockItem, StockQuery};
use crate::market::{sum_filtered, MarketClient, MarketRegion};
use crate::regions::{region_name, PRO_REGIONS};
use crate::store::{Rule, Store};
use chrono::{Local, TimeZone};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn local_midnight_ts() -> i64 {
    let today = Local::now().date_naive().and_hms_opt(0, 0, 0).unwrap();
    Local.from_local_datetime(&today).earliest().map(|d| d.timestamp()).unwrap_or_else(now)
}

// ---------------------------------------------------------------- pure logic

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RuleMatch {
    pub matched: Vec<StockItem>,
    pub idle_sum: i64,
}

/// 规则命中判断：卡型关键字（不区分大小写子串）匹配到的空闲卡数之和 >= min_idle
pub fn match_rule(rule: &Rule, items: &[StockItem]) -> Option<RuleMatch> {
    let kw = rule.gpu_keyword.trim().to_lowercase();
    let matched: Vec<StockItem> = items
        .iter()
        .filter(|i| kw.is_empty() || i.gpu_name.to_lowercase().contains(&kw))
        .filter(|i| i.idle > 0)
        .cloned()
        .collect();
    let idle_sum: i64 = matched.iter().map(|i| i.idle).sum();
    if idle_sum >= rule.min_idle.max(1) {
        Some(RuleMatch { matched, idle_sum })
    } else {
        None
    }
}

/// 命中结果里满足条件的机器台数（只有按机器统计时才有）
pub fn machines_of(m: &RuleMatch) -> Option<i64> {
    let v: Vec<i64> = m.matched.iter().filter_map(|i| i.machines).collect();
    if v.is_empty() { None } else { Some(v.iter().sum()) }
}

pub fn in_cooldown(rule: &Rule, now: i64) -> bool {
    rule.last_fired_at.map(|t| now - t < rule.cooldown_minutes.max(0) * 60).unwrap_or(false)
}

/// 规则对应的库存查询（带 CUDA / 价格过滤时需要单独查）
pub fn rule_query(rule: &Rule) -> StockQuery {
    StockQuery {
        region_sign: rule.region_sign.clone(),
        cuda_v_from: rule.cuda_v_from,
        price_to: rule.max_price_yuan.map(|p| (p * 1000.0).round() as i64),
        gpu_name_set: None,
    }
}

/// 规则对应的查询结果键：区域、最低 CUDA、单价上限（元 × 1000）、单机至少几卡、卡型关键字（去空格转小写）。
/// 按机器列出时只请求关键字匹配到的卡型，所以关键字必须在键里，
/// 否则 `4090D` 和 `4090` 两条规则会共用只含 4090D 的结果。
/// 区域汇总数据的键见 `region_key`。
pub fn rule_key(rule: &Rule) -> QKey {
    let q = rule_query(rule);
    (q.region_sign, q.cuda_v_from, q.price_to, rule.min_per_machine.max(1), rule.gpu_keyword.trim().to_lowercase())
}

/// 区域汇总数据（gpu_type，算力市场顶部那排数字）的键
pub fn region_key(region: &str) -> QKey {
    (region.to_string(), None, None, 1, String::new())
}

/// 规则是否需要按机器列出（汇总数据不够用）
pub fn needs_machines(rule: &Rule) -> bool {
    rule.max_price_yuan.is_some() || rule.cuda_v_from.is_some() || rule.min_per_machine > 1
}

/// 本轮需要发出的全部查询（去重）
pub fn plan_queries(regions: &[String], rules: &[Rule]) -> Vec<StockQuery> {
    let mut set: BTreeSet<(String, Option<i64>, Option<i64>)> = BTreeSet::new();
    for r in regions {
        set.insert((r.clone(), None, None));
    }
    for r in rules.iter().filter(|r| r.enabled) {
        let q = rule_query(r);
        set.insert((q.region_sign, q.cuda_v_from, q.price_to));
    }
    set.into_iter()
        .map(|(region_sign, cuda_v_from, price_to)| StockQuery { region_sign, cuda_v_from, price_to, gpu_name_set: None })
        .collect()
}

pub fn next_backoff(current_secs: u64, base_secs: u64, ok: bool) -> u64 {
    if ok {
        base_secs
    } else {
        (current_secs.max(base_secs) * 2).min(600)
    }
}

// ---------------------------------------------------------------- state

#[derive(Debug, Clone, Serialize, Default)]
pub struct RegionStock {
    pub region: String,
    pub region_name: String,
    pub items: Vec<StockItem>,
    pub error: Option<String>,
    /// 算力市场链接（预选这个区域），用于「去租」按钮
    pub market_url: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct RuleState {
    pub rule_id: i64,
    pub hit: bool,
    pub idle_sum: i64,
    /// 按机器统计时，满足条件的机器台数
    pub machines: Option<i64>,
    pub matched: Vec<String>,
    pub error: Option<String>,
    pub market_url: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Snapshot {
    pub has_token: bool,
    pub has_web_token: bool,
    pub web_token_exp: Option<i64>,
    pub paused: bool,
    pub running: bool,
    pub last_run_at: Option<i64>,
    pub next_run_at: Option<i64>,
    pub last_error: Option<String>,
    pub interval_secs: u64,
    pub regions: Vec<RegionStock>,
    pub rules: Vec<RuleState>,
    pub balance: Option<Balance>,
    pub balance_at: Option<i64>,
}

pub struct Monitor {
    pub store: Arc<Store>,
    token: RwLock<Option<String>>,
    web_token: RwLock<Option<String>>,
    regions_cache: RwLock<(i64, Vec<MarketRegion>)>,
    snapshot: RwLock<Snapshot>,
    wake: Notify,
    paused: AtomicBool,
    last_instances_check: RwLock<i64>,
    last_prune: RwLock<i64>,
}

pub type QKey = (String, Option<i64>, Option<i64>, i64, String);

impl Monitor {
    pub fn new(store: Arc<Store>, token: Option<String>, web_token: Option<String>) -> Arc<Self> {
        Arc::new(Self {
            store,
            token: RwLock::new(token),
            web_token: RwLock::new(web_token),
            regions_cache: RwLock::new((0, vec![])),
            snapshot: RwLock::new(Snapshot::default()),
            wake: Notify::new(),
            paused: AtomicBool::new(false),
            last_instances_check: RwLock::new(0),
            last_prune: RwLock::new(0),
        })
    }

    pub fn client(&self) -> Option<Client> {
        self.token.read().unwrap().clone().map(Client::new)
    }

    pub fn market(&self) -> Option<MarketClient> {
        self.web_token.read().unwrap().clone().map(MarketClient::new)
    }

    pub fn set_token(&self, token: Option<String>) {
        *self.token.write().unwrap() = token;
        self.trigger();
    }

    pub fn set_web_token(&self, token: Option<String>) {
        *self.web_token.write().unwrap() = token;
        *self.regions_cache.write().unwrap() = (0, vec![]);
        self.trigger();
    }

    pub fn trigger(&self) {
        self.wake.notify_one();
    }

    pub fn set_paused(&self, p: bool) {
        self.paused.store(p, Ordering::SeqCst);
        self.trigger();
    }

    pub fn snapshot(&self) -> Snapshot {
        let mut s = self.snapshot.read().unwrap().clone();
        s.has_token = self.token.read().unwrap().is_some();
        let web = self.web_token.read().unwrap().clone();
        s.has_web_token = web.is_some();
        s.web_token_exp = web.as_deref().and_then(crate::market::jwt_exp);
        s.paused = self.paused.load(Ordering::SeqCst);
        s
    }

    fn update<F: FnOnce(&mut Snapshot)>(&self, app: &AppHandle, f: F) {
        {
            let mut s = self.snapshot.write().unwrap();
            f(&mut s);
        }
        let _ = app.emit("snapshot", self.snapshot());
    }

    fn log(&self, level: &str, kind: &str, rule_id: Option<i64>, msg: &str) {
        let _ = self.store.log(now(), level, kind, rule_id, msg);
    }

    pub fn spawn(self: &Arc<Self>, app: AppHandle) {
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut wait = me.store.settings().poll_interval_secs;
            loop {
                let base = me.store.settings().poll_interval_secs.max(30);
                let ok = if me.paused.load(Ordering::SeqCst) { true } else { me.tick(&app).await };
                wait = next_backoff(wait, base, ok);
                let next = now() + wait as i64;
                me.update(&app, |s| {
                    s.next_run_at = Some(next);
                    s.interval_secs = wait;
                });
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(wait)) => {},
                    _ = me.wake.notified() => {},
                }
            }
        });
    }

    /// data_center（westDC3 …）→ 机房列表，区域表每小时刷新一次
    async fn region_signs(&self, m: &MarketClient) -> Result<Vec<MarketRegion>, String> {
        let (at, cached) = self.regions_cache.read().unwrap().clone();
        if !cached.is_empty() && now() - at < 3600 {
            return Ok(cached);
        }
        let fresh = m.regions().await.map_err(|e| e.to_string())?;
        *self.regions_cache.write().unwrap() = (now(), fresh.clone());
        Ok(fresh)
    }

    /// 用缓存的区域表拼算力市场链接；还没拿到区域表时退回不带区域的链接
    fn market_url_of(&self, data_center: &str) -> String {
        let cache = self.regions_cache.read().unwrap();
        let signs = cache.1.iter().find(|r| r.data_center == data_center).map(|r| r.signs.clone()).unwrap_or_default();
        crate::market::market_url(&signs)
    }

    /// 查算力市场库存。返回 (查询结果, 是否有一次成功, 第一条错误)
    async fn fetch_market(&self, m: &MarketClient, regions: &[String], rules: &[Rule])
        -> (HashMap<QKey, Result<Vec<StockItem>, String>>, bool, Option<String>) {
        let mut results: HashMap<QKey, Result<Vec<StockItem>, String>> = HashMap::new();
        let map = match self.region_signs(m).await {
            Ok(v) => v,
            Err(e) => return (results, false, Some(format!("读取区域列表失败：{e}"))),
        };
        let signs_of = |dc: &str| map.iter().find(|r| r.data_center == dc).map(|r| r.signs.clone());
        let (mut any_ok, mut first_err) = (false, None::<String>);

        // 每个区域一次 gpu_type（算力市场顶部那排数字）
        for (i, region) in regions.iter().enumerate() {
            if i > 0 {
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
            let r = match signs_of(region) {
                None => Err(format!("算力市场里没有区域 {region}")),
                Some(signs) => m.gpu_types(&signs).await.map_err(|e| e.to_string()),
            };
            match &r {
                Ok(_) => any_ok = true,
                Err(e) => { first_err.get_or_insert_with(|| format!("算力市场（{}）查询失败：{e}", region_name(region))); }
            }
            results.insert(region_key(region), r);
        }

        // 带单价 / CUDA / 单机卡数条件的规则：按机器列出再过滤求和
        let mut done: BTreeSet<QKey> = BTreeSet::new();
        for rule in rules.iter().filter(|r| needs_machines(r)) {
            let key = rule_key(rule);
            if !done.insert(key.clone()) {
                continue;
            }
            let base = results.get(&region_key(&rule.region_sign)).cloned();
            let r = match (base, signs_of(&rule.region_sign)) {
                (Some(Ok(items)), Some(signs)) => {
                    let kw = rule.gpu_keyword.trim().to_lowercase();
                    // 区域里这个卡型的空闲总数都不够 N 张时，不可能有单台满足，省掉一次请求
                    let names: Vec<String> = items.iter()
                        .filter(|i| i.idle >= rule.min_per_machine.max(1) && (kw.is_empty() || i.gpu_name.to_lowercase().contains(&kw)))
                        .map(|i| i.gpu_name.clone()).collect();
                    if names.is_empty() {
                        Ok(vec![])
                    } else {
                        tokio::time::sleep(Duration::from_millis(300)).await;
                        m.machines(&signs, &names).await
                            .map(|slots| sum_filtered(&slots, rule.max_price_yuan, rule.cuda_v_from, rule.min_per_machine))
                            .map_err(|e| e.to_string())
                    }
                }
                (Some(Err(e)), _) => Err(e),
                _ => Err(format!("算力市场里没有区域 {}", rule.region_sign)),
            };
            results.insert(key, r);
        }
        (results, any_ok, first_err)
    }

    /// 返回本轮是否成功（用于退避）
    pub async fn tick(&self, app: &AppHandle) -> bool {
        let client = self.client();
        let market = self.market();
        if client.is_none() && market.is_none() {
            self.update(app, |s| s.last_error = Some("还没有填写凭证，请到「设置」里填写".into()));
            return true;
        }
        self.update(app, |s| s.running = true);
        let settings = self.store.settings();
        let rules: Vec<Rule> = self.store.rules().unwrap_or_default().into_iter().filter(|r| r.enabled).collect();
        let ts = now();

        // 1) 库存（算力市场）
        let mut regions: Vec<String> = settings.regions.clone();
        for r in &rules {
            if !regions.contains(&r.region_sign) {
                regions.push(r.region_sign.clone());
            }
        }
        let (results, any_ok, first_err) = match &market {
            Some(m) => self.fetch_market(m, &regions, &rules).await,
            None => (HashMap::new(), false, Some("未设置网页登录凭证，无法查询算力市场库存，请到「设置」里填写".to_string())),
        };

        let mut region_stocks = Vec::new();
        for region in &settings.regions {
            let r = results.get(&region_key(region)).cloned()
                .unwrap_or_else(|| Err(first_err.clone().unwrap_or_default()));
            if let Ok(items) = &r {
                let _ = self.store.insert_history(ts, region, items);
            }
            region_stocks.push(RegionStock {
                region: region.clone(),
                region_name: region_name(region),
                items: r.clone().unwrap_or_default(),
                error: r.err().filter(|e| !e.is_empty()),
                market_url: self.market_url_of(region),
            });
        }
        // 规则用到但不在看板区域里的，也记历史
        for region in regions.iter().filter(|r| !settings.regions.contains(r)) {
            if let Some(Ok(items)) = results.get(&region_key(region)) {
                let _ = self.store.insert_history(ts, region, items);
            }
        }

        // 2) 规则
        let mut rule_states = Vec::new();
        let mut hits = 0;
        for rule in &rules {
            let res = results.get(&rule_key(rule));
            let mut st = RuleState { rule_id: rule.id, market_url: self.market_url_of(&rule.region_sign), ..Default::default() };
            match res {
                Some(Ok(items)) => {
                    if let Some(m) = match_rule(rule, items) {
                        st.hit = true;
                        st.idle_sum = m.idle_sum;
                        st.machines = machines_of(&m);
                        st.matched = m.matched.iter().map(|i| format!("{}×{}", i.gpu_name, i.idle)).collect();
                        hits += 1;
                        if !in_cooldown(rule, ts) {
                            let _ = self.store.mark_rule_fired(rule.id, ts);
                            self.fire(app, client.as_ref(), rule, &m, &settings).await;
                        }
                    }
                }
                Some(Err(e)) => st.error = Some(e.clone()),
                None => st.error = first_err.clone(),
            }
            rule_states.push(st);
        }
        crate::tray::set_hits(app, hits);

        // 3) 余额（每 5 分钟；优先网页凭证，没有再用开发者 Token）
        let need_balance = self.snapshot.read().unwrap().balance_at.map(|t| ts - t >= 300).unwrap_or(true);
        if need_balance {
            let b = match (&market, &client) {
                (Some(m), _) => m.wallet().await.ok(),
                (None, Some(c)) => c.balance().await.ok(),
                _ => None,
            };
            if let Some(b) = b {
                self.check_low_balance(app, &b, settings.low_balance_yuan);
                self.update(app, |s| {
                    s.balance = Some(b);
                    s.balance_at = Some(ts);
                });
            }
        }
        // 4) 长时间运行的实例（每 5 分钟）：普通实例用网页凭证，Pro 实例用开发者 Token
        let last_inst = *self.last_instances_check.read().unwrap();
        if ts - last_inst >= 300 && (market.is_some() || client.is_some()) {
            *self.last_instances_check.write().unwrap() = ts;
            self.check_long_running(app, market.as_ref(), client.as_ref(), settings.long_running_hours).await;
        }

        // 5) 网页凭证快过期时提醒一次
        if let Some(exp) = self.web_token.read().unwrap().as_deref().and_then(crate::market::jwt_exp) {
            if exp - ts < 3 * 86400 {
                let key = format!("web_exp_alert:{exp}");
                if self.store.kv_get(&key).ok().flatten().is_none() {
                    let msg = if exp <= ts { "网页登录凭证已过期，库存查询会失败".to_string() } else { format!("网页登录凭证将在 {:.0} 小时后过期", (exp - ts) as f64 / 3600.0) };
                    self.log("warn", "poll", None, &format!("{msg}，请到「设置」里重新粘贴"));
                    crate::notify::send(app, "请更新网页登录凭证", &msg);
                    let _ = self.store.kv_set(&key, "1");
                }
            }
        }

        // 6) 清理历史（每小时）
        let last_prune = *self.last_prune.read().unwrap();
        if ts - last_prune >= 3600 {
            *self.last_prune.write().unwrap() = ts;
            let _ = self.store.prune(settings.history_keep_days, ts);
        }

        let err = if any_ok || regions.is_empty() { None } else { first_err.clone() };
        if let Some(e) = &err {
            self.log("error", "poll", None, e);
        }
        self.update(app, |s| {
            s.running = false;
            s.last_run_at = Some(ts);
            s.last_error = err.clone();
            s.regions = region_stocks;
            s.rules = rule_states;
        });
        err.is_none()
    }

    async fn fire(&self, app: &AppHandle, client: Option<&Client>, rule: &Rule, m: &RuleMatch, settings: &crate::store::Settings) {
        let mut what = m.matched.iter().map(|i| format!("{} 空闲 {}", i.gpu_name, i.idle)).collect::<Vec<_>>().join("，");
        if rule.min_per_machine > 1 {
            if let Some(n) = machines_of(m) {
                what = format!("{n} 台机器可开 {} 卡（{what}）", rule.min_per_machine);
            }
        }
        let title = format!("有卡了：{}", rule.name);
        let body = format!("{} · {}", region_name(&rule.region_sign), what);
        self.log("info", "alert", Some(rule.id), &format!("{title} — {body}"));
        crate::notify::send(app, &title, &body);

        if rule.action == "notify" {
            return;
        }

        // ---- 自动动作，层层把关 ----
        let Some(client) = client else {
            self.log("warn", "skip", Some(rule.id), "自动开机 / 创建只支持容器实例 Pro，需要在「设置」里填写开发者 Token，已跳过");
            return;
        };
        let used = self.store.auto_actions_since(rule.id, local_midnight_ts()).unwrap_or(0);
        if used >= rule.daily_limit.max(0) {
            self.log("warn", "skip", Some(rule.id), &format!("今日自动动作已达上限 {}，跳过", rule.daily_limit));
            return;
        }
        match client.balance().await {
            Ok(b) if b.assets < settings.auto_min_balance_yuan => {
                self.log(
                    "warn",
                    "skip",
                    Some(rule.id),
                    &format!("余额 {:.2} 元低于自动动作下限 {:.2} 元，跳过", b.assets, settings.auto_min_balance_yuan),
                );
                return;
            }
            Err(e) => {
                self.log("warn", "skip", Some(rule.id), &format!("无法确认余额（{e}），跳过自动动作"));
                return;
            }
            _ => {}
        }

        let result: Result<String, String> = match rule.action.as_str() {
            "create" => match rule.template_id.and_then(|id| self.store.template(id).ok().flatten()) {
                None => Err("规则未绑定有效的创建模板".into()),
                Some(t) => {
                    let dcl = if PRO_REGIONS.iter().any(|r| r.value == rule.region_sign) {
                        vec![rule.region_sign.clone()]
                    } else {
                        t.data_center_list.clone()
                    };
                    let req = CreateInstanceReq {
                        data_center_list: dcl,
                        req_gpu_amount: t.gpu_amount,
                        expand_system_disk_by_gb: t.expand_disk_gb,
                        gpu_spec_uuid: t.gpu_spec_uuid.clone(),
                        image_uuid: t.image_uuid.clone(),
                        cuda_v_from: t.cuda_v_from,
                        instance_name: t.instance_name.clone(),
                        start_command: t.start_command.clone(),
                    };
                    client.create_instance(&req).await.map(|id| format!("已创建实例 {id}")).map_err(|e| e.to_string())
                }
            },
            "power_on" => match rule.instance_uuid.as_deref().filter(|s| !s.is_empty()) {
                None => Err("规则未填写要开机的实例 ID".into()),
                Some(uuid) => client.power_on(uuid, None).await.map(|_| format!("已开机 {uuid}")).map_err(|e| e.to_string()),
            },
            other => Err(format!("未知动作 {other}")),
        };
        match result {
            Ok(msg) => {
                self.log("info", "auto", Some(rule.id), &msg);
                crate::notify::send(app, "自动抢卡成功", &msg);
            }
            Err(e) => {
                self.log("error", "auto", Some(rule.id), &format!("自动动作失败：{e}"));
                crate::notify::send(app, "自动抢卡失败", &e);
            }
        }
    }

    fn check_low_balance(&self, app: &AppHandle, b: &Balance, threshold: f64) {
        let alerted = self.store.kv_get("low_balance_alerted").ok().flatten().as_deref() == Some("1");
        if b.assets < threshold {
            if !alerted {
                let msg = format!("当前余额 {:.2} 元，低于 {:.2} 元", b.assets, threshold);
                self.log("warn", "balance", None, &msg);
                crate::notify::send(app, "AutoDL 余额不足", &msg);
                let _ = self.store.kv_set("low_balance_alerted", "1");
            }
        } else if alerted {
            let _ = self.store.kv_set("low_balance_alerted", "0");
        }
    }

    async fn check_long_running(&self, app: &AppHandle, market: Option<&MarketClient>, client: Option<&Client>, hours: f64) {
        if hours <= 0.0 {
            return;
        }
        // (uuid, 名称, 开机时间)
        let mut running: Vec<(String, String, i64)> = Vec::new();
        if let Some(m) = market {
            if let Ok(list) = m.instances().await {
                running.extend(list.into_iter().filter(|i| i.status == "running").filter_map(|i| {
                    let name = if i.name.is_empty() { format!("{} {}", i.region_name, i.machine_alias).trim().to_string() } else { i.name };
                    i.started_at.map(|t| (i.uuid, name, t))
                }));
            }
        }
        if let Some(c) = client {
            if let Ok(data) = c.list_instances(1, 100).await {
                for inst in data.get("list").and_then(|l| l.as_array()).cloned().unwrap_or_default() {
                    if inst.get("status").and_then(|s| s.as_str()) != Some("running") {
                        continue;
                    }
                    let Some(started) = parse_time_field(inst.get("started_at")) else { continue };
                    let uuid = inst.get("uuid").and_then(|s| s.as_str()).unwrap_or("?").to_string();
                    let name = inst.get("name").and_then(|s| s.as_str()).filter(|s| !s.is_empty()).unwrap_or(&uuid).to_string();
                    running.push((uuid, name, started));
                }
            }
        }
        let ts = now();
        for (uuid, name, started) in running {
            let ran_h = (ts - started) as f64 / 3600.0;
            if ran_h < hours {
                continue;
            }
            let key = format!("long_alert:{uuid}:{started}");
            if self.store.kv_get(&key).ok().flatten().is_some() {
                continue;
            }
            let name = if name.is_empty() { uuid.clone() } else { name };
            let msg = format!("{name} 已连续运行 {ran_h:.1} 小时，记得关机");
            self.log("warn", "long_running", None, &msg);
            crate::notify::send(app, "实例运行时间较长", &msg);
            let _ = self.store.kv_set(&key, "1");
        }
    }
}

/// 时间字段形如 `{"Time": "2025-01-01T10:00:00+08:00", "Valid": true}`
pub fn parse_time_field(v: Option<&serde_json::Value>) -> Option<i64> {
    let v = v?;
    if v.get("Valid").and_then(|b| b.as_bool()) == Some(false) {
        return None;
    }
    let s = v.get("Time").and_then(|t| t.as_str()).or_else(|| v.as_str())?;
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(kw: &str, min: i64) -> Rule {
        Rule {
            id: 1,
            name: "t".into(),
            enabled: true,
            region_sign: "westDC3".into(),
            gpu_keyword: kw.into(),
            min_idle: min,
            cuda_v_from: None,
            max_price_yuan: None,
            cooldown_minutes: 15,
            action: "notify".into(),
            template_id: None,
            instance_uuid: None,
            daily_limit: 1,
            last_fired_at: None,
            min_per_machine: 1,
        }
    }

    fn items() -> Vec<StockItem> {
        vec![
            StockItem { gpu_name: "RTX 4090".into(), idle: 2, total: 100, machines: None },
            StockItem { gpu_name: "RTX 4090D".into(), idle: 1, total: 50, machines: None },
            StockItem { gpu_name: "RTX 5090".into(), idle: 0, total: 40, machines: None },
        ]
    }

    #[test]
    fn keyword_match_sums_variants() {
        let m = match_rule(&rule("4090", 3), &items()).unwrap();
        assert_eq!(m.idle_sum, 3);
        assert_eq!(m.matched.len(), 2);
        assert!(match_rule(&rule("4090", 4), &items()).is_none());
        assert!(match_rule(&rule("5090", 1), &items()).is_none());
        assert!(match_rule(&rule("rtx 4090d", 1), &items()).is_some(), "case-insensitive");
    }

    #[test]
    fn cooldown() {
        let mut r = rule("4090", 1);
        assert!(!in_cooldown(&r, 1000));
        r.last_fired_at = Some(1000);
        assert!(in_cooldown(&r, 1000 + 14 * 60));
        assert!(!in_cooldown(&r, 1000 + 15 * 60));
    }

    #[test]
    fn query_planning_dedups_and_adds_filtered() {
        let mut r2 = rule("5090", 1);
        r2.max_price_yuan = Some(3.5);
        let qs = plan_queries(&["westDC3".into(), "beijingDC2".into()], &[rule("4090", 1), r2]);
        assert_eq!(qs.len(), 3);
        assert!(qs.iter().any(|q| q.price_to == Some(3500)));
    }

    #[test]
    fn per_machine_rules_use_machine_listing() {
        let plain = rule("4090", 1);
        assert!(!needs_machines(&plain));
        assert_eq!(rule_key(&plain), ("westDC3".into(), None, None, 1, "4090".into()));
        let mut multi = rule("4090", 1);
        multi.min_per_machine = 2;
        assert!(needs_machines(&multi));
        assert_eq!(rule_key(&multi), ("westDC3".into(), None, None, 2, "4090".into()));
        // 机器统计结果：两台机器可开 2 卡
        let items = vec![StockItem { gpu_name: "RTX 4090".into(), idle: 6, total: 0, machines: Some(2) }];
        let m = match_rule(&multi, &items).unwrap();
        assert_eq!(machines_of(&m), Some(2));
        assert_eq!(machines_of(&match_rule(&plain, &self::tests::items()).unwrap()), None);
    }

    #[test]
    fn machine_query_key_includes_keyword() {
        // 同区域、同条件、单机都要 2 卡，但关键字不同：必须分开查，否则 4090 规则会拿到只含 4090D 的结果
        let mut a = rule("4090D", 1);
        a.min_per_machine = 2;
        let mut b = rule(" 4090 ", 1);
        b.min_per_machine = 2;
        assert_ne!(rule_key(&a), rule_key(&b));
        // 关键字大小写、首尾空格不同但实际相同时仍然共用一次查询
        let mut c = rule("4090", 1);
        c.min_per_machine = 2;
        assert_eq!(rule_key(&b), rule_key(&c));
        let mut d = rule("rtx 4090", 1);
        d.min_per_machine = 2;
        let mut e = rule("RTX 4090", 1);
        e.min_per_machine = 2;
        assert_eq!(rule_key(&d), rule_key(&e));
        assert_ne!(rule_key(&b), region_key("westDC3"));
    }

    #[test]
    fn backoff() {
        assert_eq!(next_backoff(60, 60, false), 120);
        assert_eq!(next_backoff(480, 60, false), 600);
        assert_eq!(next_backoff(600, 60, true), 60);
    }

    #[test]
    fn time_field() {
        let v = serde_json::json!({"Time": "2025-01-01T10:00:00+08:00", "Valid": true});
        assert_eq!(parse_time_field(Some(&v)), Some(1735696800));
        let v = serde_json::json!({"Time": "0001-01-01T00:00:00Z", "Valid": false});
        assert_eq!(parse_time_field(Some(&v)), None);
    }
}
