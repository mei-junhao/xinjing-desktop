# XJ-5.1.9 Codex Intake 003

## 结论

002 交付报告与本地证据已复核。Z1-Z6、Z8-Z11、Z13 及 PII MVP 归类为 confirmed；旧候选聚合 SHA `3DA5E8EC...` 在本轮源码变更后标记 stale，不复用。

## 本轮接纳补丁

- `main.js`：验收/健康探针模式仅允许显式回环 HTTP 账号地址；默认生产账号地址 fail-closed。Window 菜单 Minimize/Close 改为中文标签。
- `app/js/app.js`：侧栏初始 `aria-expanded` 与已保存折叠状态同步。
- P-3 服务器模型偏好：当前仓库及既有生产目录仅提供服务器模型目录和价格，没有账号偏好读写端点。未伪造客户端接口，保留本地 durable 镜像；该项仍为 incomplete/P2，需服务端契约与远程部署后再收口。

## 验证

- `node scripts/pii-sanitizer.test.js`：14/14 PASS。
- `node scripts/v5.1.9-tests/XJ-5.1.9-full-ui-audit-mvp-fix-002/unit-contracts.test.js`：14/14 PASS。
- `node scripts/v5.1.9-tests/XJ-5.1.9-full-ui-audit-mvp-fix-002/run-acceptance.js`：14/14 PASS，真实 Electron、临时 userData、回环账号服务。
- `node --check main.js`、`node --check app/js/app.js`：PASS。
- `git diff --check`：0 problems。

## 发布前未完成

P-3 服务器账号模型偏好跨设备回显未完成；本轮不修改远程服务器。其余发布链将在新候选冻结后执行，旧 5.1.9 候选不再有效。

DELIVERY_REPORT: D:/xinjing-electron/qa/agent-reviews/XJ-5.1.9-codex-intake-003.md
