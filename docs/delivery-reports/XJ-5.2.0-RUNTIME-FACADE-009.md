# XJ-5.2.0-RUNTIME-FACADE-009 Delivery Report

- task_id: XJ-5.2.0-RUNTIME-FACADE-009
- status: delivered for Codex intake; no UI/Electron/Store/AI integration
- model/profile: task card specifies gpt-6.1-sol-low; platform model independently unverifiable
- base_commit: eb16e2b74e6ab919a782b8bc6f66bfe9524431f2
- scope: new runtime facade, new runtime contract, and this report only

## Checkpoint A

- Read AGENTS.md, the 009 task card, 001–008 reports, and protected workflow/adapter sources and tests.
- Branch/base matched release/3.6.3-mac / eb16e2b74e6ab919a782b8bc6f66bfe9524431f2.
- No second writer or protected-file drift was observed; unrelated worktree changes were preserved.
- Recomputed protected hashes matched all 12 task-card values before and after implementation.

## Implementation

- Added a non-persisting runtime facade that privately binds workflow metadata handles to adapter handles.
- prepare performs workflow admission then adapter admission exactly once; adapter rejection cancels the workflow handle and returns stable failure.
- confirm is the only execution path; execute consumes one bound adapter handle and returns draft-only metadata.
- Added explicit supervision-question-builder/session-review task forwarding, cancellation, replay rejection, metadata-only projection, and callback/promise-shaped fromGlobals AI executor construction.
- No Store, ClinicalContext durable action, persistence, UI, Electron, network, or provider integration was added.

## Verification

- Focused runtime contract: exit 0, 4/4 passed.
- Full v5.2.0 contract suite: exit 0, 43/43 passed.
- All required node --check commands: exit 0.
- Required git diff --check: exit 0.
- Protected SHA-256 verification: exit 0, all 12 hashes matched task card.
- No commit, push, merge, upload, signing, publishing, real clinical data, or external message action.

## Internal adversarial review

- Removed adapter binding or used workflow-only success: positive runtime tests would fail because adapter handles and adapter rejection are asserted.
- Called executor before confirmation: confirmation test keeps executor count at zero.
- Replayed a confirmed handle: private state is consumed once and replay returns invalid-confirmed-state.
- Removed cancellation guard or accepted late result: cancellation test returns stable cancelled and no draft-ready result.
- Swallowed adapter/AI failure or exposed raw provider errors: stable failure and metadata-only assertions fail.
- Replaced canonical adapter snapshot with request snapshot: existing adapter canonical-key conflict tests remain red.
- Removed supervision/session task forwarding: build/task mapping assertions fail.
- Exposed private handles, messages, executor, Store, or persistence: projection/error JSON checks fail.
- Callback/promise AI entry is constructed through fromGlobals; raw provider errors are normalized to ai-failed.
- Tests execute real UMD modules and injected dependency entry points; no source-string-only acceptance was used.

## Severity and residual risk

- P0=0, P1=0, P2=0, P3=0.
- The facade is intentionally not wired to runtime pages, Electron, Store, durable persistence, or a production AI provider; those require a later explicitly authorized stage.
- This delivery does not mark 5.2.0 release-ready and requires independent Codex intake.

## Follow-up Codex Intake Repair

- Initial intake found that fromGlobals constructed an executor but the facade did not use it, so AI.send was unreachable; it also found direct root capture, incomplete AI error mapping, and insufficient real AI tests.
- Repaired only this stage allowlist: fromGlobals now constructs the adapter through ClinicalAgentAdapter.withDependencies({ context, executor }), injects the executor into the real adapter execute path, and uses the factory-injected global root safely for UMD/Node loading.
- AI callback/promise errors normalize to ai-failed; interrupted/cancelled/aborted results normalize to ai-cancelled; raw provider error text is not returned. Adapter cancellation receives the available signal/cancellation option.
- Added real fromGlobals -> prepare -> confirm -> execute coverage asserting AI.send call count, payload message, metadata options, callback success, promise rejection, provider error, and interrupted failure behavior.
- Final focused runtime contract: exit 0, 4/4. Final full v5.2.0 contract suite: exit 0, 43/43. node --check, git diff --check, and all 12 protected hashes: exit 0.
- Internal adversarial review repeated after repair: bypassing adapter, calling AI before confirmation, swallowing provider errors, resolving after cancellation, exposing raw errors, or removing the awaited adapter path is covered by failing assertions.

## Second Follow-up Codex Intake Repair

- Local probe found interrupted callback was reported as executor-failed/ai-failed; runtime now preserves ai-cancelled and ai-failed without provider text.
- Fixed CommonJS UMD global fallback by injecting global root into the factory.
- Added execute-lifetime cancellation and timeout/late-result guarding; pending cancel returns ai-cancelled and replay remains rejected.
- Forwarded signal/cancellation through adapter execution into AI.send third-argument options.
- Final focused runtime contract: exit 0, 4/4. Final full 001–009 suite: exit 0, 43/43. node --check, git diff --check, and all 12 protected hashes: exit 0.
- Adversarial checks cover interrupted/error callback and promise paths, no AI before confirmation, pending cancel, signal/options, late-result suppression, private-handle isolation, and replay failures.

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-RUNTIME-FACADE-009.md
