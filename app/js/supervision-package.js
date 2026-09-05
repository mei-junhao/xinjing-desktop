/*
 * Renderer-side facade for controlled supervision packages.
 * Package bytes are passed to the isolated main-process bridge for inspection;
 * this module never parses, decrypts, stores, or renders package resources.
 */
(function (root) {
  'use strict';

  var MAX_BYTES = 32 * 1024 * 1024;
  var bridge = root && root.__XJ_API__ && root.__XJ_API__.supervisionSkill;

  function unavailable() {
    return Promise.resolve({ ok: false, errorCode: 'bridge-unavailable', message: '受控督导包服务暂不可用' });
  }

  function readFile(file) {
    if (!file || typeof file.arrayBuffer !== 'function') return Promise.reject(new Error('package-file-required'));
    if (Number(file.size || 0) <= 0 || Number(file.size || 0) > MAX_BYTES) return Promise.reject(new Error('package-too-large'));
    return file.arrayBuffer().then(function (array) {
      return { bytes: new Uint8Array(array), fileName: String(file.name || '') };
    });
  }

  function inspectFile(file) {
    if (!bridge || typeof bridge.inspectPackage !== 'function') return unavailable();
    return readFile(file).then(function (payload) {
      return bridge.inspectPackage(payload.bytes, payload.fileName).then(function (result) {
        return Object.assign({}, result || {}, { __packageBytes: payload.bytes, __packageFileName: payload.fileName });
      });
    }).catch(function (error) {
      return { ok: false, errorCode: error && error.message ? error.message : 'package-read-failed', message: '技能包文件读取失败' };
    });
  }

  function installInspection(inspection) {
    if (!bridge || typeof bridge.installPackage !== 'function') return unavailable();
    if (!inspection || !inspection.__packageBytes || !inspection.inspectionToken) return Promise.resolve({ ok: false, errorCode: 'inspection-required', message: '请先完成技能包检查' });
    return bridge.installPackage(inspection.__packageBytes, inspection.inspectionToken, true);
  }

  var api = Object.freeze({
    inspectFile: inspectFile,
    installInspection: installInspection,
    listInstalled: function () { return bridge && bridge.listInstalled ? bridge.listInstalled() : unavailable(); },
    getRuntimeDescriptor: function (packageId, packageVersion) { return bridge && bridge.getRuntimeDescriptor ? bridge.getRuntimeDescriptor(packageId, packageVersion) : unavailable(); },
    run: function (packageId, packageVersion) { return bridge && bridge.run ? bridge.run(packageId, packageVersion) : unavailable(); },
    removePackage: function (packageId, packageVersion) { return bridge && bridge.removePackage ? bridge.removePackage(packageId, packageVersion) : unavailable(); },
  });

  if (root) root.SupervisionPackage = api;
})(typeof window !== 'undefined' ? window : this);
