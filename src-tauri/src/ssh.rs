//! SSH 连接（russh）：测试连接、推送公钥、执行采集脚本。交互终端用系统终端（见 terminal.rs）。
//!
//! - 连接按「主机 + 端口 + 用户」复用，出错时丢掉重连一次
//! - 主机密钥第一次连接时记住 SHA256 指纹（存 kv 表，键 `hostkey:<主机>:<端口>`），之后变了就拒绝，
//!   错误信息以 `HOSTKEY_CHANGED:` 开头，界面据此显示「信任新密钥」按钮
//! - 认证：先试私钥（指定的，或软件生成的那把），再试密码；密码只在内存里用，不写日志

use crate::store::Store;
use russh::client;
use russh::keys::{self, HashAlg, PrivateKey, PrivateKeyWithHashAlg};
use russh::ChannelMsg;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const HOSTKEY_CHANGED: &str = "HOSTKEY_CHANGED:";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const EXEC_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Default)]
pub struct Target {
    pub host: String,
    pub port: u16,
    pub user: String,
    /// 依次尝试的私钥文件
    pub keys: Vec<PathBuf>,
    pub password: Option<String>,
}

impl Target {
    pub fn key(&self) -> String {
        format!("{}@{}:{}", self.user, self.host, self.port)
    }
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct ExecOut {
    pub code: Option<u32>,
    pub stdout: String,
    pub stderr: String,
}

/// 主机密钥检查的结果
#[derive(Debug, PartialEq)]
pub enum HostKeyCheck {
    /// 第一次见，记下来
    Learn,
    Match,
    Changed,
}

pub fn check_fingerprint(stored: Option<&str>, seen: &str) -> HostKeyCheck {
    match stored {
        None | Some("") => HostKeyCheck::Learn,
        Some(s) if s == seen => HostKeyCheck::Match,
        Some(_) => HostKeyCheck::Changed,
    }
}

pub fn hostkey_kv(host: &str, port: u16) -> String {
    format!("hostkey:{host}:{port}")
}

struct Handler {
    store: Arc<Store>,
    kv: String,
    changed: Arc<Mutex<Option<String>>>,
}

impl client::Handler for Handler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &keys::PublicKey) -> Result<bool, Self::Error> {
        let fp = key.fingerprint(HashAlg::Sha256).to_string();
        let stored = self.store.kv_get(&self.kv).ok().flatten();
        Ok(match check_fingerprint(stored.as_deref(), &fp) {
            HostKeyCheck::Learn => {
                let _ = self.store.kv_set(&self.kv, &fp);
                true
            }
            HostKeyCheck::Match => true,
            HostKeyCheck::Changed => {
                *self.changed.lock().unwrap() = Some(fp);
                false
            }
        })
    }
}

type Handle = client::Handle<Handler>;

pub struct SshPool {
    store: Arc<Store>,
    conns: tokio::sync::Mutex<HashMap<String, Arc<Handle>>>,
}

impl SshPool {
    pub fn new(store: Arc<Store>) -> Self {
        Self { store, conns: tokio::sync::Mutex::new(HashMap::new()) }
    }

