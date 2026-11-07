use crate::api::{Balance, Client, CreateInstanceReq, StockItem, StockQuery};
use crate::monitor::{now, Snapshot};
use crate::store::{HistoryPoint, LogEntry, Rule, Settings, Template};
use crate::{secret, AppState};
use serde::Serialize;
use serde_json::Value;
use tauri::State;

type R<T> = Result<T, String>;

fn client(st: &State<AppState>) -> R<Client> {
    st.monitor.client().ok_or_else(|| "这个功能用于容器实例 Pro，需要先在「设置 → 容器实例 Pro（可选）」里填写开发者 Token".to_string())
}

fn market(st: &State<AppState>) -> R<crate::market::MarketClient> {
    st.monitor.market().ok_or_else(|| "还没有填写网页登录凭证，请到「设置」里粘贴".to_string())
}

fn s<E: ToString>(e: E) -> String {
    e.to_string()
}

// ---------- token ----------

#[derive(Serialize)]
pub struct TokenSaved {
    pub balance: Balance,
    pub in_keychain: bool,
}

/// 先用余额接口校验 Token，通过后再保存
#[tauri::command]
pub async fn set_token(st: State<'_, AppState>, token: String) -> R<TokenSaved> {
    let token = crate::api::clean_token(&token);
    if token.is_empty() {
        return Err("Token 不能为空".into());
    }
    let balance = Client::new(token.clone()).balance().await.map_err(s)?;
    let in_keychain = secret::save(&st.store, secret::Kind::Dev, &token)?;
    st.monitor.set_token(Some(token));
    Ok(TokenSaved { balance, in_keychain })
}

#[tauri::command]
pub fn clear_token(st: State<'_, AppState>) {
    secret::clear(&st.store, secret::Kind::Dev);
    st.monitor.set_token(None);
}

#[derive(Serialize)]
pub struct WebTokenSaved {
    pub regions: usize,
    pub exp: Option<i64>,
    pub in_keychain: bool,
}

/// 网页登录凭证：先读一次区域列表确认可用，再保存
#[tauri::command]
pub async fn set_web_token(st: State<'_, AppState>, token: String) -> R<WebTokenSaved> {
    let token = crate::api::clean_token(&token);
    if token.is_empty() {
        return Err("凭证不能为空".into());
    }
    if token.split('.').count() != 3 {
        return Err("这看起来不是网页登录凭证（应该是三段用点分隔的长字符串）。开发者 Token 请填在上面一栏".into());
    }
    let regions = crate::market::MarketClient::new(token.clone()).regions().await.map_err(s)?;
    if regions.is_empty() {
        return Err("凭证可用，但没有读到任何区域".into());
    }
    let in_keychain = secret::save(&st.store, secret::Kind::Web, &token)?;
    let exp = crate::market::jwt_exp(&token);
    st.monitor.set_web_token(Some(token));
    Ok(WebTokenSaved { regions: regions.len(), exp, in_keychain })
}

#[tauri::command]
pub fn clear_web_token(st: State<'_, AppState>) {
    secret::clear(&st.store, secret::Kind::Web);
    st.monitor.set_web_token(None);
}

// ---------- monitor ----------

#[tauri::command]
pub fn get_snapshot(st: State<'_, AppState>) -> Snapshot {
    st.monitor.snapshot()
}

#[tauri::command]
pub fn refresh_now(st: State<'_, AppState>) {
    st.monitor.trigger();
}

#[tauri::command]
pub fn set_paused(st: State<'_, AppState>, paused: bool) {
    st.monitor.set_paused(paused);
}

#[tauri::command]
pub fn ref_data() -> crate::regions::RefData {
    crate::regions::ref_data()
}

#[tauri::command]
pub async fn query_stock(st: State<'_, AppState>, query: StockQuery) -> R<Vec<StockItem>> {
    client(&st)?.gpu_stock(&query).await.map_err(s)
}

#[tauri::command]
pub fn stock_history(st: State<'_, AppState>, region: String, gpu_name: String, hours: i64) -> R<Vec<HistoryPoint>> {
    st.store.history(&region, &gpu_name, now() - hours.max(1) * 3600)
}

