'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const NODE = process.execPath;
const WORKSPACE = path.resolve(__dirname, '..');
const CANDIDATE = path.join(WORKSPACE, 'candidate', 'repo');
const CONTRACTS = {
  registry: path.join(__dirname, 'trusted-ai-provenance-governance-contract.js'),
  prompt: path.join(__dirname, 'prompt-governance-candidate-contract.js'),
  summary: path.join(__dirname, 'longitudinal-summary-candidate-contract.js'),
  sourceContext: path.join(__dirname, 'source-context-fail-closed-contract.js'),
};

function runContract(contract, root) {
  return cp.spawnSync(NODE, [contract], {
    env: Object.assign({}, process.env, { XJ_CANDIDATE_ROOT: root }),
    encoding: 'utf8',
  });
}
function mutateFile(root, relative, before, after) {
  const file = path.join(root, relative);
  const source = fs.readFileSync(file, 'utf8');
  if (!source.includes(before)) throw new Error('mutation target missing: ' + before.slice(0, 80));
  const changed = source.replace(before, after);
  if (changed === source) throw new Error('mutation not applied: ' + relative);
  fs.writeFileSync(file, changed, 'utf8');
  return { beforeHash: hash(source), afterHash: hash(changed) };
}
function hash(value) { return require('crypto').createHash('sha256').update(value).digest('hex'); }
function boundaryScan(file) {
  const source = fs.readFileSync(file, 'utf8').replace(/\\/g, '/');
  return !/D:\/xinjing-electron\/(?:app|main\.js|preload\.js)/i.test(source);
}

const mutations = [
  {
    id: 'M01-registry-required-field', contract: 'registry', file: 'app/js/clinical-context.js',
    before: '      id: id,\n      feature: feature,', after: '      feature: feature,',
  },
  {
    id: 'M02-cross-client-admission', contract: 'registry', file: 'app/js/clinical-context.js',
    before: "      if (origin.clientId && text(source.clientId) !== text(origin.clientId)) return { ok: false, reason: 'source-client-mismatch', index: index };",
    after: "      if (false && origin.clientId && text(source.clientId) !== text(origin.clientId)) return { ok: false, reason: 'source-client-mismatch', index: index };",
  },
  {
    id: 'M03-preview-only-boundary', contract: 'summary', file: 'app/js/clinical-context.js',
    before: "      outputMode: 'preview-only'", after: "      outputMode: 'durable-save'",
  },
  {
    id: 'M04-cross-label-knowledge-key', contract: 'prompt', file: 'app/js/prompt-governance.js',
    before: "      const key = normalized.id + '@' + normalized.version;", after: "      const key = normalized.kind + ':' + normalized.id + '@' + normalized.version;",
  },
  {
    id: 'M05-source-hash-admission', contract: 'registry', file: 'app/js/clinical-context.js',
    before: "      if (!hashPresent(source.sourceContentHash) || !hashPresent(source.anchorContentHash)) return { ok: false, reason: 'source-hash-missing', index: index };",
    after: "      if (false && (!hashPresent(source.sourceContentHash) || !hashPresent(source.anchorContentHash))) return { ok: false, reason: 'source-hash-missing', index: index };",
  },
  {
    id: 'M06-output-schema-strictness', contract: 'registry', file: 'app/js/clinical-context.js',
    before: "      if (schema.allowedProperties.indexOf(keys[index]) < 0) return { ok: false, reason: 'output-schema-additional-property', field: keys[index] };",
    after: "      if (false && schema.allowedProperties.indexOf(keys[index]) < 0) return { ok: false, reason: 'output-schema-additional-property', field: keys[index] };",
  },
  {
    id: 'M07-async-await-projection', contract: 'summary', file: 'app/js/longitudinal-summary.js',
    before: '    var projection = await root.CaseSpaceViewModel.refresh(clientId, { currentContext: { clientId: clientId }, signal: options.signal });',
    after: '    var projection = root.CaseSpaceViewModel.refresh(clientId, { currentContext: { clientId: clientId }, signal: options.signal });',
  },
  {
    id: 'M09-source-client-missing-relaxed', contract: 'sourceContext', file: 'app/js/clinical-context.js',
    before: "      if (!text(source.clientId)) return { ok: false, reason: 'source-client-missing', index: index };",
    after: "      if (false && !text(source.clientId)) return { ok: false, reason: 'source-client-missing', index: index };",
  },
  {
    id: 'M10-source-session-missing-relaxed', contract: 'sourceContext', file: 'app/js/clinical-context.js',
    before: "      if (!text(source.sessionId)) return { ok: false, reason: 'source-session-missing', index: index };",
    after: "      if (false && !text(source.sessionId)) return { ok: false, reason: 'source-session-missing', index: index };",
  },
  {
    id: 'M11-source-context-guard-fully-reverted', contract: 'sourceContext', file: 'app/js/clinical-context.js',
    before: "      if (!text(source.clientId)) return { ok: false, reason: 'source-client-missing', index: index };\n      if (!text(source.sessionId)) return { ok: false, reason: 'source-session-missing', index: index };",
    after: "      if (false && !text(source.clientId)) return { ok: false, reason: 'source-client-missing', index: index };\n      if (false && !text(source.sessionId)) return { ok: false, reason: 'source-session-missing', index: index };",
  },
];

function main() {
  const baseline = Object.entries(CONTRACTS).map(([name, contract]) => ({ name, result: runContract(contract, CANDIDATE) }));
  const baselineBad = baseline.filter((item) => item.result.status !== 0);
  if (baselineBad.length) throw new Error('baseline contract failed: ' + baselineBad.map((item) => item.name).join(','));

  const ledger = [];
  for (const mutation of mutations) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xj286-' + mutation.id + '-'));
    fs.cpSync(CANDIDATE, root, { recursive: true });
    const changed = mutateFile(root, mutation.file, mutation.before, mutation.after);
    const result = runContract(CONTRACTS[mutation.contract], root);
    ledger.push({ id: mutation.id, applied: changed.beforeHash !== changed.afterHash, killed: result.status !== 0, exitCode: result.status, stderrHead: String(result.stderr || '').split(/\r?\n/).slice(0, 3).join(' | ') });
  }

  const harnessRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xj286-M08-live-read-'));
  const harness = path.join(harnessRoot, 'contract.js');
  fs.copyFileSync(CONTRACTS.registry, harness);
  fs.appendFileSync(harness, "\nrequire('fs').readFileSync('D:/xinjing-electron/app/js/store.js', 'utf8');\n", 'utf8');
  ledger.push({ id: 'M08-live-project-test-read', applied: true, killed: boundaryScan(harness) === false, exitCode: boundaryScan(harness) ? 0 : 1, stderrHead: 'task-local boundary scanner' });

  const survived = ledger.filter((item) => !item.applied || !item.killed);
  console.log(JSON.stringify({ suite: 'mutation-probes', total: ledger.length, killed: ledger.length - survived.length, survived: survived.length, ledger }, null, 2));
  if (survived.length) process.exit(1);
}

try { main(); } catch (error) { console.error(error && error.stack || error); process.exit(1); }
