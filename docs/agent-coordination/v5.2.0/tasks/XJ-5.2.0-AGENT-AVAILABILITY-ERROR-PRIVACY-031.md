# Task Card: XJ-5.2.0-AGENT-AVAILABILITY-ERROR-PRIVACY-031

- task_id: XJ-5.2.0-AGENT-AVAILABILITY-ERROR-PRIVACY-031
- objective: Close the remaining availability and Session-construction error privacy leaks in app/js/agent-api.js. Authorization checks, model capability checks, and chat() Session construction currently concatenate raw exception text into availability reasons or returned error objects. Replace only those raw projections with stable safe wording while preserving normal availability messages, error codes, Session behavior, and all previously accepted 023-030 contracts.
- owner: gpt-6.1-sol-low
- manager: codex (/root)
- project_root: D:/xinjing-electron
- branch_or_worktree: release/3.6.3-mac; shared working tree; do not switch branches, create a worktree, or create commits
- base_commit: eb16e2b74e6ab919a782b8bc6f66bfe9524431f2
- active_release_train: 5.2.0 implementation; stage 031; not release-ready
- config_evidence_id: cfg-5.2.0-20261005-agent-availability-error-privacy-031
- agent_profile_id: gpt-6.1-sol-low
- contract_id: xj-5.2.0-agent-availability-error-privacy-v1
- write_lock_id: lock-5.2.0-agent-availability-error-privacy-031
- protected_files_manifest_hash: not-applicable; recompute protected SHA-256 before and after execution
- benchmark_manifest: synthetic App.aiUnlocked throw, AI.getActiveConfig throw, AI.isToolCapable throw, Session constructor throw, normal unavailable reasons, full 5.2.0 regression v1
- visual_baseline: existing Agent surfaces; no layout or skin redesign
- current_target_hashes:
  - app/js/agent-api.js: C2B35FEC995C2088FECE5405CB5B2E4E5BBA1150040CA9B51EE334641D33E3F2
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
  - app/js/agent-api.js (availability reason and chat Session-construction error projection only)
  - tests/v5.2.0/agent-availability-error-privacy.contract.test.cjs (new focused real-VM contract)
  - docs/delivery-reports/XJ-5.2.0-AGENT-AVAILABILITY-ERROR-PRIVACY-031.md
- forbidden:
  - app/js/agent-core.js, app/js/agent-tools.js, app/js/xinjing-chat.js, app/index.html, app/chat-home.html
  - supervision, clinical-agent, main/preload, Store/IPC, package/version/build/release files
  - changes to public error codes/result keys, normal unavailable wording, UI, persistence, queues, Session stream/confirmation/timeout behavior
  - source deletion/restoration outside this allowlist; real clinical data; network or remote state
  - commits, merges, pushes, signing, packaging, upload or publish
- required_behavior:
  - App.aiUnlocked throwing yields a stable safe availability reason without raw exception text; false still yields the existing authorization-expired message.
  - AI.getActiveConfig or AI.isToolCapable throwing yields a stable safe availability reason without raw exception text; unsupported models retain the existing model-name message.
  - chat() with a synthetic Session-construction throw returns SYS_INTERNAL_ERROR with stable safe wording and no raw exception text; successful chat and normal unavailable paths remain unchanged.
  - Existing low-level tool privacy and all Session stream, terminal, timeout, confirmation-race, error-code, and callback contracts remain unchanged.
- required_tests:
  - Load real production app/js/agent-api.js through a VM helper; capture returned objects and any VM logs. Do not use a facade or source-string-only assertions.
  - Cover each throwing host dependency, normal false/unsupported paths, constructor throw, and a positive chat path.
  - Assert raw synthetic secrets are absent from result and captured logs, and exact existing error codes/messages are preserved where they are stable contracts.
  - Await every asynchronous branch and use only synthetic values.
- required_adversarial_review:
  - Restore raw e.message interpolation in availability/constructor paths; privacy assertions must fail.
  - Replace production VM with a mock facade, remove await, or assert source text only; mark FAIL/BLOCKED.
  - Mutate normal false/unsupported paths, SYS_INTERNAL_ERROR mapping, or successful chat; focused and full contracts must fail.
- acceptance_commands:
  - node --test tests/v5.2.0/agent-availability-error-privacy.contract.test.cjs
  - node --test tests/v5.2.0/*.contract.test.cjs
  - node --check app/js/agent-api.js
  - node --check tests/v5.2.0/agent-availability-error-privacy.contract.test.cjs
  - node tests/v5.2.0/015-local-electron-acceptance.cjs
  - git diff --check -- app/js/agent-api.js tests/v5.2.0/agent-availability-error-privacy.contract.test.cjs docs/delivery-reports/XJ-5.2.0-AGENT-AVAILABILITY-ERROR-PRIVACY-031.md
  - Get-FileHash app/js/agent-core.js,app/js/agent-tools.js,app/js/xinjing-chat.js,app/index.html,app/chat-home.html,app/js/clinical-agent-runtime.js,package.json,package-lock.json -Algorithm SHA256
- checkpoints:
  - A: reproduce all raw availability/constructor leaks in real VM and recompute protected hashes
  - B: focused privacy/error-code/normal-path contract passes
  - C: exact allowlist diff, full contracts, controlled Electron, protected hashes, and adversarial self-review before delivery
- rollback: restore only the allowlisted source/test files to the 031 baseline and remove this report; preserve 023-030 and all unrelated changes; never reset, clean or revert unknown work
- stop_conditions:
  - need to modify any shared runtime/UI/persistence/IPC/public contract outside allowlist
  - raw secret remains, normal behavior regresses, protected hash drift, second writer, mock-only green, or real-data/network action
- delivery_report: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-AVAILABILITY-ERROR-PRIVACY-031.md
- acceptance_owner: /root
- next_after_acceptance: only after independent Codex intake may plan the next bounded 5.2.0 stage; this stage does not mark release-ready or authorize packaging/publishing

## Agent Instructions

你是执行代理，不是最终验收人；/root 负责范围、架构、冲突协调和最终验收。你不是独自在代码库中工作，必须保留未知改动。只修改 allowlist，不得创建提交。开始前读取 AGENTS.md、030 delivery report 和真实 agent-api.js，先用真实 VM 复现 App/AI 异常和 chat 构造异常的 raw-secret 泄露。

交付前必须先做独立内部对抗审查，单列章节，记录真实 VM 入口、四类异常、正常 false/unsupported 路径、成功 chat、result/log 隐私、异步等待、写集、保护哈希和 mock 假绿风险。报告用简体中文，列出 [STATUS]、[ARTIFACTS]、[VALIDATION]、P0-P3、残余风险和未授权动作，末行严格为：

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-AVAILABILITY-ERROR-PRIVACY-031.md
