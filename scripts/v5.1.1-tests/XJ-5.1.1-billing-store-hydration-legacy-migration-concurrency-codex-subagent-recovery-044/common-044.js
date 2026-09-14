'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = 'D:/xinjing-electron';
const TASK = 'XJ-5.1.1-billing-store-hydration-legacy-migration-concurrency-codex-subagent-recovery-044';
const CARD_PATH = path.join(ROOT, 'docs/agent-coordination/v5.1.1/tasks', `${TASK}.md`);
const STORE_PATH = path.join(ROOT, 'app/js/store.js');
const LOCKS_PATH = path.join(ROOT, 'docs/agent-coordination/v5.1.1/write-locks.json');
const SCRIPT_ROOT = path.join(ROOT, 'scripts/v5.1.1-tests', TASK);
const SCRATCH_ROOT = path.join(ROOT, 'qa/task-scratch', TASK);
const CLAIM_PATH = path.join(SCRIPT_ROOT, 'EXECUTOR_CLAIM.json');
const LEASE_PATH = path.join(SCRIPT_ROOT, 'LEASE.json');
const FIXTURE_ROOT = path.join(SCRIPT_ROOT, 'fixture-044');
const ELECTRON = path.join(ROOT, 'node_modules/electron/dist/electron.exe');
const WS_PATH = path.join(ROOT, 'node_modules/ws');
const ORIGIN = 'http://127.0.0.1:19421';
const EXPECTED_CARD_SHA = 'FCA7266ED2D8BB543A6AF1CBEEDAD7AE4F08483659C3FC0DACF9CDD9557AB087';
const EXPECTED_STORE_SHA = '84DED0E7EAF3B8DE98A727D5F1671ED42B9EA27AE7EA27CAA644E8EF20CF768D';
const EXPECTED_PROTECTED_SHA = 'D52755D4AED2E9E8D8A4CFF316B3B5F8B2D937B33AA766523998006DAA8B336C';

function shaBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

