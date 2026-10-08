'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const NODE = process.execPath;
const { workspace: WORKSPACE, candidateRoot: CANDIDATE, evidenceFile } = require('./harness-paths');
const CONTRACTS = {
  admission: path.join(__dirname, 'source-context-admission-contract.js'),
  registry: path.join(__dirname, 'trusted-ai-provenance-governance-contract.js'),
  prompt: path.join(__dirname, 'prompt-governance-candidate-contract.js'),
  summary: path.join(__dirname, 'longitudinal-summary-candidate-contract.js'),
};
const CLOSURE = [
  'app/js/agent-core.js',
  'app/js/clinical-context.js',
  'app/js/clinical-task-validators.js',
  'app/js/longitudinal-summary.js',
  'app/js/prompt-governance.js',
  'app/js/source-ref.js',
];

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function runContract(contract, root) {
  return cp.spawnSync(NODE, [contract], {
    env: Object.assign({}, process.env, { XJ_289_CANDIDATE_ROOT: root, XJ_CANDIDATE_ROOT: root }),
    encoding: 'utf8',
  });
}
function copyClosure(from, to) {
  for (const relative of CLOSURE) {
    const source = path.join(from, relative);
    const target = path.join(to, relative);
    if (!fs.existsSync(source)) throw new Error('closure source missing: ' + relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}
function mutateFile(root, relative, before, after) {
  const file = path.join(root, relative);
  const source = fs.readFileSync(file, 'utf8');
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const beforeActual = before.replace(/\r?\n/g, eol);
  const afterActual = after.replace(/\r?\n/g, eol);
  if (source.split(beforeActual).length - 1 !== 1) throw new Error('mutation anchor count must be one: ' + relative + ' :: ' + before.slice(0, 100));
  const changed = source.replace(beforeActual, afterActual);
  if (changed === source) throw new Error('mutation not applied: ' + relative);
  fs.writeFileSync(file, changed, 'utf8');
  const normalized = (value) => value.replace(/\r\n/g, '\n');
  return {
    beforeHash: hash(source), afterHash: hash(changed),
    beforeNormalizedHash: hash(normalized(source)), afterNormalizedHash: hash(normalized(changed)),
    rawChanged: hash(source) !== hash(changed), normalizedChanged: hash(normalized(source)) !== hash(normalized(changed)),
  };
}
function boundaryScan(source) {
  return !/D:\/xinjing-electron\/(?:app|main\.js|preload\.js)/i.test(String(source).replace(/\\/g, '/'));
}

function runM06() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'xj289-M06-live-project-import-'));
  const testNames = [...Object.values(CONTRACTS), path.join(__dirname, 'harness-paths.js'), path.join(__dirname, 'internal-adversarial-review.js')]
    .filter((file, index, all) => all.indexOf(file) === index);
  for (const source of testNames) fs.copyFileSync(source, path.join(scratch, path.basename(source)));
  const env = Object.assign({}, process.env, {
    XJ_289_WORKSPACE_ROOT: WORKSPACE,
    XJ_289_CANDIDATE_ROOT: CANDIDATE,
    XJ_CANDIDATE_ROOT: CANDIDATE,
    XJ_289_EVIDENCE_ROOT: path.join(scratch, 'evidence'),
  });
  fs.mkdirSync(path.join(scratch, 'evidence'), { recursive: true });
  const control = cp.spawnSync(NODE, [path.join(scratch, 'internal-adversarial-review.js')], { env, encoding: 'utf8' });
  const target = path.join(scratch, 'source-context-admission-contract.js');
  const before = fs.readFileSync(target, 'utf8');
  const after = before + "\nrequire('fs').readFileSync('D:/xinjing-electron/app/js/store.js', 'utf8');\n";
  fs.writeFileSync(target, after, 'utf8');
  const mutated = cp.spawnSync(NODE, [path.join(scratch, 'internal-adversarial-review.js')], { env, encoding: 'utf8' });
  const normalized = (value) => value.replace(/\r\n/g, '\n');
  const rawChanged = hash(before) !== hash(after);
  const normalizedChanged = hash(normalized(before)) !== hash(normalized(after));
  const killed = control.status === 0 && mutated.status !== 0;
  return {
    id: 'M06-live-project-import', beforeHash: hash(before), afterHash: hash(after),
    beforeNormalizedHash: hash(normalized(before)), afterNormalizedHash: hash(normalized(after)),
    applied: rawChanged && normalizedChanged, killed,
    exitCode: mutated.status, controlExitCode: control.status,
    stderrHead: String(mutated.stderr || '').split(/\r?\n/).slice(0, 4).join(' | '),
    scratch,
  };
}

