# 心镜 XinJing v3.0.0 — 给下一个 AI 的项目文档

**日期**：2026-07-13
**版本**：v3.0.0（里程碑版本）
**作者**：梅（心理咨询师，温尼科特/心理动力学取向）
**仓库**：https://github.com/mei-junhao/xinjing-desktop（PUBLIC，勿改 PRIVATE）
**本地根目录**：`D:\xinjing-electron\`

---

## 一、项目身份

- 产品：心理咨询师本地管理工作台（Electron 桌面版，Windows only）
- 技术栈：Electron 28 + 原生 JS（无框架）+ IndexedDB 本地存储
- 打包：electron-builder 24 → nsis + portable 双产物
- 代理服务器：腾讯云 COS（自动更新）+ 韩国 VPS Node.js 代理（DeepSeek/SiliconFlow 上游）
- 设计系统：静谧留白 calm（tokens.css），暖灰单色 + 紫调 accent #8B93C7

---

## 二、v3.0.0 架构变更

### 核心变更：去侧边栏化
- v2.x 使用 240px 左侧固定导航栏
- v3.0 完全移除侧边栏，首页变为"模块中枢"——6 格卡片入口 + 3 指标卡
- 每个子页面独立，通过首页进入，顶部保留返回箭头

### 小镜 Agent 贯通
- **首页**：右侧常驻"小镜"面板（380px），侧滑打开时**推开**主内容区（不遮挡）
- **子页面**：各页面右下角有小镜入口，上下文关联当前页
- 小镜提供每日个性化欢迎语、待办提醒、AI 对话

### 页面体系

| 页面 | 文件 | 功能 |
|------|------|------|
| 首页 | `index.html` + `dashboard.js` | 卡片中枢 + 小镜面板 + 今日概览 |
| 咨询记录 | `consult-notes.html` + `consult-notes.js` | APA 5 维度快速录入 + 小镜双栏辅助 |
| 撰写报告 | `report-writing.html` + `report-writing.js` | 6 段引导式填写 + 节次勾选 + AI 填充 + 导出 Word |
| AI 督导 | `supervision.html` + `supervision.js` | 方案1 分阶段 + 方案5 多大师画布（会员） |
| 账单 | `billing-shell.html` | 三栏记账 + 清除数据 |
| 大师对话 | `masters.html` + `masters.js` | 1v1 + 圆桌多大师 |
| 设置 | `settings.html` | API 配置 + 备份 + 激活 |
| 意见反馈 | `feedback.html` | 保留 |
| 旧来访者详情 | `client-detail.html` + `session.html` | 保留但不再作为主要入口 |

### 向后兼容
- `app.js` `initPage` 支持 `{noSidebar: true}` 选项
- 旧页面（settings/feedback/masters/client-detail/session）未传 `noSidebar`，仍走旧侧栏布局
- `App.initPage({noSidebar: true, ...})` 时跳过 sidebar 注入，body 加 `.xj-no-sidebar` class

---

## 三、目录结构（核心文件）

```
D:\xinjing-electron\
├── package.json            # 版本号 v3.0.0、build 配置
├── main.js                 # Electron 主进程
├── preload.js              # contextBridge → window.__XJ_API__ / window.__XJ_STATE__
├── license-core.js         # 激活码核心算法
├── secret.generated.js     # 【gitignore】构建时生成
├── version.generated.js    # 【gitignore】构建时生成
│
├── app\
│   ├── index.html          # ★ 首页 v3.0 — 卡片中枢 + 小镜面板
│   ├── consult-notes.html  # ★ 咨询记录 — APA 双栏
│   ├── report-writing.html # ★ 撰写报告 — 引导式 + AI 填充
│   ├── supervision.html    # ★ AI 督导 — 分阶段 + 画布
│   ├── billing-shell.html  # 记账 — 三栏 + 清除数据
│   ├── masters.html        # 大师对话（v3.mid 重写版）
│   ├── settings.html       # 设置
│   ├── feedback.html       # 意见反馈
│   ├── session.html        # 【保留】旧版会话编辑
│   ├── client-detail.html  # 【保留】旧版来访者详情
│   ├── clients.html        # 【保留】旧版来访者列表
│   ├── activation.html     # 激活码录入
│   ├── confirm-close.html  # 退出确认
│   ├── migrate-helper.html # IndexedDB 跨端口迁移依赖【勿删】
│   ├── seed-data.js        # 首次启动演示数据
│   ├── css\
│   │   ├── tokens.css      # 设计令牌（calm 浅色 + dark）
│   │   ├── style.css       # 全局样式 + 侧栏（v3.0 新增 .xj-no-sidebar）
│   │   ├── components.css  # 通用组件
│   │   └── agent.css       # Agent FAB 呼吸球
│   ├── js\
│   │   ├── app.js          # ★ 公共模块：initPage、renderSidebar、injectLayout、noSidebar 模式
│   │   ├── store.js        # ★ IndexedDB 数据层
│   │   ├── ai.js           # ★ AI 接口（代理 + 四层降级）
│   │   ├── agent-core.js   # Agent 编排核心
│   │   ├── agent-shell.js  # Agent FAB 浮窗（v3.0 修复重复+飘逸）
│   │   ├── agent-tools.js  # Agent 工具集
│   │   ├── dashboard.js    # ★ 首页逻辑 v3.0
│   │   ├── consult-notes.js# ★ 咨询记录逻辑
│   │   ├── report-writing.js# ★ 撰写报告逻辑
│   │   ├── supervision.js  # ★ 督导逻辑 v3.0
│   │   ├── supervision-core.js # 督导 AI 调用纯核
│   │   ├── supervisors.js  # 督导师人格
│   │   ├── masters.js      # 大师对话逻辑
│   │   ├── masters-core.js # 大师对话纯核
│   │   ├── masters-data.js # 大师人格库
│   │   ├── session.js      # 旧会话页逻辑
│   │   ├── client-detail.js# 旧来访者详情逻辑
│   │   ├── clients.js      # 旧来访者列表逻辑
│   │   ├── billing-sync.js # 记账桥接层
│   │   ├── prompts.builtin.js # 【gitignore】构建期生成
│   │   ├── reports.js      # 报告矩阵渲染（consultations 不复用但保留）
│   │   ├── sync.js / meetings.js / export.js # 旧孤立 JS（可清理）
│   └── vendor\mammoth.browser.min.js # .docx 解析
│
├── scripts\
│   ├── cnb-build.ps1      # ★ 一键发版
│   ├── bump-version.js    # 三档 bump
│   ├── codegen-secret.js  # 生成 secret.generated.js
│   ├── codegen-version.js # 生成 version.generated.js
│   ├── gen-license.js     # 开发者出激活码
│   ├── gen-prompts-builtin.py # 编译 prompts.builtin.js
│   ├── gen-supervisors.py # 生成 supervisors.js
│   ├── postbuild.js       # 重命名 + 生成 latest.yml + blockmap
│   ├── sync-cos.ps1       # 单独同步文件到 COS
│   └── coscli.exe         # 【gitignore】腾讯云 coscli
│
├── server\
│   └── chat-proxy-server.js # 韩国代理服务端源（已部署 /opt/chat-proxy/server.js）
│
├── .license-secret         # 【敏感】激活码密钥，gitignore
├── .gitignore
└── XinJing-*.md            # 设计/决策文档（大量，见索引）
```

---

## 四、密钥与凭据

| 凭据 | 位置 | 说明 |
|------|------|------|
| LICENSE_SECRET | `D:\xinjing-electron\.license-secret` | 激活码核心算法密钥，gitignore |
| COS 密钥 | `D:\xinjing-electron\scripts\.cos-secret.ps1` | 腾讯云 COS 上传凭证 |
| 韩国服务器 | SSH `root@<IP> -i <私钥>` | 代理服务端部署在 `/opt/chat-proxy/` |
| 韩国 API Key | `/opt/chat-proxy/.env` | DEEPSEEK/SILICONFLOW/APP_PROXY_KEY |
| GitHub keyring | `gh:github.com:mei-junhao` | PAT scopes: gist, read:org, repo, workflow |
| 公众号 AppID | `wx7e0a961e5ec61f83` | 文章发布用 |

---

## 五、发版流程

### 一键发版
```powershell
cd D:\xinjing-electron
& scripts/cnb-build.ps1                          # patch +0.0.1
$env:XJ_BUMP_KIND='minor'; & scripts/cnb-build.ps1  # +0.1.0
$env:XJ_BUMP_KIND='major'; & scripts/cnb-build.ps1  # +1.0.0
$env:XJ_NO_BUMP='1'; & scripts/cnb-build.ps1        # 锁版本
```

### 版本号规则
| 级别 | 增量 | 场景 |
|------|------|------|
| patch | +0.0.1 | bug 修复 |
| minor | +0.1.0 | 加功能 |
| major | +1.0.0 | 里程碑/大范围更新 |

### 构建产物上传
- COS bucket: `xinjing-1439314927`，region: `ap-guangzhou`
- 6 文件：setup.exe + portable.exe + 2 个 blockmap + latest.yml + latest-portable.yml
- 老用户客户端启动时 check `latest.yml` 自动更新

### GitHub push 节奏
- **默认不自动 push**，每 4 个发版版本 push 一次
- COS 自动更新与 GitHub push 无关

---

## 六、已知问题

### 构建
1. **DLL 锁**：electron-builder 在 Windows 上偶尔遇到 `d3dcompiler_47.dll` 访问被拒，需关闭所有 xinjing/Electron 进程后清空 dist 和 .electron-cache 再重试
2. **prompts.builtin 生成告警**：`gen-prompts-builtin.py` 报 `Cannot extract CANGJIE_PROMPT`，不阻断构建

### 功能
3. **导入的旧数据节次号乱序**：旧版导入时按日期升序分配节次号才能修正；已有脏数据需手动清空后重新导入
4. **部分页面仍走侧栏**：settings/feedback/masters/client-detail/session 未迁移到无侧栏模式
5. **consult-notes 页面基础**：APA 字段已就绪，但 AI 对话和 Store 保存逻辑较简，可按需深化

---

## 七、用户铁律

- 每页必须有「返回」键可点击
- 不要丢功能：下线页面前先在目标页补齐功能
- 不替用户做决定：新方案、改 UI、引入新依赖、删文件前先问
- 删除文件安全代码：**82965622**
- 仓库 **不可转 PRIVATE**（否则 autoUpdater 拉 latest.yml 404）
- 回复风格：简洁、专业、精准，拒绝套话
- 学术/精神分析文章：宁多勿少、引用出处

---

## 八、外部依赖（不在仓库）

- `~/.workbuddy/skills/winnicott-kb-skill/` — ChromaDB 温尼科特知识库
- `~/.workbuddy/skills/winnicott-perspective/` — 温尼科特临床思维框架
- `~/.workbuddy/skills/meijunhao-perspective/` — 梅俊豪知乎写作风格
- `~/.workbuddy/cognee/` — Cognee 跨会话记忆引擎
- `C:\Users\Administrator\WorkBuddy\2026-06-21-10-33-32\winnicott-chat\` — winnicott-chat 项目（大师对话参考源）

---

**文档作者**：OpenCode（deepseek-v4-pro）
