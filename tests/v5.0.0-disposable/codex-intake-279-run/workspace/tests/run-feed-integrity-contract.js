'use strict';

const { assert, path, CANDIDATE, artifact, metadata, expectCode } = require('./_helpers');
const feed = require(path.join(CANDIDATE, 'update', 'feed-validator'));

(async () => {
  let passed = 0;
  for (const channel of ['nsis', 'portable']) {
    const item = artifact(channel, '5.0.0');
    const name = channel === 'nsis' ? 'latest.yml' : 'latest-portable.yml';
    const valid = feed.validateMetadata(metadata(channel, '5.0.0', item), { channel, metadataName: name, currentVersion: '4.5.0' });
    assert.deepStrictEqual(feed.verifyArtifact(valid, item.bytes).sha512, item.sha512);
    passed += 2;
    const otherName = channel === 'nsis' ? 'latest-portable.yml' : 'latest.yml';
    await expectCode(() => feed.validateMetadata(metadata(channel, '5.0.0', item), { channel, metadataName: otherName, currentVersion: '4.5.0' }), 'channel-mismatch'); passed += 1;
    const invalids = [
      { url: '../escape.exe', path: '../escape.exe' },
      { url: 'C:\\escape.exe', path: 'C:\\escape.exe' },
      { url: '\\\\server\\share.exe', path: '\\\\server\\share.exe' },
      { url: 'https://evil.invalid/a.exe', path: 'https://evil.invalid/a.exe' },
      { fileSha: 'not-base64', rootSha: 'not-base64' },
      { size: 0 }, { size: 'NaN' }, { version: '4.4.9' }, { version: '' }, { channel: 'unknown' },
      { rootSha: Buffer.alloc(64, 1).toString('base64') }, { path: item.name + '.other' },
    ];
    for (const overrides of invalids) {
      const expectedCode = overrides.channel === 'unknown' || String(overrides.path || '').endsWith('.other') ? 'channel-mismatch' : 'metadata-invalid';
      await expectCode(() => feed.validateMetadata(metadata(channel, overrides.version || '5.0.0', item, overrides), { channel, metadataName: name, currentVersion: '4.5.0' }), expectedCode);
      passed += 1;
    }
    await expectCode(() => feed.verifyArtifact(valid, Buffer.concat([item.bytes, Buffer.from('x')])), 'artifact-mismatch'); passed += 1;
    const changed = Buffer.from(item.bytes); changed[0] ^= 1;
    await expectCode(() => feed.verifyArtifact(valid, changed), 'artifact-mismatch'); passed += 1;
  }
  await expectCode(() => feed.parseMetadata('x'.repeat(feed.MAX_METADATA_BYTES + 1)), 'metadata-invalid'); passed += 1;
  await expectCode(() => feed.parseMetadata('version: 5.0.0\nversion: 5.0.1\n'), 'metadata-invalid'); passed += 1;
  console.log(JSON.stringify({ suite: 'feed-integrity-contract', passed, failed: 0 }));
})().catch((error) => { console.error(error.stack || error); process.exit(1); });
