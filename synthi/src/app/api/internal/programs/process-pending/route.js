import { NextResponse } from 'next/server';
import { listProcessableSubmissions } from '@/lib/programs/store';
import { processSubmission } from '@/lib/programs/reviewOrchestrator';

export const runtime = 'nodejs';

// POST /api/internal/programs/process-pending
// Scheduler-triggered autonomous sweep: drive every non-terminal community-app
// submission toward a terminal state. Internal shared-secret auth only — this is
// the durable backstop for the publish route's fire-and-forget kickoff and the
// recovery path for any submission stuck mid-pipeline. Never publicly reachable.
export async function POST(req) {
  const configured = process.env.SYNTHI_INTERNAL_API_TOKEN;
  if (!configured) return NextResponse.json({ error: 'sweep_not_configured' }, { status: 503 });
  if (req.headers.get('x-synthi-internal-token') !== configured) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const rows = await listProcessableSubmissions(50);
  let processed = 0;
  for (const row of rows) {
    try {
      await processSubmission(row.id);
      processed += 1;
    } catch {
      // Best-effort: a single failure must not abort the batch; the next sweep retries.
    }
  }
  return NextResponse.json({ processed, scanned: rows.length });
}
