// 用户自建知识库（v3.6.0 RAG 分层检索版）—— 渲染进程共享模块
// 职责：在脚本加载即预取用户外部文件夹资料 → 模块级缓存；
//       供各 AI build 函数同步取 [我的资料库] 摘要上下文块，并提供分层检索 search()。
// 资料仅本机经主进程 fs 读取，不经代理、不上报、不入 user_memory。
// 分层：免费→关键词检索；Pro→向量检索；旗舰（custom）→向量 + rerank 精排。
(function () {
  let _cache = null;        // 模块级缓存：避免 build 函数（同步）里 await IPC
  let _cacheAt = 0;
  let _loading = null;
  const TTL = 5 * 60 * 1000;

  // 按档位的注入上限（token 估算，中文字 / 1.5 ≈ tokens）
  const CONTEXT_TOKEN_LIMIT = {
    free: 2000,
    pro: 4000,
    custom: 16000,
    full: 4000,
  };

  function _currentTier() {
    try {
      if (window.__XJ__ && window.__XJ__.tier) return window.__XJ__.tier;
    } catch (e) {}
    return 'free';
  }

  function _estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 1.5);
  }

  async function refresh() {
    if (_loading) return _loading;
    _loading = (async () => {
      try {
        const r = await window.__XJ_API__.readUserDocs({});
        _cache = (r && r.ok) ? r.files : [];
        _cacheAt = Date.now();
      } catch (e) { _cache = []; }
      _loading = null;
      return _cache;
    })();
    return _loading;
  }

  // 供各 build 函数同步调用：返回 [我的资料库] 摘要块（文件数 + 分类统计，约 200 tokens）
  // 避免全量注入撑爆上下文；AI 需要具体内容时通过 userdocs.search 工具按需检索。
  // opts.excludedRelPaths: 数组，指定不纳入本次注入上下文的文件 relPath（对话视图「引用开关」用）
  function getContextBlock(opts) {
    if (!_cache || Date.now() - _cacheAt > TTL) {
      refresh();
      return '';
    }
    if (!_cache.length) return '';
    const exclude = (opts && opts.excludedRelPaths) || null;
    const files = exclude ? _cache.filter(f => !exclude.includes(f.file)) : _cache;
    if (!files.length) return '';
    const total = files.length;
    let totalChars = 0;
    const catMap = new Map();
    for (const f of files) {
      totalChars += (f.text || '').length;
      const name = f.file || '';
      const cat = name.includes('/') ? name.split('/')[0] : '根目录';
      catMap.set(cat, (catMap.get(cat) || 0) + 1);
    }
    const topCats = Array.from(catMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, v]) => k + '(' + v + '篇)')
      .join('、');
    const estTokens = Math.ceil(totalChars / 1.5);
    const summary = '[我的资料库]\n' +
      '共 ' + total + ' 篇文档，约 ' + estTokens + ' tokens，' +
      '分类：' + topCats + '。\n' +
      '如需查询具体内容，请调用 userdocs.search 工具检索。';
    return summary;
  }

  // 分层检索路由：免费→关键词；Pro/旗舰→向量（旗舰额外 rerank）
  // 返回 { ok, results: [{relPath, heading, text, score}] }
  async function retrieve(query, opts) {
    opts = opts || {};
    const tier = _currentTier();
    const maxTokens = CONTEXT_TOKEN_LIMIT[tier] || 2000;

    if (tier === 'free') {
      try {
        const r = await window.__XJ_API__.searchUserDocs(query, 20);
        if (!r || !r.ok) return { ok: false, reason: r && r.reason, results: [] };
        const results = (r.hits || []).map(h => ({
          relPath: h.relPath,
          heading: '',
          text: h.text,
          score: h.score,
        }));
        return { ok: true, results, tier: 'free' };
      } catch (e) {
        return { ok: false, reason: e.message, results: [] };
      }
    }

    try {
      const topK = tier === 'custom' ? 20 : 20;
      const r = await window.__XJ_API__.ragSearch(query, topK, tier);
      if (r && r.ok && r.results && r.results.length > 0) {
        return { ok: true, results: r.results, tier };
      }
      throw new Error((r && r.reason) || 'no-results');
    } catch (e) {
      if (typeof App !== 'undefined' && App.showToast) {
        App.showToast('向量检索不可用，已降级为关键词检索', 'warning');
      }
      try {
        const r = await window.__XJ_API__.searchUserDocs(query, 20);
        if (!r || !r.ok) return { ok: false, reason: r && r.reason, results: [] };
        const results = (r.hits || []).map(h => ({
          relPath: h.relPath,
          heading: '',
          text: h.text,
          score: h.score,
        }));
        return { ok: true, results, tier: 'free-fallback' };
      } catch (e2) {
        return { ok: false, reason: e2.message, results: [] };
      }
    }
  }

  // 给 AI 工具调用的 search：返回拼好的上下文文本，受 token 上限控制
  async function search(q) {
    const r = await retrieve(q);
    if (!r.ok) return { ok: false, reason: r.reason };
    const tier = r.tier || _currentTier();
    const maxTokens = CONTEXT_TOKEN_LIMIT[tier] || 2000;
    const results = r.results || [];
    const chunks = [];
    let tokenBudget = maxTokens;
    for (const res of results) {
      const text = (res.text || '').trim();
      if (!text) continue;
      const t = _estimateTokens(text);
      if (t > tokenBudget && chunks.length > 0) break;
      chunks.push({ relPath: res.relPath, heading: res.heading || '', text, score: res.score });
      tokenBudget -= t;
      if (tokenBudget <= 0) break;
    }
    const body = chunks.map(c =>
      '文件：' + c.relPath + (c.heading ? ' / ' + c.heading : '') + '\n' + c.text
    ).join('\n\n---\n\n');
    return {
      ok: true,
      data: {
        folder: '',
        files: chunks,
        body,
        tier: r.tier,
        resultCount: chunks.length,
      },
    };
  }

  // ---- v3.5.0-UI 知识库界面数据接口（与上方 AI 注入缓存相互独立）----
  let _meta = null, _metaAt = 0, _metaLoading = null;
  const META_TTL = 10 * 1000;

  async function getMeta(force) {
    if (!force && _meta && Date.now() - _metaAt < META_TTL) return _meta;
    if (_metaLoading) return _metaLoading;
    _metaLoading = (async () => {
      try {
        const r = await window.__XJ_API__.readUserDocMeta();
        _meta = (r && r.ok) ? r : { ok: false, reason: (r && r.reason) || 'unknown', files: [], tree: [], categories: [], keywords: [], stats: {} };
        _metaAt = Date.now();
      } catch (e) {
        _meta = { ok: false, reason: 'ipc-failed', files: [], tree: [], categories: [], keywords: [], stats: {} };
      }
      _metaLoading = null;
      return _meta;
    })();
    return _metaLoading;
  }

  async function getFile(relPath) {
    try {
      const r = await window.__XJ_API__.readUserDocFile(relPath);
      return r || { ok: false, reason: 'ipc-failed' };
    } catch (e) { return { ok: false, reason: 'ipc-failed' }; }
  }

  async function searchDetailed(q, max) {
    try {
      const r = await window.__XJ_API__.searchUserDocs(q, max || 50);
      return r || { ok: false, reason: 'ipc-failed', hits: [] };
    } catch (e) { return { ok: false, reason: 'ipc-failed', hits: [] }; }
  }

  function invalidateMeta() { _meta = null; _metaAt = 0; }

  refresh();

  window.UserDocs = {
    getContextBlock,
    search,
    retrieve,
    preload: refresh,
    refresh,
    getMeta,
    getFile,
    searchDetailed,
    invalidateMeta,
    estimateTokens: _estimateTokens,
    currentTier: _currentTier,
  };
})();
