'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', 'candidate', 'repo');
const read = (name) => fs.readFileSync(path.join(ROOT, 'app', 'js', name), 'utf8');

function loadClinical() {
  const runs = [];
  const scope = {
    console, TextEncoder, encodeURIComponent, unescape, Date, Math, JSON, Promise, Object, Array, String, Number, Boolean, Error, RegExp, Map, Set,
    Store: {
      getClient: (id) => id === 'a' ? { id: 'a', name: 'Synthetic' } : null,
      getSession: (id) => id === 's1' ? { id: 's1', clientId: 'a', transcript: 'SYNTHETIC', updatedAt: 'v1' } : null,
      getMaterialWorkspace: () => null, getSupervision: () => null,
      createClinicalActionRun: (value) => { const run = Object.assign({ id: 'run-1' }, value); runs.push(run); return run; },
      updateClinicalActionRun: (id, patch) => { const run = runs.find((item) => item.id === id); if (!run) return null; Object.assign(run, patch); return run; },
    },
    App: { featureGate: () => true, hasAICompute: () => true },
  };
  scope.window = scope;
  vm.createContext(scope);
  vm.runInContext(read('clinical-task-validators.js'), scope);
  vm.runInContext(read('clinical-context.js'), scope);
  return { api: scope.ClinicalContext, runs };
}

