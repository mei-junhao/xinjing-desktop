# 心镜 XinJing v4.2.0 发布说明

**日期**：2026-07-19
**类型**：minor（功能级，4.1.1 之后的新批次）
**平台**：Windows（自动更新）、macOS（CI 构建，手动绕过 Gatekeeper）

## 一、核心变更

### 1. 资料库文件分类手动覆盖（新功能）
- 新增 `knowledge-meta-v1.json` 持久化：用户可为资料库单个文件手动设定分类，覆盖目录推断与 frontmatter 推断。
- 覆盖有效性以文件内容 SHA-256 校验（内容变更后自动失效，避免陈旧覆盖）。
- 安全写入（临时文件 + 原子 rename）、schema 校验、损坏自动隔离（`.corrupt-<ts>` 备份）。
- 新增 IPC：`xj:readKnowledgeMeta` / `xj:writeKnowledgeMeta`（main.js ↔ preload.js 两端齐备）。

### 2. 免费版导出锁误拦修复（P1）
- 修复 `preload.js` 导出/打印锁：此前容器元素（如 `main.main`）的 `textContent` 聚合了后代按钮文本，导致免费版用户点击"记一笔"等按钮被误判为"导出"而拦截。
- 现仅检查可点击元素（button/a/input/[role=button]）自身文本，容器只查 title/aria-label。

### 3. AI 代理错误归一化（健壮性）
- `ai.js` 新增 `classifyError` / `safeFailureResult`：所有失败出口共用固定安全文案，原始服务端错误不泄露到 UI；正确区分取消 / 限流（额度耗尽）/ 网络 / 鉴权 / 服务端错误。
- 限流错误提示"试用额度已用完"，与韩国代理 ¥5/30 天滚动额度一致。

### 4. 其他增强
- `transcript.js`（逐字稿）、`supervision.js`（督导）、`masters.js`（大师对话）、`knowledge.js`、`onboarding.js`、`userdocs.js`、`store.js`、`billing-calendar.js`、`doc-center.html`、`settings.html` 等小幅增强与修正。
- `billing-shell.html` 账务展示微调（账务隔离双口径不变）。
- 新增 `app/js/agent-api.js` 模块（待接入，惰性，不影响运行时）。

## 二、发版验证（闸门全过）
- 自测套件 271/0 全绿
- 22 个 HTML 页无残桩（body≥1 && script≥1）
- 15 个改动 JS `node --check` 全过；改动 HTML 内联脚本语法全过
- 账务隔离双口径（`billableSessionsFor` / `billableSessions`）完好
- IPC 桥匹配：新增 knowledge-meta 通道两端齐备；无 invoke↔handle 断裂

## 三、升级注意
- Windows：启动后自动检测并更新（generic provider → COS）。
- macOS：下载 dmg/zip 手动安装；未签名，首次需右键打开或 `xattr -cr`。
- 自动更新不可撤回，已按铁律在上传前完成全部验证。
