'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const source = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const records = [];
function record(id, label, pass, detail) {
  records.push({ id, label, status: pass ? 'PASS' : 'FAIL', detail: detail || '' });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'} ${id} ${label}${detail ? `: ${detail}` : ''}\n`);
  assert.equal(pass, true, `${id} ${label}`);
}

const main = source('main.js');
const preload = source('preload.js');
const store = source('app/js/store.js');
const entitlements = source('app/js/entitlements.js');
const ai = source('app/js/ai.js');
const facade = source('app/js/commercial-ipc-facade.js');

record('C01', 'main imports and owns commercial facade', /createCommercialFacade/.test(main) && /ensureCommercialFacade/.test(main));
record('C02', 'all stable commercial IPC channels are registered', [
  'getModelPriceCatalog', 'getAccountBalance', 'quoteRequestCharge', 'reserveRequestCharge',
  'settleRequestCharge', 'releaseRequestCharge', 'markRequestUnknown', 'reconcileRequestCharge',
].every((name) => main.includes(`xj:commercial:${name}`)));
record('C03', 'preload exposes a frozen commercial allowlist', /commercial:\s*Object\.freeze\(/.test(preload) && [
  'getModelPriceCatalog', 'getAccountBalance', 'quoteRequestCharge', 'reserveRequestCharge',
  'settleRequestCharge', 'releaseRequestCharge', 'markRequestUnknown', 'reconcileRequestCharge',
].every((name) => preload.includes(`xj:commercial:${name}`)));
record('C04', 'facade rejects sensitive and unknown fields', /sensitive-field-rejected/.test(facade) && /!allowed\.has\(key\)/.test(facade));
record('C05', 'facade owns one file envelope with CAS and rollback', /commercial-envelope-v3\.json/.test(main + facade) && /current\.revision !== snapshot\.revision - 1/.test(facade) && /restorePrevious/.test(facade));
record('C06', 'renderer cannot choose money mode', /billingMode:\s*'money-per-request'/.test(facade) && !/input\.billingMode/.test(facade.slice(facade.indexOf('async function reserveRequestCharge'), facade.indexOf('async function chargeTransition'))));
record('C07', 'AI waits for the non-money projection', /processCommercialAiRequest/.test(main) && /await processCommercialAiRequest\(request\)/.test(main));
record('C08', 'AI forwards only redacted projection to renderer cache', /acceptCommercialProjection/.test(ai) && /setCommercialProjection/.test(ai) && /setCommercialProjection/.test(store));
record('C09', 'entitlements validates without owning balance', /normalizeCommercialProjection/.test(entitlements) && !/idbPut\([^\n]*commercial/i.test(store));
record('C10', 'production behavior test passes', (() => {
  const run = spawnSync(process.execPath, ['--test', 'tests/v5.0.0-production/commercial-production-integration.test.js'], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
  });
  if (run.status !== 0) process.stdout.write(run.stdout + run.stderr);
  return run.status === 0;
})());

process.stdout.write(`COMMERCIAL_PRODUCTION_CONTRACT: PASS (${records.length}/${records.length})\n`);
