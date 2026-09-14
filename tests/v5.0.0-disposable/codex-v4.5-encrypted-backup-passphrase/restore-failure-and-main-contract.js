'use strict';

const assert = require('assert');
const crypto = require('crypto');
const EventEmitter = require('events');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '../../../');
const STORE_PATH = path.join(ROOT, 'app/js/store.js');
const VALIDATOR_PATH = path.join(ROOT, 'app/js/clinical-task-validators.js');
const BACKUP_CRYPTO_PATH = path.join(ROOT, 'app/js/backup-crypto.js');

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
  const database = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => ({}),
    transaction: (_name, mode) => {
      const pending = [];
      let scheduled = false;
      const tx = { error: null, oncomplete: null, onerror: null, onabort: null };
      function schedule() {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => {
          if (failWrites) {
            tx.error = new Error('synthetic durable write failure');
            if (typeof tx.onerror === 'function') tx.onerror({ target: tx });
            if (typeof tx.onabort === 'function') tx.onabort({ target: tx });
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
          const request = { result: undefined, onsuccess: null, onerror: null };
          setTimeout(() => {
            request.result = records.has(String(key))
              ? { key: String(key), value: clone(records.get(String(key))) }
              : undefined;
            if (typeof request.onsuccess === 'function') request.onsuccess({ target: request });
          }, 0);
          return request;
        },
        getAll() {
          const request = { result: undefined, onsuccess: null, onerror: null };
          setTimeout(() => {
            request.result = Array.from(records, ([key, value]) => ({ key, value: clone(value) }));
            if (typeof request.onsuccess === 'function') request.onsuccess({ target: request });
          }, 0);
          return request;
        },
        put(record) {
          pending.push({ type: 'put', key: String(record.key), value: record.value });
          if (mode === 'readwrite') schedule();
          return { onsuccess: null, onerror: null };
        },
        delete(key) {
          pending.push({ type: 'delete', key: String(key) });
          if (mode === 'readwrite') schedule();
          return { onsuccess: null, onerror: null };
        },
      });
      return tx;
    },
  };
  return {
    open() {
      const request = { result: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      setTimeout(() => {
        request.result = database;
        if (typeof request.onupgradeneeded === 'function') request.onupgradeneeded({ target: request });
        if (typeof request.onsuccess === 'function') request.onsuccess({ target: request });
      }, 0);
      return request;
    },
    setFailWrites(value) { failWrites = !!value; },
    read(key) { return clone(records.get(String(key))); },
  };
}

function loadStore(indexedDB) {
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
  vm.runInContext(fs.readFileSync(VALIDATOR_PATH, 'utf8'), scope, { filename: VALIDATOR_PATH });
  vm.runInContext(fs.readFileSync(STORE_PATH, 'utf8') + '\n;globalThis.__store = Store;', scope, { filename: STORE_PATH });
  return scope.__store;
}

