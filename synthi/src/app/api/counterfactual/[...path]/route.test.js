import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ session: vi.fn(), proxy: vi.fn() }));
vi.mock('next-auth', () => ({ getServerSession: mocks.session }));
vi.mock('@/app/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/proxyAiEngine', () => ({ proxyAiEngineRequest: mocks.proxy }));

import { GET } from './route';

beforeEach(() => {
  mocks.session.mockReset();
  mocks.proxy.mockReset();
});

describe('counterfactual proxy authorization', () => {
  it('rejects unauthenticated control-plane access before forwarding', async () => {
    mocks.session.mockResolvedValue(null);
    const response = await GET(new Request('http://localhost/api/counterfactual/controls'), { params: Promise.resolve({ path: ['controls'] }) });
    expect(response.status).toBe(401);
    expect(mocks.proxy).not.toHaveBeenCalled();
  });

  it('forwards authenticated requests only', async () => {
    mocks.session.mockResolvedValue({ user: { id: 'actor-1' } });
    mocks.proxy.mockResolvedValue(new Response(JSON.stringify({ enabled: true }), { status: 200 }));
    const request = new Request('http://localhost/api/counterfactual/controls');
    const response = await GET(request, { params: Promise.resolve({ path: ['controls'] }) });
    expect(response.status).toBe(200);
    expect(mocks.proxy).toHaveBeenCalledWith(request, '/counterfactual/controls');
  });
});