/// 抢卡时段分析：days = 0 表示用全部保留的历史
#[tauri::command]
pub fn stock_heatmap(st: State<'_, AppState>, region: String, keyword: String, days: i64) -> R<crate::heatmap::Heatmap> {
    let since = if days > 0 { now() - days * 86400 } else { 0 };
    let pts = st.store.idle_series(&region, &keyword, since)?;
    Ok(crate::heatmap::build(&pts, &chrono::Local))
}

#[tauri::command]
pub fn history_gpus(st: State<'_, AppState>, region: String) -> R<Vec<String>> {
    st.store.history_gpus(&region)
}

#[tauri::command]
pub async fn get_balance(st: State<'_, AppState>) -> R<Balance> {
    if let Some(m) = st.monitor.market() {
        return m.wallet().await.map_err(s);
    }
    client(&st)?.balance().await.map_err(s)
}

// ---------- settings ----------

#[tauri::command]
pub fn get_settings(st: State<'_, AppState>) -> Settings {
    st.store.settings()
}

#[tauri::command]
pub fn save_settings(st: State<'_, AppState>, settings: Settings) -> R<()> {
    st.store.save_settings(&settings)?;
    st.monitor.trigger();
    Ok(())
}

// ---------- rules ----------

#[tauri::command]
pub fn list_rules(st: State<'_, AppState>) -> R<Vec<Rule>> {
    st.store.rules()
}

#[tauri::command]
pub fn save_rule(st: State<'_, AppState>, rule: Rule) -> R<i64> {
    if rule.action == "create" && rule.template_id.is_none() {
        return Err("「自动创建实例」需要选择一个创建模板".into());
    }
    if rule.action == "power_on" && rule.instance_uuid.as_deref().unwrap_or("").trim().is_empty() {
        return Err("「自动开机」需要填写实例 ID".into());
    }
    let id = st.store.save_rule(rule)?;
    st.monitor.trigger();
    Ok(id)
}

#[tauri::command]
pub fn delete_rule(st: State<'_, AppState>, id: i64) -> R<()> {
    st.store.delete_rule(id)
}

// ---------- templates ----------

#[tauri::command]
pub fn list_templates(st: State<'_, AppState>) -> R<Vec<Template>> {
    st.store.templates()
}

#[tauri::command]
pub fn save_template(st: State<'_, AppState>, template: Template) -> R<i64> {
    if !(1..=4).contains(&template.gpu_amount) {
        return Err("GPU 数量需在 1–4 之间".into());
    }
    if !(0..=500).contains(&template.expand_disk_gb) {
        return Err("扩容系统盘需在 0–500 GB 之间".into());
    }
    st.store.save_template(template)
}

#[tauri::command]
pub fn delete_template(st: State<'_, AppState>, id: i64) -> R<()> {
    st.store.delete_template(id)
}

#[tauri::command]
pub async fn create_from_template(st: State<'_, AppState>, id: i64) -> R<String> {
    let t = st.store.template(id)?.ok_or("模板不存在")?;
    let req = CreateInstanceReq {
        data_center_list: t.data_center_list,
        req_gpu_amount: t.gpu_amount,
        expand_system_disk_by_gb: t.expand_disk_gb,
        gpu_spec_uuid: t.gpu_spec_uuid,
        image_uuid: t.image_uuid,
        cuda_v_from: t.cuda_v_from,
        instance_name: t.instance_name,
        start_command: t.start_command,
    };
    let id = client(&st)?.create_instance(&req).await.map_err(s)?;
    let _ = st.store.log(now(), "info", "manual", None, &format!("手动创建实例 {id}（模板 {}）", t.name));
    Ok(id)
}

// ---------- 实时价格（网页登录凭证） ----------

