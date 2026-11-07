// 浏览器预览用的假数据（`npm run dev` 直接在浏览器里打开时生效；在 Tauri 里不会用到）
import type { RegularInstance, Rule, ServerRecord, Watch, Settings, Snapshot, Template } from "./api";

const now = () => Math.floor(Date.now() / 1000);

// 和 regions.rs 的 REGIONS 一致（10 个区域），区域菜单的高度和真实情况一样，会出滚动条
const regionsRef = [
  { value: "westDC3", label: "西北B区" }, { value: "beijingDC2", label: "北京B区" },
  { value: "chongqingDC1", label: "重庆A区" }, { value: "neimengDC3", label: "内蒙B区" },
  { value: "beijingDC1", label: "北京A区" }, { value: "foshanDC1", label: "佛山区" },
  { value: "beijingDC3", label: "V100专区" }, { value: "neimengDC2", label: "A800专区" },
  { value: "shanghaiDC1", label: "摩尔线程专区" }, { value: "westDC2", label: "西北企业区" },
];

let settings: Settings = {
  poll_interval_secs: 60, regions: ["beijingDC3", "neimengDC2", "foshanDC1", "beijingDC2"], low_balance_yuan: 20,
  long_running_hours: 8, auto_min_balance_yuan: 10, history_keep_days: 14, watch_models: ["A100", "V100", "A800"],
};

// 机房代码来自真实的 region/list：西北B区第一个机房 west-B，北京B区 bj-B1
const MKT: Record<string, string> = {
  westDC3: "https://www.autodl.com/market/list?region=west-B",
  beijingDC2: "https://www.autodl.com/market/list?region=bj-B1",
  beijingDC3: "https://www.autodl.com/market/list?region=bj-C1",
  neimengDC2: "https://www.autodl.com/market/list?region=nm-A1",
  foshanDC1: "https://www.autodl.com/market/list?region=fs-A1",
};

