import { useEffect, useState } from "react";
import { LIVE_KEEP, usePolled, useNowSec, useServerStatus } from "../hooks";
import { AnimatePresence, motion } from "motion/react";
import { HOSTKEY_CHANGED, call, setSetting, type HostEntry, type Overview, type Probe, type ServerList, type ServerRecord, type ServerView, type Settings, type Watch } from "../api";
import { Icon } from "../icons";
import { Btn, ConfirmButton, FormRow, Group, Page, Row, Segmented, Sheet, Stepper, Switch, copy, softSpring, stagger, useAction, useToast } from "../ui";

const STATUS: Record<string, [string, string]> = {
  running: ["运行中", "on"], shutdown: ["已关机", ""], starting: ["开机中", "warn"], shutting_down: ["关机中", "warn"],
};

const sshCmd = (v: ServerView) => (v.alias_ready ? `ssh ${v.alias}` : `ssh -p ${v.port} ${v.user}@${v.host}`);
const errText = (e: unknown) => String(e);

/* ---------------- 状态 ---------------- */
const gb = (b: number) => (b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : `${(b / 1e9).toFixed(b >= 1e10 ? 0 : 1)} GB`);
const dur = (s: number | null) => (s == null ? "—" : s >= 86400 ? `${Math.floor(s / 86400)} 天 ${Math.floor((s % 86400) / 3600)} 小时` : s >= 3600 ? `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分` : `${Math.floor(s / 60)} 分钟`);

function Meter({ ratio, warn }: { ratio: number; warn?: boolean }) {
  return (
    <span className={`meter ${warn ? "warn" : ""}`}>
      <motion.i initial={{ width: 0 }} animate={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }} transition={softSpring} />
    </span>
  );
}

/** 最近 5 分钟的小折线：values 是 0–100，实线带填充；dash 是第二条虚线（显存）。右端对齐最新一帧 */
function Spark({ values, dash, warn }: { values: (number | null)[]; dash?: number[]; warn?: boolean }) {
  const W = LIVE_KEEP - 1;
  const pts = (xs: (number | null)[]) => {
    const off = W - (xs.length - 1);
    return xs.map((y, i) => (y == null ? null : `${off + i},${(100 - Math.max(0, Math.min(100, y))).toFixed(1)}`)).filter(Boolean) as string[];
  };
  const main = pts(values);
  if (main.length < 2) return <span className="spark" />;
  const first = main[0].split(",")[0], last = main[main.length - 1].split(",")[0];
  const d2 = dash ? pts(dash) : [];
  return (
    <svg className={`spark ${warn ? "warn" : ""}`} viewBox={`0 -2 ${W} 104`} preserveAspectRatio="none" aria-hidden>
      <path className="spark-area" d={`M${first},100 L${main.join(" L")} L${last},100 Z`} />
      <polyline className="spark-line" points={main.join(" ")} />
      {d2.length > 1 && <polyline className="spark-dash" points={d2.join(" ")} />}
    </svg>
  );
}

