import { NextResponse } from 'next/server';
import { workspaceSearchIndex } from '@/server/workspaceSearchIndex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request, { params }) {
  const data = await params;
  const workspaceId = data.workspaceId;
  const q = request.nextUrl.searchParams.get('q') || request.nextUrl.searchParams.get('query') || '';

  if (!workspaceId) {
    return NextResponse.json({ status: 'error', results: [], error: 'workspaceId is required' }, { status: 400 });
  }

  // Ensure index build is kicked off, but do not await.
  try {
    workspaceSearchIndex.ensure(workspaceId).catch(() => {});
  } catch (_) {}

  const payload = workspaceSearchIndex.search(workspaceId, q);
  return NextResponse.json(payload, { status: 200 });
}
