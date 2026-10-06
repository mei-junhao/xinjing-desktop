# Task Card: XJ-5.2.0-AGENT-TOOL-ERROR-LOG-PRIVACY-030

- task_id: XJ-5.2.0-AGENT-TOOL-ERROR-LOG-PRIVACY-030
- objective: Close the remaining low-level XJAgent.invokeTool() error-projection privacy leaks. The production facade currently exposes raw exception text from the top-level catch, global writeGuard failure path, synchronous AgentTools.invoke throw, and rejected AgentTools.invoke promise through console logs and/or returned error messages. Replace only those raw projections with stable safe wording while preserving existing error codes, fail-closed behavior, timeout semantics, tool success behavior, circuit accounting, and public result shape.
- owner: gpt-6.1-sol-low
- manager: codex (/root)
- project_root: D:/xinjing-electron
- branch_or_worktree: release/3.6.3-mac; shared working tree; do not switch branches, create a worktree, or create commits
- base_commit: eb16e2b74e6ab919a782b8bc6f66bfe9524431f2
- active_release_train: 5.2.0 implementation; stage 030; not release-ready
- config_evidence_id: cfg-5.2.0-20261005-agent-tool-error-log-privacy-030
- agent_profile_id: gpt-6.1-sol-low
- contract_id: xj-5.2.0-agent-tool-error-log-privacy-v1
- write_lock_id: lock-5.2.0-agent-tool-error-log-privacy-030
- protected_files_manifest_hash: not-applicable; recompute every protected SHA-256 before and after execution
- benchmark_manifest: synthetic top-level invokeTool exception, writeGuard throw, synchronous tool throw, rejected tool promise, tool timeout, unknown tool, safe result/log capture, full 5.2.0 regression v1
- visual_baseline: existing Agent surfaces; no layout or skin redesign
- current_target_hashes:
  - app/js/agent-api.js: 74D9BACEC883B32EE0981DE6D541072A55792928C9AC1D0ACE6692C0B8E24142
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
  - app/js/agent-api.js (low-level invokeTool error projection and log privacy only)
  - tests/v5.2.0/agent-tool-error-log-privacy.contract.test.cjs (new focused real-VM contract; an existing contract may be extended only if strictly necessary)
  - docs/delivery-reports/XJ-5.2.0-AGENT-TOOL-ERROR-LOG-PRIVACY-030.md
- forbidden:
  - app/js/agent-core.js, app/js/agent-tools.js, app/js/xinjing-chat.js, app/index.html, app/chat-home.html
  - app/js/clinical-agent-runtime.js, supervision, clinical-agent, main/preload, Store/IPC, package/version/build/release files
  - changes to public error codes, result keys, writeGuard fail-closed semantics, timeout/circuit behavior, UI or persistence
  - source deletion/restoration outside this allowlist; real clinical data; network or remote state
  - commits, merges, pushes, signing, packaging, upload or publish
- required_behavior:
  - A top-level unexpected invokeTool failure returns {ok:false, code:SYS_INTERNAL_ERROR} with stable safe wording and never includes raw exception text in result or captured console output.
  - A throwing global writeGuard remains fail-closed and returns SEC_WRITE_DENIED; neither console.warn nor the returned message may contain the raw guard secret. Existing writeGuard timeout remains USR_CONFIRM_TIMEOUT and safe.
  - A synchronous AgentTools.invoke throw returns TOOL_ERROR; a rejected AgentTools.invoke promise returns TOOL_ERROR; neither result nor console.warn may contain the raw tool secret.
  - A timeout still returns TOOL_TIMEOUT with existing safe timeout wording and does not leak a later rejection.
  - Existing validation, unknown-tool, schema, injection, allowWrite denial, tool success and circuit accounting behavior remains unchanged.
