import { withFreshToken } from '../token.js';
import { gitFetch } from '../safeFetch.js';
import { resolveApiBase } from '../providerConfig.js';

function mapError(status) {
  if (status === 401 || status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return 'provider_error';
}
async function call(conn, path, init = {}) {
  const token = await withFreshToken(conn);
  const res = await gitFetch(`${resolveApiBase(conn)}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  if (!res.ok) return { ok: false, error: { code: mapError(res.status), message: `gitlab ${res.status}` } };
  return { ok: true, data: await res.json() };
}
const enc = (repo) => encodeURIComponent(repo);

export const gitlab = {
  async testConnection(conn) { const r = await call(conn, '/user'); return r.ok ? { ok: true, accountLogin: r.data.username } : r; },
  async listRepos(conn, { perPage = 30, page = 1 } = {}) {
    const r = await call(conn, `/projects?membership=true&per_page=${perPage}&page=${page}&order_by=last_activity_at`);
    return r.ok ? { ok: true, repos: r.data.map((x) => ({ id: x.id, fullName: x.path_with_namespace, url: x.web_url, private: x.visibility !== 'public' })) } : r;
  },
  async createPullRequest(conn, { repo, sourceBranch, targetBranch, title, body }) {
    const r = await call(conn, `/projects/${enc(repo)}/merge_requests`, { method: 'POST', body: JSON.stringify({ source_branch: sourceBranch, target_branch: targetBranch, title, description: body }) });
    return r.ok ? { ok: true, pr: { id: r.data.iid, url: r.data.web_url, state: r.data.state } } : r;
  },
  async getStatus(conn, { repo, ref }) {
    const r = await call(conn, `/projects/${enc(repo)}/repository/commits/${encodeURIComponent(ref)}/statuses`);
    if (!r.ok) return r;
    const arr = Array.isArray(r.data) ? r.data : [];
    // An empty statuses array means "no checks reported" — report 'unknown', not a vacuous 'success'.
    const state = arr.length === 0 ? 'unknown' : (arr.every((s) => s.status === 'success') ? 'success' : 'pending');
    return { ok: true, checks: { state, total: arr.length } };
  },
};
