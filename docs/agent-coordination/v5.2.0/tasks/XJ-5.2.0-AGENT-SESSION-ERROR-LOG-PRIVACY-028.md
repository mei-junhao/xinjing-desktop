# Task Card: XJ-5.2.0-AGENT-SESSION-ERROR-LOG-PRIVACY-028

- task_id: XJ-5.2.0-AGENT-SESSION-ERROR-LOG-PRIVACY-028
- objective: Close the provider-error privacy leak found after stage 027. Session.send() currently returns a safe error but logs the provider-supplied raw message in console.error for known code/message rejections. Make the known-error log safe without changing public result/error-code semantics, the stage-026/027 terminal and timeout gates, or successful/pre-terminal behavior.
- owner: gpt-6.1-sol-low
- manager: codex (/root)
- project_root: D:/xinjing-electron
- branch_or_worktree: release/3.6.3-mac; shared working tree; do not switch branches, create a worktree, or create commits
- base_commit: eb16e2b74e6ab919a782b8bc6f66bfe9524431f2
- active_release_train: 5.2.0 implementation; stage 028; not release-ready
- config_evidence_id: cfg-5.2.0-20261005-agent-session-error-log-privacy-028
- agent_profile_id: gpt-6.1-sol-low
- contract_id: xj-5.2.0-agent-session-error-log-privacy-v1
- write_lock_id: lock-5.2.0-agent-session-error-log-privacy-028
- protected_files_manifest_hash: not-applicable; verify per-file SHA-256 values in current_target_hashes before and after execution
- benchmark_manifest: synthetic provider raw error in result/onError/console capture, errObj local timeout safe log, late callback suppression, positive confirmation and full 5.2.0 regression v1
- visual_baseline: existing Agent surfaces; no layout or skin redesign
- current_target_hashes:
  - app/js/agent-api.js: 728FE51CE2517FDA0B10A4D3EBDC148B153BFFE1A99FE27F96FFD81DAC37AFCC
  - app/js/agent-core.js: 00F758CE37702108AF4FF9BF48C294EDCB5BC32480B6DD6AD6DFD7F7235A5AD2
  - app/js/agent-tools.js: FBD7BBF2BCA95BA025420998AB96511BB517725028ECD2FA9998A7C80A644D2B
  - app/js/xinjing-chat.js: 06978873D43A2D45F31699D6DD6CF405189D4A9521EF478F11F285E136399FA1
  - app/index.html: 2EC709BFCC9DBCE735218F49B1CAB5E8B91B7E5328B758CF234B0E2F3546047
  - app/chat-home.html: 597CB6EABE2115C649D07D130E310ABE6836A98AEB882B1A15A039FF7E50E54A
  - app/js/clinical-agent-runtime.js: 6FF7382E33D6710992BF6DA3DCA22956EB15BD649431406FFE92899FADE6D435
  - package.json: B74E0AA8F9B645D06647096545A3C611C112EF217AABADEA407B1950D629FC72
  - package-lock.json: FDB8D11766CE697211B6C21AEE91E488ECD8E12FEAFF725C568D62906156CB03
- authorization:
  - code_change: allowlisted only
  - local_commit: denied
  - push: denied
  - upload: denied
  - sign: denied
  - publish: denied
- write_allowlist:
  - app/js/agent-api.js (known-error logging privacy only; do not alter terminal/timeout behavior)
  - tests/v5.2.0/agent-session-stream-callback.contract.test.cjs (real VM console privacy regression only)
  - docs/delivery-reports/XJ-5.2.0-AGENT-SESSION-ERROR-LOG-PRIVACY-028.md
- forbidden:
  - app/js/agent-core.js, app/js/agent-tools.js, app/js/xinjing-chat.js, app/index.html, app/chat-home.html
  - app/js/clinical-agent-runtime.js, supervision, clinical-agent, main/preload, Store/IPC, package/version/build/release files
  - changes to public result shapes, error codes, terminal gates, confirmation behavior, UI or persistence
  - source deletion/restoration outside this allowlist; real clinical data; network or remote state
  - commits, merges, pushes, signing, packaging, upload or publish
