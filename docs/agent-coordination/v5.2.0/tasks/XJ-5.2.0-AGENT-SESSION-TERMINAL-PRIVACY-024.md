# Task Card: XJ-5.2.0-AGENT-SESSION-TERMINAL-PRIVACY-024

- task_id: XJ-5.2.0-AGENT-SESSION-TERMINAL-PRIVACY-024
- objective: Repair the accepted XJAgent Session terminal-boundary contract. A runRound failure currently returns the raw result.error through Session.send, and terminal onEvent/onConfirm wrappers only guard _closed; late events or confirmations after final settle, provider failure, timeout, or cancellation can still reach user handlers. Normalize terminal model failures to a stable user-safe error, and suppress all late onEvent/onConfirm/onDelta/onReasoning callbacks without changing AgentCore or page contracts.
- owner: gpt-6.1-sol-low
- manager: codex (/root)
- project_root: D:/xinjing-electron
- branch_or_worktree: release/3.6.3-mac; shared worktree; do not switch branches or create commits
- base_commit: eb16e2b74e6ab919a782b8bc6f66bfe9524431f2
- active_release_train: 5.2.0 implementation; stage 024; not release-ready
- config_evidence_id: cfg-5.2.0-20261005-agent-session-terminal-privacy-024
- agent_profile_id: gpt-6.1-sol-low
- contract_id: xj-5.2.0-agent-session-terminal-boundary-v1
- write_lock_id: lock-5.2.0-agent-session-terminal-privacy-024
- benchmark_manifest: synthetic Session terminal failure privacy, late event/confirm suppression, timeout/close/cancel guard, content-only stream callbacks, write-confirmation preservation v1
- visual_baseline: existing Agent surfaces; no layout or skin redesign
- prerequisites:
  - XJ-5.2.0-AGENT-API-ENTRY-WIRING-022 accepted by Codex intake
  - XJ-5.2.0-AGENT-SESSION-STREAM-CALLBACK-023 independently verified for stream forwarding and late delta/reasoning suppression; 023 privacy assertion is known to be insufficient and must be corrected in this stage
- current_target_hashes:
  - app/js/agent-api.js: 444284882D5E31BEE4A967DDB2589ECF1C45AD4208F45283E9315877CBEDF7F9
  - app/js/agent-core.js: 00F758CE37702108AF4FF9BF48C294EDCB5BC32480B6DD6AD6DFD7F7235A5AD2
  - app/js/agent-tools.js: FBD7BBF2BCA95BA025420998AB96511BB517725028ECD2FA9998A7C80A644D2B
  - app/js/xinjing-chat.js: 06978873D43A2D45F31699D6DD6CF405189D4A9521EF478F11F285E136399FA1
  - app/index.html: 2EC7092BFCC9DBCE735218F49B1CAB5E8B91B7E5328B758CF234B0E2F3546047
  - app/chat-home.html: 597CB6EABE2115C649D07D130E310ABE6836A98AEB882B1A15A039FF7E50E54A
  - app/js/clinical-agent-runtime.js: 6FF7382E33D6710992BF6DA3DCA22956EB15BD649431406FFE92899FADE6D435
  - package.json: B74E0AA8F9B645D06647096545A3C611C112EF217AABADEA407B1950D629FC72
  - package-lock.json: FDB8D11766CE697211B6C21AEE91E488ECD8E12FEAFF725C568D62906156CB03
- write_allowlist:
  - app/js/agent-api.js (Session terminal guards and safe failure projection only)
  - tests/v5.2.0/agent-session-stream-callback.contract.test.cjs (correct privacy assertion and add terminal event/confirm/timeout/cancel regressions)
  - docs/delivery-reports/XJ-5.2.0-AGENT-SESSION-TERMINAL-PRIVACY-024.md
- forbidden:
  - agent-core.js, agent-tools.js, xinjing-chat.js, index.html, chat-home.html, supervision and clinical-agent modules
  - package/version/build/release files, main/preload, network, real clinical data, commits, merges, pushes, signing, upload or publish
