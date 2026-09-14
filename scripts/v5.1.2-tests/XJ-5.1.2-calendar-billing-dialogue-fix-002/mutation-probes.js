'use strict';

const fs = require('fs');
const path = require('path');
const runtime = require('./runtime-002.js');

const TASK_ID = 'XJ-5.1.2-calendar-billing-dialogue-fix-002';
const EVIDENCE_TASK_ID = process.env.XJ_EVIDENCE_TASK_ID || TASK_ID;
const SCRATCH = path.join(runtime.SCRATCH, 'expected-red-002');
const CASES = [
  {
    id: 'ER1-remove-handler',
    description: '删除入口 handler 被替换为空实现时，trusted click 不得冒充打开确认框',
    kind: 'remove-handler',
  },
  {
    id: 'ER2-swallow-durable-failure',
    description: '确认层吞掉 durable {ok:false} 时，失败后确认框必须仍保留',
    kind: 'swallow-durable-failure',
  },
  {
    id: 'ER3-success-ui-first',
    description: 'durable 未实际删除却返回成功时，成功 UI 不得冒充删除完成',
    kind: 'success-ui-first',
  },
  {
    id: 'ER4-billing-no-render',
    description: '月历入口不导航时，已授权路径不得冒充完成',
    kind: 'billing-no-render',
  },
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function check(checks, label, pass, details) {
  checks.push({ label, pass: !!pass, details: details == null ? null : details });
}

function progress(item, mode, step) {
  process.stderr.write('[xj002-mutation] ' + item.id + '/' + mode + ' ' + step + '\n');
}

function consoleErrorText(item) {
  if (!item) return '';
  const parts = [];
  if (typeof item.text === 'string') parts.push(item.text);
  if (typeof item.description === 'string') parts.push(item.description);
  if (item.entry) {
    if (typeof item.entry.text === 'string') parts.push(item.entry.text);
    if (typeof item.entry.url === 'string') parts.push(item.entry.url);
  }
  if (Array.isArray(item.args)) {
    item.args.forEach((arg) => {
      if (!arg) return;
      if (typeof arg.value === 'string') parts.push(arg.value);
      if (typeof arg.description === 'string') parts.push(arg.description);
    });
  }
  return parts.join(' ');
}

function isCleanError(item) {
  const text = consoleErrorText(item);
  return /Electron sandboxed_renderer\\.bundle\\.js script failed to run/i.test(text)
    || /Cannot destructure property 'preloadScripts' of 'binding\\.startupData' as it is null/i.test(text);
}

async function settle(cdp, ms) {
  await runtime.sleep(ms || 800);
  return runtime.sessionSnapshot(cdp, 'xj002-session-mutation');
}

async function runCase(item, mode) {
  const mutated = mode === 'mutated';
  const caseRoot = path.join(SCRATCH, 'runs', item.id, mode, new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid);
  ensureDir(caseRoot);
  const checks = [];
  const actions = [];
  const evidence = {
    taskId: TASK_ID,
    caseId: item.id,
    mode,
    description: item.description,
    startedAt: runtime.now(),
    checks,
    actions,
    caseRoot,
    mutation: mutated ? item.kind : null,
  };
  let app = null;
  try {
    progress(item, mode, 'launch');
    app = await runtime.launch(item.kind === 'billing-no-render' ? { tier: 'pro' } : undefined);
    progress(item, mode, 'launched');
    if (item.kind === 'billing-no-render') {
      await runtime.navigateBillingShell(app);
      progress(item, mode, 'billing-shell');
      const seeded = await runtime.seedSynthetic(app.cdp, 'mutation');
      evidence.seed = seeded;
      check(checks, '合成账单会话可用', seeded && seeded.ok === true && seeded.session && Number(seeded.session.billing.fee) === 100, seeded);
      await runtime.installInteractionAudit(app.cdp);
      if (mutated) {
        await runtime.evaluate(app.cdp, '(() => { window.__xj002 = window.__xj002 || {}; window.__xj002.originalOpenFeaturePage = App.openFeaturePage; App.openFeaturePage = function () { return true; }; return true; })()');
      }
      await runtime.trustedClick(app.cdp, '#bf-open-calendar', actions);
      progress(item, mode, 'billing-clicked');
      const rendered = await runtime.evaluate(app.cdp, '(() => ({ url: location.href, calendar: !!document.querySelector(".bc-calendar"), eventText: document.querySelector(".bc-calendar") ? document.querySelector(".bc-calendar").textContent : "", busy: document.getElementById("bf-open-calendar") ? document.getElementById("bf-open-calendar").getAttribute("aria-busy") : null }))()');
      evidence.rendered = rendered;
      check(checks, '已授权月历真实导航并渲染合成数据', rendered.url.includes('billing-calendar.html') && rendered.calendar && rendered.eventText.includes('李小明'), rendered);
    } else {
      await runtime.navigateSession(app);
      progress(item, mode, 'session-calendar');
      const seeded = await runtime.seedSynthetic(app.cdp, 'mutation');
      evidence.seed = seeded;
      check(checks, '合成来访者与会话可用', seeded && seeded.ok === true && seeded.session && Number(seeded.session.billing.fee) === 100, seeded);
      await runtime.installInteractionAudit(app.cdp);
      await runtime.renderSession(app.cdp);
      await runtime.openDetail(app.cdp, actions);
      progress(item, mode, 'detail');

      if (item.kind === 'remove-handler') {
        if (mutated) {
          await runtime.evaluate(app.cdp, '(() => { window.__xj002 = window.__xj002 || {}; window.__xj002.originalRemoveSession = SessionCal.removeSession; SessionCal.removeSession = function () { return false; }; return true; })()');
        }
        await runtime.trustedClick(app.cdp, '.sc-modal .danger', actions);
        progress(item, mode, 'remove-handler-clicked');
        const result = await settle(app.cdp, 700);
        evidence.result = result;
        check(checks, '删除 trusted click 打开确认框', result.confirmVisible && result.detailVisible, result);
      } else if (item.kind === 'swallow-durable-failure') {
        if (mutated) {
          await runtime.evaluate(app.cdp, '(() => { window.__xj002 = window.__xj002 || {}; window.__xj002.originalConfirmDialog = App.confirmDialog; App.confirmDialog = function (message, onConfirm, danger) { return window.__xj002.originalConfirmDialog(message, async function () { await onConfirm(); return true; }, danger); }; return true; })()');
        }
        await runtime.openDeleteConfirmByClick(app.cdp, actions);
        await runtime.patchDeleteFailure(app.cdp);
        await runtime.confirmByEnter(app.cdp, actions);
        progress(item, mode, 'failure-confirmed');
        const result = await settle(app.cdp, 900);
        evidence.result = result;
        check(checks, 'durable {ok:false} 后确认框和详情仍保留', result.confirmVisible && result.detailVisible && result.session && result.session.id === seeded.sessionId, result);
        check(checks, 'durable 失败有明确失败反馈且无成功提示', result.toastText.includes('删除失败') && !result.toastText.includes('已删除会话'), result.toastText);
        await runtime.restoreDelete(app.cdp);
      } else if (item.kind === 'success-ui-first') {
        await runtime.openDeleteConfirmByClick(app.cdp, actions);
        if (mutated) {
          await runtime.evaluate(app.cdp, '(() => { window.__xj002 = window.__xj002 || {}; window.__xj002.originalDeleteSessionsDurable = Store.deleteSessionsDurable; Store.deleteSessionsDurable = async function () { return { ok: true }; }; return true; })()');
        }
        await runtime.confirmByEnter(app.cdp, actions);
        progress(item, mode, 'success-confirmed');
        const result = await settle(app.cdp, 900);
        evidence.result = result;
        check(checks, '确认成功后 durable 会话确实消失', !result.session && !result.detailVisible && !result.eventText, result);
        check(checks, '删除成功反馈明确', result.toastText.includes('已删除会话'), result.toastText);
      }
    }
  } catch (error) {
    evidence.error = { message: error.message, stack: error.stack };
  } finally {
    evidence.consoleErrors = app.consoleErrors.filter((item) => !isCleanError(item)).map(consoleErrorText);
    evidence.pageErrors = app.pageErrors.map((item) => item.text || 'renderer exception');
    evidence.status = checks.every((item) => item.pass) && !evidence.error && evidence.consoleErrors.length === 0 && evidence.pageErrors.length === 0 ? 'PASS' : 'FAIL';
    evidence.finishedAt = runtime.now();
    if (app) {
      let cleanup;
      try {
        progress(item, mode, 'closing');
        cleanup = await app.close(true);
        progress(item, mode, 'closed');
        evidence.cleanup = cleanup;
        if (!cleanup || cleanup.ok !== true) {
          evidence.status = 'FAIL';
          evidence.cleanupError = cleanup || { ok: false, error: 'cleanup returned no result' };
        }
        evidence.raw = await runtime.recordAppRaw(app, 'mutation-' + item.id + '-' + mode, cleanup);
      } catch (error) {
        evidence.status = 'FAIL';
        evidence.cleanupError = { message: error.message, stack: error.stack };
        evidence.raw = await runtime.recordAppRaw(app, 'mutation-' + item.id + '-' + mode, cleanup || { ok: false, error: evidence.cleanupError });
      }
    } else {
      evidence.status = 'FAIL';
      evidence.cleanupError = { ok: false, error: 'application launch did not produce a session' };
    }
  }
  writeJson(path.join(caseRoot, 'result.json'), evidence);
  return evidence;
}

async function main() {
  ensureDir(SCRATCH);
  const startedAt = runtime.now();
  const cases = [];
  for (const item of CASES) {
    const baseline = await runCase(item, 'baseline');
    const mutated = await runCase(item, 'mutated');
    cases.push({
      id: item.id,
      description: item.description,
      baseline,
      mutated,
      killed: baseline.status === 'PASS' && mutated.status === 'FAIL',
    });
  }
  const summary = {
    taskId: TASK_ID,
    evidenceTaskId: EVIDENCE_TASK_ID,
    evidenceRoot: runtime.SCRATCH,
    evidenceCardSha256: process.env.XJ_CARD_SHA || null,
    version: 'expected-red-002-v1',
    startedAt,
    finishedAt: runtime.now(),
    caseCount: cases.length,
    killedCount: cases.filter((item) => item.killed).length,
    status: cases.length === CASES.length && cases.every((item) => item.killed) ? 'PASS' : 'FAIL',
    cases,
  };
  writeJson(path.join(SCRATCH, 'summary.json'), summary);
  process.stdout.write(JSON.stringify({
    taskId: TASK_ID,
    status: summary.status,
    caseCount: summary.caseCount,
    killedCount: summary.killedCount,
    cases: cases.map((item) => ({
      id: item.id,
      baseline: item.baseline.status,
      mutated: item.mutated.status,
      killed: item.killed,
      failures: item.mutated.checks.filter((probe) => !probe.pass).map((probe) => probe.label),
    })),
  }, null, 2) + '\n');
  process.exitCode = summary.status === 'PASS' ? 0 : 2;
}

if (require.main === module) {
  main().catch((error) => {
    writeJson(path.join(SCRATCH, 'fatal.json'), { taskId: TASK_ID, status: 'FAIL', error: { message: error.message, stack: error.stack } });
    process.stderr.write((error.stack || error.message) + '\n');
    process.exitCode = 2;
  });
}

module.exports = { TASK_ID, SCRATCH, CASES, runCase, main };
