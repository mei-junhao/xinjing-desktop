# XJ-5.2.0-ADAPTER-006 Delivery Report

- task_id: XJ-5.2.0-ADAPTER-006
- contract_id: xj-5.2.0-clinical-context-supervision-adapter-v1
- agent_profile_id: gpt-6.1-sol-low
- status: delivered for Codex intake after final same-card rework; no runtime/UI integration
- lifecycle: received -> running -> intake-rework -> intake-rework-final -> delivered

## Historical evidence

The earlier report recorded `rejected` because the task card was absent at that time. The authoritative card now exists; that reason is retained as historical evidence, and this report supersedes the prior status.

The first Codex intake also identified two contract gaps: snapshot key mismatch was not rejected, and source client/session identity mismatch was not validated. Both were repaired within this card allowlist.

The second intake identified real-interface and boundary gaps: the key is `built.snapshot.key`, request/built source metadata needed strict validation and stale markers, built origin needed reconciliation, messages needed non-empty shape validation, and drafts needed plain-object enforcement. These were repaired in the final attempt.

## Artifacts

- `app/js/clinical-agent-adapter.js`
- `tests/v5.2.0/clinical-agent-adapter.contract.test.cjs`
- `docs/delivery-reports/XJ-5.2.0-ADAPTER-006.md`

## Implementation

Added a pure UMD adapter with injected `context.build`, `context.isSnapshotCurrent`, and `executor` dependencies. It normalizes the real `built.snapshot.key` shape (without request-key fallback), validates non-empty unique request/built source metadata and stale markers, reconciles request/built origins with source identities, requires non-empty role/content messages, checks freshness before and after awaited execution, accepts only strings or plain objects as drafts, and preserves cancellation, old-handle invalidation, payload isolation, and metadata-only projection. No Store, persistence, AI, network, Electron, or UI integration was added.

## Verification

- Focused adapter contract: exit 0, 8/8 passed.
- Full v5.2.0 contract suite: exit 0, 32/32 passed.
- All required `node --check` commands: exit 0.
- Required `git diff --check`: exit 0.
- Protected hashes recomputed and matched task card exactly for all 11 protected files.
- No commits, pushes, merges, network writes, or real clinical data.

## Scope and severity

- P0=0, P1=0, P2=0, P3=0.
- Only allowlisted adapter source, focused test, and this report were written.
- Existing runtime, accepted contracts, package files, UI, and persistence were untouched.

## Internal adversarial review

- Removed `await`: async gate test requires executor completion before draft-ready.
- Replaced freshness or skipped the second check: stale-after test fails.
- Swallowed executor errors or exposed raw error text: stable `executor-failed` and no secret leakage assertions pass.
- Injected persistence/saveSupervision spies: no persistence dependency or call path exists.
- Mutated executor payload: private context remains isolated.
- Replayed old handle after success/failure: returns `invalid-state`.
- Malformed sources, missing context, cancellation, malformed draft, and wrong output mode fail closed.
- Projection body-leak probe found no messages, inputText, executor, persist, or private context.
- Snapshot mismatch mutation (`built.snapshotKey` differs from request) returns stable `snapshot-mismatch`; focused test is red if equality check is removed.
- Cross-client/session probes with explicit origin and conflicting source identities without origin return stable mismatch reasons; focused tests are red if identity checks are removed.
- Real-shape probe uses `snapshot: { key: 'snap-1' }`; absence/mismatch of normalized key fails closed without request-key fallback.
- Empty, duplicate, malformed, stale, and identity-conflicting request/built sources fail closed.
- Date/function/array/null/undefined executor drafts are rejected; only strings and plain objects reach draft-ready.

## Remaining risk

The adapter is intentionally not integrated with runtime/UI or durable persistence; independent Codex intake must approve integration separately.

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-ADAPTER-006.md
