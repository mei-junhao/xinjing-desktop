'use strict';

const assert = require('assert');
const path = require('path');

const { candidateRoot } = require('./harness-paths');
const dataApi = require(path.join(candidateRoot, 'app', 'js', 'settings-data-safety-controller.js'));
const observabilityApi = require(path.join(candidateRoot, 'app', 'js', 'settings-observability-controller.js'));

const collections = {
  version: '2.0.0',
  clients: [{ id: 'c1' }], sessions: [], supervisions: [], supervisorIdentities: [],
  masterConversations: [], expenses: [], materialWorkspaces: [], clinicalActionRuns: [],
  clinicalTasks: [], importQuarantine: [], deletionBatches: [], deletionQuarantine: []
};
const payload = JSON.stringify(collections);
const before = JSON.stringify(Object.assign({}, collections, { clients: [{ id: 'before' }] }));

function oldRestore({ decryptResult, importResult }) {
  const trace = ['file-input-clear', 'passphrase-request', 'decrypt'];
  if (!decryptResult || decryptResult.ok !== true) return { trace, input: '', state: before, visible: 'error' };
  trace.push('export-before', 'snapshot', 'import');
  if (!importResult || importResult.ok !== true) return { trace, input: '', state: before, visible: 'error' };
  trace.push('toast:success', 'reload');
  return { trace, input: '', state: payload, visible: 'success' };
}

async function candidateRestore({ decryptResult, importResult }) {
  const trace = [];
  let current = before;
  const input = { value: 'synthetic.xjbackup' };
  const controller = dataApi.createSettingsDataSafetyController({
    requestPassphrase: async () => { trace.push('passphrase-request'); return { passphrase: 'correct horse battery', confirmed: true }; },
    bridge: {
      decryptBackup: async () => { trace.push('decrypt'); return decryptResult; },
      writeBackupSafetySnapshot: async () => { trace.push('snapshot'); return { ok: true }; }
    },
    store: {
      exportAll: async () => { trace.push('export'); return current; },
      importAll: async (next) => { trace.push(next === before ? 'rollback' : 'import'); if (!importResult || importResult.ok !== true) return importResult; current = next; return importResult; }
    },
    ui: {
      showToast: (_message, type) => trace.push('toast:' + type),
      reload: () => trace.push('reload')
    }
  });
  const result = await controller.restore({ file: { text: async () => 'encrypted' }, inputElement: input });
  return { trace, input: input.value, state: current, visible: result.ok ? 'success' : 'error' };
}

function element() {
  return {
    disabled: false, textContent: '', attrs: {}, classes: new Set(), handlers: {},
    classList: { toggle(name, on) { if (on) this.owner.classes.add(name); else this.owner.classes.delete(name); }, owner: null },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    addEventListener(name, handler) { this.handlers[name] = handler; }
  };
}
function elements() {
  const result = { toggle: element(), status: element(), count: element(), exportButton: element(), clearButton: element(), revokeButton: element() };
  Object.values(result).forEach((value) => { value.classList.owner = value; });
  return result;
}
function oldObservabilityProjection(state) {
  return {
    ariaChecked: String(!!state.enabled), status: state.enabled ? '已启用；只保留匿名诊断枚举，不包含原始错误内容' : '默认关闭；只记录错误码、版本、阶段和恢复结果',
    count: state.enabled ? state.count + ' 条匿名记录' : '未启用',
    disabled: { export: !state.enabled, clear: !state.enabled || state.count === 0, revoke: !state.enabled }
  };
}
function candidateObservabilityProjection(state) {
  const els = elements();
  const app = { getPrivacyObservabilityState: () => ({ ok: true, value: state }) };
  const controller = observabilityApi.createSettingsObservabilityController({ elements: els, app });
  controller.render();
  return {
    ariaChecked: els.toggle.attrs['aria-checked'], status: els.status.textContent, count: els.count.textContent,
    disabled: { export: els.exportButton.disabled, clear: els.clearButton.disabled, revoke: els.revokeButton.disabled }
  };
}

(async function run() {
  const matrix = [];
  {
    const input = { decryptResult: { ok: false, errorCode: 'XJ_BACKUP_AUTH_FAILED' }, importResult: { ok: true } };
    const baseline = oldRestore(input);
    const candidate = await candidateRestore(input);
    assert.strictEqual(baseline.visible, candidate.visible, 'authentication failure remains visibly an error');
    assert.strictEqual(baseline.state, candidate.state, 'authentication failure preserves current data in both paths');
    assert.strictEqual(candidate.input, 'synthetic.xjbackup', 'candidate intentionally fixes baseline early input clearing');
    assert.ok(candidate.trace.indexOf('passphrase-request') < candidate.trace.indexOf('decrypt'));
    matrix.push({ scenario: 'restore-auth-failure', baseline, candidate, classification: 'intentional-safety-improvement' });
  }
  {
    const input = { decryptResult: { ok: true, payload }, importResult: { ok: true } };
    const baseline = oldRestore(input);
    const candidate = await candidateRestore(input);
    assert.strictEqual(candidate.visible, baseline.visible);
    assert.strictEqual(candidate.input, '');
    assert.ok(candidate.trace.indexOf('toast:success') > candidate.trace.lastIndexOf('export'), 'candidate success follows readback');
    matrix.push({ scenario: 'restore-success', baseline, candidate, classification: 'visible-equivalent-readback-strengthened' });
  }
  for (const state of [{ enabled: false, count: 0 }, { enabled: true, count: 0 }, { enabled: true, count: 3 }]) {
    const baseline = oldObservabilityProjection(state);
    const candidate = candidateObservabilityProjection(state);
    assert.deepStrictEqual(candidate, baseline);
    matrix.push({ scenario: 'observability-' + state.enabled + '-' + state.count, baseline, candidate, classification: 'equivalent' });
  }
  console.log('settings-safety-behavior-equivalence: 5/5 PASS');
  console.log('BEHAVIOR_MATRIX=' + JSON.stringify(matrix));
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
