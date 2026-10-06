# Task Card: XJ-5.2.0-WORKFLOW-005

- task_id: XJ-5.2.0-WORKFLOW-005
- objective: Build the first executable, bounded supervision workflow core for `session-review`: route a user request, admit a fresh metadata-only context, require explicit human confirmation, run an injected draft executor, re-check freshness, and finish at `draft-ready` without persisting a clinical record.
- owner: gpt-6.1-sol-low
- manager: codex (/root)
- project_root: D:/xinjing-electron
- branch_or_worktree: `release/3.6.3-mac`; shared worktree; do not switch branches or create commits
- base_commit: eb16e2b74e6ab919a782b8bc6f66bfe9524431f2
- active_release_train: 5.2.0 implementation (fifth work package; not release-ready)
- config_evidence_id: cfg-5.2.0-20261004-workflow-005-baseline
- agent_profile_id: gpt-6.1-sol-low
- contract_id: xj-5.2.0-controlled-session-review-workflow-v1
- write_lock_id: lock-5.2.0-workflow-005
- protected_files_manifest_hash: not-applicable; individual protected hashes are frozen below and must be rechecked
- benchmark_manifest: synthetic workflow lifecycle, confirmation, stale, cancellation, failure, and no-persistence fixtures v1
- visual_baseline: not-applicable; no UI or Electron changes authorized
- prerequisites:
  - XJ-5.2.0-AGENT-CONTRACT-001 accepted by Codex intake
  - XJ-5.2.0-ROUTER-002 accepted by Codex intake
  - XJ-5.2.0-RUN-003 accepted by Codex intake
  - XJ-5.2.0-CONTEXT-004 independently accepted by Codex intake
- protected_file_hashes:
  - app/js/agent-core.js: 00F758CE37702108AF4FF9BF48C294EDCB5BC32480B6DD6AD6DFD7F7235A5AD2
  - app/js/clinical-context.js: 09536023837266F2D560CE8D2500A6EA6BE0A25C53F97CC1C781EB46A23C1B64
  - app/js/store.js: 00473C3984B95429BE2E82AAD3C61369A2A1C2459CACA7C77CF84A66277504A7
  - app/js/agent-tools.js: FBD7BBF2BCA95BA025420998AB96511BB517725028ECD2FA9998A7C80A644D2B
  - app/js/clinical-agent-tasks.js: 3FFBD7A8FCB59A94F48EC08F324F321AABC914BC9B00DD5D5E4459E0456C0B18
  - app/js/clinical-agent-router.js: 51D8AAC36800C6090D0C14307A326D2D611548CDC6954427548ADF80F97EFA99
  - app/js/clinical-agent-run.js: 858D743C5A1B16730C966C26DEF334852BDAB964612EA11596CBD607C11A3D57
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
  - app/js/clinical-agent-workflow.js (new file only)
  - tests/v5.2.0/clinical-agent-workflow.contract.test.cjs (new file only)
  - docs/delivery-reports/XJ-5.2.0-WORKFLOW-005.md
- forbidden:
  - app/js/agent-core.js
  - app/js/agent-tools.js
  - app/js/clinical-context.js
  - app/js/store.js
  - app/js/app.js
  - app/js/ai.js
  - app/js/supervision.js
  - app/js/supervision-core.js
  - app/js/clinical-agent-tasks.js
  - app/js/clinical-agent-router.js
  - app/js/clinical-agent-run.js
  - app/js/clinical-agent-context-bridge.js
  - all existing tests/reports, package/version/build/signing/publish files
  - UI, Electron, DOM, Store, ClinicalContext, network, real clinical data, external messages, commits, pushes, merges
- scope_contract:
  - The module must be dependency-injectable and load in clean Node/CommonJS and browser/UMD contexts.
  - It may compose only the accepted router, context bridge, task contract, and AgentRun contracts. No direct Store/ClinicalContext/AI dependency is permitted.
  - Only `session-review` is enabled in this first workflow. Other registered tasks must fail closed with a stable `workflow-task-not-enabled` reason.
  - `prepare(request)` routes `request.text`, calls the context bridge with metadata, and returns only a metadata projection at `awaiting-confirmation`. Route ambiguity, missing identity/snapshot/source, stale context, cross-client/session sources, and unknown task must fail closed.
  - `confirm(prepared, { confirmed: true })` is the only path to `running`; missing, false, or malformed confirmation must not call the executor.
  - `execute(confirmed, adapters)` must obtain an execution payload through an injected adapter, verify the snapshot/source identity before execution and again before accepting the result, call an injected draft executor, and transition success to `draft-ready` with `outputDisposition=draft`.
  - The executor result is a draft-only value returned to the caller; the workflow must never call a persistence API, durable-write API, Store, filesystem, network, or external-send function.
  - On stale context, executor failure, cancellation, or malformed draft, transition to `stale`, `failed`, or `cancelled` and return a stable reason; never report success early.
  - Public projections and errors must not contain source body/content/prompt/rawText/model input. The explicit returned `draft` is the only place an executor-produced draft may appear.
  - `cancel(confirmedOrPrepared, reason?)` must be idempotent for non-terminal runs and must not invoke the executor.
