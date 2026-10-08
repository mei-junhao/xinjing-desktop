'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const facadePath = path.join(ROOT, 'app', 'js', 'commercial-ipc-facade.js');
const corePath = path.join(ROOT, 'app', 'js', 'commercial-billing-core.js');
const durablePath = path.join(ROOT, 'app', 'js', 'commercial-durable-persistence.js');
const facadeSource = fs.readFileSync(facadePath, 'utf8');
const coreSource = fs.readFileSync(corePath, 'utf8');
const mutations = [
  {
    id: 'M1_DROP_COMMIT_AWAIT',
    file: 'core',
    mutate: (text) => text.replace('await commitAndReadback(snapshot);', 'commitAndReadback(snapshot);'),
    probe: 'commit',
  },
  {
    id: 'M2_ACCEPT_UNKNOWN_INPUT',
    file: 'facade',
    mutate: (text) => text.replace("if (!allowed.has(key)) throw errorWithCode('invalid-request');", "if (false && !allowed.has(key)) throw errorWithCode('invalid-request');"),
    probe: 'unknown-input',
  },
  {
    id: 'M3_DISABLE_REVISION_CAS',
    file: 'facade',
    mutate: (text) => text.replace("if (current.revision !== snapshot.revision - 1) throw errorWithCode('stale-revision');", "if (false && current.revision !== snapshot.revision - 1) throw errorWithCode('stale-revision');"),
    probe: 'cas',
  },
];

const probe = String.raw`
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mod = require(process.argv[2]);
function workspace(balance) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-commercial-mut-'));
  const filePath = path.join(root, 'commercial-envelope-v3.json');
  const state = mod.initialEnvelope();
  state.balanceMinor = balance;
  fs.writeFileSync(filePath, JSON.stringify(state));
  return { root, filePath };
}
async function main() {
  const kind = process.argv[3];
  const w = workspace(kind === 'commit' ? 100 : 0);
  const a = await mod.createCommercialFacade({filePath:w.filePath, deviceId:'mut-a'});
  let b = null;
  try {
    if (kind === 'commit') {
      const result = await a.reserveRequestCharge({model:'model-alpha', operationId:'mut-reserve'});
      assert.equal(result.ok, true);
      const disk = JSON.parse(fs.readFileSync(w.filePath, 'utf8'));
      assert.equal(disk.revision, 1);
    } else if (kind === 'unknown-input') {
      const result = await a.processNonMoneyRequest({billingMode:'trial', operationId:'mut-trial', bogus:'reject-me'});
      assert.equal(result.ok, false);
      assert.equal(result.errorCode, 'invalid-request');
    } else if (kind === 'cas') {
      b = await mod.createCommercialFacade({filePath:w.filePath, deviceId:'mut-b'});
      const results = await Promise.all([
        a.processNonMoneyRequest({billingMode:'trial', operationId:'mut-a'}),
        b.processNonMoneyRequest({billingMode:'trial', operationId:'mut-b'}),
      ]);
      assert.equal(results.filter((x) => x.ok).length, 1);
      assert.equal(results.filter((x) => x.errorCode === 'stale-revision').length, 1);
    } else {
      throw new Error('unknown probe');
    }
  } finally {
    if (b) await b.close();
    await a.close();
    fs.rmSync(w.root, {recursive:true, force:true});
  }
}
main().catch((error) => { console.error(error.stack || error); process.exit(1); });
`;

for (const mutation of mutations) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-commercial-mutation-'));
  try {
    fs.copyFileSync(durablePath, path.join(root, 'commercial-durable-persistence.js'));
    const changedFacade = mutation.file === 'facade' ? mutation.mutate(facadeSource) : facadeSource;
    const changedCore = mutation.file === 'core' ? mutation.mutate(coreSource) : coreSource;
    fs.writeFileSync(path.join(root, 'commercial-ipc-facade.js'), changedFacade);
    fs.writeFileSync(path.join(root, 'commercial-billing-core.js'), changedCore);
    const probePath = path.join(root, 'probe.js');
    fs.writeFileSync(probePath, probe);
    const run = spawnSync(process.execPath, [probePath, path.join(root, 'commercial-ipc-facade.js'), mutation.probe], {
      cwd: root, encoding: 'utf8', timeout: 120000,
    });
    const killed = run.status !== 0;
    process.stdout.write(`${mutation.id}=${killed ? 'KILLED' : 'SURVIVED'}\n`);
    assert.equal(killed, true, `${mutation.id} survived`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

process.stdout.write('MUTATION_RESULT: PASS killed=3/3\n');
