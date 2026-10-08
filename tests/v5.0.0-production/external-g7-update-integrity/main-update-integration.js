'use strict';
// main-update-integration.js — the SINGLE typed entry end-to-end through the
// real main-update-integration module with injected production-shaped
// adapters (decision 2.1-2.5): feed (COS typed), confirm, artifact, durable
// renderer boundary, health probe hook, portable restart. Asserts committed /
// declined / fail-closed paths and that no second update path exists.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Suite, tmpDir, sha512 } = require('./_testkit');
const integration = require('../../../app/update/main-update-integration');
const { productionEnv, assertBounded } = require('../../../app/update/env-adapter');
const backupCrypto = require('../../../app/js/backup-crypto.js');

const s = new Suite('main-update-integration');
const ROOT = path.resolve(__dirname, '..');

function updaterYaml(version, strategy) {
  const name = (strategy === 'portable' ? 'xinjing-portable-' : 'xinjing-setup-') + version + '.exe';
  const bytes = Buffer.from('fake-bytes-' + version + '-' + strategy);
  const sha = Buffer.from(crypto.createHash('sha512').update(bytes).digest()).toString('base64');
  return ['version: ' + version, 'files:', '  - url: ' + name, '    sha512: ' + sha, '    size: ' + bytes.length, 'releaseDate: 2026-08-07T00:00:00.000Z'].join('\n');
}

function buildOptions(over) {
  const dir = tmpDir('xj463-mi-');
  const feedText = updaterYaml('4.3.0', (over && over.strategy) || 'installer');
  const artifactBytes = Buffer.from('fake-bytes-4.3.0-' + ((over && over.strategy) || 'installer'));
  const rendererHandlers = {};
  // P1-1 regression alignment: production main.js updateIntegrationOptions()
  // now wires a bounded production env for the durable adapters.
  const env = productionEnv(dir, null);
  assertBounded(env);
  const options = {
    userDataDir: dir,
    env,
    appVersion: '4.2.4',
    isPortable: !!(over && over.strategy === 'portable'),
    channel: 'stable',
    strategy: (over && over.strategy) || 'installer',
    backupCrypto,
    backupKey: crypto.randomBytes(32),
    agentAcceptanceMode: false,
    sourceManifestHash: '',
    releaseId: '7',
    fs,
    previousInstallerPath: null,
    confirmDecision: async () => (over && over.decline ? false : true),
    healthCheck: async () => ({ ok: over && over.healthOk === false ? false : true }),
    portableRestart: async () => ({ ok: true }),
    transport: {
      fetchText: () => ({ status: 200, bodyText: feedText }),
      fetchBytes: (url, meta) => ({ bytes: artifactBytes })
    },
    rendererIpc: {
      invoke: (win, channel, request) => {
        if (channel === 'xj:update:snapshot') {
          return Promise.resolve({
            ok: true,
            payload: JSON.stringify({ version: '2.0.0', exportedAt: new Date().toISOString(), clients: [{ id: 'c1', name: '测试', sourceRef: 'free' }], sessions: [], supervisions: [], supervisorIdentities: [], masterConversations: [], expenses: [], materialWorkspaces: [{ id: 'm1', clientId: 'c1', sessionId: '', linkStatus: 'unlinked', updatedAt: new Date().toISOString() }], clinicalActionRuns: [{ id: 'r1', clientId: 'c1', sourceRef: 'clinical:src-1' }], clinicalTasks: [], importQuarantine: [], deletionBatches: [], deletionQuarantine: [] })
          });
        }
        if (channel === 'xj:update:restore') return Promise.resolve({ ok: true, quarantine: [], deletionQuarantine: [] });
        return Promise.resolve({ ok: false, code: 'unknown' });
      }
    },
    rendererDurable: {
      read: async () => {
        const res = await options.rendererIpc.invoke(null, 'xj:update:snapshot', {});
        return JSON.parse(res.payload);
      },
      write: async (payload) => ({ ok: true, quarantine: [], deletionQuarantine: [] })
    }
  };
  return Object.assign(options, over || {});
}

