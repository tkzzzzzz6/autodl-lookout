//! 算力市场库存（和 AutoDL 控制台「算力市场」页面同一个数据源）。
//!
//! 这些是控制台网页自己用的接口，不在官方开放 API 里，需要「网页登录凭证」
//! （浏览器 localStorage 里的 `token`），不能用开发者 Token。
//! - GET  /api/v1/region/list                 区域列表：region_sign（机房）→ region_name / data_center
//! - POST /api/v1/machine/region/gpu_type     某区域各卡型 空闲/总数（算力市场顶部那一排数字）
//! - POST /api/v1/user/machine/list           按机器列出，带单价和最高 CUDA 版本（用于带筛选条件的规则）
//! - POST /api/v1/instance                     我的普通容器实例列表（控制台「容器实例」页）
//! - POST /api/v1/instance/power_on / power_off 普通实例开机（可选无卡模式）/ 关机
//!
//! 软件里的区域代码沿用 data_center（westDC3、beijingDC2 …），一个 data_center 对应多个机房。

use crate::api::{parse_stock, ApiError, ApiResult, StockItem};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::Duration;

pub const DEFAULT_BASE: &str = "https://www.autodl.com";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MarketRegion {
    pub data_center: String,
    pub name: String,
    pub signs: Vec<String>,
}

/// 单台机器里规则关心的字段
#[derive(Debug, Clone, PartialEq)]
pub struct MachineSlot {
    pub gpu_name: String,
    pub idle: i64,
    /// 每卡每小时，元
    pub price_yuan: Option<f64>,
    /// 如 "13.2" → 132
    pub max_cuda: Option<i64>,
}

/// 普通容器实例（控制台「容器实例」页）里界面要用的字段。
/// root 密码不放在这里：列表会整体发给前端、也可能被打日志，密码只在用户点「复制」时单独取。
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct RegularInstance {
    pub uuid: String,
    pub name: String,
    pub status: String,
    pub sub_status: String,
    pub gpu: String,
    pub gpu_amount: i64,
    pub region_name: String,
    pub region_sign: String,
    pub machine_alias: String,
    pub charge_type: String,
    /// 按量单价，元 / 小时
    pub payg_price_yuan: Option<f64>,
    pub ssh_command: String,
    pub jupyter_url: Option<String>,
    pub service_6006_url: Option<String>,
    pub service_6008_url: Option<String>,
    pub started_at: Option<i64>,
    pub stopped_at: Option<i64>,
    pub expired_at: Option<i64>,
    pub has_password: bool,
}

#[derive(Clone)]
pub struct MarketClient {
    http: reqwest::Client,
    base: String,
    token: String,
}

impl MarketClient {
    pub fn new(token: impl Into<String>) -> Self {
        let base = std::env::var("AUTODL_WEB_BASE").unwrap_or_else(|_| DEFAULT_BASE.to_string());
        Self::with_base(token, base)
    }

    pub fn with_base(token: impl Into<String>, base: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .expect("reqwest client");
        Self { http, base: base.into().trim_end_matches('/').to_string(), token: crate::api::clean_token(&token.into()) }
    }