async function runStoreFailureContract() {
  const database = createIndexedDB();
  const store = loadStore(database);
  await store.hydrate();
  assert.strictEqual((await store.createClientDurable({ id: 'current-client', name: 'Current synthetic client' })).ok, true);
  assert.strictEqual((await store.createSessionDurable({ id: 'current-session', clientId: 'current-client', marker: 'keep-current' })).ok, true);
  assert.strictEqual((await store.saveSettingsDurable({ apiConfig: { apiKey: 'xj-enc:synthetic-current-key', model: 'keep-model' } })).ok, true);

  const beforeClients = store.getClients();
  const beforeSessions = store.getSessions();
  const beforeSettings = store.getSettings();
  const replacement = JSON.stringify({
    version: '2.0.0',
    clients: [{ id: 'replacement-client', name: 'Replacement synthetic client' }],
    sessions: [{ id: 'replacement-session', clientId: 'replacement-client' }],
  });

  database.setFailWrites(true);
  const failed = await store.importAll(replacement);
  assert.strictEqual(failed.ok, false, 'durable import failure must be surfaced');
  assert.strictEqual(failed.error.code, 'XJ_IMPORT_DURABLE_FAILED');
  assert.deepStrictEqual(store.getClients(), beforeClients, 'failed import must preserve the current client cache');
  assert.deepStrictEqual(store.getSessions(), beforeSessions, 'failed import must preserve the current session cache');
  assert.deepStrictEqual(store.getSettings(), beforeSettings, 'failed import must preserve current settings and API key');
  assert.strictEqual(JSON.stringify(database.read('clients')), JSON.stringify(beforeClients), 'failed import must preserve the durable client record');
  assert.strictEqual(JSON.stringify(database.read('sessions')), JSON.stringify(beforeSessions), 'failed import must preserve the durable session record');

  database.setFailWrites(false);
  const healthyStore = loadStore(database);
  await healthyStore.hydrate();
  const imported = await healthyStore.importAll(replacement);
  assert.strictEqual(imported.ok, true, 'a later healthy import must still work');
  assert.strictEqual(healthyStore.getClients()[0].id, 'replacement-client');
  assert.strictEqual(healthyStore.getSessions()[0].id, 'replacement-session');
  assert.strictEqual(healthyStore.getSettings().apiConfig.apiKey, 'xj-enc:synthetic-current-key', 'manual import must retain the current API key');

  const invalid = await healthyStore.importAll('{not-json');
  assert.strictEqual(invalid.ok, false, 'invalid JSON must fail before any durable write');
  assert.strictEqual(invalid.error.code, 'XJ_IMPORT_DURABLE_FAILED');
  assert.strictEqual(healthyStore.getClients()[0].id, 'replacement-client');
  console.log('STORE_RESTORE_CONTRACT=PASS');
  console.log('STORE_RESTORE_ASSERTIONS=14');
}

function makeElectronHarness(rootDir) {
  const paths = {
    appData: path.join(rootDir, 'app-data'),
    userData: path.join(rootDir, 'initial-user-data'),
    documents: path.join(rootDir, 'documents'),
  };
  fs.mkdirSync(paths.appData, { recursive: true });
  fs.mkdirSync(paths.documents, { recursive: true });

  const app = new EventEmitter();
  app.setName = () => {};
  app.getPath = (name) => paths[name] || path.join(rootDir, String(name));
  app.setPath = (name, value) => { paths[name] = value; };
  app.requestSingleInstanceLock = () => true;
  app.whenReady = () => ({ then() { return this; } });
  app.quit = () => {};
  app.getVersion = () => '4.2.4';
  app.isPackaged = false;

  const handlers = new Map();
  const ipcMain = new EventEmitter();
  ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from('synthetic-safe:' + value, 'utf8'),
    decryptString: (value) => String(value.toString('utf8')).replace(/^synthetic-safe:/, ''),
  };
  const autoUpdater = new EventEmitter();
  const electron = {
    app,
    BrowserWindow: class BrowserWindow {},
    Tray: class Tray {},
    Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
    nativeImage: { createFromPath: () => ({}) },
    dialog: { showMessageBox: async () => ({ response: 0 }), showErrorBox: () => {} },
    ipcMain,
    net: { fetch: async () => { throw new Error('network not expected in backup contract'); } },
    shell: { openExternal: async () => {} },
    safeStorage,
    autoUpdater,
  };
  return { paths, app, handlers, safeStorage, electron, autoUpdater };
}

function loadMain(harness) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return harness.electron;
    if (request === 'electron-updater') return { autoUpdater: harness.autoUpdater };
    if (request === './license-core') return {};
    if (request === './app/js/entitlements') return {};
    if (request === './supervision-package-core') return { DEFAULT_LIMITS: { maxPackageBytes: 4 * 1024 * 1024 } };
    if (request === './proxy-secret.generated') return { APP_PROXY_KEY: '' };
    if (request === './rag-index.js') return null;
    if (request === 'mammoth') return null;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(path.join(ROOT, 'main.js'))];
    require(path.join(ROOT, 'main.js'));
  } finally {
    Module._load = originalLoad;
  }
}

