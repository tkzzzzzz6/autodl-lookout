// 浏览器预览用的假数据（`npm run dev` 直接在浏览器里打开时生效；在 Tauri 里不会用到）
import type { Rule, Settings, Snapshot, Template } from "./api";

const now = () => Math.floor(Date.now() / 1000);

const regionsRef = [
  { value: "westDC2", label: "西北企业区" }, { value: "westDC3", label: "西北B区" },
  { value: "beijingDC1", label: "北京A区" }, { value: "beijingDC2", label: "北京B区" },
  { value: "neimengDC1", label: "内蒙A区" }, { value: "chongqingDC1", label: "重庆A区" },
];

let settings: Settings = {
  poll_interval_secs: 60, regions: ["westDC3", "beijingDC2"], low_balance_yuan: 20,
  long_running_hours: 8, auto_min_balance_yuan: 10, history_keep_days: 14,
};

let rules: Rule[] = [
  ["westDC3", "4090"], ["westDC3", "5090"], ["beijingDC2", "4090"], ["beijingDC2", "5090"],
].map(([r, g], i) => ({
  id: i + 1, name: `${r === "westDC3" ? "西北B区" : "北京B区"} ${g}`, enabled: true, region_sign: r,
  gpu_keyword: g, min_idle: 1, cuda_v_from: null, max_price_yuan: null, cooldown_minutes: 15,
  action: "notify", template_id: null, instance_uuid: null, daily_limit: 1, last_fired_at: null,
}));

let templates: Template[] = [{
  id: 1, name: "4090D · PyTorch 2.0 / CUDA 11.8", gpu_spec_uuid: "4090D", gpu_amount: 1,
  data_center_list: [], image_uuid: "base-image-l2t43iu6uk", cuda_v_from: 118, expand_disk_gb: 0,
  instance_name: "autodl-lookout", start_command: null,
}];

let tick = 0;
const snapshot = (): Snapshot => ({
  has_token: true, has_web_token: true, web_token_exp: now() + 59 * 86400, paused: false, running: false, last_run_at: now() - 12, next_run_at: now() + 48,
  last_error: null, interval_secs: 60,
  regions: [
    { region: "westDC3", region_name: "西北B区", error: null, items: [
      { gpu_name: "vGPU-32GB", idle: 103, total: 2528 }, { gpu_name: "RTX 3080 Ti", idle: 60, total: 376 },
      { gpu_name: "RTX 4090", idle: 50, total: 1766 }, { gpu_name: "RTX 4090D", idle: 27, total: 1048 },
      { gpu_name: "vGPU-48GB", idle: 9, total: 970 }, { gpu_name: "RTX 6000D", idle: 7, total: 456 },
      { gpu_name: "RTX 5090", idle: 2, total: 2048 }, { gpu_name: "H800", idle: 1, total: 96 },
      { gpu_name: "RTX 5090 D", idle: 0, total: 240 }, { gpu_name: "RTX PRO 6000", idle: 0, total: 1588 },
    ] },
    { region: "beijingDC2", region_name: "北京B区", error: null, items: [
      { gpu_name: "RTX 3080 Ti", idle: 21, total: 392 }, { gpu_name: "RTX A4000", idle: 6, total: 24 },
      { gpu_name: "RTX 5090", idle: 3, total: 980 }, { gpu_name: "RTX 4090", idle: 0, total: 940 },
      { gpu_name: "RTX 4090D", idle: 0, total: 512 },
    ] },
  ],
  rules: [
    { rule_id: 1, hit: true, idle_sum: 77, matched: ["RTX 4090×50", "RTX 4090D×27"], error: null },
    { rule_id: 2, hit: true, idle_sum: 2, matched: ["RTX 5090×2"], error: null },
    { rule_id: 3, hit: false, idle_sum: 0, matched: [], error: null },
    { rule_id: 4, hit: true, idle_sum: 3, matched: ["RTX 5090×3"], error: null },
  ],
  balance: { assets: 187.46, accumulate: 2872.54, voucher_balance: 0 }, balance_at: now() - 60,
});

