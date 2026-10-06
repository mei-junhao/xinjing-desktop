# Task Card: XJ-5.2.0-AGENT-SESSION-TIMEOUT-CODE-027

- task_id: XJ-5.2.0-AGENT-SESSION-TIMEOUT-CODE-027
- objective: Fix the Session.send timeout error contract exposed by stage 026. A timeout produced by the local withTimeout() helper is an errObj-shaped rejection with { ok:false, error, code }; Session.send() must recognize that shape, preserve code MODEL_TIMEOUT, and expose only the safe timeout wording. Keep the stage-026 per-send terminal-gated confirmation and fallback writeGuard protections intact, and restore a real MODEL_TIMEOUT assertion in the shortened-timeout regressions.
- owner: gpt-6.1-sol-low
- manager: codex (/root)
- project_root: D:/xinjing-electron
- branch_or_worktree: release/3.6.3-mac; shared working tree; do not switch branches, create a worktree, or create commits
- base_commit: eb16e2b74e6ab919a782b8bc6f66bfe9524431f2
- active_release_train: 5.2.0 implementation; stage 027; not release-ready
- config_evidence_id: cfg-5.2.0-20261005-agent-session-timeout-code-027
- agent_profile_id: gpt-6.1-sol-low
- contract_id: xj-5.2.0-agent-session-timeout-code-v1
- write_lock_id: lock-5.2.0-agent-session-timeout-code-027
- protected_files_manifest_hash: not-applicable; verify the per-file SHA-256 values in current_target_hashes before and after execution
- benchmark_manifest: synthetic shortened Session timeout, MODEL_TIMEOUT code preservation, safe timeout wording, late onConfirm/writeGuard suppression, provider-error privacy, positive pre-terminal confirmation v2
- visual_baseline: existing Agent surfaces; no layout or skin redesign
- current_target_hashes:
  - app/js/agent-api.js: 1A593A68F537B292C9F1747A0FA594C69255BC5E8A77BDED23AFC10CB1646266
  - app/js/agent-core.js: 00F758CE37702108AF4FF9BF48C294EDCB5BC32480B6DD6AD6DFD7F7235A5AD2
  - app/js/agent-tools.js: FBD7BBF2BCA95BA025420998AB96511BB517725028ECD2FA9998A7C80A644D2B
  - app/js/xinjing-chat.js: 06978873D43A2D45F31699D6DD6CF405189D4A9521EF478F11F285E136399FA1
  - app/index.html: 2EC709BFCC9DBCE735218F49B1CAB5E8B91B7E5328B758CF234B0E2F3546047
  - app/chat-home.html: 597CB6EABE2115C649D07D130E310ABE6836A98AEB882B1A15A039FF7E50E54A
  - app/js/clinical-agent-runtime.js: 6FF7382E33D6710992BF4FF9BF48C294EB15BD649431406FFE92899FADE6D435
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
  - app/js/agent-api.js (known-error recognition and safe MODEL_TIMEOUT mapping only; retain terminal gate)
  - tests/v5.2.0/agent-session-stream-callback.contract.test.cjs (restore/strengthen timeout code and safety assertions only)
  - docs/delivery-reports/XJ-5.2.0-AGENT-SESSION-TIMEOUT-CODE-027.md
- forbidden:
  - app/js/agent-core.js, app/js/agent-tools.js, app/js/xinjing-chat.js, app/index.html, app/chat-home.html
  - app/js/clinical-agent-runtime.js, supervision, clinical-agent, main/preload, Store/IPC, package/version/build/release files
  - source deletion or restoration outside this allowlist; UI redesign; public callback shape changes; real clinical data; network or remote state
  - commits, merges, pushes, signing, packaging, upload or publish
- required_behavior:
  - withTimeout(..., ERR.MODEL_TIMEOUT) rejects with the existing errObj shape and Session.send() returns { ok:false, code:'MODEL_TIMEOUT', error:<safe timeout wording> }.
  - A local timeout message such as 操作超时（5ms） may be retained; provider-supplied raw timeout text must never be returned or sent to onError.
  - A provider rejection shaped { code:'MODEL_TIMEOUT', message:'provider secret' } remains MODEL_TIMEOUT with safe wording and no provider text leakage.
  - Stage-026 terminal gate remains effective: after timeout, late session onConfirm and fallback writeGuard {ok:true} cannot authorize or execute a write.
  - Pre-terminal positive confirmation, close-before-resolution protection, stream callback suppression and existing public result shapes remain green.
