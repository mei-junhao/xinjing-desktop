'use strict';

const ROUTES = [
  'index.html', 'chat-home.html', 'session-calendar.html', 'consult-notes.html',
  'transcript.html', 'transcript-guide.html', 'report-writing.html', 'supervision.html',
  'supervision-mindmap.html', 'real-supervision.html', 'real-supervision-ai.html', 'masters.html',
  'doc-center.html', 'doc-growth.html', 'knowledge.html', 'billing-shell.html',
  'billing-calendar.html', 'settings.html', 'feedback.html', 'activation.html',
  'confirm-close.html', 'migrate-helper.html'
];

const VIEWPORTS = [
  { name: '1024x700', width: 1024, height: 700 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1920x1080', width: 1920, height: 1080 }
];

const SKINS = ['clinical', 'theatre', 'observatory'];
const THEMES = ['light', 'dark'];
const STATES = ['ready', 'loading', 'empty', 'error'];

module.exports = {
  ROUTES,
  VIEWPORTS,
  SKINS,
  THEMES,
  STATES,
  syntheticContext: {
    clientId: 'client-a',
    sessionId: 'session-a',
    materialId: 'material-a',
    actionRunId: 'action-run-synth-01',
    sourceVersion: 'synthetic-v1'
  }
};
