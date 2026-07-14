// 用户自建知识库（v3.5.0）—— 渲染进程共享模块
// 职责：在脚本加载即预取用户外部文件夹资料 → 模块级缓存；
//       供各 AI build 函数同步取 [我的资料库] 上下文块，并提供主动检索 search()。
// 资料仅本机经主进程 fs 读取，不经代理、不上报、不入 user_memory。
(function () {
  let _cache = null;        // 模块级缓存：避免 build 函数（同步）里 await IPC
  let _cacheAt = 0;
  let _loading = null;
  const TTL = 5 * 60 * 1000;

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

  // 供各 build 函数同步调用：返回拼好的 [我的资料库] 块（带文件名标注）
  function getContextBlock() {
    if (!_cache || Date.now() - _cacheAt > TTL) {
      refresh(); // 懒触发，不阻塞；本次返回空
      return '';
    }
    if (!_cache.length) return '';
    const body = _cache.map(f => '文件：' + f.file + '\n' + f.text).join('\n\n');
    return '[我的资料库]\n' + body;
  }

  async function search(q) {
    const r = await window.__XJ_API__.readUserDocs({ query: q });
    if (!r || !r.ok) return { ok: false, reason: r && r.reason };
    return { ok: true, data: { folder: r.folder, files: r.files } };
  }

  // ---- v3.5.0-UI 知识库界面数据接口（与上方 AI 注入缓存相互独立）----
  let _meta = null, _metaAt = 0, _metaLoading = null;
  const META_TTL = 10 * 1000; // 元数据 10s TTL，界面切换/刷新时避免重复全量遍历

  // 知识库界面：元数据（files/tree/categories/keywords/stats）。force 跳过缓存
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

  // 知识库界面：单文件全文 + 标题目录（沉浸阅读视图）
  async function getFile(relPath) {
    try {
      const r = await window.__XJ_API__.readUserDocFile(relPath);
      return r || { ok: false, reason: 'ipc-failed' };
    } catch (e) { return { ok: false, reason: 'ipc-failed' }; }
  }

  // 知识库界面：片段化搜索（返回 hits[{relPath,name,lineNo,text,score}]）
  async function searchDetailed(q, max) {
    try {
      const r = await window.__XJ_API__.searchUserDocs(q, max || 50);
      return r || { ok: false, reason: 'ipc-failed', hits: [] };
    } catch (e) { return { ok: false, reason: 'ipc-failed', hits: [] }; }
  }

  // 元数据缓存失效（选择新文件夹后调用，强制下次重新遍历）
  function invalidateMeta() { _meta = null; _metaAt = 0; }

  // 脚本加载即自动预取（无需等待 agent-shell 调用），保证首条消息前缓存就绪
  refresh();

  window.UserDocs = { getContextBlock, search, preload: refresh, refresh, getMeta, getFile, searchDetailed, invalidateMeta };
})();
