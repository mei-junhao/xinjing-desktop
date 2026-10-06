# Task Card: XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-AUDIT-035

- task_id: XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-AUDIT-035
- objective: Continue the read-only AgentTools privacy audit after stage 034. Probe the remaining handler families that were incomplete or unverified in 033, using the real production app/js/agent-tools.js and the public window.AgentTools.invoke() entry point. Identify any reachable raw provider, storage, IPC, or clinical exception text in result objects or VM console output, classify evidence strength, and recommend the smallest bounded implementation follow-up. Do not modify production source, tests, configuration, or existing reports.
- owner: gpt-6.1-sol-low
- manager: codex (/root)
- project_root: D:/xinjing-electron
- branch_or_worktree: release/3.6.3-mac; shared working tree; do not switch branches, create a worktree, or create commits
- base_commit: eb16e2b74e6ab919a782b8bc6f66bfe9524431f2
- active_release_train: 5.2.0 implementation; stage 035 audit; not release-ready
- config_evidence_id: cfg-5.2.0-20261006-agent-tools-error-privacy-audit-035
- agent_profile_id: gpt-6.1-sol-low
- contract_id: xj-5.2.0-agent-tools-error-privacy-audit-v2
- write_lock_id: lock-5.2.0-agent-tools-error-privacy-audit-035
- protected_files_manifest_hash: read-only; recompute all protected hashes before and after execution
- benchmark_manifest: synthetic public AgentTools.invoke probes for remaining billing/storage/update/supervision/masters/file handler families, returned result privacy, console privacy, real async awaiting, no network or real clinical data
- visual_baseline: none; no UI changes
- current_target_hashes:
  - app/js/agent-tools.js: 0327989930E21278CD5751B2ED1DB29DC4142BD883FB16873795733756F5CCD9
  - app/js/agent-api.js: 33B49EA81F54DA07A2DB1E67BF28DBB03E1431E0AF05C59BC151BC1980450388
  - app/js/agent-core.js: 00F758CE37702108AF4FF9BF48C294EDCB5BC32480B6DD6AD6DFD7F7235A5AD2
  - package.json: B74E0AA8F9B645D06647096545A3C611C112EF217AABADEA407B1950D629FC72
  - package-lock.json: FDB8D11766CE697211B6C21AEE91E488ECD8E12FEAFF725C568D629061CB03
- authorization:
  - read_only_audit: allowed
  - production_code_change: denied in this task; requires a new Codex-approved implementation card
  - test_source_change: denied in this task
  - local_commit/push/upload/sign/publish: denied
- write_allowlist:
  - docs/delivery-reports/XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-AUDIT-035.md
  - qa/agent-reviews/XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-AUDIT-035.md (optional only if the project pattern requires a duplicate review artifact)
- forbidden:
  - app/js/agent-tools.js and all production source/UI/runtime/persistence/IPC/package files
  - existing tests, existing reports, configuration, release artifacts, and unrelated scratch files
  - real clinical data, network or remote state, commits, merges, pushes, signing, packaging, upload or publish
- required_behavior:
  - Load the real production module and invoke the real public registry; do not infer reachability from grep alone.
  - Probe at minimum billing.add_record, billing.monthly_settle, client.update, supervision.start, supervision.ask, masters.open, masters.message, and all file.* handlers where the public synthetic host can load them.
  - Exercise thrown Error and unknown-object failure forms wherever the public entry permits them; await every Promise before classifying results.
  - Capture returned result objects and VM console output using synthetic secret markers only; classify each path as confirmed, incomplete, unverified, or out-of-scope.
  - Distinguish stable business/validation wording from raw provider, storage, IPC, or clinical exception text.
  - If a path cannot be reached without forbidden production hooks or unrelated globals, document the exact missing dependency and do not claim a privacy pass.
- required_adversarial_review:
  - Attempt to replace the real AgentTools module with a facade, skip await, or assert only source strings; classify those as invalid evidence.
  - Recompute protected hashes after the audit and stop on any unexpected production drift.
  - Record whether a proposed fix belongs in the top-level wrapper or a handler-specific projection, without implementing it.
- acceptance_commands:
  - node --check app/js/agent-tools.js
  - git diff --check -- docs/delivery-reports/XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-AUDIT-035.md
  - Get-FileHash app/js/agent-tools.js,app/js/agent-api.js,app/js/agent-core.js,package.json,package-lock.json -Algorithm SHA256
- checkpoints:
  - A: read AGENTS.md, 034 report, real AgentTools registry/handler code, and establish protected baseline
  - B: execute real synthetic VM probes for each reachable remaining family and classify evidence
  - C: write the audit report with exact follow-up allowlist recommendation; no production changes
- rollback: remove only the new audit report; preserve all existing worktree changes; never reset, clean or revert unknown work
- stop_conditions:
  - any production/test/config file change, protected hash drift, real-data/network action, or inability to state evidence level truthfully
- delivery_report: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-AUDIT-035.md
- acceptance_owner: /root
- next_after_acceptance: Codex decides whether to open a separate implementation card for any confirmed reachable leak; this audit does not authorize production edits or release readiness

## Agent Instructions

你是只读调查代理，不是实现代理；/root 负责架构、范围、冲突协调和最终验收。你不是独自在代码库中工作，必须保留未知改动。只写 allowlist 中的新审计报告，不得修改生产代码、测试、配置或旧报告，不得创建提交。开始前读取 AGENTS.md、034 交付报告和真实 agent-tools.js，使用真实 window.AgentTools.invoke() 入口和合成宿主探测剩余 handler。

交付前必须先做独立内部对抗审查，单列章节，记录真实入口、异步等待、Error/unknown object、日志捕获、缺失宿主依赖、证据分类、写集、保护哈希和 mock 假绿风险。报告用简体中文，列出 [STATUS]、[ARTIFACTS]、[VALIDATION]、P0-P3、残余风险和未授权动作，末行严格为：

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-AUDIT-035.md
