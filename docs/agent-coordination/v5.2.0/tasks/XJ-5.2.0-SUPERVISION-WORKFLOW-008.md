# Task Card: XJ-5.2.0-SUPERVISION-WORKFLOW-008

- task_id: XJ-5.2.0-SUPERVISION-WORKFLOW-008
- objective: Extend the accepted controlled Agent workflow from `session-review` to the routed `supervision-question-builder` intent, using the real ClinicalContext task shape `supervision-ai` through an explicit adapter mapping. Preserve human confirmation, metadata-only admission, exact source/origin binding, canonical `snapshot.key`, freshness before/after execution, cancellation, draft-only output, and no runtime/UI/Store/AI/network/persistence integration.
- owner: gpt-6.1-sol-low
- manager: codex (/root)
- project_root: D:/xinjing-electron
- branch_or_worktree: release/3.6.3-mac; shared worktree; do not switch branches or create commits
- base_commit: eb16e2b74e6ab919a782b8bc6f66bfe9524431f2
- active_release_train: 5.2.0 implementation; stage 008 after accepted ADAPTER-006-ESCALATION-007; not release-ready
- config_evidence_id: cfg-5.2.0-20261005-supervision-workflow-008
- agent_profile_id: gpt-6.1-sol-low
- contract_id: xj-5.2.0-supervision-question-controlled-workflow-v1
- write_lock_id: lock-5.2.0-supervision-workflow-008
- benchmark_manifest: synthetic supervision-question routing, context-task mapping, source/origin binding, confirmation, freshness, cancellation, draft-only and no-persistence fixtures v1
- visual_baseline: not-applicable; no UI or Electron changes authorized
- prerequisites:
  - XJ-5.2.0-AGENT-CONTRACT-001 accepted by Codex intake
  - XJ-5.2.0-ROUTER-002 accepted by Codex intake
  - XJ-5.2.0-RUN-003 accepted by Codex intake
  - XJ-5.2.0-CONTEXT-004 accepted by Codex intake
  - XJ-5.2.0-WORKFLOW-005 accepted by Codex intake
  - XJ-5.2.0-ADAPTER-006-ESCALATION-007 accepted by Codex intake
- protected_file_hashes:
  - app/js/agent-core.js: 00F758CE37702108AF4FF9BF48C294EDCB5BC32480B6DD6AD6DFD7F7235A5AD2
  - app/js/clinical-context.js: 09536023837266F2D560CE8D2500A6EA6BE0A25C53F97CC1C781EB46A23C1B64
  - app/js/store.js: 00473C3984B95429BE2E82AAD3C61369A2A1C2459CACA7C77CF84A66277504A7
  - app/js/agent-tools.js: FBD7BBF2BCA95BA025420998AB96511BB517725028ECD2FA9998A7C80A644D2B
  - app/js/clinical-agent-tasks.js: 3FFBD7A8FCB59A94F48EC08F324F321AABC914BC9B00DD5D5E4459E0456C0B18
  - app/js/clinical-agent-router.js: 51D8AAC36800C6090D0C14307A326D2D611548CDC6954427548ADF80F97EFA99
  - app/js/clinical-agent-run.js: 858D743C5A1B16730C966C26DEF334852BDAB964612EA11596CBD607C11A3D57
  - app/js/clinical-agent-context-bridge.js: 55E67EBA7E0DD5629EE66FB8863A86DA2C6EFC7A79C518E4E2653925676F961B
  - package.json: B74E0AA8F9B645D06647096545A3C611C112EF217AABADEA407B1950D629FC72
  - package-lock.json: FDB8D11766CE697211B6C21AEE91E488ECD8E12FEAFF725C568D62906156CB03
- write_allowlist:
  - app/js/clinical-agent-workflow.js (extend accepted workflow only)
  - app/js/clinical-agent-adapter.js (extend accepted adapter only)
  - tests/v5.2.0/clinical-agent-workflow.contract.test.cjs (extend contract only)
  - tests/v5.2.0/clinical-agent-adapter.contract.test.cjs (extend contract only)
  - docs/delivery-reports/XJ-5.2.0-SUPERVISION-WORKFLOW-008.md (new report)
- forbidden:
  - app/js/clinical-context.js, app/js/store.js, app/js/agent-core.js, app/js/agent-tools.js, app/js/supervision-core.js, app/js/supervision.js
  - app/js/clinical-agent-tasks.js, app/js/clinical-agent-router.js, app/js/clinical-agent-run.js, app/js/clinical-agent-context-bridge.js
  - all UI/HTML/CSS/Electron/preload/main/AI/network/persistence/release/package/version files
  - original 001–007 task cards/reports; do not rewrite historical evidence
  - commits, pushes, merges, uploads, signing, publishing, real clinical data or external messages
