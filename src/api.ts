import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { mockInvoke, mockListenLive } from "./mock";

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return inTauri ? tauriInvoke<T>(cmd, args) : mockInvoke<T>(cmd, args);
}

export function onSnapshot(cb: (s: Snapshot) => void): () => void {
  if (!inTauri) return () => {};
  let un: (() => void) | undefined;
  tauriListen<Snapshot>("snapshot", (e) => cb(e.payload)).then((u) => (un = u));
  return () => un?.();
}

/** 服务器实时状态（start_live 之后每 2 秒一帧）；返回取消监听的函数，等监听真正挂上后才 resolve */
export function listenServerLive(cb: (e: LiveEvent) => void): Promise<() => void> {
  if (!inTauri) return Promise.resolve(mockListenLive(cb));
  return tauriListen<LiveEvent>("server-live", (e) => cb(e.payload));
}

/** 只改一项设置（页面上的快捷开关用） */
export async function setSetting<K extends keyof Settings>(k: K, v: Settings[K]): Promise<Settings> {
  const s = { ...(await call<Settings>("get_settings")), [k]: v };
  await call("save_settings", { settings: s });
  return s;
}

export interface Opt { value: string; label: string }
export interface RefData { regions: Opt[]; pro_regions: Opt[]; gpu_specs: Opt[]; base_images: Opt[] }
export interface StockItem { gpu_name: string; idle: number; total: number }
/** 服务器页：AutoDL 实例（id = autodl:<uuid>）和自己的服务器（id = srv:<数据库 id>） */
export interface ServerView {
  id: string; kind: "autodl" | "custom"; name: string; host: string; port: number; user: string;
  alias: string; alias_ready: boolean; auth: "key" | "password"; key_path: string | null;
  has_password: boolean; key_pushed: boolean; status: string | null; gpu: string | null; region_name: string | null; note: string | null;
}
export interface ServerList {
  servers: ServerView[]; autodl_error: string | null; own_key: string | null;
  ssh_config_path: string | null; auto_sync: boolean; synced: boolean;
}
/** 存在本机的自己的服务器（save_server 的参数） */
export interface ServerRecord {
  id: number; name: string; host: string; port: number; user: string; auth: "key" | "password";
  key_path: string | null; alias: string | null; note: string | null;
}
export interface HostEntry { alias: string; host: string; port: number; user: string; identity_file: string | null }
export interface Probe { ms: number; system: string; via_key: boolean }
export const HOSTKEY_CHANGED = "HOSTKEY_CHANGED:";
export interface Gpu { index: number; uuid: string; name: string; util: number; mem_used_mb: number; mem_total_mb: number; temp: number | null; power_w: number | null }
export interface GpuProc { gpu: number; pid: number; mem_mb: number; user: string | null; elapsed_secs: number | null; cmd: string | null }
export interface ServerStatus {
  nvidia: boolean; gpus: Gpu[]; procs: GpuProc[]; load1: number | null; cores: number | null;
  mem_total: number | null; mem_avail: number | null; disks: { mount: string; total: number; used: number }[];
  job_alive: boolean | null; log_mtime: number | null; remote_now: number | null; fetched_at: number;
}
export interface LiveEvent { id: string; status: ServerStatus | null; ended: boolean; error: string | null }
/** 列表概览：每台 GPU 的平均利用率和显存合计 */
export interface Overview { gpus: number; util_avg: number | null; mem_used_mb: number; mem_total_mb: number; no_gpu: boolean; error: string | null }
/** 服务器提醒设置（默认全关） */
export interface Watch { id: string; idle: boolean; idle_minutes: number; disk: boolean; job_pid: number | null; job_log: string | null; job_quiet_minutes: number }

/** 点开卡型时的实时价格（gpu_prices），单价都是每卡每小时、元 */
export interface PriceTier { price_yuan: number; idle: number; machines: number; max_per_machine: number; max_cuda: number | null }
export interface PriceInfo {
  gpu_name: string; fetched_at: number; machines: number; idle: number;
  min_yuan: number | null; median_yuan: number | null; max_yuan: number | null;
  tiers: PriceTier[]; multi: { cards: number; machines: number }[]; unpriced_idle: number;
  /** 能租的机器，按单价从低到高 */
  offers: Offer[];
}
export interface Offer { machine_id: string; machine_alias: string; region_sign: string; idle: number; price_yuan: number; max_cuda: number | null }
export interface BaseImage { uuid: string; label: string; framework: string; cuda: number | null; rank: number }
export type RentResult =
  | { status: "created"; instance_uuid: string }
  | { status: "price_changed"; old_yuan: number; new_yuan: number };
