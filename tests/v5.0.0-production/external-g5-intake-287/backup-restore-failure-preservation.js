'use strict';

const assert = require('assert');
const path = require('path');

const { candidateRoot } = require('./harness-paths');
const candidate = path.join(candidateRoot, 'app', 'js', 'settings-data-safety-controller.js');
const api = require(candidate);
assert.strictEqual(typeof api.createSettingsDataSafetyController, 'function');

const payload = JSON.stringify({
  version: '2.0.0',
  clients: [{ id: 'c1' }],
  sessions: [],
  supervisions: [],
  supervisorIdentities: [],
  masterConversations: [],
  expenses: [],
  materialWorkspaces: [],
  clinicalActionRuns: [],
  clinicalTasks: [],
  importQuarantine: [],
  deletionBatches: [],
  deletionQuarantine: []
});
const before = JSON.stringify({
  version: '2.0.0',
  clients: [{ id: 'old' }],
  sessions: [],
  supervisions: [],
  supervisorIdentities: [],
  masterConversations: [],
  expenses: [],
  materialWorkspaces: [],
  clinicalActionRuns: [],
  clinicalTasks: [],
  importQuarantine: [],
  deletionBatches: [],
  deletionQuarantine: []
});

function makeInput(value) {
  return { value: value || 'C:\\synthetic\\selected.xjbackup', files: [] };
}
function makeFile() {
  return { name: 'selected.xjbackup', text: async () => 'encrypted-package' };
}
function makeHarness(overrides) {
  const trace = [];
  const toasts = [];
  let current = before;
  const deps = {
    requestPassphrase: async () => ({ passphrase: 'correct horse battery', confirmed: true }),
    bridge: {
      decryptBackup: async () => { trace.push('decrypt'); return { ok: true, payload }; },
      writeBackupSafetySnapshot: async () => { trace.push('snapshot'); return { ok: true }; },
      encryptBackup: async () => ({ ok: true, package: 'encrypted' })
    },
    store: {
      exportAll: async () => { trace.push('export'); return current; },
      importAll: async (next) => { trace.push(next === before ? 'rollback' : 'import'); current = next; return { ok: true, quarantine: [], deletionQuarantine: [] }; },
      saveSettings: () => {}
    },
    ui: {
      showToast: (message, type) => { trace.push('toast:' + type); toasts.push({ message, type }); },
      downloadFile: () => {},
      reload: () => { trace.push('reload'); },
      updateBackupTime: () => {},
      formatDate: () => '2026-08-03'
    }
  };
  if (overrides) {
    if (overrides.bridge) Object.assign(deps.bridge, overrides.bridge);
    if (overrides.store) Object.assign(deps.store, overrides.store);
    if (overrides.ui) Object.assign(deps.ui, overrides.ui);
    if (overrides.requestPassphrase) deps.requestPassphrase = overrides.requestPassphrase;
  }
  return { controller: api.createSettingsDataSafetyController(deps), trace, toasts, deps, setCurrent: (value) => { current = value; } };
}

