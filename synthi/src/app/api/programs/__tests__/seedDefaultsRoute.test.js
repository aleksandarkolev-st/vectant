import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  actor: vi.fn(),
  ensureDefaultPrograms: vi.fn(),
}));

vi.mock('@/lib/integrations/session', () => ({ resolveActor: h.actor }));
vi.mock('@/lib/prisma', () => ({ default: {} }));
vi.mock('@/lib/programs/defaultPrograms', () => ({ ensureDefaultPrograms: h.ensureDefaultPrograms }));

import { POST } from '../seed-defaults/route.js';

const prevFlag = process.env.ENABLE_PROGRAM_SEED;

beforeEach(() => {
  vi.clearAllMocks();
  h.actor.mockResolvedValue({ userId: 'u1', email: 'a@b.c' });
  h.ensureDefaultPrograms.mockResolvedValue(['@vectant/nextjs-dev']);
  delete process.env.ENABLE_PROGRAM_SEED;
});
afterEach(() => {
  if (prevFlag === undefined) delete process.env.ENABLE_PROGRAM_SEED;
  else process.env.ENABLE_PROGRAM_SEED = prevFlag;
});

describe('POST /api/programs/seed-defaults', () => {
  it('returns 401 when unauthenticated', async () => {
    process.env.ENABLE_PROGRAM_SEED = '1';
    h.actor.mockResolvedValue(null);
    const res = await POST();
    expect(res.status).toBe(401);
    expect(h.ensureDefaultPrograms).not.toHaveBeenCalled();
  });

  it('returns 404 when the seed flag is not enabled', async () => {
    const res = await POST();
    expect(res.status).toBe(404);
    expect(h.ensureDefaultPrograms).not.toHaveBeenCalled();
  });

  it('seeds when authenticated and the flag is enabled', async () => {
    process.env.ENABLE_PROGRAM_SEED = '1';
    const res = await POST();
    expect(res.status).toBe(200);
    expect(h.ensureDefaultPrograms).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.seeded).toEqual(['@vectant/nextjs-dev']);
  });
});
