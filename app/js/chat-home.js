'use strict';

(function () {
  let msgsEl = null;
  let inputEl = null;
  let sendBtn = null;
  let voiceBtn = null;
  let messages = [];
  let busy = false;
  let recognition = null;
  let isRecording = false;
  let lastWriteAction = null;
  let undoPending = false;
  let structureContextRequestId = 0;
  let initialized = false;
  let hydrationFailed = false;
  let draftSeq = 0;

  const MEM_KEY = 'xj_xinjing_chat_v1';
  const MEM_MAX = 50;
  const WORKFLOW_ROUTES = [
    { key: 'realSupervision', label: '真人督导', href: 'real-supervision.html', pattern: /真人督导|督导录音|督导转写/ },
    { key: 'supervision', label: 'AI 督导', href: 'supervision.html', pattern: /督导|案例分析|个案分析/ },
    { key: 'transcript', label: '逐字稿', href: 'transcript.html', pattern: /逐字稿|录音整理|转写/ },
    { key: 'reports', label: '报告撰写', href: 'report-writing.html', pattern: /报告|SOAP|DAP|APA/ },
    { key: 'masters', label: '大师对话', href: 'masters.html', pattern: /大师对话|多大师|圆桌|温尼科特|弗洛伊德|荣格|拉康/ },
    { key: 'calendar', label: '咨询日历', href: 'session-calendar.html', pattern: /日历|排期|预约|安排下次|日程/ },
    { key: 'knowledge', label: '资料库', href: 'knowledge.html', pattern: /资料库|知识库|检索资料/ },
    { key: 'documents', label: '文档中心', href: 'doc-center.html', pattern: /文档中心|个案档案|临床材料|时间线/ },
    { key: 'settings', label: '设置', href: 'settings.html', pattern: /设置|API\s*密钥|接口配置|模型配置/ },
    { key: 'billing', label: '账务', href: 'billing-shell.html', pattern: /记账|账单|月结|收款|未收款|欠费|收入统计|查看.*收入/ },
    { key: 'consultations', label: '咨询记录', href: 'consult-notes.html', pattern: /咨询记录|会谈记录|记录.*咨询|记录.*会谈|补.*记录/ },
    { key: 'clients', label: '来访者', href: 'consult-notes.html', pattern: /新建来访者|管理来访者|编辑来访者|修改来访者资料/ }
  ];

  function workflowRouteForText(text) {
    return WORKFLOW_ROUTES.find(function (route) { return route.pattern.test(text || ''); }) || null;
  }

  function workflowRouteForKey(key) {
    return WORKFLOW_ROUTES.find(function (route) { return route.key === key; }) || null;
  }

  function el(tag, className, html) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  function esc(s) {
    if (typeof App !== 'undefined' && App.escapeHtml) return App.escapeHtml(s);
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  const COMMERCIAL_STATUS_LABELS = Object.freeze({
    settled: '本次已扣费',
    released: '本次未扣费 · 已释放',
    'pending-reconciliation': '扣费待核对',
    'not-applicable': '本次未扣费',
  });
  const COMMERCIAL_MODE_LABELS = Object.freeze({
    'money-per-request': '按次计费',
    'request-count-quota': '次数额度',
    byok: '自带密钥',
    trial: '试用额度',
  });
  const COMMERCIAL_NUMERIC_FIELDS = Object.freeze([
    'chargedMinor', 'priceMinor', 'catalogRevision', 'remainingBalanceMinor',
    'availableBalanceMinor', 'quotaRemaining',
  ]);

  function isSafeNonNegativeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  // The entitlement module owns the canonical allowlist; this second gate
  // keeps malformed monetary values out of the chat DOM without changing billing semantics.
  function normalizeChatCommercial(value) {
    if (typeof XJEntitlements === 'undefined' || !XJEntitlements.normalizeCommercialProjection) return null;
    const normalized = XJEntitlements.normalizeCommercialProjection(value);
    if (!normalized || !normalized.billing) return null;
    const billing = normalized.billing;
    if (!Object.prototype.hasOwnProperty.call(COMMERCIAL_STATUS_LABELS, billing.chargeStatus)) return null;
    for (const field of COMMERCIAL_NUMERIC_FIELDS) {
      if (billing[field] !== undefined && billing[field] !== null && !isSafeNonNegativeInteger(billing[field])) return null;
    }
    if (billing.currency !== undefined && billing.currency !== null && billing.currency !== 'CNY') return null;

    if (billing.billingMode === 'money-per-request') {
      if (billing.chargeStatus === 'not-applicable' || billing.currency !== 'CNY') return null;
      if (billing.chargeStatus === 'settled' && !isSafeNonNegativeInteger(billing.chargedMinor)) return null;
    } else {
      if (billing.chargeStatus !== 'not-applicable') return null;
      const moneyFields = ['chargedMinor', 'priceMinor', 'catalogRevision', 'remainingBalanceMinor', 'availableBalanceMinor'];
      if (moneyFields.some(function (field) { return billing[field] !== undefined && billing[field] !== null; })) return null;
      if (billing.currency !== undefined && billing.currency !== null) return null;
    }
    return normalized;
  }

  function formatCnyMinor(value) {
    if (!isSafeNonNegativeInteger(value)) return null;
    return '¥' + (value / 100).toFixed(2);
  }

  function appendCommercialItem(meta, text, className) {
    const item = el('span', 'commercial-meta-item' + (className ? ' ' + className : ''));
    item.textContent = text;
    meta.appendChild(item);
  }

  function renderCommercialMeta(value) {
    const normalized = normalizeChatCommercial(value);
    if (!normalized) return null;
    const billing = normalized.billing;
    const meta = el('div', 'commercial-meta');
    meta.setAttribute('aria-label', '本次请求费用信息');
    appendCommercialItem(meta, COMMERCIAL_MODE_LABELS[billing.billingMode] || '计费信息', 'commercial-mode');
    appendCommercialItem(meta, COMMERCIAL_STATUS_LABELS[billing.chargeStatus], 'commercial-status');

    const charged = formatCnyMinor(billing.chargedMinor);
    if (charged && billing.chargeStatus === 'settled') appendCommercialItem(meta, '费用 ' + charged, 'commercial-amount');
    const available = billing.availableBalanceMinor !== undefined
      ? formatCnyMinor(billing.availableBalanceMinor)
      : formatCnyMinor(billing.remainingBalanceMinor);
    if (available) appendCommercialItem(meta, '可用余额 ' + available, 'commercial-balance');
    if (isSafeNonNegativeInteger(billing.quotaRemaining)) appendCommercialItem(meta, '剩余次数 ' + billing.quotaRemaining, 'commercial-quota');
    return meta;
  }

  function markNewModelMessages(startIndex) {
    for (let i = startIndex; i < messages.length; i += 1) {
      const message = messages[i];
      if (message && !message.role && (typeof message.content === 'string' || Array.isArray(message.tool_calls))) {
        message.role = 'assistant';
      }
    }
  }

  function saveMemory() {
    try {
      const chat = messages.filter(m => m.role !== 'system');
      const toSave = chat.length > MEM_MAX ? chat.slice(-MEM_MAX) : chat;
      localStorage.setItem(MEM_KEY, JSON.stringify(toSave));
    } catch (e) {}
  }

  function restoreMemory() {
    try {
      const saved = localStorage.getItem(MEM_KEY);
      if (saved) {
        const chat = JSON.parse(saved);
        if (Array.isArray(chat) && chat.length > 0) {
          chat.forEach(m => {
            messages.push(m);
            renderMsg(m.role, m.content, m.commercial);
          });
          renderSystem('已恢复跨页对话记忆（' + chat.length + ' 条）', 'history');
        }
      }
    } catch (e) {}
  }

  function resolveDraftSnapshot() {
    const snap = { clientName: '', sessionLabel: '', sourceCount: 0 };
    try {
      if (window.XJClinicalWorkspace && typeof window.XJClinicalWorkspace.resolveContext === 'function') {
        const ctx = window.XJClinicalWorkspace.resolveContext({ preferRecentSession: true });
        if (ctx && ctx.clientId && typeof Store !== 'undefined' && Store.getClient) {
          const client = Store.getClient(ctx.clientId);
          if (client) snap.clientName = client.name || '';
          if (ctx.session && window.XJClinicalWorkspace.formatSession) {
            snap.sessionLabel = window.XJClinicalWorkspace.formatSession(ctx.session) || '';
          }
        }
      }
      const sourceList = document.getElementById('chat-source-list');
      if (sourceList) {
        const verified = sourceList.querySelectorAll('.xj-source-ref[data-status="verified"]');
        snap.sourceCount = verified ? verified.length : 0;
      }
    } catch (e) {}
    return snap;
  }

  function buildDraftFooter(meta, msgEl) {
    const footer = el('div', 'chat-draft-meta');
    const head = el('div', 'chat-draft-head');
    const badge = el('span', 'chat-draft-badge', 'AI 草稿 · 待人工确认');
    head.appendChild(badge);
    head.appendChild(el('span', 'chat-draft-run', '运行 ' + (meta.runId || '未知')));
    footer.appendChild(head);
    const snap = meta.snapshot || {};
    const sourceText = snap.clientName ? (snap.clientName + (snap.sessionLabel ? ' · ' + snap.sessionLabel : '')) : '未绑定来访者/会谈';
    const sourceCountText = snap.sourceCount > 0 ? (snap.sourceCount + ' 项已验证来源') : '无已验证来源';
    const source = el('div', 'chat-draft-source', '<i data-lucide="file-check-2" aria-hidden="true"></i><span>来源 ' + esc(sourceText) + ' · ' + esc(sourceCountText) + '</span>');
    footer.appendChild(source);
    const actions = el('div', 'chat-draft-actions');
    const confirm = el('button', 'chat-draft-btn confirm', '确认采纳');
    confirm.type = 'button';
    confirm.setAttribute('aria-label', '确认采纳此 AI 草稿（仅本机标记）');
    const cancel = el('button', 'chat-draft-btn cancel', '取消草稿');
    cancel.type = 'button';
    cancel.setAttribute('aria-label', '取消此 AI 草稿');
    actions.appendChild(confirm);
    actions.appendChild(cancel);
    footer.appendChild(actions);
    if (window.IconSystem) window.IconSystem.render(footer);
    confirm.addEventListener('click', function () {
      if (confirm.dataset.done) return;
      confirm.dataset.done = '1';
      badge.textContent = '已人工确认（本机标记）';
      badge.classList.add('confirmed');
      confirm.disabled = true;
      cancel.disabled = true;
      if (meta.messageRef) meta.messageRef.draftConfirmed = true;
    });
    cancel.addEventListener('click', function () {
      if (meta.messageRef) {
        const idx = messages.indexOf(meta.messageRef);
        if (idx >= 0) messages.splice(idx, 1);
        saveMemory();
      }
      if (msgEl && msgEl.parentNode) msgEl.parentNode.removeChild(msgEl);
    });
    return footer;
  }

  function findLastAssistantRef(replyText) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m && m.role === 'assistant' && typeof m.content === 'string' && m.content === replyText) return m;
    }
    return null;
  }

  function renderMsg(role, content, commercial, meta) {
    if (!msgsEl) return;
    const displayRole = role === 'assistant' ? 'assistant' : role;
    const msgEl = el('div', 'chat-msg ' + displayRole);
    const avatar = el('div', 'avatar', role === 'user' ? '我' : '心');
    const bubble = el('div', 'bubble', esc(content || ''));
    if (role === 'assistant') {
      const commercialMeta = renderCommercialMeta(commercial);
      if (commercialMeta) bubble.appendChild(commercialMeta);
      if (meta && meta.draft) bubble.appendChild(buildDraftFooter(meta, msgEl));
    }
    msgEl.appendChild(avatar);
    msgEl.appendChild(bubble);
    msgsEl.appendChild(msgEl);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return msgEl;
  }

  function renderTyping() {
    if (!msgsEl) return;
    const msgEl = el('div', 'chat-msg typing');
    const avatar = el('div', 'avatar', '心');
    const bubble = el('div', 'bubble', '<div class="typing-dots"><span></span><span></span><span></span></div>');
    msgEl.appendChild(avatar);
    msgEl.appendChild(bubble);
    msgEl.id = 'chat-typing';
    msgsEl.appendChild(msgEl);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return msgEl;
  }

  function clearTyping() {
    const t = msgsEl && msgsEl.querySelector('#chat-typing');
    if (t) t.remove();
  }

  function renderSystem(content, iconName, tone) {
    if (!msgsEl) return;
    const msgEl = el('div', 'chat-msg system');
    const bubble = el('div', 'bubble');
    if (tone) bubble.dataset.tone = tone;
    if (iconName) {
      const icon = el('i', 'chat-system-icon');
      icon.setAttribute('data-lucide', iconName);
      icon.setAttribute('aria-hidden', 'true');
      bubble.appendChild(icon);
    }
    const label = el('span', 'chat-system-copy');
    label.textContent = String(content || '');
    bubble.appendChild(label);
    msgEl.appendChild(bubble);
    msgsEl.appendChild(msgEl);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    if (window.IconSystem) window.IconSystem.render(msgEl);
  }

  function renderProgress(msg) {
    renderSystem(msg || '执行中...', 'loader-circle');
  }

  function renderFollowupCard(items) {
    if (!msgsEl || !Array.isArray(items) || !items.length) return;
    const msgEl = el('div', 'chat-msg assistant');
    const avatar = el('div', 'avatar', '心');
    const bubble = el('div', 'bubble');
    bubble.innerHTML = '<div style="font-size:12px;font-weight:600;color:var(--ink-3);margin-bottom:6px"><i data-lucide="lightbulb" aria-hidden="true"></i> 跟进提示</div>' +
      items.map(function (t) {
        return '<div class="followup-item" style="font-size:13px;padding:4px 0;cursor:pointer;color:var(--ink-2)">• ' + esc(t) + '</div>';
      }).join('');
    msgEl.appendChild(avatar);
    msgEl.appendChild(bubble);
    msgsEl.appendChild(msgEl);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    if (window.IconSystem) window.IconSystem.render(msgEl);
    bubble.querySelectorAll('.followup-item').forEach(function (item) {
      item.addEventListener('click', function () {
        if (inputEl) { inputEl.value = item.textContent.replace(/^[•\s]+/, ''); sendMsg(); }
      });
    });
  }

  function renderNavCard(card) {
    if (!msgsEl || !card) return;
    const msgEl = el('div', 'chat-msg assistant');
    const avatar = el('div', 'avatar', '心');
    const bubble = el('div', 'bubble');
    const reason = card.reason ? ('<div style="font-size:12px;color:var(--ink-3);margin-bottom:8px">' + esc(card.reason) + '</div>') : '';
    bubble.innerHTML = '<div style="font-weight:600;margin-bottom:4px"><i data-lucide="lightbulb" aria-hidden="true"></i> 建议前往「' + esc(card.label || '') + '」</div>' +
      reason +
      '<button class="nav-go-btn" style="margin-top:8px;padding:6px 14px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;font-size:12px;cursor:pointer">打开 <i data-lucide="arrow-right"></i></button>';
    msgEl.appendChild(avatar);
    msgEl.appendChild(bubble);
    msgsEl.appendChild(msgEl);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    bubble.querySelector('.nav-go-btn').addEventListener('click', function () {
      if (card.href) location.href = card.href;
    });
    if (window.IconSystem) window.IconSystem.render(msgEl);
  }

  function renderWelcome() {
    if (!msgsEl) return;
    const welcome = el('div', 'welcome-card');
    const today = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });

    let quickBtns = '';
    try {
      if (typeof Store !== 'undefined') {
        const sessions = Store.getSessions();
        const pending = sessions.filter(s => {
          const fee = (s.billing && s.billing.fee) || 0;
          return fee > 0 && !(s.billing && s.billing.paid);
        });
        const hasPending = pending.length > 0;
        quickBtns = `
          <button class="quick-btn" data-route="consultations"><i data-lucide="notebook-pen"></i>记录咨询</button>
          <button class="quick-btn" data-route="billing"><i data-lucide="chart-no-axes-column-increasing"></i>账务统计</button>
          <button class="quick-btn" data-route="billing"><i data-lucide="circle-dollar-sign"></i>${hasPending ? pending.length + '笔未收' : '未收款'}</button>
          <button class="quick-btn" data-route="supervision"><i data-lucide="brain-circuit"></i>AI督导</button>
          <button class="quick-btn" data-route="calendar"><i data-lucide="calendar-days"></i>咨询日历</button>
        `;
      }
    } catch (e) {
      quickBtns = `
        <button class="quick-btn" data-route="consultations"><i data-lucide="notebook-pen"></i>记录咨询</button>
        <button class="quick-btn" data-route="billing"><i data-lucide="chart-no-axes-column-increasing"></i>账务统计</button>
      `;
    }

    welcome.innerHTML = `
      <div class="title"><i data-lucide="hand" aria-hidden="true"></i> 你好，今天是 ${today}</div>
      <div class="desc">我是小镜，可以查询工作数据并回答问题。记录、账务、督导等完整工作会进入对应的专业页面。</div>
      <div class="quick-actions">${quickBtns}</div>
    `;
    msgsEl.appendChild(welcome);
    if (window.IconSystem) window.IconSystem.render(welcome);
    welcome.querySelectorAll('.quick-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var route = workflowRouteForKey(btn.getAttribute('data-route'));
        if (route) location.href = route.href;
      });
    });
  }

  function renderTierBanner() {
    var actions = document.querySelector('.chat-header .actions');
    if (!actions) return;
    var previous = actions.querySelector('.chat-membership-status');
    if (previous) previous.remove();
    // 用 IPC 授权状态判断，不用 AI.getTier（那是模型档位，不是会员档位）
    var tier = 'free';
    var unlocked = false;
    if (authState) {
      tier = authState.tier || 'free';
      unlocked = !!authState.aiUnlocked;
    } else if (window.__XJ__) {
      tier = window.__XJ__.tier || 'free';
      unlocked = !!window.__XJ__.aiUnlocked;
    }
    // 授权状态只决定 AI 对话是否可用，不扩大页面操作边界；状态不再占用临床消息流。
    var status = el('span', 'chat-membership-status ' + (unlocked ? 'pro' : tier));
    status.setAttribute('role', 'status');
    if (unlocked || tier === 'full' || tier === 'pro' || tier === 'custom') {
      status.textContent = 'AI 对话可用';
    } else {
      status.textContent = '基础额度';
    }
    actions.insertBefore(status, actions.firstChild);
  }

  function hasCompleteSourceRef(sourceRef) {
    var hash = /^sha256:[a-f0-9]{64}$/i;
    return !!(sourceRef && String(sourceRef.id || '').trim() &&
      String(sourceRef.normalizationVersion || '').trim() &&
      String(sourceRef.sourceVersion || '').trim() &&
      hash.test(String(sourceRef.sourceContentHash || '')) &&
      hash.test(String(sourceRef.anchorContentHash || '')));
  }

  function renderStructureContext() {
    const requestId = ++structureContextRequestId;
    if (!window.XJClinicalWorkspace) return;
    const contextStrip = document.getElementById('chat-context-strip');
    const historyList = document.getElementById('chat-history-list');
    const sourceList = document.getElementById('chat-source-list');
    const search = document.getElementById('chat-history-search');
    if (!contextStrip || !historyList || !sourceList) return;

    if (hydrationFailed) {
      historyList.innerHTML = '<div class="xj-workspace-error"><p>本机数据未能加载。请关闭后重新打开此页，再重试。</p></div>';
      sourceList.innerHTML = '<div class="xj-workspace-error"><p>来源未显示：本机数据加载失败。请恢复数据后重试。</p></div>';
      window.XJClinicalWorkspace.refreshIcons(document.querySelector('.chat-context-panel'));
      return;
    }

    const rows = window.XJClinicalWorkspace.recentClientRows(12);
    const filter = search ? (search.value || '').trim().toLowerCase() : '';
    const visibleRows = rows.filter(function (row) {
      const name = String((row.client && row.client.name) || '').toLowerCase();
      const session = String((row.session && (row.session.title || row.session.topic)) || '').toLowerCase();
      return !filter || name.indexOf(filter) >= 0 || session.indexOf(filter) >= 0;
    });
    const context = window.XJClinicalWorkspace.resolveContext({ preferRecentSession: true });
    historyList.innerHTML = visibleRows.length ? visibleRows.map(function (row) {
      const active = context.clientId && row.client.id === context.clientId;
      const sessionLabel = row.session ? window.XJClinicalWorkspace.formatSession(row.session) : '暂无会谈';
      const title = row.session && (row.session.title || row.session.topic) ? row.session.title || row.session.topic : '未命名会谈';
      return '<button type="button" class="chat-history-item' + (active ? ' active' : '') + '" data-chat-client-id="' + esc(row.client.id) + '" data-chat-session-id="' + esc(row.session ? row.session.id : '') + '">' +
        '<strong>' + esc(title) + '</strong><small>' + esc(row.client.name || '未命名来访者') + ' · ' + esc(sessionLabel) + '</small></button>';
    }).join('') : '<div class="xj-workspace-empty"><p>' + (filter ? '没有匹配的对话或来访者。' : '本机暂无可用来访者上下文。') + '</p></div>';
    historyList.querySelectorAll('[data-chat-client-id]').forEach(function (button) {
      button.addEventListener('click', function () {
        window.XJClinicalWorkspace.setContext(button.dataset.chatClientId, button.dataset.chatSessionId);
        renderStructureContext();
      });
    });
    if (search && !search.__xj_bound) {
      search.__xj_bound = true;
      search.addEventListener('input', renderStructureContext);
    }
    window.XJClinicalWorkspace.renderContextStrip(contextStrip, { feature: 'ai-analyze', preferRecentSession: true });
    const session = context.session;
    if (!context.clientId || !session) {
      sourceList.innerHTML = '<div class="xj-workspace-empty"><p>选择来访者和会谈后显示已验证材料。</p></div>';
      window.XJClinicalWorkspace.refreshIcons(document.querySelector('.chat-context-panel'));
      return;
    }
    sourceList.innerHTML = '<div class="xj-workspace-loading"><p>正在校验本机材料来源…</p></div>';
    if (!window.CaseSpaceViewModel || typeof window.CaseSpaceViewModel.refresh !== 'function' || typeof Store === 'undefined' || typeof Store.getMaterialWorkspace !== 'function') {
      sourceList.innerHTML = '<div class="xj-workspace-error"><p>来源校验模块未就绪，未显示任何材料。</p></div>';
      return;
    }
    Promise.resolve(window.CaseSpaceViewModel.refresh(context.clientId, {
      currentContext: { clientId: context.clientId }
    })).then(function (result) {
      if (requestId !== structureContextRequestId) return;
      if (!result || !result.ok || !result.model || result.model.clientId !== context.clientId) {
        sourceList.innerHTML = '<div class="xj-workspace-error"><p>来源投影不可用，未显示任何可能过期的材料。</p></div>';
        return;
      }
      const admitted = (result.model.nodes || []).filter(function (node) {
        if (!node || node.kind !== 'material' || node.clientId !== context.clientId || node.sessionId !== session.id || node.sourceStatus !== 'verified' || !hasCompleteSourceRef(node.sourceRef)) return false;
        const locator = String(node.sourceRef.anchor && node.sourceRef.anchor.locator || '');
        const materialId = locator.indexOf('material:') === 0 ? locator.slice('material:'.length) : '';
        const material = materialId ? Store.getMaterialWorkspace(materialId) : null;
        return !!(material && material.clientId === context.clientId && material.sessionId === session.id && material.parseStatus === 'ready');
      }).map(function (node) {
        const materialId = String(node.sourceRef.anchor.locator).slice('material:'.length);
        return { material: Store.getMaterialWorkspace(materialId), sourceRef: node.sourceRef };
      });
      sourceList.innerHTML = admitted.length ? admitted.slice(0, 5).map(function (entry) {
        const source = entry.material.source || {};
        return '<div class="xj-source-ref" data-status="verified"><span class="xj-source-ref-icon"><i data-lucide="file-check-2"></i></span><span><strong>' + esc(entry.material.title || source.name || '已验证材料') + '</strong><small>' + esc(entry.sourceRef.id) + ' · 定位有效</small></span><span class="xj-status-chip" data-tone="success">已确认</span></div>';
      }).join('') : '<div class="xj-workspace-empty"><p>当前会谈没有通过来源校验的材料。小镜不会把未验证内容作为本轮来源。</p></div>';
      window.XJClinicalWorkspace.refreshIcons(sourceList);
    }).catch(function () {
      if (requestId !== structureContextRequestId) return;
      sourceList.innerHTML = '<div class="xj-workspace-error"><p>来源校验失败，未显示任何可能过期的材料。</p></div>';
    });
  }

  function requestConfirm(toolCall, args) {
    return new Promise(function (resolve) {
      if (!msgsEl) { resolve({ ok: false }); return; }
      const msgEl = el('div', 'chat-msg assistant');
      const avatar = el('div', 'avatar', '心');
      const bubble = el('div', 'bubble');
      const toolName = (toolCall && toolCall.function && toolCall.function.name) || '';
      let previewHtml = '';
      try {
        previewHtml = renderConfirmPreview(toolName, args);
      } catch (e) {
        previewHtml = '<div style="font-size:12px;color:#8a8a9e">参数：' + esc(JSON.stringify(args)) + '</div>';
      }
      bubble.innerHTML =
        '<div style="font-weight:600;margin-bottom:8px"><i data-lucide="triangle-alert" aria-hidden="true"></i> 即将执行写入操作</div>' +
        '<div style="font-size:12px;color:#8a8a9e;margin-bottom:8px">工具：' + esc(toolName) + '</div>' +
        previewHtml +
        '<div style="display:flex;gap:8px;margin-top:12px">' +
          '<button class="confirm-ok" style="font-size:12px;padding:6px 14px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer">确认执行</button>' +
          '<button class="confirm-cancel" style="font-size:12px;padding:6px 14px;border-radius:8px;border:1px solid var(--border);background:var(--paper);color:var(--ink-2);cursor:pointer">取消</button>' +
        '</div>';
      msgEl.appendChild(avatar);
      msgEl.appendChild(bubble);
      msgsEl.appendChild(msgEl);
      msgsEl.scrollTop = msgsEl.scrollHeight;
      if (window.IconSystem) window.IconSystem.render(msgEl);
      bubble.querySelector('.confirm-ok').addEventListener('click', function () {
        msgEl.remove();
        resolve({ ok: true });
      });
      bubble.querySelector('.confirm-cancel').addEventListener('click', function () {
        msgEl.remove();
        resolve({ ok: false });
      });
    });
  }

  function renderConfirmPreview(toolName, args) {
    var tn = toolName.replace(/_/g, '.');
    if ((toolName === 'billing_add_record' || tn === 'billing.add_record') && Array.isArray(args.records)) {
      const rows = args.records.map(function (r, i) {
        return '<div style="font-size:13px;margin:4px 0">' +
          (i + 1) + '. 来访者：<b>' + esc(r.clientName || r.clientId || '') + '</b> ' +
          '日期：<b>' + esc(r.date || '') + '</b> ' +
          '费用：<b>¥' + esc(String(r.fee || 0)) + '</b> ' +
          (r.settleType ? esc(r.settleType) + '·' : '') +
          (r.paid ? '已收' : '未收') +
        '</div>';
      }).join('');
      return rows;
    }
    if (toolName === 'billing_monthly_settle' || tn === 'billing.monthly_settle') {
      return '<div style="font-size:13px">来访者：<b>' + esc(args.clientName || args.clientId || '') + '</b> 月份：<b>' + esc(args.month || '') + '</b> 金额：<b>¥' + esc(String(args.amount || 0)) + '</b></div>';
    }
    if (toolName === 'client_update' || tn === 'client.update') {
      const keys = Object.keys(args.patch || {}).join(', ');
      return '<div style="font-size:13px">来访者 ID：<b>' + esc(args.clientId || '') + '</b><br>修改字段：<b>' + esc(keys) + '</b></div>';
    }
    if (toolName === 'supervision_start' || tn === 'supervision.start') {
      const modeName = args.supervisorName === 'cangjie' ? '仓颉版' : '女娲版';
      const materialPreview = String(args.material || '').slice(0, 200) + (String(args.material || '').length > 200 ? '…' : '');
      return '<div style="font-size:13px">' +
        '督导模式：<b>' + esc(modeName) + '</b><br>' +
        '来访者：<b>' + esc(args.clientName || args.clientId || '') + '</b><br>' +
        '材料预览：<span style="font-size:12px;color:#8a8a9e">' + esc(materialPreview) + '</span>' +
      '</div>';
    }
    return '<div style="font-size:12px;color:#8a8a9e">参数：' + esc(JSON.stringify(args)) + '</div>';
  }

  function recordWriteAction(toolName, args, result) {
    lastWriteAction = { toolName: toolName, args: args, result: result, ts: Date.now() };
  }

  async function undoLastWrite() {
    if (undoPending) return;
    if (!lastWriteAction) {
      if (typeof App !== 'undefined' && App.showToast) App.showToast('没有可撤销的操作', 'info');
      return;
    }
    var w = lastWriteAction;
    if ((w.toolName === 'billing.add_record' || w.toolName === 'billing_add_record') && w.result && w.result.sessionIds) {
      undoPending = true;
      try {
        var result = await Store.deleteSessionsDurable(w.result.sessionIds);
        if (!result || !result.ok) throw new Error((result && result.error && result.error.message) || 'data was not persisted');
        if (typeof App !== 'undefined' && App.showToast) App.showToast('已撤销 ' + w.result.sessionIds.length + ' 条记账记录', 'success');
        lastWriteAction = null;
      } catch (e) {
        if (typeof App !== 'undefined' && App.showToast) App.showToast('撤销失败：' + (e.message || ''), 'error');
      } finally {
        undoPending = false;
      }
    } else {
      if (typeof App !== 'undefined' && App.showToast) App.showToast('该操作不支持撤销', 'info');
    }
  }

  let authState = null; // 缓存 IPC 拉取的授权状态

  async function refreshAuthState() {
    try {
      if (window.__XJ_API__ && typeof window.__XJ_API__.getState === 'function') {
        const s = await window.__XJ_API__.getState();
        if (s && typeof s === 'object') authState = s;
      }
    } catch (e) {}
  }

  function isUnlocked() {
    // 优先从 IPC 拉取的 authState 读，其次从 preload 桥接的只读快照读
    if (authState && typeof authState.aiUnlocked === 'boolean') return !!authState.aiUnlocked;
    if (authState && authState.mode === 'full') return true;
    // 回退：preload 桥接的只读引用（可能尚未被 DOMContentLoaded 回调更新）
    if (window.__XJ__ && typeof window.__XJ__.aiUnlocked === 'boolean') return !!window.__XJ__.aiUnlocked;
    if (window.__XJ__ && window.__XJ__.mode === 'full') return true;
    try {
      if (typeof App !== 'undefined' && typeof App.aiUnlocked === 'function') return App.aiUnlocked();
    } catch (e) {}
    return false;
  }

  async function sendMsg() {
    if (busy) return;
    if (!inputEl) return;
    const text = (inputEl.value || '').trim();
    if (!text) return;
    const workflowRoute = workflowRouteForText(text);
    if (workflowRoute) {
      inputEl.value = '';
      inputEl.style.height = '';
      renderMsg('user', text);
      messages.push({ role: 'user', content: text });
      const reply = '这项工作需要完整表单和上下文，我带你去「' + workflowRoute.label + '」。';
      renderMsg('assistant', reply);
      messages.push({ role: 'assistant', content: reply });
      renderNavCard({
        kind: 'navigate_hint',
        target: workflowRoute.key,
        label: workflowRoute.label,
        href: workflowRoute.href,
        reason: '在专业页面中操作更完整，也能核对保存结果。'
      });
      saveMemory();
      return;
    }
    busy = true;
    if (sendBtn) sendBtn.disabled = true;
    try {
      // 只有真正需要模型回答时才检查授权；工作流导航始终可用。
      await refreshAuthState();
      if (!isUnlocked()) {
        renderSystem('小镜对话需激活；记录、账务、督导等功能可直接从上方入口打开。');
        return;
      }
      inputEl.value = '';
      inputEl.style.height = '';
      renderMsg('user', text);
      messages.push({ role: 'user', content: text });
      const typingEl = renderTyping();
      if (messages.length === 0 || messages[0].role !== 'system') {
        messages.unshift({ role: 'system', content: '' });
      }
      try {
        if (typeof AgentCore !== 'undefined' && AgentCore.buildSystemPrompt) {
          messages[0].content = AgentCore.buildSystemPrompt();
        }
      } catch (e) {}

      if (typeof AgentCore !== 'undefined' && typeof AgentCore.runRound === 'function' && typeof AgentTools !== 'undefined') {
        const responseStartIndex = messages.length;
        const result = await AgentCore.runRound(messages, requestConfirm, function (name, status, data) {
          clearTyping();
          if (status === 'executing') renderProgress('正在执行：' + name + '…');
          else if (status === 'done') {
            if (data && data.switchedTo === 'user') {
              renderSystem('已切换到高性能模型，理解与表达质量已提升');
              return;
            }
            if (data && data.switchedTo === 'builtin' && data.testError) {
              renderSystem('接入测试未通过：' + data.testError + '，已降级到内置模型', 'triangle-alert', 'warning');
              return;
            }
            if (data && data.switchedTo === 'partial') {
              renderProgress(data.message || '已记录部分配置');
              return;
            }
            if (data && data.card && data.card.kind === 'navigate_hint') {
              renderNavCard(data.card);
              return;
            }
            if (data) {
              const summary = data.added !== undefined ? ('已新增 ' + data.added + ' 条记录' + (data.skipped ? '，跳过 ' + data.skipped + ' 条' : ''))
                : (data.receivable !== undefined ? ('应收 ¥' + data.receivable + ' / 已收 ¥' + data.received + ' / 余额 ¥' + data.balance)
                : '已完成');
              renderProgress(summary);
              if (data.added !== undefined && data.sessionIds && data.sessionIds.length) {
                recordWriteAction(name, {}, data);
              }
            }
          }
        }, function (evt) {
          if (evt && evt.type === 'followups' && Array.isArray(evt.items) && evt.items.length) {
            renderFollowupCard(evt.items);
          }
        }, function (piece, fullText) {
          if (typingEl) { var bubble = typingEl.querySelector('.bubble'); if (bubble) bubble.textContent = fullText || piece || ''; }
          if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
        });
        clearTyping();
        if (!result.error) markNewModelMessages(responseStartIndex);
        if (result.error) {
          renderMsg('assistant', '错误：' + result.error);
          // 错误分支：AgentCore 未写入消息，此处需记录到 history
          messages.push({ role: 'assistant', content: '错误：' + result.error });
        } else if (result.reply) {
          // 成功分支：AgentCore.runRound 已把模型消息写入 messages（同一数组引用），仅渲染不再 push
          let commercial = null;
          for (let i = messages.length - 1; i >= responseStartIndex; i -= 1) {
            if (messages[i] && messages[i].commercial) {
              commercial = messages[i].commercial;
              break;
            }
          }
          const assistantRef = findLastAssistantRef(result.reply);
          renderMsg('assistant', result.reply, commercial, {
            draft: true,
            runId: 'run-' + Date.now().toString(36) + '-' + (++draftSeq),
            snapshot: resolveDraftSnapshot(),
            messageRef: assistantRef,
          });
        }
      } else {
        clearTyping();
        renderSystem('Agent 模块未就绪，请重启应用。', 'triangle-alert', 'warning');
      }
    } catch (e) {
      clearTyping();
      renderMsg('assistant', '执行异常：' + (e.message || '未知错误'));
      messages.push({ role: 'assistant', content: '执行异常：' + (e.message || '未知错误') });
    } finally {
      busy = false;
      if (sendBtn) sendBtn.disabled = false;
      saveMemory();
    }
  }

  window.sendQuick = function (text) {
    if (inputEl) inputEl.value = text;
    sendMsg();
  };

  function toggleVoice() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      renderSystem('当前浏览器不支持语音输入', 'triangle-alert', 'warning');
      return;
    }
    function setVoiceButtonIcon(iconName, label) {
      if (!voiceBtn) return;
      voiceBtn.innerHTML = '<i data-lucide="' + iconName + '" aria-hidden="true"></i>';
      voiceBtn.setAttribute('aria-label', label);
      voiceBtn.title = label;
      if (window.IconSystem) window.IconSystem.render(voiceBtn);
    }
    if (!recognition) {
      recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
      recognition.lang = 'zh-CN';
      recognition.interimResults = true;
      recognition.onresult = function (e) {
        let interim = '';
        let final = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) final += e.results[i][0].transcript;
          else interim += e.results[i][0].transcript;
        }
        if (inputEl) inputEl.value = final + interim;
      };
      recognition.onend = function () {
        isRecording = false;
        if (voiceBtn) voiceBtn.classList.remove('recording');
        setVoiceButtonIcon('mic', '语音输入');
      };
      recognition.onerror = function (e) {
        isRecording = false;
        if (voiceBtn) voiceBtn.classList.remove('recording');
        setVoiceButtonIcon('mic', '语音输入');
        renderSystem('语音输入出错：' + (e.error || '未知错误'), 'triangle-alert', 'warning');
      };
    }
    if (isRecording) {
      recognition.stop();
    } else {
      recognition.start();
      isRecording = true;
      if (voiceBtn) {
        voiceBtn.classList.add('recording');
        setVoiceButtonIcon('square', '停止语音输入');
      }
    }
  }
  window.toggleVoice = toggleVoice;

  window.switchToExpert = function () {
    location.href = 'index.html';
  };

  window.openActivation = function () {
    try {
      if (window.__XJ_API__ && typeof window.__XJ_API__.openActivation === 'function') {
        window.__XJ_API__.openActivation();
      }
    } catch (e) {}
  };

  window.undoLastWrite = undoLastWrite;

  function init() {
    if (initialized) return;
    initialized = true;
    hydrationFailed = !!(window.Store && typeof Store.isHydrated === 'function' && !Store.isHydrated());
    msgsEl = document.getElementById('chat-msgs');
    inputEl = document.getElementById('chat-input');
    sendBtn = document.getElementById('chat-send');
    voiceBtn = document.getElementById('voice-btn');
    renderStructureContext();
    window.addEventListener('xj:clinical-context-changed', renderStructureContext);

    if (inputEl) {
      inputEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMsg();
        }
      });
      inputEl.addEventListener('input', function () {
        this.style.height = '';
        this.style.height = Math.min(160, this.scrollHeight) + 'px';
      });
    }
    if (sendBtn) {
      sendBtn.addEventListener('click', sendMsg);
    }

    // 先拉一次授权状态（修复对话模式鉴权问题），再渲染 banner
    refreshAuthState().then(function () {
      if (msgsEl) {
        msgsEl.innerHTML = '';
        renderTierBanner();
        renderWelcome();
        restoreMemory();
      }
    });

    try {
      if (window.__XJ_API__ && typeof window.__XJ_API__.onLicenseState === 'function') {
        window.__XJ_API__.onLicenseState(function () {
          if (msgsEl) {
            msgsEl.innerHTML = '';
            renderTierBanner();
            renderWelcome();
            restoreMemory();
          }
        });
      }
    } catch (e) {}
  }

  function startPage() {
    if (window.App && typeof App.initPage === 'function') {
      App.initPage({ noXiaojing: true, onReady: init }).catch(function () {
        hydrationFailed = true;
        init();
      });
      return;
    }
    hydrationFailed = true;
    init();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startPage);
  } else {
    startPage();
  }
})();

