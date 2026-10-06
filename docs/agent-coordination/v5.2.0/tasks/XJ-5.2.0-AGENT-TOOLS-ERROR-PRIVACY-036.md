# Task Card: XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-036

- task_id: XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-036
- objective: Close the confirmed AgentTools exception-text privacy leaks from audit 035. Keep tool success/validation contracts, partial billing result shape, and safe structured failure metadata; ensure lower-layer/provider/storage/clinical exception text cannot escape through public tool results or console logs.
- owner: codex (/root), implementation and acceptance per user instruction
- manager: codex (/root)
- project_root: D:/xinjing-electron
- branch_or_worktree: release/3.6.3-mac; shared working tree; do not switch branch or create a worktree
- base_commit: eb16e2b74e6ab919a782b8bc6f66bfe9524431f2
- active_release_train: 5.2.0 implementation; stage 036; not release-ready
- config_evidence_id: cfg-5.2.0-20261006-agent-tools-error-privacy-036
- agent_profile_id: codex-primary; model/reasoning not exposed by task tools, cannot independently verify
- contract_id: xj-5.2.0-agent-tools-error-privacy-v2
- write_lock_id: lock-5.2.0-agent-tools-error-privacy-036
- protected_files_manifest_hash: recompute before and after; main.js, preload.js, agent-api.js, agent-core.js, package.json and package-lock.json are protected and read-only
- benchmark_manifest: expected-red then real production AgentTools VM probes for add_record, monthly_settle, client.update, supervision start/ask, masters open/message, safe validation/success/structured metadata, console privacy, 5.2.0 regression contracts, controlled Electron runner
- visual_baseline: none; no UI changes
- current_target_hashes:
  - app/js/agent-tools.js: 0327989930E21278CD5751B2ED1DB29DC4142BD883FB16873795733756F5CCD9 (includes prior dirty 034 changes)
  - tests/v5.2.0/agent-tools-error-privacy.contract.test.cjs: read current on start; existing test is part of prior delivery and must be extended, not overwritten
  - docs/delivery-reports/XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-AUDIT-035.md: read-only audit evidence
  - app/js/agent-api.js: 33B49EA81F54DA07A2DB1E67BF28DBB03E1431E0AF05C59BC151BC1980450388
  - app/js/agent-core.js: 00F758CE37702108AF4FF9BF48C294EDCB5BC32480B6DD6AD6DFD7F7235A5AD2
  - main.js: 6F01CCB23DCA8A75C32BABA913310FFB491FB65287F9BE23686CFFCB4925D581
  - preload.js: 9F922668F0FF93954DE63834292D0B56F5040C67CD885D826CB87722AB6987DD
  - package.json: B74E0AA8F9B645D06647096545A3C611C112EF217AABADEA407B1950D629FC72
  - package-lock.json: FDB8D11766CE697211B6C21AEE91E488ECD8E12FEAFF725C568D629061CB03
- authorization:
  - production_changes: allowed only in listed source allowlist
  - test_changes: allowed only in listed test allowlist
  - local_commit/push/merge/package/sign/upload/publish: denied
- write_allowlist:
  - app/js/agent-tools.js
  - tests/v5.2.0/agent-tools-error-privacy.contract.test.cjs
  - docs/delivery-reports/XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-036.md
- forbidden:
  - all files outside write_allowlist, especially main.js, preload.js, Store, AgentCore/API, UI, package/version/build/release files
  - production behavior changes unrelated to safe error projection; schema/kind/confirmation/persistence/success keys or stable validation wording changes
  - modifying file.read/file.write IPC result wording in this stage; real main-process file errors are fixed error codes and explicit permission guidance, not raw Error.message
  - test weakening, mocks in place of production AgentTools, test hooks, real clinical data, external network/remote state, commits, merges, signing, packaging, upload or publish
