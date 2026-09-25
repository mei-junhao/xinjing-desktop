'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const SCRIPT = path.resolve(__dirname, '..', '..', 'tools', 'opencode', 'bridge', 'opencode-api-watch.js');
const POWERSHELL_WRAPPER = path.resolve(__dirname, '..', '..', 'tools', 'opencode', 'bridge', 'opencode-api-watch.ps1');
const { parseApiResponse } = require(SCRIPT);

function runWatcher(flag, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, flag], { env, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 5_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`opencode watcher ${flag} failed to start: ${error.message}`, { cause: error }));
    });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      if (signal) reject(new Error(`opencode watcher ${flag} terminated by ${signal}; stderr: ${stderr}`));
      else resolve({ status, stdout, stderr });
    });
  });
}

test('watcher source contains no embedded app secret', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  const wrapper = fs.readFileSync(POWERSHELL_WRAPPER, 'utf8');
  assert.doesNotMatch(source, /const\s+APP_SECRET\s*=\s*['"][^'"]+['"]/);
  assert.doesNotMatch(wrapper, /appSecret\s*=|app_secret\s*=/i);
  assert.match(wrapper, /opencode-api-watch\.js/);
});

test('watcher fails before network access when credentials are absent', async (t) => {
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-opencode-config-'));
  t.after(() => fs.rmSync(localAppData, { recursive: true, force: true }));
  const result = await runWatcher('--once', {
    ...process.env,
    LOCALAPPDATA: localAppData,
    XJ_OPENCODE_APP_ID: '',
    XJ_OPENCODE_APP_SECRET: '',
    XJ_OPENCODE_CREDENTIALS_FILE: path.join(localAppData, 'missing.json'),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /credential/i);
  assert.doesNotMatch(result.stderr, /tenant_access_token|open-apis/i);
});

test('watcher rejects HTTP and business-level API failures', () => {
  assert.throws(() => parseApiResponse(503, '{}'), /HTTP_503/);
  assert.throws(() => parseApiResponse(200, JSON.stringify({ code: 999, msg: 'synthetic' })), /API_CODE_999/);
  assert.throws(() => parseApiResponse(200, 'not-json'), /INVALID_JSON_RESPONSE/);
});

test('dry-run does not require credentials or network access', async (t) => {
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-opencode-dry-run-'));
  t.after(() => fs.rmSync(localAppData, { recursive: true, force: true }));
  const result = await runWatcher('--dry-run', { ...process.env, LOCALAPPDATA: localAppData });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.seen, 0);
  assert.equal(output.queued, 0);
});
