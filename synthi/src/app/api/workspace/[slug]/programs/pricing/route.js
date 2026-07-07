import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canWriteScope } from '@/lib/integrations/scope';
import { getMarketplaceProgramByPackageId } from '@/lib/programs/store';
import { upsertPricing, toPublicPricing, PricingError } from '@/lib/programs/pricing';

export const runtime = 'nodejs';

// POST /api/workspace/:slug/programs/pricing
//   { packageId, priceCents, currency?, payoutAccountRef?, active? }
// Owner/admin sets/replaces the price of a program THIS workspace published.
// Publishing stays free; this only prices an already-published app. The response
// is the redacted public pricing (no payout ref / take-rate).
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

  // A published app's packageId is namespaced `@<slug>/<name>`; only the owning
  // workspace may price it (defense-in-depth on top of the owner/admin gate).
  if (!packageId.startsWith(`@${slug}/`)) {
    return NextResponse.json({ error: 'not_your_program' }, { status: 403 });
  }

  const program = await getMarketplaceProgramByPackageId(packageId);
  if (!program) return NextResponse.json({ error: 'program_not_found' }, { status: 404 });

  try {
    const pricing = await upsertPricing(program.id, {
      priceCents: body.priceCents,
      currency: body.currency,
      payoutAccountRef: body.payoutAccountRef,
      active: body.active,
    });
    return NextResponse.json({ pricing: toPublicPricing(pricing) });
  } catch (err) {
    if (err instanceof PricingError) {
      return NextResponse.json({ error: err.code, field: err.field, message: err.message }, { status: 422 });
    }
    throw err;
  }
}
