# Task Card: XJ-5.2.0-SUPERVISION-STREAM-CALLBACK-021

- task_id: XJ-5.2.0-SUPERVISION-STREAM-CALLBACK-021
- objective: Restore the production streaming callback path for standard supervision execution. The confirmed supervision flow must forward onDelta from the production runtime through the adapter/executor boundary to the real AI.send callback, while preserving confirmation, cancellation, timeout, stale-result, draft-only, lifecycle, and privacy semantics accepted in stage 020.
- owner: gpt-6.1-sol-low
- manager: codex (/root)
- project_root: D:/xinjing-electron
- branch_or_worktree: release/3.6.3-mac; shared worktree; do not switch branches or create commits
- base_commit: eb16e2b74e6ab919a782b8bc6f66bfe9524431f2
- active_release_train: 5.2.0 implementation; stage 021; not release-ready
- config_evidence_id: cfg-5.2.0-20261005-supervision-stream-callback-021
- agent_profile_id: gpt-6.1-sol-low
- contract_id: xj-5.2.0-supervision-stream-callback-v1
- write_lock_id: lock-5.2.0-supervision-stream-callback-021
- benchmark_manifest: synthetic runtime-to-adapter-to-executor-to-AI.send delta delivery, final-before-delta rejection, cancellation/late-delta suppression, privacy projection, mutation-sensitive callback forwarding v1
- visual_baseline: existing supervision page; no layout or skin redesign; preserve 1024x700, 1366x768, 1920x1080 and reduced-motion behavior
- prerequisites:
  - XJ-5.2.0-SUPERVISION-OUTCOME-CONVERGENCE-020 accepted by Codex intake
  - current runtime/adapter/bridge production chain inspected; runtime currently omits onDelta in its Adapter call
- current_target_hashes:
  - app/js/clinical-agent-runtime.js: FB3C440A59E136AB68AFBD9AE025BF62960F45FCD5AF9D652194F40B7657C945
  - app/js/clinical-agent-adapter.js: 7D7E0D1E53F7E8CDDA321A85F31BD7A22FB07FC12A0C6FCE34A0512B3F64CC4D
  - app/js/clinical-agent-production-bridge.js: 46F13F0B4C4B53238582D014D79BE6CDEAAF7859FBCA16BDC2787F81D35DA276
  - app/js/supervision.js: E0E444E15FE276AC8D1F8D3963BECB2C2ED68664AB0A9C682A58641C145ADF81
  - app/supervision.html: 4404F4A7D15024A41FA9058C9010A2A47D0A3CB45EEBB6184228714205A2EBD8
  - app/js/clinical-context.js: 09536023837266F2D560CE8D2500A6EA6BE0A25C53F97CC1C781EB46A23C1B64
  - app/js/store.js: 00473C3984B95429BE2E82AAD3C61369A2A1C2459CACA7C77CF84A66277504A7
  - app/js/ai.js: 8900E053FDA0FFA6AF0BF51FC25988E7EEE53651D74622250FE831809BF2FC69
  - package.json: B74E0AA8F9B645D06647096545A3C611C112EF217AABADEA407B1950D629FC72
  - package-lock.json: FDB8D11766CE697211B6C21AEE91E488ECD8E12FEAFF725C568D62906156CB03
- write_allowlist:
  - app/js/clinical-agent-runtime.js (forward execution onDelta only)
  - tests/v5.2.0/clinical-agent-runtime.contract.test.cjs (behavioral callback contract additions only)
  - docs/delivery-reports/XJ-5.2.0-SUPERVISION-STREAM-CALLBACK-021.md (new report)
- forbidden:
  - supervision.html, supervision.js, clinical-agent-adapter.js, clinical-agent-production-bridge.js, clinical-context.js, store.js, ai.js, accepted router/run/context/workflow modules
  - package/version/build/release files, Electron/main/preload, runner logic, network, real clinical data, commits, merges, pushes, signing, upload or publish
- required_behavior:
  - Runtime.execute(confirmed, { onDelta }) must pass the callback to the Adapter execution options.
  - The real fromGlobals -> Adapter -> executor -> AI.send chain must invoke the callback before final completion when the provider emits a delta.
  - Callback payload exposed to the page must remain the safe content projection already defined by AI.send; never expose messages, payload, executor, lifecycle handles, private context, raw errors, or provider metadata.
  - Cancellation, timeout, stale snapshot, provider failure, and late callbacks must not produce a valid post-cancel UI stream; final outcome semantics from stage 020 remain unchanged.
  - Existing confirmation gate, action-run ordering, draft-only output, save/export separation and exactly-once lifecycle terminal handling remain unchanged.
