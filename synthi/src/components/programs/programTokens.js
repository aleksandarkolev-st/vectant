// Single source of truth for the Programs panel's vectant styling. Values come
// straight from the design spec (globals.css tokens). Keep components DRY.

export const BRAND_GRADIENT = 'var(--brand-gradient-horizontal)';

export const PROGRAM_STYLE = {
  panelShell: {
    // Match every other docked panel: flush, pure-void background. The dock
    // provides separation, so no outer border or drop-shadow (those made this
    // panel read as a lighter "gray" slab against its black siblings).
    background: 'var(--bg-sidebar)',
  },
  header: {
    borderBottom: '1px solid var(--border-subtle)',
    background: 'color-mix(in srgb, var(--bg-panel) 72%, transparent)',
  },
  headerTitle: {
    fontSize: '11px',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--text-muted)',
  },
  sectionLabel: {
    fontSize: '10px',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--text-muted)',
  },
  countChip: {
    color: 'var(--text-dim)',
  },
  surfaceCard: {
    background: 'linear-gradient(180deg, color-mix(in srgb, var(--bg-panel) 92%, white 3%), color-mix(in srgb, var(--bg-panel) 88%, transparent))',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-panel)',
    boxShadow: 'inset 0 1px 0 color-mix(in srgb, white 4%, transparent)',
  },
  runningShell: {
    background: 'linear-gradient(180deg, color-mix(in srgb, var(--attention-purple) 11%, var(--bg-panel)), color-mix(in srgb, var(--bg-panel) 90%, transparent))',
    border: '1px solid color-mix(in srgb, var(--attention-purple) 28%, var(--border-subtle))',
    borderRadius: 'var(--radius-panel)',
    boxShadow: 'inset 0 1px 0 color-mix(in srgb, white 6%, transparent), 0 0 22px -15px var(--attention-purple)',
  },
  iconPlate: {
    background: 'color-mix(in srgb, var(--text-primary) 7%, transparent)',
    border: '1px solid color-mix(in srgb, var(--border-subtle) 82%, transparent)',
    borderRadius: '8px',
  },
  ghostButton: {
    color: 'var(--text-secondary)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-control)',
    background: 'color-mix(in srgb, var(--bg-panel) 50%, transparent)',
    boxShadow: 'inset 0 1px 0 color-mix(in srgb, white 4%, transparent)',
  },
  primaryButton: {
    color: '#fff',
    border: '1px solid color-mix(in srgb, var(--brand-stop-4) 26%, transparent)',
    borderRadius: 'var(--radius-control)',
    background: BRAND_GRADIENT,
    boxShadow: 'inset 0 1px 0 color-mix(in srgb, white 14%, transparent), 0 16px 36px -28px color-mix(in srgb, var(--brand-stop-3) 80%, transparent)',
  },
};
