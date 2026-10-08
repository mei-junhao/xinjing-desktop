# XJ-5.1.9 全功能走查 MVP 修复与发布交接 002

- `task_id`: `XJ-5.1.9-full-ui-audit-mvp-fix-002`
- `contract_id`: `contract-xj-519-audit-mvp-and-pii-v1`
- `write_lock_id`: `lock-XJ-5.1.9-full-ui-audit-mvp-fix-002`
- `base_commit`: `9971787eb6e443ab5a5c80aee118b9b43285c093`
- `active_release_train`: `5.1.9/rework/rt-5.1.9-0002`
- `config_evidence_id`: `xj-519-full-ui-audit-zcode-20260904`
- `agent_profile_id`: `A-implementation`（由 Hermes 转发给指定执行 agent；实际模型/档位以平台回执为准）
- `benchmark_manifest`: `D:/xinjing-electron/qa/package-candidates/5.1.9-audit-mvp-002/benchmark-manifest.json`
- `visual_baseline`: `D:/xinjing-electron/qa/agent-reviews/xinjing-5.1.9-full-ui-bug-audit-zcode-20260904.md`
- `visual_baseline_sha256`: `8B7238A8E92D5FE689B308A86A04D457C6049C05790BC483D379F4189CDD0EC4`
- `authorization`: `user-authorized-5.1.9-audit-mvp-fix-test-and-package`
- `delivery_report`: `D:/xinjing-electron/qa/agent-reviews/XJ-5.1.9-full-ui-audit-mvp-fix-002.md`

## 单一关键结果

依据 2026-09-04 全功能走查，修复所有 `confirmed` 的 P1/P2/P3 客户端缺陷，并把本地 PII 脱敏 MVP 接入每一条 AI 出站消息；通过真实 Electron 与负向变异验收后，交由 Codex 重新冻结 `5.1.9` 候选、构建、签名和发布。不得把 stale、false、incomplete 或 out-of-scope 项写成已修复。

## 证据来源与已确认范围

唯一输入报告为 `xinjing-5.1.9-full-ui-bug-audit-zcode-20260904.md`。必须修复以下 14 项：

| ID | 等级 | 必须达到的行为 |
|---|---|---|
| Z1 | P2 | 工作台“文档视角”隐藏 hero-stats、checklist、schedule、quick-tools、bottom-row；不能被作者 CSS 的 `display` 覆盖。 |
| Z2 | P2 | 账务“记支出”直接显示支出表单，并可保存/回读 durable 数据；不能要求先切分类。 |
| Z3 | P2 | 圆桌每轮仅保留已请求的 3 位大师回复，禁止额外请求、碎片回复、失败卡污染摘要。 |
| Z4 | P1 | AI 督导生成链路不得同步阻塞 renderer；请求有加载、取消、成功和明确失败状态，主线程保持可交互。 |
| Z5 | P2 | 小镜发送先持久化/挂载用户消息再清空输入；首条发送必须可见并收到回复或错误卡。 |
| Z6 | P2 | `queryLocal` 仅匹配明确的统计问句；材料复述/临床提问必须走所选模型，不得被“来访者”等宽关键词劫持。 |
| Z7 | P2 | 主力模型选择保存到账号偏好并有本地镜像；关闭、刷新、重启后以服务器权威值回显，计费模型与选择一致。 |
| Z8 | P1 | 日历创建的会话删除确认“取消/确认操作”均可受信点击和键盘激活；durable `{ok:false}` 必须显示失败提示并保留可重试状态。 |
| Z9 | P3 | 所有折叠/材料面板按钮的 `aria-expanded` 与真实状态同步。 |
| Z10 | P3 | 模型标题和错误文案去重，不能出现双重括号或重复“模型调用失败”。 |
| Z11 | P3 | “新建来访者”弹窗支持 Escape 关闭，取消按钮行为不变。 |
| Z12 | P3 | Window 菜单 Minimize/Close 使用中文可见标签。 |
| Z13 | P3 | 设置页价格提示与模型选择器使用同一价格来源，不显示与实际目录矛盾的“暂不可用”。 |
| Z14 | P2 | `XJ_AGENT_ACCEPTANCE=1` 时账号 API 也必须受拒网/回环闸门约束；默认不得向生产域发注册或登录请求。 |

