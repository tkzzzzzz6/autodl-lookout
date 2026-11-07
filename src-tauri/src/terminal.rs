//! 打开系统终端执行 ssh。前期不做内嵌终端：系统终端最稳，复制粘贴、字体、快捷键都是用户熟悉的。
//!
//! 参数都先过 sshconfig 里的校验（主机名、用户名、别名只允许安全字符），再按平台拼启动命令；
//! macOS 要经过 AppleScript 字符串，所以私钥路径里不允许出现引号和反斜杠。

use crate::sshconfig::{valid_alias, valid_host, valid_user};
use std::process::Command;

/// ssh 的参数（不含 `ssh` 本身）：有别名用别名，否则用 -p / -i / user@host
pub fn ssh_args(alias: Option<&str>, host: &str, port: i64, user: &str, key: Option<&str>) -> Result<Vec<String>, String> {
    if let Some(a) = alias {
        if !valid_alias(a) {
            return Err(format!("SSH 别名「{a}」含有不支持的字符"));
        }
        return Ok(vec![a.to_string()]);
    }
    if !valid_host(host) || !valid_user(user) || !(1..=65535).contains(&port) {
        return Err("主机、用户名或端口不合法".into());
    }
    let mut v = vec!["-p".to_string(), port.to_string()];
    if let Some(k) = key.filter(|k| !k.is_empty()) {
        if k.contains(['"', '\'', '\\', '\n']) && !cfg!(windows) {
            return Err("私钥路径里有引号或反斜杠，没法安全地传给终端".into());
        }
        if k.contains(['"', '\n']) {
            return Err("私钥路径里有引号，没法安全地传给终端".into());
        }
        v.push("-i".into());
        v.push(k.to_string());
    }
    v.push(format!("{user}@{host}"));
    Ok(v)
}

/// macOS「终端」里执行的那行命令（每个参数用单引号包住）
pub fn mac_script(args: &[String]) -> String {
    let line = std::iter::once("ssh".to_string())
        .chain(args.iter().map(|a| format!("'{a}'")))
        .collect::<Vec<_>>()
        .join(" ");
    format!("tell application \"Terminal\"\n  activate\n  do script \"{line}\"\nend tell")
}

fn spawn(cmd: &mut Command) -> Result<(), String> {
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

pub fn open(title: &str, args: &[String]) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // 优先 Windows Terminal，没有就用 cmd 新开一个窗口
        let wt = spawn(Command::new("wt.exe").args(["-w", "0", "new-tab", "--title", title, "ssh"]).args(args));
        if wt.is_ok() {
            return Ok(());
        }
        return spawn(Command::new("cmd").args(["/c", "start", "", "ssh"]).args(args))
            .map_err(|e| format!("打不开终端：{e}。可以复制 SSH 命令自己粘贴到终端里"));
    }
    #[cfg(target_os = "macos")]
    {
        let _ = title;
        return spawn(Command::new("osascript").args(["-e", &mac_script(args)]))
            .map_err(|e| format!("打不开「终端」：{e}"));
    }
    #[allow(unreachable_code)]
    {
        let _ = title;
        let mut last = String::new();
        for (term, sep) in [("x-terminal-emulator", "-e"), ("gnome-terminal", "--"), ("konsole", "-e"), ("xterm", "-e")] {
            match spawn(Command::new(term).arg(sep).arg("ssh").args(args)) {
                Ok(()) => return Ok(()),
                Err(e) => last = e,
            }
        }
        Err(format!("没找到可用的终端程序（{last}）。可以复制 SSH 命令自己粘贴到终端里"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_ssh_args() {
        assert_eq!(ssh_args(Some("autodl-qwen-a1b2c3"), "", 0, "", None).unwrap(), vec!["autodl-qwen-a1b2c3"]);
        assert_eq!(
            ssh_args(None, "region-9.autodl.pro", 32145, "root", Some("/home/tk/.ssh/id_x")).unwrap(),
            vec!["-p", "32145", "-i", "/home/tk/.ssh/id_x", "root@region-9.autodl.pro"]
        );
        assert!(ssh_args(None, "-oProxyCommand=calc", 22, "root", None).is_err());
        assert!(ssh_args(None, "h", 22, "root;rm", None).is_err());
        assert!(ssh_args(None, "h", 0, "root", None).is_err());
        assert!(ssh_args(Some("a b"), "", 0, "", None).is_err());
        assert!(ssh_args(None, "h", 22, "root", Some("/tmp/\"x")).is_err());
    }

    #[test]
    fn mac_script_quotes_args() {
        let s = mac_script(&["-p".into(), "22".into(), "root@h".into()]);
        assert!(s.contains("do script \"ssh '-p' '22' 'root@h'\""), "{s}");
    }
}
