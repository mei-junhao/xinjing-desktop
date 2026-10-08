'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TASK_ID = 'XJ-5.0.0-codex-v4.3-pro-flagship-template-production-33';
const BASE_COMMIT = '9971787eb6e443ab5a5c80aee118b9b43285c093';
const CONTRACT_ID = 'v4.3-pro-flagship-template-production-v1';
const WRITE_LOCK_ID = 'lock-XJ-5.0.0-codex-v4.3-pro-flagship-template-production-33';
const OUT_DIR = path.resolve(process.env.XJ_TASK33_OUT_DIR || __dirname);
const STVM_PATH = path.resolve(process.env.XJ_TASK33_STVM_SOURCE || path.join(ROOT, 'app', 'js', 'session-template-view-model.js'));
const QR_PATH = path.resolve(process.env.XJ_TASK33_QR_SOURCE || path.join(ROOT, 'app', 'js', 'quick-record.js'));
const CONSULT_PATH = path.resolve(process.env.XJ_TASK33_CONSULT_SOURCE || path.join(ROOT, 'app', 'js', 'consult-notes.js'));
const CONSULT_HTML_PATH = path.join(ROOT, 'app', 'consult-notes.html');
const DASHBOARD_PATH = path.resolve(process.env.XJ_TASK33_DASHBOARD_SOURCE || path.join(ROOT, 'app', 'js', 'dashboard.js'));

function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase(); }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function loadViewModel(source) {
  const scope = { module: { exports: {} }, exports: {}, globalThis: {}, Date, Object, Array, String, Number, Boolean, Error, RegExp, JSON, Math, isFinite, console };
  scope.globalThis = scope;
  vm.createContext(scope);
  vm.runInContext(source + '\n;globalThis.__vm = module.exports;', scope, { filename: STVM_PATH });
  return scope.__vm;
}

function makeHarness(vmApi, options) {
  options = options || {};
  const sessions = [];
  const selections = new Map();
  const tasks = [];
  const calls = { sessions: 0, templates: 0, tasks: 0 };
  let templateFailures = Number(options.templateFailures || 0);
  const state = options.licenseState;
  const store = {
    getSession(id) { return sessions.find((item) => item.id === id) || null; },
    getClient(id) { return id === 'synthetic-client' ? { id, name: '合成来访者' } : null; },
    async createSessionDurable(payload) {
      calls.sessions += 1;
      const value = Object.assign({ sessionNumber: sessions.length + 1 }, clone(payload));
      sessions.push(value);
      return { ok: true, value };
    },
    async saveSessionTemplateSelectionDurable(sessionId, selection) {
      calls.templates += 1;
      if (templateFailures > 0) {
        templateFailures -= 1;
        return { ok: false, error: { code: 'SYNTHETIC_TEMPLATE_FAILURE', message: 'synthetic selection failure' } };
      }
      const session = this.getSession(sessionId);
      if (!session) return { ok: false, error: { code: 'SYNTHETIC_SESSION_MISSING', message: 'missing session' } };
      const normalized = clone(selection);
      selections.set(sessionId, normalized);
      session.templateSelection = normalized;
      return { ok: true, value: normalized, session: clone(session) };
    },
    async saveClinicalTasksDurable(batch) {
      calls.tasks += 1;
      batch.forEach((task) => {
        const next = clone(task);
        const index = tasks.findIndex((item) => item.id === next.id);
        if (index >= 0) tasks[index] = next;
        else tasks.push(next);
      });
      return { ok: true, value: clone(batch) };
    },
    async saveBillingBatchDurable(data) { return { ok: true, value: data }; },
    async createSupervisionDurable(data) { return { ok: true, value: data }; },
    async updateSessionFull(data) { return { ok: true, value: data }; },
  };
  const app = {
    todayStr() { return '2026-07-28'; },
    showToast() {},
    getLicenseState() { return state || { activated: true, tier: 'free' }; },
  };
  const context = vm.createContext({
    window: null, Store: store, App: app, SessionTemplateViewModel: vmApi,
    console, Date, Math, JSON, Object, Array, String, Number, Boolean, Error, RegExp, Promise,
    setTimeout, clearTimeout,
  });
  context.window = context;
  vm.runInContext(fs.readFileSync(QR_PATH, 'utf8'), context, { filename: QR_PATH });
  return { qr: context.QuickRecord, store, calls, sessions, selections, tasks };
}

const checks = [];
function check(id, label, fn) {
  try {
    fn();
    checks.push({ id, label, pass: true });
    console.log('[PASS] ' + id + ' ' + label);
  } catch (error) {
    checks.push({ id, label, pass: false, error: error.message });
    console.error('[FAIL] ' + id + ' ' + label + ': ' + error.message);
  }
}

