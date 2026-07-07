import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  actor: vi.fn(),
  canWrite: vi.fn(),
  getProgram: vi.fn(),
  getPricing: vi.fn(),
  isPaid: vi.fn(),
  getActiveEntitlement: vi.fn(),
  isBillingConfigured: vi.fn(),
  signCheckoutReference: vi.fn(),
}));

vi.mock('@/lib/integrations/session', () => ({ resolveActor: h.actor }));
vi.mock('@/lib/integrations/scope', () => ({ canWriteScope: h.canWrite }));
vi.mock('@/lib/programs/store', () => ({ getMarketplaceProgramByPackageId: h.getProgram }));
vi.mock('@/lib/programs/pricing', () => ({ getPricing: h.getPricing, isPaid: h.isPaid }));
vi.mock('@/lib/programs/paidEntitlements', () => ({ getActiveEntitlement: h.getActiveEntitlement }));
vi.mock('@/lib/programs/entitlements', () => ({ isBillingConfigured: h.isBillingConfigured }));
vi.mock('@/lib/programs/checkoutReference', () => ({ signCheckoutReference: h.signCheckoutReference }));

import { POST as CHECKOUT } from '../checkout/route.js';

const call = (packageId) => CHECKOUT({ json: async () => ({ packageId }) }, { params: Promise.resolve({ slug: 'team' }) });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PAYMENTS_CHECKOUT_URL = 'https://pay.example/checkout';
  h.actor.mockResolvedValue({ userId: 'u1' });
  h.canWrite.mockResolvedValue(true);
  h.getProgram.mockResolvedValue({ id: 'prog1', packageId: '@team/tool' });
  h.getPricing.mockResolvedValue({ priceCents: 500, currency: 'eur', payoutAccountRef: 'acct_9' });
  h.isPaid.mockReturnValue(true);
  h.getActiveEntitlement.mockResolvedValue(null);
  h.isBillingConfigured.mockReturnValue(true);
  h.signCheckoutReference.mockReturnValue('v1.body.mac');
});

describe('POST /programs/checkout', () => {
  it('401 when unauthenticated', async () => {
    h.actor.mockResolvedValue(null);
    expect((await call('@team/tool')).status).toBe(401);
  });

  it('403 when not owner/admin', async () => {
    h.canWrite.mockResolvedValue(false);
    expect((await call('@team/tool')).status).toBe(403);
  });

  it('400 without a packageId', async () => {
    expect((await call('')).status).toBe(400);
  });

  it('404 when the program is unknown', async () => {
    h.getProgram.mockResolvedValue(null);
    expect((await call('@team/nope')).status).toBe(404);
  });

  it('free app → { free: true }, no checkout', async () => {
    h.isPaid.mockReturnValue(false);
    const res = await call('@team/tool');
    expect(await res.json()).toEqual({ free: true });
    expect(h.signCheckoutReference).not.toHaveBeenCalled();
  });

  it('already entitled → { entitled: true }', async () => {
    h.getActiveEntitlement.mockResolvedValue({ id: 'e1', status: 'active' });
    expect(await (await call('@team/tool')).json()).toEqual({ entitled: true });
  });

  it('503 when billing is unconfigured (fail-closed)', async () => {
    h.isBillingConfigured.mockReturnValue(false);
    const res = await call('@team/tool');
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('billing_unconfigured');
  });

  it('paid + unentitled → signed checkout hand-off URL with server-authoritative price', async () => {
    const res = await call('@team/tool');
    const body = await res.json();
    const url = new URL(body.checkoutUrl);
    expect(url.origin + url.pathname).toBe('https://pay.example/checkout');
    expect(url.searchParams.get('programId')).toBe('prog1');
    expect(url.searchParams.get('priceCents')).toBe('500');
    expect(url.searchParams.get('currency')).toBe('eur');
    expect(url.searchParams.get('payoutAccountRef')).toBe('acct_9');
    expect(url.searchParams.get('reference')).toBe('v1.body.mac');
    // price came from pricing, and the signed reference bound the same amount
    expect(h.signCheckoutReference).toHaveBeenCalledWith(
      expect.objectContaining({ programId: 'prog1', subjectId: 'u1', priceCents: 500 }),
    );
    expect(body.priceCents).toBe(500);
  });
});
