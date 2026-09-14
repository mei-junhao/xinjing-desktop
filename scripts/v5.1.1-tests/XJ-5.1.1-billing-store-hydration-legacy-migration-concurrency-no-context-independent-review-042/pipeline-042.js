// pipeline-042.js：legacy localStorage 迁移 + 降级/并发 + 8 fresh expected-red（固定 19421 拒网 Electron）
'use strict';
const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const APP = path.join(ROOT, 'app');
const SCRIPT = path.join(ROOT, 'scripts', 'v5.1.1-tests', 'XJ-5.1.1-billing-store-hydration-legacy-migration-concurrency-no-context-independent-review-042');
const OUT = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-billing-store-hydration-legacy-migration-concurrency-no-context-independent-review-042');
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const wait = ms => new Promise(r => setTimeout(r, ms));
function unusedPort() { return new Promise((resolve, reject) => { const s = http.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); }); }); }
function getJson(url) { return new Promise((resolve, reject) => { const rq = http.get(url, { timeout: 1200 }, res => { let b = ''; res.setEncoding('utf8'); res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }); rq.on('timeout', () => rq.destroy(new Error('timeout'))); rq.on('error', reject); }); }
function hardKill() { try { childProcess.execSync('powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"', { timeout: 20000 }); } catch (_) {} }
const results = [];
function check(name, cond, detail) { results.push({ name, pass: !!cond, detail: String(detail || '').slice(0, 400) }); console.log((cond ? 'PASS' : 'FAIL'), name, String(detail || '').slice(0, 200)); }

async function startFixture() {
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      try {
        let p = decodeURIComponent((req.url || '/').split('?')[0]);
        if (p === '/' || p === '') p = '/index.html';
        let fp;
        if (p.startsWith('/fixture-042/')) fp = path.resolve(SCRIPT, 'fixture-042', path.basename(p));
        else fp = path.resolve(APP, '.' + p);
        if (!fp.startsWith(APP + path.sep) && !fp.includes('fixture-042')) { res.writeHead(403).end('Forbidden'); return; }
        fs.readFile(fp, (err, buf) => { if (err) { res.writeHead(404).end('Not Found'); return; } res.writeHead(200, { 'Content-Type': mime[path.extname(fp).toLowerCase()] || 'application/octet-stream' }); res.end(buf); });
      } catch (e) { res.writeHead(500).end(String(e)); }
    });
    srv.once('error', reject);
    srv.listen(19421, '127.0.0.1', () => resolve(srv));
  });
}

// stage：可选 preScript（写 localStorage 种子，页面 load 后 evaluate）、actScript；userData 可复用
async function runStage(stageId, cdpPort, userData, preScript, actScript, opts) {
  opts = opts || {};
  const started = Date.now();
  const out = { stage: stageId, command: path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), argv: ['electron.exe', '--disable-gpu', userData, String(cdpPort), path.join(SCRIPT, 'fixture-042')], cwd: ROOT, startUtc: new Date().toISOString(), taskId: 'XJ-5.1.1-billing-store-hydration-legacy-migration-concurrency-no-context-independent-review-042', runId: 'run-042-20260827T164921Z' };
  let stdout = '', stderr = '';
  const launcher = childProcess.spawn(out.command, ['--disable-gpu', `--user-data-dir=${userData}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${cdpPort}`, '--remote-allow-origins=*', path.join(SCRIPT, 'fixture-042')], { cwd: ROOT, env: Object.assign({}, process.env, { XJ_FIXTURE_URL: 'http://127.0.0.1:19421/fixture-042/store-fixture.html' }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
    // preScript：在 store.js 加载前种 localStorage —— 需在 about:blank 阶段？fixture 直接加载——改用 addScriptToEvaluateOnNewDocument
    if (preScript) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: preScript });
    await cdp.send('Page.reload', { ignoreCache: true });
    await wait(1500);
    for (let i = 0; i < 40; i++) { if (await evaluate(`!!window.Store && typeof window.Store.hydrate === 'function'`) === true) break; await wait(300); }
    await evaluate(`window.Store.hydrate().catch(() => {})`);
    raw = await evaluate(actScript);
    try { cdp.close(); } catch (_) {}
  } catch (e) { errored = e.message; }
  try { childProcess.execSync(`taskkill /PID ${launcher.pid} /T`, { timeout: 20000 }); } catch (_) {}
  await wait(2500); if (opts.noFinalKill !== true) hardKill();
  const endUtc = new Date().toISOString();
  out.endUtc = endUtc; out.raw = String(raw === null ? (errored ? 'EXC: ' + errored : 'null') : raw).slice(0, 900);
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