(async function run() {
  assert.strictEqual(api.validateRuntimePassphrase('short').ok, false, 'short passphrase must fail');
  assert.strictEqual(api.validateRuntimePassphrase('            ').ok, false, 'whitespace passphrase must fail');
  assert.strictEqual(api.validateRuntimePassphrase('正确的恢复口令十二字符以上').ok, true, 'unicode passphrase must use code-point length');

  {
    const h = makeHarness({ requestPassphrase: async () => null });
    const input = makeInput();
    const result = await h.controller.restore({ file: makeFile(), inputElement: input });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'cancelled');
    assert.strictEqual(input.value, 'C:\\synthetic\\selected.xjbackup', 'cancel must preserve selected input');
    assert.deepStrictEqual(h.trace, [], 'cancel must not decrypt or write');
  }

  {
    const h = makeHarness({ bridge: { decryptBackup: async () => { h.trace.push('decrypt'); return { ok: false, errorCode: 'XJ_BACKUP_AUTH_FAILED' }; } } });
    const input = makeInput();
    const result = await h.controller.restore({ file: makeFile(), inputElement: input });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(input.value, 'C:\\synthetic\\selected.xjbackup', 'authentication failure must preserve selected input');
    assert.deepStrictEqual(h.trace.filter((item) => item === 'snapshot' || item === 'import'), [], 'authentication failure must be zero-write');
    assert.strictEqual(h.toasts.some((item) => item.type === 'success'), false, 'failure cannot toast success');
  }

  {
    const h = makeHarness({ store: { importAll: async () => { h.trace.push('import'); return { ok: false, error: { code: 'XJ_IMPORT_DURABLE_FAILED' } }; } } });
    const input = makeInput();
    const result = await h.controller.restore({ file: makeFile(), inputElement: input });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(input.value, 'C:\\synthetic\\selected.xjbackup', 'durable failure must preserve selected input');
    assert.strictEqual(h.toasts.some((item) => item.type === 'success'), false, '{ok:false} cannot toast success');
  }

  {
    const h = makeHarness();
    let exportCount = 0;
    h.deps.store.exportAll = async () => {
      h.trace.push('export');
      exportCount += 1;
      if (exportCount === 1) return before;
      if (exportCount === 2) return JSON.stringify(Object.assign(JSON.parse(payload), { clients: [] }));
      return before;
    };
    const input = makeInput();
    const result = await h.controller.restore({ file: makeFile(), inputElement: input });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'XJ_RESTORE_READBACK_FAILED');
    assert.ok(h.trace.includes('rollback'), 'readback mismatch must attempt rollback');
    assert.strictEqual(input.value, 'C:\\synthetic\\selected.xjbackup', 'readback failure must preserve selected input');
    assert.strictEqual(h.toasts.some((item) => item.type === 'success'), false, 'readback failure cannot toast success');
  }

  {
    const h = makeHarness();
    const input = makeInput();
    const file = { text: async () => { throw new Error('synthetic read failure'); } };
    const result = await h.controller.restore({ file, inputElement: input });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'XJ_RESTORE_FAILED');
    assert.strictEqual(input.value, 'C:\\synthetic\\selected.xjbackup', 'file-read failure must preserve selected input');
    assert.strictEqual(h.trace.includes('snapshot'), false, 'file-read failure must happen before snapshot');
  }

  {
    const h = makeHarness({ bridge: { writeBackupSafetySnapshot: async () => { h.trace.push('snapshot'); return { ok: false, errorCode: 'XJ_BACKUP_SAFETY_WRITE_FAILED' }; } } });
    const input = makeInput();
    const result = await h.controller.restore({ file: makeFile(), inputElement: input });
    assert.strictEqual(result.errorCode, 'XJ_BACKUP_SAFETY_WRITE_FAILED');
    assert.strictEqual(h.trace.includes('import'), false, 'snapshot failure must stop before import');
    assert.strictEqual(input.value, 'C:\\synthetic\\selected.xjbackup');
  }

  {
    const h = makeHarness();
    let exportCount = 0;
    h.deps.store.exportAll = async () => {
      exportCount += 1;
      if (exportCount === 1) return before;
      if (exportCount === 2) throw new Error('synthetic readback failure');
      return before;
    };
    const input = makeInput();
    const result = await h.controller.restore({ file: makeFile(), inputElement: input });
    assert.strictEqual(result.errorCode, 'XJ_RESTORE_FAILED');
    assert.ok(h.trace.includes('rollback'), 'readback exception must rollback');
    assert.strictEqual(input.value, 'C:\\synthetic\\selected.xjbackup');
  }

  {
    const h = makeHarness();
    let exportCount = 0;
    let importCount = 0;
    h.deps.store.exportAll = async () => {
      exportCount += 1;
      if (exportCount === 1) return before;
      return JSON.stringify(Object.assign(JSON.parse(payload), { clients: [] }));
    };
    h.deps.store.importAll = async (next) => {
      importCount += 1;
      h.trace.push(next === before ? 'rollback' : 'import');
      if (importCount === 2) return { ok: false, error: { code: 'XJ_IMPORT_DURABLE_FAILED' } };
      return { ok: true };
    };
    const input = makeInput();
    const result = await h.controller.restore({ file: makeFile(), inputElement: input });
    assert.strictEqual(result.errorCode, 'XJ_RESTORE_ROLLBACK_FAILED');
    assert.strictEqual(input.value, 'C:\\synthetic\\selected.xjbackup');
    assert.strictEqual(h.toasts.some((item) => item.type === 'success'), false);
  }

  {
    const unsafePayload = JSON.stringify(Object.assign(JSON.parse(payload), { settings: { apiConfig: { apiKey: 'must-not-import' } } }));
    const h = makeHarness({ bridge: { decryptBackup: async () => { h.trace.push('decrypt'); return { ok: true, payload: unsafePayload }; } } });
    const input = makeInput();
    const result = await h.controller.restore({ file: makeFile(), inputElement: input });
    assert.strictEqual(result.ok, false, 'payload with settings must be rejected');
    assert.strictEqual(h.trace.includes('snapshot'), false);
    assert.strictEqual(h.trace.includes('import'), false);
    assert.strictEqual(input.value, 'C:\\synthetic\\selected.xjbackup');
  }

  {
    const invalidReferencePayload = JSON.stringify(Object.assign(JSON.parse(payload), { sessions: [{ id: 's-orphan', clientId: 'missing-client' }] }));
    const normalizedReadback = JSON.stringify(Object.assign(JSON.parse(payload), {
      sessions: [],
      importQuarantine: [{ id: 'iq-1' }]
    }));
    const h = makeHarness({ bridge: { decryptBackup: async () => { h.trace.push('decrypt'); return { ok: true, payload: invalidReferencePayload }; } } });
    let exportCount = 0;
    h.deps.store.exportAll = async () => {
      exportCount += 1;
      if (exportCount === 1) return before;
      if (exportCount === 2) return normalizedReadback;
      return before;
    };
    const input = makeInput();
    const result = await h.controller.restore({ file: makeFile(), inputElement: input });
    assert.strictEqual(result.errorCode, 'XJ_RESTORE_READBACK_FAILED', 'reference/quarantine projection mismatch must fail closed');
    assert.ok(h.trace.includes('rollback'));
  }

  {
    const h = makeHarness();
    const downloads = [];
    h.deps.ui.downloadFile = (name, text, type) => downloads.push({ name, text, type });
    const controller = api.createSettingsDataSafetyController(h.deps);
    const result = await controller.backup();
    assert.strictEqual(result.ok, true, 'backup remains available without tier, balance, AI, or network dependencies');
    assert.strictEqual(downloads.length, 1);
    assert.strictEqual(downloads[0].type, 'application/json');
  }

  {
    const h = makeHarness();
    const input = makeInput();
    const request = { passphrase: 'correct horse battery', confirmed: true };
    h.deps.requestPassphrase = async () => request;
    const controller = api.createSettingsDataSafetyController(h.deps);
    const result = await controller.restore({ file: makeFile(), inputElement: input });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(input.value, '', 'input clears only after verified success');
    assert.strictEqual(request.passphrase, '', 'runtime passphrase reference must be cleared');
    assert.deepStrictEqual(h.trace.slice(0, 6), ['decrypt', 'export', 'snapshot', 'import', 'export', 'toast:success']);
    assert.ok(h.trace.indexOf('reload') > h.trace.indexOf('toast:success'), 'reload follows verified success');
  }

  console.log('backup-restore-failure-preservation: 13/13 PASS');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
