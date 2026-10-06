# XJ-5.2.0-AGENT-SESSION-TIMEOUT-CODE-027

[STATUS] delivered; allowlist only.

[ARTIFACTS]
- app/js/agent-api.js：识别 withTimeout 的 errObj，保留 MODEL_TIMEOUT 与安全文案。
- tests/v5.2.0/agent-session-stream-callback.contract.test.cjs：恢复两条 shortened-timeout code/安全文案断言。

[VALIDATION]
- 真实生产 VM 入口复现并修复 errObj 形状；026 报告真实路径为 docs/delivery-reports/XJ-5.2.0-AGENT-SESSION-CONFIRMATION-TIMEOUT-026.md。
- focused contract 10/10 PASS；全量 v5.2.0 contracts 84/84 PASS；node checks、diff check、controlled Electron 均通过，SUPERVISION_STATUS=PASS。
- 保护文件 SHA-256 与任务卡基线一致；未发生保护文件漂移。

[P0-P3]
- P0=0，P1=0，P2=0，P3=0。

## 内部对抗审查
- 使用真实生产 VM，未使用 facade 或源码字符串断言。
- errObj timeout 保留 code=MODEL_TIMEOUT；provider raw message 不泄露。
- 超时前确认仍通过；超时后 onConfirm 与 fallback writeGuard 的 writeExecuted 均为 0。
- 删除 errObj 分支、恢复 raw 文案或删除 terminal gate 均会使对应断言失败；所有异步分支均 await。

残余风险：provider Promise 不可取消，但 terminal gate 阻止迟到授权和写入。

[未授权动作]
- 未执行 commit、merge、push、sign、package、upload、publish、网络访问或真实临床数据操作。

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-SESSION-TIMEOUT-CODE-027.md
