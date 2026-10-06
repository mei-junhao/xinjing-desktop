(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./clinical-agent-runtime.js'));
  else root.ClinicalAgentProductionBridge = factory(root.ClinicalAgentRuntime);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Runtime) {
  'use strict';
  if (!Runtime || typeof Runtime.withDependencies !== 'function' || typeof Runtime.fromGlobals !== 'function') throw new Error('clinical-agent-runtime dependency required');
  function surface(runtime) {
    if (!runtime || typeof runtime.prepare !== 'function' || typeof runtime.confirm !== 'function' || typeof runtime.execute !== 'function' || typeof runtime.cancel !== 'function' || typeof runtime.project !== 'function' || typeof runtime.isRuntimeState !== 'function') throw new Error('production runtime required');
    return Object.freeze({ prepareContext: typeof runtime.prepareContext === 'function' ? runtime.prepareContext : undefined, prepare: runtime.prepare, confirm: runtime.confirm, execute: runtime.execute, cancel: runtime.cancel, project: runtime.project, isRuntimeState: runtime.isRuntimeState });
  }
  function withDependencies(deps) {
    deps = deps || {};
    return surface(deps.runtime || Runtime.withDependencies(deps));
  }
  function fromGlobals(options) {
    options = options || {};
    var runtimeApi = options.Runtime || options.ClinicalAgentRuntime || Runtime;
    if (!runtimeApi || typeof runtimeApi.fromGlobals !== 'function') throw new Error('clinical-agent-runtime dependency required');
    return surface(runtimeApi.fromGlobals(options));
  }
  return Object.freeze({ withDependencies: withDependencies, fromGlobals: fromGlobals });
}));
