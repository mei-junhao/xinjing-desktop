'use strict';
/**
 * XJ-4.2.2-ui-shared-cross-route.fixtures.js (rework-04)
 * Synthetic-only data for cross-route UI shared contract tests.
 * Not referenced by production code.
 */
module.exports = (function () {
  return {
    // 22 routes from ROUTE_REGISTRY (app.js:219-242)
    ROUTES: [
      'activation.html','billing-calendar.html','billing-shell.html','chat-home.html',
      'confirm-close.html','consult-notes.html','doc-center.html','doc-growth.html',
      'feedback.html','index.html','knowledge.html','masters.html',
      'migrate-helper.html','real-supervision-ai.html','real-supervision.html',
      'report-writing.html','session-calendar.html','settings.html',
      'supervision-mindmap.html','supervision.html','transcript-guide.html','transcript.html'
    ],
    THEMES: [
      'clinical-light','clinical-dark','theatre-light','theatre-dark',
      'observatory-light','observatory-dark'
    ],
    COMPONENTS: ['PageHeader','IconButton','SegmentedControl','StatusChip','SourceRow','ContextDrawer','EmptyState','LoadingState'],
    // Components whose requiredAria has 'string' type — validateComponent must reject missing aria-label
    ARIA_STRING_COMPONENTS: ['IconButton'],
    SIDEBAR_W: { expanded: 224, narrow: 178, collapsed: 68 },
    MIN_FONT: 12,
    WIDTH_BUDGET: { minWidth: 1024, minHeight: 700 },
    NON_CORE: ['activation.html','confirm-close.html','migrate-helper.html'],
    NO_SIDEBAR_HTML: ['activation.html','chat-home.html','confirm-close.html','doc-growth.html','migrate-helper.html','real-supervision-ai.html','supervision-mindmap.html','transcript-guide.html'],
    MISSING_XJ_CSS: ['feedback.html','masters.html'],
    CSS_FILES: ['app/css/xj-ui-system.css','app/css/workbench.css','app/css/style.css','app/css/components.css'],
    TOKEN_CHECKS: {
      '--xj-sidebar-expanded': '224px',
      '--xj-sidebar-narrow': '178px',
      '--xj-sidebar-collapsed': '68px',
      '--xj-font-min': '12px',
      '--xj-header-h': '76px',
      '--xj-drawer-w': '320px',
      '--xj-icon-btn-size': '36px',
      '--xj-segment-h': '30px',
      '--xj-chip-min-h': '24px',
    },
    COMPONENT_SELECTORS: [
      '.xj-page-header', '.xj-icon-button', '.xj-segmented',
      '.xj-status-chip', '.xj-source-row', '.xj-context-drawer',
      '.xj-empty-state', '.xj-loading-state'
    ],
    // 10 mutations — each pre-verified against real ui-contract.js source
    MUTATIONS: [
      'removeAria', 'removeReducedMotion', 'removeOverflowX',
      'shrinkFont10', 'removeComponent', 'mockPass',
      'fakeSkin', 'disableStringCheck', 'emptyEmptyStateAria', 'hideOverflow'
    ],
    FAKE_ROUTES: ['nonexistent.html', '404.html', 'admin.html', 'test.html'],
  };
})();
