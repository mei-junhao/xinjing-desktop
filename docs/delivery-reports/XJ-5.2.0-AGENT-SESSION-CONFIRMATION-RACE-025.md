# XJ-5.2.0-AGENT-SESSION-CONFIRMATION-RACE-025

[STATUS] delivered; allowlist only.

[ARTIFACTS]
- app/js/agent-api.js: post-await closed checks for onConfirm and fallback writeGuard.
- tests/v5.2.0/agent-session-stream-callback.contract.test.cjs: real VM race regressions.

[VALIDATION]
- focused 8/8 PASS; full v5.2.0 82/82 PASS; node check and diff check PASS.
- controlled Electron: SUPERVISION_STATUS=PASS.
- mutation removal of post-await checks made both race tests FAIL; restored and reran PASS.
- protected SHA-256 hashes unchanged.

P0-P3: all zero.

## Internal adversarial review
- Production VM entry used; no facade mock or source-string assertion.
- Pre-close confirmation remains positive; post-close onConfirm and fallback guard late success fail closed; write count zero.
- Async branches awaited; timeout/rejection, unknown tool, allowWrite=false and guard errors covered.
- Only allowlist files changed; no network, real data, commit or publish.

Residual risk: provider promises remain non-cancellable, but closed sessions cannot authorize writes.

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-SESSION-CONFIRMATION-RACE-025.md
