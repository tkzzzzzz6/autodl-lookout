//! 服务器状态采集和提醒判断。
//!
//! 一次 SSH 执行一个脚本，拿到 GPU（nvidia-smi）、占卡进程（含用户，实验室多人共用时看得出谁占着卡）、
//! CPU 负载、内存、磁盘，以及要盯的训练进程 / 日志文件。解析和提醒判断都是纯函数，方便测试。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Gpu {
    pub index: i64,
    pub uuid: String,
    pub name: String,
    /// 利用率 %
    pub util: f64,
    pub mem_used_mb: f64,
    pub mem_total_mb: f64,
    pub temp: Option<f64>,
    pub power_w: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct GpuProc {
    /// 对应 Gpu.index；对不上时为 -1
    pub gpu: i64,
    pub pid: i64,
    pub mem_mb: f64,
    /// 容器里经常看不到宿主机的进程，这几项可能为空
    pub user: Option<String>,
    pub elapsed_secs: Option<i64>,
    pub cmd: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Disk {
    pub mount: String,
    pub total: u64,
    pub used: u64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct ServerStatus {
    /// 远程有没有 nvidia-smi
    pub nvidia: bool,
    pub gpus: Vec<Gpu>,
    pub procs: Vec<GpuProc>,
    pub load1: Option<f64>,
    pub cores: Option<i64>,
    pub mem_total: Option<u64>,
    pub mem_avail: Option<u64>,
    pub disks: Vec<Disk>,
    /// 要盯的进程还在不在（没设置时为 None）
    pub job_alive: Option<bool>,
    /// 要盯的日志文件最后修改时间（远程时钟，Unix 秒）
    pub log_mtime: Option<i64>,
    /// 远程当前时间（和 log_mtime 同一个时钟，避免两边时间不同步）
    pub remote_now: Option<i64>,
    /// 本机采集时间
    pub fetched_at: i64,
}

/// 每台服务器的提醒设置（默认全关）
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Watch {
    pub id: String,
    /// 空闲提醒（只对 AutoDL 实例生效：显卡闲着还在计费）
    pub idle: bool,
    pub idle_minutes: i64,
    /// 磁盘用量 ≥ 90% 提醒
    pub disk: bool,
    /// 盯一个进程，退出时提醒
    pub job_pid: Option<i64>,
    /// 盯一个日志文件，超过 job_quiet_minutes 分钟没更新时提醒
    pub job_log: Option<String>,
    pub job_quiet_minutes: i64,
}

impl Watch {
    pub fn new(id: &str) -> Self {
        Self { id: id.into(), idle_minutes: 30, job_quiet_minutes: 15, ..Default::default() }
    }
    pub fn any(&self) -> bool {
        self.idle || self.disk || self.job_pid.is_some() || self.job_log.as_deref().is_some_and(|s| !s.is_empty())
    }
}

pub const IDLE_UTIL: f64 = 5.0;
pub const DISK_ALERT: f64 = 0.90;
/// 磁盘降到这个比例以下才重新允许提醒，避免在 90% 上下来回刷屏
pub const DISK_RESET: f64 = 0.85;

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 采集脚本。各段以 `@@名字` 开头；命令不存在时那一段为空
pub fn script(w: Option<&Watch>) -> String {
    let mut s = String::from(
        "echo @@gpu; nvidia-smi --query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>/dev/null\n\
         echo @@apps; nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory --format=csv,noheader,nounits 2>/dev/null\n\
         echo @@ps; for p in $(nvidia-smi --query-compute-apps=pid --format=csv,noheader 2>/dev/null); do ps -o pid=,user:32=,etimes=,args= -p \"$p\" 2>/dev/null; done\n\
         echo @@load; cat /proc/loadavg 2>/dev/null; nproc 2>/dev/null\n\
         echo @@mem; free -b 2>/dev/null | awk '/^Mem:/{print $2, $7}'\n\
         echo @@disk; df -PB1 / \"$HOME\" /root/autodl-tmp 2>/dev/null | tail -n +2\n",
    );
    if let Some(w) = w {
        if let Some(pid) = w.job_pid {
            s.push_str(&format!("echo @@pid; ps -p {pid} -o pid= 2>/dev/null\n"));
        }
        if let Some(log) = w.job_log.as_deref().filter(|l| !l.is_empty()) {
            s.push_str(&format!("echo @@log; stat -c %Y {} 2>/dev/null\n", shell_quote(log)));
        }
    }
    s.push_str("echo @@now; date +%s\n");
    s
}

/// 实时刷新用的常驻命令：每 2 秒跑一次采集脚本，帧之间用 `@@frame` 分隔。
/// 最多跑 30 分钟就自己退出（界面还开着会再起一个），防止 SSH 断开时残留在服务器上；
/// 正常关闭时软件关掉通道，循环写 stdout 失败（SIGPIPE）也会立刻退出。
pub const LIVE_SEP: &str = "@@frame";
pub const LIVE_INTERVAL_SECS: u64 = 2;
pub const LIVE_MAX_SECS: u64 = 1800;

pub fn live_command(w: Option<&Watch>) -> String {
    let body = format!(
        "end=$(( $(date +%s) + {LIVE_MAX_SECS} )); while [ \"$(date +%s)\" -lt \"$end\" ]; do\n{}echo {LIVE_SEP}\nsleep {LIVE_INTERVAL_SECS}\ndone\n",
        script(w)
    );
    format!("sh -c {}", shell_quote(&body))
}

/// 列表概览：只要每张 GPU 的利用率和显存，一次 nvidia-smi 就够
pub fn overview_command() -> &'static str {
    "nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null; echo @@done"
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Overview {
    pub gpus: i64,
    /// 所有 GPU 利用率的平均值 %
    pub util_avg: Option<f64>,
    pub mem_used_mb: f64,
    pub mem_total_mb: f64,
    /// 远程没有 nvidia-smi
    pub no_gpu: bool,
    pub error: Option<String>,
}

pub fn parse_overview(out: &str) -> Overview {
    let rows: Vec<Vec<f64>> = out.lines()
        .filter(|l| !l.trim().is_empty() && !l.starts_with("@@"))
        .filter_map(|l| {
            let f: Vec<f64> = l.split(',').filter_map(num).collect();
            (f.len() >= 3).then_some(f)
        })
        .collect();
    let n = rows.len() as i64;
    Overview {
        gpus: n,
        util_avg: (n > 0).then(|| rows.iter().map(|r| r[0]).sum::<f64>() / n as f64),
        mem_used_mb: rows.iter().map(|r| r[1]).sum(),
        mem_total_mb: rows.iter().map(|r| r[2]).sum(),
        no_gpu: n == 0,
        error: None,
    }
}

/// 实际执行的命令：用 sh 跑采集脚本，不受用户登录 shell（zsh、fish 等）语法影响
pub fn command(w: Option<&Watch>) -> String {
    format!("sh -c {}", shell_quote(&script(w)))
}

fn num(s: &str) -> Option<f64> {
    s.trim().parse().ok()
}

pub fn parse(out: &str, fetched_at: i64, w: Option<&Watch>) -> ServerStatus {
    let mut st = ServerStatus { fetched_at, ..Default::default() };
    let mut sec = "";
    let mut apps: Vec<(String, i64, f64)> = vec![];
    let mut ps: Vec<(i64, String, Option<i64>, String)> = vec![];
    let mut load_lines: Vec<String> = vec![];
    let mut pid_seen = false;
    for line in out.lines() {
        let l = line.trim();
        if let Some(name) = l.strip_prefix("@@") {
            sec = match name { "gpu" => "gpu", "apps" => "apps", "ps" => "ps", "load" => "load", "mem" => "mem", "disk" => "disk", "pid" => "pid", "log" => "log", "now" => "now", _ => "" };
            continue;
        }
        if l.is_empty() {
            continue;
        }
        match sec {
            "gpu" => {
                let f: Vec<&str> = l.split(',').map(str::trim).collect();
                if f.len() >= 6 {
                    st.nvidia = true;
                    st.gpus.push(Gpu {
                        index: f[0].parse().unwrap_or(-1),
                        uuid: f[1].into(),
                        name: f[2].into(),
                        util: num(f[3]).unwrap_or(0.0),
                        mem_used_mb: num(f[4]).unwrap_or(0.0),
                        mem_total_mb: num(f[5]).unwrap_or(0.0),
                        temp: f.get(6).and_then(|x| num(x)),
                        power_w: f.get(7).and_then(|x| num(x)),
                    });
                }
            }
            "apps" => {
                let f: Vec<&str> = l.split(',').map(str::trim).collect();
                if f.len() >= 3 {
                    if let Ok(pid) = f[1].parse() {
                        apps.push((f[0].into(), pid, num(f[2]).unwrap_or(0.0)));
                    }
                }
            }
            "ps" => {
                let mut it = l.split_whitespace();
                if let (Some(pid), Some(user), Some(et)) = (it.next(), it.next(), it.next()) {
                    if let Ok(pid) = pid.parse() {
                        let cmd: String = it.collect::<Vec<_>>().join(" ").chars().take(200).collect();
                        ps.push((pid, user.into(), et.parse().ok(), cmd));
                    }
                }
            }
            "load" => load_lines.push(l.into()),
            "mem" => {
                let f: Vec<&str> = l.split_whitespace().collect();
                st.mem_total = f.first().and_then(|x| x.parse().ok());
                st.mem_avail = f.get(1).and_then(|x| x.parse().ok());
            }
            "disk" => {
                let f: Vec<&str> = l.split_whitespace().collect();
                if f.len() >= 6 {
                    let mount = f[5..].join(" ");
                    if let (Ok(total), Ok(used)) = (f[1].parse(), f[2].parse()) {
                        if !st.disks.iter().any(|d| d.mount == mount) {
                            st.disks.push(Disk { mount, total, used });
                        }
                    }
                }
            }
            "pid" => pid_seen = true,
            "log" => st.log_mtime = l.parse().ok(),
            "now" => st.remote_now = l.parse().ok(),
            _ => {}
        }
    }
    if let Some(first) = load_lines.first() {
        st.load1 = first.split_whitespace().next().and_then(num);
    }
    st.cores = load_lines.get(1).and_then(|x| x.parse().ok());
    st.procs = apps
        .into_iter()
        .map(|(uuid, pid, mem)| {
            let p = ps.iter().find(|p| p.0 == pid);
            GpuProc {
                gpu: st.gpus.iter().find(|g| g.uuid == uuid).map(|g| g.index).unwrap_or(-1),
                pid,
                mem_mb: mem,
                user: p.map(|p| p.1.clone()),
                elapsed_secs: p.and_then(|p| p.2),
                cmd: p.map(|p| p.3.clone()).filter(|c| !c.is_empty()),
            }
        })
        .collect();
    if w.and_then(|w| w.job_pid).is_some() {
        st.job_alive = Some(pid_seen);
    }
    st
}

/* ---------------- 提醒判断 ---------------- */

#[derive(Debug, Clone, Default, PartialEq)]
pub struct WatchState {
    pub idle_since: Option<i64>,
    pub idle_alerted: bool,
    pub disk_alerted: bool,
    /// 盯的进程至少见过一次活着（避免 PID 填错时立刻报「已退出」）
    pub job_seen_alive: bool,
    pub job_alerted: bool,
    pub log_alerted: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Alert {
    pub kind: &'static str,
    pub title: String,
    pub body: String,
}

/// 根据这次的状态更新提醒状态，返回要发的提醒。同一段状况只提醒一次，恢复后才重新计。
/// autodl_running：这是正在运行（计费中）的 AutoDL 实例
pub fn evaluate(prev: &WatchState, st: &ServerStatus, w: &Watch, name: &str, autodl_running: bool, now: i64) -> (WatchState, Vec<Alert>) {
    let mut s = prev.clone();
    let mut out = vec![];

    // 空闲：所有 GPU 利用率都低于 5%，持续 N 分钟
    if w.idle && autodl_running && !st.gpus.is_empty() && st.gpus.iter().all(|g| g.util < IDLE_UTIL) {
        let since = *s.idle_since.get_or_insert(now);
        let mins = (now - since) / 60;
        if mins >= w.idle_minutes.max(1) && !s.idle_alerted {
            s.idle_alerted = true;
            out.push(Alert {
                kind: "idle",
                title: "显卡闲着还在计费".into(),
                body: format!("{name} 的 GPU 已经 {mins} 分钟几乎没在用，不用的话记得关机（可以在「服务器」或「我的实例」里关机）"),
            });
        }
    } else {
        s.idle_since = None;
        s.idle_alerted = false;
    }

    // 磁盘：任一磁盘 ≥ 90%
    if w.disk {
        let worst = st.disks.iter().filter(|d| d.total > 0).map(|d| (d, d.used as f64 / d.total as f64))
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
        match worst {
            Some((d, r)) if r >= DISK_ALERT && !s.disk_alerted => {
                s.disk_alerted = true;
                out.push(Alert { kind: "disk", title: "磁盘快满了".into(), body: format!("{name} 的 {} 已用 {:.0}%，训练写满会失败", d.mount, r * 100.0) });
            }
            Some((_, r)) if r < DISK_RESET => s.disk_alerted = false,
            None => s.disk_alerted = false,
            _ => {}
        }
    }

    // 训练进程退出
    match (w.job_pid, st.job_alive) {
        (Some(_), Some(true)) => {
            s.job_seen_alive = true;
            s.job_alerted = false;
        }
        (Some(pid), Some(false)) if s.job_seen_alive && !s.job_alerted => {
            s.job_alerted = true;
            out.push(Alert { kind: "job", title: "训练进程结束了".into(), body: format!("{name} 上的进程 {pid} 已经退出") });
        }
        (None, _) => {
            s.job_seen_alive = false;
            s.job_alerted = false;
        }
        _ => {}
    }

    // 日志 N 分钟没更新
    if w.job_log.as_deref().is_some_and(|l| !l.is_empty()) {
        if let (Some(m), Some(rnow)) = (st.log_mtime, st.remote_now) {
            let quiet = (rnow - m) / 60;
            if quiet >= w.job_quiet_minutes.max(1) {
                if !s.log_alerted {
                    s.log_alerted = true;
                    out.push(Alert { kind: "log", title: "训练日志不动了".into(), body: format!("{name} 的日志已经 {quiet} 分钟没有更新，训练可能结束或卡住了") });
                }
            } else {
                s.log_alerted = false;
            }
        }
    } else {
        s.log_alerted = false;
    }
    (s, out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 字段形状来自实验室服务器上 nvidia-smi / ps / df 的真实输出（值是假的）
    const OUT: &str = "@@gpu
0, GPU-aaa, NVIDIA A100-SXM4-80GB, 97, 61234, 81920, 63, 312.45
1, GPU-bbb, NVIDIA A100-SXM4-80GB, 0, 4, 81920, 31, [N/A]
@@apps
GPU-aaa, 12345, 61000
GPU-aaa, 23456, 200
@@ps
12345 zhangsan          3600 python train.py --cfg configs/llama.yaml
@@load
3.52 3.10 2.80 2/1234 99999
128
@@mem
1081234567890 812345678901
@@disk
/dev/sda1 1000000000 920000000 80000000 92% /
/dev/sdb1 4000000000 1000000000 3000000000 25% /home
/dev/sda1 1000000000 920000000 80000000 92% /
@@pid
  4242
@@log
1793548800
@@now
1793549700
";

    #[test]
    fn parses_status() {
        let w = Watch { job_pid: Some(4242), job_log: Some("/tmp/x.log".into()), ..Watch::new("srv:1") };
        let st = parse(OUT, 100, Some(&w));
        assert!(st.nvidia);
        assert_eq!(st.gpus.len(), 2);
        assert_eq!((st.gpus[0].util, st.gpus[0].mem_used_mb, st.gpus[0].power_w), (97.0, 61234.0, Some(312.45)));
        assert_eq!(st.gpus[1].power_w, None, "[N/A] 当作没有");
        assert_eq!(st.procs.len(), 2);
        assert_eq!(st.procs[0], GpuProc { gpu: 0, pid: 12345, mem_mb: 61000.0, user: Some("zhangsan".into()), elapsed_secs: Some(3600),
            cmd: Some("python train.py --cfg configs/llama.yaml".into()) });
        assert_eq!((st.procs[1].user.clone(), st.procs[1].cmd.clone()), (None, None), "ps 查不到的进程（容器里常见）");
        assert_eq!((st.load1, st.cores), (Some(3.52), Some(128)));
        assert_eq!((st.mem_total, st.mem_avail), (Some(1081234567890), Some(812345678901)));
        assert_eq!(st.disks.len(), 2, "同一挂载点去重");
        assert_eq!((st.job_alive, st.log_mtime, st.remote_now), (Some(true), Some(1793548800), Some(1793549700)));
    }

    #[test]
    fn live_command_loops_with_frames_and_deadline() {
        let c = live_command(None);
        assert!(c.starts_with("sh -c 'end=$(( $(date +%s) + 1800 ));"), "{c}");
        assert!(c.contains("echo @@frame") && c.contains("sleep 2") && c.contains("echo @@gpu;"));
        // 每一帧都能用原来的解析函数解析
        let frame = OUT.split("@@now").next().unwrap();
        assert_eq!(parse(frame, 0, None).gpus.len(), 2);
    }

    #[test]
    fn parses_overview() {
        let o = parse_overview("97, 61234, 81920\n0, 4, 81920\n@@done\n");
        assert_eq!((o.gpus, o.util_avg, o.mem_used_mb, o.mem_total_mb, o.no_gpu), (2, Some(48.5), 61238.0, 163840.0, false));
        let none = parse_overview("@@done\n");
        assert!(none.no_gpu && none.util_avg.is_none());
    }

    #[test]
    fn no_nvidia_and_dead_pid() {
        let w = Watch { job_pid: Some(1), ..Watch::new("srv:1") };
        let st = parse("@@gpu\n@@apps\n@@ps\n@@load\n0.1 0 0 1/1 1\n4\n@@mem\n@@disk\n@@pid\n@@now\n1\n", 0, Some(&w));
        assert!(!st.nvidia && st.gpus.is_empty());
        assert_eq!(st.job_alive, Some(false));
        assert_eq!(parse("@@pid\n", 0, None).job_alive, None, "没设置 PID 时不判断");
    }

    #[test]
    fn script_quotes_log_path() {
        let w = Watch { job_log: Some("/data/it's log.txt".into()), job_pid: Some(42), ..Watch::new("x") };
        let s = script(Some(&w));
        assert!(s.contains("stat -c %Y '/data/it'\\''s log.txt'"), "{s}");
        assert!(s.contains("ps -p 42 -o pid="));
        assert!(!script(None).contains("@@pid"));
        assert!(command(None).starts_with("sh -c 'echo @@gpu;"));
    }

    fn gpus(utils: &[f64]) -> ServerStatus {
        ServerStatus { gpus: utils.iter().enumerate().map(|(i, &u)| Gpu { index: i as i64, util: u, ..Default::default() }).collect(), ..Default::default() }
    }

    #[test]
    fn idle_alert_once_after_n_minutes() {
        let w = Watch { idle: true, idle_minutes: 30, ..Watch::new("autodl:u") };
        let st = gpus(&[1.0, 0.0]);
        let (s1, a) = evaluate(&WatchState::default(), &st, &w, "qwen", true, 1000);
        assert!(a.is_empty());
        let (s2, a) = evaluate(&s1, &st, &w, "qwen", true, 1000 + 29 * 60);
        assert!(a.is_empty());
        let (s3, a) = evaluate(&s2, &st, &w, "qwen", true, 1000 + 30 * 60);
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].kind, "idle");
        let (s4, a) = evaluate(&s3, &st, &w, "qwen", true, 1000 + 90 * 60);
        assert!(a.is_empty(), "同一段空闲只提醒一次");
        // 有一张卡在用：重置
        let (s5, _) = evaluate(&s4, &gpus(&[80.0, 0.0]), &w, "qwen", true, 1000 + 91 * 60);
        assert_eq!(s5.idle_since, None);
        assert!(!s5.idle_alerted);
        // 不是运行中的 AutoDL 实例（比如实验室服务器）不提醒
        let (_, a) = evaluate(&WatchState { idle_since: Some(0), ..Default::default() }, &st, &w, "lab", false, 99999);
        assert!(a.is_empty());
    }

    #[test]
    fn disk_alert_with_hysteresis() {
        let w = Watch { disk: true, ..Watch::new("srv:1") };
        let disk = |used| ServerStatus { disks: vec![Disk { mount: "/".into(), total: 100, used }], ..Default::default() };
        let (s, a) = evaluate(&WatchState::default(), &disk(91), &w, "lab", false, 0);
        assert_eq!(a.len(), 1);
        let (s, a) = evaluate(&s, &disk(88), &w, "lab", false, 0);
        assert!(a.is_empty() && s.disk_alerted, "88% 还没降到 85% 以下，不重新计");
        let (s, _) = evaluate(&s, &disk(80), &w, "lab", false, 0);
        assert!(!s.disk_alerted);
        let (_, a) = evaluate(&s, &disk(95), &w, "lab", false, 0);
        assert_eq!(a.len(), 1);
    }

    #[test]
    fn job_exit_needs_seen_alive() {
        let w = Watch { job_pid: Some(42), ..Watch::new("srv:1") };
        let dead = ServerStatus { job_alive: Some(false), ..Default::default() };
        let alive = ServerStatus { job_alive: Some(true), ..Default::default() };
        let (s, a) = evaluate(&WatchState::default(), &dead, &w, "lab", false, 0);
        assert!(a.is_empty(), "一开始就不在（PID 填错）不提醒");
        let (s, _) = evaluate(&s, &alive, &w, "lab", false, 0);
        let (s, a) = evaluate(&s, &dead, &w, "lab", false, 0);
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].kind, "job");
        let (_, a) = evaluate(&s, &dead, &w, "lab", false, 0);
        assert!(a.is_empty());
    }

    #[test]
    fn log_quiet_alert() {
        let w = Watch { job_log: Some("/x.log".into()), job_quiet_minutes: 15, ..Watch::new("srv:1") };
        let st = |m, n| ServerStatus { log_mtime: Some(m), remote_now: Some(n), ..Default::default() };
        let (s, a) = evaluate(&WatchState::default(), &st(0, 14 * 60), &w, "lab", false, 0);
        assert!(a.is_empty());
        let (s, a) = evaluate(&s, &st(0, 15 * 60), &w, "lab", false, 0);
        assert_eq!(a[0].kind, "log");
        let (s, a) = evaluate(&s, &st(0, 60 * 60), &w, "lab", false, 0);
        assert!(a.is_empty());
        let (s, _) = evaluate(&s, &st(3600, 3600), &w, "lab", false, 0);
        assert!(!s.log_alerted, "日志又更新了，重新计");
    }
}