    async fn connect(&self, t: &Target) -> Result<Arc<Handle>, String> {
        let config = Arc::new(client::Config {
            inactivity_timeout: Some(Duration::from_secs(300)),
            keepalive_interval: Some(Duration::from_secs(30)),
            ..Default::default()
        });
        let changed = Arc::new(Mutex::new(None));
        let handler = Handler { store: self.store.clone(), kv: hostkey_kv(&t.host, t.port), changed: changed.clone() };
        let addr = (t.host.trim_matches(|c| c == '[' || c == ']').to_string(), t.port);
        let mut h = match tokio::time::timeout(CONNECT_TIMEOUT, client::connect(config, addr, handler)).await {
            Err(_) => return Err(format!("连接 {}:{} 超时，检查地址、端口和网络（实验室服务器可能要先连 VPN）", t.host, t.port)),
            Ok(Err(e)) => {
                if let Some(fp) = changed.lock().unwrap().take() {
                    return Err(format!(
                        "{HOSTKEY_CHANGED}{fp}|{}:{} 的主机密钥和上次连接时不一样。AutoDL 实例换了机器或重装系统时会这样，也可能是有人冒充。确认没问题后可以信任新的密钥。",
                        t.host, t.port
                    ));
                }
                return Err(format!("连接 {}:{} 失败：{e}", t.host, t.port));
            }
            Ok(Ok(h)) => h,
        };

        let mut tried = vec![];
        for path in t.keys.iter().filter(|p| p.exists()) {
            let key = match load_key(path) {
                Ok(k) => k,
                Err(e) => {
                    tried.push(e);
                    continue;
                }
            };
            let hash = h.best_supported_rsa_hash().await.ok().flatten().flatten();
            let r = h.authenticate_publickey(&t.user, PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await.map_err(|e| e.to_string())?;
            if r.success() {
                return Ok(Arc::new(h));
            }
            tried.push(format!("私钥 {} 被拒绝", path.display()));
        }
        if let Some(pw) = &t.password {
            let r = h.authenticate_password(&t.user, pw).await.map_err(|e| e.to_string())?;
            if r.success() {
                return Ok(Arc::new(h));
            }
            tried.push("密码不对".into());
        }
        if tried.is_empty() {
            tried.push("没有可用的私钥或密码".into());
        }
        Err(format!("登录 {} 失败：{}", t.key(), tried.join("；")))
    }

    async fn handle(&self, t: &Target, fresh: bool) -> Result<Arc<Handle>, String> {
        let k = t.key();
        let mut conns = self.conns.lock().await;
        if !fresh {
            if let Some(h) = conns.get(&k).filter(|h| !h.is_closed()) {
                return Ok(h.clone());
            }
        }
        conns.remove(&k);
        drop(conns);
        let h = self.connect(t).await?;
        self.conns.lock().await.insert(k, h.clone());
        Ok(h)
    }

    pub async fn forget(&self, t: &Target) {
        self.conns.lock().await.remove(&t.key());
    }

    /// 执行一条命令，复用连接；通道打不开时重连一次
    pub async fn exec(&self, t: &Target, cmd: &str) -> Result<ExecOut, String> {
        let h = self.handle(t, false).await?;
        let ch = match h.channel_open_session().await {
            Ok(c) => c,
            Err(_) => self.handle(t, true).await?.channel_open_session().await.map_err(|e| format!("打开会话失败：{e}"))?,
        };
        let run = async move {
            ch.exec(true, cmd).await.map_err(|e| e.to_string())?;
            let mut ch = ch;
            let mut out = ExecOut::default();
            let (mut so, mut se) = (Vec::new(), Vec::new());
            while let Some(msg) = ch.wait().await {
                match msg {
                    ChannelMsg::Data { ref data } => so.extend_from_slice(data),
                    ChannelMsg::ExtendedData { ref data, .. } => se.extend_from_slice(data),
                    ChannelMsg::ExitStatus { exit_status } => out.code = Some(exit_status),
                    _ => {}
                }
            }
            out.stdout = String::from_utf8_lossy(&so).into_owned();
            out.stderr = String::from_utf8_lossy(&se).into_owned();
            Ok::<_, String>(out)
        };
        match tokio::time::timeout(EXEC_TIMEOUT, run).await {
            Ok(r) => r,
            Err(_) => {
                self.forget(t).await;
                Err(format!("在 {} 上执行命令超时", t.key()))
            }
        }
    }

    /// 执行一条长时间运行的命令，把输出按块交给 on_data，直到命令结束或 stop 变成 true。
    /// stop 时关闭通道：远程的 sh 循环写 stdout 失败（SIGPIPE）后会自己退出，不会残留在服务器上。
    /// 返回 Ok(true) 表示是被 stop 停掉的，Ok(false) 表示远程命令自己结束了。
    pub async fn stream<F: FnMut(&[u8])>(&self, t: &Target, cmd: &str, mut on_data: F, mut stop: tokio::sync::watch::Receiver<bool>)
        -> Result<bool, String> {
        let h = self.handle(t, false).await?;
        let mut ch = match h.channel_open_session().await {
            Ok(c) => c,
            Err(_) => self.handle(t, true).await?.channel_open_session().await.map_err(|e| format!("打开会话失败：{e}"))?,
        };
        ch.exec(true, cmd).await.map_err(|e| e.to_string())?;
        loop {
            tokio::select! {
                changed = stop.changed() => {
                    if changed.is_err() || *stop.borrow() {
                        let _ = ch.close().await;
                        return Ok(true);
                    }
                }
                msg = ch.wait() => match msg {
                    Some(ChannelMsg::Data { ref data }) => on_data(data),
                    Some(_) => {}
                    None => return Ok(false),
                },
            }
        }
    }

    /// 测试连接：返回往返耗时（毫秒）和远程系统一句话描述
    pub async fn probe(&self, t: &Target) -> Result<(u128, String), String> {
        self.forget(t).await;
        let t0 = Instant::now();
        let out = self.exec(t, "uname -srm; (. /etc/os-release 2>/dev/null && echo \"$PRETTY_NAME\")").await?;
        Ok((t0.elapsed().as_millis(), out.stdout.lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" · ")))
    }
}

