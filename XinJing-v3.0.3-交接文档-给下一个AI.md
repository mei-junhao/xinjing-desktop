# 心镜 XinJing v3.0.3 — 给下一个 AI 的交接文档

**交接日期**：2026-07-13
**当前版本**：v3.0.3
**仓库**：https://github.com/mei-junhao/xinjing-desktop（PUBLIC）
**本地根目录**：`D:\xinjing-electron\`
**下载**：https://xinjing-1439314927.cos.ap-guangzhou.myqcloud.com/xinjing-setup-3.0.3.exe

---

## 一、v3.0.3 本轮改动

| 文件 | 改动 |
|------|------|
| `app/js/ai.js` | `callDirect` 支持 `options.temperature` 和 `options.maxTokens` 透传（默认 0.3/4000 不变） |
| `app/masters.html` | 3 列布局：240px 大师列表 + 1fr 对话区 + 200px 历史对话 |
| `app/js/masters.js` | 完全重写：拉齐 Chat 圆桌逻辑 |

### 大师对话 Chat 对齐项

| 对齐项 | Chat 项目 | XinJing v3.0.3 | 状态 |
|--------|----------|---------------|------|
| temperature (Round 1) | 0.7 | 0.7 | ✅ |
| temperature (React) | 0.6 | 0.6 | ✅ |
| max_tokens (Round 1) | 512 | 512 | ✅ |
| max_tokens (React) | 400 | 400 | ✅ |
| max_tokens (Summary) | 600 | 600 | ✅ |
| 圆桌规则（独立回应/150字/看不到别人） | 硬编码 JS | 硬编码 JS（逐字一致） | ✅ |
| 串行过滤自己发言 | ✅ | ✅ | ✅ |
| 600ms 延迟 | ✅ | ✅ | ✅ |
| 温尼科特永远最后 | ✅ | ✅ | ✅ |
| "空格=没什么要说的"跳过 | ✅ | ✅ | ✅ |
| @mention 专属流程 | ✅ | ✅ | ✅ |
| API 调用方式 | 直连 fetch | AI.send()（xinjing 自己的体系） | 不对齐（按用户要求） |

### AI 督导对齐状态

**已拉齐**。`supervisors.js` 的 `buildSystemPrompt()` 输出结构 = 方法论提示词 + `STYLE_CONSTRAINTS` + `WINNICOTT_PERSONA_GUARD`，与 Chat `ai-supervisor.html` 一致。提示词从 `prompts.builtin.js` 的 Base64 编码加载，不手写新提示词。

---

## 二、当前页面状态总览

| 页面 | 文件 | 布局 | 状态 |
|------|------|------|------|
| 首页 | `index.html` + `dashboard.js` | 方案B：卡片中枢 + 小镜侧滑面板（推开内容） | ✅ 小镜已接入真实 AI.send |
| 咨询记录 | `consult-notes.html` + `consult-notes.js` | 方案A：APA/SOAP/DAP/自由笔记 四模式 + 右栏小镜 | ✅ 小镜已接入真实 AI.send |
| 撰写报告 | `report-writing.html` + `report-writing.js` | 方案D：分步向导 6 步 + AI 填写 + 模板上传 AI 分析 | ✅ |
| AI 督导 | `supervision.html` + `supervision.js` | 方案D：全屏对话 + 侧拉材料面板 + 真实 AI 对话 | ✅ |
| 账单 | `billing-shell.html` | 三栏：左客户列表 + 中明细/趋势/账单 + 右AI坞（默认收起） | ✅ 去重已修、清除数据已加 |
| 大师对话 | `masters.html` + `masters.js` | 方案D：左大师列表 + 中对话 + 右历史 | ✅ Chat 圆桌逻辑已拉齐 |
| 设置 | `settings.html` + `settings.js` | 方案A：分组卡片（AI接口/数据/外观/更新/关于） | ✅ 复用现有 API 接口功能 |

### 已移除
- Agent 悬浮 FAB（`agent-shell.js` buildFab 改为 no-op）
- 侧边栏（新页面通过 `noSidebar: true` 跳过 sidebar 注入）

---

## 三、发版与发布能力

### 3.1 完整构建 → COS 发布（一键）

```powershell
cd D:\xinjing-electron
& scripts/cnb-build.ps1                          # patch +0.0.1
$env:XJ_BUMP_KIND='minor'; & scripts/cnb-build.ps1  # +0.1.0
$env:XJ_BUMP_KIND='major'; & scripts/cnb-build.ps1  # +1.0.0
$env:XJ_NO_BUMP='1'; & scripts/cnb-build.ps1        # 锁版本
```

`cnb-build.ps1` 内部流程：
1. `bump-version.js` 自动递增版本号（patch 默认）
2. `codegen-version.js` 重生成 `version.generated.js`
3. `gen-prompts-builtin.py` 重生成 Base64 提示词常量
4. `npm install --legacy-peer-deps`（若 `node_modules` 已存在则跳过）
5. `npm run dist -- --publish never`（electron-builder 构建）
6. `postbuild.js` 生成 `latest.yml` / `blockmap` / `latest-portable.yml`
7. coscli 上传 6 个产物到 COS 桶根目录

构建前需 `taskkill /F /IM "xinjing*"` 避免 DLL 锁。

### 3.2 仅上传 COS（不重新构建）

```powershell
& scripts/upload-to-cos.ps1 -Source D:\xinjing-electron\dist
```

### 3.3 从 GitHub Release 镜像到 COS

```powershell
& scripts/sync-cos.ps1 -Ver 3.0.3
```

### 3.4 COS 产物清单（6 个文件）

| 文件 | 用途 |
|------|------|
| `xinjing-setup-{ver}.exe` | NSIS 安装版 |
| `xinjing-portable-{ver}.exe` | 便携版 |
| `xinjing-setup-{ver}.exe.blockmap` | 增量更新 |
| `xinjing-portable-{ver}.exe.blockmap` | 增量更新 |
| `latest.yml` | electron-updater 元数据 |
| `latest-portable.yml` | electron-updater 元数据 |

### 3.5 GitHub 推送

**Remote**：`origin` → `https://github.com/mei-junhao/xinjing-desktop.git`（PUBLIC，不可转 PRIVATE）

