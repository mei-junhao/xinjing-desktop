'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), 'xj355-' + prefix + '-')); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex').toUpperCase(); }
function sha512(value) { return crypto.createHash('sha512').update(value).digest('hex').toUpperCase(); }
function artifactFor(bytes, fileName) { return { fileName, bytes: Buffer.from(bytes) }; }
function feedFor({ version = '1.2.0', channel = 'stable', artifactVersion = version, artifactChannel = channel, fileName = 'xinjing-setup-1.2.0.exe', bytes = Buffer.from('artifact'), size = bytes.length, artifactSha512 = sha512(bytes), url = `https://updates.example.invalid/${fileName}` }) {
  return [
    `version: ${version}`,
    `channel: ${channel}`,
    'artifacts:',
    `- channel: ${artifactChannel}`,
    `- version: ${artifactVersion}`,
    `- fileName: ${fileName}`,
    `- size: ${size}`,
    `- sha512: ${artifactSha512}`,
    `- url: ${url}`
  ].join('\n');
}
class Suite {
  constructor(name) { this.name = name; this.pass = 0; this.fail = 0; }
  ok(name, condition, detail = '') { if (condition) { this.pass += 1; console.log('[PASS]', name); } else { this.fail += 1; console.log('[FAIL]', name, detail); } }
  throws(code, fn, name = code) { let got = ''; try { fn(); } catch (error) { got = error.code || error.message; } this.ok(name, got === code, `expected=${code} got=${got}`); }
  async throwsAsync(code, fn, name = code) { let got = ''; try { await fn(); } catch (error) { got = error.code || error.message; } this.ok(name, got === code, `expected=${code} got=${got}`); }
  finish() { console.log(`RESULT: ${this.pass} passed / ${this.fail} failed`); return this.fail === 0; }
}
module.exports = { tmpDir, sha256, sha512, artifactFor, feedFor, Suite };
