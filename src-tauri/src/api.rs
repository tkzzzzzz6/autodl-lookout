//! AutoDL HTTP API client.
//!
//! Docs:
//! - 通用 API:          https://www.autodl.com/docs/common_api/
//! - 容器实例 Pro API:  https://www.autodl.com/docs/instance_pro_api/
//! - 弹性部署 API (库存): https://www.autodl.com/docs/esd_api_doc/

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

pub const DEFAULT_BASE: &str = "https://api.autodl.com";

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("未设置开发者 Token")]
    NoToken,
    #[error("网络错误: {0}")]
    Http(#[from] reqwest::Error),
    #[error("AutoDL 返回错误 [{code}]: {msg}")]
    Api { code: String, msg: String },
    #[error("解析响应失败: {0}")]
    Parse(String),
}

impl ApiError {
    pub fn is_param_error(&self) -> bool {
        matches!(self, ApiError::Api { code, .. } if code == "RequestParameterIsWrong")
    }
}

impl Serialize for ApiError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Balance {
    /// 余额（元）
    pub assets: f64,
    /// 累计消费（元）
    pub accumulate: f64,
    /// 代金券余额（元）
    pub voucher_balance: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct StockItem {
    pub gpu_name: String,
    pub idle: i64,
    pub total: i64,
    /// 按机器统计时：满足条件的机器台数（区域汇总数据里没有）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machines: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct StockQuery {
    pub region_sign: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cuda_v_from: Option<i64>,
    /// 价格上限，单位：元 × 1000
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price_to: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_name_set: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateInstanceReq {
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub data_center_list: Vec<String>,
    pub req_gpu_amount: i64,
    pub expand_system_disk_by_gb: i64,
    pub gpu_spec_uuid: String,
    pub image_uuid: String,
    pub cuda_v_from: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_command: Option<String>,
}

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    base: String,
    token: String,
}

impl Client {
    pub fn new(token: impl Into<String>) -> Self {
        let base = std::env::var("AUTODL_API_BASE").unwrap_or_else(|_| DEFAULT_BASE.to_string());
        Self::with_base(token, base)
    }

    pub fn with_base(token: impl Into<String>, base: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent("autodl-lookout/0.1")
            .build()
            .expect("reqwest client");
        Self { http, base: base.into().trim_end_matches('/').to_string(), token: token.into() }
    }

    async fn call(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> ApiResult<Value> {
        self.call_q(method, path, body, &[]).await
    }

    /// 注意：只有带 body 时才发 `Content-Type: application/json`（由 `.json()` 自动加）。
    /// 之前无 body 的余额接口也带了这个头，服务端会去解析空 body，返回 RequestParameterIsWrong。
    async fn call_q(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
        query: &[(&str, &str)],
    ) -> ApiResult<Value> {
        let token = clean_token(&self.token);
        let token = token.as_str();
        if token.is_empty() {
            return Err(ApiError::NoToken);
        }
        let url = format!("{}{}", self.base, path);
        let mut req = self.http.request(method, &url).header("Authorization", token);
        if !query.is_empty() {
            req = req.query(query);
        }
        if let Some(b) = body {
            req = req.json(&b);
        }
        let resp = req.send().await?;
        let status = resp.status();
        let text = resp.text().await?;
        let v: Value = serde_json::from_str(&text).map_err(|_| {
            ApiError::Parse(format!("HTTP {status}: {}", text.chars().take(200).collect::<String>()))
        })?;
        let code = v.get("code").and_then(|c| c.as_str()).unwrap_or("").to_string();
        if code != "Success" {
            let mut msg = v.get("msg").and_then(|m| m.as_str()).unwrap_or("").to_string();
            if msg.contains("登录") || code.to_lowercase().contains("auth") || code.to_lowercase().contains("login") {
                msg = format!(
                    "{msg}。Token 无效或已过期：请到 AutoDL 控制台「设置 → 开发者Token」重新生成并复制完整的 Token（不是网页登录凭证）"
                );
            }
            return Err(ApiError::Api {
                code: if code.is_empty() { format!("HTTP {status}") } else { code },
                msg,
            });
        }
        Ok(v.get("data").cloned().unwrap_or(Value::Null))
    }

    async fn post(&self, path: &str, body: Value) -> ApiResult<Value> {
        self.call(reqwest::Method::POST, path, Some(body)).await
    }

    // ---------- 通用 ----------

    pub async fn balance(&self) -> ApiResult<Balance> {
        const P: &str = "/api/v1/dev/wallet/balance";
        // 和官方示例一致：POST、不带 body。万一服务端仍要求 JSON，就退回发 `{}` 再试一次。
        let d = match self.call(reqwest::Method::POST, P, None).await {
            Err(e) if e.is_param_error() => self.post(P, json!({})).await?,
            r => r?,
        };
        let f = |k: &str| d.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0) / 1000.0;
        Ok(Balance { assets: f("assets"), accumulate: f("accumulate"), voucher_balance: f("voucher_balance") })
    }

