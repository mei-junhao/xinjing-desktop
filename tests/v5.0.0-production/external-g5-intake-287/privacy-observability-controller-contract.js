'use strict';

const assert = require('assert');
const path = require('path');

const { candidateRoot } = require('./harness-paths');
const candidate = path.join(candidateRoot, 'app', 'js', 'settings-observability-controller.js');
const api = require(candidate);
assert.strictEqual(typeof api.createSettingsObservabilityController, 'function');

function element() {
  const handlers = {};
  const classes = new Set();
  return {
    disabled: false,
    textContent: '',
    attrs: {},
    classList: {
      toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); },
      contains: (name) => classes.has(name)
    },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    addEventListener(name, handler) { handlers[name] = handler; },
    async click() { if (handlers.click) return handlers.click(); }
  };
}

function makeHarness(runtime) {
  const els = {
    toggle: element(), status: element(), count: element(), exportButton: element(), clearButton: element(), revokeButton: element()
  };
  const downloads = [];
  const app = {
    getPrivacyObservabilityState: () => runtime.getState(),
    grantPrivacyConsent: () => runtime.grantConsent(),
    revokePrivacyConsent: () => runtime.revokeConsent(),
    clearPrivacyDiagnostics: () => runtime.clear(),
    exportPrivacyDiagnostics: () => runtime.exportSupportReport(),
    confirmDialog: (_message, work) => work(),
    downloadFile: (name, text) => downloads.push({ name, text }),
    showToast: () => {}
  };
  const controller = api.createSettingsObservabilityController({ elements: els, app });
  return { controller, els, downloads };
}

(async function run() {
  {
    let enabled = false;
    let records = [];
    const runtime = {
      getState: () => ({ ok: true, value: { enabled, count: records.length } }),
      grantConsent: async () => { enabled = true; return { ok: true, value: { enabled: true } }; },
      revokeConsent: async () => { const cleared = records.length; records = []; enabled = false; return { ok: true, value: { enabled: false, cleared } }; },
      clear: () => { records = []; return { ok: true, value: { cleared: 1 } }; },
      exportSupportReport: () => ({ ok: true, value: { schemaVersion: 1, generatedAt: '2026-08-03T00:00:00.000Z', records: records.slice() } }),
      seed: (value) => { records = value.slice(); }
    };
    const h = makeHarness(runtime);
    h.controller.initialize();
    assert.strictEqual(h.els.toggle.attrs['aria-checked'], 'false', 'default UI must be disabled');
    assert.strictEqual(h.els.exportButton.disabled, true);
    runtime.seed([{ errorCode: 'BACKUP_FAILED', version: '4.2.4', stage: 'backup', recoveryResult: 'failed', timestamp: '2026-08-03T00:00:00.000Z' }]);
    await h.controller.toggleConsent();
    assert.strictEqual(h.els.toggle.attrs['aria-checked'], 'true', 'explicit opt-in enables UI');
    await h.controller.revokeConsent();
    assert.strictEqual(h.els.toggle.attrs['aria-checked'], 'false');
    assert.strictEqual(runtime.getState().value.count, 0, 'revocation synchronously clears queue');
  }

  {
    let enabled = false;
    const runtime = {
      getState: () => ({ ok: true, value: { enabled, count: 0 } }),
      grantConsent: async () => ({ ok: false, errorCode: 'consent-persist-failed', value: null }),
      revokeConsent: async () => ({ ok: true, value: { enabled: false, cleared: 0 } }),
      clear: () => ({ ok: true, value: { cleared: 0 } }),
      exportSupportReport: () => ({ ok: false, errorCode: 'consent-required', value: null })
    };
    const h = makeHarness(runtime);
    h.controller.initialize();
    await h.controller.toggleConsent();
    assert.strictEqual(h.els.toggle.attrs['aria-checked'], 'false', 'persist failure stays fail-closed');
    assert.match(h.els.status.textContent, /仍保持关闭/);
  }

  {
    const runtime = {
      getState: () => { throw new Error('malicious getter path'); },
      grantConsent: async () => ({ ok: false }),
      revokeConsent: async () => ({ ok: false }),
      clear: () => ({ ok: false }),
      exportSupportReport: () => ({ ok: false })
    };
    const h = makeHarness(runtime);
    h.controller.initialize();
    assert.strictEqual(h.els.toggle.attrs['aria-checked'], 'false', 'corrupted runtime state fails closed');
  }

  {
    let enabled = true;
    let records = [{ errorCode: 'BACKUP_FAILED' }];
    const runtime = {
      getState: () => ({ ok: true, value: { enabled, count: records.length } }),
      grantConsent: async () => ({ ok: true }),
      revokeConsent: async () => { enabled = false; records = []; return { ok: false, errorCode: 'consent-persist-failed' }; },
      clear: () => ({ ok: true }),
      exportSupportReport: () => ({ ok: false })
    };
    const h = makeHarness(runtime);
    h.controller.initialize();
    const result = await h.controller.revokeConsent();
    assert.strictEqual(result.ok, false, 'persistence failure remains visible');
    assert.strictEqual(h.els.toggle.attrs['aria-checked'], 'false', 'runtime revocation must project immediately even if persistence fails');
    assert.strictEqual(runtime.getState().value.count, 0, 'runtime queue must remain cleared after persistence failure');
  }

  {
    let enabled = true;
    let records = [];
    const runtime = {
      getState: () => ({ ok: true, value: { enabled, count: records.length } }),
      grantConsent: async () => ({ ok: true }),
      revokeConsent: async () => ({ ok: true }),
      clear: () => { records = []; return { ok: true, value: { cleared: 0 } }; },
      exportSupportReport: () => ({ ok: true, value: { schemaVersion: 1, generatedAt: '2026-08-03T00:00:00.000Z', records: [] } })
    };
    const h = makeHarness(runtime);
    h.controller.initialize();
    assert.strictEqual(h.els.clearButton.disabled, true, 'clear is disabled when count is zero');
    records = [{ errorCode: 'BACKUP_FAILED' }];
    h.controller.render();
    assert.strictEqual(h.els.clearButton.disabled, false, 'clear enables only when consent and records exist');
    h.controller.clearDiagnostics();
    assert.strictEqual(h.els.clearButton.disabled, true, 'clear disables immediately after queue is empty');
  }

  {
    const unsafe = { schemaVersion: 1, generatedAt: '2026-08-03T00:00:00.000Z', records: [{ errorCode: 'BACKUP_FAILED', version: '4.2.4', stage: 'backup', recoveryResult: 'failed', timestamp: '2026-08-03T00:00:00.000Z', path: 'C:\\private', secret: 'token', clinicalBody: 'raw', prompt: 'raw prompt', providerPayload: 'raw provider', accountId: 'raw identifier' }] };
    const runtime = {
      getState: () => ({ ok: true, value: { enabled: true, count: 1 } }),
      grantConsent: async () => ({ ok: true }),
      revokeConsent: async () => ({ ok: true }),
      clear: () => ({ ok: true }),
      exportSupportReport: () => ({ ok: true, value: unsafe })
    };
    const h = makeHarness(runtime);
    h.controller.initialize();
    const result = h.controller.exportDiagnostics();
    assert.strictEqual(result.ok, false, 'unsafe support report must be rejected');
    assert.strictEqual(h.downloads.length, 0, 'unsafe report must not download');
  }

  console.log('privacy-observability-controller-contract: 6/6 PASS');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
