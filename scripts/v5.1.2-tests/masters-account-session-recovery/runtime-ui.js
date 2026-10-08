'use strict';

const path = require('path');
const runtime = require('../XJ-5.1.2-masters-fold-fix-003/runtime-003.js');

async function main() {
  const session = await runtime.createSession({ name: '1024x700', width: 1024, height: 700 });
  const result = { status: 'BLOCKED', checks: [], consoleErrors: [], pageErrors: [] };
  const check = (name, pass, details) => result.checks.push({ name, pass: !!pass, details: details || null });
  try {
    await runtime.evaluate(session.cdp, `(() => {
      if (!window.App) window.App = {};
      App.featureGate = () => true;
      App.hasAICompute = () => true;
      if (window.Store) Store.saveMasterConversationDurable = async () => ({ ok: true });
      if (typeof MastersCore === 'undefined') return false;
      window.__xjRecoveryCalls = 0;
      MastersCore.callMaster = async () => {
        window.__xjRecoveryCalls += 1;
        return { error: '账号会话已失效或未登录，请重新登录后重试', errorCode: 'account_session_required' };
      };
      const card = document.querySelector('.master-card');
      if (!card) return false;
      card.click();
      return true;
    })()`);
    await runtime.waitFor(session.cdp, "!!document.querySelector('#msg-input') && !document.querySelector('#msg-input').disabled", 'master input', 10000);
    await runtime.evaluate(session.cdp, `(() => { const input = document.querySelector('#msg-input'); input.value = '合成会话恢复测试'; window.sendMessage(); return true; })()`);
    await runtime.waitFor(session.cdp, `!!document.querySelector('[data-masters-action="retry"]')`, 'recovery card', 10000);
    const first = await runtime.evaluate(session.cdp, `(() => ({
      calls: window.__xjRecoveryCalls,
      users: document.querySelectorAll('#chat-body .msg.user').length,
      retry: !!document.querySelector('[data-masters-action="retry"]'),
      account: !!document.querySelector('[data-masters-action="account"]'),
      text: (document.querySelector('.error-card') || {}).textContent || ''
    }))()`);
    check('账号会话失败显示恢复卡', first.retry && first.account && /重新登录/.test(first.text), first);
    check('失败轮次只保留一条用户消息', first.users === 1, first.users);

    await runtime.evaluate(session.cdp, `(() => { document.querySelector('[data-masters-action="retry"]').click(); return true; })()`);
    await runtime.waitFor(session.cdp, `window.__xjRecoveryCalls >= 2 && !!document.querySelector('[data-masters-action="retry"]')`, 'real retry', 10000);
    const second = await runtime.evaluate(session.cdp, `(() => ({ calls: window.__xjRecoveryCalls, users: document.querySelectorAll('#chat-body .msg.user').length }))()`);
    check('重试重新调用大师核心', second.calls >= 2, second.calls);
    check('重试不重复追加用户消息', second.users === 1, second.users);
    result.consoleErrors = session.consoleErrors.filter((item) => !runtime.isHarnessConsoleNoise(item)).map(runtime.consoleErrorText);
    result.pageErrors = session.pageErrors;
    check('运行时无页面/控制台错误', result.consoleErrors.length === 0 && result.pageErrors.length === 0, { console: result.consoleErrors, page: result.pageErrors.length });
    result.status = result.checks.every((item) => item.pass) ? 'PASS' : 'FAIL';
  } finally {
    await session.close();
  }
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'PASS' ? 0 : 2;
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 2; });
