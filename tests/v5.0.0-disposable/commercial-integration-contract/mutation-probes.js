'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const fixturePath = path.resolve(__dirname, 'contract-fixture.js');
const domainPath = path.resolve(__dirname, '../../../app/js/commercial-state-machine.js');
const contractPath = path.resolve(__dirname, 'run-contract.js');
const fixtureSource = fs.readFileSync(fixturePath, 'utf8');
const domainSource = fs.readFileSync(domainPath, 'utf8');

const probes = [
  {
    name: 'mutating handler deletes await before durable commit',
    target: 'fixture',
    find: 'const committed = await durable.commit(next);',
    replace: 'const committed = durable.commit(next);',
  },
  {
    name: 'durable commit reports success but performs a no-op',
    target: 'fixture',
    find: 'state = clone(snapshot);',
    replace: 'state = state;',
  },
  {
    name: 'domain {ok:false} is swallowed as success',
    target: 'fixture',
    find: 'if (!domainResult.ok) return domainResult;',
    replace: "if (!domainResult.ok) return success({ state: 'active' }, current.revision, false);",
  },
  {
    name: 'unknown IPC handler bypasses the registered allowlist',
    target: 'fixture',
    find: "if (!handler) return failure('unknown-channel');",
    replace: "if (!handler) return success({ bypassed: true }, 0, false);",
  },
  {
    name: 'unknown feature bypasses the canonical entitlement registry',
    target: 'fixture',
    find: "if (!feature) return failure('unknown-feature');",
    replace: "if (!feature) return success({ freeManualAllowed: true, paidAccessAllowed: true, tier: 'custom' }, 0, false);",
  },
  {
    name: 'sensitive clinical/path/secret rejection is bypassed',
    target: 'fixture',
    find: "if (containsForbidden(request)) return failure('sensitive-field-rejected');",
    replace: "if (false && containsForbidden(request)) return failure('sensitive-field-rejected');",
  },
  {
    name: 'duplicate operation replay bypasses durable receipts',
    target: 'fixture',
    find: 'const prior = current.operationReceipts[request.operationId];',
    replace: 'const prior = null;',
  },
  {
    name: 'revocation epoch rollback is accepted',
    target: 'fixture',
    find: "if (request.revocationEpoch < current.revocationEpoch) return failure('revocation-rollback');",
    replace: "if (false && request.revocationEpoch < current.revocationEpoch) return failure('revocation-rollback');",
  },
  {
    name: 'offline grace extends past seven days',
    target: 'domain',
    find: 'const effectiveEnd = Math.min(record.offlineGraceEndsAtMs, maxEnd);',
    replace: 'const effectiveEnd = record.offlineGraceEndsAtMs;',
  },
  {
    name: 'commercial failure blocks Free manual access',
    target: 'fixture',
    find: "return success({ freeManualAllowed: true, paidAccessAllowed: false, reason: 'free-manual', tier: 'free', quotaAvailable: false }, 0, false);",
    replace: "return success({ freeManualAllowed: false, paidAccessAllowed: false, reason: 'commercial-failure', tier: 'free', quotaAvailable: false }, 0, false);",
  },
];

function mutate(source, find, replacement) {
  const first = source.indexOf(find);
  assert.notStrictEqual(first, -1, `mutation anchor missing: ${find}`);
  assert.strictEqual(source.indexOf(find, first + find.length), -1, `mutation anchor is ambiguous: ${find}`);
  return source.slice(0, first) + replacement + source.slice(first + find.length);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-commercial-integration-mutations-'));
let killed = 0;
try {
  probes.forEach((probe, index) => {
    const fixtureCopy = path.join(tempRoot, `fixture-${index + 1}.js`);
    const domainCopy = path.join(tempRoot, `domain-${index + 1}.js`);
    fs.writeFileSync(fixtureCopy, probe.target === 'fixture' ? mutate(fixtureSource, probe.find, probe.replace) : fixtureSource, 'utf8');
    fs.writeFileSync(domainCopy, probe.target === 'domain' ? mutate(domainSource, probe.find, probe.replace) : domainSource, 'utf8');
    const run = spawnSync(process.execPath, [contractPath, '--module', fixtureCopy, '--domain', domainCopy], {
      cwd: path.resolve(__dirname, '../../..'),
      encoding: 'utf8',
      timeout: 30000,
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
process.stdout.write(`COMMERCIAL_INTEGRATION_MUTATIONS: PASS (${killed}/${probes.length})\n`);
