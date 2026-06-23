/* @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { PROGRAM_STYLE, BRAND_GRADIENT } from '../programTokens';

describe('programTokens', () => {
  it('exposes vectant shell + header style objects and the brand gradient', () => {
    expect(PROGRAM_STYLE.panelShell.background).toContain('linear-gradient(180deg');
    expect(PROGRAM_STYLE.sectionLabel.textTransform).toBe('uppercase');
    expect(PROGRAM_STYLE.sectionLabel.color).toBe('var(--text-muted)');
    expect(BRAND_GRADIENT).toContain('var(--brand-gradient-horizontal)');
  });
});
