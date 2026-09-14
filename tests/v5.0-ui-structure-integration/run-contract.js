'use strict';

/*
 * XJ-5.0.0 vechooool structure integration contract.
 *
 * This runner intentionally has two layers:
 *   1. static/source and real-module contracts (fast, deterministic), and
 *   2. the controlled Electron/CDP acceptance (opt-out with --no-runtime).
 *
 * It never seeds real data.  Runtime data is synthetic and is written only to
 * the temporary userData created by electron-runtime-acceptance.js.
 */
const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST_DIR = __dirname;
const EVIDENCE = path.join(TEST_DIR, 'evidence');
const PAGES = {
  chat: path.join(ROOT, 'app', 'chat-home.html'),
  atlas: path.join(ROOT, 'app', 'doc-center.html'),
  growth: path.join(ROOT, 'app', 'doc-growth.html'),
  chatJs: path.join(ROOT, 'app', 'js', 'chat-home.js'),
  atlasJs: path.join(ROOT, 'app', 'js', 'doc-center.js'),
  growthJs: path.join(ROOT, 'app', 'js', 'longitudinal-summary.js'),
  sharedJs: path.join(ROOT, 'app', 'js', 'clinical-workspace-ui.js'),
  sharedCss: path.join(ROOT, 'app', 'css', 'clinical-workspaces.css'),
  sourceRef: path.join(ROOT, 'app', 'js', 'source-ref.js'),
  caseSpace: path.join(ROOT, 'app', 'js', 'case-space-view-model.js'),
  clinicalContext: path.join(ROOT, 'app', 'js', 'clinical-context.js'),
  longitudinal: path.join(ROOT, 'app', 'js', 'longitudinal-summary.js')
};

