/* 心镜 — AI 督导（单列上下流：材料 → 生成 → 结果流 → 追问 + 会员分层） */
App.initPage({
  title: 'AI 督导',
  onReady: function () {
    'use strict';
    // chat 现在是单列结果流容器（一次 AI 输出 = 一张卡片，按顺序垂直追加）
    var chat = document.getElementById('sup-chat');
    var input = document.getElementById('sup-input');
    var materialTA = document.getElementById('sup-material');
    var askEl = document.getElementById('sup-ask');
    var materialSec = document.getElementById('sup-material-sec');
    var scrollHost = document.getElementById('sup-standard-view');
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
    var replyLength = 'medium';
    var multiSchoolMode = false;
    var multiSchoolResult = null;
    var multiSchoolProgressRows = [];
    var multiSchoolBusy = false;
    var multiSchoolBusyOwner = 0;
    var multiSchoolSaving = false;
    var multiSchoolController = null;
    var multiSchoolGeneration = 0;
    var multiSchoolBound = false;
    var multiSchoolContext = null;
    // DEC-02 ②③：本次运行区间内发生的「内置模型兜底」事实（降级提示 DOM + 归档溯源用）
    var multiSchoolFallbackEvents = [];
    var multiSchoolNoticeEl = null;

    // ---------- DEC-02：兜底可见化（页面层只消费 ai.js 的同一套字段与文案）----------
    function aiFallbackApi() {
      return (typeof AI !== 'undefined' && AI && AI.fallbackVisibility) ? AI.fallbackVisibility : null;
    }
    function aiFallbackWatermark() {
      var api = aiFallbackApi();
      return api ? api.count() : 0;
    }
    function aiFallbackEventsSince(watermark) {
      var api = aiFallbackApi();
      if (!api) return [];
      var list = api.since(watermark);
      return Array.isArray(list) ? list : [];
    }
    // 单次返回对象的降级投影（AI.send / AI.stream 出口形状同源，页面不再自造字段名）
    function degradationOf(res) {
      var api = aiFallbackApi();
      if (api && api.fields) return api.fields(res);
      return {
        fallback: !!(res && res.fallback === true),
        warning: res && res.warning,
        tier: res && res.tier,
        transportState: res && res.transportState,
      };
    }
    function degradationNoticeText(info) {
      var api = aiFallbackApi();
      if (api && api.noticeText) return api.noticeText(info || {});
      return '本次由内置模型代答，不是你选择的模型；原始失败码未知，请谨慎用于临床判断。';
    }
    // 把「实际使用的模型/档位」接进归档**已有**的 usage 字段（不改 store.js，
    // 不改 supervision-syndicate.js 的归档字段表）；督导记录与用户所选不一致时可追溯。
    function attachFallbackProvenance(result, events) {
      var api = aiFallbackApi();
      if (!result || !api || !events || !events.length) return result;
      var provenance = api.provenance(events);
      if (!provenance) return result;
      result.usage = Object.assign({}, result.usage || {}, { fallback: provenance });
      result.degraded = true;
      result.warning = provenance.warning;
      return result;
    }
    function ensureModelNoticeHost() {
      var results = document.getElementById('sup-multi-results');
      var parent = results && results.parentNode ? results.parentNode : document.getElementById('sup-multi-panel');
      if (!parent || !results || typeof parent.insertBefore !== 'function') return null;
      if (multiSchoolNoticeEl && multiSchoolNoticeEl.parentNode === parent) return multiSchoolNoticeEl;
      var notice = document.createElement('div');
      notice.className = 'sup-model-notice';
      notice.setAttribute('role', 'status');
      notice.dataset.state = 'hidden';
      notice.hidden = true;
      notice.textContent = '';
      parent.insertBefore(notice, results);
      multiSchoolNoticeEl = notice;
      return notice;
    }
    // 兜底提示只在真正降级时出现；措辞由 ai.js 统一给出，绝不写成「成功」。
    function renderModelNotice(events) {
      multiSchoolFallbackEvents = Array.isArray(events) ? events : [];
      var notice = ensureModelNoticeHost();
      if (!notice) return;
      if (!multiSchoolFallbackEvents.length) {
        notice.dataset.state = 'hidden';
        notice.hidden = true;
        notice.textContent = '';
        return;
      }
      var api = aiFallbackApi();
      var provenance = api ? api.provenance(multiSchoolFallbackEvents) : null;
      notice.dataset.state = 'degraded';
      notice.dataset.warning = (provenance && provenance.warning) || 'BUILTIN_FALLBACK_USED';
      // 节点创建时是 hidden=true，而 workbench.css 有 `[hidden]{display:none!important}`：
      // 只改 data-state 不会让它出现在屏幕上，必须显式解除 hidden。
      notice.hidden = false;
      notice.textContent = (provenance && provenance.notice)
        || '本次由内置模型代答，不是你选择的模型；原始失败码未知，请谨慎用于临床判断。';
    }

    // 中止在跑的多学派任务并交还视图所有权。切来访者/切会谈/切独立督导都必须走这里：
    // 只递增 generation 不 abort 会让旧任务的流式 delta 继续写进新上下文的 DOM。
    function abortMultiSchoolRun(reason) {
      if (multiSchoolSaving) return false;
      multiSchoolGeneration += 1;
      if (multiSchoolController) { try { multiSchoolController.abort(); } catch (e) { /* 已中止 */ } }
      multiSchoolController = null;
      multiSchoolResult = null;
      multiSchoolContext = null;
      multiSchoolProgressRows = [];
      renderMultiSchoolResults(null);
      renderModelNotice(null);
      setMultiSchoolStatus('等待材料', 'idle');
      var saveButton = document.getElementById('sup-multi-save');
      if (saveButton) saveButton.disabled = true;
      return true;
    }

    // 页面自产的失败必须与核心同规格携带 errorCode（卡片 §7.4「任何超限响应都必须含稳定 errorCode」）。
    function multiSchoolError(message, errorCode) {
      var error = new Error(message);
      error.errorCode = errorCode || 'MULTI_SCHOOL_RUN_FAILED';
      return error;
    }

    // 回复长度档位 → 输出上限；「详细」只放宽上限，不额外加指令，避免稀释督导风格
    var LENGTH_TOKENS = { brief: 1400, medium: 3200, detailed: 8192 };
    function lengthOptions(extra) {
      var opts = { maxTokens: LENGTH_TOKENS[replyLength] || LENGTH_TOKENS.medium };
      if (extra && extra.signal) opts.signal = extra.signal;
      if (extra && extra.onDelta) opts.onDelta = extra.onDelta;
      return opts;
    }

    function scrollStreamToEnd() {
      if (!scrollHost) return;
      scrollHost.scrollTop = scrollHost.scrollHeight;
    }

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
      var meta = document.getElementById('sup-material-meta');
      if (!meta || !material) return;
      meta.textContent = 'AI 上下文来源：当前材料「' + (material.source.name || material.title) + '」' + (material.clientId ? '、已关联来访者' : '；未绑定来访者，将作为独立督导保存');
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
      clearStream();
      addNote(resetMessage);
      setMaterialCollapsed(false);
      var host = document.getElementById('sup-context-host');
      if (host) host.innerHTML = '';
      updateMaterialMeta();
      updatePiiChip();
      try { localStorage.removeItem(draftKey); localStorage.removeItem(chatKey); } catch (e) {}
      if (App.setActiveClientId) App.setActiveClientId('');
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

    // 恢复草稿与回复长度
    try { var d = localStorage.getItem(draftKey); if (d) materialTA.value = d; } catch(e){}
    try {
      var savedLength = localStorage.getItem('xj_sup_reply_length');
      var lengthSel = document.getElementById('sup-length');
      if (savedLength && LENGTH_TOKENS[savedLength]) {
        replyLength = savedLength;
        if (lengthSel) lengthSel.value = savedLength;
      }
    } catch (e) {}

    // 脱敏扫描比字数统计重，节流到输入停顿后再跑，避免长逐字稿每敲一个字全量正则
    var piiTimer = null;
    function schedulePiiScan() {
      if (piiTimer) clearTimeout(piiTimer);
      piiTimer = setTimeout(function () { piiTimer = null; updatePiiChip(); }, 400);
    }
    materialTA.addEventListener('input', function () {
      try { localStorage.setItem(draftKey, this.value); } catch(e){}
      updateMaterialMeta();
      schedulePiiScan();
    });
    materialTA.addEventListener('blur', schedulePiiScan);
    updateMaterialMeta();
    updatePiiChip();

    // 历史抽屉：点遮罩或按 Esc 关闭
    var historyMask = document.getElementById('sup-history-mask');
    if (historyMask) {
      historyMask.addEventListener('click', function (event) {
        if (event.target === historyMask) window.toggleHistoryDrawer(false);
      });
    }
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && historyMask && !historyMask.hidden) window.toggleHistoryDrawer(false);
    });

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
      var multiButton = document.getElementById('sup-mode-multi');
      var lock = document.getElementById('sup-mode-multi-lock');
      var allowed = !!(App.canUse && App.canUse('ai-masters'));
      if (multiButton) {
        multiButton.disabled = !allowed;
        multiButton.setAttribute('aria-disabled', String(!allowed));
        multiButton.title = allowed ? '切换到多学派督导' : '多学派督导需要会员权益';
      }
      if (lock) lock.hidden = allowed;
      if (!allowed && multiSchoolMode) setSupervisionMode('standard');
    }
    syncAccessUI();
    updateContextState();
    if (App.onLicenseStateChange) App.onLicenseStateChange(syncAccessUI);

    function multiSchoolFeatureAllowed() {
      return !!(App.canUse && App.canUse('ai-masters'));
    }

    function setMultiSchoolStatus(text, state) {
      var status = document.getElementById('sup-multi-status');
      if (status) { status.textContent = text || ''; status.dataset.state = state || 'idle'; }
    }

    function selectedMultiSchools() {
      return Array.prototype.slice.call(document.querySelectorAll('#sup-multi-schools input[type="checkbox"]:checked'))
        .map(function (input) { return input.value; }).slice(0, 3);
    }

    function renderMultiSchoolResults(result) {
      var host = document.getElementById('sup-multi-results');
      var synthesis = document.getElementById('sup-multi-synthesis');
      var rows = result && (result.schoolResults || result.analyses || result.results) || [];
      if (host) {
        host.innerHTML = rows.length ? rows.map(function (row) {
          var key = row.key || row.schoolKey || '';
          var member = (window.SupervisionSyndicateData && SupervisionSyndicateData.getByKey) ? SupervisionSyndicateData.getByKey(key) : null;
          var name = row.name || (member && member.name) || key || '学派';
          var absent = row.status === 'absent' || row.error;
          var streaming = row.status === 'streaming';
          return '<details class="sup-multi-result" data-state="' + (absent ? 'absent' : (streaming ? 'streaming' : 'ok')) + '" open><summary><span>' + App.escapeHtml(name) + '</span><span class="result-state">' + (absent ? '缺席' : (streaming ? '生成中…' : '已完成')) + '</span></summary><div class="result-body">' + App.escapeHtml(absent ? ('本派本轮未能返回分析：' + (row.error || '调用失败')) : (row.content || row.analysis || '')) + '</div></details>';
        }).join('') : '<div class="sup-multi-empty">暂无逐派结果。</div>';
      }
      var synthesisValue = result && result.synthesis;
      var text = typeof synthesisValue === 'string' ? synthesisValue : (synthesisValue && synthesisValue.content) || (result && (result.combined || result.content)) || '';
      if (synthesis) { synthesis.dataset.state = result && result.error ? 'error' : 'ready'; synthesis.textContent = text || (result && result.error) || '等待综合结果。'; }
    }

    async function runMultiSchool() {
      if (multiSchoolBusy || multiSchoolSaving) return;
      if (!multiSchoolFeatureAllowed()) { if (App.openMembershipGate) App.openMembershipGate('ai-masters'); return; }
      var material = (document.getElementById('sup-multi-material') || {}).value || '';
      material = material.trim();
      if (!material) { App.showToast('请先填写多学派督导材料', 'warning'); return; }
      if (typeof SupervisionSyndicate === 'undefined' || !SupervisionSyndicate.run) { App.showToast('多学派督导模块未就绪', 'error'); return; }
      // 重跑也要先中止上一次：只递增 generation 拦得住终态写回，但旧任务的流式 delta
      // 仍会往综合框里写（放行轮实测：#sup-multi-synthesis 保留上一次综合文本 252–330ms），
      // 且旧请求不会中止、继续消耗额度。
      abortMultiSchoolRun('rerun');
      multiSchoolBusy = true;
      var generation = ++multiSchoolGeneration;
      multiSchoolBusyOwner = generation;
      var controller = new AbortController();
      multiSchoolController = controller;
      multiSchoolResult = null;
      multiSchoolProgressRows = [];
      var runButton = document.getElementById('sup-multi-run');
      var saveButton = document.getElementById('sup-multi-save');
      if (runButton) runButton.disabled = true;
      if (saveButton) saveButton.disabled = true;
      var host = document.getElementById('sup-multi-results');
      if (host) host.innerHTML = '<div class="sup-multi-empty">正在预处理材料并安排学派分析…</div>';
      renderModelNotice(null);
      // DEC-02：记录进入时的降级水位，运行区间内新增的兜底事件才属于本次督导。
      var fallbackWatermark = aiFallbackWatermark();
      setMultiSchoolStatus('分析进行中', 'running');
      var multiContext = null;
      var multiActionRun = null;
      try {
        if (typeof ClinicalContext === 'undefined' || !ClinicalContext.build) throw multiSchoolError('临床上下文模块未就绪', 'XJ_CLINICAL_CONTEXT_UNAVAILABLE');
        multiContext = ClinicalContext.build('supervision-multi-school', { clientId: currentClientId, sessionId: currentSessionId }, { system: '多学派临床督导编排；输出仅为草稿。', inputText: material, instruction: '运行多学派督导并生成对比、分歧与整合建议' });
        if (!multiContext || !multiContext.ok) {
          var admissionCode = (multiContext && multiContext.errorCode) ||
            (multiContext && multiContext.reason === 'task-budget-exceeded' ? 'XJ_TASK_BUDGET_EXCEEDED' : 'XJ_CLINICAL_CONTEXT_INVALID');
          throw multiSchoolError(multiContext && multiContext.reason === 'task-budget-exceeded' ? '材料与已选来源超过当前督导预算，请缩短至允许范围后重试' : '当前上下文无效，请重新选择来访者或材料', admissionCode);
        }
        if (!(await confirmContextSendAsync(multiContext)) || controller.signal.aborted || generation !== multiSchoolGeneration) throw multiSchoolError('用户已取消本次多学派督导', 'ABORTED');
        multiActionRun = ClinicalContext.createActionRun(multiContext);
        if (!multiActionRun) throw multiSchoolError('无法确认材料归属，已取消分析', 'XJ_CLINICAL_SOURCE_NOT_ADMITTED');
        multiSchoolContext = multiContext;
        var result = await SupervisionSyndicate.run({
          material: material,
          schoolKeys: (function () { var selected = selectedMultiSchools(); return selected.length ? selected : null; }()),
          clientId: currentClientId || '',
          sessionId: currentSessionId || '',
          options: { autoSave: false, signal: controller.signal },
          onProgress: function (event) {
            if (!event || controller.signal.aborted || generation !== multiSchoolGeneration) return;
            if (event.type === 'summary') setMultiSchoolStatus((event.failedSegments || []).length ? '材料摘要不完整：第 ' + event.failedSegments.join('、') + ' 段未成功，后续仅供核对' : '已完成材料摘要', (event.failedSegments || []).length ? 'warning' : 'running');
            else if (event.type === 'route') setMultiSchoolStatus('已路由 ' + ((event.schoolKeys || []).length) + ' 个学派', 'running');
            else if (event.type === 'school-start') setMultiSchoolStatus('正在分析：' + (event.name || event.schoolKey || '学派'), 'running');
            else if (event.type === 'school-result') {
              var previousIndex = multiSchoolProgressRows.findIndex(function (item) { return item && item.key === event.schoolKey; });
              if (previousIndex >= 0) multiSchoolProgressRows[previousIndex] = event.result;
              else multiSchoolProgressRows.push(event.result);
              renderMultiSchoolResults({ schoolResults: multiSchoolProgressRows });
              setMultiSchoolStatus('已完成：' + (event.name || event.schoolKey || '学派'), 'running');
            }
          },
          onDelta: function (piece, fullText, stage) {
            if (controller.signal.aborted || generation !== multiSchoolGeneration) return;
            var text = fullText || piece || '';
            if (stage === 'synthesis') {
              var synthesis = document.getElementById('sup-multi-synthesis');
              if (synthesis) { synthesis.dataset.state = 'streaming'; synthesis.textContent = text; }
              return;
            }
            if (stage && stage.indexOf('school:') === 0) {
              var key = stage.slice(7);
              var row = multiSchoolProgressRows.filter(function (item) { return item && item.key === key; })[0];
              if (!row) { row = { key: key, status: 'streaming', content: text }; multiSchoolProgressRows.push(row); }
              else row.content = text;
              renderMultiSchoolResults({ schoolResults: multiSchoolProgressRows });
            }
          },
        });
        if (controller.signal.aborted || generation !== multiSchoolGeneration) throw multiSchoolError('本次多学派督导已取消', 'ABORTED');
        var latestMaterial = (document.getElementById('sup-multi-material') || {}).value || '';
        if (!ClinicalContext.isSnapshotCurrent(multiContext.snapshot, latestMaterial.trim(), { clientId: currentClientId, sessionId: currentSessionId })) {
          ClinicalContext.failActionRun(multiActionRun.id, '上下文已变更', 'stale');
          multiActionRun = null;
          throw multiSchoolError('上下文已变更，旧分析未采用', 'XJ_STALE_CONTEXT');
        }
        multiSchoolResult = result;
        // DEC-02 ②③：本次运行区间内的兜底事实 → 归档溯源字段 + 用户可见提示。
        // 放在写回 DOM 之前，保证「结果对象 / 归档草稿 / 页面」三处同源。
        var runFallbackEvents = aiFallbackEventsSince(fallbackWatermark);
        if (controller.signal.aborted || generation !== multiSchoolGeneration) {
          renderModelNotice(null);
        } else {
          attachFallbackProvenance(multiSchoolResult, runFallbackEvents);
          renderModelNotice(runFallbackEvents);
        }
        renderMultiSchoolResults(result);
        if (result && result.ok) {
          ClinicalContext.completeActionRun(multiActionRun.id, { kind: 'supervision-multi-school', summary: result.synthesis || '', citations: [] });
          setMultiSchoolStatus(runFallbackEvents.length
            ? '综合完成，可归档（本次含内置模型代答，非所选模型结果）'
            : '综合完成，可归档', 'ready');
          if (saveButton) saveButton.disabled = false;
        } else {
          ClinicalContext.failActionRun(multiActionRun.id, (result && result.error) || '多学派督导失败');
          setMultiSchoolStatus('本次督导失败：' + ((result && result.error) || '未获得综合结果'), 'error');
        }
      } catch (error) {
        if (multiActionRun) ClinicalContext.failActionRun(multiActionRun.id, error && error.message ? error.message : '多学派督导失败');
        if (generation === multiSchoolGeneration && !controller.signal.aborted) {
          multiSchoolResult = { ok: false, error: error && error.message ? error.message : '多学派督导失败', errorCode: (error && error.errorCode) || (result && result.errorCode) || 'MULTI_SCHOOL_RUN_FAILED' };
          renderMultiSchoolResults(multiSchoolResult);
          setMultiSchoolStatus('本次督导失败', 'error');
        }
      } finally {
        if (multiSchoolController === controller) multiSchoolController = null;
        // 只有仍持有互斥属主的那次运行才允许解除 busy：否则旧任务收尾会把新任务的
        // 互斥解除掉（放行轮发现的缺陷），重跑期间用户能再点第三次。
        if (multiSchoolBusyOwner === generation) {
          multiSchoolBusy = false;
          multiSchoolBusyOwner = null;
        }
        if (runButton) runButton.disabled = false;
      }
    }

    async function archiveMultiSchool() {
      if (multiSchoolSaving || multiSchoolBusy) return;
      if (!multiSchoolResult || !multiSchoolResult.ok) { App.showToast('请先完成一次多学派督导', 'warning'); return; }
      var currentMaterial = (document.getElementById('sup-multi-material') || {}).value || '';
      if (multiSchoolContext && !ClinicalContext.isSnapshotCurrent(multiSchoolContext.snapshot, currentMaterial.trim(), { clientId: currentClientId, sessionId: currentSessionId })) { App.showToast('材料或来访者已变化，请重新运行多学派督导', 'warning'); return; }
      var saveButton = document.getElementById('sup-multi-save');
      var runButton = document.getElementById('sup-multi-run');
      var draft = multiSchoolResult;
      multiSchoolSaving = true;
      if (saveButton) saveButton.disabled = true;
      if (runButton) runButton.disabled = true;
      var saved = null;
      try {
        if (SupervisionSyndicate.archive) saved = await SupervisionSyndicate.archive(draft, { clientId: currentClientId || '', sessionId: currentSessionId || '', material: currentMaterial });
        else saved = draft.saved;
      } catch (error) { saved = { ok: false, error: error && error.message }; }
      finally { multiSchoolSaving = false; if (saveButton) saveButton.disabled = false; if (runButton) runButton.disabled = false; }
      if (!saved || saved.ok === false) { App.showToast('归档失败：督导草稿已保留，请恢复存储后重试', 'error'); return; }
      draft.archive = saved;
      if (saveButton) saveButton.disabled = true;
      var archivedDegraded = !!(draft.usage && draft.usage.fallback && draft.usage.fallback.usedBuiltinFallback);
      setMultiSchoolStatus(archivedDegraded ? '已归档多学派督导（含内置模型代答标记）' : '已归档多学派督导', 'saved');
      App.showToast(archivedDegraded ? '多学派督导已归档；本次含内置模型代答，实际模型已写入记录' : '多学派督导已归档', 'success');
    }

    function setSupervisionMode(mode) {
      var next = mode === 'multi' ? 'multi' : 'standard';
      if (next === 'multi' && !multiSchoolFeatureAllowed()) { if (App.openMembershipGate) App.openMembershipGate('ai-masters'); return; }
      multiSchoolMode = next === 'multi';
      var standard = document.getElementById('sup-standard-view');
      var multi = document.getElementById('sup-multi-panel');
      var standardButton = document.getElementById('sup-mode-standard');
      var multiButton = document.getElementById('sup-mode-multi');
      if (standard) standard.hidden = multiSchoolMode;
      if (multi) multi.hidden = !multiSchoolMode;
      if (standardButton) standardButton.setAttribute('aria-selected', String(!multiSchoolMode));
      if (multiButton) multiButton.setAttribute('aria-selected', String(multiSchoolMode));
      if (multiSchoolMode) {
        var standardMaterial = document.getElementById('sup-material');
        var multiMaterial = document.getElementById('sup-multi-material');
        if (multiMaterial && !multiMaterial.value && standardMaterial) multiMaterial.value = standardMaterial.value;
      }
    }

    function bindMultiSchoolMode() {
      if (multiSchoolBound) return;
      multiSchoolBound = true;
      var schoolsHost = document.getElementById('sup-multi-schools');
      var list = (window.SupervisionSyndicateData && SupervisionSyndicateData.getSchools) ? SupervisionSyndicateData.getSchools() : [];
      if (schoolsHost) schoolsHost.innerHTML = list.map(function (school) { return '<label class="sup-multi-school"><input type="checkbox" value="' + App.escapeHtml(school.key) + '"><span><b>' + App.escapeHtml(school.name) + '</b><br><small>' + App.escapeHtml(school.school || '') + '</small></span></label>'; }).join('');
      if (schoolsHost) schoolsHost.addEventListener('change', function (event) {
        if (!event.target || event.target.type !== 'checkbox') return;
        if (event.target.checked) {
          var checked = schoolsHost.querySelectorAll('input[type="checkbox"]:checked');
          if (checked.length > 3) { event.target.checked = false; App.showToast('最多选择 3 个学派', 'warning'); }
        }
        var label = event.target.closest ? event.target.closest('.sup-multi-school') : null;
        if (label) label.classList.toggle('selected', !!event.target.checked);
      });
      var standardButton = document.getElementById('sup-mode-standard');
      var multiButton = document.getElementById('sup-mode-multi');
      if (standardButton) standardButton.addEventListener('click', function () { setSupervisionMode('standard'); });
      if (multiButton) multiButton.addEventListener('click', function () { setSupervisionMode('multi'); });
      var runButton = document.getElementById('sup-multi-run'); if (runButton) runButton.addEventListener('click', runMultiSchool);
      var saveButton = document.getElementById('sup-multi-save'); if (saveButton) saveButton.addEventListener('click', archiveMultiSchool);
      var clearButton = document.getElementById('sup-multi-clear'); if (clearButton) clearButton.addEventListener('click', function () {
        if (multiSchoolSaving) { App.showToast('归档进行中，请等待保存结果', 'warning'); return; }
        abortMultiSchoolRun('clear');
      });
      var copyButton = document.getElementById('sup-multi-use-material'); if (copyButton) copyButton.addEventListener('click', function () { var source = document.getElementById('sup-material'); var target = document.getElementById('sup-multi-material'); if (source && target) target.value = source.value; });
      syncAccessUI();
    }
    bindMultiSchoolMode();

    /* ---------- 材料区折叠：生成成功后收成一行摘要 ---------- */
    function setMaterialCollapsed(collapsed) {
      if (!materialSec) return;
      materialSec.classList.toggle('min', !!collapsed);
      var toggle = document.getElementById('sup-material-toggle');
      if (toggle) {
        toggle.setAttribute('aria-expanded', String(!collapsed));
        toggle.textContent = collapsed ? '展开材料' : '收起材料';
      }
      var summary = document.getElementById('sup-material-summary');
      if (summary) summary.hidden = !collapsed;
      if (summary && collapsed) {
        var text = materialTA.value.trim();
        summary.innerHTML = '';
        var head = document.createElement('strong');
        head.textContent = '会谈材料 · ' + text.length + ' 字';
        var preview = document.createElement('span');
        preview.className = 's-preview';
        preview.textContent = text.slice(0, 80) || '（空）';
        summary.appendChild(head);
        summary.appendChild(preview);
      }
      if (!collapsed) materialTA.focus();
    }

    window.toggleMaterialPanel = function () {
      if (!materialSec) return false;
      var collapsed = !materialSec.classList.contains('min');
      setMaterialCollapsed(collapsed);
      return !collapsed;
    };

    function updateMaterialMeta() {
      var meta = document.getElementById('sup-material-meta');
      if (!meta) return;
      var chars = materialTA.value.trim().length;
      var parts = [];
      if (chars) parts.push(chars + ' 字' + (chars > 4000 ? '（建议控制在 4000 字以内，过长会明显降低分析质量）' : ''));
      var material = currentMaterialWorkspace();
      if (material) parts.push('AI 上下文来源：当前材料「' + (material.source.name || material.title) + '」');
      else if (!currentClientId) parts.push('未绑定来访者，将作为独立督导保存');
      meta.textContent = parts.join(' · ');
    }

    /* ---------- 内联脱敏提示：只提示，不拦提交、不加勾选 ---------- */
    var PII_LABELS = {
      PHONE: '电话号码', ID_CARD: '身份证号', EMAIL: '邮箱',
      ACCOUNT: '账号 / 病历号', ADDRESS: '地址', PERSON_NAME: '姓名',
    };
    // DATE / IP_ADDRESS / URL 不纳入：逐字稿里日期极常见，纳入会让提示长期为红而失去意义
    var PII_SHOWN = Object.keys(PII_LABELS);

    function updatePiiChip() {
      var chip = document.getElementById('sup-pii-chip');
      if (!chip) return;
      var text = materialTA.value;
      if (!text.trim()) { chip.hidden = true; chip.textContent = ''; return; }
      var found = [];
      if (typeof XJPIISanitizer !== 'undefined' && XJPIISanitizer.sanitizeText) {
        var scanned = XJPIISanitizer.sanitizeText(text);
        var seen = Object.create(null);
        (scanned.entities || []).forEach(function (item) {
          if (PII_SHOWN.indexOf(item.type) === -1 || seen[item.type]) return;
          seen[item.type] = true;
          found.push(PII_LABELS[item.type]);
        });
      }
      chip.innerHTML = '';
      chip.hidden = false;
      var icon = document.createElement('i');
      icon.setAttribute('data-lucide', found.length ? 'shield-alert' : 'shield-check');
      var label = document.createElement('span');
      if (found.length) {
        chip.dataset.state = 'found';
        label.textContent = '本地脱敏检查：材料里可能还有' + found.join('、') + '。提交前建议先删除或改为代称。';
      } else {
        delete chip.dataset.state;
        label.textContent = '本地脱敏检查：未发现电话号码、身份证号、邮箱、账号、地址或姓名。自动识别可能漏检，仍请人工确认。';
      }
      chip.appendChild(icon);
      chip.appendChild(label);
      if (found.length) {
        var link = document.createElement('a');
        link.href = 'desensitize.html';
        link.textContent = '去文档脱敏 →';
        chip.appendChild(link);
      }
      if (window.IconSystem) window.IconSystem.render(chip);
    }

    /* ---------- 历史抽屉：替代常驻左栏 ---------- */
    window.toggleHistoryDrawer = function (show) {
      var mask = document.getElementById('sup-history-mask');
      var trigger = document.getElementById('open-session-history');
      if (!mask) return false;
      var open = show === undefined ? mask.hidden : !!show;
      mask.hidden = !open;
      if (trigger) trigger.setAttribute('aria-expanded', String(open));
      if (open) {
        var close = document.getElementById('close-session-history');
        if (close) close.focus();
      } else if (trigger) {
        trigger.focus();
      }
      return open;
    };

    // 来访者选择 → 加载会话历史
    window.onClientChange = function () {
      abortMultiSchoolRun('client-switch');
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
        addNote('已自动载入 ' + Store.getClient(cid).name + ' 第' + sessions[0].sessionNumber + '节的逐字稿。点「生成整体印象」开始督导。');
      } else {
        addNote('已选择 ' + Store.getClient(cid).name + '。该来访者暂无逐字稿，请在材料区手动书写。');
      }
      updateMaterialMeta();
      updatePiiChip();
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
      abortMultiSchoolRun('session-switch');
      currentSessionId = s.id;
      materialTA.value = s.transcript || '';
      if (s.soap) materialTA.value += '\n\n--- SOAP ---\nS: ' + (s.soap.subjective||'') + '\nO: ' + (s.soap.objective||'') + '\nA: ' + (s.soap.assessment||'') + '\nP: ' + (s.soap.plan||'');
      var linkedMaterials = Store.getMaterialWorkspacesForSession ? Store.getMaterialWorkspacesForSession(s.clientId, s.id) : [];
      if (linkedMaterials.length) {
        materialTA.value += '\n\n--- 已关联材料来源 ---\n' + linkedMaterials.map(function (m) {
          return '【' + (m.sourceName || m.title) + '】\n' + (m.text || '材料已关联，但暂无可预览文本');
        }).join('\n\n');
      }
      addNote('已载入第' + (s.sessionNumber || '?') + '节材料' + (linkedMaterials.length ? '，含 ' + linkedMaterials.length + ' 份关联材料。' : '。'));
      updateMaterialMeta();
      updatePiiChip();
      // 高亮选中的会话
      document.querySelectorAll('.lh-item').forEach(function (el) { el.classList.remove('active'); });
      var active = document.querySelector('.lh-item[data-id="' + sessionId + '"]');
      if (active) active.classList.add('active');
      // 载入后关掉抽屉，让材料区回到可见位置
      window.toggleHistoryDrawer(false);
      setMaterialCollapsed(false);
    };

    window.continueLastSupervision = function () {
      if (!latestSupervision) return;
      var context = String(latestSupervision.context || latestSupervision.content || '').trim();
      if (context) {
        materialTA.value = context;
        try { localStorage.setItem(draftKey, context); } catch (e) {}
      }
      currentSessionId = latestSupervision.sessionId || ((latestSupervision.sessionIds || [])[0]) || currentSessionId;
      addNote('已恢复上次督导的材料和流派。你可以补充本次材料后再开始分析。');
      setMaterialCollapsed(false);
      updateMaterialMeta();
      updatePiiChip();
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

    /* ---------- 结果流：一次输出 = 一张卡片，按顺序垂直追加 ---------- */
    var EMPTY_STREAM_HTML = '<div class="sup-empty"><span class="big"><i data-lucide="brain-circuit"></i></span>还没有内容。生成整体印象后，结果和每一次追问的回答会按顺序出现在这里。</div>';

    function clearStream() {
      messages = [];
      chat.innerHTML = EMPTY_STREAM_HTML;
      if (askEl) askEl.hidden = true;
      if (window.IconSystem) window.IconSystem.render(chat);
    }

    function dropEmptyHint() {
      var hint = chat.querySelector('.sup-empty');
      if (hint) hint.remove();
    }

    // 把督导正文按【小标题】/ 引用行 / 普通段落分行渲染；全部经 escapeHtml，模型输出永不进 innerHTML
    function renderRich(bodyEl, text) {
      bodyEl.removeAttribute('data-streaming');
      bodyEl.textContent = '';
      String(text || '').split('\n').filter(function (line) { return line !== ''; }).forEach(function (line) {
        var node = document.createElement('p');
        if (line.startsWith('【') && line.endsWith('】')) {
          node.className = 'ab-heading';
        } else if (line.startsWith('"') || line.startsWith('“')) {
          node.className = 'ab-quote';
        }
        node.textContent = line;
        bodyEl.appendChild(node);
      });
      if (!bodyEl.childNodes.length) bodyEl.textContent = '（空）';
    }

    function resultCard(title, badge) {
      dropEmptyHint();
      var block = document.createElement('div');
      block.className = 'analysis-block sup-result';
      var head = document.createElement('div');
      head.className = 'ab-head';
      var titleEl = document.createElement('span');
      titleEl.className = 'ab-title';
      titleEl.textContent = title;
      var badgeEl = document.createElement('span');
      badgeEl.className = 'ab-badge';
      badgeEl.textContent = badge;
      var collapse = document.createElement('button');
      collapse.type = 'button';
      collapse.className = 'sup-collapse';
      collapse.setAttribute('aria-expanded', 'true');
      collapse.textContent = '收起';
      collapse.addEventListener('click', function () {
        var min = block.classList.toggle('min');
        collapse.textContent = min ? '展开' : '收起';
        collapse.setAttribute('aria-expanded', String(!min));
      });
      var body = document.createElement('div');
      body.className = 'ab-body';
      body.setAttribute('data-sup-stream', '');
      head.appendChild(titleEl);
      head.appendChild(badgeEl);
      head.appendChild(collapse);
      block.appendChild(head);
      block.appendChild(body);
      chat.appendChild(block);
      scrollStreamToEnd();
      return block;
    }

    function cardBody(block) { return block.querySelector('[data-sup-stream]'); }

    // 系统提示卡：只说明状态，不进入 messages[]，因此不会污染保存和导出的督导记录
    function addNote(text, title) {
      var block = resultCard(title || '小镜', '提示');
      renderRich(cardBody(block), text);
      return block;
    }

    function addQuestion(text) {
      dropEmptyHint();
      var bubble = document.createElement('div');
      bubble.className = 'msg me';
      bubble.textContent = text;
      chat.appendChild(bubble);
      messages.push({ role: 'user', content: text });
      scrollStreamToEnd();
    }

    function beginResult(title) {
      var block = resultCard(title, 'AI 草稿');
      var body = cardBody(block);
      body.setAttribute('data-streaming', '');
      body.textContent = '思考中…';
      return block;
    }

    function streamInto(block, text) {
      var body = cardBody(block);
      body.setAttribute('data-streaming', '');
      body.textContent = text || '';
    }

    // 卡片转错误态：保留重试与检查模型配置入口，不伪装成成功
    function failResult(block, message, request) {
      lastFailedRequest = request || null;
      block.classList.add('sup-error-card');
      block.classList.remove('min');
      var badge = block.querySelector('.ab-badge');
      if (badge) badge.textContent = '失败';
      var collapse = block.querySelector('.sup-collapse');
      if (collapse) collapse.hidden = true;
      var body = cardBody(block);
      body.removeAttribute('data-streaming');
      body.textContent = '';
      var detail = document.createElement('div');
      detail.className = 'sup-error-detail';
      detail.textContent = message || '模型没有返回结果';
      var actions = document.createElement('div');
      actions.className = 'sup-error-actions';
      var retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'primary';
      retry.setAttribute('data-sup-retry', '');
      retry.textContent = '重试';
      var settings = document.createElement('button');
      settings.type = 'button';
      settings.setAttribute('data-sup-settings', '');
      settings.textContent = '检查模型配置';
      actions.appendChild(retry);
      actions.appendChild(settings);
      body.appendChild(detail);
      body.appendChild(actions);
      scrollStreamToEnd();
    }

    function setCancelledResult(block, message) {
      var body = cardBody(block);
      body.removeAttribute('data-streaming');
      body.textContent = message;
      var badge = block.querySelector('.ab-badge');
      if (badge) badge.textContent = '已取消';
    }

    function currentSystemPrompt() {
      return (typeof Supervisors !== 'undefined' && Supervisors.buildSystemPrompt)
        ? Supervisors.buildSystemPrompt(curOrient)
        : '你是一位心理咨询督导，请用中文回应，语气专业而温暖。';
    }

    function buildMessages(userText, isImpression) {
      var sys = currentSystemPrompt();
      var material = materialTA.value.trim();
      var hist = messages.slice(-12).map(function (m) { return { role: m.role, content: m.content }; });

      var userContent = '';
      if (isImpression) {
        // 完整督导管线（材料识别 → 针对性输出 → 风格 → 开放问题 + 澄清清单）收口到纯核
        userContent = (typeof SupervisionCore !== 'undefined' && SupervisionCore.buildImpressionPrompt)
          ? SupervisionCore.buildImpressionPrompt(material)
          : '以下是临床材料，请基于' + curOrientName + '给出整体印象（个案概念化、核心议题、治疗师功能、值得注意的线索）：\n\n' + material;
      } else {
        userContent = userText;
        if (material) userContent += '\n\n--- 临床材料 ---\n' + material;
      }
      return [{ role: 'system', content: sys }].concat(hist).concat([{ role: 'user', content: userContent }]);
    }

    function callAI(msgs, signal, onDelta) {
      return new Promise(function (resolve) {
        if (typeof AI === 'undefined' || !AI.send) { resolve({ error: 'AI 模块未就绪' }); return; }
        var input = materialTA ? materialTA.value.trim() : '';
        var finalMessage = msgs[msgs.length - 1] || {};
        var context = ClinicalContext.build('supervision-ai', { clientId: currentClientId, sessionId: currentSessionId, materialId: materialId }, { system: (msgs[0] && msgs[0].content) || '', inputText: input, instruction: finalMessage.content || '', history: msgs.slice(1, -1) });
        if (!context.ok) { resolve({ error: '当前上下文无效，请检查材料或关联信息' }); return; }
        if (ClinicalContextView) ClinicalContextView.renderSummary(document.getElementById('sup-context-host') || document.body, context);
        // XJ519-Z4：上下文确认改为异步 DOM 确认，不再使用 window.confirm 同步阻塞。
        confirmContextSendAsync(context).then(function (confirmed) {
          if (!confirmed) { resolve({ error: '用户已取消本次 AI 督导', cancelled: true }); return; }
          var run = ClinicalContext.createActionRun(context);
          if (!run) { resolve({ error: '无法确认材料归属' }); return; }
          AI.send(context.messages, function (res) {
            var currentInput = materialTA ? materialTA.value.trim() : '';
            if (!ClinicalContext.isSnapshotCurrent(context.snapshot, currentInput, { clientId: currentClientId, sessionId: currentSessionId, materialId: materialId })) { ClinicalContext.failActionRun(run.id, '上下文已变更', 'stale'); resolve({ error: '上下文已变更，旧结果未采用' }); return; }
            if (res && res.content && !res.error) {
              ClinicalContext.completeActionRun(run.id, { kind: 'supervision-preview', summary: res.content, citations: [] });
              // DEC-02 ①②：兜底成功也要把降级事实与实际档位带到页面与后续归档。
              resolve(Object.assign({ content: res.content }, degradationOf(res)));
            }
            else { ClinicalContext.failActionRun(run.id, (res && res.error) || '无响应'); resolve({ error: (res && res.error) || '无响应', code: res && res.code, errorCode: res && res.errorCode, interrupted: !!(res && res.interrupted) }); }
          }, lengthOptions({ signal: signal, onDelta: onDelta }));
        });
      });
    }

    // 快捷追问：卡片标题与提示词一一对应，结果直接追加在流里
    var QUICK_ACTIONS = {
      transference: { title: '移情 / 反移情分析', prompt: '请就材料中的移情/反移情议题进行分析。如果信息不足，请提出需要关注的移情线索。' },
      deepen: { title: '深化分析', prompt: '请就材料中的核心议题深化讨论，提出进一步的思考角度与开放式提问。' },
      tech: { title: '技术建议', prompt: '基于材料，请给出具体的技术建议：在接下来的咨询中我应该怎样回应？' },
      polish: { title: '材料润色', prompt: '请在不改变原意的前提下润色以下临床材料的语言，使其更通顺、专业。' },
    };
    // 自由追问与重试时，卡片标题按本轮实际发出的指令反查，避免全部叫「督导回复」
    function titleForPrompt(text) {
      var keys = Object.keys(QUICK_ACTIONS);
      for (var i = 0; i < keys.length; i += 1) {
        if (QUICK_ACTIONS[keys[i]].prompt === text) return QUICK_ACTIONS[keys[i]].title;
      }
      return '督导回复';
    }

    window.generateImpression = function () {
      if (busy) return;
      if (!ensureSupervisionAccess()) return;
      var mat = materialTA.value.trim();
      if (!mat) { App.showToast('请先在材料区填写会谈记录', 'warning'); return; }
      sendToAI('生成整体印象', true);
    };

    window.quickAction = function (kind) {
      if (busy) return;
      if (!ensureSupervisionAccess()) return;
      var action = QUICK_ACTIONS[kind] || QUICK_ACTIONS.deepen;
      if (!materialTA.value.trim()) { App.showToast('请先在材料区填写会谈记录', 'warning'); return; }
      sendToAI(action.prompt, false);
    };

    window.sendSupMsg = function () {
      var text = (input.value || '').trim();
      if (!text || busy) return;
      if (!ensureSupervisionAccess()) return;
      input.value = '';
      sendToAI(text, false);
    };

    window.onLengthChange = function (value) {
      replyLength = LENGTH_TOKENS[value] ? value : 'medium';
      try { localStorage.setItem('xj_sup_reply_length', replyLength); } catch (e) {}
    };

    window.clearMaterial = function () {
      materialTA.value = '';
      try { localStorage.removeItem(draftKey); } catch (e) {}
      updateMaterialMeta();
      updatePiiChip();
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
      var title = isImpression ? '整体印象' : titleForPrompt(text);
      // 印象轮和重试轮不重复插提问气泡
      if (!isImpression && !isRetry) addQuestion(text);
      var block = beginResult(title);
      busy = true;
      // XJ519-Z4：请求期间提供真实的取消动作（AbortController → ai.js 桥接取消），
      // 主线程保持可交互；取消、成功、失败三种终态分开显示。
      var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      activeSupervisionController = controller;
      if (controller) {
        var cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'sup-collapse';
        cancelBtn.setAttribute('data-sup-cancel', '');
        cancelBtn.textContent = '取消生成';
        cancelBtn.addEventListener('click', function () {
          try { if (activeSupervisionController) activeSupervisionController.abort(); } catch (e) { /* 已取消 */ }
        });
        block.querySelector('.ab-head').appendChild(cancelBtn);
      }
      try {
        var msgs = buildMessages(text, isImpression);
        var r = await callAI(msgs, controller ? controller.signal : null, function (piece, fullText) {
          streamInto(block, fullText || piece || '');
          scrollStreamToEnd();
        });
        var cancelBtn2 = block.querySelector('[data-sup-cancel]');
        if (cancelBtn2) cancelBtn2.remove();
        if (r && r.cancelled) {
          setCancelledResult(block, '已取消本次 AI 督导（上下文未发送）。');
        } else if (r && r.code === 'ABORT_ERR') {
          setCancelledResult(block, '已取消生成。');
        } else if (r && !r.error) {
          renderRich(cardBody(block), r.content);
          messages.push({
            role: 'assistant',
            content: r.content,
            // DEC-02 ②：实际使用档位随对话轮一起留痕（页面记录与导出可追溯）
            tier: r.tier || '',
            transportState: r.transportState || '',
            fallback: r.fallback === true,
            warning: r.warning || '',
            requestedTier: r.requestedTier || '',
            originalErrorCode: r.originalErrorCode || '',
          });
          // DEC-02 ③：兜底发生时必须可见（addNote 不进 messages[]，不污染临床记录正文）
          if (r.fallback === true) addNote(degradationNoticeText(r), '内置模型代答提示');
          if (isImpression) {
            // 整体印象出来后，把材料收成一行摘要，将屏幕让给结果和追问
            setMaterialCollapsed(true);
            if (askEl) { askEl.hidden = false; input.focus(); }
          }
        } else {
          failResult(block, '生成失败：' + ((r && r.error) || '未知错误') + '。可重试，或检查当前模型配置。', { text: text, isImpression: !!isImpression });
        }
      } catch (e) {
        var cancelBtn3 = block.querySelector('[data-sup-cancel]');
        if (cancelBtn3) cancelBtn3.remove();
        failResult(block, '执行异常：' + ((e && e.message) || '未知错误') + '。可重试，或检查当前模型配置。', { text: text, isImpression: !!isImpression });
      }
      activeSupervisionController = null;
      busy = false;
    }

    window.saveSup = async function () {
      if (!messages.length) { App.showToast('无内容可保存', 'warning'); return; }
      if (typeof SupervisionCore === 'undefined' || !SupervisionCore.saveSupervision) {
        App.showToast('督导保存通道未就绪，草稿已保留', 'error');
        return;
      }
      // 纯核要求首条为 system；页面 messages[] 只存真实对话轮，此处按需补齐，不改变其形状
      var transcript = [{ role: 'system', content: currentSystemPrompt() }].concat(messages);
      // 绑了来访者但还没有会谈记录时仍要保住 clientId，故不能按 sessionId 有无来推断
      var binding = { clientId: currentClientId || '', id: currentSessionId || '' };
      var saved = null;
      try {
        saved = await SupervisionCore.saveSupervision(curOrient, transcript, materialTA.value.trim(), binding);
      } catch (error) {
        App.showToast('保存失败：督导草稿已保留，请恢复存储后重试', 'error');
        return;
      }
      if (!saved) { App.showToast('保存失败：督导师配置无效，草稿已保留', 'error'); return; }
      if (saved.id && materialId && Store.updateMaterialWorkspace) Store.updateMaterialWorkspace(materialId, { workflow: { supervision: 'completed' }, artifacts: { supervisionId: saved.id } });
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
        idle: '可选择 .txt 或 .docx 报告；读取结果只会写入会谈记录草稿。',
        uploading: '正在打开文件；尚未写入材料或草稿。',
        progress: '正在读取文件内容；尚未写入材料或草稿。',
        success: '报告内容已写入会谈记录区；尚未写入正式督导记录。',
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
      setUploadState('success', '报告「' + operation.file.name + '」已写入会谈记录区；尚未写入正式督导记录。', 100);
      if (typeof App !== 'undefined' && App.showToast) App.showToast('案例报告已载入材料区', 'success');
      setMaterialCollapsed(false);
      updateMaterialMeta();
      updatePiiChip();
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
              addNote('已载入从「撰写报告」带过来的案例报告。点「生成整体印象」，或在下方直接追问深入督导。');
              setMaterialCollapsed(false);
            }
          }
        }
      }
      if (material && material.parseStatus === 'ready') {
        materialTA.value = material.extractedText || '';
        setMaterialCollapsed(false);
      }
      updateMaterialMeta();
      updatePiiChip();
    } catch (e) {}
  },
});
