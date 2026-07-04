/**
 * @fileoverview Program pricing — validation (pure) + thin prisma wrappers.
 * A program is "paid" iff it has an active `ProgramPricing` with a positive
 * `priceCents`; otherwise it is free and behaves exactly as today. The platform
 * take-rate is platform-controlled (env), never publisher-settable. Card
 * processing + payouts are the external payments app's job — see the paid-apps
 * design doc.
 */

import prisma from '@/lib/prisma';

/** Currencies the checkout supports (Stripe). Keep aligned with the payments app. */
const KNOWN_CURRENCIES = ['eur', 'usd', 'gbp'];
/** Pricing models. v1 ships one-time only; the field leaves room for more. */
const SUPPORTED_MODELS = ['one_time'];

/** Structured pricing error carrying a machine code + offending field. */
export class PricingError extends Error {
  constructor(code, message, field) {
    super(message);
    this.name = 'PricingError';
    this.code = code;
    this.field = field;
  }
}

/** Validate + normalize a publisher's pricing input (fail-closed). */
export function parsePricingInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PricingError('invalid', 'Pricing input is required');
  }
  const { priceCents, currency, model, payoutAccountRef, active } = input;

  if (!Number.isInteger(priceCents) || priceCents < 0) {
    throw new PricingError('invalid_price', 'priceCents must be a non-negative integer', 'priceCents');
  }
  const cur = typeof currency === 'string' && currency.trim() ? currency.trim().toLowerCase() : 'eur';
  if (!KNOWN_CURRENCIES.includes(cur)) {
    throw new PricingError('invalid_currency', `Unsupported currency '${currency}'`, 'currency');
  }
  const mdl = model == null ? 'one_time' : model;
  if (!SUPPORTED_MODELS.includes(mdl)) {
    throw new PricingError('invalid_model', `Unsupported pricing model '${model}'`, 'model');
  }
  let payout = null;
  if (payoutAccountRef != null) {
    if (typeof payoutAccountRef !== 'string' || !payoutAccountRef.trim()) {
      throw new PricingError('invalid_payout', 'payoutAccountRef must be a non-empty string', 'payoutAccountRef');
    }
    payout = payoutAccountRef.trim();
  }
  return { priceCents, currency: cur, model: mdl, payoutAccountRef: payout, active: active !== false };
}

/** Platform take-rate (basis points), env-controlled. Default 3000 (30%). */
export function platformTakeBps(env = process.env) {
  const raw = parseInt(env.PROGRAM_PLATFORM_TAKE_BPS ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 && raw <= 10000 ? raw : 3000;
}

/** A program is paid iff its pricing is active with a positive price. */
export function isPaid(pricing) {
  return !!(pricing && pricing.active && Number.isInteger(pricing.priceCents) && pricing.priceCents > 0);
}

/**
 * Public projection of pricing for buyers/members. Exposes only the price;
 * NEVER the payout account ref or the platform take-rate (allow-list, same
 * posture as the redacted scan/AI reports).
 */
export function toPublicPricing(pricing) {
  if (!pricing) return null;
  return { priceCents: pricing.priceCents, currency: pricing.currency, isPaid: isPaid(pricing) };
}

/** Upsert a program's pricing (validated). Take-rate applied from env. */
export async function upsertPricing(programId, input, { env = process.env } = {}) {
  const parsed = parsePricingInput(input);
  const data = { ...parsed, takeRateBps: platformTakeBps(env) };
  return prisma.programPricing.upsert({
    where: { programId },
    create: { programId, ...data },
    update: data,
  });
}

/** Read a program's pricing (or null). */
export async function getPricing(programId) {
  return prisma.programPricing.findUnique({ where: { programId } });
}
