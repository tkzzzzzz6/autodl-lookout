import { useEffect, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { call, inTauri, onSnapshot, type Snapshot } from "./api";
import { Icon } from "./icons";
import { CountUp, Segmented, type SegItem } from "./ui";
import appIcon from "./assets/app-icon.svg";
import StockPage from "./pages/Stock";
import RulesPage from "./pages/Rules";
import InstancesPage from "./pages/Instances";
import TemplatesPage from "./pages/Templates";
import LogsPage from "./pages/Logs";
import AnalysisPage from "./pages/Analysis";
import SettingsPage from "./pages/Settings";
import ServersPage from "./pages/Servers";

export type PageId = "stock" | "rules" | "analysis" | "instances" | "servers" | "templates" | "logs" | "settings";

function useNow() {
  const [n, setN] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setN(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return n;
}

export default function App() {
  const [page, setPage] = useState<PageId>("stock");
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const now = useNow();

  useEffect(() => {
    const load = () => call<Snapshot>("get_snapshot").then(setSnap);
    load();
    const un = onSnapshot(setSnap);
    const id = setInterval(load, 15000);
    return () => { un(); clearInterval(id); };
  }, []);

  useEffect(() => {
    if (snap && !snap.has_token && !snap.has_web_token) setPage("settings");
  }, [snap?.has_token, snap?.has_web_token]); // eslint-disable-line react-hooks/exhaustive-deps

  const hits = snap?.rules.filter((r) => r.hit).length ?? 0;
  const next = snap?.next_run_at ? Math.max(0, snap.next_run_at - now) : null;

  let dot = "", status = "监控中";
  if (!snap) { dot = "idle"; status = "加载中"; }
  else if (!snap.has_web_token) { dot = "warn"; status = "未设置网页凭证"; }
  else if (snap.paused) { dot = "idle"; status = "已暂停"; }
  else if (snap.running) { status = "正在查询"; }
  else if (snap.last_error) { dot = "err"; status = "查询出错"; }
  else if (next != null) { status = `监控中 · ${next} 秒`; }

  const tabs: SegItem<PageId>[] = [
    { id: "stock", label: "库存" },
    { id: "rules", label: "提醒规则", badge: hits },
    { id: "analysis", label: "抢卡时段" },
    { id: "instances", label: "我的实例" },
    { id: "servers", label: "服务器" },
    { id: "templates", label: "创建模板" },
    { id: "logs", label: "日志" },
    { id: "settings", label: "设置" },
  ];

  return (
    <MotionConfig reducedMotion="user">
      <div className="shell">
        <header className="toolbar">
          <div className="brand"><img src={appIcon} alt="" />显卡管家{!inTauri && <span className="capsule warn" title="在浏览器里打开时显示的是假数据，真实数据请用 npm run tauri dev 打开的软件窗口查看" style={{ fontFamily: "var(--sans)", marginLeft: 4 }}>预览数据</span>}</div>
          <Segmented items={tabs} value={page} onChange={setPage} layoutId="nav-pill" />
          <div className="toolbar-right">
            <motion.button className="status-pill" title={snap?.last_error ?? "点击立即刷新"} whileTap={{ scale: .95 }}
              disabled={!snap?.has_web_token && !snap?.has_token} onClick={() => call("refresh_now")}>
              <span className={`dot ${dot}`}>
                {!dot && !snap?.paused && (
                  <motion.span style={{ position: "absolute", inset: -3, borderRadius: "50%", border: "2px solid var(--green)" }}
                    animate={{ scale: [1, 1.8], opacity: [.6, 0] }} transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }} />
                )}
              </span>
              <span className="num">{status}</span>
              {snap?.running && <Icon name="refresh" size={13} stroke={2} className="spin" />}
            </motion.button>
            <motion.button className="icon-btn" title={snap?.paused ? "恢复监控" : "暂停监控"} whileTap={{ scale: .9 }}
              disabled={!snap?.has_web_token && !snap?.has_token} onClick={() => call("set_paused", { paused: !snap?.paused })}>
              <Icon name={snap?.paused ? "play" : "pause"} size={16} stroke={2} />
            </motion.button>
            {snap?.balance && (
              <span className="balance" title={`代金券 ¥${snap.balance.voucher_balance.toFixed(2)}，累计消费 ¥${snap.balance.accumulate.toFixed(2)}`}>
                <Icon name="wallet" size={16} stroke={1.8} style={{ color: "var(--muted)" }} />
                <span>¥<CountUp value={snap.balance.assets} decimals={2} /></span>
              </span>
            )}
          </div>
        </header>
        <main className="content">
          <AnimatePresence mode="wait">
            {page === "stock" && <StockPage key="stock" snap={snap} go={setPage} />}
            {page === "rules" && <RulesPage key="rules" snap={snap} />}
            {page === "servers" && <ServersPage key="servers" />}
            {page === "instances" && <InstancesPage key="instances" hasToken={!!snap?.has_token} hasWebToken={!!snap?.has_web_token} go={setPage} />}
            {page === "templates" && <TemplatesPage key="templates" hasToken={!!snap?.has_token} />}
            {page === "analysis" && <AnalysisPage key="analysis" />}
            {page === "logs" && <LogsPage key="logs" />}
            {page === "settings" && <SettingsPage key="settings" hasToken={!!snap?.has_token} hasWebToken={!!snap?.has_web_token} webTokenExp={snap?.web_token_exp ?? null} />}
          </AnimatePresence>
        </main>
      </div>
    </MotionConfig>
  );
}
