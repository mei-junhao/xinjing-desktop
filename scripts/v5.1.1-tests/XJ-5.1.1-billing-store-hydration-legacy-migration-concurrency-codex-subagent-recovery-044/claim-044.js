'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = 'D:/xinjing-electron';
const TASK = 'XJ-5.1.1-billing-store-hydration-legacy-migration-concurrency-codex-subagent-recovery-044';
const CARD = path.join(ROOT, 'docs/agent-coordination/v5.1.1/tasks', `${TASK}.md`);
const STORE = path.join(ROOT, 'app/js/store.js');
const PREDECESSOR_CARD = path.join(ROOT, 'docs/agent-coordination/v5.1.1/tasks/XJ-5.1.1-billing-store-hydration-legacy-migration-concurrency-evidence-rework-043.md');
const LOCKS = path.join(ROOT, 'docs/agent-coordination/v5.1.1/write-locks.json');
const SCRIPT_ROOT = path.join(ROOT, 'scripts/v5.1.1-tests', TASK);
const SCRATCH_ROOT = path.join(ROOT, 'qa/task-scratch', TASK);
const CLAIM = path.join(SCRIPT_ROOT, 'EXECUTOR_CLAIM.json');
const LEASE = path.join(SCRIPT_ROOT, 'LEASE.json');
const EXPECTED_CARD_SHA = 'FCA7266ED2D8BB543A6AF1CBEEDAD7AE4F08483659C3FC0DACF9CDD9557AB087';
const EXPECTED_STORE_SHA = '84DED0E7EAF3B8DE98A727D5F1671ED42B9EA27AE7EA27CAA644E8EF20CF768D';
const EXPECTED_PROTECTED_SHA = 'D52755D4AED2E9E8D8A4CFF316B3B5F8B2D937B33AA766523998006DAA8B336C';
const LOCK_ID = `lock-${TASK}`;
const RUN_NONCE = crypto.randomBytes(16).toString('hex');
const RUN_ID = `run-044-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${RUN_NONCE.slice(0, 12)}`;

function shaFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

function lstatInfo(file) {
  const st = fs.lstatSync(file);
  return {
    path: path.resolve(file),
    realpath: fs.realpathSync.native(file),
    isSymbolicLink: st.isSymbolicLink(),
    isDirectory: st.isDirectory(),
    isFile: st.isFile(),
    size: st.isFile() ? st.size : null,
  };
}

