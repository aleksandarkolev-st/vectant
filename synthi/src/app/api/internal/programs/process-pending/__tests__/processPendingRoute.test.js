import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ listProcessable: vi.fn(), processSubmission: vi.fn() }));
vi.mock('@/lib/programs/store', () => ({ listProcessableSubmissions: h.listProcessable }));
vi.mock('@/lib/programs/reviewOrchestrator', () => ({ processSubmission: h.processSubmission }));

import { POST } from '../route.js';

const req = (token) => ({ headers: { get: (k) => (k.toLowerCase() === 'x-synthi-internal-token' ? token : null) } });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SYNTHI_INTERNAL_API_TOKEN = 'secret';
});

describe('POST /api/internal/programs/process-pending', () => {
  it('401s without the internal token', async () => {
    const res = await POST(req(null));
    expect(res.status).toBe(401);
    expect(h.processSubmission).not.toHaveBeenCalled();
  });

  it('processes each non-terminal submission with a valid token', async () => {
    h.listProcessable.mockResolvedValue([{ id: 'ver1' }, { id: 'ver2' }]);
    h.processSubmission.mockResolvedValue({ reviewState: 'published' });
    const res = await POST(req('secret'));
    expect(res.status).toBe(200);
    expect(h.processSubmission).toHaveBeenCalledTimes(2);
    expect((await res.json()).processed).toBe(2);
  });

  it('keeps going when one submission throws (best-effort)', async () => {
    h.listProcessable.mockResolvedValue([{ id: 'ver1' }, { id: 'ver2' }]);
    h.processSubmission.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ reviewState: 'published' });
    const res = await POST(req('secret'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scanned).toBe(2);
    expect(body.processed).toBe(1);
  });

  it('503s when no internal token is configured (fail-closed)', async () => {
    delete process.env.SYNTHI_INTERNAL_API_TOKEN;
    const res = await POST(req('whatever'));
    expect(res.status).toBe(503);
    expect(h.processSubmission).not.toHaveBeenCalled();
  });
});
