# Task Card: XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-AUDIT-033

- task_id: XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-AUDIT-033
- objective: Read-only audit of raw exception projection in the real app/js/agent-tools.js tool handlers. Identify which result/error/log paths can expose provider, storage, or clinical data exception text through public AgentTools.invoke() entry points, classify severity and reachable synthetic evidence, and propose the smallest follow-up implementation scope. Do not modify production source in this task.
- owner: gpt-6.1-sol-low
- manager: codex (/root)
- project_root: D:/xinjing-electron
- branch_or_worktree: release/3.6.3-mac; shared working tree; do not switch branches, create a worktree, or create commits
- base_commit: eb16e2b74e6ab919a782b8bc6f66bfe9524431f2
- active_release_train: 5.2.0 implementation; stage 033 audit; not release-ready
- config_evidence_id: cfg-5.2.0-20261005-agent-tools-error-privacy-audit-033
- agent_profile_id: gpt-6.1-sol-low
- contract_id: xj-5.2.0-agent-tools-error-privacy-audit-v1
- write_lock_id: lock-5.2.0-agent-tools-error-privacy-audit-033
- protected_files_manifest_hash: read-only; verify current SHA-256 without modifying protected files
- benchmark_manifest: synthetic AgentTools.invoke entry probes for each candidate handler, returned result privacy, console privacy, public caller reachability, no real data/network
- visual_baseline: none; no UI changes
- current_target_hashes:
  - app/js/agent-tools.js: FBD7BBF2BCA95BA025420998AB96511BB517725028ECD2FA9998A7C80A644D2B
  - app/js/agent-api.js: 33B49EA81F54DA07A2DB1E67BF28DBB03E1431E0AF05C59BC151BC1980450388
  - app/js/agent-core.js: 00F758CE37702108AF4FF9BF48C294EDCB5BC32480B6DD6AD6DFD7F7235A5AD2
  - package.json: B74E0AA8F9B645D06647096545A3C611C112EF217AABADEA407B1950D629FC72
  - package-lock.json: FDB8D11766CE697211B6C21AEE91E488ECD8E12FEAFF725C568D629061CB03
- authorization:
  - read_only_audit: allowed
  - production_code_change: denied in this task; requires a new Codex-approved implementation card
  - local_commit/push/upload/sign/publish: denied
- write_allowlist:
  - docs/delivery-reports/XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-AUDIT-033.md
  - qa/agent-reviews/XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-AUDIT-033.md (optional duplicate review artifact only if already used by project pattern)
- forbidden:
  - app/js/agent-tools.js and all production source/UI/runtime/persistence/IPC/package files
  - existing tests/reports except the new audit report
  - real clinical data, network or remote state, commits, merges, pushes, signing, packaging, upload or publish
- required_behavior:
  - Read the real AgentTools registry and invoke implementation; do not infer reachability from grep alone.
  - For every candidate raw projection, classify confirmed reachable, reachable only with forbidden hooks, or not reachable from public synthetic entry.
  - Capture result object and VM console output; never print actual secrets outside synthetic test values.
  - Preserve all source hashes and report any unexpected drift as STOP.
- required_tests:
  - Use real production app/js/agent-tools.js in a clean VM or the project’s existing synthetic loader.
  - Probe at least the supervision start/follow-up paths, master chat/message paths, monthly/storage/update paths, and any handler that returns e.message/e directly.
  - Test both Error and unknown-object rejection where the public handler permits it.
  - No source-string-only or mock-only conclusion; if a handler cannot be loaded without unrelated production globals, document the exact missing dependency and mark evidence incomplete.
- required_adversarial_review:
  - Try to replace the real AgentTools module with a facade or skip awaiting the returned Promise; classify as invalid evidence.
  - Distinguish provider/tool/storage raw text from stable user-safe wording and avoid conflating business validation messages with exception leaks.
  - Recompute protected hashes after all read-only work.
- acceptance_commands:
  - node --check app/js/agent-tools.js
  - git diff --check -- docs/delivery-reports/XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-AUDIT-033.md
  - Get-FileHash app/js/agent-tools.js,app/js/agent-api.js,app/js/agent-core.js,package.json,package-lock.json -Algorithm SHA256
- checkpoints:
  - A: read AGENTS.md, 032 report, real AgentTools registry and handler code; establish protected baseline
  - B: execute real synthetic probes and classify each candidate path
  - C: write audit report with exact follow-up allowlist recommendation; no production changes
- rollback: remove only the new audit report; preserve all existing worktree changes; never reset, clean or revert unknown work
- stop_conditions:
  - any production file change, protected hash drift, real-data/network action, or inability to state evidence level truthfully
- delivery_report: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-AUDIT-033.md
- acceptance_owner: /root
- next_after_acceptance: Codex decides whether to open a separate implementation card for app/js/agent-tools.js; this audit does not authorize production edits

## Agent Instructions

你是只读调查代理，不是实现代理；/root 负责架构、范围和最终验收。你不是独自在代码库中工作，必须保留未知改动。禁止修改 app/js/agent-tools.js 或任何生产文件，不得创建提交。使用真实 VM/生产模块和合成输入做可达性探针，报告必须区分 confirmed、incomplete、unverified 和 out-of-scope。交付报告用简体中文，列出 [STATUS]、[ARTIFACTS]、[VALIDATION]、候选路径、证据等级、P0-P3、内部对抗审查、残余风险和未授权动作，末行严格为：

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-AUDIT-033.md
