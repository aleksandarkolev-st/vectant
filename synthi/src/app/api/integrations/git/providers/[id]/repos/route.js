// repos/route.js
import { loadOwnedProvider, respond } from '@/lib/git/routeHelpers.js';
export const runtime = 'nodejs';
export async function GET(req, { params }) {
  const { id } = await params; const g = await loadOwnedProvider(id); if (g.error) return g.error;
  const u = new URL(req.url);
  return respond(await g.adapter.listRepos(g.conn, { page: Number(u.searchParams.get('page')) || 1, perPage: Number(u.searchParams.get('perPage')) || 30 }));
}
