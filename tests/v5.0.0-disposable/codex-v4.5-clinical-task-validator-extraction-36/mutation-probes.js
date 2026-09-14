'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const HARNESS = path.join(__dirname, 'run-contract.js');
const VALIDATOR = path.join(ROOT, 'app', 'js', 'clinical-task-validators.js');
const STORE = path.join(ROOT, 'app', 'js', 'store.js');
const PAGES = [
  'billing-calendar.html', 'billing-shell.html', 'chat-home.html', 'consult-notes.html',
  'doc-center.html', 'doc-growth.html', 'feedback.html', 'index.html', 'knowledge.html',
  'masters.html', 'real-supervision-ai.html', 'real-supervision.html', 'report-writing.html',
  'session-calendar.html', 'settings.html', 'supervision-mindmap.html', 'supervision.html',
  'transcript-guide.html', 'transcript.html',
];
const INVENTORY = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'codex-v4.5-clinical-task-validator-extraction-36');
const OUTPUT = path.join(INVENTORY, 'mutation-result.json');

function copyFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-v45-task36-'));
  const app = path.join(root, 'app');
  fs.mkdirSync(path.join(app, 'js'), { recursive: true });
  fs.copyFileSync(VALIDATOR, path.join(app, 'js', 'clinical-task-validators.js'));
  fs.copyFileSync(STORE, path.join(app, 'js', 'store.js'));
  for (const page of PAGES) fs.copyFileSync(path.join(ROOT, 'app', page), path.join(app, page));
  return { root, app, validator: path.join(app, 'js', 'clinical-task-validators.js'), store: path.join(app, 'js', 'store.js'), pages: app };
}

function replaceOnce(file, from, to) {
  const source = fs.readFileSync(file, 'utf8');
  const count = source.split(from).length - 1;
  assert.strictEqual(count, 1, 'expected one mutation anchor in ' + file + ', got ' + count);
  fs.writeFileSync(file, source.replace(from, to), 'utf8');
}

function runFixture(id, mutate) {
  const fixture = copyFixture();
  mutate(fixture);
  const output = path.join(fixture.root, 'contract-result.json');
  const result = childProcess.spawnSync(process.execPath, [HARNESS], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      XJ_VALIDATOR_PATH: fixture.validator,
      XJ_STORE_PATH: fixture.store,
      XJ_PAGE_ROOT: fixture.pages,
      XJ_CONTRACT_RESULT_PATH: output,
    }),
    encoding: 'utf8',
    timeout: 90000,
    windowsHide: true,
  });
  const killed = result.status !== 0;
  const stored = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : null;
  return {
    id,
    status: killed ? 'KILLED' : 'SURVIVED',
    exit_code: result.status,
    timed_out: !!result.error && result.error.code === 'ETIMEDOUT',
    contract_status: stored && stored.status,
    evidence: (result.stdout + '\n' + result.stderr).trim().slice(-1200),
  };
}

const guard = "  const clinicalTaskValidators = typeof window !== 'undefined' ? window.ClinicalTaskValidators : null;\n  if (!clinicalTaskValidators || typeof clinicalTaskValidators.normalizeClinicalTask !== 'function' ||\n      typeof clinicalTaskValidators.hasClinicalBodyField !== 'function') {\n    throw new Error('Store requires js/clinical-task-validators.js to be loaded first');\n  }\n";
const results = [];
results.push(runFixture('baseline', () => {}));
results.push(runFixture('open-status-acceptance', (f) => {
  replaceOnce(f.validator, "const CLINICAL_TASK_STATUSES = new Set(['ai-draft', 'open', 'done', 'cancelled']);", "const CLINICAL_TASK_STATUSES = new Set(['ai-draft', 'done', 'cancelled']);");
}));
results.push(runFixture('body-field-acceptance', (f) => {
  replaceOnce(f.validator, 'if (!value || typeof value !== \'object\' || hasClinicalBodyField(value)) return null;', "if (!value || typeof value !== 'object') return null;");
}));
results.push(runFixture('invalid-status-acceptance', (f) => {
  replaceOnce(f.validator, 'if (!CLINICAL_TASK_STATUSES.has(status) || !CLINICAL_TASK_CREATORS.has(createdBy) || !refs) return null;', 'if (!CLINICAL_TASK_CREATORS.has(createdBy) || !refs) return null;');
}));
results.push(runFixture('duplicate-source-ref-acceptance', (f) => {
  replaceOnce(f.validator, 'if (!refs.every((ref) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(ref)) || new Set(refs).size !== refs.length) return null;', 'if (!refs.every((ref) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(ref))) return null;');
}));
results.push(runFixture('timestamp-default', (f) => {
  replaceOnce(f.validator, "const createdAt = typeof value.createdAt === 'string' && value.createdAt ? value.createdAt : clock();", "const createdAt = typeof value.createdAt === 'string' && value.createdAt ? value.createdAt : '1970-01-01T00:00:00.000Z';");
}));
results.push(runFixture('store-validator-bypass', (f) => {
  replaceOnce(f.store, 'return clinicalTaskValidators.normalizeClinicalTask(value, nowISO);', 'return value;');
}));
results.push(runFixture('missing-load-guard', (f) => {
  replaceOnce(f.store, guard, "  const clinicalTaskValidators = typeof window !== 'undefined' ? window.ClinicalTaskValidators : null;\n");
}));
results.push(runFixture('reordered-script-loading', (f) => {
  const page = path.join(f.pages, 'billing-calendar.html');
  replaceOnce(page, '<script src="js/clinical-task-validators.js"></script><script src="js/store.js"></script>', '<script src="js/store.js"></script><script src="js/clinical-task-validators.js"></script>');
}));

const baseline = results[0];
assert.strictEqual(baseline.status, 'SURVIVED', 'unmutated current contract must pass before mutation results are accepted');
const mutants = results.slice(1);
const killed = mutants.filter((item) => item.status === 'KILLED').length;
const payload = {
  schema_version: 1,
  task_id: 'XJ-5.0.0-codex-v4.5-clinical-task-validator-extraction-36',
  contract_id: 'v4.5-clinical-task-validator-extraction-v1',
  status: killed === mutants.length ? 'PASS' : 'FAIL',
  mutation_count: mutants.length,
  killed_count: killed,
  baseline,
  mutants,
};
const unsigned = JSON.stringify(payload, null, 2);
payload.result_hash = crypto.createHash('sha256').update(unsigned).digest('hex').toUpperCase();
fs.mkdirSync(INVENTORY, { recursive: true });
fs.writeFileSync(OUTPUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log('clinical-task-validator extraction mutations: ' + killed + '/' + mutants.length + ' KILLED');
if (payload.status !== 'PASS') process.exit(1);
