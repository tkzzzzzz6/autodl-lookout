# CLAUDE.md

协作流程、项目说明、命令和约定都在 AGENTS.md，所有编码助手共用这一份：

@AGENTS.md

## 给 Claude 的补充

- 回复维护者用简体中文。
- 按 AGENTS.md 的「协作流程」工作：先有 issue，再从最新的 `origin/main` 拉 `claude/<issue 编号>-<简短英文描述>` 分支，提交 PR。不要直接改 `main`，不要合并自己的 PR。
- 开 PR 前跑 `npm test`，通过且没有新 warning 再提交。改了界面就用 `npm run demo`（浏览器 + `src/mock.ts` 假数据）实际操作一遍并截图，放进 PR 的「已验证」。
- Windows 桌面版的实际表现、打包安装、需要真实凭证和真实 AutoDL 数据的部分，写进 PR 的「需要在本地确认」，不要声称已经验证过。
- 不要在对话、日志、提交或 PR 里回显维护者的网页登录凭证或开发者 Token；需要验证接口时，用假服务器写测试，或请维护者在本机 PowerShell 里运行命令后把结果（去掉凭证）贴到 issue。
- 涉及扣费的功能（创建、开机实例）在 issue 里写清楚安全阀并得到维护者确认后再实现。