function StatusPanel({ v, onChanged, live, setLive }: { v: ServerView; onChanged: () => void; live: boolean; setLive: (on: boolean) => void }) {
  const { data, err, loading, refresh, history, streaming, liveErr } = useServerStatus(v.id, live);
  const now = useNowSec();
  const { busy, run } = useAction();
  const idle = !!data && v.kind === "autodl" && data.gpus.length > 0 && data.gpus.every((g) => g.util < 5);
  const hasCurve = history.length >= 2;
  return (
    <>
      <div className="group-label row" style={{ justifyContent: "space-between" }}>
        <span className="row" style={{ gap: 6 }}>
          状态
          {streaming
            ? <span className="live-tag"><i className="live-dot" />实时 · 每 2 秒</span>
            : data ? <span>（{Math.max(0, now - data.fetched_at)} 秒前）</span> : null}
        </span>
        <span className="row" style={{ gap: 8 }}>
          <span className="muted" style={{ textTransform: "none", letterSpacing: 0 }}>实时</span>
          <Switch label="详情实时刷新" checked={live} onChange={setLive} />
          {!streaming && <Btn small icon="refresh" spinning={loading} onClick={refresh}>刷新</Btn>}
        </span>
      </div>
      {liveErr && (
        <div className="group-foot err-text" style={{ marginTop: -4, marginBottom: 8 }}>
          实时刷新没有起来，先改成 30 秒刷新一次：{liveErr.startsWith(HOSTKEY_CHANGED) ? "主机密钥变了" : liveErr}。点「刷新」再试一次实时。
        </div>
      )}
      {err && !data && <Group><div className="group-row err-text">{err.startsWith(HOSTKEY_CHANGED) ? "主机密钥变了，点上面的「测试连接」处理后再看状态。" : err}</div></Group>}
      {!data && !err && <Group><div className="empty-state">正在连接服务器…</div></Group>}
      {data && (
        <>
          {idle && (
            <Group className="idle-banner">
              <div className="group-row" style={{ gap: 12 }}>
                <Icon name="yen" size={20} stroke={2} />
                <span className="grow">显卡几乎没在用，但实例还在计费。不用的话可以关机（数据会保留）。</span>
                <ConfirmButton icon="stop" className="btn" label="关机" confirmLabel="再点一次关机" disabled={busy}
                  onConfirm={async () => { const r = await run(() => call("regular_power_off", { uuid: v.id.slice(7) }), "已发送关机请求"); if (r !== undefined) setTimeout(onChanged, 1500); }} />
              </div>
            </Group>
          )}
          <Group>
            {!data.nvidia && <div className="group-row muted">这台服务器上没有 nvidia-smi（没有 NVIDIA 显卡，或者是无卡模式开机）。</div>}
            {data.gpus.map((g) => (
              <div key={g.index} className="gpu-line">
                <span className="num gpu-idx">#{g.index}</span>
                <span className="gpu-name">
                  <span title={g.name}>{g.name.replace(/^NVIDIA (GeForce )?/, "")}</span>
                  <small className="num muted">
                    显存 {(g.mem_used_mb / 1024).toFixed(1)} / {(g.mem_total_mb / 1024).toFixed(0)} GB
                    {g.temp != null ? ` · ${g.temp.toFixed(0)}°C` : ""}{g.power_w != null ? ` · ${g.power_w.toFixed(0)}W` : ""}
                  </small>
                </span>
                {hasCurve
                  ? <Spark values={history.map((p) => p.gpus[g.index]?.util ?? null)} dash={history.map((p) => p.gpus[g.index]?.mem ?? 0)} />
                  : <Meter ratio={g.util / 100} />}
                <span className="num gpu-util">{g.util.toFixed(0)}%</span>
              </div>
            ))}
          </Group>
          {hasCurve && data.gpus.length > 0 && <div className="group-foot">曲线是最近 {Math.max(1, Math.round((history.length * 2) / 60))} 分钟：实线是利用率，虚线是显存。只在面板开着时记录，不写数据库。</div>}
          {data.procs.length > 0 && (
            <>
              <div className="group-label">占用显卡的进程</div>
              <Group>
                {data.procs.map((p) => (
                  <div key={`${p.gpu}-${p.pid}`} className="proc-line">
                    <div className="row" style={{ gap: 10, flexWrap: "nowrap" }}>
                      <span className="num muted">#{p.gpu >= 0 ? p.gpu : "?"}</span>
                      <b className="proc-user">{p.user ?? "—"}</b>
                      <span className="num">{(p.mem_mb / 1024).toFixed(1)} GB</span>
                      <span className="num muted">{p.elapsed_secs != null ? `跑了 ${dur(p.elapsed_secs)}` : ""}</span>
                      <span style={{ flex: 1 }} />
                      <span className="num muted">PID {p.pid}</span>
                    </div>
                    <div className="proc-cmd kv-code" title={p.cmd ?? ""}>{p.cmd ?? "看不到进程详情（容器里常见）"}</div>
                  </div>
                ))}
              </Group>
            </>
          )}
          <div className="group-label">系统</div>
          <Group>
            {data.load1 != null && (
              <div className="sys-line"><span>CPU 负载</span>
                {hasCurve ? <Spark values={history.map((p) => p.load)} /> : <Meter ratio={data.cores ? data.load1 / data.cores : 0} />}<span className="num">{data.load1.toFixed(1)} / {data.cores ?? "?"} 核</span></div>
            )}
            {data.mem_total != null && data.mem_avail != null && (
              <div className="sys-line"><span>内存</span>
                {hasCurve ? <Spark values={history.map((p) => p.mem)} /> : <Meter ratio={1 - data.mem_avail / data.mem_total} />}
                <span className="num">{gb(data.mem_total - data.mem_avail)} / {gb(data.mem_total)}</span></div>
            )}
            {data.disks.map((d) => (
              <div key={d.mount} className="sys-line"><span className="kv-code">{d.mount}</span><Meter ratio={d.used / d.total} warn={d.used / d.total >= 0.9} />
                <span className="num">{gb(d.used)} / {gb(d.total)}</span></div>
            ))}
          </Group>
        </>
      )}
    </>
  );
}