/// 点开卡型时查价格。force = 手动刷新：只要结果超过 3 秒就重新查；否则 15 秒内用缓存。
/// 同一卡型同时只查一次、全局限流，见 price.rs。
#[tauri::command]
pub async fn gpu_prices(st: State<'_, AppState>, region: String, gpu: String, force: bool) -> R<crate::price::PriceInfo> {
    let m = market(&st)?;
    let max_age = if force { crate::price::FORCE_MIN_AGE_MS } else { crate::price::FRESH_MS };
    let mon = st.monitor.clone();
    let (r, g) = (region.clone(), gpu.clone());
    let info = st.monitor.prices.get(&region, &gpu, max_age, || async move {
        let signs = mon.signs_of(&m, &r).await?;
        m.machines(&signs, std::slice::from_ref(&g)).await.map_err(|e| e.to_string())
    }).await?;
    Ok((*info).clone())
}

// ---------- 普通容器实例（网页登录凭证） ----------

#[tauri::command]
pub async fn list_regular_instances(st: State<'_, AppState>) -> R<Vec<crate::market::RegularInstance>> {
    market(&st)?.instances().await.map_err(s)
}

/// 只在用户点「复制密码」时取，不写日志
#[tauri::command]
pub async fn regular_instance_password(st: State<'_, AppState>, uuid: String) -> R<String> {
    market(&st)?.instance_password(&uuid).await.map_err(s)
}

