/* 心镜 v3.1.0 — 文档中心（方案E：双栏+Tab分类+成长轨迹） */
(function () {
  'use strict';
  var currentClientId = null;
  var currentTab = 'all';
  var searchQuery = '';

  function renderClientList() {
    var box = document.getElementById('client-list');
    var clients = Store.getClients().filter(function (c) { return c.status !== 'ended'; });
    box.innerHTML = clients.map(function (c) {
      var sessions = Store.getSessionsByClient(c.id) || [];
      var supervisions = (Store.getSupervisionsByClient ? Store.getSupervisionsByClient(c.id) : []) || [];
      var count = sessions.length + supervisions.length;
      return '<div class="dl-item' + (c.id === currentClientId ? ' active' : '') + '" onclick="selectClient(\'' + c.id + '\')">' +
        '<div class="dl-avatar">' + (c.name ? c.name[0] : '?') + '</div>' +
        '<div class="dl-info"><div class="dl-name">' + App.escapeHtml(c.name) + '</div><div class="dl-count">' + count + ' 份文档</div></div></div>';
    }).join('');
    renderClientSelect();
  }

  // 顶部下拉：与左栏来访者列表保持同步
  function renderClientSelect() {
    var sel = document.getElementById('dc-client-select');
    if (!sel) return;
    var clients = Store.getClients().filter(function (c) { return c.status !== 'ended'; });
    sel.innerHTML = '<option value="">手动选择来访者…</option>' + clients.map(function (c) {
      return '<option value="' + c.id + '">' + App.escapeHtml(c.name) + '</option>';
    }).join('');
    sel.value = currentClientId || '';
  }

  window.selectClient = function (clientId) {
    currentClientId = clientId;
    renderClientList();
    renderDocs();
  };

  // 顶部下拉手动选择来访者：切换当前来访者并同步左栏高亮
  window.onClientSelect = function (id) {
    if (!id) return;
    selectClient(id);
  };

  window.switchDocTab = function (tab) {
    currentTab = tab;
    document.querySelectorAll('.dr-tab').forEach(function (t) { t.classList.toggle('active', t.dataset.tab === tab); });
    renderDocs();
  };

  window.filterDocs = function () {
    searchQuery = document.getElementById('dc-search').value.trim().toLowerCase();
    renderDocs();
  };

  function renderDocs() {
    var box = document.getElementById('doc-content');
    if (!currentClientId) {
      box.innerHTML = '<div class="empty-state"><span class="big">📂</span>选择左侧来访者查看文档</div>';
      return;
    }
    var client = Store.getClient(currentClientId);
    if (!client) { box.innerHTML = '<div class="empty-state">来访者不存在</div>'; return; }

    if (currentTab === 'trajectory') {
      renderTrajectory(box, client);
      return;
    }

    var sessions = Store.getSessionsByClient(currentClientId).sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
    var seenDc = {};
    sessions = sessions.filter(function (s) { if (seenDc[s.id]) return false; seenDc[s.id] = 1; return true; });
    var supervisions = (Store.getSupervisionsByClient ? Store.getSupervisionsByClient(currentClientId) : []) || [];
    var docs = [];

    sessions.forEach(function (s) {
      if (currentTab === 'all' || currentTab === 'transcript') {
        if (s.transcript && s.transcript.trim()) {
          docs.push({ type: 'transcript', title: '第' + (s.sessionNumber || '?') + '节 逐字稿', date: s.date, preview: s.transcript.slice(0, 120), id: s.id, sessionNumber: s.sessionNumber });
        }
      }
      if (currentTab === 'all' || currentTab === 'report') {
        if (s.soap && (s.soap.subjective || s.soap.objective || s.soap.assessment || s.soap.plan)) {
          var soapText = [s.soap.subjective, s.soap.objective, s.soap.assessment, s.soap.plan].filter(Boolean).join(' / ');
          docs.push({ type: 'report', title: '第' + (s.sessionNumber || '?') + '节 咨询记录', date: s.date, preview: soapText.slice(0, 120), id: s.id });
        }
      }
    });

    supervisions.forEach(function (sv) {
      if (currentTab === 'all' || currentTab === 'supervision') {
        var content = sv.content || sv.conclusion || '';
        docs.push({ type: 'supervision', title: (sv.reportTitle || '督导记录') + ' · ' + (sv.supervisorName || ''), date: sv.date, preview: content.slice(0, 120), id: sv.id });
      }
    });

    // 搜索过滤
    if (searchQuery) {
      docs = docs.filter(function (d) {
        return d.title.toLowerCase().indexOf(searchQuery) >= 0 || d.preview.toLowerCase().indexOf(searchQuery) >= 0;
      });
    }

    // 按日期排序
    docs.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });

    if (!docs.length) {
      box.innerHTML = '<div class="empty-state"><span class="big">📭</span>暂无文档' + (searchQuery ? ' 匹配搜索条件' : '') + '</div>';
      return;
    }

    var icons = { transcript: '📄', report: '📝', supervision: '🧠' };
    var tags = { transcript: '逐字稿', report: '咨询记录', supervision: '督导' };

    box.innerHTML = docs.map(function (d) {
      return '<div class="doc-card" onclick="openDoc(\'' + d.type + '\',\'' + d.id + '\')">' +
        '<div class="dc-icon">' + (icons[d.type] || '📄') + '</div>' +
        '<div class="dc-body">' +
        '<div class="dc-title">' + App.escapeHtml(d.title) + '</div>' +
        '<div class="dc-meta">' + App.formatDate(d.date) + ' <span class="tag">' + (tags[d.type] || d.type) + '</span></div>' +
        (d.preview ? '<div class="dc-preview">' + App.escapeHtml(d.preview) + '…</div>' : '') +
        '</div></div>';
    }).join('');

    // 底部成长轨迹入口
    box.innerHTML += '<div style="text-align:center;padding:8px"><button class="back" style="border:1px solid var(--border);padding:8px 20px;border-radius:8px;font-size:12px;cursor:pointer;color:var(--ink-2)" onclick="switchDocTab(\'trajectory\')">📈 查看 ' + App.escapeHtml(client.name) + ' 的成长轨迹</button></div>';
  }

  function renderTrajectory(box, client) {
    var sessions = Store.getSessionsByClient(currentClientId).sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
    var seenDc2 = {};
    sessions = sessions.filter(function (s) { if (seenDc2[s.id]) return false; seenDc2[s.id] = 1; return true; });
    var supervisions = (Store.getSupervisionsByClient ? Store.getSupervisionsByClient(currentClientId) : []) || [];

    var html = '<div class="trajectory">';
    html += '<div class="tj-head"><span class="tj-title">📈 ' + App.escapeHtml(client.name) + ' 的成长轨迹</span><span class="tj-badge">AI 生成</span></div>';

    var items = [];
    sessions.forEach(function (s) {
      var text = '';
      if (s.soap && s.soap.assessment) text = s.soap.assessment.slice(0, 100);
      else if (s.transcript) text = '进行了第' + (s.sessionNumber || '?') + '节咨询';
      if (text) items.push({ date: s.date, text: text, tag: '咨询', type: 'session' });
    });
    supervisions.forEach(function (sv) {
      var text = sv.summary || sv.content || '';
      if (text) items.push({ date: sv.date, text: text.slice(0, 100), tag: '督导', type: 'supervision' });
    });
    items.sort(function (a, b) { return (a.date || '').localeCompare(b.date || ''); });

    if (!items.length) {
      html += '<div style="text-align:center;padding:20px;color:var(--ink-3)">暂无数据</div>';
    } else {
      items.forEach(function (item) {
        html += '<div class="tj-item"><div class="tj-date">' + App.formatDate(item.date) + '</div><div class="tj-text">' + App.escapeHtml(item.text) + '</div><span class="tj-tag">' + item.tag + '</span></div>';
      });
    }
    html += '</div>';

    // 会员功能：AI生成洞察（featureGate 硬门控 + 实际 AI 调用）
    if (typeof App !== 'undefined' && typeof App.featureGate === 'function' && !App.featureGate('ai-growth')) {
      html += '<div class="trajectory" style="margin-top:12px">';
      html += '<div class="tj-head"><span class="tj-title">🤖 AI 成长洞察</span>' + App.lockBadge('ai-growth') + '</div>';
      html += '<div class="xj-locked-area"><div style="text-align:center;padding:24px;color:var(--ink-3);font-size:12px">升级会员后，AI 将自动分析所有材料，生成来访者的成长轨迹、核心议题变化与治疗进展洞察</div></div>';
      html += '</div>';
    } else {
      html += '<div class="trajectory" style="margin-top:12px">';
      html += '<div class="tj-head"><span class="tj-title">🤖 AI 成长洞察</span><span class="tj-badge">已解锁</span></div>';
      html += '<div id="ai-trajectory-output" style="padding:16px"><button class="btn btn-primary" onclick="generateAiTrajectory()">生成成长洞察</button></div>';
      html += '</div>';
    }
    window.generateAiTrajectory = function () {
      var out = document.getElementById('ai-trajectory-output');
      if (out) out.innerHTML = '<div style="text-align:center;padding:20px;color:var(--ink-3)">AI 分析中…</div>';
      var sessions = Store.getSessionsByClient(currentClientId);
      var sups = Store.getSupervisionsByClient(currentClientId) || [];
      var ctx = sessions.map(function (s) { return '第' + (s.sessionNumber || '?') + '节(' + (s.date || '?') + '): ' + ((s.soap && s.soap.assessment) || s.summary || '').slice(0, 200); }).join('\n');
      ctx += '\n督导: ' + sups.map(function (sv) { return (sv.date || '?') + ': ' + (sv.conclusion || sv.content || '').slice(0, 200); }).join('\n');
      AI.send([{ role: 'system', content: '你是心理咨询个案分析专家。根据以下咨询记录和督导记录，生成来访者的成长轨迹分析。输出JSON：{"trajectory":"整体成长轨迹描述","keyChanges":["关键变化1","关键变化2"],"insights":["AI洞察1","洞察2"],"recommendations":["后续建议1"]}' }, { role: 'user', content: ctx }], function (res) {
        if (res && res.content && !res.error) {
          try {
            var j = JSON.parse(res.content.replace(/^```json\s*/i, '').replace(/```\s*$/i, ''));
            var h = '<div style="line-height:1.8;font-size:13px">';
            h += '<p><b>成长轨迹</b>：' + App.escapeHtml(j.trajectory || '') + '</p>';
            if (j.keyChanges) h += '<p><b>关键变化</b>：<br>' + j.keyChanges.map(function (c) { return '· ' + App.escapeHtml(c); }).join('<br>') + '</p>';
            if (j.insights) h += '<p><b>AI 洞察</b>：<br>' + j.insights.map(function (c) { return '· ' + App.escapeHtml(c); }).join('<br>') + '</p>';
            if (j.recommendations) h += '<p><b>后续建议</b>：<br>' + j.recommendations.map(function (c) { return '· ' + App.escapeHtml(c); }).join('<br>') + '</p>';
            h += '</div>';
            if (out) out.innerHTML = h;
          } catch (e) { if (out) out.innerHTML = '<pre>' + App.escapeHtml(res.content) + '</pre>'; }
        } else { if (out) out.innerHTML = '<span style="color:var(--danger)">AI 分析失败</span>'; }
      });
    };

    box.innerHTML = html;
  }

  window.openDoc = function (type, id) {
    if (type === 'transcript' || type === 'report') {
      location.href = 'consult-notes.html?session=' + id;
    } else if (type === 'supervision') {
      location.href = 'real-supervision.html?id=' + id;
    }
  };

  renderClientList();
})();