export interface Balance { assets: number; accumulate: number; voucher_balance: number }
export interface RegionStock { region: string; region_name: string; items: StockItem[]; error: string | null; market_url: string }
export interface RuleState { rule_id: number; hit: boolean; idle_sum: number; machines: number | null; matched: string[]; error: string | null; market_url: string }
export interface Snapshot {
  has_token: boolean; has_web_token: boolean; web_token_exp: number | null; paused: boolean; running: boolean;
  last_run_at: number | null; next_run_at: number | null; last_error: string | null;
  interval_secs: number; regions: RegionStock[]; rules: RuleState[];
  balance: Balance | null; balance_at: number | null;
}
export interface Settings {
  poll_interval_secs: number; regions: string[]; low_balance_yuan: number;
  long_running_hours: number; auto_min_balance_yuan: number; history_keep_days: number;
  /** 关注的卡型关键字，库存页顶部显示合计 */
  watch_models: string[];
  /** 服务器详情实时刷新（2 秒一帧）；关掉回到 30 秒刷新 */
  server_live: boolean;
  /** 服务器列表显示 GPU 利用率和显存（10 秒一次）；关掉就不采集 */
  server_overview: boolean;
}
export type RuleAction = "notify" | "create" | "power_on";
export interface Rule {
  id: number; name: string; enabled: boolean; region_sign: string; gpu_keyword: string;
  min_idle: number; cuda_v_from: number | null; max_price_yuan: number | null;
  cooldown_minutes: number; action: RuleAction; template_id: number | null;
  instance_uuid: string | null; daily_limit: number; last_fired_at: number | null;
  /** 单台机器至少空出几张卡（1 = 按区域总数） */
  min_per_machine: number;
}
export interface Template {
  id: number; name: string; gpu_spec_uuid: string; gpu_amount: number; data_center_list: string[];
  image_uuid: string; cuda_v_from: number; expand_disk_gb: number;
  instance_name: string | null; start_command: string | null;
}
export interface LogEntry { id: number; ts: number; level: string; kind: string; rule_id: number | null; message: string }
export interface HistoryPoint { ts: number; idle: number; total: number }
export interface HeatCell { weekday: number; hour: number; samples: number; hit_ratio: number | null; avg_idle: number | null }
export interface Heatmap { cells: HeatCell[]; samples: number; first_ts: number | null; last_ts: number | null; summary: string | null }
export interface TimeField { Time: string; Valid: boolean }
export interface Instance {
  uuid: string; name: string; status: string; sub_status?: string; region_sign: string; region_name?: string;
  machine_alias?: string; gpu_spec_uuid: string; req_gpu_amount: number; charge_type?: string;
  created_at?: string | TimeField; started_at?: TimeField; stopped_at?: TimeField;
  [k: string]: unknown;
}
/** 普通容器实例（网页登录凭证），时间是 Unix 秒；root 密码不在列表里，要用 regular_instance_password 单独取 */
export interface RegularInstance {
  uuid: string; name: string; status: string; sub_status: string; gpu: string; gpu_amount: number;
  region_name: string; region_sign: string; machine_alias: string; charge_type: string; payg_price_yuan: number | null;
  ssh_command: string; jupyter_url: string | null; service_6006_url: string | null; service_6008_url: string | null;
  started_at: number | null; stopped_at: number | null; expired_at: number | null; has_password: boolean;
}
export interface InstancePage { list: Instance[]; result_total?: number; max_page?: number; page_index?: number }

export const fmtTime = (ts: number | null | undefined) =>
  ts ? new Date(ts * 1000).toLocaleString("zh-CN", { hour12: false }) : "—";
export const fmtClock = (ts: number) =>
  new Date(ts * 1000).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
export const yuan = (n: number | null | undefined) => (n == null ? "—" : `¥${n.toFixed(2)}`);

export function timeFieldTs(v: unknown): number | null {
  if (!v) return null;
  if (typeof v === "string") { const t = Date.parse(v); return isNaN(t) ? null : t / 1000; }
  const f = v as TimeField;
  if (f.Valid === false || !f.Time) return null;
  const t = Date.parse(f.Time);
  return isNaN(t) ? null : t / 1000;
}

export function errText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}

/** 库存接口里有些卡型名不直观，补一个对应的显卡说明 */
const GPU_ALIAS: Record<string, string> = {
  "vGPU-32GB": "4080S 32G",
  "vGPU-48GB": "4090 48G",
  "vGPU-48GB-350W": "3090 48G",
};
export const gpuAlias = (name: string) => GPU_ALIAS[name];

export const isGpu = (name: string) => !/^CPU/i.test(name);

/** 区域下拉分组：专区 / 企业区和常规区域分开，方便扫读 */
export function regionOptions(regions: Opt[]) {
  const special = (l: string) => /专区|企业区/.test(l);
  return [...regions.filter((o) => !special(o.label)), ...regions.filter((o) => special(o.label))]
    .map((o) => ({ value: o.value, label: o.label, group: special(o.label) ? "专区" : "常规区域" }));
}

export const LINKS = {
  devToken: "https://www.autodl.com/console/center/settings/token",
  proDocs: "https://www.autodl.com/docs/instance_pro_api/",
  market: "https://www.autodl.com/market/list",
  console: "https://www.autodl.com/console/instance/list",
};

/** 用系统浏览器打开外部链接 */
export function openExternal(url: string) {
  const u = url.startsWith("http") ? url : `https://${url}`;
  return inTauri ? openUrl(u) : window.open(u, "_blank");
}
