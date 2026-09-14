'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SOURCE_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-commercial-mutant-'));
const TEMP_APP = path.join(TEMP_ROOT, 'app', 'js');
fs.mkdirSync(TEMP_APP, { recursive: true });
for (const name of ['commercial-ipc-facade.js', 'commercial-durable-persistence.js', 'commercial-billing-core.js', 'commercial-state-machine.js', 'entitlements.js']) {
  fs.copyFileSync(path.join(SOURCE_ROOT, 'app', 'js', name), path.join(TEMP_APP, name));
}

const facadePath = path.join(TEMP_APP, 'commercial-ipc-facade.js');
const before = fs.readFileSync(facadePath, 'utf8');
const anchor = "if (request.context.trusted && request.context.signatureValid !== true) return failure('invalid-license');";
assert.equal(before.includes(anchor), true, 'trusted evidence guard anchor exists');
const mutant = before.replace(anchor, "if (false) return failure('invalid-license');");
assert.notEqual(mutant, before, 'mutant must change the isolated copy');
fs.writeFileSync(facadePath, mutant, 'utf8');

const statePath = path.join(TEMP_ROOT, 'state.json');
const script = `
  const fs = require('node:fs');
  const m = require(${JSON.stringify(facadePath)});
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(m.initialEnvelope()));
  (async () => {
    const f = await m.createCommercialFacade({
      filePath: ${JSON.stringify(statePath)}, deviceId: 'device:alpha',
      trustedContextProvider: () => ({ deviceBindingHash: 'device:alpha', revocationEpoch: 0, signedEvidence: { signatureValid: false, clockValid: true, subscriptionId: '' } }),
    });
    const r = await f.applyOrderEvent({ requestId: 'req-mutant', operationId: 'op-mutant', expectedRevision: 0, payload: { orderId: 'order-mutant', nextState: 'paid', fields: { amountMinor: 1, currency: 'CNY' } } });
    await f.close();
    process.exit(r && r.ok === false && r.errorCode === 'invalid-license' ? 0 : 1);
  })().catch(() => process.exit(1));
`;
const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 });
try {
  assert.notEqual(run.status, 0, `trusted evidence mutant survived: ${run.stdout || ''}${run.stderr || ''}`);
  process.stdout.write('KILLED trusted-evidence-bypass\n');
  process.stdout.write('COMMERCIAL_INTEGRATION_MUTATIONS: PASS (1/1)\n');
} finally {
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
}
