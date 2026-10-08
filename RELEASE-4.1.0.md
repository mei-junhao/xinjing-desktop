# 心镜 XinJing 4.1.0 发布说明

> 发布日期：2026-07-18
> 分支：`release/3.6.3-mac`（接续 `682b0a4` / 4.0.4）
> 版本跨度：4.0.4 → 4.1.0（功能性小幅版本）
> 自测：`scripts/self-test.js` → 通过 268 / 失败 0（新增 `v4.1.0-1/2/3` 三组断言）
> 平台：Win 已上线（4.1.0）；Mac 经本发版补齐 tag 触发 `build-mac.yml`

---

## 一、本次核心功能：双视角工作台 + 临床材料工作项

4.1.0 在工作台引入「来访者视角 / 文档视角」双栏工作台，并新增**临床材料工作项**——把散落的逐字稿、报告、督导与一份原始材料（TXT/MD/DOCX）显式关联起来，让 AI 在撰写报告 / 督导 / 逐字稿整理时能直接引用已解析材料文本，且全程不向渲染层暴露文件绝对路径。

### 1. 双视角工作台 `app/js/dashboard.js` + `app/index.html` + `app/css/style.css`
- 新增视角切换 `.workbench-switch`（来访者视角 / 文档视角），当前视角持久化至 `xj_workbench_view_v1`。
- **来访者视角**：左栏来访者列表（搜索 + 节数）+ 中栏 KPI（累计会谈 / 督导记录 / 最近材料）+ 继续会谈/新建入口 + 右栏动作面板（逐字稿、报告、AI 督导、真人督导、账务），点击经 `routeFor()` 带 `clientId/sessionId` 深链。
- **文档视角**：左栏材料来源列表 + 中栏材料工作区（解析文本预览 + 关联来访者/会谈）+ 右栏继续处理（逐字稿/报告/督导）。`@media` 响应式在窄屏收起动作栏、单列堆叠。

### 2. 临床材料工作项（数据安全模型）`app/js/store.js`
- 新增 `materialWorkspaces` 数据集：`createMaterialWorkspace / updateMaterialWorkspace / deleteMaterialWorkspace / linkMaterialWorkspace / getMaterialWorkspaces / getMaterialWorkspace`。
- `normalizeMaterialWorkspace()` **只保存安全元数据 + 已解析文本**：`source` 仅含 `name/ext/size/modifiedAt`，不保存二进制原文件、不保存绝对路径；`parseStatus`（parsing/ready/failed）+ `parseError`。
- 级联解链：删除来访者 / 会谈时，关联材料的 `clientId/sessionId` 置空、`linkStatus` 改 `unlinked`（不删除材料本身）。
- 备份兼容：`exportBackup/importBackup` 已纳入 `materialWorkspaces`，旧备份导入不报错。

### 3. 原生文件选择 + 解析（路径零泄漏）`main.js` + `preload.js` + `app/js/entitlements.js`
- `xj:selectClinicalMaterialFile`：原生 `dialog.showOpenDialog` 选文件，校验扩展名（`.txt/.md/.docx`）、大小（≤20MB）、存在性；返回一个 **短时 `selectionId` 令牌**（10 分钟过期）+ 安全元数据，**绝不直接回传绝对路径**给渲染层。
- `xj:parseClinicalMaterialFile(selectionId)`：用令牌取回路径、二次校验、读取文本（复用 `readUserDocText`，支持 mammoth 解析 docx）、超 100 万字拒绝；返回 `file + text`。
- `preload.js` 注入 `selectClinicalMaterialFile / parseClinicalMaterialFile`。
- 配额：`entitlements.js` 新增 `MATERIAL_WORKSPACE_LIMITS`（free 20 / pro 100 / full 100 / custom ∞），`materialWorkspaceLimit()` 驱动未归档材料上限。

### 4. 专业页面接入材料上下文
- `real-supervision.js` / `report-writing.js` / `supervision.js` / `transcript.js`：通过 `?materialId=` 深链恢复材料，自动填入已解析文本、显示「材料来源」条、写入 `workflow.*`（in-progress/completed）与 `artifacts.*`（对应记录 id），保存前若未关联来访者给出提示。

---

## 二、改动文件清单（16 修改 + 本文档）

| 文件 | 类别 | 说明 |
|---|---|---|
| `app/js/dashboard.js` | 功能 | 双视角工作台 + 路由 |
| `app/js/store.js` | 数据 | materialWorkspaces 模型 + 级联解链 + 备份兼容 |
| `main.js` | 安全/IPC | 临床材料文件选择 + 解析（路径零泄漏） |
| `app/js/entitlements.js` | 权益 | materialWorkspaceLimit |
| `preload.js` | 桥接 | 暴露两个新 IPC |
| `app/index.html` | 结构 | 工作台视角切换 + 双栏挂载点 + CSS |
| `app/css/style.css` | 样式 | 双栏工作台样式 + 响应式 |
| `app/js/real-supervision.js` | 接入 | 材料恢复 + 写回 |
| `app/js/report-writing.js` | 接入 | 材料注入提示词 + 写回 |
| `app/js/supervision.js` | 接入 | 材料恢复 + 写回 |
| `app/js/transcript.js` | 接入 | 材料加载到逐字稿 |
| `app/js/settings.js` | 版本 | ver → 4.1.0 |
| `app/settings.html` | 版本 | 静态 v4.1.0 |
| `scripts/self-test.js` | 自测 | v4.1.0-1/2/3 断言 |
| `package.json` / `package-lock.json` | 版本 | 4.1.0 |
| `scripts/gen-prompts-builtin.py` | 工具 | 微调（构建期生成，非运行时） |
| `RELEASE-4.1.0.md` | 文档 | 本文档 |

---

## 三、发布验证

- **自测**：`scripts/self-test.js` → 通过 268 / 失败 0（新增 `v4.1.0-1` 双视角工作台稳定视角/材料工作项/向后兼容备份、`v4.1.0-2` 文件选择解析不暴露绝对路径、`v4.1.0-3` 专业页面恢复材料并回写处理状态）。
- **Win 上线**：COS `latest.yml` / `latest-portable.yml` 版本 = 4.1.0，setup（86.5MB）/ portable（86.3MB）资产 HTTP 200。
- **Mac**：本发版用 `~/.ssh/id_ed25519_xinjing` 推 `release/3.6.3-mac` 分支与 `v4.1.0` tag，触发 `build-mac.yml` 构建 dmg/zip 并上传同桶根 `latest-mac.yml`。

---

## 四、已知遗留

- Mac 首次安装仍需手动绕过 Gatekeeper（用户决策：不买 Apple Developer）；更新包由 app 自下载通常无需再绕过。
- 当前 4.1.0 的 Mac 构建约需 4 小时（macOS runner 排队 + 打包），期间 Mac 端自动更新暂指向 4.0.4，待 `latest-mac.yml` 翻为 4.1.0 后生效。