- required_behavior:
  - Existing 034 top-level invoke catch and monthly-settle catch safe wording remain intact.
  - billing.add_record must keep {ok:true,data.details[]} partial-result contract, but replace lower-layer error.message in record creation/session persistence detail with stable operation-specific text; do not include raw Error or unknown object text.
  - billing.monthly_settle and client.update must use stable safe failures for returned error objects as well as thrown Error/unknown objects.
  - toolFailure used by supervision.start/ask and masters.open/message must emit its operation fallback text instead of raw lower-layer error text, while preserving only safe structured fields: bounded enum-like code/errorCode/stage/transportState tokens, non-negative safe-integer failed segment indexes, finite non-negative numeric counts, and boolean truncated. Invalid or free-form metadata is omitted.
  - supervision start/ask and masters open/message catches must not expose Error.message or arbitrary thrown object fields.
  - supervision.ask persistence catch must retain existing success return behavior but log no exception text or raw object; use a fixed safe log label only.
  - Preserve stable business/validation errors and representative success result shapes. Do not alter file permission/help messages in this task.
- required_tests:
  - Add expected-red real VM assertions before source repair; capture that the tests fail against the current confirmed leak.
  - Load production agent-tools.js and call actual window.AgentTools.invoke(), awaiting results.
  - Cover add_record nested returned error and rejection, monthly settle error object/rejection on new and append paths, client.update returned error/rejection, supervision and masters returned error/Error/unknown-object paths, and supervision.ask save catch console privacy.
  - Assert the secret is absent from serialized result and console, representative stable validation strings remain exact, successes retain their expected keys, partial billing stays ok:true with details, safe metadata is preserved and malformed/free-form metadata is omitted.
  - Mutation check: temporarily restore a raw error projection in a disposable copy/controlled mutation, demonstrate focused test failure, then restore the intended source without touching unrelated work.
- acceptance_commands:
  - node --test tests/v5.2.0/agent-tools-error-privacy.contract.test.cjs
  - node --test tests/v5.2.0/*.contract.test.cjs
  - node --check app/js/agent-tools.js
  - node --check tests/v5.2.0/agent-tools-error-privacy.contract.test.cjs
  - node tests/v5.2.0/015-local-electron-acceptance.cjs
  - git diff --check -- app/js/agent-tools.js tests/v5.2.0/agent-tools-error-privacy.contract.test.cjs docs/delivery-reports/XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-036.md
  - Get-FileHash app/js/agent-tools.js,app/js/agent-api.js,app/js/agent-core.js,main.js,preload.js,package.json,package-lock.json -Algorithm SHA256
- checkpoints:
  - A: confirm baseline diff/hashes and read 035 report, 034 test and real handler/IPC contracts
  - B: add expected-red tests and run focused failure against current source
  - C: implement only allowlisted projections; focused contract and mutation sensitivity pass
  - D: all v5.2.0 contracts, controlled Electron, protected hashes, report and diff review
- rollback: revert only this card's minimal changes in the three allowlisted files; preserve pre-existing 034 and unrelated changes; never reset/clean/revert unknown files
- stop_conditions:
  - a required fix needs a protected or unlisted file, changes a stable validation/success contract, requires UI/IPC semantics, or test evidence cannot use the real module
  - any protected hash drift, second writer conflict, real-data/network action, or remaining synthetic secret in result/log
- delivery_report: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-036.md
- acceptance_owner: /root
- next_after_acceptance: continue with a new bounded audit only if P1 remains; no release-ready or packaging claim

## Agent Instructions

本卡由 Codex 主负责人本人执行和验收。开始前读取 AGENTS.md、035 审计报告、当前 034 测试和真实 IPC 契约；保留工作树中已有的所有修改。先添加预期失败测试并实际运行，再修复；不得先改生产代码再补测试。只允许修改上方 allowlist。交付前做独立内部对抗审查，检查真实入口、正负路径、返回字段、未知对象、异步等待、日志、反向变异、写集与保护哈希；报告列出真实命令和结果、P0-P3、残余风险、未授权动作。末行严格为：

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-036.md
