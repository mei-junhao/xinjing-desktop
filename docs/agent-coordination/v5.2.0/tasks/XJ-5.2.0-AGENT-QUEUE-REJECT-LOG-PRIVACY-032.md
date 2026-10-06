# Task Card: XJ-5.2.0-AGENT-QUEUE-REJECT-LOG-PRIVACY-032

- task_id: XJ-5.2.0-AGENT-QUEUE-REJECT-LOG-PRIVACY-032
- objective: Remove the last two raw exception interpolations in app/js/agent-api.js queue cleanup protection branches. removeFromQueueBySession() and _drainQueue() currently concatenate e.message/e when an internal Promise reject callback itself throws. Replace only those log projections with stable safe wording while preserving queue cancellation, concurrency errors, slot accounting, ordering, and all prior 023-031 behavior.
- owner: gpt-6.1-sol-low
- manager: codex (/root)
- project_root: D:/xinjing-electron
- branch_or_worktree: release/3.6.3-mac; shared working tree; do not switch branches, create a worktree, or create commits
- base_commit: eb16e2b74e6ab919a782b8bc6f66bfe9524431f2
- active_release_train: 5.2.0 implementation; stage 032; not release-ready
- config_evidence_id: cfg-5.2.0-20261005-agent-queue-reject-log-privacy-032
- agent_profile_id: gpt-6.1-sol-low
- contract_id: xj-5.2.0-agent-queue-reject-log-privacy-v1
- write_lock_id: lock-5.2.0-agent-queue-reject-log-privacy-032
- protected_files_manifest_hash: not-applicable; recompute protected SHA-256 before and after execution
- benchmark_manifest: synthetic queue reject callback throw through the real VM when reachable, normal session queue cancellation/concurrency behavior, full 5.2.0 regression v1
- visual_baseline: existing Agent surfaces; no layout or skin redesign
- current_target_hashes:
  - app/js/agent-api.js: 5CB88F1F34253520D95BC1E28A765EBF2FB99959446404D5C38CD926D6E59D0E
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
  - app/js/agent-api.js (the two queue reject-catch log messages only)
  - tests/v5.2.0/agent-queue-reject-log-privacy.contract.test.cjs (focused real-VM regression; no production test hooks)
  - docs/delivery-reports/XJ-5.2.0-AGENT-QUEUE-REJECT-LOG-PRIVACY-032.md
- forbidden:
  - all other production JS/HTML, AgentCore/AgentTools/UI/clinical runtime, main/preload, Store/IPC, package/version/build/release files
  - changes to queue semantics, public results, error codes, slot accounting, timeout/confirmation/session behavior, or adding production test hooks
  - source deletion/restoration outside this allowlist; real clinical data; network or remote state
  - commits, merges, pushes, signing, packaging, upload or publish
- required_behavior:
  - The two queue reject protection logs never include a raw synthetic exception secret when their catches are reached.
  - Normal remove/cancel and duplicate-session queue behavior remains unchanged; reject callback exceptions remain swallowed as before so queue cleanup continues.
  - All previous low-level tool, availability, Session stream/terminal/timeout/confirmation and full 5.2.0 contracts remain green.
- required_tests:
  - Load real production app/js/agent-api.js through a VM helper. Do not use a facade or source-string-only assertions.
  - If the internal catch branches are reachable without production hooks, trigger each with a synthetic Promise/reject implementation and capture VM logs; otherwise document the concrete reachability limitation and still test normal queue behavior plus a mutation-sensitive check that restoring raw interpolation fails any reachable privacy assertion.
  - Assert raw synthetic secrets are absent from captured logs; await every asynchronous branch.
  - Do not modify production code merely to expose test hooks.
- required_adversarial_review:
  - Restore each raw e.message/e interpolation; any reachable privacy assertion must fail, or the report must explicitly classify the branch as unverified/incomplete rather than PASS.
  - Replace production VM with a facade, remove await, or assert source text only; mark FAIL/BLOCKED.
  - Mutate queue cancellation/reject behavior or slot accounting; normal queue contract must fail.
- acceptance_commands:
  - node --test tests/v5.2.0/agent-queue-reject-log-privacy.contract.test.cjs
  - node --test tests/v5.2.0/*.contract.test.cjs
  - node --check app/js/agent-api.js
  - node --check tests/v5.2.0/agent-queue-reject-log-privacy.contract.test.cjs
  - node tests/v5.2.0/015-local-electron-acceptance.cjs
  - git diff --check -- app/js/agent-api.js tests/v5.2.0/agent-queue-reject-log-privacy.contract.test.cjs docs/delivery-reports/XJ-5.2.0-AGENT-QUEUE-REJECT-LOG-PRIVACY-032.md
  - Get-FileHash app/js/agent-core.js,app/js/agent-tools.js,app/js/xinjing-chat.js,app/index.html,app/chat-home.html,app/js/clinical-agent-runtime.js,package.json,package-lock.json -Algorithm SHA256
- checkpoints:
  - A: read AGENTS.md, 031 report, and real queue code; reproduce or document reachability of both reject-catch branches and recompute protected hashes
  - B: focused privacy/queue behavior contract passes with truthful evidence classification
  - C: exact allowlist diff, full contracts, controlled Electron, protected hashes, and adversarial self-review before delivery
- rollback: restore only the allowlisted source/test files to the 032 baseline and remove this report; preserve 023-031 and all unrelated worktree changes; never reset, clean or revert unknown work
- stop_conditions:
  - need for production hooks or changes outside allowlist
  - inability to provide truthful branch evidence, queue behavior regression, protected hash drift, second writer, mock-only green, or real-data/network action
- delivery_report: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-QUEUE-REJECT-LOG-PRIVACY-032.md
- acceptance_owner: /root
- next_after_acceptance: only after independent Codex intake may plan the next bounded 5.2.0 stage; this stage does not mark release-ready or authorize packaging/publishing

## Agent Instructions

你是执行代理，不是最终验收人；/root 负责范围、架构、冲突协调和最终验收。你不是独自在代码库中工作，必须保留未知改动。只修改 allowlist，不得创建提交。开始前读取 AGENTS.md、031 报告和真实队列代码，先用真实 VM 复现或严格记录两个 reject-catch 分支的可达性。

交付前必须先做独立内部对抗审查，单列章节，记录真实 VM 入口、两条 reject-catch、正常队列取消/并发行为、result/log 隐私、异步等待、写集、保护哈希和 mock 假绿风险。若分支无法在无生产测试钩子的条件下真实触发，必须明确标记未验证，不能用源码匹配冒充通过。报告用简体中文，列出 [STATUS]、[ARTIFACTS]、[VALIDATION]、P0-P3、残余风险和未授权动作，末行严格为：

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-QUEUE-REJECT-LOG-PRIVACY-032.md
