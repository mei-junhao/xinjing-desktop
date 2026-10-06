# Task Card: XJ-5.2.0-SUPERVISION-PRODUCTION-INTEGRATION-015

- task_id: XJ-5.2.0-SUPERVISION-PRODUCTION-INTEGRATION-015
- objective: Wire the accepted production clinical bridge into the real AI supervision page for the standard supervision flow. Preserve the material/result/ask/save/export experience while making the bridge the single owner of ClinicalContext action-run and AI execution. Build one private ClinicalContext, show async confirmation, reuse that context through the bridge, render draft/stream/cancel/error states, and never call createActionRun, completeActionRun, failActionRun, saveSupervision, or AI.send directly for standard generation.
- owner: gpt-6.1-sol-low
- manager: codex (/root)
- project_root: D:/xinjing-electron
- branch_or_worktree: release/3.6.3-mac; shared worktree; do not switch branches or create commits
- base_commit: eb16e2b74e6ab919a782b8bc6f66bfe9524431f2
- active_release_train: 5.2.0 implementation; stage 015; not release-ready
- config_evidence_id: cfg-5.2.0-20261005-supervision-production-integration-015
- agent_profile_id: gpt-6.1-sol-low
- contract_id: xj-5.2.0-supervision-production-integration-v1
- write_lock_id: lock-5.2.0-supervision-production-integration-015
- benchmark_manifest: synthetic standard supervision page, independent empty-source and bound-source flows, one-context-build, async confirmation, action-run ordering, stream/final draft, cancel/timeout/stale/provider/lifecycle errors, save/export separation, replay/late-result, keyboard/focus/reduced-motion/long-Chinese fixtures v1
- visual_baseline: 1024x700, 1366x768, 1920x1080 x Clinical/Theatre/Observatory x Light/Dark, reduced-motion and narrow-window checks; no new visual language
- prerequisites:
  - XJ-5.2.0-PRODUCTION-SUPERVISION-ENTRY-CONTRACT-013 accepted by Codex intake
  - XJ-5.2.0-PRODUCTION-CLINICAL-BRIDGE-014 accepted by Codex intake
  - existing supervision.html/supervision.js call chain and xinjing-ui-system references read before editing
- current_target_hashes:
  - app/js/clinical-agent-runtime.js: CAECF4F3053A501C5A65E1BC5FBCD1325C5C9BFA9FD760006CD2C36A5133C08A
  - app/js/clinical-agent-adapter.js: D3EE7E3AB21968972E7655A262AD2EF91C0EECB095E048E28F6B56BBD45D970B
  - app/js/clinical-agent-production-bridge.js: 283FA83BC778CE10D98BF854279AF1649F4400412CE21EB3C82662CF8F5D7478
  - app/js/supervision.js: 01ED97151DDA7F90F0494E896852F72F5FA724203F5FC3474773B096990694BE
  - app/supervision.html: CD6AAA48E99312086451FCB8D5BBC0929A7A7B513BFCBC9408A28BB56270C864
  - app/js/clinical-agent-tasks.js: 497316894C7ED7C637617CBB6757D05719ED705A9A297FAF4DB4BB964F36612C
  - app/js/clinical-agent-router.js: B87C6DA6F7287A5326E771BB98C2B17202316F4935DD20D985F6526EEFB776F3
  - app/js/clinical-agent-run.js: 858D743C5A1B16730C966C26DEF334852BDAB964612EA11596CBD607C11A3D57
  - app/js/clinical-agent-context-bridge.js: 65730ABFC6CDDF29E17C7FA923B393C49F08703D32764C191506DA3F95FD43E6
  - app/js/clinical-agent-workflow.js: 33A04DC1C5E312F2EF19821A58BDC400B311205A340A165E1D974C16C3F55227
  - app/js/clinical-context.js: 09536023837266F2D560CE8D2500A6EA6BE0A25C53F97CC1C781EB46A23C1B64
  - app/js/store.js: 00473C3984B95429BE2E82AAD3C61369A2A1C2459CACA7C77CF84A66277504A7
  - app/js/ai.js: 8900E053FDA0FFA6AF0BF51FC25988E7EEE53651D74622250FE831809BF2FC69
  - package.json: B74E0AA8F9B645D06647096545A3C611C112EF217AABADEA407B1950D629FC72
  - package-lock.json: FDB8D11766CE697211C21AEE91E488ECD8E12FEAFF725C568D62906156CB03
