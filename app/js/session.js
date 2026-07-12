/* ============================================================
   心镜 XinJing — 会话记录编辑逻辑
   ============================================================ */

const params = new URLSearchParams(location.search);
const sessionId = params.get('id');

App.initPage({
  onReady: async function () {
    'use strict';

    if (!sessionId) {
      location.href = 'clients.html';
      return;
    }

    let session = null;
    let clientId = null;

    async function init() {
    session = await Store.getSessionFull(sessionId);
    if (!session) {
      location.href = 'clients.html';
      return;
    }
    clientId = session.clientId;
    const client = Store.getClient(clientId);
    const clientName = client ? client.name : '未知';

    App.injectLayout(
      `${clientName} · 第${session.sessionNumber}节`,
      session.date ? App.formatDate(session.date, true) : '未记录日期',
      `<button class="btn btn-ghost btn-sm" onclick="exportSingle()">导出</button>`
    );
    App.bindModalClose('confirm-modal');

    if (window.Supervisors) Supervisors.ensureSeed();
    populateSupervisors();
    applyAiLock();
    fillForm();
  }

  function fillForm() {
    document.getElementById('s-date').value = session.date || App.todayStr();
    document.getElementById('s-start').value = session.startTime || '';
    document.getElementById('s-end').value = session.endTime || '';
    document.getElementById('s-duration').value = session.durationMinutes || '';
    const numEl = document.getElementById('s-session-number');
    if (numEl) numEl.value = session.sessionNumber || 1;
    document.getElementById('t-transcript').value = session.transcript || '';
    document.getElementById('soap-s').value = (session.soap && session.soap.subjective) || '';
    document.getElementById('soap-o').value = (session.soap && session.soap.objective) || '';
    document.getElementById('soap-a').value = (session.soap && session.soap.assessment) || '';
    document.getElementById('soap-p').value = (session.soap && session.soap.plan) || '';
    document.getElementById('dap-d').value = (session.dap && session.dap.data) || '';
    document.getElementById('dap-a').value = (session.dap && session.dap.assessment) || '';
    document.getElementById('dap-p').value = (session.dap && session.dap.plan) || '';
    document.getElementById('t-reflection').value = session.reflection || '';
    document.getElementById('s-confirmed').checked = !!session.isConfirmed;
    updateConfirmHint();
  }

  function updateConfirmHint() {
    const hint = document.getElementById('confirm-hint');
    hint.textContent = session.isConfirmed ? '✓ 本报告已确认，内容已锁定' : '草稿状态，可继续编辑';
  }

  window.switchTab = function (tab) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + tab));
  };

  window.pasteTranscript = async function () {
    try {
      const text = await navigator.clipboard.readText();
      const area = document.getElementById('t-transcript');
      area.value = (area.value ? area.value + '\n' : '') + text;
      App.showToast('已粘贴剪贴板内容', 'success');
    } catch (e) {
      App.showToast('无法读取剪贴板，请手动粘贴', 'error');
    }
  };

  window.generateSoapFromTranscript = function () {
    const transcript = document.getElementById('t-transcript').value.trim();
    if (!transcript) {
      App.showToast('请先填写逐字稿', 'error');
      return;
    }
    switchTab('soap');
    AI.generateSoapFromTranscript(transcript, (result) => {
      if (result.error) {
        App.showToast('生成失败：' + result.error, 'error');
        return;
      }
      document.getElementById('soap-s').value = result.subjective || '';
      document.getElementById('soap-o').value = result.objective || '';
      document.getElementById('soap-a').value = result.assessment || '';
      document.getElementById('soap-p').value = result.plan || '';
      App.showToast('SOAP 已生成，请审阅后保存', 'success');
    });
  };

  window.saveSession = async function () {
    const updated = {
      ...session,
      date: document.getElementById('s-date').value,
      startTime: document.getElementById('s-start').value,
      endTime: document.getElementById('s-end').value,
      durationMinutes: parseInt(document.getElementById('s-duration').value) || 0,
      transcript: document.getElementById('t-transcript').value,
      soap: {
        subjective: document.getElementById('soap-s').value,
        objective: document.getElementById('soap-o').value,
        assessment: document.getElementById('soap-a').value,
        plan: document.getElementById('soap-p').value,
      },
      dap: {
        data: document.getElementById('dap-d').value,
        assessment: document.getElementById('dap-a').value,
        plan: document.getElementById('dap-p').value,
      },
      reflection: document.getElementById('t-reflection').value,
      isConfirmed: document.getElementById('s-confirmed').checked,
      sessionNumber: (function () {
        const n = parseInt(document.getElementById('s-session-number').value, 10);
        return Number.isFinite(n) && n >= 1 ? n : session.sessionNumber;
      })(),
    };
    await Store.updateSessionFull(updated);
    session = updated;
    updateConfirmHint();
    App.showToast('已保存', 'success');
  };

  window.exportSingle = function () {
    const md = Export.buildSingleSessionMarkdown(session);
    App.downloadFile(`心镜_${Store.getClient(clientId).name}_第${session.sessionNumber}节.md`, md, 'text/markdown');
  };

  // ---- AI 助手 ----
  function applyAiLock() {
    const lock = document.getElementById('ai-lock');
    if (!lock) return;
    if (App.aiUnlocked()) lock.classList.add('hidden');
    else lock.classList.remove('hidden');
  }
  // 页面加载时即刷新一次；激活广播后由 App 统一回调刷新
  App.onLicenseStateChange(() => { try { applyAiLock(); } catch (e) {} });

  function openActivation() {
    if (window.__XJ_API__ && window.__XJ_API__.openActivation) window.__XJ_API__.openActivation();
  }

  function switchAiMode(mode) {
    const gen = document.getElementById('mode-general');
    const sup = document.getElementById('mode-supervise');
    const area = document.getElementById('ai-supervise-area');
    if (mode === 'supervise') {
      gen.classList.remove('active'); sup.classList.add('active'); area.classList.remove('hidden');
    } else {
      gen.classList.add('active'); sup.classList.remove('active'); area.classList.add('hidden');
    }
  }

  function populateSupervisors() {
    const sel = document.getElementById('ai-supervisor');
    if (!sel) return;
    sel.innerHTML = '';
    const list = (window.Supervisors && Supervisors.list()) || [];
    list.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name + (s.builtin ? '（内置）' : '');
      sel.appendChild(opt);
    });
  }

  function buildContext() {
    const t = document.getElementById('t-transcript').value;
    const soap = [
      document.getElementById('soap-s').value,
      document.getElementById('soap-o').value,
      document.getElementById('soap-a').value,
      document.getElementById('soap-p').value,
    ].join('\n');
    const refl = document.getElementById('t-reflection').value;
    return '【逐字稿】\n' + t + '\n\n【SOAP】\n' + soap + '\n\n【咨询师反思】\n' + refl;
  }

  window.aiGenerate = function (type) {
    if (!App.aiUnlocked()) { applyAiLock(); App.showToast('AI 助手为付费功能，请先激活', 'error'); return; }
    const transcript = document.getElementById('t-transcript').value.trim();
    if (!transcript && type !== 'next') {
      App.showToast('请先填写逐字稿', 'error');
      return;
    }
    switchTab('ai');
    const prompts = {
      soap: '请根据逐字稿生成一份标准 SOAP 格式报告。',
      summary: '请对本次会谈进行简洁总结。',
      theme: '请分析本次会谈呈现的核心主题与动力学议题。',
      next: '基于当前会谈资料，建议下次咨询可以聚焦的方向。',
    };
    AI.chat(prompts[type] + '\n\n逐字稿：\n' + transcript, (reply) => {
      addAiMessage(reply, false);
    });
  };

  window.aiSend = function () {
    if (!App.aiUnlocked()) { applyAiLock(); App.showToast('AI 助手为付费功能，请先激活', 'error'); return; }
    const input = document.getElementById('ai-input');
    const text = input.value.trim();
    if (!text) return;
    addAiMessage(text, true);
    input.value = '';
    const context = `逐字稿：\n${document.getElementById('t-transcript').value}\n\nSOAP：\n${document.getElementById('soap-s').value} ${document.getElementById('soap-a').value}\n\n反思：\n${document.getElementById('t-reflection').value}`;
    AI.chat(text + '\n\n参考材料：\n' + context, (reply) => {
      addAiMessage(reply, false);
    });
  };

  // AI 督导：用所选督导师身份（或自定义提示词）基于会谈材料生成督导意见
  window.aiSupervise = function () {
    if (!App.aiUnlocked()) { applyAiLock(); App.showToast('AI 督导为付费功能，请先激活', 'error'); return; }
    const sel = document.getElementById('ai-supervisor');
    const custom = document.getElementById('ai-custom-prompt').value.trim();
    const sup = sel ? Supervisors.getById(sel.value) : null;
    const prompt = custom || (sup && sup.prompt) || '';
    if (!prompt) { App.showToast('请选择督导师或填写自定义提示词', 'error'); return; }
    const context = buildContext();
    if (!context.replace(/\s/g, '')) { App.showToast('请先填写逐字稿等会谈材料', 'error'); return; }
    // 既往督导记录 → 长时程成长视角上下文
    let history = '';
    try {
      if (typeof Store.buildSupervisionGrowthContext === 'function') {
        history = Store.buildSupervisionGrowthContext(clientId, sessionId) || '';
      }
    } catch (e) { history = ''; }
    const supName = sup ? sup.name : '自定义督导师';
    switchTab('ai');
    addAiMessage('（AI 督导 · ' + supName + (history ? ' · 已载入既往督导记录，将给出成长视角' : '') + '）正在生成督导意见…', false);
    AI.supervise(prompt, context, history, (res) => {
      if (res.error) { App.showToast('督导生成失败：' + res.error, 'error'); return; }
      addAiMessage(res.content, false);
      // 持久化为该来访者的督导档案，供后续督导纵向对照（自动积累成长轨迹）
      try {
        if (typeof Store.saveAiSupervision === 'function') {
          Store.saveAiSupervision({
            clientId: clientId,
            sessionId: sessionId,
            supervisorName: supName,
            context: context,
            content: res.content,
          });
        }
      } catch (e) { /* 保存失败不影响展示 */ }
    });
  };

  window.loadPromptFile = function () {
    const fileInput = document.getElementById('ai-prompt-file');
    const ta = document.getElementById('ai-custom-prompt');
    const f = fileInput && fileInput.files && fileInput.files[0];
    if (!f) { App.showToast('请先选择 .txt/.md 文件', 'error'); return; }
    const reader = new FileReader();
    reader.onload = () => { ta.value = reader.result || ''; App.showToast('已读取提示词文件', 'success'); };
    reader.onerror = () => App.showToast('读取文件失败', 'error');
    reader.readAsText(f);
  };

  window.switchAiMode = switchAiMode;
  window.openActivation = openActivation;

  // 返回来访者详情页。clientId 是本闭包内的局部变量，
  // 之前 HTML 内联 onclick 直接引用它会因全局作用域取不到而抛 ReferenceError（返回按钮点击无反应）。
  // 统一挂到 window 上，并对 clientId 缺失做兜底。
  window.goBack = function () {
    if (clientId) {
      location.href = 'client-detail.html?id=' + encodeURIComponent(clientId);
    } else {
      location.href = 'clients.html';
    }
  };

  function addAiMessage(text, isUser) {
    const chat = document.getElementById('ai-chat');
    const div = document.createElement('div');
    div.className = 'ai-msg ' + (isUser ? 'user' : 'ai');
    div.innerHTML = `<div class="bubble">${App.escapeHtml(text)}</div>`;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
  }

    init();
  },
});
