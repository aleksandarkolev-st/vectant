import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolveActor: vi.fn(), proxy: vi.fn() }));

vi.mock('@/lib/integrations/session', () => ({ resolveActor: mocks.resolveActor }));
vi.mock('@/lib/proxyAiEngine', () => ({ proxyAiEngineRequest: mocks.proxy }));

import { GET } from '../[...path]/route';

beforeEach(() => {
  mocks.resolveActor.mockReset();
  mocks.proxy.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('code-intel route authentication', () => {
  it('rejects anonymous requests without forwarding to the ai-engine', async () => {
    mocks.resolveActor.mockResolvedValue(null);
    const response = await GET(new Request('http://localhost/api/code-intel/health'), {
      params: Promise.resolve({ path: ['health'] }),
    });
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(response.status).toBe(401);
    expect(mocks.proxy).not.toHaveBeenCalled();
  });

  it('forwards authenticated requests to the ai-engine', async () => {
    const forwarded = new Response('ok');
    mocks.resolveActor.mockResolvedValue({ userId: 'u1' });
    mocks.proxy.mockResolvedValue(forwarded);
    const response = await GET(new Request('http://localhost/api/code-intel/status'), {
      params: Promise.resolve({ path: ['status'] }),
    });
    expect(response).toBe(forwarded);
    expect(mocks.proxy).toHaveBeenCalledTimes(1);
  });
});
