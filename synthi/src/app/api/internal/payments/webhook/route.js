import { NextResponse } from 'next/server';
import { verifyStripeSignature } from '@/lib/programs/stripeSignature';
import { eventKind, extractContext } from '@/lib/programs/paymentWebhook';
import { grantEntitlement, revokeEntitlement } from '@/lib/programs/paidEntitlements';
import { recordWebhookEventOnce } from '@/lib/programs/store';

export const runtime = 'nodejs';

// POST /api/internal/payments/webhook
// Stripe → us. Verify the Stripe-Signature over the RAW body (fail-closed 401),
// then map the event to an idempotent entitlement action:
//   payment_intent.succeeded → grant · charge.refunded → revoke
// Actions are idempotent and the eventId is deduped, so a Stripe retry is a no-op.
export async function POST(req) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: 'billing_unconfigured' }, { status: 503 });

  const raw = await req.text();
  const sig = req.headers.get('stripe-signature');
  if (!verifyStripeSignature(raw, sig, secret)) {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const kind = eventKind(event?.type);
  if (!kind) return NextResponse.json({ ignored: true });

  const ctx = extractContext(event);
  if (!ctx.programId || !ctx.subjectId) {
    return NextResponse.json({ error: 'missing_metadata' }, { status: 400 });
  }

  if (kind === 'purchase') {
    await grantEntitlement({
      programId: ctx.programId, subjectType: ctx.subjectType, subjectId: ctx.subjectId,
      source: 'purchase', reference: ctx.reference || event.id, priceCents: ctx.priceCents, currency: ctx.currency,
    });
  } else {
    await revokeEntitlement({ programId: ctx.programId, subjectType: ctx.subjectType, subjectId: ctx.subjectId });
  }

  const fresh = await recordWebhookEventOnce({
    eventId: event.id, type: kind, reference: ctx.reference || event.id, payloadJson: raw,
  });
  return NextResponse.json({ ok: true, kind, duplicate: !fresh });
}
