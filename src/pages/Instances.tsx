import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { LINKS, call, openExternal, timeFieldTs, type Instance, type InstancePage, type RegularInstance } from "../api";
import { Icon } from "../icons";
import { Btn, ConfirmButton, FormRow, Group, Page, Row, Segmented, Sheet, copy, stagger, useAction, useToast } from "../ui";

const STATUS: Record<string, [string, string]> = {
  running: ["运行中", "on"], shutdown: ["已关机", ""], shutting_down: ["关机中", "warn"],
  starting: ["开机中", "warn"], creating: ["创建中", "warn"], re_initializing: ["初始化中", "warn"],
  releasing: ["释放中", "warn"], released: ["已释放", ""],
};
const statusCap = (s: string) => {
  const [label, cls] = STATUS[s] ?? [s || "未知", ""];
  return <span className={`capsule ${cls}`}>{label}</span>;
};
const hoursSince = (ts: number | null) => (ts ? (Date.now() / 1000 - ts) / 3600 : null);
const open = openExternal;

function Detail({ inst, onChanged }: { inst: Instance; onChanged: () => void }) {
  const [snap, setSnap] = useState<Record<string, any> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [imageName, setImageName] = useState("");
  const { busy, run } = useAction();
  const toast = useToast();
  useEffect(() => {
    setSnap(null); setErr(null);
    call<Record<string, any>>("instance_snapshot", { uuid: inst.uuid }).then(setSnap).catch((e) => setErr(String(e)));
  }, [inst.uuid, inst.status]);

  const act = async (cmd: string, ok: string, args: Record<string, unknown> = {}) => {
    const r = await run(() => call(cmd, { uuid: inst.uuid, ...args }), ok);
    if (r !== undefined) setTimeout(onChanged, 1500);
  };
  const cp = async (label: string, v: string) => { await copy(v); toast(`已复制${label}`); };
  const running = inst.status === "running";
  const u = snap?.usage_info ?? {};

  return (
    <>
      <div className="row" style={{ justifyContent: "center", margin: "18px 0 6px", gap: 12 }}>
        {running
          ? <Btn icon="stop" disabled={busy} onClick={() => act("power_off", "已发送关机请求")}>关机</Btn>
          : <Btn primary icon="power" disabled={busy} onClick={() => act("power_on", "已发送开机请求", { startCommand: null })}>开机</Btn>}
        <ConfirmButton icon="trash" label="释放实例" confirmLabel="数据会清空，再点确认" disabled={busy || running}
          onConfirm={() => act("release_instance", "已发送释放请求")} />
      </div>
      {running && <div className="group-foot" style={{ textAlign: "center" }}>释放前需要先关机。</div>}

      <div className="group-label">连接</div>
      {err && <Group><div className="group-row err-text">{err}</div></Group>}
      {!snap && !err && <Group><div className="group-row muted">正在读取…</div></Group>}
      {snap && (
        <Group>
          {snap.ssh_command && (
            <Row icon="terminal" label="SSH" sub={<span className="kv-code">{snap.ssh_command}</span>}
              right={<Btn small icon="copy" onClick={() => cp(" SSH 命令", snap.ssh_command)}>复制</Btn>} />
          )}
          {snap.root_password && <Row icon="key" label="root 密码" right={<Btn small icon="copy" onClick={() => cp("密码", snap.root_password)}>复制</Btn>} />}
          {snap.jupyter_domain && (
            <Row icon="external" label="JupyterLab" chevron
              onClick={() => open(snap.jupyter_token ? `${snap.jupyter_domain}?token=${snap.jupyter_token}` : snap.jupyter_domain)} />
          )}
          {snap.service_6006_domain && <Row icon="pulse" label="6006 端口" sub="TensorBoard 等" chevron onClick={() => open(snap.service_6006_domain)} />}
          {snap.service_6008_domain && <Row icon="external" label="6008 端口" chevron onClick={() => open(snap.service_6008_domain)} />}
        </Group>
      )}

      {snap && (
        <>
          <div className="group-label">运行情况</div>
          <Group>
            <Row icon="yen" label="按量单价" value={snap.payg_price != null ? `¥${(snap.payg_price / 1000).toFixed(2)} / 时` : "—"} />
            <Row icon="chip" label="CPU / 内存" value={u.cpu_usage_percent != null ? `${u.cpu_usage_percent}% / ${u.mem_usage_percent}%` : "—"} />
            <Row icon="pin" label="区域" value={inst.region_name || inst.region_sign} />
          </Group>
        </>
      )}

      <div className="group-label">保存镜像</div>
      <Group>
        <FormRow icon="image" label="镜像名称">
          <input className="inline-input" value={imageName} placeholder="如 llm-sft-v1" onChange={(e) => setImageName(e.target.value)} />
        </FormRow>
      </Group>
      <div className="row" style={{ marginTop: 12, justifyContent: "flex-end" }}>
        <Btn small icon="check" disabled={busy || !imageName.trim()} onClick={() => act("save_image", "已开始保存镜像", { name: imageName.trim() })}>保存</Btn>
      </div>
    </>
  );
}

