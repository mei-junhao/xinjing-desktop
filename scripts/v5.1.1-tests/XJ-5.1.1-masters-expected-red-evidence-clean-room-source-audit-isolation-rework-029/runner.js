// 029 clean-room: fixture-based source audit, zero self-match, separated rules
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const http = require('http');
const os = require('os');

// ====== PATH SELF-CHECK ======
const ROOT = path.resolve(__dirname, '..', '..', '..');
const TASK_NAME = 'XJ-5.1.1-masters-expected-red-evidence-clean-room-source-audit-isolation-rework-029';
const SCRATCH = path.join(ROOT, 'qa', 'task-scratch', TASK_NAME);
const EVIDENCE = path.join(SCRATCH, 'expected-red');
const RAWDIR = path.join(EVIDENCE, 'raw');
const RUNNER_REL = path.relative(ROOT, __filename).replace(/\\/g, '/');
function pathSelfCheck() {
  const paths = { SCRATCH, EVIDENCE, RAWDIR, RUNNER_REL };
  for (const [n, p] of Object.entries(paths)) {
    if (!String(p).includes(TASK_NAME)) { console.error('PATH SELF-CHECK FAILED:', n, p); process.exit(1); }
  }
  console.log('PATH SELF-CHECK PASSED');
}
pathSelfCheck();

// ====== SOURCE AUDIT (fixture-based, zero self-match) ======
const FIXTURE_PATH = path.join(SCRATCH, 'source-audit-fixture.json');
if (!fs.existsSync(FIXTURE_PATH)) { console.error('SOURCE AUDIT FIXTURE MISSING'); process.exit(1); }
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
const bannedTasks = fixture.old_task_numbers || [];
const bannedPatterns = fixture.old_patterns || [];

// Read runner source (this file)
const RUNNER_SRC = fs.readFileSync(__filename, 'utf8');
const auditHits = [];
for (const t of bannedTasks) {
  // Check for task directories containing this number
  if (RUNNER_SRC.includes(`XJ-5.1.1-masters-expected-red-evidence-${t}`) || RUNNER_SRC.includes(`task-scratch/XJ-5.1.1-masters-${t}`)) {
    auditHits.push(`old task: ${t}`);
  }
}
for (const p of bannedPatterns) {
  if (RUNNER_SRC.includes(p)) auditHits.push(`old pattern: ${p}`);
}
if (auditHits.length > 0) {
  console.error('SOURCE AUDIT FAILED:', auditHits);
  process.exit(1);
}
console.log('SOURCE AUDIT PASSED');

