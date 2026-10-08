#!/usr/bin/env node
'use strict';

const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');

const userData = path.resolve(String(process.env.XJ_HYDRATION_USER_DATA || ''));
const port = Number(process.env.XJ_HYDRATION_PORT || 0);
const mode = String(process.env.XJ_HYDRATION_MODE || 'hydrate');
const pagePath = String(process.env.XJ_HYDRATION_PAGE || '/fixture.html');
const origin = `http://127.0.0.1:${port}`;

if (!userData || !path.isAbsolute(userData) || !port) {
  console.error('XJ_HYDRATION_USER_DATA and XJ_HYDRATION_PORT are required');
  process.exitCode = 2;
} else {
  try { fs.mkdirSync(userData, { recursive: true }); } catch (error) {
    console.error('userData mkdir failed:', error && error.message || error);
    process.exitCode = 2;
  }
}

function logError(label, error) {
  console.error(`[worker:${mode}] ${label}:`, error && error.stack || error);
}

function denyExternalRequests() {
  const allowedPrefix = origin + '/';
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    const allowed = typeof details.url === 'string' && details.url.startsWith(allowedPrefix);
    callback({ cancel: !allowed });
  });
}

function evaluate(win, expression) {
  return win.webContents.executeJavaScript(expression, true);
}