async function runMainBackupContract() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-v45-main-'));
  const harness = makeElectronHarness(rootDir);
  try {
    loadMain(harness);
    const trustedEvent = { senderFrame: { url: 'http://127.0.0.1:0/settings.html' } };
    const passphrase = 'synthetic recovery phrase 2026';
    const payload = JSON.stringify({ version: '2.0.0', clients: [], sessions: [] });
    const encrypt = harness.handlers.get('xj:backup:encrypt');
    const decrypt = harness.handlers.get('xj:backup:decrypt');
    const writeSafety = harness.handlers.get('xj:backup:writeSafetySnapshot');
    assert.ok(encrypt && decrypt && writeSafety, 'backup IPC handlers must be registered');

    const encrypted = await encrypt(trustedEvent, { payload, passphrase });
    assert.strictEqual(encrypted.ok, true, 'trusted renderer can create an encrypted package');
    assert.ok(!encrypted.package.includes('synthetic recovery phrase 2026'));
    assert.strictEqual((await decrypt(trustedEvent, { packageText: encrypted.package, passphrase: 'wrong recovery phrase 2026' })).errorCode, 'XJ_BACKUP_AUTH_FAILED');
    assert.strictEqual((await encrypt({ senderFrame: { url: 'https://evil.invalid/' } }, { payload, passphrase })).errorCode, 'XJ_BACKUP_SENDER_DENIED');

    const safety = await writeSafety(trustedEvent, { payload, passphrase });
    assert.strictEqual(safety.ok, true, 'trusted renderer can create a recovery safety snapshot: ' + JSON.stringify(safety));
    const safetyPath = path.join(harness.paths.userData, 'backup-restore-safety.xjbackup');
    assert.ok(fs.existsSync(safetyPath));
    assert.ok(!fs.readFileSync(safetyPath, 'utf8').includes('synthetic recovery phrase 2026'));

    const invalidUserData = path.join(rootDir, 'not-a-directory');
    fs.writeFileSync(invalidUserData, 'block directory creation');
    harness.paths.userData = invalidUserData;
    const safetyFailed = await writeSafety(trustedEvent, { payload, passphrase });
    assert.strictEqual(safetyFailed.ok, false, 'safety snapshot filesystem failure must be surfaced');
    assert.strictEqual(safetyFailed.errorCode, 'XJ_BACKUP_SAFETY_WRITE_FAILED');

    harness.paths.userData = path.join(harness.paths.appData, 'XinJing');
    fs.mkdirSync(harness.paths.userData, { recursive: true });
    fs.writeFileSync(path.join(harness.paths.userData, 'synthetic-user-data.txt'), 'synthetic backup content', 'utf8');
    harness.app.emit('before-quit');
    const latest = path.join(harness.paths.documents, '心镜备份', '最新.xjbackup');
    assert.ok(fs.existsSync(latest), 'quit backup must write a package');
    const packageText = fs.readFileSync(latest, 'utf8');
    const packageMeta = JSON.parse(packageText);
    assert.strictEqual(packageMeta.kind, 'user-data-snapshot');
    assert.ok(!packageText.includes('synthetic backup content'), 'automatic backup must not contain plaintext source data');
    const keyRecord = JSON.parse(fs.readFileSync(path.join(harness.paths.userData, 'backup-key.json'), 'utf8'));
    const deviceKey = Buffer.from(harness.safeStorage.decryptString(Buffer.from(keyRecord.encryptedKey.slice(7), 'base64')), 'base64');
    const decryptedSnapshot = JSON.parse(require(BACKUP_CRYPTO_PATH).decryptPayloadWithKey(packageText, deviceKey));
    assert.ok(decryptedSnapshot.files.some((file) => file.path === 'synthetic-user-data.txt'));
    deviceKey.fill(0);

    console.log('MAIN_BACKUP_CONTRACT=PASS');
    console.log('MAIN_BACKUP_ASSERTIONS=15');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

(async () => {
  await runStoreFailureContract();
  await runMainBackupContract();
})().catch((error) => {
  console.error('RESTORE_MAIN_CONTRACT=FAIL', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
