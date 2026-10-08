# XJ-UI-ALIGNED-STAGE1 · aligned 皮肤令牌层（UI 对齐阶段 1/3）

> **草案状态**：待立项。版本/train 待定（建议下一 feature train，如 5.1.9）；base_commit 参考 9971787（撰写时 HEAD，切卡时重取）。
> **依据**：`qa/task-scratch/ui-align-legalework/visual-compare.html` 视觉对照稿（决策已定：A1 衬线保留 / B1 aligned 新默认皮肤 / C1 分阶段可回退）。
> **硬约束**：不删除、不弱化任何心镜现有功能；calm/editorial/xinjing（tokens.css 旧体系）与 clinical/theatre/observatory（生产皮肤体系）全部保留可切回。

- `task_id`: `XJ-5.1.9-draft-ui-aligned-skin-stage1`
- `write_lock_id`: `lock-XJ-5.1.9-draft-ui-aligned-skin-stage1`（立项时分配）
- `authorization`: 待用户签发
- `delivery_report`: `D:/xinjing-electron/qa/agent-reviews/XJ-5.1.9-draft-ui-aligned-skin-stage1.md`

## 单一关键结果

新增第 4 皮肤 `data-skin="aligned"`（LegaleWork 设计语言：Apple 蓝 + 玻璃侧栏 + 平台原生 sans + 120/240ms 双档动效）并设为**默认皮肤**；三条旧皮肤与全部功能零改动、可随时切回；真实 Electron 明暗双态 + 全页面回归通过。

## 写集（执行 agent）

- `app/css/xj-ui-system.css`：新增 `[data-skin="aligned"]` / `[data-skin="aligned"].dark` 令牌块（映射 `--xj-*` 与 `--paper/--ink/--accent/--hair` 全套，值取自视觉对照稿第 5 节映射表）；aligned 皮肤 swatch 色（`.xj-skin-swatch.aligned`）
- `app/css/workbench.css`：aligned 皮肤的工作台配色对位块（如 clinical 块存在对位结构则同步）
- `app/css/tokens.css`：`--sans` 在 aligned 作用域下换平台原生栈（Segoe UI Variable Text / SF Pro Text + PingFang SC）；`--serif` 不动（决策 A1）
- `app/js/app.js`：三处皮肤 allowlist（迁移 IIFE / Theme.getSkin / Theme.setSkin）加入 `'aligned'`；默认回退 `'clinical'` → `'aligned'`；`updateLicenseState` 降级逻辑白名单 aligned（aligned 为免费默认皮肤，不参与 premium-skins 降级）
- `app/settings.html`：皮肤选择卡新增「aligned · 对齐（默认 · 免费）」选项（含预览 swatch 与文案），theatre/observatory 的会员门控保持不变
- 本卡测试：`scripts/v5.1.9-tests/XJ-ui-aligned-skin-stage1/**`
- 本卡 scratch 与交付报告

## 明确不做（后续阶段卡）

- 阶段 2（另立卡）：组件精修——主按钮半透明填充、卡片圆角 14+LW 阴影档、chips 胶囊化、字体密度（11px 辅助层）
- 阶段 3（另立卡）：布局校准 + 对照 LegaleWork 实机的像素级打磨
- 不改信息架构、不删改任何页面/组件/交互流程、不动 compliance/脱敏相关工作流

## 验收契约

1. aligned 皮肤（亮/暗）下真实 Electron 启动，遍历全部 13+ 页面：无取色断裂（变量缺失导致透明/黑块）、无横向溢出；18 格矩阵（3 视口 × 皮肤对位 × 明暗）几何判定 PASS。
2. 三条旧皮肤切换后逐像素快照与切换前一致（skin-scoped 隔离证明）；`xj_skin` 已存用户保留原值，未存用户默认得到 aligned。
3. 会员门控行为不变：aligned 免费；theatre/observatory 仍需 premium；非 premium 用户落在 theatre/observatory 时仍被降级回**其原有的 clinical**（不得把降级目标改成 aligned 之外破坏现有约定——降级目标保持 clinical，aligned 不参与降级）。
4. 动效令牌生效：aligned 下 transition 采用 120/240ms + material/spring 缓动；`prefers-reduced-motion` 契约不回退。
5. 至少 3 个 expected-red 变异且真实失败：删除 aligned 令牌块（页面应回退 clinical 而非白屏——断言回退行为）、篡改 aligned accent 值（色板断言检出）、allowlist 移除 aligned（默认皮肤断言检出）。
6. `node --check` 全部改动 JS；`git diff --check`=0；交付报告含逐文件 SHA 与 allowlist/保护文件零漂移声明。

## 停止条件

皮肤降级/会员门控逻辑出现预期外耦合、任一旧皮肤出现可感知差异、18 格矩阵失败两轮未修复 → `blocked` 并释放 lease。
