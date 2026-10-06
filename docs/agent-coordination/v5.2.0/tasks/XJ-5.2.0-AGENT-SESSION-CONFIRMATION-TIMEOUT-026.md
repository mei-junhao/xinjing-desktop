# Task Card: XJ-5.2.0-AGENT-SESSION-CONFIRMATION-TIMEOUT-026

- task_id: XJ-5.2.0-AGENT-SESSION-CONFIRMATION-TIMEOUT-026
- objective: Close the remaining XJAgent Session confirmation race after stage 025. When the current send reaches its terminal timeout or other terminal failure while a write-tool onConfirm or fallback writeGuard Promise is pending, a later `{ok:true}` must not authorize the write. Bind confirmation completion to the per-send terminal gate, while preserving close-before-resolution protection, pre-terminal positive confirmation, existing public API shapes, safe errors, stream callbacks, history and concurrency.
- owner: gpt-6.1-sol-low
- manager: codex (/root)
- project_root: D:/xinjing-electron
- branch_or_worktree: release/3.6.3-mac; shared worktree; do not switch branches or create commits
- base_commit: eb16e2b74e6ab919a782b8bc6f66bfe9524431f2
- active_release_train: 5.2.0 implementation; stage 026; not release-ready
- config_evidence_id: cfg-5.2.0-20261005-agent-session-confirmation-timeout-026
- agent_profile_id: gpt-6.1-sol-low
- contract_id: xj-5.2.0-agent-session-confirmation-timeout-v1
- write_lock_id: lock-5.2.0-agent-session-confirmation-timeout-026
- benchmark_manifest: synthetic shortened Session timeout, pending onConfirm/writeGuard, late-success write suppression, pre-terminal positive confirmation and 025 close-race regression v1
- visual_baseline: existing Agent surfaces; no layout or skin redesign
- prerequisites:
  - XJ-5.2.0-AGENT-SESSION-CONFIRMATION-RACE-025 independently accepted by Codex intake
  - read-only VM probe with a shortened setTimeout reproduced: send returns safe MODEL_ERROR after terminal timeout, then pending onConfirm resolves `{ok:true}` and synthetic AgentCore observes writeExecuted=1
- current_target_hashes:
  - app/js/agent-api.js: B83E44840CF217E4976E90CEC95BC1B73F196CBE01643EE013E4C259AE7F7AA2
  - app/js/agent-core.js: 00F758CE37702108AF4FF9BF48C294EDCB5BC32480B6DD6AD6DFD7F7235A5AD2
  - app/js/agent-tools.js: FBD7BBF2BCA95BA025420998AB96511BB517725028ECD2FA9998A7C80A644D2B
  - app/js/xinjing-chat.js: 06978873D43A2D45F31699D6DD6CF405189D4A9521EF478F11F285E136399FA1
  - app/index.html: 2EC7092BFCC9DBCE735218F49B1CAB5E8B91B7E5328B758CF234B0E2F3546047
  - app/chat-home.html: 597CB6EABE2115C649D07D130E310ABE6836A98AEB882B1A15A039FF7E50E54A
  - app/js/clinical-agent-runtime.js: 6FF7382E33D6710992BF6DA3DCA22956EB15BD649431406FFE92899FADE6D435
  - package.json: B74E0AA8F9B645D06647096545A3C611C112EF217AABADEA407B1950D629FC72
  - package-lock.json: FDB8D11766CE697211B6C21AEE91E488ECD8E12FEAFF725C568D62906156CB03
- write_allowlist:
  - app/js/agent-api.js (bind confirmation/guard completion to the current send terminal gate only)
  - tests/v5.2.0/agent-session-stream-callback.contract.test.cjs (add shortened-timeout race regressions only)
  - docs/delivery-reports/XJ-5.2.0-AGENT-SESSION-CONFIRMATION-TIMEOUT-026.md
- forbidden:
  - agent-core.js, agent-tools.js, xinjing-chat.js, index.html, chat-home.html, supervision and clinical-agent modules
  - package/version/build/release files, main/preload, network, real clinical data, commits, merges, pushes, signing, upload or publish