/* ---------------- 提醒设置 ---------------- */
function WatchEditor({ v }: { v: ServerView }) {
  const [w, setW] = useState<Watch | null>(null);
  const [pid, setPid] = useState("");
  const { busy, run } = useAction();
  useEffect(() => { call<Watch>("get_server_watch", { id: v.id }).then((x) => { setW(x); setPid(x.job_pid ? String(x.job_pid) : ""); }); }, [v.id]);
  if (!w) return null;
  const set = <K extends keyof Watch>(k: K, val: Watch[K]) => setW((x) => (x ? { ...x, [k]: val } : x));
  const save = () => run(() => call("save_server_watch", { watch: { ...w, job_pid: pid.trim() ? Number(pid) : null } }), "提醒设置已保存");
  return (
    <>
      <div className="group-label">提醒</div>
      <Group>
        {v.kind === "autodl" && (
          <>
            <Row icon="yen" label="显卡空闲提醒" sub="GPU 利用率一直低于 5% 时提醒关机，不会自动关机"
              right={<Switch label="显卡空闲提醒" checked={w.idle} onChange={(on) => set("idle", on)} />} />
            {w.idle && <FormRow icon="timer" label="空闲多久后提醒"><Stepper value={w.idle_minutes} min={5} max={240} step={5} unit=" 分钟" onChange={(n) => set("idle_minutes", n)} /></FormRow>}
          </>
        )}
        <Row icon="box" label="磁盘告警" sub="任一磁盘用到 90% 时提醒" right={<Switch label="磁盘告警" checked={w.disk} onChange={(on) => set("disk", on)} />} />
        <FormRow icon="number" label="训练结束：盯进程">
          <input className="inline-input" inputMode="numeric" value={pid} placeholder="PID，留空不盯" onChange={(e) => setPid(e.target.value.replace(/\D/g, ""))} />
        </FormRow>
        <FormRow icon="doc" label="训练结束：盯日志">
          <input className="inline-input" value={w.job_log ?? ""} placeholder="日志路径，留空不盯" onChange={(e) => set("job_log", e.target.value || null)} />
        </FormRow>
        {w.job_log && <FormRow icon="timer" label="日志多久没更新算结束"><Stepper value={w.job_quiet_minutes} min={1} max={240} unit=" 分钟" onChange={(n) => set("job_quiet_minutes", n)} /></FormRow>}
      </Group>
      <div className="group-foot">开了提醒的服务器，软件在后台每分钟查一次（关掉窗口也会查）。进程要先被看到在运行，退出时才会提醒；同一种情况只提醒一次。</div>
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
        <Btn small primary icon="check" disabled={busy} onClick={save}>保存提醒设置</Btn>
      </div>
    </>
  );
}

