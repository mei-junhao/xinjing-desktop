# 心镜 XinJing — 总交接文档（文档索引与全景）

> **本文件用途**：给下一个接手的 AI 一份"总入口"。它不重复各专题文档的细节，而是
> ①给出当前项目全景与状态快照；②把散落在两个目录下的**绝大多数文档编成带路径的索引**，
> 让你按需精读；③汇总跨文档的关键结论（授权/收费/服务器/已知 Bug/铁律）。
>
> **交接日期**：2026-07-14
> **当前包版本**：`v3.4.2`（`package.json`；`private:true` + `license:null`，尚未真正 OSI 开源）
> **本地根目录**：`D:\xinjing-electron\`
> **工作区文档目录**：`C:\Users\Administrator\WorkBuddy\2026-07-11-07-59-25\`
> **仓库**：GitHub `mei-junhao/xinjing-desktop`（在 GitHub 上，但仓库仍 private、无 LICENSE）

---

## 〇、30 秒速览（先读这段）

| 维度 | 现状 |
|------|------|
| 产品 | 心镜 = 面向心理咨询师的 Electron 桌面版（记账 / 来访者管理 / 逐字稿 / AI 督导 / 11 位大师对话 / 文档中心） |
| 版本轨 | 早期 1.x（v1.7.0 引入微信支付云激活方案）→ 现已推进到 **3.4.x**；PROJECT.md 记录停在 1.6.x，**以 `package.json` 与 v3.x 交接文档为准** |
| 授权现状 | **离线 HMAC 激活**（`license-core.js`）；60 天试用；云激活仅"重验签名"，**不记录支付**。付费真相源（Webhook→库→查库）仍是**待建方案**，见 v1.7.0 云激活文档 |
| 收费模型 | 两正交维度：**功能档位**(Free/Pro/Custom) × **算力来源**(BYOK / 官方请求包 / 内置兜底)；自定义督导归 Custom 独占 |
| 服务器 | 韩国服务器自建 Node 代理 `/opt/chat-proxy/server.js`（反代 DeepSeek，443 直听 + certbot + systemd）；chat 项目已走该代理转发 |
| 分发/签名 | Win：无证书（可走 SignPath/Certum 开源免费签，前提是真开源）；Mac：无 mac 构建段，规划走 ad-hoc 或 Developer ID($99)+公证 |
| 自动更新 | electron-updater generic provider → 腾讯 COS 桶 `xinjing-1439314927.cos.ap-guangzhou.myqcloud.com`（COS 通道独立，与是否 push GitHub 无关） |
| 测试基线 | `scripts/self-test.js`：127 通过 / 0 失败 |
| P0 漏洞 | `app/js/ai.js` L24 免费兜底 key **明文硬编码**，开源前必须移走 |
| push 规则 | **默认不 push GitHub**；每 4 个发版版本备份 push 一次；用户明确说"推"时才推。COS 照常上传 |

**下一个 AI 上手三步**：
1. 读本文件 → 读 `心镜-v3.2.1-交接文档-给下一个AI.md`（最新架构细节）→ 读 `package.json`。
2. `node scripts/self-test.js` 跑一遍，确认 127/0。
3. 按本文件"待办"与最新技术方案（`XinJing-v3.4.x-技术方案.md`）推进。

---

## 一、文档索引（按主题分类）

> 路径前缀说明：
> - `[D]` = `D:\xinjing-electron\`（项目根，代码 + 技术方案）
> - `[W]` = `C:\Users\Administrator\WorkBuddy\2026-07-11-07-59-25\`（工作区，部署/授权/规划类）

### A. 交接文档（历史，倒序——越靠前越新）

| 文件 | 位置 | 一句话 |
|------|------|--------|
| 心镜-总交接文档-文档索引与全景-给下一个AI.md | [D] | **本文件**，总入口 |
| 心镜-v3.2.1-交接文档-给下一个AI.md | [D] | **最新架构细节**：9 项计划完成、知识库打包、会员门控四层、双栏记账、关键文件索引（必读） |
| XinJing-v3.0.3-交接文档-给下一个AI.md | [D] | v3.0.3 状态交接 |
| XinJing-v3.0.0-项目文档-给下一个AI.md | [D] | v3.0.0 重构后项目文档 |
| XinJing-交接文档-v2.1.0-给下一个AI.md | [D] | v2.1.0 交接（29KB，最详尽的老版全景） |
| PROJECT.md | [D] | 项目日志（更新停在 1.6.x，历史参考） |
| 心镜-桌面版-使用说明.md | [D] | 面向用户的使用说明 |

### B. 技术方案（按版本）

| 文件 | 位置 | 一句话 |
|------|------|--------|
| XinJing-v3.4.1 / v3.4.0 / v3.3.1 / v3.3.0-技术方案.md | [D] | **最近四个小版本技术方案**（含新建来访者 ClientModal 等改动） |
| XinJing-v3.1.0-总体计划.md | [D] | v3.1.0 总体计划 |
| XinJing-v3.0.0-项目重构计划书.md | [D] | v3.0.0 重构计划 |
| XinJing-v2.0-技术方案.md / 审查报告.md / P0到P2-完成报告.md | [D] | v2.0 三件套 |
| XinJing-v1.7.0-微信支付云激活技术方案.md | [D] | **★ 云激活+微信支付付费真相源方案**（评审 96/100 过闸，含 §8.2 Custom 特权：自定义督导独占/更高额度/优先支持） |
| XinJing-v1.7.0-技术方案.md | [D] | v1.7.0 常规技术方案 |
| XinJing-v1.6.4 / v1.6.3-技术方案.md | [D] | v1.6.x 方案 |
| XinJing-v1.6.2-退化循环修复说明.md | [D] | Agent function-calling 退化循环修复 |

### C. 收费 / 授权 / 产品

| 文件 | 位置 | 一句话 |
|------|------|--------|
| XinJing-收费模式与请求包设计.md | [D] | **★ 两维度收费框架**（功能档位 × 算力来源 + 请求包机制） |
| 心镜-产品与授权决策存档.md | [W] | **★ 授权/收费/部署决策 consolidate**（跨对话结论存档） |
| XinJing-客户经理视角产品意见.md | [D] | 客户经理视角产品建议 |
| XinJing-Chat大师对话对比调研报告.md | [D] | 桌面大师对话 vs Chat 项目对比调研 |

### D. 部署 / 运维 / 服务器

| 文件 | 位置 | 一句话 |
|------|------|--------|
| 韩国服务器部署指南.md / 韩国服务器部署-实操脚本.md | [W] | **★ 韩国服务器 Node 代理部署**（指南 + 可执行脚本） |
| 海外服务器部署DeepSeek代理-操作手册.md | [W] | DeepSeek 反代代理操作手册 |
| server.js | [W] | 韩国服务器代理源码副本（POST / 反代 DeepSeek，尊重 stream，CORS *） |
| 部署阻塞根因与决策路径.md | [W] | 早期部署踩坑根因与决策路径 |
| 自有域名+轻量服务器方案.md | [W] | 自有域名 + 轻量服务器方案 |
| 腾讯域名+阿里服务器-域名绑定与云解析.md | [W] | 域名绑定与云解析 |
| verify.sh / scrub_creds.py / setup_ssh_config.py | [W] | 服务器校验/凭证清洗/SSH 配置脚本 |

### E. Windows 签名 / Mac 分发

| 文件 | 位置 | 一句话 |
|------|------|--------|
| 心镜-Windows签名与Mac自动更新实施规划.md | [W] | **★ 签名+分发路线**：SSL.com EV / SignPath 开源免费 / Apple 注册 / mac 构建段 / release.yml macos job / Phase 0-3 |

### F. 版本盘点

| 文件 | 位置 | 一句话 |
|------|------|--------|
| 心镜版本盘点-COS与本地核对.md | [W] | **★ COS 桶已发 22 版**（1.0.19→1.7.1）+ git 引用 31 个版本号，核对表 |
| build-*.log / cnb-build-*.log | [D] | 各版本构建日志 |

### G. 设计 / UI 重构

| 文件 | 位置 | 一句话 |
|------|------|--------|
| XinJing-设计HTML落地评估与融合计划.md | [D] | 设计稿落地评估 |
| XinJing-咨询记录主工作区设计.md / consultation-record-redesign.html | [D] | 咨询记录主工作区设计稿 |
| XinJing-记账界面完全重构设计.md / 改造计划.md / P0P1改造说明.md | [D] | 记账界面重构三件套 |
| XinJing-AI督导界面改造计划.md | [D] | AI 督导界面改造 |
| billing-demo-A~E.html / billing-redesign.html | [D] | 记账 demo 五版 + 重构稿 |
| consult-notes-v3-A/B.html / dashboard-redesign.html | [D] | 咨询笔记/仪表盘设计稿 |
| demo-M1~M5-*.html | [D] | 逐字稿/督导/文档中心 M1-M5 演示稿 |

### H. Agent / 大师对话

| 文件 | 位置 | 一句话 |
|------|------|--------|
| XinJing-Agent-改造方案.md | [D] | 小镜 Agent 改造方案 |
| XinJing-Agent设置API接口-技术文档.md | [D] | Agent API 接口技术文档 |
| XinJing-代理接入-待提供清单.md | [D] | 代理接入待提供项清单 |
| XinJing-大师对话无法输入-诊断与修复.md | [D] | 大师对话输入 bug 诊断修复 |

### I. 新建来访者字段 / 已知 Bug

| 文件 | 位置 | 一句话 |
|------|------|--------|
| 心镜-新建来访者字段结构与已知Bug.md | [W] | **★ 13 字段 schema + 其他 AI 写坏的 4 处 bug**（详见本文件第五节） |

### J. Chat 项目（winnicott-chat，独立但相关）

| 文件 | 位置 | 一句话 |
|------|------|--------|
| winnicott-chat-EdgeOne边缘函数方案.md / 部署步骤手册.md | [W] | Chat 项目 EdgeOne 边缘函数方案 + 部署 |
| winnicott-chat-SCF-Web函数部署手册.md / SCF代理方案.md | [W] | Chat 项目 SCF 代理方案 |
| chat-test-*.md / SCF-Web函数部署手册.md / scf-proxy-troubleshooting.md | [W] | Chat 代理诊断/单 DeepSeek 部署/排障 |

### K. 技能位置

| 文件 | 位置 | 一句话 |
|------|------|--------|
| xinjing-release-gate-技能位置说明.md | [W] | **★ 发版闸门技能**：`C:\Users\Administrator\.workbuddy\skills\xinjing-release-gate\SKILL.md`（每版先写方案+跑评审≥95 才动手） |

---

## 二、架构与关键文件索引

（详见 `心镜-v3.2.1-交接文档-给下一个AI.md` 第七节；此处摘要）

| 文件 | 职责 |
|------|------|
| `main.js` | 主进程：HTTP 服务 + 授权 + 备份 + 自动更新 |
| `preload.js` | 渲染桥：授权状态 + Agent 全局注入（DOMContentLoaded 注入 agent-tools/core/shell + agent.css 到所有页） |
| `license-core.js` | 激活码核心：HMAC 签名 + 60 天试用（`AI_TRIAL_DAYS`）+ 机器码；**密钥由 gitignored `secret.generated.js` 注入，不含字面量** |
| `app/js/app.js` | 公共模块：侧边栏 + 模态框 + **会员门控**（`featureGate`/`lockBadge`/`membershipBadge`/`isPro`/`isCustom`/`isTrial`） |
| `app/js/store.js` | 数据层：IndexedDB（来访者/会话/督导/支出/大师对话）；`createClient` L353 = 13 字段权威 schema |
| `app/js/ai.js` | AI 调用层；**L24 免费兜底 key 明文硬编码（P0）** |
| `app/js/masters.js` + `masters-data.js` | 11 位大师：1v1 + 圆桌 + 温度滑块 + 知识库注入；systemPrompt 必须原样复用 winnicott-chat |
| `app/js/knowledge.builtins.js` | 24 大师知识库打包（795KB，构建期由 `scripts/gen-knowledge-builtins.py` 生成，**勿手改**） |
| `app/js/agent-*.js` | 小镜 Agent：shell(浮窗)/tools(15 handler)/core(function-calling 状态机) |
| `app/js/client-modal.js` | v3.4 新建来访者模态（L40 有 `note` 单数 bug） |
| `app/billing-shell.html` | 记账主界面：双栏 + 旧三栏隐藏保留 |
| `scripts/self-test.js` | 自测 127 用例 / 0 失败 |
| `scripts/cnb-build.ps1` | 构建脚本（需管理员权限） |

---

## 三、授权与收费模型（跨文档结论汇总）

### 3.1 当前授权（已实现）
- **离线 HMAC 激活**：`license-core.js` 本地签名校验，60 天试用。
- **云激活的真相**：现有"云激活"只是**重新验证签名有效性**，**服务器不记录谁付了钱**。

### 3.2 付费真相源（待建，见 v1.7.0 云激活文档）
- 需补一层：**支付 Webhook → 落库（SQLite）→ 客户端查库**。
- 微信支付走 **API v3 官方商户号 + Native 扫码支付**（绕过 JSAPI 的 openid 要求）。
- 承载在**韩国服务器**（企业执照可申请商户号）。

### 3.3 三档功能权限
| 档 | 权限 |
|----|------|
| Free | 基础功能 + 60 天 AI 试用 |
| Pro | 解锁 AI 硬门控功能（ai-mindmap / ai-growth / export-full 等）+ 更高额度 |
| Custom | Pro 全部 + **自定义督导独占**（开发者制作）+ 最高额度 + 优先支持 |

> 注意：早期发现 Pro/Custom 曾"同权仅 logo 色差"，v3.2.x 会员门控四层已把功能分层做实；圆桌多大师引擎**已实现**（`masters.js` L113/L200），勿再误判为未实现。

### 3.4 算力来源（与功能档正交）
- **BYOK**：用户自带 API key。
- **官方请求包**：不会配 API 的用户购买请求次数包（Pro/Custom 可购）。
- **内置兜底**：免费兜底 key（即 P0 漏洞所在，需迁移到韩国代理）。

---

## 四、服务器与密钥

- **韩国服务器**：自建 Node 代理 `/opt/chat-proxy/server.js`
  - 反代 DeepSeek；443 直听；certbot 证书（上次审计剩 ~88 天）；systemd 守护；Node 22；CORS `*`；尊重 `stream` 字段。
  - chat 项目（winnicott-chat）已通过该代理转发（`SCF_URL` 指向 `xinjingchat.online`）。
- **SSH 私钥**：`C:\Users\Administrator\.workbuddy\deploy_keys\id_ed25519`。
- **COS 自动更新桶**：`xinjing-1439314927.cos.ap-guangzhou.myqcloud.com`（generic provider 消费 `latest.yml` / `latest-portable.yml`）。
- **机密隔离**：`.gitignore` 已排除 `.license-secret` / COS 密钥 / 激活码工具 / `secret.generated.js`；`server.js` 只在服务器不在仓库（服务端天然闭源）✅。

---

## 五、已知 Bug 与 P0 漏洞

### P0（开源前必须处理）
- **`app/js/ai.js` L24**：免费兜底 key 明文硬编码。开源后任何人可 extract 白嫖额度。→ 迁移到韩国代理或强制 BYOK 兜底。

### 新建来访者字段（其他 AI 写坏，4 处，详见字段文档）
1. **`client-modal.js` L40**：`note:`（单数）应为 `notes:` → 备注存进死字段 `client.note`，详情页 `client.notes` 永远空。**最小修复：改 `note`→`notes`**。
2. `alias` 字段 store 有默认值但所有 UI 无输入控件（死字段）。
3. 双入口字段割裂：新版 `client-modal.js` 只填 name/phone/email，缺 gender/birthDate/firstVisitDate/tags；老版 `consultations.js saveNewClient`（L485）填全。
4. `client-modal.js` 自造 id（`c_+Date.now().toString(36)`）与 store `genId('c')` 不统一。**最小修复：去掉自造 id，交给 store。**

> 权威 schema（`store.js createClient` L353，共 13 字段）：
> `id / name / alias / gender / birthDate / phone / email / firstVisitDate / status / tags / notes / createdAt / updatedAt`（后 3 自动，alias 默认空）。

---

## 六、待办（按优先级）

**立即可做**
1. 修新建来访者 4 处 bug（先修 P0：`note`→`notes` + 去自造 id）。
2. `git commit` + 发版（用户确认后；默认不 push GitHub）。
3. 旧页退役：`billing.html`（85KB 旧版）重定向到 `billing-shell.html`。

**中期**
4. 建付费真相源（Webhook→库→查库，见 v1.7.0 云激活文档）。
5. 真正开源三步（若决定开源）：仓库 public + 加 LICENSE(建议 MIT) + `package.json` 改 `private:false`+`license:"MIT"`；**开源前先清 `ai.js` P0**。
6. 签名落地：Win 走 SignPath/Certum 开源免费（需真开源）或自购 EV；Mac 走 ad-hoc(免费但 Gatekeeper 警告) 或 Developer ID $99 + 公证（零警告）。

**远期（v4.0）**
7. 本地知识库 RAG / Android 适配 / 坚果云同步。

---

## 七、铁律与约定（不可违反）

1. **提示词复用**：`masters-data.js` 的 `systemPrompt` 必须从 `winnicott-chat` 原样复制，不可自写。
2. **密钥安全**：`license-core.js` 不含密钥字面量，由 `secret.generated.js`（gitignored）注入。
3. **数据不出本机**：用户数据存 IndexedDB，AI 调用走用户配置/代理。
4. **全局返回键**：`App.buildBackButton()` + 各页 back-row，铁律。
5. **版本号**：`scripts/bump-version.js`（major.minor.patch）。
6. **发版闸门**：走 `xinjing-release-gate` 技能——每版先写技术方案 + 跑独立评审 ≥95 才动手。
7. **push 规则**：默认不 push GitHub；每 4 个发版备份 push 一次；用户说"推"才推。COS 通道独立，发版照常上传 COS。
8. **构建**：`predist`/`prestart` 会自动跑 `gen-knowledge-builtins.py`（需 Python）；`cnb-build.ps1` 需管理员权限。

---

*本总交接文档为"索引 + 全景"型入口。细节请按第一节索引精读对应专题文档。接手后建议先跑自测确认 127/0，再按第六节待办推进。*
