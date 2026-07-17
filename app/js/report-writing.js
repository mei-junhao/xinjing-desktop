/* 心镜 v3.0.1 — 撰写报告（分步向导式 + AI 辅助 + 模板上传自动生成模块） */
(function () {
  'use strict';
  var currentClientId = null;
  var tplSections = null; // 模板解析出的模块（null=用默认6段）
  var currentStep = 0;
  var stepData = {}; // {0: "text", 1: "text", ...}

  // 默认 6 段
  var defaultSections = [
    { title: '来访者基本信息与转介来源', hint: '姓名、年龄、性别、职业、婚姻状况、转介渠道等……', desc: '填写来访者的基本信息。可点击"AI 填写本步"自动从数据库提取。' },
    { title: '主诉与求助原因', hint: '来访者自述的困扰、持续时间、严重程度……', desc: '描述来访者主诉的核心困扰及求助原因。' },
    { title: '个人发展史与家庭背景', hint: '童年经历、家庭关系、重要生活事件……', desc: '填写来访者的成长经历与家庭背景。' },
    { title: '心理动力学评估与个案概念化', hint: '运用所选理论取向对个案形成理解……', desc: '基于理论取向对个案进行概念化。' },
    { title: '治疗过程概述与关键转折', hint: '历次咨询的进展、关键转折……', desc: '概述治疗过程中的关键节点。' },
    { title: '后续方向与反思', hint: '下一阶段的目标、可能的挑战、咨询师的自我反思……', desc: '展望后续治疗方向并做自我反思。' },
  ];

  function getSections() { return tplSections || defaultSections; }

  function loadClients() {
    var sel = document.getElementById('rpt-client');
    var clients = Store.getClients();
    sel.innerHTML = '<option value="">选择来访者…</option>' + clients.map(function (c) {
      return '<option value="' + c.id + '">' + App.escapeHtml(c.name) + '</option>';
    }).join('');
  }

  window.loadClientSessions = function () {
    var sel = document.getElementById('rpt-client');
    currentClientId = sel.value || null;
    if (!currentClientId) { document.getElementById('sess-dd').style.display = 'none'; return; }
    // 载入来访者基本信息到第 1 步
    var c = Store.getClient(currentClientId);
    stepData[0] = App.escapeHtml(c.name) + '（化名）\n' + (c.notes || '');
    document.getElementById('sess-dd').style.display = '';
    document.getElementById('sess-menu').style.display = 'none';
    renderSessMenu();
    renderStepsNav();
    goToStep(0);
  };

  // 渲染「基于节次」下拉菜单（默认不勾选，避免占满视觉）
  window.renderSessMenu = function () {
    var list = document.getElementById('sessions-list');
    if (!list || !currentClientId) return;
    var sessions = Store.getSessionsForPicker(currentClientId).sort(function (a, b) {
      return (b.date || '').localeCompare(a.date || '');
    });
    var onlyHas = document.getElementById('sess-only-has') && document.getElementById('sess-only-has').checked;
    var filtered = sessions.filter(function (s) {
      if (!onlyHas) return true;
      return s.hasTranscript || s.hasSoap || s.hasDap || (s.notes && s.notes.trim());
    });
    // 防御：按 id 去重，避免缓存中重复会话记录导致「基于节次」出现多个重复节数
    var seenM = {};
    filtered = filtered.filter(function (s) { if (seenM[s.id]) return false; seenM[s.id] = 1; return true; });
    if (!filtered.length) {
      list.innerHTML = '<div class="sess-empty">该来访者暂无可用的逐字稿或咨询记录</div>';
      return;
    }
    list.innerHTML = filtered.map(function (s) {
      var tags = [];
      if (s.hasTranscript) tags.push('逐字稿');
      if (s.hasSoap) tags.push('SOAP');
      if (s.hasDap) tags.push('DAP');
      if (!tags.length && s.notes && s.notes.trim()) tags.push('记录');
      var tagHtml = tags.map(function (t) { return '<span class="tag">' + t + '</span>'; }).join('');
      return '<label class="sess-item"><input type="checkbox" class="sess-cb" value="' + s.id + '"> 第' + s.sessionNumber + '节 ' + (s.date || '') + tagHtml + '</label>';
    }).join('');
    updateSessBtnLabel();
  };

  window.toggleSessMenu = function () {
    var m = document.getElementById('sess-menu');
    m.style.display = m.style.display === 'none' ? '' : 'none';
  };

  window.sessSelectAll = function (checked) {
    document.querySelectorAll('#sessions-list .sess-cb').forEach(function (cb) { cb.checked = checked; });
    updateSessBtnLabel();
  };

  function updateSessBtnLabel() {
    var btn = document.querySelector('.sess-dd-btn');
    if (!btn) return;
    var cbs = document.querySelectorAll('#sessions-list .sess-cb');
    var n = Array.prototype.filter.call(cbs, function (c) { return c.checked; }).length;
    if (n > 0) { btn.classList.add('has-sel'); btn.textContent = '基于节次（' + n + '）▾'; }
    else { btn.classList.remove('has-sel'); btn.textContent = '基于节次 ▾'; }
  }

  // 上传逐字稿到报告（写入该来访者一条带 transcript 的会话，便于 AI 引用）
  window.onReportTranscriptUpload = function (event) {
    var file = event.target.files[0];
    if (!file) return;
    if (!currentClientId) { App.showToast('请先选择来访者', 'warning'); event.target.value = ''; return; }
    App.showToast('正在读取逐字稿…', 'info');
    var reader = new FileReader();
    var onText = function (text) {
      var r = Store.createSession({
        clientId: currentClientId, date: App.todayStr(), durationMinutes: 0, type: 'individual',
        recordKind: 'clinical', billing: null, transcript: text, hasTranscript: true, notes: '',
      });
      App.showToast('逐字稿已存入数据库，可在「基于节次」中勾选引用', 'success');
      renderSessMenu();
    };
    if (file.name.toLowerCase().endsWith('.docx')) {
      if (typeof mammoth !== 'undefined') {
        reader.onload = function (ev) { mammoth.extractRawText({ arrayBuffer: ev.target.result }).then(function (r) { onText(r.value); }).catch(function () { App.showToast('docx 解析失败', 'error'); }); };
        reader.readAsArrayBuffer(file);
      } else { App.showToast('docx 解析库未加载', 'warning'); }
    } else {
      reader.onload = function (ev) { onText(ev.target.result); };
      reader.readAsText(file, 'UTF-8');
    }
    event.target.value = '';
  };

  function renderStepsNav() {
    var secs = getSections();
    var nav = document.getElementById('steps-nav');
    nav.innerHTML = secs.map(function (sec, i) {
      var cls = i === currentStep ? ' active' : (stepData[i] ? ' done' : '');
      return '<div class="step' + cls + '" onclick="goToStep(' + i + ')"><span class="dot">' + (i + 1) + '</span><span class="stxt">' + App.escapeHtml(sec.title) + '</span></div>';
    }).join('');
  }

  window.goToStep = function (i) {
    var secs = getSections();
    if (i < 0 || i >= secs.length) return;
    currentStep = i;
    var sec = secs[i];
    document.getElementById('step-title').textContent = (i + 1) + '. ' + sec.title;
    document.getElementById('step-desc').textContent = sec.desc || sec.hint || '';
    // 渲染 textarea
    var body = document.getElementById('step-body');
    var val = stepData[i] || '';
    body.innerHTML = '<textarea id="step-ta" placeholder="' + App.escapeHtml(sec.hint || '请填写…') + '" oninput="onStepInput(this,' + i + ')">' + App.escapeHtml(val) + '</textarea>'
      + '<div class="ai-suggest" id="ai-suggest"><div class="label">AI 建议</div><div id="ai-suggest-content"></div><button class="accept" onclick="acceptAISuggest()">采用此段</button></div>';
    // 按钮状态
    document.getElementById('btn-prev').style.display = i > 0 ? '' : 'none';
    document.getElementById('btn-ai-step').style.display = currentClientId ? '' : 'none';
    document.getElementById('step-info').textContent = '步骤 ' + (i + 1) + '/' + secs.length;
    refreshFoot();
    renderStepsNav();
  };

  // textarea 输入：同步 stepData，并在最后一步实时刷新「完成/保存」按钮
  window.onStepInput = function (ta, i) {
    stepData[i] = ta.value;
    if (i === getSections().length - 1) refreshFoot();
  };

  // 根据「是否为最后一步 + 是否全部填写」决定底栏按钮
  function refreshFoot() {
    var secs = getSections();
    var isLast = currentStep === secs.length - 1;
    var allFilled = secs.every(function (sec, idx) { return (stepData[idx] || '').trim(); });
    var nextBtn = document.getElementById('btn-next');
    var actions = document.getElementById('btn-report-actions');
    if (isLast && allFilled) {
      nextBtn.style.display = 'none';
      actions.style.display = '';
    } else {
      nextBtn.style.display = '';
      nextBtn.textContent = isLast ? '完成' : '下一步 →';
      actions.style.display = 'none';
    }
  }

  window.prevStep = function () { if (currentStep > 0) goToStep(currentStep - 1); };
  window.nextStep = function () {
    var secs = getSections();
    if (currentStep < secs.length - 1) { goToStep(currentStep + 1); }
    else {
      var html = '<div style="text-align:center;padding:10px 0;line-height:2">' +
        '<div style="font-size:36px;margin-bottom:10px">✅</div>' +
        '<div style="font-size:15px;font-weight:600;margin-bottom:6px">报告已完成</div>' +
        '<div style="font-size:12px;color:var(--ink-3);margin-bottom:16px">你可以保存为 Word 文档，也可以带着报告去 AI 督导深化分析</div>' +
        '<div style="display:flex;gap:10px;justify-content:center">' +
        '<button onclick="onSaveReport();App.closeDialog()" style="border:1px solid var(--border);background:var(--paper-2,#fff);border-radius:8px;padding:10px 20px;cursor:pointer;font:13px var(--sans)">💾 保存 Word</button>' +
        '<button onclick="onStartSupervision()" style="background:var(--accent);color:#fff;border:none;border-radius:8px;padding:10px 20px;cursor:pointer;font:600 13px var(--sans)">🧠 开始 AI 督导</button>' +
        '</div></div>';
      App.confirmDialog(html, function () {});
    }
  };

  // 保存当前 textarea 值
  window.stepData = stepData;

  // AI 填写当前步骤
  window.aiFillCurrent = function () {
    if (!App.featureGate('ai-report')) { App.showToast('AI 填充需激活后使用' + (App.isTrial() ? '，或升级会员解锁全部功能' : ''), 'warning'); return; }
    if (!currentClientId) { App.showToast('请先选择来访者', 'warning'); return; }
    var secs = getSections();
    var sec = secs[currentStep];
    var ta = document.getElementById('step-ta');
    if (ta) ta.value = '生成中…';
    // 收集选中节次（来自「基于节次」下拉菜单）
    var checked = document.querySelectorAll('#sessions-list .sess-cb:checked');
    var sessionIds = Array.prototype.map.call(checked, function (c) { return c.value; });
    var sessionData = sessionIds.map(function (sid) {
      var s = Store.getSession(sid);
      if (!s) return '';
      var parts = ['第' + s.sessionNumber + '节 (' + s.date + ')'];
      if (s.transcript) parts.push('逐字稿: ' + s.transcript.slice(0, 800));
      if (s.soap) parts.push('SOAP: S=' + (s.soap.subjective||'').slice(0,300) + ' O=' + (s.soap.objective||'').slice(0,300) + ' A=' + (s.soap.assessment||'').slice(0,300) + ' P=' + (s.soap.plan||'').slice(0,300));
      if (s.notes) parts.push('备注: ' + s.notes.slice(0, 400));
      return parts.join('\n');
    }).join('\n\n');
    var c = Store.getClient(currentClientId);
    var clientInfo = c.name + '（化名），' + (c.notes || '');
    var sys = '你是案例报告撰写助手。请依据所提供的逐字稿真实文字撰写报告模块"' + sec.title + '"。要求：①分析必须结合逐字稿中的真实表述，所有内容须有逐字稿依据；②逐字稿中未出现的内容不要凭空撰写；③本界面仅做基于事实的整理，不涉及理论知识阐释。用中文、客观、具体地回应。';
    var userContent = '来访者：' + clientInfo + '\n\n咨询记录：\n' + sessionData + '\n\n请填写模块"' + sec.title + '"的内容。';
    var msgs = [{ role: 'system', content: sys }, { role: 'user', content: userContent }];
    if (typeof AI !== 'undefined' && AI.send) {
      AI.send(msgs, function (res) {
        if (ta) ta.value = '';
        if (res && res.content) {
          var sug = document.getElementById('ai-suggest');
          var sugContent = document.getElementById('ai-suggest-content');
          if (sug && sugContent) { sugContent.textContent = res.content; sug.classList.add('show'); }
        } else {
          App.showToast('生成失败，请重试', 'error');
        }
      });
    } else {
      if (ta) ta.value = '';
      App.showToast('AI 模块未就绪', 'error');
    }
  };

  window.acceptAISuggest = function () {
    var sugContent = document.getElementById('ai-suggest-content');
    var ta = document.getElementById('step-ta');
    if (sugContent && ta) {
      ta.value = sugContent.textContent;
      stepData[currentStep] = ta.value;
    }
    var sug = document.getElementById('ai-suggest');
    if (sug) sug.classList.remove('show');
  };

  // AI 填写全部
  window.aiFillAll = function () {
    if (!App.featureGate('ai-report')) { App.showToast('AI 填充需激活后使用' + (App.isTrial() ? '，或升级会员解锁全部功能' : ''), 'warning'); return; }
    if (!currentClientId) { App.showToast('请先选择来访者', 'warning'); return; }
    var secs = getSections();
    secs.forEach(function (sec, i) { goToStep(i); window.aiFillCurrent(); });
  };

  // 上传模板
  window.onTemplateUpload = function (event) {
    var file = event.target.files[0];
    if (!file) return;
    App.showToast('正在分析模板…', 'info');
    var reader = new FileReader();
    reader.onload = function () {
      var content = reader.result;
      if (file.name.endsWith('.docx') && typeof mammoth !== 'undefined') {
        mammoth.extractRawText({ arrayBuffer: content }).then(function (r) {
          analyzeTemplate(r.value, file.name);
        }).catch(function () { App.showToast('docx 解析失败，请用 .txt 或 .md', 'error'); });
      } else {
        analyzeTemplate(content, file.name);
      }
    };
    if (file.name.endsWith('.docx')) reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
  };

  function analyzeTemplate(text, filename) {
    if (!text || !text.trim()) { App.showToast('模板内容为空', 'error'); return; }
    if (App.aiUnlocked() && typeof AI !== 'undefined' && AI.send) {
      var sys = '你是案例报告模板分析助手。用户将上传一份案例报告模板，请分析其结构，提取出所有需要填写的模块标题和简要说明。以 JSON 数组格式输出，每个元素包含 title、hint、desc 三个字段。只输出 JSON。';
      AI.send([{ role: 'system', content: sys }, { role: 'user', content: '模板内容：\n' + text.slice(0, 3000) }], function (res) {
        if (res && res.content) {
          try {
            var jsonMatch = res.content.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              tplSections = JSON.parse(jsonMatch[0]);
              App.showToast('模板分析完成，已生成 ' + tplSections.length + ' 个模块', 'success');
              currentStep = 0; stepData = {};
              renderStepsNav(); goToStep(0);
              return;
            }
          } catch (e) {}
        }
        autoParseSections(text, filename);
      });
    } else {
      autoParseSections(text, filename);
    }
  }

  function autoParseSections(text, filename) {
    var lines = text.split('\n');
    var sections = [];
    lines.forEach(function (line) {
      var m = line.match(/^[#＃\s]*[\d一二三四五六七八九十]+[.、．\s]+(.+)/);
      if (m && m[1].trim()) sections.push({ title: m[1].trim(), hint: '根据模板要求填写', desc: m[1].trim() });
    });
    if (!sections.length) {
      var paras = text.split(/\n\s*\n/).filter(function (p) { return p.trim().length > 5; });
      paras.slice(0, 10).forEach(function (p, i) {
        sections.push({ title: '段落 ' + (i + 1), hint: p.trim().slice(0, 80), desc: '段落 ' + (i + 1) });
      });
    }
    tplSections = sections;
    App.showToast('已从模板提取 ' + sections.length + ' 个模块', 'success');
    currentStep = 0; stepData = {};
    renderStepsNav(); goToStep(0);
  }

  // 导出 Word（真 .doc）
  window.exportWord = function () {
    var secs = getSections();
    var body = '<h1>案例报告</h1>';
    var client = currentClientId ? Store.getClient(currentClientId) : null;
    if (client) body += '<p><strong>来访者：</strong>' + App.escapeHtml(client.name) + '（化名）</p>';
    secs.forEach(function (sec, i) {
      var val = stepData[i] || '';
      if (val.trim()) {
        body += '<h2>' + (i + 1) + '. ' + App.escapeHtml(sec.title) + '</h2>';
        body += '<p>' + App.escapeHtml(val).replace(/\n/g, '<br>') + '</p>';
      }
    });
    var fname = (client ? client.name : 'report') + '_案例报告.doc';
    App.exportWordDoc(fname, body);
    return fname;
  };

  // 保存：弹出保存对话框，写到用户选择的真实路径并如实告知
  window.onSaveReport = function () {
    var secs = getSections();
    var body = '<h1>案例报告</h1>';
    var client = currentClientId ? Store.getClient(currentClientId) : null;
    if (client) body += '<p><strong>来访者：</strong>' + App.escapeHtml(client.name) + '（化名）</p>';
    secs.forEach(function (sec, i) {
      var val = stepData[i] || '';
      if (val.trim()) {
        body += '<h2>' + (i + 1) + '. ' + App.escapeHtml(sec.title) + '</h2>';
        body += '<p>' + App.escapeHtml(val).replace(/\n/g, '<br>') + '</p>';
      }
    });
    var fname = (client ? client.name : 'report') + '_案例报告.doc';
    App.saveReportFile(fname, body).then(function (r) {
      if (!r) { App.showToast('保存失败', 'error'); return; }
      if (r.canceled) { App.showToast('已取消保存', 'info'); return; }
      if (r.error) { App.showToast('保存失败：' + r.error, 'error'); return; }
      App.showToast('报告已保存：' + r.path, 'success');
    });
  };

  // 开始 AI 督导：先保存 Word，再携带报告跳转督导页
  window.onStartSupervision = function () {
    exportWord();
    // 暂存报告纯文本，供督导页预填材料区
    try {
      var secs = getSections();
      var reportText = '【案例报告】\n';
      var client = currentClientId ? Store.getClient(currentClientId) : null;
      if (client) reportText += '来访者：' + client.name + '（化名）\n\n';
      secs.forEach(function (sec, i) {
        var val = stepData[i] || '';
        reportText += (i + 1) + '. ' + sec.title + '\n' + val + '\n\n';
      });
      if (currentClientId) localStorage.setItem('xj_report_draft_' + currentClientId, reportText);
    } catch (e) {}
    location.href = 'supervision.html?client=' + encodeURIComponent(currentClientId || '') + '&autoloadreport=1';
  };

  App.initPage({ title: '撰写报告', subtitle: '', actions: '', onReady: function () {
    loadClients();
    // 点击外部关闭「基于节次」下拉菜单
    document.addEventListener('click', function (e) {
      var dd = document.getElementById('sess-dd');
      var menu = document.getElementById('sess-menu');
      if (!dd || !menu || menu.style.display === 'none') return;
      if (!dd.contains(e.target)) menu.style.display = 'none';
    });
  }});
})();
