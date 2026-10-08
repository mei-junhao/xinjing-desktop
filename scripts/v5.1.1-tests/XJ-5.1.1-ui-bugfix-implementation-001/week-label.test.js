'use strict';
// 511-001#1: 周标签格式聚焦测试（M.D - M.D）
function weekLabel(wsM, wsD, weM, weD) { return (wsM + 1) + '.' + wsD + ' - ' + (weM + 1) + '.' + weD; }
const cases = [
  { wsM: 0, wsD: 5, weM: 0, weD: 11, expect: '1.5 - 1.11' },
  { wsM: 8, wsD: 1, weM: 8, weD: 7, expect: '9.1 - 9.7' },
  { wsM: 10, wsD: 30, weM: 11, weD: 6, expect: '11.30 - 12.6' },
  { wsM: 11, wsD: 28, weM: 0, weD: 3, expect: '12.28 - 1.3' }
];
let pass = 0;
for (const c of cases) {
  const got = weekLabel(c.wsM, c.wsD, c.weM, c.weD);
  const ok = got === c.expect;
  console.log(ok ? 'PASS' : 'FAIL', JSON.stringify(c.expect), '->', JSON.stringify(got));
  if (ok) pass++;
}
console.log('WEEK_LABEL ' + pass + '/' + cases.length + ' PASS');
process.exit(pass === cases.length ? 0 : 1);