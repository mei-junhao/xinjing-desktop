# Task Card: XJ-5.2.0-PRODUCTION-SUPERVISION-ENTRY-CONTRACT-013

- task_id: XJ-5.2.0-PRODUCTION-SUPERVISION-ENTRY-CONTRACT-013
- objective: Extend the accepted controlled Agent contract with an explicit production `supervision-preview` task for the standard supervision page. The task must map only to the real ClinicalContext task `supervision-ai`, admit four source shapes (independent text, client-bound, session-bound, material-bound), allow the legitimate empty-source independent case, preserve human confirmation/freshness/cancellation/draft-only behavior, and leave existing Agent tasks unchanged. This stage defines the production contract only; it does not wire the page, UI, Store, action-run persistence, Electron, or release path.
- owner: gpt-6.1-sol-low
- manager: codex (/root)
- project_root: D:/xinjing-electron
- branch_or_worktree: release/3.6.3-mac; shared worktree; do not switch branches or create commits
- base_commit: eb16e2b74e6ab919a782b8bc6f66bfe9524431f2
- active_release_train: 5.2.0 implementation; stage 013; not release-ready
- config_evidence_id: cfg-5.2.0-20261005-production-supervision-entry-contract-013
- agent_profile_id: gpt-6.1-sol-low
- contract_id: xj-5.2.0-production-supervision-entry-v1
- write_lock_id: lock-5.2.0-production-supervision-entry-contract-013
- protected_files_manifest_hash: not-applicable; recompute individual hashes below before and after edits
- benchmark_manifest: synthetic standard-supervision task routing, four source shapes, independent empty-source admission, supervision-ai mapping, canonical snapshot, confirmation, freshness, cancellation, failure and no-persistence fixtures v1
- visual_baseline: not-applicable; no UI/HTML/CSS/Electron changes authorized
- prerequisites:
  - XJ-5.2.0-AGENT-CONTRACT-001 accepted by Codex intake
  - XJ-5.2.0-ROUTER-002 accepted by Codex intake
  - XJ-5.2.0-RUN-003 accepted by Codex intake
  - XJ-5.2.0-CONTEXT-004 accepted by Codex intake
  - XJ-5.2.0-WORKFLOW-005 accepted by Codex intake
  - XJ-5.2.0-ADAPTER-006-ESCALATION-007 accepted by Codex intake
  - XJ-5.2.0-SUPERVISION-WORKFLOW-008 accepted by Codex intake
  - XJ-5.2.0-RUNTIME-FACADE-009-ESCALATION-012 accepted by Codex intake
- protected_file_hashes:
  - app/js/clinical-agent-runtime.js: B46ABFD55F0E045B23BEB1C5303E025515C1E484A6420537397744132366FB5E
  - app/js/clinical-context.js: 09536023837266F2D560CE8D2500A6EA6BE0A25C53F97CC1C781EB46A23C1B64
  - app/js/store.js: 00473C3984B95429BE2E82AAD3C61369A2A1C2459CACA7C77CF84A66277504A7
  - app/js/agent-core.js: 00F758CE37702108AF4FF9BF48C294EDCB5BC32480B6DD6AD6DFD7F7235A5AD2
  - app/js/agent-tools.js: FBD7BBF2BCA95BA025420998AB96511BB517725028ECD2FA9998A7C80A644D2B
  - package.json: B74E0AA8F9B645D06647096545A3C611C112EF217AABADEA407B1950D629FC72
  - package-lock.json: FDB8D11766CE697211B6C21AEE91E488ECD8E12FEAFF725C568D62906156CB03
- accepted_contract_hashes:
  - app/js/clinical-agent-tasks.js: 3FFBD7A8FCB59A94F48EC08F324F321AABC914BC9B00DD5D5E4459E0456C0B18
  - app/js/clinical-agent-router.js: 51D8AAC36800C6090D0C14307A326D2D611548CDC6954427548ADF80F97EFA99
  - app/js/clinical-agent-run.js: 858D743C5A1B16730C966C26DEF334852BDAB964612EA11596CBD607C11A3D57
  - app/js/clinical-agent-context-bridge.js: 55E67EBA7E0DD5629EE66FB8863A86DA2C6EFC7A79C518E4E2653925676F961B
  - app/js/clinical-agent-workflow.js: 52FFCB1E936DE49700567113EC762D4E42A14F0542D49904AF3E3113AAD7C892
  - app/js/clinical-agent-adapter.js: 1778BBC72174E12A4113DFB444CDC3DA7034ADF7798FA88D652CACBE0878D44C
  - tests/v5.2.0/clinical-agent-tasks.contract.test.cjs: CCDB5E459DB4EC0B7D1AB2EC702155C622F18A6049B43C5B089D1FBCB85AD475
  - tests/v5.2.0/clinical-agent-router.contract.test.cjs: B7E084E247EAF08F6622F27778EC33C35BC5ECE2436E3363202533BEC5A02449
  - tests/v5.2.0/clinical-agent-context-bridge.contract.test.cjs: 7065E6050F8DE84812435B364DFCD5079A758FF913A9507315AD2D04BB8EE3A2
  - tests/v5.2.0/clinical-agent-workflow.contract.test.cjs: BC76C74DCDCB1594D0B150B9A6DAFD9BE1D0D7548753E2FF480BD10649AE909D
  - tests/v5.2.0/clinical-agent-adapter.contract.test.cjs: CBB30E83F42E39C209E2C25836AB7C656E457C6051979048A6C3E8872A150E13