    async fn call(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> ApiResult<Value> {
        if self.token.is_empty() {
            return Err(ApiError::NoToken);
        }
        let mut req = self.http.request(method, format!("{}{}", self.base, path)).header("Authorization", &self.token);
        if let Some(b) = body {
            req = req.json(&b);
        }
        let resp = req.send().await?;
        let status = resp.status();
        let text = resp.text().await?;
        let v: Value = serde_json::from_str(&text).map_err(|_| {
            ApiError::Parse(format!("HTTP {status}: {}", text.chars().take(160).collect::<String>()))
        })?;
        let code = v.get("code").and_then(|c| c.as_str()).unwrap_or("").to_string();
        if code != "Success" {
            let mut msg = v.get("msg").and_then(|m| m.as_str()).unwrap_or("").to_string();
            if status.as_u16() == 401 || msg.contains("登录") || code.to_lowercase().contains("auth") {
                msg = format!("{msg}。网页登录凭证无效或已过期，请在「设置」里重新粘贴");
            }
            return Err(ApiError::Api { code: if code.is_empty() { format!("HTTP {status}") } else { code }, msg });
        }
        Ok(v.get("data").cloned().unwrap_or(Value::Null))
    }

    /// 余额（控制台首页用的 /api/v1/wallet，金额单位和开放 API 一样是 元 × 1000）
    pub async fn wallet(&self) -> ApiResult<crate::api::Balance> {
        let d = self.call(reqwest::Method::GET, "/api/v1/wallet", None).await?;
        Ok(parse_wallet(&d))
    }

    pub async fn regions(&self) -> ApiResult<Vec<MarketRegion>> {
        let d = self.call(reqwest::Method::GET, "/api/v1/region/list", None).await?;
        Ok(group_regions(&d))
    }

    pub async fn gpu_types(&self, signs: &[String]) -> ApiResult<Vec<StockItem>> {
        let d = self
            .call(reqwest::Method::POST, "/api/v1/machine/region/gpu_type", Some(json!({ "region_sign_list": signs })))
            .await?;
        parse_stock(&d)
    }

    /// 列出这些机房里指定卡型的按量计费机器（自动翻页，最多 1000 台）
    pub async fn machines(&self, signs: &[String], gpu_names: &[String]) -> ApiResult<Vec<MachineSlot>> {
        let mut out = Vec::new();
        for page in 1..=10 {
            let body = json!({
                "charge_type": "payg", "region_sign": "", "gpu_type_name": gpu_names, "machine_tag_name": [],
                "gpu_idle_num": 1, "mount_net_disk": false, "instance_disk_size_order": "", "date_range": "",
                "date_from": "", "date_to": "", "page_index": page, "page_size": 100, "pay_price_order": "",
                "gpu_idle_type": "", "default_order": true, "region_sign_list": signs, "cpu_arch": [], "chip_corp": []
            });
            let d = self.call(reqwest::Method::POST, "/api/v1/user/machine/list", Some(body)).await?;
            let (slots, max_page) = parse_machines(&d);
            out.extend(slots);
            if page >= max_page {
                break;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        Ok(out)
    }
}

impl MarketClient {
    /// 我的普通容器实例（自动翻页，最多 500 台），返回原始 JSON，密码等字段由调用方决定怎么用
    async fn instances_raw(&self) -> ApiResult<Vec<Value>> {
        let mut out = Vec::new();
        for page in 1..=10 {
            let d = self
                .call(reqwest::Method::POST, "/api/v1/instance", Some(json!({ "page_index": page, "page_size": 50 })))
                .await?;
            let list = d.get("list").and_then(|l| l.as_array()).cloned().unwrap_or_default();
            let empty = list.is_empty();
            out.extend(list);
            let max_page = d.get("max_page").and_then(|v| v.as_i64()).unwrap_or(1);
            if empty || page >= max_page {
                break;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        Ok(out)
    }

    pub async fn instances(&self) -> ApiResult<Vec<RegularInstance>> {
        Ok(self.instances_raw().await?.iter().map(parse_instance).collect())
    }

    /// 只在用户点「复制密码」时调用
    pub async fn instance_password(&self, uuid: &str) -> ApiResult<String> {
        let list = self.instances_raw().await?;
        list.iter()
            .find(|i| str_of(i, "uuid") == uuid)
            .map(|i| str_of(i, "root_password"))
            .filter(|p| !p.is_empty())
            .ok_or_else(|| ApiError::Api { code: "NotFound".into(), msg: "没有找到这台实例的密码，可能已经释放".into() })
    }

    /// 开机。non_gpu = true 时用无卡模式（便宜，适合传数据、改代码）
    pub async fn power_on(&self, uuid: &str, non_gpu: bool) -> ApiResult<()> {
        let mut body = json!({ "instance_uuid": uuid });
        if non_gpu {
            body["payload"] = json!("non_gpu");
        }
        self.call(reqwest::Method::POST, "/api/v1/instance/power_on", Some(body)).await.map(|_| ())
    }

    pub async fn power_off(&self, uuid: &str) -> ApiResult<()> {
        self.call(reqwest::Method::POST, "/api/v1/instance/power_off", Some(json!({ "instance_uuid": uuid }))).await.map(|_| ())
    }
}

fn str_of(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// 控制台的拼法：端口为 0 时走 https 域名，否则走 http 代理地址 + 端口
fn service_url(v: &Value, domain_key: &str, port_key: &str, path: &str) -> Option<String> {
    let domain = str_of(v, domain_key);
    let port = v.get(port_key).and_then(|p| p.as_i64()).unwrap_or(0);
    let host = str_of(v, "proxy_host");
    if port == 0 {
        (!domain.is_empty()).then(|| format!("https://{domain}{path}"))
    } else {
        (!host.is_empty()).then(|| format!("http://{host}:{port}{path}"))
    }
}

pub fn parse_instance(v: &Value) -> RegularInstance {
    let token = str_of(v, "jupyter_token");
    RegularInstance {
        uuid: str_of(v, "uuid"),
        name: str_of(v, "name"),
        status: str_of(v, "status"),
        sub_status: str_of(v, "sub_status"),
        gpu: str_of(v, "snapshot_gpu_alias_name"),
        gpu_amount: v.get("req_gpu_amount").and_then(|x| x.as_i64()).unwrap_or(0),
        region_name: str_of(v, "region_name"),
        region_sign: str_of(v, "region_sign"),
        machine_alias: str_of(v, "machine_alias"),
        charge_type: str_of(v, "charge_type"),
        payg_price_yuan: v.get("payg_price").and_then(|x| x.as_f64()).filter(|p| *p > 0.0).map(|p| p / 1000.0),
        ssh_command: str_of(v, "ssh_command"),
        jupyter_url: service_url(v, "jupyter_domain", "jupyter_port", &format!("/jupyter?token={token}")),
        service_6006_url: service_url(v, "service_6006_domain", "service_6006_port", ""),
        service_6008_url: service_url(v, "service_6008_domain", "service_6008_port", ""),
        started_at: crate::monitor::parse_time_field(v.get("started_at")),
        stopped_at: crate::monitor::parse_time_field(v.get("stopped_at")),
        expired_at: crate::monitor::parse_time_field(v.get("expired_at")),
        has_password: !str_of(v, "root_password").is_empty(),
    }
}

pub fn parse_wallet(d: &Value) -> crate::api::Balance {
    let f = |k: &str| d.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0) / 1000.0;
    crate::api::Balance { assets: f("assets"), accumulate: f("accumulate"), voucher_balance: f("voucher_balance") }
}

/// 算力市场页面链接。页面只支持通过 `?region=<机房>` 预选区域（选中该机房所在的大区），卡型没法预选。
pub fn market_url(signs: &[String]) -> String {
    match signs.first() {
        Some(sign) => format!("https://www.autodl.com/market/list?region={sign}"),
        None => "https://www.autodl.com/market/list".into(),
    }
}

pub fn group_regions(d: &Value) -> Vec<MarketRegion> {
    let mut map: BTreeMap<String, MarketRegion> = BTreeMap::new();
    for r in d.as_array().cloned().unwrap_or_default() {
        let (Some(sign), Some(dc)) = (r.get("region_sign").and_then(|v| v.as_str()), r.get("data_center").and_then(|v| v.as_str())) else { continue };
        let name = r.get("region_name").and_then(|v| v.as_str()).unwrap_or(dc);
        let e = map.entry(dc.to_string()).or_insert_with(|| MarketRegion { data_center: dc.into(), name: name.into(), signs: vec![] });
        if !e.signs.iter().any(|s| s == sign) {
            e.signs.push(sign.to_string());
        }
    }
    map.into_values().collect()
}

pub fn parse_cuda(s: &str) -> Option<i64> {
    let mut it = s.trim().split('.');
    let major: i64 = it.next()?.trim().parse().ok()?;
    let minor: i64 = it.next().unwrap_or("0").chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(0);
    Some(major * 10 + minor.min(9))
}

pub fn parse_machines(d: &Value) -> (Vec<MachineSlot>, i64) {
    let max_page = d.get("max_page").and_then(|v| v.as_i64()).unwrap_or(1);
    let list = d.get("list").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let slots = list
        .iter()
        .filter(|m| m.get("payg").and_then(|v| v.as_bool()).unwrap_or(true))
        .map(|m| MachineSlot {
            gpu_name: m.get("gpu_name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            idle: m.get("gpu_idle_num").and_then(|v| v.as_i64()).unwrap_or(0),
            price_yuan: m.get("payg_price").and_then(|v| v.as_f64()).map(|p| p / 1000.0),
            max_cuda: m.get("highest_cuda_version").and_then(|v| v.as_str()).and_then(parse_cuda),
        })
        .collect();
    (slots, max_page)
}

/// 按单价 / CUDA / 单机空闲卡数过滤后，把机器上的空闲卡按卡型加起来，并记下满足条件的机器台数。
/// `min_per_machine` 为 N 时，只统计单台空闲 ≥ N 的机器——多卡训练要求同一台机器上同时空出 N 张卡。
pub fn sum_filtered(slots: &[MachineSlot], max_price_yuan: Option<f64>, cuda_from: Option<i64>, min_per_machine: i64) -> Vec<StockItem> {
    let mut acc: BTreeMap<String, (i64, i64)> = BTreeMap::new();
    for s in slots {
        if s.idle <= 0 || s.idle < min_per_machine.max(1) {
            continue;
        }
        if let Some(p) = max_price_yuan {
            if s.price_yuan.map(|x| x > p + 1e-9).unwrap_or(true) {
                continue;
            }
        }
        if let Some(c) = cuda_from {
            if s.max_cuda.map(|x| x < c).unwrap_or(true) {
                continue;
            }
        }
        let e = acc.entry(s.gpu_name.clone()).or_default();
        e.0 += s.idle;
        e.1 += 1;
    }
    let mut v: Vec<StockItem> = acc
        .into_iter()
        .map(|(gpu_name, (idle, machines))| StockItem { gpu_name, idle, total: 0, machines: Some(machines) })
        .collect();
    v.sort_by(|a, b| b.idle.cmp(&a.idle));
    v
}

/// 网页凭证是 JWT，读出过期时间（不校验签名，只用于提示）
pub fn jwt_exp(token: &str) -> Option<i64> {
    let payload = token.split('.').nth(1)?;
    let bytes = b64url_decode(payload)?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    v.get("exp").and_then(|e| e.as_i64())
}

fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    let mut buf = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            b'=' => break,
            _ => return None,
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            buf.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn market_url_preselects_first_sign() {
        assert_eq!(market_url(&["west-B".into(), "west-C".into()]), "https://www.autodl.com/market/list?region=west-B");
        assert_eq!(market_url(&[]), "https://www.autodl.com/market/list");
    }

    #[test]
    fn groups_regions_by_data_center() {
        // 与 2026-11-06 控制台 /api/v1/region/list 实际返回同形
        let d = json!([
            {"region_sign": "west-B", "region_name": "西北B区", "data_center": "westDC3", "visible": "all"},
            {"region_sign": "bj-B1", "region_name": "北京B区", "data_center": "beijingDC2"},
            {"region_sign": "west-C", "region_name": "西北B区", "data_center": "westDC3"},
            {"region_sign": "bj-B2", "region_name": "北京B区", "data_center": "beijingDC2"},
        ]);
        let g = group_regions(&d);
        assert_eq!(g.len(), 2);
        let west = g.iter().find(|r| r.data_center == "westDC3").unwrap();
        assert_eq!(west.signs, vec!["west-B", "west-C"]);
        assert_eq!(west.name, "西北B区");
    }

    #[test]
    fn wallet_amounts_in_yuan() {
        // 与 2026-11-06 /api/v1/wallet 实际字段同形
        let b = parse_wallet(&json!({"assets": 187460, "accumulate": 2872540, "voucher_balance": 0, "blocked_asset": 0, "uid": 1}));
        assert!((b.assets - 187.46).abs() < 1e-9);
        assert!((b.accumulate - 2872.54).abs() < 1e-9);
    }

    #[test]
    fn cuda_versions() {
        assert_eq!(parse_cuda("13.2"), Some(132));
        assert_eq!(parse_cuda("12.8"), Some(128));
        assert_eq!(parse_cuda("11"), Some(110));
        assert_eq!(parse_cuda("x"), None);
    }

    #[test]
    fn filters_machines_by_price_and_cuda() {
        let d = json!({"max_page": 1, "list": [
            {"gpu_name": "RTX 4090", "gpu_idle_num": 2, "payg_price": 2290, "highest_cuda_version": "13.2", "payg": true},
            {"gpu_name": "RTX 4090", "gpu_idle_num": 3, "payg_price": 2580, "highest_cuda_version": "12.4", "payg": true},
            {"gpu_name": "RTX 4090D", "gpu_idle_num": 1, "payg_price": 1880, "highest_cuda_version": "11.8", "payg": true},
            {"gpu_name": "RTX 4090", "gpu_idle_num": 0, "payg_price": 1000, "highest_cuda_version": "13.2", "payg": true},
            {"gpu_name": "RTX 4090", "gpu_idle_num": 5, "payg_price": 900, "highest_cuda_version": "13.2", "payg": false}
        ]});
        let (slots, mp) = parse_machines(&d);
        assert_eq!(mp, 1);
        assert_eq!(slots.len(), 4, "non-payg machines are skipped");
        let all = sum_filtered(&slots, None, None, 1);
        assert_eq!(all.iter().find(|i| i.gpu_name == "RTX 4090").unwrap().idle, 5);
        let cheap = sum_filtered(&slots, Some(2.3), None, 1);
        assert_eq!(cheap.iter().map(|i| (i.gpu_name.as_str(), i.idle)).collect::<Vec<_>>(), vec![("RTX 4090", 2), ("RTX 4090D", 1)]);
        let cuda = sum_filtered(&slots, None, Some(128), 1);
        assert_eq!(cuda.len(), 1);
        assert_eq!(cuda[0].idle, 2);
    }

    #[test]
    fn per_machine_threshold_counts_only_big_enough_machines() {
        let slot = |idle, price: f64, cuda| MachineSlot { gpu_name: "RTX 4090".into(), idle, price_yuan: Some(price), max_cuda: Some(cuda) };
        // 区域里一共空 1+1+1+2+4 = 9 张，但能开 2 卡的只有后两台
        let slots = vec![slot(1, 2.0, 132), slot(1, 2.0, 132), slot(1, 2.0, 132), slot(2, 2.5, 124), slot(4, 2.0, 132)];
        let n1 = sum_filtered(&slots, None, None, 1);
        assert_eq!((n1[0].idle, n1[0].machines), (9, Some(5)));
        let n2 = sum_filtered(&slots, None, None, 2);
        assert_eq!((n2[0].idle, n2[0].machines), (6, Some(2)));
        let n4 = sum_filtered(&slots, None, None, 4);
        assert_eq!((n4[0].idle, n4[0].machines), (4, Some(1)));
        assert!(sum_filtered(&slots, None, None, 8).is_empty());
        // 和单价、CUDA 叠加：2 卡且 ≤ ¥2.2 且 CUDA ≥ 12.8 → 只剩 4 卡那台
        let mixed = sum_filtered(&slots, Some(2.2), Some(128), 2);
        assert_eq!((mixed[0].idle, mixed[0].machines), (4, Some(1)));
    }

    #[test]
    fn reads_jwt_expiry() {
        // header.{"exp":1767560400}.sig
        let payload = "eyJleHAiOjE3Njc1NjA0MDB9";
        assert_eq!(jwt_exp(&format!("x.{payload}.y")), Some(1767560400));
        assert_eq!(jwt_exp("not-a-jwt"), None);
    }

    async fn serve_once(reply: &'static str) -> (String, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = format!("http://{}", l.local_addr().unwrap());
        let h = tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let mut req = String::new();
            loop {
                let n = s.read(&mut buf).await.unwrap();
                req.push_str(&String::from_utf8_lossy(&buf[..n]));
                if let Some(i) = req.find("\r\n\r\n") {
                    let len = req.lines().find_map(|l| l.to_lowercase().strip_prefix("content-length: ").map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                    if req.len() >= i + 4 + len { break; }
                }
                if n == 0 { break; }
            }
            let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", reply.len(), reply);
            s.write_all(resp.as_bytes()).await.unwrap();
            req
        });
        (addr, h)
    }

    /// 字段形状来自控制台「容器实例」页的真实返回（值是假的）
    const INSTANCE: &str = r#"{
        "uuid": "a1b2c3d4e5-f6a7b8c9", "name": "sft", "status": "running", "sub_status": "",
        "start_mode": "gpu", "snapshot_gpu_alias_name": "RTX 4090", "req_gpu_amount": 2,
        "region_name": "西北B区", "region_sign": "west-B", "machine_alias": "123机",
        "ssh_command": "ssh -p 12345 root@region-9.autodl.example", "root_password": "fake-password",
        "jupyter_token": "jt", "jupyter_domain": "j-abc.example", "jupyter_port": 0, "proxy_host": "region-9.autodl.example",
        "service_6006_domain": "u-6006.example", "service_6006_port": 0,
        "service_6008_domain": "", "service_6008_port": 18008,
        "started_at": {"Time": "2026-11-06T10:00:00+08:00", "Valid": true},
        "stopped_at": {"Time": "0001-01-01T00:00:00Z", "Valid": false},
        "expired_at": {"Time": "0001-01-01T00:00:00Z", "Valid": false},
        "charge_type": "payg", "payg_price": 3760, "rent_deadline": null, "timed_shutdown_at": {"Time": "", "Valid": false}
    }"#;

    #[test]
    fn parses_regular_instance_without_password() {
        let v: Value = serde_json::from_str(INSTANCE).unwrap();
        let i = parse_instance(&v);
        assert_eq!((i.gpu.as_str(), i.gpu_amount, i.region_sign.as_str()), ("RTX 4090", 2, "west-B"));
        assert_eq!(i.payg_price_yuan, Some(3.76));
        assert_eq!(i.jupyter_url.as_deref(), Some("https://j-abc.example/jupyter?token=jt"));
        assert_eq!(i.service_6006_url.as_deref(), Some("https://u-6006.example"));
        assert_eq!(i.service_6008_url.as_deref(), Some("http://region-9.autodl.example:18008"));
        assert_eq!(i.started_at, Some(1_793_930_400));
        assert_eq!((i.stopped_at, i.expired_at), (None, None));
        assert!(i.has_password);
        let json = serde_json::to_string(&i).unwrap();
        assert!(!json.contains("fake-password"), "密码不能出现在列表里");
    }

    #[test]
    fn jupyter_via_proxy_port() {
        let v = json!({ "jupyter_token": "t", "jupyter_domain": "", "jupyter_port": 8888, "proxy_host": "h.example" });
        assert_eq!(parse_instance(&v).jupyter_url.as_deref(), Some("http://h.example:8888/jupyter?token=t"));
        assert_eq!(parse_instance(&json!({})).jupyter_url, None);
    }

    #[tokio::test]
    async fn instance_list_request_shape() {
        let reply: &'static str = Box::leak(format!(r#"{{"code":"Success","data":{{"list":[{INSTANCE}],"page_index":1,"page_size":50,"max_page":1,"result_total":1}},"msg":""}}"#).into_boxed_str());
        let (base, h) = serve_once(reply).await;
        let c = MarketClient::with_base("web.jwt.token", base);
        let list = c.instances().await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].uuid, "a1b2c3d4e5-f6a7b8c9");
        let req = h.await.unwrap();
        assert!(req.starts_with("POST /api/v1/instance "));
        assert!(req.to_lowercase().contains("authorization: web.jwt.token"));
        assert!(req.contains(r#""page_index":1"#) && req.contains(r#""page_size":50"#));
    }

    #[tokio::test]
    async fn power_on_non_gpu_request_shape() {
        let (base, h) = serve_once(r#"{"code":"Success","data":null,"msg":""}"#).await;
        let c = MarketClient::with_base("web.jwt.token", base);
        c.power_on("a1b2c3d4e5-f6a7b8c9", true).await.unwrap();
        let req = h.await.unwrap();
        assert!(req.starts_with("POST /api/v1/instance/power_on "));
        assert!(req.contains(r#""instance_uuid":"a1b2c3d4e5-f6a7b8c9""#));
        assert!(req.contains(r#""payload":"non_gpu""#));

        let (base, h) = serve_once(r#"{"code":"Success","data":null,"msg":""}"#).await;
        MarketClient::with_base("web.jwt.token", base).power_off("u1").await.unwrap();
        let req = h.await.unwrap();
        assert!(req.starts_with("POST /api/v1/instance/power_off "));
        assert!(req.contains(r#"{"instance_uuid":"u1"}"#));
    }

    #[tokio::test]
    async fn gpu_type_request_shape() {
        let (base, h) = serve_once(r#"{"code":"Success","data":[{"RTX 4090":{"total_gpu_num":1766,"idle_gpu_num":0}},{"CPU":{"total_gpu_num":320,"idle_gpu_num":2}}],"msg":""}"#).await;
        let c = MarketClient::with_base("web.jwt.token", base);
        let items = c.gpu_types(&["west-B".into(), "west-C".into()]).await.unwrap();
        assert_eq!(items, vec![StockItem { gpu_name: "RTX 4090".into(), idle: 0, total: 1766, machines: None }]);
        let req = h.await.unwrap();
        assert!(req.starts_with("POST /api/v1/machine/region/gpu_type "));
        assert!(req.to_lowercase().contains("authorization: web.jwt.token"));
        assert!(req.contains(r#""region_sign_list":["west-B","west-C"]"#));
    }
}
