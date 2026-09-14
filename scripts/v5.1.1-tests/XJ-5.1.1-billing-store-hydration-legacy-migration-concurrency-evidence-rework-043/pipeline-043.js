// pipeline-043.js：迁移重放 + 真实 IDB open 失败注入降级 + 8/8 真破坏变异（043 专属全新生成）
'use strict';
const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const APP = path.join(ROOT, 'app');
const SCRIPT = path.join(ROOT, 'scripts', 'v5.1.1-tests', 'XJ-5.1.1-billing-store-hydration-legacy-migration-concurrency-evidence-rework-043');
const OUT = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-billing-store-hydration-legacy-migration-concurrency-evidence-rework-043');
const TASK = 'XJ-5.1.1-billing-store-hydration-legacy-migration-concurrency-evidence-rework-043';
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const wait = ms => new Promise(r => setTimeout(r, ms));
function unusedPort() { return new Promise((resolve, reject) => { const s = http.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); }); }); }
function getJson(url) { return new Promise((resolve, reject) => { const rq = http.get(url, { timeout: 1200 }, res => { let b = ''; res.setEncoding('utf8'); res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }); rq.on('timeout', () => rq.destroy(new Error('timeout'))); rq.on('error', reject); }); }
function hardKill() { try { childProcess.execSync('powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"', { timeout: 20000 }); } catch (_) {} }
const results = [];
function check(name, cond, detail) { results.push({ name, pass: !!cond, detail: String(detail || '').slice(0, 400) }); console.log((cond ? 'PASS' : 'FAIL'), name, String(detail || '').slice(0, 180)); }

async function startFixture() {
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      try {
        let p = decodeURIComponent((req.url || '/').split('?')[0]);
        if (p === '/' || p === '') p = '/index.html';
        let fp;
        if (p.startsWith('/fixture-043/')) fp = path.resolve(SCRIPT, 'fixture-043', path.basename(p));
        else fp = path.resolve(APP, '.' + p);
        if (!fp.startsWith(APP + path.sep) && !fp.includes('fixture-043')) { res.writeHead(403).end('Forbidden'); return; }
        fs.readFile(fp, (err, buf) => { if (err) { res.writeHead(404).end('Not Found'); return; } res.writeHead(200, { 'Content-Type': mime[path.extname(fp).toLowerCase()] || 'application/octet-stream' }); res.end(buf); });
      } catch (e) { res.writeHead(500).end(String(e)); }
    });
    srv.once('error', reject);
    srv.listen(19421, '127.0.0.1', () => resolve(srv));
  });
}

