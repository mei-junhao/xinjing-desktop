'use strict';
// 053 count-vs-manifest reconciliation (closes 052 verifier gap: duplicate/extra member on disk not detected)
const fs = require('fs');
const path = require('path');
const CAND = process.argv[2];
const man = JSON.parse(fs.readFileSync(path.join(CAND, 'manifest.json'), 'utf8'));
const declared = new Set(man.entries.map(e => e.candidate_path_rel.replace(/^files\//, '').split('/').join(path.sep)));
const declaredFwd = new Set(man.entries.map(e => e.candidate_path_rel));
let disk = 0;
const extra = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e);
    if (fs.statSync(p).isDirectory()) walk(p);
    else {
      const rel = path.relative(path.join(CAND, 'files'), p);
      disk += 1;
      if (!declared.has(rel) && !declaredFwd.has(rel.split(path.sep).join('/'))) extra.push(rel);
    }
  }
};
walk(path.join(CAND, 'files'));
if (disk !== man.entries.length || extra.length) {
  console.log(JSON.stringify({ verdict: 'FAIL', error: 'count-vs-manifest mismatch', disk: disk, declared: man.entries.length, extra: extra }));
  process.exit(1);
}
console.log(JSON.stringify({ verdict: 'PASS', disk: disk, declared: man.entries.length }));