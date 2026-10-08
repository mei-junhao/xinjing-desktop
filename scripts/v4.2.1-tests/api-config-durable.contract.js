#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
const storeSource = fs.readFileSync(path.join(root, 'app', 'js', 'store.js'), 'utf8');
const settingsSource = fs.readFileSync(path.join(root, 'app', 'js', 'settings.js'), 'utf8');
const agentToolsSource = fs.readFileSync(path.join(root, 'app', 'js', 'agent-tools.js'), 'utf8');
let passed = 0;
let failed = 0;

function check(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++;
    console.log('[PASS] ' + name);
  }).catch((error) => {
    failed++;
    console.error('[FAIL] ' + name + ': ' + (error && error.message ? error.message : error));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function buildSandbox(options) {
  options = options || {};
  const records = new Map();
  let objectStoreCreated = false;
  let fallbackWrites = 0;
  const localStorage = {
    getItem: () => null,
    setItem: () => { fallbackWrites++; },
    removeItem: () => {},
    clear: () => {},
    get length() { return 0; },
    key: () => null,
  };
  const indexedDB = {
    open: () => {
      const request = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      const database = {
        objectStoreNames: { contains: () => objectStoreCreated },
        createObjectStore: () => { objectStoreCreated = true; return { createIndex: () => {} }; },
        transaction: () => {
          const transaction = { error: null, oncomplete: null, onerror: null, onabort: null };
          transaction.objectStore = () => ({
            put: (entry) => {
              if (options.fail) {
                transaction.error = new Error('synthetic IndexedDB write failure');
              } else {
                records.set(entry.key, entry.value);
              }
              return {};
            },
            get: () => ({ result: undefined, onsuccess: null, onerror: null }),
            getAll: () => ({ result: [], onsuccess: null, onerror: null }),
            delete: () => ({}),
          });
          const finish = () => {
            if (options.fail) transaction.onerror && transaction.onerror(transaction.error);
            else transaction.oncomplete && transaction.oncomplete();
          };
          if (options.delayMs) setTimeout(finish, options.delayMs);
          else setImmediate(finish);
          return transaction;
        },
      };
      setImmediate(() => {
        request.result = database;
        request.onupgradeneeded && request.onupgradeneeded({ target: request });
        request.onsuccess && request.onsuccess({ target: request });
      });
      return request;
    },
  };
  return { indexedDB, localStorage, records, getFallbackWrites: () => fallbackWrites };
}

function loadStore(sandbox) {
  const context = vm.createContext({
    indexedDB: sandbox.indexedDB,
    localStorage: sandbox.localStorage,
    window: { indexedDB: sandbox.indexedDB, __XJ__: { activated: true, tier: 'full' }, __XJ_API__: { getState: () => Promise.resolve({ activated: true, tier: 'full' }), onLicenseState: () => {} }, location: { pathname: '/index.html' }, addEventListener: () => {} },
    document: { querySelector: () => null, addEventListener: () => {}, createElement: () => ({ style: {} }) },
    navigator: { userAgent: 'contract-test' },
    location: { pathname: '/index.html', origin: 'http://localhost', href: 'http://localhost/index.html' },
    console, Promise, setTimeout, setImmediate, URL, URLSearchParams, TextDecoder,
  });
  new vm.Script(storeSource + '\n;globalThis.__contractStore = Store;').runInContext(context);
  return context.__contractStore;
}

async function run() {
  await check('S1 strict settings API is exported and uses IndexedDB without fallback', () => {
    assert(storeSource.includes('async function saveSettingsDurable'), 'saveSettingsDurable missing');
    assert(/await idbPut\('settings', nextSettings, \{ allowFallback: false \}\)/.test(storeSource), 'settings durable write is not strict');
    assert(/getSettings, saveSettings, saveSettingsDurable/.test(storeSource), 'saveSettingsDurable not exported');
  });
  await check('S2 settings and Agent configuration paths await strict settings persistence', () => {
    assert((settingsSource.match(/await Store\.saveSettingsDurable\(\{ apiConfig:/g) || []).length >= 3, 'settings API paths are not all awaited');
    assert(agentToolsSource.includes('return await Store.saveSettingsDurable({ apiConfig: toSave });'), 'Agent configuration does not await strict persistence');
    assert(!agentToolsSource.includes('Store.saveSettings({ apiConfig: toSave });'), 'Agent configuration retains fire-and-forget save');
  });
  await check('S3 configuration UI shows success only after its strict save guard', () => {
    const manual = settingsSource.slice(settingsSource.indexOf('window.saveApiConfig'), settingsSource.indexOf('window.testApi'));
    const drawer = settingsSource.slice(settingsSource.indexOf('async function cdTestAndApply'), settingsSource.indexOf('function showDsGuide'));
    assert(manual.indexOf('if (!apiSave.ok)') < manual.indexOf("App.showToast('已保存 API 配置', 'success')"), 'manual API success message is not guarded by durable result');
    assert(manual.indexOf('if (!builtinSave.ok)') < manual.indexOf("App.showToast('已切换回内置免费模型', 'success')"), 'builtin success message is not guarded by durable result');
    assert(drawer.indexOf('if (!drawerSave.ok)') < drawer.indexOf("cdMsg('ai', '<b>接入成功"), 'drawer success message is not guarded by durable result');
  });
  await check('C1 successful strict save does not replace cache before transaction completion', async () => {
    const sandbox = buildSandbox({ delayMs: 40 });
    const Store = loadStore(sandbox);
    const before = Store.getSettings();
    const pending = Store.saveSettingsDurable({ apiConfig: { modelPreference: 'synthetic-model' } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert(Store.getSettings() === before, 'authoritative settings cache changed before transaction completion');
    const result = await pending;
    assert(result.ok === true, 'strict settings save did not succeed');
    assert(Store.getSettings().apiConfig.modelPreference === 'synthetic-model', 'saved settings not committed after transaction');
    assert(sandbox.records.has('settings'), 'IndexedDB did not receive settings record');
  });
  await check('C2 IndexedDB failure leaves authoritative settings unchanged and never falls back to localStorage', async () => {
    const sandbox = buildSandbox({ fail: true });
    const Store = loadStore(sandbox);
    const before = Store.getSettings();
    const result = await Store.saveSettingsDurable({ apiConfig: { modelPreference: 'synthetic-model' } });
    assert(result.ok === false, 'strict settings save must report failure');
    assert(Store.getSettings() === before, 'failed strict settings save replaced authoritative cache');
    assert(!sandbox.records.has('settings'), 'failed strict settings save wrote IndexedDB');
    assert(sandbox.getFallbackWrites() === 0, 'strict settings save attempted a localStorage fallback');
  });
  console.log('API_CONFIG_DURABLE: ' + passed + ' passed / ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
}

run().catch((error) => {
  console.error('[FATAL] ' + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
});