/// 把流式输出按分隔行（如 `@@frame`）切成一帧一帧；不完整的尾巴留到下次
#[derive(Default)]
pub struct FrameSplitter {
    buf: String,
}

impl FrameSplitter {
    pub fn push(&mut self, data: &[u8], sep: &str) -> Vec<String> {
        self.buf.push_str(&String::from_utf8_lossy(data));
        let mut out = vec![];
        let marker = format!("{sep}\n");
        while let Some(i) = self.buf.find(&marker) {
            out.push(self.buf[..i].to_string());
            self.buf.drain(..i + marker.len());
        }
        // 防止对面一直不输出分隔行把内存撑大
        if self.buf.len() > 1 << 20 {
            self.buf.clear();
        }
        out
    }
}

fn load_key(path: &Path) -> Result<PrivateKey, String> {
    keys::load_secret_key(path, None).map_err(|e| {
        let s = e.to_string();
        if s.to_lowercase().contains("encrypt") || s.to_lowercase().contains("password") {
            format!("私钥 {} 有口令，暂不支持，可以先用「打开终端」或换成软件生成的密钥", path.display())
        } else {
            format!("读不了私钥 {}：{s}", path.display())
        }
    })
}

/* ---------------- 软件自己的密钥 ---------------- */

pub fn own_key_path() -> Option<PathBuf> {
    crate::sshconfig::ssh_dir().map(|d| d.join("autodl_lookout_ed25519"))
}