function shaFile(file) {
  return shaBytes(fs.readFileSync(file));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function git(args) {
  return cp.execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function loadIdentity() {
  const claim = readJson(CLAIM_PATH);
  const lease = readJson(LEASE_PATH);
  if (claim.taskId !== TASK || lease.taskId !== TASK || claim.runId !== lease.runId) {
    throw new Error('claim/lease identity mismatch');
  }
  const cardSha = shaFile(CARD_PATH);
  const storeSha = shaFile(STORE_PATH);
  if (cardSha !== EXPECTED_CARD_SHA) throw new Error(`card SHA drift: ${cardSha}`);
  if (storeSha !== EXPECTED_STORE_SHA) throw new Error(`Store SHA drift: ${storeSha}`);
  const evidenceSuffix = process.env.XJ_044_EVIDENCE_SUFFIX
    ? `-${String(process.env.XJ_044_EVIDENCE_SUFFIX).replace(/[^A-Za-z0-9._-]/g, '-')}`
    : '';
  return {
    taskId: TASK,
    inputTaskId: '043',
    runId: claim.runId,
    runNonce: claim.runNonce,
    cardSha256: cardSha,
    storeSha256: storeSha,
    protectedFilesManifestSha256: EXPECTED_PROTECTED_SHA,
    fixedOrigin: ORIGIN,
    evidenceSuffix,
    evidenceRoot: path.join(SCRATCH_ROOT, 'evidence', `${claim.runId}${evidenceSuffix}`),
    selfRoot: path.join(SCRATCH_ROOT, 'self', `${claim.runId}${evidenceSuffix}`),
    scriptRoot: SCRIPT_ROOT,
    scratchRoot: SCRATCH_ROOT,
    baseCommit: git(['rev-parse', 'HEAD']),
    branch: git(['branch', '--show-current']),
    platformIdentity: claim.platformIdentity,
    platformModel: claim.platformModel,
    reasoningEffort: claim.reasoningEffort,
  };
}

function isContained(parent, candidate) {
  const p = path.resolve(parent);
  const c = path.resolve(candidate);
  const rel = path.relative(p, c);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function realContained(parent, candidate) {
  try {
    return isContained(fs.realpathSync.native(parent), fs.realpathSync.native(candidate));
  } catch (_) {
    return false;
  }
}

function lstatFacts(file) {
  const st = fs.lstatSync(file);
  return {
    path: path.resolve(file),
    realpath: fs.realpathSync.native(file),
    isSymbolicLink: st.isSymbolicLink(),
    isFile: st.isFile(),
    isDirectory: st.isDirectory(),
    bytes: st.isFile() ? st.size : null,
  };
}

function legacySeedScript() {
  return String.raw`(() => {
    const seed = {
      'xj_clients': JSON.stringify([{ id: 'legacy-c1', name: 'Legacy Client', status: 'active', billing: { monthlyPayments: [{ month: '2026-07', amount: 888 }] } }]),
      'xj_sessions': JSON.stringify([{ id: 'legacy-s1', clientId: 'legacy-c1', date: '2026-07-10', sessionNumber: 1, billing: { fee: 500, paid: true } }]),
      'xj_supervisions': JSON.stringify([{ id: 'legacy-sup1', clientId: 'legacy-c1', note: 'legacy supervision' }]),
      'xj_settings': JSON.stringify({ theme: 'light', legacy: true, marker: '044-seed' }),
      'xj_blob_legacy-s1:transcript': 'LEGACY-BLOB-044',
    };
    window.__XJ044 = window.__XJ044 || { puts: [], openCalls: 0, injectedErrors: [] };
    window.__XJ044.seed = Object.keys(seed);
    for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value);
    const originalPut = IDBObjectStore.prototype.put;
    if (!window.__XJ044.putWrapped) {
      IDBObjectStore.prototype.put = function (value) {
        try {
          if (this && this.name === 'kv' && value && typeof value === 'object') {
            window.__XJ044.puts.push({ key: value.key, value: value.value });
          }
        } catch (_) {}
        return originalPut.apply(this, arguments);
      };
      window.__XJ044.putWrapped = true;
    }
  })();`;
}

function throwOpenScript() {
  return String.raw`(() => {
    window.__XJ044 = window.__XJ044 || { puts: [], openCalls: 0, injectedErrors: [] };
    const message = '044 injected indexedDB.open throw';
    indexedDB.open = function () {
      window.__XJ044.openCalls++;
      const error = new DOMException(message, 'InvalidStateError');
      window.__XJ044.injectedErrors.push({ kind: 'throw', name: error.name, message: error.message });
      throw error;
    };
    window.__XJ044.idbFailureInjection = 'open-throws-before-request';
  })();`;
}

function applyMutationScript(kind) {
  const mutation = String(kind);
  if (mutation === 'delete-migration') return String.raw`(() => {
    const original = localStorage.getItem.bind(localStorage);
    localStorage.getItem = key => key === 'xj_clients' ? null : original(key);
    window.__XJ044.mutation = 'delete-migration';
  })();`;
  if (mutation === 'wrong-key-map') return String.raw`(() => {
    const original = localStorage.getItem.bind(localStorage);
    localStorage.getItem = key => key === 'xj_clients' ? original('xj_sessions') : original(key);
    window.__XJ044.mutation = 'wrong-key-map';
  })();`;
  if (mutation === 'keep-old-keys') return String.raw`(() => {
    const original = localStorage.removeItem.bind(localStorage);
    localStorage.removeItem = key => key && key.startsWith('xj_') ? undefined : original(key);
    window.__XJ044.mutation = 'keep-old-keys';
  })();`;
  if (mutation === 'skip-await') return String.raw`(() => {
    const original = window.Store.createClientDurable;
    window.__XJ044.originalCreateClientDurable = original;
    window.Store.createClientDurable = async function (data) {
      window.__XJ044.mutation = 'skip-await';
      return { ok: true, value: Object.assign({ id: 'mut-skip-await' }, data || {}), version: 'mutated' };
    };
  })();`;
  if (mutation === 'swallow-open-error') return String.raw`(() => {
    const original = window.Store.createClientDurable;
    window.Store.createClientDurable = async function (data) {
      window.__XJ044.mutation = 'swallow-open-error';
      const result = await original.call(this, data);
      return result && result.ok === false
        ? { ok: true, value: data || {}, swallowed: true, originalError: result.error || null }
        : result;
    };
    indexedDB.open = function () {
      window.__XJ044.openCalls = (window.__XJ044.openCalls || 0) + 1;
      const error = new DOMException('044 mutated open error', 'InvalidStateError');
      window.__XJ044.injectedErrors = window.__XJ044.injectedErrors || [];
      window.__XJ044.injectedErrors.push({ kind: 'mutation-throw', name: error.name });
      throw error;
    };
  })();`;
  if (mutation === 'object-as-array-api') return String.raw`(() => {
    window.__XJ044.mutation = 'object-as-array-api';
    window.Store.getClients = () => ({ bad: 'object', mutation: 'object-as-array-api' });
  })();`;
  if (mutation === 'hydrate-reset') return String.raw`(() => {
    const original = window.Store.hydrate;
    window.Store.hydrate = async function () {
      const result = await original.apply(this, arguments);
      window.__XJ044.mutation = 'hydrate-reset';
      window.Store.getClient = () => null;
      return result;
    };
  })();`;
  if (mutation === 'ghost-cross-origin') return String.raw`(() => {
    const original = window.Store.getClients;
    window.Store.getClients = function () {
      const list = original.apply(this, arguments);
      window.__XJ044.mutation = 'ghost-cross-origin';
      return list.concat([{ id: 'ghost-044', name: 'GHOST', origin: 'http://127.0.0.1:19420' }]);
    };
  })();`;
  throw new Error(`unknown mutation ${mutation}`);
}

module.exports = {
  ROOT,
  TASK,
  CARD_PATH,
  STORE_PATH,
  LOCKS_PATH,
  SCRIPT_ROOT,
  SCRATCH_ROOT,
  CLAIM_PATH,
  LEASE_PATH,
  FIXTURE_ROOT,
  ELECTRON,
  WS_PATH,
  ORIGIN,
  EXPECTED_CARD_SHA,
  EXPECTED_STORE_SHA,
  EXPECTED_PROTECTED_SHA,
  shaBytes,
  shaFile,
  ensureDir,
  writeJson,
  readJson,
  git,
  loadIdentity,
  isContained,
  realContained,
  lstatFacts,
  legacySeedScript,
  throwOpenScript,
  applyMutationScript,
};
