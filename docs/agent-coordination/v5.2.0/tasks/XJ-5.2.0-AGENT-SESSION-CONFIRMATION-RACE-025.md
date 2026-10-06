# Task Card: XJ-5.2.0-AGENT-SESSION-CONFIRMATION-RACE-025

- task_id: XJ-5.2.0-AGENT-SESSION-CONFIRMATION-RACE-025
- objective: Close the XJAgent Session write-confirmation race found after stage 024. If Session.close() occurs while a write-tool confirmation or fallback writeGuard Promise is pending, a late `{ ok: true }` must not authorize the tool or let AgentCore continue into the write handler. Preserve pre-close confirmation behavior, terminal stream/event gates, safe errors, history, concurrency and existing API shapes.
- owner: gpt-6.1-sol-low
- manager: codex (/root)
- project_root: D:/xinjing-electron
- branch_or_worktree: release/3.6.3-mac; shared worktree; do not switch branches or create commits
- base_commit: eb16e2b74e6ab919a782b8bc6f66bfe9524431f2
- active_release_train: 5.2.0 implementation; stage 025; not release-ready
- config_evidence_id: cfg-5.2.0-20261005-agent-session-confirmation-race-025
- agent_profile_id: gpt-6.1-sol-low
- contract_id: xj-5.2.0-agent-session-confirmation-race-v1
- write_lock_id: lock-5.2.0-agent-session-confirmation-race-025
- benchmark_manifest: synthetic pending onConfirm/onWriteGuard, close-before-resolution, write-handler non-execution, pre-close positive confirmation, terminal stream regression v1
- visual_baseline: existing Agent surfaces; no layout or skin redesign
- prerequisites:
  - XJ-5.2.0-AGENT-SESSION-TERMINAL-PRIVACY-024 independently accepted by Codex intake
  - read-only VM probe reproduced: close() while onConfirm is pending, then resolve `{ok:true}`; synthetic AgentCore observed decision ok=true and continued to write-executed
- current_target_hashes:
  - app/js/agent-api.js: 736FDF914C04B6447DBF177CD7F2B26E32B8A4162C69B52240963CE1362E4F17
  - app/js/agent-core.js: 00F758CE37702108AF4FF9BF48C294EDCB5BC32480B6DD6AD6DFD7F7235A5AD2
  - app/js/agent-tools.js: FBD7BBF2BCA95BA025420998AB96511BB517725028ECD2FA9998A7C80A644D2B
  - app/js/xinjing-chat.js: 06978873D43A2D45F31699D6DD6CF405189D4A9521EF478F11F285E136399FA1
  - app/index.html: 2EC7092BFCC9DBCE735218F49B1CAB5E8B91B7E5328B758CF234B0E2F3546047
  - app/chat-home.html: 597CB6EABE2115C649D07D130E310ABE6836A98AEB882B1A15A039FF7E50E54A
  - app/js/clinical-agent-runtime.js: 6FF7382E33D6710992BF6DA3DCA22956EB15BD649431406FFE92899FADE6D435
  - package.json: B74E0AA8F9B645D06647096545A3C611C112EF217AABADEA407B1950D629FC72
  - package-lock.json: FDB8D11766CE697211B6C21AEE91E488ECD8E12FEAFF725C568D62906156CB03
- write_allowlist:
  - app/js/agent-api.js (Session confirmation terminal check only)
  - tests/v5.2.0/agent-session-stream-callback.contract.test.cjs (add real VM race regressions only)
  - docs/delivery-reports/XJ-5.2.0-AGENT-SESSION-CONFIRMATION-RACE-025.md
- forbidden:
  - agent-core.js, agent-tools.js, xinjing-chat.js, index.html, chat-home.html, supervision and clinical-agent modules
  - package/version/build/release files, main/preload, network, real clinical data, commits, merges, pushes, signing, upload or publish
