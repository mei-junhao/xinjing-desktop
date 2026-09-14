'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..', '..');
const sourcePath = path.join(root, 'app', 'js', 'privacy-observability-core.js');
const runnerPath = path.join(__dirname, 'run-contract.js');
const scratch = path.join(__dirname, '.mutation-tmp');
const original = fs.readFileSync(sourcePath, 'utf8');

function replaceExact(source, before, after) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`Expected one mutation target, found ${count}: ${before}`);
  return source.replace(before, after);
}

const mutations = [
  {
    name: 'default-enabled',
    apply: (source) => replaceExact(source, 'var enabled = false; // MUTATION: default-disabled', 'var enabled = true; // MUTATION: default-disabled'),
  },
  {
    name: 'revoke-without-clear',
    apply: (source) => replaceExact(source, 'records = []; // MUTATION: revoke-clears', 'records = records; // MUTATION: revoke-clears'),
  },
  {
    name: 'extra-field-accepted',
    apply: (source) => replaceExact(
      replaceExact(source, 'if (keys.length !== INPUT_FIELDS.length) return invalidEvent(); // MUTATION: exact-fields', 'if (keys.length < INPUT_FIELDS.length) return invalidEvent(); // MUTATION: exact-fields'),
      'if (INPUT_FIELDS.indexOf(key) === -1) return invalidEvent();',
      'if (false) return invalidEvent();'
    ),
  },
  {
    name: 'unknown-error-code-accepted',
    apply: (source) => replaceExact(source, "if (ERROR_CODES.indexOf(values.errorCode) === -1) return invalidEvent('unknown-error-code'); // MUTATION: error-registry", "if (false) return invalidEvent('unknown-error-code'); // MUTATION: error-registry"),
  },
  {
    name: 'invalid-clock-accepted',
    apply: (source) => replaceExact(source, 'if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CLOCK_MS) return null; // MUTATION: clock-validation', 'if (false) return null; // MUTATION: clock-validation'),
  },
  {
    name: 'capacity-overflow-retained',
    apply: (source) => replaceExact(source, 'while (records.length > capacity) records.shift(); // MUTATION: capacity', 'while (false) records.shift(); // MUTATION: capacity'),
  },
  {
    name: 'internal-record-alias-returned',
    apply: (source) => replaceExact(source, 'records: records.map(function (entry) { return copyRecord(entry.value); }),', 'records: records.map(function (entry) { return entry.value; }),'),
  },
  {
    name: 'safe-public-boundary-removed',
    apply: (source) => replaceExact(source, "function safeCall(work) {\n    try { return work(); } catch (_) { return fail('internal-failure'); }\n  }", 'function safeCall(work) {\n    return work();\n  }'),
  },
  {
    name: 'plain-object-gate-bypassed',
    apply: (source) => replaceExact(source, 'return proto === Object.prototype || proto === null; // MUTATION: plain-object', 'return true; // MUTATION: plain-object'),
  },
  {
    name: 'option-extra-field-accepted',
    apply: (source) => replaceExact(source, "if (allowedKeys.indexOf(key) === -1) return { ok: false, errorCode: invalidCode };", 'if (false) return { ok: false, errorCode: invalidCode };'),
  },
  {
    name: 'consent-bypass',
    apply: (source) => replaceExact(source, "if (!enabled) return fail('consent-required'); // MUTATION: record-consent", "if (false) return fail('consent-required'); // MUTATION: record-consent"),
  },
  {
    name: 'clear-does-not-clear',
    apply: (source) => replaceExact(source, "        clear: function () {\n          return safeCall(function () {\n            var cleared = records.length;\n            records = [];\n            return succeed({ cleared: cleared });\n          });\n        },", "        clear: function () {\n          return safeCall(function () {\n            var cleared = records.length;\n            records = records;\n            return succeed({ cleared: cleared });\n          });\n        },"),
  },
  {
    name: 'record-returns-internal-alias',
    apply: (source) => replaceExact(source, 'return succeed(copyRecord(recordValue)); // MUTATION: isolated-return', 'return succeed(recordValue); // MUTATION: isolated-return'),
  },
];

fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });

const results = [];
try {
  for (let index = 0; index < mutations.length; index += 1) {
    const mutation = mutations[index];
    const candidatePath = path.join(scratch, `privacy-observability-core-${index + 1}.js`);
    fs.writeFileSync(candidatePath, mutation.apply(original), 'utf8');
    const child = spawnSync(process.execPath, [runnerPath], {
      cwd: root,
      env: Object.assign({}, process.env, { MODULE_UNDER_TEST: candidatePath }),
      encoding: 'utf8',
      timeout: 30000,
    });
    const killed = child.status !== 0;
    results.push({ name: mutation.name, killed, exitCode: child.status, signal: child.signal || null });
    process.stdout.write(`${killed ? 'KILLED' : 'SURVIVED'} ${mutation.name} exit=${child.status}\n`);
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

const survived = results.filter((result) => !result.killed);
process.stdout.write(`RESULT ${JSON.stringify({ total: results.length, killed: results.length - survived.length, survived })}\n`);
process.exitCode = survived.length === 0 ? 0 : 1;
