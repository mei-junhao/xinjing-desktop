# XJ-5.2.0-SUPERVISION-STREAM-CALLBACK-021

[STATUS] delivered；仅完成标准督导 Runtime 到 AI.send 的 onDelta 透传，未改变数据模型、权益、UI 或发布状态。

[ARTIFACTS]
- `app/js/clinical-agent-runtime.js`：Runtime.execute 将受控 onDelta 转发给 Adapter.execute；最终 settle、取消、超时后抑制 late callback。
- `tests/v5.2.0/clinical-agent-runtime.contract.test.cjs`：真实 Runtime→Adapter→executor→AI.send 行为契约，覆盖完成前 delta、隐私投影、取消/late-delta。
- 本报告。

[VALIDATION]
- `node --test tests/v5.2.0/clinical-agent-runtime.contract.test.cjs`：9/9 PASS。
- `node --test tests/v5.2.0/*.contract.test.cjs`：71/71 PASS。
- `node --check app/js/clinical-agent-runtime.js`：PASS。
- `node --check tests/v5.2.0/clinical-agent-runtime.contract.test.cjs`：PASS。
- `node tests/v5.2.0/015-local-electron-acceptance.cjs`：`SUPERVISION_STATUS=PASS`。
- `git diff --check`（allowlist）：PASS。
- 保护文件 SHA-256 与任务卡一致：adapter `7D7E0D...64CC4D`、production bridge `46F13D...5DA276`、supervision.html `4404F4...5A2EBD8`、clinical-context `095360...C1B64`、store `00473C...77504A7`、ai `8900E0...FC69`、package `B74E0A...9FC72`、lock `FDB8D1...56CB03`。
- 证据等级：formal local contract + controlled Electron acceptance；使用合成数据，未访问网络或真实临床资料。

P0-P3：P0=0，P1=0，P2=0，P3=0。

## 内部对抗审查

- 真实入口：测试通过 `Runtime.fromGlobals`、真实 adapter factory、executor 和 `AI.send`，未使用 mock-only shortcut。
- 正向路径：provider 通过 `meta.onDelta` 发出 partial，UI callback 在最终 draft-ready 前收到；final callback 不被误当作有效 UI delta。
- 取消/late-delta：取消后 provider callback 被触发，结果为 `ai-cancelled` 且 UI delta 数组保持为空。
- 隐私：callback 仅接收安全 content projection；结果不包含 providerSecret、messages、payload、executor 或 lifecycle handle。
- 反向变异：删除 Runtime 到 Adapter 的 `onDelta` 透传时，新增 focused contract 的 `ui:partial` 断言失败；将 callback 延后到 settle 后也无法满足顺序断言。
- 异步等待：测试显式 await execute Promise，并在取消场景 await pending；无源码字符串匹配作为唯一证据。
- 写集/保护哈希：仅 allowlist 三文件变更；保护文件哈希复算一致。

残余风险：AI provider 自身若违反既有安全 content contract，仍由 `AI.send`/executor 的现有投影边界负责；本阶段未修改该边界。

未授权动作：无。未执行 commit、merge、push、sign、upload、publish 或真实数据/网络操作。

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-SUPERVISION-STREAM-CALLBACK-021.md
