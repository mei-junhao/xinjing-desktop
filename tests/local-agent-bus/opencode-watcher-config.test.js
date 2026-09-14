'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const SCRIPT = path.resolve(__dirname, '..', '..', 'tools', 'opencode', 'bridge', 'opencode-api-watch.js');
const POWERSHELL_WRAPPER = path.resolve(__dirname, '..', '..', 'tools', 'opencode', 'bridge', 'opencode-api-watch.ps1');
const { parseApiResponse } = require(SCRIPT);

test('watcher source contains no embedded app secret', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  const wrapper = fs.readFileSync(POWERSHELL_WRAPPER, 'utf8');
  assert.doesNotMatch(source, /const\s+APP_SECRET\s*=\s*['"][^'"]+['"]/);
  assert.doesNotMatch(wrapper, /appSecret\s*=|app_secret\s*=/i);
  assert.match(wrapper, /opencode-api-watch\.js/);
});

test('watcher fails before network access when credentials are absent', (t) => {
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-opencode-config-'));
  t.after(() => fs.rmSync(localAppData, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [SCRIPT, '--once'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      LOCALAPPDATA: localAppData,
      XJ_OPENCODE_APP_ID: '',
      XJ_OPENCODE_APP_SECRET: '',
      XJ_OPENCODE_CREDENTIALS_FILE: path.join(localAppData, 'missing.json'),
    },
    timeout: 5_000,
    windowsHide: true,
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

test('dry-run does not require credentials or network access', (t) => {
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-opencode-dry-run-'));
  t.after(() => fs.rmSync(localAppData, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [SCRIPT, '--dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, LOCALAPPDATA: localAppData },
    timeout: 5_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.seen, 0);
  assert.equal(output.queued, 0);
});
