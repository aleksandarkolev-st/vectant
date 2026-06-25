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
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-subtle)',
    borderRadius: '10px',
  },
  runningShell: {
    background: 'linear-gradient(180deg, #1b1d2b, #14151f)',
    border: '1px solid var(--border-medium)',
    borderRadius: '11px',
    boxShadow: '0 0 0 1px rgba(181,69,255,0.16), 0 0 18px rgba(181,69,255,0.08)',
  },
  iconPlate: {
    background: 'var(--bg-elevated)',
    borderRadius: '9px',
  },
  ghostButton: {
    color: 'var(--text-secondary)',
    border: '1px solid var(--border-medium)',
    borderRadius: '6px',
    background: 'transparent',
  },
  primaryButton: {
    color: '#fff',
    borderRadius: '7px',
    background: BRAND_GRADIENT,
  },
};
