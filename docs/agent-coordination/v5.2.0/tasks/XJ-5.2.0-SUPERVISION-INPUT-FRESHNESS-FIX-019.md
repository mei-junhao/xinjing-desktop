# XJ-5.2.0-SUPERVISION-INPUT-FRESHNESS-FIX-019

- task_id: XJ-5.2.0-SUPERVISION-INPUT-FRESHNESS-FIX-019
- owner: gpt-6.1-sol-low
- manager: Codex /root
- project_root: D:/xinjing-electron
- active_release_train: 5.2.0 implementation; stage 019; not release-ready
- agent_profile_id: gpt-6.1-sol-low
- contract_id: xj-5.2.0-supervision-input-freshness-fix-v1
- write_lock_id: lock-5.2.0-supervision-input-freshness-fix-019
- write_allowlist: app/js/clinical-agent-runtime.js; tests/v5.2.0/clinical-agent-runtime.contract.test.cjs; docs/delivery-reports/XJ-5.2.0-SUPERVISION-PRODUCTION-INTEGRATION-015.md
- forbidden: other production code, runner changes, package/version/release files, real data/network, commit/merge/push/sign/upload/publish

## Context and Root Cause

Stage 018 fixed the browser UMD entry. The real Electron flow now reaches both visible confirmation dialogs and invokes the bridge, but post-confirm execution fails with stale-before before action-run/AI. The standard supervision request contains command text 生成整体印象 and clinical inputText containing the material used to build the snapshot. clinical-agent-runtime.js currently replaces that material with request.text. ClinicalContext.isSnapshotCurrent then correctly rejects the mismatched digest.

## Objective

Use the canonical request.inputText for adapter freshness and execution, falling back to request.text only when inputText is absent. Preserve routing, snapshots, lifecycle ordering, cancellation, and privacy. Prove the real Electron path reaches action-run before provider failure/cancel.

## Required Work

1. Make the smallest runtime mapping fix in app/js/clinical-agent-runtime.js.
2. Add a focused contract with distinct command text and clinical inputText, including stale negative coverage.
3. Do not weaken the strict Electron runner. It must show first confirmation and cancel with zero action/AI, second confirmation, action-run before real AI, and post-confirm provider failure/cancel without raw leakage.
4. Keep synthetic/no-network boundaries and existing contracts.

## Validation

Run node --check app/js/clinical-agent-runtime.js; node --test tests/v5.2.0/clinical-agent-runtime.contract.test.cjs; node --test tests/v5.2.0/*.contract.test.cjs; node tests/v5.2.0/015-local-electron-acceptance.cjs; and git diff --check on allowlisted files. The runner exits zero only with complete positive evidence; pre-execution stale failure remains nonzero.

The report must include adversarial review: restore request.text precedence, remove regression test, move action-run after AI, bypass freshness, swallow provider failure, skip await, or expose private fields. Preserve the final line exactly:

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-SUPERVISION-PRODUCTION-INTEGRATION-015.md

## Stop Conditions

Stop and report blocked if page/business modules must change or if the strict runner still cannot show action-run before a real provider/cancel terminal outcome.

## Agent Instructions

You are the execution agent, not the acceptance owner, and you are not alone in the repository. Preserve unrelated changes. Read this card and the 015 report before writing. Perform independent adversarial self-review and classify evidence as confirmed, stale, false, incomplete, or out of scope. Return [STATUS], [ARTIFACTS], and [VALIDATION] in Chinese and stop writing after delivery.
