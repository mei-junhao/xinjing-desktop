'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WORKSPACE = path.resolve(__dirname, '..');
const ROOT = process.env.XJ_CANDIDATE_ROOT || path.join(WORKSPACE, 'candidate', 'repo');
const INPUT = path.join(WORKSPACE, 'input');
function candidate(name) { return path.join(ROOT, 'app', 'js', name); }
function frozen(name) { return path.join(INPUT, 'app', 'js', name); }
function read(file) { return fs.readFileSync(file, 'utf8'); }

function loadClinicalContext() {
  const runs = [];
  const clients = new Map([['client-a', { id: 'client-a', name: 'Synthetic A', notes: '' }]]);
  const sessions = new Map([['session-a1', { id: 'session-a1', clientId: 'client-a', sessionNumber: 1, date: '2026-08-01', transcript: 'SYNTHETIC_ALPHA', updatedAt: 'v1' }]]);
  const scope = {
    console, TextEncoder, encodeURIComponent, unescape, Date, Math, JSON, Promise,
    Object, Array, String, Number, Boolean, Error, RegExp, Map, Set,
    Store: {
      getClient: (id) => clients.get(String(id)) || null,
      getSession: (id) => sessions.get(String(id)) || null,
      getMaterialWorkspace: () => null,
      getSupervision: () => null,
      createClinicalActionRun: (value) => { const run = Object.assign({ id: 'run-' + (runs.length + 1) }, value); runs.push(run); return run; },
      updateClinicalActionRun: (id, patch) => { const run = runs.find((item) => item.id === id); if (!run) return null; Object.assign(run, patch); return run; },
    },
    App: { featureGate: () => true, hasAICompute: () => true },
  };
  scope.window = scope;
  vm.createContext(scope);
  const validatorsPath = fs.existsSync(candidate('clinical-task-validators.js')) ? candidate('clinical-task-validators.js') : frozen('clinical-task-validators.js');
  vm.runInContext(read(validatorsPath), scope, { filename: validatorsPath });
  vm.runInContext(read(candidate('clinical-context.js')), scope, { filename: candidate('clinical-context.js') });
  return { api: scope.ClinicalContext, runs };
}

function assertRegistry(api) {
  assert.ok(api && api.TASKS, 'ClinicalContext must expose the real registry');
  const required = [
    'id', 'feature', 'label', 'allowedSourceKinds', 'requiredSourceKinds',
    'forbiddenSourceKinds', 'budget', 'outputSchema', 'writeTarget',
    'humanConfirmationRequired', 'cancellationPolicy', 'expiryMs',
    'partialStreamPolicy', 'evaluationFixtureId', 'outputMode'
  ];
  for (const [taskId, spec] of Object.entries(api.TASKS)) {
    assert.strictEqual(spec.id, taskId, 'registry id must equal its stable key');
    for (const field of required) assert.ok(Object.prototype.hasOwnProperty.call(spec, field), `${taskId} missing ${field}`);
    assert.ok(Array.isArray(spec.allowedSourceKinds) && Array.isArray(spec.requiredSourceKinds) && Array.isArray(spec.forbiddenSourceKinds));
    assert.ok(Number.isInteger(spec.budget.maxChars) && spec.budget.maxChars > 0);
    assert.ok(Number.isInteger(spec.budget.maxTokens) && spec.budget.maxTokens > 0);
    assert.strictEqual(spec.outputMode, 'preview-only');
    assert.strictEqual(spec.humanConfirmationRequired, true);
    assert.notStrictEqual(spec.writeTarget, 'formal-clinical-object');
  }
  assert.strictEqual(api.getTaskSpec('unknown-task'), null, 'unknown task must fail closed');
}

function run() {
  const { api, runs } = loadClinicalContext();
  assertRegistry(api);

  const built = api.build('transcript-ai-detect', { clientId: 'client-a', sessionId: 'session-a1' }, { selectedSessionIds: ['session-a1'], inputText: 'SYNTHETIC_INPUT' });
  assert.strictEqual(built.ok, true, 'known task with same-client source must build');
  assert.ok(built.sources.length > 0, 'real build path must produce governed sources');
  assert.strictEqual(api.validateSources('transcript-ai-detect', built.sources, built.origin).ok, true);
  assert.strictEqual(api.validateSources('transcript-ai-detect', [{ kind: 'unknown', id: 'x' }], built.origin).reason, 'source-kind-unknown');
  assert.strictEqual(api.validateSources('transcript-ai-detect', [Object.assign({}, built.sources[0], { status: 'quarantined' })], built.origin).reason, 'source-not-admissible');
  assert.strictEqual(api.validateSources('transcript-ai-detect', [Object.assign({}, built.sources[0], { clientId: 'client-b' })], built.origin).reason, 'source-client-mismatch');
  assert.strictEqual(api.validateSources('transcript-ai-detect', [Object.assign({}, built.sources[0], { sourceContentHash: '' })], built.origin).reason, 'source-hash-missing');

  const validOutput = { kind: 'transcript-detection-preview', findings: [], citations: built.sources.map((item) => item.id) };
  assert.strictEqual(api.validateOutput('transcript-ai-detect', validOutput).ok, true);
  assert.strictEqual(api.validateOutput('transcript-ai-detect', Object.assign({}, validOutput, { prose: 'FORBIDDEN' })).reason, 'output-schema-additional-property');
  assert.strictEqual(api.validateOutput('unknown-task', validOutput).reason, 'unknown-task');

  const run = api.createActionRun(built);
  assert.ok(run && run.status === 'pending');
  const completed = api.completeActionRun(run.id, validOutput);
  assert.ok(completed && completed.status === 'succeeded');
  assert.deepStrictEqual(Object.keys(completed.output).sort(), ['kind', 'ref'], 'durable output must retain bounded metadata only');
  assert.strictEqual(JSON.stringify(runs).includes('SYNTHETIC_INPUT'), false, 'action run must not persist input body');
  assert.strictEqual(api.completeActionRun('missing', validOutput), null);

  console.log(JSON.stringify({ suite: 'trusted-ai-provenance-governance', pass: 22, fail: 0, root: ROOT }, null, 2));
}

try { run(); } catch (error) { console.error(error && error.stack || error); process.exit(1); }
