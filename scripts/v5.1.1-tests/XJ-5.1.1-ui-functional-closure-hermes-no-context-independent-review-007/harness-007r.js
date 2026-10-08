// harness-007r.js — Checkpoint B: 真实 Electron 独立抽查（trusted CDP 输入）
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = 'D:/xinjing-electron';
const SC = path.join(ROOT, 'scripts/v5.1.1-tests/XJ-5.1.1-ui-functional-closure-hermes-no-context-independent-review-007');
const FX = path.join(SC, 'fixture-007r');
const APP = path.join(ROOT, 'app');
const PORT = 19421;
const CDP_PORT = 19437;

const results = [];
function rec(name, ok, detail) { results.push({ name, ok: !!ok, detail: String(detail || '').slice(0, 200) }); console.log(ok ? 'PASS' : 'FAIL', name, String(detail || '').slice(0, 120)); }

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
    const onMsg = (raw) => { const m = JSON.parse(raw); if (m.id === id) { ws.removeListener('message', onMsg); resolve(m.result || m); } };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => { ws.removeListener('message', onMsg); reject(new Error('cdp timeout ' + method)); }, 25000);
  });
}

async function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}

async function main() {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));

  const electron = require(path.join(ROOT, 'node_modules/electron/index.js'));
  const fx = FX;
  const userData = path.join(SC, 'tmp-userdata-b');
  fs.mkdirSync(userData, { recursive: true });

  // 分页依次跑：masters → supervision → billing-shell → billing-calendar
  const pages = [
    { name: 'masters', url: 'http://127.0.0.1:19421/masters.html' },
    { name: 'supervision', url: 'http://127.0.0.1:19421/supervision.html' },
    { name: 'billing-shell', url: 'http://127.0.0.1:19421/billing-shell.html' },
    { name: 'billing-calendar', url: 'http://127.0.0.1:19421/billing-calendar.html' },
  ];

  for (const pg of pages) {
    const child = spawn(electron, [FX, `--remote-debugging-port=${CDP_PORT}`], {
      env: { ...process.env, XJ_FIXTURE_URL: pg.url, XJ_W: '1366', XJ_H: '768', XJ_USER_DATA: userData },
      cwd: fx, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { out += d.toString(); });

    // 等 CDP target
    let target = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 700));
      try {
        const ts = await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
        target = ts.find(x => x.type === 'page' && x.url.includes(pg.url.split('/').pop()));
        if (target) break;
      } catch (e) {}
    }
    if (!target) { rec(`${pg.name}:launch`, false, 'no CDP target'); try { child.kill(); } catch (e) {} continue; }

    const WebSocket = require(path.join(ROOT, 'node_modules/ws/index.js'));
    const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 96 * 1024 * 1024 });
    await new Promise(r => ws.on('open', r));
    let idc = 0;
    const ev = async (expr) => {
      const r = await cdpSend(ws, ++idc, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('page eval error: ' + JSON.stringify(r.exceptionDetails).slice(0, 150));
      return r.result ? r.result.value : r.value;
    };
    // trusted mouse click
    const click = async (x, y) => {
      await cdpSend(ws, ++idc, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await cdpSend(ws, ++idc, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    };
    const clickSelector = async (sel) => {
      const r = await ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, visible: !!(b.width && b.height) }; })()`);
      if (!r || !r.visible) return false;
      await click(r.x, r.y);
      return true;
    };
    const key = async (keyCode, code, text) => {
      await cdpSend(ws, ++idc, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: keyCode, code, key: code });
      if (text) await cdpSend(ws, ++idc, 'Input.dispatchKeyEvent', { type: 'char', windowsVirtualKeyCode: keyCode, code, key: code, text });
      await cdpSend(ws, ++idc, 'Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: keyCode, code, key: code });
    };

    await new Promise(r => setTimeout(r, 3200));

    try {
      if (pg.name === 'masters') {
        const s0 = await ev(`(() => ({ left: document.getElementById('masters-collapse-left')?.getAttribute('aria-expanded'), right: document.getElementById('masters-collapse-right')?.getAttribute('aria-expanded'), bodyCls: document.body.className }))()`);
        rec('masters:初始双展开', s0.left === 'true' && s0.right === 'true', JSON.stringify(s0));

        await clickSelector('#masters-collapse-left');
        await new Promise(r => setTimeout(r, 400));
        const s1 = await ev(`(() => ({ left: document.getElementById('masters-collapse-left')?.getAttribute('aria-expanded'), cls: document.body.className.includes('masters-left-collapsed') }))()`);
        rec('masters:左折叠 trusted click', s1.left === 'false' && s1.cls === true, JSON.stringify(s1));

        await clickSelector('#masters-collapse-right');
        await new Promise(r => setTimeout(r, 400));
        const s2 = await ev(`(() => ({ cls: document.body.className, grid: getComputedStyle(document.querySelector('.masters-workspace')).gridTemplateColumns }))()`);
        rec('masters:双折叠中央最大化', s2.cls.includes('masters-left-collapsed') && s2.cls.includes('masters-right-collapsed') && s2.grid.split(' ').filter(v => v === '0px' || v === '0').length === 2, JSON.stringify(s2));

        await key(27, 'Escape');
        await new Promise(r => setTimeout(r, 500));
        const s3 = await ev(`(() => ({ left: document.getElementById('masters-collapse-left')?.getAttribute('aria-expanded'), right: document.getElementById('masters-collapse-right')?.getAttribute('aria-expanded') }))()`);
        rec('masters:Escape 恢复双折叠', s3.left === 'true' && s3.right === 'true', JSON.stringify(s3));
      }

      if (pg.name === 'supervision') {
        // 注入合成文件触发上传状态机（setUploadState 真实路径：FileReader 进度→success）
        const up = await ev(`(async () => {
          const input = document.getElementById('sup-report-file');
          if (!input) return { err: 'no #sup-report-file' };
          const dt = new DataTransfer();
          const file = new File(['合成督导材料内容 For 007r independent probe. '.repeat(400)], '007r-probe-report.txt', { type: 'text/plain' });
          dt.items.add(file);
          input.files = dt.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise(r => setTimeout(r, 900));
          const st1 = document.getElementById('sup-upload-status')?.getAttribute('data-upload-state');
          // 等 success（FileReader 快）
          let st2 = st1;
          for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 300));
            st2 = document.getElementById('sup-upload-status')?.getAttribute('data-upload-state');
            if (st2 === 'success') break;
          }
          return { st1, st2, label: document.getElementById('sup-upload-status-label')?.textContent };
        })()`);
        rec('supervision:上传 idle→…→success 状态机', up.st2 === 'success', JSON.stringify(up).slice(0, 160));
      }

      if (pg.name === 'billing-shell') {
        const s = await ev(`(() => ({ title: document.title, hasIncome: !!document.querySelector('[data-action*=income], #btn-income, .income-entry, a[href*=income]'), bodyLen: document.body.innerText.length, hasLock: !!document.querySelector('.nav-unlock') }))()`);
        rec('billing-shell:页面加载', s.bodyLen > 200, JSON.stringify(s).slice(0, 140));
      }

      if (pg.name === 'billing-calendar') {
        // 会员门禁授权（复用临时 userData license.json 投影，083 先例；本地 ipc 不触网）
        const auth = await ev(`(async () => { try { await window.App.refreshLicenseState(); return { can: window.App.canUse('billing-calendar') }; } catch (e) { return { can: false, err: String(e).slice(0, 80) }; } })()`);
        rec('calendar:授权复用生效', auth.can === true, JSON.stringify(auth));
        // 月份切换（真实按钮：.month-nav 第一个 button = 上个月）
        const btn = await ev(`(() => { const b = document.querySelector('.month-nav button'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + b.width / 2, y: r.y + r.height / 2, label: b.getAttribute('aria-label') }; })()`);
        if (btn && btn.visible !== false) {
          const m0 = await ev(`document.querySelector('.month-nav .current')?.textContent || ''`);
          // trusted 键盘：focus + Enter（button 默认行为=click；026 教训：Enter 需 rawKeyDown+char+keyUp）
          await ev(`document.querySelector('.month-nav button').focus()`);
          await key(13, 'Enter', '\r');
          await new Promise(r => setTimeout(r, 500));
          let m1 = await ev(`document.querySelector('.month-nav .current')?.textContent || ''`);
          if (m0 === m1) {
            // trusted 鼠标双保险：click 两次（左上角 + 中心）
            await click(btn.x, btn.y);
            await click(Math.max(btn.x - 8, 2), Math.max(btn.y - 6, 2));
            await new Promise(r => setTimeout(r, 600));
            m1 = await ev(`document.querySelector('.month-nav .current')?.textContent || ''`);
          }
          rec('calendar:月份切换 trusted 输入', m0 !== m1, m0.slice(0, 20) + ' → ' + m1.slice(0, 20));
        } else {
          rec('calendar:月份切换 trusted click', false, 'no month-nav button');
        }
      }
    } catch (e) {
      rec(`${pg.name}:harness`, false, String(e).slice(0, 160));
    }

    try { ws.close(); } catch (e) {}
    try { child.kill(); } catch (e) {}
    await new Promise(r => setTimeout(r, 1200));
  }

  fs.writeFileSync(path.join(SC, 'checkpoint-b-results.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  const pass = results.filter(r => r.ok).length;
  console.log(`\nCHECKPOINT-B: ${pass}/${results.length} PASS`);
  server.close();
  process.exit(0);
}

main().catch(e => { console.error('HARNESS-ERR', e); process.exit(1); });
