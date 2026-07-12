# 心镜 XinJing Agent 改造可执行方案（v1.6.1 → 目标）

> 适用范围：`app/js/ai.js`、`agent-core.js`、`agent-tools.js`、`agent-shell.js`、`store.js`、`app.js`
> 执行铁律（沿用交接文档）：每改一档先出方案 + 评审 ≥95，小步迭代；本方案已按 P0→P2 排好序。

---

## P0-1 模型能力门控（解 R2：免费档 Agent 不可用）

**文件**：`app/js/ai.js`

**现状**：`callDirect`（`ai.js:188-191`）只要 `options.tools` 非空就注入，无任何能力判断；`callWithFallback`（`ai.js:213-225`）出错只返回 `{error}`，**从不回退**到内置模型。`agent-core.js:211,214,188,191` 对每个模型都注入 tools。后果：不支持 function-calling 的模型直接 HTTP 400，所有工具全挂；系统提示却谎称"内置模型也能记账"。

**改动 A — 新增能力白名单**（加在 `ai.js` `BUILTIN_MODEL` 定义后）：

```js
// 仅这些模型才注入 tools；其余按纯对话处理
const TOOL_CAPABLE_MODELS = new Set([
  'deepseek-chat','deepseek-v4-flash','deepseek-v4-pro',
  'gpt-4o','gpt-4o-mini','gpt-4-turbo',
  'moonshot-v1-8k','moonshot-v1-32k','moonshot-v1-128k',
  'glm-4','glm-4-flash','glm-4-air',
  'qwen-plus','qwen-max','qwen-turbo','qwen-long',
  'doubao-pro-32k','doubao-pro-4k','doubao-lite-32k',
  'Qwen/Qwen3-235B-A22B','deepseek-ai/DeepSeek-V3',
  'Qwen/Qwen3.5-4B' // 若实测支持工具调用则保留，否则移除
]);
function isToolCapable(model, baseUrl) {
  if (!model) return false;
  if (TOOL_CAPABLE_MODELS.has(model)) return true;
  // 兜底：OpenAI 兼容 + 非 4B 小模型默认可用
  return /\/v1$/.test(baseUrl || '') && !/4b$/i.test(model);
}
```

**改动 B — `callDirect` 按能力注入**（替换 `ai.js:188-191`）：

```js
if (options && options.tools && options.tools.length && isToolCapable(config.model, config.baseUrl)) {
  body.tools = options.tools;
  if (options.tool_choice) body.tool_choice = options.tool_choice;
}
```

**改动 C — `callWithFallback` 真正降级**（替换 `ai.js:213-225`）：

```js
async function callWithFallback(messages, options) {
  const config = getActiveConfig();
  try {
    const m = await callDirect(config, messages, options);
    return { content: m.content || '', tool_calls: m.tool_calls, tier: config.label };
  } catch (e) {
    // 仅当原配置不是内置模型时才回退；回退时不带 tools（内置模型不一定支持）
    if (config !== BUILTIN_MODEL) {
      try {
        const m2 = await callDirect(BUILTIN_MODEL, messages, options && options.tools ? {} : options);
        return { content: m2.content || '', tool_calls: m2.tool_calls, tier: BUILTIN_MODEL.label, degraded: true };
      } catch (_) { /* fall through */ }
    }
    return { error: '模型调用失败：' + (e.message || '未知错误') };
  }
}
```

**改动 D — `agent-core.js` 启动前能力自检**（`runRound` 开头，约 `agent-core.js:168` 后）：

```js
const _cfg = (typeof AI !== 'undefined' && AI.getActiveConfig) ? AI.getActiveConfig() : {};
const _capable = (typeof AI !== 'undefined' && AI.isToolCapable)
  ? AI.isToolCapable(_cfg.model, _cfg.baseUrl) : true;
if (!_capable) {
  return { error: '当前模型（' + (_cfg.model||'内置') + '）不支持工具调用，请到设置接入支持 function-calling 的模型后再使用 Agent 工具。' };
}
```

**验收**：用内置 Qwen3.5-4B（若非工具模型）打开 Agent 时，直接提示"需接入支持工具的模型"，不再 400；填入 deepseek key 后工具正常；key 错误时回退内置且不再循环报错。

---

## P0-2 修复 onProgress 载荷错位（解 R7：成功反馈永不渲染）

**文件**：`agent-core.js` + `agent-shell.js`

