import { useCallback, useEffect, useRef, useState } from "react";
import { call, listenServerLive, type PriceInfo, type ServerStatus } from "./api";

/** 上次查到的价格，按「区域|卡型」记住：再次点开时先显示它，同时在后台刷新 */
const lastPrice = new Map<string, PriceInfo>();

const BASE = 30_000; // 和其他轮询一致，最少 30 秒
const MAX = 600_000;

/**
 * 点开卡型时的实时价格。查询在 Rust 后端用你自己的网页凭证完成（带缓存、合并请求、限流，见 price.rs）。
 * - enabled 为 true（面板开着）且窗口可见时每 30 秒刷新；收起或窗口隐藏就停
 * - 出错时翻倍退避，最长 10 分钟
 * - refresh()：手动刷新，后端 3 秒内的结果直接复用，防止连点
 */
export function useGpuPrice(region: string, gpu: string, enabled: boolean) {
  const key = `${region}|${gpu}`;
  const [data, setData] = useState<PriceInfo | null>(() => lastPrice.get(key) ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const delay = useRef(BASE);
  const timer = useRef<number | undefined>(undefined);
  const live = useRef(false);
  const seq = useRef(0);

  const load = useCallback(async (force: boolean) => {
    window.clearTimeout(timer.current);
    const my = ++seq.current;
    setLoading(true);
    try {
      const p = await call<PriceInfo>("gpu_prices", { region, gpu, force });
      if (my !== seq.current) return; // 已经换了卡型或收起
      lastPrice.set(key, p);
      setData(p);
      setErr(null);
      delay.current = BASE;
    } catch (e) {
      if (my !== seq.current) return;
      setErr(String(e));
      delay.current = Math.min(delay.current * 2, MAX);
    } finally {
      if (my === seq.current) setLoading(false);
    }
    if (live.current && document.visibilityState === "visible") {
      timer.current = window.setTimeout(() => load(false), delay.current);
    }
  }, [region, gpu, key]);

  useEffect(() => {
    setData(lastPrice.get(key) ?? null);
    setErr(null);
    if (!enabled) return;
    live.current = true;
    delay.current = BASE;
    load(false);
    const onVis = () => {
      if (document.visibilityState === "visible") load(false);
      else window.clearTimeout(timer.current);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      live.current = false;
      seq.current++; // 丢掉还在路上的结果
      window.clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [key, enabled, load]);

  const refresh = useCallback(() => load(true), [load]);
  return { data, err, loading, refresh };
}

/** 每 n 毫秒变一次的当前时间（秒），用于「几秒前更新」 */
export function useNowSec(ms = 1000) {
  const [t, setT] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = window.setInterval(() => setT(Math.floor(Date.now() / 1000)), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return t;
}

/**
 * 页面开着时定时查一次数据：enabled 且窗口可见时每 base 毫秒一次（默认 30 秒），出错翻倍退避到 10 分钟，
 * 关掉 / 隐藏就停；换 key 时丢掉还在路上的结果。返回 { data, err, loading, refresh }
 */
export function usePolled<T>(key: string, fetcher: () => Promise<T>, enabled: boolean, base = BASE) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const f = useRef(fetcher);
  f.current = fetcher;
  const delay = useRef(base);
  const baseRef = useRef(base);
  baseRef.current = base;
  const timer = useRef<number | undefined>(undefined);
  const live = useRef(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    window.clearTimeout(timer.current);
    const my = ++seq.current;
    setLoading(true);
    try {
      const d = await f.current();
      if (my !== seq.current) return;
      setData(d); setErr(null); delay.current = baseRef.current;
    } catch (e) {
      if (my !== seq.current) return;
      setErr(String(e)); delay.current = Math.min(delay.current * 2, MAX);
    } finally {
      if (my === seq.current) setLoading(false);
    }
    if (live.current && document.visibilityState === "visible") timer.current = window.setTimeout(load, delay.current);
  }, []);

  useEffect(() => {
    setData(null); setErr(null);
    if (!enabled) return;
    live.current = true; delay.current = baseRef.current;
    load();
    const onVis = () => { if (document.visibilityState === "visible") load(); else window.clearTimeout(timer.current); };
    document.addEventListener("visibilitychange", onVis);
    return () => { live.current = false; seq.current++; window.clearTimeout(timer.current); document.removeEventListener("visibilitychange", onVis); };
  }, [key, enabled, load]);

  return { data, err, loading, refresh: load };
}

/** 曲线里的一帧：只留画图要的几个数 */
export interface LivePoint { t: number; gpus: { util: number; mem: number }[]; load: number | null; mem: number | null }
export const LIVE_KEEP = 150; // 2 秒一帧，5 分钟

const toPoint = (s: ServerStatus): LivePoint => ({
  t: s.fetched_at,
  gpus: s.gpus.map((g) => ({ util: g.util, mem: g.mem_total_mb > 0 ? (g.mem_used_mb / g.mem_total_mb) * 100 : 0 })),
  load: s.load1 != null && s.cores ? Math.min(100, (s.load1 / s.cores) * 100) : null,
  mem: s.mem_total != null && s.mem_avail != null && s.mem_total > 0 ? (1 - s.mem_avail / s.mem_total) * 100 : null,
});

/**
 * 服务器状态。live 为 true 时在服务器上起常驻采集（后端 start_live，每 2 秒一帧推过来）：
 * 窗口隐藏就停、回来再起，卸载时停。live 为 false 或实时采集起不来时，回到 30 秒一次的 server_status。
 * 最近 150 帧只放在内存里画曲线，不写数据库
 */
export function useServerStatus(id: string, live: boolean) {
  const [liveData, setLiveData] = useState<ServerStatus | null>(null);
  const [liveErr, setLiveErr] = useState<string | null>(null);
  const [history, setHistory] = useState<LivePoint[]>([]);
  const streaming = live && liveErr == null;
  const polled = usePolled<ServerStatus>(id, () => call<ServerStatus>("server_status", { id }), !streaming);

  const push = useCallback((s: ServerStatus) => {
    setHistory((h) => {
      const p = toPoint(s);
      if (h.length && h[h.length - 1].t === p.t) return h;
      return [...h, p].slice(-LIVE_KEEP);
    });
  }, []);

  useEffect(() => { setHistory([]); setLiveData(null); setLiveErr(null); }, [id]);
  useEffect(() => { if (polled.data) push(polled.data); }, [polled.data, push]);

  useEffect(() => {
    if (!streaming) return;
    let alive = true;
    let un: (() => void) | undefined;
    const start = () => call("start_live", { id }).catch((e) => { if (alive) setLiveErr(String(e)); });
    const stop = () => call("stop_live", { id }).catch(() => {});
    const onVis = () => (document.visibilityState === "visible" ? start() : stop());
    listenServerLive((e) => {
      if (!alive || e.id !== id) return;
      if (e.status) { setLiveData(e.status); push(e.status); }
      // 正常停掉（隐藏、关面板）不处理；出错才回到 30 秒刷新
      if (e.ended && e.error) setLiveErr(e.error);
    }).then((u) => {
      if (!alive) { u(); return; }
      un = u;
      if (document.visibilityState === "visible") start();
      document.addEventListener("visibilitychange", onVis);
    });
    return () => { alive = false; un?.(); document.removeEventListener("visibilitychange", onVis); stop(); };
  }, [id, streaming, push]);

  const data = streaming ? liveData : polled.data;
  return {
    data, history, streaming,
    err: streaming ? null : polled.err,
    /** 实时采集起不来的原因（这时已经回到 30 秒刷新） */
    liveErr: live ? liveErr : null,
    loading: !streaming && polled.loading,
    refresh: () => { if (streaming) return; if (live) setLiveErr(null); else polled.refresh(); },
  };
}