- required_behavior:
  - workflow `prepare` accepts the existing `session-review` and the routed `supervision-question-builder`; all other routed tasks still fail with `workflow-task-not-enabled`.
  - `supervision-question-builder` keeps its task identity at the workflow boundary but maps explicitly to ClinicalContext task `supervision-ai`; no arbitrary task alias or fallback is accepted.
  - matching synthetic `supervision` source set and origin reaches `awaiting-confirmation`; missing, duplicate, stale, cross-client/session, substituted or mismatched sources fail closed before execution.
  - adapter calls `context.build('supervision-ai', selection, options)` for the supervision-question task, validates real `built.snapshot.key`, rejects conflicting `built.snapshotKey`, and never accepts the request key as a substitute for the canonical key.
  - confirmation is mandatory; cancellation before, during and after executor prevents success; freshness is checked before and after awaited executor; executor errors and malformed drafts return stable failures.
  - executor receives only defensive message payload and metadata (`runId`, user-facing `taskId`, canonical `snapshotKey`, draft disposition, source summaries); no raw context, Store, persistence or save handle is exposed.
  - successful result is a draft-only projection; no durable write or AI/provider call is made. Existing session-review behavior remains green.
- required_adversarial_tests:
  - mutate mapping to call `context.build('supervision-question-builder', ...)`: a real mapping assertion must fail.
  - remove the confirmation gate, second freshness check, canonical-key conflict check, exact source-set check, or executor payload isolation: focused tests must fail.
  - replace `built.snapshot.key` with request `snapshotKey`, allow unknown context aliases, swallow executor errors, expose raw messages/persistence handles, or remove `await`: tests must fail.
  - verify rejected admission never calls executor and no persistence spy is callable.
- acceptance_commands:
  - node --test tests/v5.2.0/clinical-agent-workflow.contract.test.cjs
  - node --test tests/v5.2.0/clinical-agent-adapter.contract.test.cjs
  - node --test tests/v5.2.0/clinical-agent-tasks.contract.test.cjs tests/v5.2.0/clinical-agent-router.contract.test.cjs tests/v5.2.0/clinical-agent-run.contract.test.cjs tests/v5.2.0/clinical-agent-context-bridge.contract.test.cjs tests/v5.2.0/clinical-agent-workflow.contract.test.cjs tests/v5.2.0/clinical-agent-adapter.contract.test.cjs
  - node --check app/js/clinical-agent-workflow.js; node --check app/js/clinical-agent-adapter.js; node --check tests/v5.2.0/clinical-agent-workflow.contract.test.cjs; node --check tests/v5.2.0/clinical-agent-adapter.contract.test.cjs
  - node --check app/js/clinical-agent-tasks.js; node --check app/js/clinical-agent-router.js; node --check app/js/clinical-agent-run.js; node --check app/js/clinical-agent-context-bridge.js
  - git diff --check -- app/js/clinical-agent-workflow.js app/js/clinical-agent-adapter.js tests/v5.2.0/clinical-agent-workflow.contract.test.cjs tests/v5.2.0/clinical-agent-adapter.contract.test.cjs docs/agent-coordination/v5.2.0/tasks/XJ-5.2.0-SUPERVISION-WORKFLOW-008.md docs/delivery-reports/XJ-5.2.0-SUPERVISION-WORKFLOW-008.md
  - Get-FileHash app/js/agent-core.js,app/js/clinical-context.js,app/js/store.js,app/js/agent-tools.js,app/js/clinical-agent-tasks.js,app/js/clinical-agent-router.js,app/js/clinical-agent-run.js,app/js/clinical-agent-context-bridge.js,package.json,package-lock.json -Algorithm SHA256
- checkpoints:
  - A: read AGENTS.md, this card, accepted 001–007 reports and current source; confirm no second writer and hash baseline before editing
  - B: focused workflow and adapter tests pass with raw output before broad regression
  - C: run all acceptance commands, inspect final diff, recompute hashes, complete adversarial self-review, and write report before delivery
- rollback: revert only changes in the four allowlisted source/test files and remove this stage report; preserve 001–007 historical reports; never reset, clean or revert unknown work
- stop_conditions:
  - need to modify ClinicalContext, Store, UI, AI, Electron, network, persistence or any protected file
  - ambiguous task-to-context mapping, source/origin semantics or draft contract
  - protected hash drift, second writer, allowlist drift or any failed test that would require weakening assertions
- delivery_report: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-SUPERVISION-WORKFLOW-008.md
- acceptance_owner: /root
- next_after_acceptance: only after independent Codex intake may plan the next bounded stage; this stage does not mark 5.2.0 release-ready

## Agent Instructions

先读项目 `AGENTS.md`、本任务卡、001–007 accepted/rejected reports and all allowlisted source/tests. 你不是项目负责人；`/root` 保留架构、范围、集成和最终验收权。只修改 allowlist，不得回滚或覆盖未知改动，不得创建提交。

交付前必须先做一次独立内部对抗审查，至少列出真实入口调用、正向/失败路径、反向变异、未知工具/错误分支、写集和保护文件哈希、异步等待、mock/proxy/源码字符串假绿检查。任何能让被攻击实现仍绿的情况必须判定 FAIL/BLOCKED，不得自评通过。报告必须记录实际命令与退出码、P0–P3、残余风险、未授权动作，最后一行严格为：

`DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-SUPERVISION-WORKFLOW-008.md`
