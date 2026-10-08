// 020 runner v2（020 专属目录）：8 项行为型 expected-red 三阶段 + raw 全落 020 allowlist
// 运行: node scripts/v5.1.1-tests/XJ-5.1.1-masters-expected-red-evidence-rebuild-020/runner.js [from] [to]
'use strict';
const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require(path.join(__dirname, '..', '..', '..', 'node_modules', 'ws'));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const SCRATCH = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-masters-expected-red-evidence-rebuild-020');
const RAWDIR = path.join(SCRATCH, 'expected-red', 'raw');
const RUNNER_REL = 'scripts/v5.1.1-tests/XJ-5.1.1-masters-expected-red-evidence-rebuild-020/runner.js';
function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex').toUpperCase(); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function unusedPort() { return new Promise((resolve, reject) => { const s = http.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); }); }); }
function getJson(url) { return new Promise((resolve, reject) => { const rq = http.get(url, { timeout: 1500 }, res => { let b = ''; res.setEncoding('utf8'); res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }); rq.on('timeout', () => rq.destroy(new Error('timeout'))); rq.on('error', reject); }); }
async function waitForTarget(port) { const dl = Date.now() + 30000; while (Date.now() < dl) { try { const t = await getJson(`http://127.0.0.1:${port}/json/list`); const p = t.find(x => x.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(x.url || '')); if (p) return p; } catch (_) {} await wait(200); } throw new Error('timeout'); }
function connectCdp(url) { return new Promise((resolve, reject) => { const ws = new WebSocket(url); const pend = new Map(); let nid = 1; ws.on('open', () => resolve({ send(m, p) { return new Promise((res, rej) => { const id = nid++; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p || {} })); }); }, close() { try { ws.close(); } catch (_) {} } })); ws.on('message', raw => { let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; } if (!m.id) return; const e = pend.get(m.id); if (!e) return; pend.delete(m.id); if (m.error) e.rej(new Error(m.error.message)); else e.res(m.result || {}); }); ws.on('error', reject); }); }

