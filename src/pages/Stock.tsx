import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { createPortal } from "react-dom";
import { LINKS, call, fmtClock, gpuAlias, isGpu, openExternal, type BaseImage, type HistoryPoint, type Offer, type RegionStock, type RentResult, type Rule, type Settings, type Snapshot, type StockItem } from "../api";
import { Icon } from "../icons";
import { useGpuPrice, useNowSec } from "../hooks";
import { Btn, ConfirmButton, CountUp, FormRow, Group, Page, Row, Segmented, Select, Sheet, Stepper, Tile, softSpring, spring, useAction, useRefData, useToast } from "../ui";
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

/* ---------------- 实时价格 ---------------- */
const yuan = (v: number | null | undefined) => (v == null ? "—" : `¥${v.toFixed(2)}`);

function ago(sec: number) {
  if (sec < 5) return "刚刚更新";
  if (sec < 60) return `${sec} 秒前更新`;
  return `${Math.floor(sec / 60)} 分钟前更新`;
}

/* ---------------- 租用（会扣费） ---------------- */
const cudaText = (c: number | null) => (c == null ? "" : (c / 10).toFixed(1));

function RentSheet({ open, onClose, region, regionName, gpu, offers, onRented }: {
  open: boolean; onClose: () => void; region: string; regionName: string; gpu: string; offers: Offer[]; onRented: () => void;
}) {
  const maxIdle = Math.min(8, Math.max(1, ...offers.map((o) => o.idle)));
  const [n, setN] = useState(1);
  const [pick, setPick] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [images, setImages] = useState<BaseImage[] | null>(null);
  const [image, setImage] = useState<string>("");
  const [changed, setChanged] = useState<{ old_yuan: number; new_yuan: number } | null>(null);
  const { busy, run } = useAction();
  const toast = useToast();

  useEffect(() => { if (open && !images) call<BaseImage[]>("base_images").then(setImages).catch((e) => toast(String(e), true)); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) { setChanged(null); setMore(false); } }, [open]);

  // 单机 N 卡：只列空闲够 N 张的机器，已经按单价从低到高排好；默认选最便宜的
  const fit = offers.filter((o) => o.idle >= n);
  const machine = fit.find((o) => o.machine_id === pick) ?? fit[0];
  useEffect(() => { if (machine && machine.machine_id !== pick) setPick(machine.machine_id); }, [machine?.machine_id]); // eslint-disable-line react-hooks/exhaustive-deps
  // 镜像的 CUDA 不能高于机器驱动支持的版本
  const okImages = (images ?? []).filter((i) => !machine?.max_cuda || i.cuda == null || i.cuda <= machine.max_cuda);
  useEffect(() => { if (okImages.length && !okImages.some((i) => i.uuid === image)) setImage(okImages[0].uuid); }, [okImages.map((i) => i.uuid).join(), machine?.machine_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const price = changed?.new_yuan ?? machine?.price_yuan ?? 0;
  const hourly = price * n;
  const rent = async (accept: boolean) => {
    if (!machine) return;
    const r = await run(() => call<RentResult>("rent_instance", {
      region, gpu, machineId: machine.machine_id, gpuAmount: n, imageUuid: image, expectedPrice: accept ? price : machine.price_yuan, acceptPrice: accept,
    }));
    if (!r) return;
    if (r.status === "price_changed") { setChanged({ old_yuan: r.old_yuan, new_yuan: r.new_yuan }); return; }
    toast("已下单，实例正在开机，到「我的实例」或「服务器」里查看");
    onRented();
    onClose();
  };
  const shown = more ? fit : fit.slice(0, 6);

  return (
    <Sheet open={open} onClose={onClose} title={`租用 ${gpu}`} left={<span />}
      right={<button className="link-btn bold" onClick={onClose}>取消</button>}>
      <p className="muted" style={{ fontSize: 13, margin: "14px 4px 0" }}>
        {regionName}，按量计费：开机期间按小时扣费，关机后只收硬盘费用。数据和控制台算力市场一致，下单前会重新核对这台机器的价格。
      </p>

      <div className="group-label">配置</div>
      <Group>
        <FormRow icon="gpu_s" label="单机卡数"><Stepper value={n} min={1} max={maxIdle} unit=" 卡" onChange={(v) => { setN(v); setChanged(null); }} /></FormRow>
        <FormRow icon="image" label="镜像">
          <Select label="镜像" value={image} onChange={setImage} placeholder={images ? "没有可用的镜像" : "正在读取…"}
            options={okImages.map((i) => ({ value: i.uuid, label: i.label, group: i.framework }))} />
        </FormRow>
      </Group>
      <div className="group-foot">多卡训练要在同一台机器上，所以只列出空闲够 {n} 张的机器。{machine?.max_cuda ? `镜像只列出 CUDA ≤ ${cudaText(machine.max_cuda)} 的（这台机器驱动支持的最高版本）。` : ""}</div>

      <div className="group-label">机器（按单价从低到高，默认最便宜）</div>
      <Group>
        {fit.length === 0 && <div className="empty-state">现在没有单台空闲 {n} 张的机器，少租几张试试。</div>}
        {shown.map((o) => (
          <Row key={o.machine_id} icon="server" grey={o.machine_id !== machine?.machine_id} onClick={() => { setPick(o.machine_id); setChanged(null); }}
            label={<span className="num"><b>¥{o.price_yuan.toFixed(2)}</b> / 卡·时</span>}
            sub={[o.machine_alias || o.machine_id, `空闲 ${o.idle} 张`, o.max_cuda ? `CUDA ≤ ${cudaText(o.max_cuda)}` : "", o.region_sign].filter(Boolean).join("，")}
            right={o.machine_id === machine?.machine_id ? <Icon name="check" size={18} stroke={2.4} className="blue" /> : null} />
        ))}
        {fit.length > 6 && (
          <button className="group-row tappable" style={{ color: "var(--blue)", justifyContent: "center", fontSize: 13 }} onClick={() => setMore(!more)}>
            {more ? "收起" : `显示其余 ${fit.length - 6} 台`}
          </button>
        )}
      </Group>

      <AnimatePresence>
        {changed && (
          <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={softSpring}>
            <Group style={{ marginTop: 16 }} className="idle-banner">
              <div className="group-row" style={{ gap: 10 }}>
                <Icon name="yen" size={20} stroke={2} />
                <span className="grow">刚才核对时这台机器涨价了：¥{changed.old_yuan.toFixed(2)} → <b>¥{changed.new_yuan.toFixed(2)}</b> / 卡·时。确认的话按新价格租。</span>
              </div>
            </Group>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="rent-total">
        <span className="num">¥{price.toFixed(2)} × {n} 卡 = <b>¥{hourly.toFixed(2)}</b> / 时</span>
        <ConfirmButton icon="power" className="btn primary" disabled={busy || !machine || !image}
          label={changed ? `按 ¥${changed.new_yuan.toFixed(2)} 租用` : "租用并开机"}
          confirmLabel={`¥${hourly.toFixed(2)}/时 × ${n} 卡，再点确认`}
          onConfirm={() => rent(!!changed)} />
      </div>
      <div className="group-foot">余额低于「开机余额下限」时不会下单。租到的实例会出现在「我的实例」和「服务器」里。</div>
    </Sheet>
  );
}

/** 点开卡型后的价格：用你自己的网页凭证实时查，单价随时会变 */
function Prices({ region, regionName, gpu, idle }: { region: string; regionName: string; gpu: string; idle: number }) {
  const { data, err, loading, refresh } = useGpuPrice(region, gpu, idle > 0);
  const [renting, setRenting] = useState(false);
  const now = useNowSec();
  if (idle <= 0) return null;
  const maxTier = Math.max(1, ...(data?.tiers.map((t) => t.idle) ?? [1]));
  return (
    <div className="prices">
      <div className="chart-head">
        <span className="muted" style={{ fontSize: 12 }}>
          实时单价{data && <> <b className="num price-range">{data.min_yuan === data.max_yuan ? yuan(data.min_yuan) : `${yuan(data.min_yuan)} – ${yuan(data.max_yuan)}`}</b> / 卡·时</>}
        </span>
        <span className="row" style={{ gap: 10, flexWrap: "nowrap" }}>
          <span className="muted num" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>{data ? ago(Math.max(0, now - data.fetched_at)) : loading ? "查询中…" : ""}</span>
          <Btn small icon="refresh" spinning={loading} onClick={refresh}>刷新</Btn>
          {data && data.offers.length > 0 && <Btn small primary icon="power" onClick={() => setRenting(true)}>租用</Btn>}
        </span>
      </div>
      {data && data.median_yuan != null && data.min_yuan !== data.max_yuan && (
        <div className="muted" style={{ fontSize: 12 }}>一半的空闲卡不超过 <span className="num">{yuan(data.median_yuan)}</span>，共 {data.idle} 张、{data.machines} 台机器</div>
      )}
      {err && <div className="err-text" style={{ fontSize: 12, marginTop: 6 }}>查价格出错：{err}{data ? "（下面是上次的结果）" : ""}</div>}
      {data && data.tiers.length > 0 && (
        <div className="tiers">
          {data.tiers.slice(0, 6).map((t) => (
            <div key={t.price_yuan} className="tier">
              <span className="num tier-price">{yuan(t.price_yuan)}</span>
              <span className="tier-bar"><motion.i initial={{ width: 0 }} animate={{ width: `${(t.idle / maxTier) * 100}%` }} transition={softSpring} /></span>
              <span className="num tier-idle">{t.idle} 张</span>
              <span className="muted num tier-sub">
                {t.machines} 台{t.max_per_machine > 1 ? `，单台最多 ${t.max_per_machine} 张` : ""}{t.max_cuda ? `，CUDA ≤ ${(t.max_cuda / 10).toFixed(1)}` : ""}
              </span>
            </div>
          ))}
          {data.tiers.length > 6 && <div className="muted" style={{ fontSize: 11.5, paddingLeft: 2 }}>还有 {data.tiers.length - 6} 个更贵的价位</div>}
        </div>
      )}
      {data && (
        <div className="row multi">
          {data.multi.map((m) => (
            <span key={m.cards} className={`capsule ${m.machines ? "" : "dim"}`}>单机 ≥ {m.cards} 卡<b className="num">{m.machines} 台</b></span>
          ))}
          {data.unpriced_idle > 0 && <span className="muted" style={{ fontSize: 11.5 }}>另有 {data.unpriced_idle} 张没标价</span>}
        </div>
      )}
      {data && data.tiers.length === 0 && !err && <div className="muted" style={{ fontSize: 12, padding: "10px 0" }}>刚才查的时候已经没有可租的机器了，库存数字会在下一轮查询更新。</div>}
      {/* 挂到 body 上：展开动画的容器带 transform，fixed 定位的面板会被困在卡片里 */}
      {createPortal(
        <RentSheet open={renting} onClose={() => setRenting(false)} region={region} regionName={regionName} gpu={gpu}
          offers={data?.offers ?? []} onRented={refresh} />,
        document.body,
      )}
    </div>
  );
}

/* ---------------- one GPU row ---------------- */
function GpuRow({ region, regionName, marketUrl, it, watched, open, onToggle, title, sub }: {
  region: string; regionName: string; marketUrl: string; it: StockItem; watched: boolean; open: boolean; onToggle: () => void;
  /** 按卡型看时，行标题是区域名 */
  title?: string; sub?: string;
}) {
  const prev = useRef(it.idle);
  const [flash, setFlash] = useState(0);
  useEffect(() => {
    if (prev.current === 0 && it.idle > 0) setFlash(Date.now()); // 从没有到有：闪一下
    prev.current = it.idle;
  }, [it.idle]);
  const alias = sub ?? gpuAlias(it.gpu_name);
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
          <div className={`label ${it.idle ? "" : "dim"}`} style={{ fontWeight: watched ? 550 : 400 }}>{title ?? it.gpu_name}</div>
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
            <Prices region={region} regionName={regionName} gpu={it.gpu_name} idle={it.idle} />
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

/* ---------------- 按卡型 ---------------- */
type Loc = { rs: RegionStock; it: StockItem };
const matchKw = (name: string, kw: string) => name.toLowerCase().includes(kw.trim().toLowerCase());

/** 所有看板区域里的卡，按卡型名合并：卡型 → 各区 */
function byModel(regions: RegionStock[]) {
  const m = new Map<string, Loc[]>();
  for (const rs of regions) {
    if (rs.error) continue;
    for (const it of rs.items.filter((i) => isGpu(i.gpu_name))) {
      m.set(it.gpu_name, [...(m.get(it.gpu_name) ?? []), { rs, it }]);
    }
  }
  return m;
}

/** 顶部「关注卡型」：每个关键字在看板区域里的空闲合计 / 总数，以及分布在哪些区 */
function WatchSummary({ regions, models, onPick, picked }: { regions: RegionStock[]; models: string[]; onPick: (kw: string) => void; picked: string | null }) {
  if (models.length === 0) return null;
  const all = [...byModel(regions).entries()];
  return (
    <div className="watch-cards">
      {models.map((kw) => {
        const locs = all.filter(([name]) => matchKw(name, kw)).flatMap(([, l]) => l);
        const idle = locs.reduce((a, l) => a + l.it.idle, 0);
        const total = locs.reduce((a, l) => a + l.it.total, 0);
        // 同一区可能有好几种匹配的卡（如 A100 40G / 80G），按区合计
        const perRegion = new Map<string, number>();
        locs.forEach((l) => perRegion.set(l.rs.region_name, (perRegion.get(l.rs.region_name) ?? 0) + l.it.idle));
        const where = [...perRegion.entries()].sort((a, b) => b[1] - a[1]);
        return (
          <motion.button key={kw} className={`watch-card glass ${picked === kw ? "picked" : ""}`} whileTap={{ scale: .98 }} transition={spring}
            onClick={() => onPick(kw)} aria-pressed={picked === kw} aria-label={`${kw} 空闲 ${idle} 张，共 ${total} 张`}>
            <span className="wc-head"><Icon name="gpu_s" size={16} stroke={1.8} /><b>{kw}</b></span>
            <span className="wc-num num"><CountUp value={idle} className={idle ? "" : "zero"} /><small> / {total} 张空闲</small></span>
            <span className="wc-where muted">
              {locs.length === 0 ? "看板区域里没有这种卡" : where.map(([r, n]) => `${r} ${n}`).join(" · ")}
            </span>
          </motion.button>
        );
      })}
    </div>
  );
}

function ModelView({ regions, rules, models, focus, onClearFocus }: {
  regions: RegionStock[]; rules: Rule[]; models: string[]; focus: string | null; onClearFocus: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const watched = (rs: RegionStock, name: string) =>
    rules.some((r) => r.enabled && r.region_sign === rs.region && matchKw(name, r.gpu_keyword));
  const isFav = (name: string) => models.some((kw) => matchKw(name, kw));
  let list = [...byModel(regions).entries()].map(([name, locs]) => ({
    name, locs: [...locs].sort((a, b) => b.it.idle - a.it.idle),
    idle: locs.reduce((a, l) => a + l.it.idle, 0), total: locs.reduce((a, l) => a + l.it.total, 0),
  }));
  if (focus) list = list.filter((m) => matchKw(m.name, focus));
  // 关注的卡型在前，然后按空闲数
  list.sort((a, b) => Number(isFav(b.name)) - Number(isFav(a.name)) || b.idle - a.idle || a.name.localeCompare(b.name));
  const primary = focus ? list : list.filter((m) => m.idle > 0 || isFav(m.name));
  const shown = showAll ? list : primary;

  return (
    <>
      {focus && (
        <div className="row" style={{ gap: 8, marginBottom: 14 }}>
          <span className="capsule on">只看名字含「{focus}」的卡型</span>
          <Btn small icon="x" onClick={onClearFocus}>看全部卡型</Btn>
        </div>
      )}
      <div className="regions">
        {shown.map((m) => (
          <section key={m.name}>
            <div className="section-title">
              <Icon name="gpu_s" size={20} stroke={1.8} />
              <h2>{m.name}</h2>
              <span className="aside num">{m.locs.length} 个区，共 <CountUp value={m.idle} /> / {m.total} 张空闲</span>
            </div>
            <Group>
              {m.locs.map(({ rs, it }) => {
                const key = `${rs.region}|${it.gpu_name}`;
                return (
                  <GpuRow key={key} region={rs.region} regionName={rs.region_name} marketUrl={rs.market_url} it={it}
                    watched={watched(rs, it.gpu_name)} title={rs.region_name} sub={`共 ${it.total} 张`}
                    open={open === key} onToggle={() => setOpen(open === key ? null : key)} />
                );
              })}
            </Group>
          </section>
        ))}
      </div>
      {shown.length === 0 && <div className="empty-state">{focus ? `看板区域里没有名字含「${focus}」的卡型。` : "看板区域里暂时没有显卡数据。"}</div>}
      {!focus && list.length > primary.length && (
        <div className="row" style={{ justifyContent: "center", marginTop: 18 }}>
          <Btn small onClick={() => setShowAll(!showAll)}>{showAll ? "只看有空闲和关注的卡型" : `显示其余 ${list.length - primary.length} 种卡型`}</Btn>
        </div>
      )}
    </>
  );
}

type View = "region" | "model";
function loadView(): View {
  try { return localStorage.getItem("stock-view") === "model" ? "model" : "region"; } catch { return "region"; }
}

/* ---------------- page ---------------- */
export default function StockPage({ snap, go }: { snap: Snapshot | null; go: (p: PageId) => void }) {
  const [rules, setRules] = useState<Rule[]>([]);
  useEffect(() => { call<Rule[]>("list_rules").then(setRules); }, [snap?.rules.length]);
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => { call<Settings>("get_settings").then((s) => setModels(s.watch_models ?? [])); }, []);
  const [view, setViewState] = useState<View>(loadView);
  const setView = (v: View) => { setViewState(v); try { localStorage.setItem("stock-view", v); } catch { /* 预览里可能不可用 */ } };
  const [focus, setFocus] = useState<string | null>(null);

  const ref = useRefData();
  // 规则里的区域不一定在看板区域里，名字从区域对照表找，别直接显示代码
  const regionName = (sign: string) =>
    snap?.regions.find((r) => r.region === sign)?.region_name ?? ref?.regions.find((o) => o.value === sign)?.label ?? sign;
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

      {snap.regions.length > 0 && (
        <>
          <WatchSummary regions={snap.regions} models={models} picked={view === "model" ? focus : null}
            onPick={(kw) => { if (view === "model" && focus === kw) setFocus(null); else { setFocus(kw); setView("model"); } }} />
          <div className="row" style={{ justifyContent: "space-between", margin: "0 6px 18px" }}>
            <span className="muted" style={{ fontSize: 13 }}>
              {view === "region" ? "按区域看每种卡的空闲数" : "同一种卡在各区的空闲数和合计"}
            </span>
            <Segmented small layoutId="stock-view" value={view} onChange={(v) => { setView(v); if (v === "region") setFocus(null); }}
              items={[{ id: "region", label: "按区域" }, { id: "model", label: "按卡型" }]} />
          </div>
        </>
      )}
      {view === "region" ? (
        <div className="regions">
          {snap.regions.map((rs) => <RegionGroup key={rs.region} rs={rs} rules={rules} />)}
        </div>
      ) : (
        <ModelView regions={snap.regions} rules={rules} models={models} focus={focus} onClearFocus={() => setFocus(null)} />
      )}
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