/* ---------------- 详情 ---------------- */
function Detail({ v, list, onChanged, onEdit, live, setLive }: { v: ServerView; list: ServerList; onChanged: () => void; onEdit: () => void; live: boolean; setLive: (on: boolean) => void }) {
  const { busy, run } = useAction();
  const toast = useToast();
  const [probe, setProbe] = useState<Probe | null>(null);
  const [hostkey, setHostkey] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const noSsh = !v.host && !v.alias_ready;

  const test = async () => {
    setTesting(true); setProbe(null); setHostkey(null);
    try { setProbe(await call<Probe>("test_server", { id: v.id })); }
    catch (e) {
      const s = errText(e);
      if (s.startsWith(HOSTKEY_CHANGED)) setHostkey(s.slice(s.indexOf("|") + 1));
      else toast(s, true);
    } finally { setTesting(false); }
  };
  const terminal = async () => {
    // 还没免密时终端里要输密码：先把密码放进剪贴板
    if (v.has_password && !v.key_pushed) {
      const pw = await run(() => call<string>("server_password", { id: v.id }));
      if (pw) await copy(pw);
    }
    const ok = await run(() => call("open_terminal", { id: v.id }));
    if (ok !== undefined) toast(v.has_password && !v.key_pushed ? "已打开终端，密码已复制，提示输入时粘贴即可" : "已打开终端");
  };
  const vscode = async () => {
    // vscode:// 链接由后端打开（前端 opener 只放行 http 链接）
    try { await call("open_vscode", { id: v.id }); toast("已让 VS Code 打开这台服务器"); }
    catch (e) {
      const s = errText(e);
      toast(s.startsWith("NEED_SYNC|") ? s.slice(10) : s, true);
    }
  };
  const push = async () => {
    if (!list.own_key) await run(() => call("ensure_ssh_key"));
    const r = await run(() => call("push_ssh_key", { id: v.id }), "公钥已推送，之后会用密钥登录");
    if (r !== undefined) onChanged();
  };

  return (
    <>
      <div className="row" style={{ justifyContent: "center", gap: 10, margin: "18px 0 6px", flexWrap: "wrap" }}>
        <Btn primary icon="terminal" disabled={busy || noSsh} onClick={terminal}>打开终端</Btn>
        <Btn icon="code" disabled={noSsh} onClick={vscode}>用 VS Code 打开</Btn>
        <Btn icon="pulse" spinning={testing} disabled={noSsh} onClick={test}>测试连接</Btn>
      </div>
      {noSsh && <div className="group-foot" style={{ textAlign: "center" }}>这台实例还没有 SSH 信息，开机后再来。</div>}

      <AnimatePresence>
        {probe && (
          <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={softSpring}>
            <Group style={{ marginTop: 12 }}>
              <Row icon="check" label={`连上了，${probe.ms} 毫秒`} sub={probe.system || undefined} right={<span className="capsule">{probe.via_key ? "密钥登录" : "密码登录"}</span>} />
            </Group>
          </motion.div>
        )}
        {hostkey && (
          <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={softSpring}>
            <Group style={{ marginTop: 12 }}>
              <div className="group-row err-text" style={{ alignItems: "flex-start" }}>{hostkey}</div>
            </Group>
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
              <ConfirmButton icon="key" label="信任新的主机密钥" confirmLabel="确认是我的服务器，再点一次"
                onConfirm={async () => { await run(() => call("trust_host_key", { id: v.id }), "已信任，正在重新连接"); test(); }} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {!noSsh && (v.kind !== "autodl" || v.status === "running") && <StatusPanel v={v} onChanged={onChanged} live={live} setLive={setLive} />}
      {!noSsh && <WatchEditor v={v} />}

      <div className="group-label">连接</div>
      <Group>
        <Row icon="terminal" label="SSH 命令" sub={<span className="kv-code">{noSsh ? "—" : sshCmd(v)}</span>}
          right={<Btn small icon="copy" disabled={noSsh} onClick={async () => { await copy(sshCmd(v)); toast("已复制 SSH 命令"); }}>复制</Btn>} />
        <Row icon="doc" label="SSH 配置里的名字" sub={<span className="kv-code">{v.alias}</span>}
          right={<span className={`capsule ${v.alias_ready ? "on" : ""}`}>{v.alias_ready ? "已同步" : "未同步"}</span>} />
        {v.has_password && (
          <Row icon="key" label={v.kind === "autodl" ? "root 密码" : "密码"} right={<Btn small icon="copy" disabled={busy}
            onClick={async () => { const p = await run(() => call<string>("server_password", { id: v.id })); if (p) { await copy(p); toast("已复制密码"); } }}>复制</Btn>} />
        )}
        <Row icon="key" label="免密登录" sub={v.key_pushed ? "已推送软件的公钥，测试连接和终端都会用密钥" : "把软件的公钥加到服务器的 authorized_keys，以后不用输密码"}
          right={v.key_pushed ? <span className="capsule on">已开启</span> : <Btn small icon="key" disabled={busy || noSsh} onClick={push}>推送公钥</Btn>} />
      </Group>

      {v.kind === "autodl" ? (
        <>
          <div className="group-label">实例</div>
          <Group>
            <Row icon="gpu_s" label="显卡" value={v.gpu ?? "—"} />
            <Row icon="pin" label="区域" value={v.region_name ?? "—"} />
          </Group>
          <div className="group-foot">AutoDL 实例重新开机后 SSH 端口可能变，开着「自动同步」就不用管。开关机在「我的实例」里。</div>
        </>
      ) : (
        <>
          {v.note && <><div className="group-label">备注</div><Group><div className="group-row">{v.note}</div></Group></>}
          <div className="row" style={{ justifyContent: "space-between", marginTop: 18 }}>
            <Btn small icon="gear" onClick={onEdit}>编辑</Btn>
            <ConfirmButton icon="trash" label="删除" confirmLabel="再点一次删除"
              onConfirm={async () => { const r = await run(() => call("delete_server", { id: Number(v.id.slice(4)) }), "已删除"); if (r !== undefined) onChanged(); }} />
          </div>
        </>
      )}
    </>
  );
}

/* ---------------- 添加 / 编辑 ---------------- */
const EMPTY: ServerRecord = { id: 0, name: "", host: "", port: 22, user: "root", auth: "key", key_path: null, alias: null, note: null };

function Editor({ init, onSaved }: { init: ServerRecord; onSaved: () => void }) {
  const [sv, setSv] = useState<ServerRecord>(init);
  const [pw, setPw] = useState("");
  const { busy, run } = useAction();
  const set = <K extends keyof ServerRecord>(k: K, val: ServerRecord[K]) => setSv((x) => ({ ...x, [k]: val }));
  const save = async () => {
    const r = await run(() => call("save_server", { server: sv, password: sv.auth === "password" ? pw : null }), "已保存");
    if (r !== undefined) onSaved();
  };
  return (
    <>
      <div className="group-label">基本</div>
      <Group>
        <FormRow icon="text" label="名称"><input className="inline-input" value={sv.name} placeholder="如 实验室 A100" onChange={(e) => set("name", e.target.value)} /></FormRow>
        <FormRow icon="server" label="主机"><input className="inline-input" value={sv.host} placeholder="域名或 IP" onChange={(e) => set("host", e.target.value)} /></FormRow>
        <FormRow icon="number" label="端口"><Stepper value={sv.port} min={1} max={65535} onChange={(p) => set("port", p)} /></FormRow>
        <FormRow icon="text" label="用户"><input className="inline-input" value={sv.user} onChange={(e) => set("user", e.target.value)} /></FormRow>
      </Group>
      <div className="group-label">登录方式</div>
      <Group>
        <FormRow icon="key" label="认证">
          <Segmented small layoutId="srv-auth" value={sv.auth} onChange={(a) => set("auth", a)} items={[{ id: "key", label: "私钥" }, { id: "password", label: "密码" }]} />
        </FormRow>
        {sv.auth === "key" ? (
          <FormRow icon="doc" label="私钥文件">
            <input className="inline-input" value={sv.key_path ?? ""} placeholder="留空用软件生成的密钥" onChange={(e) => set("key_path", e.target.value || null)} />
          </FormRow>
        ) : (
          <FormRow icon="key" label="密码">
            <input className="inline-input" type="password" value={pw} placeholder={init.id ? "不改就留空" : "存在系统钥匙串里"} onChange={(e) => setPw(e.target.value)} />
          </FormRow>
        )}
      </Group>
      <div className="group-foot">密码只存在系统钥匙串（Windows 凭据管理器 / macOS 钥匙串）。用密码登录的服务器，保存后可以「推送公钥」改成免密登录。</div>
      <div className="group-label">备注</div>
      <Group>
        <div className="group-row"><input className="inline-input" style={{ textAlign: "left", width: "100%" }} value={sv.note ?? ""} placeholder="可选，如显卡配置、谁在用"
          onChange={(e) => set("note", e.target.value || null)} /></div>
      </Group>
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 18 }}>
        <Btn primary icon="check" disabled={busy} onClick={save}>保存</Btn>
      </div>
    </>
  );
}

