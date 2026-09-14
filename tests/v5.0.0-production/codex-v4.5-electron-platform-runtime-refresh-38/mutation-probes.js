'use strict';

const childProcess = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const RUNNER = path.join(__dirname, 'run-electron-runtime-regression.js');
const mutations = [
  'wrong-electron-version',
  'missing-temp-sentinel',
  'skip-page-reload',
  'accept-forged-selection',
  'allow-nonacceptance-updater-call',
  'drop-installer-boundary',
];

let failures = 0;
for (const mutation of mutations) {
  const result = childProcess.spawnSync(process.execPath, [RUNNER], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { XJ_ELECTRON_RUNTIME_MUTATION: mutation }),
    encoding: 'utf8',
    timeout: 120000,
  });
  const killed = result.status !== 0;
  console.log('[' + (killed ? 'KILLED' : 'SURVIVED') + '] ' + mutation + (result.status === null ? ' timeout=' + result.signal : ' exit=' + result.status));
  if (!killed) failures += 1;
}

if (failures) {
  console.error('Mutation failures: ' + failures);
  process.exit(1);
}
console.log('Mutation probes: ' + mutations.length + '/' + mutations.length + ' killed');