// 各区的假库存；快照只返回设置里勾选的区域
const STOCK: Record<string, { name: string; items: { gpu_name: string; idle: number; total: number }[] }> = {
  westDC3: { name: "西北B区", items: [
    { gpu_name: "vGPU-32GB", idle: 103, total: 2528 }, { gpu_name: "RTX 3080 Ti", idle: 60, total: 376 },
    { gpu_name: "RTX 4090", idle: 50, total: 1766 }, { gpu_name: "RTX 4090D", idle: 27, total: 1048 },
    { gpu_name: "vGPU-48GB", idle: 9, total: 970 }, { gpu_name: "RTX 6000D", idle: 7, total: 456 },
    { gpu_name: "RTX 5090", idle: 2, total: 2048 }, { gpu_name: "H800", idle: 1, total: 96 },
    { gpu_name: "RTX 5090 D", idle: 0, total: 240 }, { gpu_name: "RTX PRO 6000", idle: 0, total: 1588 },
  ] },
  beijingDC2: { name: "北京B区", items: [
    { gpu_name: "RTX 3080 Ti", idle: 21, total: 392 }, { gpu_name: "A100-SXM4-80GB", idle: 4, total: 160 },
    { gpu_name: "RTX A4000", idle: 6, total: 24 }, { gpu_name: "RTX 5090", idle: 3, total: 980 },
    { gpu_name: "RTX 4090", idle: 0, total: 940 }, { gpu_name: "RTX 4090D", idle: 0, total: 512 },
  ] },
  beijingDC3: { name: "V100专区", items: [
    { gpu_name: "Tesla V100-SXM2-32GB", idle: 18, total: 320 }, { gpu_name: "V100-SXM2-16GB", idle: 0, total: 64 },
  ] },
  neimengDC2: { name: "A800专区", items: [
    { gpu_name: "A800-SXM4-80GB", idle: 0, total: 512 }, { gpu_name: "A100-SXM4-80GB", idle: 2, total: 96 },
  ] },
  foshanDC1: { name: "佛山区", items: [
    { gpu_name: "RTX 4090", idle: 12, total: 600 }, { gpu_name: "A100-PCIE-40GB", idle: 3, total: 48 },
    { gpu_name: "A800-SXM4-80GB", idle: 5, total: 80 }, { gpu_name: "RTX 3090", idle: 30, total: 410 },
  ] },
};
const ruleUrl = (id: number) => MKT[rules.find((r) => r.id === id)?.region_sign ?? ""] ?? "https://www.autodl.com/market/list";
let rules: Rule[] = [
  ["westDC3", "4090"], ["westDC3", "5090"], ["beijingDC2", "4090"], ["beijingDC2", "5090"],
].map(([r, g], i) => ({
  id: i + 1, name: `${r === "westDC3" ? "西北B区" : "北京B区"} ${g}`, enabled: true, region_sign: r,
  gpu_keyword: g, min_idle: 1, cuda_v_from: null, max_price_yuan: null, cooldown_minutes: 15,
  action: "notify", template_id: null, instance_uuid: null, daily_limit: 1, last_fired_at: null, min_per_machine: i === 3 ? 2 : 1,
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
  regions: settings.regions.filter((r) => STOCK[r]).map((r) => ({
    region: r, region_name: STOCK[r].name, error: null, market_url: MKT[r] ?? "https://www.autodl.com/market/list", items: STOCK[r].items.map((i) => ({ ...i })),
  })),
  rules: [
    { rule_id: 1, hit: true, idle_sum: 77, machines: null, matched: ["RTX 4090×50", "RTX 4090D×27"], error: null, market_url: ruleUrl(1) },
    { rule_id: 2, hit: true, idle_sum: 2, machines: null, matched: ["RTX 5090×2"], error: null, market_url: ruleUrl(2) },
    { rule_id: 3, hit: false, idle_sum: 0, machines: null, matched: [], error: null, market_url: ruleUrl(3) },
    { rule_id: 4, hit: true, idle_sum: 2, machines: 1, matched: ["RTX 5090×2"], error: null, market_url: ruleUrl(4) },
  ],
  balance: { assets: 187.46, accumulate: 2872.54, voucher_balance: 0 }, balance_at: now() - 60,
});

let sshSynced = false;
const watches: Record<string, Watch> = {};
let autoSync = false;
let ownKey: string | null = null;
let myServers: ServerRecord[] = [
  { id: 1, name: "实验室 A100", host: "10.12.0.20", port: 22, user: "tk", auth: "key", key_path: null, alias: null, note: "8 × A100 80G，组里共用" },
  { id: 2, name: "阿里云", host: "47.100.12.9", port: 22, user: "root", auth: "password", key_path: null, alias: null, note: null },
];

let regular: RegularInstance[] = [
  { uuid: "a1b2c3d4e5-f6a7b8c9", name: "qwen-lora", status: "running", sub_status: "", gpu: "RTX 4090", gpu_amount: 2,
    region_name: "西北B区", region_sign: "west-B", machine_alias: "128机", charge_type: "payg", payg_price_yuan: 3.76,
    ssh_command: "ssh -p 32145 root@region-9.autodl.example", jupyter_url: "https://example.invalid/jupyter?token=x",
    service_6006_url: "https://example.invalid/6006", service_6008_url: null,
    started_at: now() - 9.3 * 3600, stopped_at: null, expired_at: null, has_password: true },
  { uuid: "b7c8d9e0f1-a2b3c4d5", name: "", status: "shutdown", sub_status: "", gpu: "RTX 3090", gpu_amount: 1,
    region_name: "北京B区", region_sign: "bj-B1", machine_alias: "41机", charge_type: "payg", payg_price_yuan: 1.58,
    ssh_command: "ssh -p 40211 root@region-4.autodl.example", jupyter_url: null, service_6006_url: null, service_6008_url: null,
    started_at: null, stopped_at: now() - 2 * 86400, expired_at: null, has_password: true },
];

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
      const find = (r: string, g: string) => sn.regions.find((x) => x.region === r)?.items.find((i) => i.gpu_name === g);
      const a = find("foshanDC1", "RTX 4090") ?? find("westDC3", "RTX 4090");
      if (a) a.idle = 12 + ((tick * 7) % 13) - 6;
      const b = find("beijingDC2", "RTX 5090");
      if (b) b.idle = tick % 3 === 0 ? 2 : 0;
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
    list_regular_instances: () => regular,
    regular_instance_password: () => "xxxxxx",
    regular_power_on: () => { regular = regular.map((i) => (i.uuid === a.uuid ? { ...i, status: "running", started_at: now() } : i)); },
    regular_power_off: () => { regular = regular.map((i) => (i.uuid === a.uuid ? { ...i, status: "shutdown", started_at: null, stopped_at: now() } : i)); },
    instance_snapshot: () => ({
      ssh_command: "ssh -p 32145 root@connect.westb.seetacloud.com", root_password: "xxxxxx",
      jupyter_domain: "https://example.invalid/jupyter", service_6006_domain: "https://example.invalid/6006",
      payg_price: 3880, usage_info: { cpu_usage_percent: 34, mem_usage_percent: 61 },
    }),
    // 假价格：几个价位，机器上空闲 1~8 张
    gpu_prices: () => {
      const g = String(a.gpu);
      const base = /5090/.test(g) ? 3.08 : /4090D/.test(g) ? 1.68 : /4090/.test(g) ? 1.88 : /3090/.test(g) ? 1.38 : 2.28;
      const tiers = [0, 0.2, 0.5].map((d, i) => ({
        price_yuan: Math.round((base + d) * 100) / 100, idle: [14, 6, 3][i], machines: [5, 3, 1][i],
        max_per_machine: [8, 4, 3][i], max_cuda: [128, 124, 122][i],
      }));
      return { gpu_name: g, fetched_at: now() - 4, machines: 9, idle: 23, min_yuan: tiers[0].price_yuan, median_yuan: tiers[0].price_yuan,
        max_yuan: tiers[2].price_yuan, tiers, multi: [{ cards: 2, machines: 6 }, { cards: 4, machines: 3 }, { cards: 8, machines: 1 }], unpriced_idle: 0 };
    },
    list_servers: () => ({
      servers: [
        ...regular.map((i) => ({
          id: `autodl:${i.uuid}`, kind: "autodl", name: i.name || `${i.gpu} 实例`, host: i.ssh_command.split("@")[1] ?? "",
          port: Number(i.ssh_command.split(" ")[2]) || 22, user: "root", alias: `autodl-${i.name || "rtx-3090"}-${i.uuid.slice(0, 6)}`,
          alias_ready: sshSynced, auth: "password", key_path: null, has_password: true, key_pushed: i.uuid === regular[0].uuid,
          status: i.status, gpu: `${i.gpu} × ${i.gpu_amount}`, region_name: i.region_name, note: null,
        })),
        ...myServers.map((s) => ({
          id: `srv:${s.id}`, kind: "custom", name: s.name, host: s.host, port: s.port, user: s.user,
          alias: s.alias ?? `lookout-${s.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-+|-+$/g, "") || "server"}-${s.id}`, alias_ready: !!s.alias || sshSynced,
          auth: s.auth, key_path: s.key_path, has_password: s.auth === "password", key_pushed: s.id === 1, status: null, gpu: null, region_name: null, note: s.note,
        })),
      ],
      autodl_error: null, own_key: ownKey, ssh_config_path: "C:\\Users\\you\\.ssh\\config", auto_sync: autoSync, synced: false,
    }),
    save_server: () => { const sv = a.server as ServerRecord; if (sv.id > 0) myServers = myServers.map((x) => (x.id === sv.id ? sv : x)); else myServers = [...myServers, { ...sv, id: myServers.length + 10 }]; return 1; },
    delete_server: () => { myServers = myServers.filter((x) => x.id !== a.id); },
    ssh_config_hosts: () => [
      { alias: "lab-3090", host: "10.12.0.31", port: 22, user: "tk", identity_file: "~/.ssh/id_ed25519" },
      { alias: "aliyun", host: "47.100.12.8", port: 22, user: "ubuntu", identity_file: null },
    ],
    import_ssh_hosts: () => (a.aliases as string[]).length,
    sync_ssh_config: () => { sshSynced = true; return { changed: true, count: 4, path: "C:\\Users\\you\\.ssh\\config" }; },
    set_ssh_auto_sync: () => { autoSync = !!a.on; },
    open_terminal: () => {},
    open_vscode: () => { if (!sshSynced) throw "NEED_SYNC|VS Code 要通过 SSH 配置里的名字连接，先点「同步到 SSH 配置」"; },
    server_password: () => "xxxxxx",
    test_server: () => (a.id === "srv:2"
      ? (() => { throw "HOSTKEY_CHANGED:SHA256:fake|47.100.12.9:22 的主机密钥和上次连接时不一样。AutoDL 实例换了机器或重装系统时会这样，也可能是有人冒充。确认没问题后可以信任新的密钥。"; })()
      : { ms: 86, system: "Linux 5.15.0-105-generic x86_64 · Ubuntu 22.04.4 LTS", via_key: true }),
    ensure_ssh_key: () => { ownKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDemoDemoDemoDemoDemoDemoDemoDemo autodl-lookout"; return ownKey; },
    push_ssh_key: () => {},
    trust_host_key: () => {},
    server_status: () => {
      const lab = a.id === "srv:1";
      const util = lab ? [97, 88, 0, 0, 100, 63, 0, 2] : (a.id as string).startsWith("autodl:") ? [1, 0] : [];
      const gpus = util.map((u, i) => ({ index: i, uuid: `GPU-${i}`, name: lab ? "NVIDIA A100-SXM4-80GB" : "NVIDIA GeForce RTX 4090",
        util: u, mem_used_mb: u > 3 ? 61234 + i * 900 : 4, mem_total_mb: lab ? 81920 : 24564, temp: 30 + u / 3, power_w: 60 + u * 3 }));
      const users = ["zhangsan", "lisi", "tk"];
      return {
        nvidia: gpus.length > 0, gpus,
        procs: gpus.filter((g) => g.util > 3).map((g, i) => ({ gpu: g.index, pid: 12000 + g.index, mem_mb: g.mem_used_mb - 500, user: lab ? users[i % 3] : null,
          elapsed_secs: lab ? 3600 * (i + 2) : null, cmd: lab ? `python train.py --cfg configs/exp${i}.yaml` : null })),
        load1: lab ? 23.5 : 0.4, cores: lab ? 128 : 16, mem_total: lab ? 1081234567890 : 64e9, mem_avail: lab ? 512345678901 : 51e9,
        disks: lab ? [{ mount: "/", total: 1e12, used: 6.1e11 }, { mount: "/home", total: 8e12, used: 7.4e12 }]
          : [{ mount: "/", total: 3e10, used: 1.2e10 }, { mount: "/root/autodl-tmp", total: 5e10, used: 4.6e10 }],
        job_alive: watches[a.id as string]?.job_pid ? true : null, log_mtime: null, remote_now: null, fetched_at: now() - 3,
      };
    },
    get_server_watch: () => watches[a.id as string] ?? { id: a.id, idle: false, idle_minutes: 30, disk: false, job_pid: null, job_log: null, job_quiet_minutes: 15 },
    save_server_watch: () => { const w = a.watch as Watch; watches[w.id] = w; },
    stock_history: () => Array.from({ length: 96 }, (_, i) => ({
      ts: now() - (96 - i) * 900,
      idle: Math.max(0, Math.round(6 + 6 * Math.sin(i / 9) + (i % 7) - 3)), total: 1240,
    })),
    // 两周假历史：深夜和清晨容易有卡，周末更多一点
    stock_heatmap: () => {
      const days = Number(a.days) || 14;
      const cells = Array.from({ length: 168 }, (_, i) => {
        const weekday = Math.floor(i / 24), hour = i % 24;
        const night = Math.max(0, Math.cos(((hour - 3) / 24) * Math.PI * 2));
        const hit = Math.min(1, night * 0.85 + (weekday >= 5 ? 0.18 : 0) + ((i * 37) % 11) / 80);
        const samples = days >= 7 ? Math.round(days / 7) * 60 : 0;
        return { weekday, hour, samples, hit_ratio: hit, avg_idle: hit * 9 };
      });
      return { cells, samples: cells.reduce((s, c) => s + c.samples, 0), first_ts: now() - days * 86400, last_ts: now(),
        summary: "每天 02:00–05:00 最容易有卡（有卡比例约 86%），周末比工作日更容易抢到。" };
    },
    history_gpus: () => ["RTX 4090", "RTX 4090D", "RTX 3090", "vGPU-48GB"],
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