- authorization: code_change allowlisted only; local commit/push/upload/sign/publish denied
- write_allowlist:
  - app/js/clinical-agent-runtime.js (private context and stream plumbing only; preserve 014 contracts)
  - app/js/clinical-agent-adapter.js (reuse one private context and stream callback only; preserve lifecycle contract)
  - app/js/clinical-agent-production-bridge.js (controlled prepareContext surface only)
  - app/js/supervision.js (standard supervision flow only; preserve multi-school/package/upload/save/export behavior)
  - app/supervision.html (script ordering and minimal accessibility/status hooks; no route removal)
  - tests/v5.2.0/clinical-agent-runtime.contract.test.cjs
  - tests/v5.2.0/clinical-agent-adapter.contract.test.cjs
  - tests/v5.2.0/clinical-agent-production-bridge.contract.test.cjs
  - tests/v5.2.0/supervision-production-integration.contract.test.cjs
  - docs/delivery-reports/XJ-5.2.0-SUPERVISION-PRODUCTION-INTEGRATION-015.md
- forbidden: clinical-context.js, store.js, ai.js, agent-core.js, agent-tools.js, accepted task/router/run/context-bridge/workflow modules, multi-school/package business logic, durable schemas, other routes, CSS redesign, Electron/preload/main, network, package/version/release files, direct standard-path lifecycle/AI calls, commits/merges/pushes/uploads/signing/publishing, real clinical data or external messages
- required_behavior:
  - ProductionBridge remains the only standard-path execution surface; public API may add only controlled prepareContext(privateContext, request), never raw context/messages/Store/executor/lifecycle/save handles.
  - prepareContext uses one private ClinicalContext.build('supervision-ai', ...) result, canonical snapshot.key and source metadata, and adapter execution reuses that exact context; no second build.
  - build occurs before async confirmation; rejected confirmation, stale-before, malformed context or unavailable bridge yields zero action-runs and zero AI calls.
  - After confirmation, exactly one action-run is created immediately before AI, completion/failure is exactly once, and 014 late-result/cancel/timeout/stale/provider/malformed/lifecycle behavior is preserved.
  - Existing stream UX is preserved: onDelta updates the active block; final draft renders as assistant result; cancellation/error states remain distinct and retain material/input.
  - Standard generation, quick actions and follow-up questions use supervision-preview. Existing saveSup remains the sole explicit durable record action after user click and is not used by generation.
  - AbortController and page/context switches prevent stale UI writes; late callbacks/promises cannot render success or complete an action-run. Preserve membership, upload, package, multi-school, save/export, route, Chinese copy and synthetic/no-network boundaries.
  - UI keeps stable dimensions, focus, ARIA status, long-Chinese wrapping, narrow-window scroll and reduced-motion behavior; no new card nesting or decorative visual system.
- required_tests:
  - focused bridge/runtime/adapter suites remain green and add one-build/prepareContext, private-context reuse, stream callback, cancellation and replay assertions.
  - integration contract uses real CommonJS/UMD modules and verifies one build, one action-run, one AI call, one completion; confirmation rejection has zero action-runs/AI; no direct standard-handler lifecycle/AI calls.
  - synthetic independent-empty and bound client/session/material/supervision fixtures cover stale/provider/malformed/timeout/cancel/late/lifecycle errors and save/export separation.
  - static HTML checks verify all agent modules load before supervision.js, existing scripts/routes remain, and no duplicate tags.
  - controlled Electron with temporary userData and default-deny network verifies page load, confirmation, focus, cancel/error feedback, overflow, long Chinese, empty/loading/error/success and reduced-motion.
  - syntax, full v5.2.0 contracts, diff check, protected hashes and fixed 18-cell visual matrix or task-local hash-bound equivalent.