- required_tests:
  - Load real production app/js/agent-api.js through a VM helper. Do not replace it with a facade and do not rely on source-string assertions.
  - Capture console.log, console.warn, and console.error inside the VM context and assert raw synthetic secrets are absent from every captured argument.
  - Cover top-level _invokeToolImpl/invokeTool failure, writeGuard throw, synchronous tool throw, rejected tool promise, timeout, and positive successful tool invocation.
  - Assert exact error codes for SYS_INTERNAL_ERROR, SEC_WRITE_DENIED, TOOL_ERROR, and TOOL_TIMEOUT; preserve existing public result keys.
  - Await every async branch and use only synthetic values.
- required_adversarial_review:
  - Restore each raw e.message/object interpolation in the four vulnerable projections; captured-log/result privacy assertions must fail.
  - Replace production VM load with a stub/facade, remove an await, or assert only source text; mark FAIL/BLOCKED rather than accepting green.
  - Change TOOL_TIMEOUT or USR_CONFIRM_TIMEOUT mapping, bypass writeGuard fail-close, or skip releasing the tool slot; focused behavior assertions must fail.
  - Verify unknown object (not only Error) rejection does not stringify sensitive fields.
- acceptance_commands:
  - node --test tests/v5.2.0/agent-tool-error-log-privacy.contract.test.cjs
  - node --test tests/v5.2.0/*.contract.test.cjs
  - node --check app/js/agent-api.js
  - node --check tests/v5.2.0/agent-tool-error-log-privacy.contract.test.cjs
  - node tests/v5.2.0/015-local-electron-acceptance.cjs
  - git diff --check -- app/js/agent-api.js tests/v5.2.0/agent-tool-error-log-privacy.contract.test.cjs docs/delivery-reports/XJ-5.2.0-AGENT-TOOL-ERROR-LOG-PRIVACY-030.md
  - Get-FileHash app/js/agent-core.js,app/js/agent-tools.js,app/js/xinjing-chat.js,app/index.html,app/chat-home.html,app/js/clinical-agent-runtime.js,package.json,package-lock.json -Algorithm SHA256
- checkpoints:
  - A: read AGENTS.md, 029 report, and the real invokeTool/writeGuard code; reproduce every raw-secret path with the real VM and recompute protected hashes
  - B: focused privacy/error-code/timeout contract passes, including positive tool success and unknown-object rejection
  - C: inspect exact allowlist diff, run full contracts and controlled Electron, recompute protected hashes, and complete adversarial self-review before delivery
- rollback: restore only the allowlisted source/test files to the 030 baseline and remove this report; preserve stages 025-029 and all unrelated worktree changes; never reset, clean or revert unknown work
- stop_conditions:
  - need to modify AgentCore, AgentTools, UI, persistence, IPC or public result/callback contracts
  - any raw secret remains in result/onError/log, timeout/race behavior regresses, protected hash drift, second writer, allowlist drift, mock-only green, or real-data/network action
- delivery_report: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-TOOL-ERROR-LOG-PRIVACY-030.md
- acceptance_owner: /root
- next_after_acceptance: only after independent Codex intake may plan the next bounded 5.2.0 stage; this stage does not mark release-ready or authorize packaging/publishing

## Agent Instructions

你是执行代理，不是最终验收人；/root 负责范围、架构、冲突协调和最终验收。你不是独自在代码库中工作，必须保留未知改动。只修改 allowlist，不得创建提交。开始前读 AGENTS.md、029 报告和真实源码，先用真实 VM 复现四条低级 invokeTool raw-secret 路径。

交付前必须先做独立内部对抗审查，单列章节，记录真实 VM 入口、top-level、writeGuard、同步 throw、Promise reject、timeout、unknown object 和成功路径；检查 result/console 隐私、错误码、异步等待、写集、保护哈希和 mock 假绿风险。报告用简体中文，列出 [STATUS]、[ARTIFACTS]、[VALIDATION]、P0-P3、残余风险和未授权动作，末行严格为：

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-TOOL-ERROR-LOG-PRIVACY-030.md
