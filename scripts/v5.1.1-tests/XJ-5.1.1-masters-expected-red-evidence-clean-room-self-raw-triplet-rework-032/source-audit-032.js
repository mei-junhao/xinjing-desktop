'use strict';
// source-audit-032：path self-check + 规则载荷完整性（独立于 runner）
const fs = require('fs'); const path = require('path');
const RULES_P = 'D:/xinjing-electron/scripts/v5.1.1-tests/XJ-5.1.1-masters-expected-red-evidence-clean-room-self-raw-triplet-rework-032/fixtures/masters-expected-red-rules.json';
const errs = [];
if (!fs.existsSync(RULES_P)) { console.log('SOURCE_AUDIT: FAIL rules missing'); process.exit(2); }
const rules = JSON.parse(fs.readFileSync(RULES_P, 'utf8'));
if (rules.er_ids.length !== 8) errs.push('er count');
if (rules.mutation_rules.length !== 9) errs.push('mut count');
if (rules.stages.join(',') !== 'baseline,mutated,restored') errs.push('stages');
// 路径自检：runner 源码不得含规则载荷内联
const rp = 'D:/xinjing-electron/scripts/v5.1.1-tests/XJ-5.1.1-masters-expected-red-evidence-clean-room-self-raw-triplet-rework-032/runner-032.js';
const rc = fs.readFileSync(rp, 'utf8');
for (const ER of rules.er_ids) { if (rc.indexOf(ER) >= 0) errs.push('rule inline in runner: ' + ER); }
console.log('SOURCE_AUDIT_032:', errs.length === 0 ? 'PASS' : 'FAIL ' + errs.join('|'));
process.exit(errs.length ? 2 : 0);