**当前分支**：`chore/cos-sync`

**客户端推送命令**（必须照抄）：
```bash
# 第一步：注册 gh CLI 的 git credential helper
env -u GITHUB_TOKEN gh auth setup-git

# 第二步：推送
env -u GITHUB_TOKEN git push origin HEAD:refs/heads/chore/cos-sync
```

**关键坑**：环境变量 `GITHUB_TOKEN` 虽存在但 PAT 已失效（`remote: invalid credentials`），必须用 `env -u GITHUB_TOKEN` 剥离后，gh CLI 自动 fallback 到 Windows 凭据管理器中的 `gho_...` token（scopes: gist/read:user/repo）。

**推送节奏**：每 4 个版本推送一次备份；用户明确说"推一下"可破例。GitHub 推送与 COS 上传是独立通道。

### 3.6 COS 密钥

密钥存储在 `scripts/.cos-secret.ps1`（已 gitignore），格式：
```powershell
$env:COS_SECRET_ID = '...'
$env:COS_SECRET_KEY = '...'
```
也可直接设环境变量 `COS_SECRET_ID` / `COS_SECRET_KEY`。

COS 桶：`xinjing-1439314927`，区域 `ap-guangzhou`，国内用户更新主通道（`main.js` 中 `setFeedURL` 指向 COS）。

### 3.7 版本号规则

| 改动类型 | BUMP_KIND | 示例 |
|----------|-----------|------|
| bug 修复 | patch | 3.0.3 → 3.0.4 |
| 新功能 | minor | 3.0.3 → 3.1.0 |
| 大范围重构/里程碑 | major | 3.0.3 → 4.0.0 |
| 锁版本 | XJ_NO_BUMP=1 | 不变 |

---

## 四、用户铁律

- 每页必须有「返回」键
- 不要丢功能
- 不替用户做决定
- 删除文件安全代码：**82965622**
- 仓库不可转 PRIVATE
- 回复简洁专业，拒绝套话
- 不自己写提示词，复用 Chat 项目现有的

---

## 五、剩余待办（未完成）

1. **账单月历视图**：用户选了方案D（日历月视图），但 billing-shell.html 仍是三栏表格，未改为日历
2. **账单收入/支出分栏**：用户要求分收入和支出，支出分5类（个人体验/个体督导/团体督导/课程/其他）
3. **旧页面迁移**：settings/feedback 仍走旧侧栏，未传 `noSidebar: true`
4. **知识库 .md 文件接入**：Chat 项目每位大师有 `.md` 知识库文件，XinJing 用内联 systemPrompt，未接入 .md 文件
5. **大师视觉增强**：Chat 项目每位大师有独立字体/浅色背景/欢迎语 intro/icon emoji，XinJing 未加

---

## 六、关键文件索引