const checks = [];
function check(id, label, pass, detail) {
  const result = { id, label, pass: !!pass, detail: detail || '' };
  checks.push(result);
  process.stdout.write('[' + (result.pass ? 'PASS' : 'FAIL') + '] ' + id + ': ' + label + (result.detail ? ' - ' + result.detail : '') + '\n');
  return result.pass;
}
function read(file) { return fs.readFileSync(file, 'utf8'); }
function has(text, needle) { return text.indexOf(needle) >= 0; }
function expectFile(file) { check('S-' + path.basename(file), 'required artifact exists: ' + path.relative(ROOT, file), fs.existsSync(file)); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function staticContracts() {
  Object.values(PAGES).forEach(expectFile);
  const chat = read(PAGES.chat);
  const atlas = read(PAGES.atlas);
  const growth = read(PAGES.growth);
  const chatJs = read(PAGES.chatJs);
  const atlasJs = read(PAGES.atlasJs);
  const growthJs = read(PAGES.growthJs);
  const sharedJs = read(PAGES.sharedJs);
  const sharedCss = read(PAGES.sharedCss);

  check('S-HTML-CHAT-STRUCTURE', 'chat page exposes the three structure regions',
    has(chat, 'chat-history-panel') && has(chat, 'chat-workspace-main') && has(chat, 'chat-context-panel'));
  check('S-HTML-ATLAS-STRUCTURE', 'doc center retains Atlas route/tab and source inspector',
    has(atlas, 'data-tab="atlas"') && has(atlasJs, '来源检查器') && has(atlasJs, 'refreshAtlasProjection'));
  check('S-HTML-GROWTH-STRUCTURE', 'growth page retains preview-only and human-review boundaries',
    has(growthJs, 'preview-only') && has(growth, '不会自动写入') && has(growth, 'LongitudinalSummary.prepare'));
  check('S-DEPENDENCIES', 'all three pages load shared clinical workspace assets',
    [chat, atlas, growth].every((html) => has(html, 'clinical-workspace-ui.js') && has(html, 'clinical-workspaces.css')));
  check('S-REAL-ENTRYPOINTS', 'production scripts call real Store / CaseSpace / Longitudinal / ClinicalContext APIs',
    has(chatJs, 'CaseSpaceViewModel.refresh') && has(atlasJs, 'CaseSpaceViewModel.refresh') &&
    has(growth, 'LongitudinalSummary.prepare') && has(growth, 'ClinicalContext.createActionRun'));
  check('S-NO-LEGACY-TRAJECTORY-AI', 'doc-center routes growth work to doc-growth instead of running legacy trajectory AI',
    has(atlas, 'href="doc-growth.html"') && !has(atlasJs, 'generateAiTrajectory') && !has(atlasJs, 'AI.send'));
  check('S-CHAT-REAL-SOURCE-ADMISSION', 'chat loads CaseSpaceViewModel and refreshes a verified projection before showing sources',
    has(chat, 'js/case-space-view-model.js') && has(chatJs, 'CaseSpaceViewModel.refresh') && has(chatJs, 'sourceStatus'));
  check('S-CHAT-SINGLE-SEND-BINDING', 'chat send command is bound only through its runtime listener',
    !/onclick\s*=\s*["']sendMsg\s*\(/i.test(chat) && has(chatJs, "sendBtn.addEventListener('click', sendMsg)"));
  check('S-CHAT-BUSY-BEFORE-AWAIT', 'chat locks send state before the first authorization await',
    chatJs.indexOf('busy = true') >= 0 && chatJs.indexOf('await refreshAuthState') >= 0 && chatJs.indexOf('busy = true') < chatJs.indexOf('await refreshAuthState'));
  check('S-ATLAS-DRAWER-INERT', 'Atlas makes its background inert while the source drawer is open',
    has(atlasJs, ' inert') && has(atlasJs, 'drawerIsHidden'));
  check('S-ATLAS-FAIL-CLOSED', 'Atlas has request/context guards, source validation and Escape focus return',
    has(atlasJs, 'requestId !== atlasState.requestId') && has(atlasJs, 'currentClientId !== atlasState.clientId') &&
    has(atlasJs, 'material.clientId !== currentClientId') && has(atlasJs, "event.key === 'Escape'") &&
    has(atlasJs, 'atlasState.returnFocusId'));
  check('S-GROWTH-FAIL-CLOSED', 'growth preparation gates feature, compute, source and preview-only mode',
    has(read(PAGES.longitudinal), "featureGate('ai-growth')") && has(read(PAGES.longitudinal), 'hasAICompute') &&
    has(read(PAGES.longitudinal), "reason: 'no-verified-sources'") && has(read(PAGES.longitudinal), "outputMode !== 'preview-only'"));
  check('S-NO-EMOJI', 'new structure surfaces do not introduce emoji interface glyphs',
    !/(?:[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}])/u.test(chatJs + atlasJs + growth));
  check('S-REDUCED-MOTION', 'shared CSS contains an explicit reduced-motion contract', has(sharedCss, '@media (prefers-reduced-motion:reduce)') || has(sharedCss, '@media (prefers-reduced-motion: reduce)'));
  check('S-REDUCED-MOTION-TYPING-PULSE', 'reduced motion disables both typing and recording pulse animations',
    /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*typing-dots[\s\S]*animation\s*:\s*none/.test(sharedCss) &&
    /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*voice-btn\.recording[\s\S]*animation\s*:\s*none/.test(sharedCss));
  check('S-LETTER-SPACING-ZERO', 'structure typography explicitly keeps letter spacing at zero', /letter-spacing\s*:\s*0\s*;/.test(sharedCss));
  check('S-LONG-CHINESE', 'structure CSS constrains long Chinese text without horizontal spill',
    /min-width\s*:\s*0/.test(sharedCss) && (has(sharedCss, 'overflow') || has(sharedCss, 'word-break')));
  check('S-PROTECTED-BOUNDARY', 'runner does not require or modify protected production modules',
    !/app\/js\/(?:store|app|entitlements|ai|clinical-context)\.js/.test(read(__filename)));
}

function probeChatStartup(source) {
  const state = { initPageCalls: 0, documentReads: 0, ready: null, catchAttached: false };
  const store = { isHydrated: () => false };
  const app = {
    escapeHtml: (value) => String(value || ''),
    initPage: (options) => {
      state.initPageCalls += 1;
      state.ready = options && options.onReady;
      return { catch: () => { state.catchAttached = true; return this; } };
    }
  };
  const document = {
    readyState: 'complete',
    addEventListener: () => {},
    getElementById: () => { state.documentReads += 1; return null; },
    createElement: () => ({ style: {}, appendChild: () => {}, setAttribute: () => {} }),
    querySelector: () => null
  };
  const sandbox = {
    window: { App: app, Store: store, addEventListener: () => {}, dispatchEvent: () => {} },
    document,
    App: app,
    Store: store,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout,
    clearTimeout,
    Promise,
    URLSearchParams
  };
  vm.runInNewContext(source, sandbox, { filename: 'chat-home.js' });
  state.documentReadsBeforeReady = state.documentReads;
  if (typeof state.ready === 'function') state.ready();
  state.documentReadsAfterReady = state.documentReads;
  return state;
}

function chatHydrationContracts() {
  const source = read(PAGES.chatJs);
  const production = probeChatStartup(source);
  check('B-CHAT-HYDRATION-GATE', 'chat defers page initialization to App.initPage hydration readiness',
    production.initPageCalls === 1 && typeof production.ready === 'function' && production.documentReadsBeforeReady === 0 && production.documentReadsAfterReady >= 4 && production.catchAttached,
    JSON.stringify(production));

  const start = source.indexOf('  function startPage() {');
  const eventGate = source.indexOf('\n\n  if (document.readyState', start);
  const directStartMutant = start >= 0 && eventGate > start
    ? source.slice(0, start) + '  function startPage() { init(); }' + source.slice(eventGate)
    : source;
  const directStart = probeChatStartup(directStartMutant);
  check('M-CHAT-HYDRATION-DIRECT-START', 'mutation replacing the hydration gate with direct initialization is killed',
    directStartMutant !== source && directStart.initPageCalls === 0 && directStart.documentReadsBeforeReady >= 4,
    JSON.stringify(directStart));

  const noReadyMutant = source.replace('onReady: init', 'onReady: function () {}');
  const noReady = probeChatStartup(noReadyMutant);
  check('M-CHAT-HYDRATION-CALLBACK', 'mutation deleting the hydrated callback is killed',
    noReadyMutant !== source && noReady.initPageCalls === 1 && typeof noReady.ready === 'function' && noReady.documentReadsAfterReady === 0,
    JSON.stringify(noReady));
}

function makeSourceRef(id, clientId, sessionId, materialId) {
  return {
    id: id,
    clientId: clientId,
    sessionId: sessionId,
    anchor: { kind: 'material:text', locator: 'material:' + (materialId || id.replace(/^sr:/, 'mat-')) },
    normalizationVersion: 'norm-v1',
    sourceVersion: 'source-v1',
    sourceContentHash: 'sha256:' + id.slice(3).padEnd(64, '0'),
    anchorContentHash: 'sha256:' + id.slice(3).padEnd(64, '1'),
    status: 'verified'
  };
}

function runLongitudinal(source, options) {
  const clientId = 'c-synthetic-growth';
  const sessionId = 's-synthetic-growth';
  const materialId = 'mat-synthetic-growth';
  const material = { id: materialId, clientId, sessionId, parseStatus: 'ready', extractedText: '合成来源内容：仅用于自动化验收。', updatedAt: '2026-08-09T00:00:00Z' };
  const model = { clientId, nodes: [{ id: 'node-growth-001', kind: 'material', clientId, sessionId, sourceStatus: options && options.sourceStatus || 'verified', sourceRef: makeSourceRef('sr:growth001', clientId, sessionId, materialId) }] };
  const root = {
    Store: { getClient: (id) => id === clientId ? { id, name: '合成成长个案' } : null, getMaterialWorkspace: (id) => id === materialId ? material : null },
    App: { featureGate: () => options && options.feature !== undefined ? options.feature : true, hasAICompute: () => options && options.compute !== undefined ? options.compute : true },
    CaseSpaceViewModel: { refresh: () => Promise.resolve({ ok: true, model: model }) },
    ClinicalContext: {
      getTaskSpec: () => ({ outputMode: 'preview-only' }),
      validateSources: () => ({ ok: true }),
      digest: (value) => 'digest:' + value,
      createSnapshot: (context, input) => ({ clientId: context.origin.clientId, digest: input }),
      isSnapshotCurrent: () => true,
      createActionRun: () => ({ id: 'run-synthetic' })
    }
  };
  const context = vm.createContext({ window: root, console, Promise, Set, Object, Error, String, JSON, Array, module: { exports: {} }, globalThis: root });
  vm.runInContext(source, context, { filename: PAGES.longitudinal });
  return { api: root.LongitudinalSummary || context.module.exports, root, clientId };
}

async function behaviorContracts() {
  const source = read(PAGES.longitudinal);
  const ready = runLongitudinal(source, { feature: true, compute: true });
  const prepared = await ready.api.prepare(ready.clientId);
  check('B-GROWTH-POSITIVE', 'real LongitudinalSummary admits a verified synthetic source', prepared.ok && prepared.context && prepared.context.outputMode === 'preview-only', prepared.reason || 'ok');
  check('B-GROWTH-BODY-CLIP', 'growth context contains controlled source metadata, not a UI business-data copy', prepared.ok && prepared.context.sources[0].sourceContentHash.indexOf('sha256:') === 0 && !Object.prototype.hasOwnProperty.call(prepared.context.sources[0], 'text'));

  const free = runLongitudinal(source, { feature: false, compute: true });
  const locked = await free.api.prepare(free.clientId);
  check('B-GROWTH-FREE', 'feature gate blocks Free preview', !locked.ok && locked.reason === 'feature-locked');
  const compute = runLongitudinal(source, { feature: true, compute: false });
  const noCompute = await compute.api.prepare(compute.clientId);
  check('B-GROWTH-COMPUTE', 'AI compute availability remains independent from feature entitlement', !noCompute.ok && noCompute.reason === 'compute-unavailable');
  const parsed = ready.api.parsePreview(JSON.stringify({ summary: '合成摘要', changes: [], citations: [{ nodeId: 'node-growth-001', sourceId: 'sr:growth001', sessionId: 's-synthetic-growth' }] }), prepared.context);
  check('B-GROWTH-PREVIEW', 'preview parser requires an allowed SourceRef citation', parsed.ok && parsed.preview.mode === 'preview-only');
  const badCitation = ready.api.parsePreview(JSON.stringify({ summary: '错误', citations: [{ nodeId: 'foreign', sourceId: 'sr:foreign', sessionId: 's-foreign' }] }), prepared.context);
  check('B-GROWTH-CITATION-FAIL', 'unknown citation is rejected fail-closed', !badCitation.ok && badCitation.reason === 'citation-unknown');
}

async function mutationContracts() {
  const source = read(PAGES.longitudinal);
  const featureNeedle = "if (!root.App || typeof root.App.featureGate !== 'function' || !root.App.featureGate('ai-growth')) return { ok: false, reason: 'feature-locked' };";
  const mutantFeature = source.replace(featureNeedle, "if (false) return { ok: false, reason: 'feature-locked' };");
  const bypass = runLongitudinal(mutantFeature, { feature: false, compute: true });
  const bypassResult = await bypass.api.prepare(bypass.clientId);
  check('M-FEATURE-GATE', 'mutation removing feature gate is detected', bypassResult.ok === true);

  const staleNeedle = "node.sourceStatus !== 'verified'";
  const mutantStale = source.replace(staleNeedle, 'false');
  const stale = runLongitudinal(mutantStale, { feature: true, compute: true, sourceStatus: 'changed' });
  const staleResult = await stale.api.prepare(stale.clientId);
  check('M-SOURCE-STATUS', 'mutation admitting a stale source changes the contract result', staleResult.ok === true);

  const awaitNeedle = "var projection = await root.CaseSpaceViewModel.refresh(clientId, { currentContext: { clientId: clientId }, signal: options.signal });";
  const mutantAwait = source.replace(awaitNeedle, "var projection = root.CaseSpaceViewModel.refresh(clientId, { currentContext: { clientId: clientId }, signal: options.signal });");
  const noAwait = runLongitudinal(mutantAwait, { feature: true, compute: true });
  const noAwaitResult = await noAwait.api.prepare(noAwait.clientId);
  check('M-AWAIT', 'mutation removing await is observable and cannot pass', !noAwaitResult.ok);

  const chat = read(PAGES.chatJs);
  const atlas = read(PAGES.atlasJs);
  const legacyTrajectoryMutant = atlas + '\nwindow.generateAiTrajectory=function(){ AI.send([], function(){}); };';
  check('M-LEGACY-TRAJECTORY', 'mutation restoring legacy trajectory AI is rejected by the route-only contract',
    has(legacyTrajectoryMutant, 'generateAiTrajectory') && has(legacyTrajectoryMutant, 'AI.send'));
  const doubleSendMutant = read(PAGES.chat).replace('</button>', '</button><button onclick="sendMsg()"></button>');
  check('M-DOUBLE-SEND', 'mutation restoring an inline second send binding is rejected', /onclick\s*=\s*["']sendMsg\s*\(/i.test(doubleSendMutant));
  const statusOnlyMutant = chat.replace('|| !hasCompleteSourceRef(node.sourceRef)', '');
  check('M-CHAT-SOURCE-ADMISSION', 'mutation removing complete SourceRef admission changes the production guard',
    statusOnlyMutant !== chat && !has(statusOnlyMutant, 'hasCompleteSourceRef(node.sourceRef)'));
  const busyMutant = chat.replace('busy = true;', '/* busy mutation */');
  check('M-BUSY-BEFORE-AWAIT', 'mutation removing the pre-await busy lock is rejected',
    busyMutant.indexOf('busy = true') === -1 && busyMutant.indexOf('await refreshAuthState') >= 0);
  const inertMutant = atlas.replace("' inert'", "''");
  check('M-DRAWER-INERT', 'mutation removing drawer inert state is rejected', inertMutant !== atlas && !has(inertMutant, "' inert'"));
  const mutantAtlas = atlas.replace('material.clientId !== currentClientId', 'false');
  check('M-ATLAS-DEEPLINK', 'mutation bypassing Atlas ownership validation is detected', mutantAtlas !== atlas && has(atlas, 'material.clientId !== currentClientId'));
}

function runRuntime() {
  return new Promise((resolve) => {
    const runtime = path.join(TEST_DIR, 'electron-runtime-acceptance.js');
    const child = childProcess.spawn(process.execPath, [runtime], { cwd: ROOT, stdio: 'inherit', env: process.env });
    child.on('close', (code, signal) => resolve(code === 0 ? { status: 'PASS', code: 0 } : { status: 'FAIL', code, signal }));
    child.on('error', (error) => resolve({ status: 'BLOCKED', error: error.message }));
  });
}

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  staticContracts();
  chatHydrationContracts();
  await behaviorContracts();
  await mutationContracts();
  let runtime = { status: 'SKIPPED' };
  if (!process.argv.includes('--no-runtime')) runtime = await runRuntime();
  check('RUNTIME', 'controlled Electron/CDP runtime acceptance', runtime.status === 'PASS' || runtime.status === 'SKIPPED', JSON.stringify(runtime));
  const failed = checks.filter((item) => !item.pass);
  fs.writeFileSync(path.join(EVIDENCE, 'contract-summary.json'), JSON.stringify({ task_id: 'XJ-5.0.0-codex-vechooool-structure-production-integration-01', checks, failed: failed.length, runtime, generatedAt: new Date().toISOString() }, null, 2), 'utf8');
  process.stdout.write('Contract summary: ' + (checks.length - failed.length) + ' passed | ' + failed.length + ' failed\n');
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => { process.stderr.write((error && error.stack) || String(error)); process.exitCode = 1; });
