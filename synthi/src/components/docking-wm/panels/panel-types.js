/**
 * @fileoverview IDE panel type constants.
 * 
 * Extracted into a separate file to avoid circular dependencies between
 * Redux slices and the Docking Window Manager components.
 */

export const IDE_PANEL = Object.freeze({
  EXPLORER:   'explorer',
  SEARCH:     'search',
  GIT:        'git',
  EXTENSIONS: 'extensions',
  EXTENSION_VIEW: 'extension-view',
  EDITOR:     'editor',
  TERMINAL:   'terminal',
  CHAT:       'chat',
  AGENT_WORKFLOWS: 'agent-workflows',
  PROBLEMS:   'problems',
  OUTPUT:     'output',
  PREVIEW:    'preview',
  SETTINGS:   'settings',
  THEME_EDITOR: 'theme-editor',
  PULL_REQUESTS: 'pullrequests',
  COMMIT_HISTORY: 'commithistory',
  AI_HEALING: 'ai-healing',
});
