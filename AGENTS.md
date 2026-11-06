# AGENTS.md

写给在这个仓库里工作的 AI 编码助手（Claude Code、Codex、Cursor 等）和新贡献者。动手前请完整读一遍。

## 协作流程（Issue → PR）

本仓库所有改动都经过 issue 和 PR：先在 issue 里写清楚要做什么，再在独立分支上实现，提交 PR 由维护者审阅、合并。Agent 不直接修改维护者本机的工作区，也不直接提交到 `main`。

### 开始之前

- 每项工作对应一个 issue。没有 issue 时，先按 `.github/ISSUE_TEMPLATE/` 的格式起草，写明背景、工作范围、验收标准和不做的内容，由维护者确认后再动手。
- 从最新的 `origin/main` 拉分支，一个 issue 一个分支、一个 PR。分支命名：`<agent>/<issue 编号>-<简短英文描述>`，例如 `claude/3-webhook-notify`、`codex/4-per-machine-rule`。人工分支可用 `feat/...`、`fix/...`。
- 动手前先读 issue 里列出的参考入口，以及本文件后面的「两种凭证」「已知坑」「安全和钱」。
- 你只能看到已经推送到 GitHub 的内容。维护者本机未推送的改动、本机数据（`%APPDATA%\dev.local.autodl-lookout\` 下的 SQLite 数据库：规则、模板、库存历史、日志）和系统凭据管理器里的凭证都不在你的工作副本里；需要时在 issue 或 PR 里说明，不要猜测它们的内容，也不要索要真实凭证。

### 实现

- 只做 issue 范围内的事。顺手发现的其他问题记下来，在 PR 里列出或另开 issue，不要混进同一个 PR。
- 保持现有代码风格：中文注释和界面文案，说明「为什么」而不是复述代码。
- 不要改写与任务无关的文件，不要批量格式化，不要改动换行符（仓库内文本文件统一为 LF，见 `.gitattributes`）。
- 改了用户可见的行为，同步更新 `README.md` 的功能表、用到的接口或注意事项。
- 新功能和缺陷修复都要有测试：Rust 测试写在对应模块的 `#[cfg(test)] mod tests` 里；调用 AutoDL 的代码用 `api.rs` / `market.rs` 里的本地假 HTTP 服务器检查请求方法、路径、请求头和 body，返回值用真实接口的字段形状。前端目前靠 `tsc` 类型检查和演示模式下的手动验证。

### 开 PR 之前

在仓库根目录运行，全部通过才能提交 PR：

```bash
npm test          # = npm run build（tsc + vite build）+ cargo test
```

`cargo` 不能有新的 warning。这些检查与 CI（`.github/workflows/ci.yml`，Windows 和 Ubuntu 各跑一遍）一致。改了界面时，用离线演示模式（`npm run demo`）实际操作一遍，截图放进 PR。

### 提交与 PR

- 提交信息用中文，`feat:` / `fix:` / `docs:` / `refactor:` / `test:` / `chore:` 开头，标题一行说清楚做了什么，正文分条列出要点。由 Agent 创建的提交，在末尾附上该 Agent 要求的署名行。
- PR 按 `.github/pull_request_template.md` 填写：
  - 关联 issue：`Closes #编号`（全部完成）或 `Refs #编号`（部分完成）；
  - 改了什么、为什么这样改；
  - 验证：分成「已验证」（跑过哪些测试、在什么环境下手动操作过）和「需要在本地确认」（Windows 桌面版实际运行、打包安装、需要真实凭证和真实 AutoDL 数据的部分、会扣费的操作）；
  - 边界：没有做什么、已知限制。
- 给 PR 打 label，Release 说明按 label 分类（见 `.github/release.yml`）：新功能 `enhancement`，缺陷 `bug`，文档 `documentation`，破坏性变更 `breaking-change`。
- 不要合并自己的 PR，合并由维护者决定。

### 审阅之后

- 审阅意见在同一个分支上继续提交修改并推送，不要另开 PR。逐条回复处理结果；不同意的意见说明理由。
- `main` 有新提交、与 PR 冲突时，由提交 PR 的一方变基到最新的 `origin/main` 并解决冲突，再请维护者审阅。只在自己的 PR 分支上强制推送（`--force-with-lease`），绝不强制推送 `main`。