**现状**：`agent-core.js:307` `onProgress(toolKey,'done', result)` 传外层 `{ok,data}`；但 `agent-shell.js:309-336` 读 `data.switchedTo/data.card/data.added/data.receivable`（在 `result.data` 下一层）→ configure 完全体横幅、billing"已新增 N 条"、navigate 卡**全部不渲染**。

**改动**：

- `agent-core.js:307` 改为：

```js
onProgress(toolKey, 'done', result.data);
```

- `agent-shell.js:331` 改为：

```js
if (data) {
```

（其余分支 `data.switchedTo`/`data.card`/`data.added`/`data.receivable` 现在能正确命中。）

**验收**：配置成功后弹出"完全体"横幅 + toast；billing 录入后显示"✓ 已新增 N 条记录"；navigate_to 渲染跳转卡。

---

## P0-3 结构性截断，杜绝半截 JSON（解 R5）

**文件**：`agent-core.js:303-306`

**现状**：`JSON.stringify(result).slice(0, cap)` 按字符切，>20000 仍切半截 JSON。

**改动**：在 `agent-core.js` 增加工具函数，按"行数/字段"裁剪后再 stringify：

```js
function truncateResult(result, cap) {
  let s;
  try { s = JSON.stringify(result); } catch (e) { return '{"ok":false,"error":"结果序列化失败"}'; }
  if (s.length <= cap) return s;
  // 读类结果常见 payload：{ ok, data:{ clients:[...] / sessions:[...] / supervisions:[...] } }
  let clone;
  try { clone = JSON.parse(s); } catch (e) { return s.slice(0, cap); }
  const data = clone.data || {};
  ['clients','sessions','supervisions','perClient','details'].forEach(function (k) {
    if (Array.isArray(data[k]) && data[k].length > 10) data[k] = data[k].slice(0, 10);
  });
  clone.data = data;
  clone._truncated = true;
  return JSON.stringify(clone);
}
// 使用（替换原 :305）：
// const content = truncateResult(result, cap);
```

**验收**：构造 >20000 字符的 `client.query` 结果，断言 `JSON.parse(content)` 不抛错，且含 `_truncated:true`。

---

## P0-4 契约修正：合法输入不再被拒（解 R6）

**文件**：`agent-tools.js`

**改动 A** — `SCHEMA_ADD_RECORD`（`agent-tools.js:207`）：

```js
required: ['date', 'fee']   // 去掉 clientName
```

并在 `addBillingRecord`（`:222`）按"clientId/clientName 至少给一个"校验：

```js
if (!r.clientId && !r.clientName) { results.push({skipped:true, reason:'需提供 clientId 或 clientName'}); continue; }
```

**改动 B** — `SCHEMA_MONTHLY_SETTLE`（`agent-tools.js:279`）：

```js
required: ['month', 'amount']   // 去掉 clientName
```

handler `monthlySettle`（`:286`）改为校验 `if (!args.month || typeof args.amount!=='number' || (!args.clientId && !args.clientName))`。

**改动 C** — `supervision.start`（`agent-tools.js:698-700`）：仅当提供了 client 才解析：

```js
var clientId = null;
if (args.clientId || args.clientName) {
  var resolved = resolveClientId(args.clientId, args.clientName);
  if (!resolved.ok) return { ok:false, error: resolved.error };
  clientId = resolved.clientId;
}
```

**改动 D** — `configure_api` 多轮收集（`agent-tools.js:519`）：`required: []`（去掉 `apiKey`），让 `:561-572` 的 partial 分支可达；同时保留"最终测试前必须 apiKey"的校验（已有 `:562` 判断）。

**验收**：只传 `clientId` 的记账/月结请求成功；无 client 启动督导成功；仅给服务商名 + key 的 configure 走 partial 再补全。

---

## P1-1 会话持久化 + Store 回退（解 R4）

**文件**：`agent-tools.js` + `store.js`

**改动 A** — `store.js` 新增 Agent 会话存取（仿 `saveMasterConversation`）：

```js
// store.js 内与其他 save* 并列
function saveAgentSession(rec){ /* put KV 'agentSession:'+rec.id, rec */ }
function getAgentSession(id){ /* return rec or null */ }
function getAllAgentSessions(){ /* return array */ }
```

并在 `cache` / `persist` / `exportAll` / `importAll` 纳入 `agentSessions`（顺带修 P0 数据丢失 S1/S2：导出/导入补 `masterConversations` 与 `supervisorIdentities` 的 persist）。