- required_behavior:
  - A write confirmation invoked before close may resolve normally and authorize the write while the session/send remains live.
  - If Session.close() occurs while session `onConfirm` is awaiting, any later `{ok:true}` must resolve as `{ok:false}` (or equivalent fail-closed decision); synthetic AgentCore must not execute the write handler.
  - The same close-after-await guard applies to the fallback global writeGuard path when no session onConfirm is provided.
  - A late confirmation invocation after terminal gate closure remains rejected, as established in 024.
  - Existing schema, injection, allowWrite, confirmation timeout, safe error, history, stream and chat behavior remain unchanged.
- required_tests:
  - Real VM loads production app/js/agent-api.js with synthetic AgentCore and write registry.
  - Pending session onConfirm: start send, wait until confirmation starts, close session, resolve `{ok:true}`, assert AgentCore decision is not ok and `write-executed` never occurs.
  - Pending fallback writeGuard: same close-before-resolution assertion, with no session onConfirm and a global guard Promise.
  - Positive pre-close confirmation still returns ok and permits the synthetic write path.
  - Existing 024 stream/privacy/late tests remain green; all async branches are awaited.
  - Mutation-sensitive removal of the post-await closed/terminal check makes the focused race test fail.
- required_adversarial_review:
  - Resolve confirmation before close: positive path must stay green.
  - Resolve `{ok:true}` after close: write handler must remain uncalled.
  - Remove the post-await check or check only at invocation: race test must turn red.
  - Exercise fallback writeGuard, confirmation timeout/rejection, unknown tool and allowWrite=false; no bypass or raw private state.
  - Replace production VM load with a facade mock or omit await; mark FAIL/BLOCKED if the race can still pass.
- acceptance_commands:
  - node --test tests/v5.2.0/agent-session-stream-callback.contract.test.cjs
  - node --test tests/v5.2.0/*.contract.test.cjs
  - node --check app/js/agent-api.js
  - node --check tests/v5.2.0/agent-session-stream-callback.contract.test.cjs
  - node tests/v5.2.0/015-local-electron-acceptance.cjs
  - git diff --check -- app/js/agent-api.js tests/v5.2.0/agent-session-stream-callback.contract.test.cjs docs/delivery-reports/XJ-5.2.0-AGENT-SESSION-CONFIRMATION-RACE-025.md
  - Get-FileHash app/js/agent-core.js,app/js/agent-tools.js,app/js/xinjing-chat.js,app/index.html,app/chat-home.html,app/js/clinical-agent-runtime.js,package.json,package-lock.json -Algorithm SHA256
- checkpoints:
  - A: read AGENTS.md, 024 report, real Session confirmation code and reproduce the close-before-resolution probe; recompute protected hashes
  - B: focused positive/negative race tests pass before broad regression
  - C: inspect exact allowlist diff, rerun full contracts and controlled Electron, recompute hashes, and complete adversarial self-review before delivery
- rollback: restore only the allowlisted agent-api/test files to the 025 baseline and remove this report; preserve 024 evidence and unrelated worktree changes; never reset, clean or revert unknown work
- stop_conditions:
  - need to modify AgentCore, AgentTools, UI, page, persistence or public callback shape
  - inability to prove no write handler after close-before-resolution
  - protected hash drift, second writer, allowlist drift, mock-only green, or any real-data/network action
- delivery_report: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-SESSION-CONFIRMATION-RACE-025.md
- acceptance_owner: /root
- next_after_acceptance: only after independent Codex intake may plan the next bounded 5.2.0 stage; this stage does not mark release-ready or authorize packaging/publishing

## Agent Instructions

你是执行代理，不是最终验收人；/root 负责范围、架构、冲突协调和最终验收。你不是独自在代码库中工作，必须保留未知改动。只修改 allowlist，不得创建提交。开始前读 AGENTS.md、024 报告与真实源码，先复现关闭期间挂起确认返回 `{ok:true}` 仍执行写动作的探针。

交付前必须做独立内部对抗审查，单列章节，记录真实 VM 入口、关闭前正向确认、关闭后 onConfirm 与 fallback writeGuard 迟到结果、write handler 调用计数、异步等待、写集、保护哈希和 mock 假绿风险。报告用简体中文，列出 [STATUS]、[ARTIFACTS]、[VALIDATION]、P0-P3、残余风险和未授权动作，末行严格为：

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-SESSION-CONFIRMATION-RACE-025.md
