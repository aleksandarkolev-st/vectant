/**
 * Shared collaboration theme constants.
 *
 * Centralises every colour used across ShareModal,
 * WorkspaceUsersPanel and CollabToolbar so there is a
 * single source of truth for the palette.
 */
const COLLAB_THEME = Object.freeze({
  bg:       'var(--bg-app)',
  card:     'var(--bg-panel)',
  surface:  'var(--surface-panel-subtle)',
  border:   'var(--border-subtle)',
  borderHi: 'var(--border-medium)',
  text:     'var(--text-primary)',
  textSec:  'var(--text-secondary)',
  textMuted:'var(--text-muted)',
  teal:     'var(--accent-secondary)',
  tealDim:  'var(--accent-secondary)',
  blue:     'var(--brand-stop-4)',
  amber:    'var(--accent-warning)',
  red:      'var(--accent-danger)',
  live:     'var(--accent-danger)',
});

export default COLLAB_THEME;
