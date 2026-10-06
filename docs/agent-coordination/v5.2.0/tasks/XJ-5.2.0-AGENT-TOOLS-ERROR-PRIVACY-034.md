# Task Card: XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-034

- task_id: XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-034
- objective: Fix the confirmed AgentTools public result privacy leak identified by audit 033. The real window.AgentTools.invoke() wrapper currently returns raw handler exception text (e.message) and seven confirmed handlers also concatenate Store/provider exception messages into public results. Add the smallest safe error projection that prevents raw synthetic secrets from reaching public result objects for billing.summary, billing.reminder, agent.configure_api, client.query, session.query, supervision.query, and stats.overview, while preserving each handler's existing stable validation/business errors, success result shape, tool registry, and Agent API behavior.
- owner: gpt-6.1-sol-low
- manager: codex (/root)
- project_root: D:/xinjing-electron
- branch_or_worktree: release/3.6.3-mac; shared working tree; do not switch branches, create a worktree, or create commits
- base_commit: eb16e2b74e6ab919a782b8bc6f66bfe9524431f2
- active_release_train: 5.2.0 implementation; stage 034; not release-ready
- config_evidence_id: cfg-5.2.0-20261005-agent-tools-error-privacy-034
- agent_profile_id: gpt-6.1-sol-low
- contract_id: xj-5.2.0-agent-tools-error-privacy-v1
- write_lock_id: lock-5.2.0-agent-tools-error-privacy-034
- protected_files_manifest_hash: not-applicable; recompute all protected hashes before and after execution
- benchmark_manifest: real AgentTools VM probes for seven confirmed handlers, wrapper unknown Error/object rejection, stable validation errors, success result shape, full 5.2.0 regression v1
- visual_baseline: no UI changes
- current_target_hashes:
  - app/js/agent-tools.js: FBD7BBF2BCA95BA025420998AB96511BB517725028ECD2FA9998A7C80A644D2B
  - app/js/agent-api.js: 33B49EA81F54DA07A2DB1E67BF28DBB03E1431E0AF05C59BC151BC1980450388
  - app/js/agent-core.js: 00F758CE37702108AF4FF9BF48C294EDCB5BC32480B6DD6AD6DFD7F7235A5AD2
  - app/index.html: 2EC709BFCC9DBCE735218F49B1CAB5E8B91B7E5328B758CF234B0E2F3546047
  - app/chat-home.html: 597CB6EABE2115C649D07D130E310ABE6836A98AEB882B1A15A039FF7E50E54A
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
  - app/js/agent-tools.js (unified public invoke error projection plus only the seven confirmed handler catch projections)
  - tests/v5.2.0/agent-tools-error-privacy.contract.test.cjs (new real-VM synthetic Store fixture contract)
  - docs/delivery-reports/XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-034.md
- forbidden:
  - app/js/agent-core.js, app/js/agent-api.js, UI/clinical runtime, main/preload, Store/IPC, package/version/build/release files
  - changes to tool names/kinds/schema, write confirmation, durable API semantics, success result shapes, validation wording, or unrelated incomplete handlers
  - production test hooks, source deletion/restoration outside allowlist, real clinical data, network or remote state
  - commits, merges, pushes, signing, packaging, upload or publish
- required_behavior:
  - For each confirmed handler, synthetic Store/provider Error('secret') must never appear in returned result JSON; return a stable safe operation-specific failure wording and preserve ok:false shape.
  - AgentTools.invoke() synchronous throw, rejected Promise with Error, and rejected Promise with unknown object must return a stable safe generic tool failure without raw text.
  - Stable validation/business errors (missing args, unknown client, unsupported sort, etc.) remain unchanged; successful handler result shapes remain unchanged.
  - Incomplete/unverified handlers are not silently claimed covered; report any remaining raw candidates separately.
  - Existing Agent API low-level privacy and all 5.2.0 contracts remain green.
- required_tests:
  - Load real production app/js/agent-tools.js through a VM with synthetic Store/AI/window dependencies; call window.AgentTools.invoke() and await every result.
  - Cover all seven confirmed handlers with thrown Error and at least wrapper-level unknown-object rejection; capture VM console.log/warn/error.
  - Assert raw secrets absent from result and console, exact stable validation errors for representative invalid inputs, and representative success result keys.
  - Do not replace AgentTools with a facade or use source-string-only assertions.
- required_adversarial_review:
  - Restore raw e.message in unified wrapper or each confirmed handler; real VM privacy assertions must fail.
  - Replace production module with a mock, remove await, bypass handler, or weaken validation/success assertions; mark FAIL/BLOCKED.
  - Mutate a stable business error or success shape; focused contract must fail.
- acceptance_commands:
  - node --test tests/v5.2.0/agent-tools-error-privacy.contract.test.cjs
  - node --test tests/v5.2.0/*.contract.test.cjs
  - node --check app/js/agent-tools.js
  - node --check tests/v5.2.0/agent-tools-error-privacy.contract.test.cjs
  - node tests/v5.2.0/015-local-electron-acceptance.cjs
  - git diff --check -- app/js/agent-tools.js tests/v5.2.0/agent-tools-error-privacy.contract.test.cjs docs/delivery-reports/XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-034.md
  - Get-FileHash app/js/agent-tools.js,app/js/agent-api.js,app/js/agent-core.js,app/index.html,app/chat-home.html,package.json,package-lock.json -Algorithm SHA256
- checkpoints:
  - A: read AGENTS.md, 033 audit, real AgentTools wrapper/handler code; reproduce seven leaks and recompute protected hashes
  - B: focused privacy/validation/success contract passes with real VM
  - C: exact allowlist diff, full contracts, controlled Electron, protected hashes, and adversarial self-review before delivery
- rollback: restore only allowlisted source/test files to the 034 baseline and remove this report; preserve 023-033 and all unrelated worktree changes; never reset, clean or revert unknown work
- stop_conditions:
  - need to modify shared AgentCore/API/UI/persistence/IPC or public success/schema contracts
  - raw secret remains in confirmed result paths, stable validation/success regresses, protected hash drift, second writer, mock-only green, or real-data/network action
- delivery_report: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-034.md
- acceptance_owner: /root
- next_after_acceptance: only after independent Codex intake may plan a later bounded 5.2.0 stage for remaining incomplete handlers; this stage does not mark release-ready or authorize packaging/publishing

## Agent Instructions

你是执行代理，不是最终验收人；/root 负责架构、范围、冲突协调和最终验收。你不是独自在代码库中工作，必须保留未知改动。只修改 allowlist，不得创建提交。开始前读取 AGENTS.md、033 审计报告和真实 agent-tools.js，先用真实 VM 复现七个 confirmed handler 的 raw-secret result 泄露及 wrapper unknown Error/object 路径。

交付前必须先做独立内部对抗审查，单列章节，记录真实 AgentTools.invoke 入口、七个 handler、Error/unknown object、稳定业务错误、成功结构、日志捕获、异步等待、写集、保护哈希和 mock 假绿风险。报告用简体中文，列出 [STATUS]、[ARTIFACTS]、[VALIDATION]、P0-P3、残余风险和未授权动作，末行严格为：

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-034.md
