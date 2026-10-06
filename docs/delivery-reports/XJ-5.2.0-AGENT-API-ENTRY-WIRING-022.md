# XJ-5.2.0-AGENT-API-ENTRY-WIRING-022

[STATUS] delivered；仅将现有 XJAgent facade 接入 index.html 与 chat-home.html，未改变 agent-api 或其他生产模块。

[ARTIFACTS]
- app/index.html：在 agent-tools.js、agent-core.js 之后加入一次 agent-api.js。
- app/chat-home.html：在 agent-tools.js、agent-core.js 之后加入一次 agent-api.js。
- tests/v5.2.0/agent-api-entry-wiring.contract.test.cjs：真实 HTML 顺序解析、真实 agent-api VM 行为、读写门禁、session close 与安全失败投影契约。
- 本报告。

[VALIDATION]
- node --test tests/v5.2.0/agent-api-entry-wiring.contract.test.cjs：3/3 PASS。
- node --test tests/v5.2.0/*.contract.test.cjs：74/74 PASS。
- node --check app/js/agent-api.js：PASS。
- node --check tests/v5.2.0/agent-api-entry-wiring.contract.test.cjs：PASS。
- node tests/v5.2.0/015-local-electron-acceptance.cjs：SUPERVISION_STATUS=PASS。
- git diff --check（allowlist）：PASS；仅有既存 HTML 行尾转换警告。
- 保护文件 SHA-256 与任务卡一致：agent-api 124D0135...771848、agent-core 00F758CE...5A5AD2、agent-tools FBD7BBF2...44D2B、xinjing-chat 06978873...399FA1、clinical-agent-runtime 6FF7382...6D435、clinical-agent-adapter 7D7E0D1...4CC4D、clinical-agent-production-bridge 46F13F0...5DA276、supervision.html 4404F4A...5A2EBD、package B74E0AA...9FC72、lock FDB8D11...6CB03。
- 证据等级：formal local contract + controlled Electron acceptance；仅使用合成数据，未访问网络或真实临床资料。

P0-P3：P0=0，P1=0，P2=0，P3=0。

## 内部对抗审查

- 真实入口：测试解析两份真实 HTML，并在 VM 中执行真实 app/js/agent-api.js；未用 mock facade 替代。
- 正向/失败路径：读工具无需确认；写工具默认拒绝，显式 allowWrite 与 writeGuard 才可执行；未知工具和 guard 异常均 fail-closed。
- session 生命周期：create/send/close 后再次 send 被拒绝；异步 Promise 均显式 await。
- 隐私投影：失败结果不含 executor、payload 等私有字段，也不泄露 guard 异常私密消息。
- 反向变异：删除任一 script 或将 API 移到依赖前会使顺序断言失败；将 AgentTools.invoke 缺失会使真实 facade 行为断言失败；绕过写门禁或暴露私有字段会使负向断言失败。
- 写集与保护哈希：仅 allowlist 四文件新增/修改；保护文件哈希复算一致。

残余风险：页面脚本仍依赖既有 AgentCore/AgentTools 初始化契约；本阶段未改变其内部行为。HTML 行尾由工作树现状保持，git 仅提示未来触碰时可能统一为 LF。

未授权动作：无。未执行 commit、merge、push、sign、upload、publish、网络请求或真实数据操作。

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-API-ENTRY-WIRING-022.md
