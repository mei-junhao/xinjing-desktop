/* 心镜 v3.1.0 — 真人督导（方案D：全屏+侧拉历史 + 会员E方案） */
(function () {
  'use strict';
  var currentClientId = null;
  var records = [];
  var currentRecordId = null;
  var materialId = '';
  var uploadJob = { file: null, reader: null, token: 0, state: 'idle' };

  function uploadStateUi(state, label, percent) {
    uploadJob.state = state;
    var box = document.getElementById('rs-upload-state');
    var cancel = document.getElementById('rs-upload-cancel');
    var retry = document.getElementById('rs-upload-retry');
    var input = document.getElementById('rs-transcript-file');
    if (!box) return;
    box.dataset.state = state;
    box.setAttribute('aria-busy', state === 'uploading' ? 'true' : 'false');
    var text = box.querySelector('.rs-upload-label'); if (text) text.textContent = label || '未选择材料';
    var pct = Math.max(0, Math.min(100, Number(percent) || 0));
    var bar = box.querySelector('.rs-upload-progress span'); if (bar) bar.style.width = pct + '%';
    var p = box.querySelector('.rs-upload-percent'); if (p) p.textContent = pct + '%';
    if (cancel) cancel.hidden = state !== 'uploading';
    if (retry) retry.hidden = state !== 'failure';
    if (input) input.disabled = state === 'uploading';
  }

  function readFileWithProgress(file, token, asArrayBuffer) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      uploadJob.reader = reader;
      reader.onprogress = function (event) {
        if (token !== uploadJob.token || !event.lengthComputable) return;
        uploadStateUi('uploading', '正在读取 ' + file.name, Math.round(event.loaded / event.total * 80));
      };
      reader.onload = function (event) { if (token === uploadJob.token) resolve(event.target.result); };
      reader.onerror = function () { reject(new Error('文件读取失败')); };
      reader.onabort = function () { var error = new Error('已取消上传'); error.code = 'ABORTED'; reject(error); };
      if (asArrayBuffer) reader.readAsArrayBuffer(file); else reader.readAsText(file, 'UTF-8');
    });
  }

  async function processTranscriptUpload(file) {
    uploadJob.file = file;
    var token = ++uploadJob.token;
    uploadStateUi('uploading', '正在读取 ' + file.name, 0);
    try {
      var value;
      if (/\.docx$/i.test(file.name)) {
        if (typeof mammoth === 'undefined' || typeof mammoth.extractRawText !== 'function') throw new Error('DOCX 解析库未加载');
        var arrayBuffer = await readFileWithProgress(file, token, true);
        if (token !== uploadJob.token) return;
        uploadStateUi('uploading', '正在解析 ' + file.name, 88);
        var result = await mammoth.extractRawText({ arrayBuffer: arrayBuffer });
        value = result && result.value;
      } else {
        value = await readFileWithProgress(file, token, false);
      }
      if (token !== uploadJob.token) return;
      if (!String(value || '').trim()) throw new Error('文件内容为空');
      document.getElementById('rs-transcript-text').value = String(value);
      uploadStateUi('success', '材料已读取，可继续保存或分析', 100);
      App.showToast('已加载文件', 'success');
    } catch (error) {
      if (token !== uploadJob.token) return;
      if (error && error.code === 'ABORTED') { uploadStateUi('cancel', '已取消上传，可重新选择材料', 0); return; }
      uploadStateUi('failure', '读取失败：' + (error && error.message ? error.message : '未知错误') + '，可重试', 0);
      App.showToast('材料读取失败：' + (error && error.message ? error.message : '请重试'), 'error');
    } finally {
      if (token === uploadJob.token) uploadJob.reader = null;
    }
  }

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
    if (materialId && Store.reconcileMaterialContext) Store.reconcileMaterialContext(materialId, currentClientId, null, {});
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

  window.saveRecord = async function () {
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
      var updated = await Store.updateSupervisionDurable(currentRecordId, data);
      if (!updated || !updated.ok) { App.showToast('记录更新失败：草稿已保留，请恢复存储后重试', 'error'); return; }
      if (materialId && Store.updateMaterialWorkspace) Store.updateMaterialWorkspace(materialId, { workflow: { realSupervision: 'completed' }, artifacts: { realSupervisionId: currentRecordId } });
      App.showToast('记录已更新', 'success');
    } else {
      var createdResult = await Store.createSupervisionDurable(data);
      if (!createdResult || !createdResult.ok) { App.showToast('记录保存失败：草稿已保留，请恢复存储后重试', 'error'); return; }
      var created = createdResult.value;
      if (created && materialId && Store.updateMaterialWorkspace) Store.updateMaterialWorkspace(materialId, { workflow: { realSupervision: 'completed' }, artifacts: { realSupervisionId: created.id } });
      App.showToast('记录已保存', 'success');
      if (typeof Memory !== 'undefined' && Memory.record) Memory.record('supervision_done', { summary: '保存了真人督导记录', relatedClientId: currentClientId });
    }
    loadRecords();
    loadClientRecords();
  };

  window.saveTranscriptOnly = async function () {
    if (!currentClientId) { App.showToast('请先选择来访者', 'warning'); return; }
    var text = document.getElementById('rs-transcript-text').value.trim();
    if (!text) { App.showToast('请先粘贴逐字稿', 'warning'); return; }
    if (currentRecordId) {
      var updated = await Store.updateSupervisionDurable(currentRecordId, { transcript: text });
      if (!updated || !updated.ok) { App.showToast('逐字稿保存失败：草稿已保留，请恢复存储后重试', 'error'); return; }
    } else {
      var createResult = await Store.createSupervisionDurable({
        clientId: currentClientId,
        supervisorName: '真人督导',
        date: App.todayStr(),
        transcript: text,
        type: 'individual',
      });
      if (!createResult || !createResult.ok) { App.showToast('逐字稿保存失败：草稿已保留，请恢复存储后重试', 'error'); return; }
      currentRecordId = createResult.value.id;
    }
    loadRecords();
    loadClientRecords();
    App.showToast('逐字稿已保存', 'success');
    if (typeof Memory !== 'undefined' && Memory.record) Memory.record('supervision_done', { summary: '保存了真人督导逐字稿', relatedClientId: currentClientId });
  };

  window.uploadTranscriptFile = function (e) {
    var file = e && e.target && e.target.files ? e.target.files[0] : null;
    if (!file) { uploadStateUi('idle', '未选择材料', 0); return; }
    processTranscriptUpload(file);
  };

  function bindUploadControls() {
    var cancel = document.getElementById('rs-upload-cancel');
    var retry = document.getElementById('rs-upload-retry');
    if (cancel && !cancel.dataset.bound) {
      cancel.dataset.bound = '1';
      cancel.addEventListener('click', function () {
        if (uploadJob.reader && uploadJob.state === 'uploading') uploadJob.reader.abort();
        uploadJob.token += 1;
        uploadStateUi('cancel', '已取消上传，可重新选择材料', 0);
      });
    }
    if (retry && !retry.dataset.bound) {
      retry.dataset.bound = '1';
      retry.addEventListener('click', function () { if (uploadJob.file) processTranscriptUpload(uploadJob.file); });
    }
    uploadStateUi('idle', '未选择材料', 0);
  }

  function bindMembershipEntry() {
    var link = document.getElementById('rs-ai-link');
    if (!link || link.dataset.bound) return;
    link.dataset.bound = '1';
    link.addEventListener('click', function (event) {
      if (typeof App.openMembershipGate === 'function' && !App.openMembershipGate('ai-analyze')) event.preventDefault();
    });
  }

  window.aiAnalyzeTranscript = function () {
    if (!App.featureGate('ai-analyze')) { App.showToast('AI 分析需激活后使用' + (App.isTrial() ? '，或升级会员解锁全部功能' : ''), 'warning'); return; }
    var text = document.getElementById('rs-transcript-text').value.trim();
    if (!text) { App.showToast('请先粘贴逐字稿', 'warning'); return; }
    App.showToast('AI 分析中…', 'info');
    var sys = '你是心理咨询督导分析专家。请分析以下逐字稿，输出 JSON 格式：\n' +
      '{"clientName":"来访者姓名","keyIssues":["核心议题1","核心议题2"],"supervisorTechniques":["督导师使用的技术1","技术2"],"knowledgeSource":"对应的理论/知识来源","suggestions":["给咨询师的建议"]}\n只输出 JSON，不要其他文字。';
    var context = ClinicalContext.build('real-supervision-ai-organize', { clientId: currentClientId, materialId: materialId }, { system: sys, inputText: text, instruction: '整理真人督导材料', includeUserDocs: true });
    if (!context.ok) { App.showToast('当前上下文无效，请重新选择来访者', 'warning'); return; }
    if (ClinicalContextView) ClinicalContextView.renderSummary(document.querySelector('.rs-main') || document.body, context);
    if (ClinicalContextView && !ClinicalContextView.confirmSend(context)) { App.showToast('已取消 AI 分析', 'info'); return; }
    var run = ClinicalContext.createActionRun(context);
    if (!run) { App.showToast('无法确认材料归属，已取消分析', 'warning'); return; }
    AI.send(context.messages, function (res) {
      var currentText = document.getElementById('rs-transcript-text').value.trim();
      if (!ClinicalContext.isSnapshotCurrent(context.snapshot, currentText, { clientId: currentClientId, materialId: materialId })) { ClinicalContext.failActionRun(run.id, '上下文已变更', 'stale'); App.showToast('上下文已变更，旧分析未采用', 'warning'); return; }
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
          ClinicalContext.completeActionRun(run.id, { kind: 'real-supervision-summary', ref: materialId || currentClientId || '' });
          switchRSTab('record');
          App.showToast('AI 分析完成', 'success');
        } catch (e) {
          ClinicalContext.failActionRun(run.id, 'AI 返回格式异常'); App.showToast('AI 返回格式异常', 'error');
        }
      } else {
        ClinicalContext.failActionRun(run.id, (res && res.error) || 'AI 分析失败'); App.showToast('AI 分析失败', 'error');
      }
    }, { onDelta: function (piece, fullText) {
      var summary = document.getElementById('rs-summary');
      if (summary) summary.value = fullText || piece || '';
    } });
  };

  window.saveReport = async function () {
    if (!currentClientId) { App.showToast('请先选择来访者', 'warning'); return; }
    var title = document.getElementById('rs-report-title').value.trim() || '案例报告';
    var body = document.getElementById('rs-report-body').value.trim();
    if (!body) { App.showToast('请先填写报告内容', 'warning'); return; }
    if (currentRecordId) {
      var updated = await Store.updateSupervisionDurable(currentRecordId, { reportTitle: title, conclusion: body });
      if (!updated || !updated.ok) { App.showToast('报告保存失败：草稿已保留，请恢复存储后重试', 'error'); return; }
    } else {
      var createResult = await Store.createSupervisionDurable({
        clientId: currentClientId,
        supervisorName: '真人督导',
        date: App.todayStr(),
        reportTitle: title,
        conclusion: body,
        type: 'individual',
      });
      if (!createResult || !createResult.ok) { App.showToast('报告保存失败：草稿已保留，请恢复存储后重试', 'error'); return; }
      currentRecordId = createResult.value.id;
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
    document.querySelectorAll('.rr-tab').forEach(function (t) {
      var active = t.dataset.tab === tab;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.getElementById('rs-record-tab').style.display = tab === 'record' ? '' : 'none';
    document.getElementById('rs-transcript-tab').style.display = tab === 'transcript' ? '' : 'none';
    document.getElementById('rs-report-tab').style.display = tab === 'report' ? '' : 'none';
  };

  // 初始化
  fillClientSelect();
  function initRS() {
    fillClientSelect();
    bindUploadControls();
    bindMembershipEntry();
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
