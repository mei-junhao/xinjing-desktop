/* ============================================================
   心镜 XinJing — 工作台逻辑
   ============================================================ */

App.initPage({
  title: '首页',
  subtitle: App.todayFullCN(),
  actions: `<button class="btn btn-primary" onclick="App.openModal('client-modal')">新建来访者<span class="trail"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></span></button>`,
  onReady: function () {
    'use strict';

    App.bindModalClose('client-modal');
    // 默认首访日期 = 今天
    document.getElementById('c-firstvisit').value = App.todayStr();

  // ---------- 渲染统计 ----------
  function renderStats() {
    const stats = Store.getStats();
    const money = function (n) { return '¥' + Number(n || 0).toLocaleString('zh-CN'); };
    document.getElementById('stat-receivable').textContent = money(stats.monthlyReceivable);
    document.getElementById('stat-received').textContent = money(stats.monthlyReceived);
    document.getElementById('stat-pending-clients').textContent = stats.pendingClients;
    document.getElementById('stat-active-clients').textContent = stats.activeClients;
  }

  // ---------- 最近会谈 ----------
  function renderRecentSessions() {
    const container = document.getElementById('recent-sessions');
    const sessions = Store.getRecentSessions(6);
    const countEl = document.getElementById('recent-sessions-count');
    countEl.textContent = sessions.length ? `共 ${sessions.length} 条` : '';

    if (!sessions.length) {
      container.innerHTML = `<div class="empty-state"><div class="icon">${App.svgIcon('chat')}</div><div class="text">暂无会谈记录</div></div>`;
      return;
    }

    container.innerHTML = sessions
      .map((s) => {
        const client = Store.getClient(s.clientId);
        const name = client ? client.name : '未知来访者';
        return `<div class="list-card" onclick="location.href='session.html?id=${s.id}'">
          <div class="row1">
            <span class="title">${App.escapeHtml(name)} · 第${s.sessionNumber}节</span>
            <span class="meta">${App.formatDate(s.date)}</span>
          </div>
          <div class="desc">${App.renderReportTags(s)}</div>
        </div>`;
      })
      .join('');
  }

  // ---------- 最近报告 ----------
  function renderRecentReports() {
    const container = document.getElementById('recent-reports');
    const sessions = Store.getRecentReports(6);
    const countEl = document.getElementById('recent-reports-count');
    countEl.textContent = sessions.length ? `共 ${sessions.length} 条` : '';

    if (!sessions.length) {
      container.innerHTML = `<div class="empty-state"><div class="icon">${App.svgIcon('doc')}</div><div class="text">暂无报告</div></div>`;
      return;
    }

    container.innerHTML = sessions
      .map((s) => {
        const client = Store.getClient(s.clientId);
        const name = client ? client.name : '未知';
        const types = [];
        if (s.hasSoap) types.push({ t: 'SOAP个案报告', c: 'tag-soap' });
        if (s.hasDap) types.push({ t: 'DAP临床报告', c: 'tag-dap' });
        if (s.hasReflection) types.push({ t: '咨询师反思记录', c: 'tag-reflection' });
        const tagHtml = types
          .map((x) => `<span class="tag ${x.c}">${x.t}</span>`)
          .join(' ');
        return `<div class="list-card" onclick="location.href='session.html?id=${s.id}'">
          <div class="row1">
            <span class="title">${App.escapeHtml(name)} · 第${s.sessionNumber}节</span>
            <span class="meta">${App.formatDate(s.updatedAt)}</span>
          </div>
          <div class="desc">${tagHtml}</div>
        </div>`;
      })
      .join('');
  }

  // ---------- 保存新来访者 ----------
  window.saveNewClient = function () {
    const name = document.getElementById('c-name').value.trim();
    if (!name) {
      App.showToast('请填写姓名或化名', 'error');
      return;
    }
    const tagsInput = document.getElementById('c-tags').value.trim();
    const tags = tagsInput
      ? tagsInput.split(/[,，]/).map((t) => t.trim()).filter(Boolean)
      : [];

    const client = Store.createClient({
      name,
      gender: document.getElementById('c-gender').value,
      birthDate: document.getElementById('c-birth').value,
      phone: document.getElementById('c-phone').value.trim(),
      firstVisitDate: document.getElementById('c-firstvisit').value,
      tags,
      notes: document.getElementById('c-notes').value.trim(),
    });

    App.closeModal('client-modal');
    App.showToast('已创建来访者：' + name, 'success');
    // 重置表单
    document.getElementById('c-name').value = '';
    document.getElementById('c-birth').value = '';
    document.getElementById('c-phone').value = '';
    document.getElementById('c-tags').value = '';
    document.getElementById('c-notes').value = '';
    // 跳转详情页
    setTimeout(() => {
      location.href = 'client-detail.html?id=' + client.id;
    }, 600);
  };

    // ---------- 初始渲染 ----------
    renderStats();
    renderRecentSessions();
    renderRecentReports();

    // ---------- 快捷操作（#5 首页）----------
    const qaSup = document.getElementById('qa-supervise');
    const qaMas = document.getElementById('qa-masters');
    const qaUpd = document.getElementById('qa-update');
    if (qaSup) qaSup.onclick = function () { location.href = 'supervision.html'; };
    if (qaMas) qaMas.onclick = function () { location.href = 'masters.html'; };
    if (qaUpd) qaUpd.onclick = function () {
      const api = window.__XJ_API__;
      if (api && typeof api.checkForUpdates === 'function') {
        try {
          const r = api.checkForUpdates();
          if (r && typeof r.then === 'function') {
            r.catch(function (e) {
              App.showToast('检查更新失败：' + (e && e.message ? e.message : e), 'error');
            });
          }
        } catch (e) {
          App.showToast('检查更新失败：' + (e && e.message ? e.message : e), 'error');
        }
      } else {
        App.showToast('已是最新版本', 'success');
      }
    };

    // ---------- Agent 浮窗首次引导 ----------
    try {
      if (!localStorage.getItem('xj_agent_onboarded')) {
        const bubble = document.createElement('div');
        bubble.className = 'xj-agent-onboard';
        bubble.innerHTML = '<div class="xj-agent-onboard-text">右下角的 <b>AI 助手</b> 按钮已就绪，点它即可唤起心镜 Agent ✨</div><button class="xj-agent-onboard-close" aria-label="关闭">×</button>';
        document.body.appendChild(bubble);
        const dismiss = function () {
          bubble.classList.add('xj-agent-onboard-hide');
          try { localStorage.setItem('xj_agent_onboarded', '1'); } catch (e) {}
          setTimeout(function () { if (bubble.parentNode) bubble.parentNode.removeChild(bubble); }, 400);
        };
        bubble.querySelector('.xj-agent-onboard-close').addEventListener('click', dismiss);
        setTimeout(dismiss, 6000);
      }
    } catch (e) {}
  },
});