const instances = {
  result_total: 2, max_page: 1, page_index: 1,
  list: [
    { uuid: "pro-76419909953e", name: "llm-sft", status: "running", region_sign: "westDC3", region_name: "西北B区",
      machine_alias: "westB-412", gpu_spec_uuid: "5090-p", req_gpu_amount: 1, charge_type: "payg",
      started_at: { Time: new Date(Date.now() - 9.3 * 3600e3).toISOString(), Valid: true } },
    { uuid: "pro-76576c61fdf1", name: "", status: "shutdown", region_sign: "beijingDC2", region_name: "北京B区",
      machine_alias: "bjB-077", gpu_spec_uuid: "4090D", req_gpu_amount: 2, charge_type: "payg",
      started_at: { Time: "0001-01-01T00:00:00Z", Valid: false } },
  ],
};

export async function mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  await new Promise((r) => setTimeout(r, 120));
  const a = (args ?? {}) as any;
  const out: Record<string, () => unknown> = {
    get_snapshot: () => {
      const sn = snapshot();
      tick++;
      // 浏览器预览里每次刷新让数字变一点，方便看动效
      sn.regions[0].items[2].idle = 50 + ((tick * 7) % 13) - 6;
      sn.regions[1].items[3].idle = tick % 3 === 0 ? 2 : 0;
      return sn;
    },
    ref_data: () => ({
      regions: regionsRef, pro_regions: regionsRef.filter((r) => ["westDC3", "beijingDC2"].includes(r.value)),
      gpu_specs: [{ value: "5090-p", label: "5090-32G 性能型" }, { value: "4090D", label: "4090D 通用型" }],
      base_images: [{ value: "base-image-l2t43iu6uk", label: "PyTorch 2.0.0 · CUDA 11.8 · Py3.8" }],
    }),
    get_settings: () => settings,
    save_settings: () => { settings = a.settings; },
    list_rules: () => rules,
    save_rule: () => {
      const r = a.rule as Rule;
      if (r.id) rules = rules.map((x) => (x.id === r.id ? r : x)); else rules.push({ ...r, id: Date.now() });
      return r.id;
    },
    delete_rule: () => { rules = rules.filter((r) => r.id !== a.id); },
    list_templates: () => templates,
    save_template: () => {
      const t = a.template as Template;
      if (t.id) templates = templates.map((x) => (x.id === t.id ? t : x)); else templates.push({ ...t, id: Date.now() });
    },
    delete_template: () => { templates = templates.filter((t) => t.id !== a.id); },
    list_instances: () => instances,
    instance_snapshot: () => ({
      ssh_command: "ssh -p 32145 root@connect.westb.seetacloud.com", root_password: "xxxxxx",
      jupyter_domain: "https://example.invalid/jupyter", service_6006_domain: "https://example.invalid/6006",
      payg_price: 3880, usage_info: { cpu_usage_percent: 34, mem_usage_percent: 61 },
    }),
    stock_history: () => Array.from({ length: 96 }, (_, i) => ({
      ts: now() - (96 - i) * 900,
      idle: Math.max(0, Math.round(6 + 6 * Math.sin(i / 9) + (i % 7) - 3)), total: 1240,
    })),
    list_logs: () => [
      { id: 3, ts: now() - 30, level: "info", kind: "alert", rule_id: 1, message: "有卡了：西北B区 4090 — 西北B区 · RTX 4090 空闲 7，RTX 4090D 空闲 3" },
      { id: 2, ts: now() - 4000, level: "warn", kind: "long_running", rule_id: null, message: "llm-sft 已连续运行 8.1 小时，记得关机" },
      { id: 1, ts: now() - 9000, level: "info", kind: "manual", rule_id: null, message: "开机 pro-76419909953e" },
    ],
    get_balance: () => snapshot().balance,
  };
  const f = out[cmd];
  return (f ? f() : null) as T;
}
