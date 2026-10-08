'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const runner = path.join(__dirname, 'run-contract.js');
const originals = {
  quick: fs.readFileSync(path.join(ROOT, 'app', 'js', 'quick-record.js'), 'utf8'),
  dashboard: fs.readFileSync(path.join(ROOT, 'app', 'js', 'dashboard.js'), 'utf8'),
  index: fs.readFileSync(path.join(ROOT, 'app', 'index.html'), 'utf8'),
  css: fs.readFileSync(path.join(ROOT, 'app', 'css', 'workbench-home.css'), 'utf8')
};

const mutations = [
  ['remove session await', 'quick', 'result = await Store.createSessionDurable(payload);', 'result = Store.createSessionDurable(payload);'],
  ['remove template await', 'quick', 'templateResult = await Store.saveSessionTemplateSelectionDurable(session.id, completion.selection);', 'templateResult = Store.saveSessionTemplateSelectionDurable(session.id, completion.selection);'],
  ['remove task await', 'quick', 'taskResult = await Store.saveClinicalTasksDurable(completion.tasks);', 'taskResult = Store.saveClinicalTasksDurable(completion.tasks);'],
  ['swallow template failure', 'quick', "if (!templateResult || !templateResult.ok) return completionFailure('XJ_QR_TEMPLATE_SAVE_FAILED', templateResult);", "if (false) return completionFailure('XJ_QR_TEMPLATE_SAVE_FAILED', templateResult);"],
  ['swallow task failure', 'quick', "if (!taskResult || !taskResult.ok) return completionFailure('XJ_QR_TASK_SAVE_FAILED', taskResult);", "if (false) return completionFailure('XJ_QR_TASK_SAVE_FAILED', taskResult);"],
  ['skip completion retry', 'quick', 'if (existing && state.completionDraft) {', 'if (false && existing && state.completionDraft) {'],
  ['clear retry bundle on failure', 'quick', "return completionFailure('XJ_QR_TASK_SAVE_FAILED', taskResult);", "state.completionDraft = null; return completionFailure('XJ_QR_TASK_SAVE_FAILED', taskResult);"],
  ['allow excessive task list', 'quick', 'if (titles.length > 5 || titles.some(function (title) { return title.length > 160; })) return { ok: false };', 'if (false) return { ok: false };'],
  ['allow unsafe dashboard target', 'dashboard', "task.target === 'consult-notes.html' ? routeFor('consult-notes.html', task.clientId, task.originSessionId) : ''", "task.target ? routeFor(task.target, task.clientId, task.originSessionId) : ''"],
  ['remove task completion await', 'dashboard', "result = await Store.transitionClinicalTaskDurable(id, 'done');", "result = Store.transitionClinicalTaskDurable(id, 'done');"],
  ['remove task ViewModel script', 'index', '<script src="js/clinical-task-view-model.js"></script>', ''],
  ['remove task UI style', 'css', '.qr-task-titles { min-height: 76px; }', '']
];

let killed = 0;
for (const mutation of mutations) {
  const [name, target, before, after] = mutation;
  const changed = originals[target].replace(before, after);
  if (changed === originals[target]) {
    process.stderr.write('NO-OP: ' + name + '\n');
    continue;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-qr-mutation-'));
  try {
    const files = {};
    for (const key of Object.keys(originals)) {
      files[key] = path.join(dir, key + (key === 'index' ? '.html' : key === 'css' ? '.css' : '.js'));
      fs.writeFileSync(files[key], key === target ? changed : originals[key], 'utf8');
    }
    const run = spawnSync(process.execPath, [runner], {
      cwd: ROOT,
      encoding: 'utf8',
      env: Object.assign({}, process.env, {
        XJ_QR_SOURCE: files.quick,
        XJ_DASHBOARD_SOURCE: files.dashboard,
        XJ_INDEX_SOURCE: files.index,
        XJ_CSS_SOURCE: files.css
      })
    });
    if (run.status !== 0) {
      killed += 1;
      process.stdout.write('KILLED: ' + name + '\n');
    } else {
      process.stderr.write('SURVIVED: ' + name + '\n');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (killed !== mutations.length) {
  process.stderr.write('mutation probes: FAIL ' + killed + '/' + mutations.length + ' killed\n');
  process.exit(1);
}
process.stdout.write('mutation probes: PASS ' + killed + '/' + mutations.length + ' killed\n');
