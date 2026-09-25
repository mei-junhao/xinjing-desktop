'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const syndicate = require('../app/js/supervision-syndicate.js');
const source = fs.readFileSync(path.join(__dirname, '../app/js/store.js'), 'utf8');

function makeStore() {
  const rows = new Map();
  let writes = 0;
  let failNext = false;
  const db = {
    objectStoreNames: { contains: () => true },
    transaction() {
      let wrote = false;
      const tx = { error: null, objectStore() {
        return {
          get(key) {
            const req = {};
            queueMicrotask(() => {
              req.result = rows.get(key); req.onsuccess();
              queueMicrotask(() => { if (!wrote && tx.oncomplete) tx.oncomplete(); });
            });
            return req;
          },
          getAll() {
            const req = {};
            queueMicrotask(() => { req.result = [...rows.values()]; req.onsuccess(); });
            return req;
          },
          put(row) {
            writes++;
            wrote = true;
            queueMicrotask(() => {
              if (failNext) {
                failNext = false;
                tx.error = Error('injected IDB write failure');
                tx.onerror();
              } else {
                rows.set(row.key, structuredClone(row));
                tx.oncomplete();
              }
            });
          },
        };
      } };
      return tx;
    },
  };
  const indexedDB = { open() { const request = {}; queueMicrotask(() => { request.result = db; request.onsuccess({ target: request }); }); return request; } };
  const storage = new Map();
  const localStorage = { get length() { return storage.size; }, key: i => [...storage.keys()][i], getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) };
  const window = { ClinicalTaskValidators: { normalizeClinicalTask: x => x, hasClinicalBodyField: () => false }, indexedDB, localStorage };
  const context = { window, indexedDB, localStorage, console, Date, crypto: globalThis.crypto, setTimeout, clearTimeout };
  vm.createContext(context);
  vm.runInContext(source + '\nthis.__store = Store;', context);
  return { store: context.__store, rows, get writes() { return writes; }, fail() { failNext = true; } };
}

async function main() {
  const env = makeStore();
  const store = env.store;
  await store.hydrate();
  const draft = { mode: 'multi-school', ok: true, synthesis: '合成综合结论', schools: ['sup-winnicott'], route: { schools: ['sup-winnicott'] }, analyses: [{ key: 'sup-winnicott', status: 'ok', content: '合成分析' }], summary: '合成摘要', usage: { total: 10 } };
  const request = { clientId: 'synthetic-client', sessionId: 'synthetic-session', material: '合成临床材料' };
  const before = env.writes;
  const [first, concurrent] = await Promise.all([syndicate.archive(draft, request, { store }), syndicate.archive(draft, request, { store })]);
  assert.equal(first.ok, true);
  assert.equal(concurrent.ok, true);
  assert.equal(first.value.id, concurrent.value.id);
  assert.equal(env.writes - before, 1, 'one atomic write despite concurrent archive');
  assert.equal(store.getSupervisions().length, 1);
  assert.equal(store.getSupervisions()[0].summary, draft.summary);
  assert.equal(store.getSupervisions()[0].mode, 'multi-school');
  assert.equal(store.getSupervisions()[0].analyses.length, 1);
  const retry = await syndicate.archive(draft, request, { store });
  assert.equal(retry.reused, true);
  assert.equal(env.writes - before, 1);
  const second = { ...draft, archiveKey: '', synthesis: '另一次新生成的分析' };
  const fresh = await syndicate.archive(second, request, { store });
  assert.equal(fresh.ok, true);
  assert.equal(store.getSupervisions().length, 2);
  const failed = { ...draft, archiveKey: '' };
  env.fail();
  const failure = await syndicate.archive(failed, request, { store });
  assert.equal(failure.ok, false);
  assert.equal(store.getSupervisions().length, 2, 'failed transaction must not affect cache');
  assert.equal(env.rows.get('supervisions').value.length, 2, 'failed transaction must not affect disk');
  const recovery = await syndicate.archive(failed, request, { store });
  assert.equal(recovery.ok, true, 'failed draft must remain retriable after storage recovery');
  assert.equal(store.getSupervisions().length, 3);
  assert.equal(env.rows.get('supervisions').value.length, 3);
  const legacy = await store.saveAiSupervisionDurable({ context: '合成材料', content: '单派结论', clientId: 'synthetic-client' });
  assert.equal(legacy.ok, true, 'legacy single-school AI record remains supported');
  assert.equal(store.getSupervisions().length, 4);
  // Another renderer can remove a record after this renderer cached it.
  // A retry must consult durable storage instead of returning a stale cache hit.
  const persisted = env.rows.get('supervisions').value.filter(row => row.archiveKey !== draft.archiveKey);
  env.rows.set('supervisions', { key: 'supervisions', value: persisted });
  const retryAfterExternalRemoval = await syndicate.archive(draft, request, { store });
  assert.equal(retryAfterExternalRemoval.ok, true);
  assert.equal(retryAfterExternalRemoval.reused, false);
  assert.equal(env.rows.get('supervisions').value.some(row => row.archiveKey === draft.archiveKey), true);
  const session = { id: 'synthetic-session', clientId: 'synthetic-client', date: '2026-09-23' };
  // Seed an isolated session through the same legacy UI API.
  const seededSession = store.createSession ? store.createSession({ ...session }) : null;
  assert.ok(seededSession);
  // Seed a second renderer's session without touching the production database.
  const externalRecord = { id: 'external-other-window', type: 'individual', clientId: 'external-client', sessionIds: ['synthetic-session'], conclusion: '独立窗口保存' };
  env.rows.set('supervisions', { key: 'supervisions', value: [...env.rows.get('supervisions').value, externalRecord] });
  const removedSession = await store.deleteSessionsDurable(['synthetic-session']);
  assert.equal(removedSession.ok, true);
  assert.equal(env.rows.get('supervisions').value.some(row => row.id === externalRecord.id), true, 'session cleanup must preserve external records');
  assert.deepEqual(env.rows.get('supervisions').value.find(row => row.id === externalRecord.id).sessionIds, []);
  const externalAfterSession = { id: 'external-before-billing-clear', type: 'individual', clientId: 'external-client', sessionIds: [], conclusion: '不属于账单' };
  env.rows.set('supervisions', { key: 'supervisions', value: [...env.rows.get('supervisions').value, externalAfterSession] });
  const cleared = await store.clearBillingDataDurable();
  assert.equal(cleared.ok, true);
  assert.equal(env.rows.get('supervisions').value.some(row => row.id === externalAfterSession.id), true, 'billing clear must preserve external records');
  const unrelated = { id: 'other-window-unrelated-client', type: 'individual', clientId: 'other-client', sessionIds: ['other-window-session'], conclusion: '无关档案不得删除' };
  env.rows.set('supervisions', { key: 'supervisions', value: [...env.rows.get('supervisions').value, unrelated] });
  const deletedClient = await store.deleteClient('synthetic-client');
  assert.equal(deletedClient.ok, true);
  assert.equal(env.rows.get('supervisions').value.some(row => row.id === unrelated.id), true, 'client cleanup cannot delete unknown other-window sessions');
  const beforeFailedClientDelete = structuredClone(env.rows.get('supervisions').value);
  env.fail();
  const failedClientDelete = await store.deleteClient('external-client');
  assert.equal(failedClientDelete.ok, false, 'failed multi-collection transaction cannot report success');
  assert.deepEqual(env.rows.get('supervisions').value, beforeFailedClientDelete, 'failed transaction keeps durable supervision unchanged');
  console.log('PASS: 归档单次原子写、并发幂等、重复点击、新草稿独立、故障注入、恢复及单派兼容');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
