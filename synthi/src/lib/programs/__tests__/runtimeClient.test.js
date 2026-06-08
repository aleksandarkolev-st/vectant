import { afterEach, describe, expect, it, vi } from 'vitest';

import { discoverManifest, launchInstalledProgram } from '../runtimeClient';

function mockFetch(payload, { ok = true, status = 200 } = {}) {
  const fn = vi.fn().mockResolvedValue({
    ok,
    status,
    text: async () => JSON.stringify(payload),
  });
  global.fetch = fn;
  return fn;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete global.fetch;
});

describe('discoverManifest', () => {
  it('parses a vectant.programs.json manifest returned by collab-server and forwards userId', async () => {
    const fetchFn = mockFetch({
      found: true,
      source: 'vectant.programs.json',
      raw: JSON.stringify({ packageId: 'web', version: '1.0.0', launch: 'npm run dev', ports: [3000], runtimeType: 'web' }),
    });

    const result = await discoverManifest('team', 'u-42');

    const [url] = fetchFn.mock.calls[0];
    expect(url).toContain('/program-runtime/team/manifest');
    expect(url).toContain('userId=u-42');
    expect(result.source).toBe('vectant.programs.json');
    expect(result.config.launch).toBe('npm run dev');
    expect(result.config.ports).toEqual([3000]);
    expect(result.config.source).toBe('vectant.programs.json');
  });

  it('imports a devcontainer.json when that is what the workspace has', async () => {
    mockFetch({
      found: true,
      source: 'devcontainer.json',
      raw: JSON.stringify({ name: 'Dev', image: 'node:20', forwardPorts: [5173], postStartCommand: 'npm start' }),
    });

    const result = await discoverManifest('team');

    expect(result.source).toBe('devcontainer.json');
    expect(result.config.source).toBe('devcontainer.json');
    expect(result.config.launch).toBe('npm start');
    expect(result.config.ports).toEqual([5173]);
  });

  it('returns null when no manifest is present', async () => {
    mockFetch({ found: false });
    expect(await discoverManifest('team')).toBeNull();
  });
});

describe('launchInstalledProgram', () => {
  it('posts the recipe config to the collab launch-program endpoint and returns the session', async () => {
    const fetchFn = mockFetch({ session: { sessionId: 'ps-1', state: 'starting' } });
    const config = { packageId: 'web', version: '1.0.0', launch: 'npm run dev', source: 'vectant.programs.json' };

    const session = await launchInstalledProgram({ workspaceSlug: 'team', sessionId: 'ps-1', config, userId: 'u1', title: 'Web' });

    expect(session).toEqual({ sessionId: 'ps-1', state: 'starting' });
    const [url, options] = fetchFn.mock.calls[0];
    expect(url).toMatch(/\/program-runtime\/team\/launch-program$/);
    expect(options.method).toBe('POST');
    const body = JSON.parse(options.body);
    expect(body.sessionId).toBe('ps-1');
    expect(body.config.launch).toBe('npm run dev');
    expect(body.title).toBe('Web');
  });
});
