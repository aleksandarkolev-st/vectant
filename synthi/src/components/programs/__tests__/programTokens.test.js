/* @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { PROGRAM_STYLE, BRAND_GRADIENT } from '../programTokens';

describe('programTokens', () => {
  it('exposes vectant shell + header style objects and the brand gradient', () => {
    // The panel base must match every other docked panel (flush --bg-sidebar),
    // not a custom lighter gradient that read as a gray slab against its siblings.
    expect(PROGRAM_STYLE.panelShell.background).toBe('var(--bg-sidebar)');
    expect(PROGRAM_STYLE.panelShell.boxShadow).toBeUndefined();
    expect(PROGRAM_STYLE.sectionLabel.textTransform).toBe('uppercase');
    expect(PROGRAM_STYLE.sectionLabel.color).toBe('var(--text-muted)');
    expect(BRAND_GRADIENT).toContain('var(--brand-gradient-horizontal)');
  });
});
