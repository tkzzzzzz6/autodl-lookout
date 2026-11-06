import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { call, fmtTime, type Heatmap, type HeatCell, type Rule, type Settings } from "../api";
import { Icon } from "../icons";
import { Group, Page, Segmented, useRefData } from "../ui";

const WEEK = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
type Metric = "hit" | "avg";
type Range = "7" | "14" | "0";

function cellValue(c: HeatCell, metric: Metric) {
  return metric === "hit" ? c.hit_ratio : c.avg_idle;
}

export default function AnalysisPage() {
  const ref = useRefData();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [region, setRegion] = useState<string>("");
  const [gpus, setGpus] = useState<string[]>([]);
  const [keyword, setKeyword] = useState<string>("");
  const [metric, setMetric] = useState<Metric>("hit");
  const [range, setRange] = useState<Range>("14");
  const [data, setData] = useState<Heatmap | null>(null);
  const [hover, setHover] = useState<HeatCell | null>(null);

  useEffect(() => {
    call<Settings>("get_settings").then((s) => { setSettings(s); setRegion((r) => r || s.regions[0] || "westDC3"); });
    call<Rule[]>("list_rules").then(setRules);
  }, []);

  // 可选区域：首页显示的区域 + 规则用到的区域
  const regionOpts = useMemo(() => {
    const signs = [...new Set([...(settings?.regions ?? []), ...rules.map((r) => r.region_sign)])];
    return signs.map((s) => ({ id: s, label: ref?.regions.find((o) => o.value === s)?.label ?? s }));
  }, [settings, rules, ref]);

  // 可选卡型：先放这个区域规则里的关键字（会合并 4090 / 4090D 这类变体），再放历史里出现过的具体卡型
  const keywordOpts = useMemo(() => {
    const ks = rules.filter((r) => r.region_sign === region && r.gpu_keyword.trim()).map((r) => r.gpu_keyword.trim());
    return [...new Set([...ks, ...gpus])];
  }, [rules, region, gpus]);

  useEffect(() => {
    if (!region) return;
    call<string[]>("history_gpus", { region }).then(setGpus);
  }, [region]);

  useEffect(() => {
    if (keywordOpts.length && !keywordOpts.includes(keyword)) setKeyword(keywordOpts[0]);
  }, [keywordOpts]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!region || !keyword) { setData(null); return; }
    call<Heatmap>("stock_heatmap", { region, keyword, days: Number(range) }).then(setData);
  }, [region, keyword, range]);

  const max = useMemo(() => {
    if (!data) return 1;
    if (metric === "hit") return 1;
    return Math.max(1, ...data.cells.map((c) => c.avg_idle ?? 0));
  }, [data, metric]);

  const fmt = (v: number | null | undefined) =>
    v == null ? "—" : metric === "hit" ? `${Math.round(v * 100)}%` : `${v.toFixed(1)} 张`;

  const spanDays = data?.first_ts && data?.last_ts ? (data.last_ts - data.first_ts) / 86400 : 0;
  const enough = !!data && data.samples > 0 && spanDays >= 1;

  return (
    <Page>
      <h1 className="title">抢卡时段</h1>
      <p className="lede">
        {!data || data.samples === 0
          ? "还没有这个卡型的历史数据。软件开着时会持续记录库存，过一两天再来看。"
          : !enough
            ? `目前只有 ${spanDays < 1 / 24 ? "不到 1 小时" : `${Math.max(1, Math.round(spanDays * 24))} 小时`}的数据，至少要一整天才看得出规律。`
            : data.summary}
      </p>

      <div className="row" style={{ gap: 12, marginBottom: 18 }}>
        {regionOpts.length > 1
          ? <Segmented small layoutId="heat-region" value={region} onChange={setRegion} items={regionOpts} />
          : regionOpts[0] && <span className="capsule">{regionOpts[0].label}</span>}
        <label className="capsule" style={{ gap: 6, paddingRight: 4 }}>
          <Icon name="gpu_s" size={15} stroke={1.8} />
          <select className="inline-select" style={{ color: "var(--ink)" }} value={keyword} onChange={(e) => setKeyword(e.target.value)} aria-label="卡型">
            {keywordOpts.length === 0 && <option value="">暂无卡型</option>}
            {keywordOpts.map((k) => <option key={k} value={k}>{gpus.includes(k) ? k : `含“${k}”的卡型`}</option>)}
          </select>
        </label>
        <span style={{ flex: 1 }} />
        <Segmented small layoutId="heat-metric" value={metric} onChange={setMetric}
          items={[{ id: "hit", label: "有卡比例" }, { id: "avg", label: "平均空闲" }]} />
        <Segmented small layoutId="heat-range" value={range} onChange={setRange}
          items={[{ id: "7", label: "近 7 天" }, { id: "14", label: "近 14 天" }, { id: "0", label: "全部" }]} />
      </div>

      <Group className="heat-card">
        <div className="heat" role="table" aria-label="星期 × 小时 空闲热力图" onMouseLeave={() => setHover(null)}>
          <div className="heat-corner" />
          {Array.from({ length: 24 }, (_, h) => (
            <div key={`h${h}`} className="heat-hour num" role="columnheader">{h % 3 === 0 ? h : ""}</div>
          ))}
          {WEEK.map((w, d) => (
            <div key={w} role="row" style={{ display: "contents" }}>
              <div className="heat-day" role="rowheader">{w}</div>
              {Array.from({ length: 24 }, (_, h) => {
                const c = data?.cells[d * 24 + h];
                const v = c ? cellValue(c, metric) : null;
                const strength = v == null ? 0 : Math.min(1, v / max);
                return (
                  <div key={h} role="cell" tabIndex={c?.samples ? 0 : -1}
                    className={`heat-cell ${c?.samples ? "" : "empty"} ${hover === c ? "on" : ""}`}
                    style={{ "--s": `${Math.round(8 + strength * 92)}%` } as React.CSSProperties}
                    onMouseEnter={() => c && setHover(c)} onFocus={() => c && setHover(c)}
                    aria-label={`${w} ${h} 点：${fmt(v)}`} />
                );
              })}
            </div>
          ))}
        </div>
        <div className="heat-foot">
          <AnimatePresence mode="wait" initial={false}>
            <motion.span key={hover ? `${hover.weekday}-${hover.hour}` : "legend"} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }} transition={{ duration: .15 }} className="muted num">
              {hover
                ? hover.samples
                  ? `${WEEK[hover.weekday]} ${String(hover.hour).padStart(2, "0")}:00–${String((hover.hour + 1) % 24).padStart(2, "0")}:00，有卡比例 ${Math.round((hover.hit_ratio ?? 0) * 100)}%，平均空闲 ${(hover.avg_idle ?? 0).toFixed(1)} 张，${hover.samples} 次采样`
                  : `${WEEK[hover.weekday]} ${String(hover.hour).padStart(2, "0")}:00 还没有采样`
                : "把鼠标移到格子上看具体数字"}
            </motion.span>
          </AnimatePresence>
          <span className="heat-legend">
            <span className="muted">{metric === "hit" ? "0%" : "0"}</span>
            <i />
            <span className="muted num">{metric === "hit" ? "100%" : `${max.toFixed(max >= 10 ? 0 : 1)} 张`}</span>
          </span>
        </div>
      </Group>
      <p className="footnote">
        按本机时区统计；每次查询库存记一个采样（间隔约 {settings?.poll_interval_secs ?? 60} 秒），软件关着的时段没有数据。
        {data?.first_ts ? `数据从 ${fmtTime(data.first_ts)} 开始，` : ""}
        历史保留天数可以在「设置」里调整。
      </p>
    </Page>
  );
}
