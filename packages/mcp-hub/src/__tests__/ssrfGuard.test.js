import { describe, it, expect } from 'vitest';
import { isBlockedIp, assertSafeUrl } from '../ssrfGuard.js';

describe('isBlockedIp', () => {
  it('blocks loopback, private, link-local, and metadata IPs', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', '[::1]', '::ffff:7f00:1', 'fc00::1', 'fe80::1']) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });
  it('allows public IPs', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });
});

describe('assertSafeUrl', () => {
  const allowPublic = () => Promise.resolve(['93.184.216.34']);
  const allowInternal = () => Promise.resolve(['10.0.0.5']);

  it('rejects non-https URLs not on the allowlist', async () => {
    await expect(assertSafeUrl('http://example.com/mcp', { lookup: allowPublic }))
      .rejects.toMatchObject({ code: 'ssrf_blocked' });
  });
  it('rejects localhost by name', async () => {
    await expect(assertSafeUrl('https://localhost/mcp', { lookup: allowInternal }))
      .rejects.toMatchObject({ code: 'ssrf_blocked' });
  });
  it('rejects hosts resolving to internal IPs', async () => {
    await expect(assertSafeUrl('https://evil.example.com/mcp', { lookup: allowInternal }))
      .rejects.toMatchObject({ code: 'ssrf_blocked' });
  });
  it('accepts https hosts resolving to public IPs', async () => {
    await expect(assertSafeUrl('https://api.example.com/mcp', { lookup: allowPublic }))
      .resolves.toBeUndefined();
  });
  it('accepts an http host explicitly on the allowlist', async () => {
    await expect(assertSafeUrl('http://internal-tools/mcp', { allowlist: ['internal-tools'], lookup: allowInternal }))
      .resolves.toBeUndefined();
  });
  it('rejects an IPv6 loopback literal in a URL', async () => {
    await expect(assertSafeUrl('https://[::1]/mcp', { lookup: allowInternal }))
      .rejects.toMatchObject({ code: 'ssrf_blocked' });
  });
  it('rejects an IPv4-mapped IPv6 literal for a private address', async () => {
    await expect(assertSafeUrl('https://[::ffff:127.0.0.1]/mcp', { lookup: allowInternal }))
      .rejects.toMatchObject({ code: 'ssrf_blocked' });
  });
});
