// bump-version.js - bump package.json version per new version policy:
//   XJ_BUMP_KIND=patch  (default) → increment patch (2.0.0 → 2.0.1)
//   XJ_BUMP_KIND=minor            → increment minor + reset patch (2.0.0 → 2.1.0)
//   XJ_BUMP_KIND=major            → increment major + reset minor/patch (2.0.0 → 3.0.0)
//   XJ_NO_BUMP=1                  → keep current version (e.g. fixed pin per user)
//
// Version policy (established 2026-07-13):
//   bug fix              → +0.0.1
//   new feature          → +0.1.0
//   large-scope overhaul / milestone → +1.0.0
//
// Run from project root: node scripts/bump-version.js
// Keeps PowerShell free of fragile inline `node -e "..."` quoting.
const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '..', 'package.json');
const j = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const current = j.version;

if (process.env.XJ_NO_BUMP) {
  console.log('XJ_NO_BUMP set -> keeping current version ' + current);
  process.exit(0);
}

const kind = (process.env.XJ_BUMP_KIND || 'patch').toLowerCase();
const v = current.split('.').map((n) => +n);
if (v.length !== 3) throw new Error('invalid version: ' + current);

if (kind === 'major') {
  v[0] += 1; v[1] = 0; v[2] = 0;
} else if (kind === 'minor') {
  v[1] += 1; v[2] = 0;
} else {
  v[2] += 1;
}

const nextVersion = v.join('.');
j.version = nextVersion;
fs.writeFileSync(pkgPath, JSON.stringify(j, null, 2) + '\n');
console.log(`bumped version -> ${current} to ${nextVersion} (kind=${kind})`);
