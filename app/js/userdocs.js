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

  // 脚本加载即自动预取（无需等待 agent-shell 调用），保证首条消息前缓存就绪
  refresh();

  window.UserDocs = { getContextBlock, search, preload: refresh, refresh };
})();
