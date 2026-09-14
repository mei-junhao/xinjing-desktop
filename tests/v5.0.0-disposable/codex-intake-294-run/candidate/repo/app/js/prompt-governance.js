/* ============================================================
   XinJing prompt governance
   Keeps template metadata, hashes, source boundaries, and optional
   presentation style separate from dynamic clinical context.
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PromptGovernance = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const registry = Object.create(null);
  const DEFAULT_WRITING_STYLE_ENABLED = true;
  const FACT_AND_SOURCE_GUARD = [
    '[事实与来源边界 - 高于表达风格]',
    '只把已提供且可追溯的材料当作事实。资料库、内置知识和既往对话只是带标签的参考来源。',
    '写作风格只能改变表达方式，不能补写事实、弱化来源要求、改变确认边界，或把相关性说成因果。',
  ].join('\n');

  function text(value) { return typeof value === 'string' ? value : String(value == null ? '' : value); }
  function required(value, name) {
    const result = text(value).trim();
    if (!result) throw new Error('Prompt governance requires ' + name);
    return result;
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }

  function rightRotate(value, amount) { return (value >>> amount) | (value << (32 - amount)); }

  // Synchronous SHA-256 keeps manifest generation deterministic in both Electron renderer and Node tests.
  function sha256(input) {
    let ascii = unescape(encodeURIComponent(text(input)));
    const asciiBitLength = ascii.length * 8;
    const maxWord = Math.pow(2, 32);
    const words = [];
    const hash = [];
    const k = [];
    const isComposite = {};
    let primeCounter = 0;
    let candidate = 2;
    let i;
    let j;

    while (primeCounter < 64) {
      if (!isComposite[candidate]) {
        for (i = 0; i < 313; i += candidate) isComposite[i] = candidate;
        hash[primeCounter] = (Math.pow(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (Math.pow(candidate, 1 / 3) * maxWord) | 0;
      }
      candidate++;
    }

    ascii += '\x80';
    while ((ascii.length % 64) !== 56) ascii += '\x00';
    for (i = 0; i < ascii.length; i++) {
      j = ascii.charCodeAt(i);
      words[i >> 2] |= j << ((3 - (i % 4)) * 8);
    }
    words[words.length] = (asciiBitLength / maxWord) | 0;
    words[words.length] = asciiBitLength;

    for (j = 0; j < words.length;) {
      const w = words.slice(j, j += 16);
      const oldHash = hash.slice(0);
      let a;
      let b;
      let c;
      let d;
      let e;
      let f;
      let g;
      let h;

      for (i = 0; i < 64; i++) {
        const w15 = w[i - 15];
        const w2 = w[i - 2];
        const a0 = hash[0];
        const e0 = hash[4];
        const temp1 = hash[7] + (rightRotate(e0, 6) ^ rightRotate(e0, 11) ^ rightRotate(e0, 25)) + ((e0 & hash[5]) ^ ((~e0) & hash[6])) + k[i] + (w[i] = (i < 16) ? w[i] : (w[i - 16] + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3)) + w[i - 7] + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))) | 0);
        const temp2 = (rightRotate(a0, 2) ^ rightRotate(a0, 13) ^ rightRotate(a0, 22)) + ((a0 & hash[1]) ^ (a0 & hash[2]) ^ (hash[1] & hash[2]));

        h = hash[6];
        g = hash[5];
        f = hash[4];
        e = (hash[3] + temp1) | 0;
        d = hash[2];
        c = hash[1];
        b = hash[0];
        a = (temp1 + temp2) | 0;
        hash[0] = a;
        hash[1] = b;
        hash[2] = c;
        hash[3] = d;
        hash[4] = e;
        hash[5] = f;
        hash[6] = g;
        hash[7] = h;
      }
      for (i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }

    let result = '';
    for (i = 0; i < 8; i++) {
      for (j = 3; j >= 0; j--) result += ((hash[i] >> (j * 8)) & 255).toString(16).padStart(2, '0');
    }
    return result;
  }

  function normalizeDefinition(definition) {
    const input = definition || {};
    const changeLog = Array.isArray(input.changeLog) ? input.changeLog.map(function (entry) { return text(entry).trim(); }).filter(Boolean) : [];
    if (!changeLog.length) throw new Error('Prompt governance requires a non-empty changeLog');
    return {
      id: required(input.id, 'id'),
      version: required(input.version, 'version'),
      task: required(input.task, 'task'),
      model: required(input.model, 'model'),
      author: required(input.author, 'author'),
      source: required(input.source, 'source'),
      changeLog: changeLog,
      contentHash: sha256(required(input.content, 'content')),
    };
  }

  function registerPrompt(definition) {
    const normalized = normalizeDefinition(definition);
    const previous = registry[normalized.id];
    if (previous && previous.version === normalized.version && previous.contentHash !== normalized.contentHash) {
      throw new Error('Prompt governance rejected a changed template without a version bump: ' + normalized.id);
    }
    registry[normalized.id] = normalized;
    return clone(normalized);
  }

  function getPromptManifest() {
    return Object.keys(registry).sort().map(function (id) { return clone(registry[id]); });
  }

  function isWritingStyleEnabled(settings) {
    const source = settings || (typeof Store !== 'undefined' && Store.getSettings ? Store.getSettings() : null) || {};
    const governance = source && source.promptGovernance && typeof source.promptGovernance === 'object' ? source.promptGovernance : {};
    return governance.writingStyleEnabled !== false;
  }

  function getWritingStyleBlock(styleText, settings) {
    return isWritingStyleEnabled(settings) ? text(styleText).trim() : '';
  }

  function appendFactAndSourceGuard(prompt) {
    const value = text(prompt).trim();
    if (!value) return FACT_AND_SOURCE_GUARD;
    return value.indexOf(FACT_AND_SOURCE_GUARD) >= 0 ? value : value + '\n\n' + FACT_AND_SOURCE_GUARD;
  }

  function buildPrompt(parts) {
    const input = parts || {};
    const template = required(input.template, 'template');
    registerPrompt({
      id: input.id,
      version: input.version,
      task: input.task,
      model: input.model,
      author: input.author,
      source: input.source,
      changeLog: input.changeLog,
      content: template,
    });
    const output = [template];
    if (input.knowledge) output.push(text(input.knowledge));
    if (input.userContext) output.push(text(input.userContext));
    const style = getWritingStyleBlock(input.style, input.settings);
    if (style) output.push('[写作表现]\n' + style);
    output.push(FACT_AND_SOURCE_GUARD);
    return output.filter(Boolean).join('\n\n');
  }

  function normalizeKnowledgeSource(source) {
    const input = source || {};
    const kind = required(input.kind, 'knowledge kind');
    if (kind !== 'master-builtin' && kind !== 'user-library') throw new Error('Unsupported knowledge source kind: ' + kind);
    const id = required(input.id, 'knowledge id');
    const version = required(input.version, 'knowledge version');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new Error('Invalid knowledge id');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version)) throw new Error('Invalid knowledge version');
    const content = required(input.content, 'knowledge content');
    const computedHash = sha256(content);
    const hasDeclaredHash = Object.prototype.hasOwnProperty.call(input, 'contentHash');
    const declaredHash = hasDeclaredHash ? required(input.contentHash, 'knowledge hash') : computedHash;
    if (!/^[0-9a-f]{64}$/i.test(declaredHash)) throw new Error('Invalid knowledge hash');
    if (declaredHash.toLowerCase() !== computedHash) throw new Error('Knowledge hash mismatch');
    return {
      id: id,
      version: version,
      kind: kind,
      label: required(input.label, 'knowledge label'),
      source: required(input.source, 'knowledge source'),
      content: content,
      contentHash: computedHash,
    };
  }

  function mergeKnowledgeSources(sources) {
    const known = Object.create(null);
    const accepted = [];
    const conflicts = [];
    (Array.isArray(sources) ? sources : []).forEach(function (source) {
      const normalized = normalizeKnowledgeSource(source);
      const key = normalized.id + '@' + normalized.version;
      const existing = known[key];
      if (!existing) {
        known[key] = normalized;
        accepted.push(normalized);
      } else if (existing.contentHash !== normalized.contentHash) {
        conflicts.push({ id: normalized.id, version: normalized.version, kind: normalized.kind, source: normalized.source, reason: 'same-id-version-hash-mismatch' });
      }
    });
    const publicSources = accepted.map(function (source) {
      return { id: source.id, version: source.version, kind: source.kind, label: source.label, source: source.source, contentHash: source.contentHash };
    });
    if (conflicts.length) return { ok: false, sources: publicSources, conflicts: conflicts, text: '' };
    const rendered = accepted.map(function (source) {
      return '[' + source.label + ' | source=' + source.source + ' | sha256=' + source.contentHash + ']\n' + source.content;
    }).join('\n\n');
    return { ok: true, sources: publicSources, conflicts: [], text: rendered };
  }

  function createMasterKnowledgeManifest(master, knowledge, sourcePath) {
    const item = master || {};
    const key = required(item.key || item.id, 'master key');
    const source = required(sourcePath || item.knowledgeFile || item.perspectiveFile || 'builtin-master-knowledge', 'master knowledge source');
    const content = required(knowledge, 'master knowledge content');
    return {
      id: 'master:' + key,
      version: text(item.knowledgeVersion || 'builtin-v1'),
      kind: 'master-builtin',
      label: '大师内置知识',
      source: source,
      contentHash: sha256(content),
    };
  }

  return {
    DEFAULT_WRITING_STYLE_ENABLED: DEFAULT_WRITING_STYLE_ENABLED,
    FACT_AND_SOURCE_GUARD: FACT_AND_SOURCE_GUARD,
    sha256: sha256,
    registerPrompt: registerPrompt,
    getPromptManifest: getPromptManifest,
    isWritingStyleEnabled: isWritingStyleEnabled,
    getWritingStyleBlock: getWritingStyleBlock,
    appendFactAndSourceGuard: appendFactAndSourceGuard,
    buildPrompt: buildPrompt,
    mergeKnowledgeSources: mergeKnowledgeSources,
    createMasterKnowledgeManifest: createMasterKnowledgeManifest,
  };
});
