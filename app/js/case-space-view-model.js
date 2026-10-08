'use strict';
/**
 * Case-space ViewModel v1 — Phase 1 read-only projection.
 * Derives from Client, Session, MaterialWorkspace, Supervision, ClinicalActionRun.
 * No Store writes, no shared references, no DOM access.
 */
(function () {
  var Store = window.Store;
  if (!Store) throw new Error('CaseSpaceViewModel: Store not available');
  var SourceRef = window.SourceRef;

  var EMPTY_MODEL = Object.freeze({
    version: 'case-space-v1',
    clientId: '',
    nodes: Object.freeze([]),
    edges: Object.freeze([]),
    rejected: Object.freeze([]),
    counts: Object.freeze({ sessions: 0, materials: 0, supervisions: 0, actionRuns: 0, rejected: 0 }),
    sourceStatus: 'unverified'
  });

  function emptyModel(code) {
    // Clone EMPTY_MODEL so failures never share references
    return {
      ok: false, code: code || 'unknown',
      model: Object.freeze({
        version: EMPTY_MODEL.version,
        clientId: '',
        nodes: Object.freeze([]),
        edges: Object.freeze([]),
        rejected: Object.freeze([]),
        counts: Object.freeze({ sessions: 0, materials: 0, supervisions: 0, actionRuns: 0, rejected: 0 }),
        sourceStatus: 'unverified'
      })
    };
  }

  function okModel(model) {
    return { ok: true, model: Object.freeze(model) };
  }

  var nodeIdCounter = 0;
  function nextNodeId() { return 'node-' + (++nodeIdCounter); }
  var edgeIdCounter = 0;
  function nextEdgeId() { return 'edge-' + (++edgeIdCounter); }
  var admittedSourceRefs = Object.create(null);
  var latestRefreshId = 0;

  // Deterministic ID: derived from kind+clientId+entityId, stable across calls
  function nodeId(kind, clientId, entityId) { return 'node-' + kind + '-' + clientId + '-' + entityId; }
  function edgeId(from, to, relation) { return 'edge-' + from + '-' + to + '-' + (relation || 'belongs-to'); }

  function rejectedRow(kind, stableId, reason, clientId, sessionId) {
    return Object.freeze({ kind: kind, stableId: stableId || 'unknown', reason: reason || 'invalid', clientId: clientId || '', sessionId: sessionId || '' });
  }

  function materialSourceRef(material, clientId, sessionId) {
    if (!SourceRef || typeof SourceRef.create !== 'function') return null;
    var sourceText = String(material && material.extractedText || '');
    if (!sourceText) return null;
    try {
      return SourceRef.create({
        clientId: clientId,
        sessionId: sessionId,
        anchor: { kind: 'material:text', locator: 'material:' + String(material.id || '') },
        sourceText: sourceText,
        anchorText: sourceText
      });
    } catch (e) {
      return null;
    }
  }

  function materialAdmission(material, clientId, sessionIds, quarantinedIds) {
    if (!material || material.clientId !== clientId) return { admitted: false, reason: 'cross-client' };
    if (!material.sessionId || !sessionIds.has(material.sessionId)) return { admitted: false, reason: 'cross-session' };
    if (material.parseStatus !== 'ready') return { admitted: false, reason: 'parse-not-ready' };
    if (!String(material.extractedText || '').trim()) return { admitted: false, reason: 'source-empty' };
    if (quarantinedIds.has(String(material.id))) return { admitted: false, reason: 'quarantined' };
    var currentRef = materialSourceRef(material, clientId, material.sessionId);
    var cacheKey = clientId + '|' + material.sessionId + '|' + String(material.id);
    var ref = material.sourceRef || admittedSourceRefs[cacheKey] || currentRef;
    if (!ref || !currentRef || !SourceRef || typeof SourceRef.validateAdmission !== 'function') return { admitted: false, reason: 'source-ref-unavailable' };
    var admission = SourceRef.validateAdmission(ref, {
      clientId: clientId,
      sessionId: material.sessionId,
      anchor: currentRef.anchor,
      sourceText: String(material.extractedText || ''),
      anchorText: String(material.extractedText || '')
    }, { clientId: clientId, sessionId: material.sessionId });
    if (!admission.admitted) return { admitted: false, reason: admission.reason || admission.status || 'source-invalid' };
    admittedSourceRefs[cacheKey] = currentRef;
    return { admitted: true, sourceRef: currentRef };
  }

  /** Async loadClient with fail-closed abort/context */
  function loadClient(clientId, options) {
    options = options || {};
    var signal = options.signal;
    var currentContext = options.currentContext;

    // Check abort before starting
    if (signal && signal.aborted) return Promise.resolve(emptyModel('cancelled'));

    // currentContext mismatch
    if (currentContext && currentContext.clientId && currentContext.clientId !== clientId) {
      return Promise.resolve(emptyModel('context-mismatch'));
    }

    return new Promise(function (resolve) {
      var aborted = false;

      function cleanup() {
        if (signal) signal.removeEventListener('abort', onAbort);
      }

      var onAbort = function () { aborted = true; };

      if (signal) {
        if (signal.aborted) { cleanup(); resolve(emptyModel('cancelled')); return; }
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) { cleanup(); resolve(emptyModel('cancelled')); return; }
      }

      try {
        var client = Store.getClient(clientId);
        if (!client) {
          cleanup();
          resolve(emptyModel('unknown-client'));
          return;
        }
        if (aborted) { resolve(emptyModel('cancelled')); return; }

        var sessions = (Store.getSessionsByClient(clientId) || []).slice();
        if (aborted) { cleanup(); resolve(emptyModel('cancelled')); return; }

        var supervisions = (Store.getSupervisionsByClient(clientId) || []).slice();
        if (aborted) { cleanup(); resolve(emptyModel('cancelled')); return; }

        var actionRuns = (Store.getClinicalActionRuns({ clientId: clientId }) || []).slice();
        if (aborted) { cleanup(); resolve(emptyModel('cancelled')); return; }

        // Build nodes with deterministic IDs
        var nodes = [];
        var rejected = [];
        var ni = 0, ei = 0;
        var edgeCounts = { sessions: sessions.length, materials: 0, supervisions: supervisions.length, actionRuns: actionRuns.length, rejected: 0 };

        // Session nodes
        sessions.forEach(function (s) {
          if (aborted) return;
          nodes.push(Object.freeze({
            id: nodeId('session', clientId, s.id), kind: 'session', clientId: clientId, sessionId: s.id,
            occurredAt: s.date || '', sourceStatus: 'unverified', aiDraft: false
          }));
        });

        if (aborted) { cleanup(); resolve(emptyModel('cancelled')); return; }

        // Material nodes only admit a current, linked and non-quarantined SourceRef.
        var sessionIds = new Set(sessions.map(function (s) { return s.id; }));
        var quarantine = Store.getImportQuarantine ? Store.getImportQuarantine() : [];
        var quarantinedMaterialIds = new Set((quarantine || []).filter(function (item) {
          return item && item.collection === 'materialWorkspaces';
        }).map(function (item) { return String(item.entityId || ''); }).filter(Boolean));
        sessions.forEach(function (s) {
          if (aborted) return;
          var materials = Store.getMaterialWorkspacesForSession(clientId, s.id) || [];
          materials.forEach(function (m) {
            if (aborted) return;
            var material = Store.getMaterialWorkspace ? Store.getMaterialWorkspace(m.id) : m;
            var admission = materialAdmission(material, clientId, sessionIds, quarantinedMaterialIds);
            if (!admission.admitted) {
              rejected.push(rejectedRow('material', material && material.id, admission.reason, material && material.clientId, material && material.sessionId));
              edgeCounts.rejected++;
              return;
            }
            edgeCounts.materials++;
            nodes.push(Object.freeze({
              id: nodeId('material', clientId, material.id), kind: 'material', clientId: clientId, sessionId: material.sessionId,
              occurredAt: material.updatedAt || '', sourceStatus: 'verified', sourceRef: admission.sourceRef,
              aiDraft: !!(material.isAiDraft || material.aiDraft)
            }));
          });
        });

        if (aborted) { cleanup(); resolve(emptyModel('cancelled')); return; }

        // Supervision nodes (reject cross-client, detect AI drafts)
        supervisions.forEach(function (sv) {
          if (aborted) return;
          if (sv.clientId !== clientId) {
            rejected.push(Object.freeze({ kind: 'supervision', reason: 'cross-client', stableId: sv.id || 'unknown' }));
            edgeCounts.rejected++;
            return;
          }
          nodes.push(Object.freeze({
            id: nodeId('supervision', clientId, sv.id), kind: 'supervision', clientId: clientId, sessionId: sv.sessionId || '',
            occurredAt: sv.createdAt || '', sourceStatus: 'unverified',
            aiDraft: !!(sv.isAiDraft || sv.aiDraft)
          }));
        });

        if (aborted) { cleanup(); resolve(emptyModel('cancelled')); return; }

        // ActionRun nodes (reject cross-client, detect AI drafts)
        actionRuns.forEach(function (ar) {
          if (aborted) return;
          if (ar.clientId !== clientId) {
            rejected.push(Object.freeze({ kind: 'action-run', reason: 'cross-client', stableId: ar.id || 'unknown' }));
            edgeCounts.rejected++;
            return;
          }
          nodes.push(Object.freeze({
            id: nodeId('action-run', clientId, ar.id), kind: 'action-run', clientId: clientId, sessionId: ar.sessionId || '',
            occurredAt: ar.createdAt || '', sourceStatus: 'unverified',
            aiDraft: !!(ar.isAiDraft || ar.aiDraft)
          }));
        });

        if (aborted) { cleanup(); resolve(emptyModel('cancelled')); return; }

        // Build edges (non-causal: belongs-to) with deterministic IDs
        var edges = [];
        var sessionNodes = nodes.filter(function (n) { return n.kind === 'session'; });
        nodes.forEach(function (n) {
          if (n.kind === 'session') return;
          var sn = sessionNodes.find(function (s) { return s.sessionId === n.sessionId; });
          if (sn) {
            edges.push(Object.freeze({ id: edgeId(n.id, sn.id, 'belongs-to'), from: n.id, to: sn.id, relation: 'belongs-to' }));
          }
        });

        if (aborted) { cleanup(); resolve(emptyModel('cancelled')); return; }

        // Cleanup
        cleanup();

        resolve(okModel({
          version: 'case-space-v1',
          clientId: clientId,
          nodes: Object.freeze(nodes),
          edges: Object.freeze(edges),
          rejected: Object.freeze(rejected),
          counts: Object.freeze(edgeCounts),
          sourceStatus: 'unverified'
        }));

      } catch (e) {
        cleanup();
        resolve(emptyModel('error'));
      }
    });
  }

  function refresh(clientId, options) {
    var refreshId = ++latestRefreshId;
    return Promise.resolve().then(function () { return loadClient(clientId, options); }).then(function (result) {
      if (refreshId !== latestRefreshId) return emptyModel('superseded');
      return result;
    });
  }

  function cancelAsync(token) {
    if (!token || typeof token.abort !== 'function') return false;
    token.abort();
    return true;
  }

  window.CaseSpaceViewModel = Object.freeze({ loadClient: loadClient, refresh: refresh, cancelAsync: cancelAsync, EMPTY_MODEL: EMPTY_MODEL });
})();
