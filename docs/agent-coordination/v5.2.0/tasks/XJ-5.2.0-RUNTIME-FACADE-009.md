# Task Card: XJ-5.2.0-RUNTIME-FACADE-009

- task_id: XJ-5.2.0-RUNTIME-FACADE-009
- objective: Add a runtime facade that composes the accepted workflow and adapter into one controlled, non-persisting execution entry. The facade must admit routed `session-review` and `supervision-question-builder` requests, preserve explicit human confirmation, bind each workflow handle to one adapter handle, execute through the real `ClinicalContext.build` shape and injected `AI.send` shape, return draft-only results, and fail closed on stale/cancelled/error paths. This stage creates the real callable vertical loop but does not wire any page, UI, Store, durable write, Electron, or release path.
- owner: gpt-6.1-sol-low
- manager: codex (/root)
- project_root: D:/xinjing-electron
- branch_or_worktree: release/3.6.3-mac; shared worktree; do not switch branches or create commits
- base_commit: eb16e2b74e6ab919a782b8bc6f66bfe9524431f2
- active_release_train: 5.2.0 implementation; stage 009 after accepted stages 001–008; not release-ready
- config_evidence_id: cfg-5.2.0-20261005-runtime-facade-009
- agent_profile_id: gpt-6.1-sol-low
- contract_id: xj-5.2.0-runtime-workflow-adapter-facade-v1
- write_lock_id: lock-5.2.0-runtime-facade-009
- benchmark_manifest: synthetic runtime facade admission/confirmation/adapter-binding/AI-send/cancel/stale/error/no-persistence fixtures v1
- visual_baseline: not-applicable; no UI or Electron changes authorized
- prerequisites:
  - XJ-5.2.0-AGENT-CONTRACT-001 through XJ-5.2.0-SUPERVISION-WORKFLOW-008 accepted by Codex intake
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
  - tests/v5.2.0/clinical-agent-workflow.contract.test.cjs: BC76C74DCDCB1594D0B150B9A6DAFD9BE1D0D7548753E2FF480BD10649AE909D
  - tests/v5.2.0/clinical-agent-adapter.contract.test.cjs: CBB30E83F42E39C209E2C25836AB7C656E457C6051979048A6C3E8872A150E13
- write_allowlist:
  - app/js/clinical-agent-runtime.js (new facade only)
  - tests/v5.2.0/clinical-agent-runtime.contract.test.cjs (new contract only)
  - docs/delivery-reports/XJ-5.2.0-RUNTIME-FACADE-009.md (new report)
- forbidden:
  - all existing 001–008 source/test/report files; no changes to workflow or adapter in this stage
  - app/js/clinical-context.js, app/js/store.js, app/js/agent-core.js, app/js/agent-tools.js, app/js/ai.js, app/js/supervision-core.js, app/js/supervision.js
  - all UI/HTML/CSS/Electron/preload/main/network/persistence/release/package/version files
  - commits, pushes, merges, uploads, signing, publishing, real clinical data or external messages
- required_public_api:
  - `withDependencies({ workflow, adapter, executor? })` returns `{ prepare, confirm, execute, cancel, isRuntimeState, project }`.
  - `fromGlobals({ workflow?, ClinicalContext?, AI?, timeoutMs? })` resolves the real global-shaped dependencies and creates an executor that calls `AI.send(messages, callback, options)`; it must return response content as a draft or stable `ai-failed`/`ai-cancelled` failure without exposing raw provider errors.
  - `prepare(request)` calls workflow.prepare and adapter.create exactly once, binds their accepted handles privately, and returns only workflow metadata. Adapter admission failure must fail closed and never leave a live workflow handle.
  - `confirm(prepared, { confirmed: true })` is the only path to execution; false/missing confirmation does not call AI or executor.
  - `execute(confirmed, options?)` executes the bound adapter handle once, forwards cancellation to adapter and AI signal when available, returns `draft-ready` with the user-facing task ID on success, and maps stale/cancelled/executor/AI failures to stable reasons without persistence.
  - `cancel(preparedOrConfirmed, reason?)` invalidates both private handles and is idempotent for terminal states; subsequent execute cannot call adapter or AI.
  - `project`/errors contain metadata only: no messages, content, prompt, rawText, modelInput, ClinicalContext, Store, executor or persistence handles.