const mutations = [
  {
    id: 'M01-restore-client-wildcard', contract: 'admission', file: 'app/js/clinical-context.js',
    before: "      if (text(origin.clientId) && !text(source.clientId)) return { ok: false, reason: 'source-client-missing', index: index };\n      if (text(origin.clientId) && text(source.clientId) !== text(origin.clientId)) return { ok: false, reason: 'source-client-mismatch', index: index };",
    after: "      if (text(origin.clientId) && text(source.clientId) && text(source.clientId) !== text(origin.clientId)) return { ok: false, reason: 'source-client-mismatch', index: index };",
  },
  {
    id: 'M02-restore-session-wildcard', contract: 'admission', file: 'app/js/clinical-context.js',
    before: "      if (text(origin.sessionId) && !text(source.sessionId)) return { ok: false, reason: 'source-session-missing', index: index };\n      if (text(origin.sessionId) && text(source.sessionId) !== text(origin.sessionId)) return { ok: false, reason: 'source-session-mismatch', index: index };",
    after: "      if (text(origin.sessionId) && text(source.sessionId) && text(source.sessionId) !== text(origin.sessionId)) return { ok: false, reason: 'source-session-mismatch', index: index };",
  },
  {
    id: 'M03-remove-cross-client-rejection', contract: 'admission', file: 'app/js/clinical-context.js',
    before: "      if (text(origin.clientId) && text(source.clientId) !== text(origin.clientId)) return { ok: false, reason: 'source-client-mismatch', index: index };",
    after: "      if (false && text(origin.clientId) && text(source.clientId) !== text(origin.clientId)) return { ok: false, reason: 'source-client-mismatch', index: index };",
  },
  {
    id: 'M04-restore-kind-prefixed-knowledge-key', contract: 'prompt', file: 'app/js/prompt-governance.js',
    before: "      const key = normalized.id + '@' + normalized.version;",
    after: "      const key = normalized.kind + ':' + normalized.id + '@' + normalized.version;",
  },
  {
    id: 'M05-remove-longitudinal-preview-only', contract: 'summary', file: 'app/js/longitudinal-summary.js',
    before: "    return { ok: true, preview: Object.freeze({ mode: 'preview-only', kind: 'growth-summary-preview', summary: summary, changes: Object.freeze(changes), citations: Object.freeze(citations) }) };",
    after: "    return { ok: true, preview: Object.freeze({ mode: 'durable-save', kind: 'growth-summary-preview', summary: summary, changes: Object.freeze(changes), citations: Object.freeze(citations) }) };",
  },
];

function main() {
  for (const [name, contract] of Object.entries(CONTRACTS)) {
    const result = runContract(contract, CANDIDATE);
    if (result.status !== 0) throw new Error('baseline contract failed: ' + name + '\n' + result.stderr);
  }

  const ledger = [];
  for (const mutation of mutations) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xj289-' + mutation.id + '-'));
    copyClosure(CANDIDATE, root);
    const changed = mutateFile(root, mutation.file, mutation.before, mutation.after);
    const result = runContract(CONTRACTS[mutation.contract], root);
    ledger.push({
      id: mutation.id,
      beforeHash: changed.beforeHash,
      afterHash: changed.afterHash,
      beforeNormalizedHash: changed.beforeNormalizedHash,
      afterNormalizedHash: changed.afterNormalizedHash,
      applied: changed.rawChanged && changed.normalizedChanged,
      killed: result.status !== 0,
      exitCode: result.status,
      stderrHead: String(result.stderr || '').split(/\r?\n/).slice(0, 4).join(' | '),
    });
  }

  ledger.push(runM06());

  const survived = ledger.filter((item) => !item.applied || !item.killed);
  const output = { suite: 'mutation-probes', total: ledger.length, killed: ledger.length - survived.length, survived: survived.length, ledger };
  const evidence = evidenceFile('mutation-ledger.json');
  fs.mkdirSync(path.dirname(evidence), { recursive: true });
  fs.writeFileSync(evidence, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(output, null, 2));
  if (survived.length) process.exit(1);
}

try { main(); } catch (error) { console.error(error && error.stack || error); process.exit(1); }