/* ---------------- 从 SSH 配置导入 ---------------- */
function Importer({ onDone }: { onDone: () => void }) {
  const [hosts, setHosts] = useState<HostEntry[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const { busy, run } = useAction();
  useEffect(() => { call<HostEntry[]>("ssh_config_hosts").then(setHosts); }, []);
  const toggle = (a: string, on: boolean) => setPicked((p) => (on ? [...p, a] : p.filter((x) => x !== a)));
  return (
    <>
      <p className="muted" style={{ fontSize: 13, margin: "16px 4px 12px" }}>这些是你 SSH 配置里写好的主机（通配符和软件自己写的那一段不算）。导入后连接直接用原来的名字，不会改动你的配置。</p>
      <Group>
        {hosts?.length === 0 && <div className="empty-state">SSH 配置里没有可以导入的主机，或者都已经导入过了。</div>}
        {!hosts && <div className="empty-state">正在读取…</div>}
        {hosts?.map((h) => (
          <Row key={h.alias} icon="server" label={h.alias} sub={`${h.user || "root"}@${h.host}:${h.port}`}
            right={<Switch label={`导入 ${h.alias}`} checked={picked.includes(h.alias)} onChange={(on) => toggle(h.alias, on)} />} />
        ))}
      </Group>
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 18 }}>
        <Btn primary icon="plus" disabled={busy || picked.length === 0}
          onClick={async () => { const n = await run(() => call<number>("import_ssh_hosts", { aliases: picked })); if (n !== undefined) onDone(); }}>
          导入 {picked.length || ""} 台
        </Btn>
      </div>
    </>
  );
}