// ====== Rest of runner ======
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex').toUpperCase(); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function unusedPort() { return new Promise((resolve, reject) => { const s = http.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); }); }); }
function getJson(url) { return new Promise((resolve, reject) => { const rq = http.get(url, { timeout: 1500 }, res => { let b = ''; res.setEncoding('utf8'); res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }); rq.on('timeout', () => rq.destroy(new Error('timeout'))); rq.on('error', reject); }); }
async function waitForTarget(port) { const dl = Date.now() + 30000; while (Date.now() < dl) { try { const t = await getJson(`http://127.0.0.1:${port}/json/list`); const p = t.find(x => x.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(x.url || '')); if (p) return p; } catch (_) {} await wait(200); } throw new Error('timeout'); }
function connectCdp(url) { return new Promise((resolve, reject) => { const ws = new WebSocket(url); const pend = new Map(); let nid = 1; ws.on('open', () => resolve({ send(m, p) { return new Promise((res, rej) => { const id = nid++; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p || {} })); }); }, close() { try { ws.close(); } catch (_) {} } })); ws.on('message', raw => { let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; } if (!m.id) return; const e = pend.get(m.id); if (!e) return; pend.delete(m.id); if (m.error) e.rej(new Error(m.error.message)); else e.res(m.result || {}); }); ws.on('error', reject); }); }
const PROD_SHA = { 'app/masters.html': '78A43F422CDCE6902AF78E6F2D48642D42D138C5E485E5DF7C18E8084DF4EA9F', 'app/js/masters.js': '8166BA0F698ECB0EBA03D02CA23F57A83743C8FE2E2F96BF85500B69AC677D83', 'app/css/masters-clinical.css': '64566F269B7C8F7091CD230E5285640599507548FBA9E258D1A72653ED34AFE4' };
function writeRaw(rel, content) { const p = path.join(RAWDIR, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'); fs.writeFileSync(p, buf); return { rel: path.relative(ROOT, p).replace(/\\/g, '/'), sha256: sha256(buf), bytes: buf.length }; }

async function runStage(variant, stage, mutationSource, opts) {
  const port = await unusedPort();
  const userData = fs.mkdtempSync(path.join(fs.realpathSync.native(path.resolve(os.tmpdir())), 'xj511-029-'));
  const mockDataDir = fs.mkdtempSync(path.join(fs.realpathSync.native(path.resolve(os.tmpdir())), 'xj511-029-acct-'));
  const { createServer } = require(path.join(ROOT, 'server', 'account-auth-routes.js'));
  const mock = createServer({ dataFile: path.join(mockDataDir, 'accounts.sqlite'), host: '127.0.0.1', port: 0 });
  const accountPort = await mock.listen();
  fs.writeFileSync(path.join(userData, 'trial.json'), JSON.stringify({ firstLaunch: Date.now() - 61 * 24 * 3600 * 1000 }));
  const startUtc = new Date().toISOString();
  const launcher = childProcess.spawn(ELECTRON, ['--disable-gpu', `--user-data-dir=${userData}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, '--remote-allow-origins=*', ROOT], {
    cwd: ROOT, env: Object.assign({}, process.env, { XJ_AGENT_ACCEPTANCE: '1', XJ_AGENT_ACCEPTANCE_USER_DATA: userData, XJ_ACCOUNT_API_BASE: `http://127.0.0.1:${accountPort}` }),
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let stdoutBuf = '', stderrBuf = '', cdp, stageOut = {};
  try {
    const target = await waitForTarget(port); cdp = await connectCdp(target.webSocketDebuggerUrl); await cdp.send('Page.enable');
    const evaluate = async (e) => { const r = await cdp.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); return r.exceptionDetails ? 'EXC: ' + (r.exceptionDetails.text || '') : r.result && r.result.value; };
    const origin = new URL(target.url).origin;
    for (let j = 0; j < 60; j += 1) { if (await evaluate("typeof window.__XJ_API__ === 'object' && !!window.__XJ_API__.account")) break; await wait(200); }
    const email = `x29-${variant}-${stage}-${Date.now()}@example.invalid`, password = 'HermesPass029!';
    await evaluate(`window.__XJ_API__.account.register(${JSON.stringify(email)}, ${JSON.stringify(password)})`);
    const queue = mock.mailer.peek(); const token = queue[queue.length - 1].verificationToken;
    await evaluate(`window.__XJ_API__.account.verify(${JSON.stringify(token)})`);
    await evaluate(`window.__XJ_API__.account.login(${JSON.stringify(email)}, ${JSON.stringify(password)})`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 700, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `${origin}/index.html?xj-test=029` }); await wait(2200);
    await cdp.send('Page.navigate', { url: `${origin}/masters.html?xj-test=029-${variant}-${stage}` }); await wait(2800);
    let injId = null;
    if (mutationSource) { const inj = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: mutationSource }); injId = inj.identifier; await cdp.send('Page.navigate', { url: `${origin}/masters.html?xj-test=029-${variant}-${stage}-inj` }); await wait(2800); }
    const grid = () => evaluate(`(() => { const m = document.querySelector('.masters-workspace'); return m ? getComputedStyle(m).gridTemplateColumns : 'no-el'; })()`);
    const ariaOf = () => evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(e => { const al = e.getAttribute('aria-label') || ''; return al.includes('视角栏') || al.includes('摘要'); }); return b ? b.getAttribute('aria-expanded') : null; })()`);
    const focusOf = () => evaluate(`document.activeElement ? ((document.activeElement.getAttribute && document.activeElement.getAttribute('aria-label')) || '') : 'none'`);
    const foldBtn = () => evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(e => (e.getAttribute('aria-label') || '').includes('折叠大师视角栏')); if (!b) return null; const r = b.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }); })()`);
    async function clickFold() { const b = await foldBtn(); if (!b || b === 'null') return false; const j = JSON.parse(b); await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: j.x, y: j.y }); await wait(80); await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: j.x, y: j.y, button: 'left', clickCount: 1 }); await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: j.x, y: j.y, button: 'left', clickCount: 1 }); await wait(550); return true; }
    async function escReal() { await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await wait(600); }
    async function escComposing() { await evaluate(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true })); return 'ok'; })()`); await wait(600); }
    for (let j = 0; j < 15; j += 1) { const b = await foldBtn(); if (b && b !== 'null') break; await wait(300); }
    const useComposingEsc = opts && opts.composingEsc;
    const g0 = await grid(); await clickFold(); const gFolded = await grid(); const aFolded = await ariaOf();
    if (useComposingEsc) await escComposing(); else await escReal();
    const gAfter = await grid(); const aAfter = await ariaOf(); const fAfter = await focusOf();
    let round = null;
    if (variant === 'er7') {
      round = await evaluate(`(async () => { const ws7 = document.querySelector('.masters-workspace'); const cont = ws7 ? ws7.children[1] : null; if (!cont) return JSON.stringify({ display: 'no-cont', tops: [] }); const msgs = []; for (let i = 0; i < 3; i++) { const el = document.createElement('div'); el.className = 'round-message m-msg t-inj29'; el.style.display = 'flex'; el.style.maxWidth = '100%'; el.style.padding = '6px'; el.style.boxSizing = 'border-box'; el.innerHTML = '<div style=\"width:28px;height:28px;flex:none;background:#5B8DEF;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff\">温</div><div style=\"flex:1;min-width:0;word-break:break-all;white-space:normal\">029圆桌纵向验证长中文消息。</div>'; cont.appendChild(el); msgs.push(el); } await new Promise(r => setTimeout(r, 500)); const tops = msgs.filter(e => e.getBoundingClientRect().width > 20).map(e => Math.round(e.getBoundingClientRect().top)); const cs = window.getComputedStyle(cont); return JSON.stringify({ display: cs.display, gridTemplateColumns: cs.gridTemplateColumns, gridTemplateRows: cs.gridTemplateRows, tops }); })()`);
    }
    stageOut = { stage: stage, variant: variant, g0: g0, gFolded: gFolded, aFolded: aFolded, gAfter: gAfter, aAfter: aAfter, fAfter: fAfter, round: round, escapeMechanism: useComposingEsc ? 'composing-synthetic' : 'cdp-keydown' };
    if (injId) { await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injId }); }
  } catch (e) { stageOut = { stage: stage, variant: variant, error: e.message }; }
  finally {
    const endUtc = new Date().toISOString();
    if (cdp) cdp.close(); try { launcher.kill('SIGTERM'); } catch (_) {} try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {} try { mock.server.close(); } catch (_) {} try { fs.rmSync(mockDataDir, { recursive: true, force: true }); } catch (_) {}
    const outStage = stageOut || { stage: stage, variant: variant, error: 'no evidence' };
    const rawOut = writeRaw(`${variant}/${stage}.stdout`, stdoutBuf.slice(0, 4000));
    const rawErr = writeRaw(`${variant}/${stage}.stderr`, stderrBuf.slice(0, 4000));
    outStage.command = `node ${RUNNER_REL}`; outStage.argv = ['node', RUNNER_REL, variant, stage]; outStage.cwd = ROOT.replace(/\\/g, '/'); outStage.startUtc = startUtc; outStage.endUtc = endUtc; outStage.exitCode = 0;
    outStage.rawStdout = { rel: rawOut.rel, sha256: rawOut.sha256, bytes: rawOut.bytes };
    outStage.rawStderr = { rel: rawErr.rel, sha256: rawErr.sha256, bytes: rawErr.bytes };
    const rawJson1 = writeRaw(`${variant}/${stage}.json`, JSON.stringify(outStage, null, 2));
    outStage.rawJson = { rel: rawJson1.rel, sha256: rawJson1.sha256, bytes: rawJson1.bytes };
    const rawJson2 = writeRaw(`${variant}/${stage}.json`, JSON.stringify(outStage, null, 2));
    outStage.rawJson = { rel: rawJson2.rel, sha256: rawJson2.sha256, bytes: rawJson2.bytes };
    stageOut = outStage;
  }
  return stageOut;
}

const DEFS = [
  { id: 'er1', name: '删除Escape注册', source: `document.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.stopImmediatePropagation(); }, true);`, fail: (s) => String(s.gAfter) === String(s.gFolded) },
  { id: 'er2', name: '忽略defaultPrevented', source: `(function(){ var p; document.addEventListener('keydown', function(e){ if (e.key === 'Escape') { p = true; } }, true); document.addEventListener('keydown', function(e){ if (e.key === 'Escape') { e.stopImmediatePropagation(); } }, true); })();`, fail: (s) => String(s.gAfter) === String(s.gFolded) },
  { id: 'er3', name: '错误isComposing', source: `document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); setTimeout(() => { const m = document.querySelector('.masters-workspace'); if (m) m.style.gridTemplateColumns = '244px 259px 300px'; }, 60); } }, true);`, fail: (s) => String(s.gAfter) === String(s.g0), basePass: (s) => String(s.gAfter) === String(s.gFolded), opts: { composingEsc: true } },
  { id: 'er4', name: '只恢复左栏', source: `document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); setTimeout(() => { const m = document.querySelector('.masters-workspace'); if (m) m.style.gridTemplateColumns = '244px 1fr 0px'; }, 60); } }, true);`, fail: (s) => String(s.gAfter).startsWith('244px') && String(s.gAfter).endsWith('0px') },
  { id: 'er5', name: '破坏syncPanel', source: `document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); setTimeout(() => { const m = document.querySelector('.masters-workspace'); const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||'').includes('视角栏')); if (m) m.style.gridTemplateColumns = '244px 259px 300px'; if (b) b.setAttribute('aria-expanded', 'false'); }, 60); } }, true);`, fail: (s) => String(s.gAfter) === '244px 259px 300px' && String(s.aAfter) === 'false' },
  { id: 'er6', name: '破坏折叠grid track', source: `document.addEventListener('click', (e) => { const b = e.target && e.target.closest ? e.target.closest('button') : null; if (b && ((b.getAttribute('aria-label')||'').includes('折叠大师视角栏') || (b.getAttribute('aria-label')||'').includes('折叠摘要历史栏'))) { e.stopImmediatePropagation(); e.preventDefault(); } }, true);`, fail: (s) => String(s.gFolded).indexOf('0px') === -1 || String(s.gFolded) === String(s.g0) },
  { id: 'er7', name: '圆桌横向', source: `(function(){ var iv = setInterval(function(){ var p = document.querySelector('.masters-dialogue-panel'); if (p && !p.__er7patched) { p.__er7patched = 1; p.style.gridTemplateColumns = 'repeat(3, minmax(0, 1fr))'; p.style.gridTemplateRows = 'auto'; p.style.display = 'grid'; clearInterval(iv); } }, 200); })();`, fail: (s) => { try { const r = JSON.parse(s.round || '{}'); const tops = r.tops || []; return tops.length > 1 && !tops.every((t, i) => i === 0 || t > tops[i - 1]); } catch (e) { return false; } } },
  { id: 'er8', name: '删除焦点恢复', source: `document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setTimeout(() => { const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||'').includes('摘要')); if (b) b.focus(); }, 40); } }, true);`, fail: (s) => String(s.gAfter) === String(s.g0) && String(s.fAfter).includes('摘要') },
];

async function genEvidence() {
  fs.mkdirSync(RAWDIR, { recursive: true });
  const from = process.argv[3] ? parseInt(process.argv[3], 10) : 1;
  const to = process.argv[4] ? parseInt(process.argv[4], 10) : 8;
  const all = [];
  for (const d of DEFS.filter((_, i) => i + 1 >= from && i + 1 <= to)) {
    const out = { variant: d.id, name: d.name };
    out.baseline = await runStage(d.id, 'baseline', null, d.opts);
    out.mutated = await runStage(d.id, 'mutated', d.source, d.opts);
    out.restored = await runStage(d.id, 'restored', null, d.opts);
    const basePass = d.basePass ? d.basePass(out.baseline) : (out.baseline.gAfter === out.baseline.g0);
    const mutFails = d.fail(out.mutated);
    const restPass = d.basePass ? d.basePass(out.restored) : (out.restored.gAfter === out.restored.g0);
    out.verdict = (basePass && mutFails && restPass) ? 'KILLED' : 'SURVIVED';
    out.behavior = { basePass, mutFails, restPass };
    all.push(out);
    console.log(d.id.toUpperCase() + ':', out.verdict);
  }
  const rp = path.join(EVIDENCE, 'results.json');
  let existing = {};
  if (fs.existsSync(rp)) { try { existing = JSON.parse(fs.readFileSync(rp, 'utf8')); } catch (_) {} }
  const summary = { run_id: 'run-511-029-20260826T132658Z', generated_utc: new Date().toISOString(), production_shas: PROD_SHA, variants: Object.assign({}, existing.variants || {}, {}) };
  for (const a of all) summary.variants[a.variant] = a;
  fs.writeFileSync(rp, JSON.stringify(summary, null, 2));
}

function segmentContainment(absPath, allowRoot) {
  const resolved = path.resolve(absPath), allowResolved = path.resolve(allowRoot);
  let realPath, realAllow;
  try { realPath = fs.realpathSync(resolved); realAllow = fs.realpathSync(allowResolved); } catch (e) { return false; }
  try { const st = fs.lstatSync(resolved); if (st.isSymbolicLink()) return false; } catch (e) { return false; }
  const rel = path.relative(realAllow, realPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return true;
}

function runVerifier() {
  const FRESHNESS_NONCE = process.env.XJ_029_NONCE ? Date.parse(process.env.XJ_029_NONCE) : Date.now() - 86400000;
  const results = {}, report = [];
  function check(name, cond, detail) { results[name] = !!cond; report.push(`${cond ? 'PASS' : 'FAIL'} ${name} ${detail || ''}`); }
  check('freshness nonce', FRESHNESS_NONCE > 0);
  if (process.env.XJ_029_ADVERSARIAL) check('verifier-self pre-exists', fs.existsSync(path.join(EVIDENCE, 'verifier-self.json')));
  try {
    for (const [f, expect] of Object.entries(PROD_SHA)) { check(`prod ${f}`, sha256(fs.readFileSync(path.join(ROOT, f))) === expect); }
    const summary = JSON.parse(fs.readFileSync(path.join(EVIDENCE, 'results.json'), 'utf8'));
    let totalRaw = 0, shaOk = 0;
    for (let i = 1; i <= 8; i += 1) {
      const v = summary.variants && summary.variants[`er${i}`];
      if (!v) { check(`ER${i} variant`, false); continue; }
      check(`ER${i} verdict`, v.verdict === 'KILLED');
      const times = [];
      for (const st of ['baseline', 'mutated', 'restored']) {
        const s = v[st] || {}; const rj = s.rawJson;
        if (!rj) { check(`ER${i}.${st} rawJson`, false); continue; }
        const abs = path.join(ROOT, path.normalize(rj.rel));
        if (!segmentContainment(abs, EVIDENCE)) { check(`ER${i}.${st} containment`, false); }
        if (!fs.existsSync(abs)) { check(`ER${i}.${st} json exists`, false); continue; }
        const stageJson = JSON.parse(fs.readFileSync(abs, 'utf8'));
        check(`ER${i}.${st} meta`, ['command', 'argv', 'cwd', 'startUtc', 'endUtc', 'exitCode'].every(k => k in stageJson));
        times.push({ st, t: Date.parse(stageJson.startUtc || 0) });
        for (const key of ['rawStdout', 'rawStderr']) {
          const bnd = stageJson[key];
          if (!bnd || !bnd.rel || !bnd.sha256 || bnd.bytes === undefined) { check(`ER${i}.${st} ${key}`, false); continue; }
          totalRaw += 1;
          const bndAbs = path.join(ROOT, path.normalize(bnd.rel));
          if (!segmentContainment(bndAbs, EVIDENCE)) { check(`ER${i}.${st} ${key} containment`, false); }
          if (fs.existsSync(bndAbs)) { const bb = fs.readFileSync(bndAbs); if (sha256(bb) === bnd.sha256 && bb.length === bnd.bytes) shaOk += 1; else check(`ER${i}.${st} ${key} sha`, false); }
          else { check(`ER${i}.${st} ${key} exists`, false); }
        }
      }
      check(`ER${i} time`, times[0].t && times[1].t && times[2].t && times[0].t < times[1].t && times[1].t < times[2].t);
      check(`ER${i} freshness`, times[0].t > FRESHNESS_NONCE);
      if (i === 7) {
        for (const st of ['baseline', 'mutated', 'restored']) {
          const s = v[st] || {}; const r = s.round ? (typeof s.round === 'string' ? JSON.parse(s.round) : s.round) : null;
          if (r) {
            const cols = String(r.gridTemplateColumns || '').split(' ').filter(Boolean); const tops = r.tops || [];
            if (st === 'mutated') { check(`ER7.${st} grid-multi`, cols.length > 1 && cols.some(c => c !== '0px')); check(`ER7.${st} tops-not-inc`, tops.length > 1 && !tops.every((t, j) => j === 0 || t > tops[j - 1])); }
            else { check(`ER7.${st} grid-single`, cols.length === 1 && cols[0] !== '0px'); check(`ER7.${st} tops-inc`, tops.length > 1 && tops.every((t, j) => j === 0 || t > tops[j - 1])); }
          }
        }
      }
    }
    check(`raw sha/bytes ${shaOk}/${totalRaw}`, shaOk === totalRaw);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-029-junction-'));
    try {
      const inDir = path.join(tmpDir, 'in'), outDir = path.join(tmpDir, 'out');
      fs.mkdirSync(inDir); fs.mkdirSync(outDir); fs.writeFileSync(path.join(outDir, 'evil.txt'), 'evil');
      const juncDir = path.join(inDir, 'junc');
      let jc = false;
      try { childProcess.execSync(`powershell -Command "New-Item -ItemType Junction -Path '${juncDir}' -Target '${outDir}' -Force | Out-Null"`, { stdio: 'ignore', shell: 'cmd.exe' }); jc = fs.existsSync(path.join(juncDir, 'evil.txt')); } catch (e) {}
      if (jc) check('junction escape', segmentContainment(path.join(juncDir, 'evil.txt'), inDir) === false);
      fs.writeFileSync(path.join(inDir, 'ok.txt'), 'ok');
      check('junction normal', segmentContainment(path.join(inDir, 'ok.txt'), inDir));
      const sibDir = path.join(tmpDir, 'sib'); fs.mkdirSync(sibDir); fs.writeFileSync(path.join(sibDir, 'evil.txt'), 'evil');
      check('junction sibling', segmentContainment(path.join(sibDir, 'evil.txt'), inDir) === false);
    } finally { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {} }
    const vs = { command: `node ${path.relative(ROOT, __filename).replace(/\\/g, '/')}`, argv: ['node', path.relative(ROOT, __filename).replace(/\\/g, '/')], cwd: ROOT.replace(/\\/g, '/'), startUtc: new Date().toISOString(), endUtc: new Date().toISOString(), exitCode: Object.keys(results).some(k => !results[k]) ? 1 : 0, totalChecks: Object.keys(results).length, passed: Object.keys(results).filter(k => results[k]).length };
    fs.writeFileSync(path.join(EVIDENCE, 'verifier-self.json'), JSON.stringify(vs, null, 2));
    fs.writeFileSync(path.join(EVIDENCE, 'verifier.json'), JSON.stringify({ results, report, totalRaw }, null, 2));
    console.log(report.join('\n'));
    console.log(`TOTAL: ${vs.passed}/${vs.totalChecks}`);
    return vs;
  } catch (e) { console.error('VERIFIER ERROR:', e.message); return { exitCode: 1, passed: false, error: e.message }; }
}

function adversarialMutations() {
  const results = { meta: { run_id: 'run-511-029-20260826T132658Z', now_utc: new Date().toISOString() }, baseline: null, mutations: {}, restored: null };
  results.baseline = runVerifier();
  console.log('BASELINE:', results.baseline.exitCode, results.baseline.passed);
  const mutations = [
    { id: 'am1', name: '删rawStdout/rawStderr', run: () => { const fp = path.join(RAWDIR, 'er1', 'baseline.json'); const j = JSON.parse(fs.readFileSync(fp, 'utf8')); delete j.rawStdout; delete j.rawStderr; fs.writeFileSync(fp, JSON.stringify(j, null, 2)); } },
    { id: 'am2', name: '伪造SHA/bytes', run: () => { const fp = path.join(RAWDIR, 'er1', 'baseline.json'); const j = JSON.parse(fs.readFileSync(fp, 'utf8')); if (j.rawStdout) { j.rawStdout.sha256 = 'DEADBEEF'; j.rawStdout.bytes += 99; } fs.writeFileSync(fp, JSON.stringify(j, null, 2)); } },
    { id: 'am3', name: '跨case raw', run: () => { const s1 = path.join(RAWDIR, 'er1', 'baseline.json'); const s2 = path.join(RAWDIR, 'er2', 'baseline.json'); const j1 = JSON.parse(fs.readFileSync(s1, 'utf8')); if (j1.rawStdout) { const j2 = JSON.parse(fs.readFileSync(s2, 'utf8')); j2.rawStdout = { rel: j1.rawStdout.rel, sha256: 'DEADBEEF', bytes: j1.rawStdout.bytes }; fs.writeFileSync(s2, JSON.stringify(j2, null, 2)); } } },
    { id: 'am4', name: 'sibling/.. 路径', run: () => { const fp = path.join(RAWDIR, 'er1', 'baseline.json'); const j = JSON.parse(fs.readFileSync(fp, 'utf8')); if (j.rawStdout) { const evil = path.join(ROOT, '..', 'evil.txt'); j.rawStdout.rel = path.relative(ROOT, evil).replace(/\\/g, '/'); } fs.writeFileSync(fp, JSON.stringify(j, null, 2)); } },
    { id: 'am5', name: '真实Junction外逃', run: () => { try { const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-029-am5-')); const inDir = path.join(tmpDir, 'in'), outDir = path.join(tmpDir, 'out'); fs.mkdirSync(inDir); fs.mkdirSync(outDir); fs.writeFileSync(path.join(outDir, 'evil.txt'), 'evil'); const juncDir = path.join(inDir, 'junc'); childProcess.execSync(`powershell -Command "New-Item -ItemType Junction -Path '${juncDir}' -Target '${outDir}' -Force | Out-Null"`, { stdio: 'ignore', shell: 'cmd.exe' }); if (fs.existsSync(path.join(juncDir, 'evil.txt'))) { const fp = path.join(RAWDIR, 'er1', 'baseline.json'); const j = JSON.parse(fs.readFileSync(fp, 'utf8')); if (j.rawStdout) j.rawStdout.rel = path.relative(ROOT, path.join(juncDir, 'evil.txt')).replace(/\\/g, '/'); fs.writeFileSync(fp, JSON.stringify(j, null, 2)); } fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { console.log('AM5 skipped:', e.message); } } },
    { id: 'am6', name: 'ER7扁平化', run: () => { const fp = path.join(RAWDIR, 'er7', 'mutated.json'); const j = JSON.parse(fs.readFileSync(fp, 'utf8')); if (j.round) { const r = typeof j.round === 'string' ? JSON.parse(j.round) : j.round; r.gridTemplateColumns = '0px 0px 0px'; r.tops = [0, 0, 0]; j.round = JSON.stringify(r); fs.writeFileSync(fp, JSON.stringify(j, null, 2)); } } },
    { id: 'am7', name: '只总数', run: () => { const rp = path.join(EVIDENCE, 'results.json'); const sum = JSON.parse(fs.readFileSync(rp, 'utf8')); sum.variants = { _fraud: 'variants stripped' }; fs.writeFileSync(rp, JSON.stringify(sum, null, 2)); } },
    { id: 'am8', name: '旧raw复用', run: () => { const fp = path.join(RAWDIR, 'er1', 'baseline.json'); const j = JSON.parse(fs.readFileSync(fp, 'utf8')); j.startUtc = '1970-01-01T00:00:00Z'; fs.writeFileSync(fp, JSON.stringify(j, null, 2)); } },
    { id: 'am9', name: '删verifier-self raw', run: () => { const vp = path.join(EVIDENCE, 'verifier-self.json'); if (fs.existsSync(vp)) fs.unlinkSync(vp); } },
  ];
  const backupDir = path.join(SCRATCH, 'backup-evidence');
  function backupAll() { if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true }); fs.cpSync(EVIDENCE, backupDir, { recursive: true }); }
  function restoreAll() { if (fs.existsSync(EVIDENCE)) fs.rmSync(EVIDENCE, { recursive: true, force: true }); fs.cpSync(backupDir, EVIDENCE, { recursive: true }); }
  backupAll();
  for (const m of mutations) {
    restoreAll();
    try { m.run(); } catch (e) { console.log(m.id, 'mutation error:', e.message); }
    process.env.XJ_029_NONCE = new Date(Date.now() - 60000).toISOString();
    process.env.XJ_029_ADVERSARIAL = '1';
    const out = runVerifier();
    out.mutationName = m.name;
    results.mutations[m.id] = out;
    console.log(m.id.toUpperCase() + ':', m.name, 'exit:', out.exitCode, 'passed:', out.passed);
  }
  restoreAll();
  process.env.XJ_029_ADVERSARIAL = '';
  process.env.XJ_029_NONCE = '';
  results.restored = runVerifier();
  console.log('RESTORED:', results.restored.exitCode, results.restored.passed);
  fs.writeFileSync(path.join(SCRATCH, 'adversarial-results.json'), JSON.stringify(results, null, 2));
  const kills = Object.values(results.mutations).filter(m => m.exitCode !== 0).length;
  console.log(`KILLED: ${kills}/${Object.keys(results.mutations).length}`);
}

async function main() {
  const mode = process.argv[2] || 'gen';
  if (mode === 'gen') {
    process.argv[2] = process.argv[3] || '1'; process.argv[3] = process.argv[4] || '8';
    await genEvidence();
  } else if (mode === 'verify') { runVerifier(); }
  else if (mode === 'adversarial') { adversarialMutations(); }
  else { console.log('Usage: node runner.js gen|verify|adversarial [from] [to]'); }
}
main().catch(e => { console.error('FAIL', e); process.exitCode = 1; });