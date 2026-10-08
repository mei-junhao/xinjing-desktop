'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../../..');
const source = path.join(ROOT, 'qa/task-scratch/XJ-5.1.0-pi-workbench-candidate-no-context-independent-review-048/evidence');
const scratch = path.join(ROOT, 'qa/task-scratch/XJ-5.1.0-pi-workbench-mainline-merge-and-candidate-rebind-049');
const evidence = path.join(scratch, 'evidence');
const oldTask = 'XJ-5.1.0-pi-workbench-candidate-no-context-independent-review-048';
const newTask = 'XJ-5.1.0-pi-workbench-mainline-merge-and-candidate-rebind-049';
fs.mkdirSync(evidence, { recursive: true });
const mappings = {
  'harness.html': 'harness.html',
  'electron-tests.js': 'electron-tests-049.js',
  'test-electron-main.js': 'test-electron-main-049.js',
  'adversarial-048.js': 'adversarial-049.js',
  'evidence-verifier-048.js': 'evidence-verifier-049.js'
};
for (const [from, to] of Object.entries(mappings)) {
  let s = fs.readFileSync(path.join(source, from), 'utf8');
  s = s.split(oldTask).join(newTask);
  s = s.split('pi-workbench-046').join('pi-workbench-049');
  s = s.split('pi-workbench-candidate-no-context-independent-review-048').join('pi-workbench-mainline-merge-and-candidate-rebind-049');
  s = s.split('electron-tests.js').join('electron-tests-049.js');
  s = s.split('test-electron-main.js').join('test-electron-main-049.js');
  s = s.split('adversarial-048.js').join('adversarial-049.js');
  s = s.split('adversarial-048.json').join('adversarial-049.json');
  s = s.split('evidence-verifier-048.js').join('evidence-verifier-049.js');
  s = s.split('048').join('049');
  s = s.split('XJ-5.1.0-pi-workbench-candidate-no-context-independent-review-048').join(newTask);
  s = s.split('xj_task_048').join('xj_task_049');
  s = s.split('svc:048').join('svc:049');
  s = s.split('c_048').join('c_049');
  s = s.split('s_048').join('s_049');
  s = s.split('sourceId: \'svc:049\'').join('sourceId: \'svc:049\'');
  fs.writeFileSync(path.join(evidence, to), s, 'utf8');
}
console.log(JSON.stringify({ scratch, evidence, files: Object.values(mappings) }, null, 2));
