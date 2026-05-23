import { NextResponse } from 'next/server';
import { workspaceSearchIndex } from '@/server/workspaceSearchIndex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request, { params }) {
  const data = await params;
  const workspaceId = data.workspaceId;

  if (!workspaceId) {
    return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
  }

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

  return NextResponse.json(workspaceSearchIndex.status(workspaceId), { status: 200 });
}