function main() {
  const { api, runs } = loadClinical();
  const good = api.build('transcript-ai-detect', { clientId: 'a', sessionId: 's1' }, { inputText: 'BODY' });
  const checks = [];
  function check(id, fn) { fn(); checks.push(id); }

  check('A01-unknown-task', () => assert.strictEqual(api.build('forged-task', {}, {}).reason, 'unknown-task'));
  check('A02-cross-client-source', () => assert.strictEqual(api.validateSources('transcript-ai-detect', [Object.assign({}, good.sources[0], { clientId: 'b' })], good.origin).reason, 'source-client-mismatch'));
  check('A03-quarantined-source', () => assert.strictEqual(api.validateSources('transcript-ai-detect', [Object.assign({}, good.sources[0], { status: 'quarantined' })], good.origin).reason, 'source-not-admissible'));
  check('A04-unknown-source-kind', () => assert.strictEqual(api.validateSources('transcript-ai-detect', [Object.assign({}, good.sources[0], { kind: 'unknown' })], good.origin).reason, 'source-kind-unknown'));
  check('A05-hashless-source', () => assert.strictEqual(api.validateSources('transcript-ai-detect', [Object.assign({}, good.sources[0], { sourceContentHash: '' })], good.origin).reason, 'source-hash-missing'));
  check('A06-schema-smuggling', () => assert.strictEqual(api.validateOutput('transcript-ai-detect', { kind: 'transcript-detection-preview', citations: [], formalRecord: 'x' }).reason, 'output-schema-additional-property'));
  check('A07-automatic-persist', () => assert.strictEqual(api.createActionRun(Object.assign({}, good, { outputMode: 'durable-save' })), null));
  check('A08-bounded-output', () => {
    const run = api.createActionRun(good);
    const done = api.completeActionRun(run.id, { kind: 'transcript-detection-preview', findings: [], citations: [], summary: 'SECRET' });
    assert.deepStrictEqual(Object.keys(done.output).sort(), ['kind', 'ref']);
    assert.strictEqual(JSON.stringify(runs).includes('SECRET'), false);
  });

  const governance = require(path.join(ROOT, 'app', 'js', 'prompt-governance.js'));
  const h = governance.sha256('A');
  check('A09-cross-label-dedup', () => assert.strictEqual(governance.mergeKnowledgeSources([
    { id: 'k', version: 'v1', kind: 'master-builtin', label: 'a', source: 'a', content: 'A', contentHash: h },
    { id: 'k', version: 'v1', kind: 'user-library', label: 'b', source: 'b', content: 'A', contentHash: h },
  ]).sources.length, 1));
  check('A10-cross-label-conflict', () => assert.strictEqual(governance.mergeKnowledgeSources([
    { id: 'k', version: 'v1', kind: 'master-builtin', label: 'a', source: 'a', content: 'A', contentHash: h },
    { id: 'k', version: 'v1', kind: 'user-library', label: 'b', source: 'b', content: 'B', contentHash: governance.sha256('B') },
  ]).ok, false));
  check('A11-declared-hash-mismatch', () => assert.throws(() => governance.mergeKnowledgeSources([{ id: 'k', version: 'v1', kind: 'master-builtin', label: 'a', source: 'a', content: 'A', contentHash: governance.sha256('B') }]), /hash mismatch/i));
  check('A12-no-live-project-bindings', () => {
    const candidateContracts = [
      'trusted-ai-provenance-governance-contract.js', 'longitudinal-summary-candidate-contract.js',
      'prompt-governance-candidate-contract.js', 'source-context-fail-closed-contract.js',
    ];
    const testSources = candidateContracts.map((name) => fs.readFileSync(path.join(__dirname, name), 'utf8').replace(/\\/g, '/'));
    assert.ok(testSources.every((source) => !/D:\/xinjing-electron\/(?:app|main\.js|preload\.js)/i.test(source)));
  });

  // ---- Task 294 adversarial probes on the source-context fail-closed fix ----

  // A13: byte-level revert of the real-entry guard must kill the contract.
  // Proves the fix is in the real candidate entry, not only in tests.
  check('A13-revert-fix-kills-contract', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xj294-adversarial-revert-'));
    fs.cpSync(ROOT, tmp, { recursive: true });
    const file = path.join(tmp, 'app', 'js', 'clinical-context.js');
    let src = fs.readFileSync(file, 'utf8');
    const fixed = "      if (!text(source.clientId)) return { ok: false, reason: 'source-client-missing', index: index };\n      if (!text(source.sessionId)) return { ok: false, reason: 'source-session-missing', index: index };";
    const old = "      if (origin.clientId && text(source.clientId) && text(source.clientId) !== text(origin.clientId)) return { ok: false, reason: 'source-client-mismatch', index: index };\n      if (origin.sessionId && text(source.sessionId) && text(source.sessionId) !== text(origin.sessionId)) return { ok: false, reason: 'source-session-mismatch', index: index };";
    assert.ok(src.includes(fixed), 'adversarial: fixed guard lines must exist in the real candidate file');
    fs.writeFileSync(file, src.replace(fixed, old), 'utf8');
    const result = cp.spawnSync(process.execPath, [path.join(__dirname, 'source-context-fail-closed-contract.js')], {
      env: Object.assign({}, process.env, { XJ_CANDIDATE_ROOT: tmp }), encoding: 'utf8',
    });
    assert.notStrictEqual(result.status, 0, 'reverting the real-entry guard must make the contract fail');
  });

  // A14: deleting `await` on the source projection must break the real summary path.
  check('A14-delete-await-kills-summary', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xj294-adversarial-await-'));
    fs.cpSync(ROOT, tmp, { recursive: true });
    const file = path.join(tmp, 'app', 'js', 'longitudinal-summary.js');
    let src = fs.readFileSync(file, 'utf8');
    const withAwait = '    var projection = await root.CaseSpaceViewModel.refresh(clientId, { currentContext: { clientId: clientId }, signal: options.signal });';
    assert.ok(src.includes(withAwait), 'adversarial: await must exist in the real summary projection');
    fs.writeFileSync(file, src.replace(withAwait, '    var projection = root.CaseSpaceViewModel.refresh(clientId, { currentContext: { clientId: clientId }, signal: options.signal });'), 'utf8');
    const result = cp.spawnSync(process.execPath, [path.join(__dirname, 'longitudinal-summary-candidate-contract.js')], {
      env: Object.assign({}, process.env, { XJ_CANDIDATE_ROOT: tmp }), encoding: 'utf8',
    });
    assert.notStrictEqual(result.status, 0, 'removing await must break the real summary path');
  });

  // A15: a rejected admission must not be swallowed into a created action run.
  check('A15-rejection-not-swallowed', () => {
    const cleared = good.sources.map((s) => Object.assign({}, s, { clientId: '' }));
    const admission = api.validateSources('transcript-ai-detect', cleared, good.origin);
    assert.strictEqual(admission.ok, false, 'missing clientId must be rejected');
    const runRecord = api.createActionRun(Object.assign({}, good, { sources: cleared }));
    assert.strictEqual(runRecord, null, 'a rejected admission must never create an action run');
  });

  // A16: missing source context must not be backfilled from origin (no default client/session).
  check('A16-no-default-context-backfill', () => {
    const cleared = good.sources.map((s) => Object.assign({}, s, { sessionId: '' }));
    const admission = api.validateSources('transcript-ai-detect', cleared, good.origin);
    assert.strictEqual(admission.ok, false, 'missing sessionId must be rejected even when origin has a valid session');
    assert.ok(/source-session-missing/.test(admission.reason), 'rejection must name the missing field, not silently reuse origin');
  });

  // A17: whitespace-only clientId must be missing, not trimmed and passed.
  check('A17-empty-string-normalization-blocked', () => {
    const whitespace = good.sources.map((s) => Object.assign({}, s, { clientId: '   ' }));
    const admission = api.validateSources('transcript-ai-detect', whitespace, good.origin);
    assert.strictEqual(admission.ok, false, 'whitespace-only clientId must be treated as missing');
  });

  // A18: PASS text must agree with a zero exit code (no false-green / conflicting exits).
  check('A18-pass-text-exit-coherence', () => {
    const result = cp.spawnSync(process.execPath, [path.join(__dirname, 'source-context-fail-closed-contract.js')], { encoding: 'utf8' });
    function extractJsonDocs(text) {
      const docs = [];
      let cursor = 0;
      while (cursor < text.length) {
        const start = text.indexOf('{', cursor);
        if (start === -1) break;
        let depth = 0;
        let end = start;
        for (; end < text.length; end++) {
          if (text[end] === '{') depth++;
          else if (text[end] === '}') { depth--; if (depth === 0) break; }
        }
        if (depth !== 0) break;
        try { docs.push(JSON.parse(text.slice(start, end + 1))); } catch (e) { /* skip malformed */ }
        cursor = end + 1;
      }
      return docs;
    }
    const docs = extractJsonDocs(String(result.stdout || ''));
    const parsed = docs.find((item) => item && item.phase === 'assert') || null;
    assert.ok(parsed, 'contract must print an assert-phase JSON summary');
    assert.strictEqual(result.status, 0, 'contract must exit 0 when it prints pass');
    assert.strictEqual(parsed.fail, 0, 'printed fail count must be 0');
  });

  console.log(JSON.stringify({ suite: 'internal-adversarial-review', pass: checks.length, fail: 0, checks }, null, 2));
}

try { main(); } catch (error) { console.error(error && error.stack || error); process.exit(1); }
