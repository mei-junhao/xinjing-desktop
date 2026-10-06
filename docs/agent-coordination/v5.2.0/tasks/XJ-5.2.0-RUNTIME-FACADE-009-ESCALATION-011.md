# Task Card: XJ-5.2.0-RUNTIME-FACADE-009-ESCALATION-011

- task_id: XJ-5.2.0-RUNTIME-FACADE-009-ESCALATION-011
- objective: Close two concrete behavioral gaps left in escalation 010: fromGlobals default timeout propagation and per-execution AbortSignal cancellation/isolation. This is a minimal repair of the accepted non-persisting runtime facade; no new feature surface or production integration.
- owner: gpt-6.1-sol-low (new execution agent)
- manager: codex (/root)
- project_root: D:/xinjing-electron
- branch_or_worktree: release/3.6.3-mac; shared worktree; no branch switch or commit
- base_commit: eb16e2b74e6ab919a782b8bc6f66bfe9524431f2
- active_release_train: 5.2.0 implementation; stage 009 escalation 011; not release-ready
- config_evidence_id: cfg-5.2.0-runtime-facade-009-escalation-011
- agent_profile_id: gpt-6.1-sol-low
- contract_id: xj-5.2.0-runtime-facade-v1-escalation-011
- write_lock_id: lock-5.2.0-runtime-facade-009-escalation-011
- predecessor: XJ-5.2.0-RUNTIME-FACADE-009-ESCALATION-010
- baseline_hashes:
  - app/js/clinical-agent-runtime.js: E536ED4B8C31580ABC9E7FB2D2AEEE58E55117EBEB9DE24659B4D22F488DD115
  - tests/v5.2.0/clinical-agent-runtime.contract.test.cjs: 0BB26A84D691FF77685EB5FCF4FC46CFDF8DC244759BECA9F33159AFDA0D7543
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
- write_allowlist:
  - app/js/clinical-agent-runtime.js
  - tests/v5.2.0/clinical-agent-runtime.contract.test.cjs
  - docs/delivery-reports/XJ-5.2.0-RUNTIME-FACADE-009-ESCALATION-011.md
- forbidden: all 001-008 source/test/report files; escalation 010 report; UI/HTML/CSS/Electron/preload/main/Store/AI/ClinicalContext/package/version/release files; commits, pushes, merges, uploads, signing, publishing, real clinical data or external messages
- required_behavior:
  - fromGlobals({ timeoutMs: 5 }) stores a default timeout used by execute(confirmed) when no execute option is supplied; execute({ timeoutMs }) overrides the default.
  - Each execute entry owns its controller/signal. Manual runtime.cancel while pending aborts that controller when supported; AI.send sees its own signal aborted, and concurrent executions do not share activeSignal state.
  - Timeout and manual cancel both return stable ai-cancelled; late callback/promise cannot return draft-ready; timers clear; replay remains invalid.
  - Existing CommonJS fallback, callback/promise/error mapping, confirmation gate, metadata privacy and no-persistence behavior remain intact.
- required_tests: default timeout via fromGlobals; execute timeout override; AI.send signal abort observed after runtime.cancel; two concurrent AI sends receive distinct signals and cancelling one does not abort the other; late result suppression and no raw error leakage.
- acceptance_commands:
  - node --test tests/v5.2.0/clinical-agent-runtime.contract.test.cjs
  - node --test tests/v5.2.0/clinical-agent-tasks.contract.test.cjs tests/v5.2.0/clinical-agent-router.contract.test.cjs tests/v5.2.0/clinical-agent-run.contract.test.cjs tests/v5.2.0/clinical-agent-context-bridge.contract.test.cjs tests/v5.2.0/clinical-agent-workflow.contract.test.cjs tests/v5.2.0/clinical-agent-adapter.contract.test.cjs tests/v5.2.0/clinical-agent-runtime.contract.test.cjs
  - node --check app/js/clinical-agent-runtime.js; node --check tests/v5.2.0/clinical-agent-runtime.contract.test.cjs
  - git diff --check -- app/js/clinical-agent-runtime.js tests/v5.2.0/clinical-agent-runtime.contract.test.cjs docs/agent-coordination/v5.2.0/tasks/XJ-5.2.0-RUNTIME-FACADE-009-ESCALATION-011.md docs/delivery-reports/XJ-5.2.0-RUNTIME-FACADE-009-ESCALATION-011.md
  - Get-FileHash app/js/agent-core.js,app/js/clinical-context.js,app/js/store.js,app/js/agent-tools.js,app/js/clinical-agent-tasks.js,app/js/clinical-agent-router.js,app/js/clinical-agent-run.js,app/js/clinical-agent-context-bridge.js,app/js/clinical-agent-workflow.js,app/js/clinical-agent-adapter.js,package.json,package-lock.json -Algorithm SHA256
- checkpoints: A read card and hashes; B focused default-timeout/cancel/concurrency tests; C full regression, syntax, diff, hash, allowlist and adversarial review.
- rollback: restore only runtime/test to baseline hashes and remove 011 report; preserve all prior evidence and unrelated worktree changes.
- delivery_report: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-RUNTIME-FACADE-009-ESCALATION-011.md
- acceptance_owner: /root

## Agent Instructions

你是执行代理，不是项目负责人；/root 负责最终验收。你不是独自在代码库中工作，保留未知改动，不得回退。先运行独立探针证明两个缺口，再修改 allowlist。交付报告必须包含真实探针、测试、哈希和内部对抗审查，最后一行严格使用：

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-RUNTIME-FACADE-009-ESCALATION-011.md
