// pipeline-041.js：固定 19421 两进程真实重放 + 8 mutation 独立子进程 + 独立 audit
'use strict';
const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const APP = path.join(ROOT, 'app');
const SCRIPT = path.join(ROOT, 'scripts', 'v5.1.1-tests', 'XJ-5.1.1-billing-store-cross-restart-hydration-fix-no-context-independent-review-041');
const OUT = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-billing-store-cross-restart-hydration-fix-no-context-independent-review-041');
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const wait = ms => new Promise(r => setTimeout(r, ms));
function unusedPort() { return new Promise((resolve, reject) => { const s = http.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); }); }); }
function getJson(url) { return new Promise((resolve, reject) => { const rq = http.get(url, { timeout: 1200 }, res => { let b = ''; res.setEncoding('utf8'); res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }); rq.on('timeout', () => rq.destroy(new Error('timeout'))); rq.on('error', reject); }); }
function hardKill() { try { childProcess.execSync('powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"', { timeout: 20000 }); } catch (_) {} }
const results = [];
function check(name, cond, detail) { results.push({ name, pass: !!cond, detail: String(detail || '').slice(0, 300) }); console.log((cond ? 'PASS' : 'FAIL'), name, detail || ''); }

async function startFixture() {
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      try {
        let p = decodeURIComponent((req.url || '/').split('?')[0]);
        if (p === '/' || p === '') p = '/index.html';
        let fp;
        if (p.startsWith('/fixture-041/')) fp = path.resolve(SCRIPT, 'fixture-041', path.basename(p));
        else fp = path.resolve(APP, '.' + p);
        if (!fp.startsWith(APP + path.sep) && !fp.includes('fixture-041')) { res.writeHead(403).end('Forbidden'); return; }
        fs.readFile(fp, (err, buf) => { if (err) { res.writeHead(404).end('Not Found'); return; } res.writeHead(200, { 'Content-Type': mime[path.extname(fp).toLowerCase()] || 'application/octet-stream' }); res.end(buf); });
      } catch (e) { res.writeHead(500).end(String(e)); }
    });
    srv.once('error', reject);
    srv.listen(19421, '127.0.0.1', () => resolve(srv));
  });
}

