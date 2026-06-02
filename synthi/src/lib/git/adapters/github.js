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
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', ...(init.headers || {}) },
  });
  if (!res.ok) return { ok: false, error: { code: mapError(res.status), message: `github ${res.status}` } };
  return { ok: true, data: await res.json() };
}

export const github = {
  async testConnection(conn) { const r = await call(conn, '/user'); return r.ok ? { ok: true, accountLogin: r.data.login } : r; },
  async listRepos(conn, { perPage = 30, page = 1 } = {}) {
    const r = await call(conn, `/user/repos?per_page=${perPage}&page=${page}&sort=updated`);
    return r.ok ? { ok: true, repos: r.data.map((x) => ({ id: x.id, fullName: x.full_name, url: x.html_url, private: x.private })) } : r;
  },
  async createPullRequest(conn, { repo, sourceBranch, targetBranch, title, body }) {
    const r = await call(conn, `/repos/${repo}/pulls`, { method: 'POST', body: JSON.stringify({ head: sourceBranch, base: targetBranch, title, body }) });
    return r.ok ? { ok: true, pr: { id: r.data.number, url: r.data.html_url, state: r.data.state } } : r;
  },
  async getStatus(conn, { repo, ref }) {
    const r = await call(conn, `/repos/${repo}/commits/${encodeURIComponent(ref)}/status`);
    return r.ok ? { ok: true, checks: { state: r.data.state, total: r.data.total_count } } : r;
  },
};
