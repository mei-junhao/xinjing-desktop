# XJ-5.1.9 候选冻结、发布与本机升级 001

- `task_id`: `XJ-5.1.9-release-candidate-freeze-and-publish-001`
- `contract_id`: `contract-xj-519-release-chain-v1`
- `write_lock_id`: `lock-XJ-5.1.9-release-candidate-freeze-and-publish-001`
- `base_commit`: `9971787eb6e443ab5a5c80aee118b9b43285c093`
- `active_release_train`: `5.1.9/release/rt-5.1.9-0001`
- `config_evidence_id`: `xj-519-local-source-and-build-policy-20260904`
- `agent_profile_id`: `Codex-main`（平台未独立暴露当前档位）
- `benchmark_manifest`: `qa/package-candidates/5.1.9-build/candidate-manifest-519.json`
- `visual_baseline`: `qa/agent-reviews/xinjing-full-ui-walkthrough-codex-20260825.md`（2026-09-04 源码隔离实机续走查）
- `authorization`: `user-authorized-5.1.9-build-sign-upload-install-20260904`
- `delivery_report`: `D:/xinjing-electron/qa/agent-reviews/XJ-5.1.9-release-candidate-freeze-and-publish-001.md`

## 单一关键结果

将当前 5.1.9 修复源冻结为候选，构建 setup/portable，使用内部自签名证书发布到 XinJing COS 更新通道，并完成本机静默升级与健康验证。

## 本轮修复源

- `app/js/report-writing.js`：报告完成动作和 AI 请求取消/失败状态接线。
- `app/css/masters-clinical.css`：大师视角折叠时中央工作区最大化、圆桌纵向排列和溢出约束。
- `app/js/settings.js`、`app/settings.html`：5.1.9 版本兜底显示。
- `scripts/verify-build-files-policy.js`：候选构建版本闸门更新为 5.1.9。
- `package.json`、`package-lock.json`、`version.generated.js`：版本三件套同步为 5.1.9。

## 允许范围

- 当前工作树中已存在的 5.1.9 生产源和 `app/**` 候选快照。
- `qa/package-candidates/5.1.9-build/**` 候选、构建、签名、元数据和验证证据。
- 本卡报告及 `docs/agent-coordination/v5.1.9/**` 锁记录。
- COS bucket `xinjing-1439314927` / region `ap-guangzhou` 的 setup/portable、双 blockmap、双 feed 六件套上传。
- 关闭本机 XinJing、静默安装 5.1.9 和临时 userData 健康探针。

## 禁止事项

- 不回退、清理或覆盖工作树历史脏改动；不改与本轮修复无关的生产逻辑。
- 不把 COS 凭据、签名私钥、账号数据、临床材料或 token 写入包、报告或消息。
- 构建使用根 `electron-builder.yml`、正向 allowlist 和 `--publish never`；沿用 `scripts.dist=electron-builder`。
- 证书必须记录 `CN=XinJing 5.1.9 Internal` 与 `public_trust=false`。

## 必须完成

1. 版本三件套一致为 `5.1.9`，候选逐文件 SHA-256 和聚合 SHA 冻结，构建前后零漂移。
2. setup/portable EXE、两个 blockmap、`latest.yml`、`latest-portable.yml` 均存在，feed 的 size/SHA-512 与最终签名后字节匹配。
3. 两份 EXE 的 Authenticode Subject 为 `CN=XinJing 5.1.9 Internal`；自签名链不受系统信任时如实标记 `public_trust=false`。
4. COS 六件套 HTTPS 回读逐字节匹配；安装器静默退出码为 0；安装目录与 XJ463 健康探针版本为 `5.1.9`。
5. 发布状态按 `release-ready -> publish-authorized -> publishing -> released` 留痕，并保留独立证据核对记录。

## 停止条件

候选漂移、第二写者、签名主题不符、feed/远程字节不一致、安装器或健康探针失败、敏感值泄露或真实数据风险，立即停止并进入等待裁决。

DELIVERY_REPORT: D:/xinjing-electron/qa/agent-reviews/XJ-5.1.9-release-candidate-freeze-and-publish-001.md