(async () => {
  // 1) committed through the single entry (installer)
  const opts1 = buildOptions({});
  const st1 = await integration.requestUpdateCheck({ channel: 'stable', strategy: 'installer', currentVersion: '4.2.4', options: opts1 });
  s.ok('single entry committed', st1.ok === true && st1.committed === true && st1.state === 'committed' && st1.strategy === 'installer', JSON.stringify(st1));

  // 2) declined -> no download
  const opts2 = buildOptions({ decline: true });
  const st2 = await integration.requestUpdateCheck({ channel: 'stable', strategy: 'installer', currentVersion: '4.2.4', options: opts2 });
  s.ok('declined fails closed', st2.ok === false && /declined/.test(st2.errorCode || ''), JSON.stringify(st2));

  // 3) health fail -> rollback (typed failure, never committed)
  const opts3 = buildOptions({ healthOk: false });
  const st3 = await integration.requestUpdateCheck({ channel: 'stable', strategy: 'installer', currentVersion: '4.2.4', options: opts3 });
  s.ok('health fail never commits', st3.committed !== true && st3.ok === false, JSON.stringify(st3));

  // 4) single-flight: second concurrent check is not a new operation
  const opts4 = buildOptions({});
  const p1 = integration.requestUpdateCheck({ channel: 'stable', strategy: 'installer', currentVersion: '4.2.4', options: opts4 });
  const p2 = integration.requestUpdateCheck({ channel: 'stable', strategy: 'installer', currentVersion: '4.2.4', options: opts4 });
  const [r1, r2] = await Promise.all([p1, p2]);
  s.ok('single-flight preserved', r1.ok === true && (r2.errorCode === 'single-flight' || r2.ok === true), JSON.stringify(r2));

  // 5) default-deny transport: no transport -> fail-closed, never network
  const opts5 = buildOptions({ transport: null });
  const st5 = await integration.requestUpdateCheck({ channel: 'stable', strategy: 'installer', currentVersion: '4.2.4', options: opts5 });
  s.ok('default-deny transport fails closed', st5.ok === false, JSON.stringify(st5));

  // 6) portable strategy through the single entry
  const opts6 = buildOptions({ strategy: 'portable' });
  const st6 = await integration.requestUpdateCheck({ channel: 'stable', strategy: 'portable', currentVersion: '4.2.4', options: opts6 });
  s.ok('portable committed through single entry', st6.ok === true && st6.state === 'committed' && st6.strategy === 'portable', JSON.stringify(st6));

  // 7) acceptance mode guard: never starts an update
  const opts7 = buildOptions({ agentAcceptanceMode: true });
  const st7 = await integration.requestUpdateCheck({ channel: 'stable', strategy: 'installer', currentVersion: '4.2.4', options: opts7 });
  s.ok('acceptance mode guarded', st7.errorCode === 'acceptance-mode' && st7.committed !== true, JSON.stringify(st7));

  // 8) typed IPC registration list is explicit allowlist
  const reg = integration.registerTypedIpc({ handle: (m, h) => m }, buildOptions({}));
  const registered = reg.registered || [];
  s.ok('typed allowlist registered', registered.length === 5 && registered.every((m) => m.startsWith('xj:update:')) && !registered.includes('xj:check-updates'));

  // 9) no network during file lock
  let lockCalled = false;
  const opts9 = buildOptions({ lockHeld: () => { lockCalled = true; return true; } });
  const st9 = await integration.requestUpdateCheck({ channel: 'stable', strategy: 'installer', currentVersion: '4.2.4', options: opts9 });
  s.ok('network denied during file lock', lockCalled === true && st9.ok === false, JSON.stringify(st9));

  console.log('MAIN_INTEGRATION_STATUS=' + (s.fail === 0 ? 'PASS' : 'FAIL'));
  process.exit(s.finish() ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
