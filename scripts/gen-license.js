'use strict';

const signer = require('./license-sign-v2');

const subjectId = process.argv[2];
const tier = process.argv[3];
const machineCode = process.argv[4];
const expiresAt = process.argv[5];
const licenseId = process.argv[6] || ('lic_' + require('crypto').randomBytes(12).toString('hex'));

if (!subjectId || !tier || !machineCode || !expiresAt) {
  console.error('用法：node scripts/gen-license.js <sub_xxx> <pro|custom> <machineCode> <expiresAt ISO> [lic_xxx]');
  process.exit(1);
}

try {
  const claim = signer.signLicenseClaim({ licenseId, subjectId, tier, machineCode, expiresAt });
  console.log(signer.encodeActivationCode(claim));
} catch (error) {
  console.error('出码失败：' + error.message);
  process.exit(1);
}