**改动 B** — `agent-tools.js`：

- `supervisionSessions`（`:682`）改为懒加载：读取时若内存无则 `Store.getSupervision(args.sessionId)` 重建 `chatMessages`（需 `SupervisionCore` 提供反序列化或存全量 messages）。
- `masterConvs`（`:808`）已有 Store 回退（`:871-874`），与 supervision 对齐即可。
- `agent-shell.js:20` 的 `messages` 在 `buildPanel` 时从 `Store.getAllAgentSessions()` 恢复最后一条，关闭/每次回复后 `Store.saveAgentSession`。

**验收**：Agent 对话、督导会话、大师会话刷新后不丢失；`supervision.ask` 刷新后仍能追问。

---

## P1-2 页面桥接：让 Agent 真正打通督导/大师/导航（解 R3）

**文件**：`agent-shell.js` + `supervision.html` / `masters.html` / `app.js`

**改动 A** — `navigate_to` 真正跳转（`agent-shell.js:326` 分支）：直接 `location.href = data.card.href`（保留"用户主动点击"语义，但点击后真跳）。

**改动 B** — `supervision.start` 成功后派发事件（`agent-tools.js` handler 末尾，`:723` 前）：

```js
if (typeof window !== 'undefined' && window.dispatchEvent) {
  window.dispatchEvent(new CustomEvent('xj:agent:openSupervision', { detail: { sessionId: sv.id } }));
}
```

`supervision.html` 监听该事件 → 自动打开对应督导会话并渲染（复用其已有加载逻辑）。

**改动 C** — `masters.open` 成功后派发 `xj:agent:openMaster`（`agent-tools.js:834` 前），`masters.html` 监听 → 打开该会话。

**验收**：Agent 里说"开个督导/大师对话"，对应页面自动切到该会话；navigate 卡点击后真跳转。

---

## P2-1 新增缺失工具（解 R1：能力边界）

**文件**：`agent-tools.js`（新增 schema + handler 并注册到 `TOOL_REGISTRY`）

建议按优先级补：

1. `client.create`（写，确认）— 显式新建来访者（当前只有 auto-create）。
2. `session.update` / `session.delete`（写，确认）— 编辑/删除会谈（含 SOAP/DAP 字段，呼应设计文档）。
3. `meeting.*`（写/读）— 咨询日历（需求④ 规划中）。
4. `activation.*`（写）— 云激活（需求①）。
5. `report.export`（读/写）— 生成并导出报告。

每个工具统一遵循现有契约：`handler` 返回 `{ok,data}` 或 `{ok:false,error}`；写工具 `kind:'write'` 走 `onConfirm`；结果附 `data.followups`（层3 主动提示）。注册后在 `buildSystemPrompt`（`agent-core.js:332`）自动出现在工具列表，无需改其它。

**验收**：Agent 能新建客户、改/删会谈、管日历、触发激活、导出报告，且 confirm 卡有对应预览。

---

## P2-2 系统提示措辞修正（解 R2 一致性）

**文件**：`agent-core.js:351-379`

把 `:373` "内置低性能免费模型……只能完成普通任务（记账/月结/查统计/改信息/配API）" 改为：

> "内置模型为轻量兜底，**仅纯对话可用，工具调用需接入支持 function-calling 的模型（DeepSeek/OpenAI/Kimi/智谱/通义/豆包等）**。接入后你将获得完全体能力。"

与 P0-1 门控一致。

---

## 验收总表（交给执行 agent 对照）

| 编号 | 验证点 | 预期 |
|---|---|---|
| P0-1 | 内置模型开 Agent | 提示"需支持工具的模型"，不 400 |
| P0-1 | 错误 key | 回退内置，不无限循环 |
| P0-2 | 配置成功 | 弹"完全体"横幅 + toast |
| P0-2 | billing 录入 | 显"已新增 N 条记录" |
| P0-3 | >20000 字符读结果 | `JSON.parse` 不抛错 |
| P0-4 | 仅 clientId 记账/月结 | 成功 |
| P0-4 | 无 client 启动督导 | 成功 |
| P1-1 | 刷新 Agent/督导/大师 | 会话不丢 |
| P1-2 | Agent 开督导/大师 | 页面自动切到该会话 |
| P2-1 | 自然语言"新建客户/删会谈" | 走 confirm 卡并生效 |
| P2-2 | 内置档提示 | 措辞与门控一致 |
