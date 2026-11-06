import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { LINKS, call, fmtClock, gpuAlias, isGpu, openExternal, type HistoryPoint, type RegionStock, type Rule, type Snapshot, type StockItem } from "../api";
import { Icon } from "../icons";
import { Btn, CountUp, Group, Page, Segmented, Tile, softSpring, spring } from "../ui";
import type { PageId } from "../App";

const FULL = 40; // 进度条满格 = 40 张

function dateLine() {
  const d = new Date();
  const h = d.getHours();
  const part = h < 6 ? "凌晨" : h < 12 ? "上午" : h < 14 ? "中午" : h < 18 ? "下午" : "晚上";
  const wd = "日一二三四五六"[d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日 星期${wd} · ${part}`;
}

/* ---------------- history chart ---------------- */
function History({ region, gpu }: { region: string; gpu: string }) {
  const [hours, setHours] = useState<"24" | "72" | "168">("24");
  const [pts, setPts] = useState<HistoryPoint[] | null>(null);
  useEffect(() => {
    setPts(null);
    call<HistoryPoint[]>("stock_history", { region, gpuName: gpu, hours: Number(hours) }).then(setPts);
  }, [region, gpu, hours]);

  const W = 600, H = 120, P = 2;
  let meta: { max: number; t0: number; t1: number } | null = null;
  let body: React.ReactNode = null;
  let note: string | null = "加载中…";
  if (pts && pts.length < 2) {
    note = "数据还不够，开着软件多跑一会儿就有了";
  } else if (pts) {
    note = null;
    const t0 = pts[0].ts, t1 = pts[pts.length - 1].ts;
    const max = Math.max(4, ...pts.map((p) => p.idle));
    const x = (t: number) => P + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * P);
    const y = (v: number) => H - 4 - (v / max) * (H - 12);
    const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.ts).toFixed(1)},${y(p.idle).toFixed(1)}`).join("");
    const area = `${line}L${x(t1)},${H}L${x(t0)},${H}Z`;
    meta = { max, t0, t1 };
    body = (
      <>
        <defs>
          <linearGradient id="hist-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#0a6cff" stopOpacity=".22" /><stop offset="1" stopColor="#0a6cff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <motion.path d={area} fill="url(#hist-fill)" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: .3, duration: .4 }} />
        <motion.path d={line} fill="none" stroke="#0a6cff" strokeWidth="2" strokeLinejoin="round"
          initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: .8, ease: [.22, 1, .36, 1] }} />
      </>
    );
  }
  return (
    <div className="chart">
      <div className="chart-head">
        <span className="muted" style={{ fontSize: 12 }}>空闲数变化</span>
        <Segmented small layoutId={`range-${region}-${gpu}`} value={hours} onChange={setHours}
          items={[{ id: "24", label: "24 小时" }, { id: "72", label: "3 天" }, { id: "168", label: "7 天" }]} />
      </div>
      {note ? <div className="muted" style={{ fontSize: 12, padding: "36px 0", textAlign: "center" }}>{note}</div> : (
        <>
          <div className="muted num" style={{ fontSize: 11, margin: "8px 0 2px" }}>最多 {meta!.max} 张</div>
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${gpu} 历史空闲数`}>{body}</svg>
          <div className="row muted num" style={{ fontSize: 11, justifyContent: "space-between", marginTop: 4 }}>
            <span>{fmtClock(meta!.t0)}</span><span>{fmtClock(meta!.t1)}</span>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------- one GPU row ---------------- */
function GpuRow({ region, regionName, marketUrl, it, watched, open, onToggle }: {
  region: string; regionName: string; marketUrl: string; it: StockItem; watched: boolean; open: boolean; onToggle: () => void;
}) {
  const prev = useRef(it.idle);
  const [flash, setFlash] = useState(0);
  useEffect(() => {
    if (prev.current === 0 && it.idle > 0) setFlash(Date.now()); // 从没有到有：闪一下
    prev.current = it.idle;
  }, [it.idle]);
  const alias = gpuAlias(it.gpu_name);
  return (
    <>
      <motion.div role="button" tabIndex={0} aria-expanded={open} className="group-row tappable"
        onClick={onToggle} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}
        whileTap={{ scale: .99 }} transition={spring} layout="position">
        <AnimatePresence>
          {flash > 0 && (
            <motion.span key={flash} className="flash" initial={{ opacity: 1 }} animate={{ opacity: 0 }} exit={{ opacity: 0 }}
              transition={{ duration: 1.6, ease: "easeOut" }} onAnimationComplete={() => setFlash(0)} />
          )}
        </AnimatePresence>
        <Tile name="gpu_s" grey={!watched} badge={watched} size={23} />
        <div className="grow" style={{ flex: "0 0 128px" }}>
          <div className={`label ${it.idle ? "" : "dim"}`} style={{ fontWeight: watched ? 550 : 400 }}>{it.gpu_name}</div>
          {alias && <div className="sub">{alias}</div>}
        </div>
        <div className="bar" style={{ flex: 1 }}>
          <motion.i initial={false} animate={{ width: `${Math.min(1, it.idle / FULL) * 100}%` }} transition={softSpring} />
        </div>
        <CountUp value={it.idle} className={`idle ${it.idle ? "" : "zero"}`} />
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={spring} style={{ display: "inline-flex" }}>
          <Icon name="chev" size={16} stroke={2} className="chev" />
        </motion.span>
      </motion.div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="expand" key="x" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={softSpring}>
            <History region={region} gpu={it.gpu_name} />
            <RentBar url={marketUrl} regionName={regionName} gpu={it.gpu_name} idle={it.idle} />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/* ---------------- region group ---------------- */
/** 算力市场只能预选区域，卡型要用户自己点，所以把要点哪个写出来 */
function RentBar({ url, regionName, gpu, idle }: { url: string; regionName: string; gpu: string; idle: number }) {
  return (
    <div className="rent-bar">
      <span className="muted">
        {idle > 0 ? `打开后已选好${regionName}，在卡型里点「${gpu}」就能看到这 ${idle} 张。` : `现在没有空闲，也可以去算力市场看看其他卡型。`}
      </span>
      <Btn small primary={idle > 0} icon="external" onClick={() => openExternal(url)}>去算力市场租</Btn>
    </div>
  );
}

function RegionGroup({ rs, rules }: { rs: RegionStock; rules: Rule[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const watched = (name: string) =>
    rules.some((r) => r.enabled && r.region_sign === rs.region && name.toLowerCase().includes(r.gpu_keyword.toLowerCase()));
  const gpus = rs.items.filter((i) => isGpu(i.gpu_name));
  // 先显示有空闲的和你关注的，其余折叠
  const primary = gpus.filter((i) => i.idle > 0 || watched(i.gpu_name));
  const shown = showAll ? gpus : primary.slice(0, 8);
  const hidden = gpus.length - shown.length;
  const total = gpus.reduce((a, b) => a + b.idle, 0);

  return (
    <section>
      <div className="section-title">
        <Icon name="server" size={22} stroke={1.8} />
        <h2>{rs.region_name}</h2>
        <span className="aside num">共 <CountUp value={total} /> 张空闲</span>
      </div>
      {rs.error ? (
        <Group><div className="group-row"><Tile name="x" sm /><div className="grow err-text">{rs.error}</div></div></Group>
      ) : (
        <Group>
          <motion.div layout transition={softSpring}>
            {shown.length === 0 && <div className="empty-state">这个区域暂时没有返回显卡</div>}
            {shown.map((it) => (
              <GpuRow key={it.gpu_name} region={rs.region} regionName={rs.region_name} marketUrl={rs.market_url} it={it} watched={watched(it.gpu_name)}
                open={open === it.gpu_name} onToggle={() => setOpen(open === it.gpu_name ? null : it.gpu_name)} />
            ))}
            {(showAll ? gpus.length > Math.min(primary.length, 8) : hidden > 0) ? (
              <motion.button layout="position" className="group-row tappable" style={{ color: "var(--blue)", justifyContent: "center", fontSize: 13 }}
                onClick={() => setShowAll(!showAll)}>
                {showAll ? "收起" : `显示其余 ${hidden} 种卡型`}
              </motion.button>
            ) : null}
          </motion.div>
        </Group>
      )}
    </section>
  );
}

/* ---------------- page ---------------- */
export default function StockPage({ snap, go }: { snap: Snapshot | null; go: (p: PageId) => void }) {
  const [rules, setRules] = useState<Rule[]>([]);
  useEffect(() => { call<Rule[]>("list_rules").then(setRules); }, [snap?.rules.length]);

  const regionName = (sign: string) => snap?.regions.find((r) => r.region === sign)?.region_name ?? sign;
  const ruleById = useMemo(() => new Map(rules.map((r) => [r.id, r])), [rules]);
  const hits = (snap?.rules ?? []).filter((s) => s.hit && ruleById.has(s.rule_id));
  const enabled = (snap?.rules ?? []).filter((s) => ruleById.get(s.rule_id)?.enabled);

  if (!snap) return null;

  let hero: React.ReactNode;
  let lede: string;
  if (!snap.has_web_token) {
    hero = <>先连接你的 AutoDL 账号。</>;
    lede = "在「设置」里粘贴网页登录凭证，就能看到和控制台算力市场一样的空闲显卡数。";
  } else if (hits.length === 0) {
    hero = <>现在，你关注的卡都没有空闲。</>;
    lede = enabled.length ? `正在盯着 ${enabled.length} 条规则，有卡会第一时间推送通知。` : "还没有提醒规则，去添加一条吧。";
  } else {
    const shownHits = hits.slice(0, 2);
    const parts = shownHits.map((h, i) => {
      const r = ruleById.get(h.rule_id)!;
      const sameRegion = i > 0 && ruleById.get(shownHits[i - 1].rule_id)!.region_sign === r.region_sign;
      return (
        <Fragment key={h.rule_id}>
          {i === 0 ? "现在，" : ""}{sameRegion ? "还有" : `${regionName(r.region_sign)}有`} <b><CountUp value={h.idle_sum} /></b> 张 {r.gpu_keyword}
          {i === 0 ? " 空闲" : ""}{i === Math.min(hits.length, 2) - 1 ? "。" : "，"}
          {i === 0 && hits.length > 1 && <br />}
        </Fragment>
      );
    });
    hero = <>{parts}</>;
    // 写明每条规则加了哪些卡型，避免和控制台按单卡型显示的数字混淆
    const breakdown = hits.slice(0, 2).filter((h) => h.matched.length > 1)
      .map((h) => `${ruleById.get(h.rule_id)!.gpu_keyword} = ${h.matched.join(" + ")}`).join("；");
    lede = `你关注的 ${enabled.length} 条规则里有 ${hits.length} 条满足条件，已经推送通知。` +
      (hits.length > 2 ? `另外 ${hits.length - 2} 条见右侧。` : "") +
      (breakdown ? `（${breakdown.replace(/×/g, " ")}）` : "");
  }

  return (
    <Page>
      <div className="home-top">
        <div>
          <p className="eyebrow">{dateLine()}</p>
          <h1 className="hero">{hero}</h1>
          <p className="lede">{lede}</p>
          <div className="row">
            {!snap.has_web_token ? (
              <Btn primary icon="key" onClick={() => go("settings")}>去填写凭证</Btn>
            ) : (
              <>
                {snap.has_token
                  ? <Btn primary icon="power" onClick={() => go("templates")}>用模板开一台</Btn>
                  : <Btn primary icon="external" onClick={() => openExternal(hits[0]?.market_url || LINKS.market)}>{hits.length ? `去租 ${ruleById.get(hits[0].rule_id)!.gpu_keyword}` : "去算力市场租"}</Btn>}
                {snap.has_token && hits.length > 0 && <Btn icon="external" onClick={() => openExternal(hits[0].market_url || LINKS.market)}>去算力市场租</Btn>}
                <Btn icon="list" onClick={() => go("rules")}>查看规则</Btn>
              </>
            )}
          </div>
        </div>
        <Widget enabled={enabled.map((s) => ({ s, r: ruleById.get(s.rule_id)! }))} hits={hits.length} lastRun={snap.last_run_at} />
      </div>

      <div className="regions">
        {snap.regions.map((rs) => <RegionGroup key={rs.region} rs={rs} rules={rules} />)}
      </div>
      {snap.has_web_token && snap.regions.length === 0 && (
        <div className="empty-state">{snap.running ? "正在查询库存…" : "还没有库存数据，到「设置」里选几个要看的区域。"}</div>
      )}
      {snap.regions.length > 0 && (
        <p className="footnote">数据和控制台「算力市场」（按量计费）一致，每格按单卡统计，多卡机器要看单台空闲数。带铃铛的是你关注的卡型，进度条满格为 {FULL} 张。</p>
      )}
    </Page>
  );
}

function Widget({ enabled, hits, lastRun }: {
  enabled: { s: Snapshot["rules"][number]; r: Rule }[]; hits: number; lastRun: number | null;
}) {
  const total = Math.max(1, enabled.length);
  const R = 44, C = 2 * Math.PI * R;
  return (
    <motion.div className="widget glass" initial={{ opacity: 0, scale: .96 }} animate={{ opacity: 1, scale: 1 }} transition={{ ...softSpring, delay: .08 }}>
      <div className="widget-head"><Icon name="bell_fill" size={15} />关注中</div>
      <div className="widget-body">
        <div className="ring">
          <svg width="108" height="108" viewBox="0 0 108 108">
            <circle cx="54" cy="54" r={R} fill="none" stroke="var(--track)" strokeWidth="12" />
            <motion.circle cx="54" cy="54" r={R} fill="none" stroke="var(--blue)" strokeWidth="12" strokeLinecap="round"
              strokeDasharray={C} initial={{ strokeDashoffset: C }} animate={{ strokeDashoffset: C * (1 - (enabled.length ? hits / total : 0)) }}
              transition={{ ...softSpring, delay: .2 }} />
          </svg>
          <div className="ring-label">{hits}/{enabled.length}</div>
        </div>
        <div className="widget-list">
          {enabled.slice(0, 5).map(({ s, r }) => (
            <div key={s.rule_id} className={s.hit ? "hit" : ""}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                title={s.matched.length ? `由 ${s.matched.join("、").replace(/×/g, " ")} 张相加` : undefined}>{r.name}</span>
              <b><CountUp value={s.idle_sum} /></b>
            </div>
          ))}
          {enabled.length === 0 && <div>还没有规则</div>}
        </div>
      </div>
      <div className="widget-foot">{lastRun ? `上次查询 ${fmtClock(lastRun)}` : "等待第一次查询"}</div>
    </motion.div>
  );
}
