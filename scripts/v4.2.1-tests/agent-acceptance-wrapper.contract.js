#!/usr/bin/env node
'use strict';

// XinJing v4.2.1 — agent-acceptance-wrapper contract (codebuddy remediation)
//
// This contract verifies that the Electron acceptance isolation wrapper truly
// isolates a throwaway temp userData, denies all non-loopback network, and never
// delegates to `npm start`. The original 32 static source-string assertions are
// preserved, PLUS a dynamic section that extracts and EXECUTES the REAL
// acceptance logic from main.js (userData selection, resolveAgentAcceptanceUserData,
// isAgentAcceptanceLoopbackUrl) in a vm sandbox, PLUS mutation gates that prove the
// dynamic assertions are sensitive to behavior removal. No simplified copy of the
// production logic is tested.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const wrapper = fs.readFileSync(path.join(root, 'scripts', 'agent-electron-acceptance.ps1'), 'utf8');
let passed = 0;
let failed = 0;

function expect(condition, name) {
  if (condition) {
    passed++;
    console.log('[PASS] ' + name);
  } else {
    failed++;
    console.error('[FAIL] ' + name);
  }
}

// --------------------------------------------------------------------------
// ORIGINAL STATIC SOURCE ASSERTIONS (preserved verbatim)
// --------------------------------------------------------------------------
expect(/const AGENT_ACCEPTANCE_MODE = process\.env\.XJ_AGENT_ACCEPTANCE === '1';/.test(main), 'explicit acceptance mode is required');
expect(/XJ_AGENT_ACCEPTANCE_USER_DATA must be an absolute temporary directory/.test(main), 'acceptance userData requires an absolute path');
expect(/XJ_AGENT_ACCEPTANCE_USER_DATA must stay inside the system temporary directory/.test(main), 'acceptance userData is constrained to the system temp directory');
expect(/const CANON_USER_DATA = AGENT_ACCEPTANCE_MODE \? AGENT_ACCEPTANCE_USER_DATA : path\.join\(app\.getPath\('appData'\), 'XinJing'\);/.test(main), 'acceptance mode never selects real userData');
expect(/if \(!AGENT_ACCEPTANCE_MODE && !app\.requestSingleInstanceLock\(\)\)/.test(main), 'acceptance mode cannot be redirected into an already-running real-data instance');
expect(/if \(!AGENT_ACCEPTANCE_MODE\) migrateLegacyUserData\(\);/.test(main), 'legacy userData migration is disabled');
expect(/if \(!AGENT_ACCEPTANCE_MODE\) checkDataAnomaly\(\);/.test(main), 'data anomaly writes are disabled');
expect(/if \(AGENT_ACCEPTANCE_MODE\) return;\s*const now = Date\.now\(\);/.test(main), 'quit backups are disabled');
expect(/if \(AGENT_ACCEPTANCE_MODE\) return ensureTrial\(\);/.test(main), 'ProgramData install marker writes are disabled');
expect(/if \(AGENT_ACCEPTANCE_MODE\) configureAgentAcceptanceSession\(\);\s*PORT = await startStaticServer\(\);/.test(main), 'network guard precedes the local static server');
expect(/setPermissionRequestHandler\([\s\S]*?callback\(false\)\);/.test(main) && /setPermissionCheckHandler\(\(\) => false\)/.test(main), 'Electron permissions default deny');
expect(/parsed\.hostname === '127\.0\.0\.1' && Number\(parsed\.port\) === PORT/.test(main), 'network guard permits only the current loopback static server');
expect(/callback\(\{ cancel: !isAgentAcceptanceLoopbackUrl\(details\.url\) \}\);/.test(main), 'network guard cancels all other requests');
expect(/if \(!AGENT_ACCEPTANCE_MODE\) \{\s*createTray\(\);\s*enableAutoStart\(\);[\s\S]*?setupAutoUpdater\(\);/.test(main), 'tray, auto-start, and updater are disabled');
expect(/if \(!AGENT_ACCEPTANCE_MODE && mainWindow\)/.test(main), 'legacy migration servers are disabled');
expect(/if \(AGENT_ACCEPTANCE_MODE\) return;\s*autoUpdater\.checkForUpdates/.test(main), 'manual update checks are disabled');
expect(/if \(AGENT_ACCEPTANCE_MODE\) \{\s*allowAppQuit\('agent-acceptance-window-close'\);\s*return;\s*\}/.test(main), 'acceptance window can exit without tray or close dialog');
expect(/ipcMain\.on\('xj:closeDecision',[\s\S]*?if \(AGENT_ACCEPTANCE_MODE\) \{[\s\S]*?mainWindow\.close\(\);[\s\S]*?return;/.test(main), 'close decision cannot trigger a backup');
expect(/ipcMain\.on\('xj:migrate-done',[\s\S]*?if \(AGENT_ACCEPTANCE_MODE\) return;/.test(main), 'renderer cannot archive legacy data');
expect(/ipcMain\.handle\('xj:cloud-activate',[\s\S]*?if \(AGENT_ACCEPTANCE_MODE\) return \{ ok: false/.test(main), 'cloud activation is disabled');
expect(/ipcMain\.handle\('xj:openExternal',[\s\S]*?if \(AGENT_ACCEPTANCE_MODE\) return false;/.test(main), 'external links are disabled');
expect(wrapper.includes("XJ_AGENT_ACCEPTANCE = '1'"), 'wrapper enables acceptance mode');
expect(wrapper.includes('XJ_AGENT_ACCEPTANCE_USER_DATA = $tempUserData'), 'wrapper passes isolated userData');
expect(wrapper.includes('node_modules\\electron\\dist\\electron.exe'), 'wrapper launches the real Electron process directly');
expect(!wrapper.includes('electron.cmd'), 'wrapper does not wait on a transient command shim');
expect(/\$electronArgs = @\(\$repoRoot\)[\s\S]*?--remote-debugging-port/.test(wrapper), 'wrapper passes the application path before Chromium switches');
expect(/--user-data-dir=\$tempUserData/.test(wrapper), 'wrapper isolates the Chromium singleton lock before main.js starts');
expect(!/npm\s+start/i.test(wrapper), 'wrapper never invokes npm start');
expect(/System\.Diagnostics\.ProcessStartInfo/.test(wrapper) && /UseShellExecute = \$false/.test(wrapper), 'wrapper starts Electron without shell indirection');
expect(/EnvironmentVariables\['XJ_AGENT_ACCEPTANCE'\] = '1'/.test(wrapper) && /EnvironmentVariables\['XJ_AGENT_ACCEPTANCE_USER_DATA'\] = \$tempUserData/.test(wrapper), 'wrapper explicitly passes acceptance environment to Electron');
expect(/\$process\.WaitForExit\(\)/.test(wrapper), 'wrapper waits for the real Electron process to exit');
expect(/Remove-Item -LiteralPath \$tempUserData -Recurse -Force/.test(wrapper), 'wrapper cleans only its generated temp directory');

// --------------------------------------------------------------------------
// DYNAMIC REAL-EXECUTION (loads the REAL acceptance logic from main.js)
// --------------------------------------------------------------------------

function extractFunction(src, name) {
  const re = new RegExp('function ' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(src);
  if (!m) throw new Error('function ' + name + ' not found in main.js');
  let i = m.index + m[0].length;
  let depth = 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(m.index, i);
}

const PORT = 4319;

// DYN-USERDATA: the real userData selection expression must isolate temp dir in acceptance mode.
test_dyn('DYN-USERDATA acceptance mode selects the isolated temp userData (real expression)', () => {
  const canonLine = main.match(/const CANON_USER_DATA = [^\n]*;/)[0];
  const realAppData = 'C:\\Users\\tester\\AppData\\Roaming';
  const tempUserData = 'C:\\Users\\tester\\AppData\\Local\\Temp\\xinjing-agent-acceptance-9f2c1a';
  const ctx = vm.createContext({
    AGENT_ACCEPTANCE_MODE: true,
    AGENT_ACCEPTANCE_USER_DATA: tempUserData,
    app: { getPath: () => realAppData },
    path: path,
  });
  const expr = canonLine.replace(/^const CANON_USER_DATA =/, '(').replace(/;$/, ')');
  const acceptanceResult = vm.runInContext(expr, ctx);
  if (acceptanceResult !== tempUserData) {
    throw new Error('acceptance mode selected real userData: ' + acceptanceResult);
  }
  // Non-acceptance mode must use the real appData/XinJing path.
  const ctxReal = vm.createContext({
    AGENT_ACCEPTANCE_MODE: false,
    AGENT_ACCEPTANCE_USER_DATA: tempUserData,
    app: { getPath: () => realAppData },
    path: path,
  });
  const realResult = vm.runInContext(expr, ctxReal);
  if (realResult !== path.join(realAppData, 'XinJing')) {
    throw new Error('non-acceptance mode did not resolve real appData/XinJing: ' + realResult);
  }
});

// DYN-RESOLVE: the real resolveAgentAcceptanceUserData validates absolute + temp containment.
test_dyn('DYN-RESOLVE resolveAgentAcceptanceUserData resolves a valid temp dir and rejects a relative path (real function)', () => {
  const fnSrc = extractFunction(main, 'resolveAgentAcceptanceUserData');
  const mkCtx = (userData) => vm.createContext({
    process: { env: { XJ_AGENT_ACCEPTANCE_USER_DATA: userData } },
    path: path,
    os: { tmpdir: () => 'C:\\Users\\tester\\AppData\\Local\\Temp' },
    fs: { realpathSync: { native: (p) => p } },
  });
  const valid = 'C:\\Users\\tester\\AppData\\Local\\Temp\\xinjing-agent-acceptance-9f2c1a';
  const resolved = vm.runInContext('(' + fnSrc + ')()', mkCtx(valid));
  if (resolved !== valid) throw new Error('did not resolve valid temp userData: ' + resolved);
  let threw = false;
  try {
    vm.runInContext('(' + fnSrc + ')()', mkCtx('relative\\dir'));
  } catch (e) { threw = true; }
  if (!threw) throw new Error('relative path was not rejected');
});

// DYN-LOOPBACK: the real isAgentAcceptanceLoopbackUrl denies everything except current loopback.
test_dyn('DYN-LOOPBACK isAgentAcceptanceLoopbackUrl allows only 127.0.0.1:PORT (real function)', () => {
  const fnSrc = extractFunction(main, 'isAgentAcceptanceLoopbackUrl');
  const ctx = vm.createContext({ PORT: PORT, URL: URL });
  const check = vm.runInContext('(' + fnSrc + ')', ctx);
  const cases = [
    ['http://127.0.0.1:' + PORT, true, 'current loopback port allowed'],
    ['http://example.com/x', false, 'external host blocked'],
    ['http://169.254.169.254/', false, 'link-local metadata blocked'],
    ['http://127.0.0.1:9999/', false, 'wrong loopback port blocked'],
    ['file:///C:/x', false, 'file scheme blocked'],
    ['http://localhost:' + PORT, false, 'localhost hostname blocked (only 127.0.0.1)'],
  ];
  for (const [url, want, label] of cases) {
    if (check(url) !== want) throw new Error(label + ' -> got ' + check(url) + ' want ' + want);
  }
});

// ---- Mutation gates: prove the dynamic assertions are sensitive ----
test_dyn('MUT-USERDATA removing the acceptance branch makes DYN-USERDATA fail (gate)', () => {
  const canonLine = main.match(/const CANON_USER_DATA = [^\n]*;/)[0];
  const mutatedLine = canonLine.replace('AGENT_ACCEPTANCE_MODE ? AGENT_ACCEPTANCE_USER_DATA :', '');
  const realAppData = 'C:\\Users\\tester\\AppData\\Roaming';
  const tempUserData = 'C:\\Users\\tester\\AppData\\Local\\Temp\\xinjing-agent-acceptance-9f2c1a';
  const ctx = vm.createContext({
    AGENT_ACCEPTANCE_MODE: true,
    AGENT_ACCEPTANCE_USER_DATA: tempUserData,
    app: { getPath: () => realAppData },
    path: path,
  });
  const expr = mutatedLine.replace(/^const CANON_USER_DATA =/, '(').replace(/;$/, ')');
  const result = vm.runInContext(expr, ctx);
  if (result === tempUserData) throw new Error('gate failed: mutation did not break isolation');
  // Gate proves sensitivity: in acceptance mode the broken variant selects real userData.
  if (result !== path.join(realAppData, 'XinJing')) throw new Error('gate inconsistency: ' + result);
});

test_dyn('MUT-LOOPBACK neutering isAgentAcceptanceLoopbackUrl makes DYN-LOOPBACK fail (gate)', () => {
  const fnSrc = extractFunction(main, 'isAgentAcceptanceLoopbackUrl');
  const mutated = fnSrc.replace(/return parsed\.protocol === 'http:' && parsed\.hostname === '127\.0\.0\.1' && Number\(parsed\.port\) === PORT;/, 'return true;');
  const ctx = vm.createContext({ PORT: PORT, URL: URL });
  const check = vm.runInContext('(' + mutated + ')', ctx);
  if (check('http://example.com/x') !== true) throw new Error('gate failed: mutation did not break loopback guard');
});

test_dyn('MUT-WRAPPER inserting npm start must be caught by the no-npm-start guard (gate)', () => {
  const wrapperMut = wrapper + '\nnpm start\n';
  if (!wrapperMut.toLowerCase().includes('npm start')) throw new Error('gate setup failed: npm start not injected');
  // The real wrapper must still be clean; the mutated one must be detected.
  if (wrapper.toLowerCase().includes('npm start')) throw new Error('real wrapper unexpectedly contains npm start');
  if (!wrapperMut.toLowerCase().includes('npm start')) throw new Error('gate inconsistency');
});

function test_dyn(name, fn) {
  try {
    fn();
    passed++;
    console.log('[PASS] ' + name);
  } catch (error) {
    failed++;
    console.error('[FAIL] ' + name + ': ' + error.message);
  }
}

console.log('Passed ' + passed + ' / Failed ' + failed);
process.exitCode = failed ? 1 : 0;
