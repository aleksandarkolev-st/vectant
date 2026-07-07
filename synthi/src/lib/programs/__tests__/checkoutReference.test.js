import { describe, expect, it } from 'vitest';
import { signCheckoutReference, verifyCheckoutReference } from '../checkoutReference';

const secret = 'handoff_secret_1';
const payload = { programId: 'prog1', subjectId: 'u1', priceCents: 500, currency: 'eur' };

describe('checkout reference (HMAC)', () => {
  it('round-trips a signed payload', () => {
    const token = signCheckoutReference(payload, { secret });
    const r = verifyCheckoutReference(token, { secret });
    expect(r.valid).toBe(true);
    expect(r.payload).toEqual(payload);
  });

  it('rejects a tampered body', () => {
    const token = signCheckoutReference(payload, { secret });
    const [ver, , mac] = token.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ ...payload, priceCents: 1 })).toString('base64url');
    expect(verifyCheckoutReference(`${ver}.${forgedBody}.${mac}`, { secret }).valid).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const token = signCheckoutReference(payload, { secret });
    const [ver, body] = token.split('.');
    expect(verifyCheckoutReference(`${ver}.${body}.deadbeef`, { secret }).valid).toBe(false);
  });

  it('rejects a different secret', () => {
    const token = signCheckoutReference(payload, { secret });
    expect(verifyCheckoutReference(token, { secret: 'other' }).valid).toBe(false);
  });

  it('rejects malformed tokens and missing secret', () => {
    expect(verifyCheckoutReference('nope', { secret }).valid).toBe(false);
    expect(verifyCheckoutReference('', { secret }).valid).toBe(false);
    expect(verifyCheckoutReference(signCheckoutReference(payload, { secret }), { secret: '' }).valid).toBe(false);
  });

  it('signing requires a secret', () => {
    expect(() => signCheckoutReference(payload, { secret: '' })).toThrow();
  });
});