function actionExpression() {
  const synthetic = {
    clientId: 'c-xj021-synthetic',
    sessionId: 's-xj021-synthetic',
    paymentId: 'mp-xj021-synthetic',
  };
  const encoded = JSON.stringify(synthetic);
  if (mode === 'write') {
    return `(async()=>{const seed=${encoded};await Store.hydrate();const clientResult=await Store.createClientDurable({id:seed.clientId,name:'XJ021 synthetic client',status:'active',billing:{monthlyPayments:[{id:seed.paymentId,month:'2026-08',amount:123.45,status:'paid'}]}});const sessionResult=await Store.createSessionDurable({id:seed.sessionId,clientId:seed.clientId,date:'2026-08-26',summary:'XJ021 synthetic session',fee:123.45});const rawClients=await Store._get('clients');const rawSessions=await Store._get('sessions');return {ok:clientResult&&clientResult.ok===true&&sessionResult&&sessionResult.ok===true,clientResult,sessionResult,rawClientCount:Array.isArray(rawClients)?rawClients.length:-1,rawSessionCount:Array.isArray(rawSessions)?rawSessions.length:-1,clients:Store.getClients(),sessions:Store.getSessions(),monthlyPayments:Store.getClients()[0]&&Store.getClients()[0].billing&&Store.getClients()[0].billing.monthlyPayments||[]};})()`;
  }
  if (mode === 'hydrate') {
    return `(async()=>{await Store.hydrate();const rawClients=await Store._get('clients');const rawSessions=await Store._get('sessions');const clients=Store.getClients();const sessions=Store.getSessions();return {ok:Store.isHydrated()===true,hydrated:Store.isHydrated(),clientCount:clients.length,sessionCount:sessions.length,rawClientCount:Array.isArray(rawClients)?rawClients.length:-1,rawSessionCount:Array.isArray(rawSessions)?rawSessions.length:-1,clientIds:clients.map(c=>c.id),sessionIds:sessions.map(s=>s.id),monthlyPayments:clients[0]&&clients[0].billing&&clients[0].billing.monthlyPayments||[]};})()`;
  }
  if (mode === 'roundtrip') {
    return `(async()=>{const seed=${encoded};await Store.hydrate();const before=Store.getClients().length;const r=await Store.createClientDurable({id:seed.clientId,name:'roundtrip',billing:{monthlyPayments:[{id:seed.paymentId,amount:9}]}});await Store.hydrate();return {ok:r&&r.ok===true&&Store.isHydrated()===true&&Store.getClient(seed.clientId)!==null,before,after:Store.getClients().length,client:Store.getClient(seed.clientId),hydrated:Store.isHydrated()};})()`;
  }
  if (mode === 'duplicate-hydrate') {
    return `(async()=>{const results=await Promise.all([Store.hydrate(),Store.hydrate(),Store.hydrate()]);return {ok:Store.isHydrated()===true,results,clientCount:Store.getClients().length,sessionCount:Store.getSessions().length};})()`;
  }
  if (mode === 'legacy') {
    return `(async()=>{localStorage.setItem('xj_clients',JSON.stringify([{id:'c-xj021-legacy',name:'legacy synthetic',status:'active'}]));localStorage.setItem('xj_sessions',JSON.stringify([{id:'s-xj021-legacy',clientId:'c-xj021-legacy',date:'2026-08-26',summary:'legacy synthetic'}]));await Store.hydrate();const raw=await Store._get('clients');return {ok:Store.getClient('c-xj021-legacy')!==null&&Array.isArray(raw),client:Store.getClient('c-xj021-legacy'),legacyClientKey:localStorage.getItem('xj_clients'),rawClientCount:Array.isArray(raw)?raw.length:-1};})()`;
  }
  if (mode === 'seed-bad') {
    return `(async()=>{await Store._put('clients',{not:'an array',marker:'xj021-bad'});await Store._put('sessions',{not:'an array'});return {ok:true,rawClients:await Store._get('clients'),rawSessions:await Store._get('sessions')};})()`;
  }
  if (mode === 'bad-value-hydrate') {
    return `(async()=>{await Store.hydrate();const raw=await Store._get('clients');return {ok:Store.getClients().length===0&&Store.getSessions().length===0&&raw&&raw.marker==='xj021-bad',clientCount:Store.getClients().length,sessionCount:Store.getSessions().length,rawClients:raw};})()`;
  }
  if (mode === 'fallback-read') {
    return `(async()=>{localStorage.setItem('xj2_clients',JSON.stringify([{id:'c-xj021-fallback',name:'fallback synthetic',status:'active'}]));const original=indexedDB.open.bind(indexedDB);indexedDB.open=function(){const request={result:null,error:new Error('synthetic open failure'),onsuccess:null,onerror:null,onupgradeneeded:null};setTimeout(()=>{if(typeof request.onerror==='function')request.onerror({target:request});},0);return request;};await Store.hydrate();indexedDB.open=original;return {ok:Store.getClient('c-xj021-fallback')!==null,clientCount:Store.getClients().length,client:Store.getClient('c-xj021-fallback'),backend:Store.storageInfo().backend};})()`;
  }
  if (mode === 'fail-closed-write') {
    return `(async()=>{const original=indexedDB.open.bind(indexedDB);indexedDB.open=function(){const request={result:null,error:new Error('synthetic durable open failure'),onsuccess:null,onerror:null,onupgradeneeded:null};setTimeout(()=>{if(typeof request.onerror==='function')request.onerror({target:request});},0);return request;};const r=await Store.createClientDurable({id:'c-xj021-fail',name:'must not cache'});indexedDB.open=original;return {ok:r&&r.ok===false&&Store.getClient('c-xj021-fail')===null,result:r,clientCount:Store.getClients().length};})()`;
  }
  if (mode === 'read-error') {
    return `(async()=>{await Store.hydrate();await Store._get('clients');const proto=window.IDBObjectStore&&window.IDBObjectStore.prototype;if(!proto||typeof proto.get!=='function')return {ok:false,errorPropagated:false,reason:'IDBObjectStore prototype unavailable'};const original=proto.get;proto.get=function(){const request={result:undefined,error:new Error('synthetic read failure'),onsuccess:null,onerror:null};setTimeout(()=>{if(typeof request.onerror==='function')request.onerror({target:request});},0);return request;};let errorPropagated=false;let value;try{value=await Store._get('clients');}catch(error){errorPropagated=true;}proto.get=original;return {ok:errorPropagated,errorPropagated,value};})()`;
  }
  throw new Error(`unknown hydration mode: ${mode}`);
}

async function run() {
  await app.whenReady();
  app.setPath('userData', userData);
  denyExternalRequests();
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.webContents.on('console-message', (_event, _level, message) => console.error(`[renderer:${mode}] ${message}`));
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[worker:${mode}] did-fail-load ${errorCode} ${errorDescription} ${validatedURL}`);
  });
  await win.loadURL(origin + pagePath);
  const result = await evaluate(win, actionExpression());
  console.log('XJ_HYDRATION_RESULT:' + JSON.stringify(result));
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    win.once('closed', finish);
    setTimeout(finish, 1500);
    try { win.close(); } catch (_) { finish(); }
  });
  app.quit();
}

if (process.exitCode !== 2) {
  run().catch((error) => {
    logError('fatal', error);
    try { app.quit(); } catch (_) {}
    process.exitCode = 1;
  });
}
