/* ============================================================
 * 心镜 XinJing — Agent API 封装层（v1.0.0）
 *
 * 在现有三层架构（agent-core / agent-tools / agent-shell）之上
 * 纯加层封装，提供三档粒度 API：
 *   高级：XJAgent.chat(text, options)        一行调用
 *   中级：XJAgent.createSession(options)     会话式
 *   低级：XJAgent.invokeTool(name, args)     单工具直调
 *
 * 信任模型：Electron 桌面应用内部封装，所有调用方均为应用自身业务代码。
 * 安全目标：防模型误调用写工具，不防同源恶意脚本。
 *
 * 范式：IIFE + window.XJAgent 全局，依赖裸全局 AI/Store/App
 * （与 agent-core.js / agent-tools.js 同范式）。
 * ============================================================ */
'use strict';

(function () {
  // ============================================================
  // 第一部分：基础设施（日志 + 错误码 + 全局并发队列 + 工具元信息 + writeGuard）
  // ============================================================

  // ---------- 版本 ----------
  var VERSION = '1.0.0';

  // ---------- 日志 ----------
  var LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
  var _logLevel = 'info';

  function setLogLevel(level) {
    // P3-1 修复：统一使用 Object.prototype.hasOwnProperty.call 风格
    if (Object.prototype.hasOwnProperty.call(LOG_LEVELS, level)) {
      _logLevel = level;
      log('info', '日志级别已设为 ' + level);
    } else {
      log('warn', '未知日志级别：' + level + '，保持 ' + _logLevel);
    }
  }
  function getLogLevel() { return _logLevel; }

  function log(level, msg) {
    // P3-1 修复：统一使用 Object.prototype.hasOwnProperty.call 风格
    if (!Object.prototype.hasOwnProperty.call(LOG_LEVELS, level)) return;
    if (LOG_LEVELS[level] < LOG_LEVELS[_logLevel]) return;
    var ts = new Date().toISOString().slice(11, 23);
    var prefix = '[XJAgent][' + level.toUpperCase() + '] ' + ts + ' ';
    if (level === 'error' && typeof console !== 'undefined' && console.error) {
      console.error(prefix + msg);
    } else if (level === 'warn' && typeof console !== 'undefined' && console.warn) {
      console.warn(prefix + msg);
    } else if (typeof console !== 'undefined' && console.log) {
      console.log(prefix + msg);
    }
  }

  // ---------- 错误码 ----------
  // 分类前缀：SEC_（安全策略）/ USR_（用户操作）/ SYS_（系统状态）/ MODEL_（模型）/ TOOL_（工具）
  var ERR = {
    // 安全策略：主动拒绝
    SEC_INJECTION_DETECTED: 'SEC_INJECTION_DETECTED',
    SEC_WRITE_DENIED: 'SEC_WRITE_DENIED',
    SEC_TOOL_NOT_ALLOWED: 'SEC_TOOL_NOT_ALLOWED',
    // 用户操作
    USR_CANCELLED: 'USR_CANCELLED',
    USR_CONFIRM_TIMEOUT: 'USR_CONFIRM_TIMEOUT',
    // 系统状态
    SYS_NOT_AVAILABLE: 'SYS_NOT_AVAILABLE',
    SYS_INVALID_STATE: 'SYS_INVALID_STATE',
    SYS_CONCURRENCY_ERROR: 'SYS_CONCURRENCY_ERROR',
    SYS_QUEUE_FULL: 'SYS_QUEUE_FULL',
    SYS_QUEUE_TIMEOUT: 'SYS_QUEUE_TIMEOUT',
    SYS_MAX_STEPS: 'SYS_MAX_STEPS',
    SYS_CONTEXT_OVERFLOW: 'SYS_CONTEXT_OVERFLOW',
    SYS_INTERNAL_ERROR: 'SYS_INTERNAL_ERROR',
    // 模型调用
    MODEL_ERROR: 'MODEL_ERROR',
    MODEL_TIMEOUT: 'MODEL_TIMEOUT',
    MODEL_NETWORK_ERROR: 'MODEL_NETWORK_ERROR',
    // 工具执行
    TOOL_ERROR: 'TOOL_ERROR',
    TOOL_TIMEOUT: 'TOOL_TIMEOUT',
    TOOL_SCHEMA_ERROR: 'TOOL_SCHEMA_ERROR',
    TOOL_MAX_FAILURES: 'TOOL_MAX_FAILURES',
    TOOL_CIRCUIT_OPEN: 'TOOL_CIRCUIT_OPEN'
  };

  // 构造错误返回对象
  function errObj(code, message) {
    return { ok: false, error: message || code, code: code };
  }
  // 构造成功返回对象
  // P2-新6 修复：data 为 falsy 合法值（0/false/''）时不替换为 {}，仅 undefined/null 替换
  function okObj(data) {
    return { ok: true, data: (data === undefined || data === null) ? {} : data };
  }

  // ---------- 宿主全局守卫 ----------
  function getAI() {
    if (typeof AI === 'undefined') return null;
    return AI;
  }
  function getStore() {
    if (typeof Store === 'undefined') return null;
    return Store;
  }
  function getApp() {
    if (typeof App === 'undefined') return null;
    return App;
  }
  function getAgentCore() {
    if (typeof window === 'undefined' || !window.AgentCore) return null;
    return window.AgentCore;
  }
  function getAgentTools() {
    if (typeof window === 'undefined' || !window.AgentTools) return null;
    return window.AgentTools;
  }

  // ---------- 可用性检查 ----------
  function isAvailable() {
    var reason = getAvailabilityReason();
    return reason === null;
  }

  // P2-新3 修复：外部函数调用全部包 try/catch，单点异常不破坏 isAvailable 契约
  function getAvailabilityReason() {
    if (!getAI()) return 'AI 未注入';
    if (!getStore()) return 'Store 未注入';
    if (!getAgentCore()) return 'AgentCore 未注入';
    if (!getAgentTools()) return 'AgentTools 未注入';
    // 授权检查
    var App = getApp();
    if (App && typeof App.aiUnlocked === 'function') {
      try {
        if (!App.aiUnlocked()) return '授权已失效，请重新激活';
      } catch (e) {
        return '授权检查异常：' + (e.message || e);
      }
    }
    // 模型能力检查
    var AI = getAI();
    if (AI && typeof AI.getActiveConfig === 'function' && typeof AI.isToolCapable === 'function') {
      try {
        var cfg = AI.getActiveConfig() || {};
        if (!AI.isToolCapable(cfg.model, cfg.baseUrl)) {
          return '当前模型（' + (cfg.model || '内置') + '）不支持工具调用';
        }
      } catch (e) {
        return '模型能力检查异常：' + (e.message || e);
      }
    }
    return null;
  }

  // ---------- 工具元信息 ----------
  // 读工具（kind=read）默认可用；写工具（非 read）需显式开启
  // P1 修复：原白名单 { write, write-light } 漏掉 kind='config' 等敏感工具，
  //   导致 agent.configure_api 可绕过 writeGuard 改写 API 配置。
  //   改为 default-deny：仅 kind='read' 视为读工具，其余一律视为写工具。
  //   这样新增 kind='config'/'admin'/'destructive' 等自动归入写工具门控。
  var READ_KIND = 'read';

  function listTools(kind) {
    var tools = getAgentTools();
    if (!tools || !tools.TOOL_REGISTRY) return [];
    var result = [];
    var registry = tools.TOOL_REGISTRY;
    for (var name in registry) {
      if (!Object.prototype.hasOwnProperty.call(registry, name)) continue;
      var t = registry[name];
      if (!t || typeof t !== 'object') continue;
      var tKind = t.kind || 'unknown';
      if (kind && tKind !== kind) continue;
      var desc = '';
      if (t.schema && t.schema.function && t.schema.function.description) {
        desc = t.schema.function.description;
      }
      // P3 修复：增加 isWrite 字段，与 isWriteTool 判断一致
      result.push({
        name: name,
        kind: tKind,
        description: desc,
        isWrite: isWriteTool(name)
      });
    }
    return result;
  }

  function getToolSchema(name) {
    var tools = getAgentTools();
    if (!tools || !tools.TOOL_REGISTRY) return null;
    // P2-新4 修复：hasOwnProperty 守卫，防原型属性名误判
    if (!Object.prototype.hasOwnProperty.call(tools.TOOL_REGISTRY, name)) return null;
    var t = tools.TOOL_REGISTRY[name];
    if (!t || typeof t !== 'object') return null;
    return t.schema || null;
  }

  function getToolInternal(name) {
    var tools = getAgentTools();
    if (!tools || !tools.TOOL_REGISTRY) return null;
    // P2-新4 修复：hasOwnProperty 守卫
    if (!Object.prototype.hasOwnProperty.call(tools.TOOL_REGISTRY, name)) return null;
    var t = tools.TOOL_REGISTRY[name];
    return (t && typeof t === 'object') ? t : null;
  }

  // P1 修复：default-deny，非 read 一律视为写工具
  // P2-1 修复：missing kind 也视为写工具（真 default-deny），防遗漏 kind 字段静默绕过
  // P2-5 修复：工具不存在时返回 true（保守视为写工具），与 default-deny 原则一致。
  //   说明：invokeTool 在调用 isWriteTool 前已做存在性检查，此处修正为独立语义正确。
  function isWriteTool(name) {
    var t = getToolInternal(name);
    if (!t) return true; // 未知工具视为写工具，保守拒绝
    var k = t.kind;
    // 严格白名单：仅 'read' 视为读工具，缺失/空/其他值一律视为写工具
    return k !== READ_KIND;
  }

  // ---------- 全局 writeGuard ----------
  // 应用初始化时可设置，所有写工具执行前经过。fail-close（异常默认拒绝）。
  var _writeGuard = null;

  function setWriteGuard(fn) {
    if (typeof fn === 'function' || fn === null) {
      _writeGuard = fn;
      log('info', fn ? '全局 writeGuard 已设置' : '全局 writeGuard 已清除');
    } else {
      log('warn', 'setWriteGuard 参数须为 function 或 null');
    }
  }

  function getWriteGuard() { return _writeGuard; }

  // 执行 writeGuard 检查，返回 true 放行，false 拒绝
  async function checkWriteGuard(toolName, args) {
    if (!_writeGuard) return true; // 未设置守卫，放行
    try {
      var result = await _writeGuard(toolName, args);
      return result === true;
    } catch (e) {
      log('warn', 'writeGuard 执行异常（fail-close 拒绝）：' + (e.message || e));
      return false;
    }
  }

  // ---------- 全局并发队列 ----------
  // 最多 maxConcurrency 个 active session；超出排队；队列上限 maxQueueSize；排队超时 queueTimeout
  // P1-2 修复：_activeSessionIds 用 Object.create(null) 消除原型污染
  //   （否则 sessionId='toString'/'hasOwnProperty' 等会误判为已在执行）
  var _maxConcurrency = 5;
  var _maxQueueSize = 10;
  var _queueTimeout = 60000; // 默认 60s
  var _activeCount = 0;
  var _activeSessionIds = Object.create(null); // 正在执行的 sessionId 集合，防同一 session 获得多个槽位
  var _queue = []; // 元素：{ sessionId, resolve, reject, timer, startTime }

  function setMaxConcurrency(n) {
    // P3-新3 修复：增加整数校验
    if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 50) {
      _maxConcurrency = n;
      log('info', '全局并发上限设为 ' + n);
      // 尝试消费队列
      _drainQueue();
    } else {
      log('warn', 'setMaxConcurrency 参数须为 1-50 的整数');
    }
  }
  function getMaxConcurrency() { return _maxConcurrency; }

  // P2-1 注释：setQueueTimeout 仅对【新入队】的请求生效；
  // 已在队列中等待的请求仍按其入队时的旧 _queueTimeout 触发超时（保持行为可预测）
  // P3-新3 修复：增加整数校验
  function setQueueTimeout(ms) {
    if (typeof ms === 'number' && Number.isInteger(ms) && ms >= 1000 && ms <= 600000) {
      _queueTimeout = ms;
      log('info', '排队超时设为 ' + ms + 'ms（仅对新入队请求生效）');
    } else {
      log('warn', 'setQueueTimeout 参数须为 1000-600000 的整数');
    }
  }
  function getQueueTimeout() { return _queueTimeout; }

  // 申请一个执行槽位。返回 Promise，resolve 后表示获得槽位，可开始执行。
  // 同一 sessionId 同时最多 1 个在执行/排队。
  function acquireSlot(sessionId) {
    return new Promise(function (resolve, reject) {
      // 参数校验（P2-2 修复）
      if (typeof sessionId !== 'string' || !sessionId) {
        reject(errObj(ERR.SYS_INVALID_STATE, 'acquireSlot 参数 sessionId 须为非空字符串'));
        return;
      }
      // 检查该 session 是否正在执行中
      if (_activeSessionIds[sessionId]) {
        reject(errObj(ERR.SYS_CONCURRENCY_ERROR, '该 session 已有请求在执行中'));
        return;
      }
      // 检查该 session 是否已在队列
      for (var i = 0; i < _queue.length; i++) {
        if (_queue[i].sessionId === sessionId) {
          reject(errObj(ERR.SYS_CONCURRENCY_ERROR, '该 session 已有请求在排队中'));
          return;
        }
      }
      // 有空位，立即执行
      if (_activeCount < _maxConcurrency) {
        _activeCount++;
        _activeSessionIds[sessionId] = true;
        log('debug', 'session ' + sessionId + ' 获得槽位（active=' + _activeCount + '/' + _maxConcurrency + '）');
        resolve();
        return;
      }
      // 队列已满
      if (_queue.length >= _maxQueueSize) {
        reject(errObj(ERR.SYS_QUEUE_FULL, '全局排队队列已满（' + _maxQueueSize + '），请稍后重试'));
        return;
      }
      // 入队等待
      var item = {
        sessionId: sessionId,
        resolve: resolve,
        reject: reject,
        startTime: Date.now()
      };
      // 排队超时定时器
      item.timer = setTimeout(function () {
        _removeFromQueue(item);
        reject(errObj(ERR.SYS_QUEUE_TIMEOUT, '排队等待超时（' + _queueTimeout + 'ms）'));
      }, _queueTimeout);
      _queue.push(item);
      log('debug', 'session ' + sessionId + ' 入队（位置 ' + _queue.length + '/' + _maxQueueSize + '）');
    });
  }

  // 释放执行槽位（P1-1 修复：增加槽位持有检查，防重复调用污染 _activeCount）
  function releaseSlot(sessionId) {
    if (!_activeSessionIds[sessionId]) {
      log('warn', 'releaseSlot: session ' + sessionId + ' 未持有槽位，忽略重复释放');
      return;
    }
    delete _activeSessionIds[sessionId];
    _activeCount = Math.max(0, _activeCount - 1);
    log('debug', 'session ' + sessionId + ' 释放槽位（active=' + _activeCount + '/' + _maxConcurrency + '）');
    _drainQueue();
  }

  // 从队列中移除指定 session 的请求（用于 destroy 时清理）
  // P1-1 修复：必须 reject 被移除的 item，否则调用方 await acquireSlot 将永久阻塞
  function removeFromQueueBySession(sessionId) {
    var removed = 0;
    for (var i = _queue.length - 1; i >= 0; i--) {
      if (_queue[i].sessionId === sessionId) {
        var item = _queue[i];
        if (item.timer) clearTimeout(item.timer);
        _queue.splice(i, 1);
        // 显式 reject，避免 Promise 永久 pending
        try {
          item.reject(errObj(ERR.USR_CANCELLED, 'session 已销毁，排队请求被取消'));
        } catch (e) {
          log('warn', 'removeFromQueueBySession reject 异常：' + (e.message || e));
        }
        removed++;
      }
    }
    if (removed) log('debug', '从队列移除 session ' + sessionId + ' 的 ' + removed + ' 个请求');
    return removed;
  }

  // 消费队列：将队首的请求推进执行
  // P0-1 修复：出队执行时必须设置 _activeSessionIds，否则同一 session 可获得多个槽位
  function _drainQueue() {
    while (_queue.length > 0 && _activeCount < _maxConcurrency) {
      var item = _queue.shift();
      if (item.timer) clearTimeout(item.timer);
      // 双重校验：理论上 acquireSlot 已保证不重复入队，此处兜底
      if (_activeSessionIds[item.sessionId]) {
        // 极端情况：等待期间同一 session 已有新请求获得槽位，本次出队作废
        log('warn', '_drainQueue: session ' + item.sessionId + ' 已在执行中，丢弃排队请求');
        // P3-新5 修复：reject 加 try/catch，与 removeFromQueueBySession 保持一致
        try {
          item.reject(errObj(ERR.SYS_CONCURRENCY_ERROR, '该 session 已有请求在执行中'));
        } catch (e) {
          log('warn', '_drainQueue reject 异常：' + (e.message || e));
        }
        continue;
      }
      _activeCount++;
      _activeSessionIds[item.sessionId] = true;
      var waited = Date.now() - item.startTime;
      log('debug', 'session ' + item.sessionId + ' 离开队列开始执行（等待 ' + waited + 'ms）');
      item.resolve();
    }
  }

  function _removeFromQueue(item) {
    var idx = _queue.indexOf(item);
    if (idx >= 0) {
      if (item.timer) clearTimeout(item.timer);
      _queue.splice(idx, 1);
    }
  }

  // ---------- 上下文原子单元工具 ----------
  // 原子单元：单条消息 或 assistant(tool_calls)+后续 tool 消息为一组
  // 用于 maxHistory 上限时按单元丢弃

  // 将 messages 数组按原子单元分组，返回单元数组
  // P2-7 修复：跳过非对象元素（null/undefined 等）
  function splitIntoUnits(messages) {
    if (!Array.isArray(messages)) return [];
    var units = [];
    var i = 0;
    while (i < messages.length) {
      var m = messages[i];
      if (!m || typeof m !== 'object') {
        // 非法元素单独成单元，便于 caller 识别
        units.push([m]);
        i++;
        continue;
      }
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        // assistant(tool_calls) + 后续连续 tool 消息 = 1 个单元
        var unit = [m];
        i++;
        while (i < messages.length && messages[i] && messages[i].role === 'tool') {
          unit.push(messages[i]);
          i++;
        }
        units.push(unit);
      } else {
        units.push([m]);
        i++;
      }
    }
    return units;
  }

  // 按单元上限截断：保留所有 system 在原位置 + 最近 maxUnits 个 nonSystem 单元
  // P2-1 修复：保留 system 在原 messages 中的相对位置，不抽取到开头
  // P2-4 修复：system.length === 0 时也插入截断提示（作为新 system 消息）
  // P2-6 修复：所有返回路径统一为浅拷贝（messages.slice() 或新数组），不返回原引用
  // P2-新2 修复：maxUnits 添加 NaN 校验
  // P2-8 修复：返回的消息对象用 deepClone 深拷贝，避免嵌套属性（tool_calls 等）引用共享
  function trimUnitsByCount(messages, maxUnits) {
    if (!Array.isArray(messages) || messages.length === 0) return Array.isArray(messages) ? messages.slice() : messages;
    if (typeof maxUnits !== 'number' || !Number.isFinite(maxUnits) || maxUnits < 1) {
      // 返回深拷贝数组
      var copyArr = [];
      for (var ci = 0; ci < messages.length; ci++) {
        copyArr.push(deepClone(messages[ci]));
      }
      return copyArr;
    }

    // 收集 nonSystem 消息及其单元分组（保持原顺序）
    var nonSystemMsgs = [];
    for (var k = 0; k < messages.length; k++) {
      var mk = messages[k];
      if (!mk || typeof mk !== 'object') continue;
      if (mk.role !== 'system') nonSystemMsgs.push(mk);
    }
    var units = splitIntoUnits(nonSystemMsgs);
    // 不超限，返回深拷贝
    if (units.length <= maxUnits) {
      var copyArr2 = [];
      for (var ci2 = 0; ci2 < messages.length; ci2++) {
        copyArr2.push(deepClone(messages[ci2]));
      }
      return copyArr2;
    }

    // 决定每个单元是否保留（从尾部贪心取最近 maxUnits 个）
    var keptCount = 0;
    var unitKept = new Array(units.length).fill(false);
    for (var j = units.length - 1; j >= 0; j--) {
      if (keptCount >= maxUnits) break;
      unitKept[j] = true;
      keptCount++;
    }

    // 标记每条 nonSystem 消息是否保留（按单元归属）
    var msgKept = new Array(nonSystemMsgs.length).fill(false);
    var msgPtr = 0;
    for (var u = 0; u < units.length; u++) {
      for (var mi = 0; mi < units[u].length; mi++) {
        msgKept[msgPtr++] = unitKept[u];
      }
    }

    var truncationHint = {
      role: 'system',
      content: '（系统提示：较早的对话历史已被截断以控制上下文长度。如需引用早期内容，请用户重新说明。）'
    };
    var result = [];
    var hintInserted = false;
    var nsIdx = 0;
    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      // P3 修复：过滤非法消息元素（非对象 / null），而非直接保留
      if (!msg || typeof msg !== 'object') {
        log('warn', 'trimUnitsByCount: 跳过非法消息元素（索引 ' + m + '）');
        continue;
      }
      if (msg.role === 'system') {
        result.push(deepClone(msg));
      } else {
        if (msgKept[nsIdx]) {
          result.push(deepClone(msg));
        } else if (!hintInserted) {
          result.push(truncationHint);
          hintInserted = true;
        }
        nsIdx++;
      }
    }
    log('debug', '上下文截断：' + units.length + ' 个单元 → 保留 ' + keptCount + ' 个');
    return result;
  }

  // ---------- HTML 转义 ----------
  // P2-4 修复：补全转义字符（/ 和 `），覆盖更多 HTML 上下文
  function escapeHtml(str) {
    if (typeof str !== 'string') return str;
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/`/g, '&#96;')
      .replace(/\//g, '&#47;');
  }

  // 递归转义对象中所有字符串叶子（P1-2 修复）
  // 用于 'all' 级别：覆盖 messages 中嵌套的 tool_calls[i].function.arguments 等字段
  // P2-3 注释修正：返回的是深拷贝，原对象不受影响；转义后的 messages 仅供展示/存储，
  //   不可再作为模型输入——arguments 字段被转义后 JSON.parse 会抛 SyntaxError（如
  //   '{"k":"v"}' 转义为 '{&quot;k&quot;:&quot;v&quot;}'，不再合法 JSON）。
  // P2-2 修复：增加深度上限 + visited 检测，防循环引用栈溢出
  // P1-新1 修复：数组分支补 depth 检查 + 传递 depth+1（原仅对象分支有，纯嵌套数组可栈溢出）
  var _DEEP_ESCAPE_MAX_DEPTH = 50;
  function deepEscapeStrings(obj, visited, depth) {
    if (typeof obj === 'string') return escapeHtml(obj);
    if (typeof obj === 'number' || typeof obj === 'boolean' || obj === null || obj === undefined) {
      return obj;
    }
    if (obj instanceof Date || obj instanceof RegExp) return obj;
    // 统一深度初始化
    depth = depth || 0;
    // P2-1 修复：fail-close 策略——深度超限时返回安全空值，而非原对象（原对象深层字符串未转义）
    if (depth >= _DEEP_ESCAPE_MAX_DEPTH) {
      log('warn', 'deepEscapeStrings: 超过最大深度 ' + _DEEP_ESCAPE_MAX_DEPTH + '，fail-close 返回安全空值');
      if (Array.isArray(obj)) return [];
      if (obj && typeof obj === 'object') return {};
      return obj;
    }
    visited = visited || new WeakSet();
    if (visited.has(obj)) {
      // P1-2 修复：循环引用 fail-close，返回安全空值（原对象深层字符串未转义，不能返回）
      log('warn', 'deepEscapeStrings: 检测到循环引用，fail-close 返回安全空值');
      if (Array.isArray(obj)) return [];
      return {};
    }
    if (Array.isArray(obj)) {
      visited.add(obj);
      var arr = [];
      for (var i = 0; i < obj.length; i++) arr.push(deepEscapeStrings(obj[i], visited, depth + 1));
      return arr;
    }
    if (obj && typeof obj === 'object') {
      visited.add(obj);
      var out = {};
      for (var k in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
        out[k] = deepEscapeStrings(obj[k], visited, depth + 1);
      }
      return out;
    }
    return obj;
  }

  // 按级别转义
  // level: 'reply-only' | 'all' | 'none'
  // P2-3 修复：level 参数校验，未知值降级为 'all'（保守安全）
  // P2-8 修复：validLevels 用 Object.create(null) 消除原型污染
  var _SANITIZE_LEVELS = Object.create(null);
  _SANITIZE_LEVELS['none'] = true;
  _SANITIZE_LEVELS['reply-only'] = true;
  _SANITIZE_LEVELS['all'] = true;
  function sanitizeByLevel(reply, messages, level) {
    if (!Object.prototype.hasOwnProperty.call(_SANITIZE_LEVELS, level)) {
      log('warn', 'sanitizeByLevel 未知 level：' + level + '，按 all 处理');
      level = 'all';
    }
    if (level === 'none') return { reply: reply, messages: messages };
    var safeReply = (typeof reply === 'string') ? escapeHtml(reply) : reply;
    if (level === 'reply-only') {
      return { reply: safeReply, messages: messages };
    }
    // 'all'：递归转义 reply + messages 中所有字符串叶子
    // P2-新5 修复：非数组但为对象时也递归转义（caller 可能传单个 message 对象）
    var safeMessages;
    if (Array.isArray(messages)) {
      safeMessages = deepEscapeStrings(messages);
    } else if (messages && typeof messages === 'object') {
      safeMessages = deepEscapeStrings(messages);
    } else {
      safeMessages = messages;
    }
    return { reply: safeReply, messages: safeMessages };
  }

  // ---------- 深拷贝 ----------
  // P1-1 修复：递归实现 + 循环引用检测 + 深度限制，比 JSON 序列化更可靠
  //   - 支持：对象、数组、字符串、数字、布尔、null、Date、RegExp
  //   - 不支持：函数、Symbol、WeakMap 等（返回 null，fail-close）
  //   - 循环引用：返回 null（fail-close，不返回共享引用）
  //   - 深度超限：返回 null（fail-close，防栈溢出）
  var _DEEP_CLONE_MAX_DEPTH = 100;
  function deepClone(obj) {
    if (obj === null || obj === undefined) return obj;
    var visited = new WeakMap();
    return _deepCloneInternal(obj, visited, 0);
  }
  function _deepCloneInternal(obj, visited, depth) {
    if (depth > _DEEP_CLONE_MAX_DEPTH) {
      log('warn', 'deepClone: 超过最大深度 ' + _DEEP_CLONE_MAX_DEPTH + '，返回 null（fail-close）');
      return null;
    }
    if (obj === null || obj === undefined) return obj;
    var t = typeof obj;
    if (t === 'string' || t === 'number' || t === 'boolean') return obj;
    if (obj instanceof Date) return new Date(obj.getTime());
    if (obj instanceof RegExp) return new RegExp(obj.source, obj.flags);
    if (t === 'function' || t === 'symbol') {
      log('warn', 'deepClone: 不支持的类型 ' + t + '，返回 null（fail-close）');
      return null;
    }
    if (t !== 'object') return obj;

    // 循环引用检测
    if (visited.has(obj)) {
      log('warn', 'deepClone: 检测到循环引用，返回 null（fail-close）');
      return null;
    }

    if (Array.isArray(obj)) {
      var arr = new Array(obj.length);
      visited.set(obj, arr);
      for (var i = 0; i < obj.length; i++) {
        arr[i] = _deepCloneInternal(obj[i], visited, depth + 1);
      }
      return arr;
    }

    // 普通对象
    var result = {};
    visited.set(obj, result);
    for (var key in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
      result[key] = _deepCloneInternal(obj[key], visited, depth + 1);
    }
    return result;
  }

  // ---------- 超时包裹 ----------
  // 给 Promise 加超时，超时后 reject
  // P2-4/P2-5 修复：参数校验（ms 非负数字、promise 为 thenable）
  function withTimeout(promise, ms, timeoutCode) {
    // 参数校验
    if (typeof ms !== 'number' || ms < 0 || !Number.isFinite(ms)) {
      return Promise.reject(errObj(ERR.SYS_INVALID_STATE, 'withTimeout: ms 须为非负有限数字'));
    }
    if (!promise || typeof promise.then !== 'function') {
      return Promise.reject(errObj(ERR.SYS_INVALID_STATE, 'withTimeout: promise 须为 thenable'));
    }
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) {
          settled = true;
          reject(errObj(timeoutCode || ERR.MODEL_TIMEOUT, '操作超时（' + ms + 'ms）'));
        }
      }, ms);
      promise.then(function (val) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(val);
        }
      }, function (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  // ---------- 唯一 ID 生成 ----------
  // P3-5 修复：_idCounter 接近 Number.MAX_SAFE_INTEGER 时回绕，避免精度丢失
  // P3-2 修复：prefix 类型校验，非字符串强制转为字符串
  var _idCounter = 0;
  var _ID_COUNTER_MAX = 0x7fffffff; // 2^31-1，远低于 MAX_SAFE_INTEGER，留充足安全余量
  function genId(prefix) {
    if (_idCounter >= _ID_COUNTER_MAX) {
      _idCounter = 0;
      log('debug', 'genId: _idCounter 回绕');
    }
    _idCounter++;
    var p = (typeof prefix === 'string' && prefix) ? prefix
           : (prefix == null ? 'id' : String(prefix));
    return p + '_' + Date.now().toString(36) + '_' + _idCounter.toString(36);
  }

  // ============================================================
  // 第二部分：低级 API（invokeTool + schema 校验 + writeGuard + 超时 + 注入检测）
  // ============================================================

  // ---------- JSON Schema 简校验（draft-07 子集） ----------
  // P2-1 / P2-4 修复说明：本函数是 agent-core.js validateSchema 的【增强超集】，
  //   额外增加：
  //   - Array.isArray(args) 顶层守卫（防数组伪装对象）
  //   - spec.maximum / minLength / maxLength / minItems / maxItems 检查
  //   - 嵌套对象 properties 和数组 items 的递归校验（P2-4）
  //   - pattern 字段按 draft-07 标准为纯模式字符串（P2-2）
  //   这些增强是有意的安全加固，不是分叉。
  // 返回 null 表示通过，返回字符串表示错误描述
  function validateSchema(args, schema) {
    if (!schema || !schema.function || !schema.function.parameters) return null;
    var params = schema.function.parameters;
    return _validateValue(args, params, '');
  }

  // 递归校验单个值（P2-4 新增：支持嵌套对象和数组项校验）
  // P1-1 修复：支持多类型 schema（type 为数组，如 ["string", "null"]）
  function _validateValue(value, spec, path) {
    if (!spec || typeof spec !== 'object') return null;

    // null/undefined 处理
    if (value === null || value === undefined) {
      if (value === undefined) return null; // undefined 由 required 检查处理
      // null：检查 type 是否包含 "null"
      // P2 修复：未指定 type 时按 JSON Schema 语义接受所有类型（含 null）
      if (!spec.type) return null;
      var typeArr = Array.isArray(spec.type) ? spec.type : [spec.type];
      if (typeArr.indexOf('null') !== -1) return null;
      return (path || '值') + ' 不能为 null';
    }

    // 检测值的实际 JSON Schema 类型
    var actualType = _getJsonType(value);

    // 期望类型：统一为数组形式
    var expectedTypes = spec.type
      ? (Array.isArray(spec.type) ? spec.type.slice() : [spec.type])
      : null;

    // 未指定 type → 宽松通过（但仍校验枚举等通用约束）
    if (!expectedTypes) {
      return _validateCommonConstraints(value, spec, path);
    }

    // 过滤出值实际匹配的期望类型
    var matchedTypes = [];
    for (var ti = 0; ti < expectedTypes.length; ti++) {
      var et = expectedTypes[ti];
      if (et === 'null') continue; // null 已在上面处理
      if (et === actualType || (et === 'number' && actualType === 'integer')) {
        matchedTypes.push(et);
      }
    }

    if (matchedTypes.length === 0) {
      return (path || '值') + ' 类型错误，期望：' + expectedTypes.join('/') + '，实际：' + actualType;
    }

    // 按匹配的类型逐一校验约束，只要有一个类型完全通过就算通过
    // （JSON Schema 多类型语义：值需满足至少一个类型的所有约束）
    var lastErr = null;
    for (var mi = 0; mi < matchedTypes.length; mi++) {
      var err = _validateByType(value, matchedTypes[mi], spec, path);
      if (err === null) return null; // 有一个类型完全通过
      lastErr = err;
    }
    return lastErr; // 所有匹配类型都不满足约束，返回最后一个错误
  }

  // 检测值的 JSON Schema 类型
  function _getJsonType(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'string') return 'string';
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number') {
      return Number.isInteger(value) ? 'integer' : 'number';
    }
    if (typeof value === 'object') return 'object';
    return typeof value;
  }

  // 通用约束校验（enum）
  function _validateCommonConstraints(value, spec, path) {
    if (Array.isArray(spec.enum) && spec.enum.indexOf(value) === -1) {
      return (path || '值') + ' 须为枚举值之一：' + spec.enum.join('/');
    }
    return null;
  }

  // 按具体类型校验约束
  function _validateByType(value, type, spec, path) {
    var commonErr = _validateCommonConstraints(value, spec, path);
    if (commonErr) return commonErr;

    if (type === 'string') {
      if (typeof value !== 'string') return path + ' 须为字符串';
      if (spec.minLength !== undefined && value.length < spec.minLength)
        return path + ' 长度不能小于 ' + spec.minLength;
      if (spec.maxLength !== undefined && value.length > spec.maxLength)
        return path + ' 长度不能大于 ' + spec.maxLength;
      if (spec.pattern) {
        try {
          var re = new RegExp(spec.pattern);
          if (!re.test(value)) return path + ' 格式不符：' + spec.pattern;
        } catch (e) {
          return path + ' 正则校验异常';
        }
      }
      return null;
    }
    if (type === 'number' || type === 'integer') {
      if (typeof value !== 'number') return path + ' 须为数字';
      if (type === 'integer' && !Number.isInteger(value)) return path + ' 须为整数';
      if (spec.minimum !== undefined && value < spec.minimum) return path + ' 不能小于 ' + spec.minimum;
      if (spec.maximum !== undefined && value > spec.maximum) return path + ' 不能大于 ' + spec.maximum;
      return null;
    }
    if (type === 'boolean') {
      if (typeof value !== 'boolean') return path + ' 须为布尔';
      return null;
    }
    if (type === 'array') {
      if (!Array.isArray(value)) return path + ' 须为数组';
      if (spec.minItems !== undefined && value.length < spec.minItems)
        return path + ' 项数不能小于 ' + spec.minItems;
      if (spec.maxItems !== undefined && value.length > spec.maxItems)
        return path + ' 项数不能大于 ' + spec.maxItems;
      if (spec.items && typeof spec.items === 'object') {
        for (var ai = 0; ai < value.length; ai++) {
          var itemErr = _validateValue(value[ai], spec.items, path + '[' + ai + ']');
          if (itemErr) return itemErr;
        }
      }
      return null;
    }
    if (type === 'object') {
      if (typeof value !== 'object' || Array.isArray(value)) return path + ' 须为对象';
      // required 检查
      if (Array.isArray(spec.required)) {
        for (var ri = 0; ri < spec.required.length; ri++) {
          var rk = spec.required[ri];
          var fpath = path ? path + '.' + rk : rk;
          if (!Object.prototype.hasOwnProperty.call(value, rk) || value[rk] === undefined) {
            return '缺少必填字段：' + fpath;
          }
          // P1-2 修复：required 不拒绝 null——如果 schema 允许 null 类型，null 是合法值
          //   （null 的合法性由该字段的 type 定义校验，不由 required 决定）
        }
      }
      // 递归校验 properties
      if (spec.properties) {
        for (var pk in value) {
          if (!Object.prototype.hasOwnProperty.call(value, pk)) continue;
          if (!Object.prototype.hasOwnProperty.call(spec.properties, pk)) continue;
          var ppath = path ? path + '.' + pk : pk;
          var perr = _validateValue(value[pk], spec.properties[pk], ppath);
          if (perr) return perr;
        }
      }
      // additionalProperties 校验
      if (spec.additionalProperties === false) {
        for (var ek in value) {
          if (!Object.prototype.hasOwnProperty.call(value, ek)) continue;
          if (spec.properties && Object.prototype.hasOwnProperty.call(spec.properties, ek)) continue;
          return '不允许的额外字段：' + (path ? path + '.' + ek : ek);
        }
      }
      return null;
    }
    return null;
  }

  // ---------- 提示注入检测 ----------
  // 与 agent-tools.js 的 INJECTION_RE 保持一致（覆盖中英文常见注入模式）
  // 检测范围：仅对 string 类型参数值做检测，递归遍历对象/数组
  var INJECTION_RE = new RegExp([
    '忽略(?:以上|上述|前述|之前)?(?:指令|规则|提示|设定|约束|system)',
    ' disregard (?:all |any )?previous',
    ' ignore (?:all |any )?previous',
    ' forget (?:everything|all|previous|prior)',
    '你现在是|从现在起你是|act as if you are|pretend you are',
    '新指令|新规则|new instruction|new rule',
    'system\\s*[:：]',
    '\\boverride\\b.*\\b(instructions?|rules?|system)',
    'disregard.*(?:above|prior|previous|instructions?)'
  ].join('|'), 'gi');

  var _INJECTION_MAX_DEPTH = 50;
  var _INJECTION_MAX_STR_LEN = 65536; // 单段最大 64KB
  var _INJECTION_STRIDE = 32768; // 每 32KB 检测一段，保证无长盲区
  // P2-7 修复：全文分段检测，每 _INJECTION_STRIDE 字节采样一段，避免中间盲区
  function _detectInjectionDeep(value, visited, depth) {
    if (typeof value === 'string') {
      // P2-7：长字符串分段检测，每 32KB 一段，段间有重叠确保无盲区
      if (value.length <= _INJECTION_MAX_STR_LEN) {
        INJECTION_RE.lastIndex = 0;
        if (INJECTION_RE.test(value)) return true;
        return false;
      }
      // 分段扫描：stride < maxStrLen 保证段间重叠，无盲区
      // stride=32KB, maxStrLen=64KB → 每段重叠 32KB，注入模式横跨两段边界也一定命中
      var pos = 0;
      while (pos < value.length) {
        var chunk = value.slice(pos, pos + _INJECTION_MAX_STR_LEN);
        INJECTION_RE.lastIndex = 0;
        if (INJECTION_RE.test(chunk)) return true;
        pos += _INJECTION_STRIDE;
      }
      return false;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
      return false;
    }
    if (value instanceof Date || value instanceof RegExp) return false;
    depth = depth || 0;
    // P2-2：深度超限 fail-close，保守拒绝
    // P3-3：使用 >= 语义，最大深度为 _INJECTION_MAX_DEPTH（depth 从 0 计数）
    if (depth >= _INJECTION_MAX_DEPTH) {
      log('warn', '_detectInjectionDeep: 超过最大深度 ' + _INJECTION_MAX_DEPTH + '，fail-close 拒绝');
      return true;
    }
    visited = visited || new WeakSet();
    // P3 修复：循环引用采用 fail-close 策略（与 deepClone/deepEscapeStrings 一致）
    if (visited.has(value)) {
      log('warn', '注入检测遇到循环引用，保守拒绝');
      return true;
    }
    if (Array.isArray(value)) {
      visited.add(value);
      for (var i = 0; i < value.length; i++) {
        if (_detectInjectionDeep(value[i], visited, depth + 1)) return true;
      }
      return false;
    }
    if (value && typeof value === 'object') {
      visited.add(value);
      for (var k in value) {
        if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
        if (_detectInjectionDeep(value[k], visited, depth + 1)) return true;
      }
    }
    return false;
  }

  // 检测 args 中是否含提示注入模式
  // P2-3 修复：支持所有类型参数，不只是对象（字符串、数组等都要检测）
  function detectInjection(args) {
    if (args === null || args === undefined) return false;
    return _detectInjectionDeep(args, new WeakSet(), 0);
  }

  // ---------- 低级 invokeTool ----------
  // 单工具直调，不走模型。安全门控顺序：
  //   1. 可用性检查
  //   2. 工具存在性检查
  //   3. 工具可见性（allowWrite 控制）
  //   4. schema 参数校验
  //   5. 提示注入检测
  //   6. writeGuard（仅写工具）
  //   7. 超时包裹执行 handler
  //
  // options:
  //   allowWrite: boolean      是否允许写工具（默认 false，安全默认）
  //   timeout: number          工具执行超时（默认 10000ms，上限 60000ms）
  //   skipInjectionCheck: bool 跳过注入检测（仅限可信内部调用，默认 false）
  //   args: object             工具参数（必填）
  // 返回：{ ok: true, data } | { ok: false, error, code }
  var _DEFAULT_TOOL_TIMEOUT = 10000;
  var _MAX_TOOL_TIMEOUT = 60000;
  // P2-2 修复：writeGuard 超时兜底，防止 writeGuard 实现缺陷导致 invokeTool 永久 pending
  var _WRITE_GUARD_TIMEOUT = 30000; // 30s，足够用户确认弹窗响应

  // ---------- 工具熔断器 ----------
  // P2-5 新增：单工具连续失败熔断，保护下游服务免于雪崩
  // 规则：连续失败 _CIRCUIT_BREAKER_FAILURE_THRESHOLD 次 → 冷却 _CIRCUIT_BREAKER_COOLDOWN_MS
  var _CIRCUIT_BREAKER_FAILURE_THRESHOLD = 3; // 连续失败阈值
  var _CIRCUIT_BREAKER_COOLDOWN_MS = 60000;   // 冷却时间 60s
  // 每个工具的状态：{ consecutiveFailures: number, cooldownUntil: number }
  var _circuitBreakerState = Object.create(null);

  function _getCircuitState(name) {
    if (!Object.prototype.hasOwnProperty.call(_circuitBreakerState, name)) {
      _circuitBreakerState[name] = { consecutiveFailures: 0, cooldownUntil: 0 };
    }
    return _circuitBreakerState[name];
  }

  function _isCircuitOpen(name) {
    var st = _getCircuitState(name);
    var now = Date.now();
    if (st.cooldownUntil > 0 && now < st.cooldownUntil) {
      return true;
    }
    // 冷却结束，重置冷却标记（失败计数保留，成功一次才清零）
    if (st.cooldownUntil > 0) {
      st.cooldownUntil = 0;
    }
    return false;
  }

  function _recordToolFailure(name) {
    var st = _getCircuitState(name);
    st.consecutiveFailures += 1;
    if (st.consecutiveFailures >= _CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
      st.cooldownUntil = Date.now() + _CIRCUIT_BREAKER_COOLDOWN_MS;
      log('warn', '工具 ' + name + ' 连续失败 ' + st.consecutiveFailures + ' 次，触发熔断，冷却 ' + (_CIRCUIT_BREAKER_COOLDOWN_MS / 1000) + 's');
    }
  }

  function _recordToolSuccess(name) {
    var st = _getCircuitState(name);
    if (st.consecutiveFailures > 0) {
      st.consecutiveFailures = 0;
      st.cooldownUntil = 0;
    }
  }

  // ---------- 工具级并发限制 ----------
  // P2-4 新增：invokeTool 低级 API 也有并发上限，防大量并发调用耗尽底层资源
  // P1-1 修复：基于 token 的槽位追踪，彻底防止重复释放导致的并发超限
  var _MAX_TOOL_CONCURRENCY = 20;
  var _MAX_TOOL_QUEUE_SIZE = 100;
  var _toolActiveTokens = Object.create(null); // tokenId -> true
  var _toolTokenCounter = 0;
  var _TOOL_TOKEN_MAX = 0x7fffffff; // P3 修复：与 genId 一致的回绕上限
  var _toolConcurrencyQueue = [];
  var _TOOL_QUEUE_TIMEOUT = 30000;

  function _getActiveToolCount() {
    var count = 0;
    for (var k in _toolActiveTokens) {
      if (Object.prototype.hasOwnProperty.call(_toolActiveTokens, k)) count++;
    }
    return count;
  }

  // P3 修复：token 计数器回绕函数（与 genId 保持一致的安全策略）
  function _nextToolTokenId() {
    if (_toolTokenCounter >= _TOOL_TOKEN_MAX) {
      _toolTokenCounter = 0;
      log('debug', '_toolTokenCounter 回绕');
    }
    _toolTokenCounter++;
    return 't' + _toolTokenCounter;
  }

  // P3-2 新增：工具级并发配置接口（与全局队列 API 风格统一）
  function setToolConcurrency(n) {
    if (typeof n !== 'number' || n < 1 || n > 100) {
      log('warn', 'setToolConcurrency: 参数须为 1-100 的数字，忽略');
      return;
    }
    _MAX_TOOL_CONCURRENCY = Math.floor(n);
    log('info', '工具级并发上限设为 ' + _MAX_TOOL_CONCURRENCY);
  }
  function getToolConcurrency() { return _MAX_TOOL_CONCURRENCY; }

  function setToolQueueTimeout(ms) {
    if (typeof ms !== 'number' || ms < 1000 || ms > 5 * 60 * 1000) {
      log('warn', 'setToolQueueTimeout: 参数须为 1000-300000ms，忽略');
      return;
    }
    _TOOL_QUEUE_TIMEOUT = ms;
    log('info', '工具级排队超时设为 ' + _TOOL_QUEUE_TIMEOUT + 'ms');
  }
  function getToolQueueTimeout() { return _TOOL_QUEUE_TIMEOUT; }

  function _acquireToolSlot() {
    return new Promise(function (resolve, reject) {
      var activeCount = _getActiveToolCount();
      if (activeCount < _MAX_TOOL_CONCURRENCY) {
        var tokenId = _nextToolTokenId();
        _toolActiveTokens[tokenId] = true;
        resolve(tokenId);
        return;
      }
      if (_toolConcurrencyQueue.length >= _MAX_TOOL_QUEUE_SIZE) {
        reject(errObj(ERR.SYS_QUEUE_FULL, '工具调用队列已满（' + _MAX_TOOL_QUEUE_SIZE + '），请稍后再试'));
        return;
      }
      var timer = setTimeout(function () {
        var idx = _toolConcurrencyQueue.indexOf(item);
        if (idx !== -1) _toolConcurrencyQueue.splice(idx, 1);
        reject(errObj(ERR.SYS_QUEUE_TIMEOUT, '工具调用排队超时（' + _TOOL_QUEUE_TIMEOUT + 'ms）'));
      }, _TOOL_QUEUE_TIMEOUT);
      var item = { resolve: resolve, reject: reject, timeoutTimer: timer };
      _toolConcurrencyQueue.push(item);
    });
  }

  function _releaseToolSlot(tokenId) {
    // P1-1 修复：校验 token 是否存在，不存在则为重复释放，直接忽略并告警
    if (!tokenId || !Object.prototype.hasOwnProperty.call(_toolActiveTokens, tokenId)) {
      log('warn', '_releaseToolSlot: 检测到无效或重复释放，token=' + tokenId);
      return;
    }
    delete _toolActiveTokens[tokenId];

    // 从队列中取下一个
    if (_toolConcurrencyQueue.length > 0) {
      var next = _toolConcurrencyQueue.shift();
      clearTimeout(next.timeoutTimer);
      var newToken = _nextToolTokenId();
      _toolActiveTokens[newToken] = true;
      next.resolve(newToken);
    }
  }

  async function invokeTool(name, options) {
    // P2-3 修复：顶层 try/catch，防未预期异常以 rejected Promise 暴露给调用方
    try {
      return await _invokeToolImpl(name, options);
    } catch (e) {
      log('error', 'invokeTool: 内部异常 ' + (e && e.message ? e.message : e));
      return errObj(ERR.SYS_INTERNAL_ERROR, 'invokeTool 内部异常：' + (e && e.message ? e.message : String(e)));
    }
  }

  async function _invokeToolImpl(name, options) {
    // 1. 可用性检查
    if (!isAvailable()) {
      var reason = getAvailabilityReason() || '不可用';
      return errObj(ERR.SYS_NOT_AVAILABLE, reason);
    }

    // 参数校验
    if (typeof name !== 'string' || !name) {
      return errObj(ERR.SYS_INVALID_STATE, 'invokeTool: name 须为非空字符串');
    }
    options = options || {};
    var args = options.args || {};
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return errObj(ERR.SYS_INVALID_STATE, 'invokeTool: options.args 须为对象');
    }
    var allowWrite = options.allowWrite === true; // 默认 false
    var skipInjectionCheck = options.skipInjectionCheck === true;
    var timeout = (typeof options.timeout === 'number' && Number.isFinite(options.timeout))
      ? options.timeout : _DEFAULT_TOOL_TIMEOUT;
    // P2-5 修复：下限 100ms，防 timeout=0 导致必然超时
    if (timeout < 100) timeout = 100;
    if (timeout > _MAX_TOOL_TIMEOUT) timeout = _MAX_TOOL_TIMEOUT;

    // 2. 工具存在性检查
    var toolInternal = getToolInternal(name);
    if (!toolInternal) {
      return errObj(ERR.SEC_TOOL_NOT_ALLOWED, '工具「' + name + '」不存在');
    }

    // P2-5 新增：熔断器检查（连续失败过多则暂时拒绝）
    if (_isCircuitOpen(name)) {
      var st = _getCircuitState(name);
      var remain = Math.ceil((st.cooldownUntil - Date.now()) / 1000);
      return errObj(ERR.TOOL_CIRCUIT_OPEN, '工具「' + name + '」因连续失败已熔断，剩余冷却 ' + remain + 's');
    }

    // 3. 工具可见性：写工具需显式 allowWrite=true
    var isWrite = isWriteTool(name);
    if (isWrite && !allowWrite) {
      return errObj(ERR.SEC_WRITE_DENIED, '工具「' + name + '」为写工具，需设置 allowWrite=true');
    }

    // 4. schema 参数校验
    var schema = getToolSchema(name);
    if (schema) {
      var schemaErr = validateSchema(args, schema);
      if (schemaErr) {
        return errObj(ERR.TOOL_SCHEMA_ERROR, schemaErr);
      }
    }

    // 5. 提示注入检测（写工具必检；读工具默认也检，除非 skipInjectionCheck=true）
    // P3-2 修复：合并重复逻辑——写工具始终检，读工具按 skipInjectionCheck 决定
    var needInjectCheck = isWrite || !skipInjectionCheck;
    if (needInjectCheck) {
      if (detectInjection(args)) {
        log('warn', 'invokeTool: 检测到提示注入模式，拒绝执行工具 ' + name);
        return errObj(ERR.SEC_INJECTION_DETECTED, '参数中检测到提示注入模式，已拒绝执行');
      }
    }

    // 6. writeGuard（仅写工具，P2-2 修复：加超时兜底防永久 pending）
    if (isWrite) {
      var guardOk;
      try {
        guardOk = await withTimeout(checkWriteGuard(name, args), _WRITE_GUARD_TIMEOUT, ERR.USR_CONFIRM_TIMEOUT);
      } catch (e) {
        if (e && e.code === ERR.USR_CONFIRM_TIMEOUT) {
          log('warn', 'invokeTool: writeGuard 超时（' + _WRITE_GUARD_TIMEOUT + 'ms），拒绝写工具 ' + name);
          return errObj(ERR.USR_CONFIRM_TIMEOUT, 'writeGuard 确认超时（' + _WRITE_GUARD_TIMEOUT + 'ms）');
        }
        log('warn', 'invokeTool: writeGuard 异常：' + (e && e.message ? e.message : e));
        return errObj(ERR.SEC_WRITE_DENIED, 'writeGuard 执行异常');
      }
      if (!guardOk) {
        log('warn', 'invokeTool: writeGuard 拒绝写工具 ' + name);
        return errObj(ERR.SEC_WRITE_DENIED, 'writeGuard 拒绝执行写工具');
      }
    }

    // 7. 调用底层 AgentTools.invoke，包裹超时
    var tools = getAgentTools();
    if (!tools || typeof tools.invoke !== 'function') {
      return errObj(ERR.SYS_INTERNAL_ERROR, 'AgentTools.invoke 不可用');
    }

    // P2-4 新增：工具级并发控制——获取槽位（安全闸门通过后才占用，避免被拒请求占槽）
    var toolSlotToken = null;
    try {
      toolSlotToken = await _acquireToolSlot();
    } catch (e) {
      // 排队超时或队列满
      return e;
    }

    var execPromise;
    try {
      // AgentTools.invoke(name, args) 返回 { ok, data? } | { ok: false, error }
      execPromise = Promise.resolve(tools.invoke(name, args));
    } catch (e) {
      _releaseToolSlot(toolSlotToken);
      log('warn', 'invokeTool: tools.invoke 同步异常：' + (e.message || e));
      return errObj(ERR.TOOL_ERROR, '工具执行同步异常：' + (e.message || e));
    }

    // 注：withTimeout 超时后底层 execPromise 仍会继续执行（JS Promise 不可取消）。
    // P2-3 风险提示：对写工具，超时后 handler 仍可能在后台完成写入。
    //   调用方收到 TOOL_TIMEOUT 后应假定"结果不确定"——写入可能已落库也可能未落库。
    //   建议：写工具 handler 自行实现幂等或可取消机制（如 AbortSignal）。
    //   封装层不强制要求，但通过日志记录写工具超时事件便于追溯。
    // 为避免超时后底层 reject 导致 unhandled rejection，附加 catch 静默吞掉
    // P3-6 说明：空 catch 是有意的——withTimeout 超时后，
    //   底层 execPromise 仍会在后台执行（JS Promise 不可取消）。
    //   如果底层最终 reject，没有这个空 catch 会产生 unhandled rejection 警告。
    //   这个 catch 静默吞掉已超时请求的后续异常，是标准做法。
    execPromise.catch(function () { /* 超时后底层异常已无关，防 unhandled rejection */ });
    if (isWrite && timeout < _DEFAULT_TOOL_TIMEOUT) {
      log('warn', 'invokeTool: 写工具 ' + name + ' 使用了较短超时（' + timeout + 'ms），超时后结果不可信');
    }

    try {
      var result = await withTimeout(execPromise, timeout, ERR.TOOL_TIMEOUT);
      // 判断是否为工具执行失败（ok === false）
      var isToolError = result && typeof result === 'object'
        && Object.prototype.hasOwnProperty.call(result, 'ok')
        && result.ok === false;

      if (isToolError) {
        _recordToolFailure(name);
      } else {
        _recordToolSuccess(name);
      }

      // P3-6 修复：写工具成功执行加审计日志（便于安全追溯）
      if (isWrite && result && typeof result === 'object' && result.ok) {
        log('info', 'invokeTool: 写工具 ' + name + ' 执行成功');
      }
      // 释放工具并发槽位
      _releaseToolSlot(toolSlotToken);
      // 透传 handler 返回的结构：{ ok, data/error }
      if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'ok')) {
        return result;
      }
      // handler 返回非标准结构，包装为 okObj
      return okObj(result);
    } catch (e) {
      // 释放工具并发槽位
      _releaseToolSlot(toolSlotToken);
      // withTimeout 超时或 promise reject → 计入失败熔断
      _recordToolFailure(name);
      if (e && e.code === ERR.TOOL_TIMEOUT) {
        return errObj(ERR.TOOL_TIMEOUT, '工具「' + name + '」执行超时（' + timeout + 'ms）');
      }
      log('warn', 'invokeTool: 工具 ' + name + ' 执行异常：' + (e && e.message ? e.message : e));
      return errObj(ERR.TOOL_ERROR, '工具执行异常：' + (e && e.message ? e.message : String(e)));
    }
  }

  // ============================================================
  // Phase 3: 中级 API — Session 类
  // ============================================================
  // 封装 function-calling 循环，维护会话状态，集成写工具确认、
  // 上下文截断、会话级并发控制、工具熔断。

  var _SESSION_MAX_STEPS = 8;
  var _SESSION_MAX_CONTEXT_UNITS = 30;
  var _SESSION_DEFAULT_IDLE_TIMEOUT = 10 * 60 * 1000; // 默认空闲 10 分钟自动关闭
  var _activeSessions = Object.create(null); // sessionId -> session

  // P2-3 修复：消息匹配函数，找到 newMessages 中与 origMessages 尾部对齐的增量起点
  // 返回值：增量消息的起始索引（>=0），无法匹配返回 -1
  function _findMessageMatchStart(newMessages, origMessages) {
    if (!Array.isArray(newMessages) || !Array.isArray(origMessages)) return -1;
    var origLen = origMessages.length;
    if (origLen === 0) return 0; // 原来无消息，全部都是新增

    // 理想情况：newMessages.length >= origLen 且前 origLen 条与 origMessages 一致
    // 用尾部对齐：从 origMessages 最后一条开始在 newMessages 中找匹配位置
    var lastOrig = origMessages[origLen - 1];
    // 在 newMessages 中从 origLen-1 位置开始向前搜索 lastOrig 的匹配位置
    var searchStart = Math.min(origLen - 1, newMessages.length - 1);
    for (var k = searchStart; k >= 0; k--) {
      if (_messageEqual(newMessages[k], lastOrig)) {
        // 验证从 k 向前是否与 origMessages 尾部连续匹配
        var allMatch = true;
        for (var back = 1; back < origLen && (k - back) >= 0; back++) {
          if (!_messageEqual(newMessages[k - back], origMessages[origLen - 1 - back])) {
            allMatch = false;
            break;
          }
        }
        if (allMatch) {
          // 匹配成功，增量起点 = k + 1
          return k + 1;
        }
      }
    }

    // 尾部匹配失败，尝试从头匹配（runRound 可能截断了历史）
    if (newMessages.length > 0 && _messageEqual(newMessages[0], origMessages[0])) {
      // 头部匹配，找第一个不同的位置
      var idx = 0;
      while (idx < newMessages.length && idx < origLen &&
             _messageEqual(newMessages[idx], origMessages[idx])) {
        idx++;
      }
      return idx;
    }

    return -1;
  }

  // 消息相等判断（基于 role + content 摘要，不比较深层引用）
  function _messageEqual(a, b) {
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    if (a.role !== b.role) return false;
    // content 可能是字符串或数组（多模态），用 JSON.stringify 比较
    try {
      return JSON.stringify(a.content) === JSON.stringify(b.content);
    } catch (e) {
      return false;
    }
  }

  function Session(options) {
    if (!isAvailable()) {
      throw new Error('XJAgent 不可用：' + (getAvailabilityReason() || '未知原因'));
    }
    options = options || {};

    this.id = genId('sess');
    this._messages = [];
    this._closed = false;
    this._running = false;
    this._maxSteps = (typeof options.maxSteps === 'number' && options.maxSteps > 0 && options.maxSteps <= 32)
      ? options.maxSteps : _SESSION_MAX_STEPS;
    this._maxContextUnits = (typeof options.maxContextUnits === 'number' && options.maxContextUnits > 0 && options.maxContextUnits <= 200)
      ? Math.floor(options.maxContextUnits) : _SESSION_MAX_CONTEXT_UNITS;
    this._allowWrite = options.allowWrite === true;
    this._onConfirm = typeof options.onConfirm === 'function' ? options.onConfirm : null;
    this._onMessage = typeof options.onMessage === 'function' ? options.onMessage : null;
    this._onToolCall = typeof options.onToolCall === 'function' ? options.onToolCall : null;
    this._onError = typeof options.onError === 'function' ? options.onError : null;
    this._systemPrompt = typeof options.systemPrompt === 'string' ? options.systemPrompt : null;

    // P2-4 新增：空闲超时自动关闭
    // idleTimeout: 0 表示禁用，正数表示毫秒，默认 10 分钟
    this._idleTimeout = (typeof options.idleTimeout === 'number' && options.idleTimeout >= 0 && options.idleTimeout <= 24 * 60 * 60 * 1000)
      ? options.idleTimeout : _SESSION_DEFAULT_IDLE_TIMEOUT;
    this._idleTimer = null;

    // 系统提示入队
    if (this._systemPrompt) {
      this._messages.push({ role: 'system', content: this._systemPrompt });
    }

    _activeSessions[this.id] = this;
    this._resetIdleTimer();
    log('debug', 'Session ' + this.id + ' 创建');
  }

  // P2-4 新增：重置空闲定时器
  Session.prototype._resetIdleTimer = function () {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    if (this._closed || this._running || this._idleTimeout <= 0) return;
    var self = this;
    this._idleTimer = setTimeout(function () {
      if (!self._closed && !self._running) {
        log('info', 'Session ' + self.id + ' 空闲超时（' + (self._idleTimeout / 1000) + 's），自动关闭');
        self.close();
      }
    }, this._idleTimeout);
  };

  // P2-4 新增：清除空闲定时器
  Session.prototype._clearIdleTimer = function () {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  };

  Session.prototype.getMessages = function () {
    return deepClone(this._messages);
  };

  Session.prototype.clearHistory = function () {
    if (this._closed) return;
    this._messages = this._systemPrompt
      ? [{ role: 'system', content: this._systemPrompt }]
      : [];
  };

  Session.prototype.close = function () {
    if (this._closed) return;
    this._closed = true;
    // P3 修复：关闭时重置 _running 状态，确保后续调用语义准确
    this._running = false;
    // P2-4：关闭时清除空闲定时器
    this._clearIdleTimer();
    // 取消排队中的请求
    if (typeof removeFromQueueBySession === 'function') {
      removeFromQueueBySession(this.id);
    }
    if (_activeSessions[this.id]) {
      delete _activeSessions[this.id];
    }
    log('debug', 'Session ' + this.id + ' 已关闭');
  };

  // Session 级 runRound 超时（5 分钟）
  var _SESSION_RUNROUND_TIMEOUT = 5 * 60 * 1000;

  Session.prototype.send = async function (userMessage) {
    if (this._closed) {
      return errObj(ERR.SYS_INVALID_STATE, '会话已关闭');
    }
    if (this._running) {
      return errObj(ERR.SYS_CONCURRENCY_ERROR, '会话正在处理中，请等待上一条消息完成');
    }
    if (typeof userMessage !== 'string' || !userMessage.trim()) {
      return errObj(ERR.SYS_INVALID_STATE, '消息内容不能为空');
    }

    this._running = true;
    var self = this;
    var hasSlot = false;

    try {
      // 1. 获取会话级并发槽位（每次请求获取-释放，空闲会话不占槽位）
      try {
        await acquireSlot(self.id);
        hasSlot = true;
      } catch (e) {
        return e; // 排队超时或队列满
      }

      // 获取槽位后再次检查 closed（竞态条件：close() 可能在排队期间调用）
      if (self._closed) {
        return errObj(ERR.SYS_INVALID_STATE, '会话已关闭');
      }

      // 2. 添加用户消息
      var userMsg = { role: 'user', content: userMessage };
      self._messages.push(userMsg);
      if (self._onMessage) self._onMessage(deepClone(userMsg));

      // 3. 上下文截断
      self._messages = trimUnitsByCount(self._messages, self._maxContextUnits);

      // 4. 调用底层 runRound
      var agentCore = _getAgentCore();
      if (!agentCore || typeof agentCore.runRound !== 'function') {
        return errObj(ERR.SYS_INTERNAL_ERROR, 'AgentCore.runRound 不可用');
      }

      var onConfirmWrapper = async function (toolCall, args) {
        return self._handleToolConfirm(toolCall, args);
      };
      var onProgressWrapper = function (step, total) {
        log('debug', 'Session ' + self.id + ' 进度：' + step + '/' + total);
      };
      var onEventWrapper = function (event) {
        self._handleCoreEvent(event);
      };

      // P1-2 修复：runRound 超时保护（5 分钟）
      var runRoundPromise = agentCore.runRound(
        deepClone(self._messages),
        onConfirmWrapper,
        onProgressWrapper,
        onEventWrapper
      );
      var result = await withTimeout(
        runRoundPromise,
        _SESSION_RUNROUND_TIMEOUT,
        ERR.MODEL_TIMEOUT
      );

      // 5. 处理结果
      if (result && result.error) {
        if (self._onError) self._onError(result.error);
        return errObj(ERR.MODEL_ERROR, result.error);
      }

      var replyText = (result && result.reply) ? result.reply : '';
      var newMessages = (result && result.messages) ? result.messages : [];

      // 消息历史合并：基于内容匹配找到增量起点，避免脆弱的长度差假设
      if (Array.isArray(newMessages) && newMessages.length > 0) {
        var origLen = self._messages.length;
        // 从 newMessages 中找到与 _messages 尾部匹配的起始位置
        // 策略：从 origLen 位置开始检查，若 newMessages[origLen-1] 与 _messages 尾部不匹配，
        // 向前搜索找最长匹配点
        var matchIdx = _findMessageMatchStart(newMessages, self._messages);
        if (matchIdx >= 0) {
          // 从匹配点之后追加新增消息
          for (var i = matchIdx; i < newMessages.length; i++) {
            var nm = newMessages[i];
            if (!nm || typeof nm !== 'object') continue;
            if (nm.role === 'system') continue;
            self._messages.push(deepClone(nm));
            if (self._onMessage) self._onMessage(deepClone(nm));
          }
        } else {
          // 无法找到匹配点，全量替换（保留 system prompt）
          log('warn', 'Session ' + self.id + '：无法匹配 runRound 返回消息，全量替换');
          var sysPrompt = self._systemPrompt;
          self._messages = [];
          if (sysPrompt) {
            self._messages.push({ role: 'system', content: sysPrompt });
          }
          for (var j = 0; j < newMessages.length; j++) {
            var m = newMessages[j];
            if (!m || typeof m !== 'object') continue;
            if (m.role === 'system') continue;
            self._messages.push(deepClone(m));
          }
        }
      }

      return okObj(replyText);
    } catch (e) {
      // 如果是已知的 errObj（有 code + message），直接返回保留错误码
      if (e && typeof e === 'object' && e.code && typeof e.message === 'string') {
        log('error', 'Session ' + self.id + ' 错误：' + e.code + ' - ' + e.message);
        if (self._onError) self._onError(e.message);
        return e;
      }
      log('error', 'Session ' + self.id + ' 异常：' + (e && e.message ? e.message : e));
      if (self._onError) self._onError(e && e.message ? e.message : String(e));
      return errObj(ERR.SYS_INTERNAL_ERROR, '会话异常：' + (e && e.message ? e.message : String(e)));
    } finally {
      // 统一释放槽位和重置状态
      if (hasSlot) {
        releaseSlot(self.id);
      }
      self._running = false;
      // P2-4：运行结束后重置空闲定时器
      self._resetIdleTimer();
    }
  };

  Session.prototype._handleToolConfirm = async function (toolCall, args) {
    // 关闭状态下拒绝所有工具
    if (this._closed) {
      return { ok: false };
    }

    var toolName = toolCall && toolCall.function ? toolCall.function.name : '';
    var internalName = _wireToInternal(toolName);
    var realName = internalName || toolName;

    // P2 修复：工具存在性校验，不存在的工具直接拒绝
    var toolInfo = getToolInternal(realName);
    if (!toolInfo) {
      log('warn', 'Session ' + this.id + '：工具不存在，拒绝执行 - ' + realName);
      return { ok: false };
    }

    // P2 修复：熔断器检查（与 invokeTool 对齐）
    if (_isCircuitOpen(realName)) {
      log('warn', 'Session ' + this.id + '：工具 ' + realName + ' 熔断中，拒绝执行');
      return { ok: false };
    }

    // P2 修复：schema 参数校验（深度防御，与 invokeTool 对齐）
    var schema = getToolSchema(realName);
    if (schema) {
      var schemaErr = validateSchema(args, schema);
      if (schemaErr) {
        log('warn', 'Session ' + this.id + '：工具 ' + realName + ' schema 校验失败 - ' + schemaErr);
        return { ok: false };
      }
    }

    // 检查是否为写工具
    var isWrite = isWriteTool(realName);

    // P2 修复：写工具参数注入检测（深度防御，与 invokeTool 对齐）
    // P3 修复：去掉 object 类型限制，直接交给 detectInjection 处理所有类型
    if (isWrite) {
      if (detectInjection(args)) {
        log('warn', 'Session ' + this.id + '：写工具 ' + realName + ' 参数中检测到注入模式，拒绝执行');
        return { ok: false };
      }
    }

    // 读工具直接放行
    if (!isWrite) {
      return { ok: true };
    }

    // 写工具需要确认
    if (!this._allowWrite) {
      log('warn', 'Session ' + this.id + '：写工具 ' + realName + ' 被拒绝（allowWrite=false）');
      return { ok: false };
    }

    var CONFIRM_TIMEOUT = 30000; // 30s

    // 优先使用 session 级 onConfirm
    if (this._onConfirm) {
      try {
        var confirmPromise = Promise.resolve(this._onConfirm({
          toolName: realName,
          args: deepClone(args),
          toolCall: deepClone(toolCall)
        }));
        var userResult = await withTimeout(confirmPromise, CONFIRM_TIMEOUT, ERR.USR_CONFIRM_TIMEOUT);
        if (userResult && userResult.ok) {
          return { ok: true };
        }
        return { ok: false };
      } catch (e) {
        if (e && e.code === ERR.USR_CONFIRM_TIMEOUT) {
          log('warn', 'Session ' + this.id + '：onConfirm 超时，拒绝写工具 ' + realName);
        } else {
          log('warn', 'Session ' + this.id + '：onConfirm 异常，拒绝写工具 ' + realName);
        }
        return { ok: false };
      }
    }

    // P3 修复：降级到全局 writeGuard 也使用深拷贝的 args
    try {
      var guardPromise = Promise.resolve(checkWriteGuard(realName, deepClone(args)));
      var guardOk = await withTimeout(guardPromise, CONFIRM_TIMEOUT, ERR.USR_CONFIRM_TIMEOUT);
      if (guardOk) return { ok: true };
      return { ok: false };
    } catch (e) {
      log('warn', 'Session ' + this.id + '：writeGuard 超时/异常，拒绝写工具 ' + realName);
      return { ok: false };
    }
  };

  Session.prototype._handleCoreEvent = function (event) {
    // 关闭状态下忽略所有事件
    if (this._closed) return;
    if (!event || !event.type) return;

    var etype = event.type;

    // 工具开始
    if (etype === 'tool_call' || etype === 'tool_start') {
      if (this._onToolCall) {
        this._onToolCall({
          type: 'start',
          toolName: event.toolName || event.name || '',
          args: deepClone(event.args || {})
        });
      }
      return;
    }

    // 工具结束 —— 根据结果记录熔断器成功/失败（与 invokeTool 语义对齐）
    if (etype === 'tool_end' || etype === 'tool_result') {
      var endName = event.toolName || event.name || '';
      if (endName) {
        var internalEnd = _wireToInternal(endName) || endName;
        // P2 修复：检查 result.ok，业务失败（ok:false）也计入熔断失败
        var endResult = event.result || event.output;
        var isEndError = endResult && typeof endResult === 'object'
          && Object.prototype.hasOwnProperty.call(endResult, 'ok')
          && endResult.ok === false;
        if (isEndError) {
          _recordToolFailure(internalEnd);
        } else {
          _recordToolSuccess(internalEnd);
        }
      }
      if (this._onToolCall) {
        this._onToolCall({
          type: 'end',
          toolName: endName,
          result: deepClone(event.result || event.output || null)
        });
      }
      return;
    }

    // 工具错误 —— 记录熔断器失败
    if (etype === 'tool_error' || etype === 'tool_fail') {
      var errName = event.toolName || event.name || '';
      if (errName) {
        var internalErr = _wireToInternal(errName) || errName;
        _recordToolFailure(internalErr);
      }
      if (this._onToolCall) {
        this._onToolCall({
          type: 'error',
          toolName: errName,
          error: event.error || event.message || '工具执行失败'
        });
      }
      return;
    }

    // 步骤进度
    if (etype === 'step' || etype === 'progress') {
      if (this._onToolCall) {
        this._onToolCall({
          type: 'progress',
          step: event.step || 0,
          total: event.total || 0
        });
      }
      return;
    }
  };

  // 线格式 → 内部工具名映射（与 agent-core.js 的 wireName 对应）
  // P1-3 修复：从注册表构建映射表，避免下划线转点号的歧义
  var _wireToInternalMap = null;
  function _buildWireToInternalMap() {
    if (_wireToInternalMap) return _wireToInternalMap;
    _wireToInternalMap = Object.create(null);
    var registry = _getToolRegistry();
    if (!registry) return _wireToInternalMap;
    for (var name in registry) {
      if (!Object.prototype.hasOwnProperty.call(registry, name)) continue;
      // 与 agent-core.js 的 wireName 规则一致：非字母数字下划线的字符替换为下划线
      var wireName = String(name).replace(/[^A-Za-z0-9_-]/g, '_');
      // P2 修复：检测到冲突时记录 warn 日志
      if (Object.prototype.hasOwnProperty.call(_wireToInternalMap, wireName)) {
        log('warn', '工具线名冲突：' + wireName + ' 同时映射到 ' + _wireToInternalMap[wireName] + ' 和 ' + name + '，保留前者');
      } else {
        _wireToInternalMap[wireName] = name;
      }
    }
    return _wireToInternalMap;
  }

  function _wireToInternal(wireName) {
    if (typeof wireName !== 'string') return null;
    var map = _buildWireToInternalMap();
    if (Object.prototype.hasOwnProperty.call(map, wireName)) {
      return map[wireName];
    }
    // 兜底：直接查注册表（线名与内部名相同的情况）
    var registry = _getToolRegistry();
    if (registry && Object.prototype.hasOwnProperty.call(registry, wireName)) {
      return wireName;
    }
    return null;
  }

  function _getAgentCore() {
    if (typeof window !== 'undefined' && window.AgentCore) return window.AgentCore;
    return null;
  }

  function _getToolRegistry() {
    if (typeof window !== 'undefined' && window.AgentTools && window.AgentTools.TOOL_REGISTRY) {
      return window.AgentTools.TOOL_REGISTRY;
    }
    return null;
  }

  // ============================================================
  // Phase 4: 高级 API
  // ============================================================

  // 单次对话（自动创建临时会话，用完自动关闭）
  async function chat(message, options) {
    if (!isAvailable()) {
      return errObj(ERR.SYS_NOT_AVAILABLE, 'XJAgent 不可用：' + (getAvailabilityReason() || '未知原因'));
    }
    if (typeof message !== 'string' || !message.trim()) {
      return errObj(ERR.SYS_INVALID_STATE, '消息内容不能为空');
    }
    options = options || {};

    // 创建临时会话
    var session;
    try {
      session = new Session(options);
    } catch (e) {
      return errObj(ERR.SYS_INTERNAL_ERROR, '创建会话失败：' + (e && e.message ? e.message : String(e)));
    }

    try {
      var result = await session.send(message);
      return result;
    } finally {
      session.close();
    }
  }

  // 会话管理：列出活动会话
  function listSessions() {
    var result = [];
    for (var id in _activeSessions) {
      if (!Object.prototype.hasOwnProperty.call(_activeSessions, id)) continue;
      var s = _activeSessions[id];
      result.push({
        id: s.id,
        closed: s._closed,
        running: s._running,
        messageCount: s._messages ? s._messages.length : 0
      });
    }
    return result;
  }

  // 会话管理：按 ID 获取会话（返回只读视图，不暴露内部状态）
  function getSession(id) {
    if (!id || !_activeSessions[id]) return null;
    var s = _activeSessions[id];
    // P3-1 修复：返回只读快照，防止调用方直接修改内部状态
    return {
      id: s.id,
      closed: s._closed,
      running: s._running,
      messageCount: s._messages ? s._messages.length : 0,
      // 提供安全的操作方法
      getMessages: function () { return s.getMessages(); },
      close: function () { return s.close(); },
      send: function (msg) { return s.send(msg); },
      clearHistory: function () { return s.clearHistory(); }
    };
  }

  // ============================================================
  // 导出（Phase 1 + Phase 2 + Phase 3 + Phase 4）
  // ============================================================
  if (typeof window !== 'undefined') {
    window.XJAgent = {
      version: VERSION,
      // 日志
      setLogLevel: setLogLevel,
      getLogLevel: getLogLevel,
      // 可用性
      isAvailable: isAvailable,
      getAvailabilityReason: getAvailabilityReason,
      // 工具元信息
      listTools: listTools,
      getToolSchema: getToolSchema,
      // 全局配置
      setMaxConcurrency: setMaxConcurrency,
      getMaxConcurrency: getMaxConcurrency,
      setQueueTimeout: setQueueTimeout,
      getQueueTimeout: getQueueTimeout,
      // P3-2 新增：工具级并发配置
      setToolConcurrency: setToolConcurrency,
      getToolConcurrency: getToolConcurrency,
      setToolQueueTimeout: setToolQueueTimeout,
      getToolQueueTimeout: getToolQueueTimeout,
      // 全局 writeGuard
      setWriteGuard: setWriteGuard,
      getWriteGuard: getWriteGuard,
      // 低级 API（Phase 2）
      invokeTool: invokeTool,
      // 中级 API（Phase 3）
      Session: Session,
      // 高级 API（Phase 4）
      chat: chat,
      createSession: function (options) { return new Session(options); },
      listSessions: listSessions,
      getSession: getSession,
      // 错误码常量（供调用方引用）
      ERR: ERR
    };
  }

  log('info', 'XJAgent v' + VERSION + ' 全部四层 API 已加载（基础设施 + 低级 + 中级 + 高级）');
})();
