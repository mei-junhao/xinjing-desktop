'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../../');
const OUT = path.join(ROOT, 'qa/task-scratch/XJ-5.1.0-pi-supervision-broker-production-wiring-041/evidence/mutation-results.json');
const trusted = { sender: { id: 419 } };
const sourceRef = { sourceId: 'mutation:041', sourceVersion: 1, sourceContentHash: 'sha256:' + 'e'.repeat(64), anchorContentHash: 'sha256:' + 'f'.repeat(64) };
const projection = { clientId: 'mc-041', sessionId: 'ms-041', sourceRefs: [sourceRef], storeProjectionVersion: 1, membershipProjectionVersion: 1 };

function makeIpc() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handlers,
    handle(c, fn) { handlers.set(c, fn); },
    removeHandler(c) { handlers.delete(c); },
    on(c, fn) { const xs = listeners.get(c) || []; xs.push(fn); listeners.set(c, xs); },
    removeListener(c, fn) { listeners.set(c, (listeners.get(c) || []).filter((x) => x !== fn)); },
    emit(c, e, p) { (listeners.get(c) || []).slice().forEach((fn) => fn(e, p)); },
  };
}

function makeRuntime(mod, membership, userDataDir) {
  const bus = makeIpc();
  const win = { webContents: { id: 419, isDestroyed: () => false, send: (_c, req) => {
    bus.emit('xj:pi:renderer-reply', trusted, { requestId: req.requestId, response: { ok: true, savedObjectId: 'mutation-receipt', version: Date.now(), object: {} } });
  } } };
  const runtime = mod.createPiProductionRuntime({
    ipcMain: bus,
    getMainWindow: () => win,
    isTrustedRendererEvent: (e) => !!(e && e.sender && e.sender.id === 419),
    userDataDir: userDataDir || fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj510-041-mut-')),
    serverMembershipProjection: () => membership,
  });
  return { runtime, bus };
}

function copyPi() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj510-041-pi-copy-'));
  fs.cpSync(path.join(ROOT, 'app/js/pi'), path.join(dir, 'pi'), { recursive: true });
  return path.join(dir, 'pi');
}

function mutate(relative, needle, replacement) {
  const piRoot = copyPi();
  const file = path.join(piRoot, relative);
  const before = fs.readFileSync(file, 'utf8');
  if (!before.includes(needle)) throw new Error('mutation needle missing: ' + relative);
  fs.writeFileSync(file, before.replace(needle, replacement), 'utf8');
  return { piRoot, module: require(path.join(piRoot, 'bridge/pi-production-runtime-v1.js')) };
}

async function runCase(id, mutant, probe) {
  const baselineMod = require(path.join(ROOT, 'app/js/pi/bridge/pi-production-runtime-v1.js'));
  const baseline = await probe(baselineMod);
  const mutatedMod = mutant.module;
  const mutated = await probe(mutatedMod);
  const killed = JSON.stringify(baseline) !== JSON.stringify(mutated);
  console.log((killed ? 'KILLED ' : 'SURVIVED ') + id + ' baseline=' + JSON.stringify(baseline) + ' mutated=' + JSON.stringify(mutated));
  return { id, killed, baseline, mutated };
}

function startWith(mod, opts) {
  const rt = makeRuntime(mod, opts.membership === undefined ? { tier: 'pro' } : opts.membership, opts.userDataDir);
  if (opts.publish !== false) rt.runtime.publishState(trusted, opts.message || { projection, reads: { 'read.task.cards': { '{}': { cards: [] } } } });
  return rt;
}

