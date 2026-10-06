# Task Card: XJ-5.2.0-AGENT-SESSION-STREAM-CALLBACK-023

- task_id: XJ-5.2.0-AGENT-SESSION-STREAM-CALLBACK-023
- objective: Complete the existing XJAgent session streaming contract. Session/chat options onDelta and onReasoning must reach the existing AgentCore.runRound -> AI.send stream path before final reply, while callbacks after Session.close or terminal failure are ignored. Preserve write confirmation, history, concurrency, timeout and privacy semantics.
- owner: gpt-6.1-sol-low
- manager: codex (/root)
- project_root: D:/xinjing-electron
- branch_or_worktree: release/3.6.3-mac; shared worktree; do not switch branches or create commits
- base_commit: eb16e2b74e6ab919a782b8bc6f66bfe9524431f2
- active_release_train: 5.2.0 implementation; stage 023; not release-ready
- config_evidence_id: cfg-5.2.0-20261005-agent-session-stream-callback-023
- agent_profile_id: gpt-6.1-sol-low
- contract_id: xj-5.2.0-agent-session-stream-callback-v1
- write_lock_id: lock-5.2.0-agent-session-stream-callback-023
- benchmark_manifest: synthetic Session.onDelta/onReasoning forwarding, pre-final ordering, close/late callback suppression, timeout/failure projection, write-gate preservation v1
- visual_baseline: existing Agent surfaces; no layout or skin redesign
- prerequisites:
  - XJ-5.2.0-AGENT-API-ENTRY-WIRING-022 accepted by Codex intake
  - read-only audit confirmed AgentCore.runRound already accepts onDelta/onReasoning as parameters and forwards them to AI.send, while Agent API Session.send currently calls runRound with only four arguments
- current_target_hashes:
  - app/js/agent-api.js: 124D0135B9A0C8317ED30A6F76A2C279B6EFFBBFC7D56C8999954072C2771848
  - app/js/agent-core.js: 00F758CE37702108AF4FF9BF48C294EDCB5BC32480B6DD6AD6DFD7F7235A5AD2
  - app/js/agent-tools.js: FBD7BBF2BCA95BA025420998AB96511BB517725028ECD2FA9998A7C80A644D2B
  - app/js/xinjing-chat.js: 06978873D43A2D45F31699D6DD6CF405189D4A9521EF478F11F285E136399FA1
  - app/index.html: 2EC7092BFCC9DBCE735218F49B1CAB5E8B91B7E5328B758CF234B0E2F3546047
  - app/chat-home.html: 597CB6EABE2115C649D07D130E310ABE6836A98AEB882B1A15A039FF7E50E54A
  - app/js/clinical-agent-runtime.js: 6FF7382E33D6710992BF6DA3DCA22956EB15BD649431406FFE92899FADE6D435
  - package.json: B74E0AA8F9B645D06647096545A3C611C112EF217AABADEA407B1950D629FC72
  - package-lock.json: FDB8D11766CE697211B6C21AEE91E488ECD8E12FEAFF725C568D62906156CB03
- write_allowlist:
  - app/js/agent-api.js (Session option capture, callback forwarding and close/terminal guard only)
  - tests/v5.2.0/agent-session-stream-callback.contract.test.cjs (new behavioral contract)
  - docs/delivery-reports/XJ-5.2.0-AGENT-SESSION-STREAM-CALLBACK-023.md (new report)
- forbidden:
  - agent-core.js, agent-tools.js, xinjing-chat.js, index.html, chat-home.html, supervision and clinical-agent modules
  - package/version/build/release files, main/preload, network, real clinical data, commits, merges, pushes, signing, upload or publish
- required_behavior:
  - createSession({ onDelta, onReasoning }).send() passes safe wrapped callbacks as the fifth and sixth arguments to the existing AgentCore.runRound contract.
  - XJAgent.chat(message, options) preserves the same callback options and final result shape.
  - Delta/reasoning callbacks can arrive before final reply; callback payloads stay content-only and do not expose messages, payload, executor, lifecycle handles or raw provider errors.
  - After Session.close, terminal failure, timeout or cancellation, late delta/reasoning callbacks do not reach user handlers.
  - Existing read/write confirmation, session concurrency, history and safe failure semantics remain unchanged.
