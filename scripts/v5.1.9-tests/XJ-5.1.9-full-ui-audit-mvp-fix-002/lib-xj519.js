'use strict';
/* lib-xj519.js — XJ-5.1.9-full-ui-audit-mvp-fix-002 验收公共库。
 * 复用项目既有 QA harness（qa/task-scratch/XJ-5.0.2-.../harness-lib.js，只读 require）：
 * 回环合成账号服务 + 临时 userData + 默认拒网 + 回环 CDP 启动。
 * 本库只新增：受信 CDP 输入（trusted click / insertText / key）、断言求值、
 * AI 出站桥接观察器（捕获真实出站副本，可注入合成应答以走完链路）、登录引导。
 * 安全：一切网络仅 127.0.0.1；不记录真实凭据；合成数据以 xj519fx 前缀标记。
 */
const path = require('path');
const fs = require('fs');
const HARNESS = require('D:/xinjing-electron/qa/task-scratch/XJ-5.0.2-account-auth-desktop-enforcement-008/harness-lib.js');

const SCRATCH_ROOT = 'D:/xinjing-electron/qa/task-scratch/XJ-5.1.9-full-ui-audit-mvp-fix-002';

function ensureScratch(sub) {
  const dir = sub ? path.join(SCRATCH_ROOT, sub) : SCRATCH_ROOT;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sha256(value) { return HARNESS.sha256(value); }
function delay(ms) { return HARNESS.delay(ms); }

/* ---------- CDP 求值（带超时；超时本身是 Z4 类死锁的观测信号） ----------
 * 支持两种签名：evaluate(cdp, expr) 或 evaluate(expr)（使用 setCurrentCdp 绑定的当前实例）。 */
let currentCdp = null;
function setCurrentCdp(cdp) { currentCdp = cdp; }

async function evaluate(cdpOrExpr, expression, timeoutMs) {
  let cdp;
  let expr;
  if (typeof cdpOrExpr === 'string') { expr = cdpOrExpr; cdp = currentCdp; }
  else { cdp = cdpOrExpr; expr = expression; }
  if (!cdp || typeof cdp.send !== 'function') throw new Error('EVAL_NO_CDP_BOUND');
  const limit = timeoutMs || 10000;
  const result = await Promise.race([
    cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('EVALUATE_TIMEOUT_' + limit + 'ms')), limit)),
  ]);
  if (result && result.exceptionDetails) {
    const detail = result.exceptionDetails;
    const text = detail.exception && detail.exception.description ? detail.exception.description : JSON.stringify(detail).slice(0, 200);
    throw new Error('EVAL_ERROR: ' + text.slice(0, 300));
  }
  return result ? result.result && result.result.value : undefined;
}

async function screenshot(cdp, filePath) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(filePath, Buffer.from(shot.data, 'base64'));
  return filePath;
}

/* ---------- 受信 CDP Input 输入（与审计通道同级别：Input 域事件，非 .click()） ---------- */
async function trustedClick(cdp, finderExpr) {
  const point = await evaluate(cdp, `(() => {
    const el = (${finderExpr});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return null;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width, h: r.height };
  })()`);
  if (!point) throw new Error('TRUSTED_CLICK_TARGET_MISSING: ' + finderExpr);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  return point;
}

async function trustedType(cdp, finderExpr, text) {
  await trustedClick(cdp, finderExpr);
  // 先清空既有值（受信全选 + 删除），再 insertText。CDP modifiers 为整型位掩码（ctrl=2）。
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  if (text) await cdp.send('Input.insertText', { text });
}

async function trustedKey(cdp, key) {
  const map = {
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
  };
  const spec = map[key];
  if (!spec) throw new Error('UNSUPPORTED_KEY: ' + key);
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, spec));
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, spec));
}


/* 重试点击直到效果表达式成立（覆盖页面处理器晚绑定的时序伪影，非掩盖缺陷）。 */
async function trustedClickUntil(cdp, finderExpr, effectExpr, tries, gapMs) {
  const total = tries || 6;
  for (let i = 0; i < total; i++) {
    try { await trustedClick(cdp, finderExpr); } catch (e) { /* 元素暂不可点，等待重试 */ }
    await delay(gapMs || 450);
    let ok = false;
    try { ok = await evaluate(cdp, effectExpr, 4000); } catch (e) { ok = false; }
    if (ok) return { attempts: i + 1 };
  }
  throw new Error('CLICK_EFFECT_TIMEOUT after ' + total + ' tries: ' + effectExpr.slice(0, 120));
}


