/* ============================================================
   心镜 v4.2.2 — 快速记录模块（QuickRecord）
   职责：以来访者最小输入快速创建一条临床会谈（durable），并在保存成功后
   提供四个派生后续动作：账务、下次安排、督导、完整记录。
   仅使用 v4.2.1 已验收的 durable API；所有保存/删除成功提示必须发生在
   await 成功后；失败必须保留输入/草稿、旧权威对象与原上下文，并阻止切换。
   v4.3 起在会谈成功后继续保存 Free 手动模板和可选临床任务；跨聚合失败
   保留同一完成包并可重试，绝不删除已成功保存的会谈或伪报全部成功。
   ============================================================ */
(function () {
  'use strict';

  // 模块级状态：幂等锁、草稿、在途标记、原上下文、最近错误。
  // 这些状态使重复点击幂等、失败可恢复、切换可被阻断。
  var state = {
    lockedSessionId: null, // 首次成功创建后锁定，避免重复点击生成重复节次
    draft: null,           // 最近一次输入草稿（失败/中断后可恢复）
    pending: false,        // 是否有保存操作在途
    lastContext: null,     // 原上下文（clientId, date）
    lastError: null,
    completionDraft: null, // 已保存会谈之后尚未完成的模板/任务写入
  };

  function nowISO() {
    try { return new Date().toISOString(); } catch (e) { return '2026-07-21T00:00:00.000Z'; }
  }
  function todayStr() {
    if (App && typeof App.todayStr === 'function') return App.todayStr();
    return nowISO().slice(0, 10);
  }
  function toast(msg, kind) {
    if (App && typeof App.showToast === 'function') App.showToast(msg, kind || 'info');
  }

  function copy(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function normalizeTaskTitles(value) {
    if (value == null) return { ok: true, value: [] };
    if (!Array.isArray(value)) return { ok: false };
    var titles = value.map(function (title) { return typeof title === 'string' ? title.trim() : ''; }).filter(Boolean);
    if (titles.length > 5 || titles.some(function (title) { return title.length > 160; })) return { ok: false };
    return { ok: true, value: titles };
  }

  function templateViewModel() {
    if (typeof SessionTemplateViewModel !== 'undefined') return SessionTemplateViewModel;
    if (typeof window !== 'undefined' && window.SessionTemplateViewModel) return window.SessionTemplateViewModel;
    return null;
  }

  function currentLicenseState(input) {
    if (input && Object.prototype.hasOwnProperty.call(input, 'licenseState')) return input.licenseState;
    try {
      if (App && typeof App.getLicenseState === 'function') return App.getLicenseState();
    } catch (e) {}
    return null;
  }

  function resolveTemplateSelection(input) {
    var templateId = input && input.templateId ? String(input.templateId) : 'manual-session-v1';
    var context = input && input.context === 'supervision' ? 'supervision' : 'individual';
    var vm = templateViewModel();
    if (!vm || typeof vm.createSelection !== 'function') {
      if (templateId !== 'manual-session-v1' || (input && input.customTemplateId)) {
        return { ok: false, code: 'template-boundary-unavailable' };
      }
      return { ok: true, selection: {
        version: 'session-template-selection-v1',
        templateId: 'manual-session-v1',
        tierAtSelection: 'Free',
        context: context,
        appliedAt: nowISO(),
        customTemplateId: '',
      } };
    }
    var result = vm.createSelection(templateId, {
      licenseState: currentLicenseState(input),
      context: context,
      customTemplateId: input && input.customTemplateId,
    });
    if (!result || !result.ok || !result.selection) {
      return { ok: false, code: 'template-selection-invalid', cause: result && result.code ? result.code : 'unknown' };
    }
    return result;
  }

  function taskId(sessionId, index) {
    return 'ct-qr-' + String(sessionId).replace(/[^A-Za-z0-9._:-]/g, '-') + '-' + index + '-' + Math.random().toString(36).slice(2, 8);
  }

  function buildCompletionDraft(session, selection, titles) {
    var appliedAt = nowISO();
    return {
      sessionId: session.id,
      clientId: session.clientId,
      templateSaved: false,
      tasksSaved: false,
      selection: copy(selection),
      tasks: titles.map(function (title, index) {
        return {
          id: taskId(session.id, index),
          clientId: session.clientId,
          originSessionId: session.id,
          title: title,
          status: 'open',
          due: '',
          sourceRefs: ['session:' + session.id],
          target: 'consult-notes.html',
          createdBy: 'manual',
          actionRunId: '',
          createdAt: appliedAt,
          updatedAt: appliedAt,
          completedAt: '',
        };
      }),
    };
  }

  function completionFailure(code, result) {
    state.lastError = {
      code: code,
      message: result && result.error && result.error.message ? result.error.message : 'completion persistence failed',
      cause: result && result.error && result.error.code ? result.error.code : '',
    };
    toast('会谈已保存，模板或待办尚未完成：输入已保留，请重试', 'error');
    return {
      ok: false,
      sessionSaved: true,
      value: Store.getSession(state.lockedSessionId),
      error: state.lastError,
      recoveredDraft: recoverDraft(),
      completionDraft: copy(state.completionDraft),
    };
  }

  async function resumeCompletion(session) {
    var completion = state.completionDraft;
    if (!completion || completion.sessionId !== session.id) {
      return { ok: true, value: session, selection: null, tasks: [] };
    }
    if (!completion.templateSaved) {
      var templateResult;
      try { templateResult = await Store.saveSessionTemplateSelectionDurable(session.id, completion.selection); }
      catch (e) { templateResult = { ok: false, error: { code: 'XJ_QR_TEMPLATE_THROW', message: (e && e.message) || String(e) } }; }
      if (!templateResult || !templateResult.ok) return completionFailure('XJ_QR_TEMPLATE_SAVE_FAILED', templateResult);
      completion.templateSaved = true;
    }
    if (!completion.tasksSaved && completion.tasks.length) {
      var taskResult;
      try { taskResult = await Store.saveClinicalTasksDurable(completion.tasks); }
      catch (e) { taskResult = { ok: false, error: { code: 'XJ_QR_TASK_THROW', message: (e && e.message) || String(e) } }; }
      if (!taskResult || !taskResult.ok) return completionFailure('XJ_QR_TASK_SAVE_FAILED', taskResult);
      completion.tasksSaved = true;
    }
    if (!completion.tasks.length) completion.tasksSaved = true;
    var selection = copy(completion.selection);
    var tasks = copy(completion.tasks);
    state.draft = null;
    state.completionDraft = null;
    state.lastError = null;
    toast('快速记录、模板和待办已保存', 'success');
    return { ok: true, value: session, selection: selection, tasks: tasks };
  }

  // ---------- 核心：快速创建临床会谈 ----------
  async function createQuickRecord(input) {
    if (state.pending) {
      // 并发重复点击：在途时不再发起新写入，保持幂等。
      return { ok: false, error: { code: 'XJ_QR_PENDING', message: 'a save is already in flight' } };
    }
    if (!input || !input.clientId) {
      return { ok: false, error: { code: 'XJ_QR_NO_CLIENT', message: 'clientId required' } };
    }
    var normalizedTitles = normalizeTaskTitles(input.taskTitles);
    if (!normalizedTitles.ok) {
      return { ok: false, error: { code: 'XJ_QR_TASK_INPUT_INVALID', message: 'manual follow-up tasks are invalid' } };
    }
    var selectionResult = resolveTemplateSelection(input);
    if (!selectionResult.ok) {
      return { ok: false, error: { code: 'XJ_QR_TEMPLATE_INPUT_INVALID', message: 'selected session template is unavailable', cause: selectionResult.code || selectionResult.cause || '' } };
    }
    // 幂等：已成功创建并锁定时，直接返回既有会话，不再生成重复节次。
    if (state.lockedSessionId) {
      var existing = Store.getSession(state.lockedSessionId);
      if (existing && state.completionDraft) {
        state.pending = true;
        try { return await resumeCompletion(existing); }
        finally { state.pending = false; }
      }
      if (existing) return { ok: true, value: existing, idempotent: true, selection: null, tasks: [] };
    }

    var sessionId = 'qr-' + String(input.clientId) + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    var payload = {
      id: sessionId,
      clientId: input.clientId,
      date: input.date || todayStr(),
      durationMinutes: typeof input.durationMinutes === 'number' ? input.durationMinutes : 0,
      type: input.type || 'individual',
      recordKind: 'clinical',
      billing: null,
      notes: input.notes || '',
      hasTranscript: !!input.hasTranscript,
      hasSoap: !!input.hasSoap,
      hasDap: !!input.hasDap,
    };
    if (Number(input.sessionNumber) > 0) payload.sessionNumber = Number(input.sessionNumber);
    if (input.transcript) payload.transcript = input.transcript;
    if (input.soap) payload.soap = input.soap;
    if (input.dap) payload.dap = input.dap;

    // 在尝试持久化之前，先保留输入草稿与原上下文（用于失败/中断恢复）。
    state.draft = Object.assign(copy(payload), {
      templateId: selectionResult.selection.templateId,
      customTemplateId: selectionResult.selection.customTemplateId || '',
      taskTitles: normalizedTitles.value.slice(),
    });
    state.lastContext = { clientId: input.clientId, date: payload.date };
    state.pending = true;
    state.lastError = null;

    var result;
    try {
      // 唯一持久化入口：v4.2.1 已验收的 durable API。必须 await。
      result = await Store.createSessionDurable(payload);
    } catch (e) {
      result = { ok: false, error: { code: 'XJ_QR_DURABLE_THROW', message: (e && e.message) || String(e) } };
    } finally {
      state.pending = false;
    }

    if (!result || !result.ok) {
      // 失败：保留草稿/旧权威对象/原上下文，阻止切换，绝不提示“已保存”。
      state.lastError = (result && result.error) || { code: 'XJ_QR_UNKNOWN', message: 'unknown failure' };
      toast('快速记录保存失败：本地草稿已保留，请恢复存储后重试', 'error');
      return { ok: false, error: state.lastError, recoveredDraft: state.draft };
    }

    // 成功：在 await 成功之后才提示“已保存”，并锁定幂等。
    state.lockedSessionId = (result.value && result.value.id) || sessionId;
    var savedSession = result.value || Store.getSession(state.lockedSessionId);
    if (typeof Store.saveSessionTemplateSelectionDurable !== 'function' || typeof Store.saveClinicalTasksDurable !== 'function') {
      state.draft = null;
      toast('快速记录已保存', 'success');
      return { ok: true, value: savedSession, selection: null, tasks: [], legacyCompletion: true };
    }
    state.completionDraft = buildCompletionDraft(savedSession, selectionResult.selection, normalizedTitles.value);
    state.pending = true;
    try { return await resumeCompletion(savedSession); }
    finally { state.pending = false; }
  }

  // ---------- 派生后续动作 1：账务同步 ----------
  async function followUpBilling(session, data) {
    if (!session || !session.id) return { ok: false, error: { code: 'XJ_QR_NO_SESSION', message: 'session required' } };
    var batch = {
      clients: [Store.getClient(session.clientId)].filter(Boolean),
      sessions: [session],
      expenses: (data && data.expenses) || [],
    };
    var result;
    try { result = await Store.saveBillingBatchDurable(batch); }
    catch (e) { result = { ok: false, error: { code: 'XJ_QR_BILLING_THROW', message: (e && e.message) || String(e) } }; }
    if (!result || !result.ok) {
      toast('账务同步失败：请重试', 'error');
      return { ok: false, error: (result && result.error) || {} };
    }
    toast('账务已同步', 'success');
    return { ok: true, value: result.value };
  }

  // ---------- 派生后续动作 2：下次安排（新增预约会谈） ----------
  async function followUpNextSchedule(clientId, data) {
    if (!clientId) return { ok: false, error: { code: 'XJ_QR_NO_CLIENT', message: 'clientId required' } };
    var payload = {
      id: 'qr-appt-' + String(clientId) + '-' + Date.now().toString(36),
      clientId: clientId,
      date: (data && data.date) || todayStr(),
      durationMinutes: 0,
      type: 'individual',
      recordKind: 'appointment',
      billing: null,
      notes: (data && data.notes) || '',
      hasTranscript: false, hasSoap: false, hasDap: false,
    };
    var result;
    try { result = await Store.createSessionDurable(payload); }
    catch (e) { result = { ok: false, error: { code: 'XJ_QR_APPT_THROW', message: (e && e.message) || String(e) } }; }
    if (!result || !result.ok) {
      toast('下次安排保存失败：草稿已保留', 'error');
      return { ok: false, error: (result && result.error) || {} };
    }
    toast('下次安排已创建', 'success');
    return { ok: true, value: result.value };
  }

  // ---------- 派生后续动作 3：督导记录 ----------
  async function followUpSupervision(clientId, data) {
    if (!clientId) return { ok: false, error: { code: 'XJ_QR_NO_CLIENT', message: 'clientId required' } };
    var sv = Object.assign(
      { id: 'qr-sv-' + String(clientId) + '-' + Date.now().toString(36), clientId: clientId, sessionIds: (data && data.sessionIds) || [], createdAt: nowISO() },
      data || {}
    );
    var result;
    try { result = await Store.createSupervisionDurable(sv); }
    catch (e) { result = { ok: false, error: { code: 'XJ_QR_SV_THROW', message: (e && e.message) || String(e) } }; }
    if (!result || !result.ok) {
      toast('督导记录保存失败：草稿已保留', 'error');
      return { ok: false, error: (result && result.error) || {} };
    }
    toast('督导记录已保存', 'success');
    return { ok: true, value: result.value };
  }

  // ---------- 派生后续动作 4：完整记录（补充 SOAP/逐字稿/督导要点） ----------
  async function followUpFullRecord(session, data) {
    if (!session || !session.id) return { ok: false, error: { code: 'XJ_QR_NO_SESSION', message: 'session required' } };
    var full = Object.assign({}, session, data || {}, { id: session.id, clientId: session.clientId, recordKind: 'clinical', updatedAt: nowISO() });
    var result;
    try { result = await Store.updateSessionFull(full); }
    catch (e) { result = { ok: false, error: { code: 'XJ_QR_FULL_THROW', message: (e && e.message) || String(e) } }; }
    if (!result || !result.ok) {
      toast('完整记录保存失败：草稿已保留', 'error');
      return { ok: false, error: (result && result.error) || {} };
    }
    toast('完整记录已保存', 'success');
    return { ok: true, value: result.value };
  }

  // ---------- 重复预约批量创建：任一失败即停止后续写入 ----------
  async function createRecurringSeries(clientId, rule, count) {
    if (!clientId) return { ok: false, error: { code: 'XJ_QR_NO_CLIENT', message: 'clientId required' } };
    var created = [];
    var stopped = false;
    for (var i = 0; i < count; i++) {
      if (stopped) break;
      var date = (rule && rule.startDate) || todayStr();
      var payload = {
        id: 'qr-series-' + String(clientId) + '-' + i + '-' + Date.now().toString(36),
        clientId: clientId,
        date: date,
        durationMinutes: 0,
        type: 'individual',
        recordKind: 'appointment',
        billing: null,
        notes: '',
        hasTranscript: false, hasSoap: false, hasDap: false,
      };
      var result;
      try { result = await Store.createSessionDurable(payload); }
      catch (e) { result = { ok: false, error: { code: 'XJ_QR_SERIES_THROW', message: (e && e.message) || String(e) } }; }
      if (!result || !result.ok) {
        // 中断：停止后续写入；未保存的草稿可恢复。
        stopped = true;
        toast('批量创建已中断：已停止后续写入，未保存的草稿可恢复', 'error');
        return { ok: false, error: (result && result.error) || {}, created: created, stoppedAtIndex: i };
      }
      created.push(result.value);
    }
    toast('批量预约已创建 ' + created.length + ' 条', 'success');
    return { ok: true, created: created };
  }

  // ---------- 切换保护 / 草稿恢复 ----------
  function canSwitchAway() {
    if (state.pending) return { allowed: false, reason: 'pending-save' };
    // 存在未成功持久化的草稿 → 阻断切换，直至恢复或丢弃。
    if (state.draft || state.completionDraft) return { allowed: false, reason: state.completionDraft ? 'pending-completion' : 'unsaved-draft' };
    return { allowed: true };
  }
  function recoverDraft() { return copy(state.draft); }
  function getLastContext() { return state.lastContext; }
  function getLastError() { return state.lastError; }
  function reset() {
    state.lockedSessionId = null;
    state.draft = null;
    state.pending = false;
    state.lastContext = null;
    state.lastError = null;
    state.completionDraft = null;
  }

  window.QuickRecord = {
    createQuickRecord: createQuickRecord,
    followUpBilling: followUpBilling,
    followUpNextSchedule: followUpNextSchedule,
    followUpSupervision: followUpSupervision,
    followUpFullRecord: followUpFullRecord,
    createRecurringSeries: createRecurringSeries,
    canSwitchAway: canSwitchAway,
    recoverDraft: recoverDraft,
    getLastContext: getLastContext,
    getLastError: getLastError,
    reset: reset,
    _state: state,
  };
})();
