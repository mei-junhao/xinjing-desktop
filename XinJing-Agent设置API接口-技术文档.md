# 心镜 · 通过 Agent 设置 API 接口 — 技术文档

## 一、整体架构

```
用户对 Agent 说"接入 DeepSeek，密钥 sk-xxxx"
        │
        ▼
agent-shell.js → AgentCore.runRound() → LLM 选择工具 agent.configure_api
        │
        ▼
agent-tools.js → configureApi(args) → AI.testConnection(config)
        │                                            │
        ▼                                            ▼
Store.saveSettings({ apiConfig: { ... } })    ai.js → fetch(baseUrl + '/chat/completions')
                                                          ├── model: xxx
                                                          ├── temperature: 0.3
                                                          └── messages: [{ role: 'user', content: 'ping' }]
```

## 二、关键文件与函数

### 2.1 Agent 工具定义：`agent-tools.js`

**工具注册位置**：`agent-tools.js` 第 515 行 `SCHEMA_CONFIGURE_API`

**8 个预设供应商**（第 454-510 行）：

| provider key | label | baseUrl | 默认模型 |
|---|---|---|---|
| `deepseek` | DeepSeek | https://api.deepseek.com/v1 | `deepseek-v4-flash` |
| `siliconflow` | 硅基流动 | https://api.siliconflow.cn/v1 | `Qwen/Qwen3.5-4B` |
| `openai` | OpenAI | https://api.openai.com/v1 | `gpt-4o` |
| `moonshot` | 月之暗面 | https://api.moonshot.cn/v1 | `moonshot-v1-8k` |
| `zhipu` | 智谱 GLM | https://open.bigmodel.cn/api/paas/v4 | `glm-4-flash` |
| `qwen` | 通义千问 | https://dashscope.aliyuncs.com/compatible-mode/v1 | `qwen-plus` |
| `doubao` | 豆包 | https://ark.cn-beijing.volces.com/api/v3 | `doubao-pro-32k` |
| `other` | 自定义 | （需手动填） | （需手动填） |

### 2.2 核心配置函数：`configureApi(args)`（第 534-625 行）

**执行流程**：

1. **多轮合并**：从 `Store.getSettings().apiConfig` 加载已存的配置，本轮 args 覆盖旧的（实现多轮对话逐步收齐配置）
2. **解析 provider 预设**：
   - 非 `other`：从 `API_PROVIDERS[provider]` 自动取 baseUrl 和 defaultModel，用户只需给 provider 名 + apiKey
   - `other`：必须手动给 baseUrl + model
   - 非预设名 + 有 baseUrl+model：直接使用
3. **分阶段收集**：
   - 没 key → 存 partial，返 `switchedTo: 'partial'`，提示用户给 key
   - 没 baseUrl/model → 存 partial，提示需更多信息
   - 齐全 → 执行真实连接测试
4. **连接测试**（第 592-595 行）：
   ```javascript
   AI.testConnection({ baseUrl, apiKey, model })
   ```
5. **结果处理**：
   - 成功（第 597-609 行）：`merged.verified = true` → 存 → 返 `switchedTo: 'user'`
   - 失败（第 611-624 行）：`merged.verified = false` → 存 → 返 `switchedTo: 'builtin'` + `testError`

### 2.3 配置文件存储位置

```javascript
Store.saveSettings({ apiConfig: { ... } })
```

实际存储在 IndexedDB（`xinjing_db` → `kv` store），键 `key === 'settings'`，字段 `apiConfig`。

**存盘结构**：
```json
{
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-...",
  "modelPreference": "deepseek-v4-flash",
  "provider": "deepseek",
  "maxTokens": 4000,
  "verified": true
}
```

### 2.4 连接测试函数：`AI.testConnection(config)`（`ai.js` 第 183-200 行）

```javascript
async function testConnection(config) {
  const msg = await callDirect(
    { baseUrl, apiKey, model, maxTokens: 16 },
    [{ role: 'user', content: 'ping' }],
    {}
  );
  if (msg && typeof msg.content === 'string') return { ok: true };
  return { ok: false, error: '空响应' };
}
```

- 发一次极简请求（`maxTokens: 16`，无 system prompt）
- 只要有 string 响应就算成功
- 网络错误 / HTTP 错误 / 非 JSON 响应都算失败

### 2.5 档位判定：`AI.getActiveConfig()` 和 `AI.getTier()`（`ai.js` 第 159-179 行）

