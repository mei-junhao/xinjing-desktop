# Task Card: XJ-5.2.0-AGENT-API-ENTRY-WIRING-022

- task_id: XJ-5.2.0-AGENT-API-ENTRY-WIRING-022
- objective: Wire the existing app/js/agent-api.js facade into the two real Agent entry pages (index.html and chat-home.html) so the already-implemented window.XJAgent chat/session/tool APIs are actually available to user workflows. Preserve the existing AgentCore/AgentTools/XinJingChat behavior and keep all other routes lazy/unmodified.
- owner: gpt-6.1-sol-low
- manager: codex (/root)
- project_root: D:/xinjing-electron
- branch_or_worktree: release/3.6.3-mac; shared worktree; do not switch branches or create commits
- base_commit: eb16e2b74e6ab919a782b8bc6f66bfe9524431f2
- active_release_train: 5.2.0 implementation; stage 022; not release-ready
- config_evidence_id: cfg-5.2.0-20261005-agent-api-entry-wiring-022
- agent_profile_id: gpt-6.1-sol-low
- contract_id: xj-5.2.0-agent-api-entry-wiring-v1
- write_lock_id: lock-5.2.0-agent-api-entry-wiring-022
- benchmark_manifest: synthetic XJAgent facade availability, session lifecycle, read/write tool gate, explicit write confirmation, failure projection, duplicate script/order guard v1
- visual_baseline: existing index/chat-home Agent surfaces; no visual redesign; preserve all route/layout/skin behavior
- prerequisites:
  - XJ-5.2.0-SUPERVISION-STREAM-CALLBACK-021 accepted by Codex intake
  - read-only audit confirmed agent-api.js defines window.XJAgent but no production HTML loads it
  - RELEASE-4.2.0.md describes the module as previously added but pending lazy integration
- current_target_hashes:
  - app/index.html: 384D3A3F397199D51B7AD5442C7C2DF912B8E71EBC2722F65B9CA4F9413993F8
  - app/chat-home.html: 05B73EF8C6A8BC0D768A38EA4D5BA5A6A00832E7962F16E9CD0A3E6164B38FDA
  - app/js/agent-api.js: 124D0135B9A0C8317ED30A6F76A2C279B6EFFBBFC7D56C8999954072C2771848
  - app/js/agent-core.js: 00F758CE37702108AF4FF9BF48C294EDCB5BC32480B6DD6AD6DFD7F7235A5AD2
  - app/js/agent-tools.js: FBD7BBF2BCA95BA025420998AB96511BB517725028ECD2FA9998A7C80A644D2B
  - app/js/xinjing-chat.js: 06978873D43A2D45F31699D6DD6CF405189D4A9521EF478F11F285E136399FA1
  - app/js/clinical-agent-runtime.js: 6FF7382E33D6710992BF6DA3DCA22956EB15BD649431406FFE92899FADE6D435
  - app/js/clinical-agent-adapter.js: 7D7E0D1E53F7E8CDDA321A85F31BD7A22FB07FC12A0C6FCE34A0512B3F64CC4D
  - app/js/clinical-agent-production-bridge.js: 46F13F0B4C4B53238582D014D79BE6CDEAAF7859FBCA16BDC2787F81D35DA276
  - app/supervision.html: 4404F4A7D15024A41FA9058C9010A2A47D0A3CB45EEBB6184228714205A2EBD8
  - package.json: B74E0AA8F9B645D06647096545A3C611C112EF217AABADEA407B1950D629FC72
  - package-lock.json: FDB8D11766CE697211B6C21AEE91E488ECD8E12FEAFF725C568D62906156CB03
- write_allowlist:
  - app/index.html (add one ordered script tag only)
  - app/chat-home.html (add one ordered script tag only)
  - tests/v5.2.0/agent-api-entry-wiring.contract.test.cjs (new behavioral contract)
  - docs/delivery-reports/XJ-5.2.0-AGENT-API-ENTRY-WIRING-022.md (new report)
- forbidden:
  - app/js/agent-api.js and all other production JS changes
  - supervision.html/supervision.js/clinical-agent-* modules and all other HTML routes
  - package/version/build/release files, main/preload, network, real clinical data, commits, merges, pushes, signing, upload or publish