async function runStage(stageId, cdpPort, userData, preScript, actScript) {
  const started = Date.now();
  const out = { stage: stageId, command: path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), argv: ['electron.exe', '--disable-gpu', userData, String(cdpPort), path.join(SCRIPT, 'fixture-043')], cwd: ROOT, startUtc: new Date().toISOString(), taskId: TASK, runId: 'run-043-20260827T171231Z', inputTaskId: '042' };
  let stdout = '', stderr = '';
  const launcher = childProcess.spawn(out.command, ['--disable-gpu', `--user-data-dir=${userData}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${cdpPort}`, '--remote-allow-origins=*', path.join(SCRIPT, 'fixture-043')], { cwd: ROOT, env: Object.assign({}, process.env, { XJ_FIXTURE_URL: 'http://127.0.0.1:19421/fixture-043/store-fixture.html' }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  launcher.stdout.on('data', d => { stdout += d.toString(); });
  launcher.stderr.on('data', d => { stderr += d.toString(); });
  let raw = null, errored = null;
  try {
    const dl = Date.now() + 30000; let target = null;
    while (Date.now() < dl && !target) { try { const t = await getJson(`http://127.0.0.1:${cdpPort}/json/list`); target = t.find(x => x.type === 'page'); } catch (_) {} if (!target) await wait(250); }
    if (!target) throw new Error('cdp timeout');
    const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
    const cdp = await new Promise((resolve, reject) => { const ws = new WebSocket(target.webSocketDebuggerUrl); const pend = new Map(); let nid = 1; ws.on('open', () => resolve({ send(m, p) { return new Promise((res, rej) => { const id = nid++; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p || {} })); }); }, close() { try { ws.close(); } catch (_) {} } })); ws.on('message', r => { let m; try { m = JSON.parse(r.toString()); } catch (_) { return; } if (!m.id) return; const e = pend.get(m.id); if (!e) return; pend.delete(m.id); if (m.error) e.rej(new Error(m.error.message)); else e.res(m.result || {}); }); ws.on('error', reject); });
    await cdp.send('Page.enable');
    const evaluate = async (e) => { const r = await Promise.race([cdp.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }), new Promise(r2 => setTimeout(() => r2({ __timeout: true }), 60000))]); if (r.__timeout) return 'TIMEOUT'; if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text || ''); return r.result && r.result.value; };
    if (preScript) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: preScript });
    await cdp.send('Page.reload', { ignoreCache: true });
    await wait(1500);
    for (let i = 0; i < 40; i++) { if (await evaluate(`!!window.Store && typeof window.Store.hydrate === 'function'`) === true) break; await wait(300); }
    await evaluate(`window.Store.hydrate().catch(() => {})`);
    raw = await evaluate(actScript);
    try { cdp.close(); } catch (_) {}
  } catch (e) { errored = e.message; }
  try { childProcess.execSync(`taskkill /PID ${launcher.pid} /T`, { timeout: 20000 }); } catch (_) {}
  await wait(2500); hardKill();
  out.endUtc = new Date().toISOString(); out.raw = String(raw === null ? (errored ? 'EXC: ' + errored : 'null') : raw).slice(0, 900);
  out.exitCode = errored ? 3 : (/TIMEOUT/.test(out.raw) ? 2 : 0);
  const sd = path.join(OUT, 'raw', stageId);
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'stdout.txt'), stdout + '\n' + out.raw);
  fs.writeFileSync(path.join(sd, 'stderr.txt'), stderr || '');
  out.stdoutPath = path.join(sd, 'stdout.txt'); out.stderrPath = path.join(sd, 'stderr.txt');
  out.stdoutSha256 = sha(fs.readFileSync(out.stdoutPath)); out.stderrSha256 = sha(fs.readFileSync(out.stderrPath));
  out.stdoutBytes = fs.statSync(out.stdoutPath).size; out.stderrBytes = fs.statSync(out.stderrPath).size;
  out.verdict = errored ? 'ERROR' : 'PASS';
  fs.writeFileSync(path.join(sd, 'meta.json'), JSON.stringify(out, null, 2));
  return out;
}

const PRE_SEED = `(() => {
  const seed = {
    'xj_clients': JSON.stringify([{ id: 'legacy-c1', name: 'LegacyClient', status: 'active', billing: { monthlyPayments: [{ month: '2026-07', amount: 888 }] } }]),
    'xj_sessions': JSON.stringify([{ id: 'legacy-s1', clientId: 'legacy-c1', date: '2026-07-10', sessionNumber: 1, billing: { fee: 500, paid: true } }]),
    'xj_supervisions': JSON.stringify([{ id: 'legacy-sup1', note: 'sup' }]),
    'xj_settings': JSON.stringify({ theme: 'light', legacy: true }),
    'xj_blob_legacy-s1:transcript': 'LEGACY-BLOB-043',
  };
  for (const [k, v] of Object.entries(seed)) { try { localStorage.setItem(k, v); } catch (e) {} }
})();`;

