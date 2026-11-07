//! ~/.ssh/config 的读写，以及 SSH 目标的解析和校验。
//!
//! 软件只改自己标记的一段（`# >>> autodl-lookout >>>` 到 `# <<< autodl-lookout <<<`），
//! 用户手写的配置一个字都不动；写之前先备份。AutoDL 实例重新开机后端口可能会变，
//! 同步这一段就能让终端、VS Code、scp 一直用同一个名字连上去。

use std::path::PathBuf;

pub const BEGIN: &str = "# >>> autodl-lookout >>>";
pub const END: &str = "# <<< autodl-lookout <<<";

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct HostEntry {
    /// Host 名（别名）
    pub alias: String,
    pub host: String,
    pub port: i64,
    pub user: String,
    pub identity_file: Option<String>,
}

/// AutoDL 的 SSH 命令形如 `ssh -p 12345 root@region-9.autodl.pro`
pub fn parse_ssh_command(cmd: &str) -> Option<(String, i64, String)> {
    let parts: Vec<&str> = cmd.split_whitespace().collect();
    if parts.first() != Some(&"ssh") {
        return None;
    }
    let mut port = 22;
    let mut target = None;
    let mut i = 1;
    while i < parts.len() {
        match parts[i] {
            "-p" => {
                port = parts.get(i + 1)?.parse().ok()?;
                i += 2;
            }
            p if p.starts_with("-p") && p.len() > 2 => {
                port = p[2..].parse().ok()?;
                i += 1;
            }
            p if !p.starts_with('-') => {
                target = Some(p);
                i += 1;
            }
            _ => i += 1,
        }
    }
    let (user, host) = target?.split_once('@')?;
    (valid_user(user) && valid_host(host)).then(|| (host.to_string(), port, user.to_string()))
}

/// 主机名 / IP 只允许这些字符：拼进终端命令时不会被当成选项或 shell 语法
pub fn valid_host(h: &str) -> bool {
    !h.is_empty() && h.len() <= 253 && !h.starts_with('-')
        && h.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']' | '_'))
}

pub fn valid_user(u: &str) -> bool {
    !u.is_empty() && u.len() <= 64 && !u.starts_with('-')
        && u.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

pub fn valid_alias(a: &str) -> bool {
    !a.is_empty() && a.len() <= 64 && !a.starts_with('-')
        && a.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// 名字里的中文等字符去掉，只留字母数字和 - _；全被去掉时用 fallback
pub fn slug(name: &str, fallback: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c.to_ascii_lowercase() } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if s.is_empty() { fallback.to_string() } else { s.chars().take(32).collect() }
}

/// 解析 ~/.ssh/config 里能直接用的 Host（跳过通配符和软件自己管理的那一段）
pub fn parse_config(text: &str) -> Vec<HostEntry> {
    let mut out: Vec<HostEntry> = vec![];
    let mut cur: Vec<HostEntry> = vec![];
    let mut in_managed = false;
    let flush = |cur: &mut Vec<HostEntry>, out: &mut Vec<HostEntry>| {
        for mut h in cur.drain(..) {
            if h.host.is_empty() {
                h.host = h.alias.clone();
            }
            if valid_alias(&h.alias) && valid_host(&h.host) {
                out.push(h);
            }
        }
    };
    for raw in text.lines() {
        let line = raw.trim();
        if line == BEGIN {
            flush(&mut cur, &mut out);
            in_managed = true;
            continue;
        }
        if line == END {
            in_managed = false;
            continue;
        }
        if in_managed || line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (k, v) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => (k.to_ascii_lowercase(), v.trim().trim_start_matches('=').trim().trim_matches('"').to_string()),
            None => continue,
        };
        match k.as_str() {
            "host" => {
                flush(&mut cur, &mut out);
                cur = v
                    .split_whitespace()
                    .filter(|a| !a.contains('*') && !a.contains('?') && !a.starts_with('!'))
                    .map(|a| HostEntry { alias: a.to_string(), port: 22, ..Default::default() })
                    .collect();
            }
            "match" => flush(&mut cur, &mut out),
            "hostname" => cur.iter_mut().for_each(|h| h.host = v.clone()),
            "port" => {
                if let Ok(p) = v.parse() {
                    cur.iter_mut().for_each(|h| h.port = p);
                }
            }
            "user" => cur.iter_mut().for_each(|h| h.user = v.clone()),
            "identityfile" => cur.iter_mut().for_each(|h| h.identity_file = Some(v.clone())),
            _ => {}
        }
    }
    flush(&mut cur, &mut out);
    out
}

/// 软件管理的那一段
pub fn render_block(entries: &[HostEntry]) -> String {
    let mut s = String::new();
    s.push_str(BEGIN);
    s.push_str("\n# 由 AutoDL Lookout 自动生成，下次同步会被覆盖；要自定义请写在这一段外面\n");
    for h in entries {
        s.push_str(&format!("Host {}\n    HostName {}\n    Port {}\n    User {}\n", h.alias, h.host, h.port, h.user));
        if let Some(f) = &h.identity_file {
            s.push_str(&format!("    IdentityFile \"{f}\"\n"));
        }
        s.push_str("    ServerAliveInterval 30\n");
    }
    s.push_str(END);
    s.push('\n');
    s
}

