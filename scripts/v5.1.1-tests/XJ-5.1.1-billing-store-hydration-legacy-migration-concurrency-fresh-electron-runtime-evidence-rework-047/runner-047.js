'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const crypto = require('crypto');
const {
  ROOT,
  TASK,
  SCRIPT_ROOT,
  SCRATCH_ROOT,
  FIXTURE_ROOT,
  ELECTRON,
  WS_PATH,
  ORIGIN,
  shaFile,
  shaBytes,
  ensureDir,
  writeJson,
  loadIdentity,
  legacySeedScript,
  throwOpenScript,
  applyMutationScript,
} = require('./common-047');

const identity = loadIdentity();
const EVIDENCE_ROOT = identity.evidenceRoot;
const FIXTURE_URL = `${ORIGIN}/fixture-047/store-fixture.html`;
const results = [];
const stageRecords = [];

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function logCheck(name, pass, detail) {
  const item = { name, pass: !!pass, detail: String(detail || '').slice(0, 700) };
  results.push(item);
  console.log(`${item.pass ? 'PASS' : 'FAIL'} ${name} ${item.detail}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 1500 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.once('timeout', () => request.destroy(new Error(`timeout ${url}`)));
    request.once('error', reject);
  });
}

function startFixtureServer() {
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  };
  const server = http.createServer((request, response) => {
    try {
      let urlPath = decodeURIComponent(String(request.url || '/').split('?')[0]);
      if (urlPath === '/' || urlPath === '') urlPath = '/fixture-047/store-fixture.html';
      let base;
      let relative;
      if (urlPath.startsWith('/fixture-047/')) {
        base = FIXTURE_ROOT;
        relative = urlPath.slice('/fixture-047/'.length);
      } else {
        base = path.join(ROOT, 'app');
        relative = urlPath.replace(/^\/+/, '');
      }
      const file = path.resolve(base, relative);
      const rel = path.relative(path.resolve(base), file);
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      fs.readFile(file, (error, data) => {
        if (error) { response.writeHead(404).end('Not Found'); return; }
        response.writeHead(200, {
          'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': ORIGIN,
        });
        response.end(data);
      });
    } catch (error) {
      response.writeHead(500).end(String(error && error.message || error));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(19421, '127.0.0.1', () => resolve(server));
  });
}

function connectCdp(webSocketUrl) {
  const WebSocket = require(WS_PATH);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const pending = new Map();
    let nextId = 1;
    const failAll = error => {
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    };
    socket.on('open', () => resolve({
      send(method, params) {
        return new Promise((res, rej) => {
          const id = nextId++;
          const timer = setTimeout(() => {
            pending.delete(id);
            rej(new Error(`CDP timeout ${method}`));
          }, 15000);
          pending.set(id, { resolve: res, reject: rej, timer });
          socket.send(JSON.stringify({ id, method, params: params || {} }));
        });
      },
      close() { try { socket.close(); } catch (_) {} },
    }));
    socket.on('message', payload => {
      let message;
      try { message = JSON.parse(payload.toString()); } catch (_) { return; }
      if (!message.id) return;
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message || 'CDP error'));
      else waiter.resolve(message.result || {});
    });
    socket.on('error', error => { failAll(error); reject(error); });
    socket.on('close', () => failAll(new Error('CDP socket closed')));
  });
}

async function findPage(cdpPort) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const pages = await getJson(`http://127.0.0.1:${cdpPort}/json/list`);
      const page = pages.find(item => item && item.type === 'page');
      if (page) return page;
    } catch (_) {}
    await wait(200);
  }
  throw new Error(`CDP page timeout on ${cdpPort}`);
}

async function evaluate(cdp, expression) {
  const reply = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (reply.exceptionDetails) {
    const detail = reply.exceptionDetails.exception && reply.exceptionDetails.exception.description
      || reply.exceptionDetails.text || 'runtime exception';
    throw new Error(detail);
  }
  return reply.result && reply.result.value;
}

