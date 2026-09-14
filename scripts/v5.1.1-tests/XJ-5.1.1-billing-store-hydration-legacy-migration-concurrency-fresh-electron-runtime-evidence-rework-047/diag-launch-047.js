'use strict';
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const root = 'D:/xinjing-electron';
const fixture = path.join(root, 'scripts/v5.1.1-tests/XJ-5.1.1-billing-store-hydration-legacy-migration-concurrency-fresh-electron-runtime-evidence-rework-047/fixture-047');
const electron = path.join(root, 'node_modules/electron/dist/electron.exe');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-047-diag-'));
const port = 25126;
const argv = ['--disable-gpu', '--no-sandbox', `--user-data-dir=${userData}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, '--remote-allow-origins=*', fixture];
const child = cp.spawn(electron, argv, { cwd: root, env: { ...process.env, XJ_FIXTURE_URL: 'http://127.0.0.1:19421/fixture-047/store-fixture.html' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let out = '';
let err = '';
child.stdout.on('data', b => { out += b.toString(); });
child.stderr.on('data', b => { err += b.toString(); });
console.log(JSON.stringify({ pid: child.pid, argv, userData }));
function check() {
  const req = http.get(`http://127.0.0.1:${port}/json/list`, { timeout: 2000 }, res => {
    let body = '';
    res.on('data', b => { body += b.toString(); });
    res.on('end', () => { console.log('JSON', body); finish(); });
  });
  req.on('error', e => { console.log('JSON_ERROR', e.message, 'OUT', JSON.stringify(out), 'ERR', JSON.stringify(err)); finish(); });
  req.on('timeout', () => req.destroy(new Error('timeout')));
}
function finish() { try { child.kill(); } catch (_) {} setTimeout(() => process.exit(0), 500); }
setTimeout(check, 5000);
setTimeout(() => { console.log('TIMEOUT', JSON.stringify({ out, err })); finish(); }, 10000);
child.on('exit', (code, signal) => console.log('EXIT', code, signal));
