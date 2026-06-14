import { describe, expect, it, vi } from 'vitest';

import {
  resolveTerminalLinkUrl,
  terminalLinkNeedsRuntimeResolution,
} from '../terminal-preview-links';

const options = {
  terminalHttpUrl: 'https://beta.vectant.dev/collab',
  windowOrigin: 'https://beta.vectant.dev',
};

describe('terminal-preview-links', () => {
  it('resolves direct localhost links to the runtime preview URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ url: 'https://p3000-rt-demo.preview.vectant.dev/dashboard?tab=1#top' }),
    });

    const result = await resolveTerminalLinkUrl(
      'http://localhost:3000/dashboard?tab=1#top',
      'ws-demo-user-demo',
      { ...options, fetchImpl },
    );

    expect(result).toBe('https://p3000-rt-demo.preview.vectant.dev/dashboard?tab=1#top');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://beta.vectant.dev/collab/preview-url?runtimeScope=ws-demo-user-demo&port=3000&path=%2Fdashboard%3Ftab%3D1%23top',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });

  it('handles scheme-less loopback links from terminal output', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ url: 'https://p5173-rt-demo.preview.vectant.dev/' }),
    });

    expect(terminalLinkNeedsRuntimeResolution('localhost:5173')).toBe(true);
    await expect(
      resolveTerminalLinkUrl('localhost:5173', 'ws-demo-user-demo', { ...options, fetchImpl }),
    ).resolves.toBe('https://p5173-rt-demo.preview.vectant.dev/');
  });

  it('rewrites loopback callback parameters inside external auth links', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ url: 'https://p1455-rt-demo.preview.vectant.dev/auth/callback' }),
    });
    const authUrl = 'https://auth.example.test/oauth/authorize?client_id=cli&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid';

    expect(terminalLinkNeedsRuntimeResolution(authUrl)).toBe(true);
    const result = await resolveTerminalLinkUrl(authUrl, 'ws-demo-user-demo', { ...options, fetchImpl });
    const parsed = new URL(result);

    expect(parsed.origin).toBe('https://auth.example.test');
    expect(parsed.searchParams.get('client_id')).toBe('cli');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://p1455-rt-demo.preview.vectant.dev/auth/callback');
    expect(parsed.searchParams.get('scope')).toBe('openid');
  });

  it('rewrites loopback callback parameters inside URL hashes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ url: 'https://p8765-rt-demo.preview.vectant.dev/callback?mode=cli' }),
    });
    const authUrl = 'https://auth.example.test/start#redirect_uri=http%3A%2F%2F127.0.0.1%3A8765%2Fcallback%3Fmode%3Dcli&state=abc';

    const result = await resolveTerminalLinkUrl(authUrl, 'ws-demo-user-demo', { ...options, fetchImpl });
    const parsed = new URL(result);
    const hashParams = new URLSearchParams(parsed.hash.slice(1));

    expect(hashParams.get('redirect_uri')).toBe('https://p8765-rt-demo.preview.vectant.dev/callback?mode=cli');
    expect(hashParams.get('state')).toBe('abc');
  });

  it('leaves ordinary external links untouched', async () => {
    const fetchImpl = vi.fn();
    const url = 'https://example.test/docs?next=https%3A%2F%2Fdocs.example.test%2Fpage';

    expect(terminalLinkNeedsRuntimeResolution(url)).toBe(false);
    await expect(resolveTerminalLinkUrl(url, 'ws-demo-user-demo', { ...options, fetchImpl })).resolves.toBe(url);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