- required_tests:
  - Add a behavioral contract through the real Runtime/Adapter/executor boundary; do not rely solely on source-string matching.
  - Assert onDelta is received before final draft completion in a successful run.
  - Assert callback is not exposed on projected metadata and no private fields leak.
  - Assert cancellation suppresses valid late UI deltas and existing failure/cancel behavior remains intact.
  - Preserve and rerun the full tests/v5.2.0/*.contract.test.cjs suite and controlled Electron runner.
- required_adversarial_tests:
  - Remove runtime onDelta forwarding: focused test must fail.
  - Replace real executor with a mock-only shortcut or invoke callback after final settle: focused test must fail.
  - Emit a delta after cancellation: test must reject it as a valid UI stream.
  - Expose payload/messages/private context/executor through callback or projection: privacy assertion must fail.
  - Ensure tests await asynchronous completion and are not green from static source matching.
- acceptance_commands:
  - node --test tests/v5.2.0/clinical-agent-runtime.contract.test.cjs
  - node --test tests/v5.2.0/*.contract.test.cjs
  - node --check app/js/clinical-agent-runtime.js
  - node --check tests/v5.2.0/clinical-agent-runtime.contract.test.cjs
  - node tests/v5.2.0/015-local-electron-acceptance.cjs
  - git diff --check -- app/js/clinical-agent-runtime.js tests/v5.2.0/clinical-agent-runtime.contract.test.cjs docs/agent-coordination/v5.2.0/tasks/XJ-5.2.0-SUPERVISION-STREAM-CALLBACK-021.md docs/delivery-reports/XJ-5.2.0-SUPERVISION-STREAM-CALLBACK-021.md
  - Get-FileHash app/js/clinical-agent-adapter.js,app/js/clinical-agent-production-bridge.js,app/supervision.html,app/js/clinical-context.js,app/js/store.js,app/js/ai.js,package.json,package-lock.json -Algorithm SHA256
- checkpoints:
  - A: read AGENTS.md, relevant UI references, 020 report, runtime/adapter/bridge chain and hashes; confirm no second writer and allowlist before edits
  - B: focused real-chain delta test passes, including mutation-sensitive removal of runtime forwarding
  - C: inspect exact diff, rerun full contracts and controlled Electron evidence, recompute protected hashes, complete adversarial self-review, and write report before delivery
- rollback: restore only allowlisted runtime/test and remove this stage report; preserve 020 report/artifacts and all unrelated worktree changes; never reset, clean or revert unknown work
- stop_conditions:
  - need to modify adapter, bridge, supervision UI, core data schema or weaken an existing contract
  - inability to prove pre-final callback delivery or cancellation/late-delta suppression
  - protected hash drift, second writer, allowlist drift, mock-only green or real-data/network action
- delivery_report: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-SUPERVISION-STREAM-CALLBACK-021.md
- acceptance_owner: /root
- next_after_acceptance: only after independent Codex intake may plan the next bounded 5.2.0 stage; this stage does not mark release-ready or authorize packaging/publishing

## Agent Instructions

你是执行代理，不是最终验收人；/root 负责范围、架构、冲突协调和最终验收。你不是独自在代码库中工作，必须保留未知改动。只修改 allowlist，不得创建提交。

开始前读取项目 AGENTS.md、xinjing-ui-system 相关参考、020任务卡与最终报告、runtime真实调用链和当前哈希。实现必须沿用现有生产链，不得绕过 Adapter/Executor 或恢复直接 AI.send。

交付前必须先做独立内部对抗审查，单列章节，记录真实入口、成功/取消/失败/late-delta、私有字段隔离、写集与哈希、测试是否等待 Promise，以及是否存在 mock/proxy/源码字符串假绿。报告使用简体中文，列出 [STATUS]、[ARTIFACTS]、[VALIDATION]、P0-P3、残余风险和未授权动作，最后一行严格为：

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-SUPERVISION-STREAM-CALLBACK-021.md
