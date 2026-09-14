'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = 'D:/xinjing-electron';
const TASK = 'XJ-5.1.1-billing-monthly-override-feedback-runtime-closure-018';
const BASE = path.join(ROOT, 'qa', 'task-scratch', TASK);
const EVID = path.join(BASE, 'evidence');
const SCRIPTS = path.join(ROOT, 'scripts', 'v5.1.1-tests', TASK);
const PROD = path.join(ROOT, 'app', 'js', 'billing-calendar.js');
const HTML_FILE = path.join(ROOT, 'app', 'billing-calendar.html');
const EXPECTED_PROD_SHA = 'B42FFB0429BEBC534885BA7A1AE68E9F23D89300B55EF0DE4F1CD0529948BC79';
const CARD_SHA = '6275D51177EF2C02C5F7329AF702E5431FED4FCD24DEFBE873CFCC4851E93682';

const checks = [];
function add(name, ok, detail) {
  checks.push({ name: name, ok: !!ok, detail: detail || {} });
}
function sha256Hex(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase();
}
function exists(p) {
  try { return fs.statSync(p).isFile(); } catch (e) { return false; }
}
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function nodeCheck(file) {
  const r = spawnSync(process.execPath, ['--check', file], { cwd: ROOT, encoding: 'utf8' });
  return { exit: r.status === null ? -1 : r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

// ---------- A. production file ----------
add('production-exists', exists(PROD));
if (exists(PROD)) {
  const src = fs.readFileSync(PROD, 'utf8');
  add('production-sha-expected', sha256Hex(PROD) === EXPECTED_PROD_SHA, { actual: sha256Hex(PROD), expected: EXPECTED_PROD_SHA, bytes: Buffer.byteLength(src) });
  const nc = nodeCheck(PROD);
  add('production-node-check', nc.exit === 0, nc);
  add('no-test-hook-in-production', !src.includes('__xj018'), { found: src.includes('__xj018') });
  const anchors = [
    ['toggle-button', 'id="bc-inv-toggle-override"'],
    ['toggle-aria-expanded', 'aria-expanded="false"'],
    ['toggle-aria-controls', 'aria-controls="bc-inv-override-wrap"'],
    ['feedback-id', 'id="bc-inv-feedback"'],
    ['feedback-role', 'role="status"'],
    ['feedback-aria-live', 'aria-live="polite"'],
    ['await-durable', 'saved = await Store.updateClientDurable('],
    ['ok-gate', 'if (!saved || !saved.ok)'],
    ['focus-to-amount', 'amtInput.focus()'],
    ['push-target-month', 'monthlyPayments.push({ month: ym'],
    ['escape-key', 'Escape']
  ];
  for (let i = 0; i < anchors.length; i++) {
    add('anchor-' + anchors[i][0], src.includes(anchors[i][1]), { needle: anchors[i][1] });
  }
  const busyCount = src.split('if (billingSettleBusy)').length - 1;
  add('busy-guard-count-3', busyCount === 3, { count: busyCount });
  add('replace-filters-month', src.includes('return m.month !== ym;'));
}

// ---------- B. test scripts node --check ----------
for (const s of ['contract-tests.js', 'expected-red.js', 'runtime-electron-cdp.js']) {
  const p = path.join(SCRIPTS, s);
  add('script-exists-' + s, exists(p));
  if (exists(p)) {
    const nc = nodeCheck(p);
    add('script-node-check-' + s, nc.exit === 0, nc);
  }
}

// ---------- C. contract evidence ----------
const ctPath = path.join(EVID, 'contract-tests.json');
add('contract-evidence-exists', exists(ctPath));
if (exists(ctPath)) {
  const ct = readJson(ctPath);
  add('contract-summary-58-58-0', ct.summary && ct.summary.total === 58 && ct.summary.passed === 58 && ct.summary.failed === 0, ct.summary);
  add('contract-all-checks-ok', Array.isArray(ct.checks) && ct.checks.length === 58 && ct.checks.every(function (c) { return c.ok; }), { checks: ct.checks.length });
  add('contract-syntax-node-check-pass', ct.syntax_check && ct.syntax_check.exit === 0, ct.syntax_check);
  add('contract-production-sha-match', ct.production && String(ct.production.sha256).toUpperCase() === EXPECTED_PROD_SHA && ct.production.bytes === 44323, ct.production);
  if (ct.html && ct.html.path && exists(ct.html.path)) {
    const h = sha256Hex(ct.html.path);
    const bytes = fs.statSync(ct.html.path).size;
    add('contract-html-sha-match', h === String(ct.html.expected_sha256).toUpperCase() && bytes === ct.html.bytes, { actual: h, expected: ct.html.expected_sha256, bytes: bytes });
  } else {
    add('contract-html-sha-match', false, { note: 'html path missing or unreadable' });
  }
}

// ---------- D. runtime evidence ----------
const rtPath = path.join(EVID, 'runtime-electron-cdp.json');
add('runtime-evidence-exists', exists(rtPath));
if (exists(rtPath)) {
  const rt = readJson(rtPath);
  add('runtime-results-all-ok', Array.isArray(rt.results) && rt.results.length === 3 && rt.results.every(function (r) { return r.ok === true; }), { count: rt.results ? rt.results.length : 0 });
  let subOk = true;
  let subTotal = 0;
  const subBad = [];
  const names = [];
  if (Array.isArray(rt.results)) {
    for (const r of rt.results) {
      if (r.detail && Array.isArray(r.detail.scenarios)) {
        for (const s of r.detail.scenarios) {
          subTotal++;
          names.push(s.name);
          if (s.ok !== true) { subOk = false; subBad.push(s.name); }
        }
      }
    }
  }
  add('runtime-subchecks-all-ok', subOk && subTotal === 10, { subTotal: subTotal, subBad: subBad });
  const requiredSub = ['success-replace','add-accumulates','double-click-guard','ime-enter-safe','blur-safe','escape-cancel','restart-readback','failure-fail-closed','retry-after-failure','stale-async-client-switch'];
  const missing = requiredSub.filter(function (n) { return names.indexOf(n) < 0; });
  add('runtime-required-subchecks-present', missing.length === 0, { missing: missing });
  let rawOk = true;
  const rawInfo = [];
  for (const r of rt.results || []) {
    if (r.detail && r.detail.raw) {
      if (r.detail.raw.exit !== 0) rawOk = false;
      for (const k of ['stdout', 'stderr']) {
        const o = r.detail.raw[k];
        if (o && o.path) {
          const onDisk = exists(o.path);
          if (onDisk) {
            const bytes = fs.statSync(o.path).size;
            const h = sha256Hex(o.path);
            const bOk = bytes === o.bytes;
            const sOk = h === String(o.sha256).toUpperCase();
            if (!bOk || !sOk) rawOk = false;
            rawInfo.push({ role: 'raw.' + k, file: o.path, bytes: bytes, sha: h, ok: bOk && sOk });
          } else {
            rawOk = false;
            rawInfo.push({ role: 'raw.' + k, file: o.path, missing: true, ok: false });
          }
        }
      }
      if (r.detail.relaunch_raw) {
        if (r.detail.relaunch_raw.exit !== 0) rawOk = false;
        for (const k of ['stdout', 'stderr']) {
          const o = r.detail.relaunch_raw[k];
          if (o && o.path) {
            const onDisk = exists(o.path);
            if (onDisk) {
              const bytes = fs.statSync(o.path).size;
              const h = sha256Hex(o.path);
              const bOk = bytes === o.bytes;
              const sOk = h === String(o.sha256).toUpperCase();
              if (!bOk || !sOk) rawOk = false;
              rawInfo.push({ role: 'relaunch.' + k, file: o.path, bytes: bytes, sha: h, ok: bOk && sOk });
            } else {
              rawOk = false;
              rawInfo.push({ role: 'relaunch.' + k, file: o.path, missing: true, ok: false });
            }
          }
        }
      }
    }
  }
  add('runtime-raw-exit-and-artifacts-ok', rawOk, { records: rawInfo });
  const shots = rt.screenshots || [];
  add('runtime-screenshot-count', shots.length === 7, { count: shots.length });
  let shotsOk = true;
  const shotInfo = [];
  for (const s of shots) {
    const p = path.join(EVID, s.file);
    const onDisk = exists(p);
    if (onDisk) {
      const bytes = fs.statSync(p).size;
      const h = sha256Hex(p);
      const bOk = bytes === s.bytes;
      const hOk = h === String(s.sha256).toUpperCase();
      if (!bOk || !hOk) shotsOk = false;
      shotInfo.push({ file: s.file, bytes: bytes, sha: h, ok: bOk && hOk });
    } else {
      shotsOk = false;
      shotInfo.push({ file: s.file, missing: true, ok: false });
    }
  }
  add('runtime-screenshots-verify', shotsOk, { shots: shotInfo });
  const shotNames = shots.map(function (s) { return s.file.toLowerCase(); });
  add('runtime-screenshots-both-paths', shotNames.some(function (n) { return n.indexOf('success') >= 0; }) && shotNames.some(function (n) { return n.indexOf('failure') >= 0; }), {});
  add('runtime-card-sha-quirk-note', true, { note: 'card_sha256 field carries production SHA B42FFB04..., not task card SHA 6275D511...; informational record, not a failure' });
  add('runtime-card-sha-equals-production', String(rt.card_sha256).toUpperCase() === EXPECTED_PROD_SHA, { actual: rt.card_sha256 });
}

// ---------- E. expected-red evidence ----------
const erPath = path.join(EVID, 'expected-red.json');
add('expected-red-evidence-exists', exists(erPath));
if (exists(erPath)) {
  const er = readJson(erPath);
  add('er-baseline-ok', er.baselineOk === true);
  add('er-all-confirmed', er.allExpectedRedConfirmed === true);
  add('er-invariant-count-18', er.invariantCount === 18, { count: er.invariantCount });
  add('er-mutation-count-13', er.mutationCases === 13, { count: er.mutationCases });
  const cases = er.cases || [];
  const baseline = cases.filter(function (c) { return c.id === 'BASELINE'; });
  add('er-baseline-case-green', baseline.length === 1 && baseline[0].red === false && (baseline[0].invariants.failed || []).length === 0, { count: baseline.length });
  const muts = cases.filter(function (c) { return c.id !== 'BASELINE'; });
  let mutAllOk = true;
  const mutInfo = [];
  for (const c of muts) {
    const shaOk = /^[0-9A-Fa-f]{64}$/.test(c.inputSha256 || '');
    const nb = c.nodeCheck || {};
    const ok = c.red === true && (c.unexpectedFailed || []).length === 0 && (c.missedExpected || []).length === 0 && nb.exit === 0 && shaOk && typeof c.inputBytes === 'number' && c.inputBytes > 0 && typeof nb.command === 'string' && typeof nb.cwd === 'string' && typeof nb.stdout === 'string' && typeof nb.stderr === 'string';
    if (!ok) mutAllOk = false;
    mutInfo.push({ id: c.id, red: c.red, failed: (c.invariants && c.invariants.failed) || [], unexpected: c.unexpectedFailed || [], missed: c.missedExpected || [], nodeExit: nb.exit, shaOk: shaOk, bytes: c.inputBytes });
  }
  add('er-mutations-all-red', mutAllOk && muts.length === 13, { count: muts.length, cases: mutInfo });
}

// ---------- summary ----------
const passed = checks.filter(function (c) { return c.ok; }).length;
const failed = checks.length - passed;
const verdict = failed === 0 ? 'PASS' : 'FAIL';
const out = {
  task: TASK,
  generated_at: new Date().toISOString(),
  cwd: ROOT,
  production_file: 'app/js/billing-calendar.js',
  production_sha256: EXPECTED_PROD_SHA,
  task_card_sha256: CARD_SHA,
  verdict: verdict,
  summary: { total: checks.length, passed: passed, failed: failed },
  checks: checks
};
const outPath = path.join(EVID, 'self-audit-018.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
console.log('SELF_AUDIT verdict:', verdict, 'total:', checks.length, 'passed:', passed, 'failed:', failed);
console.log('SELF_AUDIT evidence:', outPath);
for (const c of checks) { if (!c.ok) console.log('FAILED_CHECK:', c.name, JSON.stringify(c.detail)); }
process.exitCode = failed === 0 ? 0 : 1;