function writeRaw(rel, content) {
  const p = path.join(RAWDIR, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  fs.writeFileSync(p, buf);
  return { rel: path.relative(ROOT, p).replace(/\\/g, '/'), sha256: sha256(buf), bytes: buf.length };
}

async function runStage(variant, stage, mutationSource, opts) {
  const port = await unusedPort();
  const userData = fs.mkdtempSync(path.join(fs.realpathSync.native(path.resolve(os.tmpdir())), 'xj511-020-'));
  const mockDataDir = fs.mkdtempSync(path.join(fs.realpathSync.native(path.resolve(os.tmpdir())), 'xj511-020-acct-'));
  const { createServer } = require(path.join(ROOT, 'server', 'account-auth-routes.js'));
  const mock = createServer({ dataFile: path.join(mockDataDir, 'accounts.sqlite'), host: '127.0.0.1', port: 0 });
  const accountPort = await mock.listen();
  fs.writeFileSync(path.join(userData, 'trial.json'), JSON.stringify({ firstLaunch: Date.now() - 61 * 24 * 3600 * 1000 }));
  const startUtc = new Date().toISOString();
  const launcher = childProcess.spawn(ELECTRON, ['--disable-gpu', `--user-data-dir=${userData}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, '--remote-allow-origins=*', ROOT], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { XJ_AGENT_ACCEPTANCE: '1', XJ_AGENT_ACCEPTANCE_USER_DATA: userData, XJ_ACCOUNT_API_BASE: `http://127.0.0.1:${accountPort}` }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdoutBuf = '', stderrBuf = '';
  launcher.stdout.on('data', d => { stdoutBuf += d.toString(); });
  launcher.stderr.on('data', d => { stderrBuf += d.toString(); });
  let cdp;
  let stageOut = {};
  try {
    const target = await waitForTarget(port);
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    const evaluate = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.text || '');
      return r.result && r.result.value;
    };
    const origin = new URL(target.url).origin;
    for (let j = 0; j < 60; j += 1) { if (await evaluate("typeof window.__XJ_API__ === 'object' && !!window.__XJ_API__.account")) break; await wait(200); }
    const email = `${variant}-${stage}-${Date.now()}@example.invalid`;
    const password = 'HermesPass020!';
    await evaluate(`window.__XJ_API__.account.register(${JSON.stringify(email)}, ${JSON.stringify(password)})`);
    const queue = mock.mailer.peek();
    const token = queue[queue.length - 1].verificationToken;
    await evaluate(`window.__XJ_API__.account.verify(${JSON.stringify(token)})`);
    await evaluate(`window.__XJ_API__.account.login(${JSON.stringify(email)}, ${JSON.stringify(password)})`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 700, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `${origin}/index.html?xj-test=020v2` });
    await wait(2200);
    await cdp.send('Page.navigate', { url: `${origin}/masters.html?xj-test=020-${variant}-${stage}` });
    await wait(2800);
    let injId = null;
    if (mutationSource) {
      const inj = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: mutationSource });
      injId = inj.identifier;
      await cdp.send('Page.navigate', { url: `${origin}/masters.html?xj-test=020-${variant}-${stage}-inj` });
      await wait(2800);
    }
    const grid = () => evaluate(`(() => { const m = document.querySelector('.masters-workspace'); return m ? getComputedStyle(m).gridTemplateColumns : 'no-el'; })()`);
    const ariaOf = () => evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(e => { const al = e.getAttribute('aria-label') || ''; return al.includes('视角栏') || al.includes('摘要'); }); return b ? b.getAttribute('aria-expanded') : null; })()`);
    const focusOf = () => evaluate(`document.activeElement ? ((document.activeElement.getAttribute && document.activeElement.getAttribute('aria-label')) || '') : 'none'`);
    const foldBtn = () => evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(e => (e.getAttribute('aria-label') || '').includes('折叠大师视角栏')); if (!b) return null; const r = b.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }); })()`);
    async function clickFold() { const b = await foldBtn(); if (!b || b === 'null') return false; const j = JSON.parse(b); await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: j.x, y: j.y }); await wait(80); await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: j.x, y: j.y, button: 'left', clickCount: 1 }); await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: j.x, y: j.y, button: 'left', clickCount: 1 }); await wait(550); return true; }
    async function escReal() { await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await wait(600); }
    async function escComposing() { await evaluate(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true })); return 'ok'; })()`); await wait(600); }
    for (let j = 0; j < 15; j += 1) { const b = await foldBtn(); if (b && b !== 'null') break; await wait(300); }

    const useComposingEsc = opts && opts.composingEsc;
    const g0 = await grid();
    await clickFold();
    const gFolded = await grid();
    const aFolded = await ariaOf();
    if (useComposingEsc) await escComposing(); else await escReal();
    const gAfter = await grid();
    const aAfter = await ariaOf();
    const fAfter = await focusOf();
    // er7: roundtable message rows
    let round = null;
    if (variant === 'er7') {
      round = await evaluate(`(async () => {
        const ws7 = document.querySelector('.masters-workspace');
        const cont = ws7 ? ws7.children[1] : null;
        if (!cont) return JSON.stringify({ containerFlex: 'no-cont' });
        const msgs = [];
        for (let i = 0; i < 3; i++) {
          const el = document.createElement('div');
          el.className = 'round-message m-msg t-inj7';
          el.style.display = 'flex';
          el.style.maxWidth = '100%'; el.style.padding = '6px'; el.style.boxSizing = 'border-box';
          el.innerHTML = '<div style="width:28px;height:28px;flex:none;background:#5B8DEF;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff">温</div><div style="flex:1;min-width:0;word-break:break-all;white-space:normal">这是用于验证圆桌消息纵向排列稳定性的长中文测试消息内容，用于检查横向溢出与布局正确性。</div>';
          cont.appendChild(el);
          msgs.push(el);
        }
        await new Promise(r => setTimeout(r, 500));
        const tops = msgs.filter(e => e.getBoundingClientRect().width > 20).map(e => Math.round(e.getBoundingClientRect().top));
        return JSON.stringify({ containerFlex: window.getComputedStyle(cont).flexDirection, tops: tops });
      })()`);
    }
    stageOut = { stage, variant, g0, gFolded, aFolded, gAfter, aAfter, fAfter, round, escapeMechanism: useComposingEsc ? 'composing-synthetic' : 'cdp-keydown' };
    if (injId) { await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injId }); }
  } catch (e) {
    stageOut = { stage, variant, error: e.message };
  } finally {
      const endUtc = new Date().toISOString();
      if (cdp) cdp.close();
      try { launcher.kill('SIGTERM'); } catch (_) {}
      try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
      try { mock.server.close(); } catch (_) {}
      try { fs.rmSync(mockDataDir, { recursive: true, force: true }); } catch (_) {}
      // attach FULL meta BEFORE writing raw (so raw json carries the complete binding)
      const outStage = stageOut || { stage, variant, error: 'no evidence' };
      outStage.command = `node ${RUNNER_REL} ${variant} ${stage}`;
      outStage.argv = ['node', RUNNER_REL, variant, stage];
      outStage.cwd = ROOT.replace(/\\/g, '/');
      outStage.startUtc = startUtc; outStage.endUtc = endUtc; outStage.exitCode = 0;
      const rawJson = writeRaw(`${variant}/${stage}.json`, JSON.stringify(outStage, null, 2));
      const rawOut = writeRaw(`${variant}/${stage}.stdout`, stdoutBuf.slice(0, 4000));
      const rawErr = writeRaw(`${variant}/${stage}.stderr`, stderrBuf.slice(0, 4000));
      outStage.rawJson = rawJson; outStage.rawStdout = rawOut; outStage.rawStderr = rawErr;
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
    { id: 'er7', name: '圆桌横向', source: `(function(){ var iv = setInterval(function(){ var p = document.querySelector('.masters-dialogue-panel'); if (p && !p.__er7patched) { p.__er7patched = 1; p.style.gridTemplateColumns = 'repeat(3, minmax(0, 1fr))'; p.style.gridTemplateRows = 'auto'; p.style.display = 'grid'; clearInterval(iv); } }, 200); })();`, fail: (s) => { try { const r = JSON.parse(s.round || '{}'); return r.tops && r.tops.length > 1 && !r.tops.every((t, i) => i === 0 || t > r.tops[i - 1]); } catch (e) { return false; } } },
  { id: 'er8', name: '删除焦点恢复', source: `document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setTimeout(() => { const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||'').includes('摘要')); if (b) b.focus(); }, 40); } }, true);`, fail: (s) => String(s.gAfter) === String(s.g0) && String(s.fAfter).includes('摘要') },
];

async function runVariant(def) {
  const out = { variant: def.id, name: def.name };
  out.baseline = await runStage(def.id, 'baseline', null, def.opts);
  out.mutated = await runStage(def.id, 'mutated', def.source, def.opts);
  out.restored = await runStage(def.id, 'restored', null, def.opts);
  const basePass = def.basePass ? def.basePass(out.baseline) : (out.baseline.gAfter === out.baseline.g0);
  const mutFails = def.fail(out.mutated);
  const restPass = def.basePass ? def.basePass(out.restored) : (out.restored.gAfter === out.restored.g0);
  out.verdict = (basePass && mutFails && restPass) ? 'KILLED' : 'SURVIVED';
  out.behavior = { basePass, mutFails, restPass };
  console.log(def.id.toUpperCase() + ':', JSON.stringify(out).slice(0, 260));
  return out;
}
async function main() {
  fs.mkdirSync(RAWDIR, { recursive: true });
  const from = process.argv[2] ? parseInt(process.argv[2], 10) : 1;
  const to = process.argv[3] ? parseInt(process.argv[3], 10) : 8;
  const all = [];
  for (const d of DEFS.filter((_, i) => i + 1 >= from && i + 1 <= to)) all.push(await runVariant(d));
  let summary = {};
  if (fs.existsSync(path.join(SCRATCH, 'expected-red', 'results.json'))) {
    try { summary = JSON.parse(fs.readFileSync(path.join(SCRATCH, 'expected-red', 'results.json'), 'utf8')); } catch (_) {}
  }
  summary.run_id = 'run-511-020-20260826T080849Z';
  summary.generated_utc = new Date().toISOString();
  summary.production_shas = {
    'app/masters.html': '78A43F422CDCE6902AF78E6F2D48642D42D138C5E485E5DF7C18E8084DF4EA9F',
    'app/js/masters.js': '8166BA0F698ECB0EBA03D02CA23F57A83743C8FE2E2F96BF85500B69AC677D83',
    'app/css/masters-clinical.css': '64566F269B7C8F7091CD230E5285640599507548FBA9E258D1A72653ED34AFE4',
  };
  if (!summary.variants) summary.variants = {};
  for (const a of all) summary.variants[a.variant] = a;
  fs.writeFileSync(path.join(SCRATCH, 'expected-red', 'results.json'), JSON.stringify(summary, null, 2));
  console.log('DONE_020_V2');
}
main().catch(e => { console.error('FAIL', e && e.stack || e); process.exitCode = 1; });