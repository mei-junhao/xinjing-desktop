# 心镜 韩国代理接入（v1.7.0）— 待提供清单

> 用途：用户填写后回传给 AI，AI 据此配置韩国服务器代理 + 客户端 trial-proxy 档位。
> 已确认的设计决策：
> 1. 鉴权 = 客户端内嵌**共享密钥** + 随请求发送**本机安装码(machine id)** 作为用户标识；服务端按机器码记额度、硬封顶。
> 2. 额度记账 = **服务端累计**每个机器码花费，提供 `GET /quota?mid=xxx` 返回剩余元/百分比/重置时间；客户端只展示。
> 3. 交付 = 客户端集成 **+** AI 通过 SSH 把韩国服务器代理与额度服务也配置好。

---

## A. 服务器 SSH 访问（AI 需登录配置）
- 主机 / IP：
- 端口（默认 22）：
- 用户名：
- 认证方式（勾选）：
  - [ ] 密码（私信给我，勿明文留此文件）
  - [ ] 公钥：我把我的 **ed25519 公钥**贴给你，你加到 `~/.ssh/authorized_keys`
  - [ ] 你已把我公钥加好，直接给账号即可
- 操作系统：（Ubuntu 22.04 / Debian 12 / 其他 ___）
- 是否有 sudo / root：
- 出网是否需代理：（韩国机房常有，影响装包与回连上游 API）

## B. 服务器现状（决定配置现有还是重装）
- 是否已运行 LLM 代理？（one-api / ai-gateway / litellm / 自定义 Node / **无**）
  - 若已运行：监听地址+端口、配置文件路径、如何重启
- 是否已有 HTTPS 域名？（域名 ___ / 仅 IP:port）
- 已装运行时：（Node.js / Python / Docker / Nginx / Caddy / 无）

## C. v4-flash 后端（试用档用的高性能模型）
- v4-flash 实际代理到哪个服务商 / 模型？（如：某韩国 Claude 类、OpenAI、自托管等）
- 该后端 API Key：（**只放服务端，绝不进客户端**）
- 代理侧 model 字符串：（如 `v4-flash` 或 `kr-v4-flash`）
- 单价（用于服务端计费，也便于客户端提示）：
  - ¥ / 1M input tokens：
  - ¥ / 1M output tokens：

## D. 内置低性能模型（移上代理，提升安全性）
- 现 SiliconFlow API Key：（**移服务端**，客户端不再持有）
- 代理侧 model 字符串：（原 `Qwen3.5-4B`）

## E. 共享应用密钥
- 由 AI 生成随机密钥，并**同时**写入：① 服务端配置 ② 客户端 `secret.generated.js`（构建期注入 exe，不入库）。
- 你只需确认：是否接受 AI 生成（默认是）。如你已有固定 key 请在此填：___

## F. 额度规则
- 封顶：¥5 / 每机器码 / 30 天
- 重置方式：（30 天滚动窗口 / 固定自然月 / 其他 ___）
- `/quota` 返回字段（AI 将按此实现）：`{ remainingYuan, percent, resetAt }`
- 超额行为：（直接 429 掐断 / 自动降级为内置低性能 / 其他 ___）

## G. 试用期后行为（v4-flash 去向）
- [ ] 到期后 v4-flash 停用，自动回退到「走代理的内置低性能」
- [ ] 到期后仍可继续，但降级为内置低性能速率
- [ ] 其他：___

## H. 客户端已具备、AI 会复用的现状（无需你提供）
- 机器绑定：`resolveFirstInstall()`（ProgramData + userData 取较早，防重装刷）
- 档位判定：`apiConfig.verified===true` → user 档；否则 builtin
- 密钥注入机制：`secret.generated.js`（gitignored，构建期由 `codegen-secret.js` 生成打进 exe）
- 内置模型定义：`ai.js` 的 `BUILTIN_MODEL`（现直连 SiliconFlow Qwen3.5-4B）
- 设置页档位状态：`settings.js` 的 `updateTierStatus`（已验证/未验证/内置 三态）

---
填完把本文件回传即可。AI 收到后会：① SSH 登录排查现状 → ② 部署/配置代理 + 额度服务 → ③ 写 v1.7.0 技术方案 → ④ 改客户端接代理、加 /quota 展示 → ⑤ 独立评审≥95 + 自测 → ⑥ 构建上传 COS。
