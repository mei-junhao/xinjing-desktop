'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const path = require('path');

const runner = path.join(__dirname, 'run-contract.js');
const mutants = [
  'admit-unverified',
  'admit-non-material',
  'expose-source-body',
  'accept-stale-projection',
  'bypass-deep-link-validation'
];

let killed = 0;
for (const mutant of mutants) {
  const result = childProcess.spawnSync(process.execPath, [runner], {
    env: Object.assign({}, process.env, { XJ_ATLAS_MUTANT: mutant }),
    encoding: 'utf8'
  });
  assert.notStrictEqual(result.status, 0, 'mutation survived: ' + mutant + '\n' + result.stdout + result.stderr);
  killed += 1;
}

process.stdout.write('doc-center-atlas mutations: ' + killed + '/' + mutants.length + ' killed\n');
