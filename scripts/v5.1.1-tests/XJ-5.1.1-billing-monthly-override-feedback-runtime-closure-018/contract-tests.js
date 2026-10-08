#!/usr/bin/env node
/*
 * XJ-5.1.1-billing-monthly-override-feedback-runtime-closure-018 — contract tests
 * Source-invariant checks against app/js/billing-calendar.js (the ONLY sanctioned
 * production change) and the read-only app/billing-calendar.html.
 *
 * Exit code: 0 = all invariants hold; 1 = at least one failed.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = process.cwd();
const PROD = path.join(ROOT, 'app', 'js', 'billing-calendar.js');
const HTML = path.join(ROOT, 'app', 'billing-calendar.html');

const EXPECTED_PROD_SHA =
  'B42FFB0429BEBC534885BA7A1AE68E9F23D89300B55EF0DE4F1CD0529948BC79';
const EXPECTED_HTML_SHA =
  '64313236C09D43D9A6B8CF4331AB9793EC8ED5F6496C2F2341DC711C01F29FFF';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const TASK = 'XJ-5.1.1-billing-monthly-override-feedback-runtime-closure-018';
const EVIDENCE_JSON = path.join(
  ROOT, 'qa', 'task-scratch', TASK, 'evidence', 'contract-tests.json');

let failures = 0;
const checks = [];

function record(ok, name, detail) {
  checks.push({ ok, name, detail });
  if (!ok) failures += 1;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  :: ' + detail : ''));
}

function extractBody(src, name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length - 1;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        return { head: m[0], body: src.slice(m.index, i + 1), start: m.index, end: i };
      }
    }
  }
  return null;
}

const count = (s, pat) => {
  const mm = s.match(pat);
  return mm ? mm.length : 0;
};
const has = (s, needle) => s.indexOf(needle) !== -1;

/* ------------------------------------------------------------------ */
/* load inputs                                                         */
/* ------------------------------------------------------------------ */
const prodSrc = fs.readFileSync(PROD, 'utf8');
const htmlSrc = fs.readFileSync(HTML, 'utf8');
const prodSha = sha256(prodSrc);
const htmlSha = sha256(htmlSrc);

const syntax = spawnSync(process.execPath, ['--check', PROD], {
  cwd: ROOT, encoding: 'utf8', timeout: 120000,
});

/* ------------------------------------------------------------------ */
/* A. artifact identity                                                */
/* ------------------------------------------------------------------ */
record(prodSha.toUpperCase() === EXPECTED_PROD_SHA,
  'A1 production SHA matches permitted working-tree state',
  prodSha + (prodSha === EXPECTED_PROD_SHA ? ' == ' + EXPECTED_PROD_SHA : ' != ' + EXPECTED_PROD_SHA));
record(htmlSha.toUpperCase() === EXPECTED_HTML_SHA,
  'A2 billing-calendar.html is byte-identical to base (read-only)',
  htmlSha + (htmlSha === EXPECTED_HTML_SHA ? ' == ' + EXPECTED_HTML_SHA : ' != ' + EXPECTED_HTML_SHA));
record(syntax.status === 0,
  'A3 node --check app/js/billing-calendar.js passes',
  'exit=' + syntax.status + (syntax.stderr ? ' stderr=' + syntax.stderr.trim().slice(0, 200) : ''));

