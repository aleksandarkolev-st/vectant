// status/route.js
import { loadOwnedProvider, respond } from '@/lib/git/routeHelpers.js';
import { NextResponse } from 'next/server';
export const runtime = 'nodejs';
export async function GET(req, { params }) {
  const { id } = await params; const g = await loadOwnedProvider(id); if (g.error) return g.error;
  const u = new URL(req.url); const repo = u.searchParams.get('repo'); const ref = u.searchParams.get('ref');
  if (!repo || !ref) return NextResponse.json({ error: 'repo and ref required' }, { status: 400 });
  return respond(await g.adapter.getStatus(g.conn, { repo, ref }));
}
