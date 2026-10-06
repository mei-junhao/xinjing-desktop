# Task Card: XJ-5.2.0-PRODUCTION-CLINICAL-BRIDGE-014

- task_id: XJ-5.2.0-PRODUCTION-CLINICAL-BRIDGE-014
- objective: Add the production clinical lifecycle bridge that composes the accepted runtime facade with the real ClinicalContext action-run boundary without wiring any page. After the caller has explicitly confirmed a prepared standard-supervision request, the bridge must create exactly one `ClinicalContext.createActionRun` immediately before AI execution, bind its `clinicalActionRunId` to the runtime result, complete it exactly once on an accepted draft, and fail it exactly once on cancellation, timeout, stale-after, provider/executor failure, malformed draft, or lifecycle failure. The bridge must keep raw ClinicalContext private, preserve draft-only output and existing runtime cancellation/freshness semantics, and never save a clinical record.
- owner: gpt-6.1-sol-low
- manager: codex (/root)
- project_root: D:/xinjing-electron
- branch_or_worktree: release/3.6.3-mac; shared worktree; do not switch branches or create commits
- base_commit: eb16e2b74e6ab919a782b8bc6f66bfe9524431f2
- active_release_train: 5.2.0 implementation; stage 014; not release-ready
- config_evidence_id: cfg-5.2.0-20261005-production-clinical-bridge-014
- agent_profile_id: gpt-6.1-sol-low
- contract_id: xj-5.2.0-production-clinical-bridge-v1
- write_lock_id: lock-5.2.0-production-clinical-bridge-014
- protected_files_manifest_hash: not-applicable; recompute individual hashes before and after edits
- benchmark_manifest: synthetic confirmed supervision lifecycle, action-run creation ordering, clinicalActionRunId binding, exactly-once complete/fail, cancellation, timeout, stale-before/after, provider error, malformed draft, replay, lifecycle failure, no-save and private-context fixtures v1
- visual_baseline: not-applicable; no UI/HTML/CSS/Electron changes authorized
- prerequisites:
  - XJ-5.2.0-PRODUCTION-SUPERVISION-ENTRY-CONTRACT-013 accepted by Codex intake
  - XJ-5.2.0-RUNTIME-FACADE-009-ESCALATION-012 accepted by Codex intake
- current_target_hashes:
  - app/js/clinical-agent-runtime.js: B46ABFD55F0E045B23BEB1C5303E025515C1E484A6420537397744132366FB5E
  - app/js/clinical-agent-adapter.js: 826DF98083B8D97BEF01092DD5307712B17DA974D2C8ABEB809C974DB3A4856E
  - app/js/clinical-agent-tasks.js: 497316894C7ED7C637617CBB6757D05719ED705A9A297FAF4DB4BB964F36612C
  - app/js/clinical-agent-router.js: B87C6DA6F7287A5326E771BB98C2B17202316F4935DD20D985F6526EEFB776F3
  - app/js/clinical-agent-run.js: 858D743C5A1B16730C966C26DEF334852BDAB964612EA11596CBD607C11A3D57
  - app/js/clinical-agent-context-bridge.js: 65730ABFC6CDDF29E17C7FA923B393C49F08703D32764C191506DA3F95FD43E6
  - app/js/clinical-agent-workflow.js: 33A04DC1C5E312F2EF19821A58BDC400B311205A340A165E1D974C16C3F55227
  - app/js/clinical-context.js: 09536023837266F2D560CE8D2500A6EA6BE0A25C53F97CC1C781EB46A23C1B64
  - app/js/store.js: 00473C3984B95429BE2E82AAD3C61369A2A1C2459CACA7C77CF84A66277504A7
  - app/js/agent-core.js: 00F758CE37702108AF4FF9BF48C294EDCB5BC32480B6DD6AD6DFD7F7235A5AD2
  - app/js/agent-tools.js: FBD7BBF2BCA95BA025420998AB96511BB517725028ECD2FA9998A7C80A644D2B
  - app/js/supervision.js: 01ED97151DDA7F90F0494E896852F72F5FA724203F5FC3474773B096990694BE
  - app/supervision.html: CD6AAA48E99312086451FCB8D5BBC0929A7A7B513BFCBC9408A28BB56270C864
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
  - app/js/clinical-agent-runtime.js
  - app/js/clinical-agent-adapter.js
  - app/js/clinical-agent-production-bridge.js
  - tests/v5.2.0/clinical-agent-runtime.contract.test.cjs
  - tests/v5.2.0/clinical-agent-adapter.contract.test.cjs
  - tests/v5.2.0/clinical-agent-production-bridge.contract.test.cjs
  - docs/delivery-reports/XJ-5.2.0-PRODUCTION-CLINICAL-BRIDGE-014.md
