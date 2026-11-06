import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { call, fmtTime, type LogEntry } from "../api";
import type { IconName } from "../icons";
import { Group, Page, Segmented, Tile, spring } from "../ui";

const KIND: Record<string, [string, IconName]> = {
  alert: ["有卡提醒", "bell_fill"], auto: ["自动动作", "power"], skip: ["跳过", "pause"], manual: ["手动操作", "sparkle"],
  balance: ["余额", "wallet"], long_running: ["运行时长", "timer"], poll: ["查询", "refresh"],
};
type Filter = "all" | "alert" | "auto" | "manual" | "error";

export default function LogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const load = () => call<LogEntry[]>("list_logs", { limit: 500 }).then(setLogs);
  useEffect(() => { load(); const id = setInterval(load, 10000); return () => clearInterval(id); }, []);
  const shown = logs.filter((l) =>
    filter === "all" ? true : filter === "error" ? l.level !== "info" : filter === "auto" ? l.kind === "auto" || l.kind === "skip" : l.kind === filter);

  return (
    <Page>
      <h1 className="title">日志</h1>
      <p className="lede">提醒、自动抢卡和手动操作的记录，保留 30 天。</p>
      <div style={{ maxWidth: 760 }}>
        <div style={{ marginBottom: 14 }}>
          <Segmented small layoutId="log-filter" value={filter} onChange={setFilter}
            items={[{ id: "all", label: "全部" }, { id: "alert", label: "有卡提醒" }, { id: "auto", label: "自动动作" }, { id: "manual", label: "手动操作" }, { id: "error", label: "警告和错误" }]} />
        </div>
        <Group>
          <AnimatePresence initial={false} mode="popLayout">
            {shown.slice(0, 200).map((l) => {
              const [label, icon] = KIND[l.kind] ?? [l.kind, "doc"];
              return (
                <motion.div key={l.id} layout initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring}
                  className="group-row" style={{ alignItems: "flex-start" }}>
                  <Tile name={icon} grey={l.level === "info" && l.kind !== "alert"} sm />
                  <div className="grow">
                    <div className="label" style={{ color: l.level === "error" ? "var(--red)" : undefined }}>{l.message}</div>
                    <div className="sub">{label}，{fmtTime(l.ts)}</div>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
          {shown.length === 0 && <div className="empty-state">暂时没有记录</div>}
        </Group>
      </div>
    </Page>
  );
}
