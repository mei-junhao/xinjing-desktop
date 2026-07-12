# 心镜 XinJing v1.7.0 技术方案 —— 免费试用代理档（韩国服务器 v4-flash 限量体验）

> 目标：为免费/未激活用户接入作者部署在韩国服务器（`xinjingchat.online`）的代理，
> 额度内使用高性能 **DeepSeek-V4-Flash**（¥5 / 30 天 / 机器码），超额或过期自动降级到
> 内置基础模型 **Qwen3.5-4B**（走代理，不限量免费），以此培养付费习惯。
> 同时把内置低性能模型的 SiliconFlow Key 移上服务端，**客户端不再持有任何 provider 密钥**，安全性提升。

---

## 一、架构总览

```
客户端（Electron 渲染进程）
  ai.js
   ├─ getActiveConfig(): 用户已 verified → 用户模型(最高优先)
   │                    否则 → 试用代理档 buildTrialConfig(getTrialModel())
   │                              getTrialModel(): 代理未明确降级(basic) → deepseek-v4-flash
   │                                            否则 → Qwen3.5-4B
   ├─ callDirect(): 试用档注入 Authorization: Bearer <APP_PROXY_KEY> + X-Machine-Id:<机器码>
   │              读取响应头 X-Tier / X-Quota-* 实时更新额度缓存并广播
   └─ 额度缓存 QUOTA_CACHE + onQuotaChange 订阅 + fetchQuota 主动查询
        │
        │ HTTPS (OpenAI 兼容 /v1/chat/completions + /quota)
        ▼
韩国代理 (xinjingchat.online:443, Node 自终止 TLS)
  server.js (chat-proxy-server.js)
   ├─ 鉴权：共享密钥 + 机器码（X-Machine-Id）双因子
   ├─ 路由：model 含 v4-flash 且未超额/未过期 → DeepSeek-V4-Flash（按 usage 计费 ¥）
   │       否则 → Qwen/Qwen3.5-4B（SiliconFlow，不限量免费）
   ├─ 配额记账：quota.json（JSON 文件持久化），滚动 30 天窗口，硬限额 ¥5
   └─ 响应用响应头 X-Tier / X-Quota-Percent / X-Quota-Remaining 回传客户端
```

**密钥不入库**：`APP_PROXY_KEY` 由 `codegen-secret.js` 注入 `secret.generated.js`（gitignored，构建期打进 exe）；
provider key（DeepSeek / SiliconFlow）仅存服务端 `/opt/chat-proxy/.env`（600，root）。

---

## 二、客户端改动（app/）

### ai.js
- 头部：移除内置模型直连 SiliconFlow 的明文 Key；新增 `PROXY_BASE='https://xinjingchat.online/v1'`
  `getProxyKey()`（经 preload `window.__XJ_API__.appProxyKey`）/`getMachineCode()`（经 preload `getMachineCode`）。
- `BUILTIN_MODEL = buildTrialConfig('Qwen3.5-4B')`：保留常量名供旧引用，实为试用代理基础模型。
- 新增额度模块：`QUOTA_TOTAL_YUAN=5`、`QUOTA_CACHE`、`getQuota/fetchQuota/onQuotaChange/updateQuotaFromHeaders/applyQuotaInfo`。
- `getActiveConfig()`：用户 verified → 用户配置（`isUser:true`）；否则 `buildTrialConfig(getTrialModel())`。
- `getTrialModel()`：代理未降级(`tier!=='basic'`)→ `deepseek-v4-flash`，否则 `Qwen3.5-4B`。
- `callDirect()`：试用档 `await getMachineCode()` 注入 `X-Machine-Id`；响应后 `updateQuotaFromHeaders(resp.headers)`。
- `callWithFallback()`：降级判定由 `config!==BUILTIN_MODEL` 改为 `config.isUser`（对象每次新建，旧比较失效）。
- 导出：`getQuota / fetchQuota / refreshQuota / onQuotaChange / getTrialModel`；页面加载自动 `fetchQuota()`。

### agent-core.js
- `buildSystemPrompt` 内置档提示词更新为试用档措辞：额度内 v4-flash、超额降级基础模型、
  引导购买会员/增量包恢复、支持的服务商列表、function-calling 不支持模型主动提示。
  保留「低性能」「普通任务」字眼（供自测 I1）。

### agent-shell.js
- `refreshTierUI` 内置档横幅改为「🌱 免费试用 · v4-flash（额度用尽降级基础模型）」+ 剩余百分比徽标。
- 新增 `updateAgentQuotaBadge()`，订阅 `AI.onQuotaChange` 实时刷新徽标。

