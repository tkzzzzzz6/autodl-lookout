# 参与贡献

感谢你愿意改进 AutoDL Lookout！提 Issue、修 Bug、改文案、加功能都欢迎。

## 开始之前

- 想做的改动比较大（新功能、换数据源、改界面风格）时，先开一个 Issue 说明想法，避免白做。
- 项目背景、目录结构和各种约定写在 [AGENTS.md](./AGENTS.md)，动手前请读一遍，尤其是「两种凭证」和「已知坑」两节。

## 本地开发

需要：

- [Rust](https://rustup.rs)（stable）
- Node.js 18+
- Windows：Visual Studio Build Tools 里的「使用 C++ 的桌面开发」，以及 WebView2（Win10/11 一般自带）
- macOS：Xcode Command Line Tools（`xcode-select --install`）

```bash
git clone https://github.com/tkzzzzzz6/autodl-lookout.git
cd autodl-lookout
npm install
npm run tauri dev
```

只改界面时可以 `npm run dev`，在浏览器打开 http://localhost:1420 ，用的是 `src/mock.ts` 里的假数据，不需要 AutoDL 账号。

## 提交 Pull Request

1. 从 `main` 拉一个新分支，名字能看出在做什么，例如 `fix/balance-param-error`、`feat/webhook-notify`。
2. 保持改动集中：一个 PR 只做一件事。
3. 提交前确认这两条都通过，并且 `cargo` 没有新的 warning：

   ```bash
   npm run build
   cd src-tauri && cargo test
   ```

4. 调用 AutoDL 接口的新代码要带测试：用 `src-tauri/src/api.rs` / `market.rs` 里的本地假 HTTP 服务器检查请求格式，不要依赖真实网络和真实凭证。
5. 改了界面就在 PR 里附截图（浅色即可，项目不做深色模式）。
6. PR 描述写清楚：改了什么、为什么、怎么验证的。

### 提交信息

推荐 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 格式，中英文都可以：

```
feat: 规则支持「单机至少 N 卡」
fix: 余额接口不再发送多余的 Content-Type
docs: 补充网页凭证获取方法
```

## 代码风格

- Rust：`cargo fmt`；错误信息写给用户看，用中文说清楚原因和怎么办。
- TypeScript / React：沿用现有写法；颜色用 `src/styles.css` 里的变量，图标用 `src/icons.tsx`，交互组件优先复用 `src/ui.tsx`。
- 界面文案：简体中文、口语、句子式；按钮写清楚动作。

## 安全

- **不要**在 Issue、PR、日志、截图或测试里贴出任何真实凭证（网页登录凭证、开发者 Token）。网页登录凭证等同于登录状态，泄露后请立即在 AutoDL 网页上退出登录让它失效，开发者 Token 请到控制台删除并重新生成。
- 发现安全问题请不要公开提 Issue，先通过 GitHub 私信或 Security Advisory 联系维护者。

## 关于 AutoDL 接口

本项目与 AutoDL 官方无关。库存和余额用的是 AutoDL 控制台网页自己调用的接口，不在官方开放 API 里，随时可能变化；如果发现接口变了，欢迎提 Issue 附上新的返回格式（记得去掉凭证）。

## 许可

提交贡献即表示你同意你的代码以 [MIT 协议](./LICENSE) 发布。
