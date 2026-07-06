import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  actor: vi.fn(),
}));

vi.mock('@/lib/integrations/session', () => ({ resolveActor: h.actor }));

import { GET, POST } from '../route';

function ctx(path) {
  return { params: { path } };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.actor.mockResolvedValue({ userId: 'u1', email: 'u@example.test' });
  vi.stubGlobal('fetch', vi.fn());
});

it('requires an authenticated actor before proxying provenance', async () => {
  h.actor.mockResolvedValue(null);

  const res = await GET(new Request('http://x/api/provenance/rec-1'), ctx(['rec-1']));

  expect(res.status).toBe(401);
  expect(fetch).not.toHaveBeenCalled();
});

it('redacts sensitive provenance fields from record responses', async () => {
  fetch.mockResolvedValue(new Response(JSON.stringify({
    record_id: 'rec-1',
    target_file: 'src/app.js',
    prompt_info: {
      system_prompt_hash: 'sys-hash',
      user_prompt_hash: 'user-hash',
      user_prompt_preview: 'secret prompt text',
      context_files: ['src/app.js', 'src/secrets.js'],
      context_size_bytes: 1234,
      focus_file: 'src/app.js',
    },
    session_id: 'session-secret',
    user_id: 'other-user',
    metadata: { workspaceRoot: '/private/workspace' },
  }), { headers: { 'content-type': 'application/json' } }));

  const res = await GET(new Request('http://x/api/provenance/rec-1'), ctx(['rec-1']));

  expect(res.status).toBe(200);
  expect(String(fetch.mock.calls[0][0])).toBe('http://localhost:8000/provenance/rec-1');
  const body = await res.json();
  expect(body).toMatchObject({
    record_id: 'rec-1',
    target_file: 'src/app.js',
    prompt_info: {
      system_prompt_hash: 'sys-hash',
      user_prompt_hash: 'user-hash',
      user_prompt_preview: null,
      context_files: [],
      context_file_count: 2,
      context_size_bytes: 1234,
      focus_file: 'src/app.js',
    },
    session_id: null,
    user_id: null,
    metadata: null,
  });
});

it('redacts sensitive provenance fields from file response lists', async () => {
  fetch.mockResolvedValue(new Response(JSON.stringify([
    {
      record_id: 'rec-1',
      prompt_info: { user_prompt_preview: 'secret', context_files: ['src/app.js'] },
      session_id: 'session-secret',
      user_id: 'other-user',
      metadata: { workspaceRoot: '/private/workspace' },
    },
  ]), { headers: { 'content-type': 'application/json' } }));

  const res = await GET(new Request('http://x/api/provenance/file/src/app.js'), ctx(['file', 'src', 'app.js']));

  expect(res.status).toBe(200);
  expect(String(fetch.mock.calls[0][0])).toBe('http://localhost:8000/provenance/file/src/app.js');
  const body = await res.json();
  expect(body[0]).toMatchObject({
    prompt_info: {
      user_prompt_preview: null,
      context_files: [],
      context_file_count: 1,
    },
    session_id: null,
    user_id: null,
    metadata: null,
  });
});

it('rejects non-read provenance action paths and POST proxying', async () => {
  const get = await GET(new Request('http://x/api/provenance/rec-1/rollback'), ctx(['rec-1', 'rollback']));
  const post = await POST();

  expect(get.status).toBe(404);
  expect(post.status).toBe(405);
  expect(post.headers.get('allow')).toBe('GET');
  expect(fetch).not.toHaveBeenCalled();
});