- required_adversarial_tests: duplicate build, move action-run before/after AI, bypass bridge with direct AI, swallow ok:false, complete after cancel, late render, expose private context, omit await/signal/onDelta, alter completion kind/id, admit bound empty source, or arbitrary task alias; each must turn focused tests red.
- acceptance_commands:
  - node --test tests/v5.2.0/supervision-production-integration.contract.test.cjs
  - node --test tests/v5.2.0/clinical-agent-adapter.contract.test.cjs tests/v5.2.0/clinical-agent-runtime.contract.test.cjs tests/v5.2.0/clinical-agent-production-bridge.contract.test.cjs tests/v5.2.0/supervision-production-integration.contract.test.cjs
  - node --test tests/v5.2.0/clinical-agent-tasks.contract.test.cjs tests/v5.2.0/clinical-agent-router.contract.test.cjs tests/v5.2.0/clinical-agent-run.contract.test.cjs tests/v5.2.0/clinical-agent-context-bridge.contract.test.cjs tests/v5.2.0/clinical-agent-workflow.contract.test.cjs tests/v5.2.0/clinical-agent-adapter.contract.test.cjs tests/v5.2.0/clinical-agent-runtime.contract.test.cjs tests/v5.2.0/clinical-agent-production-bridge.contract.test.cjs tests/v5.2.0/supervision-production-integration.contract.test.cjs
  - node --check app/js/clinical-agent-adapter.js; node --check app/js/clinical-agent-runtime.js; node --check app/js/clinical-agent-production-bridge.js; node --check app/js/supervision.js; node --check tests/v5.2.0/supervision-production-integration.contract.test.cjs
  - git diff --check -- allowlisted source/test/report files
  - Get-FileHash protected files listed above; controlled Electron command and evidence documented in delivery report
- checkpoints: A read AGENTS.md, UI references, accepted 013/014 reports, page call chain and hashes; B expected-red one-build/direct-call/duplicate-lifecycle probes then focused tests; C full contracts, controlled Electron, visual/a11y checks, final diff/hash review and adversarial self-audit before delivery
- rollback: restore only 015 allowlisted files to pre-015 contents and remove 015 test/report; preserve 013/014 and unrelated worktree changes; never reset/clean/revert unknown work
- stop_conditions: need to modify protected core/UI schema/Electron/network/package files; inability to reuse one context or preserve exactly-once/late-result guarantees; protected hash drift, second writer, allowlist drift, fake-green test or visual/a11y P0/P1
- delivery_report: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-SUPERVISION-PRODUCTION-INTEGRATION-015.md
- acceptance_owner: /root
- next_after_acceptance: plan the next bounded 5.2.0 stage only after independent intake; 015 does not mark release-ready or authorize packaging/publishing

## Agent Instructions

你是执行代理，不是项目负责人；/root 负责范围、架构、冲突协调和最终验收。你不是独自在代码库中工作，必须保留未知改动。先读项目 AGENTS.md、013/014 accepted reports、xinjing-ui-system references、supervision 页面和真实调用链。Checkpoint A 未通过不得写入。

只修改 allowlist。标准督导页面必须统一走 production bridge；不得保留同一路径的旧 ClinicalContext.createActionRun/completeActionRun/failActionRun/AI.send 直连。多学派和受控技能包是本阶段外既有能力，除非脚本顺序需要，不得改其业务逻辑。

交付前必须先做独立内部对抗审查，单列“内部对抗审查”章节，覆盖真实 UMD/CommonJS 入口、一次 context build、confirm gate、action-run 顺序/exactly-once、stream/await/cancel/timeout/late callback、stale/provider/malformed/lifecycle error、raw context privacy、save/export separation、membership/upload/multi-school regression、脚本顺序、controlled Electron network deny、键盘焦点、长中文、空/加载/错误/成功/低动效和 protected hashes。主动尝试删除 await、恢复直接 AI、重复 build、移除 signal、提前 complete、吞掉错误、暴露 private context；任何仍通过的攻击必须判定 FAIL/BLOCKED。报告记录实际命令/退出码、P0-P3、测试/视觉/电子证据、哈希、未授权动作、残余风险、未完成项；最后一行严格为：

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-SUPERVISION-PRODUCTION-INTEGRATION-015.md
