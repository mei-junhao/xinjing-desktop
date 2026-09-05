/* 心镜 v3.1.0 — AI 督导（方案C：三栏研究台 + 历史 + 会员分层） */
App.initPage({
  title: 'AI 督导',
  onReady: function () {
    'use strict';
    var chat = document.getElementById('sup-chat');
    var input = document.getElementById('sup-input');
    var materialTA = document.getElementById('sup-material');
    var curOrient = 'cangjie';
    var curOrientName = '仓颉版温尼科特督导师';
    var messages = [];
    var busy = false;
    var currentClientId = null;
    var currentSessionId = '';
    var materialId = '';
    var latestSupervision = null;
    var draftKey = 'xj_sup_v31_draft';
    var chatKey = 'xj_sup_v31_chat';
    var packageInspection = null;
    var installedPackage = null;
    var uploadState = 'idle';
    var uploadStateHistory = ['idle'];
    var uploadPendingFile = null;
    var uploadOperation = null;
    var uploadSequence = 0;
    var uploadLastFileName = '';
    var lastFailedRequest = null;
    var activeSupervisionController = null;

    // XJ519-Z4：AI 督导生成链路不得同步阻塞 renderer。
    // 原 ClinicalContextView.confirmSend 使用 window.confirm——原生模态会冻结渲染主线程
    // （审计观测：Runtime.evaluate 超时、CPU 0、无 CDP 可见对话框）。改为 DOM 确认（异步可交互）。
    function confirmContextSendAsync(context) {
      return new Promise(function (resolve) {
        if (!context || !context.ok) { resolve(false); return; }
        if (typeof App === 'undefined' || typeof App.confirmDialog !== 'function') {
          App.showToast('确认组件未就绪，本次发送已阻止', 'error');
          resolve(false);
          return;
        }
        var lines = (context.sources || []).map(function (source, index) {
          var label = (source && source.label) || ('来源' + (index + 1));
          var chars = source && source.chars != null ? '（约 ' + source.chars + ' 字）' : '';
          return '· ' + label + (source && source.truncated ? '（已截断）' : '') + chars;
        });
        var message = '将发送以下上下文（约 ' + (context.estimatedChars || 0) + ' 字）：\n' + (lines.join('\n') || '仅本轮指令');
        var settled = false;
        var overlay = App.confirmDialog(message, function () {
          if (!settled) { settled = true; resolve(true); }
          return true;
        });
        if (overlay && typeof overlay.querySelector === 'function') {
          var cancel = overlay.querySelector('[data-modal-cancel]');
          if (cancel) cancel.addEventListener('click', function () {
            if (!settled) { settled = true; resolve(false); }
          }, { once: true });
        }
      });
    }

    function setPackageState(state, label, detail) {
      var status = document.getElementById('sup-package-status');
      var copy = document.getElementById('sup-package-detail');
      if (status) { status.dataset.state = state || 'locked'; status.textContent = label || '未安装'; }
      if (copy) copy.textContent = detail || '';
    }

    function packageDescription(descriptor) {
      if (!descriptor) return '';
      var provider = descriptor.providerPolicy && descriptor.providerPolicy.mode === 'local-only' ? '本机处理' : '受信服务';
      return String(descriptor.displayName || '受控督导包') + ' · v' + String(descriptor.packageVersion || '') + ' · ' + provider;
    }

    function updatePackageButtons() {
      var install = document.getElementById('sup-package-install');
      var run = document.getElementById('sup-package-run');
      var remove = document.getElementById('sup-package-remove');
      var allowed = typeof App !== 'undefined' && App.featureGate && App.featureGate('custom-supervisors');
      if (install) install.disabled = !packageInspection || !packageInspection.inspectionToken;
      if (run) run.disabled = !installedPackage || !allowed;
      if (remove) remove.disabled = !installedPackage;
    }

    function showInstalledPackage(result) {
      var list = result && result.ok && Array.isArray(result.packages) ? result.packages : [];
      installedPackage = list.length ? list[0] : null;
      if (!installedPackage) {
        setPackageState('locked', '未安装', '仅接受作者签发的加密 .xjsup 文件；检查、授权和解密均在本机主进程完成。');
      } else if (installedPackage.status === 'locked') {
        setPackageState('locked', '已安装 · 已锁定', packageDescription(installedPackage) + ' · ' + (installedPackage.reason || '需要旗舰授权'));
      } else {
        setPackageState('installed', '已安装 · 可运行', packageDescription(installedPackage));
      }
      updatePackageButtons();
    }

    function bindControlledPackage() {
      var fileInput = document.getElementById('sup-package-file');
      var importButton = document.getElementById('sup-package-import');
      var installButton = document.getElementById('sup-package-install');
      var runButton = document.getElementById('sup-package-run');
      var removeButton = document.getElementById('sup-package-remove');
      if (!fileInput || !importButton || !window.SupervisionPackage) return;
      importButton.addEventListener('click', function () { fileInput.click(); });
      fileInput.addEventListener('change', function () {
        var file = fileInput.files && fileInput.files[0];
        fileInput.value = '';
        if (!file) return;
        setPackageState('loading', '检查中', '正在验证文件格式、作者签名和密文完整性……');
        window.SupervisionPackage.inspectFile(file).then(function (result) {
          if (!result || !result.ok) {
            packageInspection = null;
            setPackageState('locked', '检查未通过', (result && result.message) || '技能包不可用');
            updatePackageButtons();
            return;
          }
          packageInspection = result;
          setPackageState('available', '已检查 · 等待确认', packageDescription(result.descriptor) + ' · 请确认后再安装');
          updatePackageButtons();
        });
      });
      if (installButton) installButton.addEventListener('click', function () {
        if (!packageInspection) return;
        if (!App.featureGate('custom-supervisors')) {
          setPackageState('locked', '已检查 · 需要旗舰', '技能包预览可用，但安装和运行需要旗舰版授权。');
          updatePackageButtons();
          return;
        }
        setPackageState('loading', '安装中', '正在重新验权并保存加密密文……');
        window.SupervisionPackage.installInspection(packageInspection).then(function (result) {
          if (!result || !result.ok) {
            setPackageState('locked', '安装未通过', (result && result.message) || '技能包未安装');
            updatePackageButtons();
            return;
          }
          packageInspection = null;
          installedPackage = result.descriptor;
          setPackageState('installed', '已安装 · 可运行', packageDescription(installedPackage));
          updatePackageButtons();
          App.showToast('受控督导包已安装；运行时仍会再次检查授权和撤销状态', 'success');
        });
      });
      if (runButton) runButton.addEventListener('click', function () {
        if (!installedPackage) return;
        setPackageState('loading', '授权中', '正在主进程内校验设备绑定、撤销状态和版本高水位……');
        window.SupervisionPackage.run(installedPackage.packageId, installedPackage.packageVersion).then(function (result) {
          if (!result || !result.ok) {
            setPackageState('locked', '运行已锁定', (result && result.message) || '技能包暂不可运行');
            updatePackageButtons();
            return;
          }
          installedPackage = result.descriptor || installedPackage;
          setPackageState('installed', '已授权 · 本机处理', '本次督导方法已在主进程内解密并使用，Renderer 未取得包正文。');
          updatePackageButtons();
          App.showToast('受控督导包已授权运行', 'success');
        });
      });
      if (removeButton) removeButton.addEventListener('click', function () {
        if (!installedPackage || !window.confirm('移除这个受控督导包？既有督导记录不会删除。')) return;
        window.SupervisionPackage.removePackage(installedPackage.packageId, installedPackage.packageVersion).then(function (result) {
          if (!result || !result.ok) { App.showToast((result && result.message) || '移除失败', 'error'); return; }
          installedPackage = null;
          showInstalledPackage({ ok: true, packages: [] });
          App.showToast('受控督导包已移除，既有记录保留', 'success');
        });
      });
      window.SupervisionPackage.listInstalled().then(showInstalledPackage);
      if (window.__XJ_API__ && typeof window.__XJ_API__.onLicenseState === 'function') {
        window.__XJ_API__.onLicenseState(function () {
          updatePackageButtons();
          if (installedPackage) window.SupervisionPackage.getRuntimeDescriptor(installedPackage.packageId, installedPackage.packageVersion).then(function (result) {
            if (result && result.ok) showInstalledPackage({ ok: true, packages: [result.descriptor] });
          });
        });
      }
    }

    function currentMaterialWorkspace() { return materialId && Store.getMaterialWorkspace ? Store.getMaterialWorkspace(materialId) : null; }
    function showMaterialSource(material) {
      var host = document.querySelector('.sup-main') || document.querySelector('.sup-page') || document.body;
      if (!host || !material || document.getElementById('sup-material-source')) return;
      var source = document.createElement('div');
      source.id = 'sup-material-source'; source.style.cssText = 'margin:8px 0;padding:8px 10px;border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:6px;font-size:12px;color:var(--ink-2)';
      source.textContent = 'AI 上下文来源：当前材料「' + (material.source.name || material.title) + '」' + (material.clientId ? '、已关联来访者' : '；未绑定来访者，将作为独立督导保存');
      host.insertBefore(source, host.firstChild);
    }

    function updateContextState() {
      var state = document.getElementById('sup-context-state');
      if (!state) return;
      state.textContent = currentClientId ? '已关联来访者' : '独立督导';
      state.title = currentClientId ? '本次督导将关联当前来访者' : '本次督导不会关联任何来访者或会谈';
    }

    function clearBoundContext(resetMessage, toastMessage) {
      var material = currentMaterialWorkspace();
      var wasBound = !!currentClientId || !!(material && material.clientId);
      if (!wasBound) return;
      materialId = '';
      materialTA.value = '';
      input.value = '';
      messages = [];
      chat.innerHTML = '<div class="msg ai"><div class="src">小镜</div>' + resetMessage + '</div>';
      var source = document.getElementById('sup-material-source');
      if (source) source.remove();
      var impression = document.getElementById('impression-body');
      if (impression) impression.innerHTML = '<div class="ab-empty"><span class="big"><i data-lucide="brain-circuit"></i></span>输入或上传材料后，生成整体印象开始督导</div>';
      var deepen = document.getElementById('deepen-body');
      if (deepen) deepen.innerHTML = '<div class="ab-empty">尚未生成深化分析</div>';
      try { localStorage.removeItem(draftKey); localStorage.removeItem(chatKey); } catch (e) {}
      if (App.setActiveClientId) App.setActiveClientId('');
      if (window.IconSystem) window.IconSystem.render(chat);
      App.showToast(toastMessage, 'info');
    }

    // 来访者列表
    var selClient = document.getElementById('sup-client');
    Store.getClients().forEach(function (c) {
      if (c.status !== 'ended') {
        var opt = document.createElement('option');
        opt.value = c.id; opt.textContent = c.name;
        selClient.appendChild(opt);
      }
    });

    // 恢复草稿
    try { var d = localStorage.getItem(draftKey); if (d) materialTA.value = d; } catch(e){}
    materialTA.addEventListener('input', function () { try { localStorage.setItem(draftKey, this.value); } catch(e){} });

    // 督导师注册表与批准后的取向选择器
    var orientSel = document.getElementById('sup-orient');
    var orientDesc = document.getElementById('sup-orient-desc');
    var supervisorList = [];
    if (typeof Supervisors !== 'undefined' && Supervisors.getBuiltinList) {
      supervisorList = Supervisors.getBuiltinList();
      supervisorList.forEach(function (s) {
        var opt = document.createElement('option');
        opt.value = s.id; opt.textContent = s.name;
        if (s.desc) opt.setAttribute('data-desc', s.desc);
        orientSel.appendChild(opt);
      });
    }
    function renderSupervisorOptions() {
      function buttonFor(s) {
        return '<button class="supervisor-option' + (s.isWinnicott ? ' special' : '') + (s.id === curOrient ? ' selected' : '') + '" type="button" data-supervisor-id="' + App.escapeHtml(s.id) + '" aria-pressed="' + (s.id === curOrient ? 'true' : 'false') + '">' +
          '<span class="supervisor-option-mark">' + App.escapeHtml(s.mark || '督') + '</span><span><strong>' + App.escapeHtml(s.name) + '</strong><small>' + App.escapeHtml(s.desc || '') + '</small></span><i class="supervisor-option-check" data-lucide="check"></i></button>';
      }
      var special = document.getElementById('supervisor-special-options');
      var ordinary = document.getElementById('supervisor-orientation-options');
      if (special) special.innerHTML = supervisorList.filter(function (s) { return s.isWinnicott; }).map(buttonFor).join('');
      if (ordinary) ordinary.innerHTML = supervisorList.filter(function (s) { return !s.isWinnicott; }).map(buttonFor).join('');
      document.querySelectorAll('[data-supervisor-id]').forEach(function (button) {
        button.addEventListener('click', function () { setOrientation(button.getAttribute('data-supervisor-id'), true); closeSupervisorPicker(); });
      });
      if (window.IconSystem) window.IconSystem.render(document.getElementById('supervisor-picker'));
    }
    function closeSupervisorPicker() {
      var picker = document.getElementById('supervisor-picker');
      var openButton = document.getElementById('open-supervisor-picker');
      if (picker) picker.hidden = true;
      if (openButton) openButton.setAttribute('aria-expanded', 'false');
    }
    function setOrientation(orientationId, persistPreference) {
      var normalized = Supervisors.normalizeId ? Supervisors.normalizeId(orientationId) : orientationId;
      var definition = Supervisors.getDefinition ? Supervisors.getDefinition(normalized) : null;
      if (!normalized || !definition) { App.showToast('督导师配置无效，请重新选择', 'error'); return; }
      orientSel.value = normalized;
      curOrient = normalized;
      curOrientName = definition.displayName;
      updateBadge();
      var desc = definition.desc || '';
      if (orientDesc) {
        orientDesc.textContent = desc || '';
        orientDesc.style.display = 'none';
      }
      renderSupervisorOptions();
      if (persistPreference && currentClientId) {
        var client = Store.getClient(currentClientId);
        if (client) {
          Store.updateClient(currentClientId, {
            preferences: Object.assign({}, client.preferences || {}, { lastSupervisionOrientation: curOrient })
          });
        }
      }
    }
    setOrientation(curOrient, false);
    orientSel.addEventListener('change', function () { setOrientation(this.value, true); });
    var openPickerButton = document.getElementById('open-supervisor-picker');
    if (openPickerButton) openPickerButton.addEventListener('click', function () {
      var picker = document.getElementById('supervisor-picker');
      var opening = picker && picker.hidden;
      if (picker) picker.hidden = !opening;
      openPickerButton.setAttribute('aria-expanded', String(!!opening));
    });
    var closePickerButton = document.getElementById('close-supervisor-picker');
    if (closePickerButton) closePickerButton.addEventListener('click', closeSupervisorPicker);
    var customOption = document.getElementById('custom-supervisor-option');
    if (customOption) customOption.addEventListener('click', function () {
      if (!App.canUse('custom-supervisors')) {
        App.showToast('新建定制督导师为旗舰功能', 'warning');
        App.openPlans();
        return;
      }
      location.href = 'feedback.html?type=custom-supervisor';
    });
    function updateBadge() {
      document.getElementById('sup-badge').textContent = curOrientName;
      var name = document.getElementById('supervisor-current-name');
      var mark = document.getElementById('supervisor-current-mark');
      var definition = Supervisors.getDefinition ? Supervisors.getDefinition(curOrient) : null;
      if (name) name.textContent = curOrientName;
      if (mark) mark.textContent = (definition && definition.mark) || '督';
    }
    function ensureSupervisionAccess() {
      if (!App.canUse('ai-supervise')) {
        App.showToast('AI 督导为会员功能，可先预览界面', 'warning');
        App.openPlans();
        return false;
      }
      if (!(App.hasAICompute && App.hasAICompute())) {
        App.showToast('会员权益已解锁，但尚未检测到可用 AI 算力', 'warning');
        return false;
      }
      return true;
    }
    function syncAccessUI() {
      var unlock = document.getElementById('sup-unlock-button');
      if (unlock) unlock.style.display = App.canUse('ai-supervise') ? 'none' : '';
    }
    syncAccessUI();
    updateContextState();
    if (App.onLicenseStateChange) App.onLicenseStateChange(syncAccessUI);

    // Tab 切换
    window.switchTab = function (tab) {
      document.querySelectorAll('.m-tab').forEach(function (t) { t.classList.toggle('active', t.dataset.tab === tab); });
      document.getElementById('impression-body').parentElement.style.display = tab === 'impression' ? '' : 'none';
      document.getElementById('deepen-block').style.display = tab === 'deepen' ? '' : 'none';
      document.getElementById('material-block').style.display = tab === 'material' ? '' : 'none';
    };

    window.toggleMaterialPanel = function () {
      var panel = document.getElementById('mat-panel');
      var toggle = document.getElementById('sup-material-toggle');
      if (!panel || !toggle) return false;
      var open = !panel.classList.contains('open');
      panel.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.textContent = open ? '收起材料' : '展开材料';
      return open;
    };

    // 来访者选择 → 加载会话历史
    window.onClientChange = function () {
      var cid = selClient.value;
      var continueButton = document.getElementById('continue-supervision');
      if (!cid) {
        clearBoundContext('当前为独立督导。请重新输入不关联来访者的材料，或直接开始提问。', '已清除上一位来访者的材料和对话，现为独立督导');
        currentClientId = null;
        currentSessionId = '';
        latestSupervision = null;
        if (continueButton) continueButton.style.display = 'none';
        updateContextState();
        renderSessionHistory([]);
        return;
      }
      if (currentClientId && currentClientId !== cid) {
        clearBoundContext('已清除上一位来访者的材料和对话，正在切换到新的来访者。', '已清除上一位来访者的材料和对话');
      }
      currentClientId = cid;
      updateContextState();
      if (App.setActiveClientId) App.setActiveClientId(currentClientId);
      if (materialId && Store.reconcileMaterialContext) Store.reconcileMaterialContext(materialId, currentClientId, currentSessionId || null, {});
      var client = Store.getClient(cid);
      var preferences = (client && client.preferences) || {};
      if (preferences.lastSupervisionOrientation) setOrientation(preferences.lastSupervisionOrientation, false);
      var supervisions = Store.getSupervisionsByClient ? Store.getSupervisionsByClient(cid) : [];
      latestSupervision = supervisions.length ? supervisions[supervisions.length - 1] : null;
      if (continueButton) continueButton.style.display = latestSupervision ? '' : 'none';
      var sessions = Store.getSessionsForPicker(cid).sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
      renderSessionHistory(sessions);
      // 自动载入最近一次会话的逐字稿
      if (sessions.length && sessions[0].transcript) {
        materialTA.value = sessions[0].transcript;
        currentSessionId = sessions[0].id;
        addMsg('ai', '已自动载入 ' + Store.getClient(cid).name + ' 第' + sessions[0].sessionNumber + '节的逐字稿。点「生成整体印象」开始督导。');
      } else {
        addMsg('ai', '已选择 ' + Store.getClient(cid).name + '。该来访者暂无逐字稿，请在材料区手动书写。');
      }
    };

    function renderSessionHistory(sessions) {
      var box = document.getElementById('session-history');
      if (!sessions || !sessions.length) {
        box.innerHTML = '<div style="padding:24px;text-align:center;color:var(--ink-3);font-size:12px">' +
          (currentClientId ? '暂无会话记录' : '当前为独立督导；可直接输入或上传材料') + '</div>';
        return;
      }
      box.innerHTML = sessions.map(function (s) {
        var hasTranscript = s.transcript && s.transcript.trim();
        var hasSoap = s.soap && (s.soap.subjective || s.soap.objective || s.soap.assessment || s.soap.plan);
        var linkedMaterials = Store.getMaterialWorkspacesForSession ? Store.getMaterialWorkspacesForSession(currentClientId, s.id) : [];
        var tags = '';
        if (hasTranscript) tags += '<span class="tag done">逐字稿</span>';
        if (hasSoap) tags += '<span class="tag done">记录</span>';
        if (linkedMaterials.length) tags += '<span class="tag done">已关联材料 ' + linkedMaterials.length + '</span>';
        if (!hasTranscript && !hasSoap && !linkedMaterials.length) tags += '<span class="tag">无材料</span>';
        var preview = (s.transcript || '').slice(0, 60);
        return '<div class="lh-item" onclick="loadSessionTranscript(\'' + s.id + '\')" data-id="' + s.id + '">' +
          '<div class="s-num">第' + (s.sessionNumber || '?') + '节</div>' +
          '<div class="s-date">' + App.formatDate(s.date) + '</div>' +
          (preview ? '<div class="s-preview">' + App.escapeHtml(preview) + '…</div>' : '') +
          '<div class="s-tags">' + tags + '</div></div>';
      }).join('');
    }

    window.loadSessionTranscript = function (sessionId) {
      var s = Store.getSession(sessionId);
      if (!s) return;
      currentSessionId = s.id;
      materialTA.value = s.transcript || '';
      if (s.soap) materialTA.value += '\n\n--- SOAP ---\nS: ' + (s.soap.subjective||'') + '\nO: ' + (s.soap.objective||'') + '\nA: ' + (s.soap.assessment||'') + '\nP: ' + (s.soap.plan||'');
      var linkedMaterials = Store.getMaterialWorkspacesForSession ? Store.getMaterialWorkspacesForSession(s.clientId, s.id) : [];
      if (linkedMaterials.length) {
        materialTA.value += '\n\n--- 已关联材料来源 ---\n' + linkedMaterials.map(function (m) {
          return '【' + (m.sourceName || m.title) + '】\n' + (m.text || '材料已关联，但暂无可预览文本');
        }).join('\n\n');
      }
      addMsg('ai', '已载入第' + (s.sessionNumber || '?') + '节材料' + (linkedMaterials.length ? '，含 ' + linkedMaterials.length + ' 份关联材料。' : '。'));
      // 高亮选中的会话
      document.querySelectorAll('.lh-item').forEach(function (el) { el.classList.remove('active'); });
      var active = document.querySelector('.lh-item[data-id="' + sessionId + '"]');
      if (active) active.classList.add('active');
    };

    window.continueLastSupervision = function () {
      if (!latestSupervision) return;
      var context = String(latestSupervision.context || latestSupervision.content || '').trim();
      if (context) {
        materialTA.value = context;
        try { localStorage.setItem(draftKey, context); } catch (e) {}
      }
      currentSessionId = latestSupervision.sessionId || ((latestSupervision.sessionIds || [])[0]) || currentSessionId;
      addMsg('ai', '已恢复上次督导的材料和流派。你可以补充本次材料后再开始分析。');
      switchTab('material');
    };

    window.loadTranscript = function () {
      var cid = selClient.value;
      if (!cid) { App.showToast('请先选择来访者', 'warning'); return; }
      var sessions = Store.getSessionsForPicker(cid).sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
      if (!sessions.length) { App.showToast('该来访者无会话记录', 'warning'); return; }
      var html = sessions.map(function (s, i) {
        return '<label style="display:block;padding:8px;cursor:pointer"><input type="radio" name="sup-sess" value="' + s.id + '"' + (i === 0 ? ' checked' : '') + '> 第' + s.sessionNumber + '节 · ' + App.formatDate(s.date) + (s.transcript ? ' (有逐字稿)' : ' (无逐字稿)') + '</label>';
      }).join('');
      App.confirmDialog(html, function () {
        var checked = document.querySelector('input[name="sup-sess"]:checked');
        if (!checked) return;
        loadSessionTranscript(checked.value);
      });
    };

    function addMsg(role, text) {
      var div = document.createElement('div');
      div.className = 'msg ' + (role === 'me' ? 'me' : 'ai');
      if (role === 'ai') {
        div.innerHTML = '<div class="src">小镜</div>' + App.escapeHtml(text).replace(/\n/g, '<br>');
      } else {
        div.textContent = text;
      }
      chat.appendChild(div);
      chat.scrollTop = chat.scrollHeight;
      messages.push({ role: role === 'me' ? 'user' : 'assistant', content: text });
    }

    function addTyping() {
      var div = document.createElement('div');
      div.className = 'msg ai'; div.id = 'sup-typing';
      div.innerHTML = '<div class="src">小镜</div>思考中…';
      chat.appendChild(div);
      chat.scrollTop = chat.scrollHeight;
    }
    function removeTyping() { var t = document.getElementById('sup-typing'); if (t) t.remove(); }

    function addErrorCard(message, request) {
      lastFailedRequest = request || null;
      var div = document.createElement('div');
      div.className = 'msg ai sup-error-card';
      div.innerHTML = '<div class="src">小镜</div>' +
        '<div class="sup-error-detail">' + App.escapeHtml(message || '模型没有返回结果') + '</div>' +
        '<div class="sup-error-actions">' +
        '<button type="button" class="primary" data-sup-retry>重试</button>' +
        '<button type="button" data-sup-settings>检查模型配置</button>' +
        '</div>';
      chat.appendChild(div);
      chat.scrollTop = chat.scrollHeight;
    }

    function buildMessages(userText, isImpression) {
      var sys = (typeof Supervisors !== 'undefined' && Supervisors.buildSystemPrompt)
        ? Supervisors.buildSystemPrompt(curOrient)
        : '你是一位心理咨询督导，请用中文回应，语气专业而温暖。';
      var material = materialTA.value.trim();
      var hist = messages.slice(-12).map(function (m) { return { role: m.role, content: m.content }; });

      var userContent = '';
      if (isImpression) {
        userContent = '以下是临床材料，请基于' + curOrientName + '给出整体印象（个案概念化、核心议题、治疗师功能、值得注意的线索）：\n\n' + material;
      } else {
        userContent = userText;
        if (material) userContent += '\n\n--- 临床材料 ---\n' + material;
      }
      return [{ role: 'system', content: sys }].concat(hist).concat([{ role: 'user', content: userContent }]);
    }

    function callAI(msgs, signal) {
      return new Promise(function (resolve) {
        if (typeof AI === 'undefined' || !AI.send) { resolve({ error: 'AI 模块未就绪' }); return; }
        var input = materialTA ? materialTA.value.trim() : '';
        var finalMessage = msgs[msgs.length - 1] || {};
        var context = ClinicalContext.build('supervision-ai', { clientId: currentClientId, sessionId: currentSessionId, materialId: materialId }, { system: (msgs[0] && msgs[0].content) || '', inputText: input, instruction: finalMessage.content || '', history: msgs.slice(1, -1) });
        if (!context.ok) { resolve({ error: '当前上下文无效，请检查材料或关联信息' }); return; }
        if (ClinicalContextView) ClinicalContextView.renderSummary(document.querySelector('.sup-main') || document.body, context);
        // XJ519-Z4：上下文确认改为异步 DOM 确认，不再使用 window.confirm 同步阻塞。
        confirmContextSendAsync(context).then(function (confirmed) {
          if (!confirmed) { resolve({ error: '用户已取消本次 AI 督导', cancelled: true }); return; }
          var run = ClinicalContext.createActionRun(context);
          if (!run) { resolve({ error: '无法确认材料归属' }); return; }
          AI.send(context.messages, function (res) {
            var currentInput = materialTA ? materialTA.value.trim() : '';
            if (!ClinicalContext.isSnapshotCurrent(context.snapshot, currentInput, { clientId: currentClientId, sessionId: currentSessionId, materialId: materialId })) { ClinicalContext.failActionRun(run.id, '上下文已变更', 'stale'); resolve({ error: '上下文已变更，旧结果未采用' }); return; }
            if (res && res.content && !res.error) { ClinicalContext.completeActionRun(run.id, { kind: 'supervision-preview', summary: res.content, citations: [] }); resolve({ content: res.content }); }
            else { ClinicalContext.failActionRun(run.id, (res && res.error) || '无响应'); resolve({ error: (res && res.error) || '无响应', code: res && res.code, errorCode: res && res.errorCode, interrupted: !!(res && res.interrupted) }); }
          }, signal ? { signal: signal } : undefined);
        });
      });
    }

    function renderImpression(text) {
      var body = document.getElementById('impression-body');
      body.innerHTML = '';
      var paras = text.split('\n').filter(Boolean);
      paras.forEach(function (p) {
        if (p.startsWith('【') && p.endsWith('】')) {
          body.innerHTML += '<div style="font-weight:600;font-family:var(--serif);font-size:14px;margin:12px 0 6px;color:var(--accent)">' + App.escapeHtml(p) + '</div>';
        } else if (p.startsWith('"') || p.startsWith('“')) {
          body.innerHTML += '<div class="ab-quote">' + App.escapeHtml(p) + '</div>';
        } else {
          body.innerHTML += '<p style="margin:6px 0">' + App.escapeHtml(p) + '</p>';
        }
      });
    }

    window.generateImpression = function () {
      if (busy) return;
      if (!ensureSupervisionAccess()) return;
      var mat = materialTA.value.trim();
      if (!mat) { App.showToast('请先在材料区填写临床材料', 'warning'); return; }
      sendToAI('生成整体印象', true);
    };

    window.quickAction = function (kind) {
      if (busy) return;
      if (!ensureSupervisionAccess()) return;
      var prompts = {
        deepen: '请就材料中的核心议题深化讨论，提出进一步的思考角度与开放式提问。',
        polish: '请在不改变原意的前提下润色以下临床材料的语言，使其更通顺、专业。',
        tech: '基于材料，请给出具体的技术建议——在接下来的咨询中我应该怎样回应？',
        transference: '请就材料中的移情/反移情议题进行分析。如果信息不足，请提出需要关注的移情线索。',
      };
      sendToAI(prompts[kind] || prompts.deepen, false);
    };

    window.inviteMaster = function () {
      if (busy) return;
      if (!ensureSupervisionAccess()) return;
      var masters = (window.MASTERS || []);
      var html = masters.map(function (m) {
        return '<label style="display:inline-block;padding:6px 12px;cursor:pointer"><input type="radio" name="sup-master" value="' + m.key + '"' + (m.key === 'winnicott' ? ' checked' : '') + '> ' + m.name + '</label>';
      }).join('');
      App.confirmDialog(html, function () {
        var checked = document.querySelector('input[name="sup-master"]:checked');
        if (!checked) return;
        var m = (window.getMasterByKey ? getMasterByKey(checked.value) : null);
        if (!m) return;
        var mat = materialTA.value.trim();
        if (!mat) { App.showToast('请先填写临床材料', 'warning'); return; }
        addMsg('me', '邀请 ' + m.name + ' 发表视角');
        addTyping();
        busy = true;
        var sys = m.systemPrompt + '\n\n以下是临床材料，请以你的理论视角给出对个案的分析和督导意见：\n\n' + mat;
        callAI([{ role: 'system', content: sys }, { role: 'user', content: '请基于你的取向分析这个个案。' }]).then(function (r) {
          removeTyping();
          if (r && !r.error) {
            addMsg('ai', '【' + m.name + '视角】\n' + r.content);
            // 也渲染到中栏深化区
            var deepenBody = document.getElementById('deepen-body');
            deepenBody.innerHTML = '<div class="ab-head" style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><span style="font-weight:600;color:var(--accent)">' + m.name + '视角</span></div>' +
              '<div style="font-size:13px;line-height:1.8">' + App.escapeHtml(r.content).replace(/\n/g, '<br>') + '</div>';
            switchTab('deepen');
          } else addMsg('ai', '生成失败：' + ((r && r.error) || '未知'));
          busy = false;
        });
      });
    };

    window.sendSupMsg = function () {
      var text = (input.value || '').trim();
      if (!text || busy) return;
      if (!ensureSupervisionAccess()) return;
      input.value = '';
      sendToAI(text, false);
    };

    chat.addEventListener('click', function (event) {
      var retry = event.target.closest ? event.target.closest('[data-sup-retry]') : null;
      var settings = event.target.closest ? event.target.closest('[data-sup-settings]') : null;
      if (retry && lastFailedRequest && !busy) {
        var request = lastFailedRequest;
        lastFailedRequest = null;
        sendToAI(request.text, request.isImpression, true);
      } else if (settings) {
        location.href = 'settings.html';
      }
    });

    async function sendToAI(text, isImpression, isRetry) {
      if (busy) return;
      if (!isImpression && !isRetry) addMsg('me', text);
      addTyping();
      busy = true;
      // XJ519-Z4：请求期间提供真实的取消动作（AbortController → ai.js 桥接取消），
      // 主线程保持可交互；取消、成功、失败三种终态分开显示。
      var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      activeSupervisionController = controller;
      var typingEl = document.getElementById('sup-typing');
      if (typingEl && controller) {
        var cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.textContent = '取消生成';
        cancelBtn.style.cssText = 'margin-left:10px;padding:2px 10px;font-size:11px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--ink-2);cursor:pointer';
        cancelBtn.addEventListener('click', function () {
          try { if (activeSupervisionController) activeSupervisionController.abort(); } catch (e) { /* 已取消 */ }
        });
        typingEl.appendChild(cancelBtn);
      }
      try {
        var msgs = buildMessages(text, isImpression);
        var r = await callAI(msgs, controller ? controller.signal : null);
        removeTyping();
        if (r && r.cancelled) {
          addMsg('ai', '已取消本次 AI 督导（上下文未发送）。');
        } else if (r && r.code === 'ABORT_ERR') {
          addMsg('ai', '已取消生成。');
        } else if (r && !r.error) {
          addMsg('ai', r.content);
          if (isImpression) {
            renderImpression(r.content);
            switchTab('impression');
          } else {
            // 把深化分析渲染到中栏
            var deepenBody = document.getElementById('deepen-body');
            deepenBody.innerHTML = '<div style="font-size:13px;line-height:1.8">' + App.escapeHtml(r.content).replace(/\n/g, '<br>') + '</div>';
            switchTab('deepen');
          }
        } else {
          var reason = (r && r.error) || '未知错误';
          addErrorCard('生成失败：' + reason + '。可重试，或检查当前模型配置。', { text: text, isImpression: !!isImpression });
        }
      } catch (e) {
        removeTyping();
        addErrorCard('执行异常：' + ((e && e.message) || '未知错误') + '。可重试，或检查当前模型配置。', { text: text, isImpression: !!isImpression });
      }
      activeSupervisionController = null;
      busy = false;
    }

    window.saveSup = async function () {
      if (!messages.length) { App.showToast('无内容可保存', 'warning'); return; }
      var full = messages.map(function (m) { return (m.role === 'user' ? '咨询师：' : '督导师：') + m.content; }).join('\n\n');
      var modeName = curOrientName;
      if (typeof Store !== 'undefined' && typeof Store.saveAiSupervision === 'function') {
        var savedResult = await Store.saveAiSupervisionDurable({
          supervisorName: modeName,
          clientId: currentClientId || '',
          sessionId: currentSessionId,
          sessionIds: currentSessionId ? [currentSessionId] : [],
          context: materialTA.value.trim(),
          content: full,
        });
        if (!savedResult || !savedResult.ok) { App.showToast('保存失败：督导草稿已保留，请恢复存储后重试', 'error'); return; }
        var saved = savedResult.value;
        if (saved && materialId && Store.updateMaterialWorkspace) Store.updateMaterialWorkspace(materialId, { workflow: { supervision: 'completed' }, artifacts: { supervisionId: saved.id } });
      }
      App.showToast(currentClientId ? '已保存督导记录' : '已保存独立督导记录', 'success');
      if (typeof Memory !== 'undefined' && Memory.record) Memory.record('supervision_done', { summary: '完成了 AI 督导' });
    };

    window.exportSup = function () {
      var body = '<h2>AI 督导记录</h2>';
      messages.forEach(function (m) {
        body += '<p><strong>' + (m.role === 'user' ? '我' : '小镜') + '：</strong>' + App.escapeHtml(m.content).replace(/\n/g, '<br>') + '</p>';
      });
      App.exportWordDoc('督导记录_' + App.todayStr() + '.doc', body);
      App.showToast('已导出 Word 文档', 'success');
    };

    // 手动上传案例报告 → 载入材料区（本地 FileReader；只更新材料草稿，不写正式督导记录）
    function uploadActive(operation) {
      return !!operation && uploadOperation === operation && !operation.cancelled;
    }

    function uploadProgressValue(value) {
      var number = Number(value);
      if (!isFinite(number)) return 0;
      return Math.max(0, Math.min(100, Math.round(number)));
    }

    function resetReportFileInput() {
      var inputEl = document.getElementById('sup-report-file');
      if (inputEl) inputEl.value = '';
    }

    function setUploadState(state, detail, progress) {
      var labels = {
        idle: '等待上传',
        uploading: '正在读取',
        progress: '读取进度',
        success: '已载入',
        failure: '读取失败',
        retry: '正在重试',
        cancel: '已取消'
      };
      var defaults = {
        idle: '可选择 .txt 或 .docx 报告；读取结果只会写入临床材料草稿。',
        uploading: '正在打开文件；尚未写入材料或草稿。',
        progress: '正在读取文件内容；尚未写入材料或草稿。',
        success: '报告内容已写入临床材料区；尚未写入正式督导记录。',
        failure: '读取失败，材料与草稿均未改变。请检查原因后重试。',
        retry: '正在使用同一个文件重试；当前材料与草稿保持不变。',
        cancel: '已取消读取；材料与草稿均未改变。'
      };
      uploadState = state || 'idle';
      uploadStateHistory.push(uploadState);
      if (uploadStateHistory.length > 120) uploadStateHistory.shift();
      var status = document.getElementById('sup-upload-status');
      var label = document.getElementById('sup-upload-status-label');
      var fileLabel = document.getElementById('sup-upload-status-file');
      var detailLabel = document.getElementById('sup-upload-status-detail');
      var progressWrap = document.getElementById('sup-upload-progress-wrap');
      var progressBar = document.getElementById('sup-upload-progress');
      var progressFill = document.getElementById('sup-upload-progress-bar');
      var retryButton = document.getElementById('sup-upload-retry');
      var cancelButton = document.getElementById('sup-upload-cancel');
      var currentProgress = uploadProgressValue(progress);
      if (status) status.setAttribute('data-upload-state', uploadState);
      if (label) label.textContent = labels[uploadState] || labels.idle;
      if (fileLabel) fileLabel.textContent = (uploadPendingFile && uploadPendingFile.name) || uploadLastFileName || '未选择文件';
      if (detailLabel) detailLabel.textContent = detail || defaults[uploadState] || defaults.idle;
      var showProgress = uploadState === 'uploading' || uploadState === 'progress' || uploadState === 'retry';
      if (progressWrap) progressWrap.hidden = !showProgress;
      if (progressBar) progressBar.setAttribute('aria-valuenow', String(currentProgress));
      if (progressFill) progressFill.style.width = currentProgress + '%';
      var canRetry = uploadState === 'failure' && !!uploadPendingFile && !uploadOperation;
      var canCancel = (uploadState === 'uploading' || uploadState === 'progress' || uploadState === 'retry' || uploadState === 'failure') && (!!uploadPendingFile || !!uploadOperation);
      if (retryButton) {
        retryButton.hidden = !canRetry;
        retryButton.disabled = !canRetry;
        retryButton.title = canRetry ? '使用同一文件再次读取' : '读取失败后才可重试';
      }
      if (cancelButton) {
        cancelButton.hidden = !canCancel;
        cancelButton.disabled = !canCancel;
        cancelButton.title = canCancel ? '取消读取并放弃待重试文件' : '当前没有正在读取的文件';
      }
    }

    function uploadErrorMessage(error) {
      if (error && (error.name === 'AbortError' || error.code === 'ABORTED')) return '读取已取消';
      if (error && error.code === 'STALE') return '读取结果已失效，未采用';
      var message = error && (error.message || error.name);
      return message ? String(message) : '文件读取或解析失败';
    }

    function readReportFileWithReader(file, operation, asArrayBuffer) {
      return new Promise(function (resolve, reject) {
        var reader;
        try { reader = new FileReader(); } catch (error) { reject(error); return; }
        operation.reader = reader;
        var settled = false;
        function rejectOnce(error) {
          if (settled) return;
          settled = true;
          reject(error);
        }
        reader.onloadstart = function () {
          if (uploadActive(operation)) setUploadState('uploading', '正在读取「' + file.name + '」；尚未写入材料或草稿。', 0);
        };
        reader.onprogress = function (event) {
          if (!uploadActive(operation)) return;
          var percent = event && event.lengthComputable ? (event.loaded / Math.max(1, event.total)) * 100 : 50;
          setUploadState('progress', '正在读取「' + file.name + '」；尚未写入材料或草稿。', percent);
        };
        reader.onerror = function () { rejectOnce(reader.error || new Error('文件读取失败')); };
        reader.onabort = function () { rejectOnce({ code: 'ABORTED', name: 'AbortError', message: '读取已取消' }); };
        reader.onload = function (event) {
          if (!uploadActive(operation)) { rejectOnce({ code: 'STALE', message: '读取结果已失效' }); return; }
          settled = true;
          resolve(event && event.target ? event.target.result : reader.result);
        };
        try {
          if (asArrayBuffer) reader.readAsArrayBuffer(file);
          else reader.readAsText(file, 'UTF-8');
        } catch (error) { rejectOnce(error); }
      });
    }

    function readReportFile(file, operation) {
      var name = String(file.name || '').toLowerCase();
      if (!name.endsWith('.docx')) return readReportFileWithReader(file, operation, false);
      return readReportFileWithReader(file, operation, true).then(function (arrayBuffer) {
        if (!uploadActive(operation)) throw { code: 'ABORTED', name: 'AbortError', message: '读取已取消' };
        if (typeof mammoth === 'undefined' || typeof mammoth.extractRawText !== 'function') throw new Error('docx 解析库未加载');
        var extracted;
        try { extracted = mammoth.extractRawText({ arrayBuffer: arrayBuffer }); } catch (error) { throw error; }
        return Promise.resolve(extracted).then(function (result) {
          if (!uploadActive(operation)) throw { code: 'ABORTED', name: 'AbortError', message: '读取已取消' };
          if (!result || typeof result.value !== 'string') throw new Error('docx 解析未返回文本');
          return result.value;
        });
      });
    }

    function finishUploadCancel(operation) {
      if (operation && operation.cancelSettled) return;
      if (operation) operation.cancelSettled = true;
      if (!operation || uploadOperation === operation) uploadOperation = null;
      uploadPendingFile = null;
      uploadLastFileName = '';
      resetReportFileInput();
      setUploadState('cancel', '已取消读取；材料与草稿均未改变。');
      if (typeof App !== 'undefined' && App.showToast) App.showToast('已取消报告读取，材料与草稿未改变', 'info');
      window.setTimeout(function () {
        if (!uploadOperation && uploadState === 'cancel') setUploadState('idle', '可再次选择报告文件；材料与草稿保持不变。');
      }, 0);
    }

    function failReportUpload(operation, error) {
      if (!uploadActive(operation)) return;
      uploadOperation = null;
      uploadPendingFile = operation.file;
      uploadLastFileName = operation.file.name;
      var reason = uploadErrorMessage(error);
      setUploadState('failure', reason + '；材料与草稿均未改变。');
      if (typeof App !== 'undefined' && App.showToast) App.showToast('报告读取失败：' + reason, 'error');
    }

    function completeReportUpload(operation, text) {
      if (!uploadActive(operation)) return;
      if (typeof text !== 'string' || !text.trim()) { failReportUpload(operation, new Error('报告内容为空')); return; }
      var before = materialTA.value;
      var next = before + (before.trim() ? '\n\n' : '') + '【上传的案例报告：' + operation.file.name + '】\n' + text;
      try {
        materialTA.value = next;
        localStorage.setItem(draftKey, next);
      } catch (error) {
        materialTA.value = before;
        failReportUpload(operation, new Error('草稿保存失败，未完成载入'));
        return;
      }
      uploadOperation = null;
      uploadPendingFile = null;
      uploadLastFileName = operation.file.name;
      resetReportFileInput();
      setUploadState('success', '报告「' + operation.file.name + '」已写入临床材料区；尚未写入正式督导记录。', 100);
      if (typeof App !== 'undefined' && App.showToast) App.showToast('案例报告已载入材料区', 'success');
      switchTab('material');
    }

    function startReportUpload(file, isRetry) {
      if (!file || !file.name) return;
      var previous = uploadOperation;
      if (previous) {
        previous.cancelled = true;
        try { if (previous.reader && previous.reader.readyState === 1) previous.reader.abort(); } catch (ignore) {}
      }
      var operation = { id: ++uploadSequence, file: file, reader: null, cancelled: false, cancelSettled: false };
      uploadOperation = operation;
      uploadPendingFile = file;
      uploadLastFileName = file.name;
      setUploadState(isRetry ? 'retry' : 'uploading', isRetry ? '正在使用同一个文件重试；当前材料与草稿保持不变。' : '正在读取「' + file.name + '」；尚未写入材料或草稿。', 0);
      setUploadState('progress', '正在读取「' + file.name + '」；尚未写入材料或草稿。', 0);
      readReportFile(file, operation).then(function (text) {
        completeReportUpload(operation, text);
      }).catch(function (error) {
        if (!uploadActive(operation)) return;
        if (operation.cancelled || (error && (error.code === 'ABORTED' || error.name === 'AbortError'))) finishUploadCancel(operation);
        else failReportUpload(operation, error);
      });
    }

    window.retryReportFileUpload = function () {
      if (uploadOperation || !uploadPendingFile) return;
      startReportUpload(uploadPendingFile, true);
    };

    window.cancelReportFileUpload = function () {
      var operation = uploadOperation;
      if (operation) {
        operation.cancelled = true;
        try { if (operation.reader && operation.reader.readyState === 1) operation.reader.abort(); } catch (ignore) {}
        finishUploadCancel(operation);
        return;
      }
      if (uploadPendingFile) finishUploadCancel(null);
    };

    window.onReportFileUpload = function (event) {
      var target = event && event.target;
      var file = target && target.files && target.files[0];
      if (!file) return;
      startReportUpload(file, false);
    };

    window.__xjSupervisionUpload = {
      getState: function () {
        return { state: uploadState, history: uploadStateHistory.slice(), pendingFileName: uploadPendingFile ? uploadPendingFile.name : '', lastFileName: uploadLastFileName, readerState: uploadOperation && uploadOperation.reader ? uploadOperation.reader.readyState : null };
      },
      resetHistory: function () { uploadStateHistory = [uploadState]; }
    };

    bindControlledPackage();

    // 从「撰写报告」跳转而来：选择来访者并预填案例报告
    try {
      var qs = new URLSearchParams(location.search);
      var autoClient = qs.get('clientId') || qs.get('client') || (App.getActiveClientId && App.getActiveClientId());
      var autoSession = qs.get('sessionId') || qs.get('session');
      materialId = qs.get('materialId') || '';
      var material = currentMaterialWorkspace();
      if (material && material.parseStatus === 'ready') {
        if (material.clientId) autoClient = material.clientId;
        if (material.sessionId) autoSession = material.sessionId;
        materialTA.value = material.extractedText || '';
        Store.updateMaterialWorkspace(materialId, { workflow: { supervision: 'in-progress' } });
        showMaterialSource(material);
      }
      var autoReport = qs.get('autoloadreport') === '1';
      if (autoClient) {
        selClient.value = autoClient;
        if (selClient.value === autoClient) {
          window.onClientChange();
          if (autoSession) window.loadSessionTranscript(autoSession);
          if (autoReport) {
            var draft = localStorage.getItem('xj_report_draft_' + autoClient);
            if (draft) {
              materialTA.value = draft;
              try { localStorage.setItem(draftKey, draft); } catch (e) {}
              addMsg('ai', '已载入从「撰写报告」带过来的案例报告。点「生成整体印象」或直接在右侧对话窗深入督导。');
              switchTab('material');
            }
          }
        }
      }
      if (material && material.parseStatus === 'ready') {
        materialTA.value = material.extractedText || '';
        switchTab('material');
      }
    } catch (e) {}
  },
});