- required_tests:
  - Load the real production app/js/agent-api.js through the existing VM helper; do not replace it with a facade or source-string assertion.
  - Restore explicit assert.equal(result.code, MODEL_TIMEOUT) in both shortened-timeout race tests and assert the safe error wording.
  - Add or retain a focused regression for an errObj-shaped timeout rejection ({ok:false,error:'操作超时（Nms）',code:'MODEL_TIMEOUT'}).
  - Keep both late session onConfirm and fallback writeGuard writeExecuted===0 checks.
  - Await every asynchronous branch; do not merely sleep without observing the pending operation.
- required_adversarial_review:
  - Remove the {code,error} recognition branch: the timeout code assertion must fail.
  - Restore raw provider timeout text: privacy assertion must fail.
  - Remove the per-send terminal gate: at least one shortened-timeout late-confirmation test must fail.
  - Remove an await or replace the production VM load with a facade: mark FAIL/BLOCKED rather than accepting a false green.
  - Exercise provider-shaped known timeout, errObj-shaped local timeout, close-after-await, unknown tool and allowWrite=false paths.
- acceptance_commands:
  - node --test tests/v5.2.0/agent-session-stream-callback.contract.test.cjs
  - node --test tests/v5.2.0/*.contract.test.cjs
  - node --check app/js/agent-api.js
  - node --check tests/v5.2.0/agent-session-stream-callback.contract.test.cjs
  - node tests/v5.2.0/015-local-electron-acceptance.cjs
  - git diff --check -- app/js/agent-api.js tests/v5.2.0/agent-session-stream-callback.contract.test.cjs docs/delivery-reports/XJ-5.2.0-AGENT-SESSION-TIMEOUT-CODE-027.md
  - Get-FileHash app/js/agent-core.js,app/js/agent-tools.js,app/js/xinjing-chat.js,app/index.html,app/chat-home.html,app/js/clinical-agent-runtime.js,package.json,package-lock.json -Algorithm SHA256
- checkpoints:
  - A: read AGENTS.md, 026 report, real Session.send()/withTimeout() code; reproduce the errObj-shaped timeout mismatch; recompute protected hashes
  - B: focused timeout-code/privacy/race tests pass, including explicit MODEL_TIMEOUT assertions
  - C: inspect exact allowlist diff, run full contracts and controlled Electron, recompute hashes, and complete adversarial self-review before delivery
- rollback: restore only the two allowlisted source/test files to the 027 baseline and remove this report; preserve 025/026 evidence and all unrelated worktree changes; never reset, clean or revert unknown work
- stop_conditions:
  - need to modify AgentCore, AgentTools, UI, persistence, IPC or public callback shapes
  - timeout code still becomes MODEL_ERROR, raw provider text leaks, or late confirmation executes a write
  - protected hash drift, second writer, allowlist drift, mock-only green, or any real-data/network action
- delivery_report: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-SESSION-TIMEOUT-CODE-027.md
- acceptance_owner: /root
- next_after_acceptance: only after independent Codex intake may plan the next bounded 5.2.0 stage; this stage does not mark release-ready or authorize packaging/publishing

## Agent Instructions

你是执行代理，不是最终验收人；/root 负责范围、架构、冲突协调和最终验收。你不是独自在代码库中工作，必须保留未知改动。只修改 allowlist，不得创建提交。开始前读 AGENTS.md、026 报告和真实源码，先用真实 VM 复现 {ok:false,error,code} timeout 被 Session.send() 错误降级为 MODEL_ERROR 的问题。

交付前必须先做独立内部对抗审查，单列章节，记录真实 VM 入口、errObj 与 provider-shaped timeout 两条路径、超时前正向确认、超时后 onConfirm 与 fallback writeGuard 迟到结果、write handler 调用计数、异步等待、写集、保护哈希和 mock 假绿风险。报告用简体中文，列出 [STATUS]、[ARTIFACTS]、[VALIDATION]、P0-P3、残余风险和未授权动作，末行严格为：

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-SESSION-TIMEOUT-CODE-027.md
