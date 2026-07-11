/* ============================================================
   心镜 XinJing — 督导记录逻辑
   - 手工记录（个体 / 团体督导）
   - AI 督导（复刻 winnicott-chat ai-supervisor：女娲/仓颉版本切换、
     先输出「整体印象」、再进入多轮督导对话；复用用户自有 API key 与四层降级）
   ============================================================ */

App.initPage({
  title: '督导',
  subtitle: '个体与团体督导记录',
  actions: `<button class="btn btn-primary" onclick="openSupModal()">新增督导记录<span class="trail"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></span></button>`,
  onReady: function () {
    'use strict';

    App.bindModalClose('sup-modal');
    let currentType = 'all';

  // ===================== 手工记录 =====================
  window.setSupType = function (type) {
    currentType = type;
    document.querySelectorAll('#sup-type-filter .pill').forEach((p) => {
      p.classList.toggle('active', p.dataset.type === type);
    });
    renderList();
  };

  function renderSessionOptions(selectedIds) {
    const sessions = Store.getSessions();
    if (!sessions.length) {
      document.getElementById('sv-sessions').innerHTML = '<div style="font-size:13px;color:var(--muted);font-family:var(--sans)">暂无会话记录</div>';
      return;
    }
    document.getElementById('sv-sessions').innerHTML = sessions
      .map((s) => {
        const client = Store.getClient(s.clientId);
        const name = client ? client.name : '?';
        const checked = selectedIds.includes(s.id) ? 'checked' : '';
        return `<label style="display:flex;align-items:center;gap:8px;padding:4px 0;font-family:var(--sans);font-size:13px;cursor:pointer">
          <input type="checkbox" value="${s.id}" ${checked}> ${App.escapeHtml(name)} · 第${s.sessionNumber}节 (${App.formatDate(s.date, true)})
        </label>`;
      })
      .join('');
  }

  window.openSupModal = function (id) {
    const isEdit = !!id;
    document.getElementById('sup-modal-title').textContent = isEdit ? '编辑督导记录' : '新增督导记录';
    document.getElementById('sv-id').value = id || '';
    document.getElementById('sv-type').value = 'individual';
    document.getElementById('sv-supervisor').value = '';
    document.getElementById('sv-date').value = App.todayStr();
    document.getElementById('sv-content').value = '';
    document.getElementById('sv-conclusion').value = '';
    renderSessionOptions([]);
    if (isEdit) {
      const sv = Store.getSupervision(id);
      if (sv) {
        document.getElementById('sv-type').value = sv.type;
        document.getElementById('sv-supervisor').value = sv.supervisorName || '';
        document.getElementById('sv-date').value = sv.date || App.todayStr();
        document.getElementById('sv-content').value = sv.content || '';
        document.getElementById('sv-conclusion').value = sv.conclusion || '';
        renderSessionOptions(sv.sessionIds || []);
      }
    }
    App.openModal('sup-modal');
  };

  window.saveSupervision = function () {
    const id = document.getElementById('sv-id').value;
    const sessionIds = [...document.querySelectorAll('#sv-sessions input:checked')].map((c) => c.value);
    const data = {
      type: document.getElementById('sv-type').value,
      supervisorName: document.getElementById('sv-supervisor').value.trim(),
      date: document.getElementById('sv-date').value,
      sessionIds,
      content: document.getElementById('sv-content').value.trim(),
      conclusion: document.getElementById('sv-conclusion').value.trim(),
    };
    try {
      if (id) {
        Store.updateSupervision(id, data);
        App.showToast('已保存', 'success');
      } else {
        Store.createSupervision(data);
        App.showToast('已新增督导记录', 'success');
      }
    } catch (e) {
      App.showToast(e.message, 'error');
      return;
    }
    App.closeModal('sup-modal');
    renderList();
  };

  function renderList() {
    const container = document.getElementById('sup-list');
    let sups = Store.getSupervisions();
    if (currentType !== 'all') sups = sups.filter((s) => s.type === currentType);
    sups.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

    if (!sups.length) {
      container.innerHTML = `<div class="empty-state"><div class="icon">${App.svgIcon('cap')}</div><div class="text">暂无督导记录</div></div>`;
      return;
    }

    container.innerHTML = sups
      .map((sv) => {
        const typeLabel = sv.type === 'group' ? '团体督导' : (sv.type === 'ai' ? 'AI 督导' : '个体督导');
        const names = (sv.sessionIds || [])
          .map((sid) => {
            const s = Store.getSession(sid);
            if (!s) return '';
            const c = Store.getClient(s.clientId);
            return c ? `${c.name}·第${s.sessionNumber}节` : '';
          })
          .filter(Boolean)
          .join('、');
        const preview = (sv.content || '').slice(0, 60);
        return `<div class="list-card">
          <div class="row1">
            <span class="title">${App.escapeHtml(sv.supervisorName || '未填督导师')} · ${typeLabel}</span>
            <span class="meta">${App.formatDate(sv.date, true)}
              <span style="margin-left:8px;cursor:pointer;color:var(--accent)" onclick="openSupModal('${sv.id}')">编辑</span>
              <span style="margin-left:8px;cursor:pointer;color:var(--red)" onclick="deleteSup('${sv.id}')">删除</span>
            </span>
          </div>
          ${names ? `<div class="meta" style="margin-bottom:4px">关联：${App.escapeHtml(names)}</div>` : ''}
          <div class="desc">${App.escapeHtml(preview) || '（无内容）'}</div>
        </div>`;
      })
      .join('');
  }

  window.deleteSup = function (id) {
    App.confirmDialog('确定删除该督导记录？', () => {
      try {
        Store.deleteSupervision(id);
      } catch (e) {
        App.showToast(e.message, 'error');
        return;
      }
      App.showToast('已删除', 'success');
      renderList();
    }, true);
  };

    renderList();

  // ===================== AI 督导 =====================
  let spvMode = (localStorage.getItem('xj_spv_mode') || 'nvwa');
  let spvSystem = '';
  let chatMessages = [];     // [system, impression(assistant), ...user/assistant]
  let loadedSession = null;  // { id, clientId }
  let isGenerating = false;
  let isSending = false;

  window.switchSupTab = function (tab) {
    const manual = tab === 'manual';
    document.getElementById('tab-manual').classList.toggle('active', manual);
    document.getElementById('tab-ai').classList.toggle('active', !manual);
    document.getElementById('panel-manual').classList.toggle('hidden', !manual);
    document.getElementById('panel-ai').classList.toggle('hidden', manual);
    if (!manual) applyAiLock();
  };

  function refreshSpvSystem() {
    spvSystem = (window.Supervisors && Supervisors.buildSystemPrompt(spvMode)) || '';
  }

  window.switchSpvMode = function (mode) {
    spvMode = mode;
    localStorage.setItem('xj_spv_mode', mode);
    document.getElementById('spvNvwa').classList.toggle('active', mode === 'nvwa');
    document.getElementById('spvCangjie').classList.toggle('active', mode === 'cangjie');
    document.getElementById('spvHint').textContent = mode === 'nvwa'
      ? '女娲版教你「怎么做督导」，仓颉版告诉你「我是怎么督导的」'
      : '仓颉版以「认知植入」的方式，用数十年督导经历里的信念与伤疤来看临床问题';
    refreshSpvSystem();
    // 若已有对话，刷新 system 消息，使后续回复跟随新版本
    if (chatMessages.length && chatMessages[0].role === 'system') {
      chatMessages[0].content = spvSystem;
    }
  };

  window.aiHandleFile = function (input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      const ta = document.getElementById('aiMaterial');
      const add = (reader.result || '').trim();
      ta.value = (ta.value.trim() ? ta.value.trim() + '\n\n' : '') + add;
      updateLenTip();
    };
    reader.readAsText(file);
    input.value = '';
  };

  function populateSessionSelect() {
    const sel = document.getElementById('aiSessionSel');
    if (!sel) return;
    const sessions = Store.getSessions();
    const opts = ['<option value="">载入会谈…</option>'].concat(sessions.map((s) => {
      const c = Store.getClient(s.clientId);
      const name = c ? c.name : '?';
      return `<option value="${s.id}">${App.escapeHtml(name)} · 第${s.sessionNumber}节 (${App.formatDate(s.date, true)})</option>`;
    }));
    sel.innerHTML = opts.join('');
  }

  window.aiLoadSession = function (id) {
    const sel = document.getElementById('aiSessionSel');
    if (!id) { loadedSession = null; return; }
    const s = Store.getSession(id);
    if (!s) { loadedSession = null; return; }
    loadedSession = { id: s.id, clientId: s.clientId || '' };
    const parts = [];
    if (s.transcript && s.transcript.trim()) parts.push('【逐字稿】\n' + s.transcript.trim());
    if (s.soap && (s.soap.subjective || s.soap.objective || s.soap.assessment || s.soap.plan)) {
      parts.push('【SOAP】\n' + [s.soap.subjective, s.soap.objective, s.soap.assessment, s.soap.plan].filter(Boolean).join('\n'));
    }
    if (s.reflection && s.reflection.trim()) parts.push('【咨询师反思】\n' + s.reflection.trim());
    const c = Store.getClient(s.clientId);
    const header = `【来访者】${c ? c.name : '?'} · 第${s.sessionNumber}节 · ${App.formatDate(s.date, true)}\n`;
    document.getElementById('aiMaterial').value = header + parts.join('\n\n');
    updateLenTip();
    App.showToast('已载入会谈材料', 'success');
  };

  function updateLenTip() {
    const tip = document.getElementById('aiLenTip');
    if (!tip) return;
    const len = (document.getElementById('aiMaterial').value || '').length;
    if (len > 8000) {
      tip.style.color = 'var(--red)';
      tip.textContent = `已输入 ${len} 字，偏长，可能影响分析质量`;
    } else if (len > 4000) {
      tip.style.color = 'var(--muted)';
      tip.textContent = `已输入 ${len} 字，建议控制在 4000 字内以确保分析质量`;
    } else {
      tip.style.color = 'var(--muted)';
      tip.textContent = len ? `已输入 ${len} 字` : '';
    }
  }

  window.generateImpression = async function () {
    if (!App.aiUnlocked()) { applyAiLock(); App.showToast('AI 督导为付费功能，请先激活', 'error'); return; }
    const ack = document.getElementById('aiAck');
    if (!ack.checked) { App.showToast('请先勾选「我已阅读并理解上述说明」', 'error'); ack.focus(); return; }
    const text = document.getElementById('aiMaterial').value.trim();
    if (!text) { App.showToast('请粘贴或上传临床材料', 'error'); return; }

    isGenerating = true;
    const btn = document.getElementById('aiGenBtn');
    btn.disabled = true; btn.textContent = '分析中……';
    const box = document.getElementById('aiImpression');
    const body = document.getElementById('aiImpressionBody');
    box.classList.remove('hidden');
    body.innerHTML = '<div class="chat-msg ai typing">阅读材料中……</div>';

    const result = await SupervisionCore.runImpression(spvMode, text);
    isGenerating = false;
    btn.disabled = false; btn.textContent = '重新生成整体印象';

    if (result.error) {
      body.innerHTML = '<div class="chat-msg ai" style="color:var(--red)">生成失败：' + App.escapeHtml(result.error) + '</div>';
      return;
    }
    body.innerHTML = App.escapeHtml(result.impression).replace(/\n/g, '<br>');
    chatMessages = result.chatMessages;
    document.getElementById('aiChat').classList.remove('hidden');
    document.getElementById('aiSaveRow').classList.remove('hidden');
    renderAiChat();
  };

  window.toggleImpression = function () {
    const body = document.getElementById('aiImpressionBody');
    const btn = document.querySelector('#aiImpression .toggle-btn');
    const collapsed = body.style.display === 'none';
    body.style.display = collapsed ? '' : 'none';
    if (btn) btn.textContent = collapsed ? '收起 ▲' : '展开 ▼';
  };

  function renderAiChat() {
    const box = document.getElementById('aiChatMsgs');
    // 跳过 system[0] 与整体印象 assistant[1]（已在上方印象框展示）
    const msgs = chatMessages.slice(2);
    if (!msgs.length) { box.innerHTML = ''; return; }
    box.innerHTML = msgs.map((m) =>
      '<div class="chat-msg ' + (m.role === 'user' ? 'user' : 'ai') + '">' +
      App.escapeHtml(m.content).replace(/\n/g, '<br>') + '</div>'
    ).join('');
    box.scrollTop = box.scrollHeight;
  }

  window.aiSendChat = async function () {
    if (!App.aiUnlocked()) { applyAiLock(); App.showToast('AI 督导为付费功能，请先激活', 'error'); return; }
    const input = document.getElementById('aiChatInput');
    const text = input.value.trim();
    if (!text || isSending) return;
    input.value = '';
    chatMessages.push({ role: 'user', content: text });
    renderAiChat();

    const typing = document.createElement('div');
    typing.className = 'chat-msg ai typing';
    typing.textContent = '思考中……';
    document.getElementById('aiChatMsgs').appendChild(typing);
    document.getElementById('aiChatMsgs').scrollTop = document.getElementById('aiChatMsgs').scrollHeight;

    isSending = true;
    const sendBtn = document.getElementById('aiChatSend');
    sendBtn.disabled = true;

    const result = await SupervisionCore.runRound(chatMessages, text);
    isSending = false;
    sendBtn.disabled = false;
    typing.remove();

    if (result.error) {
      chatMessages.push({ role: 'assistant', content: '（生成失败：' + result.error + '）' });
      renderAiChat();
      return;
    }
    chatMessages = result.chatMessages;
    renderAiChat();
  };

  window.aiSaveSupervision = function () {
    if (!chatMessages.length || chatMessages[0].role !== 'system') {
      App.showToast('请先生成整体印象', 'error');
      return;
    }
    const material = document.getElementById('aiMaterial').value.trim();
    try {
      SupervisionCore.saveSupervision(spvMode, chatMessages, material, loadedSession);
      App.showToast('已保存为督导记录', 'success');
    } catch (e) {
      App.showToast(e.message, 'error');
    }
  };

  function applyAiLock() {
    const lock = document.getElementById('ai-sup-lock');
    if (!lock) return;
    const unlocked = App.aiUnlocked();
    if (unlocked) {
      lock.classList.add('hidden');
      document.getElementById('ai-sup').style.filter = '';
      document.getElementById('ai-sup').style.pointerEvents = '';
    } else {
      lock.classList.remove('hidden');
    }
  }

  window.openActivation = function () {
    if (window.__XJ_API__ && window.__XJ_API__.openActivation) window.__XJ_API__.openActivation();
  };

  // AI 督导初始化
  populateSessionSelect();
  document.getElementById('aiAck').checked = localStorage.getItem('xj_ai_sup_ack') === '1';
  document.getElementById('aiAck').addEventListener('change', function () {
    localStorage.setItem('xj_ai_sup_ack', this.checked ? '1' : '0');
  });
  const mat = document.getElementById('aiMaterial');
  if (mat) mat.addEventListener('input', updateLenTip);
  switchSpvMode(spvMode);
  applyAiLock();
  App.onLicenseStateChange(function () { try { applyAiLock(); } catch (e) {} });

  },
});
