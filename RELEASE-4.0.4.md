# 心镜 XinJing 4.0.4 发布说明

> 发布日期：2026-07-17
> 分支：`release/3.6.3-mac`（HEAD 接续 `8be5211` / 4.0.3）
> 版本跨度：4.0.3 → 4.0.4（同套已验证代码以新版本号发布，并补齐延后的 Mac CI 构建）
> 自测：`scripts/self-test.js` → 通过 265 / 失败 0

---

## 一、4.0.4 的定位

4.0.4 **不含任何功能性代码改动**，它是 4.0.3 的「完整双平台发布版」：

- 4.0.3 已通过自测 265/0、Win 构建已上线 COS（`latest.yml` / `latest-portable.yml` 版本 = 4.0.3，资产 HTTP 200）。
- 4.0.3 发版时 Mac 的 tag 推送被延后；本次 **补齐 `v4.0.4` tag 推送**，触发 `build-mac.yml` 在 macOS runner 上构建 dmg/zip 并上传同一 COS 桶。
- 因此 **4.0.4 是首个 Win + Mac 同时可用的完整发布**：Windows 用户经自动更新/便携包获取，macOS 用户从 COS 桶拉取 `latest-mac.yml` 对应资产。

代码层面 4.0.4 与 4.0.3 完全一致，仅版本号元数据（package.json / package-lock.json / version.generated.js / settings.js / settings.html / self-test 断言）由 `4.0.3` 升为 `4.0.4`。

---

## 二、复用 4.0.3 的核心改动（完整清单见 `RELEASE-4.0.3.md`）

1. **活跃来访者上下文**（跨页稳定选人）— `app/js/app.js` + 8 个临床页 `App.setActiveClientId/getActiveClientId()`。
2. **仪表盘快捷入口拖拽整理** — `dashboard.js` 支持 HTML5 drag 排序，持久化 `xj_quick_tools_layout_v1`。
3. **侧栏可折叠分组** — `app.js` `renderDisclosure()`，折叠状态 `xj_sidebar_group_<key>`。
4. **退出确认框放大 + 响应式**（#351）— `closeConfirmWin` 456×378 + 暖色实色主按钮。
5. **账单重构**（#352/#353/#354）— 行内编辑 + 月结账单页 + AI 记账写库修复 + 三入口修复。
6. **大师输入区修复** — `masters.html`/`masters.js` 输入区显示。
7. **版本一致性** — 五处版本元数据同步。

---

## 三、改动文件清单（仅版本元数据）

| 文件 | 类别 | 说明 |
|---|---|---|
| `package.json` | 版本 | 4.0.3 → 4.0.4 |
| `package-lock.json` | 版本 | 4.0.3 → 4.0.4 |
| `version.generated.js` | 版本 | 构建期同步 `4.0.4`（gitignored，由 `codegen-version.js` 生成） |
| `app/js/settings.js` | 版本 | 回退版本 `'4.0.4'` |
| `app/settings.html` | 版本 | 静态 `v4.0.4` 双处回退 |
| `scripts/self-test.js` | 自测 | `v4.0.3-*` → `v4.0.4-*` 断言 |
| `RELEASE-4.0.4.md` | 文档 | 本文档 |

---

## 四、发布验证

- **自测**：`scripts/self-test.js` → 通过 265 / 失败 0（含 `v4.0.4-1` 文档中心/大师输入框/快捷入口运行时防回归、`v4.0.4-2` 版本与预览基准一致）。
- **构建**：`XJ_NO_BUMP=1` 跑 `scripts/cnb-build.ps1`（锁版 4.0.4）上传 COS。
- **上线**：验证 COS `latest.yml` / `latest-portable.yml` 版本 = 4.0.4 且资产 HTTP 200。
- **Mac**：用 `~/.ssh/id_ed25519_xinjing` 推 `release/3.6.3-mac` 分支与 `v4.0.4` tag 触发 `build-mac.yml`，构建后 dmg/zip/`latest-mac.yml` 上传同桶根。

---

## 五、已知遗留

- Mac 首次安装仍需手动绕过 Gatekeeper（用户决策：不买 Apple Developer），更新包由 app 自下载通常无需再绕过。
- 两个 git stash（`xj-pre-3.6.3-release`、`calendar-wip-exclude-from-3.5.0`）属无关分支的预 bump 工作，未纳入本次发布。
