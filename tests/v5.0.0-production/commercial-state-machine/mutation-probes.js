'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const sourcePath = path.resolve(__dirname, '../../../app/js/commercial-state-machine.js');
const contractPath = path.resolve(__dirname, 'run-contract.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const probes = [
  {
    name: 'unknown state grants paid access',
    find: "new Set(['active', 'offline-grace'])",
    replace: "new Set(['active', 'offline-grace', 'unknown'])",
  },
  {
    name: 'refunded state grants paid access',
    find: "new Set(['active', 'offline-grace'])",
    replace: "new Set(['active', 'offline-grace', 'refunded'])",
  },
  {
    name: 'revoked state grants paid access',
    find: "new Set(['active', 'offline-grace'])",
    replace: "new Set(['active', 'offline-grace', 'revoked'])",
  },
  {
    name: 'wrong device accepted by access gate',
    find: "if (current.deviceBindingHash !== record.deviceBindingHash) {",
    replace: "if (false && current.deviceBindingHash !== record.deviceBindingHash) {",
  },
  {
    name: 'stale subscription revision accepted',
    find: "if (!safeInteger(event.revision, 1) || event.revision <= current.revision) return failure('stale-revision', current);",
    replace: "if (!safeInteger(event.revision, 1)) return failure('stale-revision', current);",
  },
  {
    name: 'offline grace ignores hard seven-day clamp',
    find: 'const effectiveEnd = Math.min(record.offlineGraceEndsAtMs, maxEnd);',
    replace: 'const effectiveEnd = record.offlineGraceEndsAtMs;',
  },
  {
    name: 'duplicate quota debit bypasses idempotency lookup',
    find: 'const prior = findOperation(current, event.operationId);',
    replace: 'const prior = null;',
    occurrence: 2,
  },
  {
    name: 'insufficient quota failure is swallowed',
    find: "if (event.type === 'debit' && event.amount > current.balance) return failure('insufficient-quota', current);",
    replace: "if (event.type === 'debit' && event.amount > current.balance) return success(current, false);",
  },
  {
    name: 'subscription transition handler is bypassed',
    find: 'if (!allowed.includes(event.targetState))',
    replace: 'if (false && !allowed.includes(event.targetState))',
  },
];

function replaceOccurrence(text, find, replacement, occurrence) {
  let index = -1;
  let from = 0;
  for (let count = 0; count < (occurrence || 1); count += 1) {
    index = text.indexOf(find, from);
    assert.notStrictEqual(index, -1, `mutation anchor missing: ${find}`);
    from = index + find.length;
  }
  return text.slice(0, index) + replacement + text.slice(index + find.length);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-commercial-mutations-'));
let killed = 0;
try {
  probes.forEach(function (probe, index) {
    const mutated = replaceOccurrence(source, probe.find, probe.replace, probe.occurrence);
    const modulePath = path.join(tempRoot, `commercial-state-machine-mutant-${index + 1}.js`);
    fs.writeFileSync(modulePath, mutated, 'utf8');
    const run = spawnSync(process.execPath, [contractPath, '--module', modulePath], {
      cwd: path.resolve(__dirname, '../../..'),
      encoding: 'utf8',
      timeout: 15000,
    });
    if (run.status !== 0) {
      killed += 1;
      process.stdout.write(`KILLED ${String(index + 1).padStart(2, '0')} ${probe.name}\n`);
      return;
    }
    process.stderr.write(run.stdout || '');
    process.stderr.write(run.stderr || '');
    throw new Error(`SURVIVED: ${probe.name}`);
  });
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

assert.strictEqual(killed, probes.length);
process.stdout.write(`COMMERCIAL_STATE_MACHINE_MUTATIONS: PASS (${killed}/${probes.length})\n`);
