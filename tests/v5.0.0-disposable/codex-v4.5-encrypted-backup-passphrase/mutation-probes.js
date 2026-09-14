'use strict';

// This harness is intentionally expected-red until backup-crypto.js exists.
// After implementation it must execute behavioral mutations in temporary copies,
// not source-string assertions against the healthy module.
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const ROOT = path.resolve(__dirname, '../../../');
const SOURCE = path.join(ROOT, 'app/js/backup-crypto.js');
const RUNNER = path.join(__dirname, 'run-contract.js');

if (!fs.existsSync(SOURCE)) {
  console.error('MUTATION_RESULT=EXPECTED_RED missing backup-crypto.js');
  process.exitCode = 1;
} else {
  const source = fs.readFileSync(SOURCE, 'utf8');
  const mutations = [
    ['M1_SKIP_AAD', 'cipher.setAAD(aad);', '/* M1 removed setAAD */'],
    ['M2_SKIP_AUTH_TAG', 'decipher.setAuthTag(parsed.authTag);', '/* M2 removed setAuthTag */'],
    ['M3_SKIP_PAYLOAD_HASH', "if (payloadHash(plaintext) !== parsed.pkg.payloadSha256) throw backupError('XJ_BACKUP_PAYLOAD_HASH_MISMATCH');", '/* M3 removed payload hash check */'],
    ['M4_ACCEPT_SHORT_PASSPHRASE', "if (length < PASSPHRASE_MIN_LENGTH || length > PASSPHRASE_MAX_LENGTH || !String(passphrase).trim()) {", "if (length > PASSPHRASE_MAX_LENGTH || !String(passphrase).trim()) {"],
    ['M5_EXPORT_API_KEY', 'if (SENSITIVE_SETTING_KEYS.has(key)) return;', 'if (false) return;']
  ];
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-backup-mut-'));
  let failures = 0;
  try {
    for (const [id, needle, replacement] of mutations) {
      if (!source.includes(needle)) {
        console.error(id + '=HARNESS_ERROR anchor missing');
        failures++;
        continue;
      }
      const mutant = source.replace(needle, replacement);
      const mutantPath = path.join(tempRoot, id + '.js');
      fs.writeFileSync(mutantPath, mutant, 'utf8');
      const probe = "const m=require(" + JSON.stringify(mutantPath) + ");" +
        "(async()=>{" +
        "const p=JSON.stringify({version:'2.0.0',clients:[],sessions:[]});" +
        "const pass='synthetic recovery phrase 2026';" +
        "const x=await m.encryptPayload(p,pass,{kind:'user-export'});" +
        "if(" + JSON.stringify(id) + "==='M3_SKIP_PAYLOAD_HASH'){const o=JSON.parse(x);o.payloadSha256='0'.repeat(64);let rejected=false;try{await m.decryptPayload(JSON.stringify(o),pass);}catch(e){rejected=true;}if(!rejected)throw new Error('payload hash mutant survived');}" +
        "else if(" + JSON.stringify(id) + "==='M4_ACCEPT_SHORT_PASSPHRASE'){let rejected=false;try{await m.encryptPayload(p,'short',{kind:'user-export'});}catch(e){rejected=true;}if(!rejected)throw new Error('short passphrase mutant survived');}" +
        "else if(" + JSON.stringify(id) + "==='M5_EXPORT_API_KEY'){const s=m.sanitizeExportPayload({version:'2.0.0',settings:{apiConfig:{apiKey:'secret'}}});if(s.settings.apiConfig.apiKey!==undefined)throw new Error('api key mutant survived');}" +
        "else {await m.decryptPayload(x,pass);const o=JSON.parse(x);o.createdAt='2026-08-01T00:00:01.000Z';o.aad.createdAt=o.createdAt;let rejected=false;try{await m.decryptPayload(JSON.stringify(o),pass);}catch(e){rejected=true;}if(!rejected)throw new Error('authentication mutant survived');}" +
        "})().then(()=>process.exit(0)).catch(()=>process.exit(1));";
      const result = childProcess.spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', timeout: 30000 });
      if (result.status === 0) {
        console.error(id + '=SURVIVED');
        failures++;
      } else {
        console.log(id + '=KILLED');
      }
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  if (failures) {
    console.error('MUTATION_RESULT=FAIL failures=' + failures);
    process.exitCode = 1;
  } else {
    console.log('MUTATION_RESULT=PASS killed=' + mutations.length + '/' + mutations.length);
  }
}
