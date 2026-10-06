# XJ-5.2.0-SUPERVISION-RUNTIME-UMD-FIX-018

- task_id: XJ-5.2.0-SUPERVISION-RUNTIME-UMD-FIX-018
- owner: gpt-6.1-sol-low
- manager: Codex /root
- project_root: D:/xinjing-electron
- branch_or_worktree: release/3.6.3-mac; shared worktree; do not switch branches or create commits
- base_commit: eb16e2b74e6ab919a782b8bc6f66bfe9524431f2
- active_release_train: 5.2.0 implementation; stage 018; not release-ready
- config_evidence_id: cfg-5.2.0-20261005-supervision-runtime-umd-fix-018
- agent_profile_id: gpt-6.1-sol-low
- contract_id: xj-5.2.0-supervision-runtime-umd-fix-v1
- write_lock_id: lock-5.2.0-supervision-runtime-umd-fix-018
- write_allowlist: app/js/clinical-agent-runtime.js; tests/v5.2.0/clinical-agent-runtime.contract.test.cjs; tests/v5.2.0/015-local-electron-acceptance.cjs (only if needed to count the real AI call without stubbing it); docs/delivery-reports/XJ-5.2.0-SUPERVISION-PRODUCTION-INTEGRATION-015.md
- forbidden: other app production code; ClinicalContext/Store/AI/supervision.js/supervision.html unless the runner allowlist exception is strictly needed; package/version/release files; other tests; real data/network; commit/merge/push/sign/upload/publish

## Context and Root Cause

Stage 017 evidence gating is truthful but blocked. Read-only inspection found a browser UMD defect in `app/js/clinical-agent-runtime.js`: the browser branch assigns `root.ClinicalAgentRuntime = factory()` even though `fromGlobals()` later reads `globalRoot.ClinicalAgentWorkflow` and `globalRoot.ClinicalAgentAdapter`. In the real Electron page, `fromGlobals({ workflow, ClinicalContext, AI })` therefore dereferences an undefined `globalRoot` before the confirmation dialog. CommonJS tests do not expose this because their factory receives `globalThis`. Do not mask this with runner stubs.

## Objective

Fix the smallest browser-entry defect so the real `ClinicalAgentProductionBridge.fromGlobals` path initializes on `supervision.html`, while preserving all 013/014/015 contracts and private-data boundaries. Add a browser/UMD-sensitive contract assertion, then rerun the strict controlled Electron runner.

## Required Work

1. In the runtime UMD wrapper, pass the actual browser root into the factory (or make an equivalent minimal global-root resolution that preserves CommonJS behavior). Do not redesign the runtime or change lifecycle semantics.
2. Add a focused test that executes the browser-style UMD entry in a VM/global context with `ClinicalAgentWorkflow`, `ClinicalAgentAdapter`, `ClinicalContext`, and `AI` globals and proves `fromGlobals` reaches the real adapter factory instead of throwing `globalRoot` errors. Preserve all existing runtime tests and expected-red boundaries.
3. Use the existing strict runner. If the runner needs a non-invasive counter for the real `AI.send`, wrap it by calling the original function and recording only count/result status; never replace it with a synthetic success or prevent the default-deny provider failure. Keep `#confirm-modal.show` strict evidence and safe bridge diagnostics.
4. Confirm the real flow: synthetic auth, supervision page, first visible confirmation, cancellation with zero lifecycle/AI, second visible confirmation, action-run before the real AI call, and provider failure or cancellation feedback. A missing step remains nonzero.
5. Do not expose raw context, messages, executor, lifecycle handles, or AI payloads in JSON.

## Validation

Run and record in the 015 report:

- `node --check app/js/clinical-agent-runtime.js`
- `node --check tests/v5.2.0/015-local-electron-acceptance.cjs`
- `node --test tests/v5.2.0/clinical-agent-runtime.contract.test.cjs`
- `node --test tests/v5.2.0/*.contract.test.cjs`
- `node tests/v5.2.0/015-local-electron-acceptance.cjs`
- `git diff --check -- app/js/clinical-agent-runtime.js tests/v5.2.0/clinical-agent-runtime.contract.test.cjs tests/v5.2.0/015-local-electron-acceptance.cjs docs/delivery-reports/XJ-5.2.0-SUPERVISION-PRODUCTION-INTEGRATION-015.md`

The runner must exit zero only with complete positive evidence; if the bridge remains unavailable, exit nonzero and report the structured browser error. The report must include an adversarial review (restore `factory()`, bypass UMD test, stub AI success, move action-run after AI, skip await, expose private fields) and retain the final line exactly:

`DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-SUPERVISION-PRODUCTION-INTEGRATION-015.md`

## Stop Conditions

Stop and report blocked if the fix requires changing ClinicalContext/Store/AI/supervision business logic, if the UMD test cannot execute a real browser-style entry, or if controlled Electron still cannot produce an unambiguous provider/cancel transition after the runtime fix. No later 5.2.0 stage may be planned until this stage is independently accepted.

## Agent Instructions

You are the execution agent, not the acceptance owner, and you are not alone in the repository. Preserve unrelated changes. Read this card, the 015 report, and the current runner before writing. Complete an independent adversarial self-review before delivery; distinguish confirmed, stale, false, incomplete, and out-of-scope evidence. Return `[STATUS]`, `[ARTIFACTS]`, and `[VALIDATION]` in Chinese and stop writing after delivery.
