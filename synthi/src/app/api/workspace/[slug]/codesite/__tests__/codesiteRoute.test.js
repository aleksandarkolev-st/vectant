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
    createDocument: vi.fn(),
    createProject: vi.fn(),
    dryRunTransactionWrites: vi.fn(),
    eventCursor: vi.fn(),
    getEvents: vi.fn(),
    getControlState: vi.fn(),
    getCodeSiteMetrics: vi.fn(),
    getAgentInbox: vi.fn(),
    recordPolicyDecision: vi.fn(),
    recordTransactionWrite: vi.fn(),
    getLineProvenance: vi.fn(),
    getSourceStateSince: vi.fn(),
    preflightCodeSiteFsWrite: vi.fn(),
    validateTransaction: vi.fn(),
    recordTransactionQuarantineEvent: vi.fn(),
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
    'eventCursor',
    'exportArtifacts',
    'getAgentInbox',
    'getAgentManifest',
    'getCodeSiteMetrics',
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
    'preflightCodeSiteFsWrite',
    'recordPolicyDecision',
    'recordAssumption',
    'recordTransactionRead',
    'recordTransactionQuarantineEvent',
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
    delete process.env.SYNTHI_WORKSPACE_AUTH_BYPASS;
    delete process.env.NEXT_PUBLIC_SYNTHI_WORKSPACE_AUTH_BYPASS;
    resolveActor.mockResolvedValue({ userId: 'user-1', email: 'u@example.test' });
    canReadScope.mockResolvedValue(true);
    canWriteScope.mockResolvedValue(true);
    checkLimit.mockReturnValue({ ok: true });
    controlPlane.eventCursor.mockImplementation((event) => (
      Number.isSafeInteger(Number(event?.logicalTime)) ? `lt:${Number(event.logicalTime)}` : event?.id
    ));
    delete process.env.COLLAB_SERVER_URL;
    delete process.env.SYNTHI_CODESITE_API_BASE_URL;
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

  it('keeps project creation write-gated for plain workspace members', async () => {
    canWriteScope.mockResolvedValue(false);
    const request = new Request('http://test/api/workspace/acme/codesite/projects', {
      method: 'POST',
      body: JSON.stringify({ title: 'Signup' }),
    });

    const response = await POST(request, params(['projects']));

    expect(response.status).toBe(403);
    expect(controlPlane.createProject).not.toHaveBeenCalled();
    expect(canWriteScope).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      { scope: 'workspace', workspaceSlug: 'acme' },
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
    expect(controlPlane.recordTransactionWrite).toHaveBeenCalledWith(
      'acme',
      'txn-1',
      { path: 'api/auth/signup.ts' },
      expect.objectContaining({ userId: 'user-1' }),
    );
  });

  it('dispatches transaction quarantine lifecycle events to the control plane', async () => {
    controlPlane.recordTransactionQuarantineEvent.mockResolvedValue({
      id: 'event-quarantine-applied',
      eventType: 'quarantine_applied',
    });
    const body = {
      eventType: 'quarantine_applied',
      quarantineId: 'qtn-1',
      paths: ['docs/review.md'],
    };
    const request = new Request('http://test/api/workspace/acme/codesite/transactions/txn-1/quarantine-events', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const response = await POST(request, params(['transactions', 'txn-1', 'quarantine-events']));

    expect(response.status).toBe(201);
    expect(await json(response)).toEqual({
      event: {
        id: 'event-quarantine-applied',
        eventType: 'quarantine_applied',
      },
    });
    expect(controlPlane.recordTransactionQuarantineEvent).toHaveBeenCalledWith(
      'acme',
      'txn-1',
      body,
      expect.objectContaining({ userId: 'user-1' }),
    );
  });

  it('proxies quarantine manifest review through the read-gated CodeSite facade', async () => {
    process.env.COLLAB_SERVER_URL = 'http://collab.test';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      quarantines: [{ quarantineId: 'qtn-1', status: 'reviewable' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const response = await GET(
      new Request('http://app.test/api/workspace/acme/codesite/quarantines?transactionId=txn-1&status=reviewable'),
      params(['quarantines']),
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      ok: true,
      quarantines: [{ quarantineId: 'qtn-1', status: 'reviewable' }],
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      new URL('http://collab.test/codesitefs/quarantines/acme?userId=user-1&filesystemUserId=user-1&transactionId=txn-1&status=reviewable'),
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'x-user-id': 'user-1',
          'x-runtime-fs-user-id': 'user-1',
          'x-codesite-control-plane-url': 'http://app.test/api/workspace/acme/codesite',
        }),
      }),
    );
    fetchSpy.mockRestore();
    delete process.env.COLLAB_SERVER_URL;
  });

  it('proxies quarantine replay with selected paths and transaction metadata', async () => {
    process.env.COLLAB_SERVER_URL = 'http://collab.test';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      replay: [{ path: 'docs/review.md' }],
      rejected: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const request = new Request('http://app.test/api/workspace/acme/codesite/quarantines/qtn-1/replay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        transactionId: 'txn-1',
        mutationLeaseId: 'lease-1',
        paths: ['docs/review.md'],
      }),
    });

    const response = await POST(request, params(['quarantines', 'qtn-1', 'replay']));

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      ok: true,
      replay: [{ path: 'docs/review.md' }],
      rejected: [],
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      new URL('http://collab.test/codesitefs/quarantines/acme/qtn-1/replay'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-user-id': 'user-1',
          'x-runtime-fs-user-id': 'user-1',
          'x-codesite-mode': 'enforce',
          'x-codesite-transaction-id': 'txn-1',
          'x-codesite-lease-id': 'lease-1',
        }),
      }),
    );
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toMatchObject({
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
      paths: ['docs/review.md'],
      userId: 'user-1',
      filesystemUserId: 'user-1',
      codesite: {
        enforce: true,
        mode: 'enforce',
        workspaceSlug: 'acme',
        transactionId: 'txn-1',
        mutationLeaseId: 'lease-1',
        controlPlaneUrl: 'http://app.test/api/workspace/acme/codesite',
      },
    });
    fetchSpy.mockRestore();
    delete process.env.COLLAB_SERVER_URL;
  });

  it('does not forward caller-injected quarantine changes to the collab manifest endpoint', async () => {
    process.env.COLLAB_SERVER_URL = 'http://collab.test';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      replay: [{ path: 'docs/review.md' }],
      rejected: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const request = new Request('http://app.test/api/workspace/acme/codesite/quarantines/qtn-1/replay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        transactionId: 'txn-1',
        mutationLeaseId: 'lease-1',
        paths: ['docs/review.md'],
        changes: [{ path: 'secrets/override.txt', afterText: 'bad' }],
      }),
    });

    const response = await POST(request, params(['quarantines', 'qtn-1', 'replay']));

    expect(response.status).toBe(200);
    const forwarded = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(forwarded).toMatchObject({
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
      paths: ['docs/review.md'],
      userId: 'user-1',
      filesystemUserId: 'user-1',
    });
    expect(forwarded).not.toHaveProperty('changes');
    fetchSpy.mockRestore();
    delete process.env.COLLAB_SERVER_URL;
  });

  it('rejects quarantine proxy requests that impersonate a different runtime filesystem user', async () => {
    process.env.COLLAB_SERVER_URL = 'http://collab.test';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const request = new Request('http://app.test/api/workspace/acme/codesite/quarantines/qtn-1/replay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        transactionId: 'txn-1',
        paths: ['docs/review.md'],
        filesystemUserId: 'user-2',
      }),
    });

    const response = await POST(request, params(['quarantines', 'qtn-1', 'replay']));

    expect(response.status).toBe(403);
    expect(await json(response)).toEqual({
      error: 'codesite_runtime_identity_mismatch',
      detail: {
        field: 'filesystemUserId',
        actorUserId: 'user-1',
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    delete process.env.COLLAB_SERVER_URL;
  });

  it('keeps quarantine apply write-gated because it can mutate the workspace', async () => {
    canWriteScope.mockResolvedValue(false);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const request = new Request('http://app.test/api/workspace/acme/codesite/quarantines/qtn-1/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        transactionId: 'txn-1',
        paths: ['docs/review.md'],
      }),
    });

    const response = await POST(request, params(['quarantines', 'qtn-1', 'apply']));

    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(canWriteScope).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      { scope: 'workspace', workspaceSlug: 'acme' },
    );
    fetchSpy.mockRestore();
  });

  it('rejects quarantine replay without explicit selected paths before proxying', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const request = new Request('http://app.test/api/workspace/acme/codesite/quarantines/qtn-1/replay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        transactionId: 'txn-1',
        paths: [],
      }),
    });

    const response = await POST(request, params(['quarantines', 'qtn-1', 'replay']));

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({
      error: 'missing_selected_paths',
      detail: { quarantineId: 'qtn-1', action: 'replay' },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('uses forwarded host instead of a 0.0.0.0 bind origin for quarantine callbacks', async () => {
    process.env.COLLAB_SERVER_URL = 'http://collab.test';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      replay: [{ path: 'docs/review.md' }],
      rejected: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const request = new Request('http://0.0.0.0:3000/api/workspace/acme/codesite/quarantines/qtn-1/replay', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: 'codesite-proof-app:3000',
        'x-forwarded-proto': 'http',
      },
      body: JSON.stringify({
        transactionId: 'txn-1',
        paths: ['docs/review.md'],
      }),
    });

    const response = await POST(request, params(['quarantines', 'qtn-1', 'replay']));

    expect(response.status).toBe(200);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toMatchObject({
      codesite: {
        controlPlaneUrl: 'http://codesite-proof-app:3000/api/workspace/acme/codesite',
      },
    });
    fetchSpy.mockRestore();
  });

  it('reads project success metrics through the read-gated metrics endpoint', async () => {
    controlPlane.getCodeSiteMetrics.mockResolvedValue({
      schemaVersion: 'synthi.codesite.metrics.v1',
      projectId: 'proj-1',
      summary: { collisionsAvoided: 2 },
      sections: { atc: [] },
    });

    const response = await GET(new Request('http://test/api/workspace/acme/codesite/projects/proj-1/metrics'), params(['projects', 'proj-1', 'metrics']));

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      metrics: {
        schemaVersion: 'synthi.codesite.metrics.v1',
        projectId: 'proj-1',
        summary: { collisionsAvoided: 2 },
        sections: { atc: [] },
      },
    });
    expect(controlPlane.getCodeSiteMetrics).toHaveBeenCalledWith('acme', 'proj-1');
  });

  it('dispatches CodeSiteFS preflight events before external adapters mutate files', async () => {
    controlPlane.preflightCodeSiteFsWrite.mockResolvedValue({
      ok: false,
      disposition: 'write_denied',
      reasonCodes: ['active_clearance_required'],
    });
    const body = {
      path: 'backend/collab-server/terminalService.js',
      source: 'runtime_pod_terminal',
      tool: 'terminal_exec',
    };
    const request = new Request('http://test/api/workspace/acme/codesite/projects/proj-1/codesitefs-events', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const response = await POST(request, params(['projects', 'proj-1', 'codesitefs-events']));

    expect(response.status).toBe(201);
    expect(await json(response)).toEqual({
      ok: false,
      disposition: 'write_denied',
      reasonCodes: ['active_clearance_required'],
    });
    expect(controlPlane.preflightCodeSiteFsWrite).toHaveBeenCalledWith(
      'acme',
      'proj-1',
      body,
      expect.objectContaining({ userId: 'user-1' }),
    );
  });

  it('dispatches line provenance lookups with project and line filters', async () => {
    controlPlane.getLineProvenance.mockResolvedValue([{
      id: 'line-1',
      filePath: 'api/checkout/route.js',
      startLine: 42,
    }]);

    const response = await GET(
      new Request('http://test/api/workspace/acme/codesite/provenance/line?projectId=proj-1&filePath=api%2Fcheckout%2Froute.js&lineNumber=42'),
      params(['provenance', 'line']),
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      lineProvenance: [{ id: 'line-1', filePath: 'api/checkout/route.js', startLine: 42 }],
    });
    expect(controlPlane.getLineProvenance).toHaveBeenCalledWith('acme', {
      projectId: 'proj-1',
      filePath: 'api/checkout/route.js',
      lineAnchor: null,
      lineNumber: '42',
    });
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
    }, expect.objectContaining({ userId: 'user-1' }));
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

  it('passes the resolved actor through tower-mediated document routes', async () => {
    canWriteScope.mockResolvedValue(false);
    controlPlane.createDocument.mockResolvedValue({
      document: { id: 'doc-1', kind: 'rfi' },
      inboxItems: [{ id: 'inbox-1' }],
    });
    const body = {
      kind: 'rfi',
      fromSessionId: 'ags-1',
      toSessionId: 'ags-2',
      executionPlanId: 'plan-1',
      title: 'Need schema owner approval',
    };
    const request = new Request('http://test/api/workspace/acme/codesite/projects/proj-1/documents', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const response = await POST(request, params(['projects', 'proj-1', 'documents']));

    expect(response.status).toBe(201);
    expect(await json(response)).toEqual({
      document: { id: 'doc-1', kind: 'rfi' },
      inboxItems: [{ id: 'inbox-1' }],
    });
    expect(controlPlane.createDocument).toHaveBeenCalledWith(
      'acme',
      'proj-1',
      body,
      expect.objectContaining({ userId: 'user-1' }),
    );
    expect(canWriteScope).not.toHaveBeenCalled();
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
    expect(controlPlane.getSourceStateSince).toHaveBeenCalledWith(
      'acme',
      'txn-1',
      expect.objectContaining({ userId: 'user-1' }),
    );
    expect(controlPlane.validateTransaction).not.toHaveBeenCalled();
  });

  it('streams project events as server-sent events', async () => {
    controlPlane.getEvents.mockResolvedValueOnce([
      { id: 'a-later-event', logicalTime: 8, eventType: 'flight_plan_filed', displayCallsign: 'ATLAS-1' },
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
    expect(text).toContain('id: lt:8');
    expect(text).toContain('event: flight_plan_filed');
    expect(text).toContain('data:');
    expect(controlPlane.getEvents).toHaveBeenCalledWith('acme', 'proj-1', null);
  });

  it('passes the resolved actor through agent inbox read and ack routes', async () => {
    canWriteScope.mockResolvedValue(false);
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
    expect(canWriteScope).not.toHaveBeenCalled();
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
