import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGuardedFetch } from '../guardedFetch.js';

// Minimal Response-like stub: only the bits guardedFetch touches (status + headers.get).
function resp(status, location = null) {
  return {
    status,
    headers: {
      get: (k) => (String(k).toLowerCase() === 'location' ? location : null),
    },
  };
}

// Injected DNS lookups so tests never touch the network or real DNS.
const publicLookup = () => Promise.resolve(['93.184.216.34']);
const privateLookup = () => Promise.resolve(['10.0.0.5']);

let baseFetch;
beforeEach(() => {
  baseFetch = vi.fn();
});

describe('createGuardedFetch', () => {
  it('passes a public URL straight through and never auto-follows redirects', async () => {
    baseFetch.mockResolvedValue(resp(200));
    const gf = createGuardedFetch({ lookup: publicLookup, baseFetch });
    const res = await gf('https://api.example.com/mcp', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(baseFetch).toHaveBeenCalledTimes(1);
    // redirect:'manual' is forced so the underlying fetch can never silently follow.
    expect(baseFetch).toHaveBeenCalledWith(
      'https://api.example.com/mcp',
      expect.objectContaining({ method: 'POST', redirect: 'manual' }),
    );
  });

  it('blocks a DNS-rebind to a private IP before calling baseFetch', async () => {
    baseFetch.mockResolvedValue(resp(200));
    const gf = createGuardedFetch({ lookup: privateLookup, baseFetch });
    await expect(gf('https://api.example.com/mcp')).rejects.toMatchObject({ code: 'ssrf_blocked' });
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it('blocks a redirect that targets an internal IP (re-validates the hop)', async () => {
    // The first hop is public; it redirects to a link-local literal IP.
    baseFetch.mockResolvedValueOnce(resp(302, 'https://169.254.169.254/'));
    const gf = createGuardedFetch({ lookup: publicLookup, baseFetch });
    await expect(gf('https://api.example.com/mcp')).rejects.toMatchObject({ code: 'ssrf_blocked' });
    expect(baseFetch).toHaveBeenCalledTimes(1); // the internal target was never fetched
  });

  it('follows a redirect to another public host and returns the final response', async () => {
    baseFetch
      .mockResolvedValueOnce(resp(302, 'https://other.public.example/v2'))
      .mockResolvedValueOnce(resp(200));
    const gf = createGuardedFetch({ lookup: publicLookup, baseFetch });
    const res = await gf('https://api.example.com/mcp');
    expect(res.status).toBe(200);
    expect(baseFetch).toHaveBeenCalledTimes(2);
    expect(baseFetch).toHaveBeenLastCalledWith(
      'https://other.public.example/v2',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('resolves relative redirect Locations against the current URL', async () => {
    baseFetch
      .mockResolvedValueOnce(resp(302, '/v2/mcp'))
      .mockResolvedValueOnce(resp(200));
    const gf = createGuardedFetch({ lookup: publicLookup, baseFetch });
    const res = await gf('https://api.example.com/mcp');
    expect(res.status).toBe(200);
    expect(baseFetch).toHaveBeenLastCalledWith(
      'https://api.example.com/v2/mcp',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('fails closed after exceeding maxRedirects (default 3)', async () => {
    baseFetch.mockResolvedValue(resp(302, 'https://hop.public.example/'));
    const gf = createGuardedFetch({ lookup: publicLookup, baseFetch });
    const e = await gf('https://api.example.com/mcp').catch((x) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('ssrf_blocked');
    expect(e.message).toMatch(/too many redirects/i);
    // initial + 3 followed hops are fetched; the cap trips on the would-be 4th follow.
    expect(baseFetch).toHaveBeenCalledTimes(4);
  });

  it('respects a custom maxRedirects', async () => {
    baseFetch.mockResolvedValue(resp(302, 'https://hop.public.example/'));
    const gf = createGuardedFetch({ lookup: publicLookup, baseFetch, maxRedirects: 1 });
    await expect(gf('https://api.example.com/mcp')).rejects.toMatchObject({ code: 'ssrf_blocked' });
    expect(baseFetch).toHaveBeenCalledTimes(2); // initial + 1 follow, then capped
  });
});
