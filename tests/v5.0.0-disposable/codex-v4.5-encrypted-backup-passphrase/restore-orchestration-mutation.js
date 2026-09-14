'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '../../../');
const SETTINGS_PATH = path.join(ROOT, 'app/js/settings.js');

function makeElement(id) {
  const attributes = new Map();
  const listeners = new Map();
  return {
    id,
    style: {},
    classList: {
      contains: () => false,
      add: () => {},
      remove: () => {},
      toggle: () => {},
    },
    options: [],
    value: '',
    checked: false,
    disabled: false,
    readOnly: false,
    files: [],
    textContent: '',
    innerHTML: '',
    placeholder: '',
    scrollHeight: 0,
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) || null; },
    toggleAttribute(name, force) {
      if (force) attributes.set(name, '');
      else attributes.delete(name);
    },
    addEventListener(name, handler) { listeners.set(name, handler); },
    focus() { this.focused = true; },
    select() {},
    appendChild() {},
  };
}

function createHarness() {
  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };
  const documentElement = getElement('documentElement');
  const document = {
    documentElement,
    getElementById: getElement,
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: (tag) => makeElement(tag),
    addEventListener: () => {},
  };
  const settings = { apiConfig: {}, backup: {}, profile: {} };
  const toasts = [];
  let importCalls = 0;
  let safetyCalls = 0;
  let modalOptions = null;
  let ready = null;

  const App = {
    initPage(config) { ready = config.onReady; },
    bindModalClose: () => {},
    canUse: () => false,
    closeModal: () => {
      if (modalOptions && typeof modalOptions.onClose === 'function') modalOptions.onClose();
      modalOptions = null;
    },
    confirmDialog: () => {},
    downloadFile: () => {},
    escapeHtml: (value) => String(value),
    formatDate: () => '20260801',
    getLicenseState: () => ({ mode: 'free' }),
    getPrivacyObservabilityState: () => ({ ok: false }),
    grantPrivacyConsent: async () => ({ ok: false }),
    revokePrivacyConsent: async () => ({ ok: false }),
    clearPrivacyDiagnostics: () => ({ ok: false }),
    exportPrivacyDiagnostics: () => ({ ok: false }),
    initPageState: {},
    membershipBadge: () => '',
    onLicenseStateChange: () => {},
    openModal: (_id, options) => { modalOptions = options || null; },
    openPlans: () => {},
    showToast: (message, kind) => { toasts.push({ message, kind }); },
    Theme: { getSkin: () => 'clinical', setSkin: () => true },
  };

  const Store = {
    aiUnlocked: () => true,
    exportAll: async () => JSON.stringify({ version: '2.0.0', clients: [] }),
    getSettings: () => settings,
    getSupervisorIdentities: () => [],
    getSupervisorIdentity: () => null,
    importAll: async () => {
      importCalls += 1;
      return { ok: true };
    },
    saveSettings: (patch) => Object.assign(settings, patch),
    saveSettingsDurable: async (patch) => {
      Object.assign(settings, patch);
      return { ok: true };
    },
    storageInfo: () => ({ backend: 'synthetic', approxDataSizeMB: 0, clientCount: 0, sessionCount: 0, supervisionCount: 0 }),
    createSupervisorIdentity: () => {},
    updateSupervisorIdentity: () => {},
    deleteSupervisorIdentity: () => {},
  };

  const api = {
    getVersion: async () => '5.0.0',
    getState: async () => ({}),
    getUserDocFolder: async () => ({ folder: '' }),
    onLicenseState: () => {},
    decryptBackup: async () => ({ ok: true, payload: JSON.stringify({ version: '2.0.0', clients: [{ id: 'replacement' }] }) }),
    writeBackupSafetySnapshot: async () => {
      safetyCalls += 1;
      return { ok: false, errorCode: 'XJ_BACKUP_SAFETY_WRITE_FAILED' };
    },
  };

  const localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  const context = {
    App,
    AI: {
      getTier: () => 'builtin',
      getActiveConfig: () => null,
      getQuota: () => null,
      onQuotaChange: () => {},
      fetchQuota: () => {},
    },
    Store,
    XJEntitlements: { effectiveTier: () => 'free', tierLabel: () => '免费版' },
    PromptGovernance: { isWritingStyleEnabled: () => true },
    document,
    console,
    clearTimeout,
    setTimeout: (handler) => { handler(); return 0; },
    Promise,
    Date,
    Array,
    JSON,
    Math,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
  };
  context.__XJ_API__ = api;
  context.XJBackupCrypto = { PASSPHRASE_MIN_LENGTH: 12 };
  context.__XJ__ = { tier: 'free' };
  context.localStorage = localStorage;
  context.location = { reload: () => {} };
  context.window = context;
  context.document = document;
  context.setTimeout = context.setTimeout;
  context.clearTimeout = clearTimeout;
  vm.createContext(context);

  return {
    context,
    document,
    importCalls: () => importCalls,
    safetyCalls: () => safetyCalls,
    toasts,
    getReady: () => ready,
  };
}

async function runScenario(source) {
  const harness = createHarness();
  vm.runInContext(source, harness.context, { filename: SETTINGS_PATH });
  assert.strictEqual(typeof harness.getReady(), 'function', 'settings.js must register an onReady callback');
  await harness.getReady()();

  const restore = harness.context.window.restoreData;
  assert.strictEqual(typeof restore, 'function', 'settings.js must expose restoreData');
  const file = { text: async () => 'synthetic-encrypted-package' };
  const pending = restore({ target: { files: [file], value: 'synthetic.xjbackup' } });

  await Promise.resolve();
  const input = harness.document.getElementById('backup-passphrase');
  const confirm = harness.document.getElementById('backup-restore-confirm');
  const submit = harness.document.getElementById('backup-passphrase-submit');
  input.value = '恢复口令跨设备安全快照二零二六';
  confirm.checked = true;
  assert.strictEqual(typeof submit.onclick, 'function', 'restore dialog must install a submit handler');
  submit.onclick();
  await pending;
  return harness;
}

async function main() {
  const source = fs.readFileSync(SETTINGS_PATH, 'utf8');
  const healthy = await runScenario(source);
  assert.strictEqual(healthy.safetyCalls(), 1, 'restore must attempt the safety snapshot once');
  assert.strictEqual(healthy.importCalls(), 0, 'safety failure must prevent Store.importAll');
  assert.ok(healthy.toasts.some((toast) => /当前数据未改变/.test(toast.message)), 'safety failure must be surfaced to the user');

  const guard = /      if \(!safety \|\| safety\.ok !== true\) \{\r?\n        App\.showToast\(backupErrorMessage\(safety && safety\.errorCode\), 'error'\);\r?\n        return;\r?\n      \}\r?\n/;
  assert.strictEqual((source.match(guard) || []).length, 1, 'mutation target must exist exactly once');
  const mutant = source.replace(guard, '');
  const mutated = await runScenario(mutant);
  assert.strictEqual(mutated.safetyCalls(), 1, 'mutant must still encounter the failed safety snapshot');
  assert.strictEqual(mutated.importCalls(), 1, 'reverse mutation must be caught by the orchestration assertion');

  console.log('RESTORE_ORCHESTRATION=PASS');
  console.log('RESTORE_ORCHESTRATION_ASSERTIONS=7');
  console.log('RESTORE_ORCHESTRATION_MUTATION=KILLED');
}

main().catch((error) => {
  console.error('RESTORE_ORCHESTRATION=FAIL', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