- `app/js/ai.js` — AI 集成模块，`callDirect` 现支持 `options.temperature/maxTokens` 透传
- `app/js/masters.js` — 大师对话，圆桌逻辑与 Chat 拉齐
- `app/js/masters-data.js` — 11 位大师人格库（内联 systemPrompt）
- `app/js/supervisors.js` — 督导师身份管理（方法论+风格约束+身份guard）
- `app/js/prompts.builtin.js` — Base64 编码的提示词常量（仓颉/女娲/温尼科特/STYLE_CONSTRAINTS/PERSONA_GUARD）
- `app/js/supervision-core.js` — 督导管线纯核
- `XinJing-Chat大师对话对比调研报告.md` — 详细对比文档
- `C:\Users\Administrator\WorkBuddy\2026-06-21-10-33-32\chat-config-reference.md` — Chat 项目配置参考

---

## 七、v3.1.0 已实施改动（2026-07-13）

### 7.1 P1 基础修复

| 项 | 改动 | 文件 |
|----|------|------|
| ③ 数据去重 | 新增 `dedupSessionSource()`：同一 clientId+date+sessionNumber 时留 import 删 manual（次结） | `app/js/store.js` |
| ⑪ 设置修复 | 版本号统一走 `getVersion()`（构建期注入）；激活状态订阅式监听；API 配置区加 Agent 提示 | `app/js/settings.js`, `app/settings.html` |

### 7.2 P2 记账重构

| 项 | 改动 | 文件 |
|----|------|------|
| ① 加月历入口 | actions 栏新增「📅 月历」按钮 | `app/billing-shell.html` |
| ② 月历视图 | 新页面：月概览 4 卡片 + 日历网格，每日显示会谈/收费 | `app/billing-calendar.html`, `app/js/billing-calendar.js` |

### 7.3 P3 新页面

| 页面 | 方案 | 文件 | 说明 |
|------|------|------|------|
| ⑤ 逐字稿整理 | A 双栏对照 + C 会员对话引导 + D 会员差异视图 | `app/transcript.html`, `app/js/transcript.js` | AI 错误检测、记忆库自动学习、一键修正同类型错误 |
| ⑧ 真人督导 | D 全屏+侧拉历史 + E 会员 AI 分析 | `app/real-supervision.html`, `app/js/real-supervision.js` | 督导记录、逐字稿上传、案例报告、AI 分析 |
| ⑨ 文档中心 | E 双栏+Tab+轨迹 + C 会员成长轨迹 | `app/doc-center.html`, `app/js/doc-center.js` | 按来访者/类型浏览，成长轨迹时间线 |
| AI 督导 | C 三栏研究台 | `app/supervision.html`, `app/js/supervision.js` | 左会话历史 + 中分析区 Tab + 右 AI 对话 |

### 7.4 P4 Agent 统一

| 项 | 改动 | 文件 |
|----|------|------|
| ④ 小镜增强 | 身份定义（专业助理，非督导）；本地数据查询（欠费/来访者/收入/今日）；反幻觉约束（只能引用真实数据） | `app/js/dashboard.js` |
| ⑥ 报告跳转督导 | 步骤6完成后弹出对话框，可选「导出报告」或「去 AI 督导」 | `app/js/report-writing.js` |
| ⑦ 督导历史 | 已在 AI 督导左栏实现（会话历史列表） | `app/supervision.html` |

### 7.5 P5 大师对话

| 项 | 改动 | 文件 |
|----|------|------|
| ⑩ 温度滑块 | Chat 项目对齐：0-100 滑块，每位大师独立存储，区间知识库指令 | `app/masters.html`, `app/js/masters.js` |

### 7.6 首页入口更新

`app/index.html` 模块从 6 个扩充到 9 个，新增：逐字稿整理、真人督导、文档中心。

### 7.7 版本号

`package.json`: `3.0.3` → `3.1.0`

---

## 八、用户铁律

- 每页必须有「返回」键
- 不要丢功能
- 不替用户做决定
- 删除文件安全代码：**82965622**
- 仓库不可转 PRIVATE
- 回复简洁专业，拒绝套话
- 不自己写提示词，复用 Chat 项目现有的

---

## 九、剩余待办

1. **账单收入/支出分栏**：用户要求分收入和支出，支出分5类（个人体验/个体督导/团体督导/课程/其他）
2. **旧页面迁移**：settings/feedback 仍走旧侧栏，未传 `noSidebar: true`
3. **知识库 .md 文件接入**：Chat 项目每位大师有 `.md` 知识库文件，XinJing 用内联 systemPrompt，未接入 .md 文件
4. **大师视觉增强**：Chat 项目每位大师有独立字体/浅色背景/欢迎语 intro/icon emoji，XinJing 未加
5. **COA 构建测试**：需要在本地运行 `cnb-build.ps1` 验证构建产物是否正常

---

**文档作者**：OpenSquilla