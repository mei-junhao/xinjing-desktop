'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const runner = path.join(__dirname, 'run-contract.js');
const healthyJs = fs.readFileSync(path.join(ROOT, 'app', 'js', 'consult-notes.js'), 'utf8');
const healthyHtml = fs.readFileSync(path.join(ROOT, 'app', 'consult-notes.html'), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-later-session-mutations-'));

function execute(js, html) {
  const jsPath = path.join(temp, 'consult-' + Math.random().toString(16).slice(2) + '.js');
  const htmlPath = path.join(temp, 'consult-' + Math.random().toString(16).slice(2) + '.html');
  fs.writeFileSync(jsPath, js, 'utf8');
  fs.writeFileSync(htmlPath, html, 'utf8');
  return cp.spawnSync(process.execPath, [runner], {
    cwd: ROOT,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { XJ_LATER_SESSION_JS: jsPath, XJ_LATER_SESSION_HTML: htmlPath })
  });
}

const baseline = execute(healthyJs, healthyHtml);
if (baseline.status !== 0) {
  process.stderr.write('[HARNESS_ERROR] healthy baseline failed\n' + baseline.stdout + baseline.stderr);
  fs.rmSync(temp, { recursive: true, force: true });
  process.exit(1);
}

const probes = [
  ['M01-later-session-disabled', 'C05-later-session-option', (js) => js.replace('{ allowLaterSession: true }', '{ allowLaterSession: false }')],
  ['M02-all-client-store-read', 'C04-same-client-store-read', (js) => js.replace('Store.getClinicalTasksByClient(currentClientId)', 'Store.getClinicalTasks()')],
  ['M03-origin-session-cleared', 'C06-origin-retained', (js) => js.replace('task.originSessionId === currentSessionId', "'' === currentSessionId")],
  ['M04-origin-client-gate-removed', 'C07-origin-client-gate', (js) => js.replace("String(origin.clientId || '') !== currentClientId", 'false')],
  ['M05-title-escape-removed', 'C08-safe-title-render', (js) => js.replace('App.escapeHtml(task.title)', 'task.title')],
  ['M06-ai-draft-label-removed', 'C09-ai-draft-visible-state', (js) => js.replace(/task\.status === 'ai-draft'/g, 'false')],
  ['M07-stale-clear-removed', 'C10-stale-dom-cleared', (js) => js.replace("list.innerHTML = '';", '')],
  ['M08-session-rerender-removed', 'C11-session-change-rerenders', (js) => js.replace(/renderClinicalTaskContext\(\);/g, '')],
  ['M09-current-session-gate-removed', 'C12-current-session-gate', (js) => js.replace("String(selectedSession.clientId || '') !== currentClientId", 'false')],
  ['M10-viewmodel-script-removed', 'C13-script-order', (js, html) => [js, html.replace('<script src="js/clinical-task-view-model.js"></script>', '')]],
  ['M11-aria-live-removed', 'C14-accessible-region', (js, html) => [js, html.replace(' aria-live="polite"', '')]],
  ['M12-long-wrap-removed', 'C15-long-title-wrap', (js, html) => [js, html.replace('overflow-wrap:anywhere', 'overflow-wrap:normal')]]
];

let killed = 0;
try {
  probes.forEach(([id, expected, mutate]) => {
    const changed = mutate(healthyJs, healthyHtml);
    const js = Array.isArray(changed) ? changed[0] : changed;
    const html = Array.isArray(changed) ? changed[1] : healthyHtml;
    const run = execute(js, html);
    const output = String(run.stdout || '') + String(run.stderr || '');
    const target = run.status !== 0 && output.includes('[FAIL] ' + expected + ':');
    process.stdout.write((target ? '[KILLED] ' : '[SURVIVED] ') + id + ' target=' + expected + ' exit=' + run.status + '\n');
    if (target) killed += 1;
  });
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

process.stdout.write('later-session mutations: ' + killed + '/' + probes.length + ' killed\n');
process.exit(killed === probes.length ? 0 : 1);
