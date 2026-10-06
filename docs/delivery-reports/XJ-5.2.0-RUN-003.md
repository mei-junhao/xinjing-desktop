# XJ-5.2.0-RUN-003 Delivery Report

- task_id: XJ-5.2.0-RUN-003
- contract_id: xj-5.2.0-agent-run-contract-v1
- agent_profile_id: gpt-6.1-sol-low
- lifecycle: received -> running -> intake-rejected -> running -> delivered
- scope: only the allowlisted new AgentRun module, focused contract test, and this report

## Artifacts

- `app/js/clinical-agent-run.js`
- `tests/v5.2.0/clinical-agent-run.contract.test.cjs`
- `docs/delivery-reports/XJ-5.2.0-RUN-003.md`

## Validation

- `node --test tests/v5.2.0/clinical-agent-run.contract.test.cjs`: 5 passed, 0 failed.
- `node --check app/js/clinical-agent-run.js`: passed.
- `node --check app/js/clinical-agent-tasks.js`: passed.
- `node --check app/js/clinical-agent-router.js`: passed.
- `git diff --check` for allowlisted source/test/report paths: passed.
- Protected hashes rechecked against task card: all matched, with no changes to protected files.
- Intake rework: added validated `outputDisposition` metadata (`preview`/`draft`), defaulted creation to `preview`, enforced draft-ready projection, and rejected disposition fields on steps.

## Coverage and adversarial review

- Status transition matrix: legal paths covered through persisted; illegal direct persisted, failed->running, and prerequisite bypasses rejected.
- Terminal states: persisted, stale, failed, and cancelled cannot transition onward.
- Preconditions: runId/taskId, initial status, adopted<-draft-ready, persisted<-adopted, and bounded step metadata enforced.
- Immutability: transitions and appendStep return frozen copies; input run and nested metadata remain unchanged.
- Metadata-only projection: project exposes identifiers, status, step IDs, source summaries, and dispositions; no body, prompt, answer, or model output.
- Leakage rejection: appendStep rejects prompt/content fields and projection contains no body/prompt values.
- Mutation-sensitive attacks attempted: bypass transition guards, drop adopted/draft-ready prerequisites, and accept clinical content in steps; focused tests fail under each mutation.

## Internal adversarial review

The implementation was reviewed against the required attack cases before delivery. Removing the transition guard makes the prerequisite tests red; dropping the adopted/draft-ready checks makes the prerequisite assertions red; replacing bounded step-key validation permits content/prompt and makes the leakage assertion red. No Electron, Store, AI, router, network, or clinical data dependency was introduced.

The prior intake was rejected because output disposition was not preserved or validated. This revision adds focused coverage for default preview, explicit draft, invalid disposition rejection, draft-ready projection, and absence of answer/prompt/body fields.

## Out of scope

No AgentCore, AgentTools, ClinicalContext, Store, UI, package, version, release, or existing test/report file was modified. No commit, push, merge, network write, or real clinical data was used.

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-RUN-003.md
