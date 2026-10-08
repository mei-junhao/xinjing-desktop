'use strict';

const fs = require('fs');
const path = require('path');
const {
  SCRIPT_DIR,
  FIXTURE_PATH,
  parseArgs,
  loadFixture,
  digest,
  writeJson,
  exactKeys
} = require('./common-033');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

function listSourceFiles() {
  return fs.readdirSync(SCRIPT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => path.join(SCRIPT_DIR, entry.name))
    .sort();
}

function scanSources(fixture, sources) {
  const findings = [];
  for (const filePath of sources) {
    const source = fs.readFileSync(filePath, 'utf8');
    const hits = [];
    for (const token of fixture.sourceAudit.forbiddenSourceTokens) {
      if (source.includes(token)) hits.push({ type: 'inline-rule-token', token });
    }
    for (const fragment of fixture.sourceAudit.forbiddenLegacyFragments) {
      if (source.includes(fragment)) hits.push({ type: 'legacy-fragment', fragment });
    }
    const info = digest(filePath);
    findings.push({ path: filePath, sha256: info.sha256, bytes: info.bytes, hits });
  }
  return findings;
}

const args = parseArgs(process.argv);

if (args['self-probe']) {
  try {
    const fixture = loadFixture(FIXTURE_PATH);
    const findings = scanSources(fixture, listSourceFiles());
    const hitCount = findings.reduce((sum, entry) => sum + entry.hits.length, 0);
    if (hitCount !== 0) throw new Error('source isolation self-probe found forbidden source content');
    process.stdout.write(`${JSON.stringify({ ok: true, script: 'source-audit', sourceCount: findings.length, hitCount })}\n`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
} else {
  try {
    const fixturePath = path.resolve(String(args.fixture || FIXTURE_PATH));
    const outputPath = args.output ? path.resolve(String(args.output)) : null;
    const fixture = loadFixture(fixturePath);
    const sourcePaths = args['sources-json'] ? JSON.parse(String(args['sources-json'])) : listSourceFiles();
    if (!Array.isArray(sourcePaths) || sourcePaths.length === 0 || sourcePaths.some((entry) => typeof entry !== 'string')) throw new Error('source list is invalid');
    const findings = scanSources(fixture, sourcePaths.map((entry) => path.resolve(entry)));
    const hitCount = findings.reduce((sum, entry) => sum + entry.hits.length, 0);
    const report = {
      schemaVersion: 'source-audit-033-v1',
      fixtureId: fixture.fixtureId,
      sourceCount: findings.length,
      findings,
      hitCount,
      ok: hitCount === 0,
      checkedUtc: new Date().toISOString()
    };
    if (!exactKeys(report, ['schemaVersion', 'fixtureId', 'sourceCount', 'findings', 'hitCount', 'ok', 'checkedUtc'])) throw new Error('source audit report shape is invalid');
    if (outputPath) writeJson(outputPath, report);
    process.stdout.write(`${JSON.stringify({ ok: report.ok, outputPath, sourceCount: findings.length, hitCount })}\n`);
    if (!report.ok) process.exitCode = 3;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
