'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const corePath = path.join(root, 'app', 'js', 'privacy-observability-core.js');
const boundaryPath = path.join(root, 'app', 'js', 'privacy-observability-boundary.js');
const runtimePath = path.join(root, 'app', 'js', 'privacy-observability-runtime.js');

function loadRuntime(store) {
  global.Store = store;
  delete require.cache[require.resolve(runtimePath)];
  delete require.cache[require.resolve(boundaryPath)];
  delete require.cache[require.resolve(corePath)];
  require(corePath);
  require(boundaryPath);
  return require(runtimePath);
}

async function run() {
  let settings = {};
  const saves = [];
  const runtime = loadRuntime({
    getSettings: () => settings,
    saveSettingsDurable: async (patch) => {
      saves.push(patch);
      settings = Object.assign({}, settings, patch);
      return { ok: true, value: settings };
    },
  });

  let result = runtime.initialize({ version: '4.2.4' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.value.enabled, false, 'fresh runtime must default to disabled');
  result = runtime.recordError({ errorCode: 'AI_REQUEST_FAILED', stage: 'ai', recoveryResult: 'failed' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errorCode, 'consent-required');

  result = await runtime.grantConsent();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(settings.privacyObservability.consentGranted, true);
  assert.strictEqual(saves.length, 1);

  result = runtime.recordError({ errorCode: 'AI_REQUEST_FAILED', stage: 'ai', recoveryResult: 'failed' });
  assert.strictEqual(result.ok, true);
  result = runtime.recordError({
    errorCode: 'NETWORK_REQUEST_FAILED',
    stage: 'network',
    recoveryResult: 'degraded',
    message: 'patient name and prompt must never pass',
  });
  assert.strictEqual(result.ok, false, 'extra raw fields must be rejected');

  const report = runtime.exportSupportReport();
  assert.strictEqual(report.ok, true);
  assert.strictEqual(report.value.records.length, 1);
  const serialized = JSON.stringify(report.value);
  for (const forbidden of ['message', 'stack', 'path', 'prompt', 'token', 'apiKey', 'patient name']) {
    assert.strictEqual(serialized.includes(forbidden), false, `export leaked ${forbidden}`);
  }

  result = await runtime.revokeConsent();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(settings.privacyObservability.consentGranted, false);
  assert.strictEqual(runtime.getState().value.count, 0, 'revocation must synchronously clear records');
  assert.strictEqual(runtime.exportSupportReport().errorCode, 'consent-required');

  const failureRuntime = loadRuntime({
    getSettings: () => ({}),
    saveSettingsDurable: async () => ({ ok: false, value: null }),
  });
  assert.strictEqual(failureRuntime.initialize({ version: '4.2.4' }).value.enabled, false);
  result = await failureRuntime.grantConsent();
  assert.strictEqual(result.ok, false, 'consent persistence failure must fail closed');
  assert.strictEqual(failureRuntime.getState().value.enabled, false);

  let getterReads = 0;
  const hostilePrivacy = {};
  Object.defineProperty(hostilePrivacy, 'consentGranted', {
    enumerable: true,
    get: () => { getterReads += 1; throw new Error('hostile getter'); },
  });
  const hostileSettings = { privacyObservability: hostilePrivacy };
  const hostileRuntime = loadRuntime({
    getSettings: () => hostileSettings,
    saveSettingsDurable: async (patch) => {
      assert.deepStrictEqual(patch, { privacyObservability: { consentGranted: true } });
      return { ok: true, value: patch };
    },
  });
  assert.doesNotThrow(() => hostileRuntime.initialize({ version: '4.2.4' }));
  result = await hostileRuntime.grantConsent();
  assert.strictEqual(result.ok, true, 'hostile settings getter must not block explicit consent');
  assert.strictEqual(getterReads, 0, 'consent read must not invoke an untrusted getter');

  let failedSettings = { privacyObservability: { consentGranted: true } };
  const fallbackWrites = [];
  const revocationFailureStore = {
    getSettings: () => failedSettings,
    saveSettingsDurable: async () => ({ ok: false, value: failedSettings }),
    saveSettings: (patch) => {
      fallbackWrites.push(patch);
      failedSettings = Object.assign({}, failedSettings, patch);
      return failedSettings;
    },
  };
  const revocationRuntime = loadRuntime(revocationFailureStore);
  assert.strictEqual(revocationRuntime.initialize({ version: '4.2.4' }).value.enabled, true);
  result = await revocationRuntime.revokeConsent();
  assert.strictEqual(result.ok, false, 'revocation must report durable persistence failure');
  assert.strictEqual(revocationRuntime.getState().value.enabled, false);
  assert.deepStrictEqual(fallbackWrites, [{ privacyObservability: { consentGranted: false } }]);
  const restartedRuntime = loadRuntime(revocationFailureStore);
  assert.strictEqual(restartedRuntime.initialize({ version: '4.2.4' }).value.enabled, false, 'failed revoke must not restore stale consent');

  const appSource = fs.readFileSync(path.join(root, 'app', 'js', 'app.js'), 'utf8');
  assert.ok(appSource.includes('loadPrivacyObservabilityModules'), 'App must load privacy modules before onReady');
  assert.ok(appSource.includes('privacy diagnostic'), 'App error path must use safe diagnostic logging');
  assert.strictEqual(/\bmsg\s*:|\bstack\s*:|\bctx\s*:/.test(appSource.slice(appSource.indexOf('function logError'), appSource.indexOf('function getErrorLog'))), false, 'App logError must not build raw fields');
  const settingsSource = fs.readFileSync(path.join(root, 'app', 'settings.html'), 'utf8');
  for (const id of ['privacy-consent-toggle', 'privacy-export-btn', 'privacy-clear-btn', 'privacy-revoke-btn']) {
    assert.ok(settingsSource.includes(`id="${id}"`), `missing settings control ${id}`);
  }

  delete global.Store;
  console.log('privacy-observability-integration: PASS');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
