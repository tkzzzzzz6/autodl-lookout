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

/// 手动开机会开始计费：界面上要点两次确认，这里只做手动操作，不接入规则的自动动作
#[tauri::command]
pub async fn regular_power_on(st: State<'_, AppState>, uuid: String, non_gpu: bool) -> R<()> {
    market(&st)?.power_on(&uuid, non_gpu).await.map_err(s)?;
    let mode = if non_gpu { "（无卡模式）" } else { "" };
    let _ = st.store.log(now(), "info", "manual", None, &format!("普通实例开机{mode} {uuid}"));
    Ok(())
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