报告标为 `incomplete` 的 AI 督导内容质量、上传五态、account-session 恢复卡、Qwen 主动触发、逐字稿取消、结算 durable、851px 专项、人工像素判定，不得在本卡中伪称完成；如需修复，另建 successor 卡。

## 本地 PII 脱敏 MVP（本卡必须纳入）

1. 复用并审查 `D:/xinjing-electron/app/js/pii-sanitizer.js` 的无依赖规则实现；覆盖手机号、邮箱、身份证、日期、地址、账号、姓名、IP、URL，并在一次请求内保持占位符稳定。
2. 在所有实际 AI 出站路径统一调用脱敏器。脱敏器不可加载、输入结构非法或仍有高风险残留时必须 fail-closed，禁止把原文发送给模型。
3. 脱敏只发生在请求副本；UI 草稿、durable 临床对象和本地原文不被覆盖。日志、错误卡、报告和证据不得包含原始 PII。
4. 使用合成中文材料测试，覆盖普通 chat、SOAP/报告、圆桌、AI 督导和小镜；不得使用真实临床材料或真实账号。
5. `scripts/pii-sanitizer.test.js` 作为最小单测基线；补充真实调用链测试与反向变异（删脱敏、吞 fail-closed、只脱敏 UI、不脱敏嵌套 tool 参数）且每个变异都必须失败。

## 写集与职责

### 执行 agent（仅非保护文件）

- `app/billing-shell.html`
- `app/js/billing-calendar.js`
- `app/js/masters.js`
- `app/css/masters-clinical.css`
- `app/js/supervision.js`、`app/supervision.html`、相关非保护样式
- `app/js/xinjing-chat.js`
- `app/js/session-calendar.js`、`app/session-calendar.html`
- `app/js/pii-sanitizer.js`、`scripts/pii-sanitizer.test.js`
- `scripts/v5.1.9-tests/XJ-5.1.9-full-ui-audit-mvp-fix-002/**`
- `qa/task-scratch/XJ-5.1.9-full-ui-audit-mvp-fix-002/**`
- 本卡交付报告

### Codex 独占（执行 agent 不得修改）

- `app/js/ai.js`：把 PII MVP 接入最终统一出站边界，并核对所有 AI 调用者。
- `app/js/settings.js`、`app/js/store.js`：模型偏好权威/本地镜像及价格显示契约。
- `main.js`、`preload.js`：Z14 账号 API 拒网边界与必要 IPC；不得扩大接口。
- `package.json`、`package-lock.json`、`version.generated.js`、构建/签名/上传脚本及发布锁。
- 候选冻结、构建、签名、COS 上传、feed 切换、本机安装和最终发布。

执行 agent 如发现必须改动上述保护文件，只提交最小补丁说明和测试，不直接写入；由 Codex intake 后串行接入。

## 禁止事项

- 不修改服务器模型配置、真实用户/临床数据、生产数据库、COS 对象或远程 feed。
- 不使用真实账号、真实邮件、真实材料；不记录 token、密钥、验证码或原始 PII。
- 不回退、清理、覆盖当前脏工作树，不执行 `git commit`、`merge`、`push`、`reset`、`checkout`、`clean`。
- 不把源码字符串匹配、mock、固定 DOM、提前 toast、吞 `{ok:false}` 或未等待异步当作验收。
- 不修复审计已判定 stale/false 的历史问题，不把 incomplete 项改写成 PASS。

## 验收契约

