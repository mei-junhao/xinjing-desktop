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
  const GOVERNANCE_REJECTION_PREFIX = 'Prompt governance rejected a changed template without a version bump: ';
  const FACT_AND_SOURCE_GUARD = [
    '[事实与来源边界 - 高于表达风格]',
    '只把已提供且可追溯的材料当作事实。资料库、内置知识和既往对话只是带标签的参考来源。',
    '写作风格只能改变表达方式，不能补写事实、弱化来源要求、改变确认边界，或把相关性说成因果。',
  ].join('\n');

  /* ---------- 版本核（F7-P0-1 的收口点） ----------
   * 「同版本内容变更必须被拒绝」的判据（见 registerPrompt）成立的前提是
   * **版本与内容线性无关**。一旦版本被定义成内容的函数（`4.4.0+sha256.<12>` 这类
   * 由 contentHash 派生的形态），改文本必然自动换版本，判据前件恒假 —— 该 id 族
   * 永不可能触发（这就是被复审判为 P0 的那条被悄悄废除的语义）。
   * 收口方式不是回滚成「对所有模板谎报同一个字面量」，而是把两件事分开：
   *   - `version`：可比对的**声明版本**（模板卡自己的 promptVersion，或调用点声明）；
   *     对确实未声明版本的第三方/生成物，允许在声明版本核之后追加 `+sha256.<12>`
   *     作为构建元数据（semver 明确「构建元数据不参与版本优先序比较」），逐模板
   *     字节可追溯性由 manifest 的 `contentHash` / `templateHash` 独立承担；
   *   - `versionCore`：拒绝判据**只看它**，即只看声明部分，绝不看那段内容派生的
   *     元数据。于是「改文本必须显式升版」在每一个 id 上都真实可达。
   */
  function versionCore(version) {
    const value = text(version).trim();
    const plus = value.indexOf('+');
    const core = (plus >= 0 ? value.slice(0, plus) : value).trim();
    return core;
  }

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

  /* ---------- 模板来源可核（F7 §0 两条 FAIL 的收口） ----------
   * 既往 masters.system.* 的 source / version 由调用点写成硬编码常量：
   *   - sup-klein / sup-winnicott 的模板实际在 app/js/supervision-syndicate-data.js，
   *     manifest 却声明 app/js/masters-data.js（getMasterByKey 查不到 → 说谎）；
   *   - version 恒等于 String(master.promptVersion || '4.4.0') 的兜底字面量，
   *     而模板对象根本不声明 promptVersion → 逐模板不可追溯。
   * 治理层改为「按真实载荷反查模板」：只有当登记的文本确实就是某模板原文
   * （或包含该模板原文）时才改写 source / version；查不到就保留声明值并显式
   * 标记 declared-unverified，绝不猜测、绝不静默改写。
   * 5.1.19 F7-P0-1 返工：app/js/masters-data.js 的 12 张大师卡现在**自己声明**
   * promptVersion，这些 id 的 version 取该声明值（versionBasis='template-promptVersion'）；
   * 未声明的卡（学派卡）保留可区分的 versionBasis，且拒绝判据改用 versionCore，
   * 使「同版本改文本必被拒」在两类 id 上都真实可达。
   * 同轮追加：合成文本不属于任何一张卡时，登记方可用 `ownTemplateVersion` 自声明该阶段
   * 自己的模板版本（versionBasis='call-site-self-declared(...)'），从此不再落进
   * 「版本 = 内容哈希」的派生族。
   */
  const TEMPLATE_LIBRARIES = [
    { idPrefix: 'masters.system.', globalName: 'MASTERS', file: 'app/js/masters-data.js' },
    { idPrefix: 'masters.system.', globalName: 'SUPERVISION_SYNDICATE', file: 'app/js/supervision-syndicate-data.js' },
  ];

  function templateScope() {
    // 注意：UMD 包装里的 `root` 形参在 factory 函数的词法作用域内不可见
    // （factory 是作为实参写在外面的），必须走 globalThis（浏览器下即 window）。
    if (typeof window !== 'undefined' && window) return window;
    if (typeof globalThis !== 'undefined' && globalThis) return globalThis;
    return null;
  }

  function templateCandidates(id, content, keyHint) {
    const scope = templateScope();
    const found = [];
    if (!scope) return found;
    for (let i = 0; i < TEMPLATE_LIBRARIES.length; i++) {
      const lib = TEMPLATE_LIBRARIES[i];
      if (!keyHint && id.indexOf(lib.idPrefix) !== 0) continue;
      const collection = scope[lib.globalName];
      if (!Array.isArray(collection)) continue;
      for (let j = 0; j < collection.length; j++) {
        const card = collection[j];
        if (!card || !card.key) continue;
        // 两种寻址方式：id 约定 masters.system.<key>；或显式 templateKey（供
        // 「一个模板、多个阶段改写」的管线用，如多学派 synthesis 阶段）。
        if (keyHint ? card.key !== keyHint : card.key !== id.slice(lib.idPrefix.length)) continue;
        const template = text(card.systemPrompt);
        if (!template) continue;
        // 同源判据：登记的文本就是模板原文，或模板原文确实出现在登记文本里
        if (content === template || content.indexOf(template) >= 0) {
          found.push({ file: lib.file, card: card, templateLength: template.length, templateHash: sha256(template) });
        }
      }
    }
    return found;
  }

  function resolveTemplateProvenance(input, contentHash) {
    const out = { provenance: 'declared-unverified' };
    const id = text(input && input.id).trim();
    const content = text(input && input.content);
    const keyHint = text(input && input.templateKey).trim();
    if (!content || (!id && !keyHint)) return out;
    const candidates = templateCandidates(id, content, keyHint);
    if (!candidates.length) return out;
    let longest = candidates[0];
    for (let i = 1; i < candidates.length; i++) if (candidates[i].templateLength > longest.templateLength) longest = candidates[i];
    const best = candidates.filter(function (c) { return c.templateLength === longest.templateLength; });
    const files = Object.create(null);
    best.forEach(function (c) { files[c.file] = true; });
    if (Object.keys(files).length > 1) { out.provenance = 'ambiguous'; return out; }
    const hit = best[0];
    out.provenance = 'verified';
    out.source = hit.file;
    out.templateKey = hit.card.key;
    out.templateHash = hit.templateHash;
    const declared = text(input.version).trim();
    const tplVersion = text(hit.card.promptVersion).trim();
    // 登记方自己就是这条 prompt 的模板属主：某些阶段的文本不在任何一张卡里
    // （多学派综合阶段 = 主理人模板 + 阶段指令 + 边界段的合成文本），它必须**自声明**版本，
    // 否则就会被塞进「版本 = 声明核 + 内容哈希」的派生族 —— 那正是 F7-P0-1 判为 P0 的形态：
    // 版本成为内容的函数后，「同版本改文本必须被拒」在这条 id 上结构性永不触发。
    // 来源与 templateHash 仍按反查结果登记，逐字节可追溯性由 contentHash / templateHash 承担。
    const ownVersion = text(input.ownTemplateVersion).trim();
    if (tplVersion) {
      // 模板卡自己声明版本 → 治理层 version 取该声明值（F7 目标 6）。
      // 不再追加内容哈希：那会把版本重新变成内容的函数，并让 F7 目标 2 的拒绝
      // 判据在该 id 上结构性永不触发（F7-P0-1）。
      out.version = tplVersion;
      out.versionCore = versionCore(tplVersion);
      out.versionBasis = 'template-promptVersion';
    } else if (ownVersion) {
      out.version = ownVersion;
      out.versionCore = versionCore(ownVersion);
      out.versionBasis = 'call-site-self-declared(模板未声明 promptVersion，登记方自声明版本)';
    } else {
      // 模板自身没有 promptVersion 字段（第三方卡 / 构建期生成物），且登记方也没有声明
      // 「我就是这条文本的模板属主」：版本核取调用点声明值，尾部 `+sha256.<12>` 只是构建元数据，
      // 供「这条 prompt 是哪一版文本」人工比对；**拒绝判据只用版本核**，所以这些 id 同样能被
      // 真实杀死。versionBasis 把这一族显式标出，便于断言它不再是多数。
      const core = versionCore(declared) || '0.0.0';
      out.version = core + '+sha256.' + contentHash.slice(0, 12);
      out.versionCore = core;
      out.versionBasis = versionCore(declared)
        ? 'declared-call-site+content-metadata(模板未声明 promptVersion)'
        : 'content-hash(模板与调用点均未声明版本)';
    }
    return out;
  }

  function normalizeDefinition(definition) {
    const input = definition || {};
    const changeLog = Array.isArray(input.changeLog) ? input.changeLog.map(function (entry) { return text(entry).trim(); }).filter(Boolean) : [];
    if (!changeLog.length) throw new Error('Prompt governance requires a non-empty changeLog');
    const contentHash = sha256(required(input.content, 'content'));
    const provenance = resolveTemplateProvenance(input, contentHash);
    const version = provenance.version || required(input.version, 'version');
    return {
      id: required(input.id, 'id'),
      version: version,
      // 拒绝判据专用字段：声明版本核（不含内容派生的构建元数据）。见 versionCore()。
      versionCore: provenance.versionCore || versionCore(version),
      task: required(input.task, 'task'),
      model: required(input.model, 'model'),
      author: required(input.author, 'author'),
      source: provenance.source || required(input.source, 'source'),
      changeLog: changeLog,
      contentHash: contentHash,
      // F7 §0 审计收口：来源/版本必须能对着真实载荷复核，故把复核依据一并登记。
      provenance: provenance.provenance,
      versionBasis: provenance.versionBasis || 'declared',
      // 「一个模板、多阶段改写」的管线（如综合阶段）必须能在 manifest 里说明它改的是
      // 哪张卡，否则审计只能靠 id 字符串猜。
      templateKey: provenance.templateKey || '',
      templateHash: provenance.templateHash || '',
    };
  }

  function registerPrompt(definition) {
    const normalized = normalizeDefinition(definition);
    const previous = registry[normalized.id];
    // F7-P0-1：判据打在「声明版本核 + 内容哈希」上，绝不打在带内容派生元数据的
    // 完整版本串上 —— 后者会让本条前件恒假（版本成了内容的函数）。
    if (previous && previous.versionCore === normalized.versionCore && previous.contentHash !== normalized.contentHash) {
      throw new Error(GOVERNANCE_REJECTION_PREFIX + normalized.id);
    }
    registry[normalized.id] = normalized;
    return clone(normalized);
  }

  // 调用点需要区分「治理层拒绝」（必须停止发送，绝不能带着旧文本继续跑）与
  // 「其它实现异常」（可回退到本地确定性文本）。见 supervision-syndicate.roundSystem。
  function isRegistrationRejection(error) {
    const message = text(error && error.message);
    return message.indexOf(GOVERNANCE_REJECTION_PREFIX) === 0;
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
      // buildPrompt 也必须把模板寻址提示传下去，否则经统一入口登记的条目拿不到来源复核
      templateKey: input.templateKey,
      // 同理：登记方自声明的阶段模板版本也要透传，否则统一入口会把该条目打成内容派生族
      ownTemplateVersion: input.ownTemplateVersion,
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
    versionCore: versionCore,
    isRegistrationRejection: isRegistrationRejection,
    getPromptManifest: getPromptManifest,
    isWritingStyleEnabled: isWritingStyleEnabled,
    getWritingStyleBlock: getWritingStyleBlock,
    appendFactAndSourceGuard: appendFactAndSourceGuard,
    buildPrompt: buildPrompt,
    mergeKnowledgeSources: mergeKnowledgeSources,
    createMasterKnowledgeManifest: createMasterKnowledgeManifest,
    // 模板来源对照表 + 反查器：上层（含 supervision-syndicate 接线）复用同一份
    // 「模板在哪个文件」事实，不再各写一份 source 常量。
    TEMPLATE_LIBRARIES: TEMPLATE_LIBRARIES.map(function (l) { return Object.assign({}, l); }),
    resolveTemplateProvenance: resolveTemplateProvenance,
  };
});