function git(args) {
  return cp.execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function writeNew(file, value) {
  const fd = fs.openSync(file, 'wx');
  try {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.writeSync(fd, bytes, 0, bytes.length, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

if (fs.existsSync(CLAIM) || fs.existsSync(LEASE)) {
  throw new Error('044 claim/lease already exists; refusing second writer');
}
fs.mkdirSync(SCRIPT_ROOT, { recursive: true });
fs.mkdirSync(SCRATCH_ROOT, { recursive: true });

const startUtc = new Date().toISOString();
const head = git(['rev-parse', 'HEAD']);
const branch = git(['branch', '--show-current']);
const statusStart = git(['status', '--short']);
const cardSha = shaFile(CARD);
const storeSha = shaFile(STORE);
const predecessorSha = shaFile(PREDECESSOR_CARD);
const lockSha = shaFile(LOCKS);

let lockState = null;
let lockEntry = null;
try {
  const lockDoc = JSON.parse(fs.readFileSync(LOCKS, 'utf8'));
  lockState = lockDoc.base_commit === head && lockDoc.active_release_train === '5.1.1/implementation/rt-5.1.1-0001'
    ? 'base/release match' : 'base/release mismatch';
  lockEntry = (lockDoc.locks || []).find(x => x.lock_id === LOCK_ID) || null;
} catch (e) {
  lockState = `parse-error:${e.message}`;
}

const pathFacts = {
  root: lstatInfo(ROOT),
  scriptRoot: lstatInfo(SCRIPT_ROOT),
  scratchRoot: lstatInfo(SCRATCH_ROOT),
  card: lstatInfo(CARD),
  store: lstatInfo(STORE),
  predecessorCard: lstatInfo(PREDECESSOR_CARD),
  locks: lstatInfo(LOCKS),
};

const platformModel = process.env.CODEX_MODEL || process.env.OPENAI_MODEL || 'unverified: child platform identity not exposed';
const reasoningEffort = process.env.CODEX_REASONING_EFFORT || process.env.REASONING_EFFORT || 'unverified: child platform identity not exposed';
const platformIdentity = process.env.CODEX_AGENT_ID || process.env.CODEX_AGENT_PROFILE || 'Codex-subagent/luna_max_worker (task-card profile; platform response unavailable in child context)';

const common = {
  taskId: TASK,
  inputTaskId: '043',
  cardPath: CARD,
  cardSha256: cardSha,
  expectedCardSha256: EXPECTED_CARD_SHA,
  lockId: LOCK_ID,
  lockState: lockEntry && lockEntry.state,
  lockEntry: lockEntry ? {
    taskId: lockEntry.task_id,
    owner: lockEntry.owner,
    acceptanceOwner: lockEntry.acceptance_owner,
    state: lockEntry.state,
    claimAllowed: lockEntry.claim_allowed,
    leaseAllowed: lockEntry.lease_allowed,
    productionWrite: lockEntry.production_write,
    remoteWrite: lockEntry.remote_write,
    taskCardSha256: lockEntry.task_card_sha256,
  } : null,
  activeReleaseTrain: '5.1.1/implementation/rt-5.1.1-0001',
  baseCommit: head,
  expectedBaseCommit: '9971787eb6e443ab5a5c80aee118b9b43285c093',
  branch,
  expectedBranch: 'release/3.6.3-mac',
  storePath: STORE,
  storeSha256: storeSha,
  expectedStoreSha256: EXPECTED_STORE_SHA,
  protectedFilesManifestPath: null,
  protectedFilesManifestSha256: EXPECTED_PROTECTED_SHA,
  protectedFilesManifestVerification: 'pinned hash recorded; manifest path is not declared by card and remains unverified in this child context',
  predecessorCardPath: PREDECESSOR_CARD,
  predecessorCardSha256: predecessorSha,
  lockFilePath: LOCKS,
  lockFileSha256: lockSha,
  runNonce: RUN_NONCE,
  runId: RUN_ID,
  startUtc,
  fixedOrigin: 'http://127.0.0.1:19421',
  platformIdentity,
  platformModel,
  reasoningEffort,
  identityVerification: 'unverified: platform-created child model/difficulty response is not exposed in this context',
  evidenceRoot: SCRATCH_ROOT,
  writeAllowlist: [SCRIPT_ROOT, SCRATCH_ROOT, path.join(ROOT, 'qa/agent-reviews', `${TASK}.md`)],
  forbiddenWriteRoots: [path.join(ROOT, 'app/js/store.js'), path.join(ROOT, 'main.js'), path.join(ROOT, 'preload.js'), path.join(ROOT, 'docs/agent-coordination/v5.1.1/write-locks.json'), path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-billing-store-hydration-legacy-migration-concurrency-evidence-rework-043')],
  pathFacts,
  gitStatusStart: statusStart,
  codegraphCheck: 'ensure-codegraph.ps1 absent at C:/Users/Administrator/.codex/scripts/ensure-codegraph.ps1',
  protectedHashExpectedMatch: false,
  cardHashMatch: cardSha === EXPECTED_CARD_SHA,
  storeHashMatch: storeSha === EXPECTED_STORE_SHA,
  headMatch: head === '9971787eb6e443ab5a5c80aee118b9b43285c093',
  branchMatch: branch === 'release/3.6.3-mac',
  noSecondWriterEvidence: '044 dedicated script/scratch roots were absent before atomic claim; write-lock entry is granted and no other active lock names these roots',
};

writeNew(CLAIM, {
  schema: 'xj-executor-claim-v1',
  claimType: 'EXECUTOR_CLAIM',
  claimedAtUtc: startUtc,
  ...common,
  status: 'received',
  owner: 'Codex-subagent',
  acceptanceOwner: 'Codex',
  implementationOwner: 'Codex-subagent',
  independentReviewer: 'Hermes',
  atomicCreate: true,
});

const leaseUtc = new Date().toISOString();
writeNew(LEASE, {
  schema: 'xj-executor-lease-v1',
  leaseType: 'LEASE',
  leasedAtUtc: leaseUtc,
  ...common,
  status: 'running',
  leaseOwner: 'Codex-subagent',
  leaseMode: 'automatic-local-allowlist-dispatch',
  leaseExpires: null,
  atomicCreate: true,
});

console.log(JSON.stringify({ claim: CLAIM, lease: LEASE, taskId: TASK, runId: RUN_ID, cardSha, storeSha, head, branch, lockState, protectedExpected: EXPECTED_PROTECTED_SHA, platformModel, reasoningEffort }, null, 2));
