'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const STORE_PATH = path.join(ROOT, 'app', 'js', 'store.js');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function memoryStorage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
    key(index) { return Array.from(values.keys())[index] || null; },
  };
}

function createIndexedDB(seed) {
  const records = new Map(Object.entries(seed || {}).map(([key, value]) => [key, clone(value)]));
  let failWrites = false;
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => ({}),
    transaction: (_name, mode) => {
      const pending = [];
      let scheduled = false;
      const tx = { error: null, oncomplete: null, onerror: null, onabort: null };
      function scheduleWrite() {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => {
          if (failWrites) {
            tx.error = new Error('synthetic durable write failure');
            if (typeof tx.onerror === 'function') tx.onerror({ target: tx });
            return;
          }
          pending.forEach((operation) => {
            if (operation.type === 'put') records.set(operation.key, clone(operation.value));
            else records.delete(operation.key);
          });
          if (typeof tx.oncomplete === 'function') tx.oncomplete({ target: tx });
        }, 0);
      }
      tx.objectStore = () => ({
        get(key) {
          const request = { result: undefined, error: null, onsuccess: null, onerror: null };
          setTimeout(() => {
            request.result = records.has(String(key)) ? { key: String(key), value: clone(records.get(String(key))) } : undefined;
            if (typeof request.onsuccess === 'function') request.onsuccess({ target: request });
          }, 0);
          return request;
        },
        getAll() {
          const request = { result: undefined, error: null, onsuccess: null, onerror: null };
          setTimeout(() => {
            request.result = Array.from(records, ([key, value]) => ({ key, value: clone(value) }));
            if (typeof request.onsuccess === 'function') request.onsuccess({ target: request });
          }, 0);
          return request;
        },
        put(record) {
          pending.push({ type: 'put', key: String(record.key), value: record.value });
          if (mode === 'readwrite') scheduleWrite();
          return { onsuccess: null, onerror: null };
        },
        delete(key) {
          pending.push({ type: 'delete', key: String(key) });
          if (mode === 'readwrite') scheduleWrite();
          return { onsuccess: null, onerror: null };
        },
      });
      return tx;
    },
  };
  return {
    open() {
      const request = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      setTimeout(() => {
        request.result = db;
        if (typeof request.onupgradeneeded === 'function') request.onupgradeneeded({ target: request });
        if (typeof request.onsuccess === 'function') request.onsuccess({ target: request });
      }, 0);
      return request;
    },
    setFailWrites(value) { failWrites = !!value; },
    read(key) { return clone(records.get(String(key))); },
  };
}

function loadStore(options) {
  options = options || {};
  const indexedDB = options.indexedDB || createIndexedDB(options.seed);
  const scope = {
    console,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON,
    Promise,
    Map,
    Set,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    RegExp,
    localStorage: memoryStorage(),
    indexedDB,
    location: { reload() {} },
  };
  scope.window = scope;
  vm.createContext(scope);
  // store.js 依赖 window.ClinicalTaskValidators：先加载 validators（纯 IIFE 自动挂载）
  const validatorsSource = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'app', 'js', 'clinical-task-validators.js'), 'utf8');
  vm.runInContext(validatorsSource, scope, { filename: 'clinical-task-validators.js' });
  if (!scope.window.ClinicalTaskValidators) throw new Error('validators did not attach to window');
  const source = options.storeSource || fs.readFileSync(STORE_PATH, 'utf8');
  vm.runInContext(source + '\n;globalThis.__store = Store;', scope, { filename: STORE_PATH });
  return { Store: scope.__store, indexedDB };
}

async function seedClientAndSession(Store) {
  let result = await Store.createClientDurable({ id: 'client-a', name: 'Synthetic A' });
  assert.strictEqual(result.ok, true, 'synthetic client A must persist');
  result = await Store.createClientDurable({ id: 'client-b', name: 'Synthetic B' });
  assert.strictEqual(result.ok, true, 'synthetic client B must persist');
  result = await Store.createSessionDurable({ id: 'session-a1', clientId: 'client-a', sessionNumber: 1, marker: 'keep-me' });
  assert.strictEqual(result.ok, true, 'synthetic session A must persist');
  result = await Store.createSessionDurable({ id: 'session-a2', clientId: 'client-a', sessionNumber: 2 });
  assert.strictEqual(result.ok, true, 'synthetic session A2 must persist');
  result = await Store.createSessionDurable({ id: 'session-b1', clientId: 'client-b', sessionNumber: 1 });
  assert.strictEqual(result.ok, true, 'synthetic session B must persist');
}

