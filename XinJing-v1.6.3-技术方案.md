# 心镜 XinJing v1.6.3 技术方案 — 批量 Bug 修复（Agent / AI 接口 / 数据 / 主进程）

> 版本基线：v1.6.2（COS 已上，包版本 1.6.2）
> 类型：纯 Bug 修复（无新功能模块）→ 按发布纪律规则 5 走 patch+1，目标包版本 **1.6.3**
> 范围：AG-1~10、A1~A7、S4~S11、M1~M9、UI-1~5、C1~C3（用户贴出的 bug 清单全量修复）
> 评审门禁：独立代码评审 ≥95 分方可发版（本方案随实现完成后由子代理对抗性评审）

## 一、范围与非目标

### 范围内
- Agent Orchestrator 工具调用链路（onProgress 契约、结构化截断、窗口截断、clientId 解析、license 守卫、过期会话回退）。
- AI 接口层（档位诚实化、function-calling 门控、模型降级、Qwen 大小写、JSON 解析保护、错误回调形状统一）。
- 数据层 Store（删客户级联督导、session 指纹、设置合并、旧端口迁移失败不冒充成功、blob 合并、license 守卫、saveSession 返回 flags、_dbPromise 重试）。
- 主进程（computeState 容错、license-state 早推、迁移 try/catch、符号链接穿越、备份路径校验、隐藏父窗口 modal）。
- UI（逐字稿列误显、中文 IME 守卫、导出崩溃、CSS token、prompts 内置生成）。

### 非目标
- 不新增功能模块（无 minor 跳版）。
- 不改动 `webSecurity:false`（本地单用户工具需向外部 AI API 发请求，contextIsolation 已开，可接受）。
- 不新增 CSP（会破坏内联事件处理器与跨域 AI 请求，风险高于收益，本期不做）。

## 二、逐模块改法

### 2.1 Agent 层（app/js/agent-core.js / agent-shell.js / agent-tools.js）
| 编号 | 文件 | 改法 | 验收 |
|---|---|---|---|
| AG-1 | agent-shell.js:331 | `onProgress` 放宽 `if (data)` 而非 `if (data && data.ok)`，避免空 data 误判；core 传 `{ok,data}` 外层，shell 读 `result.data` | 工具成功无 data 时进度正常收尾 |
| AG-2 | agent-tools.js:698 | supervision.start 仅当 clientId/clientName 有值时 resolveClientId；无则 followups=[] | 无来访者不强制建幽灵客户 |
| AG-3 | agent-tools.js:207 | billing.add_record required 改为 `[date,fee]`（去 clientName 强约束） | 已知 clientId 时可直接记 |
| AG-4 | agent-tools.js:279 | monthly_settle required 改为 `[month,amount]` | 同上 |
| AG-5 | agent-core.js:305 | 结构化截断：`_truncateStrings`+`safeStringify` 仅截字符串值，不再 `slice` 整段 JSON | 超长工具结果不再切半截 JSON 导致解析错 |
| AG-6 | agent-shell.js:174 | 进度文案经 `App.escapeHtml` 转义 | 含 `<` 的进度不破坏 DOM |
| AG-7 | agent-tools.js:771 | askSupervision 内存会话丢失时从 `Store.getSupervision` 回退重建 chatMessages | 刷新后继续督导不报"过期" |
| AG-8 | agent-core.js:81 | 窗口截断 `if (count+unit.length > windowSize) break`（去掉 `result.length>0` 强塞首段） | 首段超窗不再被强制塞入 |
| AG-9 | agent-tools.js | resolveClientId 加 `allowCreate`；无匹配且不允许创建时返回近似候选提示，防幽灵客户 | 错名不静默建新客户 |
| AG-10 | agent-tools.js:529 | configure_api required 改 `[]`，激活 partial 多轮收集分支 | 缺密钥不一次性报失败 |

### 2.2 AI 接口层（app/js/ai.js / 调用方）
| 编号 | 文件 | 改法 | 验收 |
|---|---|---|---|
| A1 | ai.js | `supportsFunctionCalling` + `NO_TOOL_MODEL_RE` 拒绝 o1/o2/o3/o4/reasoning/deepseek-reasoner/r1；仅支持时注入 tools；HTTP 非2xx含tool关键词则去tools重试 | 不支持模型不再盲注 tools 触发 400 |
| A2 | ai.js | `callWithFallback` 用户模型失败→回退 BUILTIN_MODEL，返回 `{degraded}`；内置也失败才返 error | 用户密钥错不硬失败 |
| A3 | ai.js:54 | `getActiveConfig` 与 `getTier` 一致：必须 `verified===true` 才用用户配置 | 错密钥不再谎报高性能 |
| A4 | ai.js / session.js | `chat` 错误回调统一为 `{error}`；session.js 两个 `AI.chat` 调用方处理 `reply.error` | 错误不再被当普通消息渲染 |
| A5 | ai.js:104 | **经自测回退**：原方案「不合并 assistant」会使 Q1/Q5 失败并回归 20015 修复。核对合法对话序列中 assistant 之间必有 user/tool 隔开，原合并（content+tool_calls 并回一条）是 20015 修复的必要动作，故保留原合并逻辑，仅在 (a)(b) 二次修正层保证 tool 配对不破坏 | 自测 127/127 通过，Q1/Q5 通过 |
| A6 | ai.js:194 | Qwen 检测改 `/qwen/i`（大小写不敏感） | `qwen/...` 也能禁用思考 |
| A7 | ai.js:227 | `resp.json()` 加 `.catch` + 空 choices 保护，抛清晰错误 | 网关 HTML 错误页不再抛出难懂异常 |

