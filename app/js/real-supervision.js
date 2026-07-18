/* 心镜 v3.1.0 — 真人督导（方案D：全屏+侧拉历史 + 会员E方案） */
(function () {
  'use strict';
  var currentClientId = null;
  var records = [];
  var currentRecordId = null;
  var materialId = '';

  function currentMaterialWorkspace() { return materialId && Store.getMaterialWorkspace ? Store.getMaterialWorkspace(materialId) : null; }
  function showMaterialSource(material) {
    var host = document.querySelector('.rs-main') || document.querySelector('.rs-page') || document.body;
    if (!host || !material || document.getElementById('rs-material-source')) return;
    var source = document.createElement('div');
    source.id = 'rs-material-source'; source.style.cssText = 'margin:8px 0;padding:8px 10px;border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:6px;font-size:12px;color:var(--ink-2)';
    source.textContent = '材料来源：' + (material.source.name || material.title) + (material.clientId ? ' · 已关联来访者' : ' · 未归档，保存前请选择来访者');
    host.insertBefore(source, host.firstChild);
  }

  // 来访者列表（Store 就绪后再填充，并支持深链 ?clientId / ?client 自动关联）
  var selClient = document.getElementById('rs-client');
  function fillClientSelect() {
    if (!selClient) return;
    var keep = selClient.value;
    selClient.innerHTML = '<option value="">选择来访者…</option>';
    Store.getClients().forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c.id; opt.textContent = c.name;
      selClient.appendChild(opt);
    });
    if (keep) selClient.value = keep;
  }

  function loadRecords() {
    try { records = Store.getSupervisions() || []; } catch (e) { records = []; }
  }

  window.loadClientRecords = function () {
    currentClientId = selClient.value || null;
    if (!currentClientId) { renderHistory([]); return; }
    if (App.setActiveClientId) App.setActiveClientId(currentClientId);
    if (materialId && Store.linkMaterialWorkspace) Store.linkMaterialWorkspace(materialId, currentClientId, '');
    var clientRecords = records.filter(function (r) { return r.clientId === currentClientId; })
      .sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
    renderHistory(clientRecords);
  };

  function renderHistory(list) {
    var box = document.getElementById('rs-history');
    if (!list || !list.length) {
      box.innerHTML = '<div style="padding:24px;text-align:center;color:var(--ink-3);font-size:12px">暂无记录，点击"新记录"开始</div>';
      return;
    }
    box.innerHTML = list.map(function (r) {
      var preview = (r.content || r.summary || '').slice(0, 60);
      var tags = '';
      if (r.type === 'individual') tags += '<span class="tag">督导</span>';
      if (r.conclusion) tags += '<span class="tag">报告</span>';
      return '<div class="rl-item' + (r.id === currentRecordId ? ' active' : '') + '" onclick="openRecord(\'' + r.id + '\')">' +
        '<div class="r-name">' + App.escapeHtml(r.supervisorName || '真人督导') + '</div>' +
        '<div class="r-date">' + App.formatDate(r.date) + '</div>' +
        (preview ? '<div class="r-preview">' + App.escapeHtml(preview) + '…</div>' : '') +
        '<div class="r-tags">' + tags + '</div></div>';
    }).join('');
  }

  window.openRecord = function (id) {
    var r = records.find(function (x) { return x.id === id; });
    if (!r) return;
    currentRecordId = id;
    document.getElementById('rs-supervisor').value = r.supervisorName || '';
    document.getElementById('rs-date').value = r.date || '';
    document.getElementById('rs-topic').value = r.topic || '';
    document.getElementById('rs-summary').value = r.summary || r.content || '';
    document.getElementById('rs-techniques').value = r.techniques || '';
    document.getElementById('rs-reflection').value = r.reflection || '';
    document.getElementById('rs-transcript-text').value = r.transcript || '';
    document.getElementById('rs-report-title').value = (r.reportTitle || '');
    document.getElementById('rs-report-body').value = (r.conclusion || '');
    loadClientRecords();
    App.showToast('已加载记录', 'success');
  };

  window.startNewRecord = function () {
    currentRecordId = null;
    clearForm();
    if (currentClientId) {
      var d = new Date();
      document.getElementById('rs-date').value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    switchRSTab('record');
  };

  window.clearForm = function () {
    ['rs-supervisor', 'rs-date', 'rs-topic', 'rs-summary', 'rs-techniques', 'rs-reflection', 'rs-transcript-text', 'rs-report-title', 'rs-report-body'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.value = '';
    });
  };

  window.saveRecord = function () {
    if (!currentClientId) { App.showToast('请先选择来访者', 'warning'); return; }
    var data = {
      clientId: currentClientId,
      supervisorName: document.getElementById('rs-supervisor').value.trim() || '真人督导',
      date: document.getElementById('rs-date').value || App.todayStr(),
      topic: document.getElementById('rs-topic').value.trim(),
      content: document.getElementById('rs-summary').value.trim(),
      techniques: document.getElementById('rs-techniques').value.trim(),
      reflection: document.getElementById('rs-reflection').value.trim(),
      type: 'individual',
    };
    if (currentRecordId) {
      Store.updateSupervision(currentRecordId, data);
      if (materialId && Store.updateMaterialWorkspace) Store.updateMaterialWorkspace(materialId, { workflow: { realSupervision: 'completed' }, artifacts: { realSupervisionId: currentRecordId } });
      App.showToast('记录已更新', 'success');
    } else {
      var created = Store.createSupervision(data);
      if (created && materialId && Store.updateMaterialWorkspace) Store.updateMaterialWorkspace(materialId, { workflow: { realSupervision: 'completed' }, artifacts: { realSupervisionId: created.id } });
      App.showToast('记录已保存', 'success');
      if (typeof Memory !== 'undefined' && Memory.record) Memory.record('supervision_done', { summary: '保存了真人督导记录', relatedClientId: currentClientId });
    }
    loadRecords();
    loadClientRecords();
  };

  window.saveTranscriptOnly = function () {
    if (!currentClientId) { App.showToast('请先选择来访者', 'warning'); return; }
    var text = document.getElementById('rs-transcript-text').value.trim();
    if (!text) { App.showToast('请先粘贴逐字稿', 'warning'); return; }
    if (currentRecordId) {
      Store.updateSupervision(currentRecordId, { transcript: text });
    } else {
      var r = Store.createSupervision({
        clientId: currentClientId,
        supervisorName: '真人督导',
        date: App.todayStr(),
        transcript: text,
        type: 'individual',
      });
      if (r) currentRecordId = r.id;
    }
    loadRecords();
    loadClientRecords();
    App.showToast('逐字稿已保存', 'success');
    if (typeof Memory !== 'undefined' && Memory.record) Memory.record('supervision_done', { summary: '保存了真人督导逐字稿', relatedClientId: currentClientId });
  };

  window.uploadTranscriptFile = function (e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (ev) {
      document.getElementById('rs-transcript-text').value = ev.target.result;
      App.showToast('已加载文件', 'success');
    };
    if (file.name.endsWith('.docx')) {
      // 需要 mammoth 库
      if (typeof mammoth !== 'undefined') {
        reader.readAsArrayBuffer(file);
        reader.onload = function (ev) {
          mammoth.extractRawText({ arrayBuffer: ev.target.result }).then(function (result) {
            document.getElementById('rs-transcript-text').value = result.value;
          });
        };
      } else {
        App.showToast('docx 解析库未加载，请手动粘贴', 'warning');
      }
    } else {
      reader.readAsText(file, 'UTF-8');
    }
  };

  window.aiAnalyzeTranscript = function () {
    if (!App.featureGate('ai-analyze')) { App.showToast('AI 分析需激活后使用' + (App.isTrial() ? '，或升级会员解锁全部功能' : ''), 'warning'); return; }
    var text = document.getElementById('rs-transcript-text').value.trim();
    if (!text) { App.showToast('请先粘贴逐字稿', 'warning'); return; }
    App.showToast('AI 分析中…', 'info');
    var sys = '你是心理咨询督导分析专家。请分析以下逐字稿，输出 JSON 格式：\n' +
      '{"clientName":"来访者姓名","keyIssues":["核心议题1","核心议题2"],"supervisorTechniques":["督导师使用的技术1","技术2"],"knowledgeSource":"对应的理论/知识来源","suggestions":["给咨询师的建议"]}\n只输出 JSON，不要其他文字。';
    // v3.5.0：被动注入用户自建资料库（仅本机读取，零出网）
    var ud = (typeof window !== 'undefined' && window.UserDocs && window.UserDocs.getContextBlock) ? window.UserDocs.getContextBlock() : '';
    if (ud) sys += '\n\n' + ud;
    AI.send([{ role: 'system', content: sys }, { role: 'user', content: text }], function (res) {
      if (res && res.content && !res.error) {
        try {
          var json = JSON.parse(res.content.replace(/^```json\s*/i, '').replace(/```\s*$/i, ''));
          var summary = '【AI 分析结果】\n\n';
          summary += '来访者：' + (json.clientName || '未识别') + '\n';
          summary += '\n核心议题：\n' + (json.keyIssues || []).map(function (s) { return '· ' + s; }).join('\n');
          summary += '\n\n督导师技术：\n' + (json.supervisorTechniques || []).map(function (s) { return '· ' + s; }).join('\n');
          summary += '\n\n知识来源：' + (json.knowledgeSource || '未识别');
          summary += '\n\n建议：\n' + (json.suggestions || []).map(function (s) { return '· ' + s; }).join('\n');
          document.getElementById('rs-summary').value = summary;
          switchRSTab('record');
          App.showToast('AI 分析完成', 'success');
        } catch (e) {
          App.showToast('AI 返回格式异常', 'error');
        }
      } else {
        App.showToast('AI 分析失败', 'error');
      }
    });
  };

  window.saveReport = function () {
    if (!currentClientId) { App.showToast('请先选择来访者', 'warning'); return; }
    var title = document.getElementById('rs-report-title').value.trim() || '案例报告';
    var body = document.getElementById('rs-report-body').value.trim();
    if (!body) { App.showToast('请先填写报告内容', 'warning'); return; }
    if (currentRecordId) {
      Store.updateSupervision(currentRecordId, { reportTitle: title, conclusion: body });
    } else {
      var r = Store.createSupervision({
        clientId: currentClientId,
        supervisorName: '真人督导',
        date: App.todayStr(),
        reportTitle: title,
        conclusion: body,
        type: 'individual',
      });
      if (r) currentRecordId = r.id;
    }
    loadRecords();
    loadClientRecords();
    App.showToast('案例报告已保存', 'success');
    if (typeof Memory !== 'undefined' && Memory.record) Memory.record('supervision_done', { summary: '保存了真人督导案例报告', relatedClientId: currentClientId });
  };

  window.exportReport = function () {
    var body = document.getElementById('rs-report-body').value.trim();
    if (!body) { App.showToast('无内容可导出', 'warning'); return; }
    App.exportWordDoc('案例报告_' + App.todayStr() + '.doc', App.mdToWordHtml(body));
    App.showToast('已导出 Word 文档', 'success');
  };

  window.switchRSTab = function (tab) {
    document.querySelectorAll('.rr-tab').forEach(function (t) { t.classList.toggle('active', t.dataset.tab === tab); });
    document.getElementById('rs-record-tab').style.display = tab === 'record' ? '' : 'none';
    document.getElementById('rs-transcript-tab').style.display = tab === 'transcript' ? '' : 'none';
    document.getElementById('rs-report-tab').style.display = tab === 'report' ? '' : 'none';
  };

  // 初始化
  fillClientSelect();
  function initRS() {
    fillClientSelect();
    loadRecords();
    var params = new URLSearchParams(location.search);
    var cid = params.get('clientId') || params.get('client') || (App.getActiveClientId && App.getActiveClientId());
    materialId = params.get('materialId') || '';
    var material = currentMaterialWorkspace();
    if (material && material.parseStatus === 'ready') {
      if (material.clientId) cid = material.clientId;
      var transcript = document.getElementById('rs-transcript-text');
      if (transcript) transcript.value = material.extractedText || '';
      Store.updateMaterialWorkspace(materialId, { workflow: { realSupervision: 'in-progress' } });
      showMaterialSource(material);
    }
    if (cid && Store.getClient(cid)) {
      selClient.value = cid;
      currentClientId = cid;
      if (App.setActiveClientId) App.setActiveClientId(currentClientId);
      loadClientRecords();
      App.showToast('已自动关联来访者：' + (Store.getClient(cid).name || ''), 'success');
    }
  }
  if (window.Store && typeof Store.hydrate === 'function') {
    Store.hydrate().then(initRS).catch(initRS);
  } else {
    initRS();
  }
})();