- required_tests:
  - Real VM behavior using actual app/js/agent-api.js with synthetic AgentCore.runRound that emits delta/reasoning before and after final settle.
  - Assert callback ordering, final result, close/late suppression, failure privacy and write-gate preservation.
  - Mutation-sensitive: remove fifth/sixth runRound args or remove close/terminal guard and focused tests fail.
  - Run full tests/v5.2.0/*.contract.test.cjs and controlled Electron acceptance.
- required_adversarial_tests:
  - Replace runRound with mock facade or source-string-only check: test must fail.
  - Emit callbacks after close and after rejected runRound: no user callback may fire.
  - Leak private messages/payload/error text through callback: privacy assertion must fail.
  - Bypass write confirmation while adding callback support: write-gate negative assertion must fail.
  - Ensure all asynchronous assertions await completion.
- acceptance_commands:
  - node --test tests/v5.2.0/agent-session-stream-callback.contract.test.cjs
  - node --test tests/v5.2.0/*.contract.test.cjs
  - node --check app/js/agent-api.js
  - node --check tests/v5.2.0/agent-session-stream-callback.contract.test.cjs
  - node tests/v5.2.0/015-local-electron-acceptance.cjs
  - git diff --check -- app/js/agent-api.js tests/v5.2.0/agent-session-stream-callback.contract.test.cjs docs/agent-coordination/v5.2.0/tasks/XJ-5.2.0-AGENT-SESSION-STREAM-CALLBACK-023.md docs/delivery-reports/XJ-5.2.0-AGENT-SESSION-STREAM-CALLBACK-023.md
  - Get-FileHash app/js/agent-core.js,app/js/agent-tools.js,app/js/xinjing-chat.js,app/index.html,app/chat-home.html,app/js/clinical-agent-runtime.js,package.json,package-lock.json -Algorithm SHA256
- checkpoints:
  - A: read AGENTS.md, UI references, 022 report, actual AgentCore callback signature and Session lifecycle; confirm no second writer and allowlist
  - B: focused real VM stream/late/privacy/write-gate tests pass, including mutation-sensitive removal checks
  - C: inspect exact diff, rerun full contracts and controlled Electron evidence, recompute protected hashes, complete adversarial self-review, and write report
- rollback: restore only allowlisted agent-api/test and remove this stage report; preserve 021/022 reports and all unrelated worktree changes; never reset, clean or revert unknown work
- stop_conditions:
  - need to modify AgentCore or public callback shape beyond existing runRound parameters
  - inability to prove close/terminal late suppression or privacy boundary
  - protected hash drift, second writer, allowlist drift, mock-only green or real-data/network action
- delivery_report: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-SESSION-STREAM-CALLBACK-023.md
- acceptance_owner: /root
- next_after_acceptance: only after independent Codex intake may plan the next bounded 5.2.0 stage; this stage does not mark release-ready or authorize packaging/publishing

## Agent Instructions

你是执行代理，不是最终验收人；/root 负责范围、架构、冲突协调和最终验收。你不是独自在代码库中工作，必须保留未知改动。只修改 allowlist，不得创建提交。

开始前读取 AGENTS.md、xinjing-ui-system 相关参考、022 交付报告、agent-core 真实 runRound 签名和 agent-api Session.send/close 调用链。不要改 agent-core；沿用已有第五/第六参数契约，补最小 Session 透传与 late guard。

交付前必须先做独立内部对抗审查，单列章节，记录真实 VM 入口、成功/失败/关闭/late callback、写门禁、私有字段隔离、异步等待、写集与哈希和 mock 假绿风险。报告使用简体中文，列出 [STATUS]、[ARTIFACTS]、[VALIDATION]、P0-P3、残余风险和未授权动作，最后一行严格为：

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-SESSION-STREAM-CALLBACK-023.md
