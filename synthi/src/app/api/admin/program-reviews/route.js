import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { isPlatformAdmin } from '@/lib/programs/entitlements';
import { listPendingReview, toReviewQueueItem } from '@/lib/programs/store';

export const runtime = 'nodejs';

// GET /api/admin/program-reviews — platform-admin only: the pending_review queue.
export async function GET() {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!isPlatformAdmin(actor)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const rows = await listPendingReview();
  return NextResponse.json({ queue: rows.map(toReviewQueueItem) });
}
