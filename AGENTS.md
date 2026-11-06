# AGENTS.md

写给在这个仓库里工作的 AI 编码助手（Claude Code、Codex、Cursor 等）和新贡献者。动手前请完整读一遍。

## 项目是什么

**AutoDL Lookout（显卡管家）**：基于 Tauri 2 的桌面工具，盯着 [AutoDL](https://www.autodl.com) 各区域的空闲显卡，有卡时推送系统通知，可选在有卡时自动创建 / 开机「容器实例 Pro」。

- 后端：Rust（`src-tauri/`），负责调用 AutoDL、轮询、规则判断、通知、SQLite 存储、托盘
- 前端：React 19 + TypeScript + Vite（`src/`），动效用 [Motion](https://motion.dev)（`motion/react`）
- 主要开发平台：Windows 10/11；也要能在 macOS 上编译运行
- 界面语言：简体中文

## 常用命令

```bash
npm install                 # 安装前端依赖
npm run tauri dev           # 开发模式（会自动起 Vite 和编译 Rust）
npm run build               # 前端类型检查 + 打包（tsc && vite build）
npm run tauri build         # 打安装包，产物在 src-tauri/target/release/bundle/
cd src-tauri && cargo test  # Rust 单元测试（不需要网络，也不需要真实凭证）
```

只调界面时可以 `npm run dev`，在浏览器打开 http://localhost:1420 ：此时 `src/mock.ts` 提供假数据，顶栏会显示「预览数据」标记。

**提交前必须通过**：`npm run build` 和 `cd src-tauri && cargo test`，且 `cargo` 不能有新的 warning。

## 目录

```
src-tauri/src/
  api.rs        AutoDL 官方开放 API（开发者 Token）：余额、容器实例 Pro、镜像
  market.rs     算力市场库存（网页登录凭证，控制台内部接口）
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
| 网页登录凭证（JWT，浏览器 `localStorage.token`） | 库存、余额 | `www.autodl.com/api/v1/...`（控制台内部接口） | 必填 |
| 开发者 Token | 容器实例 Pro 的列表 / 开关机 / 创建 / 镜像 | `api.autodl.com/api/v1/dev/...`（官方开放 API） | 可选 |

为什么库存不用官方的 `dev/machine/region/gpu_stock`：它是「弹性部署可调度」口径。2026-11-06 同一分钟实测，西北B区 RTX 4090 官方接口显示 34 张空闲，控制台算力市场是 0 张。用户要的是「现在能不能租到」，所以库存只用算力市场的数据（`market.rs`）。不要再把库存切回 `gpu_stock`。

算力市场用到的内部接口（只需要 `Authorization: <网页凭证>` 一个请求头）：

- `GET  /api/v1/region/list`：机房 `region_sign`（如 `west-B`）→ `region_name`、`data_center`（如 `westDC3`）。软件里的区域代码就是 `data_center`，一个区域对应多个机房。
- `POST /api/v1/machine/region/gpu_type`，body `{"region_sign_list": [...]}`：各卡型空闲 / 总数，和算力市场顶部数字一致。
- `POST /api/v1/user/machine/list`：按机器列出，带 `payg_price`（元 × 1000，每卡每小时）和 `highest_cuda_version`，用于带单价 / CUDA 条件的规则。
- `GET  /api/v1/wallet`：余额（元 × 1000）。

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
- 调用 AutoDL 的新代码要有测试：用 `api.rs` / `market.rs` 里的本地假 HTTP 服务器检查请求方法、路径、请求头和 body。
- 数据库结构变化要兼容老数据（`CREATE TABLE IF NOT EXISTS`、新增列给默认值）。
- 轮询间隔最少 30 秒，出错时指数退避到 10 分钟，不要为了“更实时”去掉。
