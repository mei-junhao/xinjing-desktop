'use strict';

/*
 * Codex-owned prewrite gate for v5 commercial request billing.
 * This runner is intentionally EXPECTED_RED: it proves that the live
 * production entry points do not yet claim the frozen v3 surface. It is not
 * production acceptance and must be replaced by behavior-level checks once
 * the real integration exists.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const files = {
  contract: path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'contracts', 'v5.0-commercial-request-billing-v3.md'),
  main: path.join(ROOT, 'main.js'),
  preload: path.join(ROOT, 'preload.js'),
  store: path.join(ROOT, 'app', 'js', 'store.js'),
  entitlements: path.join(ROOT, 'app', 'js', 'entitlements.js'),
  ai: path.join(ROOT, 'app', 'js', 'ai.js'),
  stateMachine: path.join(ROOT, 'app', 'js', 'commercial-state-machine.js'),
};

const source = {};
Object.keys(files).forEach((key) => {
  assert(fs.existsSync(files[key]), `missing source: ${files[key]}`);
  source[key] = fs.readFileSync(files[key], 'utf8');
});

const contract = source.contract;
assert(contract.includes('v5.0-commercial-request-billing-v3'), 'wrong contract version');
assert(contract.includes('commercial.getModelPriceCatalog'), 'contract channel inventory missing');
assert(contract.includes('commercial.reconcileRequestCharge'), 'contract reconciliation channel missing');

let expectedRed = 0;
let failed = 0;
let checks = 0;
function check(id, label, observedGap) {
  checks += 1;
  if (observedGap) {
    expectedRed += 1;
    process.stdout.write(`EXPECTED_RED ${id} ${label}\n`);
  } else {
    failed += 1;
    process.stdout.write(`FAIL ${id} ${label}\n`);
  }
}

// These are prewrite observations, not evidence that the future behavior is safe.
check('R1', 'preload has no commercial bridge namespace', !/commercial\s*[:=]/.test(source.preload));
check('R2', 'main has no commercial IPC handlers', !/commercial\.(getModelPriceCatalog|getAccountBalance|quoteRequestCharge|reserveRequestCharge|settleRequestCharge|releaseRequestCharge|markRequestUnknown|reconcileRequestCharge)/.test(source.main));
check('R3', 'main has no v5 billing-mode derivation', !/money-per-request|request-count-quota|pending-reconciliation/.test(source.main));
check('R4', 'Store has no durable commercial envelope owner', !/commercialEnvelope|requestCharges|reservedMinor|operationReceipts/.test(source.store));
check('R5', 'AI renderer path has no billing/account-balance projection', !/accountBalance|chargedMinor|billingMode|chargeStatus/.test(source.ai));
check('R6', 'entitlements has no commercial request billing policy surface', !/request-billing|money-per-request|request-count-quota/.test(source.entitlements));
check('R7', 'legacy commercial state machine has no v5 envelope API', !/createCommercialEnvelope|reserveRequestCharge|reconcileRequestCharge/.test(source.stateMachine));
check('R8', 'production does not yet expose a shared commercial revision readback', !/commercialRevision|envelopeRevision|readback-mismatch/.test(`${source.main}\n${source.preload}\n${source.store}`));
check('R9', 'production has no explicit no-money projection boundary', !/chargeStatus\s*:\s*['"]not-applicable['"]/.test(`${source.main}\n${source.preload}\n${source.ai}`));
check('R10', 'production has no v5 commercial failure-code family', !/catalog-revision-mismatch|operation-conflict|stale-revision|durable-write-failed/.test(`${source.main}\n${source.preload}\n${source.store}`));

assert.strictEqual(failed, 0, 'production is partially integrated; expected-red baseline must be reviewed before proceeding');
process.stdout.write(`EXPECTED_RED_GATE: PASS (${expectedRed}/${checks}); production integration remains absent\n`);
