'use strict';

const { assert, crypto, fs, os, path, CANDIDATE } = require('./_helpers');
const { spawnSync } = require('child_process');

const node = process.execPath;
const target = path.join(__dirname, 'mutation-target.js');
const updateRoot = path.join(CANDIDATE, 'update');
const mutations = [
  { id: 1, file: 'feed-validator.js', from: "if (opts.metadataName !== CHANNELS[channel].metadata) throw updateError('channel-mismatch');", to: "if (false) throw updateError('channel-mismatch');" },
  { id: 2, file: 'feed-validator.js', from: "if (digest !== metadata.sha512) throw updateError('artifact-mismatch');", to: "if (false) throw updateError('artifact-mismatch');" },
  { id: 3, file: 'feed-validator.js', from: "if (value.includes('..') || value.includes('/') || value.includes('\\\\') || path.isAbsolute(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || /^\\\\\\\\/.test(value)) {\n    throw updateError('metadata-invalid');\n  }\n  if (!CHANNELS[channel].artifact.test(value)) throw updateError('channel-mismatch');", to: "if (false) { throw updateError('metadata-invalid'); }\n  if (false) throw updateError('channel-mismatch');" },
  { id: 4, file: 'feed-validator.js', from: "if (typeof opts.currentVersion !== 'string' || compareVersions(version, opts.currentVersion) <= 0) throw updateError('metadata-invalid');", to: "if (false) throw updateError('metadata-invalid');" },
  { id: 5, file: 'coordinator.js', from: "if (confirmed !== true) return stableResult(false, 'confirmation', record, null);", to: "if (false) return stableResult(false, 'confirmation', record, null);" },
  { id: 6, file: 'coordinator.js', from: "try { bytes = await deps.downloadArtifact(metadata); } catch (_) { return fail(record, 'download-failed'); }", to: "try { bytes = await deps.downloadArtifact(metadata); } catch (_) { bytes = Buffer.alloc(metadata.size); }" },
  { id: 7, file: 'coordinator.js', from: 'snapshot = await safety.createVerifiedSnapshot', to: 'snapshot = safety.createVerifiedSnapshot' },
  { id: 8, file: 'coordinator.js', from: 'metadata.sha512 !== input.expectedArtifactSha512', to: 'false' },
  { id: 9, file: 'coordinator.js', from: "} catch (_) { return fail(record, 'backup-failed'); }", to: "} catch (_) { snapshot = { snapshot: { data: {} }, payloadHash: '0'.repeat(64) }; }" },
  { id: 10, file: 'coordinator.js', from: 'await safety.migrateWithProtection(deps.snapshotAdapter, snapshot,', to: 'await deps.snapshotAdapter.replaceStableData({},' },
  { id: 11, file: 'coordinator.js', from: "if (healthy !== true) return fail(record, 'health-check-failed');", to: "if (false) return fail(record, 'health-check-failed');" },
  { id: 12, file: 'coordinator.js', from: "if (input.channel === 'nsis') await strategies.runNsis", to: "if (input.channel === 'portable') await strategies.runNsis" },
  { id: 13, file: 'strategies.js', from: 'if (!rollback || rollback.version !== context.currentVersion)', to: 'if (false)' },
  { id: 14, file: 'transaction-journal.js', from: "!SAFE_SHA512.test(input.artifactSha512)", to: 'false' },
  { id: 15, file: 'transaction-journal.js', from: "if (existing.state === 'committed' && candidate.state !== 'committed') return existing;", to: "if (false) return existing;" },
  { id: 16, file: 'transaction-journal.js', from: "if (Object.keys(input).some((key) => !ALLOWED_KEYS.has(key))) throw journalError('journal-sensitive-or-unknown-field');", to: 'if (false) throw journalError(\'journal-sensitive-or-unknown-field\');' },
  { id: 17, file: 'coordinator.js', from: "const { validateMetadata, verifyArtifact } = require('./feed-validator');", to: "require('https').get('https://example.invalid'); const { validateMetadata, verifyArtifact } = require('./feed-validator');" },
  { id: 18, file: 'coordinator.js', from: 'metadata = validateMetadata(response.body,', to: 'metadata = { version: input.targetVersion, channel: input.channel, sha512: input.expectedArtifactSha512, artifact: \'mini-handler.exe\', size: 1 }; void validateMetadata(response.body,' },
  { id: 19, file: 'coordinator.js', from: 'await safety.migrateWithProtection(deps.snapshotAdapter, snapshot,', to: 'await deps.snapshotAdapter.replaceStableData({},' },
  { id: 20, file: 'coordinator.js', from: "return stableResult(false, 'rollback', failed, 'rollback-failed');", to: "return stableResult(true, 'commit', failed, null);" },
];

function copyCandidate(destination) {
  fs.mkdirSync(path.join(destination, 'update'), { recursive: true });
  for (const name of fs.readdirSync(updateRoot)) fs.copyFileSync(path.join(updateRoot, name), path.join(destination, 'update', name));
}

const baseline = spawnSync(node, [target], { env: Object.assign({}, process.env, { XJ279_CANDIDATE_ROOT: CANDIDATE }), encoding: 'utf8', timeout: 30000 });
assert.strictEqual(baseline.status, 0, `baseline failed: ${baseline.stderr}`);
const results = [];
for (const mutation of mutations) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `xj279-mutation-${mutation.id}-`));
  copyCandidate(root);
  const file = path.join(root, 'update', mutation.file);
  const before = fs.readFileSync(file, 'utf8');
  assert(before.includes(mutation.from), `mutation ${mutation.id} anchor missing`);
  const beforeHash = crypto.createHash('sha256').update(before).digest('hex');
  const after = before.replace(mutation.from, mutation.to);
  fs.writeFileSync(file, after, 'utf8');
  const afterHash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.notStrictEqual(afterHash, beforeHash, `mutation ${mutation.id} bytes unchanged`);
  const run = spawnSync(node, [target], { env: Object.assign({}, process.env, { XJ279_CANDIDATE_ROOT: root }), encoding: 'utf8', timeout: 30000 });
  assert.notStrictEqual(run.status, 0, `mutation ${mutation.id} survived\nstdout=${run.stdout}\nstderr=${run.stderr}`);
  results.push({ id: mutation.id, file: mutation.file, beforeHash, afterHash, exitCode: run.status, signal: run.signal || null, result: 'KILLED' });
}
assert.strictEqual(results.length, 20);
console.log(JSON.stringify({ suite: 'mutation-probes', baselineExit: baseline.status, killed: 20, survived: 0, blocked: 0, results }));