/// 替换已有的那一段；没有就加到文件开头（ssh 取第一个匹配的值，放开头才不会被前面的通配规则盖掉）
pub fn replace_block(text: &str, block: &str) -> String {
    if let (Some(a), Some(b)) = (text.find(BEGIN), text.find(END)) {
        if a < b {
            let mut end = b + END.len();
            if text[end..].starts_with("\r\n") {
                end += 2;
            } else if text[end..].starts_with('\n') {
                end += 1;
            }
            return format!("{}{}{}", &text[..a], block, &text[end..]);
        }
    }
    if text.trim().is_empty() {
        block.to_string()
    } else {
        format!("{block}\n{text}")
    }
}

pub fn ssh_dir() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(home).join(".ssh"))
}

pub fn config_path() -> Option<PathBuf> {
    ssh_dir().map(|d| d.join("config"))
}

/// 写回 ~/.ssh/config：内容没变就不写；变了先备份成 config.autodl-lookout.bak
pub fn write_block(entries: &[HostEntry]) -> Result<bool, String> {
    let path = config_path().ok_or("找不到用户目录")?;
    let old = std::fs::read_to_string(&path).unwrap_or_default();
    let new = replace_block(&old, &render_block(entries));
    if new == old {
        return Ok(false);
    }
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| format!("创建 .ssh 目录失败：{e}"))?;
    if !old.is_empty() {
        std::fs::write(path.with_file_name("config.autodl-lookout.bak"), &old).map_err(|e| format!("备份 SSH 配置失败：{e}"))?;
    }
    std::fs::write(&path, new).map_err(|e| format!("写入 SSH 配置失败：{e}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_autodl_ssh_command() {
        assert_eq!(parse_ssh_command("ssh -p 32145 root@region-9.autodl.pro"), Some(("region-9.autodl.pro".into(), 32145, "root".into())));
        assert_eq!(parse_ssh_command("ssh root@1.2.3.4"), Some(("1.2.3.4".into(), 22, "root".into())));
        assert_eq!(parse_ssh_command("ssh -p32145 root@h.example"), Some(("h.example".into(), 32145, "root".into())));
        assert_eq!(parse_ssh_command("scp a b"), None);
        assert_eq!(parse_ssh_command("ssh -p 22 root@h;rm -rf /"), None, "不合法的主机名不能通过");
    }

    #[test]
    fn validates_targets() {
        assert!(valid_host("region-9.autodl.pro") && valid_host("10.0.0.8") && valid_host("[::1]"));
        assert!(!valid_host("-oProxyCommand=x") && !valid_host("a b") && !valid_host("a'b") && !valid_host(""));
        assert!(valid_user("root") && !valid_user("-l") && !valid_user("a$b"));
    }

    #[test]
    fn slug_keeps_ascii() {
        assert_eq!(slug("qwen-lora", "x"), "qwen-lora");
        assert_eq!(slug("实验室 A100 (2号)", "x"), "a100-2");
        assert_eq!(slug("训练机", "fallback"), "fallback");
    }

    const CONFIG: &str = "\
Host *
    ServerAliveInterval 60

Host lab lab-alias
    HostName 10.0.0.8
    User tk
    Port 2222
    IdentityFile ~/.ssh/id_lab

Host cloud
  HostName=47.1.2.3
  User ubuntu

# >>> autodl-lookout >>>
Host autodl-old-1
    HostName region-1.autodl.pro
    Port 1
    User root
# <<< autodl-lookout <<<

Host gh
    HostName github.com
    User git
";

    #[test]
    fn parses_config_hosts() {
        let hs = parse_config(CONFIG);
        let names: Vec<&str> = hs.iter().map(|h| h.alias.as_str()).collect();
        assert_eq!(names, vec!["lab", "lab-alias", "cloud", "gh"], "跳过通配符和软件管理的段");
        assert_eq!(hs[0], HostEntry { alias: "lab".into(), host: "10.0.0.8".into(), port: 2222, user: "tk".into(), identity_file: Some("~/.ssh/id_lab".into()) });
        assert_eq!((hs[2].host.as_str(), hs[2].user.as_str(), hs[2].port), ("47.1.2.3", "ubuntu", 22));
    }

    #[test]
    fn replaces_only_managed_block() {
        let block = render_block(&[HostEntry { alias: "autodl-qwen".into(), host: "region-9.autodl.pro".into(), port: 32145, user: "root".into(), identity_file: None }]);
        let out = replace_block(CONFIG, &block);
        assert!(out.contains("Port 32145") && !out.contains("autodl-old-1"));
        assert!(out.starts_with("Host *\n") && out.contains("Host gh\n    HostName github.com"), "用户手写的部分不动");
        assert_eq!(replace_block(&out, &block), out, "再同步一次内容不变");
        // 没有管理段时加到开头
        let fresh = replace_block("Host gh\n  User git\n", &block);
        assert!(fresh.starts_with(BEGIN) && fresh.ends_with("Host gh\n  User git\n"));
        assert_eq!(replace_block("", &block), block);
    }
}