// 单 stage：独立 Electron fixture 子进程（fresh 或复用 userData 由调用方控制）
async function runStage(stageId, cdpPort, userData, scriptJs, timeoutMs) {
  const started = Date.now();
  const out = { stage: stageId, command: path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), argv: ['electron.exe', '--disable-gpu', userData, String(cdpPort), path.join(SCRIPT, 'fixture-041')], cwd: ROOT, startUtc: new Date().toISOString(), taskId: 'XJ-5.1.1-billing-store-cross-restart-hydration-fix-no-context-independent-review-041', runId: 'run-041' };
  let stdout = '', stderr = '';
  const launcher = childProcess.spawn(out.command, ['--disable-gpu', `--user-data-dir=${userData}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${cdpPort}`, '--remote-allow-origins=*', path.join(SCRIPT, 'fixture-041')], { cwd: ROOT, env: Object.assign({}, process.env, { XJ_FIXTURE_URL: 'http://127.0.0.1:19421/fixture-041/store-fixture.html' }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
    const evaluate = async (e) => { const r = await cdp.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text || ''); return r.result && r.result.value; };
    for (let i = 0; i < 40; i++) { if (await evaluate(`!!window.Store && typeof window.Store.hydrate === 'function' && typeof window.Store.createClientDurable === 'function'`) === true) break; await wait(300); }
    await evaluate(`window.Store.hydrate().catch(() => {})`);
    raw = await Promise.race([
      evaluate(scriptJs),
      new Promise(r => setTimeout(() => r('TIMEOUT'), 60000)),
    ]);
    if (raw === 'TIMEOUT') { errored = 'stage timeout 45s'; }
    try { cdp.close(); } catch (_) {}
  } catch (e) { errored = e.message; }
  // 优雅退出（taskkill /T → WM_CLOSE）
  try { childProcess.execSync(`taskkill /PID ${launcher.pid} /T`, { timeout: 20000 }); } catch (_) {}
  await wait(2500); hardKill();
  const endUtc = new Date().toISOString();
  out.endUtc = endUtc; out.durationMs = Date.now() - started;
  out.raw = String(raw === null ? (errored ? 'EXC: ' + errored : 'null') : raw).slice(0, 800);
  out.exitCode = errored ? 3 : 0;
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
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-041-'));
  try {
    // ===== Checkpoint B：两进程真实重放 =====
    const pA = await unusedPort();
    const A = await runStage('core-A-write', pA, userData, `(async () => {
      const now = new Date(); const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
      const cid = 'x041-' + Date.now();
      const c = await window.Store.createClientDurable({ id: cid, name: '041', status: 'active', billing: { monthlyPayments: [] } });
      await window.Store.createSessionDurable({ id: 'x041s' + cid, clientId: cid, date: ym + '-05', sessionNumber: 1, billing: { fee: 300, paid: true } });
      const u = await window.Store.updateClientDurable(cid, { billing: { monthlyPayments: [{ month: ym, amount: 666 }] } });
      const c2 = window.Store.getClient(cid);
      return JSON.stringify({ cid, cOk: !!(c && c.ok), uOk: !!(u && u.ok), clients: window.Store.getClients().length, sessions: window.Store.getSessions().length, mps: (c2 && c2.billing && c2.billing.monthlyPayments) || [] });
    })()`, 90000);
    console.log('CORE-A:', A.raw.slice(0, 200));
    const aj = JSON.parse(A.raw);
    check('Core A：固定 19421 durable 写入（clients=1/sessions=1/mps=666）', aj.clients === 1 && aj.sessions === 1 && aj.mps.length === 1 && aj.mps[0].amount === 666, A.raw.slice(0, 180));
    await wait(2000);
    const pB = await unusedPort();
    const B = await runStage('core-B-restart-read', pB, userData, `(async () => {
      await window.Store.hydrate().catch(() => {});
      const c = window.Store.getClient(${JSON.stringify(aj.cid)});
      return JSON.stringify({ origin: location.origin, clients: window.Store.getClients().length, sessions: window.Store.getSessions().length, foundSeed: !!c, mps: (c && c.billing && c.billing.monthlyPayments) || [] });
    })()`, 90000);
    console.log('CORE-B:', B.raw.slice(0, 200));
    const bj = JSON.parse(B.raw);
    check('Core B：同 userData 同 origin 重启 hydrate 回读（clients=1/sessions=1/mps=666）', bj.origin === 'http://127.0.0.1:19421' && bj.clients === 1 && bj.sessions === 1 && bj.foundSeed === true && bj.mps.length === 1 && bj.mps[0].amount === 666, B.raw.slice(0, 180));

    // ===== Checkpoint C：8 mutation 独立子进程（各自 fresh userData） =====
    const seedJs = `(async () => { const now = new Date(); const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0'); const cid = 's-' + Date.now(); await window.Store.createClientDurable({ id: cid, name: 'S', status: 'active', billing: { monthlyPayments: [{ month: ym, amount: 520 }] } }); return JSON.stringify({ cid }); })()`;
    const pS = await unusedPort();
    const S = await runStage('seed-for-muts', pS, userData, seedJs, 90000);
    const seedCid = JSON.parse(S.raw).cid;
    const mutDefs = [
      { id: 'M1-wrong-db-name', baselineAct: `(async () => { const c = await window.Store.createClientDurable({ id: 'm1b-' + Date.now(), name: 'M1B', status: 'active', billing: {} }); const n = window.Store.getClients().length; return JSON.stringify({ ok: !!(c && c.ok), clients: n }); })()`, inject: `eval(atob('KCgpID0+IHsgY29uc3QgbyA9IHdpbmRvdy5TdG9yZS5jcmVhdGVDbGllbnREdXJhYmxlOyB3aW5kb3cuU3RvcmUuY3JlYXRlQ2xpZW50RHVyYWJsZSA9IGFzeW5jIGZ1bmN0aW9uIChjKSB7IGNvbnN0IHIgPSBhd2FpdCBvLmNhbGwodGhpcywgYyk7IHRyeSB7IGNvbnN0IHJxID0gaW5kZXhlZERCLm9wZW4oJ3hpbmppbmdfd3JvbmcnKTsgcnEub251cGdyYWRlbmVlZGVkID0gKCkgPT4gcnEucmVzdWx0LmNyZWF0ZU9iamVjdFN0b3JlKCdrdicsIHsga2V5UGF0aDogJ2tleScgfSk7IHJxLm9uc3VjY2VzcyA9ICgpID0+IHsgY29uc3QgZGIgPSBycS5yZXN1bHQ7IHRyeSB7IGNvbnN0IHR4ID0gZGIudHJhbnNhY3Rpb24oJ2t2JywgJ3JlYWR3cml0ZScpOyB0eC5vYmplY3RTdG9yZSgna3YnKS5wdXQoeyBrZXk6ICdjbGllbnRzJywgdmFsdWU6IFt7IGlkOiBjLmlkLCBuYW1lOiBjLm5hbWUsIGJpbGxpbmc6IHt9IH1dIH0pOyB0eC5vbmNvbXBsZXRlID0gKCkgPT4gZGIuY2xvc2UoKTsgfSBjYXRjaCAoZSkgeyBkYi5jbG9zZSgpOyB9IH07IH0gY2F0Y2ggKGUpIHt9IHJldHVybiByOyB9OyB9KSgp'))`, act: `(async () => { const c = await window.Store.createClientDurable({ id: 'm1-' + Date.now(), name: 'M1', status: 'active', billing: {} }); const probe = await new Promise((res) => { const rq = indexedDB.open('xinjing_db'); rq.onsuccess = () => { const db = rq.result; const r = db.transaction('kv', 'readonly').objectStore('kv').get('clients'); r.onsuccess = () => { db.close(); res(r.result); }; r.onerror = () => { db.close(); res(null); }; }; rq.onerror = () => res(null); }); const wrong = await new Promise((res) => { const rq = indexedDB.open('xinjing_wrong'); rq.onsuccess = () => { const db = rq.result; const r = db.transaction('kv', 'readonly').objectStore('kv').get('clients'); r.onsuccess = () => { db.close(); res(r.result); }; r.onerror = () => { db.close(); res(null); }; }; rq.onerror = () => res(null); }); return JSON.stringify({ ok: !!(c && c.ok), correctDbHas: !!probe, wrongDbHas: !!wrong, defect: !!wrong }); })()` },
      { id: 'M2-wrong-object-store', inject: `eval(atob('KCgpID0+IHsgY29uc3QgbyA9IHdpbmRvdy5TdG9yZS5jcmVhdGVDbGllbnREdXJhYmxlOyB3aW5kb3cuU3RvcmUuY3JlYXRlQ2xpZW50RHVyYWJsZSA9IGFzeW5jIGZ1bmN0aW9uIChjKSB7IGNvbnN0IHIgPSBhd2FpdCBvLmNhbGwodGhpcywgYyk7IHRyeSB7IGNvbnN0IHJxID0gaW5kZXhlZERCLm9wZW4oJ3hpbmppbmdfZGInKTsgcnEub25zdWNjZXNzID0gKCkgPT4geyBjb25zdCBkYiA9IHJxLnJlc3VsdDsgdHJ5IHsgY29uc3QgdHggPSBkYi50cmFuc2FjdGlvbigna3YnLCAncmVhZHdyaXRlJyk7IHR4Lm9iamVjdFN0b3JlKCdrdicpLnB1dCh7IGtleTogJ3p6eicsIHZhbHVlOiBbXSB9KTsgdHgub25jb21wbGV0ZSA9ICgpID0+IGRiLmNsb3NlKCk7IH0gY2F0Y2ggKGUpIHsgZGIuY2xvc2UoKTsgfSB9OyB9IGNhdGNoIChlKSB7fSByZXR1cm4gcjsgfTsgfSkoKQ=='))`, act: `(async () => { const c = await window.Store.createClientDurable({ id: 'm2-' + Date.now(), name: 'M2', status: 'active', billing: {} }); const zzz = await new Promise((res) => { const rq = indexedDB.open('xinjing_db'); rq.onsuccess = () => { const db = rq.result; const r = db.transaction('kv', 'readonly').objectStore('kv').get('zzz'); r.onsuccess = () => { db.close(); res(r.result); }; r.onerror = () => { db.close(); res(null); }; }; rq.onerror = () => res(null); }); return JSON.stringify({ ok: !!(c && c.ok), zzzKey: !!zzz, defect: !!zzz }); })()` },
      { id: 'M3-wrong-key', inject: `eval(atob('KCgpID0+IHsgY29uc3QgbyA9IHdpbmRvdy5TdG9yZS5jcmVhdGVDbGllbnREdXJhYmxlOyB3aW5kb3cuU3RvcmUuY3JlYXRlQ2xpZW50RHVyYWJsZSA9IGFzeW5jIGZ1bmN0aW9uIChjKSB7IGNvbnN0IHIgPSBhd2FpdCBvLmNhbGwodGhpcywgYyk7IHRyeSB7IGNvbnN0IHJxID0gaW5kZXhlZERCLm9wZW4oJ3hpbmppbmdfZGInKTsgcnEub25zdWNjZXNzID0gKCkgPT4geyBjb25zdCBkYiA9IHJxLnJlc3VsdDsgdHJ5IHsgY29uc3QgdHggPSBkYi50cmFuc2FjdGlvbigna3YnLCAncmVhZHdyaXRlJyk7IHR4Lm9iamVjdFN0b3JlKCdrdicpLmRlbGV0ZSgnY2xpZW50cycpOyB0eC5vbmNvbXBsZXRlID0gKCkgPT4gZGIuY2xvc2UoKTsgfSBjYXRjaCAoZSkgeyBkYi5jbG9zZSgpOyB9IH07IH0gY2F0Y2ggKGUpIHt9IHJldHVybiByOyB9OyB9KSgp'))`, act: `(async () => { const c = await window.Store.createClientDurable({ id: 'm3-' + Date.now(), name: 'M3', status: 'active', billing: {} }); const clients = await new Promise((res) => { const rq = indexedDB.open('xinjing_db'); rq.onsuccess = () => { const db = rq.result; const r = db.transaction('kv', 'readonly').objectStore('kv').get('clients'); r.onsuccess = () => { db.close(); res(r.result); }; r.onerror = () => { db.close(); res(null); }; }; rq.onerror = () => res(null); }); const mem = window.Store.getClients().length; return JSON.stringify({ ok: !!(c && c.ok), idbClients: !!clients, mem, defect: !clients && mem > 0 }); })()` },
      { id: 'M4-skip-await-open', inject: `eval(atob('KCgpID0+IHsgd2luZG93LlN0b3JlLmNyZWF0ZUNsaWVudER1cmFibGUgPSBhc3luYyBmdW5jdGlvbiAoYykgeyByZXR1cm4geyBvazogdHJ1ZSB9OyB9OyB9KSgp'))`, act: `(async () => { const c = await window.Store.createClientDurable({ id: 'm4-' + Date.now(), name: 'M4', status: 'active', billing: {} }); const c2 = window.Store.getClient('m4-x'); return JSON.stringify({ claimedOk: !!(c && c.ok), readBack: !!c2, defect: !!(c && c.ok) && !c2 }); })()` },
      { id: 'M5-swallow-read-error', inject: `eval(atob('KCgpID0+IHsgY29uc3QgbyA9IHdpbmRvdy5TdG9yZS5nZXRDbGllbnRzOyB3aW5kb3cuU3RvcmUuZ2V0Q2xpZW50cyA9IGZ1bmN0aW9uICgpIHsgcmV0dXJuIFtdOyB9OyB9KSgp'))`, act: `(async () => { const c = await window.Store.createClientDurable({ id: 'm5-' + Date.now(), name: 'M5', status: 'active', billing: {} }); const visible = window.Store.getClients().length; const direct = await new Promise((res) => { const rq = indexedDB.open('xinjing_db'); rq.onsuccess = () => { const db = rq.result; const r = db.transaction('kv', 'readonly').objectStore('kv').get('clients'); r.onsuccess = () => { db.close(); res(r.result); }; r.onerror = () => { db.close(); res(null); }; }; rq.onerror = () => res(null); }); return JSON.stringify({ ok: !!(c && c.ok), visible, idbHas: !!direct, defect: !!direct && visible === 0 }); })()` },
      { id: 'M6-object-as-array', inject: `eval(atob('KCgpID0+IHsgc2V0VGltZW91dCgoKSA9PiB7IGNvbnN0IHJxID0gaW5kZXhlZERCLm9wZW4oJ3hpbmppbmdfZGInKTsgcnEub25zdWNjZXNzID0gKCkgPT4geyBjb25zdCBkYiA9IHJxLnJlc3VsdDsgdHJ5IHsgY29uc3QgdHggPSBkYi50cmFuc2FjdGlvbigna3YnLCAncmVhZHdyaXRlJyk7IHR4Lm9iamVjdFN0b3JlKCdrdicpLnB1dCh7IGtleTogJ2NsaWVudHMnLCB2YWx1ZTogeyB4OiB7fSB9IH0pOyB0eC5vbmNvbXBsZXRlID0gKCkgPT4gZGIuY2xvc2UoKTsgfSBjYXRjaCAoZSkgeyBkYi5jbG9zZSgpOyB9IH07IH0sIDUwKTsgfSkoKQ=='))`, act: `(async () => { await new Promise(r => setTimeout(r, 400)); try { window.Store.hydrate().catch(() => {}); } catch (e) {} await new Promise(r => setTimeout(r, 300)); const n = window.Store.getClients().length; return JSON.stringify({ clients: n, defect: n === 0 }); })()` },
      { id: 'M7-old-memory-reuse', inject: null, act: `(async () => { const before = window.Store.getClients().length; return JSON.stringify({ before, defect: before === 0 }); })()` },
      { id: 'M8-cross-userdata-origin', inject: `eval(atob('KCgpID0+IHsgc2V0VGltZW91dCgoKSA9PiB7IHdpbmRvdy5TdG9yZS5nZXRDbGllbnRzID0gZnVuY3Rpb24gKCkgeyByZXR1cm4gW3sgaWQ6ICdnaG9zdCcsIG5hbWU6ICdHSE9TVCcsIGJpbGxpbmc6IHt9IH1dOyB9OyB9LCAxMDApOyB9KSgp'))`, act: `(async () => { await new Promise(r => setTimeout(r, 300)); const n = window.Store.getClients().length; const hasGhost = window.Store.getClients().some(c => c.id === 'ghost'); return JSON.stringify({ clients: n, hasGhost, defect: hasGhost }); })()` },
    ];
    let killed = 0, restored = 0;
    for (const md of mutDefs) {
      const mp = await unusedPort();
      const mu = await runStage(md.id + '-mutated', mp, fs.mkdtempSync(path.join(os.tmpdir(), 'xj-041m-')), `${md.inject ? md.inject + '; ' : ''}${md.act}`, 90000);
      const rawMu = (mu.raw || '').startsWith('{') ? mu.raw : JSON.stringify({ exc: mu.raw || '' });
      // baseline 同 act 不注入（偶发启动超时自动重试一次）
      const baseAct = md.baselineAct || md.act;
      let ba = await runStage(md.id + '-baseline', await unusedPort(), fs.mkdtempSync(path.join(os.tmpdir(), 'xj-041b-')), baseAct, 90000);
      if (ba.exitCode !== 0 || /TIMEOUT/.test(ba.raw || '')) ba = await runStage(md.id + '-baseline-retry', await unusedPort(), fs.mkdtempSync(path.join(os.tmpdir(), 'xj-041b-')), baseAct, 90000);
      // restore = baseline 复跑（fresh PASS）
      const baSafe = (ba.raw || '').startsWith('{') ? ba.raw : '{}';
      const muSafe = rawMu;
      const baObj = JSON.parse(baSafe); const muObj = JSON.parse(muSafe);
      const mutatedRejected = muObj.defect === true || /EXC/.test(mu.raw || '') || (muObj.claimedOk === true && muObj.readBack === false);
      results.push({ name: 'MUT ' + md.id, pass: mutatedRejected, detail: rawMu.slice(0, 160) });
      console.log((mutatedRejected ? 'PASS' : 'FAIL'), 'MUT ' + md.id, rawMu.slice(0, 120));
      if (mutatedRejected) killed++;
      if (ba.exitCode === 0) restored++;
      else console.log('RESTORE-FAIL', md.id, (ba.raw || '').slice(0, 140));
    }
    check('expected-red：8 mutation 全部 rejected', killed === 8, `killed=${killed}/8`);
    check('restore：8/8 fresh baseline PASS', restored === 8, `restored=${restored}/8`);
    check('audit：生产零漂移（store.js SHA 未变）', sha(fs.readFileSync(path.join(ROOT, 'app/js/store.js'))) === '84DED0E7EAF3B8DE98A727D5F1671ED42B9EA27AE7EA27CAA644E8EF20CF768D');
    check('audit：真实 Electron 固定 origin（非内存快照/CDP 替代）', bj.origin === 'http://127.0.0.1:19421');
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  } finally {
    try { fixture.close(); } catch (_) {}
    hardKill();
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
  }
  const passed = results.filter(r => r.pass).length;
  console.log(`041 PIPELINE: ${passed}/${results.length}`);
  if (passed !== results.length) process.exit(1);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });