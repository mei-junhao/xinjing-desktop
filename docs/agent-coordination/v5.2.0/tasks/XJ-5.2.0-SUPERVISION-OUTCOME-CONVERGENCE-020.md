# Task Card: XJ-5.2.0-SUPERVISION-OUTCOME-CONVERGENCE-020

- task_id: XJ-5.2.0-SUPERVISION-OUTCOME-CONVERGENCE-020
- objective: Harden the accepted standard supervision production path so bridge/executor Promise rejection and synchronous bridge failures converge to a visible, retryable terminal result instead of leaving the page busy or silently pending. Preserve the existing confirmation gate, action-run ordering, cancellation, stale checks, draft-only output, save/export separation, and privacy boundary.
- owner: gpt-6.1-sol-low
- manager: codex (/root)
- project_root: D:/xinjing-electron
- branch_or_worktree: release/3.6.3-mac; shared worktree; do not switch branches or create commits
- base_commit: eb16e2b74e6ab919a782b8bc6f66bfe9524431f2
- active_release_train: 5.2.0 implementation; stage 020; not release-ready
- config_evidence_id: cfg-5.2.0-20261005-supervision-outcome-convergence-020
- agent_profile_id: gpt-6.1-sol-low
- contract_id: xj-5.2.0-supervision-outcome-convergence-v1
- write_lock_id: lock-5.2.0-supervision-outcome-convergence-020
- benchmark_manifest: synthetic bridge rejection, synchronous bridge throw, provider failure, user cancellation, retry affordance, busy-release, stale/late-result suppression, safe error projection and no-persistence fixtures v1
- visual_baseline: existing supervision page; no layout or skin redesign; preserve 1024x700, 1366x768, 1920x1080 and reduced-motion behavior
- prerequisites:
  - XJ-5.2.0-SUPERVISION-PRODUCTION-INTEGRATION-015 accepted by Codex intake
  - current controlled Electron artifact `tests/v5.2.0/artifacts/run-1791161480350-29552/` remains the baseline negative provider evidence
- current_target_hashes:
  - app/js/supervision.js: 2E64DB9079AFF9EABF264ABB9AADF2A21584E9DC65C51A539FD098EC43EA6E42
  - tests/v5.2.0/supervision-production-integration.contract.test.cjs: F5856700921EEA95C38882D014D79BE6CDEAAF7859FBCA16BDC2787F81D35DA276
  - app/js/clinical-agent-runtime.js: FB3C440A59E136AB68AFBD9AE025BF62960F45FCD5AF9D652194F40B7657C945
  - app/js/clinical-agent-adapter.js: 7D7E0D1E53F7E8CDDA321A85F31BD7A22FB07FC12A0C6FCE34A0512B3F64CC4D
  - app/js/clinical-agent-production-bridge.js: 46F13F0B4C4B53238582D014D79BE6CDEAAF7859FBCA16BDC2787F81D35DA276
  - app/supervision.html: 4404F4A7D15024A41FA9058C9010A2A47D0A3CB45EEBB6184228714205A2EBD8
  - package.json: B74E0AA8F9B645D06647096545A3C611C112EF217AABADEA407B1950D629FC72
  - package-lock.json: FDB8D11766CE697211B6C21AEE91E488ECD8E12FEAFF725C568D62906156CB03
- write_allowlist:
  - app/js/supervision.js (standard supervision outcome handling only)
  - tests/v5.2.0/supervision-production-integration.contract.test.cjs (behavioral contract additions only)
  - docs/delivery-reports/XJ-5.2.0-SUPERVISION-OUTCOME-CONVERGENCE-020.md (new report)
- forbidden:
  - app/supervision.html and all CSS/layout/skin changes
  - clinical-agent-runtime.js, clinical-agent-adapter.js, clinical-agent-production-bridge.js and accepted task/router/run/context/workflow modules
  - clinical-context.js, store.js, ai.js, supervision-core.js, multi-school/package/upload/save/export business logic
  - package/version/build/release files, Electron/main/preload, network, real clinical data, commits, merges, pushes, signing, upload or publish
