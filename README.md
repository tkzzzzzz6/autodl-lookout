# AutoDL Lookout · 显卡管家

基于 AutoDL 开放 API 的桌面工具（Tauri 2 + Rust + React）：
监控各区域空闲显卡、有卡时发系统通知（可选自动创建 / 开机）、管理容器实例 Pro、余额和长时间运行提醒。

## 运行

需要：Rust（`rustup`）、Node 18+。
- Windows：还需要 Visual Studio Build Tools 里的「使用 C++ 的桌面开发」，以及 WebView2（Win10/11 一般自带）
- macOS：还需要 Xcode Command Line Tools（`xcode-select --install`）

界面：浅色毛玻璃风格（`src/styles.css`，CSS `backdrop-filter`），动效用 [Motion](https://motion.dev)（`motion/react`），图标在 `src/icons.tsx`，设计稿在 `design/`。
标题用的衬线字体是 Noto Serif SC 的子集（GB2312 常用字），放在 `src/assets/fonts/`，SIL OFL 授权。

```bash
npm install
npm run tauri dev      # 开发模式
npm run tauri build    # 打包安装包（Windows 是 .msi / .exe，macOS 是 .app / .dmg，在 src-tauri/target/release/bundle/）
```

只调界面时可以 `npm run dev` 在浏览器打开 http://localhost:1420 ，会用 `src/mock.ts` 里的假数据。

首次打开到「设置」填写两个凭证（都存在 Windows 凭据管理器 / macOS 钥匙串里）：

- **网页登录凭证**：查库存用，数字和控制台「算力市场」一致。获取：浏览器登录 autodl.com → F12 → Console 输入 `copy(localStorage.token)`。有效期约 60 天，快过期时软件会提醒。
- **开发者 Token**：查余额、管理和创建实例用（AutoDL 控制台 → 设置 → 开发者Token，账号需实名）。

## 功能

| 页面 | 内容 |
|---|---|
| 库存 | 每个区域每种卡的空闲数，一格一张卡；点开看 24h / 3 天 / 7 天历史 |
| 提醒规则 | 区域 + 卡型关键字 + 空闲门槛 (+ 单价上限 / 最低 CUDA)，冷却时间内不重复提醒；可选「自动创建实例」或「自动开机」 |
| 我的实例 | 列表、开机 / 关机 / 释放、复制 SSH 和密码、打开 Jupyter / 6006 / 6008、保存镜像 |
| 创建模板 | 卡型、卡数、镜像、CUDA、系统盘、开机命令，一键创建 |
| 日志 | 提醒、自动动作、手动操作记录 |
| 设置 | Token、看板区域、轮询间隔、余额提醒线、自动动作余额下限、运行时长提醒、开机自启 |

关闭窗口会留在菜单栏继续监控（菜单栏图标旁的数字 = 当前有卡的规则数）。

### 自动动作的安全阀

- 默认所有规则只提醒；需要手动把「触发后」改成自动创建 / 自动开机
- 每条规则每天最多执行 N 次（失败也计数，避免反复重试）
- 执行前先查余额，低于「自动动作余额下限」就跳过
- 单价上限会作为库存查询的 `price_to` 过滤条件

## 用到的接口

| 用途 | 接口 |
|---|---|
| 余额 | `POST /api/v1/dev/wallet/balance` |
| 库存 | 控制台内部接口（网页凭证）：`GET /api/v1/region/list`、`POST /api/v1/machine/region/gpu_type`、`POST /api/v1/user/machine/list`（带单价 / CUDA 条件的规则） |
| 实例 | `POST /api/v1/dev/instance/pro/{create,list,power_on,power_off,release}`、`GET .../snapshot`、`GET .../status` |
| 镜像 | `POST /api/v1/dev/instance/pro/image/save`、`.../image/private/list` |

注意：

- 为什么不用官方的 `dev/machine/region/gpu_stock`：它是「弹性部署可调度」口径，2026-11-06 21:03 实测西北B区 4090 显示 34 张空闲，同一时刻算力市场是 0 张，和能不能租到差得很远
- 库存的卡型名（如 `RTX 4090`）和 Pro 创建用的 `gpu_spec_uuid`（如 `4090D`、`5090-p`）是两套命名，规则用关键字匹配，模板里单独选规格
- 库存按单卡统计，多卡机器不一定能开出来
- 官方文档没写限流，轮询间隔最少 30 秒，出错时指数退避到最多 10 分钟
- 实例状态只有 `running` 有文档，其他状态值界面里按原样显示

## 代码结构

```
src-tauri/src/
  api.rs       AutoDL 开放 API 客户端（开发者 Token）
  market.rs    算力市场库存（网页凭证）
  monitor.rs   轮询、规则判断、通知、自动动作、余额 / 运行时长提醒
  store.rs     SQLite（设置、规则、模板、库存历史、日志）
  secret.rs    Token 存钥匙串
  regions.rs   区域 / 规格 / 公共镜像对照表
  commands.rs  前端调用的 Tauri 命令
  tray.rs      菜单栏图标
src/
  pages/       库存、规则、实例、模板、日志、设置
  ui.tsx       毛玻璃列表、分段控件、开关、步进器、侧边面板、数字滚动等组件
  icons.tsx    线条图标
  mock.ts      浏览器预览用的假数据
```

测试：`cd src-tauri && cargo test`

数据库位置：Windows 在 `%APPDATA%\dev.local.autodl-lookout\autodl-lookout.sqlite3`，macOS 在 `~/Library/Application Support/dev.local.autodl-lookout/`。
从旧名字 autodl-manager 升级时，首次启动会自动把旧数据库和凭证搬过来（旧数据库文件保留不动）。

## 参与贡献

欢迎提 Issue 和 PR，开发环境、提交规范和注意事项见 [CONTRIBUTING.md](./CONTRIBUTING.md)。使用 AI 编码助手的话，项目约定写在 [AGENTS.md](./AGENTS.md)。

本项目与 AutoDL 官方无关。

## 许可

[MIT](./LICENSE) © 2026 tkzzzzzz6

打包的标题字体是 Noto Serif SC 子集，使用 [SIL Open Font License 1.1](./src/assets/fonts/LICENSE-OFL.txt)。