function readKvExpression(keys) {
  return String.raw`(async () => {
    const wanted = ${JSON.stringify(keys)};
    const output = {};
    const request = indexedDB.open('xinjing_db');
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IDB read open failed'));
      request.onblocked = () => reject(new Error('IDB read open blocked'));
    });
    try {
      for (const key of wanted) {
        output[key] = await new Promise((resolve, reject) => {
          const req = db.transaction('kv', 'readonly').objectStore('kv').get(key);
          req.onsuccess = () => resolve(req.result === undefined ? null : req.result);
          req.onerror = () => reject(req.error || new Error('IDB get failed'));
        });
      }
    } finally { db.close(); }
    return output;
  })()`;
}

function listLocalStorageExpression() {
  return String.raw`(() => {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) keys.push(key);
    }
    return keys.sort();
  })()`;
}

function waitForChild(child, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true, code: null, signal: null });
    }, timeoutMs);
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut: false, code, signal });
    });
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut: false, code: null, signal: error && error.code || 'spawn-error' });
    });
  });
}

async function runStage(options) {
  const {
    stageId,
    phase,
    role,
    userDataDir,
    preScript,
    activity,
    expectedFailure = false,
  } = options;
  const stageDir = path.join(EVIDENCE_ROOT, 'stages', stageId);
  if (fs.existsSync(stageDir)) throw new Error(`stage path already exists: ${stageDir}`);
  ensureDir(stageDir);
  const cdpPort = await freePort();
  const argv = [
    '--disable-gpu',
    '--no-sandbox',
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${cdpPort}`,
    '--remote-allow-origins=*',
    FIXTURE_ROOT,
  ];
  const startUtc = new Date().toISOString();
  const env = Object.assign({}, process.env, {
    XJ_FIXTURE_URL: FIXTURE_URL,
    XJ_NETWORK_DENY: '1',
    XJ_047_TASK_ID: TASK,
    XJ_047_RUN_ID: identity.runId,
  });
  const child = cp.spawn(ELECTRON, argv, {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  let cdp = null;
  let target = null;
  let semanticResult = null;
  let runnerError = null;
  let closeMode = 'not-started';
  let forcedTermination = false;
  let processResult = null;
  try {
    target = await findPage(cdpPort);
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    if (preScript) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: preScript });
    await cdp.send('Page.reload', { ignoreCache: true });
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        ready = await evaluate(cdp, `location.origin === ${JSON.stringify(ORIGIN)} && !!window.Store && typeof window.Store.hydrate === 'function'`);
        if (ready === true) break;
      } catch (_) {}
      await wait(250);
    }
    if (!ready) throw new Error('Store fixture did not become ready');
    semanticResult = await evaluate(cdp, activity);
    closeMode = 'Browser.close';
    try { await cdp.send('Browser.close'); } catch (_) {}
  } catch (error) {
    runnerError = String(error && error.stack || error);
    closeMode = 'error-cleanup';
    try { if (cdp) await cdp.send('Browser.close'); } catch (_) {}
  } finally {
    if (cdp) cdp.close();
  }
  processResult = await waitForChild(child, 20000);
  if (processResult.timedOut) {
    forcedTermination = true;
    try { child.kill(); } catch (_) {}
    processResult = await waitForChild(child, 5000);
  }
  const endUtc = new Date().toISOString();
  const evaluationLine = `\n=== 047 EVALUATION_RESULT ===\n${JSON.stringify({ taskId: TASK, runId: identity.runId, stageId, semanticResult })}\n`;
  const errorLine = runnerError ? `=== 047 RUNNER_ERROR ===\n${runnerError}\n` : '';
  const stdoutPath = path.join(stageDir, 'stdout.txt');
  const stderrPath = path.join(stageDir, 'stderr.txt');
  fs.writeFileSync(stdoutPath, stdout + evaluationLine + errorLine, 'utf8');
  fs.writeFileSync(stderrPath, stderr || '', 'utf8');
  const semanticDefect = !!(semanticResult && semanticResult.defect === true);
  let verdict = 'FAIL';
  let exitCode = processResult.code == null ? 3 : processResult.code;
  let exitCodeSource = 'electron-process';
  if (!runnerError && !forcedTermination && processResult.code === 0) {
    if (expectedFailure && semanticDefect) {
      exitCode = 1;
      exitCodeSource = 'semantic-gate-defect';
      verdict = 'KILLED';
    } else if (expectedFailure && !semanticDefect) {
      exitCode = 0;
      exitCodeSource = 'electron-process';
      verdict = 'MUTATION_SURVIVED';
    } else {
      exitCode = 0;
      verdict = semanticResult && semanticResult.ok === false ? 'PASS_EXPECTED_ERROR' : 'PASS';
    }
  }
  const meta = {
    schema: 'xj-047-stage-meta-v2',
    taskId: TASK,
    inputTaskId: '046',
    runId: identity.runId,
    runNonce: identity.runNonce,
    cardSha256: identity.cardSha256,
    storeSha256: shaFile(path.join(ROOT, 'app/js/store.js')),
    protectedFilesManifestSha256: identity.protectedFilesManifestSha256,
    fixedOrigin: ORIGIN,
    stageId,
    phase,
    role,
    expectedFailure,
    command: ELECTRON,
    argv: argv.slice(),
    spawnVector: [ELECTRON, ...argv],
    cwd: ROOT,
    startUtc,
    endUtc,
    processExitCode: processResult.code,
    processSignal: processResult.signal,
    exitCode,
    exitCodeSource,
    verdict,
    closeMode,
    forcedTermination,
    runtime: 'electron',
    realElectron: true,
    fixtureRoot: FIXTURE_ROOT,
    fixtureUrl: FIXTURE_URL,
    cdpPort,
    userDataDir,
    evidenceRoot: EVIDENCE_ROOT,
    stdoutPath,
    stderrPath,
    stdoutSha256: shaFile(stdoutPath),
    stderrSha256: shaFile(stderrPath),
    stdoutBytes: fs.statSync(stdoutPath).size,
    stderrBytes: fs.statSync(stderrPath).size,
    semanticResult,
    runnerError,
  };
  writeJson(path.join(stageDir, 'meta.json'), meta);
  stageRecords.push(meta);
  console.log(`${verdict} ${stageId} processExit=${processResult.code} effectiveExit=${exitCode}`);
  return meta;
}

function migrationActivity() {
  return String.raw`(async () => {
    const beforeConcurrent = window.__XJ047.puts.length;
    await Promise.all([window.Store.hydrate(), window.Store.hydrate(), window.Store.hydrate(), window.Store.hydrate()]);
    const firstPutCount = window.__XJ047.puts.length;
    const first = {
      clients: window.Store.getClients(),
      sessions: window.Store.getSessions(),
      supervisions: window.Store.getSupervisions(),
      settings: window.Store.getSettings(),
    };
    const firstClient = window.Store.getClient('legacy-c1');
    const firstSession = window.Store.getSession('legacy-s1');
    const capturedBlobPut = window.__XJ047.puts.find(x => x && x.key === 'clients_blob_legacy-s1:transcript') || null;
    window.__XJ047.puts.length = 0;
    await window.Store.hydrate();
    const repeatPutCount = window.__XJ047.puts.length;
    const records = await (${readKvExpression(['clients', 'sessions', 'supervisions', 'settings', 'clients_blob_legacy-s1:transcript'])});
    const oldKeys = (${listLocalStorageExpression()}).filter(k => k.startsWith('xj_'));
    const fallbackKeys = (${listLocalStorageExpression()}).filter(k => k.startsWith('xj2_'));
    const clientRecord = records.clients;
    const sessionRecord = records.sessions;
    const supervisionRecord = records.supervisions;
    const settingsRecord = records.settings;
    const expectedClient = first.clients.length === 1 && first.clients[0].id === 'legacy-c1' && first.clients[0].billing.monthlyPayments[0].amount === 888;
    const expectedSession = first.sessions.length === 1 && first.sessions[0].id === 'legacy-s1' && firstSession && firstSession.transcript === 'LEGACY-BLOB-047';
    const expectedSupervision = first.supervisions.length === 1 && first.supervisions[0].id === 'legacy-sup1';
    const expectedSettings = first.settings && first.settings.marker === '047-seed';
    const idbShape = clientRecord && clientRecord.key === 'clients' && Array.isArray(clientRecord.value)
      && sessionRecord && sessionRecord.key === 'sessions' && Array.isArray(sessionRecord.value)
      && supervisionRecord && supervisionRecord.key === 'supervisions' && Array.isArray(supervisionRecord.value)
      && settingsRecord && settingsRecord.key === 'settings' && settingsRecord.value && settingsRecord.value.marker === '047-seed';
    return {
      ok: location.origin === 'http://127.0.0.1:19421' && expectedClient && expectedSession && expectedSupervision && expectedSettings && idbShape && oldKeys.length === 0 && repeatPutCount === 0 && firstPutCount >= beforeConcurrent,
      runtimeProbe: { realElectron: true, origin: location.origin, storeLoaded: true, hydrateAwaited: true },
      origin: location.origin,
      concurrentHydrateCount: 4,
      beforeConcurrent,
      firstPutCount,
      repeatPutCount,
      clients: first.clients,
      sessions: first.sessions,
      supervisions: first.supervisions,
      settings: first.settings,
      clientRecord,
      sessionRecord,
      supervisionRecord,
      settingsRecord,
      blobRecordAfterMerge: records['clients_blob_legacy-s1:transcript'],
      capturedBlobPut,
      sessionTranscript: firstSession && firstSession.transcript,
      oldKeys,
      fallbackKeys,
      defect: false,
    };
  })()`;
}

function restartActivity() {
  return String.raw`(async () => {
    await window.Store.hydrate();
    const records = await (${readKvExpression(['clients', 'sessions', 'supervisions', 'settings'])});
    const oldKeys = (${listLocalStorageExpression()}).filter(k => k.startsWith('xj_'));
    const client = window.Store.getClient('legacy-c1');
    const session = window.Store.getSession('legacy-s1');
    const ok = location.origin === 'http://127.0.0.1:19421'
      && !!client && client.billing.monthlyPayments[0].amount === 888
      && !!session && session.transcript === 'LEGACY-BLOB-047'
      && records.clients && records.clients.key === 'clients' && Array.isArray(records.clients.value)
      && records.sessions && records.sessions.key === 'sessions' && Array.isArray(records.sessions.value)
      && records.settings && records.settings.key === 'settings' && records.settings.value.marker === '047-seed'
      && oldKeys.length === 0;
    return {
      ok,
      runtimeProbe: { realElectron: true, origin: location.origin, hydrateAwaited: true, sameOriginRestart: true },
      origin: location.origin,
      client,
      session,
      settings: window.Store.getSettings(),
      records,
      oldKeys,
      repeatMigration: oldKeys.length > 0,
      defect: false,
    };
  })()`;
}

function throwDegradeActivity() {
  return String.raw`(async () => {
    await window.Store.hydrate();
    const durableResult = await window.Store.createClientDurable({ id: 'degrade-throw-client', name: 'Degrade throw', status: 'active', billing: {} });
    const keys = (${listLocalStorageExpression()}).sort();
    const fallbackKeys = keys.filter(k => k.startsWith('xj2_'));
    const oldKeys = keys.filter(k => k.startsWith('xj_'));
    let fallbackClients = null;
    try { fallbackClients = JSON.parse(localStorage.getItem('xj2_clients') || 'null'); } catch (_) {}
    const ok = location.origin === 'http://127.0.0.1:19421'
      && window.__XJ047.idbFailureInjection === 'open-throws-before-request'
      && window.__XJ047.openCalls > 0
      && fallbackKeys.includes('xj2_clients')
      && Array.isArray(fallbackClients) && fallbackClients[0].id === 'legacy-c1'
      && oldKeys.length === 0
      && durableResult && durableResult.ok === false
      && durableResult.error && typeof durableResult.error.code === 'string'
      && !window.Store.getClient('degrade-throw-client');
    return {
      ok,
      runtimeProbe: { realElectron: true, origin: location.origin, storeLoaded: true, hydrateAwaited: true },
      injectionEvidence: { kind: 'indexedDB.open throws', openCalls: window.__XJ047.openCalls, injectedErrors: window.__XJ047.injectedErrors },
      origin: location.origin,
      fallbackKeys,
      oldKeys,
      fallbackClients,
      durableResult,
      visibleClient: window.Store.getClient('degrade-throw-client'),
      defect: false,
    };
  })()`;
}

function errorEventActivity() {
  return String.raw`(async () => {
    const prepared = await new Promise((resolve, reject) => {
      const request = indexedDB.open('xinjing_db', 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('kv')) request.result.createObjectStore('kv', { keyPath: 'key' });
      };
      request.onsuccess = () => { request.result.close(); resolve({ version: 2 }); };
      request.onerror = () => reject(request.error || new Error('prepare DB v2 failed'));
    });
    const probe = await new Promise(resolve => {
      const request = indexedDB.open('xinjing_db', 1);
      request.onerror = event => resolve({ event: true, name: event.target && event.target.error && event.target.error.name || 'unknown', message: event.target && event.target.error && event.target.error.message || '' });
      request.onsuccess = () => { request.result.close(); resolve({ event: false, name: 'unexpected-success' }); };
    });
    await window.Store.hydrate();
    const durableResult = await window.Store.createClientDurable({ id: 'degrade-event-client', name: 'Degrade event', status: 'active', billing: {} });
    const keys = (${listLocalStorageExpression()}).sort();
    const fallbackKeys = keys.filter(k => k.startsWith('xj2_'));
    const oldKeys = keys.filter(k => k.startsWith('xj_'));
    let fallbackClients = null;
    try { fallbackClients = JSON.parse(localStorage.getItem('xj2_clients') || 'null'); } catch (_) {}
    const ok = location.origin === 'http://127.0.0.1:19421'
      && prepared.version === 2 && probe.event === true && probe.name === 'VersionError'
      && fallbackKeys.includes('xj2_clients') && Array.isArray(fallbackClients) && fallbackClients[0].id === 'legacy-c1'
      && oldKeys.length === 0
      && durableResult && durableResult.ok === false
      && durableResult.error && typeof durableResult.error.code === 'string';
    return {
      ok,
      runtimeProbe: { realElectron: true, origin: location.origin, storeLoaded: true, hydrateAwaited: true },
      injectionEvidence: { kind: 'natural IndexedDB open error event', preparedDbVersion: prepared.version, targetStoreVersion: 1, errorEvent: probe },
      origin: location.origin,
      fallbackKeys,
      oldKeys,
      fallbackClients,
      durableResult,
      defect: false,
    };
  })()`;
}

function badValueActivity() {
  return String.raw`(async () => {
    const seeded = await new Promise((resolve, reject) => {
      const request = indexedDB.open('xinjing_db', 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('kv')) request.result.createObjectStore('kv', { keyPath: 'key' });
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put({ key: 'clients', value: { corrupt: true } });
        tx.objectStore('kv').put({ key: 'sessions', value: 'corrupt-sessions' });
        tx.oncomplete = () => { db.close(); resolve(true); };
        tx.onerror = () => { db.close(); reject(tx.error || new Error('bad value seed failed')); };
      };
      request.onerror = () => reject(request.error || new Error('bad value open failed'));
    });
    await window.Store.hydrate();
    const clients = window.Store.getClients();
    const sessions = window.Store.getSessions();
    const settings = window.Store.getSettings();
    const ok = seeded === true && Array.isArray(clients) && clients.length === 0 && Array.isArray(sessions) && sessions.length === 0 && settings && typeof settings === 'object';
    return {
      ok,
      runtimeProbe: { realElectron: true, origin: location.origin, hydrateAwaited: true },
      injectionEvidence: { kind: 'real IndexedDB bad-value records', clientsValueType: 'object', sessionsValueType: 'string' },
      origin: location.origin,
      clients,
      sessions,
      settings,
      storageDiagnostics: window.Store.getStorageDiagnostics(),
      defect: false,
    };
  })()`;
}

function baselineActivity() {
  return String.raw`(async () => {
    await window.Store.hydrate();
    const records = await (${readKvExpression(['clients', 'sessions', 'supervisions', 'settings'])});
    const oldKeys = (${listLocalStorageExpression()}).filter(k => k.startsWith('xj_'));
    const clients = window.Store.getClients();
    const sessions = window.Store.getSessions();
    const client = window.Store.getClient('legacy-c1');
    const session = window.Store.getSession('legacy-s1');
    const ok = Array.isArray(clients) && clients.length === 1 && !!client
      && Array.isArray(sessions) && sessions.length === 1 && !!session && session.transcript === 'LEGACY-BLOB-047'
      && records.clients && records.clients.key === 'clients' && Array.isArray(records.clients.value)
      && records.sessions && records.sessions.key === 'sessions' && Array.isArray(records.sessions.value)
      && records.settings && records.settings.key === 'settings' && records.settings.value.marker === '047-seed'
      && oldKeys.length === 0;
    return {
      ok,
      runtimeProbe: { realElectron: true, origin: location.origin, hydrateAwaited: true },
      origin: location.origin,
      clients,
      sessions,
      client,
      session,
      records,
      oldKeys,
      defect: false,
    };
  })()`;
}

function mutationActivity(kind) {
  const setup = applyMutationScript(kind);
  if (kind === 'skip-await') {
    return String.raw`(async () => {
      ${setup}
      await window.Store.hydrate();
      const result = await window.Store.createClientDurable({ id: 'mut-skip-await', name: 'Skip await', status: 'active', billing: {} });
      const records = await (${readKvExpression(['clients'])});
      const persisted = records.clients && Array.isArray(records.clients.value) && records.clients.value.some(x => x && x.id === 'mut-skip-await');
      return { ok: false, defect: result && result.ok === true && !persisted, mutation: ${JSON.stringify(kind)}, runtimeProbe: { realElectron: true, origin: location.origin }, result, persisted, records };
    })()`;
  }
  if (kind === 'swallow-open-error') {
    return String.raw`(async () => {
      ${setup}
      await window.Store.hydrate();
      const result = await window.Store.createClientDurable({ id: 'mut-swallow-error', name: 'Swallow error', status: 'active', billing: {} });
      const fallbackKeys = (${listLocalStorageExpression()}).filter(k => k.startsWith('xj2_'));
      return { ok: false, defect: result && result.ok === true && result.swallowed === true && result.originalError && typeof result.originalError.code === 'string', mutation: ${JSON.stringify(kind)}, runtimeProbe: { realElectron: true, origin: location.origin }, result, fallbackKeys, visible: window.Store.getClient('mut-swallow-error') };
    })()`;
  }
  return String.raw`(async () => {
    ${setup}
    await window.Store.hydrate();
    const clients = window.Store.getClients();
    const sessions = window.Store.getSessions();
    const oldKeys = (${listLocalStorageExpression()}).filter(k => k.startsWith('xj_'));
    const client = window.Store.getClient('legacy-c1');
    const defect = ${JSON.stringify(kind)} === 'delete-migration'
      ? oldKeys.includes('xj_clients') && !client
      : ${JSON.stringify(kind)} === 'wrong-key-map'
        ? Array.isArray(clients) && clients.some(x => x && x.id === 'legacy-s1') && !client
        : ${JSON.stringify(kind)} === 'keep-old-keys'
          ? oldKeys.length > 0
          : ${JSON.stringify(kind)} === 'object-as-array-api'
            ? !Array.isArray(clients)
            : ${JSON.stringify(kind)} === 'hydrate-reset'
              ? !client
              : ${JSON.stringify(kind)} === 'ghost-cross-origin'
                ? Array.isArray(clients) && clients.some(x => x && x.id === 'ghost-047')
                : false;
    return { ok: false, defect, mutation: ${JSON.stringify(kind)}, runtimeProbe: { realElectron: true, origin: location.origin }, clients, sessions, oldKeys, client };
  })()`;
}

async function main() {
  if (fs.existsSync(EVIDENCE_ROOT)) throw new Error(`fresh evidence root already exists: ${EVIDENCE_ROOT}`);
  ensureDir(EVIDENCE_ROOT);
  console.log(`047 RUNNER_START ${JSON.stringify({ taskId: TASK, runId: identity.runId, evidenceRoot: EVIDENCE_ROOT })}`);
  writeJson(path.join(EVIDENCE_ROOT, 'run-context.json'), {
    schema: 'xj-047-run-context-v1',
    taskId: TASK,
    inputTaskId: '046',
    runId: identity.runId,
    runNonce: identity.runNonce,
    cardSha256: identity.cardSha256,
    storeSha256AtStart: identity.storeSha256,
    protectedFilesManifestSha256: identity.protectedFilesManifestSha256,
    baseCommit: identity.baseCommit,
    branch: identity.branch,
    fixedOrigin: ORIGIN,
    runtime: 'electron',
    networkPolicy: 'default-deny except fixed 127.0.0.1:19421',
    evidenceRoot: EVIDENCE_ROOT,
    argvPolicy: 'argv is the exact array passed to child_process.spawn',
    startedUtc: new Date().toISOString(),
  });
  const fixtureServer = await startFixtureServer();
  console.log(`FIXTURE ${ORIGIN} UP`);
  let migrationUserData;
  try {
    migrationUserData = fs.mkdtempSync(path.join(require('os').tmpdir(), `xj-047-migration-${identity.runNonce.slice(0, 8)}-`));
    const migration = await runStage({
      stageId: 'core-migration-concurrent-hydrate',
      phase: 'B1',
      role: 'migration',
      userDataDir: migrationUserData,
      preScript: legacySeedScript(),
      activity: migrationActivity(),
    });
    logCheck('迁移/IDB kv key-value/旧键删除/重复并发 hydrate', migration.verdict.startsWith('PASS') && migration.semanticResult && migration.semanticResult.ok === true, migration.semanticResult);

    const restart = await runStage({
      stageId: 'core-graceful-close-same-origin-restart',
      phase: 'B1',
      role: 'restart',
      userDataDir: migrationUserData,
      preScript: null,
      activity: restartActivity(),
    });
    logCheck('graceful close + 同 userData 同 origin 重启回读', restart.verdict.startsWith('PASS') && restart.semanticResult && restart.semanticResult.ok === true && restart.closeMode === 'Browser.close', restart.semanticResult);

    const throwUserData = fs.mkdtempSync(path.join(require('os').tmpdir(), `xj-047-throw-${identity.runNonce.slice(0, 8)}-`));
    const throwStage = await runStage({
      stageId: 'core-idb-open-throws-fallback',
      phase: 'B2',
      role: 'idb-open-throw-degrade',
      userDataDir: throwUserData,
      preScript: `${legacySeedScript()}\n${throwOpenScript()}`,
      activity: throwDegradeActivity(),
    });
    logCheck('IDB open 抛异常 → localStorage 降级 + durable ok:false', throwStage.verdict.startsWith('PASS') && throwStage.semanticResult && throwStage.semanticResult.ok === true, throwStage.semanticResult);

    const eventUserData = fs.mkdtempSync(path.join(require('os').tmpdir(), `xj-047-event-${identity.runNonce.slice(0, 8)}-`));
    const eventStage = await runStage({
      stageId: 'core-idb-open-error-event-fallback',
      phase: 'B2',
      role: 'idb-open-error-event-degrade',
      userDataDir: eventUserData,
      preScript: legacySeedScript(),
      activity: errorEventActivity(),
    });
    logCheck('真实 IDB open VersionError error 事件 → 降级', eventStage.verdict.startsWith('PASS') && eventStage.semanticResult && eventStage.semanticResult.ok === true, eventStage.semanticResult);

    const badUserData = fs.mkdtempSync(path.join(require('os').tmpdir(), `xj-047-bad-${identity.runNonce.slice(0, 8)}-`));
    const badStage = await runStage({
      stageId: 'core-bad-value-fail-closed',
      phase: 'B2',
      role: 'bad-value-fail-closed',
      userDataDir: badUserData,
      preScript: null,
      activity: badValueActivity(),
    });
    logCheck('坏值 fail-closed（非数组不进入缓存）', badStage.verdict.startsWith('PASS') && badStage.semanticResult && badStage.semanticResult.ok === true, badStage.semanticResult);

    const defs = [
      ['01-delete-migration', 'delete-migration'],
      ['02-wrong-key-map', 'wrong-key-map'],
      ['03-keep-old-keys', 'keep-old-keys'],
      ['04-skip-await', 'skip-await'],
      ['05-swallow-open-error', 'swallow-open-error'],
      ['06-object-as-array-api', 'object-as-array-api'],
      ['07-hydrate-reset', 'hydrate-reset'],
      ['08-ghost-cross-origin', 'ghost-cross-origin'],
    ];
    let killed = 0;
    let restored = 0;
    for (const [label, kind] of defs) {
      const mutatedUserData = fs.mkdtempSync(path.join(require('os').tmpdir(), `xj-047-${label}-mut-${identity.runNonce.slice(0, 6)}-`));
      const mutated = await runStage({
        stageId: `expected-red/${label}/mutated`,
        phase: 'C',
        role: 'mutated',
        userDataDir: mutatedUserData,
        preScript: legacySeedScript(),
        activity: mutationActivity(kind),
        expectedFailure: true,
      });
      const baselineUserData = fs.mkdtempSync(path.join(require('os').tmpdir(), `xj-047-${label}-base-${identity.runNonce.slice(0, 6)}-`));
      const baseline = await runStage({
        stageId: `expected-red/${label}/baseline`,
        phase: 'C',
        role: 'baseline',
        userDataDir: baselineUserData,
        preScript: legacySeedScript(),
        activity: baselineActivity(),
      });
      const restoreUserData = fs.mkdtempSync(path.join(require('os').tmpdir(), `xj-047-${label}-restore-${identity.runNonce.slice(0, 6)}-`));
      const restore = await runStage({
        stageId: `expected-red/${label}/restore`,
        phase: 'C',
        role: 'restore',
        userDataDir: restoreUserData,
        preScript: legacySeedScript(),
        activity: baselineActivity(),
      });
      const mutKilled = mutated.verdict === 'KILLED' && mutated.exitCode !== 0 && mutated.semanticResult && mutated.semanticResult.defect === true;
      const basePass = baseline.verdict.startsWith('PASS') && baseline.exitCode === 0 && baseline.semanticResult && baseline.semanticResult.ok === true;
      const restorePass = restore.verdict.startsWith('PASS') && restore.exitCode === 0 && restore.semanticResult && restore.semanticResult.ok === true;
      if (mutKilled) killed++;
      if (restorePass) restored++;
      logCheck(`expected-red ${label}: mutated KILLED + baseline/restore PASS`, mutKilled && basePass && restorePass, JSON.stringify({ mutated: mutated.verdict, baseline: baseline.verdict, restore: restore.verdict, defect: mutated.semanticResult && mutated.semanticResult.defect }));
    }
    logCheck('expected-red 8/8 真 KILLED', killed === 8, `${killed}/8`);
    logCheck('restore 8/8 fresh PASS', restored === 8, `${restored}/8`);
    const storeShaEnd = shaFile(path.join(ROOT, 'app/js/store.js'));
    logCheck('生产 Store SHA 未变', storeShaEnd === identity.storeSha256, `${storeShaEnd}`);
    const manifest = {
      schema: 'xj-047-evidence-manifest-v1',
      taskId: TASK,
      inputTaskId: '046',
      runId: identity.runId,
      runNonce: identity.runNonce,
      cardSha256: identity.cardSha256,
      storeSha256AtStart: identity.storeSha256,
      storeSha256AtEnd: storeShaEnd,
      protectedFilesManifestSha256: identity.protectedFilesManifestSha256,
      fixedOrigin: ORIGIN,
      evidenceRoot: EVIDENCE_ROOT,
      stageCount: stageRecords.length,
      stageMetaPaths: stageRecords.map(stage => path.join(path.dirname(stage.stdoutPath), 'meta.json')),
      stageRecords: stageRecords.map(stage => ({ stageId: stage.stageId, phase: stage.phase, role: stage.role, verdict: stage.verdict, exitCode: stage.exitCode, expectedFailure: stage.expectedFailure, userDataDir: stage.userDataDir, metaPath: path.join(path.dirname(stage.stdoutPath), 'meta.json') })),
      checks: results,
      flags: { createdLocal: true, releaseReady: false, publishAuthorized: false, released: false },
      finishedUtc: new Date().toISOString(),
    };
    writeJson(path.join(EVIDENCE_ROOT, 'results.json'), results);
    writeJson(path.join(EVIDENCE_ROOT, 'evidence-manifest.json'), manifest);
    console.log(`047 RUNNER ${results.filter(x => x.pass).length}/${results.length}`);
    if (results.some(x => !x.pass)) process.exitCode = 1;
  } finally {
    try { fixtureServer.close(); } catch (_) {}
  }
}

main().catch(error => {
  console.error('047 RUNNER FATAL', error && error.stack || error);
  process.exitCode = 1;
});


