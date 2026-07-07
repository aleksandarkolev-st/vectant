import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canWriteScope } from '@/lib/integrations/scope';
import { getMarketplaceProgramByPackageId } from '@/lib/programs/store';
import { getPricing, isPaid } from '@/lib/programs/pricing';
import { getActiveEntitlement } from '@/lib/programs/paidEntitlements';
import { isBillingConfigured } from '@/lib/programs/entitlements';
import { signCheckoutReference } from '@/lib/programs/checkoutReference';

export const runtime = 'nodejs';

// POST /api/workspace/:slug/programs/checkout  { packageId }
// Owner/admin. Starts a purchase for a paid marketplace app:
//   free app          -> { free: true }        (no checkout needed)
//   already entitled  -> { entitled: true }
//   billing unset     -> 503 billing_unconfigured (fail-closed)
//   paid, unentitled  -> { checkoutUrl } hand-off to the payments app.
// The charged price is taken from ProgramPricing (server-authoritative), never
// from the client, and bound into a signed `reference` for the webhook to trust.
export async function POST(req, { params }) {
  const { slug } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!(await canWriteScope(actor, { scope: 'workspace', workspaceSlug: slug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const packageId = typeof body.packageId === 'string' ? body.packageId : '';
  if (!packageId) return NextResponse.json({ error: 'packageId_required' }, { status: 400 });

  const program = await getMarketplaceProgramByPackageId(packageId);
  if (!program) return NextResponse.json({ error: 'program_not_found' }, { status: 404 });

  const pricing = await getPricing(program.id);
  if (!isPaid(pricing)) return NextResponse.json({ free: true });

  const subjectId = actor.userId;
  if (await getActiveEntitlement({ programId: program.id, subjectId })) {
    return NextResponse.json({ entitled: true });
  }
  if (!isBillingConfigured()) {
    return NextResponse.json({ error: 'billing_unconfigured' }, { status: 503 });
  }

  const reference = signCheckoutReference({
    programId: program.id, subjectId, priceCents: pricing.priceCents, currency: pricing.currency,
  });
  const url = new URL(process.env.PAYMENTS_CHECKOUT_URL);
  url.searchParams.set('programId', program.id);
  url.searchParams.set('subjectId', subjectId);
  url.searchParams.set('priceCents', String(pricing.priceCents));
  url.searchParams.set('currency', pricing.currency);
  if (pricing.payoutAccountRef) url.searchParams.set('payoutAccountRef', pricing.payoutAccountRef);
  url.searchParams.set('reference', reference);

  return NextResponse.json({ checkoutUrl: url.toString(), priceCents: pricing.priceCents, currency: pricing.currency });
}
