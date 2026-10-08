// probe-049.js — 壳层结构探测（Phase B0）：8 快捷卡/侧栏/Window/主题 只读盘点
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = 'D:/xinjing-electron';
const SC = path.join(ROOT, 'scripts/v5.1.1-tests/XJ-5.1.1-version-candidate-readiness-workbench-shell-no-context-independent-review-049');
const FX = path.join(SC, 'fixture-049');
const APP = path.join(ROOT, 'app');
const PORT = 19421;
const CDP_PORT = 19429;

function log(...a) { console.log(...a); }

// 静态服务器（MIME 表）
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = path.join(APP, p);
  if (!fp.startsWith(APP)) { res.writeHead(403); res.end(); return; }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});

function cdpSend(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const onMsg = (raw) => {
      const m = JSON.parse(raw);
      if (m.id === id) { ws.removeListener('message', onMsg); resolve(m.result || m); }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => { ws.removeListener('message', onMsg); reject(new Error('cdp timeout ' + method)); }, 20000);
  });
}

async function waitHttp(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { await new Promise((r, j) => http.get(url, r).on('error', j)); return; } catch (e) {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('server not up');
}

async function main() {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  log('SERVER-UP', PORT);

  // 找空闲 CDP 端口
  const { execSync } = require('child_process');

  const electron = require(path.join(ROOT, 'node_modules/electron/index.js'));
  // 先试 19429，占用则 +1
  let cdpPort = CDP_PORT;
  const fx = FX;
  const userData = path.join(SC, 'tmp-userdata-probe');
  fs.mkdirSync(userData, { recursive: true });

  const child = spawn(electron, [fx, `--remote-debugging-port=${cdpPort}`], {
    env: { ...process.env, XJ_FIXTURE_URL: `http://127.0.0.1:19421/index.html`, ELECTRON_USER_DATA: userData },
    cwd: fx, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => { out += d.toString(); });
  child.stderr.on('data', d => { out += d.toString(); });

  // 等 CDP
  await new Promise(r => setTimeout(r, 6000));
  let targets;
  try {
    const t = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${cdpPort}/json/list`, res => {
        let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b)));
      }).on('error', reject);
    });
    targets = t.filter(x => x.type === 'page' && x.url.includes('index.html'));
  } catch (e) {
    log('CDP-FAIL', String(e).slice(0, 200)); console.log(out.slice(-1500)); process.exit(2);
  }
  if (!targets.length) { log('NO-PAGE-TARGET'); console.log(out.slice(-1200)); process.exit(2); }

  const WebSocket = require(path.join(ROOT, 'node_modules/ws/index.js'));
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise(r => ws.on('open', r));

  const ev = async (expr) => {
    const r = await cdpSend(ws, Math.floor(Math.random() * 1e9), 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result ? r.result.value : r.value;
  };

  await new Promise(r => setTimeout(r, 3500)); // 等 app.js 注入

  const snapshot = await ev(`(async () => {
    const q = s => Array.from(document.querySelectorAll(s));
    const mods = q('.mod[data-quick-key]').map(m => ({
      key: m.getAttribute('data-quick-key'),
      text: (m.textContent || '').trim().slice(0, 30),
      visible: !!(m.offsetWidth || m.offsetHeight),
    }));
    const nav = q('#sidebar-mount a, #sidebar-mount [role=menuitem], #sidebar-mount button').map(a => ({
      text: (a.textContent || '').trim().slice(0, 24), href: a.getAttribute('href') || '',
      visible: !!(a.offsetWidth || a.offsetHeight),
    }));
    return {
      title: document.title,
      modsCount: mods.length, mods,
      navCount: nav.length, nav,
      theme: document.documentElement.getAttribute('data-theme') || getComputedStyle(document.documentElement).getPropertyValue('--paper') || '',
      bodyClass: document.body.className,
      sidebarWidth: (document.querySelector('#sidebar-mount') || {}).offsetWidth || 0,
      errors: (window.__xjErrors || []),
    };
  })()`);
  log('SNAPSHOT', JSON.stringify(snapshot));

  // 控制台错误收集
  const cdpErrors = out.split('\n').filter(l => /049 PAGE.*(error|Error|ERROR)/.test(l)).slice(0, 8);
  log('CONSOLE-ERRORS', JSON.stringify(cdpErrors));

  ws.close();
  try { child.kill(); } catch (e) {}
  await new Promise(r => setTimeout(r, 800));
  server.close();
  process.exit(0);
}

main().catch(e => { console.error('PROBE-ERR', e); process.exit(1); });