/* ---------------- 列表概览 ---------------- */
function OvBars({ o }: { o?: Overview }) {
  if (!o) return null;
  if (o.error) return <span className="ov muted" title={o.error}>连不上</span>;
  if (o.no_gpu || o.util_avg == null) return <span className="ov muted">无 GPU</span>;
  const mem = o.mem_total_mb > 0 ? o.mem_used_mb / o.mem_total_mb : 0;
  return (
    <span className="ov" title={`${o.gpus} 张卡，GPU 平均利用率 ${o.util_avg.toFixed(0)}%，显存 ${(o.mem_used_mb / 1024).toFixed(0)} / ${(o.mem_total_mb / 1024).toFixed(0)} GB`}>
      <span className="ov-item"><small>GPU</small><Meter ratio={o.util_avg / 100} /><b className="num">{o.util_avg.toFixed(0)}%</b></span>
      <span className="ov-item"><small>显存</small><Meter ratio={mem} warn={mem >= 0.95} /><b className="num">{(mem * 100).toFixed(0)}%</b></span>
    </span>
  );
}

/* ---------------- 页面 ---------------- */
type SheetState = { kind: "detail"; id: string } | { kind: "edit"; rec: ServerRecord } | { kind: "import" } | null;

export default function ServersPage() {
  const [list, setList] = useState<ServerList | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [loading, setLoading] = useState(false);
  const { busy, run } = useAction();
  const toast = useToast();
  // 两个开关存在设置里（设置页也能改），这里只读写这两项
  const [prefs, setPrefs] = useState<Pick<Settings, "server_live" | "server_overview"> | null>(null);
  useEffect(() => { call<Settings>("get_settings").then((s) => setPrefs({ server_live: s.server_live ?? true, server_overview: s.server_overview ?? true })).catch(() => {}); }, []);
  const togglePref = async (k: "server_live" | "server_overview", on: boolean) => {
    // 先存再切：后端 start_live / servers_overview 会看这两项设置
    try { await setSetting(k, on); setPrefs((p) => (p ? { ...p, [k]: on } : p)); } catch (e) { toast(errText(e)); }
  };
  const ov = usePolled<Record<string, Overview>>("overview", () => call<Record<string, Overview>>("servers_overview"), !!prefs?.server_overview && !!list, 10_000);

  const load = () => {
    setLoading(true);
    return call<ServerList>("list_servers").then((l) => { setList(l); setErr(null); if (l.synced) toast("AutoDL 实例的 SSH 信息有变化，已同步到 SSH 配置"); })
      .catch((e) => setErr(errText(e))).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // 删除或实例释放后，详情面板里的服务器已经不在列表里了
  useEffect(() => {
    if (sheet?.kind === "detail" && list && !list.servers.some((s) => s.id === sheet.id)) setSheet(null);
  }, [list, sheet]);

  const autodl = list?.servers.filter((s) => s.kind === "autodl") ?? [];
  const mine = list?.servers.filter((s) => s.kind === "custom") ?? [];
  const selected = sheet?.kind === "detail" ? list?.servers.find((s) => s.id === sheet.id) : undefined;

  const sync = async () => {
    const r = await run(() => call<{ changed: boolean; count: number; path: string }>("sync_ssh_config"));
    if (r) { toast(r.changed ? `已把 ${r.count} 台服务器写进 SSH 配置` : "SSH 配置已经是最新的"); load(); }
  };
  const editRecord = (v: ServerView): ServerRecord => ({
    id: Number(v.id.slice(4)), name: v.name, host: v.host, port: v.port, user: v.user, auth: v.auth, key_path: v.key_path,
    alias: v.alias.startsWith("lookout-") ? null : v.alias, note: v.note,
  });

  const row = (v: ServerView) => {
    const st = v.status ? STATUS[v.status] ?? [v.status, ""] : null;
    const sub = [v.host ? `${v.user}@${v.host}:${v.port}` : "还没有 SSH 信息", v.gpu, v.region_name].filter(Boolean).join("，");
    return (
      <motion.div key={v.id} variants={stagger.item}>
        <Row icon="server" grey={v.kind === "autodl" && v.status !== "running"} label={<b style={{ fontWeight: 600 }}>{v.name}</b>} sub={sub}
          selected={selected?.id === v.id} onClick={() => setSheet({ kind: "detail", id: v.id })} chevron
          right={<span className="row" style={{ gap: 6 }}>
            {prefs?.server_overview && <OvBars o={ov.data?.[v.id]} />}
            {v.key_pushed && <span className="capsule">免密</span>}
            {st && <span className={`capsule ${st[1]}`}>{st[0]}</span>}
          </span>} />
      </motion.div>
    );
  };

  return (
    <Page>
      <h1 className="title">服务器</h1>
      <p className="lede">AutoDL 实例自动出现，实验室和云服务器手动添加或从 SSH 配置导入。终端用系统自带的。</p>

      <div className="row" style={{ gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
        <Btn primary icon="plus" onClick={() => setSheet({ kind: "edit", rec: EMPTY })}>添加服务器</Btn>
        <Btn icon="doc" onClick={() => setSheet({ kind: "import" })}>从 SSH 配置导入</Btn>
        <Btn icon="refresh" disabled={busy} onClick={sync}>同步到 SSH 配置</Btn>
        <span style={{ flex: 1 }} />
        {prefs && (
          <span className="row" style={{ gap: 8, fontSize: 13 }}>
            <span className="muted">列表状态</span>
            <Switch label="列表显示服务器状态" checked={prefs.server_overview} onChange={(on) => togglePref("server_overview", on)} />
          </span>
        )}
        {list && (
          <span className="row" style={{ gap: 8, fontSize: 13 }}>
            <span className="muted">自动同步</span>
            <Switch label="自动同步 SSH 配置" checked={list.auto_sync}
              onChange={async (on) => { await run(() => call("set_ssh_auto_sync", { on }), on ? "AutoDL 实例端口变了会自动更新 SSH 配置" : undefined); load(); }} />
          </span>
        )}
        <Btn small icon="refresh" spinning={loading} onClick={load}>刷新</Btn>
      </div>

      {err && <Group style={{ marginBottom: 16 }}><div className="group-row err-text">{err}</div></Group>}

      <div className="servers-grid">
        <div>
          <div className="group-label">AutoDL 实例</div>
          <Group>
            <motion.div variants={stagger.container} initial="initial" animate="animate">{autodl.map(row)}</motion.div>
            {list && autodl.length === 0 && <div className="empty-state">{list.autodl_error ?? "还没有 AutoDL 实例。"}</div>}
            {!list && !err && <div className="empty-state">正在读取…</div>}
          </Group>
          {list?.autodl_error && autodl.length > 0 && <div className="group-foot err-text">{list.autodl_error}</div>}
        </div>
        <div>
          <div className="group-label">我的服务器</div>
          <Group>
            <motion.div variants={stagger.container} initial="initial" animate="animate">{mine.map(row)}</motion.div>
            {list && mine.length === 0 && (
              <div className="empty-state"><Icon name="server" size={34} stroke={1.4} /><br />添加实验室 GPU 服务器、云服务器，或者从 SSH 配置导入。</div>
            )}
          </Group>
        </div>
      </div>

      <div className="group-label">密钥</div>
      <Group>
        {list?.own_key ? (
          <Row icon="key" label="软件的 SSH 密钥" sub={<span className="kv-code">~/.ssh/autodl_lookout_ed25519</span>}
            right={<Btn small icon="copy" onClick={async () => { await copy(list.own_key!); toast("已复制公钥"); }}>复制公钥</Btn>} />
        ) : (
          <Row icon="key" label="还没有 SSH 密钥" sub="生成一把 ed25519 密钥，推送到服务器后就能免密登录"
            right={<Btn small icon="plus" disabled={busy} onClick={async () => { await run(() => call("ensure_ssh_key"), "已生成密钥"); load(); }}>生成密钥</Btn>} />
        )}
      </Group>
      <p className="footnote">
        同步只改 SSH 配置（{list?.ssh_config_path ?? "~/.ssh/config"}）里「autodl-lookout」标记的一段，改之前会备份成 config.autodl-lookout.bak；你自己写的配置不会动。
      </p>

      <Sheet open={sheet != null} onClose={() => setSheet(null)}
        title={sheet?.kind === "edit" ? (sheet.rec.id ? "编辑服务器" : "添加服务器") : sheet?.kind === "import" ? "从 SSH 配置导入" : selected?.name ?? ""}
        left={<span />} right={<button className="link-btn bold" onClick={() => setSheet(null)}>完成</button>}>
        {sheet?.kind === "detail" && selected && list && (
          <Detail v={selected} list={list} onChanged={() => { load(); }} onEdit={() => setSheet({ kind: "edit", rec: editRecord(selected) })}
            live={prefs?.server_live ?? true} setLive={(on) => togglePref("server_live", on)} />
        )}
        {sheet?.kind === "edit" && <Editor key={sheet.rec.id} init={sheet.rec} onSaved={() => { setSheet(null); load(); }} />}
        {sheet?.kind === "import" && <Importer onDone={() => { setSheet(null); load(); toast("已导入"); }} />}
      </Sheet>
    </Page>
  );
}