/// 读软件生成的公钥（一行 OpenSSH 格式）
pub fn own_public_key() -> Option<String> {
    let p = own_key_path()?.with_extension("pub");
    std::fs::read_to_string(p).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// 生成 ed25519 密钥；已经有了就直接返回公钥，不覆盖
pub fn ensure_own_key() -> Result<String, String> {
    if let Some(p) = own_public_key() {
        return Ok(p);
    }
    let path = own_key_path().ok_or("找不到用户目录")?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| format!("创建 .ssh 目录失败：{e}"))?;
    let mut key = PrivateKey::random(&mut rand_core::OsRng, keys::Algorithm::Ed25519).map_err(|e| e.to_string())?;
    key.set_comment("autodl-lookout");
    let private = key.to_openssh(keys::ssh_key::LineEnding::LF).map_err(|e| e.to_string())?;
    let public = key.public_key().to_openssh().map_err(|e| e.to_string())?;
    std::fs::write(&path, private.as_bytes()).map_err(|e| format!("写入私钥失败：{e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::write(path.with_extension("pub"), format!("{public}\n")).map_err(|e| format!("写入公钥失败：{e}"))?;
    Ok(public)
}

/// 把公钥追加到远程 authorized_keys（已有就不重复加）。公钥只允许 OpenSSH 一行格式里的字符，避免拼脚本出问题
pub fn push_key_script(pubkey: &str) -> Result<String, String> {
    let k = pubkey.trim();
    let ok = k.split_whitespace().count() >= 2
        && k.starts_with("ssh-")
        && k.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '+' | '/' | '=' | '-' | '_' | '.' | '@'));
    if !ok {
        return Err("公钥格式不对".into());
    }
    Ok(format!(
        "umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && \
         (grep -qxF '{k}' ~/.ssh/authorized_keys || echo '{k}' >> ~/.ssh/authorized_keys) && \
         chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys && echo ok"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::server::{self, Auth, Msg, Server as _, Session};
    use russh::{Channel, ChannelId, CryptoVec};

    #[test]
    fn fingerprint_decisions() {
        assert_eq!(check_fingerprint(None, "SHA256:a"), HostKeyCheck::Learn);
        assert_eq!(check_fingerprint(Some(""), "SHA256:a"), HostKeyCheck::Learn);
        assert_eq!(check_fingerprint(Some("SHA256:a"), "SHA256:a"), HostKeyCheck::Match);
        assert_eq!(check_fingerprint(Some("SHA256:a"), "SHA256:b"), HostKeyCheck::Changed);
    }

    #[test]
    fn push_script_rejects_weird_keys() {
        let k = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTests autodl-lookout";
        let s = push_key_script(k).unwrap();
        assert!(s.contains(&format!("grep -qxF '{k}'")));
        assert!(push_key_script("ssh-ed25519 AAAA'; rm -rf ~ #").is_err());
        assert!(push_key_script("not a key").is_err());
    }

    /* 本地起一个 russh 服务器，测真实的连接、认证、执行和主机密钥检查 */
    #[derive(Clone)]
    struct TestServer {
        allowed_key: Option<keys::PublicKey>,
    }
    impl server::Server for TestServer {
        type Handler = Self;
        fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
            self.clone()
        }
    }
    impl server::Handler for TestServer {
        type Error = russh::Error;
        async fn auth_password(&mut self, user: &str, pw: &str) -> Result<Auth, Self::Error> {
            Ok(if user == "tk" && pw == "fake-pw" { Auth::Accept } else { Auth::reject() })
        }
        async fn auth_publickey(&mut self, _: &str, key: &keys::PublicKey) -> Result<Auth, Self::Error> {
            Ok(if self.allowed_key.as_ref().map(|k| k.key_data() == key.key_data()).unwrap_or(false) { Auth::Accept } else { Auth::reject() })
        }
        async fn channel_open_session(&mut self, _: Channel<Msg>, _: &mut Session) -> Result<bool, Self::Error> {
            Ok(true)
        }
        async fn exec_request(&mut self, ch: ChannelId, data: &[u8], s: &mut Session) -> Result<(), Self::Error> {
            let cmd = String::from_utf8_lossy(data).to_string();
            if cmd.starts_with("forever") {
                // 模拟常驻的采集循环：输出两帧后一直不结束
                s.data(ch, CryptoVec::from("a\n@@frame\nb\n@@fr"))?;
                s.data(ch, CryptoVec::from("ame\n"))?;
                return Ok(());
            }
            s.data(ch, CryptoVec::from(format!("ran: {cmd}\n")))?;
            s.extended_data(ch, 1, CryptoVec::from("warn\n"))?;
            s.exit_status_request(ch, 0)?;
            s.eof(ch)?;
            s.close(ch)?;
            Ok(())
        }
    }

    async fn start(host_key: PrivateKey, allowed_key: Option<keys::PublicKey>) -> u16 {
        let config = Arc::new(server::Config {
            keys: vec![host_key],
            auth_rejection_time: Duration::from_millis(10),
            auth_rejection_time_initial: Some(Duration::from_millis(0)),
            ..Default::default()
        });
        let sock = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = sock.local_addr().unwrap().port();
        let mut srv = TestServer { allowed_key };
        tokio::spawn(async move {
            let _ = srv.run_on_socket(config, &sock).await;
        });
        port
    }

    fn rand_key() -> PrivateKey {
        PrivateKey::random(&mut rand_core::OsRng, keys::Algorithm::Ed25519).unwrap()
    }

    #[tokio::test]
    async fn password_login_exec_and_hostkey_pinning() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let pool = SshPool::new(store.clone());
        let port = start(rand_key(), None).await;
        let t = Target { host: "127.0.0.1".into(), port, user: "tk".into(), keys: vec![], password: Some("fake-pw".into()) };

        let out = pool.exec(&t, "echo hi").await.unwrap();
        assert_eq!(out.stdout, "ran: echo hi\n");
        assert_eq!(out.stderr, "warn\n");
        assert_eq!(out.code, Some(0));
        // 第一次连接记住了指纹
        let fp = store.kv_get(&hostkey_kv("127.0.0.1", port)).unwrap().unwrap();
        assert!(fp.starts_with("SHA256:"));
        // 复用连接再执行一次
        assert_eq!(pool.exec(&t, "true").await.unwrap().stdout, "ran: true\n");

        // 密码错
        let bad = Target { password: Some("nope".into()), ..t.clone() };
        pool.forget(&bad).await;
        let e = pool.exec(&bad, "x").await.unwrap_err();
        assert!(e.contains("密码不对") && !e.contains("nope"), "错误里不能带密码：{e}");

        // 同一端口换了主机密钥：拒绝
        store.kv_set(&hostkey_kv("127.0.0.1", port), "SHA256:somethingelse").unwrap();
        pool.forget(&t).await;
        let e = pool.exec(&t, "x").await.unwrap_err();
        assert!(e.starts_with(HOSTKEY_CHANGED), "{e}");
    }

    #[test]
    fn splits_frames_across_chunks() {
        let mut f = FrameSplitter::default();
        assert!(f.push(b"gpu 1\n@@fr", "@@frame").is_empty());
        assert_eq!(f.push(b"ame\ngpu 2\n@@frame\ngpu 3", "@@frame"), vec!["gpu 1\n", "gpu 2\n"]);
        assert_eq!(f.push(b"\n@@frame\n", "@@frame"), vec!["gpu 3\n"]);
    }

    #[tokio::test]
    async fn stream_delivers_frames_and_stops() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let pool = Arc::new(SshPool::new(store));
        let port = start(rand_key(), None).await;
        let t = Target { host: "127.0.0.1".into(), port, user: "tk".into(), keys: vec![], password: Some("fake-pw".into()) };
        // 命令自己结束
        let mut got = String::new();
        let (_tx0, rx0) = tokio::sync::watch::channel(false);
        assert_eq!(pool.stream(&t, "echo once", |d| got.push_str(&String::from_utf8_lossy(d)), rx0).await, Ok(false));
        assert_eq!(got, "ran: echo once\n");
        // 常驻命令：收到两帧后手动停掉
        let (tx, rx) = tokio::sync::watch::channel(false);
        let frames = Arc::new(Mutex::new(Vec::new()));
        let (p2, t2, f2) = (pool.clone(), t.clone(), frames.clone());
        let task = tokio::spawn(async move {
            let mut sp = FrameSplitter::default();
            p2.stream(&t2, "forever", |d| f2.lock().unwrap().extend(sp.push(d, "@@frame")), rx).await
        });
        for _ in 0..50 {
            if frames.lock().unwrap().len() >= 2 { break; }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(*frames.lock().unwrap(), vec!["a\n".to_string(), "b\n".to_string()]);
        tx.send(true).unwrap();
        assert_eq!(tokio::time::timeout(Duration::from_secs(2), task).await.unwrap().unwrap(), Ok(true));
    }

    #[tokio::test]
    async fn key_login_after_push() {
        let dir = std::env::temp_dir().join(format!("lookout-ssh-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let client_key = rand_key();
        let key_path = dir.join("id_test");
        std::fs::write(&key_path, client_key.to_openssh(keys::ssh_key::LineEnding::LF).unwrap().as_bytes()).unwrap();

        let store = Arc::new(Store::open_in_memory().unwrap());
        let pool = SshPool::new(store);
        let port = start(rand_key(), Some(client_key.public_key().clone())).await;
        // 只有私钥、没有密码也能登录
        let t = Target { host: "127.0.0.1".into(), port, user: "tk".into(), keys: vec![key_path.clone()], password: None };
        assert_eq!(pool.exec(&t, "id").await.unwrap().code, Some(0));
        // 私钥不被接受时退回密码
        let other = dir.join("id_other");
        std::fs::write(&other, rand_key().to_openssh(keys::ssh_key::LineEnding::LF).unwrap().as_bytes()).unwrap();
        let t2 = Target { keys: vec![other], password: Some("fake-pw".into()), ..t.clone() };
        pool.forget(&t2).await;
        assert_eq!(pool.exec(&t2, "id").await.unwrap().code, Some(0));
        let _ = std::fs::remove_dir_all(dir);
    }
}
