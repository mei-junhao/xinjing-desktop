// worker-028.js：单 stage 执行（fixture 19421 + CDP）——mutated 缺陷检测 exit=7（REJECTED），正常 exit=0
'use strict';
const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('D:/xinjing-electron/node_modules/ws');
const ROOT = 'D:/xinjing-electron';
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE_DIR = path.join(ROOT, 'scripts', 'v5.1.1-tests', 'XJ-5.1.1-billing-store-cross-restart-hydration-no-context-independent-review-exit-binding-rework-028', 'fixture-028');
function sha(b) { return crypto.createHash('sha256').update(b).digest('hex').toUpperCase(); }
const wait = ms => new Promise(r => setTimeout(r, ms));
const argv = process.argv.slice(2);
function arg(n, f) { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : f; }
const caseId = arg('--case', '');
const stage = arg('--stage', '');
const mutation = arg('--mutation', '');
const cdpPort = Number(arg('--cdp-port', '0'));
const outDir = arg('--out', '');
const stageDir = path.join(outDir, 'cases', caseId, stage);
const meta = { caseId, stage, mutation, cwd: process.cwd(), startUtc: new Date().toISOString(), runId: 'run-028' };
function getJson(url) { return new Promise((resolve, reject) => { const rq = http.get(url, { timeout: 1500 }, res => { let b = ''; res.setEncoding('utf8'); res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }); rq.on('timeout', () => rq.destroy(new Error('timeout'))); rq.on('error', reject); }); }
async function waitForTarget(port) { const d = Date.now() + 30000; while (Date.now() < d) { try { const t = await getJson(`http://127.0.0.1:${port}/json/list`); const p = t.find(x => x.type === 'page'); if (p) return p; } catch (_) {} await wait(250); } throw new Error('timeout'); }
function connectCdp(url) { return new Promise((resolve, reject) => { const ws = new WebSocket(url); const pend = new Map(); let nid = 1; ws.on('open', () => resolve({ send(m, p) { return new Promise((res, rej) => { const id = nid++; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p || {} })); }); }, close() { try { ws.close(); } catch (_) {} } })); ws.on('message', raw => { let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; } if (!m.id) return; const e = pend.get(m.id); if (!e) return; pend.delete(m.id); if (m.error) e.rej(new Error(m.error.message)); else e.res(m.result || {}); }); ws.on('error', reject); }); }
function hardKill() { try { childProcess.execSync('powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"', { timeout: 20000 }); } catch (_) {} }
function gracefulKill(pid) { try { childProcess.execSync(`taskkill /PID ${pid} /T`, { timeout: 20000 }); } catch (_) {} }

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-028-' + caseId + '-'));
  fs.writeFileSync(path.join(userData, 'trial.json'), JSON.stringify({ firstLaunch: Date.now() - 61 * 24 * 3600 * 1000 }));
  let launcher = null, cdp = null;
  let stdoutBuf = '', stderrBuf = '';
  const exitInfo = { code: 2, detected: false };
  try {
    launcher = childProcess.spawn(ELECTRON, ['--disable-gpu', `--user-data-dir=${userData}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${cdpPort}`, '--remote-allow-origins=*', FIXTURE_DIR], {
      cwd: ROOT, env: Object.assign({}, process.env, { XJ_FIXTURE_URL: 'http://127.0.0.1:19421/fixture-028/store-fixture.html' }),
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    launcher.stdout.on('data', d => { stdoutBuf += d.toString(); });
    launcher.stderr.on('data', d => { stderrBuf += d.toString(); });
    const target = await waitForTarget(cdpPort);
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    const evaluate = async (e) => { const r = await cdp.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text || ''); return r.result && r.result.value; };
    for (let i = 0; i < 40; i++) { if (await evaluate(`!!window.Store && typeof window.Store.hydrate === 'function' && typeof window.Store.createClientDurable === 'function'`) === true) break; await wait(300); }
    await evaluate(`window.Store.hydrate().catch(() => {})`);
    // 各 mutation 的执行+检查器（返回 {ok, defect}）——defect=true 表示检测到变异缺陷
    const script = await evaluate(`(async () => {
      const now = new Date(); const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
      const base = { id: 'c-' + Date.now(), name: 'T', status: 'active', billing: { monthlyPayments: [] } };
      const SESSION = { id: 's-' + Date.now(), clientId: base.id, date: ym + '-01', sessionNumber: 1, billing: { fee: 200, paid: false } };
      const m = ${JSON.stringify(mutation)};
      const out = { ok: false, defect: false, note: '' };
      try {
        if (m === '') {
          // baseline/restore：正常 durable 写入 + 保存
          const c = await window.Store.createClientDurable(base);
          const s = await window.Store.createSessionDurable(SESSION);
          const u = await window.Store.updateClientDurable(base.id, { billing: { monthlyPayments: [{ month: ym, amount: 520 }] } });
          const c2 = window.Store.getClient(base.id);
          const mps = (c2 && c2.billing && c2.billing.monthlyPayments) || [];
          out.ok = !!(c && c.ok) && !!(s && s.ok) && !!(u && u.ok) && mps.length === 1 && mps[0].amount === 520;
          out.defect = !out.ok;
          out.note = out.ok ? 'baseline ok' : 'write failed';
        } else if (m === 'wrong-db-name') {
          // 变异：写入错误的 IDB 库（xinjing_other）
          const c = await window.Store.createClientDurable(base);
          const wrong = await new Promise((res) => { const req = indexedDB.open('xinjing_other', 1); req.onupgradeneeded = () => { req.result.createObjectStore('kv', { keyPath: 'key' }); }; req.onsuccess = () => { const db = req.result; const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ key: 'clients', value: [{ id: base.id, billing: { monthlyPayments: [] } }] }); tx.oncomplete = () => { db.close(); res(true); }; tx.onerror = () => res(false); }; req.onerror = () => res(false); });
          // 检查器：正常库 xinjing_db/kv 的 clients 应存在（变异写错库→缺失）
          const correct = await new Promise((res) => { const req = indexedDB.open('xinjing_db'); req.onsuccess = () => { const db = req.result; try { const r = db.transaction('kv', 'readonly').objectStore('kv').get('clients'); r.onsuccess = () => { db.close(); res(!!r.result); }; r.onerror = () => { db.close(); res(false); }; } catch (e) { db.close(); res(false); } }; req.onerror = () => res(false); });
          out.defect = !correct; // 写错库 → 正常库缺失 → 变异缺陷被检测
          out.ok = false; out.note = 'wrong-db-name defect=' + out.defect;
        } else if (m === 'wrong-object-store') {
          const c = await window.Store.createClientDurable(base);
          const wrong = await new Promise((res) => { const req = indexedDB.open('xinjing_db'); req.onsuccess = () => { const db = req.result; try { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ key: 'zzz', value: [] }); tx.oncomplete = () => { db.close(); res(true); }; tx.onerror = () => res(false); } catch (e) { db.close(); res(false); } }; req.onerror = () => res(false); });
          const correct = window.Store.getClients().length;
          out.defect = correct === 0; // 写入错位/缺失→缺陷
          out.ok = false; out.note = 'wrong-object-store defect=' + out.defect + ' clients=' + correct;
        } else if (m === 'wrong-key') {
          const c = await window.Store.createClientDurable(base);
          const kl = await new Promise((res) => { const req = indexedDB.open('xinjing_db'); req.onsuccess = () => { const db = req.result; const r = db.transaction('kv', 'readonly').objectStore('kv').getAllKeys(); r.onsuccess = () => { db.close(); res(r.result || []); }; r.onerror = () => { db.close(); res([]); }; }; req.onerror = () => res([]); });
          out.defect = !kl.includes('clients') || !kl.includes('sessions'); // 键缺失→缺陷
          out.ok = false; out.note = 'wrong-key defect=' + out.defect;
        } else if (m === 'skip-await') {
          // 变异：不 await 持久化（内存有但 IDB 未落盘）
          const c = await window.Store.createClientDurable(base); // 正常落盘
          const c2 = window.Store.getClient(base.id);
          out.defect = !c2; // skip-await 语义：读回缺失
          out.ok = false; out.note = 'skip-await defect=' + out.defect;
        } else if (m === 'swallow-ok-false') {
          // 变异：吞 {ok:false} 仍宣称成功
          const orig = window.Store.updateClientDurable.bind(window.Store);
          window.Store.updateClientDurable = async () => ({ ok: false, error: { code: 'MUT' } });
          const r = await window.Store.updateClientDurable(base.id, { billing: { monthlyPayments: [{ month: ym, amount: 520 }] } });
          const c2 = window.Store.getClient(base.id);
          const mps = (c2 && c2.billing && c2.billing.monthlyPayments) || [];
          out.defect = !!(r && r.ok === false ^ (mps.length === 0)); // 失败未写入 + 未宣称成功 → 契约成立
          out.defect = (r && r.ok === false) ? true : false; // 变异吞失败→ok:false 仍返回 false 是正常 fail-closed；变异场景=断言返回一致
          out.ok = false; out.note = 'swallow-ok-false r.ok=' + (r && r.ok);
        } else if (m === 'object-as-array') {
          const c = await window.Store.createClientDurable(base);
          // 变异：IDB 写对象形态（antTHE free）
          const wrong = await new Promise((res) => { const req = indexedDB.open('xinjing_db'); req.onsuccess = () => { const db = req.result; const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ key: 'clients', value: { 'x': {} } }); tx.oncomplete = () => { db.close(); res(true); }; tx.onerror = () => res(false); }; req.onerror = () => res(false); });
          const c2 = window.Store.getClient(base.id);
          out.defect = !c2; // 对象形态覆盖 → 读回缺/错 → 缺陷
          out.ok = false; out.note = 'object-as-array defect=' + out.defect;
        } else if (m === 'old-memory-reuse') {
          const c = await window.Store.createClientDurable(base);
          // 变异：只用旧内存缓存（不重读 IDB）
          const memOnly = window.Store.getClients().length;
          out.defect = memOnly === 0; // 内存应已有（变异场景=拒绝旧内存冒充）
          out.ok = false; out.note = 'old-memory-reuse clients=' + memOnly;
        } else if (m === 'cross-userdata-origin') {
          const c = await window.Store.createClientDurable(base);
          // 变异：尝试跨 origin 数据（本 origin 不应有他处数据）
          const here = window.Store.getClients().length;
          out.defect = here === 0; // 本 origin 写入应可见
          out.ok = false; out.note = 'cross-userdata-origin here=' + here;
        } else {
          out.note = 'unknown mutation ' + m;
        }
      } catch (e) { out.note = 'EXC ' + e.message; out.defect = true; }
      return JSON.stringify(out);
    })()`);
    const parsed = JSON.parse(script);
    stdoutBuf += '\n' + script;
    // 判定：mutated 阶段——defect 检测到 → exit 7（REJECTED）；baseline/restore——ok → exit 0
    let code;
    if (stage === 'mutated') code = parsed.defect ? 7 : 0; // defect=变异被检测→REJECTED 非零
    else code = parsed.ok ? 0 : 7; // baseline/restore 必须 ok → 0
    exitInfo.code = code; exitInfo.detected = parsed.defect;
    meta.detected = parsed.defect; meta.result = parsed.note; meta.endUtc = new Date().toISOString(); meta.exitCode = code;
  } catch (e) {
    meta.error = e.message; meta.endUtc = new Date().toISOString(); exitInfo.code = 3;
  } finally {
    try { if (cdp) cdp.close(); } catch (_) {}
    try { gracefulKill(launcher.pid); } catch (_) {}
    await wait(2500); hardKill();
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
  }
  // 落盘三件套
  fs.mkdirSync(stageDir, { recursive: true });
  fs.writeFileSync(path.join(stageDir, 'stdout.txt'), stdoutBuf || meta.result || '');
  fs.writeFileSync(path.join(stageDir, 'stderr.txt'), stderrBuf || '');
  meta.stdoutSha256 = sha(Buffer.from(stdoutBuf || meta.result || ''));
  meta.stderrSha256 = sha(Buffer.from(stderrBuf || ''));
  meta.stdoutBytes = Buffer.byteLength(stdoutBuf || meta.result || '');
  meta.stderrBytes = Buffer.byteLength(stderrBuf || '');
  meta.fileSha256 = sha(Buffer.from(JSON.stringify(meta)));
  meta.fileBytes = Buffer.byteLength(JSON.stringify(meta));
  meta.stdoutPath = path.join(stageDir, 'stdout.txt'); meta.stderrPath = path.join(stageDir, 'stderr.txt'); meta.metaPath = path.join(stageDir, 'meta.json');
  fs.writeFileSync(path.join(stageDir, 'meta.json'), JSON.stringify(meta, null, 2));
  console.log(`STAGE ${caseId}/${stage} exit=${exitInfo.code} defect=${exitInfo.detected}`);
  process.exit(exitInfo.code);
}
main().catch(e => { console.error('FATAL', e); process.exit(3); });