- forbidden:
  - app/js/clinical-agent-tasks.js, app/js/clinical-agent-router.js, app/js/clinical-agent-run.js, app/js/clinical-agent-context-bridge.js, app/js/clinical-agent-workflow.js
  - app/js/clinical-context.js, app/js/store.js, app/js/agent-core.js, app/js/agent-tools.js, app/js/ai.js
  - app/js/supervision.js, app/supervision.html, all other UI/HTML/CSS/Electron/preload/main/network/persistence/release/package/version files
  - changing the accepted 013 contract semantics, arbitrary task aliases, direct page integration, direct Store calls outside injected ClinicalContext lifecycle spies, saveSupervision, durable clinical record writes, commits, merges, pushes, uploads, signing, publishing, real clinical data or external messages
- lifecycle_contract:
  - Add a private dependency-level lifecycle hook to the accepted adapter/runtime composition; do not expose raw `ClinicalContext`, messages, Store handles or lifecycle callbacks through public state/projection.
  - `ClinicalAgentProductionBridge.fromGlobals({ Runtime?, ClinicalAgentRuntime?, ClinicalContext?, AI?, timeoutMs? })` resolves the accepted runtime and real globals, and returns the same controlled `prepare`, `confirm`, `execute`, `cancel`, `project`, `isRuntimeState` surface plus no extra raw handle. `withDependencies` must permit synthetic lifecycle spies without browser globals.
  - `prepare` and `confirm` remain non-AI; no action-run is created before explicit confirmation. A failed confirmation must not invoke `createActionRun`, AI or executor.
  - At execution, after adapter freshness-before passes and immediately before the executor/AI call, invoke `ClinicalContext.createActionRun(privateBuiltContext)` exactly once. If it returns null/invalid, fail closed and do not call AI.
  - The lifecycle receives only private adapter context internally. It must bind the returned action-run id as `clinicalActionRunId` in draft-ready and post-admission failure results, while public projections before execution remain metadata-only.
  - On accepted draft, call `ClinicalContext.completeActionRun(actionRunId, { kind: 'supervision-preview', summary: <draft text>, citations: [] })` exactly once. Do not call `saveSupervision` or any durable clinical-object API.
  - On cancellation, timeout, stale-after, provider/executor error, malformed draft, or completion failure after action-run creation, call `ClinicalContext.failActionRun(actionRunId, stable error, status)` exactly once. Pre-admission stale/cancelled failures have no action-run to fail.
  - Late callback/promise results after cancellation/timeout must not complete the action-run or return success. Replay of a confirmed/terminal handle must not create a second action-run or call AI.
  - Preserve existing `session-review` and `supervision-preview` task IDs, explicit confirmation, canonical snapshot, source identity, dual freshness, per-execution cancellation signal and draft-only result semantics.
- required_tests:
  - synthetic positive standard supervision: prepare -> confirm -> createActionRun -> AI/executor -> completeActionRun -> `draft-ready` with one `clinicalActionRunId`; assert action-run creation precedes AI.
  - independent empty-source and all four bound source shapes remain admitted through bridge; no page/UI dependency.
  - confirmation false/missing, stale-before and cancel-before produce zero action-runs and zero AI calls.
  - provider error, malformed draft, stale-after, user cancel during pending AI, timeout and late callback/promise each fail exactly once, call failActionRun once, never complete, and never call saveSupervision.
  - lifecycle create/complete/fail returning null or throwing fails closed without leaking raw error/context.
  - second execute/cancel/replay cannot create another action-run or call executor.
  - `clinicalActionRunId` is preserved in successful and post-admission failure metadata but raw context/messages/body/prompt/Store/executor/lifecycle handles are absent from public JSON.
  - existing runtime/adaptor contracts and all v5.2.0 contracts remain green.
- required_adversarial_tests:
  - remove the confirmation gate, move createActionRun after AI, call AI when createActionRun fails, omit exactly-once guard, complete after cancellation, swallow lifecycle failure, use a second context build, expose raw context, call saveSupervision, or remove await; focused tests must turn red.
  - mutate `kind` away from `supervision-preview` or bind a different action-run id; completion assertions must fail.
