import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  discoverManifest,
  execInWorkspaceRuntime,
  launchInstalledProgram,
  launchProgramRuntime,
  fetchDetectedRepoProgram,
} from '../runtimeClient';

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

describe('fetchDetectedRepoProgram (Slice 1)', () => {
  it('maps a detected compose file from collab-server into a container config', async () => {
    const fetchFn = mockFetch({
      found: true,
      files: { 'docker-compose.yml': 'services:\n  w:\n    ports:\n      - "8080:80"\n' },
      containerRuntimeAvailable: true,
    });

    const r = await fetchDetectedRepoProgram('team', 'u-42');

    const [url] = fetchFn.mock.calls[0];
    expect(url).toContain('/program-runtime/team/detect');
    expect(url).toContain('userId=u-42');
    expect(r.source).toBe('docker-compose.yml');
    expect(r.config.launch).toBe('docker compose up');
    expect(r.config.ports).toContain(8080);
  });

  it('returns null when nothing is found', async () => {
    mockFetch({ found: false });
    expect(await fetchDetectedRepoProgram('team')).toBeNull();
  });

  it('returns null when the container runtime is unavailable', async () => {
    mockFetch({ found: true, files: { 'docker-compose.yml': 'services:\n  w:\n    image: x\n' }, containerRuntimeAvailable: false });
    expect(await fetchDetectedRepoProgram('team')).toBeNull();
  });
});

describe('launchInstalledProgram', () => {
  it('posts the recipe config and CodeSite context to the collab launch-program endpoint', async () => {
    const fetchFn = mockFetch({ session: { sessionId: 'ps-1', state: 'starting' } });
    const config = { packageId: 'web', version: '1.0.0', launch: 'npm run dev', source: 'vectant.programs.json' };
    const codeSiteContext = { active: true, transactionId: 'txn-1', mutationLeaseId: 'lease-1' };

    const session = await launchInstalledProgram({ workspaceSlug: 'team', sessionId: 'ps-1', config, userId: 'u1', title: 'Web', codeSiteContext });

    expect(session).toEqual({ sessionId: 'ps-1', state: 'starting' });
    const [url, options] = fetchFn.mock.calls[0];
    expect(url).toMatch(/\/program-runtime\/team\/launch-program$/);
    expect(options.method).toBe('POST');
    const body = JSON.parse(options.body);
    expect(body.sessionId).toBe('ps-1');
    expect(body.config.launch).toBe('npm run dev');
    expect(body.title).toBe('Web');
    expect(body.codeSiteContext).toEqual(codeSiteContext);
  });
});

describe('runtime command clients', () => {
  it('posts CodeSite context to one-shot workspace runtime exec', async () => {
    const fetchFn = mockFetch({ stdout: 'ok\n', stderr: '', exitCode: 0 });
    const codeSiteContext = { active: true, transactionId: 'txn-1', mutationLeaseId: 'lease-1' };

    await execInWorkspaceRuntime('team', { command: 'npm test', timeout: 1000, codeSiteContext });

    const [url, options] = fetchFn.mock.calls[0];
    expect(url).toMatch(/\/program-runtime\/team\/exec$/);
    const body = JSON.parse(options.body);
    expect(body).toMatchObject({ command: 'npm test', timeout: 1000 });
    expect(body.codeSiteContext).toEqual(codeSiteContext);
  });

  it('posts CodeSite context to managed program command launch', async () => {
    const fetchFn = mockFetch({ sessionId: 'ps-1', output: 'ready' });
    const codeSiteContext = { active: true, transactionId: 'txn-1', mutationLeaseId: 'lease-1' };

    await launchProgramRuntime({
      workspaceSlug: 'team',
      sessionId: 'ps-1',
      command: 'npm run dev',
      userId: 'u1',
      codeSiteContext,
    });

    const [url, options] = fetchFn.mock.calls[0];
    expect(url).toMatch(/\/exec-terminal\/team$/);
    const body = JSON.parse(options.body);
    expect(body).toMatchObject({ sessionId: 'ps-1', command: 'npm run dev', userId: 'u1' });
    expect(body.codeSiteContext).toEqual(codeSiteContext);
  });
});