- required_behavior:
  - A pre-terminal write confirmation remains allowed: if onConfirm resolves before the send terminal gate closes, the synthetic write path may execute.
  - If the current send times out or otherwise enters terminal failure while session onConfirm is pending, a later `{ok:true}` must resolve fail-closed and synthetic AgentCore must not execute the write handler.
  - The same per-send terminal check applies to the fallback global writeGuard path. It must not rely only on Session._closed.
  - Existing Session.close-after-await race protections from 025 remain green. Late event/delta/reasoning and safe provider error behavior remain unchanged.
  - Direct internal helper compatibility may be preserved, but the real AgentCore -> onConfirm wrapper path must be terminal-gated.
- required_tests:
  - Real VM loads production app/js/agent-api.js. Use a synthetic VM timer wrapper that shortens only the 5-minute session timeout to a few milliseconds; do not wait five minutes and do not claim a real-timeout duration beyond the terminal-boundary behavior.
  - Pending session onConfirm: start send, let the shortened timeout settle it, assert safe failure, then resolve `{ok:true}` and assert synthetic AgentCore/write handler was never authorized.
  - Pending fallback writeGuard: same timeout-before-resolution assertion with no session onConfirm.
  - Positive pre-terminal confirmation remains green.
  - Existing 024/025 close, privacy, stream and late-callback tests remain green; all asynchronous assertions await completion.
  - Mutation-sensitive removal of the per-send terminal check makes both timeout race tests fail.
- required_adversarial_review:
  - Resolve before timeout: positive write path must remain allowed.
  - Resolve after shortened timeout: write handler call count must remain zero.
  - Check only `_closed` and remove per-send gate: timeout race must turn red.
  - Exercise close-after-await, confirmation timeout/rejection, unknown tool and allowWrite=false; no raw private state or provider error leakage.
  - Replace production VM load with a facade mock or omit await; mark FAIL/BLOCKED if the race can still pass.
- acceptance_commands:
  - node --test tests/v5.2.0/agent-session-stream-callback.contract.test.cjs
  - node --test tests/v5.2.0/*.contract.test.cjs
  - node --check app/js/agent-api.js
  - node --check tests/v5.2.0/agent-session-stream-callback.contract.test.cjs
  - node tests/v5.2.0/015-local-electron-acceptance.cjs
  - git diff --check -- app/js/agent-api.js tests/v5.2.0/agent-session-stream-callback.contract.test.cjs docs/delivery-reports/XJ-5.2.0-AGENT-SESSION-CONFIRMATION-TIMEOUT-026.md
  - Get-FileHash app/js/agent-core.js,app/js/agent-tools.js,app/js/xinjing-chat.js,app/index.html,app/chat-home.html,app/js/clinical-agent-runtime.js,package.json,package-lock.json -Algorithm SHA256
- checkpoints:
  - A: read AGENTS.md, 025 report, real Session send/confirm code and reproduce the shortened-timeout probe; recompute protected hashes
  - B: focused positive/negative timeout race tests pass before broad regression
  - C: inspect exact allowlist diff, rerun full contracts and controlled Electron, recompute hashes, and complete adversarial self-review before delivery
- rollback: restore only the allowlisted agent-api/test files to the 026 baseline and remove this report; preserve 025 evidence and unrelated worktree changes; never reset, clean or revert unknown work
- stop_conditions:
  - need to modify AgentCore, AgentTools, UI, page, persistence or public callback shape
  - inability to prove no write handler after terminal timeout-before-resolution
  - protected hash drift, second writer, allowlist drift, mock-only green, or any real-data/network action
- delivery_report: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-SESSION-CONFIRMATION-TIMEOUT-026.md
- acceptance_owner: /root
- next_after_acceptance: only after independent Codex intake may plan the next bounded 5.2.0 stage; this stage does not mark release-ready or authorize packaging/publishing

## Agent Instructions

你是执行代理，不是最终验收人；/root 负责范围、架构、冲突协调和最终验收。你不是独自在代码库中工作，必须保留未知改动。只修改 allowlist，不得创建提交。开始前读 AGENTS.md、025 报告与真实源码，先复现缩短 timeout 后挂起确认仍执行写动作的探针。

交付前必须做独立内部对抗审查，单列章节，记录真实 VM 入口、超时前正向确认、超时后 onConfirm 与 fallback writeGuard 迟到结果、write handler 调用计数、异步等待、缩短计时器证据边界、写集、保护哈希和 mock 假绿风险。报告用简体中文，列出 [STATUS]、[ARTIFACTS]、[VALIDATION]、P0-P3、残余风险和未授权动作，末行严格为：

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-SESSION-CONFIRMATION-TIMEOUT-026.md
