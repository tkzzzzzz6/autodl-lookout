import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { LINKS, call, openExternal, timeFieldTs, type Instance, type InstancePage } from "../api";
import { Icon } from "../icons";
import { Btn, ConfirmButton, FormRow, Group, Page, Row, Sheet, copy, stagger, useAction, useToast } from "../ui";

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

export default function InstancesPage({ hasToken, go }: { hasToken: boolean; go: (p: "settings") => void }) {
  if (!hasToken) {
    return (
      <Page>
        <h1 className="title">我的实例</h1>
        <p className="lede">这一页管理的是「容器实例 Pro」，需要开发者 Token。你在算力市场租的普通容器实例请在控制台管理。</p>
        <div style={{ maxWidth: 640 }}>
          <Group>
            <div className="empty-state">
              <Icon name="server" size={34} stroke={1.4} /><br />
              还没有填写开发者 Token。只用普通容器实例的话可以不填。
            </div>
          </Group>
          <div className="row" style={{ marginTop: 18 }}>
            <Btn primary icon="key" onClick={() => go("settings")}>去填写开发者 Token</Btn>
            <Btn icon="external" onClick={() => openExternal(LINKS.console)}>在控制台管理普通实例</Btn>
          </div>
        </div>
      </Page>
    );
  }
  return <ProInstances />;
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
    <Page>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <h1 className="title">我的实例</h1>
          <p className="lede">容器实例 Pro，每 30 秒自动刷新状态。普通容器实例请在控制台管理。</p>
        </div>
        <Btn icon="refresh" spinning={loading} onClick={load}>刷新</Btn>
      </div>
      <div style={{ maxWidth: 720 }}>
        {err && <Group style={{ marginBottom: 16 }}><div className="group-row err-text">{err}</div></Group>}
        <Group>
          <motion.div variants={stagger.container} initial="initial" animate="animate">
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
          </motion.div>
          {data && list.length === 0 && (
            <div className="empty-state">
              <Icon name="server" size={34} stroke={1.4} /><br />
              还没有 Pro 实例。到「创建模板」里用模板一键创建一台。
            </div>
          )}
          {!data && !err && <div className="empty-state">正在读取…</div>}
        </Group>
      </div>
      <Sheet open={!!selected} onClose={() => setSel(null)} title={selected?.name || selected?.uuid || ""}
        left={<span />} right={<button className="link-btn bold" onClick={() => setSel(null)}>完成</button>}>
        {selected && <Detail inst={selected} onChanged={load} />}
      </Sheet>
    </Page>
  );
}