### settings.js
- 新增 `renderTrialQuota()`：免费档显示剩余百分比进度条 + 约 ¥ 余额 + 重置时间 + 购买引导；用户档隐藏。
- `updateTierStatus()` 末尾调用；`onReady` 订阅 `onQuotaChange` 并主动 `fetchQuota()`。

### settings.html
- `api-tier-status` 后新增 `<div id="trial-quota-box">` 容器。

### preload.js
- 暴露 `appProxyKey: () => require('./secret.generated').APP_PROXY_KEY`（已有 `getMachineCode`）。

### scripts/codegen-secret.js
- 从 `.license-secret` + `.app-proxy-key` 合并注入 `secret.generated.js`（含 `SECRET` + `APP_PROXY_KEY`）。

---

## 三、服务端改动（/opt/chat-proxy/server.js，v1.7.0）

- 保留原有 TLS（certbot 证书 `/etc/letsencrypt/live/xinjingchat.online`）、80→443 跳转、systemd 守护。
- 保留旧 `POST /` DeepSeek 透传（向后兼容）。
- 新增 `POST /v1/chat/completions`：共享密钥 + 机器码鉴权；按 model 路由 DeepSeek-V4-Flash（计费）/
  SiliconFlow-Qwen3.5-4B（免费）；**透传 `tools`/`tool_choice`**（Agent 工具调用依赖）；
  响应头回传 `X-Tier`/`X-Quota-Percent`/`X-Quota-Remaining`。
- 新增 `GET /quota?mid=<机器码>`：返回 `{tier, spentYuan, budgetYuan, remainingYuan, percent, resetAt}`。
- 配额记账：进程内缓存 + `data/quota.json` 同步落盘；滚动 30 天窗口；`spent>=¥5` 即 tier='basic' 降级。
- CORS `*`，允许 `X-Machine-Id` 头。
- 密钥来源 `.env`：`DEEPSEEK_API_KEY` / `SILICONFLOW_API_KEY` / `APP_PROXY_KEY` / `QUOTA_BUDGET_YUAN=5` / `QUOTA_WINDOW_DAYS=30`。

**已实机部署并验证**：
- `systemctl restart chat-proxy.service` 后 `is-active=active`。
- `GET /` 健康检查、`GET /quota?mid=...` 返回 `{tier:'v4', percent:100, remainingYuan:5}`。
- `POST /v1/chat/completions`（X-Machine-Id + Bearer 共享密钥 + model=deepseek-v4-flash）→ 返回真实
  `deepseek-v4-flash` 响应；二次 `GET /quota` 显示 `spentYuan` 已扣减（¥0.0001）。
- 带 `tools` 的请求返回正确 `tool_calls` 结构（Agent function-calling 链路可用）。

---

## 四、验收清单

| 项 | 验证方式 | 结果 |
|---|---|---|
| 免费用户默认走 v4-flash | `getActiveConfig().model==='deepseek-v4-flash'` | ✅ 自测 G1 |
| 用户 verified 优先于试用档 | G2 / G2b | ✅ |
| 机器码 + 共享密钥鉴权 | 实机调用 + 缺头 401 | ✅ 实机 |
| 超额/过期降级基础模型 | `tier==='basic'` 时 `getTrialModel()==='Qwen3.5-4B'` | ✅ 逻辑 + 代理 |
| Agent 工具透传 | 实机 tools 请求返回 tool_calls | ✅ 实机 |
| 额度百分比实时展示 | settings + Agent 浮窗订阅 onQuotaChange | ✅ 代码 + 实机头 |
| 客户端不持 provider key | SiliconFlow Key 已移服务端；repo 无明文 | ✅ 代码审计 |
| 密钥不入库 | `.env.production`/`.app-proxy-key`/`secret.generated.js` 均 gitignore | ✅ git check-ignore |
| 自测全绿 | `node scripts/self-test.js` | ✅ 127/127 |
| 独立对抗性评审 | ≥95 | 见评审报告 |

---

## 五、风险与遗留

- 共享密钥可被逆向（桌面端本质），但服务端按机器码硬限额 ¥5/30天 兜底，刷量不可行。
- 实时计费基于 DeepSeek `usage` 字段；缓存命中价忽略，计费偏保守（对用户有利）。
- 机器码复用现有 `resolveFirstInstall()`（绑定 `%ProgramData%\XinJing\.xjinstall` + 机器码），重装不刷额度。
- 试用期后行为：v4-flash 自动停用回退 Qwen3.5-4B（已落地）；会员/增量包恢复为后续支付模块（本期未含微信支付）。
- 剩余百分比展示依赖 `/quota` 或响应头；离线/代理不可达时显示「查询中…」，不阻塞使用。
