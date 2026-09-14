# Task 279 Frozen Gap Note

This file is a Codex-created, evidence-bound summary for the isolated task. It is not production authority and does not authorize a release.

## Confirmed context

- Project root: `D:/xinjing-electron`.
- Base commit: `9971787eb6e443ab5a5c80aee118b9b43285c093`.
- The snapshot was taken from a dirty worktree. The manifest, not the base commit, is the source of truth for this task.
- Active release train: `5.0.0/implementation/rt-5.0.0-0001`.
- 270 is still unfinished. Its scope is the commercial main/preload/AI IPC boundary. This task must not repair, replace, or claim completion of 270.
- 277 is the commercial account UI runtime candidate. This task does not implement account UI.
- 278 is the trusted AI kernel runtime candidate. This task does not implement AI request, ClinicalContext, tool, prompt, or longitudinal-summary behavior.

## Gap evidence

The authoritative plan requires all of the following as separate evidence:

- v4.5 sections 19.3 and 19.6: supported Electron upgrade behavior, migration rollback, and update failure rollback.
- v5.0 development-plan sections 25.3, 27.1, 27.3 and 27.4: same-batch artifact evidence, install/upgrade/rollback smoke, no data deletion rollback, and a previous stable artifact plus migration-compatible rollback plan.

The current source has an updater connection in `main.js` and metadata generation in `scripts/postbuild.js`, but the current evidence does not prove a complete rollback rehearsal. The current readiness reconciliation classified the following as incomplete or stale:

1. No current candidate-bound installer/updater/upgrade/rollback matrix.
2. No evidence that a failed migration leaves the prior durable data intact and returns to a previous runnable version.
3. No evidence for the portable replacement helper's failure recovery or for NSIS and portable channel separation under failure.
4. No current candidate-bound proof that `latest.yml` and `latest-portable.yml` metadata match the exact artifact bytes and channel.

The existing encrypted backup implementation is accepted for development scope, but a backup implementation acceptance is not an update rollback rehearsal. This task may use the frozen backup crypto module and synthetic payloads only to prove the update safety boundary.

## Non-goals

- No live project integration.
- No real feed, COS, account, provider, payment, credential, clinical data, package, signature, upload, push, publish, or remote manifest action.
- No change to 270, 277, or 278 conclusions.
