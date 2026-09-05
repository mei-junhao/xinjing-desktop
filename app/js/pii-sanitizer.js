/*
 * XinJing local PII sanitizer (MVP)
 *
 * This module is deliberately deterministic and dependency-free. It runs before
 * any AI request leaves the renderer. It is a high-recall safety layer, not a
 * clinical NER model: unknown or ambiguous text must not be treated as safe.
 */
(function exposePiiSanitizer(root, factory) {
  var api = factory();
  if (root) root.XJPIISanitizer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function createPiiSanitizer() {
  'use strict';

  var HIGH_RISK_PATTERNS = [
    { type: 'PHONE', regex: /(?:^|[^\d])(1[3-9]\d{9})(?!\d)/g, group: 1 },
    { type: 'PHONE', regex: /(?:^|[^\d])(0\d{2,3}-?\d{7,8})(?!\d)/g, group: 1 },
    { type: 'EMAIL', regex: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, group: 0 },
    { type: 'ID_CARD', regex: /(?:^|[^\d])(\d{17}[\dXx])(?!\d)/g, group: 1 },
    { type: 'IP_ADDRESS', regex: /(?:^|[^\d])((?:\d{1,3}\.){3}\d{1,3})(?![\d.])/g, group: 1 },
    { type: 'URL', regex: /https?:\/\/[^\s，。；;]+/gi, group: 0 },
    { type: 'DATE', regex: /(?:\d{4}[-\/]\d{1,2}[-\/]\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日)/g, group: 0 },
  ];
  var CONTEXT_PATTERNS = [
    { type: 'ACCOUNT', regex: /(?:账号|帐号|账户|病历号|病例号|个案号|订单号)\s*[:：]?\s*([A-Za-z0-9_-]{6,32})/g, group: 1 },
    { type: 'ACCOUNT', regex: /(?:微信号|微信|QQ号|QQ|qq)\s*[:：]?\s*([A-Za-z][A-Za-z0-9_-]{5,19}|[1-9]\d{4,10})(?![\dA-Za-z_-])/g, group: 1 },
    { type: 'ADDRESS', regex: /(?:家庭住址|住址|地址|居住地)\s*[:：]?\s*([^，。；;\n]{4,60})/g, group: 1 },
    { type: 'PERSON_NAME', regex: /(?:患者姓名|来访者姓名|咨询师姓名|姓名|患者|来访者|咨询师|家属)\s*[:：]?\s*([\u4e00-\u9fff]{2,4})/g, group: 1 },
  ];

  function toText(value) {
    return typeof value === 'string' ? value : String(value == null ? '' : value);
  }

  function addPatternMatches(text, spec, matches) {
    spec.regex.lastIndex = 0;
    var match;
    while ((match = spec.regex.exec(text))) {
      var raw = match[spec.group];
      if (!raw) continue;
      var offset = match[0].indexOf(raw);
      if (offset < 0) continue;
      var start = match.index + offset;
      matches.push({ type: spec.type, start: start, end: start + raw.length, raw: raw });
      if (match[0].length === 0) spec.regex.lastIndex += 1;
    }
  }

  function collectMatches(text, state) {
    var matches = [];
    HIGH_RISK_PATTERNS.forEach(function (spec) { addPatternMatches(text, spec, matches); });
    CONTEXT_PATTERNS.forEach(function (spec) { addPatternMatches(text, spec, matches); });
    (state.known || []).forEach(function (known) {
      var from = 0;
      var index;
      while ((index = text.indexOf(known.raw, from)) !== -1) {
        matches.push({ type: known.type, start: index, end: index + known.raw.length, raw: known.raw, placeholder: known.placeholder });
        from = index + Math.max(known.raw.length, 1);
      }
    });
    return matches.sort(function (a, b) {
      return a.start - b.start || (b.end - b.start) - (a.end - a.start);
    });
  }

  function residualHighRisk(text) {
    var residual = [];
    if (typeof text !== 'string' || !text) return residual;
    HIGH_RISK_PATTERNS.forEach(function (spec) {
      spec.regex.lastIndex = 0;
      var match;
      while ((match = spec.regex.exec(text))) {
        var raw = match[spec.group];
        if (!raw) continue;
        var offset = match[0].indexOf(raw);
        residual.push({ type: spec.type, start: match.index + Math.max(0, offset), length: raw.length });
        if (match[0].length === 0) spec.regex.lastIndex += 1;
      }
    });
    return residual;
  }

  // 残余扫描必须覆盖嵌套结构里的每一个字符串（tool_calls 参数、数组 content 等），
  // 只扫顶层 content 会给“只脱敏了可见文本、嵌套参数仍带原文”的缺陷留出假绿空间。
  function collectStringValues(value, out) {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach(function (item) { collectStringValues(item, out); });
    else if (value && typeof value === 'object') Object.keys(value).forEach(function (key) { collectStringValues(value[key], out); });
    return out;
  }

  function sanitizeText(input, state) {
    var text = toText(input);
    var matches = collectMatches(text, state);
    var accepted = [];
    var end = -1;
    matches.forEach(function (item) {
      if (item.start < end) return;
      accepted.push(item);
      end = item.end;
    });
    var output = text;
    var entities = [];
    for (var i = accepted.length - 1; i >= 0; i -= 1) {
      var item = accepted[i];
      var key = item.type + '\u0000' + item.raw;
      var placeholder = item.placeholder || state.mapping[key];
      if (!placeholder) {
        state.counters[item.type] = (state.counters[item.type] || 0) + 1;
        placeholder = '[[' + item.type + '_' + state.counters[item.type] + ']]';
        state.mapping[key] = placeholder;
        state.known.push({ type: item.type, raw: item.raw, placeholder: placeholder });
      }
      output = output.slice(0, item.start) + placeholder + output.slice(item.end);
      entities.unshift({ type: item.type, start: item.start, end: item.end, placeholder: placeholder });
    }
    return { text: output, entities: entities };
  }

  function sanitizeMessages(messages) {
    if (!Array.isArray(messages)) {
      return { ok: false, code: 'XJ_PII_SANITIZATION_FAILED', messages: [], entities: [], residual: [] };
    }
    var state = { mapping: Object.create(null), counters: Object.create(null), known: [] };
    var allEntities = [];
    function sanitizeContent(value) {
      if (typeof value === 'string') {
        var result = sanitizeText(value, state);
        allEntities = allEntities.concat(result.entities);
        return result.text;
      }
      if (Array.isArray(value)) return value.map(sanitizeContent);
      if (value && typeof value === 'object') {
        var copy = {};
        Object.keys(value).forEach(function (key) {
          if (key === 'id' || key === 'role' || key === 'type' || key === 'tool_call_id' || key === 'name') copy[key] = value[key];
          else copy[key] = sanitizeContent(value[key]);
        });
        return copy;
      }
      return value;
    }
    var safeMessages = messages.map(function (message) {
      if (!message || typeof message !== 'object') return message;
      var copy = {};
      Object.keys(message).forEach(function (key) {
        copy[key] = key === 'role' || key === 'tool_call_id' ? message[key] : sanitizeContent(message[key]);
      });
      return copy;
    });
    // 残余扫描覆盖嵌套结构中的所有字符串（tool_calls 参数、数组 content 等一并检查）
    var residualStrings = [];
    safeMessages.forEach(function (message) {
      if (message && typeof message === 'object') collectStringValues(message, residualStrings);
    });
    var residual = [];
    residualStrings.forEach(function (text) { residual = residual.concat(residualHighRisk(text)); });
    return {
      ok: residual.length === 0,
      code: residual.length ? 'XJ_PII_SANITIZATION_FAILED' : null,
      messages: safeMessages,
      entities: allEntities,
      residual: residual,
    };
  }

  /* ---------- 文档遮蔽模式（不入出站路径） ---------- */

  // 仅文档模式使用的机构规则（不加入 CONTEXT_PATTERNS，保证出站行为零变化）。
  var DOC_ORG_PATTERN = {
    type: 'ORG_NAME',
    regex: /[\u4e00-\u9fa5A-Za-z0-9]{2,14}(?:有限责任公司|股份有限公司|集团有限公司|有限公司|律师事务所)/g,
    group: 0,
  };
  var ORG_SUFFIX_RE = /(?:有限责任公司|股份有限公司|集团有限公司|有限公司|律师事务所)$/;
  // 文档模式专属：银行卡（15-19 位数字，排除 18 位身份证形态）；不加入出站 HIGH_RISK_PATTERNS。
  var DOC_BANK_PATTERN = /(?<!\d)\d(?:[ -]?\d){14,18}(?!\d)/g;
  function docLooksLikeIdCard(value) {
    var digits = String(value).replace(/\D/g, '');
    return digits.length === 18 && /^\d{17}[\dXx]$/.test(digits);
  }

  function maskMiddle(value, left, right) {
    if (value.length <= left + right) return value;
    return value.slice(0, left) + '****' + value.slice(value.length - right);
  }

  function maskValue(type, value) {
    var compact = String(value).replace(/\s+/g, '');
    switch (type) {
      case 'PHONE': {
        var digits = compact.replace(/\D/g, '');
        if (digits.indexOf('86') === 0 && digits.length === 13) digits = digits.slice(2);
        if (digits.length >= 7) return digits.slice(0, 3) + '****' + digits.slice(-4);
        return maskMiddle(compact, 2, 2);
      }
      case 'EMAIL': {
        var at = value.indexOf('@');
        if (at > 0) {
          var local = value.slice(0, at);
          return local.slice(0, local.length > 2 ? 2 : 1) + '***' + value.slice(at);
        }
        return maskMiddle(compact, 2, 2);
      }
      case 'ID_CARD':
        return maskMiddle(compact, 3, 4);
      case 'BANK_CARD':
        return maskMiddle(compact.replace(/\D/g, '') || compact, 6, 4);
      case 'IP_ADDRESS': {
        var parts = value.split('.');
        if (parts.length === 4) return parts[0] + '.***.***.' + parts[3];
        return maskMiddle(compact, 2, 2);
      }
      case 'ADDRESS':
        // JS 版检测的捕获组不含「住址：」等角色前缀（前缀留在原文中），替换体只给「某地址」
        return '某地址';
      case 'DATE':
        return /出生\s*$/.test(value) ? '****年**月**日出生' : '****年**月**日';
      case 'ACCOUNT':
        return maskMiddle(compact, 2, 2);
      case 'PERSON_NAME': {
        var compactName = String(value).replace(/\s+/g, '');
        if (compactName.length <= 1) return compactName;
        var masked = compactName[0];
        for (var ci = 1; ci < compactName.length; ci++) masked += '某';
        return masked;
      }
      case 'ORG_NAME':
        return '某' + '公司';
      case 'URL': {
        var slash = value.indexOf('://');
        return slash > 0 ? value.slice(0, slash + 3) + '***' : '***';
      }
      default:
        return maskMiddle(compact, 2, 2);
    }
  }

  function buildPreview(value) {
    var compact = String(value).replace(/\s+/g, '');
    if (compact.length <= 2) return compact[0] + '*';
    return compact[0] + '***' + compact[compact.length - 1];
  }

  function paragraphOf(text, index) {
    var before = text.slice(0, index);
    var n = before.split(/\n{2,}/).length;
    return '正文 · 第 ' + n + ' 段';
  }

  function collectDocMatches(text) {
    var matches = [];
    HIGH_RISK_PATTERNS.forEach(function (spec) {
      spec.regex.lastIndex = 0;
      var m;
      while ((m = spec.regex.exec(text))) {
        var raw = m[spec.group];
        if (!raw || raw.indexOf('*') >= 0) continue;
        var offset = m[0].indexOf(raw);
        if (offset < 0) continue;
        matches.push({ type: spec.type, start: m.index + offset, end: m.index + offset + raw.length, raw: raw, score: 0.95 });
        if (m[0].length === 0) spec.regex.lastIndex += 1;
      }
    });
    CONTEXT_PATTERNS.forEach(function (spec) {
      spec.regex.lastIndex = 0;
      var m;
      while ((m = spec.regex.exec(text))) {
        var raw2 = m[spec.group];
        if (!raw2) continue;
        var offset2 = m[0].indexOf(raw2);
        if (offset2 < 0) continue;
        var type2 = spec.type === 'PERSON_NAME' ? 'PERSON_NAME' : spec.type;
        matches.push({ type: type2, start: m.index + offset2, end: m.index + offset2 + raw2.length, raw: raw2, score: type2 === 'PERSON_NAME' ? 0.95 : 0.9 });
        if (m[0].length === 0) spec.regex.lastIndex += 1;
      }
    });
    DOC_BANK_PATTERN.lastIndex = 0;
    var bm;
    while ((bm = DOC_BANK_PATTERN.exec(text))) {
      var bankRaw = bm[0];
      var bankDigits = bankRaw.replace(/\D/g, '');
      if (bankDigits.length < 15 || docLooksLikeIdCard(bankRaw)) continue;
      matches.push({ type: 'BANK_CARD', start: bm.index, end: bm.index + bankRaw.length, raw: bankRaw, score: 0.8 });
    }
    DOC_ORG_PATTERN.regex.lastIndex = 0;
    var om;
    while ((om = DOC_ORG_PATTERN.regex.exec(text))) {
      // 修剪贪婪匹配吞掉的前导虚词（在/的/与/和/由…），避免替换时吃掉句子成分
      var orgRaw = om[0];
      var trimmed = 0;
      var STOP = /^(?:在|的|与|和|及|或|由|从|向|至|到|是|于|会|等|为|对|把|被|让|使|向)/;
      while (true) {
        var t = orgRaw.match(STOP);
        if (!t || orgRaw.length - t[0].length < 6) break; // 保留最短机构名长度
        orgRaw = orgRaw.slice(t[0].length);
        trimmed += t[0].length;
      }
      if (ORG_SUFFIX_RE.test(orgRaw)) {
        matches.push({ type: 'ORG_NAME', start: om.index + trimmed, end: om.index + om[0].length, raw: orgRaw, score: 0.88 });
      }
    }
    // 重叠去重：位置优先、长 span 优先、高置信度优先（与出站去重同口径）
    matches.sort(function (a, b) { return a.start - b.start || (b.end - b.start) - (a.end - a.start) || b.score - a.score; });
    var kept = [];
    var cursorEnd = -1;
    matches.forEach(function (item) {
      if (item.start < cursorEnd) return;
      kept.push(item);
      cursorEnd = item.end;
    });
    return kept;
  }

  function maskDocument(text, options) {
    options = options || {};
    if (typeof text !== 'string' || !text.trim()) {
      return { ok: false, code: 'XJ_MASK_EMPTY_INPUT', text: text, report: null };
    }
    var documentName = String(options.documentName || '未命名文档');
    var matches = collectDocMatches(text);
    // 主体代称稳定性：同一原文 → 同一代称；机构简称（为更长机构名的后缀子串）归并到同一代称。
    var tokenByOriginal = Object.create(null);
    var orgMatches = matches.filter(function (m) { return m.type === 'ORG_NAME'; });
    orgMatches.forEach(function (m) {
      m._suffix = (m.raw.match(ORG_SUFFIX_RE) || [''])[0];
    });
    orgMatches.forEach(function (shortM) {
      orgMatches.forEach(function (longM) {
        if (shortM === longM || shortM._merged) return;
        if (longM.raw.length > shortM.raw.length &&
            longM._suffix === shortM._suffix &&
            longM.raw.indexOf(shortM.raw) >= 0 &&
            longM.raw.indexOf(shortM.raw) + shortM.raw.length === longM.raw.length) {
          shortM._merged = longM; // 简称归并到全称
        }
      });
    });
    var orgRoot = function (m) { var root = m; while (root._merged) root = root._merged; return root; };

    var output = text;
    var findings = [];
    var entityCounts = Object.create(null);
    var tokenCounters = Object.create(null);
    // 从后往前替换，保证 start/end 偏移有效
    for (var i = matches.length - 1; i >= 0; i -= 1) {
      var item = matches[i];
      var replacement;
      if (item.type === 'ORG_NAME') {
        var root = orgRoot(item);
        replacement = tokenByOriginal[root.raw];
        if (!replacement) {
          var hintMatch = root.raw.match(/(科技|网络|信息|咨询|教育|文化|传媒|贸易|实业|工程|医药|生物|数据|智能|软件|法律)/);
          var suffix = root._suffix === '律师事务所' ? '律师事务所' : '公司';
          replacement = '某' + (hintMatch ? hintMatch[1] : '') + suffix;
          tokenByOriginal[root.raw] = replacement;
        }
      } else if (item.type === 'PERSON_NAME') {
        replacement = tokenByOriginal[item.raw] || maskValue('PERSON_NAME', item.raw);
        tokenByOriginal[item.raw] = replacement;
      } else {
        replacement = maskValue(item.type, item.raw);
      }
      output = output.slice(0, item.start) + replacement + output.slice(item.end);
      entityCounts[item.type] = (entityCounts[item.type] || 0) + 1;
      findings.unshift({
        type: item.type,
        locator: paragraphOf(text, item.start),
        replacement: replacement,
        preview: buildPreview(item.raw),
        score: item.score,
      });
    }
    var total = findings.length;
    var warnings = total === 0
      ? ['未命中敏感信息，仍建议人工抽样复核。']
      : ['自动识别可能存在漏检或误检；低置信度（<0.80）命中建议人工复核后再外发。'];
    return {
      ok: true,
      code: null,
      text: output,
      report: {
        document_name: documentName,
        strategy: '格式打码',
        summary: { total_findings: total, entity_counts: entityCounts },
        findings: findings,
        warnings: warnings,
      },
    };
  }

  return {
    version: '1.1.0-mvp',
    sanitizeText: function (text) {
      var result = sanitizeText(text, { mapping: Object.create(null), counters: Object.create(null), known: [] });
      var residual = residualHighRisk(result.text);
      return { ok: residual.length === 0, text: result.text, entities: result.entities, residual: residual };
    },
    sanitizeMessages: sanitizeMessages,

    /* ============================================================
       文档遮蔽模式（XJ-5.1.9-desensitize-work-style）——仅供「生成脱敏文档」
       功能页使用，与出站占位符管线（sanitizeText/sanitizeMessages）完全隔离：
       出站行为零变化；本模式替换策略为 LegaleWork 式「保留格式打码」。
       ============================================================ */
    maskDocument: maskDocument,
  };
}));