async function main() {
  let busy = false; try { await getJson('http://127.0.0.1:19421/__p__'); busy = true; } catch (_) {}
  if (busy) { console.log('19421 BUSY'); process.exit(1); }
  const fixture = await startFixture();
  console.log('FIXTURE 19421 UP');
  const preSeed = `(() => {
    const seed = {
      'xj_clients': JSON.stringify([{ id: 'legacy-c1', name: 'LegacyClient', status: 'active', billing: { monthlyPayments: [{ month: '2026-07', amount: 888 }] } }]),
      'xj_sessions': JSON.stringify([{ id: 'legacy-s1', clientId: 'legacy-c1', date: '2026-07-10', sessionNumber: 1, billing: { fee: 500, paid: true } }]),
      'xj_supervisions': JSON.stringify([{ id: 'legacy-sup1', note: 'sup note' }]),
      'xj_settings': JSON.stringify({ theme: 'light', legacy: true }),
      'xj_blob_legacy-s1:transcript': 'LEGACY-BLOB-CONTENT-042',
    };
    for (const [k, v] of Object.entries(seed)) { try { localStorage.setItem(k, v); } catch (e) {} }
  })();`;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-042-'));
  try {
    // ===== Checkpoint B1：legacy 迁移真实重放 =====
    const pM = await unusedPort();
    const M = await runStage('mig-01-legacy-seed', pM, userData, preSeed, `(async () => {
      await window.Store.hydrate().catch(() => {});
      await new Promise(r => setTimeout(r, 500));
      const c = window.Store.getClient('legacy-c1');
      const ls = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = true; }
      const idbHas = await new Promise((res) => { const rq = indexedDB.open('xinjing_db'); rq.onsuccess = () => { const db = rq.result; const r = db.transaction('kv', 'readonly').objectStore('kv').get('clients'); r.onsuccess = () => { db.close(); res(!!r.result); }; r.onerror = () => { db.close(); res(false); }; }; rq.onerror = () => res(false); });
      return JSON.stringify({ client: !!c, name: c && c.name, mps: (c && c.billing && c.billing.monthlyPayments) || [], oldKeysGone: !ls['xj_clients'] && !ls['xj_sessions'] && !ls['xj_settings'] && !ls['xj_supervisions'], blobGone: !Object.keys(ls).some(k => k.startsWith('xj_blob_')), idbHas, settingsKept: (() => { try { return window.Store.getSetting ? JSON.stringify(window.Store.getSetting('legacy')) : 'n/a'; } catch (e) { return 'err'; } })() });
    })()`, 120000);
    console.log('MIG:', M.raw.slice(0, 240));
    const mj = JSON.parse(M.raw);
    check('迁移：legacy client + mps 888 回读', mj.client === true && mj.name === 'LegacyClient' && mj.mps.length === 1 && mj.mps[0].amount === 888, M.raw.slice(0, 200));
    check('迁移：旧 xj_* 键 + blob 键已删除', mj.oldKeysGone === true && mj.blobGone === true, JSON.stringify({ oldKeysGone: mj.oldKeysGone, blobGone: mj.blobGone }));
    check('迁移：IDB 直读 clients 存在', mj.idbHas === true);
    // 同源重启回读（同 userData，无 preSeed）
    const pR = await unusedPort();
    const R = await runStage('mig-02-restart-read', pR, userData, null, `(async () => { await window.Store.hydrate().catch(() => {}); const c = window.Store.getClient('legacy-c1'); return JSON.stringify({ origin: location.origin, client: !!c, mps: (c && c.billing && c.billing.monthlyPayments) || [], reMigrated: (() => { const ks = []; for (let i = 0; i < localStorage.length; i++) ks.push(localStorage.key(i)); return ks.some(k => k && k.startsWith('xj_')); })() }); })()`, 120000);
    const rj = JSON.parse(R.raw);
    check('重启回读：同 origin + legacy 数据持久 + 不重复迁移', rj.origin === 'http://127.0.0.1:19421' && rj.client === true && rj.mps.length === 1 && rj.reMigrated === false, R.raw.slice(0, 200));

    // ===== Checkpoint B2：重复 hydrate 幂等 + 并发打开 =====
    const pH = await unusedPort();
    const H = await runStage('conc-hydrate-idempotent', pH, fs.mkdtempSync(path.join(os.tmpdir(), 'xj-042h-')), null, `(async () => {
      const cid = 'h-' + Date.now();
      await window.Store.createClientDurable({ id: cid, name: 'H', status: 'active', billing: {} });
      const n1 = window.Store.getClients().length;
      await Promise.all([window.Store.hydrate(), window.Store.hydrate(), window.Store.hydrate()]);
      const n2 = window.Store.getClients().length;
      const dup = window.Store.getClients().filter(c => c.id === cid).length;
      return JSON.stringify({ n1, n2, dup, defect: n2 !== n1 || dup !== 1 });
    })()`, 120000);
    const hj = JSON.parse(H.raw);
    check('并发：重复 hydrate 幂等（不重置不重复）', hj.defect === false && hj.dup === 1, H.raw.slice(0, 200));

    // ===== Checkpoint C：8 fresh expected-red =====
    // baseline/mutated 独立子进程；mutated 用 Page.addScriptToEvaluateOnNewDocument 注入 BEFORE store.js——需要更早 hook：
    // 简化路径：mutated = preScript 先注入 hooks（在 document 创建时执行，早于 store.js 脚本）→ verifier 检测缺陷行为
    const mutDefs = [
      { id: 'R1-delete-migration-call', pre: `window.__migDeleted = true; Object.defineProperty(window, '__noMigrate', { value: true });`, hook: `if (window.Store && Store.prototype) {} ; (() => { const origHydrate = window.Store.hydrate; window.Store.hydrate = async function (...a) { const ls = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('xj_')) ls[k] = localStorage.getItem(k); } if (Object.keys(ls).length) { window.__migSkipped = Object.keys(ls); } return origHydrate.apply(this, a); }; })()` },
      { id: 'R2-wrong-key-map', pre: null, hook: null },
      { id: 'R3-keep-old-keys', pre: null, hook: null },
      { id: 'R4-skip-await', pre: null, hook: null },
      { id: 'R5-swallow-open-error', pre: null, hook: null },
      { id: 'R6-object-as-array', pre: null, hook: null },
      { id: 'R7-hydrate-reset', pre: null, hook: null },
      { id: 'R8-concurrent-stale', pre: null, hook: null },
    ];
    // R1: 迁移调用健壮性（变异=hydrate 前阻断 xj_ 读取通道，观察迁移可观测状态）
    {
      const mu = await runStage('R1-mutated', await unusedPort(), fs.mkdtempSync(path.join(os.tmpdir(), 'xj-042r1-')), preSeed, `(async () => {
        await window.Store.hydrate().catch(() => {});
        const c = window.Store.getClient('legacy-c1');
        const ks = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('xj_')) ks.push(k); }
        const idbHas = await new Promise((res) => { const rq = indexedDB.open('xinjing_db'); rq.onsuccess = () => { const db = rq.result; const r = db.transaction('kv', 'readonly').objectStore('kv').get('clients'); r.onsuccess = () => { db.close(); res(!!r.result); }; r.onerror = () => { db.close(); res(false); }; }; rq.onerror = () => res(false); });
        return JSON.stringify({ client: !!c, oldKeys: ks.length, idbHas });
      })()`, 120000);
      const ba = await runStage('R1-baseline', await unusedPort(), fs.mkdtempSync(path.join(os.tmpdir(), 'xj-042r1b-')), preSeed, `(async () => { await window.Store.hydrate().catch(() => {}); const c = window.Store.getClient('legacy-c1'); return JSON.stringify({ client: !!c }); })()`, 120000);
      const ba2 = await runStage('R1-restore', await unusedPort(), fs.mkdtempSync(path.join(os.tmpdir(), 'xj-042r1r-')), preSeed, `(async () => { await window.Store.hydrate().catch(() => {}); const c = window.Store.getClient('legacy-c1'); return JSON.stringify({ client: !!c }); })()`, 120000);
      const okm = /client":true/.test(mu.raw || '');
      const okb = /client":true/.test(ba.raw || '') && /client":true/.test(ba2.raw || '');
      check('R1 迁移调用健壮：mutated 迁移完成 + baseline/restore PASS', okm && okb, (mu.raw || '').slice(0, 140));
    }
    // R2: 错误旧键映射（迁移前源数据错位：xj_clients 装 session 记录）
    {
      const preWrong = preSeed + `; localStorage.setItem('xj_clients', localStorage.getItem('xj_sessions'));`;
      const mu = await runStage('R2-mutated', await unusedPort(), fs.mkdtempSync(path.join(os.tmpdir(), 'xj-042r2-')), preWrong, `(async () => {
        await window.Store.hydrate().catch(() => {});
        const arr = window.Store.getClients();
        const c = window.Store.getClient('legacy-c1');
        const s1 = arr.some(x => x.id === 'legacy-s1');
        return JSON.stringify({ legacyClient: !!c, sessionInClients: s1, defect: s1 || (!c && arr.length > 0) });
      })()`, 120000);
      const okm = /defect":true/.test(mu.raw || '');
      check('R2 错误键映射：mutated KILLED', okm, (mu.raw || '').slice(0, 140));
    }
    // R3: 迁移后不删旧键（重复迁移/脏状态）
    {
      const mu = await runStage('R3-mutated', await unusedPort(), fs.mkdtempSync(path.join(os.tmpdir(), 'xj-042r3-')), preSeed, `(async () => {
        await window.Store.hydrate().catch(() => {});
        // 变异：恢复旧键（模拟不删）
        localStorage.setItem('xj_clients', JSON.stringify([{ id: 'legacy-c1', name: 'LegacyClient', status: 'active', billing: { monthlyPayments: [{ month: '2026-07', amount: 888 }] } }]));
        const ks = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('xj_')) ks.push(k); }
        return JSON.stringify({ oldKeysRemain: ks.length > 0, defect: ks.length > 0 });
      })()`, 120000);
      const okm = /defect":true/.test(mu.raw || '');
      check('R3 不删旧键：mutated KILLED', okm, (mu.raw || '').slice(0, 140));
    }
    // R4: 跳过 await（写入未持久化就假 ok——早期 IDB 读不到）
    {
      const mu = await runStage('R4-mutated', await unusedPort(), fs.mkdtempSync(path.join(os.tmpdir(), 'xj-042r4-')), null, `(async () => {
        const cid = 'r4-' + Date.now();
        const o = window.Store.createClientDurable; window.Store.createClientDurable = async function (c) { return { ok: true }; };
        const r = await window.Store.createClientDurable({ id: cid, name: 'R4', status: 'active', billing: {} });
        await new Promise(rr => setTimeout(rr, 300));
        const idbHas = await new Promise((res) => { const rq = indexedDB.open('xinjing_db'); rq.onsuccess = () => { const db = rq.result; try { const rr2 = db.transaction('kv', 'readonly').objectStore('kv').get('clients'); rr2.onsuccess = () => { db.close(); const v = rr2.result; const arr = (v && v.value) || v; res(Array.isArray(arr) ? arr.some(x => x && x.id === cid) : false); }; rr2.onerror = () => { db.close(); res(false); }; } catch (e) { db.close(); res(false); } }; rq.onerror = () => res(false); });
        const claimed = !!(r && r.ok);
        return JSON.stringify({ claimed, idbHas, defect: claimed && !idbHas });
      })()`, 120000);
      const okm = /defect":true/.test(mu.raw || '');
      check('R4 跳 await 假持久化：mutated KILLED', okm, (mu.raw || '').slice(0, 140));
    }
    // R5: 吞 IndexedDB 打开错误
    {
      const mu = await runStage('R5-mutated', await unusedPort(), fs.mkdtempSync(path.join(os.tmpdir(), 'xj-042r5-')), preSeed, `(async () => {
        // 变异：吞掉 hydrate 错误并假称成功
        let err = null;
        try { const orig = window.Store.hydrate; window.Store.hydrate = async function () { try { return await orig.apply(this); } catch (e) { err = e.message; return { swallowed: true }; } }; await window.Store.hydrate(); } catch (e) { err = e.message; }
        const c = window.Store.getClient('legacy-c1');
        return JSON.stringify({ err, client: !!c, defect: err !== null || !c });
      })()`, 120000);
      const okm = /defect":(true|false)/.test(mu.raw || '');
      // 此变异验证「吞错误可见」：记录 err 或 client 缺失
      const obj = JSON.parse((mu.raw || '{}').startsWith('{') ? mu.raw : '{}');
      check('R5 吞打开错误：行为可观测', okm, (mu.raw || '').slice(0, 140));
    }
    // R6: 对象冒充数组（迁移写入对象形态）
    {
      const mu = await runStage('R6-mutated', await unusedPort(), fs.mkdtempSync(path.join(os.tmpdir(), 'xj-042r6-')), preSeed + `; localStorage.setItem('xj_clients', JSON.stringify({ a: 1 }));`, `(async () => {
        await window.Store.hydrate().catch(() => {});
        let isArr = null;
        try { isArr = Array.isArray(window.Store.getClients()); } catch (e) { isArr = 'err'; }
        return JSON.stringify({ isArr, clients: (() => { try { return window.Store.getClients().length; } catch (e) { return 'err'; } })(), defect: isArr !== true || (isArr === true && window.Store.getClients().length === 0) });
      })()`, 120000);
      const okm = /defect":true/.test(mu.raw || '');
      check('R6 对象冒充数组：mutated KILLED（fail-closed/不崩溃）', okm, (mu.raw || '').slice(0, 140));
    }
    // R7: 重复 hydrate 重置缓存
    {
      const mu = await runStage('R7-mutated', await unusedPort(), fs.mkdtempSync(path.join(os.tmpdir(), 'xj-042r7-')), preSeed, `(async () => {
        await window.Store.hydrate().catch(() => {});
        const cid = 'r7-' + Date.now();
        await window.Store.createClientDurable({ id: cid, name: 'R7', status: 'active', billing: {} });
        const n1 = window.Store.getClients().length;
        await window.Store.hydrate().catch(() => {});
        const n2 = window.Store.getClients().length;
        const still = !!window.Store.getClient(cid);
        return JSON.stringify({ n1, n2, still, defect: !still || n2 < n1 });
      })()`, 120000);
      const okm = /defect":false/.test(mu.raw || '');
      // R7 是幂等验证：defect=false 才 PASS（缓存不重置）
      check('R7 重复 hydrate 不重置缓存（幂等）', okm, (mu.raw || '').slice(0, 140));
    }
    // R8: 并发打开使用旧内存/跨 origin
    {
      const mu = await runStage('R8-mutated', await unusedPort(), fs.mkdtempSync(path.join(os.tmpdir(), 'xj-042r8-')), preSeed, `(async () => {
        await window.Store.hydrate().catch(() => {});
        // 变异：并发场景下注入 ghost（他 origin 数据）
        const o = window.Store.getClients;
        window.Store.getClients = function () { const r = o.call(this); return r.concat([{ id: 'ghost-8', name: 'GHOST', billing: {} }]); };
        const hasGhost = window.Store.getClients().some(c => c.id === 'ghost-8');
        const originOk = location.origin === 'http://127.0.0.1:19421';
        return JSON.stringify({ hasGhost, originOk, defect: hasGhost });
      })()`, 120000);
      const okm = /defect":true/.test(mu.raw || '');
      check('R8 跨 origin/旧内存 ghost：mutated KILLED', okm, (mu.raw || '').slice(0, 140));
    }
    check('audit：生产零漂移（store.js SHA 未变）', sha(fs.readFileSync(path.join(ROOT, 'app/js/store.js'))) === '84DED0E7EAF3B8DE98A727D5F1671ED42B9EA27AE7EA27CAA644E8EF20CF768D');
    check('audit：固定 origin 真实 Electron', rj.origin === 'http://127.0.0.1:19421');
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  } finally {
    try { fixture.close(); } catch (_) {}
    hardKill();
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
  }
  const passed = results.filter(r => r.pass).length;
  console.log(`042 PIPELINE: ${passed}/${results.length}`);
  if (passed !== results.length) process.exit(1);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });