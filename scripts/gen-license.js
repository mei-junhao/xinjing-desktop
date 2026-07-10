'use strict';
/**
 * gen-license.js — 开发者出码（Freemium 分层，离线激活码）
 *
 * 用法：
 *   node scripts/gen-license.js <identity> [tier]
 *   tier ∈ pro | custom（省略或 'full' = 旧完整版，无 tier 前缀，祖父条款）
 * 例：
 *   node scripts/gen-license.js mei@x.com pro
 *   node scripts/gen-license.js clinic@x.com custom
 *
 * 依赖：secret.generated.js 已生成（scripts/codegen-secret.js），或本机 .license-secret，
 *       或环境变量 LICENSE_SECRET —— 与客户端校验共用同一主密钥。
 */
const path = require('path');
const root = path.resolve(__dirname, '..');
const license = require(path.join(root, 'license-core.js'));

const identity = process.argv[2];
let tier = process.argv[3] || 'pro';
if (!identity) {
  console.error('用法：node scripts/gen-license.js <identity> [pro|custom]');
  process.exit(1);
}
if (!['pro', 'custom', 'full', ''].includes(tier)) {
  console.error('tier 必须为 pro | custom（或省略/full 表示旧完整版）');
  process.exit(1);
}
if (tier === 'full') tier = ''; // 旧完整版不编码前缀

try {
  const code = license.encodeKey(identity, tier);
  console.log('生成激活码 [' + (tier || 'full') + ']：');
  console.log('  ' + code);
  const v = license.verifyKey(code);
  console.log('自检 verify → valid=' + v.valid + ' tier=' + v.tier + ' identity=' + v.identity);
  if (!v.valid || v.tier !== (tier || 'full')) {
    console.error('自检失败：tier 未正确编码');
    process.exit(1);
  }
  console.log('OK');
} catch (e) {
  console.error('出码失败：', e.message);
  process.exit(1);
}
