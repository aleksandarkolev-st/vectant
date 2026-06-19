// pulls/route.js
import { loadOwnedProvider, respond } from '@/lib/git/routeHelpers.js';
import { NextResponse } from 'next/server';
export const runtime = 'nodejs';
export async function POST(req, { params }) {
  const { id } = await params; const g = await loadOwnedProvider(id); if (g.error) return g.error;
  const b = await req.json().catch(() => ({}));
  if (!b.repo || !b.sourceBranch || !b.targetBranch || !b.title) return NextResponse.json({ error: 'repo, sourceBranch, targetBranch, title required' }, { status: 400 });
  return respond(await g.adapter.createPullRequest(g.conn, { repo: b.repo, sourceBranch: b.sourceBranch, targetBranch: b.targetBranch, title: b.title, body: b.body || '' }), 201);
}
