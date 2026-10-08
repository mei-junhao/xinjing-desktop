/* ============================================================
   settings-update-ui.js — replace-mode settings.js update section
   (replaces settings.js:38-51 window.checkUpdate 3-second premature-success
   fallback; per serial_write_set[2]).
   - consumes a TYPED status stream (xj:update:status via
     window.__XJ_API__.update / __XJ_UPDATE_BRIDGE__);
   - success text appears ONLY after 'committed';
   - no fixed 3-second premature "already latest" fallback;
   - unknown states render a neutral '状态未知' and never claim success;
   - keyboard focus, reduced motion, narrow window and long Chinese text
     remain usable.
   ============================================================ */
(function () {
  'use strict';

  var STATE_TEXT = {
    checking: '正在检查更新…',
    available: '发现新版本',
    'awaiting-confirmation': '等待确认…',
    downloading: '正在下载更新…',
    verified: '已下载并校验通过',
    restarting: '正在重启以应用更新…',
    'health-check': '正在验证更新健康…',
    committed: '更新已完成',
    failed: '更新未完成',
    'rollback-pending': '回滚待处理…',
    'rolling-back': '正在回滚…',
    'rolled-back': '已回滚到原版本'
  };
  var UNKNOWN = '状态未知';

  // 2026-09-14（真实生产测试 P2-D）：failed 曾硬编码为「更新失败，已回滚到原版本」且完全不看
  // errorCode —— 于是「已是最新版本」与「健康探针失败」显示同一句话，并谎称发生了回滚。实测：
  // 点「检查更新」时线上 feed 与已装版本相同，validateFeed 在任何 writeMarker 之前就以
  // stale-or-downgrade-version 拒掉（无下载、无安装、无回滚）。现按 errorCode 给出准确文案。
  var ERROR_TEXT = {
    'stale-or-downgrade-version': '已是最新版本',
    'check-failed': '无法完成检查，请稍后重试',
    'single-flight': '已有检查更新正在进行中',
    'acceptance-mode': '当前为验收模式，不执行真实更新',
    'operation-conflict': '上一轮更新尚未结束，请稍后重试',
    'update-net-timeout': '下载更新超时，请检查网络后重试',
    'feed-channel-mismatch': '更新源通道不匹配，已停止更新',
    'feed-body-mismatch': '更新源内容校验失败，已停止更新',
    'invalid-signature': '更新包签名校验未通过，已停止更新',
    'strategy-artifact-mismatch': '更新产物与策略不匹配，已停止更新',
    'health-check-failed': '新版本健康检查未通过',
    'health-check-false': '新版本健康检查未通过',
    'health-timeout': '新版本健康检查超时',
    'health-marker-missing': '缺少健康检查标记',
    'health-version-mismatch': '健康检查版本不符',
    'health-channel-mismatch': '健康检查通道不符',
    'health-strategy-mismatch': '健康检查策略不符',
    'no-health-probe': '未找到健康检查探针',
    'rollback-previous-missing': '缺少可回滚的上一版本安装包',
    'rollback-strategy-failed': '回滚动作未成功执行',
    'update-failed': '更新未完成'
  };
  // 只有 failed 需要额外措辞；其余状态沿用 STATE_TEXT。
  function failureText(status) {
    var code = status && status.errorCode ? String(status.errorCode) : '';
    if (!code) return STATE_TEXT.failed;
    if (code === 'stale-or-downgrade-version') return ERROR_TEXT[code];
    var known = ERROR_TEXT[code];
    return known ? ('更新未完成：' + known) : ('更新未完成（' + code + '）');
  }

  var winRef = null;
  function bridge() {
    var w = winRef || window;
    var api = w.__XJ_API__ || {};
    if (api.update && api.update.onStatus) return api.update;
    return w.__XJ_UPDATE_BRIDGE__ || null;
  }

  function render(info, status) {
    if (!info) return;
    var state = status && status.state;
    if (!state || !Object.prototype.hasOwnProperty.call(STATE_TEXT, state)) {
      info.textContent = UNKNOWN; // never claim success on unknown input
      info.classList.remove('update-ok', 'update-warn');
      setBar(info, null);
      return;
    }
    // 2026-09-13（下载进度条）：downloading 状态带 progress 时显示百分比与进度条，
    // 让用户看到下载真实进展（此前只有文字「正在下载」，看起来像没反应）。
    var pct = status && typeof status.progress === 'number' ? Math.max(0, Math.min(100, status.progress)) : null;
    if (state === 'downloading') {
      info.textContent = '正在下载更新…' + (pct != null ? ' ' + pct + '%' : '') + (pct != null && pct >= 100 ? '（校验中…）' : '');
      setBar(info, pct == null ? 0 : pct);
    } else if (state === 'failed') {
      info.textContent = failureText(status);
      setBar(info, null);
    } else {
      info.textContent = STATE_TEXT[state];
      setBar(info, null);
    }
    // 「已是最新版本」是健康结果，不是失败：不标警告样式、也不声称回滚。
    var alreadyLatest = state === 'failed' && status && status.errorCode === 'stale-or-downgrade-version';
    info.classList.toggle('update-ok', status.committed === true);
    info.classList.toggle('update-warn', !alreadyLatest && (state === 'failed' || state === 'rolled-back' || state === 'rollback-pending' || state === 'rolling-back'));
    // Long Chinese text must wrap in narrow windows.
    info.style.whiteSpace = 'normal';
    info.style.wordBreak = 'break-all';
  }

  // 进度条元素：惰性创建在 #update-info 之后（不改变既有 DOM 约定）。
  function setBar(info, pct) {
    var doc = info.ownerDocument || document;
    var bar = doc.getElementById('update-progress-bar');
    if (pct == null) {
      if (bar) bar.style.display = 'none';
      return;
    }
    if (!bar) {
      bar = doc.createElement('div');
      bar.id = 'update-progress-bar';
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-label', '更新下载进度');
      var inner = doc.createElement('div');
      inner.className = 'update-progress-inner';
      inner.style.cssText = 'height:100%;width:0%;background:var(--accent,#5B6478);border-radius:3px;transition:width .25s ease';
      bar.style.cssText = 'height:6px;width:100%;max-width:320px;margin-top:6px;background:rgba(127,127,127,.22);border-radius:3px;overflow:hidden';
      bar.appendChild(inner);
      if (info.parentNode) info.parentNode.insertBefore(bar, info.nextSibling);
    }
    bar.style.display = 'block';
    bar.setAttribute('aria-valuenow', String(pct));
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    var fill = bar.firstChild;
    if (fill) fill.style.width = pct + '%';
  }

  function install(windowRef) {
    var win = windowRef || window;
    winRef = win;
    var info = win.document.getElementById('update-info');
    if (!info) return;
    // Narrow-window baseline: long Chinese status text always wraps.
    info.style.whiteSpace = 'normal';
    info.style.wordBreak = 'break-all';

    win.checkUpdate = function () {
      var b = bridge();
      if (!b || typeof b.check !== 'function') {
        render(info, null);
        return Promise.resolve(null);
      }
      render(info, { state: 'checking', committed: false });
      var strategy = /portable/i.test(String(win.navigator.userAgent)) ? 'portable' : 'installer';
      return b.check('stable', strategy).then(function (status) {
        render(info, status || { state: 'checking' });
        return status || { state: 'checking' };
      }).catch(function () {
        render(info, { state: 'failed', committed: false, errorCode: 'check-failed' });
        return { state: 'failed', committed: false, errorCode: 'check-failed' };
      });
    };

    var b = bridge();
    if (b && typeof b.onStatus === 'function') {
      b.onStatus(function (status) { render(info, status); });
    }
    // Reduced motion: never animate; text-only updates.
    if (info && win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      info.classList.add('reduce-motion');
    }
  }

  if (typeof module === 'object' && module.exports) module.exports = { install: install, STATE_TEXT: STATE_TEXT, UNKNOWN: UNKNOWN };
  else if (typeof window !== 'undefined') install(window);
})();
