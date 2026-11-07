//! 点开卡型时的实时价格：按机器查算力市场，汇总成价格区间、分档和多卡机器数。
//!
//! 用的是用户自己的网页凭证，只服务本机这一个人。但同一个账号内部也会有几路请求同时到达
//! （后台监控、点开的几个卡型、手动刷新），所以这里做了三层控制，避免把账号请求量刷上去：
//! - 缓存：同一「区域 + 卡型」默认 15 秒内直接用缓存；手动刷新也只在结果超过 3 秒时才重新查
//! - 合并请求：同一个键同时只有一个调用真正去查，其他调用等它查完后直接用缓存
//! - 全局限流：最多同时 2 个上游请求，相邻两次请求至少间隔 300ms
//! 后台监控为带条件的规则查机器列表时，会把结果写进来（`put_slots`），界面直接复用。

use crate::market::MachineSlot;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;

/// 默认缓存时间
pub const FRESH_MS: i64 = 15_000;
/// 手动刷新时，比这个还新的结果直接复用，防止连点
pub const FORCE_MIN_AGE_MS: i64 = 3_000;
const MAX_CONCURRENT: usize = 2;
const MIN_GAP: Duration = Duration::from_millis(300);

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct PriceTier {
    /// 每卡每小时，元
    pub price_yuan: f64,
    pub idle: i64,
    pub machines: i64,
    /// 这一档里单台机器最多空闲几张
    pub max_per_machine: i64,
    /// 这一档机器里驱动支持的最高 CUDA（如 128 = 12.8）
    pub max_cuda: Option<i64>,
}