- authorization:
  - code_change: allowlisted only
  - local_commit: denied
  - push: denied
  - upload: denied
  - sign: denied
  - publish: denied
- write_allowlist:
  - app/js/clinical-agent-tasks.js
  - app/js/clinical-agent-router.js
  - app/js/clinical-agent-context-bridge.js
  - app/js/clinical-agent-workflow.js
  - app/js/clinical-agent-adapter.js
  - tests/v5.2.0/clinical-agent-tasks.contract.test.cjs
  - tests/v5.2.0/clinical-agent-router.contract.test.cjs
  - tests/v5.2.0/clinical-agent-context-bridge.contract.test.cjs
  - tests/v5.2.0/clinical-agent-workflow.contract.test.cjs
  - tests/v5.2.0/clinical-agent-adapter.contract.test.cjs
  - docs/delivery-reports/XJ-5.2.0-PRODUCTION-SUPERVISION-ENTRY-CONTRACT-013.md
- forbidden:
  - app/js/clinical-agent-runtime.js
  - app/js/clinical-context.js
  - app/js/store.js
  - app/js/agent-core.js
  - app/js/agent-tools.js
  - app/js/ai.js
  - app/js/supervision.js
  - app/supervision.html
  - all HTML/CSS/Electron/preload/main/network/persistence/release/package/version files
  - historical task cards/reports; do not rewrite 001–012 evidence
  - commits, merges, pushes, uploads, signing, publishing, real clinical data or external messages
- required_behavior:
  - Register exactly one new task ID: `supervision-preview`; keep all existing task IDs, effects and required source rules unchanged.
  - Route explicit standard-supervision phrases such as `生成整体印象`, `AI 督导` and `督导整体印象` to `supervision-preview`; `督导问题生成` must continue routing to `supervision-question-builder`, and ambiguous intents must still fail closed.
  - `supervision-preview` has allowed source kinds `client`, `session`, `material`, `supervision`, no required source kind, and an explicit `allowEmptySources`/independent-input rule. Empty sources are valid only when the task is `supervision-preview` and the origin is unbound; all other tasks and bound empty-source cases fail closed.
  - Adapter maps only `supervision-preview` to `context.build('supervision-ai', ...)`; `session-review` remains `session-review`; arbitrary aliases fail closed.
  - The built context must provide `outputMode='preview-only'`, canonical `snapshot.key`, messages and an exact source set. The request snapshot key remains non-authoritative.
  - Preserve explicit confirmation, freshness-before/after, cancellation, stable error mapping, draft-only output and metadata-only public projections. No action-run, Store, save, AI or network call is added in this stage.
  - Positive synthetic coverage must include: independent empty-source text, client-only source, session source, material source, and mixed valid sources. Negative coverage must include: empty sources for old tasks, bound empty-source request, cross-client/session substitution, duplicate/stale/mismatched source, wrong context alias, canonical snapshot conflict, no confirmation, stale-before/after, cancellation and executor/provider failure.
- required_adversarial_tests:
  - Mutate `supervision-preview` to require `supervision`: independent positive test must fail.
  - Route `生成整体印象` to `supervision-question-builder`: explicit route assertion must fail.
  - Map the new task to `context.build('supervision-preview')`: exact mapping assertion must fail.
  - Remove the empty-source boundary, source identity checks, confirmation gate, second freshness check, canonical snapshot check, await, or error normalization: focused tests must fail.
  - Reuse an arbitrary alias, call a persistence spy, expose raw messages/body/prompt, or execute a rejected admission: tests must fail.
