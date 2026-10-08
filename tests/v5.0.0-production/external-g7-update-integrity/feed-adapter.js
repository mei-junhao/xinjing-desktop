'use strict';
// feed-adapter.js — typed feed positive + malformed/stale/downgrade/
// cross-channel/cross-strategy/unsafe-path/credential/oversized tests using
// REAL production-shaped electron-updater YAML bytes (decision 2.1).
// fetchTypedFeed is async (await-aware for the real Electron net transport).
const { Suite, sha512 } = require('./_testkit');
const path = require('path');
const adapter = require('../../../app/update/feed-adapter');
const feedValidator = require('../../../app/update/feed-validator');
const { tmpDir } = require('./_testkit');

const s = new Suite('feed-adapter');
const ROOT = require('path').resolve(__dirname, '..');
const backupCrypto = require(path.join(ROOT, '..', '..', 'app', 'js', 'backup-crypto.js'));
const crypto = require('crypto');

function updaterYaml(over = {}) {
  const version = over.version || '4.3.0';
  const strategy = over.strategy || 'installer';
  const name = (strategy === 'portable' ? 'xinjing-portable-' : 'xinjing-setup-') + version + '.exe';
  const bytes = over.bytes || Buffer.from('fake-artifact-bytes-' + version);
  const sha = Buffer.from(crypto.createHash('sha512').update(bytes).digest()).toString('base64');
  return [
    'version: ' + version,
    'files:',
    '  - url: ' + name,
    '    sha512: ' + sha,
    '    size: ' + bytes.length,
    'releaseDate: 2026-08-07T00:00:00.000Z'
  ].join('\n');
}

function transportFor(text) {
  return { fetchText: () => ({ status: 200, bodyText: text }) };
}
const baseOptions = { channel: 'stable', strategy: 'installer', currentVersion: '4.2.4', releaseId: '42', sourceManifestHash: '', transport: transportFor(updaterYaml()) };

