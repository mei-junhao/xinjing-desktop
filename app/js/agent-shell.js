/* ============================================================
 * 心镜 XinJing — Agent 浮窗壳（v1.3.0 U1 页面层）
 *
 * 委托 agent-core.js 纯核跑 function-calling 循环；自己管：
 *   - 浮窗面板 DOM（展开/收起 + 消息流渲染）
 *   - inline 确认卡（写工具执行前用户确认/修改/取消）
 *   - toast 反馈 + 错误显示
 *   - 授权门控 UI（未激活时锁定）
 *
 * 入口：window.AgentOpen() / window.AgentSend(text) / window.AgentClose()
 * Agent DOM 注入主窗口 body 末尾固定定位（injectLayout 是 header.innerHTML 先清再赋值，
 * agent DOM 不能放 header，见方案 §2.2 / §7）。
 * ============================================================ */
'use strict';

(function () {
  let panelEl = null;       // 浮窗根容器
  let messagesEl = null;    // 消息流容器
  let inputEl = null;       // 输入框
  let messages = [];        // 对话历史（含 system）
  let busy = false;         // 防重入
  let lastWriteAction = null; // 撤销栈：最近一次写操作

  var MEM_KEY = 'xj_agent_messages_v1';
  var MEM_MAX = 20; // 跨页记忆最多保留 20 条（不含 system）

  // 跨页记忆：保存到 localStorage
  function saveMemory() {
    try {
      var chat = messages.filter(function (m) { return m.role !== 'system'; });
      if (chat.length > MEM_MAX) chat = chat.slice(-MEM_MAX);
      localStorage.setItem(MEM_KEY, JSON.stringify(chat));
    } catch (e) { /* ignore */ }
  }

  // 跨页记忆：从 localStorage 恢复
  function restoreMemory() {
    try {
      var saved = localStorage.getItem(MEM_KEY);
      if (saved) {
        var chat = JSON.parse(saved);
        if (Array.isArray(chat) && chat.length > 0) {
          // 在 system prompt 之后插入历史消息
          for (var i = 0; i < chat.length; i++) {
            messages.push(chat[i]);
            renderMsg(chat[i].role, chat[i].content);
          }
          // 显示恢复提示
          var note = el('div', 'xj-agent-msg xj-agent-system');
          note.innerHTML = '<span style="font-size:11px;color:var(--muted)">↩ 已恢复跨页对话记忆（' + chat.length + ' 条）</span>';
          messagesEl.appendChild(note);
        }
      }
    } catch (e) { /* ignore */ }
  }

  // 撤销：记录最近写操作
  function recordWriteAction(toolName, args, result) {
    lastWriteAction = { toolName: toolName, args: args, result: result, ts: Date.now() };
  }

  // 撤销：执行撤销（目前支持 billing.add_record 撤销）
  function undoLastWrite() {
    if (!lastWriteAction) {
      toast('没有可撤销的操作', 'info');
      return;
    }
    var w = lastWriteAction;
    if (w.toolName === 'billing.add_record' && w.result && w.result.sessionIds) {
      // 撤销记账：删除刚创建的会话
      try {
        w.result.sessionIds.forEach(function (sid) {
          if (typeof Store !== 'undefined' && Store.deleteSession) Store.deleteSession(sid);
        });
        toast('已撤销 ' + w.result.sessionIds.length + ' 条记账记录', 'success');
        lastWriteAction = null;
      } catch (e) {
        toast('撤销失败：' + (e.message || ''), 'error');
      }
    } else {
      toast('该操作不支持撤销', 'info');
    }
  }

  // ---------- 工具：DOM 创建 ----------
  function el(tag, className, html) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  // ---------- 构建浮窗 DOM ----------
  function buildPanel() {
    panelEl = el('div', 'xj-agent-panel');
    panelEl.innerHTML = `
      <div class="xj-agent-header">
        <span class="xj-agent-title">⚙ 心镜 Agent</span>
        <div style="display:flex;gap:4px;align-items:center">
          <button class="xj-agent-expand" title="全屏/小屏切换" style="border:none;background:transparent;color:inherit;font-size:14px;cursor:pointer;padding:4px 8px">⤢</button>
          <button class="xj-agent-toggle" title="收起">–</button>
        </div>
      </div>
      <div class="xj-agent-body">
        <div class="xj-agent-msgs" id="xj-agent-msgs"></div>
        <div class="xj-agent-input-row">
          <input id="xj-agent-input" class="xj-agent-input" placeholder="对心镜 Agent 说点什么..." />
          <button class="btn btn-primary btn-sm" id="xj-agent-send">发送</button>
        </div>
      </div>
    `;
    document.body.appendChild(panelEl);
    messagesEl = panelEl.querySelector('#xj-agent-msgs');
    inputEl = panelEl.querySelector('#xj-agent-input');
    // 绑定事件
    panelEl.querySelector('.xj-agent-toggle').addEventListener('click', toggleCollapse);
    panelEl.querySelector('.xj-agent-expand').addEventListener('click', toggleFullscreen);
    panelEl.querySelector('#xj-agent-send').addEventListener('click', onSend);
    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
    });
    // 初始化 messages
    messages = [{ role: 'system', content: '' }];
    try {
      if (typeof AgentCore !== 'undefined' && AgentCore.buildSystemPrompt) {
        messages[0].content = AgentCore.buildSystemPrompt();
      }
    } catch (e) { /* ignore */ }
    // 授权门控 UI（解锁时一并刷新档位横幅与欢迎语）
    refreshLock();
    // 跨页记忆：恢复上次对话
    restoreMemory();
  }

  function refreshLock() {
    if (!panelEl) return;
    let unlocked = true;
    try {
      if (typeof App !== 'undefined' && typeof App.aiUnlocked === 'function') {
        unlocked = App.aiUnlocked();
      }
    } catch (e) { /* ignore */ }
    const inputRow = panelEl.querySelector('.xj-agent-input-row');
    const msgArea = panelEl.querySelector('.xj-agent-msgs');
    let lockBanner = panelEl.querySelector('.xj-agent-lock');
    if (unlocked) {
      if (lockBanner) lockBanner.remove();
      if (inputRow) inputRow.style.display = '';
      // 解锁：渲染档位横幅 + 欢迎语
      refreshTierUI();
    } else {
      // 锁定：移除档位横幅与欢迎语，避免与锁提示并存
      const tierBanner = panelEl.querySelector('.xj-agent-tier');
      if (tierBanner) tierBanner.remove();
      const welcome = messagesEl && messagesEl.querySelector('#xj-agent-welcome');
      if (welcome) welcome.remove();
      if (inputRow) inputRow.style.display = 'none';
      if (!lockBanner && msgArea) {
        lockBanner = el('div', 'xj-agent-lock');
        lockBanner.innerHTML = '<div class="xj-agent-lock-inner">⚠ Agent 为付费功能，请先激活。<br><button class="btn btn-ghost btn-sm" style="margin-top:8px" id="xj-agent-activate-btn">输入激活码</button></div>';
        msgArea.appendChild(lockBanner);
        lockBanner.querySelector('#xj-agent-activate-btn').addEventListener('click', function () {
          if (window.__XJ_API__ && typeof window.__XJ_API__.openActivation === 'function') {
            window.__XJ_API__.openActivation();
          }
        });
      }
    }
  }

  // 档位信息：'user' = 用户高性能模型；'builtin' = 内置低性能免费模型
  function tierInfo() {
    try {
      if (typeof AI !== 'undefined' && AI.getTier) return AI.getTier();
    } catch (e) { /* ignore */ }
    return 'builtin';
  }

  // 根据当前档位刷新横幅 + 欢迎语（无锁时调用）
  function refreshTierUI() {
    if (!panelEl || !messagesEl) return;
    const tier = tierInfo();

    // 档位横幅（浮窗 body 顶部）
    let banner = panelEl.querySelector('.xj-agent-tier');
    if (!banner) {
      banner = el('div', 'xj-agent-tier');
      const body = panelEl.querySelector('.xj-agent-body');
      if (body) body.insertBefore(banner, body.firstChild);
    }
    banner.className = 'xj-agent-tier ' + (tier === 'user' ? 'tier-user' : 'tier-builtin');
    if (tier === 'user') {
      banner.textContent = '⚡ 已接入你的高性能模型（完全体）';
    } else {
      banner.innerHTML = '🌱 免费试用 · <span id="xj-agent-quota">v4-flash</span>（额度用尽降级基础模型）'
        + '<span id="xj-agent-quota-pct" style="float:right;opacity:.85"></span>';
    }
    updateAgentQuotaBadge();

    // 欢迎语（消息流首条）
    let welcome = messagesEl.querySelector('#xj-agent-welcome');
    if (!welcome) {
      welcome = el('div', 'xj-agent-msg xj-agent-system', '');
      welcome.id = 'xj-agent-welcome';
      messagesEl.insertBefore(welcome, messagesEl.firstChild);
    }
    welcome.innerHTML = tier === 'user'
      ? '你已接入高性能模型，我现在是完全体，可以做更多事。可以帮你记账、月结、查统计、改来访者信息。'
      : '我是内置低性能免费模型，只能完成普通任务（记账 / 月结 / 查统计 / 改来访者信息）。接入你的高性能模型后我能做更多。比如：<br>「帮张明记 4 月 10 号会谈 300 块次结没付」<br>「张明这个月收了多少」<br>「把张明的电话改成 138xxxx」';
  }

  // 试用额度小徽标（v1.7.0）：实时更新 Agent 浮窗档位横幅上的模型名与剩余百分比
  function updateAgentQuotaBadge() {
    if (!panelEl) return;
    const pctEl = panelEl.querySelector('#xj-agent-quota-pct');
    const qEl = panelEl.querySelector('#xj-agent-quota');
    if (!pctEl && !qEl) return;
    let tier = 'builtin';
    try { if (typeof AI !== 'undefined' && AI.getTier) tier = AI.getTier(); } catch (e) {}
    if (tier === 'user') return;
    const q = (typeof AI !== 'undefined' && AI.getQuota) ? AI.getQuota() : null;
    if (pctEl) pctEl.textContent = (q && q.percent != null) ? ('剩余 ' + q.percent + '%') : '';
    if (qEl) qEl.textContent = (q && q.tier === 'basic') ? '基础模型（已降级）' : 'v4-flash';
  }

  function toggleCollapse() {
    if (!panelEl) return;
    panelEl.classList.toggle('xj-agent-collapsed');
    const btn = panelEl.querySelector('.xj-agent-toggle');
    if (btn) btn.textContent = panelEl.classList.contains('xj-agent-collapsed') ? '+' : '–';
  }

  // 全屏/小屏切换（#6）：全屏时铺满视口右半；小屏（默认）为 400px 宽固定面板
  function toggleFullscreen() {
    if (!panelEl) return;
    panelEl.classList.toggle('xj-agent-fullscreen');
    const btn = panelEl.querySelector('.xj-agent-expand');
    if (btn) btn.textContent = panelEl.classList.contains('xj-agent-fullscreen') ? '⤡' : '⤢';
  }

  // ---------- 渲染单条消息 ----------
  function renderMsg(role, content) {
    if (!messagesEl) return;
    const cls = 'xj-agent-msg ' + (role === 'user' ? 'xj-agent-user' : (role === 'assistant' ? 'xj-agent-ai' : 'xj-agent-system'));
    const bubble = el('div', cls);
    bubble.innerHTML = App.escapeHtml ? App.escapeHtml(content || '') : (content || '');
    // 保留换行
    bubble.style.whiteSpace = 'pre-wrap';
    messagesEl.appendChild(bubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function renderTyping() {
    if (!messagesEl) return;
    const t = el('div', 'xj-agent-msg xj-agent-typing', '<span class="xj-typing-dot"></span><span class="xj-typing-dot"></span><span class="xj-typing-dot"></span> 思考中…');
    t.id = 'xj-agent-typing';
    messagesEl.appendChild(t);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return t;
  }
  function clearTyping() {
    const t = messagesEl && messagesEl.querySelector('#xj-agent-typing');
    if (t) t.remove();
  }

  function renderProgress(msg) {
    if (!messagesEl) return;
    const p = el('div', 'xj-agent-msg xj-agent-progress', App.escapeHtml ? App.escapeHtml(msg || '执行中…') : (msg || '执行中…'));
    messagesEl.appendChild(p);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // navigate_to 跳转提示卡（方案 B：仅提示，用户主动点击才跳转）
  function renderNavCard(card) {
    if (!messagesEl) return;
    const wrap = el('div', 'xj-agent-msg xj-agent-nav-card');
    const reason = card.reason ? ('<div class="xj-agent-nav-reason">' + App.escapeHtml(card.reason) + '</div>') : '';
    wrap.innerHTML =
      '<div class="xj-agent-nav-head">💡 建议前往「' + App.escapeHtml(card.label) + '」</div>' +
      reason +
      '<button class="btn btn-secondary btn-sm xj-agent-nav-go">' + App.escapeHtml(card.label) + ' →</button>';
    const goBtn = wrap.querySelector('.xj-agent-nav-go');
    if (goBtn) {
      goBtn.addEventListener('click', function () {
        if (card.href) location.href = card.href;
      });
    }
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ---------- inline 确认卡（写工具） ----------
  // 确认卡渲染：返回 Promise<{ ok, edited?, args? }>
  function requestConfirm(toolCall, args) {
    return new Promise(function (resolve) {
      if (!messagesEl) { resolve({ ok: false }); return; }
      const card = el('div', 'xj-agent-confirm-card');
      const toolName = (toolCall && toolCall.function && toolCall.function.name) || '';
      // 预览关键字段（不同工具渲染不同的字段）
      let previewHtml = '';
      try {
        previewHtml = renderConfirmPreview(toolName, args);
      } catch (e) { previewHtml = '<div style="font-size:12px;color:var(--muted)">参数：' + App.escapeHtml(JSON.stringify(args)) + '</div>'; }
      card.innerHTML =
        '<div class="xj-agent-confirm-title">⚠ 即将执行写入操作</div>' +
        '<div class="xj-agent-confirm-tool">工具：' + App.escapeHtml(toolName) + '</div>' +
        '<div class="xj-agent-confirm-preview">' + previewHtml + '</div>' +
        '<div class="xj-agent-confirm-actions">' +
          '<button class="btn btn-primary btn-sm xj-agent-confirm-ok">确认执行</button>' +
          '<button class="btn btn-ghost btn-sm xj-agent-confirm-cancel">取消</button>' +
        '</div>';
      messagesEl.appendChild(card);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      // 确认
      card.querySelector('.xj-agent-confirm-ok').addEventListener('click', function () {
        card.remove();
        resolve({ ok: true });
      });
      // 取消
      card.querySelector('.xj-agent-confirm-cancel').addEventListener('click', function () {
        card.remove();
        resolve({ ok: false });
      });
      // 本版暂不实现"修改"按钮（避免交互复杂化）；用户取消后可在对话里重新发起
    });
  }

  function renderConfirmPreview(toolName, args) {
    if (toolName === 'billing.add_record' && Array.isArray(args.records)) {
      const rows = args.records.map(function (r, i) {
        return '<div class="xj-agent-confirm-row">' +
          '<span>①</span>'.replace('①', (i + 1) + '.') +
          ' 来访者：<b>' + App.escapeHtml(r.clientName || r.clientId || '') + '</b> ' +
          '日期：<b>' + App.escapeHtml(r.date || '') + '</b> ' +
          '费用：<b>¥' + App.escapeHtml(String(r.fee || 0)) + '</b> ' +
          (r.settleType ? App.escapeHtml(r.settleType) + '·' : '') +
          (r.paid ? '已收' : '未收') +
        '</div>';
      }).join('');
      return '<div class="xj-agent-confirm-row-list">' + rows + '</div>';
    }
    if (toolName === 'billing.monthly_settle') {
      return '<div class="xj-agent-confirm-row">来访者：<b>' + App.escapeHtml(args.clientName || args.clientId || '') + '</b> 月份：<b>' + App.escapeHtml(args.month || '') + '</b> 金额：<b>¥' + App.escapeHtml(String(args.amount || 0)) + '</b></div>';
    }
    if (toolName === 'client.update') {
      const keys = Object.keys(args.patch || {}).join(', ');
      return '<div class="xj-agent-confirm-row">来访者 ID：<b>' + App.escapeHtml(args.clientId || '') + '</b><br>修改字段：<b>' + App.escapeHtml(keys) + '</b></div>';
    }
    if (toolName === 'supervision.start') {
      var modeName = args.supervisorName === 'cangjie' ? '\u4ed3\u988d\u7248' : '\u5973\u5a23\u7248';
      var materialPreview = String(args.material || '').slice(0, 200) + (String(args.material || '').length > 200 ? '\u2026' : '');
      return '<div class="xj-agent-confirm-row">' +
        '\u7763\u5bfc\u5e08\uff1a<b>' + App.escapeHtml(modeName) + '</b><br>' +
        '\u6765\u8bbf\u8005\uff1a<b>' + App.escapeHtml(args.clientName || args.clientId || '') + '</b><br>' +
        '\u6750\u6599\u9884\u89c8\uff1a<span style="font-size:12px;color:var(--muted)">' + App.escapeHtml(materialPreview) + '</span>' +
      '</div>';
    }
    return '<div style="font-size:12px;color:var(--muted)">参数：' + App.escapeHtml(JSON.stringify(args)) + '</div>';
  }

  // 主动跟进提示卡（写工具成功后由 runRound 经 onEvent 推送；非确认卡、不阻断）
  function renderFollowupCard(items) {
    if (!messagesEl || !Array.isArray(items) || !items.length) return;
    const wrap = el('div', 'xj-agent-msg xj-agent-followup-card');
    const lis = items.map(function (t) {
      return '<div class="xj-agent-followup-item">• ' + App.escapeHtml(t) + '</div>';
    }).join('');
    wrap.innerHTML = '<div class="xj-agent-followup-head">💡 跟进提示</div>' + lis;
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ---------- toast ----------
  function toast(msg, type) {
    if (typeof App !== 'undefined' && typeof App.showToast === 'function') {
      App.showToast(msg, type || 'success');
    }
  }

  // ---------- 发送 ----------
  async function onSend() {
    if (busy) return;
    refreshLock();
    let unlocked = true;
    try {
      if (typeof App !== 'undefined' && typeof App.aiUnlocked === 'function') unlocked = App.aiUnlocked();
    } catch (e) { /* ignore */ }
    if (!unlocked) { toast('Agent 为付费功能，请先激活', 'error'); return; }
    if (!inputEl) return;
    const text = (inputEl.value || '').trim();
    if (!text) return;
    inputEl.value = '';
    renderMsg('user', text);
    messages.push({ role: 'user', content: text });
    busy = true;
    const typingEl = renderTyping();
    try {
      const result = await AgentCore.runRound(messages, requestConfirm, function (name, status, data) {
        clearTyping();
        if (status === 'executing') renderProgress('正在执行：' + name + '…');
        else if (status === 'done') {
          // 配置 API 成功：自动切换到用户模型，刷新档位 UI + 完全体提示
          if (data && data.switchedTo === 'user') {
            refreshTierUI();
            toast('已切换到你的高性能模型，我现在是完全体，可以做更多事', 'success');
            return;
          }
          // 配置 API 测试失败：如实降级到内置模型，并说明原因
          if (data && data.switchedTo === 'builtin' && data.testError) {
            refreshTierUI();
            toast('接入测试未通过：' + data.testError + '，已降级到内置模型', 'error');
            return;
          }
          // 配置 API 多轮收集中（还差密钥）：提示进度，不切档位
          if (data && data.switchedTo === 'partial') {
            renderProgress(data.message || '已记录部分配置');
            return;
          }
          // navigate_to：渲染跳转提示卡（用户主动点击才跳转）
          if (data && data.card && data.card.kind === 'navigate_hint') {
            renderNavCard(data.card);
            return;
          }
          // 成功结果由 OBSERVE→RESPOND 处理或简洁提示
          if (data) {
            const summary = data.added !== undefined ? ('✓ 已新增 ' + data.added + ' 条记录' + (data.skipped ? '，跳过 ' + data.skipped + ' 条' : ''))
              : (data.receivable !== undefined ? ('✓ 应收 ¥' + data.receivable + ' / 已收 ¥' + data.received + ' / 余额 ¥' + data.balance)
              : '✓ 已完成');
            renderProgress(summary);
            // 撤销：记录写操作供 AgentUndo 使用
            if (data.added !== undefined && data.sessionIds) {
              recordWriteAction(name, {}, data);
            }
          }
        }
      }, function (evt) {
        // 层3 主动提示：写工具成功后经 onEvent 推送，渲染轻量跟进卡（非确认卡、不阻断）
        if (evt && evt.type === 'followups' && Array.isArray(evt.items) && evt.items.length) {
          renderFollowupCard(evt.items);
        }
      });
      clearTyping();
      if (result.error) {
        renderMsg('system', '⚠ ' + result.error);
      } else if (result.reply) {
        renderMsg('assistant', result.reply);
      }
    } catch (e) {
      clearTyping();
      renderMsg('system', '⚠ 执行异常：' + (e.message || '未知错误'));
    }
    busy = false;
    saveMemory();
  }

  // 撤销：最近写操作的撤销入口
  window.AgentUndo = undoLastWrite;

  // ---------- 入口：window.AgentOpen / Close / Send ----------
  window.AgentOpen = function () {
    if (!panelEl) buildPanel();
    // 面板位置跟随 FAB
    if (fabEl) {
      var rect = fabEl.getBoundingClientRect();
      panelEl.style.left = Math.max(0, Math.min(window.innerWidth - 390, rect.left - 360)) + 'px';
      panelEl.style.top = Math.max(0, Math.min(window.innerHeight - 500, rect.top - 280)) + 'px';
      panelEl.style.right = 'auto';
      panelEl.style.bottom = 'auto';
    }
    panelEl.classList.add('xj-agent-visible');
    if (inputEl) inputEl.focus();
  };
  window.AgentClose = function () {
    if (panelEl) panelEl.classList.remove('xj-agent-visible');
  };
  window.AgentSend = function (text) {
    if (!panelEl) buildPanel();
    if (!panelEl.classList.contains('xj-agent-visible')) panelEl.classList.add('xj-agent-visible');
    if (inputEl && text) { inputEl.value = text; onSend(); }
  };

  // 订阅主进程授权状态广播（激活/登出实时刷新锁）
  try {
    if (window.__XJ_API__ && typeof window.__XJ_API__.onLicenseState === 'function') {
      window.__XJ_API__.onLicenseState(function () { refreshLock(); });
    }
  } catch (e) { /* ignore */ }

  // 订阅试用额度变更，实时刷新浮窗档位徽标（v1.7.0）
  try {
    if (typeof AI !== 'undefined' && AI.onQuotaChange) {
      AI.onQuotaChange(function () { updateAgentQuotaBadge(); });
    }
  } catch (e) { /* ignore */ }

  // ---------- FAB 悬浮球已废弃（v3.4.0），由 xiaojing-panel.js 替代 ----------

  // 主动引擎：每日启动时检查待办（仅首页，避免每页弹窗）
  function dailyCheck() {
    try {
      if (location.pathname.indexOf('index.html') < 0 && location.pathname.indexOf('dashboard') < 0) return;
      var today = new Date().toISOString().slice(0, 10);
      var lastCheck = localStorage.getItem('xj_daily_check');
      if (lastCheck === today) return;
      localStorage.setItem('xj_daily_check', today);

      var sessions = [];
      try { if (typeof Store !== 'undefined') sessions = Store.getSessions(); } catch (e) {}
      var pending = sessions.filter(function (s) {
        var fee = (s.billing && s.billing.fee) || 0;
        return fee > 0 && !(s.billing && s.billing.paid);
      });

      var stale = [];
      try {
        if (typeof Store !== 'undefined') {
          var clients = Store.getClients().filter(function (c) { return c.status !== 'ended'; });
          var now = Date.now();
          clients.forEach(function (c) {
            var cs = sessions.filter(function (s) { return s.clientId === c.id; });
            cs.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
            if (cs.length > 0 && cs[0].date) {
              var daysAgo = Math.floor((now - new Date(cs[0].date).getTime()) / 86400000);
              if (daysAgo > 30) stale.push(c.name + '（' + daysAgo + '天未会谈）');
            }
          });
        }
      } catch (e) {}

      if (pending.length > 0 || stale.length > 0) {
        var msg = '';
        if (pending.length > 0) msg += '📋 ' + pending.length + ' 笔未收款 ';
        if (stale.length > 0) msg += '⏰ ' + stale.length + ' 位来访者待跟进';
        try {
          if (typeof App !== 'undefined' && App.showToast) App.showToast(msg.trim(), 'info');
        } catch (e) {}
      }
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', dailyCheck);
  } else {
    dailyCheck();
  }
})();
