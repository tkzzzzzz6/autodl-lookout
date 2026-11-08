// 生成 README 用的界面截图和操作演示 GIF（用演示模式的假数据，不含真实账号信息）。
//
// 用法：
//   npm run demo                                   # 另开一个终端，先把演示页跑起来
//   npm i --no-save playwright && npx playwright install chromium
//   node scripts/screenshots.mjs [http://localhost:1420]
//
// 需要 ffmpeg（转 GIF）和 Python 的 Pillow（PNG → WebP 压缩），产物写到 docs/screenshots/。
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const URL = process.argv[2] ?? "http://localhost:1420";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");
const VIEW = { width: 1280, height: 800 };
mkdirSync(OUT, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "lookout-shots-"));

// 录屏里看不到系统鼠标，画一个假的指针，点击时缩一下
const CURSOR = `
addEventListener("DOMContentLoaded", () => {
  const c = document.createElement("div");
  c.style.cssText = "position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;" +
    "background:rgba(10,132,255,.35);border:2px solid rgba(10,132,255,.9);pointer-events:none;z-index:2147483647;" +
    "transition:transform .12s ease;transform:translate(-100px,-100px)";
  document.body.appendChild(c);
  let x = -100, y = -100, s = 1;
  const draw = () => (c.style.transform = "translate(" + x + "px," + y + "px) scale(" + s + ")");
  addEventListener("mousemove", (e) => { x = e.clientX; y = e.clientY; draw(); }, true);
  addEventListener("mousedown", () => { s = 0.7; draw(); }, true);
  addEventListener("mouseup", () => { s = 1; draw(); }, true);
});`;

const wait = (p, ms) => p.waitForTimeout(ms);
async function tab(p, name) {
  await p.getByRole("tab", { name: new RegExp(`^${name}`) }).click(); // 提醒规则的标签带角标数字
  await wait(p, 1200);
}
async function glide(p, loc) {
  const b = await loc.boundingBox();
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 18 });
  await wait(p, 250);
  await p.mouse.down(); await wait(p, 90); await p.mouse.up();
}
const firstGpuRow = (p) => p.locator(".group-row.tappable[aria-expanded]").first();

// PNG → WebP（2 倍图，文字清楚，体积是 PNG 的五分之一左右）
function webp(png, name) {
  execFileSync("python3", ["-c",
    "import sys;from PIL import Image;Image.open(sys.argv[1]).convert('RGB').save(sys.argv[2],'WEBP',quality=86,method=6)",
    png, join(OUT, name)]);
}

const browser = await chromium.launch();

// ---------- 截图 ----------
{
  const p = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 2 });
  await p.goto(URL);
  await wait(p, 1500);
  const shot = async (name) => {
    const png = join(tmp, name + ".png");
    await p.screenshot({ path: png });
    webp(png, name + ".webp");
    console.log("✓", name);
  };
  await firstGpuRow(p).click();
  await wait(p, 1500);
  await shot("stock");
  await tab(p, "提醒规则"); await shot("rules");
  await tab(p, "抢卡时段"); await shot("analysis");
  await tab(p, "我的实例"); await shot("instances");
  await tab(p, "服务器"); await wait(p, 800); await shot("servers");
  await p.getByText("实验室 3080").first().click();
  await wait(p, 2500);
  await shot("server-live");
  await p.getByRole("button", { name: "完成" }).click();
  await tab(p, "设置"); await shot("settings");
  await p.close();
}

// ---------- 操作演示 GIF ----------
{
  const ctx = await browser.newContext({ viewport: VIEW, recordVideo: { dir: tmp, size: VIEW } });
  await ctx.addInitScript(CURSOR);
  const p = await ctx.newPage();
  await p.goto(URL);
  await wait(p, 2000);
  await glide(p, firstGpuRow(p));                                   // 点开卡型看实时价格
  await wait(p, 2600);
  await glide(p, p.getByRole("tab", { name: /^抢卡时段/ }));
  await wait(p, 2400);
  await glide(p, p.getByRole("tab", { name: /^服务器/ }));
  await wait(p, 1600);
  await glide(p, p.getByText("实验室 3080").first());               // 服务器实时状态
  await wait(p, 5000);
  const video = await p.video().path();
  await ctx.close();
  // 去掉开头页面加载的空白，10 帧 / 秒，宽 800，96 色（控制在 3 MB 以内）
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", "1.2", "-i", video, "-vf",
    "fps=10,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
    join(OUT, "demo.gif")]);
  console.log("✓ demo.gif", (statSync(join(OUT, "demo.gif")).size / 1048576).toFixed(1), "MB");
}

await browser.close();
rmSync(tmp, { recursive: true, force: true });
