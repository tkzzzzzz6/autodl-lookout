import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { LINKS, call, inTauri, openExternal, type Balance, type Settings } from "../api";
import { Btn, ConfirmButton, FormRow, Group, Page, Row, Stepper, Switch, copy, useAction, useRefData, useToast } from "../ui";

const CMD = "copy(localStorage.token)";

export default function SettingsPage({ hasToken, hasWebToken, webTokenExp }: { hasToken: boolean; hasWebToken: boolean; webTokenExp: number | null }) {
  const ref = useRefData();
  const [s, setS] = useState<Settings | null>(null);
  const [saved, setSaved] = useState<string>("");
  const [token, setToken] = useState("");
  const [webToken, setWebToken] = useState("");
  const [autostart, setAutostart] = useState(false);
  const { busy, run } = useAction();
  const toast = useToast();

  useEffect(() => {
    call<Settings>("get_settings").then((x) => { setS(x); setSaved(JSON.stringify(x)); });
    if (inTauri) isEnabled().then(setAutostart).catch(() => {});
  }, []);
  const dirty = s != null && JSON.stringify(s) !== saved;

  const saveToken = async () => {
    const r = await run(() => call<{ balance: Balance; in_keychain: boolean }>("set_token", { token }));
    if (r) {
      setToken("");
      toast(`Token 可用，余额 ¥${r.balance.assets.toFixed(2)}${r.in_keychain ? "，已存入系统凭据管理器" : ""}`);
    }
  };
  const saveWebToken = async () => {
    const r = await run(() => call<{ regions: number; exp: number | null; in_keychain: boolean }>("set_web_token", { token: webToken }));
    if (r) {
      setWebToken("");
      toast(`凭证可用，读到 ${r.regions} 个区域${r.exp ? `，${new Date(r.exp * 1000).toLocaleDateString("zh-CN")} 过期` : ""}`);
    }
  };
  const daysLeft = webTokenExp ? Math.floor((webTokenExp * 1000 - Date.now()) / 86400000) : null;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((x) => (x ? { ...x, [k]: v } : x));
  const toggleRegion = (v: string) => s && set("regions", s.regions.includes(v) ? s.regions.filter((x) => x !== v) : [...s.regions, v]);
  const toggleAuto = async (on: boolean) => {
    setAutostart(on);
    await run(() => (on ? enable() : disable()));
    setAutostart(await isEnabled());
  };
  const saveSettings = async () => {
    if (!s) return;
    const r = await run(() => call("save_settings", { settings: s }), "设置已保存");
    if (r !== undefined) setSaved(JSON.stringify(s));
  };

  return (
    <Page>
      <h1 className="title">设置</h1>
      <p className="lede">只需要网页登录凭证：查库存、查余额都用它，数字和控制台一致。开发者 Token 是可选的，只有用「容器实例 Pro」时才需要。</p>
      <div style={{ maxWidth: 640 }}>
        <div className="group-label">网页登录凭证（必填）</div>
        <Group>
          <FormRow icon="key" label="网页凭证">
            <input className="inline-input" type="password" value={webToken} onChange={(e) => setWebToken(e.target.value)}
              placeholder={hasWebToken ? "已设置，粘贴新的可替换" : "粘贴凭证"} onKeyDown={(e) => e.key === "Enter" && webToken.trim() && saveWebToken()} />
          </FormRow>
          {hasWebToken && daysLeft != null && (
            <Row icon="calendar" grey={daysLeft > 7} label="有效期" value={daysLeft < 0 ? "已过期" : `还剩 ${daysLeft} 天（${new Date(webTokenExp! * 1000).toLocaleDateString("zh-CN")}）`} />
          )}
        </Group>
        <div className="group-foot">
          获取方法：在浏览器里登录 autodl.com，按 F12 打开开发者工具，切到「控制台 / Console」，输入
          <code className="kv-code" style={{ margin: "0 4px", padding: "1px 6px", background: "var(--blue-soft)", borderRadius: 5, cursor: "pointer", whiteSpace: "nowrap" }}
            title="点击复制这条命令" onClick={async () => { await copy(CMD); toast("已复制命令"); }}>{CMD}</code>
          回车，凭证就复制好了，回来粘贴即可。它相当于你的网页登录状态，只存在本机的系统凭据管理器里；在网页上退出登录后需要重新获取。
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <Btn primary icon="check" disabled={busy || !webToken.trim()} onClick={saveWebToken}>验证并保存</Btn>
          {hasWebToken && <ConfirmButton className="btn danger" icon="trash" label="清除凭证" onConfirm={() => run(() => call("clear_web_token"), "已清除网页凭证")} />}
        </div>

        <div className="group-label">容器实例 Pro（可选）</div>
        <Group>
          <FormRow icon="key" label="开发者 Token">
            <input className="inline-input" type="password" value={token} onChange={(e) => setToken(e.target.value)}
              placeholder={hasToken ? "已设置，粘贴新的可替换" : "粘贴 Token"} onKeyDown={(e) => e.key === "Enter" && token.trim() && saveToken()} />
          </FormRow>
        </Group>
        <div className="group-foot">
          只有用到容器实例 Pro 时才需要：「我的实例」「创建模板」，以及规则里的自动创建 / 自动开机。
          在 AutoDL 控制台「账号 → 设置 → 开发者Token」点「新增Token」生成，账号需要完成实名认证。
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <Btn icon="external" onClick={() => openExternal(LINKS.devToken)}>打开开发者 Token 页面</Btn>
          <Btn icon="doc" onClick={() => openExternal(LINKS.proDocs)}>Pro API 文档</Btn>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <Btn primary icon="check" disabled={busy || !token.trim()} onClick={saveToken}>验证并保存</Btn>
          {hasToken && <ConfirmButton className="btn danger" icon="trash" label="清除 Token" onConfirm={() => run(() => call("clear_token"), "已清除 Token")} />}
        </div>

        {s && (
          <>
            <div className="group-label">库存首页显示的区域</div>
            <Group>
              {ref?.regions.map((o) => {
                const on = s.regions.includes(o.value);
                return (
                  <Row key={o.value} icon="server" grey={!on} label={o.label} sub={o.value} onClick={() => toggleRegion(o.value)}
                    right={on ? <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} style={{ color: "var(--blue)", fontWeight: 700 }}>✓</motion.span> : null} />
                );
              })}
            </Group>
            <div className="group-foot">提醒规则用到的区域会自动查询，不必在这里勾选。</div>

            <div className="group-label">关注卡型</div>
            <Group>
              <FormRow icon="gpu_s" label="卡型关键字">
                <ModelsInput value={s.watch_models ?? []} onChange={(v) => set("watch_models", v)} />
              </FormRow>
            </Group>
            <div className="group-foot">库存页顶部显示这些卡型在上面勾选的区域里一共有几张空闲。用逗号或空格分开，不区分大小写，「A100」会同时算上 A100 40G 和 80G。</div>

            <div className="group-label">监控</div>
            <Group>
              <FormRow icon="timer" label="查询间隔"><Stepper value={s.poll_interval_secs} min={30} max={600} step={30} unit="秒" onChange={(v) => set("poll_interval_secs", v)} /></FormRow>
              <FormRow icon="calendar" label="库存历史保留"><Stepper value={s.history_keep_days} min={1} max={90} unit="天" onChange={(v) => set("history_keep_days", v)} /></FormRow>
            </Group>
            <div className="group-foot">查询出错时会自动放慢，最长 10 分钟一次。</div>

            <div className="group-label">提醒</div>
            <Group>
              <FormRow icon="wallet" label="余额低于"><Stepper value={s.low_balance_yuan} min={0} max={1000} step={5} unit="元" onChange={(v) => set("low_balance_yuan", v)} /></FormRow>
              <FormRow icon="power" label="开机余额下限"><Stepper value={s.auto_min_balance_yuan} min={0} max={1000} step={5} unit="元" onChange={(v) => set("auto_min_balance_yuan", v)} /></FormRow>
              <FormRow icon="timer" label="运行超过多久提醒关机"><Stepper value={s.long_running_hours} min={0} max={72} step={1} unit="小时" onChange={(v) => set("long_running_hours", v)} /></FormRow>
            </Group>
            <div className="group-foot">余额低于「开机余额下限」时，规则的自动创建 / 开机和手动开机普通实例都会被拦下。「运行超过多久」设为 0 表示不提醒。</div>

            <div className="group-label">服务器</div>
            <Group>
              <FormRow icon="server" label="详情实时刷新"><Switch checked={s.server_live ?? true} label="详情实时刷新" onChange={(v) => set("server_live", v)} /></FormRow>
              <FormRow icon="gpu_s" label="列表显示服务器状态"><Switch checked={s.server_overview ?? true} label="列表显示服务器状态" onChange={(v) => set("server_overview", v)} /></FormRow>
            </Group>
            <div className="group-foot">实时刷新：打开服务器详情时每 2 秒更新一次并画出最近 5 分钟的曲线，关掉面板或最小化窗口就停；关掉这项回到 30 秒刷新。列表状态：「服务器」页开着时每 10 秒采集一次每台的 GPU 利用率和显存；关掉就不连服务器。</div>

            {inTauri && (
              <>
                <div className="group-label">系统</div>
                <Group>
                  <FormRow icon="sparkle" label="开机时自动启动并隐藏到托盘"><Switch checked={autostart} label="开机自启" onChange={toggleAuto} /></FormRow>
                </Group>
              </>
            )}

            <motion.div initial={false} animate={{ opacity: dirty ? 1 : .5, y: dirty ? 0 : 4 }} transition={{ duration: .2 }}
              className="row" style={{ marginTop: 22 }}>
              <Btn primary icon="check" disabled={busy || !dirty} onClick={saveSettings}>{dirty ? "保存设置" : "设置已保存"}</Btn>
            </motion.div>
          </>
        )}
        <p className="footnote">关闭窗口不会退出，软件会留在托盘里继续监控。要彻底退出，右键托盘图标选「退出」。</p>
      </div>
    </Page>
  );
}

/** 关键字输入：编辑时保留原文，失焦时再拆成列表，避免打逗号时被吞掉 */
function ModelsInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(value.join(", "));
  useEffect(() => { setText(value.join(", ")); }, [value.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = () => onChange([...new Set(text.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean))]);
  return <input className="inline-input" value={text} placeholder="如 A100, V100, A800" onChange={(e) => setText(e.target.value)} onBlur={commit}
    onKeyDown={(e) => { if (e.key === "Enter") commit(); }} />;
}
