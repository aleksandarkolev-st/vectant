import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { verifyStripeSignature, parseSigHeader } from '../stripeSignature';

const secret = 'whsec_test';
const body = '{"id":"evt_1","type":"payment_intent.succeeded"}';

function sign(rawBody, ts, sec = secret) {
  const mac = crypto.createHmac('sha256', sec).update(`${ts}.${rawBody}`).digest('hex');
  return `t=${ts},v1=${mac}`;
}

describe('parseSigHeader', () => {
  it('extracts t and all v1 signatures', () => {
    expect(parseSigHeader('t=123,v1=aaa,v1=bbb')).toEqual({ t: '123', v1: ['aaa', 'bbb'] });
  });
});

describe('verifyStripeSignature', () => {
  const now = 1_000_000;

  it('accepts a valid, in-tolerance signature', () => {
    const header = sign(body, now);
    expect(verifyStripeSignature(body, header, secret, { nowSec: now })).toBe(true);
  });

  it('accepts when one of several v1 candidates matches', () => {
    const good = sign(body, now).split('v1=')[1];
    const header = `t=${now},v1=deadbeef,v1=${good}`;
    expect(verifyStripeSignature(body, header, secret, { nowSec: now })).toBe(true);
  });

  it('rejects a wrong secret', () => {
    expect(verifyStripeSignature(body, sign(body, now, 'other'), secret, { nowSec: now })).toBe(false);
  });

  it('rejects a tampered body', () => {
    const header = sign(body, now);
    expect(verifyStripeSignature(body + 'x', header, secret, { nowSec: now })).toBe(false);
  });

  it('rejects a timestamp outside tolerance (replay)', () => {
    const header = sign(body, now - 10_000);
    expect(verifyStripeSignature(body, header, secret, { nowSec: now, toleranceSec: 300 })).toBe(false);
  });

  it('rejects missing secret / header / body', () => {
    expect(verifyStripeSignature(body, sign(body, now), '', { nowSec: now })).toBe(false);
    expect(verifyStripeSignature(body, '', secret, { nowSec: now })).toBe(false);
    expect(verifyStripeSignature(body, 't=1', secret, { nowSec: now })).toBe(false);
  });
});
