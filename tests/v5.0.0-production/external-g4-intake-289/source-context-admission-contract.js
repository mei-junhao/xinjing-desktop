'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { candidateRoot: ROOT } = require('./harness-paths');
const clinicalPath = path.join(ROOT, 'app', 'js', 'clinical-context.js');

function loadClinicalContext() {
  const scope = {
    console, TextEncoder, encodeURIComponent, unescape, Date, Math, JSON, Promise,
    Object, Array, String, Number, Boolean, Error, RegExp, Map, Set,
    Store: {
      getClient: () => null,
      getSession: () => null,
      getMaterialWorkspace: () => null,
      getSupervision: () => null,
      createClinicalActionRun: () => null,
      updateClinicalActionRun: () => null,
    },
    App: { featureGate: () => true, hasAICompute: () => true },
  };
  scope.window = scope;
  vm.createContext(scope);
  vm.runInContext(fs.readFileSync(clinicalPath, 'utf8'), scope, { filename: clinicalPath });
  return scope.ClinicalContext;
}

function source(kind, id, clientId, sessionId) {
  return {
    kind,
    id,
    clientId,
    sessionId,
    normalizationVersion: '1',
    sourceVersion: 'v1',
    sourceContentHash: 'sha256:synthetic-source',
    anchorContentHash: 'sha256:synthetic-anchor',
    status: 'verified',
  };
}

function run() {
  const api = loadClinicalContext();
  const origin = { clientId: 'client-a', sessionId: 'session-a1' };
  const validClient = source('client', 'client-a', 'client-a', 'session-a1');
  const validSession = source('session', 'session-a1', 'client-a', 'session-a1');
  const checks = [];
  function check(id, fn) { fn(); checks.push(id); }

  check('S01-valid-bound-transcript', () => {
    assert.strictEqual(api.validateSources('transcript-ai-detect', [validClient, validSession], origin).ok, true);
  });
  check('S02-missing-client-rejects', () => {
    const sources = [validClient, validSession].map((item) => Object.assign({}, item, { clientId: '' }));
    assert.strictEqual(api.validateSources('transcript-ai-detect', sources, origin).reason, 'source-client-missing');
  });
  check('S03-missing-session-rejects', () => {
    const sources = [validClient, validSession].map((item) => Object.assign({}, item, { sessionId: '' }));
    assert.strictEqual(api.validateSources('transcript-ai-detect', sources, origin).reason, 'source-session-missing');
  });
  check('S04-cross-client-rejects', () => {
    const sources = [validClient, Object.assign({}, validSession, { clientId: 'client-b' })];
    assert.strictEqual(api.validateSources('transcript-ai-detect', sources, origin).reason, 'source-client-mismatch');
  });
  check('S05-cross-session-rejects', () => {
    const sources = [validClient, Object.assign({}, validSession, { sessionId: 'session-b1' })];
    assert.strictEqual(api.validateSources('transcript-ai-detect', sources, origin).reason, 'source-session-mismatch');
  });
  check('S06-valid-source-cannot-mask-unbound-client', () => {
    const sources = [validClient, Object.assign({}, validSession, { clientId: '' })];
    assert.strictEqual(api.validateSources('transcript-ai-detect', sources, origin).reason, 'source-client-missing');
  });
  check('S07-valid-source-cannot-mask-unbound-session', () => {
    const sources = [validClient, Object.assign({}, validSession, { sessionId: '' })];
    assert.strictEqual(api.validateSources('transcript-ai-detect', sources, origin).reason, 'source-session-missing');
  });
  check('S08-growth-summary-no-origin-session-allows-multiple-sessions', () => {
    const summaryOrigin = { clientId: 'client-a', sessionId: '' };
    const sources = [
      source('material', 'material-a1', 'client-a', 'session-a1'),
      source('material', 'material-a2', 'client-a', 'session-a2'),
    ];
    assert.strictEqual(api.validateSources('growth-summary', sources, summaryOrigin).ok, true);
  });
  check('S09-growth-summary-no-origin-session-still-rejects-cross-client', () => {
    const summaryOrigin = { clientId: 'client-a', sessionId: '' };
    const sources = [
      source('material', 'material-a1', 'client-a', 'session-a1'),
      source('material', 'material-b1', 'client-b', 'session-b1'),
    ];
    assert.strictEqual(api.validateSources('growth-summary', sources, summaryOrigin).reason, 'source-client-mismatch');
  });

  console.log(JSON.stringify({ suite: 'source-context-admission', pass: checks.length, fail: 0, root: ROOT, checks }, null, 2));
}

try { run(); } catch (error) { console.error(error && error.stack || error); process.exit(1); }
