# XJ-5.1.9 候选冻结、发布与本机升级报告

- `task_id`: `XJ-5.1.9-release-candidate-freeze-and-publish-001`
- `contract_id`: `contract-xj-519-release-chain-v1`
- `write_lock_id`: `lock-XJ-5.1.9-release-candidate-freeze-and-publish-001`
- `base_commit`: `9971787eb6e443ab5a5c80aee118b9b43285c093`
- `candidate_base_commit`: `fe377548b2aef1853ede0b527da268f1b60835c6`
- `candidate_file_count`: `197`
- `candidate_aggregate_sha256`: `5BCB508CDFC2C9563CB03CE5254566B92CB06E92DA0BB2D1DCA0DEFFE8EE7EDC`

## 结果

5.1.9 已完成候选冻结、构建、自签名、COS 上传、HTTPS 逐字节回读和本机静默升级。发布锁已收口为 `released=true`。旧候选聚合 SHA `3DA5E8EC...` 未复用。

## 接纳变更

- `main.js`：验收/健康探针账号 API 默认拒网，仅允许显式回环 HTTP；Window 菜单使用中文 Minimize/Close 标签。
- `app/js/app.js`：侧栏初始 `aria-expanded` 与已保存折叠状态同步。
- 002 MVP、PII 脱敏和 UI 对齐交付已纳入本候选；构建源由 `candidate-manifest-519.json` 固定。

## 候选与构建证据

- manifest：`D:/xinjing-electron/qa/package-candidates/5.1.9-build/candidate-manifest-519.json`
- 聚合 SHA：`5BCB508CDFC2C9563CB03CE5254566B92CB06E92DA0BB2D1DCA0DEFFE8EE7EDC`
- `candidate_file_count=197`；构建前后候选源无漂移。
- PII 测试：14/14 PASS；002 真实 Electron 验收：14/14 PASS；`node --check main.js`、`node --check app/js/app.js`、`git diff --check` 均 PASS。

## 签名

- 证书主题：`CN=XinJing 5.1.9 Internal`
- 两个 EXE 均使用同一内部自签名证书，`public_trust=false`；系统不信任根证书的状态如实保留。
- 签名证据：`D:/xinjing-electron/qa/package-candidates/5.1.9-build/signature-results-518.json`

## COS 六件套

基址：`https://xinjing-1439314927.cos.ap-guangzhou.myqcloud.com/`。以下 SHA 为本地与 HTTPS 回读值，均逐字节一致：

| 文件 | URL | SHA-256 |
|---|---|---|
| setup | https://xinjing-1439314927.cos.ap-guangzhou.myqcloud.com/xinjing-setup-5.1.9.exe | `F97CB330E2E5012C2FB91D7BEA19D3F29568C64C8C2B8138E32D5AC4839617A8` |
| portable | https://xinjing-1439314927.cos.ap-guangzhou.myqcloud.com/xinjing-portable-5.1.9.exe | `62E57E48FFA9CA689A81345464EE601EBCA6690879CA96C5D1DBDD54E0599D6A` |
| setup blockmap | https://xinjing-1439314927.cos.ap-guangzhou.myqcloud.com/xinjing-setup-5.1.9.exe.blockmap | `0E61F73FBF676E3E44DD87691044AC8F83BB731CFD42372AA99AC1CD9D85978F` |
| portable blockmap | https://xinjing-1439314927.cos.ap-guangzhou.myqcloud.com/xinjing-portable-5.1.9.exe.blockmap | `1C5DC085D0FC9A73A729FAE1A9D9259D6EB6405FF136AB61C1FE59F8A805352A` |
| latest.yml | https://xinjing-1439314927.cos.ap-guangzhou.myqcloud.com/latest.yml | `98FCF40C4719A0789E3AE1E5B5F281F8B4F9C91070D814CD638FDBA6211492E6` |
| latest-portable.yml | https://xinjing-1439314927.cos.ap-guangzhou.myqcloud.com/latest-portable.yml | `5370175BE8E070D906D4249D0CF5DFD7A6A6429D706FC6EAC27A4D2E071627B0` |

Feed 双通道均报告 version `5.1.9`，size 与 SHA-512 和 EXE 实际字节匹配。完整逐字节证据：`D:/xinjing-electron/qa/package-candidates/5.1.9-build/cos-verification-519.json`。

## 本机升级与健康探针

- 静默安装器 exit code：`0`
- 安装目录版本：`5.1.9`
- XJ463 健康探针：exit `0`，marker `status=ok`、version `5.1.9`
- `networkAttempted=false`，`denySentinelBlocked=true`

## 未完成与风险披露

- P-3“服务器模型偏好跨设备回显”仍未实现：当前服务端只有模型目录/价格读取，没有账号偏好读写端点；本轮未修改远程服务器，归类 `incomplete/P2`。
- 自签名证书不是公开信任证书，Windows 可能显示未受信任发布者；这是内部发布策略的已知限制。

## 发布状态

`release-ready -> publish-authorized -> publishing -> released`

DELIVERY_REPORT: D:/xinjing-electron/qa/agent-reviews/XJ-5.1.9-release-candidate-freeze-and-publish-001.md