/// 一台可以租的机器（租用面板按它列出，默认选最便宜的）
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Offer {
    pub machine_id: String,
    pub machine_alias: String,
    pub region_sign: String,
    pub idle: i64,
    pub price_yuan: f64,
    pub max_cuda: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct MultiCount {
    pub cards: i64,
    pub machines: i64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct PriceInfo {
    pub gpu_name: String,
    /// 查询时间（Unix 秒）
    pub fetched_at: i64,
    /// 有空闲卡的机器数和空闲卡总数
    pub machines: i64,
    pub idle: i64,
    pub min_yuan: Option<f64>,
    /// 按卡加权的中位价：一半的空闲卡不贵于它
    pub median_yuan: Option<f64>,
    pub max_yuan: Option<f64>,
    /// 按单价从低到高
    pub tiers: Vec<PriceTier>,
    /// 单机至少 2 / 4 / 8 张空闲的机器数
    pub multi: Vec<MultiCount>,
    /// 没有标价的空闲卡（不计入价格统计）
    pub unpriced_idle: i64,
    /// 能租的机器：按单价从低到高、同价按空闲从多到少，最多 60 台
    pub offers: Vec<Offer>,
}

/// 只统计 gpu_name 完全相同、空闲 > 0 的机器
pub fn summarize(gpu_name: &str, slots: &[MachineSlot], fetched_at: i64) -> PriceInfo {
    let slots: Vec<&MachineSlot> = slots.iter().filter(|s| s.gpu_name == gpu_name && s.idle > 0).collect();
    // 价格按分取整再分档，避免浮点误差把同一价格拆成两档
    let mut tiers: BTreeMap<i64, PriceTier> = BTreeMap::new();
    let mut unpriced_idle = 0;
    for s in &slots {
        let Some(p) = s.price_yuan.filter(|p| *p > 0.0) else {
            unpriced_idle += s.idle;
            continue;
        };
        let cents = (p * 100.0).round() as i64;
        let t = tiers.entry(cents).or_insert_with(|| PriceTier { price_yuan: cents as f64 / 100.0, ..Default::default() });
        t.idle += s.idle;
        t.machines += 1;
        t.max_per_machine = t.max_per_machine.max(s.idle);
        t.max_cuda = t.max_cuda.max(s.max_cuda);
    }
    let tiers: Vec<PriceTier> = tiers.into_values().collect();
    let priced: i64 = tiers.iter().map(|t| t.idle).sum();
    let median_yuan = (priced > 0).then(|| {
        let half = (priced + 1) / 2;
        let mut acc = 0;
        tiers.iter().find(|t| { acc += t.idle; acc >= half }).map(|t| t.price_yuan).unwrap_or(0.0)
    });
    PriceInfo {
        gpu_name: gpu_name.to_string(),
        fetched_at,
        machines: slots.len() as i64,
        idle: slots.iter().map(|s| s.idle).sum(),
        min_yuan: tiers.first().map(|t| t.price_yuan),
        median_yuan,
        max_yuan: tiers.last().map(|t| t.price_yuan),
        multi: [2, 4, 8]
            .iter()
            .map(|&n| MultiCount { cards: n, machines: slots.iter().filter(|s| s.idle >= n).count() as i64 })
            .collect(),
        offers: {
            let mut o: Vec<Offer> = slots.iter().filter(|s| !s.machine_id.is_empty())
                .filter_map(|s| s.price_yuan.filter(|p| *p > 0.0).map(|p| Offer {
                    machine_id: s.machine_id.clone(), machine_alias: s.machine_alias.clone(), region_sign: s.region_sign.clone(),
                    idle: s.idle, price_yuan: (p * 100.0).round() / 100.0, max_cuda: s.max_cuda,
                }))
                .collect();
            o.sort_by(|a, b| a.price_yuan.partial_cmp(&b.price_yuan).unwrap().then(b.idle.cmp(&a.idle)));
            o.truncate(60);
            o
        },
        tiers,
        unpriced_idle,
    }
}

type Key = (String, String);

pub struct PriceCache {
    entries: Mutex<HashMap<Key, (i64, Arc<PriceInfo>)>>,
    locks: Mutex<HashMap<Key, Arc<tokio::sync::Mutex<()>>>>,
    upstream: Semaphore,
    last_call: tokio::sync::Mutex<Option<Instant>>,
}

impl Default for PriceCache {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            locks: Mutex::new(HashMap::new()),
            upstream: Semaphore::new(MAX_CONCURRENT),
            last_call: tokio::sync::Mutex::new(None),
        }
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl PriceCache {
    fn fresh(&self, key: &Key, max_age_ms: i64) -> Option<Arc<PriceInfo>> {
        let e = self.entries.lock().unwrap();
        e.get(key).filter(|(at, _)| now_ms() - at < max_age_ms).map(|(_, v)| v.clone())
    }

    /// 取价格：缓存够新就直接返回；否则同一个键只让一个调用去查（fetch），其他调用等它查完再读缓存。
    pub async fn get<F, Fut>(&self, region: &str, gpu: &str, max_age_ms: i64, fetch: F) -> Result<Arc<PriceInfo>, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Vec<MachineSlot>, String>>,
    {
        let key: Key = (region.to_string(), gpu.to_string());
        if let Some(v) = self.fresh(&key, max_age_ms) {
            return Ok(v);
        }
        let lock = self.locks.lock().unwrap().entry(key.clone()).or_default().clone();
        let _guard = lock.lock().await;
        // 排队期间别的调用可能已经查完了
        if let Some(v) = self.fresh(&key, max_age_ms) {
            return Ok(v);
        }
        let _permit = self.upstream.acquire().await.map_err(|e| e.to_string())?;
        {
            let mut last = self.last_call.lock().await;
            if let Some(t) = *last {
                let gap = t.elapsed();
                if gap < MIN_GAP {
                    tokio::time::sleep(MIN_GAP - gap).await;
                }
            }
            *last = Some(Instant::now());
        }
        let slots = fetch().await?;
        let info = Arc::new(summarize(gpu, &slots, now_ms() / 1000));
        self.entries.lock().unwrap().insert(key, (now_ms(), info.clone()));
        Ok(info)
    }

    /// 后台监控按机器查到的结果：按卡型拆开写进缓存（查询条件同样是「至少 1 张空闲」，所以对这些卡型是完整的）
    pub fn put_slots(&self, region: &str, gpu_names: &[String], slots: &[MachineSlot]) {
        let at = now_ms();
        let mut e = self.entries.lock().unwrap();
        for g in gpu_names {
            e.insert((region.to_string(), g.clone()), (at, Arc::new(summarize(g, slots, at / 1000))));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn slot(gpu: &str, idle: i64, price: Option<f64>, cuda: Option<i64>) -> MachineSlot {
        MachineSlot { gpu_name: gpu.into(), idle, price_yuan: price, max_cuda: cuda, ..Default::default() }
    }

    #[test]
    fn summarizes_tiers_median_and_multi_card() {
        let slots = vec![
            slot("RTX 4090", 8, Some(1.88), Some(128)),
            slot("RTX 4090", 2, Some(1.88), Some(124)),
            slot("RTX 4090", 1, Some(2.08), Some(122)),
            slot("RTX 4090", 4, Some(2.38), None),
            slot("RTX 4090", 3, None, None),           // 没标价
            slot("RTX 4090", 0, Some(0.98), None),     // 没空闲，不算
            slot("RTX 4090D", 6, Some(1.58), None),    // 别的卡型，不算
        ];
        let p = summarize("RTX 4090", &slots, 100);
        assert_eq!((p.machines, p.idle, p.unpriced_idle), (5, 18, 3));
        assert_eq!((p.min_yuan, p.max_yuan), (Some(1.88), Some(2.38)));
        // 有标价的 15 张：1.88 有 10 张，已经过半
        assert_eq!(p.median_yuan, Some(1.88));
        assert_eq!(p.tiers.len(), 3);
        assert_eq!(p.tiers[0], PriceTier { price_yuan: 1.88, idle: 10, machines: 2, max_per_machine: 8, max_cuda: Some(128) });
        assert_eq!(p.multi, vec![
            MultiCount { cards: 2, machines: 4 },
            MultiCount { cards: 4, machines: 2 },
            MultiCount { cards: 8, machines: 1 },
        ]);
    }

    #[test]
    fn offers_sorted_by_price_then_idle() {
        let m = |id: &str, idle, price| MachineSlot { machine_id: id.into(), gpu_name: "A".into(), idle, price_yuan: Some(price), ..Default::default() };
        let p = summarize("A", &[m("x", 1, 2.0), m("y", 4, 1.5), m("z", 8, 1.5), m("", 3, 1.0)], 0);
        assert_eq!(p.offers.iter().map(|o| o.machine_id.as_str()).collect::<Vec<_>>(), vec!["z", "y", "x"], "没有 machine_id 的不列");
    }

    #[test]
    fn same_price_with_float_noise_is_one_tier() {
        let p = summarize("A", &[slot("A", 1, Some(1.88), None), slot("A", 1, Some(1.8799999), None)], 0);
        assert_eq!(p.tiers.len(), 1);
        assert_eq!(p.tiers[0].idle, 2);
    }

    #[test]
    fn empty_has_no_prices() {
        let p = summarize("A", &[], 0);
        assert_eq!((p.min_yuan, p.median_yuan, p.max_yuan, p.idle), (None, None, None, 0));
    }

    #[tokio::test]
    async fn concurrent_calls_share_one_request_and_cache() {
        let cache = Arc::new(PriceCache::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let mut tasks = vec![];
        for _ in 0..8 {
            let (cache, calls) = (cache.clone(), calls.clone());
            tasks.push(tokio::spawn(async move {
                cache.get("westDC3", "RTX 4090", FRESH_MS, || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    Ok(vec![slot("RTX 4090", 2, Some(1.88), None)])
                }).await
            }));
        }
        for t in tasks {
            assert_eq!(t.await.unwrap().unwrap().idle, 2);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1, "8 个同时到达的调用只查一次");
        // 缓存期内再取也不查
        let c2 = calls.clone();
        cache.get("westDC3", "RTX 4090", FRESH_MS, || async move { c2.fetch_add(1, Ordering::SeqCst); Ok(vec![]) }).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // 不同卡型是不同的键
        let c3 = calls.clone();
        cache.get("westDC3", "RTX 4090D", FRESH_MS, || async move { c3.fetch_add(1, Ordering::SeqCst); Ok(vec![]) }).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn expired_entry_is_refetched_and_errors_are_not_cached() {
        let cache = PriceCache::default();
        let r = cache.get("r", "g", FRESH_MS, || async { Err::<Vec<MachineSlot>, _>("登录超时".to_string()) }).await;
        assert_eq!(r.unwrap_err(), "登录超时");
        let p = cache.get("r", "g", FRESH_MS, || async { Ok(vec![slot("g", 1, Some(1.0), None)]) }).await.unwrap();
        assert_eq!(p.idle, 1);
        // max_age = 0 视为过期，必须重新查
        let p = cache.get("r", "g", 0, || async { Ok(vec![slot("g", 5, Some(1.0), None)]) }).await.unwrap();
        assert_eq!(p.idle, 5);
    }

    #[tokio::test]
    async fn upstream_calls_are_spaced() {
        let cache = PriceCache::default();
        let t0 = Instant::now();
        for g in ["a", "b", "c"] {
            cache.get("r", g, FRESH_MS, || async { Ok(vec![]) }).await.unwrap();
        }
        assert!(t0.elapsed() >= MIN_GAP * 2, "相邻请求至少间隔 {MIN_GAP:?}");
    }

    #[test]
    fn monitor_results_fill_the_cache() {
        let cache = PriceCache::default();
        cache.put_slots("westDC3", &["RTX 4090".into(), "RTX 4090D".into()],
            &[slot("RTX 4090", 2, Some(1.88), None), slot("RTX 4090D", 3, Some(1.58), None)]);
        let k = ("westDC3".to_string(), "RTX 4090D".to_string());
        assert_eq!(cache.fresh(&k, FRESH_MS).unwrap().idle, 3);
    }
}