- required_behavior:
  - A provider rejection shaped {code: MODEL_TIMEOUT, message: provider secret} still returns {ok:false,code:MODEL_TIMEOUT,error:操作超时} and sends only the safe wording to onError.
  - The same provider secret must not appear in any console.error/log argument emitted by Session.send(); logging may retain stable code and safe local wording only.
  - A local withTimeout errObj {ok:false,error:操作超时（Nms）,code:MODEL_TIMEOUT} remains code-preserving and does not regress.
  - Stage-026/027 late onConfirm and fallback writeGuard protections, stream suppression, close-after-await and pre-terminal positive confirmation remain unchanged.
- required_tests:
  - Load the real production app/js/agent-api.js through the existing VM helper with a synthetic AgentCore; capture console.error in the VM context, not by source-string matching.
  - Add a focused provider-secret assertion covering result, onError and captured logs.
  - Keep the existing errObj timeout code assertions and both shortened-timeout writeExecuted===0 race tests.
  - Await every asynchronous branch and use only synthetic values.
- required_adversarial_review:
  - Restore raw provider message in the known-error log: the captured-log privacy assertion must fail.
  - Replace production VM load with a facade or source-string assertion, or remove await: mark FAIL/BLOCKED rather than accepting green.
  - Remove terminal gate or alter timeout mapping: existing focused race/code assertions must fail.
  - Exercise provider-shaped timeout, errObj-shaped local timeout, unknown tool, allowWrite=false and close-after-await paths.
- acceptance_commands:
  - node --test tests/v5.2.0/agent-session-stream-callback.contract.test.cjs
  - node --test tests/v5.2.0/*.contract.test.cjs
  - node --check app/js/agent-api.js
  - node --check tests/v5.2.0/agent-session-stream-callback.contract.test.cjs
  - node tests/v5.2.0/015-local-electron-acceptance.cjs
  - git diff --check -- app/js/agent-api.js tests/v5.2.0/agent-session-stream-callback.contract.test.cjs docs/delivery-reports/XJ-5.2.0-AGENT-SESSION-ERROR-LOG-PRIVACY-028.md
  - Get-FileHash app/js/agent-core.js,app/js/agent-tools.js,app/js/xinjing-chat.js,app/index.html,app/chat-home.html,app/js/clinical-agent-runtime.js,package.json,package-lock.json -Algorithm SHA256
- checkpoints:
  - A: read AGENTS.md, 027 report, real Session.send() known-error catch; reproduce the raw provider message in captured console output; recompute protected hashes
  - B: focused provider-log privacy and existing timeout/race tests pass
  - C: inspect exact allowlist diff, run full contracts and controlled Electron, recompute hashes, and complete adversarial self-review before delivery
- rollback: restore only the two allowlisted source/test files to the 028 baseline and remove this report; preserve 025-027 evidence and all unrelated worktree changes; never reset, clean or revert unknown work
- stop_conditions:
  - need to modify AgentCore, AgentTools, UI, persistence, IPC or public result/callback contracts
  - provider raw text still appears in logs/result/onError, timeout/race behavior regresses, protected hash drift, second writer, allowlist drift, mock-only green, or real-data/network action
- delivery_report: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-SESSION-ERROR-LOG-PRIVACY-028.md
- acceptance_owner: /root
- next_after_acceptance: only after independent Codex intake may plan the next bounded 5.2.0 stage; this stage does not mark release-ready or authorize packaging/publishing

## Agent Instructions

你是执行代理，不是最终验收人；/root 负责范围、架构、冲突协调和最终验收。你不是独自在代码库中工作，必须保留未知改动。只修改 allowlist，不得创建提交。开始前读 AGENTS.md、027 报告和真实源码，先用真实 VM 复现 provider secret 出现在 Session.send() 的 console.error 日志中的问题。

交付前必须先做独立内部对抗审查，单列章节，记录真实 VM 入口、provider-shaped 与 errObj-shaped 两条错误路径、result/onError/log 的隐私断言、超时前正向确认、超时后 onConfirm 与 fallback writeGuard 迟到结果、异步等待、写集、保护哈希和 mock 假绿风险。报告用简体中文，列出 [STATUS]、[ARTIFACTS]、[VALIDATION]、P0-P3、残余风险和未授权动作，末行严格为：

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-SESSION-ERROR-LOG-PRIVACY-028.md
