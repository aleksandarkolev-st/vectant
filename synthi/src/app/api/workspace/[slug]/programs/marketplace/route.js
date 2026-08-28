import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canReadScope } from '@/lib/integrations/scope';
import { listPublishedPrograms, listPricingForPrograms, listActiveEntitlementProgramIds } from '@/lib/programs/store';
import { toPublicPricing } from '@/lib/programs/pricing';

export const runtime = 'nodejs';

// GET /api/workspace/:slug/programs/marketplace?q=
// Member-readable: browse/search the global published catalog. Each program is
// enriched with its (redacted) price + whether the caller is already entitled,
// so the UI can show Install / Buy / Owned. Payout ref + take-rate never leak.
export async function GET(req, { params }) {
  const { slug } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  if (!(await canReadScope(actor, { scope: 'workspace', workspaceSlug: slug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const q = new URL(req.url).searchParams.get('q') || '';
  const programs = await listPublishedPrograms({ q });

  const ids = programs.map((p) => p.id);
  const [pricings, entitledIds] = await Promise.all([
    listPricingForPrograms(ids),
    listActiveEntitlementProgramIds({ subjectId: actor.userId, programIds: ids }),
  ]);
  const pricingByProgram = new Map(pricings.map((p) => [p.programId, p]));
  const entitled = new Set(entitledIds);

  const enriched = programs.map((p) => {
    const price = toPublicPricing(pricingByProgram.get(p.id));
    return { ...p, price, isPaid: !!(price && price.isPaid), entitled: entitled.has(p.id) };
  });

  return NextResponse.json({ programs: enriched });
}