/* ====================================================================
   XJ-5.1.0-005 — Pi Workbench UI 模块（并入 chat-home.js；写集允许文件）
   消费 004 生产桥（window.__PI__ 白名单 + __XJ_API__.piTransport 回传）；
   本模块绝不直接调用 Store 写入口：写入只经 commitStep→approval→主进程→transport 请求→reply。
   会员门禁经 App.canUse；材料上传经 __XJ_API__.selectClinicalMaterialFile（不暴露绝对路径）。
   ==================================================================== */
var PiWorkbench = (function () {
  'use strict';
  var VERSION = 1;
  var STATUS_LABELS = {
    queued: '排队中', planning: '规划中', awaiting_confirmation: '等待确认', executing: '执行中',
    paused: '已暂停', succeeded: '已完成', failed: '失败', cancelled: '已取消',
  };

  function el(id) { return document.getElementById(id); }
  function failClosedNote(code) {
    return '操作已阻止（' + (code || 'fail-closed') + '），请刷新或重新登录后再试。';
  }
  function isOk(r) { return r && typeof r === 'object' && r.ok === true; }
  function errCode(r) { return (r && r.code) || ''; }

  function createPiWorkbench(options) {
    var opts = options || {};
    var state = {
      taskId: null, taskStatus: null,
      trajectory: [],
      pendingApprovalId: null,
      materials: [],
      durableWrites: 0, lastSavedObjectId: null,
      projection: null,
    };

    function bridgeAvailable() {
      return !!(window.__PI__ && typeof window.__PI__.startTask === 'function'
        && window.__XJ_API__ && window.__XJ_API__.piTransport);
    }
    function transport() { return window.__XJ_API__.piTransport; }

    var transportWired = false;
    function wireTransport() {
      if (transportWired || !bridgeAvailable()) return;
      transportWired = true;
      transport().onRequest(function (request) {
        if (!request || typeof request !== 'object') return;
        if (request.kind === 'durable-write') {
          // 唯一写通道：主进程在 approval 之后请求；页面按预览草稿回执，绝不在此之外写
          state.durableWrites += 1;
          var payload = request.payload || {};
          var savedObjectId = 'wb_' + String(state.taskId || 'task') + '_' + String(state.durableWrites);
          transport().reply(request.requestId, {
            ok: true, savedObjectId: savedObjectId, version: 1,
            object: { snapshotHash: String(payload.snapshotHash || ''), version: 1, fields: payload.fields || {} },
          });
          return;
        }
        transport().reply(request.requestId, { ok: false, code: 'XJ_PI_UNKNOWN_EVENT', message: 'unsupported kind' });
      });
    }

    function buildProjection(ctx) {
      var c = ctx || {};
      if (!c.clientId || !c.sessionId) return null;
      return {
        clientId: String(c.clientId), sessionId: String(c.sessionId),
        sourceRefs: (state.materials || []).map(function (m, i) {
          return {
            sourceId: m.sourceId || 'mat_' + (i + 1),
            sourceVersion: m.sourceVersion || 1,
            sourceContentHash: m.sourceContentHash || ('sha256:' + new Array(65).join('0')),
            anchorContentHash: m.anchorContentHash || ('sha256:' + new Array(65).join('1')),
          };
        }),
        storeProjectionVersion: Number.isSafeInteger(c.storeProjectionVersion) ? c.storeProjectionVersion : 1,
        membershipProjectionVersion: Number.isSafeInteger(c.membershipProjectionVersion) ? c.membershipProjectionVersion : 1,
      };
    }
    function publishReads() {
      if (!bridgeAvailable()) return;
      var p = state.projection;
      if (!p) return;
      var readClientKey = JSON.stringify({ clientId: p.clientId });
      var readSessionKey = JSON.stringify({ sessionId: p.sessionId });
      var readsObj = {};
      readsObj['read.client.summary'] = {};
      readsObj['read.client.summary'][readClientKey] = { clientId: p.clientId };
      readsObj['read.session.notes'] = {};
      readsObj['read.session.notes'][readSessionKey] = { sessionId: p.sessionId };
      readsObj['read.task.cards'] = {};
      readsObj['read.task.cards'][JSON.stringify({})] = { cards: [] };
      transport().publishState({ projection: p, reads: readsObj });
    }

    function membershipAllows(kind) {
      try {
        if (window.App && typeof App.canUse === 'function') return App.canUse(kind) === true;
      } catch (e) { return false; }
      return false;
    }

    function setStatus(status) {
      state.taskStatus = status || null;
      if (el('wb-status-chip')) el('wb-status-chip').textContent = status ? (STATUS_LABELS[status] || status) : '空闲';
      renderButtons();
    }
    function pushTrajectory(entry) {
      state.trajectory.push(entry);
      if (state.trajectory.length > 200) state.trajectory.shift();
      var list = el('wb-trajectory');
      if (!list) return;
      var row = document.createElement('div');
      row.className = 'wb-traj-item' + (entry.ok === false ? ' wb-traj-err' : '');
      row.textContent = entry.text;
      list.appendChild(row);
      list.scrollTop = list.scrollHeight;
    }
    function renderButtons() {
      var active = !!state.taskId && ['queued', 'planning', 'awaiting_confirmation', 'executing', 'paused'].indexOf(state.taskStatus) >= 0;
      var paused = state.taskStatus === 'paused';
      if (el('wb-pause')) el('wb-pause').disabled = !active || paused;
      if (el('wb-resume')) el('wb-resume').disabled = !paused;
      if (el('wb-cancel')) el('wb-cancel').disabled = !active;
      if (el('wb-approve')) el('wb-approve').disabled = !state.pendingApprovalId;
      if (el('wb-reject')) el('wb-reject').disabled = !state.pendingApprovalId;
      if (el('wb-commit')) el('wb-commit').disabled = !(active && state.projection);
    }
    function showApprovalCard(pending) {
      state.pendingApprovalId = pending || null;
      var card = el('wb-approval-card');
      if (!card) return;
      card.style.display = state.pendingApprovalId ? 'block' : 'none';
      if (state.pendingApprovalId && el('wb-approval-preview')) {
        el('wb-approval-preview').textContent = '待确认写入：临床记录草稿（来访者 ' + (state.projection ? state.projection.clientId : '—') + ' / 会谈 ' + (state.projection ? state.projection.sessionId : '—') + '）。批准后经主进程 durable 通道保存并回读验证。';
      }
      renderButtons();
    }
    function showState(stateKind, message) {
      var box = el('wb-state-note');
      if (!box) return;
      box.setAttribute('data-state', stateKind);
      box.textContent = message || '';
    }

    function startObserve(ctx) {
      if (!bridgeAvailable()) { showState('error', failClosedNote('bridge-unavailable')); return Promise.resolve({ ok: false, code: 'bridge-unavailable' }); }
      // 按钮/测试两条入口共用：无显式 ctx 时复用已设定的投影（_setContextForTests 或上次任务）
      var useCtx = (ctx && ctx.clientId) ? ctx : (state.projection ? {
        clientId: state.projection.clientId, sessionId: state.projection.sessionId,
        storeProjectionVersion: state.projection.storeProjectionVersion,
        membershipProjectionVersion: state.projection.membershipProjectionVersion,
      } : null);
      state.projection = buildProjection(useCtx);
      if (!state.projection) { showState('error', failClosedNote('context-missing')); return Promise.resolve({ ok: false, code: 'context-missing' }); }
      publishReads();
      state.taskId = 'xj_task_wb_' + Date.now().toString(36);
      var self = state.taskId;
      return window.__PI__.startTask({ taskId: self, mode: 'observe', projection: state.projection }).then(function (r) {
        if (!isOk(r)) { showState('error', failClosedNote(errCode(r))); pushTrajectory({ kind: 'event', text: '创建任务失败：' + errCode(r), ok: false }); return r; }
        setStatus('queued');
        pushTrajectory({ kind: 'event', text: '任务已创建（observe）', ok: true });
        return window.__PI__.contextCheck(self).then(function (c) {
          if (!isOk(c)) { setStatus('failed'); pushTrajectory({ kind: 'event', text: '上下文校验失败：' + errCode(c), ok: false }); return c; }
          return window.__PI__.plan(self, [{ tool: 'read.client.summary', args: { clientId: state.projection.clientId } }]).then(function (pl) {
            if (isOk(pl)) { setStatus('planning'); pushTrajectory({ kind: 'plan', text: '计划：读取来访者摘要', ok: true }); }
            return pl;
          });
        });
      });
    }
    function runTool(tool, args) {
      if (!state.taskId) return Promise.resolve({ ok: false, code: 'no-task' });
      publishReads();
      // 主进程 reads 投影经 IPC 异步到达：先让出一个宏任务节拍再调用，避免首次读取竞态
      return new Promise(function (resolve) { setTimeout(resolve, 120); }).then(function () {
        return window.__PI__.runToolStep(state.taskId, { tool: tool, args: args || {} });
      }).then(function (r) {
        if (isOk(r)) { setStatus('executing'); pushTrajectory({ kind: 'tool', text: '工具 ' + tool + ' 完成', ok: true }); }
        else pushTrajectory({ kind: 'tool', text: '工具 ' + tool + ' 失败：' + errCode(r), ok: false });
        return r;
      });
    }
    function commitDraft(fields) {
      if (!state.taskId || !state.projection) return Promise.resolve({ ok: false, code: 'no-task' });
      if (!membershipAllows('ai-supervise') && !membershipAllows('manual-core')) {
        // 会员未知/不满足：保留预览，不执行（fail-closed）
        showState('error', '会员状态未知或不满足，写入未执行；可在方案页查看所需等级。');
        return Promise.resolve({ ok: false, code: 'membership-unknown' });
      }
      var tgt = { kind: 'session', clientId: state.projection.clientId, sessionId: state.projection.sessionId };
      return window.__PI__.commitStep(state.taskId, tgt, fields || {}).then(function (r) {
        if (r && r.awaiting) { setStatus('awaiting_confirmation'); showApprovalCard(r.pendingApprovalId); pushTrajectory({ kind: 'event', text: '等待用户确认（approval）', ok: true }); return r; }
        if (isOk(r)) {
          setStatus('succeeded'); showApprovalCard(null);
          state.lastSavedObjectId = r.savedObjectId || null;
          pushTrajectory({ kind: 'event', text: '已保存并回读验证：' + (r.savedObjectId || '（无回执）'), ok: true });
          showState('success', '草稿已确认保存：' + (r.savedObjectId || '回执缺失'));
          return r;
        }
        setStatus(errCode(r) === 'XJ_PI_APPROVAL_REQUIRED' ? 'awaiting_confirmation' : 'failed');
        pushTrajectory({ kind: 'event', text: '提交失败：' + errCode(r), ok: false });
        showState('error', failClosedNote(errCode(r)));
        return r;
      });
    }
    function resolveApproval(decision) {
      if (!state.pendingApprovalId) return Promise.resolve({ ok: false, code: 'no-pending' });
      var id = state.pendingApprovalId;
      return window.__PI__.resolveApproval(id, decision ? 'approved' : 'rejected', 'local-user').then(function (r) {
        if (!isOk(r)) {
          showApprovalCard(null);
          setStatus('paused');
          pushTrajectory({ kind: 'event', text: '确认卡失效（' + errCode(r) + '）', ok: false });
          showState('error', failClosedNote(errCode(r)));
          return r;
        }
        showApprovalCard(null);
        pushTrajectory({ kind: 'event', text: decision ? '已批准，执行保存' : '已拒绝', ok: true });
        return r;
      });
    }
    function pause() { return lifecycle('pause', '已暂停', 'wb-pause', 'paused'); }
    function resume() { return lifecycle('resume', '已继续', 'wb-resume', 'executing'); }
    function cancel() { return lifecycle('cancel', '已取消（不可恢复）', 'wb-cancel', 'cancelled'); }
    function lifecycle(method, label, btnId, nextStatus) {
      if (!state.taskId) return Promise.resolve({ ok: false, code: 'no-task' });
      var b = el(btnId);
      if (b) { b.disabled = true; b.setAttribute('data-busy', '1'); }
      return window.__PI__[method](state.taskId, 'user').then(function (r) {
        if (b) b.removeAttribute('data-busy');
        if (isOk(r)) {
          setStatus(nextStatus);
          if (method === 'cancel') showApprovalCard(null);
          pushTrajectory({ kind: 'event', text: label, ok: true });
        } else {
          pushTrajectory({ kind: 'event', text: label + '失败：' + errCode(r), ok: false });
          showState('error', failClosedNote(errCode(r)));
        }
        renderButtons();
        return r;
      });
    }

    function uploadMaterial() {
      // 生产通道：window.__XJ_API__ 的受控材料入口；__xjMaterialTestChannel 仅为隔离测试
      // 注入同形通道（contextBridge 对象只读，页面内无法覆写），生产永不设置该变量。
      var api = window.__xjMaterialTestChannel || window.__XJ_API__;
      if (!api || typeof api.selectClinicalMaterialFile !== 'function') {
        showState('error', failClosedNote('material-channel-unavailable'));
        return Promise.resolve({ ok: false, code: 'material-channel-unavailable' });
      }
      return api.selectClinicalMaterialFile().then(function (sel) {
        if (!sel || !isOk(sel) || !sel.selectionId) { showState('error', '未选择材料或选择失败。'); return { ok: false, code: 'no-selection' }; }
        return api.parseClinicalMaterialFile(sel.selectionId).then(function (parsed) {
          if (!isOk(parsed)) { showState('error', '材料解析失败：' + errCode(parsed)); return parsed; }
          var m = {
            sourceId: 'mat_' + String((state.materials.length || 0) + 1),
            name: String(parsed.displayName || parsed.name || '材料').slice(0, 40),
            sourceVersion: 1,
          };
          state.materials.push(m);
          renderMaterials();
          pushTrajectory({ kind: 'event', text: '材料已绑定（' + m.name + ' → client/session/sourceRefs）', ok: true });
          return { ok: true, material: m };
        });
      });
    }
    function renderMaterials() {
      var box = el('wb-materials');
      if (!box) return;
      box.textContent = '';
      if (!state.materials.length) {
        var empty = document.createElement('div');
        empty.className = 'wb-empty';
        empty.textContent = '尚未绑定材料';
        box.appendChild(empty);
        return;
      }
      state.materials.forEach(function (m) {
        var row = document.createElement('div');
        row.className = 'wb-material';
        row.textContent = m.name + '（' + m.sourceId + '）';
        box.appendChild(row);
      });
    }

    function supervisionDraft(text) {
      if (!membershipAllows('ai-supervise')) {
        showState('error', '会员状态未知或不满足，督导能力未执行；可查看方案了解所需等级。');
        pushTrajectory({ kind: 'event', text: '督导能力被门禁拦截（membership）', ok: false });
        return Promise.resolve({ ok: false, code: 'membership-unknown' });
      }
      return runTool('supervision.note.append', { noteText: String(text || '').slice(0, 2000) });
    }

    function mount(container) {
      var root = typeof container === 'string' ? el(container) : container;
      if (!root || root.getAttribute('data-pi-workbench') === '1') return;
      root.setAttribute('data-pi-workbench', '1');
      root.innerHTML = [
        '<div class="wb-head"><span class="wb-title">Pi 工作台</span><span class="xj-status-chip" id="wb-status-chip">空闲</span>',
        '<span class="wb-projection" id="wb-projection-label"></span></div>',
        '<div class="wb-state-note" id="wb-state-note" data-state="empty" role="status" aria-live="polite">暂无任务。选择来访者与会话后创建观察任务。</div>',
        '<div class="wb-toolbar">',
        '<button type="button" class="btn" id="wb-start">创建观察任务</button>',
        '<button type="button" class="btn" id="wb-commit" disabled>保存草稿（需确认）</button>',
        '<button type="button" class="btn" id="wb-pause" disabled>暂停</button>',
        '<button type="button" class="btn" id="wb-resume" disabled>继续</button>',
        '<button type="button" class="btn" id="wb-cancel" disabled>取消</button>',
        '<button type="button" class="btn" id="wb-upload">上传材料</button>',
        '</div>',
        '<div class="wb-approval-card" id="wb-approval-card" style="display:none" role="alertdialog" aria-label="高风险写入确认">',
        '<div class="wb-approval-title">确认卡 · 高风险临床写入</div>',
        '<div class="wb-approval-preview" id="wb-approval-preview"></div>',
        '<div class="wb-approval-actions">',
        '<button type="button" class="btn pri" id="wb-approve" disabled>批准</button>',
        '<button type="button" class="btn" id="wb-reject" disabled>拒绝</button>',
        '</div></div>',
        '<div class="wb-cols">',
        '<section class="wb-panel"><h3>任务轨迹</h3><div class="wb-trajectory" id="wb-trajectory" role="log" aria-live="polite"></div></section>',
        '<section class="wb-panel"><h3>绑定材料</h3><div id="wb-materials" class="wb-materials"></div></section>',
        '</div>',
      ].join('');
      el('wb-start').addEventListener('click', function () { showState('loading', '正在创建任务…'); startObserve(opts.context || {}).then(function () { }); });
      el('wb-commit').addEventListener('click', function () { commitDraft({ note: 'workbench 草稿' }); });
      el('wb-approve').addEventListener('click', function () { resolveApproval(true); });
      el('wb-reject').addEventListener('click', function () { resolveApproval(false); });
      el('wb-pause').addEventListener('click', pause);
      el('wb-resume').addEventListener('click', resume);
      el('wb-cancel').addEventListener('click', cancel);
      el('wb-upload').addEventListener('click', uploadMaterial);
      wireTransport();
      renderMaterials();
      renderButtons();
      if (!bridgeAvailable()) showState('error', failClosedNote('bridge-unavailable'));
    }

    return Object.freeze({
      version: VERSION, mount: mount,
      startObserve: startObserve, runTool: runTool, commitDraft: commitDraft, resolveApproval: resolveApproval,
      pause: pause, resume: resume, cancel: cancel, uploadMaterial: uploadMaterial, supervisionDraft: supervisionDraft,
      membershipAllows: membershipAllows, bridgeAvailable: bridgeAvailable,
      getState: function () {
        return {
          taskId: state.taskId, taskStatus: state.taskStatus,
          pendingApprovalId: state.pendingApprovalId,
          durableWrites: state.durableWrites, lastSavedObjectId: state.lastSavedObjectId,
          materialIds: state.materials.map(function (m) { return m.sourceId; }),
          trajectoryCount: state.trajectory.length,
          projection: state.projection ? { clientId: state.projection.clientId, sessionId: state.projection.sessionId } : null,
        };
      },
      _setContextForTests: function (ctx) { state.projection = buildProjection(ctx); publishReads(); }, // 仅供隔离测试驱动
    });
  }

  return Object.freeze({ create: createPiWorkbench });
})();

// 生产路径自动挂载：chat-home 的 #pi-workbench-root 容器（005 注入）
(function () {
  'use strict';
  function boot() {
    var host = document.getElementById('pi-workbench-root');
    if (!host || host.getAttribute('data-pi-workbench') === '1') return;
    window.__piWorkbenchInstance = PiWorkbench.create({});
    window.__piWorkbenchInstance.mount(host);
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
  }
})();
