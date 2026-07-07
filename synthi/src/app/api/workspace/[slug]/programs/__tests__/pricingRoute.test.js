import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  class PricingError extends Error {
    constructor(code, message, field) { super(message); this.code = code; this.field = field; }
  }
  return {
    actor: vi.fn(),
    canWrite: vi.fn(),
    getProgram: vi.fn(),
    upsertPricing: vi.fn(),
    toPublicPricing: vi.fn(),
    PricingError,
  };
});

vi.mock('@/lib/integrations/session', () => ({ resolveActor: h.actor }));
vi.mock('@/lib/integrations/scope', () => ({ canWriteScope: h.canWrite }));
vi.mock('@/lib/programs/store', () => ({ getMarketplaceProgramByPackageId: h.getProgram }));
vi.mock('@/lib/programs/pricing', () => ({ upsertPricing: h.upsertPricing, toPublicPricing: h.toPublicPricing, PricingError: h.PricingError }));

import { POST as PRICING } from '../pricing/route.js';

const call = (body) => PRICING({ json: async () => body }, { params: Promise.resolve({ slug: 'team' }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.actor.mockResolvedValue({ userId: 'u1' });
  h.canWrite.mockResolvedValue(true);
  h.getProgram.mockResolvedValue({ id: 'prog1', packageId: '@team/tool' });
  h.upsertPricing.mockResolvedValue({ priceCents: 500, currency: 'eur', payoutAccountRef: 'acct_9', takeRateBps: 3000 });
  h.toPublicPricing.mockReturnValue({ priceCents: 500, currency: 'eur', isPaid: true });
});

describe('POST /programs/pricing', () => {
  it('401 unauthenticated / 403 non-owner', async () => {
    h.actor.mockResolvedValue(null);
    expect((await call({ packageId: '@team/tool', priceCents: 500 })).status).toBe(401);
    h.actor.mockResolvedValue({ userId: 'u1' });
    h.canWrite.mockResolvedValue(false);
    expect((await call({ packageId: '@team/tool', priceCents: 500 })).status).toBe(403);
  });

  it('403 when pricing an app owned by another workspace', async () => {
    const res = await call({ packageId: '@other/tool', priceCents: 500 });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('not_your_program');
    expect(h.upsertPricing).not.toHaveBeenCalled();
  });

  it('404 when the program does not exist', async () => {
    h.getProgram.mockResolvedValue(null);
    expect((await call({ packageId: '@team/tool', priceCents: 500 })).status).toBe(404);
  });

  it('sets the price and returns the redacted pricing', async () => {
    const res = await call({ packageId: '@team/tool', priceCents: 500, currency: 'eur', payoutAccountRef: 'acct_9' });
    expect(res.status).toBe(200);
    expect(h.upsertPricing).toHaveBeenCalledWith('prog1', expect.objectContaining({ priceCents: 500, currency: 'eur', payoutAccountRef: 'acct_9' }));
    const body = await res.json();
    expect(body.pricing).toEqual({ priceCents: 500, currency: 'eur', isPaid: true });
    expect(JSON.stringify(body)).not.toContain('takeRateBps');
  });

  it('422 on invalid pricing input (never writes a bad price)', async () => {
    h.upsertPricing.mockRejectedValue(new h.PricingError('invalid_price', 'bad', 'priceCents'));
    const res = await call({ packageId: '@team/tool', priceCents: -5 });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('invalid_price');
  });
});
