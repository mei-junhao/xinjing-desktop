'use strict';

const path = require('path');

const workspace = path.resolve(process.env.XJ_289_WORKSPACE_ROOT || path.resolve(__dirname, '..'));
const candidateRoot = path.resolve(process.env.XJ_289_CANDIDATE_ROOT || process.env.XJ_CANDIDATE_ROOT || path.join(workspace, 'candidate', 'repo'));
const inputRoot = path.resolve(process.env.XJ_289_INPUT_ROOT || path.join(workspace, 'input'));

function evidenceFile(name) {
  if (process.env.XJ_289_EVIDENCE_ROOT) return path.join(path.resolve(process.env.XJ_289_EVIDENCE_ROOT), name);
  if (process.env.XJ_289_EVIDENCE_PATH) return path.resolve(process.env.XJ_289_EVIDENCE_PATH);
  return path.join(workspace, 'evidence', name);
}

module.exports = { workspace, candidateRoot, inputRoot, evidenceFile };
