# CLAUDE.md

项目说明、命令、架构和约定都在 AGENTS.md，所有编码助手共用这一份：

@AGENTS.md

## 给 Claude 的补充

- 回复用户用简体中文。
- 改完代码后先跑 `npm run build` 和 `cd src-tauri && cargo test`，两者都通过、没有新 warning 再交付。
- 界面改动要截图自查：`npm run build && npx vite preview` 后用 Playwright 打开（浏览器里是 `src/mock.ts` 的假数据），确认布局和动效没问题。
- 不要在对话、日志或提交里回显用户的网页登录凭证或开发者 Token；需要验证接口时让用户在本机 PowerShell 里跑命令，或用假服务器写测试。
- 涉及扣费的功能（创建、开机）先和用户确认方案，再动手。
