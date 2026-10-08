// probe-cal.js
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = 'D:/xinjing-electron';
const SC = path.join(ROOT, 'scripts/v5.1.1-tests/XJ-5.1.1-ui-functional-closure-hermes-no-context-independent-review-007');
const FX = path.join(SC, 'fixture-007r');
const APP = path.join(ROOT, 'app');
const PORT = 19421, CDP_PORT = 19438;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const fp = path.join(APP, p);
  if (!fp.startsWith(APP)) { res.writeHead(403); res.end(); return; }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' }); res.end(data);
  });
});
function cdpSend(ws, id, method, params) { return new Promise((resolve, reject) => {
  const onMsg = (raw) => { const m = JSON.parse(raw); if (m.id === id) { ws.removeListener('message', onMsg); resolve(m.result || m); } };
  ws.on('message', onMsg); ws.send(JSON.stringify({ id, method, params: params || {} }));
  setTimeout(() => reject(new Error('timeout')), 20000); }); }
async function main() {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const electron = require(path.join(ROOT, 'node_modules/electron/index.js'));
  const child = spawn(electron, [FX, '--remote-debugging-port=' + CDP_PORT], {
    env: { ...process.env, XJ_FIXTURE_URL: 'http://127.0.0.1:19421/billing-calendar.html', XJ_USER_DATA: path.join(SC, 'tmp-userdata-b') }, cwd: FX, stdio: ['ignore','pipe','pipe'] });
  let out = '';
  child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
  let target = null;
  for (let i = 0; i < 25; i++) { await new Promise(r => setTimeout(r, 700));
    try { const ts = await new Promise((res, rej) => http.get('http://127.0.0.1:' + CDP_PORT + '/json/list', r2 => { let b=''; r2.on('data', c => b+=c); r2.on('end', () => res(JSON.parse(b))); }).on('error', rej));
      target = ts.find(x => x.type === 'page' && x.url.includes('billing-calendar.html')); if (target) break; } catch(e) {} }
  const WebSocket = require(path.join(ROOT, 'node_modules/ws/index.js'));
  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 32*1024*1024 });
  await new Promise(r => ws.on('open', r));
  let idc = 0;
  const ev = async (ex) => { const r = await cdpSend(ws, ++idc, 'Runtime.evaluate', { expression: ex, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __err: JSON.stringify(r.exceptionDetails).slice(0,300) };
    return r.result ? r.result.value : r.value; };
  await new Promise(r => setTimeout(r, 4000));
  const r1 = await ev(`({ label: document.getElementById('month-label')?.textContent, hasPrev: typeof window.prevMonth })`);
  console.log('BEFORE', JSON.stringify(r1));
  const r2 = await ev(`(typeof window.prevMonth === 'function') ? (window.prevMonth(), 'called') : 'missing'`);
  console.log('CALL', JSON.stringify(r2));
  await new Promise(r2 => setTimeout(r2, 700));
  const r3 = await ev(`({ label: document.getElementById('month-label')?.textContent })`);
  console.log('AFTER', JSON.stringify(r3));
  const r4 = await ev(`({ canBilling: window.App ? window.App.canUse('billing-calendar') : 'noApp', xj: window.__XJ__ ? { mode: window.__XJ__.mode, tier: window.__XJ__.tier } : null, locked: !!document.querySelector('.bc-locked, [class*=lock]') })`);
  console.log('STATE', JSON.stringify(r4));
  const r5 = await ev(`(async () => { try { const s = await window.__XJ_API__.getState(); return { ok: true, mode: s && s.mode, tier: s && s.tier }; } catch (e) { return { err: String(e).slice(0,120) }; } })()`);
  console.log('GETSTATE-DIRECT', JSON.stringify(r5));
  const r6 = await ev(`(async () => { try { await window.App.refreshLicenseState(); return { can: window.App.canUse('billing-calendar') }; } catch (e) { return { err: String(e).slice(0,120) }; } })()`);
  console.log('REFRESH', JSON.stringify(r6));
  const r7 = await ev(`(window.prevMonth(), document.getElementById('month-label').textContent)`);
  console.log('AFTER2', JSON.stringify(r7));
  console.log('FULL-OUT:', out.split('\n').filter(l => /PAGE|XJ|preload|Unable|Error|Sandbox/i.test(l)).slice(0, 20).join(' || ').slice(0, 1200));
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