function manualTask(overrides) {
  return Object.assign({
    id: 'task-manual-1',
    clientId: 'client-a',
    originSessionId: 'session-a1',
    title: 'Synthetic follow-up',
    status: 'open',
    due: '2026-07-28',
    sourceRefs: ['source-ref-a'],
    target: 'consult-notes.html',
    createdBy: 'manual',
  }, overrides || {});
}

async function run(options) {
  options = options || {};
  const database = createIndexedDB();
  const first = loadStore({ storeSource: options.storeSource, indexedDB: database });
  const Store = first.Store;
  await Store.hydrate();
  await seedClientAndSession(Store);

  assert.strictEqual(typeof Store.createClinicalTaskDurable, 'function', 'real Store must expose durable clinical-task creation');
  assert.strictEqual(typeof Store.saveSessionTemplateSelectionDurable, 'function', 'real Store must expose durable template selection');

  let result = await Store.createClinicalTaskDurable(manualTask());
  assert.strictEqual(result.ok, true, 'manual Free workflow must create an open task');
  assert.strictEqual(Store.getClinicalTasksByClient('client-a').length, 1, 'client projection must include its task');
  assert.strictEqual(database.read('clinicalTasks').length, 1, 'clinicalTasks must persist as a top-level collection');
  const exposedTask = Store.getClinicalTask('task-manual-1');
  exposedTask.title = 'MUTATED OUTSIDE STORE';
  exposedTask.sourceRefs.push('source-ref-external');
  assert.strictEqual(Store.getClinicalTask('task-manual-1').title, 'Synthetic follow-up', 'read APIs must not expose the authoritative task object');
  assert.deepStrictEqual(Array.from(Store.getClinicalTask('task-manual-1').sourceRefs), ['source-ref-a'], 'read APIs must clone source references');

  assert.strictEqual((await Store.createClinicalTaskDurable(manualTask())).ok, false, 'duplicate task IDs must fail');
  assert.strictEqual((await Store.createClinicalTaskDurable(manualTask({ id: 'task-cross', originSessionId: 'session-b1' }))).ok, false, 'origin session must belong to the same client');
  assert.strictEqual((await Store.createClinicalTaskDurable(manualTask({ id: 'task-body', metadata: { raw_content: 'FORBIDDEN' } }))).ok, false, 'nested clinical body fields must fail');
  assert.strictEqual((await Store.createClinicalTaskDurable(manualTask({
    id: 'task-status', status: 'unknown', createdBy: 'ai-draft', actionRunId: 'run-synthetic-status',
  }))).ok, false, 'unknown task status must fail independently of manual-task rules');
  assert.strictEqual((await Store.createClinicalTaskDurable(manualTask({ id: 'task-refs', sourceRefs: ['source-ref-a', 'source-ref-a'] }))).ok, false, 'duplicate source references must fail');
  assert.strictEqual((await Store.createClinicalTaskDurable(manualTask({ id: 'task-ref-body', sourceRefs: ['clinical narrative with spaces'] }))).ok, false, 'source references must be bounded stable identifiers');
  assert.strictEqual((await Store.createClinicalTaskDurable(manualTask({ id: 'task-terminal-create', status: 'done' }))).ok, false, 'manual tasks must not be created directly in a terminal state');
  assert.strictEqual((await Store.createClinicalTaskDurable(manualTask({
    id: 'task-ai-open-create', createdBy: 'ai-draft', status: 'open', actionRunId: 'run-synthetic-open',
  }))).ok, false, 'AI-created tasks must not bypass draft confirmation');
  assert.strictEqual((await Store.createAiDraftClinicalTaskDurable(manualTask({ id: 'task-ai-no-run', actionRunId: '' }))).ok, false, 'AI-created tasks must retain an action-run trace');

  result = await Store.updateClinicalTaskDurable('task-manual-1', { clientId: 'client-b' });
  assert.strictEqual(result.ok, false, 'client trace must be immutable');
  result = await Store.updateClinicalTaskDurable('task-manual-1', { originSessionId: 'session-a2' });
  assert.strictEqual(result.ok, false, 'origin session trace must be immutable');
  result = await Store.updateClinicalTaskDurable('task-manual-1', { status: 'done' });
  assert.strictEqual(result.ok, false, 'ordinary updates must not bypass explicit transitions');

  result = await Store.createAiDraftClinicalTaskDurable(manualTask({
    id: 'task-ai-1', status: 'open', createdBy: 'manual', actionRunId: 'run-synthetic-1',
  }));
  assert.strictEqual(result.ok, true, 'AI task API must create a draft');
  assert.strictEqual(result.value.status, 'ai-draft', 'AI-created task must remain a draft');
  result = await Store.confirmClinicalTaskDurable('task-ai-1');
  assert.strictEqual(result.ok, true, 'explicit confirmation must open an AI draft');
  assert.strictEqual(result.value.status, 'open', 'confirmed AI draft must become open');
  assert.strictEqual((await Store.confirmClinicalTaskDurable('task-manual-1')).ok, false, 'non-drafts must not pass confirmation');

  result = await Store.transitionClinicalTaskDurable('task-manual-1', 'done', '2026-07-27T07:00:00.000Z');
  assert.strictEqual(result.ok, true, 'an open task must complete');
  assert.strictEqual(result.value.originSessionId, 'session-a1', 'completion must preserve the origin session');
  assert.strictEqual((await Store.transitionClinicalTaskDurable('task-manual-1', 'cancelled')).ok, false, 'terminal tasks must not transition again');

  result = await Store.saveClinicalTasksDurable([
    manualTask({ id: 'task-batch-1', updatedAt: '2026-07-27T07:01:00.000Z' }),
    manualTask({ id: 'task-batch-2', updatedAt: '2026-07-27T07:02:00.000Z' }),
  ]);
  assert.strictEqual(result.ok, true, 'validated task batch must persist atomically');
  const beforeDuplicateBatch = Store.getClinicalTasks().length;
  result = await Store.saveClinicalTasksDurable([manualTask({ id: 'task-dup' }), manualTask({ id: 'task-dup' })]);
  assert.strictEqual(result.ok, false, 'duplicate IDs in a batch must fail');
  assert.strictEqual(Store.getClinicalTasks().length, beforeDuplicateBatch, 'failed batch must not partially update cache');
  result = await Store.saveClinicalTasksDurable([Object.assign({}, Store.getClinicalTask('task-ai-1'), { status: 'done' })]);
  assert.strictEqual(result.ok, false, 'batch updates must not bypass explicit status transitions');

  result = await Store.saveSessionTemplateSelectionDurable('session-a1', {
    templateId: 'manual-session-v1', tierAtSelection: 'Free', context: 'individual',
  });
  assert.strictEqual(result.ok, true, 'Free manual template selection must persist');
  assert.strictEqual(result.session.marker, 'keep-me', 'template save must preserve unrelated session fields');
  assert.strictEqual(Store.getSessionTemplateSelection('session-a1').templateId, 'manual-session-v1', 'template selection must be readable');
  assert.strictEqual((await Store.saveSessionTemplateSelectionDurable('session-a1', {
    templateId: 'ai-session-v1', tierAtSelection: 'Free', context: 'individual',
  })).ok, false, 'Free tier must not persist a Pro template selection');
  assert.strictEqual((await Store.saveSessionTemplateSelectionDurable('missing-session', {
    templateId: 'manual-session-v1', tierAtSelection: 'Free', context: 'individual',
  })).ok, false, 'unknown session must fail closed');
  assert.strictEqual((await Store.saveSessionTemplateSelectionDurable('session-a1', {
    templateId: 'flagship-session-v1', tierAtSelection: 'Flagship', context: 'individual', customTemplateId: '../bad',
  })).ok, false, 'unsafe custom template ID must fail');

  const exported = JSON.parse(await Store.exportAll());
  assert.ok(Array.isArray(exported.clinicalTasks) && exported.clinicalTasks.length >= 4, 'backup export must include clinical tasks');

  const reloaded = loadStore({ storeSource: options.storeSource, indexedDB: database });
  await reloaded.Store.hydrate();
  assert.ok(reloaded.Store.getClinicalTask('task-manual-1'), 'a task must survive Store reload');
  assert.strictEqual(reloaded.Store.getSessionTemplateSelection('session-a1').templateId, 'manual-session-v1', 'template selection must survive Store reload');

  const failureDb = createIndexedDB();
  const failureStore = loadStore({ storeSource: options.storeSource, indexedDB: failureDb }).Store;
  await failureStore.hydrate();
  await seedClientAndSession(failureStore);
  result = await failureStore.saveSessionTemplateSelectionDurable('session-a1', {
    templateId: 'manual-session-v1', tierAtSelection: 'Free', context: 'individual',
  });
  assert.strictEqual(result.ok, true, 'failure fixture must establish an authoritative template selection');
  failureDb.setFailWrites(true);
  result = await failureStore.createClinicalTaskDurable(manualTask({ id: 'task-must-not-cache' }));
  assert.strictEqual(result.ok, false, 'durable task failure must surface');
  assert.strictEqual(failureStore.getClinicalTask('task-must-not-cache'), null, 'failed durable task must not enter authoritative cache');
  result = await failureStore.saveSessionTemplateSelectionDurable('session-a1', {
    templateId: 'ai-session-v1', tierAtSelection: 'Pro', context: 'individual',
  });
  assert.strictEqual(result.ok, false, 'durable template failure must surface');
  assert.strictEqual(failureStore.getSessionTemplateSelection('session-a1').templateId, 'manual-session-v1', 'failed template save must preserve authoritative selection');

  const corrupt = loadStore({ storeSource: options.storeSource, seed: {
    clients: [{ id: 'client-a', name: 'Synthetic A' }],
    sessions: [{ id: 'session-a1', clientId: 'client-a' }],
    clinicalTasks: { invalid: true },
  } }).Store;
  await corrupt.hydrate();
  assert.deepStrictEqual(Array.from(corrupt.getClinicalTasks()), [], 'corrupt clinicalTasks storage must hydrate to empty');
  assert.ok(corrupt.getStorageDiagnostics().some((item) => item.code === 'XJ_CLINICAL_TASKS_CORRUPT'), 'corrupt storage must expose a diagnostic');

  const importDb = createIndexedDB();
  const importStore = loadStore({ storeSource: options.storeSource, indexedDB: importDb }).Store;
  await importStore.hydrate();
  result = await importStore.importAll(JSON.stringify({
    clients: [{ id: 'client-a', name: 'Synthetic A' }],
    sessions: [{ id: 'session-a1', clientId: 'client-a', templateSelection: { templateId: 'ai-session-v1', tierAtSelection: 'Free', context: 'individual' } }],
    clinicalTasks: [
      manualTask({ id: 'task-import-invalid', nested: { transcript: 'FORBIDDEN' } }),
      manualTask({ id: 'task-import-status', status: 'unknown', createdBy: 'ai-draft', actionRunId: 'run-import-status' }),
    ],
    settings: {},
  }));
  assert.strictEqual(result.ok, true, 'import must complete while quarantining invalid optional records');
  assert.strictEqual(importStore.getClinicalTasks().length, 0, 'invalid imported clinical tasks must not enter cache');
  assert.strictEqual(importStore.getSessionTemplateSelection('session-a1'), null, 'invalid imported template selection must be removed');
  assert.ok(result.quarantine.some((item) => item.collection === 'clinicalTasks'), 'invalid imported task must be quarantined');
  assert.ok(result.quarantine.some((item) => item.entityId === 'task-import-status'), 'unknown imported task status must be quarantined by the status allowlist');
  assert.ok(result.quarantine.some((item) => item.reason === 'invalid-template-selection'), 'invalid template selection must be quarantined');

  console.log('durable clinical-task/session-template Store contract: PASS');
  return { checks: 52 };
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error && error.stack || error);
    process.exit(1);
  });
}

module.exports = {
  run,
  readStoreSource: () => fs.readFileSync(STORE_PATH, 'utf8'),
};
