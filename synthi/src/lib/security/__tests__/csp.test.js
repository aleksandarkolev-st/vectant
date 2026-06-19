import { describe, expect, it } from 'vitest';
import { buildContentSecurityPolicy } from '../csp';

function frameSrc(csp) {
  return csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('frame-src '));
}

describe('buildContentSecurityPolicy', () => {
  it('adds the collab-server origin to frame-src', () => {
    const csp = buildContentSecurityPolicy('http://localhost:1234');
    expect(frameSrc(csp)).toBe("frame-src 'self' blob: http://localhost:1234");
  });

  it('uses only the origin (strips path) and supports https', () => {
    const csp = buildContentSecurityPolicy('https://collab.example.com/base/');
    expect(frameSrc(csp)).toBe("frame-src 'self' blob: https://collab.example.com");
  });

  it('falls back to self + blob when the url is missing or invalid', () => {
    expect(frameSrc(buildContentSecurityPolicy(''))).toBe("frame-src 'self' blob:");
    expect(frameSrc(buildContentSecurityPolicy('not a url'))).toBe("frame-src 'self' blob:");
  });

  it('preserves the other directives', () => {
    const csp = buildContentSecurityPolicy('http://localhost:1234');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("object-src 'none'");
  });
});
