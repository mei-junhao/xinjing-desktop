'use strict';
/**
 * XJ-4.3.0-opensquilla-case-atlas-disposable-v1
 * SourceRef Adapter — adapts production SourceRef API for disposable case atlas.
 *
 * Responsibilities:
 * 1. Wrap production SourceRef.create/verify/migrateLegacy with atlas-specific defaults
 * 2. Provide cache invalidation rules (client/session/material/source version changes)
 * 3. Provide quarantine handling for invalid sources
 * 4. Reject AI-generated edges and ALL persistence in disposable prototype
 *
 * This adapter imports the real production SourceRef module.
 * It does NOT modify production code.
 */
var path = require('path');

// FIXED: only 2 levels up from design-previews/4.3.0-opensquilla-case-atlas/ to project root
var SourceRef = require(path.join("D:\\xinjing-electron\\design-previews\\4.3.0-opensquilla-case-atlas", '..', '..', 'app', 'js', 'source-ref.js'));

var NORMALIZATION_VERSION = '4.3.0-disposable-v1';
var SOURCE_VERSION = 'synthetic-001';

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

/**
 * Create a SourceRef for a case atlas node.
 * Returns a signed SourceRef with stable id.
 */
function createAtlasSourceRef(opts) {
  opts = opts || {};
  assert(opts.clientId, 'clientId required');
  assert(opts.sessionId, 'sessionId required');
  assert(opts.anchor, 'anchor required');
  assert(opts.sourceText || opts.sourceContentHash, 'sourceText or sourceContentHash required');

  return SourceRef.create({
    clientId: opts.clientId,
    sessionId: opts.sessionId,
    anchor: opts.anchor,
    sourceText: opts.sourceText || '',
    anchorText: opts.anchorText,
    sourceContentHash: opts.sourceContentHash || '',
    anchorContentHash: opts.anchorContentHash || '',
    capturedAt: opts.capturedAt || new Date().toISOString()
  });
}

/**
 * Verify a SourceRef against current data.
 * Applies the production verify() rules:
 * - sourceContentHash mismatch → warning (never verified)
 * - anchorContentHash match → anchor-matched
 * - source changed + anchor matched → warning candidate
 */
function verifyAtlasSourceRef(ref, currentSourceText, currentAnchorText) {
  var current = {
    clientId: ref.clientId,
    sessionId: ref.sessionId,
    anchor: ref.anchor,
    sourceText: currentSourceText || '',
    anchorText: currentAnchorText || ''
  };
  return SourceRef.verify(ref, current);
}

/**
 * Check if a SourceRef is stale — source or anchor content has changed
 * since capture. Stale refs must trigger cache invalidation.
 */
function isStale(ref, currentSourceText, currentAnchorText) {
  var result = verifyAtlasSourceRef(ref, currentSourceText, currentAnchorText);
  return result.status !== 'unchanged';
}

/**
 * Quarantine a SourceRef that references an unknown client or session.
 * Returns a quarantine record with reason and timestamp.
 */
function quarantineSourceRef(ref, reason) {
  return Object.assign({}, ref, {
    status: 'quarantined',
    quarantineReason: reason || 'source-deleted-or-invalid',
    quarantinedAt: new Date().toISOString(),
    verified: true /* MUTATED */
  });
}

/**
 * Check if a given object is an AI-generated edge (must be preview-only).
 * AI edges MUST NOT be persisted; they exist only in the current preview session.
 */
function isAiEdge(edge) {
  if (!edge || typeof edge !== 'object') return false;
  return edge.type === 'ai-inference' || edge.previewOnly === true;
}

/**
 * Reject AI edges if persistence is attempted.
 * Also rejects ALL persistence in disposable prototype (no persistence allowed).
 */
function rejectAiEdgePersistence(edge) {
  if (isAiEdge(edge)) {
    return { ok: false, reason: 'ai-edge-persistence-denied', message: 'AI-generated edges are preview-only and must not be persisted' };
  }
  return { ok: false, reason: 'persistence-not-allowed-in-disposable-prototype' };
}

/**
 * Create an invalid SourceRef for testing quarantine behavior.
 * This is a test-only utility; not used in production.
 */
function createInvalidSourceRef() {
  return {
    id: 'sr:invalid:test',
    schemaVersion: '',
    clientId: '',
    sessionId: '',
    anchor: null,
    normalizationVersion: '',
    sourceVersion: '',
    sourceContentHash: '',
    anchorContentHash: '',
    capturedAt: '',
    legacy: true,
    status: 'legacy-unverified',
    verified: false
  };
}

/**
 * Check cache invalidation: returns true if the ViewModel must be regenerated
 * because a dependency (client/session/material/supervision) has changed.
 */
function needsCacheInvalidation(snapshot, current) {
  if (!snapshot) return true;
  if (snapshot.normalizationVersion !== NORMALIZATION_VERSION) return true;
  if (snapshot.sourceVersion !== current.sourceVersion) return true;
  if (snapshot.clientId && current.clientId && snapshot.clientId !== current.clientId) return true;
  if (snapshot.sessionId && current.sessionId && snapshot.sessionId !== current.sessionId) return true;
  return false;
}

module.exports = {
  SourceRef: SourceRef,
  NORMALIZATION_VERSION: NORMALIZATION_VERSION,
  SOURCE_VERSION: SOURCE_VERSION,
  createAtlasSourceRef: createAtlasSourceRef,
  verifyAtlasSourceRef: verifyAtlasSourceRef,
  isStale: isStale,
  quarantineSourceRef: quarantineSourceRef,
  isAiEdge: isAiEdge,
  rejectAiEdgePersistence: rejectAiEdgePersistence,
  createInvalidSourceRef: createInvalidSourceRef,
  needsCacheInvalidation: needsCacheInvalidation,
  assert: assert
};