```javascript
function getActiveConfig() {
  const user = Store.getSettings().apiConfig;
  if (user && user.apiKey && user.verified === true) {
    // 用户已通过连接验证 → 用用户配置
    return { baseUrl, apiKey, model, maxTokens, label: '用户模型', isUser: true };
  }
  // 否则走试用代理
  return { baseUrl: PROXY_BASE, apiKey: proxyKey, model: trialModel, isTrial: true };
}

function getTier() {
  const user = Store.getSettings().apiConfig;
  return (user && user.apiKey && user.verified === true) ? 'user' : 'builtin';
}
```

**关键规则**：`verified === true` 是档位判定的 **唯一事实来源**。填了 key 但没验证/验证失败 → 仍走 builtin。

### 2.6 Agent 系统提示中的引导（`agent-core.js` 第 408 行）

```javascript
'8. 配置 API 接口时，如果用户只说了服务商名（如 DeepSeek 或 硅基流动）和密钥，' +
'从 agent.configure_api 的 provider 参数填预设名即可——handler 会自动查出 baseUrl 和默认 model。' +
'不要让用户手动找 baseUrl 和 model 名。' +
'若用户说出未在预设列表的服务商，选 other 并问用户要 baseUrl 和 model 名。'
```

## 三、多轮对话流程示例

用户说：**"帮我接入 DeepSeek，密钥是 sk-abc123"**

```
Round 1: LLM 调用 agent.configure_api({ provider: 'deepseek', apiKey: 'sk-abc123' })
  → handler 自动查出 baseUrl=https://api.deepseek.com/v1, defaultModel=deepseek-v4-flash
  → 存 partial: { baseUrl, apiKey, modelPreference, provider, maxTokens:4000 }
  → AI.testConnection({ baseUrl, apiKey, model: 'deepseek-v4-flash' })
  → 成功: verified=true → 返 switchedTo:'user'
  → Agent Shell 收到后调 refreshTierUI() → 首页/设置页档位横幅更新为"完全体"
```

用户说：**"我想用 OpenAI"**

```
Round 1: LLM 调用 agent.configure_api({ provider: 'openai' })
  → 自动查 baseUrl 和默认 model
  → 没 key → 存 partial → 返 need:'apiKey'
  → Agent 追问："收到，端点已设好。请把您的 OpenAI API 密钥发给我。"
  
Round 2: 用户发密钥 → LLM 再调 agent.configure_api({ provider: 'openai', apiKey: 'sk-xxx' })
  → 多轮合并: 新 apiKey + 已存的 baseUrl/model
  → testConnection → verified=true
```

## 四、设置页手动配置（同源逻辑）

`settings.js` 第 546-772 行实现了「接入高性能 AI」抽屉（`openConnectDrawer`），逻辑与 Agent 工具完全一致：

- 同样的 `PROVIDER_PRESETS`（第 551-560 行，与 agent-tools.js 重复——需两边同步更新）
- 同样的 `AI.testConnection()` 做真实测试
- 同样的 `Store.saveSettings({ apiConfig: { ..., verified: true/false } })` 存盘
- 同样的 `verified` 为唯一事实来源

## 五、设置页档位状态展示（`settings.js` `updateTierStatus` 第 83-105 行）

| 条件 | 显示 |
|------|------|
| `tier === 'user'` | "⚡ 你的高性能模型 · deepseek-v4-flash（已验证，完全体）" |
| 填了 key 但未验证 | "🌱 内置免费模型 · 你填的密钥未验证，点「接入高性能 AI」重新验证" |
| 其他（builtin） | "🌱 内置免费模型 · Qwen/Qwen3.5-4B（低性能，仅普通任务）" |

## 六、复制注意事项

如需在新页面或新组件中复用此功能，需保证：

1. **`agent-tools.js` 的 `API_PROVIDERS`** 与 **`settings.js` 的 `PROVIDER_PRESETS`** 同步更新——两处有重复定义
2. **`verified` 是档位唯一事实来源**，不能用 `apiKey` 是否为空来判断
3. `Store.saveSettings({ apiConfig })` 后，需调用 `updateTierStatus()` 或 `refreshTierUI()` 刷新 UI
4. `AI.testConnection()` 要 `await`，它是 `async` 函数
5. Agent 系统提示词（`agent-core.js` L408）中的引导说明要同步更新