/* ------------------------------------------------------------------ */
/* B. persistent feedback region (deliverable 1)                       */
/* ------------------------------------------------------------------ */
const fbDiv = /<div[^>]*class="[^"]*bc-inv-feedback[^"]*"[^>]*id="bc-inv-feedback"[^>]*role="status"/;
record(fbDiv.test(prodSrc), 'B1 feedback div id="bc-inv-feedback" + role="status" in markup', '');
record(/\baria-live="polite"/.test(prodSrc),
  'B2 feedback div carries aria-live="polite"', '');
record(/\baria-busy="false"/.test(prodSrc),
  'B3 feedback div starts aria-busy="false"', '');
record(/data-state="' \+ billingFeedbackTone/.test(prodSrc),
  'B4 feedback data-state bound to billingFeedbackTone (idle default)', '');
const setFb = extractBody(prodSrc, 'setBillingFeedback');
record(setFb !== null && /\.textContent\s*=/.test(setFb.body),
  'B5 setBillingFeedback writes textContent (not innerHTML)', setFb ? setFb.head : 'not found');
record(setFb === null || !/\.innerHTML\s*=/.test(setFb.body),
  'B6 setBillingFeedback never assigns innerHTML', '');
record(setFb === null || /setAttribute\(['"]data-state['"]\s*,\s*billingFeedbackTone\)/.test(setFb.body),
  'B7 setBillingFeedback sets data-state from tone', '');
record(setFb === null || /setAttribute\(['"]aria-busy['"]\s*,\s*billingFeedbackTone\s*===\s*['"]busy['"]/.test(setFb.body),
  'B8 setBillingFeedback syncs aria-busy (true when busy)', '');
record(setFb === null || /style\.color\s*=/.test(setFb.body),
  'B9 setBillingFeedback applies tone color', '');
record(/function clearBillingFeedback\(\)\s*\{\s*setBillingFeedback\([^)]*idle[^)]*\)/.test(prodSrc),
  'B10 clearBillingFeedback resets to idle', '');
const bindEv = extractBody(prodSrc, 'bindInvoiceEvents');
record(bindEv !== null && /clearBillingFeedback\(\)/.test(bindEv.body) && /renderInvoiceDetail\(/.test(bindEv.body),
  'B11 load handler clears feedback before rendering invoice detail',
  bindEv ? bindEv.head : 'not found');
record(/billingFeedbackText/.test(prodSrc) && /App\.escapeHtml\(billingFeedbackText\)/.test(prodSrc),
  'B12 feedback text survives render (re-rendered from billingFeedbackText)', '');

/* ------------------------------------------------------------------ */
/* C. doSettle rewrite (deliverable 3)                                 */
/* ------------------------------------------------------------------ */
const settle = extractBody(prodSrc, 'doSettle');
record(settle !== null, 'C1 doSettle function found', settle ? settle.head : 'missing');
record(/\basync\s+function\s+doSettle/.test(prodSrc),
  'C2 doSettle declared async', '');
const updCalls = settle ? count(settle.body, /await\s+Store\.updateClientDurable/g) : -1;
record(updCalls === 1,
  'C3 doSettle awaits Store.updateClientDurable exactly once', 'count=' + updCalls);
record(settle !== null && /await\s+Store\.updateClientDurable\(clientId\s*,\s*\{\s*billing:\s*billing\s*\}\)/.test(settle.body),
  'C4 single durable call passes exactly {billing: billing}', '');
record(settle !== null && /\bsaved\s*=\s*await\s+Store\.updateClientDurable/.test(settle.body),
  'C5 await result captured into saved variable', '');
record(settle !== null && /if\s*\(\s*!saved\s*\|\|\s*!saved\.ok\s*\)/.test(settle.body),
  'C6 success requires if (!saved || !saved.ok)', '');
record(settle !== null && /!saved\.ok/.test(settle.body),
  'C7 only saved.ok===true counts as success', '');
const failIdxs = [];
if (settle) {
  let fi = settle.body.indexOf('月结保存失败');
  while (fi !== -1) { failIdxs.push(fi); fi = settle.body.indexOf('月结保存失败', fi + 1); }
}
let failRenderFree = settle !== null && failIdxs.length >= 2;
for (const fi of failIdxs) {
  const slice = settle.body.slice(fi, fi + 400);
  if (/\.render\s*\(\s*\)/.test(slice)) failRenderFree = false;
}
record(failRenderFree,
  'C8 every failure branch fails closed without re-render (input+client+month preserved)',
  'failure feedback occurrences=' + failIdxs.length);
record(settle !== null && /\brender\s*\(\s*\)/.test(settle.body),
  'C9 success branch re-renders (receipt visible)', '');
const successIdx = settle ? settle.body.indexOf('月结已保存') : -1;
const renderIdx = settle && /\brender\s*\(\s*\)/.exec(settle.body) ? settle.body.indexOf('render()') : -1;
record(successIdx >= 0 && renderIdx > successIdx,
  'C10 render() only after success feedback', 'success@' + successIdx + ' render@' + renderIdx);
record(settle !== null && /ym\.replace\(['"]-['"]\s*,\s*['"]年['"]\)/.test(settle.body),
  'C11 success feedback shows 年月 label', '');
record(settle !== null && /newAmount\.toLocaleString\(\)/.test(settle.body),
  'C12 success feedback shows toLocaleString amount', '');
record(settle !== null && /newAmount\s*=\s*mode\s*===\s*['"]add['"]\s*\?\s*\(\s*prevAmount\s*\+\s*amount\s*\)\s*:\s*amount/.test(settle.body),
  'C13 mode semantics: add accumulates, replace overrides', '');
record(settle !== null && /oldMp\.filter\([^\n]*m\.month\s*!==\s*ym/.test(settle.body),
  'C14 replace filters previous records of the same month (other months untouched)', '');
record(settle !== null && /push\(\s*\{\s*month\s*:\s*ym\s*,\s*amount\s*:\s*newAmount\s*\}\s*\)/.test(settle.body),
  'C15 replace pushes exactly one {month, amount} record', '');
record(settle !== null && /try\s*\{/.test(settle.body) && /catch\s*\(/.test(settle.body) && /finally\s*\{/.test(settle.body),
  'C16 try/catch/finally present', '');
record(settle !== null && /finally\s*\{[^}]*billingSettleBusy\s*=\s*false/.test(settle.body),
  'C17 finally resets billingSettleBusy = false', '');
record(settle !== null && /if\s*\(\s*billingSettleBusy\s*\)/.test(settle.body),
  'C18 busy guard at top of doSettle (double-click / re-entry blocked)', '');
record(settle !== null && /billingSettleBusy\s*=\s*true/.test(settle.body),
  'C19 busy flag set before durable call', '');
record(settle !== null && /setBillingBusyUI\(true\)/.test(settle.body),
  'C20 busy UI enabled before durable call (buttons disabled)', '');
record(settle !== null && /setBillingBusyUI\(false\)/.test(settle.body),
  'C21 busy UI reset after settle', '');
record(settle !== null && /setBillingFeedback\(['"]正在保存/.test(settle.body),
  'C22 saving-in-progress feedback emitted (aria-busy=true)', '');
record(settle !== null &&
  /if\s*\(\s*!\(amount\s*>\s*0\)\s*\)/.test(settle.body) &&
  /amount\s*>\s*100000000/.test(settle.body) &&
  /if\s*\(\s*!\/\^\\d\{4\}-\\d\{2\}\$\/\.test\(ym\)\s*\)/.test(settle.body),
  'C23 invalid amount / oversized amount / bad month all fail closed before mutation', '');
const mutIdx = settle ? settle.body.indexOf('billingSettleBusy = true') : -1;
record(mutIdx > 0 && settle.body.slice(0, mutIdx).indexOf('updateClientDurable') === -1,
  'C24 no durable write before validation/busy-guard completes', 'firstMutation@' + mutIdx);
record(settle !== null && /catch\s*\(e\)[^}]*setBillingFeedback\(['"]月结保存失败：发生异常/.test(settle.body),
  'C25 exception path also fails closed with preserved input', '');
record(!/\.innerHTML\s*=/.test(settle ? settle.body : ''),
  'C26 doSettle never assigns innerHTML (no user-text XSS sink)', '');

/* ------------------------------------------------------------------ */
/* D. keyboard accessibility (deliverable 2)                           */
/* ------------------------------------------------------------------ */
record(has(prodSrc, 'type="button"') &&
  /id="bc-inv-toggle-override"[^>]*aria-expanded="false"[^>]*aria-controls="bc-inv-override-wrap"/.test(prodSrc),
  'D1 toggle is type=button, starts aria-expanded="false" + aria-controls', '');
const escFn = extractBody(prodSrc, 'bindOverrideEscape');
record(escFn !== null && /billingOverrideEscBound/.test(escFn.body),
  'D2 bindOverrideEscape exists with one-time bind guard', escFn ? escFn.head : 'missing');
record(escFn !== null && /e\.key\s*!==\s*['"]Escape['"]/.test(escFn.body),
  'D3 Escape handler keyed on e.key === "Escape"', '');
record(escFn !== null && /wrap\.style\.display\s*=\s*['"]none['"]/.test(escFn.body) &&
  /setAttribute\(['"]aria-expanded['"]\s*,\s*['"]false['"]\)/.test(escFn.body),
  'D4 Escape collapses wrap and syncs aria-expanded="false"', '');
record(escFn !== null && /toggle\.focus\(\)/.test(escFn.body),
  'D5 Escape returns focus to the expand toggle', '');
record(escFn !== null && !/updateClientDurable/.test(escFn.body) && !/\.render\s*\(/.test(escFn.body),
  'D6 Escape path writes nothing (no durable call, no re-render)', '');
record(/setAttribute\(['"]aria-expanded['"]\s*,\s*nowExpanded\s*\?\s*['"]true['"]\s*:\s*['"]false['"]\)/.test(prodSrc),
  'D7 expand path syncs aria-expanded=true/false with visible state', '');
record(/amtInput\.focus\(\)/.test(prodSrc),
  'D8 expand moves focus to amount input', '');
record(/amtInput\.select\(\)/.test(prodSrc),
  'D9 expand selects existing amount for overwrite', '');
record(/addEventListener\(['"]keydown['"]/.test(prodSrc),
  'D10 keydown listener registered for override interactions', '');

/* ------------------------------------------------------------------ */
/* F. busy UI helper                                                   */
/* ------------------------------------------------------------------ */
const busyFn = extractBody(prodSrc, 'setBillingBusyUI');
record(busyFn !== null, 'F1 setBillingBusyUI helper exists', busyFn ? busyFn.head : 'missing');
record(busyFn !== null && /forEach\(function \(id\)/.test(busyFn.body) &&
  /\.disabled\s*=\s*!!busy/.test(busyFn.body),
  'F2 busy helper disables fixed control ids (double-click blocked)', '');
record(busyFn !== null && /bc-inv-toggle-override/.test(busyFn.body) &&
  /bc-inv-settle-override/.test(busyFn.body),
  'F3 busy helper covers toggle + settle-override + settle + input', '');

/* ------------------------------------------------------------------ */
/* G. markup wiring                                                    */
/* ------------------------------------------------------------------ */
record(has(prodSrc, 'bc-inv-override-wrap'), 'G1 override wrapper id in markup', '');
record(has(prodSrc, 'bc-inv-feedback'), 'G2 feedback element id in markup', '');
record(has(prodSrc, 'bc-inv-settle-override'), 'G3 override save button present in markup', '');

/* ------------------------------------------------------------------ */
/* H. read-only html still wired                                       */
/* ------------------------------------------------------------------ */
record(!/<div[^>]*id="bc-inv-feedback"/.test(htmlSrc) || has(htmlSrc, 'billing-calendar.js'),
  'H1 html has no second feedback region that could shadow the JS-built one', '');

/* ------------------------------------------------------------------ */
/* write evidence                                                      */
/* ------------------------------------------------------------------ */
const evidence = {
  task: TASK,
  generated_at: new Date().toISOString(),
  cwd: ROOT,
  summary: { total: checks.length, passed: checks.length - failures, failed: failures },
  production: {
    path: PROD, sha256: prodSha, expected_sha256: EXPECTED_PROD_SHA,
    bytes: fs.statSync(PROD).size,
  },
  html: {
    path: HTML, sha256: htmlSha, expected_sha256: EXPECTED_HTML_SHA,
    bytes: fs.statSync(HTML).size,
  },
  syntax_check: {
    command: [process.execPath, '--check', PROD].join(' '),
    cwd: ROOT, exit: syntax.status,
    stdout: syntax.stdout || '', stderr: syntax.stderr || '',
  },
  checks,
  node_version: process.version,
};
fs.mkdirSync(path.dirname(EVIDENCE_JSON), { recursive: true });
const body = JSON.stringify(evidence, null, 2);
fs.writeFileSync(EVIDENCE_JSON, body, 'utf8');
const evidenceSha = sha256(fs.readFileSync(EVIDENCE_JSON));
console.log('\ncontract-tests: ' + (checks.length - failures) + '/' + checks.length + ' passed, ' + failures + ' failed');
console.log('evidence: ' + EVIDENCE_JSON + ' (sha256 ' + evidenceSha + ')');
process.exit(failures === 0 ? 0 : 1);