- acceptance_commands:
  - node --test tests/v5.2.0/clinical-agent-tasks.contract.test.cjs
  - node --test tests/v5.2.0/clinical-agent-router.contract.test.cjs
  - node --test tests/v5.2.0/clinical-agent-context-bridge.contract.test.cjs
  - node --test tests/v5.2.0/clinical-agent-workflow.contract.test.cjs
  - node --test tests/v5.2.0/clinical-agent-adapter.contract.test.cjs
  - node --test tests/v5.2.0/clinical-agent-tasks.contract.test.cjs tests/v5.2.0/clinical-agent-router.contract.test.cjs tests/v5.2.0/clinical-agent-run.contract.test.cjs tests/v5.2.0/clinical-agent-context-bridge.contract.test.cjs tests/v5.2.0/clinical-agent-workflow.contract.test.cjs tests/v5.2.0/clinical-agent-adapter.contract.test.cjs tests/v5.2.0/clinical-agent-runtime.contract.test.cjs
  - node --check app/js/clinical-agent-tasks.js; node --check app/js/clinical-agent-router.js; node --check app/js/clinical-agent-context-bridge.js; node --check app/js/clinical-agent-workflow.js; node --check app/js/clinical-agent-adapter.js
  - node --check tests/v5.2.0/clinical-agent-tasks.contract.test.cjs; node --check tests/v5.2.0/clinical-agent-router.contract.test.cjs; node --check tests/v5.2.0/clinical-agent-context-bridge.contract.test.cjs; node --check tests/v5.2.0/clinical-agent-workflow.contract.test.cjs; node --check tests/v5.2.0/clinical-agent-adapter.contract.test.cjs
  - git diff --check -- app/js/clinical-agent-tasks.js app/js/clinical-agent-router.js app/js/clinical-agent-context-bridge.js app/js/clinical-agent-workflow.js app/js/clinical-agent-adapter.js tests/v5.2.0/clinical-agent-tasks.contract.test.cjs tests/v5.2.0/clinical-agent-router.contract.test.cjs tests/v5.2.0/clinical-agent-context-bridge.contract.test.cjs tests/v5.2.0/clinical-agent-workflow.contract.test.cjs tests/v5.2.0/clinical-agent-adapter.contract.test.cjs docs/agent-coordination/v5.2.0/tasks/XJ-5.2.0-PRODUCTION-SUPERVISION-ENTRY-CONTRACT-013.md docs/delivery-reports/XJ-5.2.0-PRODUCTION-SUPERVISION-ENTRY-CONTRACT-013.md
  - Get-FileHash app/js/clinical-agent-runtime.js,app/js/clinical-context.js,app/js/store.js,app/js/agent-core.js,app/js/agent-tools.js,package.json,package-lock.json -Algorithm SHA256
- checkpoints:
  - A: read AGENTS.md, this card, all accepted 001–012 reports and current source/tests; recompute protected and accepted hashes; confirm no second writer.
  - B: focused new-task route/admission/mapping tests pass before broad regression; report raw output and any stop condition.
  - C: run all acceptance commands, inspect exact diff and allowlist, recompute protected hashes, perform adversarial self-review, and write the report before delivery.
- rollback: restore only the five contract files and five contract tests to their pre-013 contents if needed; remove this stage report; preserve all historical reports and unrelated worktree changes; never reset, clean or revert unknown work.
- stop_conditions:
  - need to modify runtime, ClinicalContext, Store, UI, HTML/CSS, Electron, AI, network, persistence or release files
  - ambiguity about independent empty-source semantics or source identity that cannot be resolved from this card and existing code
  - protected hash drift, second writer, allowlist drift, failed test requiring weakened assertions, or any real clinical data
- delivery_report: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-PRODUCTION-SUPERVISION-ENTRY-CONTRACT-013.md
- acceptance_owner: /root
- next_after_acceptance: create the separate production page integration card; this stage does not wire `supervision.html`/`supervision.js` and does not mark 5.2.0 release-ready

## Agent Instructions

你是执行代理，不是项目负责人；`/root` 保留架构、范围、集成和最终验收权。你不是独自在代码库中工作，必须保留未知改动。先读项目 `AGENTS.md`、本任务卡、001–012 accepted/rejected reports 和真实源码。Checkpoint A 未通过不得写入。

只修改 allowlist；不得改变旧任务的既有契约来凑通过，不得删除断言、放宽边界、使用源码字符串匹配、mock 替代真实模块、吞掉错误、提前成功或伪造证据。不要创建提交。

交付前必须先做独立内部对抗审查，单列“内部对抗审查”章节，覆盖真实 UMD/CommonJS 入口、四种来源形状、独立空来源、正向/失败路径、反向变异、unknown alias、canonical snapshot、异步等待、错误分支、写集和保护哈希、测试是否会对 await/确认/二次 freshness/映射移除变红。报告必须记录实际命令与退出码、P0–P3、评分、残余风险、未授权动作和 PASS/FAIL。

报告最后一行严格使用：
`DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-PRODUCTION-SUPERVISION-ENTRY-CONTRACT-013.md`
