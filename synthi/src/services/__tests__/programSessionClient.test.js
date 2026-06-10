import { describe, expect, it } from 'vitest';

import { getProgramSessionAppUrl } from '../programSessionClient';

// COLLAB_BASE defaults to http://localhost:1234 in the test env (no
// NEXT_PUBLIC_COLLAB_SERVER_URL set).
const BASE = 'http://localhost:1234';

describe('getProgramSessionAppUrl', () => {
  it('returns null for a non-numeric / missing port', () => {
    expect(getProgramSessionAppUrl(null)).toBeNull();
    expect(getProgramSessionAppUrl(undefined)).toBeNull();
    expect(getProgramSessionAppUrl(NaN)).toBeNull();
  });

  it('uses the global /port/<n>/ path for non-container runtimes', () => {
    expect(getProgramSessionAppUrl(3000)).toBe(`${BASE}/port/3000/`);
    expect(getProgramSessionAppUrl(5173, { slug: 'my-repo', runtimeType: 'web' })).toBe(`${BASE}/port/5173/`);
  });

  it('uses the workspace-scoped /wsport/<slug>/<n>/ path for container runtimes', () => {
    expect(getProgramSessionAppUrl(3000, { slug: 'my-repo', runtimeType: 'container' })).toBe(
      `${BASE}/wsport/my-repo/3000/`,
    );
  });

  it('falls back to /port/ when runtimeType is container but slug is missing', () => {
    expect(getProgramSessionAppUrl(3000, { runtimeType: 'container' })).toBe(`${BASE}/port/3000/`);
  });

  it('url-encodes the slug segment', () => {
    expect(getProgramSessionAppUrl(8080, { slug: 'a b', runtimeType: 'container' })).toBe(
      `${BASE}/wsport/a%20b/8080/`,
    );
  });
});
