/**
 * @fileoverview Pure helpers for mapping a Stripe webhook event to an entitlement
 * action. The buyer/program/reference travel as PaymentIntent (or charge)
 * `metadata` set by the checkout hand-off. No I/O here — the route wires these to
 * the stores.
 */

/** Map a Stripe event type to our action, or null if we ignore it. */
export function eventKind(type) {
  if (type === 'payment_intent.succeeded') return 'purchase';
  if (type === 'charge.refunded') return 'refund';
  return null;
}

/** Extract our context from a Stripe event's object metadata. */
export function extractContext(event) {
  const obj = (event && event.data && event.data.object) || {};
  const md = obj.metadata || {};
  const priceCents = Number.parseInt(md.priceCents, 10);
  return {
    programId: md.programId || null,
    subjectId: md.subjectId || null,
    subjectType: md.subjectType || 'user',
    reference: md.reference || null,
    priceCents: Number.isFinite(priceCents) ? priceCents : null,
    currency: md.currency || obj.currency || null,
  };
}
