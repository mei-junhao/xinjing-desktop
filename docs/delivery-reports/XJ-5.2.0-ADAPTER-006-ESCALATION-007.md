# XJ-5.2.0-ADAPTER-006-ESCALATION-007 Delivery Report

- task_id: XJ-5.2.0-ADAPTER-006-ESCALATION-007
- status: delivered for Codex intake; no runtime/UI integration
- model/profile: gpt-6.1-sol-low (platform task assignment)
- scope: allowlisted adapter and contract test only

## Repairs

Request source metadata is now validated independently, stale/isStale/status=stale request markers return stable `stale-snapshot` (including missing/empty/duplicate/malformed sources returning `invalid-context`), and request/built source kind+id sets must match exactly or return `source-mismatch` before executor admission. Request source client/session metadata is reconciled with built metadata, and request and built origins are reconciled with stable client/session mismatch reasons.

## Verification

- `node --test tests/v5.2.0/clinical-agent-adapter.contract.test.cjs`: PASS, 12/12.
- Full v5.2.0 contract suite (tasks/router/run/context-bridge/workflow/adapter): PASS, 36/36.
- All required `node --check` commands for the adapter and 001–005 contract modules: PASS.
- `git diff --check` on allowlisted source/test: PASS.
- Protected-file SHA256 hashes recomputed; all 11 match task card.
- No commits, pushes, merges, network writes, runtime/UI changes, persistence changes, or real clinical data.

## Codex independent intake

- Reviewed the delivered diff and found one boundary gap before acceptance: the first implementation classified missing/empty request sources as `malformed-request`, and did not compare request-side source client/session metadata with the exact built source entry.
- Repaired only the allowlisted adapter and focused test. The final focused run is 12/12 and the broad regression run is 36/36; the report now reflects those raw results.
- Protected-file hashes were independently recomputed after the repair and match all 11 card values exactly.

## Internal adversarial review

- Removed request/built source-set comparison: new source-mismatch test fails.
- Changed request stale handling to malformed: three stale-marker assertions fail.
- Skipped origin reconciliation: request/built origin conflict test fails.
- Removed request-source validation split: missing/empty/duplicate/malformed source assertions fail, and build/executor call counts prove admission stops first.
- Removed request/built source identity comparison: client/session substitution assertions fail.
- Bypassed admission failure: source mismatch returns before executor and positive lifecycle remains intact.
- Removed await/freshness checks: existing stale-after and async lifecycle tests fail.
- Projection remains metadata-only; executor payload remains isolated; malformed drafts and old handles remain fail-closed.

## Severity and residual risk

P0=0, P1=0, P2=0, P3=0. Adapter remains intentionally unintegrated with runtime/UI and durable persistence; that is outside this escalation allowlist.




## Follow-up Codex intake finding

- Found and repaired canonical snapshot-key conflict: built.snapshot.key is authoritative; conflicting built.snapshotKey now fails with snapshot-mismatch.
- Added a real conflict regression proving forged aliases cannot be admitted; matching aliases remain accepted.
- One prior focused run failed because an old fixture used snapshot:{} with snapshotKey:other; the fixture was corrected to snapshot:{key:snap-1} and final runs are green.
- Final focused adapter contract: PASS, 13/13. Final full v5.2.0 contract suite: PASS, 37/37.
- Final node --check, git diff --check, and protected-file SHA256 verification: PASS; all 11 protected hashes unchanged.

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-ADAPTER-006-ESCALATION-007.md
