const BASE = '/api/integrations/connections';

export async function fetchConnections(workspaceSlug) {
  const qs = workspaceSlug ? `?workspaceSlug=${encodeURIComponent(workspaceSlug)}` : '';
  const res = await fetch(`${BASE}${qs}`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Failed to load connections');
  return (await res.json()).connections || [];
}

export async function createConnection(payload) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Failed to create connection');
  return data.connection;
}

export async function updateConnection(id, patch) {
  const res = await fetch(`${BASE}/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Failed to update connection');
  return data.connection;
}

export async function deleteConnection(id) {
  const res = await fetch(`${BASE}/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Failed to delete connection');
  return true;
}

export async function testConnection(id) {
  const res = await fetch(`${BASE}/${id}/test`, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Test failed');
  return data; // { ok, state, tools?: [{name, description}], ... }
}

const TOKENS = '/api/integrations/tokens';

export async function fetchTokens() {
  const res = await fetch(TOKENS);
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Failed to load tokens');
  return (await res.json()).tokens || [];
}

export async function createToken(name) {
  const res = await fetch(TOKENS, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Failed to create token');
  return data; // { id, name, last4, createdAt, token (plaintext, once) }
}

export async function revokeToken(id) {
  const res = await fetch(`${TOKENS}/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Failed to revoke token');
  return true;
}
