import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { isPlatformAdmin } from '@/lib/programs/entitlements';
import { approveSubmission, rejectSubmission } from '@/lib/programs/reviewOrchestrator';

export const runtime = 'nodejs';

// POST /api/admin/program-reviews/:versionId  body {action:'approve'|'reject', notes?}
export async function POST(req, { params }) {
  const { versionId } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!isPlatformAdmin(actor)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  let body = {};
  try { body = (await req.json()) || {}; } catch { body = {}; }
  const action = body.action;

  let result;
  if (action === 'approve') {
    result = await approveSubmission({ versionId, adminUserId: actor.userId });
  } else if (action === 'reject') {
    result = await rejectSubmission({ versionId, adminUserId: actor.userId, notes: typeof body.notes === 'string' ? body.notes : '' });
  } else {
    return NextResponse.json({ error: 'invalid_action' }, { status: 400 });
  }

  if (result?.error === 'self_review_forbidden') return NextResponse.json({ error: 'self_review_forbidden' }, { status: 403 });
  if (result?.error === 'not_found') return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (result?.error) return NextResponse.json({ error: result.error, reviewState: result.reviewState }, { status: 409 });
  return NextResponse.json({ result });
}
