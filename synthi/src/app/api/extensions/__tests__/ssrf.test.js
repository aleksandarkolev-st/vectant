import { describe, expect, it } from 'vitest';
import { isAllowedOpenVsxUrl } from '../search/validateTargetUrl.js';

describe('isAllowedOpenVsxUrl', () => {
  it.each([
    'https://open-vsx.org.evil.com/x',
    'https://open-vsx.org@evil.com/x',
    'http://open-vsx.org/x',
    'https://evil.com/?u=https://open-vsx.org',
  ])('rejects %s', (targetUrl) => {
    expect(isAllowedOpenVsxUrl(targetUrl)).toBe(false);
  });

  it('accepts the exact Open VSX origin over HTTPS', () => {
    expect(isAllowedOpenVsxUrl('https://open-vsx.org/api/-/search?query=x')).toBe(true);
  });
});
