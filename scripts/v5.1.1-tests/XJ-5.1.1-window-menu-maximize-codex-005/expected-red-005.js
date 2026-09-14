'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const base = require('./run-contract-005');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MAIN = path.join(ROOT, 'main.js');
const SCRATCH = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-window-menu-maximize-codex-005');
const source = base.helperSource(fs.readFileSync(MAIN, 'utf8'));
const mutations = [
  {
    id: 'M1-delete-maximize-click',
    source: source.replace("click: () => toggleFocusedNormalWindowMaximize()", 'click: null')
  },
  {
    id: 'M2-reverse-restore-condition',
    source: source.replace('if (wasMaximized) focusedWindow.restore();', 'if (!wasMaximized) focusedWindow.restore();')
  },
  {
    id: 'M3-quit-side-effect',
    source: source.replace('const wasMaximized = focusedWindow.isMaximized();', "prepareAppQuit('mutation');\n  const wasMaximized = focusedWindow.isMaximized();")
  }
];

function main() {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const results = mutations.map(mutation => {
    let failed = false;
    try { base.execute(mutation.source); } catch (_) { failed = true; }
    return { id: mutation.id, killed: failed };
  });
  const killed = results.filter(item => item.killed).length;
  const out = { task_id: 'XJ-5.1.1-window-menu-maximize-codex-005', mutations: results, killed, total: results.length, result: killed === results.length ? 'PASS' : 'FAIL' };
  fs.writeFileSync(path.join(SCRATCH, 'expected-red-005.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`WINDOW_MENU_005_EXPECTED_RED: ${killed}/${results.length} KILLED`);
  if (killed !== results.length) process.exitCode = 2;
}

if (require.main === module) main();
