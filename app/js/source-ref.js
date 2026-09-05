/* 心镜来源追溯（SourceRef）：无副作用、可单测的来源引用构造与校验模块。
 * 该模块不访问 DOM、Store、App、IPC、文件系统或网络；可在浏览器与主进程（Node）下加载。
 * 不修改任意调用方；调用方需自行对接本模块 API。
 */
(function () {
  'use strict';

  var SCHEMA_VERSION = '1';
  var NORMALIZATION_VERSION = '1';
  var SOURCE_VERSION = '1';

  /* ---------- 纯函数哈希（不新增依赖，与 clinical-context.js 的 digest 风格一致） ---------- */
  function utf8Bytes(input) {
    var s = String(input == null ? '' : input);
    if (typeof TextEncoder !== 'undefined') return Array.prototype.slice.call(new TextEncoder().encode(s));
    var encoded = unescape(encodeURIComponent(s));
    var bytes = [];
    for (var i = 0; i < encoded.length; i++) bytes.push(encoded.charCodeAt(i));
    return bytes;
  }
  function sha256(value) {
    var bytes = utf8Bytes(value);
    var bitLength = bytes.length * 8;
    bytes.push(0x80);
    while ((bytes.length % 64) !== 56) bytes.push(0);
    for (var shift = 7; shift >= 0; shift--) bytes.push((bitLength / Math.pow(2, shift * 8)) & 0xff);
    var k = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    function add() { var t = 0; for (var a = 0; a < arguments.length; a++) t = (t + arguments[a]) >>> 0; return t; }
    function ror(n, c) { return (n >>> c) | (n << (32 - c)); }
    for (var off = 0; off < bytes.length; off += 64) {
      var w = new Array(64);
      for (var wi = 0; wi < 16; wi++) {
        var b = off + wi * 4;
        w[wi] = ((bytes[b] << 24) | (bytes[b + 1] << 16) | (bytes[b + 2] << 8) | bytes[b + 3]) >>> 0;
      }
      for (wi = 16; wi < 64; wi++) {
        var s0 = ror(w[wi - 15], 7) ^ ror(w[wi - 15], 18) ^ (w[wi - 15] >>> 3);
        var s1 = ror(w[wi - 2], 17) ^ ror(w[wi - 2], 19) ^ (w[wi - 2] >>> 10);
        w[wi] = add(w[wi - 16], s0, w[wi - 7], s1);
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], i2 = h[7];
      for (wi = 0; wi < 64; wi++) {
        var up1 = ror(e, 6) ^ ror(e, 11) ^ ror(e, 25);
        var ch = (e & f) ^ ((~e) & g);
        var t1 = add(i2, up1, ch, k[wi], w[wi]);
        var up0 = ror(a, 2) ^ ror(a, 13) ^ ror(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = add(up0, maj);
        i2 = g; g = f; f = e; e = add(d, t1); d = c; c = b; b = a; a = add(t1, t2);
      }
      h[0] = add(h[0], a); h[1] = add(h[1], b); h[2] = add(h[2], c); h[3] = add(h[3], d);
      h[4] = add(h[4], e); h[5] = add(h[5], f); h[6] = add(h[6], g); h[7] = add(h[7], i2);
    }
    return 'sha256:' + h.map(function (p) { return p.toString(16).padStart(8, '0'); }).join('');
  }

  /* ---------- 工具函数 ---------- */
  function text(value) { return value == null ? '' : String(value); }
  function nowIso() { return new Date().toISOString(); }

  // 安全 id：仅由确定性字段派生（不含绝对路径）。
  function buildStableId(signed) {
    return 'sr:' + sha256([
      signed.schemaVersion, signed.clientId, signed.sessionId,
      signed.anchor.kind, signed.anchor.locator, signed.anchor.fragment,
      signed.normalizationVersion, signed.sourceVersion, signed.sourceContentHash, signed.anchorContentHash
    ].join('|'));
  }

  // 拒绝绝对路径，只保留受控来源键（与临床匿名化名体系一致，不含真实姓名/路径）。
  function normalizeAnchor(anchor) {
    if (!anchor || typeof anchor !== 'object') return null;
    var kind = text(anchor.kind).trim();
    var locator = text(anchor.locator).trim();
    var fragment = text(anchor.fragment);
    var position = anchor.position;
    if (!kind || !locator) return null;
    // 绝对路径检测：Windows / Unix / URL 绝对形式均拒绝。
    if (/^(?:[a-zA-Z]:[\\/]|[\\/]|\\\\|\w+:\/\/)/.test(locator)) return null;
    if (locator.indexOf('..') !== -1) return null; // 路径遍历也拒绝
    var norm = {
      kind: kind,
      locator: locator,
      fragment: fragment
    };
    if (position != null && typeof position === 'object') {
      var pos = {};
      ['start', 'end', 'line', 'column'].forEach(function (key) {
        if (typeof position[key] === 'number' && isFinite(position[key])) pos[key] = position[key];
      });
      if (Object.keys(pos).length) norm.position = pos;
    }
    return norm;
  }

  function normalizeRecord(record) {
    if (!record || typeof record !== 'object') return null;
    var clientId = text(record.clientId).trim();
    var sessionId = text(record.sessionId).trim();
    // 冻结契约：每条 SourceRef 必须同时具备 clientId 与 sessionId，任一为空即拒绝。
    if (!clientId || !sessionId) return null;
    var anchor = normalizeAnchor(record.anchor);
    if (!anchor) return null;
    var sourceText = text(record.sourceText);
    var sourceContentHash = text(record.sourceContentHash).trim();
    var anchorText = text(record.anchorText);
    var anchorContentHash = text(record.anchorContentHash).trim();
    // 若未提供哈希，按当前版本规则即时派生。
    if (!sourceContentHash) sourceContentHash = sha256(sourceText);
    if (!anchorContentHash) anchorContentHash = sha256(anchorText || extractAnchorText(sourceText, anchor));
    return {
      clientId: clientId,
      sessionId: sessionId,
      anchor: anchor,
      sourceText: sourceText,
      anchorText: anchorText,
      sourceContentHash: sourceContentHash,
      anchorContentHash: anchorContentHash
    };
  }

  // 从来源文本中抽取锚点片段文本（用于未提供 anchorText 时补全哈希；纯字符串操作，无副作用）。
  function extractAnchorText(sourceText, anchor) {
    var src = text(sourceText);
    var frag = text(anchor.fragment);
    if (frag) {
      var idx = src.indexOf(frag);
      if (idx !== -1) return frag;
    }
    var pos = anchor.position;
    if (pos && typeof pos.start === 'number' && typeof pos.end === 'number') {
      return src.slice(pos.start, pos.end);
    }
    return '';
  }

  /* ---------- 构造 ---------- */
  // create({ clientId, sessionId, anchor, sourceText, anchorText?, sourceContentHash?, anchorContentHash?, capturedAt? })
  // 缺省哈希即时派生，但始终优先使用调用方显式提供的哈希（保证可复核）。
  function create(input) {
    input = input || {};
    var record = normalizeRecord(input);
    if (!record) throw new Error('SourceRef.create: invalid input (require BOTH clientId and sessionId, plus kind/locator anchor and source text)');
    var capturedAt = input.capturedAt ? text(input.capturedAt) : nowIso();
    var signed = {
      schemaVersion: SCHEMA_VERSION,
      clientId: record.clientId,
      sessionId: record.sessionId,
      anchor: record.anchor,
      normalizationVersion: NORMALIZATION_VERSION,
      sourceVersion: SOURCE_VERSION,
      sourceContentHash: record.sourceContentHash,
      anchorContentHash: record.anchorContentHash,
      capturedAt: capturedAt
    };
    signed.id = buildStableId(signed);
    return signed;
  }

  /* ---------- 校验 ---------- */
  // verify(ref, current): 以捕获时的 sourceContentHash 为基线，对比当前来源内容/锚点。
  // 关键规则：只要来源内容变化（sourceContentHash 不匹配），无论锚点是否仍匹配，都只能是 warning，不得标记 verified。
  function verify(ref, current) {
    if (!ref || typeof ref !== 'object') return { status: 'invalid', reason: 'ref-missing', verified: false };
    if (!current || typeof current !== 'object') return { status: 'missing', reason: 'current-missing', verified: false };
    if (text(ref.schemaVersion).trim() === '' || text(ref.sourceContentHash).trim() === '') {
      return { status: 'legacy-unverified', reason: 'legacy-fields', verified: false, legacy: true };
    }

    var cur = normalizeRecord(current);
    if (!cur) return { status: 'invalid', reason: 'current-invalid', verified: false };

    if (text(cur.clientId).trim() && text(ref.clientId).trim() && cur.clientId !== ref.clientId) {
      return { status: 'ambiguous', reason: 'client-mismatch', verified: false };
    }
    if (text(cur.sessionId).trim() && text(ref.sessionId).trim() && cur.sessionId !== ref.sessionId) {
      return { status: 'ambiguous', reason: 'session-mismatch', verified: false };
    }
    if (cur.anchor.kind !== ref.anchor.kind || cur.anchor.locator !== ref.anchor.locator) {
      return { status: 'ambiguous', reason: 'anchor-locator-mismatch', verified: false };
    }

    var sourceChanged = cur.sourceContentHash !== ref.sourceContentHash;
    var anchorMatched = cur.anchorContentHash === ref.anchorContentHash;

    if (sourceChanged) {
      // 关键规则：来源内容已变，即使锚点仍匹配，也只能标记 warning candidate，禁止 verified。
      if (anchorMatched) {
        return { status: 'warning', reason: 'source-changed-anchor-matched', verified: false, warning: true, candidate: true };
      }
      return { status: 'changed', reason: 'source-changed-anchor-not-matched', verified: false };
    }

    if (anchorMatched) {
      return { status: 'unchanged', reason: 'source-and-anchor-matched', verified: true };
    }
    return { status: 'changed', reason: 'anchor-not-matched', verified: false };
  }

  // 准入必须由独立的当前上下文确认，不能只信任引用自身携带的归属字段。
  function validateAdmission(ref, current, currentContext) {
    currentContext = currentContext || {};
    var clientId = text(currentContext.clientId).trim();
    var sessionId = text(currentContext.sessionId).trim();
    if (!clientId || !sessionId) return { admitted: false, status: 'invalid', reason: 'context-missing' };
    if (!ref || !current) return { admitted: false, status: 'missing', reason: 'source-missing' };
    if (text(ref.clientId).trim() !== clientId || text(ref.sessionId).trim() !== sessionId) {
      return { admitted: false, status: 'ambiguous', reason: 'ref-context-mismatch' };
    }
    if (text(current.clientId).trim() !== clientId || text(current.sessionId).trim() !== sessionId) {
      return { admitted: false, status: 'ambiguous', reason: 'current-context-mismatch' };
    }
    var result = verify(ref, current);
    if (!result.verified) return { admitted: false, status: result.status, reason: result.reason, verification: result };
    return { admitted: true, status: 'valid', reason: 'source-verified', verification: result };
  }

  /* ---------- 旧版迁移 ---------- */
  // migrateLegacy(raw): 将无 schemaVersion / 无哈希的旧引用转换为 legacy-unverified，并补算哈希以备后续校验。
  function migrateLegacy(raw) {
    raw = raw || {};
    var record = normalizeRecord({
      clientId: raw.clientId,
      sessionId: raw.sessionId,
      anchor: raw.anchor || raw.source,
      sourceText: raw.sourceText || raw.text || '',
      anchorText: raw.anchorText
    });
    if (!record) {
      return { status: 'legacy-unverified', reason: 'legacy-fields', verified: false, legacy: true, migrated: false, id: text(raw.id), clientId: text(raw.clientId), sessionId: text(raw.sessionId), anchor: raw.anchor || null };
    }
    var migrated = {
      id: text(raw.id) || 'sr:legacy:' + sha256([record.clientId, record.sessionId, record.anchor.kind, record.anchor.locator].join('|')),
      schemaVersion: '',
      clientId: record.clientId,
      sessionId: record.sessionId,
      anchor: record.anchor,
      normalizationVersion: '',
      sourceVersion: '',
      sourceContentHash: record.sourceContentHash,
      anchorContentHash: record.anchorContentHash,
      capturedAt: text(raw.capturedAt) || nowIso(),
      legacy: true,
      migrated: true,
      status: 'legacy-unverified',
      reason: 'legacy-fields',
      verified: false
    };
    return migrated;
  }

  /* ---------- 校验给定来源是否包含绝对路径（供调用方在导入前做只读校准） ---------- */
  function containsAbsolutePath(value) {
    var s = text(value);
    return /^(?:[a-zA-Z]:[\\/]|[\\/]|\\\\|\w+:\/\/)/.test(s.trim()) || s.indexOf('..') !== -1;
  }

  var API = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    NORMALIZATION_VERSION: NORMALIZATION_VERSION,
    SOURCE_VERSION: SOURCE_VERSION,
    sha256: sha256,
    create: create,
    verify: verify,
    validateAdmission: validateAdmission,
    migrateLegacy: migrateLegacy,
    containsAbsolutePath: containsAbsolutePath,
    normalizeAnchor: normalizeAnchor
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.SourceRef = API;
  if (typeof globalThis !== 'undefined') globalThis.SourceRef = API;
})();
