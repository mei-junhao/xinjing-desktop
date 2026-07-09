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

    fillForm();
  }

  function fillForm() {
    document.getElementById('s-date').value = session.date || App.todayStr();
    document.getElementById('s-start').value = session.startTime || '';
    document.getElementById('s-end').value = session.endTime || '';
    document.getElementById('s-duration').value = session.durationMinutes || '';
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
  window.aiGenerate = function (type) {
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