### 2.3 数据层（app/js/store.js / 调用方）
| 编号 | 文件 | 改法 | 验收 |
|---|---|---|---|
| S4 | store.js:876 | sessionKey 加唯一字段（sessionNumber+id）防同日空 session 互删 | 同日多空 session 不被误并 |
| S5 | store.js:328 | deleteClient 级联督导改 `some`（非 `every`） | 任一 session 在则保留督导 |
| S6 | store.js:782 | mergeInto 旧端口真实 apiKey 合并进当前（当前无密钥时） | 迁移后密钥不丢 |
| S7 | store.js:822 | migrateOldPorts 写入失败标记 `failed` → 拒绝 resolve（不再冒充成功） | 部分失败明确报错 |
| S8 | store.js | 新增 `idbDelete`/`mergeLegacyBlobs`：旧版 `clients_blob_<sessionId>:<field>` 合并回对应 session 并删孤儿键 | 旧大字段真正可用 |
| S9 | store.js:373 | `createSession` 加 `licenseGuard('client', data.clientId)`，受限模式只读来访者不可加节次 | 与客户端守卫一致 |
| S10 | store.js:364 | `saveSession` 返回带 flags 的 `meta`（非原始 session） | 报告中心标记不丢 |
| S11 | store.js:36 | `_dbPromise` reject 时清空缓存，允许重试 | 一次性打开失败不永久锁死 |

### 2.4 主进程（main.js / preload.js）
| 编号 | 文件 | 改法 | 验收 |
|---|---|---|---|
| M1 | main.js:733 | `computeState()` 包 try/catch，失败用默认未激活态 | 启动不因授权计算崩 |
| M2 | main.js:746 | did-finish-load 早推 `xj:license-state` | 付费/试用用户短暂不误锁 |
| M3 | （既有设计已覆盖） | 渲染页经 `getState()` 拉权威态，非依赖 `window.__XJ__` 快照；reload 后重新拉取 | 激活后 AI 锁即时解除（已具备） |
| M4 | main.js:744 | 旧端口迁移服务启动包 try/catch | 异常不再未处理 rejection |
| M5 | （接受） | `webSecurity:false` 保留（AI 外呼必需，contextIsolation 已开） | — |
| M6 | （接受） | 不新增 CSP（避免破坏内联事件+跨域） | — |
| M7 | main.js:320 | `serveApp` 加 `fs.realpathSync` 校验真实路径仍在 APP_DIR | symlink 不可穿越读外部 |
| M8 | main.js:140 | `exportBackup` 自定义位置导出前校验（存在+为目录） | 失效路径不静默失败 |
| M9 | main.js:504 | closeConfirmWin 仅当主窗口可见才设为 modal 父；隐藏时不挂父 | 托盘退出确认窗可见可点 |

### 2.5 UI / 构建
| 编号 | 文件 | 改法 | 验收 |
|---|---|---|---|
| UI-1(P0) | billing.html | `doExport` 对缺 `date` 记录 `(r.date||'')` 兜底，防 `slice`/`startsWith` 崩溃 | 缺日期记录不再导出崩溃 |
| UI-2 | settings.js:665 | CD 输入框 `keydown` 加 `!e.isComposing && e.keyCode!==229` | 中文输入回车不误发 |
| UI-3 | reports.js:103 | 逐字稿列改 `tag-transcript`（非 `tag-confirmed`✓已确认） | 不再混淆有稿/已确认 |
| UI-4 | app.js/session.html/supervision.html/masters.html | 4 处聊天/命令输入加 IME 合成守卫 | 中文合成中回车不发送 |
| UI-5 | sync.js/meetings.js | 导入 `createClient` 包 try/catch，license 上限部分失败提示不崩 | 受限模式导入不整批崩 |
| C1 | style.css | `:root{--radius-sm:var(--r-sm)}` 别名，兼容旧引用 | 旧 CSS 变量不丢失 |
| C2 | agent.css | 定义 `--clay` 浅/暗值（不依赖 fallback） |  clay 色稳定 |
| C3 | cnb-build.ps1 | 构建前调用 `gen-prompts-builtin.py` 重生成 gitignored `prompts.builtin.js` | 内置提示词随构建刷新 |

## 三、验收清单（自测 + 手测）
1. `node --check` 全部改动 JS 通过（已执行：9 个文件全 OK）。
2. Agent 跑一轮含工具调用的对话：进度正常、超长结果不报错、刷新后续问不报过期。
3. 受限模式（5 客户上限）导入第 6 位来访者 → 提示受限，已导入部分保留，不崩溃。
4. 报告中心逐字稿列显示「逐字稿」标签，已确认列仍显示「✓已确认」。
5. 中文输入法下回车不误发消息。
6. 激活后 AI 锁即时解除（无需整页刷新）。
7. 主进程：托盘退出确认窗在后台常驻时仍可见可点；备份失效路径不静默失败。

## 四、影响面与回归风险
- A3 改 `getActiveConfig` 需 `verified`：未验证密钥一律走内置，与档位铁律一致；configure_api 流程已先 `testConnection` 置 verified。
- S9 给 `createSession` 加守卫：受限模式超 5 客户加节次被拦；client-detail.js 已 try/catch toast 兜底；billing-shell/seed-data/agent-tools 在完整版不受影响。
- M7/M8/M9 仅加固，不影响正常路径。