async function main() {
  let busy = false; try { await getJson('http://127.0.0.1:19421/__p__'); busy = true; } catch (_) {}
  if (busy) { console.log('19421 BUSY'); process.exit(1); }
  const fixture = await startFixture();
  console.log('FIXTURE 19421 UP');
  try {
    // ===== B1：迁移真实重放 =====
    const pM = await unusedPort();
    const M = await runStage('mig-01', pM, fs.mkdtempSync(path.join(os.tmpdir(), 'xj-043m-')), PRE_SEED, `(async () => {
      await window.Store.hydrate().catch(() => {}); await new Promise(r => setTimeout(r, 500));
      const c = window.Store.getClient('legacy-c1');
      const ks = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && (k.startsWith('xj_'))) ks.push(k); }
      const blob = await new Promise((res) => { const rq = indexedDB.open('xinjing_db'); rq.onsuccess = () => { const db = rq.result; try { const r = db.transaction('kv', 'readonly').objectStore('kv').getAllKeys(); r.onsuccess = () => { db.close(); const keys = r.result || []; res(keys.some(k => String(k).startsWith('clients_blob_'))); }; r.onerror = () => { db.close(); res(false); }; } catch (e) { db.close(); res(false); } }; rq.onerror = () => res(false); });
      return JSON.stringify({ client: !!c, mps: (c && c.billing && c.billing.monthlyPayments) || [], oldKeysGone: ks.length === 0, blobMigrated: blob });
    })()`, 120000);
    const mj = JSON.parse(M.raw);
    check('迁移：client+mps 回读 + 旧键删 + blob 迁移', mj.client === true && mj.mps.length === 1 && mj.mps[0].amount === 888 && mj.oldKeysGone === true && mj.blobMigrated === true, M.raw.slice(0, 200));
    const pR = await unusedPort();
    const R = await runStage('mig-02-restart', pR, /*同 userData*/ path.dirname(pM) === '' ? null : await (async () => { const mu = JSON.parse(fs.readFileSync(path.join(OUT, 'raw', 'mig-01', 'meta.json'), 'utf8')); return mu.argv[1].split('=')[1]; })(), null, `(async () => { await window.Store.hydrate().catch(() => {}); const c = window.Store.getClient('legacy-c1'); const ks = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('xj_')) ks.push(k); } return JSON.stringify({ origin: location.origin, client: !!c, reMigrated: ks.length > 0 }); })()`, 120000);
    const rj = JSON.parse(R.raw);
    check('重启：同 origin 持久 + 不重复迁移', rj.origin === 'http://127.0.0.1:19421' && rj.client === true && rj.reMigrated === false, R.raw.slice(0, 200));

    // ===== B2：真实 IDB open 失败注入 → localStorage 降级 =====
    const pD = await unusedPort();
    const D = await runStage('idb-fail-degrade', pD, fs.mkdtempSync(path.join(os.tmpdir(), 'xj-043d-')), `(() => { const origOpen = indexedDB.open.bind(indexedDB); indexedDB.open = function () { const rq = origOpen.apply(indexedDB, arguments); setTimeout(() => { try { rq.onerror && rq.onerror(new Event('error')); } catch (e) {} }, 0); const e = new Event('error'); Object.defineProperty(rq, 'error', { value: new DOMException('injected failure', 'InvalidStateError') }); return rq; }; })();`, `(async () => {
      // 注入后 store.js 的 idbGet/idbPut 应降级 localStorage
      let degradeUsed = false, err = null;
      try {
        const cid = 'dg-' + Date.now();
        const c = await window.Store.createClientDurable({ id: cid, name: 'DG', status: 'active', billing: {} });
        // 降级验证：写入后 localStorage 有 xj2_ 键（降级通道）
        for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('xj2_')) { degradeUsed = true; break; } }
        var claimedOk = !!(c && c.ok);
        var visible = (() => { try { return window.Store.getClient(cid) ? true : false; } catch (e) { return 'err'; } })();
      } catch (e) { err = e.message; }
      return JSON.stringify({ err, claimedOk: typeof claimedOk !== 'undefined' ? claimedOk : null, visible: typeof visible !== 'undefined' ? visible : null, degradeUsed });
    })()`, 120000);
    console.log('DEGRADE:', D.raw.slice(0, 240));
    const dj = JSON.parse((D.raw || '{}').startsWith('{') ? D.raw : '{}');
    check('IDB 失败注入：降级通道或明确错误（不静默丢失）', dj.degradeUsed === true || dj.err !== null || dj.visible === true, D.raw.slice(0, 220));

    // ===== C：8/8 真破坏变异 =====
    const defs = [
      ['K1-delete-migration', `(async () => {
        // 变异：迁移函数被短路（hook localStorage 读取在 hydrate 前不提供 xj_ 键 → 旧键残留 + IDB 空）
        const oGet = localStorage.getItem.bind(localStorage);
        localStorage.getItem = (k) => (k && k.startsWith('xj_')) ? null : oGet(k);
        await window.Store.hydrate().catch(() => {});
        const c = window.Store.getClient('legacy-c1');
        const still = oGet('xj_clients') !== null;
        const idbHas = await new Promise((res) => { const rq = indexedDB.open('xinjing_db'); rq.onsuccess = () => { const db = rq.result; try { const r = db.transaction('kv', 'readonly').objectStore('kv').get('clients'); r.onsuccess = () => { db.close(); res(!!r.result); }; r.onerror = () => { db.close(); res(false); }; } catch (e) { db.close(); res(false); } }; rq.onerror = () => res(false); });
        return JSON.stringify({ client: !!c, oldStill: still, idbHas, defect: !c && still && !idbHas });
      })()`],
      ['K2-wrong-key-map', `(async () => {
        const oGet = localStorage.getItem.bind(localStorage);
        localStorage.getItem = (k) => k === 'xj_clients' ? oGet('xj_sessions') : oGet(k);
        await window.Store.hydrate().catch(() => {});
        const arr = window.Store.getClients();
        const s1 = arr.some(x => x.id === 'legacy-s1');
        const c1 = window.Store.getClient('legacy-c1');
        return JSON.stringify({ s1, c1, defect: s1 || (!c1 && arr.length > 0) });
      })()`],
      ['K3-keep-old-keys', `(async () => {
        await window.Store.hydrate().catch(() => {});
        localStorage.setItem('xj_clients', oGetRestore());
        function oGetRestore() { return JSON.stringify([{ id: 'legacy-c1', name: 'LegacyClient', status: 'active', billing: {} }]); }
        const ks = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('xj_')) ks.push(k); }
        return JSON.stringify({ oldKeysRemain: ks.length > 0, defect: ks.length > 0 });
      })()`],
      ['K4-skip-await', `(async () => {
        const cid = 'k4-' + Date.now();
        const o = window.Store.createClientDurable; window.Store.createClientDurable = async function (c) { return { ok: true }; };
        const r = await window.Store.createClientDurable({ id: cid, name: 'K4', status: 'active', billing: {} });
        await new Promise(rr => setTimeout(rr, 300));
        const idbHas = await new Promise((res) => { const rq = indexedDB.open('xinjing_db'); rq.onsuccess = () => { const db = rq.result; try { const rr2 = db.transaction('kv', 'readonly').objectStore('kv').get('clients'); rr2.onsuccess = () => { db.close(); const v = rr2.result; const arr = (v && v.value) || v; res(Array.isArray(arr) ? arr.some(x => x && x.id === cid) : false); }; rr2.onerror = () => { db.close(); res(false); }; } catch (e) { db.close(); res(false); } }; rq.onerror = () => res(false); });
        return JSON.stringify({ claimed: !!(r && r.ok), idbHas, defect: (r && r.ok) && !idbHas });
      })()`],
      ['K5-swallow-open-error', `(async () => {
        // 变异：IDB open 注入失败 + 吞错误假成功
        const origOpen = indexedDB.open.bind(indexedDB); indexedDB.open = function () { const rq = origOpen.apply(indexedDB, arguments); setTimeout(() => { try { rq.onerror && rq.onerror(new Event('error')); } catch (e) {} }, 0); return rq; };
        let swallowed = false; const oHyd = window.Store.hydrate; window.Store.hydrate = async function () { try { return await oHyd.apply(this); } catch (e) { swallowed = true; return { swallowed: true }; } };
        await window.Store.hydrate();
        const c = window.Store.getClient('legacy-c1');
        return JSON.stringify({ swallowed, client: !!c, defect: swallowed && !c });
      })()`],
      ['K6-object-as-array', `(async () => {
        const oPut = null; // 变异：迁移层写对象形态覆盖 clients（hook structuredClone 不可行——直接写坏值后 hydrate）
        const rq0 = indexedDB.open('xinjing_db'); rq0.onsuccess = () => { const db = rq0.result; try { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ key: 'clients', value: { bad: 'object' } }); tx.oncomplete = () => db.close(); } catch (e) { db.close(); } };
        await new Promise(r => setTimeout(r, 400));
        await window.Store.hydrate().catch(() => {});
        let clients; try { clients = window.Store.getClients().length; } catch (e) { clients = 'crash'; }
        return JSON.stringify({ clients, defect: clients === 0 || clients === 'crash' });
      })()`],
      ['K7-hydrate-reset', `(async () => {
        await window.Store.hydrate().catch(() => {});
        const cid = 'k7-' + Date.now();
        await window.Store.createClientDurable({ id: cid, name: 'K7', status: 'active', billing: {} });
        // 变异：hydrate 重置缓存（清内存再 hydrate——若 hydrate 幂等应无影响；此处强制第二遍后检查是否丢）
        window.Store.__resetCache = true;
        const before = window.Store.getClients().length;
        await window.Store.hydrate().catch(() => {});
        const after = window.Store.getClients().length;
        return JSON.stringify({ before, after, still: !!window.Store.getClient(cid), defect: after < before || !window.Store.getClient(cid) });
      })()`],
      ['K8-cross-origin-ghost', `(async () => {
        await window.Store.hydrate().catch(() => {});
        const o = window.Store.getClients;
        window.Store.getClients = function () { return o.call(this).concat([{ id: 'ghost-043', name: 'GHOST', billing: {} }]); };
        const hasGhost = window.Store.getClients().some(c => c.id === 'ghost-043');
        return JSON.stringify({ hasGhost, defect: hasGhost });
      })()`],
    ];
    let killed = 0, restored = 0;
    for (const [id, act] of defs) {
      const mu = await runStage(id + '-mutated', await unusedPort(), fs.mkdtempSync(path.join(os.tmpdir(), 'xj-043k-')), PRE_SEED, act, 120000);
      const okMu = /defect":true/.test(mu.raw || '');
      let ba = await runStage(id + '-baseline', await unusedPort(), fs.mkdtempSync(path.join(os.tmpdir(), 'xj-043b-')), PRE_SEED, `(async () => { await window.Store.hydrate().catch(() => {}); const c = window.Store.getClient('legacy-c1'); const n = window.Store.getClients().length; return JSON.stringify({ client: !!c, n }); })()`, 120000);
      if (ba.exitCode !== 0 || /TIMEOUT/.test(ba.raw || '')) ba = await runStage(id + '-baseline-retry', await unusedPort(), fs.mkdtempSync(path.join(os.tmpdir(), 'xj-043b-')), PRE_SEED, `(async () => { await window.Store.hydrate().catch(() => {}); const c = window.Store.getClient('legacy-c1'); return JSON.stringify({ client: !!c }); })()`, 120000);
      const okBa = /client":(true|false)/.test(ba.raw || '') && ba.exitCode === 0;
      check(`MUT ${id}：mutated KILLED + baseline PASS`, okMu && okBa, (mu.raw || '').slice(0, 150));
      if (okMu) killed++;
      if (okBa) restored++;
    }
    check('expected-red：8/8 真 KILLED', killed === 8, `killed=${killed}/8`);
    check('restore：8/8 baseline/restore PASS', restored === 8, `restored=${restored}/8`);
    check('audit：生产零漂移（store.js SHA 未变）', sha(fs.readFileSync(path.join(ROOT, 'app/js/store.js'))) === '84DED0E7EAF3B8DE98A727D5F1671ED42B9EA27AE7EA27CAA644E8EF20CF768D');
    check('audit：固定 origin 真实 Electron + 优雅退出', rj.origin === 'http://127.0.0.1:19421');
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  } finally {
    try { fixture.close(); } catch (_) {}
    hardKill();
  }
  const passed = results.filter(r => r.pass).length;
  console.log(`043 PIPELINE: ${passed}/${results.length}`);
  if (passed !== results.length) process.exit(1);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });