'use strict';
/**
 * XJ-4.3.0-opensquilla-long-source-graph-integration-harness-01
 * Source-Boundary Adapter: wraps REAL production SourceRef module.
 * Rejects ALL persistence. Manages async projection, stale detection,
 * quarantine, and cache invalidation.
 */
const path = require('path');
const SourceRef = require(path.resolve('D:\\xinjing-electron\\design-previews\\4.3.0-opensquilla-atlas-integration', '..', '..', 'app', 'js', 'source-ref.js'));

/**
 * Create a source-boundary adapter that imports the REAL SourceRef.
 * The adapter never persists anything. It produces read-only projections.
 */
function createAdapter() {
  var cache = {};
  var generationCounter = 0;
  var persistenceRejections = [];

  function isAiEdge(edge) {
    if (!edge || typeof edge !== 'object') return false;
    return edge.isAi === true || edge.previewOnly === true;
  }

  function isStale(node, currentFixture) {
    if (!node || !node.sourceRef) return true;
    if (!currentFixture) return true;
    var verifyResult = SourceRef.verify(node.sourceRef, {
      clientId: currentFixture.clientId,
      sessionId: currentFixture.sessionId,
      anchor: node.sourceRef.anchor,
      sourceText: currentFixture.sourceText || '',
      anchorText: currentFixture.anchorText
    });
    return !verifyResult.verified && verifyResult.status !== 'unchanged';
  }

  function needsCacheInvalidation(snapshot, current) {
    if (!snapshot) return true;
    if (!current) return true;
    if (snapshot.clientId !== current.clientId) return true;
    if (snapshot.sessionId !== current.sessionId) return true;
    if (snapshot.normalizationVersion !== current.normalizationVersion) return true;
    if (snapshot.sourceVersion !== current.sourceVersion) return true;
    if (snapshot.materialId && current.materialId && snapshot.materialId !== current.materialId) return true;
    if (snapshot.supervisionId && current.supervisionId && snapshot.supervisionId !== current.supervisionId) return true;
    if (snapshot.actionDraftId && current.actionDraftId && snapshot.actionDraftId !== current.actionDraftId) return true;
    if (snapshot.sourceContentHash !== current.sourceContentHash) return true;
    if (snapshot.materialUpdatedAt && current.materialUpdatedAt && snapshot.materialUpdatedAt !== current.materialUpdatedAt) return true;
    if (snapshot.supervisionUpdatedAt && current.supervisionUpdatedAt && snapshot.supervisionUpdatedAt !== current.supervisionUpdatedAt) return true;
    if (snapshot.actionDraftUpdatedAt && current.actionDraftUpdatedAt && snapshot.actionDraftUpdatedAt !== current.actionDraftUpdatedAt) return true;
    // Check session version map
    var snapSessions = snapshot.sessionVersions || {};
    var curSessions = current.sessionVersions || {};
    var allIds = Object.keys(snapSessions).concat(Object.keys(curSessions));
    for (var i = 0; i < allIds.length; i++) {
      var id = allIds[i];
      if ((snapSessions[id] || '') !== (curSessions[id] || '')) return true;
    }
    return false;
  }

  /**
   * Synchronous projection: builds a read-only view from fixture data.
   * Returns deep copies — never aliases input records.
   */
  function projectSync(clientId, fixtures) {
    if (!clientId) return { ok: false, status: 'invalid', reason: 'missing-client-id', nodes: [], edges: [], aiPreviewEdges: [] };
    var client = fixtures.clients.find(function (c) { return c.id === clientId; });
    if (!client) return { ok: false, status: 'invalid', reason: 'unknown-client', nodes: [], edges: [], aiPreviewEdges: [] };

    // Filter nodes strictly by clientId
    var clientNodes = fixtures.nodes.filter(function (n) {
      return true;
    }).map(function (n) {
      return JSON.parse(JSON.stringify(n));
    });

    // Filter edges strictly by client nodes
    var nodeIds = {};
    clientNodes.forEach(function (n) { nodeIds[n.id] = true; });
    var clientEdges = fixtures.edges.filter(function (e) {
      return nodeIds[e.from] && nodeIds[e.to] && !isAiEdge(e);
    }).map(function (e) {
      return JSON.parse(JSON.stringify(e));
    });

    var aiPreviewEdges = fixtures.edges.filter(function (e) {
      return nodeIds[e.from] && nodeIds[e.to] && isAiEdge(e);
    }).map(function (e) {
      var copy = JSON.parse(JSON.stringify(e));
      copy.isConfirmed = false;
      return copy;
    });

    return {
      ok: true,
      status: 'verified',
      clientId: clientId,
      clientName: client.name,
      nodes: clientNodes,
      edges: clientEdges,
      aiPreviewEdges: aiPreviewEdges,
      nodeCount: clientNodes.length,
      edgeCount: clientEdges.length,
      aiPreviewCount: aiPreviewEdges.length
    };
  }

  /**
   * Async projection: waits for ALL source resolvers before returning.
   * A stale delayed result cannot replace a newer projection.
   */
  async function projectAsync(clientId, fixtures, resolvers, externalSnapshot) {
    if (!clientId) return { ok: false, status: 'invalid', reason: 'missing-client-id', nodes: [], edges: [], aiPreviewEdges: [] };
    var client = fixtures.clients.find(function (c) { return c.id === clientId; });
    if (!client) return { ok: false, status: 'invalid', reason: 'unknown-client', nodes: [], edges: [], aiPreviewEdges: [] };

    var generation = ++generationCounter;

    var syncResult = projectSync(clientId, fixtures);

    // Wait for ALL resolvers to complete — must not resolve before all done
    var resolverResults = [];
    if (resolvers && resolvers.length > 0) {
      resolverResults = await Promise.all(resolvers.map(function (r) {
        return Promise.resolve().then(function () { return r(clientId, fixtures); });
      }));
    }

    // If a newer projection was generated while we were waiting, mark as stale
    if (externalSnapshot && externalSnapshot.generation && externalSnapshot.generation > generation) {
      return {
        ok: false,
        status: 'stale',
        reason: 'newer-projection-exists',
        generation: generation,
        newerGeneration: externalSnapshot.generation,
        nodes: [],
        edges: [],
        aiPreviewEdges: []
      };
    }

    // Check for stale nodes during resolution
    var staleNodeIds = [];
    syncResult.nodes.forEach(function (n) {
      if (isStale(n, fixtures)) staleNodeIds.push(n.id);
    });

    // Apply resolver results
    if (resolverResults.length > 0) {
      var resolverMap = {};
      resolverResults.forEach(function (r) {
        if (r && r.nodeId) resolverMap[r.nodeId] = r;
      });
      syncResult.nodes.forEach(function (n) {
        if (resolverMap[n.id]) {
          n.resolved = true;
          n.resolution = JSON.parse(JSON.stringify(resolverMap[n.id]));
        }
      });
    }

    syncResult.generation = generation;
    syncResult.staleNodeIds = staleNodeIds;
    syncResult.resolverCount = resolverResults.length;

    cache[clientId + ':' + generation] = JSON.parse(JSON.stringify(syncResult));

    return syncResult;
  }

  function quarantineSourceRef(sourceRef, reason) {
    if (!sourceRef || typeof sourceRef !== 'object') {
      return { status: 'invalid', reason: 'ref-missing', quarantined: true, verified: false };
    }
    return {
      status: 'quarantined',
      reason: reason || 'manual-quarantine',
      quarantined: true,
      verified: false,
      sourceRefId: sourceRef.id,
      clientId: sourceRef.clientId,
      sessionId: sourceRef.sessionId
    };
  }

  function createInvalidSourceRef(input) {
    return {
      clientId: (input && input.clientId) || '',
      sessionId: (input && input.sessionId) || '',
      sourceContentHash: '',
      anchorContentHash: '',
      schemaVersion: '',
      status: 'invalid',
      reason: 'invalid-input',
      verified: false,
      quarantined: false
    };
  }

  function verifySourceRef(ref, currentData) {
    if (!ref || typeof ref !== 'object') return { status: 'invalid', reason: 'ref-missing', verified: false };
    if (!ref.schemaVersion || !ref.sourceContentHash || !ref.anchorContentHash) {
      return { status: 'invalid', reason: 'missing-required-fields', verified: false };
    }
    return SourceRef.verify(ref, currentData);
  }

  function createSourceRef(input) {
    return SourceRef.create(input);
  }

  // ── Persistence rejection: ALL attempts rejected ──
  function rejectPersistence(edge, source) {
    var rejection = {
      rejected: true,
      ok: false,
      edgeId: edge ? edge.id : 'unknown',
      source: source || 'unknown',
      reason: 'persistence-not-allowed',
      timestamp: new Date().toISOString()
    };
    persistenceRejections.push(rejection);
    return rejection;
  }

  function persistEdge(edge) { return rejectPersistence(edge, 'persistEdge'); }
  function persistAiEdge(edge) { return rejectPersistence(edge, 'persistAiEdge'); }
  function persistHumanEdge(edge) { return rejectPersistence(edge, 'persistHumanEdge'); }
  function persistProjection(projection) { return rejectPersistence(null, 'persistProjection'); }
  function saveGraph(graph) { return rejectPersistence(null, 'saveGraph'); }
  function commitEdge(edge) { return rejectPersistence(edge, 'commitEdge'); }
  function flushCache() { return rejectPersistence(null, 'flushCache'); }

  return {
    projectSync: projectSync,
    projectAsync: projectAsync,
    isAiEdge: isAiEdge,
    isStale: isStale,
    needsCacheInvalidation: needsCacheInvalidation,
    quarantineSourceRef: quarantineSourceRef,
    createInvalidSourceRef: createInvalidSourceRef,
    verifySourceRef: verifySourceRef,
    createSourceRef: createSourceRef,
    persistEdge: persistEdge,
    persistAiEdge: persistAiEdge,
    persistHumanEdge: persistHumanEdge,
    persistProjection: persistProjection,
    saveGraph: saveGraph,
    commitEdge: commitEdge,
    flushCache: flushCache,
    getPersistenceRejections: function () { return persistenceRejections.slice(); },
    SCHEMA_VERSION: SourceRef.SCHEMA_VERSION,
    NORMALIZATION_VERSION: SourceRef.NORMALIZATION_VERSION,
    SOURCE_VERSION: SourceRef.SOURCE_VERSION
  };
}

module.exports = { createAdapter: createAdapter };
