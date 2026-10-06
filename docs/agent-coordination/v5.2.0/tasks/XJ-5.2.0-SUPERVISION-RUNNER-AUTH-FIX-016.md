# XJ-5.2.0-SUPERVISION-RUNNER-AUTH-FIX-016

- owner: gpt-6.1-sol-low
- manager: Codex /root
- base_commit: eb16e2b74e6ab919a782b8bc6f66bfe9524431f2
- active_release_train: 5.2.0 implementation; stage 016; not release-ready
- contract_id: xj-5.2.0-supervision-runner-auth-fix-v1
- write_lock_id: lock-5.2.0-supervision-runner-auth-fix-016
- write_allowlist: tests/v5.2.0/015-local-electron-acceptance.cjs; docs/delivery-reports/XJ-5.2.0-SUPERVISION-PRODUCTION-INTEGRATION-015.md
- forbidden: production code, package/version/release files, other tests, real data/network, commit/merge/push/sign/upload/publish

## Objective

修复 015 受控 Electron/CDP runner。当前 runner 只等待 /index.html；临时 userData 下 main.js 正确停在 account.html，独立运行 exit 1、约 13 秒后 page timeout。必须复用已验证的 tests/v5.0.0-production/external-g8-visual-matrix/run-visual-matrix.js 认证流程，不得用静态断言替代。

## Required Work

1. 可读地重写单个 runner（允许完整重写该文件）：启动 server/account-auth-routes.js 合成 auth 服务、临时 auth data、auth.listen()，设置 XJ_ACCOUNT_API_BASE；CDP 等待 account.html，注册 synthetic email，读取 auth.mailer.peek() verification token，验证、登录，等待 index.html，再导航 supervision.html。保留临时 userData、loopback CDP、XJ_AGENT_ACCEPTANCE=1、XJ_NETWORK_POLICY=deny。
2. 在真实 supervision.html 收集 JSON：脚本加载顺序；拒绝确认时 AI/action-run 增量均为 0；安全确认摘要包含 label、chars/估算、truncated/estimatedChars 语义且无 raw body/messages/executor/私有句柄；确认后的 provider error/cancel 不误报成功；reduced-motion、键盘 focus、横向 overflow。至少 captureScreenshot 一张 PNG 并记录 SHA256。JSON 写入 tests/v5.2.0/artifacts/<run>/。
3. 仅合成数据；失败必须记录准确的启动、HTTP、DOM、CDP 或 renderer 错误，不得只写 page timeout。

## Validation

运行并把命令、退出码和关键输出写入同一 015 report：

- node tests/v5.2.0/015-local-electron-acceptance.cjs
- node --check tests/v5.2.0/015-local-electron-acceptance.cjs
- git diff --check -- tests/v5.2.0/015-local-electron-acceptance.cjs docs/delivery-reports/XJ-5.2.0-SUPERVISION-PRODUCTION-INTEGRATION-015.md

报告必须单列内部对抗审查（移除 auth、跳过登录、暴露 raw body、确认前调用 AI/action-run、吞掉 provider error、移除 await/focus/overflow/reduced-motion 检查时应失败或明确未覆盖），说明没有生产代码修改、提交或发布。

完成后停止写入，使用简体中文纯文本回报 [STATUS]、[ARTIFACTS]、[VALIDATION]。报告最后一行严格为：

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-SUPERVISION-PRODUCTION-INTEGRATION-015.md
