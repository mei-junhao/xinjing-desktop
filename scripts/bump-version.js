// bump-version.js - bump patch version of package.json unless XJ_NO_BUMP is set.
// Run from project root: node scripts/bump-version.js
// Keeps PowerShell free of fragile inline `node -e "..."` quoting.
const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '..', 'package.json');
const j = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const current = j.version;

if (process.env.XJ_NO_BUMP) {
  console.log('XJ_NO_BUMP set -> keeping current version ' + current);
} else {
  const v = current.split('.');
  v[2] = String((+v[2]) + 1);
  j.version = v.join('.');
  fs.writeFileSync(pkgPath, JSON.stringify(j, null, 2) + '\n');
  console.log('bumped version -> ' + current + ' to ' + j.version);
}