    // ---------- 库存 ----------

    pub async fn gpu_stock(&self, q: &StockQuery) -> ApiResult<Vec<StockItem>> {
        let body = serde_json::to_value(q).map_err(|e| ApiError::Parse(e.to_string()))?;
        let d = self.post("/api/v1/dev/machine/region/gpu_stock", body).await?;
        parse_stock(&d)
    }

    // ---------- 容器实例 Pro ----------

    pub async fn create_instance(&self, req: &CreateInstanceReq) -> ApiResult<String> {
        let body = serde_json::to_value(req).map_err(|e| ApiError::Parse(e.to_string()))?;
        let d = self.post("/api/v1/dev/instance/pro/create", body).await?;
        d.as_str().map(|s| s.to_string()).ok_or_else(|| ApiError::Parse(format!("create 返回: {d}")))
    }

    pub async fn list_instances(&self, page_index: i64, page_size: i64) -> ApiResult<Value> {
        self.post("/api/v1/dev/instance/pro/list", json!({"page_index": page_index, "page_size": page_size}))
            .await
    }

    /// 文档写的是 GET + JSON body。有些网关会丢掉 GET 的 body，所以参数错误时改用查询参数再试一次。
    async fn get_instance(&self, path: &str, uuid: &str) -> ApiResult<Value> {
        match self.call(reqwest::Method::GET, path, Some(json!({"instance_uuid": uuid}))).await {
            Err(e) if e.is_param_error() => {
                self.call_q(reqwest::Method::GET, path, None, &[("instance_uuid", uuid)]).await
            }
            r => r,
        }
    }

    pub async fn snapshot(&self, uuid: &str) -> ApiResult<Value> {
        self.get_instance("/api/v1/dev/instance/pro/snapshot", uuid).await
    }

    pub async fn status(&self, uuid: &str) -> ApiResult<String> {
        let d = self.get_instance("/api/v1/dev/instance/pro/status", uuid).await?;
        Ok(d.as_str().map(|s| s.to_string()).unwrap_or_else(|| d.to_string()))
    }

    pub async fn power_on(&self, uuid: &str, start_command: Option<String>) -> ApiResult<()> {
        let mut b = json!({"instance_uuid": uuid, "payload": "gpu"});
        if let Some(c) = start_command.filter(|c| !c.trim().is_empty()) {
            b["start_command"] = json!(c);
        }
        self.post("/api/v1/dev/instance/pro/power_on", b).await.map(|_| ())
    }

    pub async fn power_off(&self, uuid: &str) -> ApiResult<()> {
        self.post("/api/v1/dev/instance/pro/power_off", json!({"instance_uuid": uuid})).await.map(|_| ())
    }

    pub async fn release(&self, uuid: &str) -> ApiResult<()> {
        self.post("/api/v1/dev/instance/pro/release", json!({"instance_uuid": uuid})).await.map(|_| ())
    }

    pub async fn save_image(&self, uuid: &str, name: &str) -> ApiResult<Value> {
        self.post("/api/v1/dev/instance/pro/image/save", json!({"instance_uuid": uuid, "image_name": name}))
            .await
    }