- acceptance_commands:
  - node --test tests/v5.2.0/clinical-agent-production-bridge.contract.test.cjs
  - node --test tests/v5.2.0/clinical-agent-adapter.contract.test.cjs tests/v5.2.0/clinical-agent-runtime.contract.test.cjs tests/v5.2.0/clinical-agent-production-bridge.contract.test.cjs
  - node --test tests/v5.2.0/clinical-agent-tasks.contract.test.cjs tests/v5.2.0/clinical-agent-router.contract.test.cjs tests/v5.2.0/clinical-agent-run.contract.test.cjs tests/v5.2.0/clinical-agent-context-bridge.contract.test.cjs tests/v5.2.0/clinical-agent-workflow.contract.test.cjs tests/v5.2.0/clinical-agent-adapter.contract.test.cjs tests/v5.2.0/clinical-agent-runtime.contract.test.cjs tests/v5.2.0/clinical-agent-production-bridge.contract.test.cjs
  - node --check app/js/clinical-agent-adapter.js; node --check app/js/clinical-agent-runtime.js; node --check app/js/clinical-agent-production-bridge.js; node --check tests/v5.2.0/clinical-agent-adapter.contract.test.cjs; node --check tests/v5.2.0/clinical-agent-runtime.contract.test.cjs; node --check tests/v5.2.0/clinical-agent-production-bridge.contract.test.cjs
  - git diff --check -- app/js/clinical-agent-adapter.js app/js/clinical-agent-runtime.js app/js/clinical-agent-production-bridge.js tests/v5.2.0/clinical-agent-adapter.contract.test.cjs tests/v5.2.0/clinical-agent-runtime.contract.test.cjs tests/v5.2.0/clinical-agent-production-bridge.contract.test.cjs docs/agent-coordination/v5.2.0/tasks/XJ-5.2.0-PRODUCTION-CLINICAL-BRIDGE-014.md docs/delivery-reports/XJ-5.2.0-PRODUCTION-CLINICAL-BRIDGE-014.md
  - Get-FileHash app/js/clinical-agent-tasks.js,app/js/clinical-agent-router.js,app/js/clinical-agent-run.js,app/js/clinical-agent-context-bridge.js,app/js/clinical-agent-workflow.js,app/js/clinical-context.js,app/js/store.js,app/js/agent-core.js,app/js/agent-tools.js,app/js/supervision.js,app/supervision.html,package.json,package-lock.json -Algorithm SHA256
- checkpoints:
  - A: read AGENTS.md, 013 accepted report, runtime/adapter contracts and real ClinicalContext lifecycle; recompute all hashes and confirm no second writer.
  - B: run expected-red lifecycle ordering/once-only probes before implementation, then focused bridge tests.
  - C: run full contracts, node checks, diff/hash checks, inspect public JSON and perform internal adversarial review before delivery.
- rollback: restore only runtime/adapter to their pre-014 contents and remove the new bridge/test/report; preserve 013 and all unrelated worktree changes; never reset, clean or revert unknown work.
- stop_conditions:
  - need to modify ClinicalContext, Store, UI, page, AI, network, Electron, package/version or release files
  - inability to guarantee action-run ordering/exactly-once or private context isolation
  - protected hash drift, second writer, allowlist drift, fake-green test, real clinical data, or lifecycle behavior requiring a new architecture decision
- delivery_report: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-PRODUCTION-CLINICAL-BRIDGE-014.md
- acceptance_owner: /root
- next_after_acceptance: create the separate supervision page integration card; this stage does not modify `supervision.js`/HTML and does not mark 5.2.0 release-ready

## Agent Instructions

你是执行代理，不是项目负责人；`/root` 保留架构、范围、集成和最终验收权。你不是独自在代码库中工作，必须保留未知改动。先读项目 `AGENTS.md`、本任务卡、013 accepted report、runtime/adapter source/tests 和真实 ClinicalContext lifecycle。Checkpoint A 未通过不得写入。

只修改 allowlist；不要在 UI 中重复 build context、create action-run 或调用 AI。不得改动 013 任务语义来凑测试，不得通过删除断言、源码字符串匹配、替代实现、吞错、提前成功、重复 build 或伪造证据变绿。

交付前必须先做独立内部对抗审查，单列“内部对抗审查”章节，覆盖真实 CommonJS/UMD 入口、action-run 创建顺序、confirm gate、exactly-once complete/fail、cancel/timeout/late result、lifecycle throw/null、raw context isolation、no-save、replay、写集和保护哈希、测试对 await/生命周期顺序变异是否变红。报告记录实际命令与退出码、P0–P3、评分、残余风险、未授权动作、PASS/FAIL；最后一行严格为：

`DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-PRODUCTION-CLINICAL-BRIDGE-014.md`