/// 手动开机会开始计费：界面上要点两次确认，这里再过一遍安全阀（`market::power_on_guard`）：
/// 余额查得到且不低于「开机余额下限」、每台实例每天最多 5 次（失败也计数）。
/// 只做手动操作，不接入规则的自动动作。
#[tauri::command]
pub async fn regular_power_on(st: State<'_, AppState>, uuid: String, non_gpu: bool) -> R<()> {
    let m = market(&st)?;
    let mode = if non_gpu { "（无卡模式）" } else { "" };
    let key = format!("regular_power_on:{uuid}:{}", chrono::Local::now().format("%Y-%m-%d"));
    let attempts: i64 = st.store.kv_get(&key).ok().flatten().and_then(|v| v.parse().ok()).unwrap_or(0);
    let balance = m.wallet().await.map(|b| b.assets).map_err(s);
    let min = st.store.settings().auto_min_balance_yuan;
    if let Err(e) = crate::market::power_on_guard(balance, min, attempts) {
        let _ = st.store.log(now(), "warn", "skip", None, &format!("普通实例开机{mode}被拦下 {uuid}：{e}"));
        return Err(e);
    }
    // 先记次数再发请求，失败也算一次，避免反复重试
    let _ = st.store.kv_set(&key, &(attempts + 1).to_string());
    match m.power_on(&uuid, non_gpu).await {
        Ok(()) => {
            let _ = st.store.log(now(), "info", "manual", None, &format!("普通实例开机{mode} {uuid}（今天第 {} 次）", attempts + 1));
            Ok(())
        }
        Err(e) => {
            let _ = st.store.log(now(), "warn", "manual", None, &format!("普通实例开机{mode}失败 {uuid}：{e}"));
            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub async fn regular_power_off(st: State<'_, AppState>, uuid: String) -> R<()> {
    market(&st)?.power_off(&uuid).await.map_err(s)?;
    let _ = st.store.log(now(), "info", "manual", None, &format!("普通实例关机 {uuid}"));
    Ok(())
}

// ---------- instances ----------

#[tauri::command]
pub async fn list_instances(st: State<'_, AppState>, page_index: i64, page_size: i64) -> R<Value> {
    client(&st)?.list_instances(page_index, page_size).await.map_err(s)
}

#[tauri::command]
pub async fn instance_snapshot(st: State<'_, AppState>, uuid: String) -> R<Value> {
    client(&st)?.snapshot(&uuid).await.map_err(s)
}

#[tauri::command]
pub async fn instance_status(st: State<'_, AppState>, uuid: String) -> R<String> {
    client(&st)?.status(&uuid).await.map_err(s)
}

#[tauri::command]
pub async fn power_on(st: State<'_, AppState>, uuid: String, start_command: Option<String>) -> R<()> {
    client(&st)?.power_on(&uuid, start_command).await.map_err(s)?;
    let _ = st.store.log(now(), "info", "manual", None, &format!("开机 {uuid}"));
    Ok(())
}

#[tauri::command]
pub async fn power_off(st: State<'_, AppState>, uuid: String) -> R<()> {
    client(&st)?.power_off(&uuid).await.map_err(s)?;
    let _ = st.store.log(now(), "info", "manual", None, &format!("关机 {uuid}"));
    Ok(())
}

#[tauri::command]
pub async fn release_instance(st: State<'_, AppState>, uuid: String) -> R<()> {
    client(&st)?.release(&uuid).await.map_err(s)?;
    let _ = st.store.log(now(), "warn", "manual", None, &format!("释放 {uuid}"));
    Ok(())
}

#[tauri::command]
pub async fn save_image(st: State<'_, AppState>, uuid: String, name: String) -> R<Value> {
    let v = client(&st)?.save_image(&uuid, &name).await.map_err(s)?;
    let _ = st.store.log(now(), "info", "manual", None, &format!("保存镜像 {name}（实例 {uuid}）"));
    Ok(v)
}

#[tauri::command]
pub async fn list_images(st: State<'_, AppState>, page_index: i64, page_size: i64) -> R<Value> {
    client(&st)?.list_private_images(page_index, page_size).await.map_err(s)
}

// ---------- logs ----------

#[tauri::command]
pub fn list_logs(st: State<'_, AppState>, limit: i64) -> R<Vec<LogEntry>> {
    st.store.logs(limit)
}

// ---------- 服务器（AutoDL 实例 + 自己的 SSH 服务器） ----------

use crate::servers::{self, ServerView};
use crate::sshconfig;
use crate::store::Server;

#[derive(Serialize)]
pub struct ServerList {
    pub servers: Vec<ServerView>,
    /// 读 AutoDL 实例出错（没填网页凭证、凭证过期等），自己的服务器照常显示
    pub autodl_error: Option<String>,
    /// 软件生成的公钥（还没生成时为空）
    pub own_key: Option<String>,
    pub ssh_config_path: Option<String>,
    pub auto_sync: bool,
    /// 这次是否自动同步改了 ~/.ssh/config
    pub synced: bool,
}

fn config_aliases() -> Vec<String> {
    let text = sshconfig::config_path().and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
    let mut v: Vec<String> = sshconfig::parse_config(&text).into_iter().map(|h| h.alias).collect();
    // 管理段里的条目 parse_config 会跳过，单独找
    v.extend(text.lines().filter_map(|l| l.trim().strip_prefix("Host ").map(|a| a.trim().to_string())));
    v
}

async fn autodl_instances(st: &State<'_, AppState>) -> (Vec<crate::market::RegularInstance>, Option<String>) {
    match st.monitor.market() {
        None => (vec![], Some("没有填写网页登录凭证，AutoDL 实例不会出现在这里".into())),
        Some(m) => match m.instances().await {
            Ok(v) => (v, None),
            Err(e) => (vec![], Some(format!("读取 AutoDL 实例失败：{e}"))),
        },
    }
}

fn auto_sync_on(st: &State<'_, AppState>) -> bool {
    st.store.kv_get("ssh_auto_sync").ok().flatten().as_deref() == Some("1")
}

#[tauri::command]
pub async fn list_servers(st: State<'_, AppState>) -> R<ServerList> {
    let (insts, autodl_error) = autodl_instances(&st).await;
    let saved = st.store.servers()?;
    let auto_sync = auto_sync_on(&st);
    // 实例列表读失败时不同步，免得把配置里的 AutoDL 条目清掉
    let synced = if auto_sync && autodl_error.is_none() {
        sshconfig::write_block(&servers::managed_entries(&insts, &saved)).unwrap_or(false)
    } else {
        false
    };
    Ok(ServerList {
        servers: servers::views(&st.store, &insts, &saved, &config_aliases()),
        autodl_error,
        own_key: crate::ssh::own_public_key(),
        ssh_config_path: sshconfig::config_path().map(|p| p.display().to_string()),
        auto_sync,
        synced,
    })
}

async fn find_server(st: &State<'_, AppState>, id: &str) -> R<ServerView> {
    let saved = st.store.servers()?;
    let insts = if id.starts_with("autodl:") { autodl_instances(st).await.0 } else { vec![] };
    servers::views(&st.store, &insts, &saved, &config_aliases())
        .into_iter()
        .find(|v| v.id == id)
        .ok_or_else(|| "找不到这台服务器，可能已经删除或实例已释放".to_string())
}

async fn server_password_inner(st: &State<'_, AppState>, v: &ServerView) -> R<Option<String>> {
    servers::password(&st.store, st.monitor.market().as_ref(), v).await
}

/// 连接：推过公钥的先只用密钥，失败（比如实例重建过）再带上密码重试；主机密钥变化的错误直接返回
async fn ssh_exec(st: &State<'_, AppState>, v: &ServerView, cmd: &str) -> R<crate::ssh::ExecOut> {
    servers::exec(&st.store, &st.monitor.ssh, st.monitor.market().as_ref(), v, cmd).await
}

fn validate_server(sv: &Server) -> R<()> {
    if sv.name.trim().is_empty() {
        return Err("给服务器起个名字".into());
    }
    if !sshconfig::valid_host(sv.host.trim()) {
        return Err("主机地址只能是域名或 IP".into());
    }
    if !sshconfig::valid_user(sv.user.trim()) {
        return Err("用户名只能包含字母、数字和 . - _".into());
    }
    if !(1..=65535).contains(&sv.port) {
        return Err("端口要在 1–65535 之间".into());
    }
    if !matches!(sv.auth.as_str(), "key" | "password") {
        return Err("认证方式只能是私钥或密码".into());
    }
    Ok(())
}

/// 保存自己的服务器。password 为 Some 且非空时写进钥匙串；认证方式改成私钥时清掉旧密码
#[tauri::command]
pub fn save_server(st: State<'_, AppState>, server: Server, password: Option<String>) -> R<i64> {
    let mut sv = server;
    sv.name = sv.name.trim().to_string();
    sv.host = sv.host.trim().to_string();
    sv.user = sv.user.trim().to_string();
    validate_server(&sv)?;
    let is_new = sv.id <= 0;
    let id = st.store.save_server(sv.clone())?;
    match (sv.auth.as_str(), password.filter(|p| !p.is_empty())) {
        ("password", Some(pw)) => {
            if let Err(e) = crate::secret::save_server_password(&st.store, id, &pw) {
                // 新加的服务器存不了密码就整个不保存，免得留下一台登录不了的
                if is_new {
                    let _ = st.store.delete_server(id);
                }
                return Err(e);
            }
        }
        ("key", _) => crate::secret::clear_server_password(&st.store, id),
        _ => {}
    }
    let _ = st.store.log(now(), "info", "server", None, &format!("保存服务器 {}（{}@{}:{}）", sv.name, sv.user, sv.host, sv.port));
    Ok(id)
}

#[tauri::command]
pub fn delete_server(st: State<'_, AppState>, id: i64) -> R<()> {
    st.store.delete_server(id)?;
    crate::secret::clear_server_password(&st.store, id);
    Ok(())
}

/// ~/.ssh/config 里还没导入过的 Host
#[tauri::command]
pub fn ssh_config_hosts(st: State<'_, AppState>) -> R<Vec<sshconfig::HostEntry>> {
    let text = sshconfig::config_path().and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
    let have: Vec<String> = st.store.servers()?.into_iter().filter_map(|s| s.alias).collect();
    Ok(sshconfig::parse_config(&text).into_iter().filter(|h| !have.contains(&h.alias)).collect())
}

#[tauri::command]
pub fn import_ssh_hosts(st: State<'_, AppState>, aliases: Vec<String>) -> R<usize> {
    let text = sshconfig::config_path().and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
    let mut n = 0;
    for h in sshconfig::parse_config(&text).into_iter().filter(|h| aliases.contains(&h.alias)) {
        let user = if h.user.is_empty() { "root".to_string() } else { h.user.clone() };
        st.store.save_server(Server {
            id: 0, name: h.alias.clone(), host: h.host, port: h.port, user, auth: "key".into(),
            key_path: h.identity_file, alias: Some(h.alias), note: None,
        })?;
        n += 1;
    }
    Ok(n)
}

#[derive(Serialize)]
pub struct SyncResult {
    pub changed: bool,
    pub count: usize,
    pub path: String,
}

#[tauri::command]
pub async fn sync_ssh_config(st: State<'_, AppState>) -> R<SyncResult> {
    let (insts, err) = autodl_instances(&st).await;
    if let (Some(e), true) = (err, st.monitor.market().is_some()) {
        return Err(format!("{e}。为了不把配置里的 AutoDL 条目清掉，这次没有同步"));
    }
    let entries = servers::managed_entries(&insts, &st.store.servers()?);
    let changed = sshconfig::write_block(&entries)?;
    let path = sshconfig::config_path().map(|p| p.display().to_string()).unwrap_or_default();
    if changed {
        let _ = st.store.log(now(), "info", "server", None, &format!("同步 SSH 配置：{} 台服务器写入 {path}", entries.len()));
    }
    Ok(SyncResult { changed, count: entries.len(), path })
}

#[tauri::command]
pub fn set_ssh_auto_sync(st: State<'_, AppState>, on: bool) -> R<()> {
    st.store.kv_set("ssh_auto_sync", if on { "1" } else { "0" })
}

#[tauri::command]
pub async fn open_terminal(st: State<'_, AppState>, id: String) -> R<()> {
    let v = find_server(&st, &id).await?;
    if v.host.is_empty() && !v.alias_ready {
        return Err("这台实例还没有 SSH 信息（可能还没开机）".into());
    }
    let key = v.key_path.clone().filter(|k| !k.is_empty()).map(|k| servers::expand_home(&k).display().to_string());
    let args = crate::terminal::ssh_args(v.alias_ready.then_some(v.alias.as_str()), &v.host, v.port, &v.user, key.as_deref())?;
    crate::terminal::open(&v.name, &args)
}

/// VS Code Remote-SSH 的链接，要用 SSH 配置里的 Host 名
pub fn vscode_uri(alias: &str, user: &str) -> R<String> {
    if !sshconfig::valid_alias(alias) || !sshconfig::valid_user(user) {
        return Err("SSH 别名或用户名含有不支持的字符".into());
    }
    let dir = if user == "root" { "/root".to_string() } else { format!("/home/{user}") };
    Ok(format!("vscode://vscode-remote/ssh-remote+{alias}{dir}?windowId=_blank"))
}

/// 用 VS Code 打开。vscode:// 不是 http 链接，前端的 openExternal / opener 插件的默认权限都不放行，
/// 所以在后端用系统默认方式打开；没同步过别名就提示先同步
#[tauri::command]
pub async fn open_vscode(app: tauri::AppHandle, st: State<'_, AppState>, id: String) -> R<()> {
    use tauri_plugin_opener::OpenerExt;
    let v = find_server(&st, &id).await?;
    if !v.alias_ready {
        return Err("NEED_SYNC|VS Code 要通过 SSH 配置里的名字连接，先点「同步到 SSH 配置」".into());
    }
    let uri = vscode_uri(&v.alias, &v.user)?;
    app.opener().open_url(uri, None::<&str>)
        .map_err(|e| format!("打不开 VS Code（{e}）。确认装了 VS Code 和 Remote - SSH 扩展"))
}

/// 复制密码用：用户点了才取，不写日志
#[tauri::command]
pub async fn server_password(st: State<'_, AppState>, id: String) -> R<String> {
    let v = find_server(&st, &id).await?;
    server_password_inner(&st, &v).await?.ok_or_else(|| "这台服务器没有保存密码".into())
}

#[derive(Serialize)]
pub struct Probe {
    pub ms: u128,
    pub system: String,
    pub via_key: bool,
}

#[tauri::command]
pub async fn test_server(st: State<'_, AppState>, id: String) -> R<Probe> {
    let v = find_server(&st, &id).await?;
    let t0 = std::time::Instant::now();
    st.monitor.ssh.forget(&servers::target(&v, None)).await;
    let out = ssh_exec(&st, &v, "uname -srm; (. /etc/os-release 2>/dev/null && echo \"$PRETTY_NAME\")").await?;
    let system = out.stdout.lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" · ");
    Ok(Probe { ms: t0.elapsed().as_millis(), system, via_key: v.key_pushed || v.auth == "key" })
}

/// 生成（或读取已有的）软件密钥，返回公钥
#[tauri::command]
pub fn ensure_ssh_key() -> R<String> {
    crate::ssh::ensure_own_key()
}

/// 把软件的公钥追加到服务器的 authorized_keys
#[tauri::command]
pub async fn push_ssh_key(st: State<'_, AppState>, id: String) -> R<()> {
    let v = find_server(&st, &id).await?;
    let script = crate::ssh::push_key_script(&crate::ssh::ensure_own_key()?)?;
    let out = ssh_exec(&st, &v, &script).await?;
    if out.code != Some(0) || !out.stdout.contains("ok") {
        return Err(format!("推送公钥失败：{}", out.stderr.trim()));
    }
    st.store.kv_set(&servers::pushed_kv(&v.user, &v.host, v.port), "1")?;
    st.monitor.ssh.forget(&servers::target(&v, None)).await;
    let _ = st.store.log(now(), "info", "server", None, &format!("已把公钥推送到 {}（{}@{}:{}）", v.name, v.user, v.host, v.port));
    Ok(())
}

/// 用户确认后信任新的主机密钥（清掉记住的旧指纹，下次连接重新记）
#[tauri::command]
pub async fn trust_host_key(st: State<'_, AppState>, id: String) -> R<()> {
    let v = find_server(&st, &id).await?;
    st.store.kv_set(&crate::ssh::hostkey_kv(&v.host, v.port as u16), "")?;
    let _ = st.store.log(now(), "warn", "server", None, &format!("信任了 {}:{} 的新主机密钥", v.host, v.port));
    Ok(())
}

// ---------- 服务器状态和提醒 ----------

use crate::serverstat::{ServerStatus, Watch};

fn load_watch(st: &State<'_, AppState>, id: &str) -> Watch {
    st.store.kv_get(&format!("watch:{id}")).ok().flatten()
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_else(|| Watch::new(id))
}

/// 点开服务器时采集一次状态（界面开着时 30 秒刷新）
#[tauri::command]
pub async fn server_status(st: State<'_, AppState>, id: String) -> R<ServerStatus> {
    let v = find_server(&st, &id).await?;
    let w = load_watch(&st, &id);
    let out = ssh_exec(&st, &v, &crate::serverstat::command(Some(&w))).await?;
    Ok(crate::serverstat::parse(&out.stdout, now(), Some(&w)))
}

#[tauri::command]
pub fn get_server_watch(st: State<'_, AppState>, id: String) -> Watch {
    load_watch(&st, &id)
}

#[tauri::command]
pub fn save_server_watch(st: State<'_, AppState>, watch: Watch) -> R<()> {
    let mut w = watch;
    w.idle_minutes = w.idle_minutes.clamp(5, 24 * 60);
    w.job_quiet_minutes = w.job_quiet_minutes.clamp(1, 24 * 60);
    w.job_log = w.job_log.map(|l| l.trim().to_string()).filter(|l| !l.is_empty());
    if w.job_pid.is_some_and(|p| p <= 0) {
        return Err("PID 要是正整数".into());
    }
    st.store.kv_set(&format!("watch:{}", w.id), &serde_json::to_string(&w).map_err(s)?)?;
    st.monitor.reset_watch_state(&w.id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vscode_uri_uses_alias_and_home() {
        assert_eq!(vscode_uri("autodl-qwen-a1b2c3", "root").unwrap(), "vscode://vscode-remote/ssh-remote+autodl-qwen-a1b2c3/root?windowId=_blank");
        assert_eq!(vscode_uri("lab", "tk").unwrap(), "vscode://vscode-remote/ssh-remote+lab/home/tk?windowId=_blank");
        assert!(vscode_uri("a b", "root").is_err());
        assert!(vscode_uri("lab", "x/../y").is_err());
    }
}