function probes() {
  return [
    {
      id: 'M1-empty-sourceRefs',
      mutant: mutate('bridge/pi-production-runtime-v1.js', 'if (!Array.isArray(value.sourceRefs) || value.sourceRefs.length === 0) return null;', 'if (!Array.isArray(value.sourceRefs)) return null;'),
      probe: (mod) => { const empty = { ...projection, sourceRefs: [] }; const rt = startWith(mod, { message: { projection: empty, reads: {} } }); const r = rt.runtime.bridge.api.startTask({ taskId: 'xj_task_041_m1', mode: 'observe', projection: empty }); rt.runtime.stop(); return { code: r.code || null, ok: r.ok === true }; },
    },
    {
      id: 'M2-request-projection-overwrite',
      mutant: mutate('bridge/pi-production-runtime-v1.js', "if (!requestedHash || !publishedHash || requestedHash !== publishedHash) {", "if (!requestedHash || !publishedHash || false) {"),
      probe: (mod) => { const rt = startWith(mod, {}); const r = rt.runtime.bridge.api.startTask({ taskId: 'xj_task_041_m2', mode: 'observe', projection: { ...projection, storeProjectionVersion: 9 } }); rt.runtime.stop(); return { code: r.code || null, ok: r.ok === true }; },
    },
    {
      id: 'M3-malformed-publication-clear',
      mutant: mutate('bridge/pi-production-runtime-v1.js', '    const projection = projectionShape(message.projection);\n    if (!projection) {\n      // A malformed publication must not leave a previous context writable.\n      state.projection = null;\n      state.activeContext = null;\n      state.reads = {};\n      return;\n    }', '    const projection = projectionShape(message.projection);\n    if (!projection) {\n      // mutation: retain the previous trusted projection\n      return;\n    }'),
      probe: (mod) => { const rt = startWith(mod, {}); rt.runtime.bridge.api.startTask({ taskId: 'xj_task_041_m3_old', mode: 'observe', projection }); rt.runtime.publishState(trusted, { projection: { ...projection, extra: true }, reads: {} }); const r = rt.runtime.bridge.api.startTask({ taskId: 'xj_task_041_m3_new', mode: 'observe', projection }); rt.runtime.stop(); return { code: r.code || null, ok: r.ok === true }; },
    },
    {
      id: 'M4-trusted-sender-bypass',
      mutant: mutate('bridge/pi-production-runtime-v1.js', "        if (!trustedMainWindowEvent(event)) return fail('XJ_PI_UNKNOWN_EVENT', 'untrusted sender');\n        return handler(event, payload);", '        return handler(event, payload);'),
      probe: async (mod) => { const rt = startWith(mod, {}); const h = rt.bus.handlers.get('xj-pi-v1:invoke'); const r = await h({ sender: { id: 999 } }, { method: 'diagnose', args: ['xj_task_041_m4'] }); rt.runtime.stop(); return { code: r && r.code || null, ok: r && r.ok === true }; },
    },
    {
      id: 'M5-membership-fallback',
      mutant: mutate('pi-brokers-v1.js', "if (!proj || !P.PERMISSION_MATRIX['read.client.summary'][proj.tier]) return P.fail('XJ_PI_MEMBERSHIP_UNKNOWN');", "if (!proj) proj = { tier: 'pro' };"),
      probe: (mod) => { const rt = startWith(mod, { membership: null }); const s = rt.runtime.bridge.api.startTask({ taskId: 'xj_task_041_m5', mode: 'observe', projection }); const r = rt.runtime.bridge.api.runToolStep('xj_task_041_m5', { tool: 'read.task.cards', args: {} }); rt.runtime.stop(); return { start: s.ok === true, code: r.code || null, ok: r.ok === true }; },
    },
    {
      id: 'M6-unknown-ipc-route',
      mutant: mutate('bridge/pi-bridge-main-v1.js', "if (!IPC_METHODS.includes(method)) return P.fail('XJ_PI_UNKNOWN_EVENT', 'unknown bridge method: ' + String(method).slice(0, 40));", "if (!IPC_METHODS.includes(method)) return api.diagnose.apply(null, payload.args || []);"),
      probe: async (mod) => { const rt = startWith(mod, {}); const h = rt.bus.handlers.get('xj-pi-v1:invoke'); const r = await h(trusted, { method: 'fs.read', args: [] }); rt.runtime.stop(); return { code: r && r.code || null, ok: r && r.ok === true }; },
    },
    {
      id: 'M7-bad-replay-fail-open',
      mutant: mutate('bridge/pi-production-runtime-v1.js', 'if (!replay || replay.ok !== true) {', 'if (false) {'),
      probe: (mod) => { const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj510-041-m7-log-')); fs.writeFileSync(path.join(dir, 'pi-events-v1.jsonl'), '{broken\n', 'utf8'); const rt = startWith(mod, { userDataDir: dir }); const r = rt.runtime.bridge.api.startTask({ taskId: 'xj_task_041_m7', mode: 'observe', projection }); rt.runtime.stop(); return { code: r.code || null, ok: r.ok === true }; },
    },
    {
      id: 'M8-empty-source-content-hash',
      mutant: mutate('bridge/pi-production-runtime-v1.js', "if (typeof ref.sourceContentHash !== 'string' || !ref.sourceContentHash.trim() || ref.sourceContentHash.length > 256) return null;", "if (typeof ref.sourceContentHash !== 'string' || ref.sourceContentHash.length > 256) return null;"),
      probe: (mod) => { const rt = startWith(mod, { message: { projection: { ...projection, sourceRefs: [{ ...sourceRef, sourceContentHash: '' }] }, reads: {} } }); const r = rt.runtime.bridge.api.startTask({ taskId: 'xj_task_041_m8', mode: 'observe', projection: { ...projection, sourceRefs: [{ ...sourceRef, sourceContentHash: '' }] } }); rt.runtime.stop(); return { code: r.code || null, ok: r.ok === true }; },
    },
  ];
}

const results = [];
(async () => {
  for (const item of probes()) results.push(await runCase(item.id, item.mutant, item.probe));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ schema: 'pi-production-041-mutation-v1', taskId: 'XJ-5.1.0-pi-supervision-broker-production-wiring-041', count: results.length, killed: results.filter((x) => x.killed).length, results }, null, 2), 'utf8');
  const survived = results.filter((x) => !x.killed);
  console.log('MUTATION ' + results.filter((x) => x.killed).length + '/' + results.length + ' KILLED');
  if (survived.length) { console.error('SURVIVED ' + survived.map((x) => x.id).join(',')); process.exitCode = 1; }
})().catch((error) => { console.error('FATAL', error.stack || error); process.exitCode = 1; });
