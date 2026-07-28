import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { resolveActorMock, canReadMock, canWriteMock, checkLimitMock } = vi.hoisted(() => ({
  resolveActorMock: vi.fn(),
  canReadMock: vi.fn(),
  canWriteMock: vi.fn(),
  checkLimitMock: vi.fn(),
}));

vi.mock('@/lib/integrations/session', () => ({ resolveActor: resolveActorMock }));
vi.mock('@/lib/integrations/scope', () => ({ canReadScope: canReadMock, canWriteScope: canWriteMock }));
vi.mock('@/lib/integrations/rateLimit', () => ({
  checkLimit: checkLimitMock,
  RATE_LIMITS: { crud: { max: 100, windowMs: 1000 } },
}));

import { requireCodesiteAccess } from '@/lib/codesite/routeHelpers';

// Minimal Request-like stub: case-insensitive headers.get(), like NextRequest.
function reqWith(headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { headers: { get: (name) => (name in lower ? lower[name] : lower[String(name).toLowerCase()]) ?? null } };
}

const SECRET = 'test-codesite-service-secret';

describe('requireCodesiteAccess — internal-service token (collab-server control-plane probe)', () => {
  let prevToken;
  beforeEach(() => {
    vi.clearAllMocks();
    resolveActorMock.mockResolvedValue(null); // no NextAuth session by default
    // Ensure the dev bypass is OFF so we exercise the real (production-like) path.
    delete process.env.SYNTHI_WORKSPACE_AUTH_BYPASS;
    delete process.env.NEXT_PUBLIC_SYNTHI_WORKSPACE_AUTH_BYPASS;
    prevToken = process.env.SYNTHI_CODESITE_TOKEN;
    process.env.SYNTHI_CODESITE_TOKEN = SECRET;
  });
  afterEach(() => {
    if (prevToken === undefined) delete process.env.SYNTHI_CODESITE_TOKEN;
    else process.env.SYNTHI_CODESITE_TOKEN = prevToken;
  });

  it('authorizes a Bearer token matching SYNTHI_CODESITE_TOKEN (no session needed)', async () => {
    const access = await requireCodesiteAccess('ws1', 'read', reqWith({ authorization: `Bearer ${SECRET}` }));
    expect(access.ok).toBe(true);
    expect(access.actor.internalService).toBe(true);
    expect(resolveActorMock).not.toHaveBeenCalled();
  });

  it('authorizes a write via the x-synthi-internal-token header', async () => {
    const access = await requireCodesiteAccess('ws1', 'write', reqWith({ 'x-synthi-internal-token': SECRET }));
    expect(access.ok).toBe(true);
    expect(access.actor.internalService).toBe(true);
  });

  it('rejects a wrong token and falls through to session auth → 401', async () => {
    const access = await requireCodesiteAccess('ws1', 'read', reqWith({ authorization: 'Bearer wrong-secret' }));
    expect(access.ok).toBe(false);
    expect(access.status).toBe(401);
    expect(resolveActorMock).toHaveBeenCalled();
  });

  it('is inert when SYNTHI_CODESITE_TOKEN is unset (no new auth path)', async () => {
    delete process.env.SYNTHI_CODESITE_TOKEN;
    const access = await requireCodesiteAccess('ws1', 'read', reqWith({ authorization: `Bearer ${SECRET}` }));
    expect(access.ok).toBe(false);
    expect(access.status).toBe(401);
  });

  it('does not grant access when no request is provided (back-compat call sites)', async () => {
    const access = await requireCodesiteAccess('ws1', 'read');
    expect(access.ok).toBe(false);
    expect(access.status).toBe(401);
  });

  it('leaves the existing NextAuth-session path intact', async () => {
    delete process.env.SYNTHI_CODESITE_TOKEN;
    resolveActorMock.mockResolvedValue({ userId: 'u1', email: 'u@example.com', workspaceUserId: 'u1' });
    canReadMock.mockResolvedValue(true);
    const access = await requireCodesiteAccess('ws1', 'read', reqWith({}));
    expect(access.ok).toBe(true);
    expect(access.actor.userId).toBe('u1');
    expect(access.actor.internalService).toBeUndefined();
  });
});
