# 心镜 XinJing v1.6.4 技术方案（Agent 改造方案 · P0-1 改动 D + P2-2）

> 本版是《XinJing-Agent-改造方案.md》七档中的第一批落地。
> 文档其余档（P0-2/3/4、P1-1/1-2、P2-1）已在 v1.6.3 等价实现或留待后续版本。
> 本版只做两处低风险、低风险改动，遵循「小步迭代」铁律。

---

## 一、背景与范围

《XinJing-Agent-改造方案.md》原写于 v1.6.1→目标，其中：

- **P0-2 / P0-3 / P0-4**：已在 v1.6.3 等价实现（AG-1/AG-5/AG-2~10），本次**不重复**。
- **P0-1**：v1.6.3 已用「denylist 正则拒绝不可用模型」(`supportsFunctionCalling` + `NO_TOOL_MODEL_RE`) 实现注入门控与 `callWithFallback` 真降级（A1/A2）。本次仅补文档「**改动 D：runRound 启动前能力自检**」——这是 v1.6.3 缺的一环。
- **P2-2**：系统提示措辞修正。文档原稿要求把内置档写成「**仅纯对话可用**」，但经亲核：本工程 denylist 逻辑下内置 `Qwen/Qwen3.5-4B`（SiliconFlow）**实际支持 function-calling**（否则 v1.6.3 免费档 Agent 工具全挂）。照字面改会制造与事实矛盾的系统提示，故**改为准确的表述**，并与 P0-1 门控一致。

---

## 二、改动 1：P0-1 改动 D — runRound 启动前能力自检

### 文件
- `app/js/ai.js`（导出暴露）
- `app/js/agent-core.js`（`runRound` 自检）

### 现状
`runRound` 不预判模型能力。当前 `callDirect` 已按 `supportsFunctionCalling(config)` 决定是否注入 tools；对 denylist 命中模型（o1/o2/o3/o4/reasoning/deepseek-reasoner/r1）不注入 tools → 工具静默不可用，但用户无任何反馈，体验差。

### 改动 A — ai.js 暴露能力判断（`return { ... }` 块内，紧跟 `normalizeMessageSequence`）

```js
  // 模型是否支持 function-calling（denylist：已知不支持的推理/专属模型拒绝，其余默认支持）
  supportsFunctionCalling,
  // 兼容文档命名：isToolCapable(model, baseUrl) → 委托 denylist 判断
  isToolCapable: function (model, baseUrl) {
    return supportsFunctionCalling({ model: model, baseUrl: baseUrl });
  },
```

### 改动 B — agent-core.js `runRound` 启动前自检（在 `if (!isUnlocked())` 门控之后插入）

```js
    // === 模型能力自检（P0-1 改动 D）===
    // 当前生效模型明确不支持 function-calling（denylist 命中 o1/o2/o3/o4/reasoning/deepseek-reasoner/r1）时，
    // 直接友好提示，避免工具被盲注后静默 400 或「无工具可用却无反馈」。
    try {
      const _cfg = (typeof AI !== 'undefined' && AI.getActiveConfig) ? AI.getActiveConfig() : {};
      const _capable = (typeof AI !== 'undefined' && AI.isToolCapable)
        ? AI.isToolCapable(_cfg.model, _cfg.baseUrl)
        : true;
      if (!_capable) {
        return { error: '当前模型（' + (_cfg.model || '内置') + '）不支持工具调用，请到设置接入支持 function-calling 的模型（DeepSeek / OpenAI / Kimi / 智谱 / 通义 / 豆包等）后再使用 Agent 工具。' };
      }
    } catch (e) { /* 自检异常不阻断，交由 callDirect 兜底 */ }
```

> 语义保证：内置 `Qwen/Qwen3.5-4B` 不在 denylist → `_capable=true` → 正常注入 tools；用户填 o1 等 → `_capable=false` → 友好报错。

---

## 三、改动 2：P2-2 — 系统提示措辞修正（纠偏）

### 文件
- `app/js/agent-core.js` `buildSystemPrompt`（内置档段落，原 L407）

### 现状（原稿）
```
[档位] 你运行在内置低性能免费模型（Qwen3.5-4B，永久免费），只能完成普通任务
（记账 / 月结 / 查统计 / 改来访者信息 / 配 API）。复杂长篇分析……
```

### 问题
- 「**仅纯对话可用**」式表述（文档 P2-2 文案）与事实矛盾：内置 Qwen3.5-4B 实际支持工具调用。
- 需与 P0-1 门控一致地说明「工具可用性取决于模型」。

### 改动（准确表述，保留事实 + 与门控一致）

```js
'\n\n[档位] 你运行在内置免费模型（Qwen3.5-4B，永久免费，支持工具调用），可完成记账 / 月结 / 查统计 / 改来访者信息 / 配 API 等任务。若用户需要更复杂长篇分析或真人督导式深度工作，引导其填入自己的高性能模型 key——支持的服务商：DeepSeek / 硅基流动 / OpenAI / 月之暗面 Kimi / 智谱 / 通义千问 / 豆包；用户只需说出服务商名和 API Key，你就能从内置预设表自动配好。注意：若用户接入的模型不支持 function-calling（如 o1/o2/o3/o4 系列或 reasoning 模型），Agent 会主动提示其换用支持的模型，而非静默失效。'
```

---

## 四、验收标准

| 编号 | 验证点 | 预期 |
|---|---|---|
| P0-1-D | 内置 Qwen3.5-4B 开 Agent | 正常注入 tools，工具可用（回归 v1.6.3 行为） |
| P0-1-D | 用户接入 o1/o2/o3/o4/reasoning 等 | runRound 返回友好错误「当前模型…不支持工具调用，请接入…」，不再静默 400 |
| P0-1-D | 自检异常（AI 未注入） | try/catch 吞掉，不阻断，callDirect 兜底 |
| P2-2 | 内置档系统提示 | 准确描述「支持工具调用」，且与门控一致；不出现「仅纯对话」谎言 |

---

## 五、风险与回滚

- **风险**：极低。仅新增只读自检分支 + 文案微调，不改变工具注入/降级主链路。
- **回归防护**：`self-test.js` 全量跑绿；独立对抗性评审 ≥95。
- **回滚**：单 commit `app/js/ai.js` + `app/js/agent-core.js`，可 `git revert` 精确回退。

---

## 六、发版动作

1. 本地提交（fix: v1.6.4 ...）
2. `scripts/cnb-build.ps1` 后台构建：1.6.3 → 1.6.4，6 产物上传 COS
3. GitHub cadence：距上次 push（v1.6.3）仅 1 版，**未达 4 版，本版不 push**（遵循用户设定）