## 项目是什么

**AutoDL Lookout（显卡管家）**：基于 Tauri 2 的桌面工具，盯着 [AutoDL](https://www.autodl.com) 各区域的空闲显卡，有卡时推送系统通知，可选在有卡时自动创建 / 开机「容器实例 Pro」。

- 后端：Rust（`src-tauri/`），负责调用 AutoDL、轮询、规则判断、通知、SQLite 存储、托盘
- 前端：React 19 + TypeScript + Vite（`src/`），动效用 [Motion](https://motion.dev)（`motion/react`）
- 主要开发平台：Windows 10/11；也要能在 macOS 上编译运行
- 界面语言：简体中文

## 常用命令

```bash
npm install            # 安装前端依赖
npm test               # 前端类型检查 + 打包（npm run build）+ Rust 单元测试（cargo test，离线，不需要凭证）
npm run build          # 只做前端类型检查 + 打包到 dist/（Rust 编译时要用到 dist/）
npm run demo           # 离线演示：浏览器打开 http://localhost:1420 ，用 src/mock.ts 的假数据
npm run tauri dev      # 桌面开发模式（需要真实凭证才有数据）
npm run tauri build    # 打安装包，产物在 src-tauri/target/release/bundle/
```

演示模式下顶栏会显示「预览数据」标记，不需要 AutoDL 账号。

## 目录

```
src-tauri/src/
  api.rs        AutoDL 官方开放 API（开发者 Token）：余额、容器实例 Pro、镜像
  market.rs     算力市场库存、余额、普通容器实例（网页登录凭证，控制台内部接口）
  monitor.rs    后台轮询：库存 → 历史 → 规则 → 通知 / 自动动作；余额、运行时长、凭证过期提醒
  store.rs      SQLite：设置、规则、模板、库存历史、日志
  secret.rs     凭证存系统钥匙串（Windows 凭据管理器 / macOS Keychain），不可用时退回数据库
  regions.rs    区域、Pro 规格、公共镜像对照表
  commands.rs   暴露给前端的 Tauri 命令
  tray.rs       托盘图标和菜单
  lib.rs        启动、插件、旧数据迁移
src/
  App.tsx       顶栏（分段导航、状态胶囊、余额）+ 页面切换
  ui.tsx        共用组件：毛玻璃列表 Group/Row/FormRow、Segmented、Switch、Stepper、Sheet、CountUp、Toast…
  icons.tsx     线条图标（24×24，SF Symbols 风格），和 design/ 的设计稿同源
  api.ts        前端调用封装、类型、外部链接、卡型别名
  mock.ts       浏览器预览用假数据
  pages/        库存、提醒规则、我的实例、创建模板、日志、设置
  styles.css    设计令牌和样式（仅浅色）
design/         设计稿 SVG（B2 风格）和应用图标源文件
```

## 两种凭证（最重要的背景）

| 凭证 | 用途 | 接口 | 是否必填 |
|---|---|---|---|
| 网页登录凭证（JWT，浏览器 `localStorage.token`） | 库存、余额、普通容器实例 | `www.autodl.com/api/v1/...`（控制台内部接口） | 必填 |
| 开发者 Token | 容器实例 Pro 的列表 / 开关机 / 创建 / 镜像 | `api.autodl.com/api/v1/dev/...`（官方开放 API） | 可选 |

为什么库存不用官方的 `dev/machine/region/gpu_stock`：它是「弹性部署可调度」口径。2026-11-06 同一分钟实测，西北B区 RTX 4090 官方接口显示 34 张空闲，控制台算力市场是 0 张。用户要的是「现在能不能租到」，所以库存只用算力市场的数据（`market.rs`）。不要再把库存切回 `gpu_stock`。

算力市场用到的内部接口（只需要 `Authorization: <网页凭证>` 一个请求头）：

- `GET  /api/v1/region/list`：机房 `region_sign`（如 `west-B`）→ `region_name`、`data_center`（如 `westDC3`）。软件里的区域代码就是 `data_center`，一个区域对应多个机房。
- `POST /api/v1/machine/region/gpu_type`，body `{"region_sign_list": [...]}`：各卡型空闲 / 总数，和算力市场顶部数字一致。
- `POST /api/v1/user/machine/list`：按机器列出，带 `payg_price`（元 × 1000，每卡每小时）和 `highest_cuda_version`，用于带单价 / CUDA 条件的规则。
- `GET  /api/v1/wallet`：余额（元 × 1000）。
- `POST /api/v1/instance`，body `{"page_index", "page_size"}`：我的普通容器实例；`POST /api/v1/instance/power_on` / `power_off`，body `{"instance_uuid"}`，无卡模式开机加 `"payload": "non_gpu"`。普通实例只做手动开关机，不接规则的自动动作；root 密码只在用户点复制时单独取，不放进列表、不写日志。

这些接口不是官方开放的，随时可能变。改动相关代码时，返回格式的测试要用真实返回的字段形状（见 `market.rs` 里的测试）。

## 已知坑

- **余额接口不能带 `Content-Type: application/json` 又不带 body**，否则 AutoDL 返回 `RequestParameterIsWrong`。`api.rs` 只在有 body 时用 `.json()` 加这个头，不要手动加。
- Pro 的 `snapshot` / `status` 是 GET 带 JSON body；参数错误时会退回用查询参数重试。
- 库存里有 `CPU`、`CPU-close-HT` 等无卡条目，`parse_stock` 会过滤掉。
- 卡型名有两套：库存用 `RTX 4090`、`vGPU-48GB`，Pro 创建用 `gpu_spec_uuid`（`4090D`、`5090-p`、`v-48g`…）。规则用关键字子串匹配，`4090` 会同时匹配 4090 和 4090D。
- 库存按单卡统计，多卡机器不一定开得出来。
- 用户粘贴的凭证可能带 `Bearer `、引号、换行，统一走 `api::clean_token`。
- 应用曾叫 `autodl-manager`：`lib.rs` 的 `migrate_legacy_db` 和 `secret.rs` 的 `LEGACY_SERVICE` 负责把旧数据搬过来，不要删。

## 安全和钱

- **永远不要**把凭证写进日志、错误信息、提交、测试快照或截图。测试里用假字符串。
- 网页登录凭证等同于用户的登录状态，权限比开发者 Token 大，只能存在 `secret.rs` 的钥匙串里。
- 自动创建 / 开机会扣费。保留这些安全阀：每条规则每天次数上限（失败也计数）、执行前查余额并和「自动动作余额下限」比较、默认只提醒。新增任何会产生费用的动作都要有同等的把关，并写日志。
- 释放实例等不可逆操作在界面上用 `ConfirmButton`（点两次）。

## 界面约定

- **只做浅色**，不要加深色模式。
- 风格：留白 + 苹果式毛玻璃（`.glass`、`Group`）、蓝白配色。颜色只用 `styles.css` 里的变量，不要写死新颜色。
- 图标只用 `src/icons.tsx` 里的；需要新图标就按同样的 24×24 线条风格加进去。显卡用 `gpu`（大）/ `gpu_s`（小尺寸简化版）。
- 标题用衬线字体（`.title`、`.hero`，打包的 Noto Serif SC 子集只含 GB2312 常用字，生僻字会回退）。
- 动效用 Motion，并保持克制：弹簧参数用 `ui.tsx` 里的 `spring` / `softSpring`；`App` 已包了 `MotionConfig reducedMotion="user"`。
- 文案：中文、口语、句子式，按钮写清楚动作（「验证并保存」而不是「提交」）；出错时说清楚原因和怎么办。

## 改代码时

- 新的 Tauri 命令：在 `commands.rs` 实现，在 `lib.rs` 的 `generate_handler!` 注册；前端通过 `api.ts` 的 `call()` 调用，参数名用 camelCase（Tauri 自动转 snake_case）。如果浏览器预览要用到，同时在 `mock.ts` 里加假数据。
- 数据库结构变化要兼容老数据（`CREATE TABLE IF NOT EXISTS`、新增列给默认值）。
- 轮询间隔最少 30 秒，出错时指数退避到 10 分钟，不要为了“更实时”去掉。
