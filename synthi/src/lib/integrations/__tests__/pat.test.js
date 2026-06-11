import { describe, it, expect } from 'vitest';
import { generatePat, hashToken, looksLikePat } from '../pat';

describe('pat helpers', () => {
  it('generatePat returns a prefixed token, matching hash, and last4', () => {
    const { token, tokenHash, last4 } = generatePat();
    expect(token.startsWith('synthi_pat_')).toBe(true);
    expect(token.length).toBeGreaterThan('synthi_pat_'.length + 30);
    expect(tokenHash).toBe(hashToken(token));
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(last4).toBe(token.slice(-4));
  });

  it('hashToken is deterministic and differs per token', () => {
    expect(hashToken('a')).toBe(hashToken('a'));
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });

  it('looksLikePat gates obvious non-tokens', () => {
    const { token } = generatePat();
    expect(looksLikePat(token)).toBe(true);
    expect(looksLikePat('nope')).toBe(false);
    expect(looksLikePat('synthi_pat_short')).toBe(false);
    expect(looksLikePat(null)).toBe(false);
  });
});