- required_behavior:
  - Session.send result.error and thrown provider errors never expose raw provider text, secrets, payloads, or private error objects; return a stable MODEL_ERROR/user-safe message and preserve the error code. onError receives only the same safe message.
  - A per-send terminal gate opens before runRound and closes exactly once on final success, resolved failure, rejection, timeout, cancellation, close, or synchronous throw.
  - onEvent and onConfirm wrappers must no-op/reject after the gate closes or while Session is closed; late tool confirmation must not call user onConfirm or execute a write.
  - Existing onDelta/onReasoning content-only semantics and late suppression remain intact.
  - Existing write confirmation, history, concurrency, timeout, chat final result, and availability semantics remain unchanged.
- required_tests:
  - Real VM loading of app/js/agent-api.js with synthetic AgentCore.runRound; no mock facade and no source-string-only assertions.
  - Provider failure with a unique secret asserts the final result, onError, and callback/event observations do not contain that secret.
  - Emit onEvent and invoke onConfirm after final success, resolved failure, rejected runRound, timeout, and Session.close; user handlers must observe no late event/confirmation and write confirmation count remains zero.
  - Positive pre-terminal onEvent/onConfirm behavior remains covered; content-only delta/reasoning and chat forwarding remain covered.
  - Mutation-sensitive removal of the terminal gate, raw error normalization, or wrapper checks makes focused tests fail.
  - All asynchronous branches are awaited; test actually loads the production file.
- required_adversarial_review:
  - Delete terminal gate checks; late event/confirm tests must turn red.
  - Restore raw result.error in errObj/onError; secret assertion must turn red.
  - Call onConfirm before the terminal gate opens; positive confirmation path must remain valid and no false rejection may be introduced.
  - Remove allowWrite from the failure fixture; test must still prove the write gate rather than pass by denial.
  - Replace production VM load with a facade mock or remove await; focused tests must fail or be marked blocked.
- acceptance_commands:
  - node --test tests/v5.2.0/agent-session-stream-callback.contract.test.cjs
  - node --test tests/v5.2.0/*.contract.test.cjs
  - node --check app/js/agent-api.js
  - node --check tests/v5.2.0/agent-session-stream-callback.contract.test.cjs
  - node tests/v5.2.0/015-local-electron-acceptance.cjs
  - git diff --check -- app/js/agent-api.js tests/v5.2.0/agent-session-stream-callback.contract.test.cjs docs/delivery-reports/XJ-5.2.0-AGENT-SESSION-TERMINAL-PRIVACY-024.md
  - Get-FileHash app/js/agent-core.js,app/js/agent-tools.js,app/js/xinjing-chat.js,app/index.html,app/chat-home.html,app/js/clinical-agent-runtime.js,package.json,package-lock.json -Algorithm SHA256
- checkpoints:
  - A: read AGENTS.md, this card, 022/023 reports, actual Session.send/close and AgentCore callback shapes; confirm no second writer and recompute protected hashes
  - B: focused real VM privacy and terminal-late tests pass before broad regression
  - C: inspect exact allowlist diff, rerun full contracts and controlled Electron, recompute hashes, and complete independent adversarial review before delivery
- rollback: restore only the allowlisted agent-api/test files to the 024 baseline and remove this report; preserve 022/023 evidence and unrelated worktree changes; never reset, clean or revert unknown work
- stop_conditions:
  - need to modify AgentCore or public callback shape beyond existing runRound parameters
  - inability to prove raw-error suppression or terminal late-event/confirm suppression
  - protected hash drift, second writer, allowlist drift, mock-only green, or any real-data/network action
- delivery_report: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-SESSION-TERMINAL-PRIVACY-024.md
- acceptance_owner: /root
- next_after_acceptance: only after independent Codex intake may plan the next bounded 5.2.0 stage; this stage does not mark release-ready or authorize packaging/publishing

## Agent Instructions

你是执行代理，不是最终验收人；/root 负责范围、架构、冲突协调和最终验收。你不是独自在代码库中工作，必须保留未知改动。只修改 allowlist，不得创建提交。开始前先读 AGENTS.md、022/023 交付报告和真实源码，确认共享工作树中没有第二个 active writer。

交付前必须先做独立内部对抗审查，单列章节，记录真实 VM 入口、成功/失败/关闭/超时/取消/late event/confirm、隐私边界、写门禁、异步等待、写集与保护哈希和 mock 假绿风险。报告使用简体中文，列出 [STATUS]、[ARTIFACTS]、[VALIDATION]、P0-P3、残余风险和未授权动作，最后一行严格为：

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-SESSION-TERMINAL-PRIVACY-024.md