(async () => {
  const m1 = await adapter.fetchTypedFeed(baseOptions);
  s.ok('positive typed descriptor', m1.version === '4.3.0' && m1.strategy === 'installer' && m1.channel === 'stable' && /^[0-9A-F]{128}$/.test(m1.sha512) && m1.size > 0 && /^[0-9A-F]{64}$/.test(m1.sourceManifestHash) && m1.feedRevision === '42' && typeof m1.typedText === 'string' && m1.typedText.includes('artifacts:'));

  const m2 = await adapter.fetchTypedFeed(Object.assign({}, baseOptions, { strategy: 'portable', transport: transportFor(updaterYaml({ strategy: 'portable' })) }));
  s.ok('positive portable strategy', m2.strategy === 'portable' && m2.fileName.startsWith('xinjing-portable-'));

  // sourceManifestHash binding: bytes swapped -> rejected
  await s.throwsAsync('sourceManifestHash-mismatch', async () => {
    const text = updaterYaml();
    const hash = crypto.createHash('sha256').update(text, 'utf8').digest('hex').toUpperCase();
    await adapter.fetchTypedFeed(Object.assign({}, baseOptions, { sourceManifestHash: (hash[0] === '0' ? '1' : '0') + hash.slice(1) }));
  });

  // malformed: unknown top-level field (authority-changing) -> rejected
  await s.throwsAsync('unknown-top-level-field:publish', async () => {
    const bad = updaterYaml() + '\npublish:\n  provider: github\n';
    await adapter.fetchTypedFeed(Object.assign({}, baseOptions, { transport: transportFor(bad) }));
  });

  // stale/downgrade: feed version <= current -> frozen validator rejects
  await s.throwsAsync('stale-or-downgrade-version', async () => {
    await adapter.fetchTypedFeed(Object.assign({}, baseOptions, { currentVersion: '4.3.0', transport: transportFor(updaterYaml({ version: '4.3.0' })) }));
  });
  await s.throwsAsync('stale-or-downgrade-version', async () => {
    await adapter.fetchTypedFeed(Object.assign({}, baseOptions, { currentVersion: '4.5.0', transport: transportFor(updaterYaml({ version: '4.3.0' })) }));
  });

  // cross-channel: adapter maps latest.yml -> stable; a 'beta' request is rejected
  await s.throwsAsync('production-channel-unavailable', () => adapter.fetchTypedFeed(Object.assign({}, baseOptions, { channel: 'beta' })));
  await s.throwsAsync('unknown-channel', () => adapter.fetchTypedFeed(Object.assign({}, baseOptions, { channel: 'latest' })));
  await s.throwsAsync('unknown-strategy', () => adapter.fetchTypedFeed(Object.assign({}, baseOptions, { strategy: 'nsis' })));

  // unsafe path: traversal / absolute file name in url -> rejected
  await s.throwsAsync('missing-artifact', async () => {
    const bad = updaterYaml().replace('xinjing-setup-4.3.0.exe', '../../evil.exe');
    await adapter.fetchTypedFeed(Object.assign({}, baseOptions, { transport: transportFor(bad) }));
  });

  // non-COS authority URL (credential-bearing, wrong host) -> rejected
  await s.throwsAsync('non-cos-authority-url', async () => {
    const bad = updaterYaml().replace('xinjing-setup-4.3.0.exe', 'https://user:pass@evil.invalid/xinjing-setup-4.3.0.exe');
    await adapter.fetchTypedFeed(Object.assign({}, baseOptions, { transport: transportFor(bad) }));
  });

  // oversized response -> rejected
  await s.throwsAsync('oversized-response', async () => {
    const big = updaterYaml() + '\n' + 'x'.repeat(70 * 1024);
    await adapter.fetchTypedFeed(Object.assign({}, baseOptions, { transport: transportFor(big) }));
  });

  // malformed YAML / missing files -> rejected
  await s.throwsAsync('malformed-line', () => adapter.fetchTypedFeed(Object.assign({}, baseOptions, { transport: transportFor('version: 4.3.0\n  bad indent\n') })));
  await s.throwsAsync('missing-artifact', () => adapter.fetchTypedFeed(Object.assign({}, baseOptions, { transport: transportFor('version: 4.3.0\nfiles:\n  - url: blockmap\n    sha512: x\n    size: 1\n') })));

  // bad sha512 (base64 wrong length) -> rejected
  await s.throwsAsync('invalid-sha512', async () => {
    const bad = updaterYaml().replace(/sha512: \S+/, 'sha512: AAAA');
    await adapter.fetchTypedFeed(Object.assign({}, baseOptions, { transport: transportFor(bad) }));
  });

  // no transport (default-deny) -> rejected
  await s.throwsAsync('no-transport', () => adapter.fetchTypedFeed(Object.assign({}, baseOptions, { transport: null })));

  // transport error -> download-failed
  await s.throwsAsync('download-failed', () => adapter.fetchTypedFeed(Object.assign({}, baseOptions, { transport: { fetchText: () => ({ error: 'ECONNREFUSED' }) } })));
  await s.throwsAsync('http-500', () => adapter.fetchTypedFeed(Object.assign({}, baseOptions, { transport: { fetchText: () => ({ status: 500, bodyText: '' }) } })));

  // frozen validator remains authoritative on the typed text
  const m3 = await adapter.fetchTypedFeed(baseOptions);
  const meta = feedValidator.validateFeed({ currentVersion: '4.2.4', channel: 'stable', feedText: m3.typedText, fetchAdapter: () => ({ status: 200, bodyText: m3.typedText }) });
  s.ok('frozen validator validates typed text', meta.sha512 === m3.sha512 && meta.fileName === m3.fileName);

  console.log('FEED_ADAPTER_STATUS=' + (s.fail === 0 ? 'PASS' : 'FAIL'));
  process.exit(s.finish() ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
