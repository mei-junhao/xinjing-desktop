# 心镜 XinJing 开发分支与 Codex 接入说明

> 生成时间：2026-07-16 13:36（GMT+8）
> 背景：用户接入 Codex 继续开发 xinjing 项目，Codex 定位到 `release/3.6.3-mac`，询问正确分支。

## 结论（一句话）

**正确开发 / 发版分支就是 `release/3.6.3-mac` —— Codex 定位得没错。**

分支名带 "mac" 是历史遗留（最初仅为 Mac CI 构建而建），但现在它已是事实上的主干，**所有 3.5.x / 3.6.x 的 Windows 与 Mac 发版都从这一个分支走**。不要切到 `main`。

## 为什么是这个分支

- `main` 分支停留在早期提交 `3096bea`（自动更新迁移到 COS），长期未更新，落后主线很多。
- 所有 3.6.x 的功能提交、发版 tag（v3.6.3 ~ v3.6.8）、COS 上传都基于 `release/3.6.3-mac`。
- Mac CI（`.github/workflows/build-mac.yml`）由打 `v*` tag 触发，与具体分支名无关；Windows 一键构建 `scripts/cnb-build.ps1` 也在这条分支上跑。

## 当前 Git 真实状态（已实测）

| 项 | 值 | 说明 |
|---|---|---|
| 当前分支 | `release/3.6.3-mac` | 本地 HEAD |
| 本地 HEAD | `720a9bb` | "Refactor the Electron settings and session flow" |
| 该 commit 作者 | Mei，2026-07-16 13:27 | **Codex 接入后做的第一个提交**（引入 `android/` Capacitor 脚手架） |
| 远程 `origin/release/3.6.3-mac` | `a94749e` | 3.6.8 NSIS close-app 修复（已 push） |
| ahead / behind | 本地领先 1，远程不领先本地 | 干净前向开发，无分叉冲突 |
| 工作区 | 20+ 文件被修改未提交 | Codex 进行中的改动（含新文件 `app/js/xinjing-chat.js`） |

### 关键事实澄清
- `720a9bb`（Codex 的 android 重构）**基于 `a94749e`（3.6.8 NSIS 修复）之上**，因此 **3.6.8 的安装器修复没有丢失**，仍在历史链里。
- 本地仅比远程多 1 个未 push 的 commit，远程不比本地多 → 不是 diverge，是单纯"本地有未推送的新活"。
- 工作区大量未提交改动是 Codex 正常进行中的开发，无需干预。

## 给 Codex 的明确操作指引

1. **留在 `release/3.6.3-mac` 继续开发**，不要切换到 `main`（`main` 是早期旧线，切过去会丢失全部 3.6.x 工作）。
2. 正常 `git commit`（按既有约定：中文 `feat/fix` 前缀）。**默认不主动 `git push`**——发版由一键脚本 + 打 tag 推远程触发 Mac CI。
3. 发版流程（沿用）：
   - 跑 `powershell -ExecutionPolicy Bypass -File scripts/cnb-build.ps1`（自动 bump patch、electron-builder 打包、coscli 上传 6 件到 COS 桶 `xinjing-1439314927`）。
   - 构建成功后 `git tag v3.6.x` + `env -u GITHUB_TOKEN git push origin HEAD:refs/heads/release/3.6.3-mac --tags` 触发 Mac CI。
4. 密钥绝不入库：`.license-secret` / COS 密钥只在本机或 CI secret；`package.json build.files` 已显式列 `secret.generated.js`。

## 长期建议（当前不必动）

分支名 `release/3.6.3-mac` 极具误导性。后续稳定时可重命名为 `develop` / `main-dev` 并同步更新 Mac CI 的触发配置，但**现在不要动**，以免打断 Codex 正在进行的开发会话。
