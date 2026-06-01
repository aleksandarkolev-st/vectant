import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  resolveActorMock,
  canReadMock,
  canWriteMock,
  listMock,
  createMock,
  getRowMock,
  updateMock,
  deleteMock,
  checkLimitMock,
  testConnMock,
  listToolsMock,
} = vi.hoisted(() => ({
  resolveActorMock: vi.fn(),
  canReadMock: vi.fn(),
  canWriteMock: vi.fn(),
  listMock: vi.fn(),
  createMock: vi.fn(),
  getRowMock: vi.fn(),
  updateMock: vi.fn(),
  deleteMock: vi.fn(),
  checkLimitMock: vi.fn(),
  testConnMock: vi.fn(),
  listToolsMock: vi.fn(),
}));

vi.mock('@/lib/integrations/session', () => ({ resolveActor: resolveActorMock }));
vi.mock('@/lib/integrations/scope', () => ({ canReadScope: canReadMock, canWriteScope: canWriteMock }));
vi.mock('@/lib/integrations/connectionStore', () => ({
  listConnections: listMock,
  createConnection: createMock,
  getConnectionRow: getRowMock,
  updateConnection: updateMock,
  deleteConnection: deleteMock,
}));
vi.mock('@/lib/integrations/rateLimit', () => ({
  checkLimit: checkLimitMock,
  RATE_LIMITS: {
    crud: { limit: 30, windowMs: 60000 },
    test: { limit: 10, windowMs: 60000 },
    extcall: { limit: 60, windowMs: 60000 },
  },
}));
// Keep the real isAllowedHeaderName (security-critical) but stub the network bits.
vi.mock('@/lib/mcp-hub', async (importActual) => {
  const actual = await importActual();
  return { ...actual, testConnection: testConnMock, listTools: listToolsMock };
});
vi.mock('@/lib/tokenCrypto', () => ({ decryptToken: () => 'DECRYPTED' }));

import { GET, POST } from '../route.js';
import { PATCH, DELETE } from '../[id]/route.js';
import { POST as TEST_POST } from '../[id]/test/route.js';

const req = (url, body) => ({ url, json: async () => body });

beforeEach(() => {
  resolveActorMock.mockReset();
  canReadMock.mockReset();
  canWriteMock.mockReset();
  listMock.mockReset();
  createMock.mockReset();
  getRowMock.mockReset();
  updateMock.mockReset();
  deleteMock.mockReset();
  checkLimitMock.mockReset();
  testConnMock.mockReset();
  listToolsMock.mockReset();

  checkLimitMock.mockReturnValue({ ok: true });
  resolveActorMock.mockResolvedValue({ userId: 'u1', email: 'a@b.c' });
});

describe('GET /api/integrations/connections', () => {
  it('1. 401 when unauthenticated; listConnections not called', async () => {
    resolveActorMock.mockResolvedValue(null);
    const res = await GET(req('http://localhost/api/integrations/connections'));
    expect(res.status).toBe(401);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('2. 403 for a workspace non-member; listConnections not called', async () => {
    canReadMock.mockResolvedValue(false);
    const res = await GET(req('http://localhost/api/integrations/connections?workspaceSlug=team'));
    expect(res.status).toBe(403);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('3. 200 for a workspace member with the connection list', async () => {
    canReadMock.mockResolvedValue(true);
    listMock.mockResolvedValue([{ id: 'c1' }]);
    const res = await GET(req('http://localhost/api/integrations/connections?workspaceSlug=team'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connections).toHaveLength(1);
  });

  it('4. 429 when rate-limited; listConnections not called', async () => {
    checkLimitMock.mockReturnValue({ ok: false, retryAfterMs: 5000 });
    const res = await GET(req('http://localhost/api/integrations/connections'));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.retryAfterMs).toBe(5000);
    expect(listMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/integrations/connections', () => {
  it('5. 400 invalid_header_name for a denylisted header; createConnection not called', async () => {
    canWriteMock.mockResolvedValue(true);
    const res = await POST(req('http://localhost/api/integrations/connections', {
      name: 'n', url: 'https://x', scope: 'personal', authType: 'header', headerName: 'Host',
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_header_name');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('6. 201 and creates a fail-closed personal connection', async () => {
    canWriteMock.mockResolvedValue(true);
    createMock.mockResolvedValue({ id: 'new', toolAllowlist: [] });
    const res = await POST(req('http://localhost/api/integrations/connections', {
      name: 'n', url: 'https://x', scope: 'personal', authType: 'header', headerName: 'X-Api-Key', secret: 's',
    }));
    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalledTimes(1);
    const arg = createMock.mock.calls[0][0];
    expect(arg.toolAllowlist).toEqual([]);
    expect(arg.ownerUserId).toBe('u1');
  });

  it('7. 403 forbidden when canWriteScope is false; createConnection not called', async () => {
    canWriteMock.mockResolvedValue(false);
    const res = await POST(req('http://localhost/api/integrations/connections', {
      name: 'n', url: 'https://x', scope: 'workspace', workspaceSlug: 'team',
    }));
    expect(res.status).toBe(403);
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/integrations/connections/[id]', () => {
  it('8. 400 invalid_header_name even when the authz gate passes; updateConnection not called', async () => {
    getRowMock.mockResolvedValue({ scope: 'personal', ownerUserId: 'u1' });
    canWriteMock.mockResolvedValue(true);
    const res = await PATCH(req('http://localhost/api/integrations/connections/c1', { headerName: 'Cookie' }), {
      params: Promise.resolve({ id: 'c1' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_header_name');
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/integrations/connections/[id]', () => {
  it('9. 404 not_found when the row is missing; deleteConnection not called', async () => {
    getRowMock.mockResolvedValue(null);
    const res = await DELETE(req('http://localhost/api/integrations/connections/missing'), {
      params: Promise.resolve({ id: 'missing' }),
    });
    expect(res.status).toBe(404);
    expect(deleteMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/integrations/connections/[id]/test', () => {
  it('10. member-allowed path uses canReadScope, probes, and records health', async () => {
    getRowMock.mockResolvedValue({
      scope: 'workspace', workspaceSlug: 't', url: 'https://x', transport: 'http',
      authType: 'none', headerName: null, secret: null,
    });
    canReadMock.mockResolvedValue(true);
    testConnMock.mockResolvedValue({ ok: true, serverInfo: { name: 's' }, toolCount: 1 });
    listToolsMock.mockResolvedValue({ ok: true, tools: [{ name: 'a', description: 'd' }] });
    const res = await TEST_POST(req('http://localhost/api/integrations/connections/c1/test'), {
      params: Promise.resolve({ id: 'c1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0][1]).toHaveProperty('lastHealthState');
  });

  it('11. 403 forbidden when canReadScope is false; testConnection not called', async () => {
    getRowMock.mockResolvedValue({
      scope: 'workspace', workspaceSlug: 't', url: 'https://x', transport: 'http',
      authType: 'none', headerName: null, secret: null,
    });
    canReadMock.mockResolvedValue(false);
    const res = await TEST_POST(req('http://localhost/api/integrations/connections/c1/test'), {
      params: Promise.resolve({ id: 'c1' }),
    });
    expect(res.status).toBe(403);
    expect(testConnMock).not.toHaveBeenCalled();
  });
});
