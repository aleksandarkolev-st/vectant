import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  canReadScope,
  canWriteScope,
  checkLimit,
  controlPlane,
  resolveActor,
} = vi.hoisted(() => ({
  canReadScope: vi.fn(),
  canWriteScope: vi.fn(),
  checkLimit: vi.fn(),
  resolveActor: vi.fn(),
  controlPlane: {
    listProjects: vi.fn(),
    createProject: vi.fn(),
    getControlState: vi.fn(),
    recordTransactionWrite: vi.fn(),
  },
}));

vi.mock('@/lib/integrations/session', () => ({
  resolveActor,
}));

vi.mock('@/lib/integrations/scope', () => ({
  canReadScope,
  canWriteScope,
}));

vi.mock('@/lib/integrations/rateLimit', () => ({
  checkLimit,
  RATE_LIMITS: {
    crud: { limit: 30, windowMs: 60_000 },
    audit: { limit: 120, windowMs: 60_000 },
  },
}));

vi.mock('@/lib/codesite/controlPlane', async () => {
  const names = [
    'abortTransaction',
    'acknowledgeInboxItem',
    'collisionPredict',
    'commitTransaction',
    'completeInspectionRun',
    'createAgentSession',
    'createCounterfactualRun',
    'createDocument',
    'createExecutionPlan',
    'createIncident',
    'createInspectionRun',
    'createPolicyDelta',
    'createProject',
    'getAgentInbox',
    'getAgentManifest',
    'getControlState',
    'getEvents',
    'getIncidentReplay',
    'getLineProvenance',
    'getProofBundle',
    'getProject',
    'getSchemas',
    'getTransaction',
    'listProjects',
    'openTransaction',
    'recordAssumption',
    'recordTransactionRead',
    'recordTransactionWrite',
    'requestMutationLease',
    'revokeMutationLease',
    'shadowMergeSimulate',
    'updateControlPlan',
    'updateZonePolicy',
    'validateTransaction',
  ];
  return Object.fromEntries(names.map((name) => [name, controlPlane[name] || vi.fn()]));
});

import { GET, POST } from '../[[...path]]/route.js';

function params(path = []) {
  return { params: Promise.resolve({ slug: 'acme', path }) };
}

async function json(response) {
  return response.json();
}

describe('CodeSite catch-all route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveActor.mockResolvedValue({ userId: 'user-1', email: 'u@example.test' });
    canReadScope.mockResolvedValue(true);
    canWriteScope.mockResolvedValue(true);
    checkLimit.mockReturnValue({ ok: true });
  });

  it('lists projects through the read-gated projects endpoint', async () => {
    controlPlane.listProjects.mockResolvedValue([{ id: 'proj-1', title: 'Signup' }]);

    const response = await GET(new Request('http://test/api/workspace/acme/codesite/projects'), params(['projects']));

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ projects: [{ id: 'proj-1', title: 'Signup' }] });
    expect(canReadScope).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      { scope: 'workspace', workspaceSlug: 'acme' },
    );
  });

  it('creates a project through the write-gated projects endpoint', async () => {
    controlPlane.createProject.mockResolvedValue({ id: 'proj-1', title: 'Signup' });
    const request = new Request('http://test/api/workspace/acme/codesite/projects', {
      method: 'POST',
      body: JSON.stringify({ title: 'Signup' }),
    });

    const response = await POST(request, params(['projects']));

    expect(response.status).toBe(201);
    expect(await json(response)).toEqual({ project: { id: 'proj-1', title: 'Signup' } });
    expect(controlPlane.createProject).toHaveBeenCalledWith(
      'acme',
      expect.objectContaining({ userId: 'user-1' }),
      { title: 'Signup' },
    );
  });

  it('dispatches transaction write records to the control plane', async () => {
    controlPlane.recordTransactionWrite.mockResolvedValue({ ok: false, policyDecision: { decision: 'block' } });
    const request = new Request('http://test/api/workspace/acme/codesite/transactions/txn-1/record-write', {
      method: 'POST',
      body: JSON.stringify({ path: 'api/auth/signup.ts' }),
    });

    const response = await POST(request, params(['transactions', 'txn-1', 'record-write']));

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ ok: false, policyDecision: { decision: 'block' } });
    expect(controlPlane.recordTransactionWrite).toHaveBeenCalledWith('acme', 'txn-1', { path: 'api/auth/signup.ts' });
  });

  it('rejects unauthenticated read access before dispatch', async () => {
    resolveActor.mockResolvedValue(null);

    const response = await GET(new Request('http://test/api/workspace/acme/codesite/projects'), params(['projects']));

    expect(response.status).toBe(401);
    expect(await json(response)).toEqual({ error: 'Authentication required' });
    expect(controlPlane.listProjects).not.toHaveBeenCalled();
  });
});
