# XJ-5.2.0-AGENT-SESSION-TERMINAL-PRIVACY-024

[STATUS] delivered；仅修改任务卡 allowlist，未提交、合并、发布或触碰保护文件。

[ARTIFACTS]
- app/js/agent-api.js：每次 send 增加 terminal gate；终态后抑制 event/confirm/delta/reasoning；provider 错误统一安全投影并保留错误码，raw timeout 也映射为稳定文案。
- tests/v5.2.0/agent-session-stream-callback.contract.test.cjs：真实 VM 覆盖成功、失败、close 期间 pending runRound、timeout-shaped terminal rejection、late event/confirm/delta/reasoning、正向确认、隐私和 content-only 回调。

[VALIDATION]
- focused contract：6/6 PASS。
- full contracts：80/80 PASS。
- node check、git diff --check：PASS。
- controlled Electron：SUPERVISION_STATUS=PASS。
- 保护文件 SHA-256 与任务卡一致：agent-core 00F758CE...5A5AD2、agent-tools FBD7BBF2...44D2B、xinjing-chat 06978873...399FA1、index 2EC7092B...6047、chat-home 597CB6EA...0E54A、clinical-agent-runtime 6FF7382E...6D435、package B74E0AA...9FC72、lock FDB8D11...6CB03。

P0-P3：P0=0，P1=0，P2=0，P3=0。

## 内部对抗审查

- 真实入口：VM 加载生产 agent-api.js，使用 synthetic AgentCore.runRound；未使用 facade mock 或源码字符串断言。
- late event/confirm/delta/reasoning 在成功和 provider failure 后均被抑制；close/timeout/rejection 受 gate 与 closed 检查保护。
- 新增真实 close 证据：pending runRound 期间调用 close 后，四类 late callback 均不到达，随后释放 synthetic Promise 并 await send 完成。
- 新增 timeout 边界证据：synthetic MODEL_TIMEOUT rejection 作为 timeout-shaped terminal path，验证终态 gate 对四类 late callback 的抑制；不宣称驱动五分钟真实计时器。
- timeout 原文和唯一 secret 均不出现在 result 或 onError；所有 raw timeout 均映射为“操作超时”，MODEL_TIMEOUT code 保留。
- terminal gate 打开后 onEvent 与 onConfirm 仍可用，allowWrite=true 的确认路径通过；失败后确认计数为零。
- 所有异步分支均 await；受控 Electron 真实执行通过。
- 仅 allowlist 文件写入；未执行网络、真实临床数据、commit、merge、push、sign、upload、publish。

残余风险：底层 provider 仍可能调用包装函数，但终态 gate 确保不会触达用户 handler；底层 Promise 不可取消属于既有语义。

未授权动作：无。

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-SESSION-TERMINAL-PRIVACY-024.md
