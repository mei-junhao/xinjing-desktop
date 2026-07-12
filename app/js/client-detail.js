/* ============================================================
   心镜 XinJing — 来访者详情逻辑
   ============================================================ */

const params = new URLSearchParams(location.search);
const clientId = params.get('id');

App.initPage({
  onReady: function () {
    'use strict';

    if (!clientId) {
      location.href = 'clients.html';
      return;
    }

    const client = Store.getClient(clientId);
    if (!client) {
      location.href = 'clients.html';
      return;
    }

    App.injectLayout(
      client.name,
      `首访 ${client.firstVisitDate ? App.formatDate(client.firstVisitDate, true) : '未记录'} · ${App.statusLabel(client.status)}`,
      `<button class="btn btn-ghost btn-sm" onclick="location.href='index.html'">← 工作台</button>
<button class="btn btn-primary" onclick="newSession()">新增会话<span class="trail"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></span></button>`
    );
    App.bindModalClose('confirm-modal');
    App.bindModalClose('edit-modal');

  // ---------- 基本信息 ----------
  function renderBasic() {
    document.getElementById('detail-name').textContent = client.name;
    document.getElementById('detail-badge').textContent = App.statusLabel(client.status);
    document.getElementById('detail-tags').innerHTML = App.renderTags(client.tags);

    const sessions = Store.getSessionsByClient(clientId);
    const sessionIds = sessions.map((s) => s.id);
    const sups = Store.getSupervisions().filter((sv) => (sv.sessionIds || []).some((sid) => sessionIds.includes(sid)));

    document.getElementById('st-sessions').textContent = sessions.length;
    document.getElementById('st-first').textContent = client.firstVisitDate ? App.formatDate(client.firstVisitDate, true) : '—';
    const lastDate = sessions.length ? sessions.map((s) => s.date).filter(Boolean).sort().pop() : '';
    document.getElementById('st-last').textContent = lastDate ? App.formatDate(lastDate, true) : '—';
    document.getElementById('st-sup').textContent = sups.length;

    const notesEl = document.getElementById('detail-notes');
    if (notesEl) notesEl.textContent = client.notes || '（暂无备注）';
  }

  // ---------- 会话列表 ----------
  async function renderSessions() {
    const container = document.getElementById('session-list');
    const sessions = Store.getSessionsByClient(clientId);
    document.getElementById('session-count').textContent = sessions.length ? `共 ${sessions.length} 节` : '';

    if (!sessions.length) {
      container.innerHTML = `<div class="empty-state"><div class="icon">${App.svgIcon('chat')}</div><div class="text">还没有会话记录，点击下方按钮新增</div></div>`;
      return;
    }

    container.innerHTML = sessions
      .map((s) => `
        <div class="list-card" onclick="location.href='session.html?id=${s.id}'">
          <div class="row1">
            <span class="title">第 ${s.sessionNumber} 节</span>
            <span class="meta">${App.formatDate(s.date, true)} ${s.startTime ? '· ' + s.startTime : ''}</span>
          </div>
          <div class="desc">${App.renderReportTags(s)}</div>
        </div>`)
      .join('');
  }

  // ---------- 督导列表 ----------
  function renderSupervisions() {
    const container = document.getElementById('supervision-list');
    const sessionIds = Store.getSessionsByClient(clientId).map((s) => s.id);
    const sups = Store.getSupervisions().filter((sv) => (sv.sessionIds || []).some((sid) => sessionIds.includes(sid)));
    document.getElementById('sup-count').textContent = sups.length ? `共 ${sups.length} 条` : '';

    if (!sups.length) {
      container.innerHTML = `<div class="empty-state"><div class="icon">${App.svgIcon('cap')}</div><div class="text">暂无督导记录</div></div>`;
      return;
    }

    container.innerHTML = sups
      .map((sv) => {
        const typeLabel = sv.type === 'group' ? '团体督导' : '个体督导';
        const names = (sv.sessionIds || [])
          .map((sid) => {
            const s = Store.getSession(sid);
            return s ? '第' + s.sessionNumber + '节' : '';
          })
          .filter(Boolean)
          .join('、');
        return `<div class="list-card" onclick="location.href='supervision.html'">
          <div class="row1">
            <span class="title">${sv.supervisorName || '未填督导师'} · ${typeLabel}</span>
            <span class="meta">${App.formatDate(sv.date, true)}</span>
          </div>
          <div class="desc">关联：${names || '无'}</div>
        </div>`;
      })
      .join('');
  }

  // ---------- 操作 ----------
  // 新增会话：先让用户自定义「第X节」序号（默认 = 当前最大节数+1）
  window.newSession = function () {
    const input = document.getElementById('new-session-number');
    if (input) {
      const next = (typeof Store.nextSessionNumber === 'function') ? Store.nextSessionNumber(clientId) : 1;
      input.value = next;
    }
    App.openModal('session-number-modal');
    setTimeout(() => { if (input) input.focus(); }, 50);
  };

  window.createSessionWithNumber = async function () {
    const input = document.getElementById('new-session-number');
    let num = 1;
    if (input && input.value) {
      num = parseInt(input.value, 10);
      if (!Number.isFinite(num) || num < 1) {
        App.showToast('节数必须为正整数', 'error');
        return;
      }
    }
    try {
      const session = await Store.createSession({ clientId, sessionNumber: num });
      App.closeModal('session-number-modal');
      location.href = 'session.html?id=' + session.id;
    } catch (e) {
      // createSession 在受限模式下可能对只读(溢出)来访者抛错（S9 守卫），需提示而非静默失败
      App.showToast(e && e.message ? e.message : '新建节次失败', 'error');
    }
  };

  window.openEditFromDetail = function () {
    document.getElementById('e-id').value = clientId;
    document.getElementById('e-name').value = client.name || '';
    document.getElementById('e-gender').value = client.gender || 'unknown';
    document.getElementById('e-birth').value = client.birthDate || '';
    document.getElementById('e-phone').value = client.phone || '';
    document.getElementById('e-firstvisit').value = client.firstVisitDate || '';
    document.getElementById('e-status').value = client.status || 'active';
    document.getElementById('e-tags').value = (client.tags || []).join(', ');
    document.getElementById('e-notes').value = client.notes || '';
    App.openModal('edit-modal');
  };

  window.saveEditFromDetail = function () {
    const tagsInput = document.getElementById('e-tags').value.trim();
    const tags = tagsInput ? tagsInput.split(/[,，]/).map((t) => t.trim()).filter(Boolean) : [];
    Store.updateClient(clientId, {
      name: document.getElementById('e-name').value.trim(),
      gender: document.getElementById('e-gender').value,
      birthDate: document.getElementById('e-birth').value,
      phone: document.getElementById('e-phone').value.trim(),
      firstVisitDate: document.getElementById('e-firstvisit').value,
      status: document.getElementById('e-status').value,
      tags,
      notes: document.getElementById('e-notes').value.trim(),
    });
    App.closeModal('edit-modal');
    App.showToast('已保存', 'success');
    location.reload();
  };

  window.deleteFromDetail = function () {
    App.confirmDialog('确定删除该来访者及其所有数据？不可撤销。', () => {
      Store.deleteClient(clientId);
      App.closeModal('edit-modal');
      App.showToast('已删除', 'success');
      setTimeout(() => { location.href = 'clients.html'; }, 500);
    }, true);
  };

  // ---------- 成长轨迹（AI） ----------
  function parseJSONRobustly(str) {
    if (typeof str !== 'string') throw new Error('返回内容为空');
    let s = str.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    try { return JSON.parse(s); } catch (e) { /* 继续尝试提取 */ }
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try { return JSON.parse(s.slice(start, end + 1)); } catch (e2) { /* 失败 */ }
    }
    throw new Error('返回内容不是合法 JSON');
  }

  window.analyzeGrowthTrajectory = function (cid) {
    const c = Store.getClient(cid);
    if (!c) return;
    const sessions = Store.getSessionsByClient(cid);
    const sessionIds = sessions.map((s) => s.id);
    const sups = Store.getSupervisions().filter((sv) => (sv.sessionIds || []).some((id) => sessionIds.includes(id)));

    const lines = sessions
      .slice()
      .sort((a, b) => (a.sessionNumber || 0) - (b.sessionNumber || 0))
      .map((s) => {
        const flags = [];
        if (s.hasTranscript) flags.push('逐字稿');
        if (s.hasSoap) flags.push('SOAP');
        if (s.hasDap) flags.push('DAP');
        if (s.hasReflection) flags.push('反思');
        return `第${s.sessionNumber}节 ${s.date || ''} 含[${flags.join('/') || '无'}]`;
      })
      .join('\n');

    const supThemes = sups
      .map((sv) => `- ${sv.supervisorName || '未填督导师'}（${sv.type === 'group' ? '团体' : '个体'}督导）`)
      .join('\n');

    const prompt =
      `你是一位资深心理咨询督导师。请基于以下来访者「${c.name}」的咨询记录与督导记录，生成一份结构化的「成长轨迹」分析。\n\n` +
      `【会谈记录】\n${lines || '（暂无会谈记录）'}\n\n` +
      `【督导主题】\n${supThemes || '（暂无督导记录）'}\n\n` +
      `请只返回一个 JSON 对象，不要包含任何其他文字或 markdown 代码块，格式如下：\n` +
      `{\n` +
      `  "summary": "一段总体概括，描述来访者的成长脉络与当前状态",\n` +
      `  "milestones": [ { "title": "里程碑标题", "note": "说明" } ],\n` +
      `  "risks": [ "需要关注的风险点" ],\n` +
      `  "resources": [ "来访者具备的内在/外在资源" ]\n` +
      `}`;

    App.showToast('正在生成成长轨迹…', 'info');
    AI.send([{ role: 'user', content: prompt }], function (res) {
      if (res.error) {
        App.showToast('生成失败：' + (res.error.message || res.error), 'error');
        return;
      }
      try {
        var data = parseJSONRobustly(res.content);
        Store.updateClient(cid, {
          growthTrajectory: {
            generatedAt: new Date().toISOString(),
            model: AI.getTier(),
            summary: data.summary || '',
            milestones: data.milestones || [],
            risks: data.risks || [],
            resources: data.resources || [],
          },
        });
        renderGrowth();
      } catch (e) {
        App.showToast('生成结果解析失败', 'error');
      }
    });
  };

  function renderGrowth() {
    const el = document.getElementById('growth-trajectory');
    if (!el) return;
    const c = Store.getClient(clientId);
    const gt = c && c.growthTrajectory;

    const hasContent = gt && (gt.summary || (gt.milestones && gt.milestones.length) || (gt.risks && gt.risks.length) || (gt.resources && gt.resources.length));
    if (!hasContent) {
      el.innerHTML = `<div class="empty">尚无成长轨迹，点击上方按钮生成</div>`;
      return;
    }

    let html = '';
    if (gt.summary) {
      html += `<div style="font-size:14px;line-height:1.85;color:var(--text);font-family:var(--sans);margin-bottom:14px">${App.escapeHtml(gt.summary)}</div>`;
    }
    if (gt.milestones && gt.milestones.length) {
      html += `<div class="section-title" style="margin-top:0">里程碑</div>`;
      html += gt.milestones
        .map(
          (m) => `<div class="list-card">
            <div class="row1"><span class="title">${App.escapeHtml(m.title || '')}</span></div>
            ${m.note ? `<div class="desc">${App.escapeHtml(m.note)}</div>` : ''}
          </div>`
        )
        .join('');
    }
    if (gt.risks && gt.risks.length) {
      html += `<div class="section-title">风险</div><div class="tags" style="margin-bottom:14px">${gt.risks
        .map((r) => `<span class="tag">${App.escapeHtml(r)}</span>`)
        .join('')}</div>`;
    }
    if (gt.resources && gt.resources.length) {
      html += `<div class="section-title">资源</div><div class="tags" style="margin-bottom:14px">${gt.resources
        .map((r) => `<span class="tag">${App.escapeHtml(r)}</span>`)
        .join('')}</div>`;
    }
    if (gt.generatedAt) {
      const modelLabel = gt.model === 'user' ? '高性能模型' : '内置模型';
      html += `<div style="font-size:11.5px;color:var(--text-muted);margin-top:14px">生成于 ${App.formatDate(
        gt.generatedAt,
        true
      )} · ${modelLabel}</div>`;
    }
    el.innerHTML = html;
  }

  // 成长轨迹按钮：按档位显示文案
  (function setupGrowthButton() {
    const btn = document.getElementById('growth-btn');
    if (!btn) return;
    const tier = AI.getTier();
    btn.textContent = tier === 'user' ? '生成成长轨迹（高性能模型）' : '生成成长轨迹（内置模型·较简略）';
    btn.onclick = function () {
      analyzeGrowthTrajectory(clientId);
    };
  })();

    // ---------- 初始渲染 ----------
    renderBasic();
    renderSessions();
    renderSupervisions();
    renderGrowth();
  },
});
