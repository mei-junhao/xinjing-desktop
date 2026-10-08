'use strict';
/**
 * legacy-write-dom-fixtures.js — XJ-4.2.2 OpenSquilla DOM integration sidecar fixtures (REWORK 02).
 * Synthetic-only data for CDP-based legacy write DOM integration tests.
 * Not referenced by production code.
 *
 * REWORK 02 changes:
 * - Mutations target Store internals ONLY for observation; the ACTION is always a real DOM entry.
 * - suppressToast mutation is a KILLED mutation (must be detected as survived, NOT pass).
 * - No direct Store API calls counted as handler evidence.
 */
module.exports = (function () {
  return {
    // Synthetic client for seeding (via CDP evaluate, not counted as handler evidence)
    client: {
      id: 'c_cdp_01', name: 'CDP合成来访者', status: 'active',
      billing: { feePerSession: 300, billingMode: 'per-session' },
      tags: ['synthetic', 'cdp'], createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T00:00:00.000Z'
    },

    // B5: Synthetic __XJ_API__ to inject into index.html page context.
    // selectClinicalMaterialFile returns a fake file selection (no disk access).
    // parseClinicalMaterialFile returns synthetic parsed text.
    syntheticXjApi: [
      '(function(){',
      '  var syntheticApi = {',
      '    selectClinicalMaterialFile: function(){',
      '      return Promise.resolve({ok:true, selectionId:"sel_syn_01", file:{name:"synthetic-notes.txt", path:"synthetic", size:1024}});',
      '    },',
      '    parseClinicalMaterialFile: function(sid){',
      '      return Promise.resolve({ok:true, file:{name:"synthetic-notes.txt", path:"synthetic", size:1024}, text:"This is synthetic parsed text content for CDP testing."});',
      '    }',
      '  };',
      '  try { Object.defineProperty(window, "__XJ_API__", { value: syntheticApi, writable: true, configurable: true }); } catch(e)',
      '  { try { window.__XJ_API__ = syntheticApi; } catch(e2) {} }',
      '  window.__xjB5ApiInjected = true;',
      '})()'
    ].join('\n'),

    // B5 mutation: make Store.createMaterialWorkspace return null (simulating limit reached)
    b5NullMaterial: '(function(){Store.__origCreateMaterialWorkspace = Store.createMaterialWorkspace; Store.createMaterialWorkspace = function(d){Store.__cdpMutation="b5NullMaterial"; return null};})()',
    // B5 restore
    b5Restore: '(function(){if(Store.__origCreateMaterialWorkspace){Store.createMaterialWorkspace = Store.__origCreateMaterialWorkspace; delete Store.__origCreateMaterialWorkspace;} delete Store.__cdpMutation;})()',

    // M4/M5: Make saveMasterConversationDurable return {ok:false} (failing durable)
    failingDurable: '(function(){Store.__origSaveMasterConv = Store.saveMasterConversationDurable; Store.saveMasterConversationDurable = function(c){Store.__cdpMutation="failingDurable"; return Promise.resolve({ok:false, value:null, error:{code:"XJ_TEST_FAIL", message:"Synthetic durable failure"}})};})()',
    // M4 mutation: remove await (wrap in .then to simulate non-awaited)
    removeAwait: '(function(){var s = Store.saveMasterConversationDurable; Store.saveMasterConversationDurable = function(c){var p = s.call(Store, c); p.then(function(){}); Store.__cdpMutation="removeAwait"; return p};})()',
    // M4 restore
    m4Restore: '(function(){if(Store.__origSaveMasterConv){Store.saveMasterConversationDurable = Store.__origSaveMasterConv; delete Store.__origSaveMasterConv;} delete Store.__cdpMutation;})()',

    // M5: Toast spy — records all toasts into window.__cdpToasts
    toastSpy: '(function(){window.__cdpToasts=[];var orig=App.showToast;App.showToast=function(msg,kind){window.__cdpToasts.push({msg:msg,kind:kind,t:Date.now()});if(orig) return orig.call(App,msg,kind)}})()',
    // M5: Suppress failure toast — THIS IS A MUTATION THAT MUST BE KILLED
    suppressToast: '(function(){var orig=App.showToast;App.showToast=function(msg,kind){if(kind==="error"&&msg.indexOf("对话保存失败")>=0){window.__cdpToastSuppressed=true;return}return orig.call(App,msg,kind)}})()',
    // M5 restore toast
    m5RestoreToast: '(function(){delete window.__cdpToasts; delete window.__cdpToastSuppressed;})()',

    // M6: Make saveSessionsDurable return {ok:false}
    failingSessionsDurable: '(function(){Store.__origSaveSessions = Store.saveSessionsDurable; Store.saveSessionsDurable = function(s){Store.__cdpMutation="failingSessionsDurable"; return Promise.resolve({ok:false, value:null, error:{code:"XJ_TEST_FAIL", message:"Synthetic sessions durable failure"}})};})()',
    // M6 mutation: fake success (return ok:true without actually saving)
    fakeSuccess: '(function(){Store.__origSaveSessions = Store.saveSessionsDurable; Store.saveSessionsDurable = function(s){Store.__cdpMutation="fakeSuccess"; return Promise.resolve({ok:true, value:s, version:"fake"})};})()',
    // M6 restore
    m6Restore: '(function(){if(Store.__origSaveSessions){Store.saveSessionsDurable = Store.__origSaveSessions; delete Store.__origSaveSessions;} delete Store.__cdpMutation;})()',
  };
})();
