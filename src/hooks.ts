import { useCallback, useEffect, useRef, useState } from "react";
import { call, type PriceInfo } from "./api";

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
 * 页面开着时定时查一次数据：enabled 且窗口可见时每 30 秒一次，出错翻倍退避到 10 分钟，
 * 关掉 / 隐藏就停；换 key 时丢掉还在路上的结果。返回 { data, err, loading, refresh }
 */
export function usePolled<T>(key: string, fetcher: () => Promise<T>, enabled: boolean) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const f = useRef(fetcher);
  f.current = fetcher;
  const delay = useRef(BASE);
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
      setData(d); setErr(null); delay.current = BASE;
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
    live.current = true; delay.current = BASE;
    load();
    const onVis = () => { if (document.visibilityState === "visible") load(); else window.clearTimeout(timer.current); };
    document.addEventListener("visibilitychange", onVis);
    return () => { live.current = false; seq.current++; window.clearTimeout(timer.current); document.removeEventListener("visibilitychange", onVis); };
  }, [key, enabled, load]);

  return { data, err, loading, refresh: load };
}
