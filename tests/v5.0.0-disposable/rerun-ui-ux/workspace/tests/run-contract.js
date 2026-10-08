'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { ROUTES, STATES } = require('./fixture');

const PROJECT_ROOT = path.resolve(__dirname, '../../../../../');
const TASK_ID = 'XJ-5.0.0-full-ui-ux-review-successor-391';
const RUN_ROOT = path.join(PROJECT_ROOT, 'docs/agent-coordination/v5.0.0/cli-coordination/runs', TASK_ID, 'workspace');
const PROTOTYPE_ROOT = path.join(PROJECT_ROOT, 'design-previews/5.0.0-rerun-ui-ux');
const EVIDENCE_ROOT = path.join(RUN_ROOT, 'evidence');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function read(filePath) { return fs.readFileSync(filePath, 'utf8'); }
function relative(filePath) { return path.relative(PROJECT_ROOT, filePath).replaceAll(path.sep, '/'); }
function checkNode(filePath) {
  const result = spawnSync(process.execPath, ['--check', filePath], { encoding: 'utf8' });
  assert(result.status === 0, `NODE_CHECK_FAILED ${relative(filePath)} ${result.stderr.trim()}`);
}

function main() {
  const manifestPath = path.join(RUN_ROOT, 'input/INPUT_MANIFEST.json');
  const reportPath = path.join(RUN_ROOT, 'delivery/DELIVERY_REPORT.md');
  const manifest = JSON.parse(read(manifestPath));
  assert(manifest.task_id === TASK_ID, 'MANIFEST_TASK_MISMATCH');
  assert(manifest.checkpoint === 'A', 'MANIFEST_CHECKPOINT_MISMATCH');
  assert(manifest.base_commit === '9971787eb6e443ab5a5c80aee118b9b43285c093', 'MANIFEST_BASE_MISMATCH');
  assert(manifest.files.filter((file) => file.role === 'route-html').length === 22, 'ROUTE_MANIFEST_COUNT');
  assert(manifest.files.filter((file) => file.role === 'referenced-ui-asset').length === 55, 'ASSET_MANIFEST_COUNT');
  for (const file of manifest.files) {
    const absolute = path.join(PROJECT_ROOT, file.path);
    assert(fs.existsSync(absolute), `MANIFEST_FILE_MISSING ${file.path}`);
    assert(sha256(absolute) === file.sha256, `MANIFEST_HASH_MISMATCH ${file.path}`);
    assert(fs.statSync(absolute).size === file.bytes, `MANIFEST_BYTE_MISMATCH ${file.path}`);
  }

  const html = read(path.join(PROTOTYPE_ROOT, 'index.html'));
  const css = read(path.join(PROTOTYPE_ROOT, 'prototype.css'));
  const js = read(path.join(PROTOTYPE_ROOT, 'prototype.js'));
  assert(html.includes('<main class="route-view"'), 'PROTOTYPE_MAIN_MISSING');
  assert(html.includes('lang="zh-CN"'), 'PROTOTYPE_LANG_MISSING');
  assert(html.includes('prototype.css') && html.includes('prototype.js'), 'PROTOTYPE_LOCAL_ASSETS_MISSING');
  assert(!/(?:https?:)?\/\//.test(html + css + js), 'PROTOTYPE_EXTERNAL_REFERENCE');
  for (const route of ROUTES) assert(js.includes(`file: '${route}'`), `PROTOTYPE_ROUTE_MISSING ${route}`);
  for (const state of STATES) assert(js.includes(`'${state}'`), `PROTOTYPE_STATE_MISSING ${state}`);
  for (const action of ['open-context', 'close-context', 'save-note', 'begin-session', 'toggle-motion', 'view-plans']) assert(js.includes(`'${action}'`), `PROTOTYPE_ACTION_MISSING ${action}`);
  assert(/prefers-reduced-motion|reduced-motion/.test(css + js), 'REDUCED_MOTION_CONTRACT_MISSING');
  assert(/1024px|1024/.test(css), 'NARROW_VIEWPORT_CONTRACT_MISSING');
  assert(/aria-label|aria-live|aria-modal/.test(html + js), 'ARIA_CONTRACT_MISSING');
  checkNode(path.join(PROTOTYPE_ROOT, 'prototype.js'));
  for (const file of ['fixture.js', 'browser-cdp.js', 'run-contract.js', 'run-browser-matrix.js', 'interaction-probes.js', 'mutation-probes.js', 'capture-acceptance.js', 'verify-artifacts.js']) checkNode(path.join(__dirname, file));

  const reportLastLine = read(reportPath).trimEnd().split(/\r?\n/).at(-1);
  assert(reportLastLine === 'DELIVERY_REPORT: D:/xinjing-electron/docs/agent-coordination/v5.0.0/cli-coordination/runs/XJ-5.0.0-full-ui-ux-review-successor-391/workspace/delivery/DELIVERY_REPORT.md', 'DELIVERY_REPORT_LAST_LINE');

  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
  const result = {
    task_id: TASK_ID,
    status: 'PASS',
    manifest_files_verified: manifest.files.length,
    routes_verified: ROUTES.length,
    states_verified: STATES,
    prototype_files: ['design-previews/5.0.0-rerun-ui-ux/index.html', 'design-previews/5.0.0-rerun-ui-ux/prototype.css', 'design-previews/5.0.0-rerun-ui-ux/prototype.js'],
    browser_gate: 'deferred to run-browser-matrix.js; no browser result inferred here'
  };
  fs.writeFileSync(path.join(EVIDENCE_ROOT, 'contract-results.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(`CONTRACT PASS routes=${ROUTES.length} manifest_files=${manifest.files.length}`);
}

try { main(); } catch (error) { console.error(`CONTRACT FAIL: ${error.message}`); process.exitCode = 1; }