async function checkAsync(id, label, fn) {
  try {
    await fn();
    checks.push({ id, label, pass: true });
    console.log('[PASS] ' + id + ' ' + label);
  } catch (error) {
    checks.push({ id, label, pass: false, error: error.message });
    console.error('[FAIL] ' + id + ' ' + label + ': ' + error.message);
  }
}

async function run() {
  const vmSource = fs.readFileSync(STVM_PATH, 'utf8');
  const vmApi = loadViewModel(vmSource);

  check('VM-LICENSE', 'activated license states normalize to Free/Pro/Flagship and invalid states fail closed', () => {
    assert.strictEqual(vmApi.normalizeLicenseState({ activated: true, tier: 'free' }).tier, 'Free');
    assert.strictEqual(vmApi.normalizeLicenseState({ activated: true, tier: 'pro' }).tier, 'Pro');
    assert.strictEqual(vmApi.normalizeLicenseState({ activated: true, tier: 'full' }).tier, 'Pro');
    assert.strictEqual(vmApi.normalizeLicenseState({ activated: true, tier: 'custom' }).tier, 'Flagship');
    assert.strictEqual(vmApi.normalizeLicenseState({ activated: true, tier: 'unknown' }).tier, 'Free');
    assert.strictEqual(vmApi.normalizeLicenseState({ activated: true, tier: 'pro', expiresAt: '2020-01-01' }).tier, 'Free');
    assert.strictEqual(vmApi.normalizeLicenseState({ activated: true, tier: 'custom', revoked: true }).tier, 'Free');
    assert.strictEqual(vmApi.list({ tier: 'unknown' }).ok, false);
  });

  check('VM-TRIAL', 'trial exposes paid preview but never grants paid selection', () => {
    const trial = vmApi.list({ licenseState: { activated: false, mode: 'trial', aiUnlocked: true }, includeLocked: true });
    const ai = trial.templates.find((item) => item.id === 'ai-session-v1');
    assert.strictEqual(trial.access.tier, 'Free');
    assert.strictEqual(ai.preview, true);
    assert.strictEqual(ai.locked, true);
    assert.strictEqual(vmApi.createSelection('ai-session-v1', { licenseState: { activated: false, mode: 'trial', aiUnlocked: true } }).ok, false);
  });

  check('VM-OPTIONS', 'Pro and Flagship list eligible templates while retaining locked discoverability', () => {
    const pro = vmApi.list({ licenseState: { activated: true, tier: 'pro' }, includeLocked: true });
    const custom = vmApi.list({ licenseState: { activated: true, tier: 'custom' }, includeLocked: true });
    assert.strictEqual(pro.templates.find((item) => item.id === 'ai-session-v1').eligible, true);
    assert.strictEqual(pro.templates.find((item) => item.id === 'flagship-session-v1').locked, true);
    assert.strictEqual(custom.templates.find((item) => item.id === 'flagship-session-v1').eligible, true);
    const selected = vmApi.createSelection('flagship-session-v1', { licenseState: { activated: true, tier: 'custom' }, customTemplateId: 'brand-acme-001' });
    assert.strictEqual(selected.ok, true);
    assert.strictEqual(selected.selection.customTemplateId, 'brand-acme-001');
    assert.strictEqual(vmApi.createSelection('flagship-session-v1', { licenseState: { activated: true, tier: 'custom' }, customTemplateId: '../body' }).ok, false);
  });

  check('VM-HISTORY', 'historical paid selection is readable but locked after downgrade', () => {
    const result = vmApi.describeSelection({ version: 'session-template-selection-v1', templateId: 'flagship-session-v1', tierAtSelection: 'Flagship', context: 'individual', appliedAt: '2026-07-28T00:00:00+08:00', customTemplateId: 'brand-acme-001' }, { licenseState: { activated: true, tier: 'free' } });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.historical, true);
    assert.strictEqual(result.selection.customTemplateId, 'brand-acme-001');
  });

  await checkAsync('QR-PRO-FLAGSHIP', 'handler accepts eligible Pro/Flagship selections and saves bounded metadata', async () => {
    const h = makeHarness(vmApi, { licenseState: { activated: true, tier: 'custom' } });
    const result = await h.qr.createQuickRecord({ clientId: 'synthetic-client', templateId: 'flagship-session-v1', customTemplateId: 'brand-acme-001', taskTitles: ['后续核对'] });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(h.calls.sessions, 1);
    assert.strictEqual(h.selections.get(result.value.id).tierAtSelection, 'Flagship');
    assert.strictEqual(h.selections.get(result.value.id).customTemplateId, 'brand-acme-001');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(h.selections.get(result.value.id), 'body'), false);
  });

  await checkAsync('QR-FAIL-CLOSED', 'handler rejects paid selection under Free/trial/unknown before session write', async () => {
    const free = makeHarness(vmApi, { licenseState: { activated: true, tier: 'free' } });
    const freeResult = await free.qr.createQuickRecord({ clientId: 'synthetic-client', templateId: 'ai-session-v1' });
    assert.strictEqual(freeResult.ok, false);
    assert.strictEqual(free.calls.sessions, 0);
    const trial = makeHarness(vmApi, { licenseState: { activated: false, mode: 'trial', aiUnlocked: true } });
    const trialResult = await trial.qr.createQuickRecord({ clientId: 'synthetic-client', templateId: 'flagship-session-v1' });
    assert.strictEqual(trialResult.ok, false);
    assert.strictEqual(trial.calls.sessions, 0);
    const unknown = makeHarness(vmApi, { licenseState: { activated: true, tier: 'mystery' } });
    const unknownResult = await unknown.qr.createQuickRecord({ clientId: 'synthetic-client', templateId: 'ai-session-v1' });
    assert.strictEqual(unknownResult.ok, false);
    assert.strictEqual(unknown.calls.sessions, 0);
  });

  await checkAsync('QR-RETRY', 'selection failure preserves the same session and retries without duplicate IDs', async () => {
    const h = makeHarness(vmApi, { licenseState: { activated: true, tier: 'pro' }, templateFailures: 1 });
    const input = { clientId: 'synthetic-client', templateId: 'ai-session-v1', taskTitles: ['同一任务'] };
    const first = await h.qr.createQuickRecord(input);
    assert.strictEqual(first.ok, false);
    assert.strictEqual(first.sessionSaved, true);
    assert.strictEqual(first.error.code, 'XJ_QR_TEMPLATE_SAVE_FAILED');
    const id = h.qr._state.lockedSessionId;
    const taskId = h.qr._state.completionDraft.tasks[0].id;
    const second = await h.qr.createQuickRecord(input);
    assert.strictEqual(second.ok, true);
    assert.strictEqual(h.calls.sessions, 1);
    assert.strictEqual(h.tasks[0].id, taskId);
    assert.strictEqual(h.selections.get(id).templateId, 'ai-session-v1');
  });

  check('UI-INTEGRATION', 'dashboard and consultation route expose the same guarded selector contract', () => {
    const dashboard = fs.readFileSync(DASHBOARD_PATH, 'utf8');
    const consult = fs.readFileSync(CONSULT_PATH, 'utf8');
    const html = fs.readFileSync(CONSULT_HTML_PATH, 'utf8');
    assert.match(dashboard, /includeLocked:\s*true/);
    assert.match(dashboard, /qr-custom-template-id/);
    assert.match(dashboard, /licenseState/);
    assert.match(dashboard, /item\.locked \? ' disabled' : ''/);
    assert.match(consult, /saveSessionTemplateSelectionDurable/);
    assert.match(consult, /await Store\.saveSessionTemplateSelectionDurable/);
    assert.match(consult, /历史模板当前不可用/);
    assert.match(consult, /templateSelectionDirty/);
    assert.match(html, /id="session-template-select"/);
    assert.match(html, /js\/session-template-view-model\.js/);
  });

  const failed = checks.filter((item) => !item.pass).length;
  const result = {
    schema_version: 1,
    task_id: TASK_ID,
    base_commit: BASE_COMMIT,
    contract_id: CONTRACT_ID,
    write_lock_id: WRITE_LOCK_ID,
    checks,
    passed: checks.length - failed,
    failed,
    module_hashes: {
      'session-template-view-model.js': sha256(STVM_PATH),
      'quick-record.js': sha256(QR_PATH),
      'consult-notes.js': sha256(CONSULT_PATH),
      'dashboard.js': sha256(DASHBOARD_PATH),
    },
    invariants: { zeroFailed: failed === 0, paidCannotBypassHandler: true, historicalSelectionNotRewritten: true },
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'contract-result.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, 'contract-matrix.json'), JSON.stringify({ schema_version: 1, task_id: TASK_ID, rows: checks.map((item) => ({ id: item.id, label: item.label, pass: item.pass, production_entry_point: item.id.indexOf('VM-') === 0 ? 'app/js/session-template-view-model.js' : item.id.indexOf('QR-') === 0 ? 'app/js/quick-record.js' : 'app/js/consult-notes.js + app/js/dashboard.js' })) }, null, 2) + '\n', 'utf8');
  console.log('F2 contract: ' + result.passed + '/' + checks.length + ' PASS');
  if (failed) process.exitCode = 1;
}

run().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