- required_mapping:
  - `supervision-question-builder` must reach adapter context build as `supervision-ai`; `session-review` maps to `session-review`; arbitrary aliases fail closed.
  - `AI.send` receives the adapter payload messages and no Store/persistence references. The facade must not call `ClinicalContext.createActionRun`, `completeActionRun`, `failActionRun`, `Store`, `saveSupervision` or any durable API.
  - If timeout/cancellation is implemented, late AI callbacks/promises must not write success after cancellation or stale invalidation.
- required_behavior_tests:
  - synthetic positive session-review and supervision-question-builder prepare -> confirm -> execute -> draft-ready, with real adapter context/build argument assertions and AI.send payload/metadata assertions.
  - adapter rejection, missing/false confirmation, unknown task, source mismatch, stale-before/after, AI error, malformed AI response, cancellation before/mid/after, timeout/late result and old-handle replay all fail closed; rejected admission proves adapter/AI call count is zero.
  - exact task mapping assertion: supervision-question-builder -> `context.build('supervision-ai', ...)`, session-review -> `context.build('session-review', ...)`.
  - no-persistence spies remain unused; project/error JSON contains no sensitive/private fields; executor payload mutation cannot alter context.
- required_adversarial_review:
  - remove adapter binding, use workflow-only success, call AI before confirmation, accept request snapshotKey instead of adapter canonical key, swallow `{error}` from AI, resolve after cancellation, remove late-result guard, expose private handles, call any persistence method, or let one handle execute twice; focused tests must turn red.
- acceptance_commands:
  - node --test tests/v5.2.0/clinical-agent-runtime.contract.test.cjs
  - node --test tests/v5.2.0/clinical-agent-tasks.contract.test.cjs tests/v5.2.0/clinical-agent-router.contract.test.cjs tests/v5.2.0/clinical-agent-run.contract.test.cjs tests/v5.2.0/clinical-agent-context-bridge.contract.test.cjs tests/v5.2.0/clinical-agent-workflow.contract.test.cjs tests/v5.2.0/clinical-agent-adapter.contract.test.cjs tests/v5.2.0/clinical-agent-runtime.contract.test.cjs
  - node --check app/js/clinical-agent-runtime.js; node --check tests/v5.2.0/clinical-agent-runtime.contract.test.cjs
  - node --check app/js/clinical-agent-workflow.js; node --check app/js/clinical-agent-adapter.js
  - git diff --check -- app/js/clinical-agent-runtime.js tests/v5.2.0/clinical-agent-runtime.contract.test.cjs docs/agent-coordination/v5.2.0/tasks/XJ-5.2.0-RUNTIME-FACADE-009.md docs/delivery-reports/XJ-5.2.0-RUNTIME-FACADE-009.md
  - Get-FileHash app/js/agent-core.js,app/js/clinical-context.js,app/js/store.js,app/js/agent-tools.js,app/js/clinical-agent-tasks.js,app/js/clinical-agent-router.js,app/js/clinical-agent-run.js,app/js/clinical-agent-context-bridge.js,app/js/clinical-agent-workflow.js,app/js/clinical-agent-adapter.js,package.json,package-lock.json -Algorithm SHA256
- checkpoints:
  - A: read AGENTS.md, this card, accepted 001–008 reports/source/tests; recompute protected hashes and confirm no second writer before edits
  - B: focused runtime contract positive/negative paths pass before broad regression
  - C: all commands, hash/diff inspection and internal adversarial review complete before delivery
- rollback: remove only the new runtime source, runtime test and report; preserve 001–008 evidence; never reset, clean or revert unknown work
- stop_conditions:
  - need to modify any protected existing module, page, UI, Store, AI, network or persistence file
  - ambiguity about handle binding, failure mapping, cancellation or late-result semantics
  - protected hash drift, second writer, allowlist drift or any failed test that would require weakening assertions
- delivery_report: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-RUNTIME-FACADE-009.md
- acceptance_owner: /root
- next_after_acceptance: only after independent Codex intake may plan the production page integration stage; this stage does not mark release-ready

## Agent Instructions

先读项目 `AGENTS.md`、本任务卡、001–008 accepted/rejected reports and all protected source/tests. 你不是项目负责人；`/root` 保留架构、范围、集成和最终验收权。只修改 allowlist，不得创建提交。

交付前必须先做独立内部对抗审查，列出真实运行时入口形状、正向/失败路径、反向变异、AI callback/promise 是否等待、取消后的迟到结果、私有句柄泄漏、持久化 spy、写集与保护哈希。任何被攻击实现仍绿必须判定 FAIL/BLOCKED。报告记录实际命令/退出码、P0–P3、残余风险、未授权动作，最后一行严格为：

`DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-RUNTIME-FACADE-009.md`