/* 输入后校验实际值，未写入则重试（消除受信输入偶发失效的时序伪影）。 */
async function trustedTypeVerified(cdp, finderExpr, text, tries) {
  const total = tries || 3;
  for (let i = 0; i < total; i++) {
    await trustedType(cdp, finderExpr, text);
    await delay(200);
    let value = null;
    try { value = await evaluate(cdp, `(() => { const el = (${finderExpr}); return el ? String(el.value || '') : null; })()`, 4000); } catch (e) { value = null; }
    if (value === text) return { attempts: i + 1 };
  }
  throw new Error('TYPE_VERIFY_TIMEOUT: ' + finderExpr.slice(0, 80));
}

async function waitFor(cdp, expr, timeoutMs, pollMs) {
  const deadline = Date.now() + (timeoutMs || 10000);
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await evaluate(cdp, expr, 5000);
      if (last) return last;
    } catch (e) { last = String(e.message || e); }
    await delay(pollMs || 250);
  }
  throw new Error('WAIT_TIMEOUT: ' + expr + ' | last=' + JSON.stringify(last).slice(0, 200));
}

/* ---------- AI 观察器（挂在主世界模块对象上；contextBridge 的 __XJ_API__ 只读不可包装） ----------
 * mode: 'observe' = AI.send 透传原链路（拒网下出站失败），捕获 XJPIISanitizer 输出=真实出站副本；
 *       'canned'  = AI.send 返回合成应答（不触网），用于走完链路统计请求数；
 *       'hold'    = AI.send 挂起，abort 信号到达时按真实语义返回 ABORT_ERR 结果。
 */
function observerSource(mode) {
  return `(() => {
    window.__xjObs = window.__xjObs || { aiCalls: [], piiOutbound: [], mode: null };
    const obs = window.__xjObs;
    if (obs.mode === ${JSON.stringify(mode)} && window.AI && window.AI.__xjWrapped) {
      return { installed: true, calls: obs.aiCalls.length };
    }
    if (typeof window.AI === 'undefined' || typeof window.AI.send !== 'function') return { installed: false, reason: 'AI module missing' };
    // 换模式时先恢复真实实现，杜绝「包装器上再包包装」导致原链路永不执行。
    if (window.AI.__xjWrapped && obs.originalSend) {
      window.AI.send = obs.originalSend;
      window.AI.__xjWrapped = false;
    }
    obs.mode = ${JSON.stringify(mode)};
    obs.aiCalls = [];
    obs.piiOutbound = [];
    const origSend = window.AI.send;
    if (!obs.originalSend) obs.originalSend = origSend;
    window.AI.send = function (messages, callback, options) {
      let snapshot = '';
      try { snapshot = JSON.stringify(messages || []); } catch (e) { snapshot = '[]'; }
      obs.aiCalls.push({ ts: Date.now(), messagesSnapshot: snapshot.slice(0, 12000) });
      if (${JSON.stringify(mode)} === 'canned') {
        setTimeout(function () { callback({ content: '（合成回复 xj519fx）', transportState: 'primary-ready' }); }, 30);
        return;
      }
      if (${JSON.stringify(mode)} === 'hold') {
        const timer = setInterval(() => {
          if (options && options.signal && options.signal.aborted) {
            clearInterval(timer);
            callback({ error: '已取消生成', code: 'ABORT_ERR', errorCode: 'aborted', interrupted: true, transportState: 'manual-only' });
          }
        }, 80);
        return;
      }
      return origSend.call(window.AI, messages, callback, options);
    };
    window.AI.__xjWrapped = true;
    // 预载并包装本地脱敏器：其返回值即「脱敏后的出站副本」（ai.js 归一化只重组角色不改写内容）。
    function wrapSanitizer() {
      const s = window.XJPIISanitizer;
      if (!s || typeof s.sanitizeMessages !== 'function' || s.__xjWrapped) return !!s;
      const origSanitize = s.sanitizeMessages;
      s.sanitizeMessages = function (messages) {
        const result = origSanitize.call(s, messages);
        try { obs.piiOutbound.push(JSON.stringify(result && result.messages || [])); } catch (e) { /* ignore */ }
        return result;
      };
      s.__xjWrapped = true;
      return true;
    }
    if (!wrapSanitizer() && typeof document !== 'undefined' && !document.getElementById('xj519fx-pii-script')) {
      const script = document.createElement('script');
      script.id = 'xj519fx-pii-script';
      script.src = 'js/pii-sanitizer.js';
      script.onload = wrapSanitizer;
      (document.head || document.documentElement).appendChild(script);
    }
    return { installed: true, calls: obs.aiCalls.length };
  })()`;
}

