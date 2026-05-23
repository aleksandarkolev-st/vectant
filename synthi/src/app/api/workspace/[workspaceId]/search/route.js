import { NextResponse } from 'next/server';
import { workspaceSearchIndex } from '@/server/workspaceSearchIndex';
import { requireWorkspaceAccess } from '@/lib/workspaceAccess';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request, { params }) {
  const data = await params;
  const workspaceId = data.workspaceId;
  const q = request.nextUrl.searchParams.get('q') || request.nextUrl.searchParams.get('query') || '';

  if (!workspaceId) {
    return NextResponse.json({ status: 'error', results: [], error: 'workspaceId is required' }, { status: 400 });
  }

  let access;
  try {
    access = await requireWorkspaceAccess(workspaceId);
  } catch (err) {
    console.error('Workspace search access check failed:', err);
    return NextResponse.json({ status: 'error', results: [], error: 'Internal server error' }, { status: 500 });
  }

  if (!access.ok) {
    return NextResponse.json({ status: 'error', results: [], error: access.error }, { status: access.status });
  }

  // Ensure index build is kicked off, but do not await.
  try {
    workspaceSearchIndex.ensure(workspaceId).catch((err) => {
      console.warn('search index build failed', {
        workspaceId,
        error: err?.message,
      });
    });
  } catch (err) {
    console.warn('search index build failed to start', {
      workspaceId,
      error: err?.message,
    });
  }

  const payload = workspaceSearchIndex.search(workspaceId, q);
  return NextResponse.json(payload, { status: 200 });
}
