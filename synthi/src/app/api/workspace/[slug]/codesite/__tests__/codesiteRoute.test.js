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
    acknowledgeInboxItem: vi.fn(),
    listProjects: vi.fn(),
    createProject: vi.fn(),
    dryRunTransactionWrites: vi.fn(),
    getEvents: vi.fn(),
    getControlState: vi.fn(),
    getAgentInbox: vi.fn(),
    recordPolicyDecision: vi.fn(),
    recordTransactionWrite: vi.fn(),
    getSourceStateSince: vi.fn(),
    validateTransaction: vi.fn(),
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
    'dryRunTransactionWrites',
    'exportArtifacts',
    'getAgentInbox',
    'getAgentManifest',
    'getControlState',
    'getEvents',
    'getIncidentReplay',
    'getLineProvenance',
    'getProofBundle',
    'getProject',
    'getSchemas',
    'getSourceStateSince',
    'getTransaction',
    'listProjects',
    'openTransaction',
    'recordPolicyDecision',
    'recordAssumption',
    'recordTransactionRead',
    'recordTransactionWrite',
    'requestMutationLease',
    'previewArtifacts',
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

  it('previews dry-run patches without dispatching transaction write records', async () => {
    controlPlane.dryRunTransactionWrites.mockResolvedValue({
      results: [{ ok: true, path: 'synthi/src/App.jsx' }],
    });
    const request = new Request('http://test/api/workspace/acme/codesite/transactions/txn-1/dry-run-patch', {
      method: 'POST',
      body: JSON.stringify({ files: [{ path: 'synthi/src/App.jsx' }] }),
    });

    const response = await POST(request, params(['transactions', 'txn-1', 'dry-run-patch']));

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ results: [{ ok: true, path: 'synthi/src/App.jsx' }] });
    expect(controlPlane.dryRunTransactionWrites).toHaveBeenCalledWith('acme', 'txn-1', {
      files: [{ path: 'synthi/src/App.jsx' }],
      tool: 'dry_run_patch',
    });
    expect(controlPlane.recordTransactionWrite).not.toHaveBeenCalled();
  });

  it('records explicit mutation-lease policy decisions', async () => {
    controlPlane.recordPolicyDecision.mockResolvedValue({ id: 'pd-1', decision: 'hold' });
    const request = new Request('http://test/api/workspace/acme/codesite/mutation-leases/lease-1/policy-decisions', {
      method: 'POST',
      body: JSON.stringify({ decision: 'hold', reasonCodes: ['schema_first'] }),
    });

    const response = await POST(request, params(['mutation-leases', 'lease-1', 'policy-decisions']));

    expect(response.status).toBe(201);
    expect(await json(response)).toEqual({ policyDecision: { id: 'pd-1', decision: 'hold' } });
    expect(controlPlane.recordPolicyDecision).toHaveBeenCalledWith('acme', 'lease-1', {
      decision: 'hold',
      reasonCodes: ['schema_first'],
    });
  });

  it('serves source-state-since through the documented read endpoint', async () => {
    controlPlane.getSourceStateSince.mockResolvedValue({
      sourceState: { transactionId: 'txn-1', changedPaths: ['src/app.js'] },
    });

    const response = await GET(
      new Request('http://test/api/workspace/acme/codesite/transactions/txn-1/source-state-since'),
      params(['transactions', 'txn-1', 'source-state-since']),
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      sourceState: { transactionId: 'txn-1', changedPaths: ['src/app.js'] },
    });
    expect(controlPlane.getSourceStateSince).toHaveBeenCalledWith('acme', 'txn-1');
    expect(controlPlane.validateTransaction).not.toHaveBeenCalled();
  });

  it('streams project events as server-sent events', async () => {
    controlPlane.getEvents.mockResolvedValueOnce([
      { id: 'evt-1', eventType: 'flight_plan_filed', displayCallsign: 'ATLAS-1' },
    ]);
    const controller = new AbortController();

    const response = await GET(
      new Request('http://test/api/workspace/acme/codesite/projects/proj-1/events/stream', { signal: controller.signal }),
      params(['projects', 'proj-1', 'events', 'stream']),
    );
    const reader = response.body.getReader();
    const chunk = await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    const text = new TextDecoder().decode(chunk.value);

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(text).toContain('event: flight_plan_filed');
    expect(text).toContain('data:');
    expect(controlPlane.getEvents).toHaveBeenCalledWith('acme', 'proj-1', null);
  });

  it('passes the resolved actor through agent inbox read and ack routes', async () => {
    controlPlane.getAgentInbox.mockResolvedValue([{ id: 'inbox-1', eventId: 'evt-1' }]);
    controlPlane.acknowledgeInboxItem.mockResolvedValue({ id: 'inbox-1', status: 'acknowledged' });

    const readResponse = await GET(
      new Request('http://test/api/workspace/acme/codesite/agent-sessions/ags-1/inbox'),
      params(['agent-sessions', 'ags-1', 'inbox']),
    );
    const ackResponse = await POST(
      new Request('http://test/api/workspace/acme/codesite/agent-sessions/ags-1/inbox/evt-1', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
      params(['agent-sessions', 'ags-1', 'inbox', 'evt-1']),
    );

    expect(readResponse.status).toBe(200);
    expect(ackResponse.status).toBe(200);
    expect(controlPlane.getAgentInbox).toHaveBeenCalledWith(
      'acme',
      'ags-1',
      expect.objectContaining({ userId: 'user-1' }),
    );
    expect(controlPlane.acknowledgeInboxItem).toHaveBeenCalledWith(
      'acme',
      'ags-1',
      'evt-1',
      expect.objectContaining({ userId: 'user-1' }),
    );
  });

  it('rejects unauthenticated read access before dispatch', async () => {
    resolveActor.mockResolvedValue(null);

    const response = await GET(new Request('http://test/api/workspace/acme/codesite/projects'), params(['projects']));

    expect(response.status).toBe(401);
    expect(await json(response)).toEqual({ error: 'Authentication required' });
    expect(controlPlane.listProjects).not.toHaveBeenCalled();
  });

  it('honors the non-production workspace auth bypass for disposable dev workspaces', async () => {
    const previous = process.env.NEXT_PUBLIC_SYNTHI_WORKSPACE_AUTH_BYPASS;
    process.env.NEXT_PUBLIC_SYNTHI_WORKSPACE_AUTH_BYPASS = '1';
    resolveActor.mockResolvedValue(null);
    controlPlane.listProjects.mockResolvedValue([{ id: 'proj-dev', title: 'Bypass proof' }]);

    try {
      const response = await GET(new Request('http://test/api/workspace/acme/codesite/projects'), params(['projects']));

      expect(response.status).toBe(200);
      expect(await json(response)).toEqual({ projects: [{ id: 'proj-dev', title: 'Bypass proof' }] });
      expect(resolveActor).not.toHaveBeenCalled();
      expect(canReadScope).not.toHaveBeenCalled();
    } finally {
      if (previous == null) {
        delete process.env.NEXT_PUBLIC_SYNTHI_WORKSPACE_AUTH_BYPASS;
      } else {
        process.env.NEXT_PUBLIC_SYNTHI_WORKSPACE_AUTH_BYPASS = previous;
      }
    }
  });
});
