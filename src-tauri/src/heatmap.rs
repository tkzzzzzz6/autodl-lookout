//! 抢卡时段分析：把库存历史按「星期 × 小时」聚合，看一周里什么时候最容易有卡。
//!
//! 按本地时区分桶（用户关心的是自己这边的几点钟）。每个格子给出：
//! - 有卡比例：该时段的采样里空闲 ≥ 1 的占比
//! - 平均空闲：该时段采样的空闲卡数平均值
//! 采样是轮询时写入的，间隔约等于查询间隔；同一时刻多个卡型（同一型号的变体）先求和再分桶。

use chrono::{Datelike, TimeZone, Timelike};
use serde::Serialize;

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct HeatCell {
    /// 0 = 周一 … 6 = 周日
    pub weekday: u32,
    pub hour: u32,
    pub samples: i64,
    /// 0–1，没有采样时为 None
    pub hit_ratio: Option<f64>,
    pub avg_idle: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Heatmap {
    /// 7 × 24 = 168 个格子，按 weekday、hour 排序
    pub cells: Vec<HeatCell>,
    pub samples: i64,
    pub first_ts: Option<i64>,
    pub last_ts: Option<i64>,
    /// 一句话结论；数据不够时为 None
    pub summary: Option<String>,
}

/// points：(时间戳, 该时刻空闲卡数)
pub fn build<Tz: TimeZone>(points: &[(i64, i64)], tz: &Tz) -> Heatmap {
    let mut acc = vec![(0i64, 0i64, 0i64); 7 * 24]; // (采样数, 有卡次数, 空闲总和)
    for &(ts, idle) in points {
        let Some(t) = tz.timestamp_opt(ts, 0).single() else { continue };
        let i = t.weekday().num_days_from_monday() as usize * 24 + t.hour() as usize;
        acc[i].0 += 1;
        acc[i].1 += (idle > 0) as i64;
        acc[i].2 += idle.max(0);
    }
    let cells = acc
        .iter()
        .enumerate()
        .map(|(i, &(n, hit, sum))| HeatCell {
            weekday: (i / 24) as u32,
            hour: (i % 24) as u32,
            samples: n,
            hit_ratio: (n > 0).then(|| hit as f64 / n as f64),
            avg_idle: (n > 0).then(|| sum as f64 / n as f64),
        })
        .collect::<Vec<_>>();
    let samples = points.len() as i64;
    let first_ts = points.iter().map(|p| p.0).min();
    let last_ts = points.iter().map(|p| p.0).max();
    let span_ok = match (first_ts, last_ts) {
        (Some(a), Some(b)) => b - a >= 86400,
        _ => false,
    };
    let summary = if span_ok { summarize(&cells) } else { None };
    Heatmap { cells, samples, first_ts, last_ts, summary }
}

/// 找出全天里有卡比例最高的连续 3 小时（跨午夜也算），再看工作日和周末差别大不大。
pub fn summarize(cells: &[HeatCell]) -> Option<String> {
    let ratio = |pred: &dyn Fn(&HeatCell) -> bool, hour: u32| -> Option<f64> {
        let (mut n, mut hit) = (0i64, 0f64);
        for c in cells.iter().filter(|c| c.hour == hour && pred(c)) {
            if let Some(r) = c.hit_ratio {
                n += c.samples;
                hit += r * c.samples as f64;
            }
        }
        (n > 0).then(|| hit / n as f64)
    };
    let all = |_: &HeatCell| true;
    let by_hour: Vec<Option<f64>> = (0..24).map(|h| ratio(&all, h)).collect();
    if by_hour.iter().all(|r| r.is_none()) {
        return None;
    }
    let mut best: Option<(u32, f64)> = None;
    for start in 0..24u32 {
        let vals: Vec<f64> = (0..3).filter_map(|k| by_hour[((start + k) % 24) as usize]).collect();
        if vals.len() < 3 {
            continue;
        }
        let avg = vals.iter().sum::<f64>() / 3.0;
        if best.map(|(_, b)| avg > b + 1e-9).unwrap_or(true) {
            best = Some((start, avg));
        }
    }
    let (start, avg) = best?;
    if avg <= 0.0 {
        return Some("这段时间里几乎没有空闲，可以把规则的冷却时间调短，或者换个区域看看。".into());
    }
    let end = (start + 3) % 24;
    let mut s = format!("每天 {start:02}:00–{end:02}:00 最容易有卡（有卡比例约 {:.0}%）", avg * 100.0);

    let weekday = |c: &HeatCell| c.weekday < 5;
    let weekend = |c: &HeatCell| c.weekday >= 5;
    let mean = |pred: &dyn Fn(&HeatCell) -> bool| -> Option<f64> {
        let v: Vec<f64> = (0..24).filter_map(|h| ratio(pred, h)).collect();
        (!v.is_empty()).then(|| v.iter().sum::<f64>() / v.len() as f64)
    };
    if let (Some(a), Some(b)) = (mean(&weekday), mean(&weekend)) {
        if (a - b).abs() >= 0.15 {
            s.push_str(if a > b { "，工作日比周末更容易抢到" } else { "，周末比工作日更容易抢到" });
        }
    }
    s.push('。');
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn cst() -> FixedOffset {
        FixedOffset::east_opt(8 * 3600).unwrap()
    }

    /// 2026-11-02 是周一，这里取北京时间 00:00
    const MON0: i64 = 1_793_548_800;

    #[test]
    fn monday_midnight_constant_is_right() {
        let t = cst().timestamp_opt(MON0, 0).unwrap();
        assert_eq!((t.weekday().num_days_from_monday(), t.hour()), (0, 0));
    }

    #[test]
    fn buckets_by_local_weekday_and_hour() {
        let pts = vec![
            (MON0 + 3600 * 2, 4),          // 周一 02 点，有卡
            (MON0 + 3600 * 2 + 600, 0),    // 周一 02 点，没有
            (MON0 + 86400 * 6 + 3600 * 23, 2), // 周日 23 点
        ];
        let h = build(&pts, &cst());
        assert_eq!(h.cells.len(), 168);
        let mon2 = &h.cells[2];
        assert_eq!((mon2.weekday, mon2.hour, mon2.samples), (0, 2, 2));
        assert_eq!(mon2.hit_ratio, Some(0.5));
        assert_eq!(mon2.avg_idle, Some(2.0));
        let sun23 = &h.cells[6 * 24 + 23];
        assert_eq!((sun23.samples, sun23.hit_ratio), (1, Some(1.0)));
        assert_eq!(h.cells[5].samples, 0);
        assert_eq!(h.cells[5].hit_ratio, None);
        // 同样的时间戳换成 UTC 分桶，周一北京 02 点 = 周日 UTC 18 点
        let utc = build(&pts[..1], &FixedOffset::east_opt(0).unwrap());
        assert_eq!(utc.cells[6 * 24 + 18].samples, 1);
    }

    #[test]
    fn no_summary_with_less_than_a_day() {
        let pts: Vec<(i64, i64)> = (0..10).map(|i| (MON0 + i * 600, 1)).collect();
        assert_eq!(build(&pts, &cst()).summary, None);
    }

    #[test]
    fn finds_best_three_hour_window_across_midnight() {
        // 两周，每 30 分钟一个采样；23、0、1 点有卡，其他时间没有
        let mut pts = vec![];
        for i in 0..(14 * 48) {
            let ts = MON0 + i * 1800;
            let hour = cst().timestamp_opt(ts, 0).unwrap().hour();
            pts.push((ts, if matches!(hour, 23 | 0 | 1) { 3 } else { 0 }));
        }
        let h = build(&pts, &cst());
        let s = h.summary.unwrap();
        assert!(s.starts_with("每天 23:00–02:00 最容易有卡（有卡比例约 100%）"), "{s}");
        assert!(!s.contains("工作日"), "weekday/weekend identical: {s}");
    }

    #[test]
    fn mentions_weekend_when_clearly_better() {
        let mut pts = vec![];
        for i in 0..(14 * 24) {
            let ts = MON0 + i * 3600;
            let t = cst().timestamp_opt(ts, 0).unwrap();
            let weekend = t.weekday().num_days_from_monday() >= 5;
            pts.push((ts, if weekend || t.hour() == 3 { 1 } else { 0 }));
        }
        let s = build(&pts, &cst()).summary.unwrap();
        assert!(s.contains("周末比工作日更容易抢到"), "{s}");
    }

    #[test]
    fn says_so_when_never_available() {
        let pts: Vec<(i64, i64)> = (0..(3 * 24)).map(|i| (MON0 + i * 3600, 0)).collect();
        assert!(build(&pts, &cst()).summary.unwrap().contains("几乎没有空闲"));
    }
}