- required_public_api:
  - `prepare(request)`
  - `confirm(prepared, confirmation)`
  - `execute(confirmed, adapters)`
  - `cancel(preparedOrConfirmed, reason)`
  - `project(workflowState)`
  - `isWorkflowState(value)`
- acceptance_commands:
  - `node --test tests/v5.2.0/clinical-agent-workflow.contract.test.cjs`
  - `node --check app/js/clinical-agent-workflow.js`
  - `node --test tests/v5.2.0/clinical-agent-tasks.contract.test.cjs tests/v5.2.0/clinical-agent-router.contract.test.cjs tests/v5.2.0/clinical-agent-run.contract.test.cjs tests/v5.2.0/clinical-agent-context-bridge.contract.test.cjs tests/v5.2.0/clinical-agent-workflow.contract.test.cjs`
  - `node --check app/js/clinical-agent-tasks.js`
  - `node --check app/js/clinical-agent-router.js`
  - `node --check app/js/clinical-agent-run.js`
  - `node --check app/js/clinical-agent-context-bridge.js`
  - `git diff --check -- app/js/clinical-agent-workflow.js tests/v5.2.0/clinical-agent-workflow.contract.test.cjs docs/agent-coordination/v5.2.0/tasks/XJ-5.2.0-WORKFLOW-005.md docs/delivery-reports/XJ-5.2.0-WORKFLOW-005.md`
  - `Get-FileHash app/js/agent-core.js,app/js/clinical-context.js,app/js/store.js,app/js/agent-tools.js,app/js/clinical-agent-tasks.js,app/js/clinical-agent-router.js,app/js/clinical-agent-run.js,package.json,package-lock.json -Algorithm SHA256`
- checkpoints:
  - A: read AGENTS.md and this card; confirm the current branch, base commit, protected hashes, allowlist, and no second writer before editing
  - B: at roughly 50 percent, report raw focused test output, current files, and any stop condition; do not broaden scope
  - C: before delivery, run all acceptance commands, perform an independent adversarial self-review, recompute hashes, inspect diff, and write the complete report
- required_tests:
  - positive `session-review` prepare -> explicit confirm -> injected execute -> `draft-ready`
  - route ambiguity/unsupported task/missing runId/snapshotKey/sources/stale/cross-client/cross-session failures
  - confirmation false/missing and cancellation do not invoke executor
  - executor failure, malformed draft, stale-before and stale-after execution fail closed
  - no-persistence spy remains unused; no body/content/prompt/rawText leaks from projections/errors
  - mutation-sensitive tests that remove the confirmation gate, freshness re-check, or persistence prohibition turn red
- rollback: remove only the newly added workflow source, focused test, and delivery report; preserve all failure evidence; never reset, clean, or revert the shared worktree
- stop_conditions:
  - any need to modify a protected/shared runtime file or accepted contract
  - any need for real clinical data, Electron, UI, Store, ClinicalContext, AI, filesystem, network, external message, or persistence access
  - any ambiguity about confirmation, freshness, draft shape, or output semantics not resolvable from this card
  - protected hash drift, second writer, allowlist drift, or failed test that would require weakening an assertion
- delivery_report: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-WORKFLOW-005.md
- acceptance_owner: /root
- next_after_acceptance: only after independent Codex intake may create XJ-5.2.0-ADAPTER-006 for a real ClinicalContext/supervision-core adapter; no UI/runtime integration in this card

## Agent Instructions

先读项目 `AGENTS.md`、本任务卡和已接受的 001–004 源码/测试。Checkpoint A 未通过不得写入。

你不是独立负责人；`/root` 保留架构、范围、集成和最终验收权。只修改 allowlist，不得回滚或覆盖其他用户/agent 改动。不要通过删除断言、放宽校验、源码字符串匹配、mock 替代真实模块、吞掉异常、提前成功、自动持久化或伪造测试结果来变绿。

交付报告必须包含：实际文件、原始命令与退出码、正向/负向测试、失败路径、P0–P3、文件 SHA-256、范围核对、残余风险、未授权动作，以及单独的“内部对抗审查”章节。至少主动尝试：删除显式确认门、删除二次 freshness 检查、注入持久化函数、去掉 `await`、替换 accepted router/bridge/run 入口、让 projection 携带 body/prompt；任何攻击能让测试仍绿都必须判定 FAIL/BLOCKED。

报告最后一行必须严格为：
`DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-WORKFLOW-005.md`
