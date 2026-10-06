# Task Card: XJ-5.2.0-RUNTIME-FACADE-009-ESCALATION-010

- task_id: XJ-5.2.0-RUNTIME-FACADE-009-ESCALATION-010
- objective: Repair the still-unaccepted runtime facade from stage 009 after three same-root-cause intake failures. Make the facade CommonJS/global fallback, stable AI cancellation/error mapping, execution-time cancellation, timeout and late-result protection real at the callable entry point, while preserving accepted 001-008 contracts and the non-persisting boundary.
- owner: gpt-6.1-sol-low (new escalation subagent)
- manager: codex (/root)
- project_root: D:/xinjing-electron
- branch_or_worktree: release/3.6.3-mac; shared worktree; do not switch branches or create commits
- base_commit: eb16e2b74e6ab919a782b8bc6f66bfe9524431f2
- active_release_train: 5.2.0 implementation; escalation of stage 009; not release-ready
- config_evidence_id: cfg-5.2.0-runtime-facade-009-escalation-010
- agent_profile_id: gpt-6.1-sol-low
- contract_id: xj-5.2.0-runtime-facade-v1-escalation
- write_lock_id: lock-5.2.0-runtime-facade-009-escalation-010
- escalation_reason: Same runtime-facade root cause remained after three distinct 009 execution attempts: CommonJS factory received undefined globalRoot; timeoutMs was absent; execution cancellation and AI signal propagation were not behaviorally complete; interrupted AI callback could be misclassified.
- prior_attempts:
  - 009 initial delivery: local intake found executor was constructed but not connected to the real adapter and globalRoot was undefined.
  - 009 follow-up repair 1: local probe still found interrupted mapped to ai-failed and CommonJS fallback failed; timeout/cancel semantics absent.
  - 009 follow-up repair 2: local probe still found Runtime.fromGlobals without explicit globals throws TypeError from undefined globalRoot; timeoutMs still absent.
- protected_file_hashes:
  - app/js/agent-core.js: 00F758CE37702108AF4FF9BF48C294EDCB5BC32480B6DD6AD6DFD7F7235A5AD2
  - app/js/clinical-context.js: 09536023837266F2D560CE8D2500A6EA6BE0A25C53F97CC1C781EB46A23C1B64
  - app/js/store.js: 00473C3984B95429BE2E82AAD3C61369A2A1C2459CACA7C77CF84A66277504A7
  - app/js/agent-tools.js: FBD7BBF2BCA95BA025420998AB96511BB517725028ECD2FA9998A7C80A644D2B
  - app/js/clinical-agent-tasks.js: 3FFBD7A8FCB59A94F48EC08F324F321AABC914BC9B00DD5D5E4459E0456C0B18
  - app/js/clinical-agent-router.js: 51D8AAC36800C6090D0C14307A326D2D611548CDC6954427548ADF80F97EFA99
  - app/js/clinical-agent-run.js: 858D743C5A1B16730C966C26DEF334852BDAB964612EA11596CBD607C11A3D57
  - app/js/clinical-agent-context-bridge.js: 55E67EBA7E0DD5629EE66FB8863A86DA2C6EFC7A79C518E4E2653925676F961B
  - app/js/clinical-agent-workflow.js: 52FFCB1E936DE49700567113EC762D4E42A14F0542D49904AF3E3113AAD7C892
  - app/js/clinical-agent-adapter.js: 1778BBC72174E12A4113DFB444CDC3DA7034ADF7798FA88D652CACBE0878D44C
  - package.json: B74E0AA8F9B645D06647096545A3C611C112EF217AABADEA407B1950D629FC72
  - package-lock.json: FDB8D11766CE697211B6C21AEE91E488ECD8E12FEAFF725C568D62906156CB03
  - app/js/clinical-agent-runtime.js: 842512319B7E396451677255DA9F0F0C7697C0586FA8461E9DFCEC61AB653BEA
  - tests/v5.2.0/clinical-agent-runtime.contract.test.cjs: 05486FDE1FF97D2594FF7340E610E9CF251EAD03D3D88774A288C2E08AE4361D
- write_allowlist:
  - app/js/clinical-agent-runtime.js (existing stage-009 source; repair only)
  - tests/v5.2.0/clinical-agent-runtime.contract.test.cjs (existing stage-009 contract; add regression evidence)
  - docs/delivery-reports/XJ-5.2.0-RUNTIME-FACADE-009-ESCALATION-010.md (new report)
