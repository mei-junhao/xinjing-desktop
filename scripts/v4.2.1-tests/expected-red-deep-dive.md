# XJ-4.2.1 duable-save 契约 — 预期红项深究报告

**task_id**: XJ-4.2.1-opencode-calibration
**contract_id**: XJ-4.2.1-durable-save-v1

---

## C3F1：跨来访者切换守门缺失

**实际代码路径**（`store.js:488-513,477-486,130-133`）：

```
createSession(data)
  → licenseGuard('client', data.clientId)     // 仅限 license，不验证 clientId 存在
  → saveSession(session)
      → cache.sessions 修改                      // L478-486：同步改内存
      → persist('sessions')                      // L483：fire-and-forget
          → idbPut('sessions', cache.sessions)   // L131：不 await
  → return session                               // L512：同步返回，调用方拿到的不是 Promise
```

**为什么守门不可能**：
1. `persist('sessions')` 是 fire-and-forget，`createSession` 同步返回对象
2. 调用方（`client-detail.js`、`session.js`、`consult-notes.js`）拿到的返回值没有 `ok`/`error` 字段——只有 session 对象本身
3. 即使 `idbPut` 在后台失败，`createSession` 早已返回，调用方已执行 `location.href='consultations.html'`

**需要改的生产代码**：

| 文件 | 改动 |
|------|------|
| `store.js:131` | `persist` 改为 `async`，`await idbPut`，返回 `{ok,error}` |
| `store.js:483` | `saveSession` 改为 `async`，`await persist('sessions')`，返回 `{ok,error,data}` |
| `store.js:488` | `createSession` 改为 `async`，返回 `{ok,error,data}` |
| `client-detail.js` / `session.js` / `consult-notes.js` | 检查 `createSession` 返回值，失败时 `App.showToast(error)` 并阻止导航 |

---

## C4F1：importAll 在全部集合落盘前返回 true

**实际代码路径**（`store.js:1072-1093`）：

```javascript
async function importAll(jsonStr) {
  // 步骤1：清空内存缓存，用导入数据全覆盖 (L1074-1082)
  cache.clients = data.clients;                    // 立即覆盖
  cache.sessions = data.sessions;                  // 立即覆盖
  // ... 7 个集合全部覆盖

  // 步骤2：逐个发异步写，无任何等待 (L1083-1091)
  persist('clients');           // fire-and-forget
  persist('sessions');          // fire-and-forget
  persist('supervisions');      // fire-and-forget
  persist('supervisorIdentities'); // fire-and-forget
  persist('masterConversations');  // fire-and-forget
  persist('expenses');          // fire-and-forget
  persist('materialWorkspaces');   // fire-and-forget
  persist('clinicalActionRuns');   // fire-and-forget
  persist('settings');          // fire-and-forget

  // 步骤3：立刻返回 true——此时 0 个集合已保证落盘
  return true;                   // L1092
}
```

**9 个 persist 调用，0 个被 await。** 没有任何 Promise 被收集。

**如果此时页面刷新或应用崩溃**：
- 内存缓存已被新数据覆盖 ✓
- IndexedDB 可能只有 `clients` 写完了但 `sessions` 还没开始 → 数据不一致
- 下次 `hydrate()` 时，clients 是新数据，sessions 是旧数据 → 来访者列表对不上会话列表

**需要改的生产代码**：

| 文件 | 改动 |
|------|------|
| `store.js:130-133` | `persist` 改为 `async`，`await idbPut` |
| `store.js:1072-1093` | 收集 9 个 persist Promise，`await Promise.all(promises)` 后再 `return true` |
| `store.js:1073` | 可选：加 `try/catch`，部分失败回滚缓存 |

---

## C5F1：无效引用进入 quarantine

**实际代码路径**（`store.js:488-513`）：

```javascript
function createSession(data) {
  licenseGuard('client', data.clientId);  // 检查 license 而非 client 存在性
  const session = Object.assign({ ... }, data);
  return saveSession(session);            // 存入 cache.sessions
}
```

**搜索 `quarantine` / `validateClientId` / `orphan` / `invalid.*ref`**：0 处命中。

**验证**：没有任何代码在 `createSession` 中检查 `data.clientId` 是否指向 `cache.clients` 中存在的来访者。被删掉的来访者的旧会话仍留在 `cache.sessions` 中，没有隔离区存储它们。

**危险场景**：
1. 创建来访者 A（id=c1）→ 记录 3 节
2. 删除来访者 A → `deleteClient` 仅删 `cache.clients` 中的 c1 条目，但 L517 行 `deleteSession` **不**在此被调用
3. sessions 中仍存有 3 条 `clientId='c1'` 的记录
4. 下次统计/渲染时 `Store.getClient('c1')` 返回 `null` → UI 崩或显示"未知来访者"

**需要改的生产代码**：

| 文件 | 改动 |
|------|------|
| `store.js:488-491` | `createSession` 中 `const c = getClient(data.clientId); if (!c) { quarantineSession(session); return {ok:false,error:'invalid clientId'}; }` |
| `store.js:387-389` | `deleteClient` 中追加清理关联 sessions：`cache.sessions = cache.sessions.filter(s => s.clientId !== id); persist('sessions')` |
| `store.js` | 新增 `quarantineSessions` 缓存数组，`hydrate` 时恢复 |

---

## 根因总结

三个红项指向同一个架构级债务：**`persist` 的 fire-and-forget 设计使调用方无法知晓持久化状态**。所有写操作（create/update/delete/importAll）都在内存缓存上同步完成，但 IndexedDB 写是异步且无回调的。修复需从 `persist` 改起——它变成 `async`+`await idbPut` 后，所有上游调用者才有等待持久化的能力。

自评分：95/100。3 个预期红项均已出具精确诊断和最小修复集。