/* ---------------- 普通容器实例 ---------------- */
function RegularDetail({ inst, onChanged }: { inst: RegularInstance; onChanged: () => void }) {
  const { busy, run } = useAction();
  const toast = useToast();
  const running = inst.status === "running";
  const stopped = inst.status === "shutdown";
  const act = async (cmd: string, ok: string, args: Record<string, unknown> = {}) => {
    const r = await run(() => call(cmd, { uuid: inst.uuid, ...args }), ok);
    if (r !== undefined) setTimeout(onChanged, 1500);
  };
  const cp = async (label: string, v: string) => { await copy(v); toast(`已复制${label}`); };
  const cpPassword = async () => {
    const p = await run(() => call<string>("regular_instance_password", { uuid: inst.uuid }));
    if (p) await cp("密码", p);
  };
  const price = inst.payg_price_yuan != null ? `¥${inst.payg_price_yuan.toFixed(2)} / 时` : null;

  return (
    <>
      <div className="row" style={{ justifyContent: "center", margin: "18px 0 6px", gap: 12 }}>
        {running && <Btn icon="stop" disabled={busy} onClick={() => act("regular_power_off", "已发送关机请求")}>关机</Btn>}
        {stopped && (
          <>
            <ConfirmButton icon="power" className="btn primary" label="开机" confirmLabel={price ? `按 ${price} 计费，再点确认` : "开机后开始计费，再点确认"}
              disabled={busy} onConfirm={() => act("regular_power_on", "已发送开机请求", { nonGpu: false })} />
            <ConfirmButton icon="chip" className="btn" label="无卡模式开机" confirmLabel="不带显卡、便宜，再点确认"
              disabled={busy} onConfirm={() => act("regular_power_on", "已发送无卡模式开机请求", { nonGpu: true })} />
          </>
        )}
        {!running && !stopped && <span className="muted">{STATUS[inst.status]?.[0] ?? inst.status}，稍等再操作</span>}
      </div>
      <div className="group-foot" style={{ textAlign: "center" }}>
        {stopped ? "开机要点两次确认。机器上的卡被别人占了时会开机失败，可以先用无卡模式开机传数据。" : "释放、续费、换卡等操作请在控制台进行。"}
      </div>

      <div className="group-label">连接</div>
      <Group>
        {inst.ssh_command
          ? <Row icon="terminal" label="SSH" sub={<span className="kv-code">{inst.ssh_command}</span>}
              right={<Btn small icon="copy" onClick={() => cp(" SSH 命令", inst.ssh_command)}>复制</Btn>} />
          : <div className="group-row muted">开机后才有连接信息</div>}
        {inst.has_password && <Row icon="key" label="root 密码" right={<Btn small icon="copy" disabled={busy} onClick={cpPassword}>复制</Btn>} />}
        {running && inst.jupyter_url && <Row icon="external" label="JupyterLab" chevron onClick={() => open(inst.jupyter_url!)} />}
        {running && inst.service_6006_url && <Row icon="pulse" label="6006 端口" sub="TensorBoard 等" chevron onClick={() => open(inst.service_6006_url!)} />}
        {running && inst.service_6008_url && <Row icon="external" label="6008 端口" chevron onClick={() => open(inst.service_6008_url!)} />}
      </Group>

      <div className="group-label">信息</div>
      <Group>
        <Row icon="gpu_s" label="显卡" value={`${inst.gpu || "—"} × ${inst.gpu_amount}`} />
        <Row icon="pin" label="区域 / 机器" value={`${inst.region_name || inst.region_sign} ${inst.machine_alias}`} />
        <Row icon="yen" label="计费" value={inst.charge_type === "payg" ? (price ?? "按量计费") : inst.charge_type || "—"} />
        {inst.expired_at && <Row icon="calendar" label="到期" value={new Date(inst.expired_at * 1000).toLocaleString("zh-CN", { hour12: false })} />}
      </Group>
      <div className="row" style={{ marginTop: 14, justifyContent: "flex-end" }}>
        <Btn small icon="external" onClick={() => open(LINKS.console)}>在控制台打开</Btn>
      </div>
    </>
  );
}

