'use strict';
// Task 294: produce a readable diff of candidate files vs the immutable input snapshot.
const fs = require('fs');
const path = require('path');
const WORKSPACE = path.resolve(__dirname, '..');
const candidateRoot = path.join(WORKSPACE, 'candidate', 'repo');
const inputRoot = path.join(WORKSPACE, 'input', 'candidate', 'repo');
const files = [
  'app/js/clinical-context.js',
  'app/js/clinical-task-validators.js',
  'app/js/source-ref.js',
  'app/js/prompt-governance.js',
  'app/js/longitudinal-summary.js',
  'app/js/agent-core.js',
];
function splitLines(text) { return text.split(/\r?\n/); }
function lcsDiff(a, b) {
  // Simple Myers-ish LCS diff limited to the small candidate change set.
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push('  ' + a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push('- ' + a[i]); i++; }
    else { out.push('+ ' + b[j]); j++; }
  }
  while (i < m) { out.push('- ' + a[i]); i++; }
  while (j < n) { out.push('+ ' + b[j]); j++; }
  return out;
}
let changed = 0;
for (const rel of files) {
  const before = fs.readFileSync(path.join(inputRoot, rel), 'utf8');
  const after = fs.readFileSync(path.join(candidateRoot, rel), 'utf8');
  if (before === after) { console.log('=== UNCHANGED ' + rel); continue; }
  changed++;
  console.log('=== CHANGED ' + rel);
  console.log(lcsDiff(splitLines(before), splitLines(after)).join('\n'));
}
console.log('=== changed_files=' + changed);
