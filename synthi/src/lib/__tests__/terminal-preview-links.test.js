import { describe, expect, it, vi } from 'vitest';

import {
  findTerminalLoopbackAuthLinks,
  resolveTerminalLinkUrl,
  rewriteTerminalOutputLoopbackAuthLinks,
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

  it('routes external auth links with loopback callbacks through the helper page', async () => {
    const authUrl = 'https://auth.example.test/oauth/authorize?client_id=cli&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid';

    expect(terminalLinkNeedsRuntimeResolution(authUrl)).toBe(true);
    const result = await resolveTerminalLinkUrl(authUrl, 'ws-demo-user-demo', {
      ...options,
      loopbackCallbackBridgeUrl: 'https://beta.vectant.dev/auth/loopback',
      loopbackContext: {
        workspaceSlug: 'demo',
        runtimeKind: 'private',
        terminalId: 'terminal-main',
      },
    });
    const parsed = new URL(result);

    expect(parsed.origin).toBe('https://beta.vectant.dev');
    expect(parsed.pathname).toBe('/auth/loopback');
    expect(parsed.searchParams.get('runtimeScope')).toBe('ws-demo-user-demo');
    expect(parsed.searchParams.get('authUrl')).toBe(authUrl);
    expect(parsed.searchParams.get('workspaceSlug')).toBe('demo');
    expect(parsed.searchParams.get('runtimeKind')).toBe('private');
    expect(parsed.searchParams.get('terminalId')).toBe('terminal-main');
  });

  it('routes hash-based loopback callback parameters through the helper page', async () => {
    const authUrl = 'https://auth.example.test/start#redirect_uri=http%3A%2F%2F127.0.0.1%3A8765%2Fcallback%3Fmode%3Dcli&state=state-abc123';

    const result = await resolveTerminalLinkUrl(authUrl, 'ws-demo-user-demo', {
      ...options,
      loopbackCallbackBridgeUrl: 'https://beta.vectant.dev/auth/loopback',
    });
    const parsed = new URL(result);

    expect(parsed.pathname).toBe('/auth/loopback');
    expect(parsed.searchParams.get('authUrl')).toBe(authUrl);
  });

  it('rewrites terminal output auth links to the helper page', () => {
    const authUrl = 'https://auth.example.test/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=state-abc123';
    const text = `Open this link: ${authUrl}`;
    const rewritten = rewriteTerminalOutputLoopbackAuthLinks(text, {
      runtimeScope: 'ws-demo-user-demo',
      bridgeBaseUrl: 'https://beta.vectant.dev/auth/loopback',
      loopbackContext: {
        workspaceSlug: 'demo',
      },
    });
    const helperUrl = rewritten.replace('Open this link: ', '');
    const parsed = new URL(helperUrl);

    expect(parsed.pathname).toBe('/auth/loopback');
    expect(parsed.searchParams.get('runtimeScope')).toBe('ws-demo-user-demo');
    expect(parsed.searchParams.get('authUrl')).toBe(authUrl);
    expect(parsed.searchParams.get('workspaceSlug')).toBe('demo');
  });

  it('finds terminal output auth links for in-IDE relay prompts', () => {
    const authUrl = 'https://auth.example.test/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A4567%2Fcallback&state=state-abc123';
    const links = findTerminalLoopbackAuthLinks(`Open (${authUrl}).`, {
      runtimeScope: 'ws-demo-user-demo',
      bridgeBaseUrl: 'https://beta.vectant.dev/auth/loopback',
      loopbackContext: {
        workspaceSlug: 'demo',
        terminalId: 'term-1',
      },
    });

    expect(links).toHaveLength(1);
    expect(links[0].originalUrl).toBe(authUrl);
    const parsed = new URL(links[0].bridgeUrl);
    expect(parsed.pathname).toBe('/auth/loopback');
    expect(parsed.searchParams.get('runtimeScope')).toBe('ws-demo-user-demo');
    expect(parsed.searchParams.get('authUrl')).toBe(authUrl);
    expect(parsed.searchParams.get('workspaceSlug')).toBe('demo');
    expect(parsed.searchParams.get('terminalId')).toBe('term-1');
  });

  it('does not include OSC-8 terminal hyperlink escape sequences in detected auth URLs', () => {
    const authUrl = 'https://auth.example.test/oauth/authorize?client_id=cli&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid&state=state-abc123';
    const osc8Output = `Open \u001b]8;;${authUrl}\u001b\\${authUrl}\u001b]8;;\u001b\\ to continue`;
    const links = findTerminalLoopbackAuthLinks(osc8Output, {
      runtimeScope: 'ws-demo-user-demo',
      bridgeBaseUrl: 'https://beta.vectant.dev/auth/loopback',
      loopbackContext: {
        workspaceSlug: 'demo',
        terminalId: 'term-1',
      },
    });

    expect(links).toHaveLength(1);
    expect(links[0].originalUrl).toBe(authUrl);
    const parsed = new URL(links[0].bridgeUrl);
    expect(parsed.pathname).toBe('/auth/loopback');
    expect(parsed.searchParams.get('authUrl')).toBe(authUrl);
  });

  it('detects the rendered auth URL when terminal styling splits the state parameter', () => {
    const authUrl = 'https://auth.example.test/oauth/authorize?client_id=cli&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid&state=state-abc123';
    const styledOutput = `Open ${authUrl.replace('state-abc123', '\u001b[36mstate-abc123\u001b[0m')} to continue`;
    const links = findTerminalLoopbackAuthLinks(styledOutput, {
      runtimeScope: 'ws-demo-user-demo',
      bridgeBaseUrl: 'https://beta.vectant.dev/auth/loopback',
      loopbackContext: {
        workspaceSlug: 'demo',
        terminalId: 'term-1',
      },
    });

    expect(links).toHaveLength(1);
    expect(links[0].originalUrl).toBe(authUrl);
    const parsed = new URL(links[0].bridgeUrl);
    expect(parsed.pathname).toBe('/auth/loopback');
    expect(parsed.searchParams.get('authUrl')).toBe(authUrl);
  });

  it('does not surface a detected auth URL with an explicitly broken state value', () => {
    const authUrl = 'https://auth.example.test/oauth/authorize?client_id=cli&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid&state=';
    const links = findTerminalLoopbackAuthLinks(`Open ${authUrl} to continue`, {
      runtimeScope: 'ws-demo-user-demo',
      bridgeBaseUrl: 'https://beta.vectant.dev/auth/loopback',
      loopbackContext: {
        workspaceSlug: 'demo',
        terminalId: 'term-1',
      },
    });

    expect(links).toEqual([]);
  });

  it('does not surface ordinary terminal links as auth relay prompts', () => {
    const links = findTerminalLoopbackAuthLinks('Docs: https://example.test/docs and preview: http://localhost:3000', {
      runtimeScope: 'ws-demo-user-demo',
      bridgeBaseUrl: 'https://beta.vectant.dev/auth/loopback',
    });

    expect(links).toEqual([]);
  });

  it('leaves ordinary external links untouched', async () => {
    const fetchImpl = vi.fn();
    const url = 'https://example.test/docs?next=https%3A%2F%2Fdocs.example.test%2Fpage';

    expect(terminalLinkNeedsRuntimeResolution(url)).toBe(false);
    await expect(resolveTerminalLinkUrl(url, 'ws-demo-user-demo', { ...options, fetchImpl })).resolves.toBe(url);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