- required_behavior:
  - Both target pages load js/agent-api.js exactly once, after agent-tools.js and agent-core.js and before page code that may consume XJAgent.
  - No duplicate agent-api.js tag, no order inversion, no change to existing scripts/routes/layout.
  - In a synthetic VM with AI/Store/App/AgentCore/AgentTools dependencies, evaluating the page script order creates window.XJAgent with chat, createSession, invokeTool, listTools, getAvailabilityReason, and ERR.
  - Read tools remain callable without write confirmation; non-read tools remain fail-closed until explicit write guard/confirmation. Do not weaken existing agent-api semantics.
  - Session close releases active state; failure results are stable and do not expose private messages, payload, executor, or lifecycle handles.
- required_tests:
  - Behavioral contract must parse the real HTML script order and execute the real agent-api.js plus dependency fixtures in a VM; do not rely solely on string presence.
  - Assert target pages pass exactly one API tag and correct dependency order; a mutation removing either tag or moving it before dependencies must fail.
  - Assert XJAgent facade availability, read/write gating, session create/send/close and safe failure projection with synthetic data.
  - Run node --check app/js/agent-api.js, node --check tests/v5.2.0/agent-api-entry-wiring.contract.test.cjs, full tests/v5.2.0/*.contract.test.cjs, and controlled Electron acceptance.
- required_adversarial_tests:
  - Remove either HTML tag: focused contract fails.
  - Move API tag before agent-tools/agent-core: VM dependency assertion fails.
  - Replace real agent-api with a mock global: contract fails because facade methods/semantics are missing.
  - Bypass write gate or expose raw failure/private fields: negative assertions fail.
  - Ensure async session tests await completion and no source-string-only green.
- acceptance_commands:
  - node --test tests/v5.2.0/agent-api-entry-wiring.contract.test.cjs
  - node --test tests/v5.2.0/*.contract.test.cjs
  - node --check app/js/agent-api.js
  - node --check tests/v5.2.0/agent-api-entry-wiring.contract.test.cjs
  - node tests/v5.2.0/015-local-electron-acceptance.cjs
  - git diff --check -- app/index.html app/chat-home.html tests/v5.2.0/agent-api-entry-wiring.contract.test.cjs docs/agent-coordination/v5.2.0/tasks/XJ-5.2.0-AGENT-API-ENTRY-WIRING-022.md docs/delivery-reports/XJ-5.2.0-AGENT-API-ENTRY-WIRING-022.md
  - Get-FileHash app/js/agent-api.js,app/js/agent-core.js,app/js/agent-tools.js,app/js/xinjing-chat.js,app/js/clinical-agent-runtime.js,app/js/clinical-agent-adapter.js,app/js/clinical-agent-production-bridge.js,app/supervision.html,package.json,package-lock.json -Algorithm SHA256
- checkpoints:
  - A: read AGENTS.md, UI references, 021 report, target HTML dependency order and agent-api semantics; confirm no second writer and allowlist before edits
  - B: focused VM behavior contract passes, including mutation-sensitive tag/order and write-gate checks
  - C: inspect exact diff, rerun full contracts and controlled Electron evidence, recompute protected hashes, complete adversarial self-review, and write report before delivery
- rollback: remove only the two added script tags, focused contract and stage report; preserve 021 and all unrelated worktree changes; never reset, clean or revert unknown work
- stop_conditions:
  - target page requires agent-api changes, duplicate facade semantics, new persistence or UI redesign
  - inability to prove dependency order, write-gate preservation or safe failure projection
  - protected hash drift, second writer, allowlist drift, mock-only green or real-data/network action
- delivery_report: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-API-ENTRY-WIRING-022.md
- acceptance_owner: /root
- next_after_acceptance: only after independent Codex intake may plan the next bounded 5.2.0 stage; this stage does not mark release-ready or authorize packaging/publishing

## Agent Instructions

你是执行代理，不是最终验收人；/root 负责范围、架构、冲突协调和最终验收。你不是独自在代码库中工作，必须保留未知改动。只修改 allowlist，不得创建提交。

开始前读取 AGENTS.md、xinjing-ui-system 相关参考、021 交付报告、index/chat-home 实际 script 顺序和 agent-api 真实依赖。实现只允许增加两个有序 script 标签，不改 agent-api 内部逻辑，不把它接入全部页面。

交付前必须先做独立内部对抗审查，单列章节，记录真实 HTML/VM 入口、读写工具正反路径、session close/failure、私有字段隔离、写集与哈希、测试是否等待 Promise，以及 mock/proxy/源码字符串假绿风险。报告使用简体中文，列出 [STATUS]、[ARTIFACTS]、[VALIDATION]、P0-P3、残余风险和未授权动作，最后一行严格为：

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-API-ENTRY-WIRING-022.md
