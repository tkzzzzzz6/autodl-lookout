// 版本号工具：三处版本号（package.json、src-tauri/Cargo.toml、src-tauri/tauri.conf.json）必须一致。
//   node scripts/version.mjs check [v0.1.0]  检查三处一致；给了 tag 还要和 tag 一致（发版 workflow 用）
//   node scripts/version.mjs set 0.2.0       同时改三处（连同 package-lock.json、Cargo.lock 里本项目的那一条）
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const p = (f) => join(root, f);
const read = (f) => readFileSync(p(f), "utf8");
const SEMVER = /^\d+\.\d+\.\d+$/; // MSI 安装包只认纯数字的三段版本号，不能带 -beta 之类的后缀

// Cargo.toml / Cargo.lock 里本项目那一段的 version
const CARGO_TOML = /(\[package\][^[]*?\nversion\s*=\s*")([^"]+)(")/;
const CARGO_LOCK = /(\[\[package\]\]\nname = "autodl-lookout"\nversion = ")([^"]+)(")/;

function versions() {
  return {
    "package.json": JSON.parse(read("package.json")).version,
    "src-tauri/Cargo.toml": read("src-tauri/Cargo.toml").match(CARGO_TOML)?.[2],
    "src-tauri/tauri.conf.json": JSON.parse(read("src-tauri/tauri.conf.json")).version,
  };
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "check") {
  const v = versions();
  const set = new Set(Object.values(v));
  if (set.size !== 1) fail(`三处版本号不一致：\n${Object.entries(v).map(([f, x]) => `  ${f}: ${x}`).join("\n")}\n用 node scripts/version.mjs set <版本号> 统一改。`);
  const [ver] = set;
  if (!SEMVER.test(ver)) fail(`版本号 ${ver} 不是 x.y.z 的格式（Windows 的 MSI 安装包不支持后缀）`);
  if (arg) {
    const tag = arg.replace(/^refs\/tags\//, "");
    if (tag !== `v${ver}`) fail(`tag ${tag} 和版本号 ${ver} 对不上，应该是 v${ver}。先改版本号合并到 main，再在那个提交上打 tag。`);
  }
  console.log(`✓ 版本号 ${ver}${arg ? `，和 tag 一致` : ""}`);
} else if (cmd === "set") {
  if (!arg || !SEMVER.test(arg)) fail("用法：node scripts/version.mjs set 0.2.0（x.y.z，不带 v）");
  const pkg = JSON.parse(read("package.json"));
  pkg.version = arg;
  writeFileSync(p("package.json"), JSON.stringify(pkg, null, 2) + "\n");
  const lock = JSON.parse(read("package-lock.json"));
  lock.version = arg;
  if (lock.packages?.[""]) lock.packages[""].version = arg;
  writeFileSync(p("package-lock.json"), JSON.stringify(lock, null, 2) + "\n");
  const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
  conf.version = arg;
  writeFileSync(p("src-tauri/tauri.conf.json"), JSON.stringify(conf, null, 2) + "\n");
  for (const [f, re] of [["src-tauri/Cargo.toml", CARGO_TOML], ["src-tauri/Cargo.lock", CARGO_LOCK]]) {
    const s = read(f);
    if (!re.test(s)) fail(`${f} 里没找到本项目的 version`);
    writeFileSync(p(f), s.replace(re, `$1${arg}$3`));
  }
  console.log(`✓ 版本号改成了 ${arg}（package.json、package-lock.json、Cargo.toml、Cargo.lock、tauri.conf.json）`);
} else {
  fail("用法：node scripts/version.mjs check [tag] | set <版本号>");
}
