'use strict';
/**
 * account-auth-adversarial.js — Better Auth + SQLite 认证底座反向变异测试。
 * 对 account-auth.js / account-auth-routes.js / auth-sqlite.js / resend-email-adapter.js
 * 注入变异并验证 probe 可判定差异（KILLED）。每变异独立复制到项目 scratch 下临时目录运行，
 * 使 better-auth 的 ESM 依赖能沿 node_modules 向上解析。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const ROOT = path.resolve(__dirname, '..');
const SCRATCH = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.0.2-account-auth-better-auth-sqlite-integration-014');
const AUTH = path.join(ROOT, 'server/account-auth.js');
const ROUTES = path.join(ROOT, 'server/account-auth-routes.js');
const EMAIL = path.join(ROOT, 'server/email-adapter.js');
const RESEND = path.join(ROOT, 'server/resend-email-adapter.js');
const SQLITE = path.join(ROOT, 'server/auth-sqlite.js');
const BA_CONFIG = path.join(ROOT, 'server/better-auth-config.js');
const BA_ADAPTER = path.join(ROOT, 'server/better-auth-adapter.js');
const j = (a) => a.join('\n');

const M = [
  { id: 'M1-token-leak', file: 'routes', find: j(['        // 响应剔除 token', '        return json(res, 200, { ok: true, accountId: committed.accountId, email: committed.email });']), replace: j(['        // 响应剔除 token', '        return json(res, 200, { ok: true, accountId: committed.accountId, email: committed.email, verificationToken: staged.verificationToken });']), probe: 'token-leak' },
  { id: 'M2-membership-forgery', file: 'auth', find: j(['  getMembership(sessionToken) {', '    const s = this.validateSession(sessionToken);', '    if (!s.ok) return { ok: false, error: s.error };']), replace: j(['  getMembership(accountId) {', '    const s = { ok: true, accountId: String(accountId || \"\"), tier: this._tierOf(String(accountId || \"\")), serverAuthoritative: true };', '    return s;', '    if (!s.ok) return { ok: false, error: s.error };']), probe: 'membership-unknown' },
  { id: 'M3-resend-invalidation', file: 'auth', find: j(['      this._revokeVerificationsFor(e, this._verifications());', '      this.store.insert(\'verification\', { id: key, identifier: e, value: key, expiresAt: expiresIso, createdAt: nowIso, updatedAt: nowIso });']), replace: j(['      this.store.insert(\'verification\', { id: key, identifier: e, value: key, expiresAt: expiresIso, createdAt: nowIso, updatedAt: nowIso });']), probe: 'resend-old-token' },
  { id: 'M4-corrupt-store', file: 'sqlite', find: 'if (/not a database|SQLITE_NOTADB/i.test(msg)) { const err = new Error(\'account-store-corrupt\'); err.cause = e; throw err; }', replace: 'if (/not a database|SQLITE_NOTADB/i.test(msg)) { return; }', probe: 'corrupt-store' },
  { id: 'M5-body-size', file: 'routes', find: 'if (data.length > MAX_BODY)', replace: 'if (false)', probe: 'body-size' },
  { id: 'M6-provider-timeout', file: 'resend', find: "      if (e && e.name === 'AbortError') return { ok: false, error: { code: 'provider-timeout' } };", replace: "      if (false) return { ok: false, error: { code: 'provider-timeout' } };", probe: 'provider-timeout' },
  { id: 'M7-disabled-reject', file: 'auth', find: j(['    if (account.disabled) return { ok: false, error: { code: \'account-disabled\' } };', '    if (!account.emailVerified) return { ok: false, error: { code: \'account-unverified\' } };']), replace: j(['    if (account.emailVerified === \'never\') return { ok: false, error: { code: \'account-disabled\' } };', '    if (!account.emailVerified) return { ok: false, error: { code: \'account-unverified\' } };']), probe: 'disabled-reject' },
  { id: 'M8-unknown-tier', file: 'auth', find: "    if (!VALID_TIERS.includes(tier)) return { ok: false, error: { code: 'unknown-tier' } };", replace: "    // if (!VALID_TIERS.includes(tier)) return;", probe: 'unknown-tier' },
  { id: 'M9-disable-route', file: 'routes', find: "      if (url === '/account/membership') {", replace: "      if (url === '/account/disable') {\n        const r = auth.disable(b.email);\n        return json(res, r.ok ? 200 : 400, r);\n      }\n      if (url === '/account/membership') {", probe: 'disable-route' },
  { id: 'M10-failed-mailer', file: 'routes', find: 'if (!delivery || delivery.ok !== true) {', replace: 'if (false) {', probe: 'failed-mailer' },
  { id: 'M11-thrown-mailer', file: 'routes', find: 'catch (e) { delivery = null; }', replace: 'catch (e) { delivery = { ok: true }; }', probe: 'thrown-mailer' },
  { id: 'M15-swallow-persist', file: 'sqlite', find: '_checkWrite() { if (this._failWrites) { const e = new Error(\'persistence-failed\'); e.code = \'persistence-failed\'; throw e; } }', replace: '_checkWrite() { return; }', probe: 'register-swallow' },
  { id: 'M20-error-token-leak', file: 'routes', find: j(['        if (!delivery || delivery.ok !== true) {', '          return json(res, 503, { ok: false, error: { code: \'email-delivery-failed\' } });', '        }']), replace: j(['        if (!delivery || delivery.ok !== true) {', '          return json(res, 503, { ok: false, error: { code: \'email-delivery-failed\' }, verificationToken: staged.verificationToken });', '        }']), probe: 'error-token-leak' },
  { id: 'M21-failed-mailer-durable', file: 'routes', find: j(['        if (!delivery || delivery.ok !== true) {', '          return json(res, 503, { ok: false, error: { code: \'email-delivery-failed\' } });', '        }']), replace: j(['        if (!delivery || delivery.ok !== true) {', '          try { auth.commitRegistration(staged); } catch (e) {}', '          return json(res, 503, { ok: false, error: { code: \'email-delivery-failed\' } });', '        }']), probe: 'failed-mailer-durable' },
    { id: 'M16-revoke-skipped', file: 'auth', find: "    if (rec) this.store.remove('session', rec.id);", replace: "    if (false) this.store.remove('session', rec.id);", probe: 'revoke' },



    { id: 'M22-skip-token-digest', file: 'sqlite', find: "      if (model === 'session' && row && typeof row.token === 'string') {", replace: "      if (false) {", probe: 'skip-token-digest' },



    { id: 'M23-bypass-query-normalization', file: 'auth', find: "    const rec = this._sessions().find((s) => s.token === key);", replace: "    const rec = this._sessions().find((s) => s.token === token);", probe: 'bypass-query-normalization' },



    { id: 'M24-retain-raw-session', file: 'sqlite', find: "          this.db.prepare('UPDATE session SET token = ? WHERE id = ?')", replace: "          if (false) this.db.prepare('UPDATE session SET token = ? WHERE id = ?')", probe: 'retain-raw-session' },



    { id: 'M25-fake-audit-hash-fields', file: 'auth', find: "    const sessionDigestOk = sessions.every((s) => isSessionTokenDigest(s.token));", replace: "    const sessionDigestOk = true;", probe: 'fake-audit-hash-fields' },


];

function tmp() { fs.mkdirSync(SCRATCH, { recursive: true }); return fs.mkdtempSync(path.join(SCRATCH, 'mut-')); }
function copySupport(t) {
  fs.copyFileSync(AUTH, path.join(t, 'account-auth.js'));
  fs.copyFileSync(EMAIL, path.join(t, 'email-adapter.js'));
  fs.copyFileSync(ROUTES, path.join(t, 'account-auth-routes.js'));
  fs.copyFileSync(RESEND, path.join(t, 'resend-email-adapter.js'));
  fs.copyFileSync(SQLITE, path.join(t, 'auth-sqlite.js'));
  fs.copyFileSync(BA_CONFIG, path.join(t, 'better-auth-config.js'));
  fs.copyFileSync(BA_ADAPTER, path.join(t, 'better-auth-adapter.js'));
}

function script(kind, modulePath, routesPath) {
  const head = 'const fs=require("fs"),os=require("os"),path=require("path"); const out={};';
  const df = 'fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),"xa-"))+"/a.sqlite"';
  if (kind === 'token-leak') return head+'const{createServer}=require('+JSON.stringify(routesPath)+');(async()=>{const s=createServer({dataFile:'+df+'});const p=await s.listen();const r=await fetch("http://127.0.0.1:"+p+"/account/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:"m@x.com",password:"Password123"})});const b=await r.json();out.leaked=("verificationToken" in b);s.server.close();console.log(JSON.stringify(out));})().catch(e=>console.log(JSON.stringify({err:String(e)})));';
  if (kind === 'membership-unknown') return head+'const{AccountAuth}=require('+JSON.stringify(modulePath)+');const a=new AccountAuth({dataFile:'+df+'});out.result=a.getMembership("unknown");console.log(JSON.stringify(out));';
  if (kind === 'resend-old-token') return head+'const{AccountAuth}=require('+JSON.stringify(modulePath)+');const a=new AccountAuth({dataFile:'+df+'});const r=a.register({email:"m@x.com",password:"Password123"});const t1=r.verificationToken;const rr=a.resendVerification("m@x.com");a.commitResend("m@x.com");out.oldValid=a.verify(t1).ok;out.newValid=a.verify(rr.verificationToken).ok;console.log(JSON.stringify(out));';
  if (kind === 'corrupt-store') return head+'const f='+df+';fs.writeFileSync(f,"NOT JSON {{");let threw=false;try{const{AccountAuth}=require('+JSON.stringify(modulePath)+');new AccountAuth({dataFile:f});}catch(e){threw=true;}out.threw=threw;console.log(JSON.stringify(out));';
  if (kind === 'body-size') return head+'const{createServer}=require('+JSON.stringify(routesPath)+');(async()=>{const s=createServer({dataFile:'+df+'});const p=await s.listen();const r=await fetch("http://127.0.0.1:"+p+"/account/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:"m@x.com",password:"x".repeat(70000)})});out.status=r.status;s.server.close();console.log(JSON.stringify(out));})().catch(e=>console.log(JSON.stringify({err:String(e)})));';
  if (kind === 'provider-timeout') return head+'const{ResendEmailAdapter}=require('+JSON.stringify(modulePath)+');(async()=>{const a=new ResendEmailAdapter({apiKey:"k",from:"f",timeoutMs:40,fetch:(u,o)=>new Promise((_,rej)=>{o.signal.addEventListener("abort",()=>rej(new DOMException("Aborted","AbortError")));})});out.result=await a.sendVerificationEmail({to:"a@b.com",token:"x"});console.log(JSON.stringify(out));})().catch(e=>console.log(JSON.stringify({err:String(e)})));';
  if (kind === 'disabled-reject') return head+'const{AccountAuth}=require('+JSON.stringify(modulePath)+');(async()=>{const a=new AccountAuth({dataFile:'+df+'});const r=a.register({email:"m@x.com",password:"Password123"});a.verify(r.verificationToken);const l=await a.login({email:"m@x.com",password:"Password123"});a.setDisabled("m@x.com",true);out.result=a.validateSession(l.sessionToken);console.log(JSON.stringify(out));})().catch(e=>console.log(JSON.stringify({err:String(e)})));';
  if (kind === 'unknown-tier') return head+'const{AccountAuth}=require('+JSON.stringify(modulePath)+');(async()=>{const a=new AccountAuth({dataFile:'+df+'});const r=a.register({email:"m@x.com",password:"Password123"});a.verify(r.verificationToken);const l=await a.login({email:"m@x.com",password:"Password123"});a._setMembershipRaw(r.accountId,"admin");out.result=a.validateSession(l.sessionToken);console.log(JSON.stringify(out));})().catch(e=>console.log(JSON.stringify({err:String(e)})));';
  if (kind === 'disable-route') return head+'const{createServer}=require('+JSON.stringify(routesPath)+');(async()=>{const s=createServer({dataFile:'+df+'});const p=await s.listen();const b="http://127.0.0.1:"+p;const post=(u,o)=>fetch(b+u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(o)});await post("/account/register",{email:"m@x.com",password:"Password123"});const m=s.mailer.drain();await post("/account/verify",{token:m[0].verificationToken});await post("/account/login",{email:"m@x.com",password:"Password123"});const d=await post("/account/disable",{email:"m@x.com"});const l2=await post("/account/login",{email:"m@x.com",password:"Password123"});const lj=await l2.json();out.disableStatus=d.status;out.loginOk=(lj&&lj.ok);s.server.close();console.log(JSON.stringify(out));})().catch(e=>console.log(JSON.stringify({err:String(e)})));';
  if (kind === 'failed-mailer') return head+'const{createServer}=require('+JSON.stringify(routesPath)+');(async()=>{const fm={async sendVerificationEmail(){return{ok:false,error:{code:"x"}};}};const s=createServer({dataFile:'+df+',mailer:fm});const p=await s.listen();const r=await fetch("http://127.0.0.1:"+p+"/account/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:"m@x.com",password:"Password123"})});out.status=r.status;s.server.close();console.log(JSON.stringify(out));})().catch(e=>console.log(JSON.stringify({err:String(e)})));';
  if (kind === 'thrown-mailer') return head+'const{createServer}=require('+JSON.stringify(routesPath)+');(async()=>{const fm={async sendVerificationEmail(){throw new Error("boom");}};const s=createServer({dataFile:'+df+',mailer:fm});const p=await s.listen();const r=await fetch("http://127.0.0.1:"+p+"/account/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:"m@x.com",password:"Password123"})});out.status=r.status;s.server.close();console.log(JSON.stringify(out));})().catch(e=>console.log(JSON.stringify({err:String(e)})));';
  if (kind === 'register-swallow') return head+'const{createServer}=require('+JSON.stringify(routesPath)+');(async()=>{const m={async sendVerificationEmail(){return{ok:true};}};const s=createServer({dataFile:'+df+',mailer:m});const p=await s.listen();s.auth.setSaveFail(true);const r=await fetch("http://127.0.0.1:"+p+"/account/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:"m@x.com",password:"Password123"})});out.status=r.status;s.server.close();console.log(JSON.stringify(out));})().catch(e=>console.log(JSON.stringify({err:String(e)})));';
  if (kind === 'error-token-leak') return head+'const{createServer}=require('+JSON.stringify(routesPath)+');(async()=>{const fm={async sendVerificationEmail(){return{ok:false,error:{code:"x"}};}};const s=createServer({dataFile:'+df+',mailer:fm});const p=await s.listen();const r=await fetch("http://127.0.0.1:"+p+"/account/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:"m@x.com",password:"Password123"})});const b=await r.json();out.leaked=("verificationToken" in (b||{}));s.server.close();console.log(JSON.stringify(out));})().catch(e=>console.log(JSON.stringify({err:String(e)})));';
  if (kind === 'failed-mailer-durable') return head+'const{createServer}=require('+JSON.stringify(routesPath)+');(async()=>{const f='+df+';const fm={async sendVerificationEmail(){return{ok:false,error:{code:"x"}};}};const s=createServer({dataFile:f,mailer:fm});const p=await s.listen();const r=await fetch("http://127.0.0.1:"+p+"/account/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:"m@x.com",password:"Password123"})});out.status=r.status;s.server.close();const{AccountAuth}=require('+JSON.stringify(modulePath)+');const reload=new AccountAuth({dataFile:f});out.reloadCount=reload._audit().accountCount;console.log(JSON.stringify(out));})().catch(e=>console.log(JSON.stringify({err:String(e)})));';
  if (kind === 'revoke') return head+'const{AccountAuth}=require('+JSON.stringify(modulePath)+');(async()=>{const a=new AccountAuth({dataFile:'+df+'});const r=a.register({email:"m@x.com",password:"Password123"});a.verify(r.verificationToken);const l=await a.login({email:"m@x.com",password:"Password123"});a.revokeSession(l.sessionToken);out.validateAfter=a.validateSession(l.sessionToken).ok;console.log(JSON.stringify(out));})().catch(e=>console.log(JSON.stringify({err:String(e)})));';




    if (kind === 'skip-token-digest') return head+'const{AccountAuth}=require('+JSON.stringify(modulePath)+');(async()=>{const a=new AccountAuth({dataFile:'+df+'});const r=a.register({email:"m@x.com",password:"Password123"});a.verify(r.verificationToken);const l=await a.login({email:"m@x.com",password:"Password123"});const s=a._sessions()[0]||{};out.rawAtRest=(s.token===l.sessionToken);out.tokenSample=String(s.token||"").slice(0,10);console.log(JSON.stringify(out));})().catch(e=>console.log(JSON.stringify({err:String(e)})));';

    if (kind === 'bypass-query-normalization') return head+'const{AccountAuth}=require('+JSON.stringify(modulePath)+');(async()=>{const a=new AccountAuth({dataFile:'+df+'});const r=a.register({email:"m@x.com",password:"Password123"});a.verify(r.verificationToken);const l=await a.login({email:"m@x.com",password:"Password123"});out.validateOk=a.validateSession(l.sessionToken).ok;console.log(JSON.stringify(out));})().catch(e=>console.log(JSON.stringify({err:String(e)})));';

    if (kind === 'retain-raw-session') return 'const fs=require("fs"),os=require("os"),path=require("path");const{DatabaseSync}=require("node:sqlite");const out={};const f=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),"xa-"))+"/a.sqlite";const raw="LegacyRawSessionToken_1234567890";const db=new DatabaseSync(f);db.exec("CREATE TABLE session (id TEXT PRIMARY KEY,userId TEXT,token TEXT,expiresAt TEXT,ipAddress TEXT,userAgent TEXT,createdAt TEXT,updatedAt TEXT,_json TEXT)");db.prepare("INSERT INTO session (id,userId,token,expiresAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?)").run("s1","u1",raw,new Date(Date.now()+3600000).toISOString(),new Date().toISOString(),new Date().toISOString());db.close();try{const{AccountAuth}=require('+JSON.stringify(modulePath)+');const a=new AccountAuth({dataFile:f});out.token=a._sessions()[0].token;out.rawRetained=(out.token===raw);}catch(e){out.err=String(e)}console.log(JSON.stringify(out));';

    if (kind === 'fake-audit-hash-fields') return head+'const{AccountAuth}=require('+JSON.stringify(modulePath)+');(async()=>{const a=new AccountAuth({dataFile:'+df+'});const r=a.register({email:"m@x.com",password:"Password123"});a.verify(r.verificationToken);const l=await a.login({email:"m@x.com",password:"Password123"});a.store.db.prepare("UPDATE session SET token = ?").run(l.sessionToken);out.audit=a._audit().sessionTokensHashedAtRest;console.log(JSON.stringify(out));})().catch(e=>console.log(JSON.stringify({err:String(e)})));';

  return '';
}

function judge(kind, before, after) {
  if (!before || !after) return false;
  if (kind === 'token-leak') return before.leaked===false && after.leaked===true;
  if (kind === 'membership-unknown') return before.result&&before.result.ok===false && after.result&&after.result.ok===true;
  if (kind === 'resend-old-token') return before.oldValid===false&&before.newValid===true && after.oldValid===true;
  if (kind === 'corrupt-store') return before.threw===true && after.threw===false;
  if (kind === 'body-size') return before.status===413 && after.status!==413;
  if (kind === 'provider-timeout') return before.result&&before.result.error&&before.result.error.code==='provider-timeout' && after.result&&after.result.error&&after.result.error.code!=='provider-timeout';
  if (kind === 'disabled-reject') return before.result&&before.result.ok===false && after.result&&after.result.ok===true;
  if (kind === 'unknown-tier') return before.result&&before.result.ok===false && after.result&&after.result.ok===true;
  if (kind === 'disable-route') return (before.disableStatus!==200&&before.loginOk===true) && (after.disableStatus===200&&after.loginOk===false);
  if (kind === 'failed-mailer') return before.status===503 && after.status===200;
  if (kind === 'thrown-mailer') return before.status===503 && after.status===200;
  if (kind === 'register-swallow') return before.status===503 && after.status===200;
  if (kind === 'error-token-leak') return before.leaked===false && after.leaked===true;
  if (kind === 'failed-mailer-durable') return before.status===503&&before.reloadCount===0 && after.status===503&&after.reloadCount===1;
  if (kind === 'revoke') return before.validateAfter===false && after.validateAfter===true;
    if (kind === 'skip-token-digest') return before.rawAtRest===false && after.rawAtRest===true;

    if (kind === 'bypass-query-normalization') return before.validateOk===true && after.validateOk===false;

    if (kind === 'retain-raw-session') return before.rawRetained===false && after.rawRetained===true;

    if (kind === 'fake-audit-hash-fields') return before.audit===false && after.audit===true;

  return false;
}

function run(kind, modulePath, routesPath) {
  const t = tmp();
  fs.writeFileSync(path.join(t, 'probe.js'), script(kind, modulePath, routesPath));
  const r = cp.spawnSync(process.execPath, [path.join(t, 'probe.js')], { encoding: 'utf8', timeout: 30000 });
  let out = null; try { out = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch (e) {}
  fs.rmSync(t, { recursive: true, force: true });
  return out;
}

const results = []; let killed = 0;
const SOURCE_FILES = [AUTH, ROUTES, EMAIL, RESEND, SQLITE, BA_CONFIG, BA_ADAPTER];
const sourceShaBefore = {}; for (const f of SOURCE_FILES) sourceShaBefore[f] = sha256(fs.readFileSync(f));
for (const m of M) {
  const t0 = tmp(); copySupport(t0);
  const origModule = (m.file === 'auth' || m.file === 'sqlite') ? path.join(t0, 'account-auth.js') : m.file === 'resend' ? path.join(t0, 'resend-email-adapter.js') : AUTH;
  const before = run(m.probe, origModule, path.join(t0, 'account-auth-routes.js'));
  fs.rmSync(t0, { recursive: true, force: true });

  const t1 = tmp(); copySupport(t1);
  const name = m.file === 'auth' ? 'account-auth.js' : m.file === 'routes' ? 'account-auth-routes.js' : m.file === 'resend' ? 'resend-email-adapter.js' : 'auth-sqlite.js';
  const srcPath = m.file === 'auth' ? AUTH : m.file === 'routes' ? ROUTES : m.file === 'resend' ? RESEND : SQLITE;
  const src = fs.readFileSync(srcPath, 'utf8');
  const inputSha = sha256(src);
  if (!src.includes(m.find)) { results.push({ id: m.id, ok: false, detail: 'marker missing' }); console.log('SURVIVOR ' + m.id + ' (marker missing)'); console.log('EVIDENCE ' + JSON.stringify({ id: m.id, target: m.file, input_sha: inputSha, replace_hit: false })); fs.rmSync(t1, { recursive: true, force: true }); continue; }
  const mutated = src.replace(m.find, m.replace);
  fs.writeFileSync(path.join(t1, name), mutated);
  const mutatedSha = sha256(mutated);
  const mutModule = (m.file === 'auth' || m.file === 'sqlite') ? path.join(t1, 'account-auth.js') : m.file === 'resend' ? path.join(t1, 'resend-email-adapter.js') : AUTH;
  const after = run(m.probe, mutModule, path.join(t1, 'account-auth-routes.js'));
  fs.rmSync(t1, { recursive: true, force: true });

  const ok = judge(m.probe, before, after);
  results.push({ id: m.id, ok, detail: 'orig=' + JSON.stringify(before) + ' mut=' + JSON.stringify(after) });
  console.log((ok ? 'KILLED ' : 'SURVIVOR ') + m.id + ' - orig=' + JSON.stringify(before) + ' mut=' + JSON.stringify(after));
  console.log('EVIDENCE ' + JSON.stringify({ id: m.id, target: m.file, probe: m.probe, replace_hit: true, replacement_changed: mutated !== src, input_sha: inputSha, mutated_sha: mutatedSha, verdict: ok ? 'KILLED' : 'SURVIVOR' }));
  if (ok) killed += 1;
}
const sourceShaAfter = {}; for (const f of SOURCE_FILES) sourceShaAfter[f] = sha256(fs.readFileSync(f));
console.log('SOURCE_INTEGRITY ' + JSON.stringify({ unchanged: JSON.stringify(sourceShaBefore) === JSON.stringify(sourceShaAfter), before: sourceShaBefore, after: sourceShaAfter }));
const survivors = results.filter((r) => !r.ok);
console.log('ADVERSARIAL PASSED ' + killed + ' FAILED ' + survivors.length + ' / ' + results.length);
if (survivors.length) process.exit(2);
console.log('ADVERSARIAL_OK');