1. 先读当前工作树与本卡，回报 `received`；Checkpoint A 通过且开始写入后回报 `running`。
2. 每个 Z 项使用临时 `userData`、合成数据和默认拒网/回环 wrapper 真实启动 Electron；记录操作、DOM/可见响应、错误、等待时长和退出码。
3. 必须覆盖正向、失败、重试、取消、重复点击、刷新/重启（适用时）和键盘焦点；Z4 额外证明 renderer 在请求期间可响应。
4. PII 测试必须证明所有 AI 出站副本不含原始 PII，失败时不发请求；保留原文仅在本地合成 fixture。
5. 每项关键行为至少一个 expected-red 变异：删除 handler、吞 durable 失败、只改 UI、不等待异步、复用旧 DOM、绕过模型选择、删除脱敏或把账号 API 绕过拒网；变异必须真实失败。
6. `node --check` 覆盖所有改动 JS；运行 `node scripts/pii-sanitizer.test.js` 及本卡测试；`git diff --check` 为 0。
7. 交付前执行内部对抗审查，单列攻击、原始结果、未覆盖项和主动否决的 PASS；重算每个文件 SHA，确认 allowlist 与 protected-files 零漂移。
8. 报告必须明确 `confirmed/stale/false/incomplete/out-of-scope` 分类，并附真实命令、cwd、start/end、exit、stdout/stderr 路径与 SHA。

## Codex 发布交接（执行 agent 不执行远程动作）

交付被 Codex intake 接纳后：

1. 重新冻结 5.1.9 候选，聚合 SHA 在构建前后零漂移；旧 `5.1.9` publishing 候选自动标为 stale，不得复用。
2. 复用既有 electron-builder 配置与 `--publish never`；构建 setup/portable、双 blockmap、`latest.yml`、`latest-portable.yml`。
3. 自签名证书主题 `CN=XinJing 5.1.9 Internal`，如实记录 `public_trust=false`。
4. 运行 XJ463 健康探针和最小真实 UI 回归；仅全部通过后上传 COS `xinjing-1439314927` / `ap-guangzhou` 六件套并 HTTPS 逐字节回读。
5. `5.1.9` 为用户明确的目标版本；若远程 feed 或安装器拒绝同版本重发布，停止并报告，不得静默改成其他版本或覆盖旧对象。
6. 发布状态按 `release-ready -> publish-authorized -> publishing -> released` 记录，并另建 Hermes 无上下文独立复核卡。

## 生命周期与飞书同步

每个状态必须同步项目群：`received`、`running`、`rejected/blocked`、`delivered`、Codex `intake/accepted/rework`、发布状态和最终完成。关键消息同一条中真实多重 `@Hermes`（结构化 at、可见 `@Hermes`、角色名+动作），发送后回读 `mentions[]` 确认；未确认最多按协作 skill 重试三次并保留 outbox。执行 agent 只在拒绝、硬阻塞和最终交付时提及负责人。

## 停止条件

遇到保护文件冲突、第二写者、候选/卡 SHA 漂移、生产网络或真实数据风险、任何 P1 未复现通过、expected-red 假绿、异步未等待、越界写入或三轮不同修复仍失败，立即回报 `blocked` 并释放 lease，等待 Codex 裁决；不得用旧证据、旧候选或静态截图冒充完成。

## 目标模式提示词（转发给执行 agent）

你是本卡的实现执行者。先读取本卡、审计报告和当前工作树，只在 allowlist 写入。先回报 `received`，Checkpoint A 通过后回报 `running`。按 Z1-Z14 逐项修复，并把 PII 脱敏 MVP 接入所有实际 AI 出站副本；只用合成数据、临时 userData 和拒网/回环环境。每一项都要真实点击或调用、等待异步结果，记录成功/失败/取消/重试/键盘焦点，并写 expected-red 变异证明测试确实能抓住缺陷。不得修改 Codex 独占文件、服务器、远程 COS、feed、真实数据或任何秘密。提交前必须执行内部对抗审查、重算 SHA、检查 diff 越界、如实列出未覆盖项；报告最后一行严格写入本卡的 `DELIVERY_REPORT` 绝对路径。若保护文件或范围成为必要条件，立即 `blocked`，不要猜测或绕过边界。

DELIVERY_REPORT: D:/xinjing-electron/qa/agent-reviews/XJ-5.1.9-full-ui-audit-mvp-fix-002.md
