'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const HARNESS = __dirname;
const RUNNER = path.join(HARNESS, 'run-contract.js');
const STVM = path.join(ROOT, 'app', 'js', 'session-template-view-model.js');
const QR = path.join(ROOT, 'app', 'js', 'quick-record.js');
const CONSULT = path.join(ROOT, 'app', 'js', 'consult-notes.js');
const DASHBOARD = path.join(ROOT, 'app', 'js', 'dashboard.js');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-f2-mutation-'));
const results = [];

function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase(); }
function probe(id, title, sourceFile, mutate, extraEnv) {
  const source = fs.readFileSync(sourceFile, 'utf8');
  const mutated = mutate(source);
  if (mutated === source) {
    results.push({ id, title, verdict: 'harness_error', status: 'mutation-anchor-not-found' });
    console.log('[HARNESS_ERROR] ' + id + ' mutation anchor not found');
    return;
  }
  const mutatedPath = path.join(tmpRoot, id + '.js');
  const outputDir = path.join(tmpRoot, id + '-out');
  fs.writeFileSync(mutatedPath, mutated, 'utf8');
  const env = Object.assign({}, process.env, { XJ_TASK33_OUT_DIR: outputDir }, extraEnv || {});
  if (sourceFile === STVM) env.XJ_TASK33_STVM_SOURCE = mutatedPath;
  if (sourceFile === QR) env.XJ_TASK33_QR_SOURCE = mutatedPath;
  if (sourceFile === CONSULT) env.XJ_TASK33_CONSULT_SOURCE = mutatedPath;
  if (sourceFile === DASHBOARD) env.XJ_TASK33_DASHBOARD_SOURCE = mutatedPath;
  const run = spawnSync(process.execPath, [RUNNER], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 });
  const killed = run.status !== 0;
  results.push({ id, title, verdict: killed ? 'killed' : 'survived', status: run.status, signal: run.signal || null, mutated_hash: sha256(mutatedPath), stderr: String(run.stderr || '').split(/\r?\n/).filter(Boolean).slice(0, 2) });
  console.log('[' + (killed ? 'KILLED' : 'SURVIVED') + '] ' + id + ' ' + title);
}

try {
  probe('M01-TIER-FAIL-OPEN', 'unknown tier promotion to Flagship', STVM, (source) => source.replace("if (!current) return fail('unknown-tier');", "if (!current) current = 'Flagship';"));
  probe('M02-TRIAL-PROMOTION', 'trial paid preview becomes eligible', STVM, (source) => source.replace("var eligible = item.tier === 'Free' || (!access.trial && accessRank(access) >= TIER_RANK[item.tier]);", "var eligible = item.tier === 'Free' || (access.trial || accessRank(access) >= TIER_RANK[item.tier]);"));
  probe('M03-CUSTOM-ID-BYPASS', 'invalid custom template id is accepted', STVM, (source) => source.replace("if (!custom.ok || (custom.value && picked.template.id !== 'flagship-session-v1')) return fail('custom-template-invalid');", "if (false) return fail('custom-template-invalid');"));
  probe('M04-HANDLER-BYPASS', 'QuickRecord skips handler-side template validation', QR, (source) => source.replace('if (!selectionResult.ok) {', 'if (false) {'));
  probe('M05-SELECTION-AWAIT', 'selection write is not awaited', QR, (source) => source.replace('templateResult = await Store.saveSessionTemplateSelectionDurable(session.id, completion.selection);', 'templateResult = Store.saveSessionTemplateSelectionDurable(session.id, completion.selection);'));
  probe('M06-DUPLICATE-RETRY', 'retry creates a second session', QR, (source) => source.replace('if (state.lockedSessionId) {', 'if (false) {'));
  probe('M07-CONSULT-AWAIT', 'consultation selection write is not awaited', CONSULT, (source) => source.replace('selectionResult = await Store.saveSessionTemplateSelectionDurable(currentSessionId, templatePlan.selection);', 'selectionResult = Store.saveSessionTemplateSelectionDurable(currentSessionId, templatePlan.selection);'));
  probe('M08-LOCKED-OPTION', 'locked paid option remains selectable', DASHBOARD, (source) => source.replace("(item.locked ? ' disabled' : '')", "(false ? ' disabled' : '')"));
} finally {
  const out = {
    schema_version: 1,
    task_id: 'XJ-5.0.0-codex-v4.3-pro-flagship-template-production-33',
    probe_count: results.length,
    killed: results.filter((item) => item.verdict === 'killed').length,
    survived: results.filter((item) => item.verdict === 'survived').length,
    harness_errors: results.filter((item) => item.verdict === 'harness_error').length,
    all_killed: results.length === 8 && results.every((item) => item.verdict === 'killed'),
    source_hashes: {
      'session-template-view-model.js': sha256(STVM),
      'quick-record.js': sha256(QR),
      'consult-notes.js': sha256(CONSULT),
      'dashboard.js': sha256(DASHBOARD),
    },
    probes: results,
  };
  fs.writeFileSync(path.join(HARNESS, 'mutation-result.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
  if (!out.all_killed) process.exitCode = 1;
}
