'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const runner = path.join(__dirname, 'run-contract.js');
const original = fs.readFileSync(path.join(ROOT, 'app', 'js', 'dashboard.js'), 'utf8');
const mutations = [
  ['remove durable confirmation await', 'await Store.confirmClinicalTaskDurable(id)', 'Store.confirmClinicalTaskDurable(id)'],
  ['replace confirmation with done transition', 'Store.confirmClinicalTaskDurable(id)', "Store.transitionClinicalTaskDurable(id, 'done')"],
  ['swallow durable confirmation failure', 'if (!result || !result.ok) {', 'if (false) {'],
  ['bypass pending projection guard', "task.status === 'open' || task.status === 'ai-draft'", "task.status === 'open' || true"],
  ['remove confirmation action identity', 'data-task-confirm=', 'data-task-complete='],
];

let killed = 0;
const results = [];
for (const [name, before, after] of mutations) {
  const changed = original.replace(before, after);
  if (changed === original) {
    results.push({ name, status: 'NO_OP' });
    continue;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-ai-draft-mutation-'));
  const source = path.join(dir, 'dashboard.js');
  const output = path.join(dir, 'contract-result.json');
  fs.writeFileSync(source, changed, 'utf8');
  try {
    const run = spawnSync(process.execPath, [runner], {
      cwd: ROOT,
      encoding: 'utf8',
      env: Object.assign({}, process.env, { XJ_DASHBOARD_SOURCE: source, XJ_CONTRACT_RESULT: output }),
    });
    const status = run.status === 0 ? 'SURVIVED' : 'KILLED';
    results.push({ name, status, exit_code: run.status });
    if (status === 'KILLED') killed += 1;
    process.stdout.write(status + ': ' + name + '\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const result = {
  schema_version: 1,
  task_id: 'XJ-5.0.0-codex-v4.3-ai-draft-confirmation-dashboard-30',
  total: mutations.length,
  killed,
  survived: mutations.length - killed,
  results,
};
if (results.some((item) => item.status === 'NO_OP') || killed !== mutations.length) {
  process.stderr.write('mutation probes: FAIL ' + killed + '/' + mutations.length + ' killed\n');
  process.exitCode = 1;
} else {
  process.stdout.write('mutation probes: PASS ' + killed + '/' + mutations.length + ' killed\n');
}
fs.writeFileSync(path.join(__dirname, 'mutation-result.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
