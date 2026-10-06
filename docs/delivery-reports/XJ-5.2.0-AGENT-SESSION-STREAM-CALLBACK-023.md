[STATUS] delivered；仅修改任务卡 allowlist，未改变 AgentCore、UI、数据模型或发布状态。

[ARTIFACTS]
- app/js/agent-api.js：Session 捕获 onDelta/onReasoning，安全透传 runRound 第五/六参数；流回调在 close、失败、超时和最终 settle 后统一抑制。
- tests/v5.2.0/agent-session-stream-callback.contract.test.cjs：真实 VM 合同覆盖顺序、最终结果、late callback、隐私、chat 透传和写确认门禁。

[VALIDATION]
- focused：node --test tests/v5.2.0/agent-session-stream-callback.contract.test.cjs PASS（3/3）。
- full contracts：node --test tests/v5.2.0/*.contract.test.cjs PASS（77/77）。
- syntax：node --check app/js/agent-api.js PASS。
- 真实 VM 入口使用实际 agent-api.js 与 synthetic AgentCore.runRound；未使用 mock facade 或源码字符串断言。
- 受保护文件未修改；未执行网络、真实临床数据、提交、发布或签名动作。

P0-P3：P0=0，P1=0，P2=0，P3=0。

内部对抗审查：
- 删除 runRound 第五/六参数会使 focused 合同无法收到 delta/reasoning，预期变红。
- 删除 _streamOpen/_closed 门禁会使 close、失败后的 late callback 断言变红。
- 将回调参数改为透传对象会触发 content-only 与隐私断言。
- 将 allowWrite 去除会触发 write confirmation gate 断言。
- 所有异步路径均显式 await；测试调用真实 VM 加载的生产文件。

残余风险：底层 provider 若在 Session 终态后继续持有回调引用，仍会执行包装函数但不会触达用户 handler；无可取消的底层 Promise 属于既有 runRound 语义。

未授权动作：无。

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-SESSION-STREAM-CALLBACK-023.md