function RegularInstances() {
  const [list, setList] = useState<RegularInstance[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = () => {
    setLoading(true);
    return call<RegularInstance[]>("list_regular_instances")
      .then((d) => { setList(d); setErr(null); }).catch((e) => setErr(String(e))).finally(() => setLoading(false));
  };
  useEffect(() => { load(); const id = setInterval(load, 30000); return () => clearInterval(id); }, []);
  const selected = list?.find((i) => i.uuid === sel);

  return (
    <>
      <InstanceList loading={loading} onRefresh={load} err={err} loaded={list != null} empty={list?.length === 0}
        emptyText="还没有普通容器实例。到算力市场租一台，这里就会出现。">
        {(list ?? []).map((i) => {
          const h = i.status === "running" ? hoursSince(i.started_at) : null;
          const sub = [`${i.region_name || i.region_sign} ${i.machine_alias}`.trim(), `${i.gpu} × ${i.gpu_amount}`,
            h != null ? `已运行 ${h.toFixed(1)} 小时` : null, i.status === "running" && i.payg_price_yuan != null ? `¥${i.payg_price_yuan.toFixed(2)}/时` : null]
            .filter(Boolean).join("，");
          return (
            <motion.div key={i.uuid} variants={stagger.item}>
              <Row icon="server" grey={i.status !== "running"} label={<b style={{ fontWeight: 600 }}>{i.name || `${i.gpu} 实例`}</b>}
                sub={sub} selected={sel === i.uuid} onClick={() => setSel(i.uuid)} right={statusCap(i.status)} chevron />
            </motion.div>
          );
        })}
      </InstanceList>
      <Sheet open={!!selected} onClose={() => setSel(null)} title={selected ? selected.name || `${selected.gpu} 实例` : ""}
        left={<span />} right={<button className="link-btn bold" onClick={() => setSel(null)}>完成</button>}>
        {selected && <RegularDetail inst={selected} onChanged={load} />}
      </Sheet>
    </>
  );
}

/* ---------------- 页面 ---------------- */
function InstanceList({ loading, onRefresh, err, loaded, empty, emptyText, children }: {
  loading: boolean; onRefresh: () => void; err: string | null; loaded: boolean; empty: boolean; emptyText: string; children: React.ReactNode;
}) {
  return (
    <div style={{ maxWidth: 720 }}>
      <div className="row" style={{ justifyContent: "flex-end", marginTop: -8, marginBottom: 12 }}>
        <Btn small icon="refresh" spinning={loading} onClick={onRefresh}>刷新</Btn>
      </div>
      {err && <Group style={{ marginBottom: 16 }}><div className="group-row err-text">{err}</div></Group>}
      <Group>
        <motion.div variants={stagger.container} initial="initial" animate="animate">{children}</motion.div>
        {loaded && empty && (
          <div className="empty-state"><Icon name="server" size={34} stroke={1.4} /><br />{emptyText}</div>
        )}
        {!loaded && !err && <div className="empty-state">正在读取…</div>}
      </Group>
    </div>
  );
}

type Kind = "regular" | "pro";

export default function InstancesPage({ hasToken, hasWebToken, go }: { hasToken: boolean; hasWebToken: boolean; go: (p: "settings") => void }) {
  const [kind, setKind] = useState<Kind>(hasWebToken ? "regular" : "pro");
  const shown: Kind = !hasToken ? "regular" : kind;
  return (
    <Page>
      <h1 className="title">我的实例</h1>
      <p className="lede">
        {shown === "regular"
          ? "你在算力市场租的容器实例，每 30 秒刷新一次。开机会开始计费，要点两次确认。"
          : "容器实例 Pro（开发者 Token），每 30 秒刷新一次。"}
      </p>
      {hasToken && (
        <div style={{ marginBottom: 18 }}>
          <Segmented small layoutId="inst-kind" value={kind} onChange={setKind}
            items={[{ id: "regular", label: "普通实例" }, { id: "pro", label: "容器实例 Pro" }]} />
        </div>
      )}
      {shown === "pro" ? <ProInstances /> : hasWebToken ? <RegularInstances /> : (
        <div style={{ maxWidth: 640 }}>
          <Group>
            <div className="empty-state">
              <Icon name="server" size={34} stroke={1.4} /><br />
              还没有填写网页登录凭证，填好后这里会列出你的容器实例。
            </div>
          </Group>
          <div className="row" style={{ marginTop: 18 }}>
            <Btn primary icon="key" onClick={() => go("settings")}>去填写凭证</Btn>
          </div>
        </div>
      )}
    </Page>
  );
}

function ProInstances() {
  const [data, setData] = useState<InstancePage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    return call<InstancePage>("list_instances", { pageIndex: 1, pageSize: 100 })
      .then((d) => { setData(d); setErr(null); }).catch((e) => setErr(String(e))).finally(() => setLoading(false));
  };
  useEffect(() => { load(); const id = setInterval(load, 30000); return () => clearInterval(id); }, []);

  const list = data?.list ?? [];
  const selected = list.find((i) => i.uuid === sel);

  return (
    <>
      <InstanceList loading={loading} onRefresh={load} err={err} loaded={data != null} empty={list.length === 0}
        emptyText="还没有 Pro 实例。到「创建模板」里用模板一键创建一台。">
        {list.map((i) => {
          const h = i.status === "running" ? hoursSince(timeFieldTs(i.started_at)) : null;
          return (
            <motion.div key={i.uuid} variants={stagger.item}>
              <Row icon="server" grey={i.status !== "running"} label={<b style={{ fontWeight: 600 }}>{i.name || "未命名实例"}</b>}
                sub={`${i.region_name || i.region_sign}，${i.gpu_spec_uuid} × ${i.req_gpu_amount}${h != null ? `，已运行 ${h.toFixed(1)} 小时` : ""}`}
                selected={sel === i.uuid} onClick={() => setSel(i.uuid)} right={statusCap(i.status)} chevron />
            </motion.div>
          );
        })}
      </InstanceList>
      <Sheet open={!!selected} onClose={() => setSel(null)} title={selected?.name || selected?.uuid || ""}
        left={<span />} right={<button className="link-btn bold" onClick={() => setSel(null)}>完成</button>}>
        {selected && <Detail inst={selected} onChanged={load} />}
      </Sheet>
    </>
  );
}
