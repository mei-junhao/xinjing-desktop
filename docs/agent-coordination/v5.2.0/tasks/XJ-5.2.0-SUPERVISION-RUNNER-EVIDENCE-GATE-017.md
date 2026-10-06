# XJ-5.2.0-SUPERVISION-RUNNER-EVIDENCE-GATE-017

- task_id: XJ-5.2.0-SUPERVISION-RUNNER-EVIDENCE-GATE-017
- owner: gpt-6.1-sol-low
- manager: Codex /root
- project_root: D:/xinjing-electron
- branch_or_worktree: release/3.6.3-mac; shared worktree; do not switch branches or create commits
- base_commit: eb16e2b74e6ab919a782b8bc6f66bfe9524431f2
- active_release_train: 5.2.0 implementation; stage 017; not release-ready
- config_evidence_id: cfg-5.2.0-20261005-supervision-runner-evidence-gate-017
- agent_profile_id: gpt-6.1-sol-low
- contract_id: xj-5.2.0-supervision-runner-evidence-gate-v1
- write_lock_id: lock-5.2.0-supervision-runner-evidence-gate-017
- write_allowlist: tests/v5.2.0/015-local-electron-acceptance.cjs; docs/delivery-reports/XJ-5.2.0-SUPERVISION-PRODUCTION-INTEGRATION-015.md
- forbidden: app/** production code; package/version/release files; other tests; real data/network; commit/merge/push/sign/upload/publish

## Context

Stage 016 produced a real synthetic register/verify/login and entered `supervision.html`, but the latest evidence is incomplete: `secondConfirm=false`, post-confirm `action=0/ai=0`, and the page reports `督导桥接未就绪`. The runner currently exits 0 because its pass condition only checks raw-leak, focus, and the inverted no-overflow field. This is a false-green acceptance gate. Do not accept or mask the production bridge failure.

## Objective

Harden the existing controlled Electron/CDP runner so it can distinguish a real supervision production-bridge execution from an unavailable bridge, and fails closed when required evidence is absent. Diagnose the actual renderer/DOM/bridge state with structured JSON; do not fix production code in this task.

## Required Work

1. Keep the synthetic auth flow, temporary `userData`, loopback CDP, `XJ_AGENT_ACCEPTANCE=1`, and default-deny network. Preserve the existing real Electron route into `supervision.html`.
2. Rename or clarify the inverted overflow probe so the JSON says `noHorizontalOverflow` (true only when there is no horizontal overflow). Preserve the raw measurement.
3. Make the confirmation probe deterministic and observable: record whether the first dialog appeared, its safe text, whether cancel resolved, whether a second dialog appeared, and the DOM/bridge status immediately before and after each click. Do not treat a missing second dialog as success.
4. Require safe confirmation evidence to include a material/source label and character metadata (`chars` or `estimatedChars`, plus `truncated` semantics when present) while excluding raw body, messages, executor, private context, lifecycle handles, and AI payloads.
5. Exercise the actual standard generation callback. If the bridge is unavailable, record a structured `bridgeUnavailable` reason and fail with nonzero exit; do not stub around it or claim provider/cancel success. If the bridge becomes available, prove action-run/AI counts and order, provider failure or cancellation status, and final UI state with awaited DOM evidence.
6. Make the final pass predicate require all mandatory evidence: auth/page load, script order, first confirmation/cancel gate, safe summary, `noHorizontalOverflow`, focus/reduced-motion probes, second confirmation, and a real post-confirm outcome (`providerError` or `cancelled`) with the expected action/AI transition. Any missing or ambiguous field fails.
7. JSON and PNG evidence remain under `tests/v5.2.0/artifacts/<run>/`; failure JSON must include startup, HTTP/auth, DOM, CDP, and renderer diagnostics available at the failure point.

## Validation

Run and record in the 015 report:

- `node --check tests/v5.2.0/015-local-electron-acceptance.cjs`
- `node tests/v5.2.0/015-local-electron-acceptance.cjs` (must exit nonzero while the bridge is unavailable; must exit zero only with complete positive evidence)
- `node --test tests/v5.2.0/*.contract.test.cjs`
- `git diff --check -- tests/v5.2.0/015-local-electron-acceptance.cjs docs/delivery-reports/XJ-5.2.0-SUPERVISION-PRODUCTION-INTEGRATION-015.md`

The report must explicitly classify stage 017 as blocked/incomplete if the bridge remains unavailable. It must include an independent adversarial review: weaken the pass predicate, set `secondConfirm=false`, skip the await, expose raw payload, or bypass the real generation callback; each must fail or be called uncovered. No production code, version, package, commit, merge, or publishing changes. Preserve the final line exactly:

`DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-SUPERVISION-PRODUCTION-INTEGRATION-015.md`

## Stop Conditions

Stop and report blocked if completing this requires modifying production code or if the real bridge cannot be entered from the controlled Electron page. Stage 015 remains unaccepted and no later 5.2.0 stage may be planned until the evidence gate is truthful.

## Agent Instructions

You are the execution agent, not the acceptance owner. You are not alone in the repository; preserve unrelated changes. Read this card and the current 015 report before writing. Perform an independent adversarial self-review before delivery, including a check that the runner truly waits for asynchronous confirmation/provider state and that no mock or source-string check creates a false green. Return `[STATUS]`, `[ARTIFACTS]`, and `[VALIDATION]` in Chinese and stop writing after delivery.