- forbidden: all 001-008 files; any UI/HTML/CSS/Electron/preload/main/Store/AI/ClinicalContext/production/package/version/release file; commits, pushes, merges, uploads, signing, publishing, real clinical data or external messages
- required_behavior:
  - CommonJS require of clinical-agent-runtime.js followed by fromGlobals() must resolve globals safely when required globals are installed on globalThis; explicit dependency injection must still work.
  - fromGlobals must construct the real ClinicalAgentAdapter factory and execute through AI.send(messages, callback, options).
  - callback success, callback error/interrupted/cancelled/aborted, promise resolve/reject and thrown provider errors map to stable draft-ready, ai-failed or ai-cancelled without raw provider text.
  - timeoutMs must be observable in a pending execution: timer is cleared on settle, timeout returns stable cancellation, and late callback/promise cannot become draft-ready.
  - runtime cancellation while execute is pending must mark the private entry cancelled, invoke workflow cancellation, pass cancellation/signal state to adapter/AI when supported, and reject late success; replay/second execution remains invalid.
  - adapter payload messages and metadata remain isolated; no Store/action-run/persistence call is allowed.
- required_tests: real CommonJS global fallback; real callback and promise execution with AI call/options assertions; error/interrupted/rejection/late mapping; pending timeout and pending runtime.cancel; confirmation/admission/stale/replay/private-handle/raw-error failures; mutation-sensitive checks for factory root, timeout, cancel, late guard, confirmation gate and ai-cancelled mapping.
- required_adversarial_review: independently execute exact CommonJS entry; delete/skip await and late-result guards in scratch mutation and prove focused tests fail; verify signal/options and no persistence spies; verify only allowlist changed and protected hashes match.
- acceptance_commands:
  - node --test tests/v5.2.0/clinical-agent-runtime.contract.test.cjs
  - node --test tests/v5.2.0/clinical-agent-tasks.contract.test.cjs tests/v5.2.0/clinical-agent-router.contract.test.cjs tests/v5.2.0/clinical-agent-run.contract.test.cjs tests/v5.2.0/clinical-agent-context-bridge.contract.test.cjs tests/v5.2.0/clinical-agent-workflow.contract.test.cjs tests/v5.2.0/clinical-agent-adapter.contract.test.cjs tests/v5.2.0/clinical-agent-runtime.contract.test.cjs
  - node --check app/js/clinical-agent-runtime.js; node --check tests/v5.2.0/clinical-agent-runtime.contract.test.cjs
  - git diff --check -- app/js/clinical-agent-runtime.js tests/v5.2.0/clinical-agent-runtime.contract.test.cjs docs/agent-coordination/v5.2.0/tasks/XJ-5.2.0-RUNTIME-FACADE-009-ESCALATION-010.md docs/delivery-reports/XJ-5.2.0-RUNTIME-FACADE-009-ESCALATION-010.md
  - Get-FileHash app/js/agent-core.js,app/js/clinical-context.js,app/js/store.js,app/js/agent-tools.js,app/js/clinical-agent-tasks.js,app/js/clinical-agent-router.js,app/js/clinical-agent-run.js,app/js/clinical-agent-context-bridge.js,app/js/clinical-agent-workflow.js,app/js/clinical-agent-adapter.js,package.json,package-lock.json -Algorithm SHA256
- checkpoints: A read card/source/test and hashes; B focused real-entry tests; C full regression, syntax, diff, hash, allowlist and adversarial review.
- rollback: restore only stage-009 source/test to the escalation baseline and remove escalation report; preserve prior reports and unrelated worktree changes; never reset/clean/revert unknown work.
- delivery_report: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-RUNTIME-FACADE-009-ESCALATION-010.md
- acceptance_owner: /root
- next_after_acceptance: only after independent intake may plan production page integration; this escalation does not mark release-ready

## Agent Instructions

你是升级后的执行子代理，不是项目负责人；/root 保留架构、范围、集成和最终验收权。你不是独自在代码库中工作，必须保留其他用户/代理已有改动，不得回退未知变更。严格只写 allowlist，先完成 Checkpoint A 再修改。

交付前必须独立自审并主动尝试推翻结论；报告列出真实入口、正负路径、取消/超时/迟到结果、AI callback/promise 等待、私有句柄、无持久化、写集和哈希。报告最后一行严格使用：

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-RUNTIME-FACADE-009-ESCALATION-010.md