- required_behavior:
  - `callAI`/standard generation must settle exactly once for: prepared-context failure, confirmation cancellation, bridge.confirm failure, bridge.execute resolved provider failure, bridge.execute rejection, and synchronous bridge/execute throw.
  - A rejected/throwing execution must render the existing safe failure path (or equivalent stable user-facing error), clear the active controller and release `busy`; it must not leave the page waiting forever and must preserve retry metadata.
  - Raw Error messages, stack traces, private context, messages, executor, lifecycle handles and AI payloads must not reach UI state, JSON evidence or persisted records.
  - Existing provider-failure evidence (`ai-failed`) and cancellation semantics remain unchanged; successful drafts remain preview-only until explicit `saveSup`.
  - No direct standard-path `AI.send` or ClinicalContext lifecycle calls may be reintroduced.
  - No duplicate result block, duplicate lifecycle terminal call, late success render, or post-cancel completion is permitted.
- required_tests:
  - Add a behavioral contract using the real production module boundary or a narrowly extracted pure outcome helper; do not rely solely on source-string matching.
  - Cover resolved `{ok:false}` provider failure, rejected execute Promise, synchronous execute throw, confirmation cancel, and retry/busy release.
  - Assert safe stable error classification and absence of raw error text/private fields.
  - Preserve and rerun the full `tests/v5.2.0/*.contract.test.cjs` suite and the existing controlled Electron runner; do not weaken its PASS predicate.
- required_adversarial_tests:
  - Remove the rejection catch, swallow `{ok:false}`, resolve success before the Promise settles, skip busy cleanup, expose `error.message`, or render a late success after cancellation; focused tests must fail.
  - Restore a direct `AI.send`/ClinicalContext call, duplicate completion/failure, or bypass the existing bridge; integration assertions must fail.
  - Ensure the test is not green from a mock-only path or static source substring.
- acceptance_commands:
  - node --test tests/v5.2.0/supervision-production-integration.contract.test.cjs
  - node --test tests/v5.2.0/*.contract.test.cjs
  - node --check app/js/supervision.js
  - node --check tests/v5.2.0/supervision-production-integration.contract.test.cjs
  - node tests/v5.2.0/015-local-electron-acceptance.cjs
  - git diff --check -- app/js/supervision.js tests/v5.2.0/supervision-production-integration.contract.test.cjs docs/agent-coordination/v5.2.0/tasks/XJ-5.2.0-SUPERVISION-OUTCOME-CONVERGENCE-020.md docs/delivery-reports/XJ-5.2.0-SUPERVISION-OUTCOME-CONVERGENCE-020.md
  - Get-FileHash app/js/clinical-agent-runtime.js,app/js/clinical-agent-adapter.js,app/js/clinical-agent-production-bridge.js,app/supervision.html,app/js/clinical-context.js,app/js/store.js,app/js/ai.js,package.json,package-lock.json -Algorithm SHA256
- checkpoints:
  - A: read AGENTS.md, xinjing-ui-system references, 015 accepted report, current supervision call chain and hashes; confirm no second writer and allowlist before edits
  - B: focused rejection/throw/cancel tests pass with raw output before broad regression
  - C: inspect exact diff, rerun full contracts and controlled Electron evidence, recompute protected hashes, complete adversarial self-review, and write report before delivery
- rollback: restore only the allowlisted supervision source/test and remove this stage report; preserve 015 report/artifacts and all unrelated worktree changes; never reset, clean or revert unknown work
- stop_conditions:
  - need to change bridge/runtime/core data/UI schema or weaken an existing contract
  - inability to prove busy release or exactly-once terminal handling
  - protected hash drift, second writer, allowlist drift, mock-only green or real-data/network action
- delivery_report: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-SUPERVISION-OUTCOME-CONVERGENCE-020.md
- acceptance_owner: /root
- next_after_acceptance: only after independent Codex intake may plan the next bounded 5.2.0 stage; this stage does not mark release-ready or authorize packaging/publishing

## Agent Instructions

你是执行代理，不是最终验收人；`/root` 负责范围、架构、冲突协调和最终验收。你不是独自在代码库中工作，必须保留未知改动。只修改 allowlist，不得创建提交。

开始前读取项目 `AGENTS.md`、`xinjing-ui-system` 的信息架构/组件/QA参考、015任务卡与最终报告、`supervision.js`真实调用链和当前哈希。实现必须沿用现有 UI 文案、失败卡片和重试交互，不做视觉重构。

交付前必须进行独立内部对抗审查，单列章节，记录真实入口、同步/异步失败、取消/重试/late-result、私有字段隔离、写集与哈希、测试是否等待 Promise，以及是否存在 mock/proxy/源码字符串假绿。报告使用简体中文，列出 `[STATUS]`、`[ARTIFACTS]`、`[VALIDATION]`、P0-P3、残余风险和未授权动作，最后一行严格为：

`DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-SUPERVISION-OUTCOME-CONVERGENCE-020.md`