    pub async fn list_private_images(&self, page_index: i64, page_size: i64) -> ApiResult<Value> {
        self.post(
            "/api/v1/dev/instance/pro/image/private/list",
            json!({"page_index": page_index, "page_size": page_size}),
        )
        .await
    }
}

/// 清理用户粘贴的 Token：去掉首尾空白/引号、`Bearer ` 前缀、中间的换行和空格
pub fn clean_token(raw: &str) -> String {
    let mut t = raw.trim().trim_matches(|c| c == '"' || c == '\'' || c == '“' || c == '”').trim();
    for p in ["Bearer ", "bearer ", "Authorization:", "authorization:"] {
        if let Some(r) = t.strip_prefix(p) {
            t = r.trim();
        }
    }
    t.chars().filter(|c| !c.is_whitespace()).collect()
}

/// `data` 形如 `[{"RTX 4090": {"idle_gpu_num": 215, "total_gpu_num": 2285}}, ...]`
pub fn parse_stock(d: &Value) -> ApiResult<Vec<StockItem>> {
    let arr = match d {
        Value::Array(a) => a.clone(),
        Value::Null => vec![],
        // 防御：万一返回的是对象而不是数组
        Value::Object(m) => m.iter().map(|(k, v)| json!({ k.clone(): v.clone() })).collect(),
        other => return Err(ApiError::Parse(format!("库存数据格式异常: {other}"))),
    };
    let mut out = Vec::new();
    for item in arr {
        if let Value::Object(m) = item {
            for (name, v) in m {
                // 库存里还有 "CPU" / "CPU-close-HT" 这类无卡机器，不算显卡
                if name.to_uppercase().starts_with("CPU") {
                    continue;
                }
                out.push(StockItem {
                    machines: None,
                    gpu_name: name,
                    idle: v.get("idle_gpu_num").and_then(|x| x.as_i64()).unwrap_or(0),
                    total: v.get("total_gpu_num").and_then(|x| x.as_i64()).unwrap_or(0),
                });
            }
        }
    }
    out.sort_by(|a, b| b.idle.cmp(&a.idle).then(a.gpu_name.cmp(&b.gpu_name)));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_real_response_shape_and_skips_cpu() {
        let d = json!([
            {"vGPU-32GB": {"total_gpu_num": 2528, "idle_gpu_num": 103, "chip_corp": "nvidia", "cpu_arch": "x86"}},
            {"CPU": {"total_gpu_num": 320, "idle_gpu_num": 3, "chip_corp": "nvidia", "cpu_arch": "x86"}},
            {"CPU-close-HT": {"total_gpu_num": 6, "idle_gpu_num": 0}},
            {"RTX 4090": {"total_gpu_num": 1766, "idle_gpu_num": 50}}
        ]);
        let s = parse_stock(&d).unwrap();
        assert_eq!(s.iter().map(|i| i.gpu_name.as_str()).collect::<Vec<_>>(), vec!["vGPU-32GB", "RTX 4090"]);
    }

    #[test]
    fn parses_stock_example_from_docs() {
        let d = json!([
            {"RTX 4090": {"idle_gpu_num": 215, "total_gpu_num": 2285}},
            {"RTX 3080 Ti": {"idle_gpu_num": 20, "total_gpu_num": 392}},
            {"RTX A4000": {"idle_gpu_num": 6, "total_gpu_num": 24}}
        ]);
        let s = parse_stock(&d).unwrap();
        assert_eq!(s.len(), 3);
        assert_eq!(s[0], StockItem { gpu_name: "RTX 4090".into(), idle: 215, total: 2285, machines: None });
    }

    /// 起一个最小的 HTTP 假服务器：按顺序回复 replies，返回收到的原始请求
    async fn mock_server(replies: Vec<&'static str>) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = format!("http://{}", l.local_addr().unwrap());
        let h = tokio::spawn(async move {
            let mut reqs = vec![];
            for reply in replies {
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
                reqs.push(req);
            }
            reqs
        });
        (addr, h)
    }

    const PARAM_ERR: &str = r#"{"code":"RequestParameterIsWrong","msg":"请求参数错误","data":null}"#;

    #[tokio::test]
    async fn stock_request_shape() {
        let (base, h) = mock_server(vec![r#"{"code":"Success","msg":"","data":[{"RTX 5090":{"idle_gpu_num":2,"total_gpu_num":9}}]}"#]).await;
        let c = Client::with_base("tok123", base);
        let q = StockQuery { region_sign: "westDC3".into(), price_to: Some(3500), ..Default::default() };
        let r = c.gpu_stock(&q).await.unwrap();
        assert_eq!(r[0].idle, 2);
        let req = &h.await.unwrap()[0];
        assert!(req.starts_with("POST /api/v1/dev/machine/region/gpu_stock "), "{req}");
        assert!(req.to_lowercase().contains("authorization: tok123"));
        assert!(req.to_lowercase().contains("content-type: application/json"));
        assert!(req.contains(r#""region_sign":"westDC3""#) && req.contains(r#""price_to":3500"#));
    }

    #[tokio::test]
    async fn balance_sends_no_body_and_no_json_header() {
        let (base, h) = mock_server(vec![r#"{"code":"Success","data":{"assets":86420,"accumulate":1000,"voucher_balance":0},"msg":""}"#]).await;
        let b = Client::with_base(" tok \n", base).balance().await.unwrap();
        assert!((b.assets - 86.42).abs() < 1e-9);
        let req = h.await.unwrap()[0].to_lowercase();
        assert!(req.starts_with("post /api/v1/dev/wallet/balance "));
        assert!(!req.contains("content-type"), "balance must not send a JSON content-type: {req}");
        assert!(req.contains("authorization: tok\r\n"), "token is trimmed");
    }

    #[tokio::test]
    async fn balance_falls_back_to_empty_json_on_param_error() {
        let (base, h) = mock_server(vec![PARAM_ERR, r#"{"code":"Success","data":{"assets":1000},"msg":""}"#]).await;
        let b = Client::with_base("t", base).balance().await.unwrap();
        assert_eq!(b.assets, 1.0);
        let reqs = h.await.unwrap();
        assert!(reqs[1].ends_with("{}"), "retry sends {{}}: {}", reqs[1]);
    }

    #[tokio::test]
    async fn snapshot_get_body_then_query_fallback() {
        let (base, h) = mock_server(vec![PARAM_ERR, r#"{"code":"InstanceNotFound","msg":"实例不存在","data":null}"#]).await;
        let err = Client::with_base("t", base).snapshot("pro-x").await.unwrap_err();
        assert!(err.to_string().contains("实例不存在"));
        let reqs = h.await.unwrap();
        assert!(reqs[0].starts_with("GET /api/v1/dev/instance/pro/snapshot ") && reqs[0].contains(r#""instance_uuid":"pro-x""#));
        assert!(reqs[1].starts_with("GET /api/v1/dev/instance/pro/snapshot?instance_uuid=pro-x "), "{}", reqs[1]);
    }

    #[test]
    fn cleans_pasted_tokens() {
        assert_eq!(clean_token("  \"Bearer abc.def\"\n"), "abc.def");
        assert_eq!(clean_token("Authorization: abc\r\ndef"), "abcdef");
        assert_eq!(clean_token("plain"), "plain");
    }

    #[tokio::test]
    async fn login_timeout_gets_actionable_message() {
        let (base, _h) = mock_server(vec![r#"{"code":"AuthorizeFailed","msg":"登录超时","data":null}"#]).await;
        let e = Client::with_base("t", base).balance().await.unwrap_err().to_string();
        assert!(e.contains("登录超时") && e.contains("开发者Token"), "{e}");
    }

    #[test]
    fn stock_query_skips_none() {
        let q = StockQuery { region_sign: "westDC3".into(), ..Default::default() };
        assert_eq!(serde_json::to_value(&q).unwrap(), json!({"region_sign": "westDC3"}));
    }
}
