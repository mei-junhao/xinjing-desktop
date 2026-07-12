# 心镜 XinJing v1.6.2 — Agent 退化循环修复说明

> 日期：2026-07-13
> 关联：v1.6.0（Agent 数据感知能力大幅增强）、v1.6.1（已发布）
> 状态：源码已提交 `f67aa2c`，构建上传 COS（包版本 1.6.2）进行中

---

## 1. 故障现象（用户实测）

问 Agent「谁跟我工作最久的来访是谁」，Agent 的行为是：

```
正在执行：stats.overview…  ✓ 已完成
正在执行：stats.overview…  ✓ 已完成
…（重复 8 次）…
⚠ 操作步数超限（8 步），请分步或改用批量 records
```

**全程没有回答任何内容**，直接撞到 `MAX_STEPS=8` 步数上限放弃。

---

## 2. 根因诊断

### 2.1 不是数据 bug

`stats.overview` 的 handler（`agent-tools.js` `statsOverview`）直接返回 `aggregateAll()`，其中包含：

```js
longestClient: { name, firstSessionDate, tenureDays }
```

自测 **T41** 已验证：有会谈的来访者会被正确算出 `longestClient`，且 `tenureDays` 以首会谈日期为基准。也就是说，**工具返回的数据本身是正确的、包含"谁最久"的答案**。

### 2.2 是 function-calling 退化循环

编排器 `agent-core.js` 的 `runRound` 是一个循环：

```
调模型 → 模型发 tool_calls → 执行工具 → 把结果push回消息 → 再调模型 → …
```

模型在拿到 `stats.overview` 的结果（含 `longestClient`）后，**没有产出最终文字，而是又发了一个 `stats.overview` 的 tool_call**。如此反复 8 次。

这是 **DeepSeek 在「系统提示强约束必须先查工具」（规则 9）下的典型退化循环**：模型把"必须先查工具"理解成"应该一直发工具调用"，且看到结果后仍不收敛到文字回答。模型本身不笨，是循环控制缺了"查到就停"的护栏。

---

## 3. 修复方案（编排器层，根源治理）

改动集中在 `app/js/agent-core.js` 的 `runRound`，分三层防护：

### 3.1 拿到首个结果后注入「直接回答」提示

```js
const ANSWER_NUDGE = {
  role: 'system',
  content: '你已通过工具取得真实业务数据。优先基于已有数据直接用自然语言回答用户（可引用具体姓名与数字）；除非确实需要另一项不同的数据，否则不要再调用工具，尤其不得重复调用已查过的同一工具。'
};
```

从第二次循环起，每轮把这条 system 提示拼到消息后发送给模型，温和地把模型拉回"该回答了"的状态。

### 3.2 退化循环硬检测 + 强制文字回答

每步算出 `singleKey`（仅当本轮只有 1 个工具调用时取该工具 key，否则为 null）：

```js
if (resultSeen && singleKey && singleKey === prevSingleKey) repeatCount++;
else repeatCount = singleKey ? 1 : 0;

if (resultSeen && singleKey && singleKey === prevSingleKey && repeatCount >= 2) {
  const finalText = await forceTextAnswer(trimmed);
  if (finalText) return { reply: finalText, messages, forced: true };
}
```

即：**同一工具连续调用 2 次**，判定为退化循环，立即用 `tool_choice: 'none'` 强制模型只回文字（不再发工具）：

```js
async function forceTextAnswer(baseMessages) {
  const r = await new Promise((resolve, reject) => {
    AI.send(baseMessages.concat([ANSWER_NUDGE]), cb,
      { tools: wireSchemas, tool_choice: 'none' });  // 关键：tools 必须保留
  });
  // 取 r.content
}
```

> **关键契约**（`ai.js` L187-191）：`tool_choice` 只有在 `options.tools` 非空时才会被注入请求体。所以不能只传空 `tools` 来禁用工具——必须 `tools` 与 `tool_choice:'none'` 同时传，既避免"有 tool 消息却无 tools 声明"的 400 报错，又强制模型只回文字。

### 3.3 不误伤正常流程

- **不同工具交错**（如 `stats.overview` → `client.query`）：`singleKey` 变化，`repeatCount` 重置，**不触发强制**。
- **单步多工具调用**（`willCallKeys.length > 1` → `singleKey = null`）：直接重置，**不触发**。
- **强制回答空串**（极端异常）：不返回空回复，继续循环交 `MAX_STEPS` 兜底。

### 3.4 系统提示规则 10

`buildSystemPrompt` 新增规则 10：「查到数据后用一次文字回复直接回答用户，不要再调用同一查询工具；同一查询工具连续调用两次即视为已获取足够信息，必须停止调用工具。」从源头降低模型发起重复调用的倾向。

---

## 4. 质量门禁

- **自测 T45 / T46**（新增，端到端跑真实 `runRound`）：
  - T45 用 mock「退化模型」（连发 `stats.overview` 3 次）→ 验证第 2 次被强制收敛、`reply` 含"张三"、`calls ≤ 4`、`forced === true`。
  - T46 用「正常模型」（查一次即答）→ 验证 `calls === 2`、`reply` 含"李四"、`forced !== true`（不误触发）。
- **全量 127 通过 / 0 失败**（原 125 + T45/T46）。
- **独立代码评审 97/100（≥95 可发版）**，无 P0/P1。

---

## 5. 验证你要的效果

修复后，同样问「谁跟我工作最久」，Agent 的行为变为：

```
正在执行：stats.overview…  ✓ 已完成
→ 工作最久的是张三（自 2024-01-01 起，至今约 XXX 天）。
```

最多 1 次查询 + 1 次文字回答，不再空转 8 次。

---

## 6. 发布

- 源码提交 `f67aa2c`（agent-core.js / self-test.js / PROJECT.md）。
- 构建走 `cnb-build.ps1`，`bump-version.js` 自 `1.6.1` patch-bump 至 **1.6.2** 上传 COS 自动更新通道。
- GitHub 本版不 push（距上次 v1.5.3 备份仅 2 版，未达 4 版 cadence）。
