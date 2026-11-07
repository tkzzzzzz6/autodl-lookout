//! 凭证存储：优先系统钥匙串（macOS Keychain / Windows 凭据管理器），
//! 钥匙串不可用时退回本地数据库。
//! - Dev：开发者 Token（余额、实例管理，官方开放 API）
//! - Web：网页登录凭证（算力市场库存，控制台内部接口）

use crate::store::Store;

const SERVICE: &str = "dev.local.autodl-lookout";
/// 改名前（autodl-manager）用的钥匙串服务名，首次启动时把凭证搬过来
const LEGACY_SERVICE: &str = "dev.local.autodl-manager";

#[derive(Clone, Copy)]
pub enum Kind {
    Dev,
    Web,
}

impl Kind {
    fn user(self) -> &'static str {
        match self {
            Kind::Dev => "developer-token",
            Kind::Web => "web-token",
        }
    }
    fn fallback_key(self) -> &'static str {
        match self {
            Kind::Dev => "token_fallback",
            Kind::Web => "web_token_fallback",
        }
    }
}

fn entry(k: Kind) -> Option<keyring::Entry> {
    keyring::Entry::new(SERVICE, k.user()).ok()
}

pub fn load(store: &Store, k: Kind) -> Option<String> {
    if let Some(t) = entry(k).and_then(|e| e.get_password().ok()) {
        if !t.is_empty() {
            return Some(t);
        }
    }
    // 旧名字下存的凭证：搬到新名字下，再删掉旧的
    if let Some(old) = keyring::Entry::new(LEGACY_SERVICE, k.user()).ok() {
        if let Some(t) = old.get_password().ok().filter(|t| !t.is_empty()) {
            if save(store, k, &t).is_ok() {
                let _ = old.delete_credential();
            }
            return Some(t);
        }
    }
    store.kv_get(k.fallback_key()).ok().flatten().filter(|t| !t.is_empty())
}

/// 返回 true 表示存进了系统钥匙串，false 表示退回到本地数据库
pub fn save(store: &Store, k: Kind, token: &str) -> Result<bool, String> {
    if let Some(e) = entry(k) {
        if e.set_password(token).is_ok() && e.get_password().ok().as_deref() == Some(token) {
            let _ = store.kv_set(k.fallback_key(), "");
            return Ok(true);
        }
    }
    store.kv_set(k.fallback_key(), token)?;
    Ok(false)
}

pub fn clear(store: &Store, k: Kind) {
    if let Some(e) = entry(k) {
        let _ = e.delete_credential();
    }
    let _ = store.kv_set(k.fallback_key(), "");
}

/// 自己的 SSH 服务器的密码：钥匙串里的账户名是 `server-<id>`，钥匙串不可用时退回数据库
pub fn load_server_password(store: &Store, id: i64) -> Option<String> {
    let user = format!("server-{id}");
    if let Some(t) = keyring::Entry::new(SERVICE, &user).ok().and_then(|e| e.get_password().ok()) {
        if !t.is_empty() {
            return Some(t);
        }
    }
    store.kv_get(&format!("{user}_fallback")).ok().flatten().filter(|t| !t.is_empty())
}

pub fn save_server_password(store: &Store, id: i64, password: &str) -> Result<bool, String> {
    let user = format!("server-{id}");
    if let Ok(e) = keyring::Entry::new(SERVICE, &user) {
        if e.set_password(password).is_ok() && e.get_password().ok().as_deref() == Some(password) {
            let _ = store.kv_set(&format!("{user}_fallback"), "");
            return Ok(true);
        }
    }
    store.kv_set(&format!("{user}_fallback"), password)?;
    Ok(false)
}

pub fn clear_server_password(store: &Store, id: i64) {
    let user = format!("server-{id}");
    if let Ok(e) = keyring::Entry::new(SERVICE, &user) {
        let _ = e.delete_credential();
    }
    let _ = store.kv_set(&format!("{user}_fallback"), "");
}