async function installObserver(cdp, mode) {
  const state = await evaluate(cdp, observerSource(mode));
  if (!state || !state.installed) throw new Error('OBSERVER_INSTALL_FAILED: ' + JSON.stringify(state));
  return state;
}

async function observerState(cdp) {
  return evaluate(cdp, `(() => {
    const o = window.__xjObs || {};
    return {
      aiCalls: (o.aiCalls || []).length,
      piiOutbound: o.piiOutbound || [],
      lastOutbound: (o.piiOutbound && o.piiOutbound.length) ? o.piiOutbound[o.piiOutbound.length - 1] : null,
    };
  })()`);
}

/* ---------- 合成账号注册 + 验证 + 登录（全部走回环 mock，生产零触达） ---------- */
async function registerVerifyLogin(cdp, mock, account) {
  await cdp.send('Page.enable');
  // 等账号页 DOM 就绪（首帧可能是加载态）。
  await waitFor(cdp, `document.readyState === 'complete' && !!document.getElementById('tab-register')`, 25000);
  await trustedClick(cdp, `document.getElementById('tab-register')`);
  await waitFor(cdp, `!document.getElementById('pane-register').hidden && !!document.getElementById('register-email') && document.getElementById('register-email').offsetParent !== null`, 10000);
  await trustedTypeVerified(cdp, `document.getElementById('register-email')`, account.email);
  await trustedTypeVerified(cdp, `document.getElementById('register-password')`, account.password);
  await trustedTypeVerified(cdp, `document.getElementById('register-password2')`, account.password);
  await trustedClick(cdp, `document.getElementById('register-submit')`);
  // 合成 mailer 的验证码只经本进程内 mock 暴露，不落群消息/报告。
  let token = '';
  for (let i = 0; i < 40 && !token; i++) { await delay(250); token = String(mock.lastVerificationToken() || ''); }
  if (!token) throw new Error('NO_VERIFICATION_TOKEN_FROM_MOCK');
  await waitFor(cdp, `document.getElementById('view-verify') && !document.getElementById('view-verify').hidden && document.getElementById('verify-token').offsetParent !== null`, 15000);
  await trustedTypeVerified(cdp, `document.getElementById('verify-token')`, token);
  await trustedClick(cdp, `document.getElementById('verify-submit')`);
  await waitFor(cdp, `document.getElementById('pane-login') && !document.getElementById('pane-login').hidden && document.getElementById('login-email').offsetParent !== null`, 15000);
  await trustedTypeVerified(cdp, `document.getElementById('login-email')`, account.email);
  await trustedType(cdp, `document.getElementById('login-password')`, account.password);
  await trustedClick(cdp, `document.getElementById('login-submit')`);
  // 登录成功后主进程解除账号门禁；等待离开账号页；失败时转储页面现场。
  try {
    await waitFor(cdp, `!location.pathname.endsWith('account.html')`, 30000);
  } catch (e) {
    const dump = await evaluate(cdp, `document.body.innerText.replace(/\\s+/g, ' ').slice(0, 500)`, 5000).catch(() => 'EVAL_FAIL');
    throw new Error('LOGIN_DID_NOT_LEAVE_ACCOUNT_PAGE | page=' + dump);
  }
  return { verified: true, tokenMasked: 'len=' + token.length };
}

/* ---------- 场景记录 ---------- */
function createRecorder() {
  const results = [];
  return {
    record(id, name, pass, evidence, note) {
      results.push({ id, name, pass: !!pass, evidence: evidence || {}, note: note || '', at: new Date().toISOString() });
      process.stdout.write((pass ? 'PASS ' : 'FAIL ') + id + ' ' + name + (pass ? '' : ' | ' + JSON.stringify(evidence || {}).slice(0, 300)) + '\n');
    },
    get results() { return results; },
    get allPass() { return results.every((r) => r.pass); },
    write(file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
    },
  };
}

module.exports = {
  HARNESS, SCRATCH_ROOT, ensureScratch, sha256, delay,
  evaluate, setCurrentCdp, screenshot, trustedClick, trustedType, trustedKey, waitFor,
  installObserver, observerState, trustedClickUntil, trustedTypeVerified, registerVerifyLogin, createRecorder,
};
