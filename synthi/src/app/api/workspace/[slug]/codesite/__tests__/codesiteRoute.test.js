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
    abortTransaction: vi.fn(),
    acknowledgeInboxItem: vi.fn(),
    attachAgentSession: vi.fn(),
    commitTransaction: vi.fn(),
    createAgentKnowledgeItem: vi.fn(),
    listProjects: vi.fn(),
    createDocument: vi.fn(),
    createProject: vi.fn(),
    dryRunTransactionWrites: vi.fn(),
    detachAgentSession: vi.fn(),
    eventCursor: vi.fn(),
    getEvents: vi.fn(),
    getControlState: vi.fn(),
    getCodeSiteMetrics: vi.fn(),
    getAgentInbox: vi.fn(),
    getAgentSharedKnowledge: vi.fn(),
    recordPolicyDecision: vi.fn(),
    recordTransactionWrite: vi.fn(),
    getLineProvenance: vi.fn(),
    heartbeatAgentSession: vi.fn(),
    getProject: vi.fn(),
    getRelevantAgentContext: vi.fn(),
    getSourceStateSince: vi.fn(),
    listActiveTransactions: vi.fn(),
    listProjectKnowledge: vi.fn(),
    listProjectMembers: vi.fn(),
    openTransaction: vi.fn(),
    preflightCodeSiteFsWrite: vi.fn(),
    recordTransactionRead: vi.fn(),
    validateTransaction: vi.fn(),
    recordTransactionQuarantineEvent: vi.fn(),
    resumeMaydayIncident: vi.fn(),
    respondToAgentKnowledgeInbox: vi.fn(),
    revokeProjectMember: vi.fn(),
    shadowMergeSimulate: vi.fn(),
    upsertProjectMember: vi.fn(),
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
    'attachAgentSession',
    'collisionPredict',
    'commitTransaction',
    'completeInspectionRun',
    'createAgentKnowledgeItem',
    'createAgentSession',
    'createCounterfactualRun',
    'createDocument',
    'createExecutionPlan',
    'createIncident',
    'createInspectionRun',
    'createPolicyDelta',
    'createProject',
    'dryRunTransactionWrites',
    'detachAgentSession',
    'eventCursor',
    'exportArtifacts',
    'getAgentInbox',
    'getAgentManifest',
    'getAgentSharedKnowledge',
    'getCodeSiteMetrics',
    'getControlState',
    'getEvents',
    'getIncidentReplay',
    'getLineProvenance',
    'heartbeatAgentSession',
    'getProofBundle',
    'getProject',
    'getRelevantAgentContext',
    'getSchemas',
    'getSourceStateSince',
    'getTransaction',
    'listActiveTransactions',
    'listProjectKnowledge',
    'listProjectMembers',
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
    'resumeMaydayIncident',
    'respondToAgentKnowledgeInbox',
    'revokeProjectMember',
    'shadowMergeSimulate',
    'updateControlPlan',
    'updateZonePolicy',
    'upsertProjectMember',
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
    delete process.env.COLLAB_INTERNAL_TOKEN;
    delete process.env.SYNTHI_CODESITE_TOKEN;
    delete process.env.SYNTHI_APP_INTERNAL_URL;
  });

  it('proves both authenticated readiness directions without exposing secret material', async () => {
    process.env.COLLAB_SERVER_URL = 'http://collab.test';
    process.env.COLLAB_INTERNAL_TOKEN = 'collab-readiness-secret';
    process.env.SYNTHI_CODESITE_TOKEN = 'control-plane-readiness-secret';
    process.env.SYNTHI_CODESITE_API_BASE_URL = 'http://frontend.test/api/workspace/{workspace_slug}/codesite';
    let publishedTransactionId = null;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      if (options.method === 'GET') {
        return new Response(JSON.stringify({
          activeTransactions: [{ transactionId: publishedTransactionId }],
        }), { status: 200 });
      }
      const payload = JSON.parse(options.body);
      if (payload.event === 'transaction_opened') publishedTransactionId = payload.transactionId;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await GET(new Request(
      'http://frontend.test/api/workspace/__codesite_readiness__/codesite/readiness',
      { headers: { authorization: 'Bearer control-plane-readiness-secret' } },
    ), { params: Promise.resolve({ slug: '__codesite_readiness__', path: ['readiness'] }) });
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      checks: { controlPlaneReachable: true, activityBridgeReachable: true },
    });
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls[0][0]).toEqual(new URL('http://collab.test/codesite/activity/__codesite_readiness__'));
    expect(fetchSpy.mock.calls[0][1].headers['x-collab-internal-token']).toBe('collab-readiness-secret');
    fetchSpy.mockRestore();
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

  it('publishes project deployment status from live control-plane, bridge, inbox, and runtime checks', async () => {
    controlPlane.getProject.mockResolvedValue({ id: 'proj-1', inboxItems: [] });
    process.env.COLLAB_SERVER_URL = 'http://collab.test';
    process.env.COLLAB_INTERNAL_TOKEN = 'collab-status-secret';
    process.env.SYNTHI_CODESITE_API_BASE_URL = 'http://frontend.test/api/workspace/{workspace_slug}/codesite';
    let publishedTransactionId;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      const target = new URL(url);
      if (target.pathname === '/codesite/deployment-status') {
        return new Response(JSON.stringify({
          ok: true,
          checks: {
            overlayCapable: { ok: true, code: 'docker_overlay_runtime_ready' },
            runtimeEventAdapterHealthy: { ok: false, code: 'runtime_event_adapter_unconfigured' },
          },
        }), { status: 200 });
      }
      if (options.method === 'GET') {
        return new Response(JSON.stringify({
          activeTransactions: [{ transactionId: publishedTransactionId }],
        }), { status: 200 });
      }
      const payload = JSON.parse(options.body);
      if (payload.event === 'transaction_opened') publishedTransactionId = payload.transactionId;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await GET(
      new Request('http://frontend.test/api/workspace/acme/codesite/projects/proj-1/deployment-status'),
      params(['projects', 'proj-1', 'deployment-status']),
    );
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body.status).toBe('degraded');
    expect(body.checks).toEqual({
      controlPlaneReachable: { ok: true, code: 'project_query_succeeded' },
      activityBridgeReachable: { ok: true, code: 'authenticated_activity_round_trip_succeeded' },
      overlayCapable: { ok: true, code: 'docker_overlay_runtime_ready' },
      inboxDeliveryCapable: { ok: true, code: 'durable_inbox_query_succeeded' },
      runtimeEventAdapterHealthy: { ok: false, code: 'runtime_event_adapter_unconfigured' },
    });
    expect(controlPlane.getProject).toHaveBeenCalledWith('acme', 'proj-1', expect.objectContaining({ userId: 'user-1' }));
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    fetchSpy.mockRestore();
  });

  it('lists active transactions through the shared control-plane endpoint', async () => {
    controlPlane.listActiveTransactions.mockResolvedValue([
      {
        id: 'txn-1',
        mutationLeaseId: 'lease-1',
        agentSessionId: 'agent-1',
        actorUserId: 'user-1',
        effectiveUserId: 'user-1',
        status: 'open',
      },
      {
        id: 'txn-blocked',
        mutationLeaseId: 'lease-2',
        agentSessionId: 'agent-2',
        actorUserId: 'user-1',
        effectiveUserId: 'user-1',
        status: 'blocked',
      },
    ]);

    const response = await GET(new Request('http://test/api/workspace/acme/codesite/transactions/active'), params(['transactions', 'active']));

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      activeTransactions: [
        {
          id: 'txn-1',
          mutationLeaseId: 'lease-1',
          agentSessionId: 'agent-1',
          actorUserId: 'user-1',
          effectiveUserId: 'user-1',
          status: 'open',
        },
        {
          id: 'txn-blocked',
          mutationLeaseId: 'lease-2',
          agentSessionId: 'agent-2',
          actorUserId: 'user-1',
          effectiveUserId: 'user-1',
          status: 'blocked',
        },
      ],
    });
    expect(controlPlane.listActiveTransactions).toHaveBeenCalledWith(
      'acme',
      expect.objectContaining({ userId: 'user-1' }),
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

  it('allows only the internal collaboration service to attach a verified agent lifecycle', async () => {
    process.env.SYNTHI_CODESITE_TOKEN = 'agent-lifecycle-secret';
    controlPlane.attachAgentSession.mockResolvedValue({
      resumed: false,
      session: { id: 'agent-1', status: 'attached' },
      event: { eventType: 'agent_attached' },
    });
    const body = {
      ownerUserId: 'user-1',
      collaborationUserId: 'user-1',
      effectiveWorkspaceUserId: 'shared-owner',
      collaborationSessionId: 'collab-session-1',
      collaborationMembershipVerified: true,
      terminalSessionId: 'terminal-1',
      runtimeScope: 'shared-workspace',
      agentProvider: 'codex',
      providerSessionRef: 'codex-session-1',
    };

    const response = await POST(new Request(
      'http://test/api/workspace/acme/codesite/projects/project-1/agent-sessions/attach',
      {
        method: 'POST',
        headers: { authorization: 'Bearer agent-lifecycle-secret' },
        body: JSON.stringify(body),
      },
    ), params(['projects', 'project-1', 'agent-sessions', 'attach']));

    expect(response.status).toBe(201);
    expect(await json(response)).toMatchObject({ session: { id: 'agent-1', status: 'attached' } });
    expect(controlPlane.attachAgentSession).toHaveBeenCalledWith('acme', 'project-1', body, {
      internalService: true,
      collaborationMembershipVerified: true,
      actorUserId: 'user-1',
      collaborationUserId: 'user-1',
      effectiveWorkspaceUserId: 'shared-owner',
      collaborationSessionId: 'collab-session-1',
      runtimeScope: 'shared-workspace',
    });

    const denied = await POST(new Request(
      'http://test/api/workspace/acme/codesite/projects/project-1/agent-sessions/attach',
      { method: 'POST', body: JSON.stringify(body) },
    ), params(['projects', 'project-1', 'agent-sessions', 'attach']));
    expect(denied.status).toBe(403);
    expect(await json(denied)).toEqual({ error: 'agent_lifecycle_internal_auth_required' });
  });

  it('routes exact-bound heartbeat and detach calls for the internal collaboration service', async () => {
    process.env.SYNTHI_CODESITE_TOKEN = 'agent-lifecycle-secret';
    const body = {
      ownerUserId: 'user-1',
      collaborationUserId: 'member-1',
      effectiveWorkspaceUserId: 'shared-owner',
      collaborationSessionId: 'collab-session-1',
      collaborationMembershipVerified: true,
      terminalSessionId: 'terminal-1',
      runtimeScope: 'shared-workspace',
      agentProvider: 'codex',
      providerSessionRef: 'codex-session-1',
    };
    const authority = {
      internalService: true,
      collaborationMembershipVerified: true,
      actorUserId: 'user-1',
      collaborationUserId: 'member-1',
      effectiveWorkspaceUserId: 'shared-owner',
      collaborationSessionId: 'collab-session-1',
      runtimeScope: 'shared-workspace',
    };
    controlPlane.heartbeatAgentSession.mockResolvedValue({ session: { id: 'agent-1', status: 'attached' } });
    controlPlane.detachAgentSession.mockResolvedValue({ session: { id: 'agent-1', status: 'detached' } });

    const heartbeat = await POST(new Request(
      'http://test/api/workspace/acme/codesite/agent-sessions/agent-1/heartbeat',
      {
        method: 'POST',
        headers: { authorization: 'Bearer agent-lifecycle-secret' },
        body: JSON.stringify(body),
      },
    ), params(['agent-sessions', 'agent-1', 'heartbeat']));
    expect(heartbeat.status).toBe(200);
    expect(controlPlane.heartbeatAgentSession).toHaveBeenCalledWith('acme', 'agent-1', body, authority);

    const detachBody = { ...body, reason: 'terminal_exit', ended: true };
    const detach = await POST(new Request(
      'http://test/api/workspace/acme/codesite/agent-sessions/agent-1/detach',
      {
        method: 'POST',
        headers: { authorization: 'Bearer agent-lifecycle-secret' },
        body: JSON.stringify(detachBody),
      },
    ), params(['agent-sessions', 'agent-1', 'detach']));
    expect(detach.status).toBe(200);
    expect(controlPlane.detachAgentSession).toHaveBeenCalledWith('acme', 'agent-1', detachBody, authority);
  });

  it('authorizes relevant context with only the scoped agent credential', async () => {
    controlPlane.getRelevantAgentContext.mockResolvedValue({
      contextVersion: 'synthi.codesite.agentContext.v1',
      agent: { id: 'agent-1' },
    });
    const response = await GET(new Request(
      'http://test/api/workspace/acme/codesite/agent-sessions/agent-1/relevant-context',
      { headers: { authorization: 'Bearer csa_agent_scoped_token' } },
    ), params(['agent-sessions', 'agent-1', 'relevant-context']));

    expect(response.status).toBe(200);
    expect(controlPlane.getRelevantAgentContext).toHaveBeenCalledWith('acme', 'agent-1', 'csa_agent_scoped_token');
    expect(resolveActor).not.toHaveBeenCalled();
  });

  it('reads shared knowledge with only the environment-bound agent credential', async () => {
    controlPlane.getAgentSharedKnowledge.mockResolvedValue([
      { id: 'knowledge-1', kind: 'discovery', status: 'verified' },
    ]);
    const response = await GET(new Request(
      'http://test/api/workspace/acme/codesite/agent-sessions/agent-1/knowledge?kind=discovery&status=verified&limit=25',
      { headers: { authorization: 'Bearer csa_agent_scoped_token' } },
    ), params(['agent-sessions', 'agent-1', 'knowledge']));

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      knowledge: [{ id: 'knowledge-1', kind: 'discovery', status: 'verified' }],
    });
    expect(controlPlane.getAgentSharedKnowledge).toHaveBeenCalledWith(
      'acme',
      'agent-1',
      'csa_agent_scoped_token',
      { kind: 'discovery', status: 'verified', limit: '25' },
    );
    expect(resolveActor).not.toHaveBeenCalled();
    expect(canReadScope).not.toHaveBeenCalled();
  });

  it('creates shared knowledge with only the environment-bound agent credential', async () => {
    const body = {
      kind: 'discovery',
      title: 'Turn contract changed',
      summary: 'The producer now emits v2.',
      confidence: 0.94,
    };
    controlPlane.createAgentKnowledgeItem.mockResolvedValue({
      knowledge: { id: 'knowledge-1', kind: 'discovery' },
      impacts: [],
      duplicate: false,
    });
    const response = await POST(new Request(
      'http://test/api/workspace/acme/codesite/agent-sessions/agent-1/knowledge',
      {
        method: 'POST',
        headers: { authorization: 'Bearer csa_agent_scoped_token' },
        body: JSON.stringify(body),
      },
    ), params(['agent-sessions', 'agent-1', 'knowledge']));

    expect(response.status).toBe(201);
    expect(controlPlane.createAgentKnowledgeItem).toHaveBeenCalledWith(
      'acme',
      'agent-1',
      'csa_agent_scoped_token',
      body,
    );
    expect(resolveActor).not.toHaveBeenCalled();
    expect(canWriteScope).not.toHaveBeenCalled();
    expect(checkLimit).not.toHaveBeenCalled();
  });

  it('routes an agent impact response before the legacy inbox acknowledgement', async () => {
    const body = {
      action: 'rebase_requested',
      reason: 'The consumer transaction is stale.',
      evidence_refs: ['txn:consumer-1'],
    };
    controlPlane.respondToAgentKnowledgeInbox.mockResolvedValue({
      inboxItem: { id: 'inbox/1', status: 'responded' },
      response: body,
      duplicate: false,
    });
    const response = await POST(new Request(
      'http://test/api/workspace/acme/codesite/agent-sessions/agent-1/inbox/inbox%2F1/respond',
      {
        method: 'POST',
        headers: { authorization: 'Bearer csa_agent_scoped_token' },
        body: JSON.stringify(body),
      },
    ), params(['agent-sessions', 'agent-1', 'inbox', 'inbox/1', 'respond']));

    expect(response.status).toBe(200);
    expect(controlPlane.respondToAgentKnowledgeInbox).toHaveBeenCalledWith(
      'acme',
      'agent-1',
      'inbox/1',
      'csa_agent_scoped_token',
      body,
    );
    expect(controlPlane.acknowledgeInboxItem).not.toHaveBeenCalled();
    expect(resolveActor).not.toHaveBeenCalled();
    expect(canReadScope).not.toHaveBeenCalled();
    expect(checkLimit).not.toHaveBeenCalled();
  });

  it('keeps human project knowledge reads behind ordinary actor authorization', async () => {
    controlPlane.listProjectKnowledge.mockResolvedValue([
      { id: 'knowledge-1', kind: 'shared_skill', status: 'published' },
    ]);
    const response = await GET(new Request(
      'http://test/api/workspace/acme/codesite/projects/project-1/knowledge?kind=shared_skill&limit=10',
    ), params(['projects', 'project-1', 'knowledge']));

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      knowledge: [{ id: 'knowledge-1', kind: 'shared_skill', status: 'published' }],
    });
    expect(resolveActor).toHaveBeenCalledTimes(1);
    expect(canReadScope).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      { scope: 'workspace', workspaceSlug: 'acme' },
    );
    expect(controlPlane.listProjectKnowledge).toHaveBeenCalledWith(
      'acme',
      'project-1',
      { kind: 'shared_skill', limit: '10' },
      expect.objectContaining({ userId: 'user-1' }),
    );
  });

  it('uses agent credential bypasses only for exact knowledge route lengths', async () => {
    const extraGet = await GET(new Request(
      'http://test/api/workspace/acme/codesite/agent-sessions/agent-1/knowledge/extra',
      { headers: { authorization: 'Bearer csa_agent_scoped_token' } },
    ), params(['agent-sessions', 'agent-1', 'knowledge', 'extra']));
    const extraCreate = await POST(new Request(
      'http://test/api/workspace/acme/codesite/agent-sessions/agent-1/knowledge/extra',
      {
        method: 'POST',
        headers: { authorization: 'Bearer csa_agent_scoped_token' },
        body: JSON.stringify({}),
      },
    ), params(['agent-sessions', 'agent-1', 'knowledge', 'extra']));
    const extraRespond = await POST(new Request(
      'http://test/api/workspace/acme/codesite/agent-sessions/agent-1/inbox/inbox-1/respond/extra',
      {
        method: 'POST',
        headers: { authorization: 'Bearer csa_agent_scoped_token' },
        body: JSON.stringify({}),
      },
    ), params(['agent-sessions', 'agent-1', 'inbox', 'inbox-1', 'respond', 'extra']));

    expect(extraGet.status).toBe(404);
    expect(extraCreate.status).toBe(404);
    expect(extraRespond.status).toBe(404);
    expect(resolveActor).toHaveBeenCalledTimes(3);
    expect(controlPlane.getAgentSharedKnowledge).not.toHaveBeenCalled();
    expect(controlPlane.createAgentKnowledgeItem).not.toHaveBeenCalled();
    expect(controlPlane.respondToAgentKnowledgeInbox).not.toHaveBeenCalled();
    expect(controlPlane.acknowledgeInboxItem).not.toHaveBeenCalled();
  });

  it('notifies collab when a CodeSite transaction opens', async () => {
    process.env.COLLAB_SERVER_URL = 'http://collab.test';
    process.env.COLLAB_INTERNAL_TOKEN = 'collab-internal-test-token';
    controlPlane.openTransaction.mockResolvedValue({
      id: 'txn-1',
      mutationLeaseId: 'lease-1',
      agentSessionId: 'agent-1',
      status: 'open',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const request = new Request('http://app.test/api/workspace/acme/codesite/mutation-leases/lease-1/transactions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ readSet: ['src/app.js'], writeSet: ['src/app.js'] }),
    });

    const response = await POST(request, params(['mutation-leases', 'lease-1', 'transactions']));

    expect(response.status).toBe(201);
    expect(await json(response)).toEqual({
      transaction: {
        id: 'txn-1',
        mutationLeaseId: 'lease-1',
        agentSessionId: 'agent-1',
        status: 'open',
      },
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      new URL('http://collab.test/codesite/activity/acme'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          'x-user-id': 'user-1',
          'x-codesite-control-plane-url': 'http://app.test/api/workspace/acme/codesite',
          'x-collab-internal-token': 'collab-internal-test-token',
        }),
      }),
    );
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toMatchObject({
      event: 'transaction_opened',
      workspaceSlug: 'acme',
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
      agentSessionId: 'agent-1',
      status: 'open',
      actorUserId: 'user-1',
      effectiveUserId: 'user-1',
      source: 'next_codesite_route',
    });
    fetchSpy.mockRestore();
    delete process.env.COLLAB_SERVER_URL;
    delete process.env.COLLAB_INTERNAL_TOKEN;
  });

  it('notifies collab when a CodeSite transaction closes through commit', async () => {
    process.env.COLLAB_SERVER_URL = 'http://collab.test';
    process.env.COLLAB_INTERNAL_TOKEN = 'collab-internal-test-token';
    controlPlane.commitTransaction.mockResolvedValue({
      decision: { ok: true },
      transaction: {
        id: 'txn-1',
        mutationLeaseId: 'lease-1',
        agentSessionId: 'agent-1',
        status: 'committed',
        proofBundleDigest: 'bundle-digest-1',
      },
      proofBundle: { bundleDigest: 'bundle-digest-1' },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const request = new Request('http://app.test/api/workspace/acme/codesite/transactions/txn-1/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commitSha: 'abc123' }),
    });

    const response = await POST(request, params(['transactions', 'txn-1', 'commit']));

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      decision: { ok: true },
      transaction: {
        id: 'txn-1',
        mutationLeaseId: 'lease-1',
        agentSessionId: 'agent-1',
        status: 'committed',
        proofBundleDigest: 'bundle-digest-1',
      },
      proofBundle: { bundleDigest: 'bundle-digest-1' },
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      new URL('http://collab.test/codesite/activity/acme'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-collab-internal-token': 'collab-internal-test-token',
        }),
      }),
    );
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toMatchObject({
      event: 'transaction_committed',
      workspaceSlug: 'acme',
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
      agentSessionId: 'agent-1',
      status: 'committed',
      proofBundleDigest: 'bundle-digest-1',
      actorUserId: 'user-1',
      effectiveUserId: 'user-1',
    });
    fetchSpy.mockRestore();
    delete process.env.COLLAB_SERVER_URL;
    delete process.env.COLLAB_INTERNAL_TOKEN;
  });

  it('keeps collab activity active when commit validation blocks landing', async () => {
    process.env.COLLAB_SERVER_URL = 'http://collab.test';
    process.env.COLLAB_INTERNAL_TOKEN = 'collab-internal-test-token';
    controlPlane.commitTransaction.mockResolvedValue({
      decision: { ok: false, reasonCodes: ['repo_snapshot_changed'] },
      transaction: {
        id: 'txn-1',
        mutationLeaseId: 'lease-1',
        agentSessionId: 'agent-1',
        status: 'blocked',
      },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const request = new Request('http://app.test/api/workspace/acme/codesite/transactions/txn-1/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commitSha: 'abc123' }),
    });

    const response = await POST(request, params(['transactions', 'txn-1', 'commit']));

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      decision: { ok: false, reasonCodes: ['repo_snapshot_changed'] },
      transaction: {
        id: 'txn-1',
        mutationLeaseId: 'lease-1',
        agentSessionId: 'agent-1',
        status: 'blocked',
      },
    });
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toMatchObject({
      event: 'transaction_blocked',
      workspaceSlug: 'acme',
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
      agentSessionId: 'agent-1',
      status: 'blocked',
      proofBundleDigest: null,
      actorUserId: 'user-1',
      effectiveUserId: 'user-1',
    });
    fetchSpy.mockRestore();
    delete process.env.COLLAB_SERVER_URL;
    delete process.env.COLLAB_INTERNAL_TOKEN;
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

  it('keeps shadow merge simulation write-gated because it records counterfactual evidence', async () => {
    canWriteScope.mockResolvedValue(false);
    const request = new Request('http://test/api/workspace/acme/codesite/projects/proj-1/shadow-merge-simulate', {
      method: 'POST',
      body: JSON.stringify({ strategies: ['schema-first'] }),
    });

    const response = await POST(request, params(['projects', 'proj-1', 'shadow-merge-simulate']));

    expect(response.status).toBe(403);
    expect(controlPlane.shadowMergeSimulate).not.toHaveBeenCalled();
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

  it('dispatches transaction read records to the control plane', async () => {
    controlPlane.recordTransactionRead.mockResolvedValue({
      id: 'txn-1',
      observedReadSet: ['openapi/auth.yaml'],
    });
    const request = new Request('http://test/api/workspace/acme/codesite/transactions/txn-1/record-read', {
      method: 'POST',
      body: JSON.stringify({ path: 'openapi/auth.yaml' }),
    });

    const response = await POST(request, params(['transactions', 'txn-1', 'record-read']));

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      transaction: {
        id: 'txn-1',
        observedReadSet: ['openapi/auth.yaml'],
      },
    });
    expect(controlPlane.recordTransactionRead).toHaveBeenCalledWith(
      'acme',
      'txn-1',
      { path: 'openapi/auth.yaml' },
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

  it('returns an empty quarantine list when the runtime manifest is unavailable', async () => {
    process.env.COLLAB_SERVER_URL = 'http://collab.test';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Object.assign(new Error('connect failed'), {
      cause: { code: 'ECONNREFUSED' },
    }));

    const response = await GET(
      new Request('http://app.test/api/workspace/acme/codesite/quarantines?transactionId=txn-1'),
      params(['quarantines']),
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      ok: false,
      quarantines: [],
      quarantine: null,
      unavailable: true,
      error: 'quarantine_runtime_unavailable',
      detail: {
        target: 'http://collab.test',
        reason: 'ECONNREFUSED',
      },
    });
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
    expect(controlPlane.getCodeSiteMetrics).toHaveBeenCalledWith('acme', 'proj-1', expect.objectContaining({ userId: 'user-1' }));
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
    }, expect.objectContaining({ userId: 'user-1' }));
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
    }, expect.objectContaining({ userId: 'user-1' }));
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
    const response = await GET(
      new Request('http://test/api/workspace/acme/codesite/projects/proj-1/events/stream'),
      params(['projects', 'proj-1', 'events', 'stream']),
    );
    const reader = response.body.getReader();
    const chunk = await reader.read();
    await reader.cancel().catch(() => {});
    const text = new TextDecoder().decode(chunk.value);

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(text).toContain('id: lt:8');
    expect(text).toContain('event: flight_plan_filed');
    expect(text).toContain('data:');
    expect(controlPlane.getEvents).toHaveBeenCalledWith('acme', 'proj-1', null, expect.objectContaining({ userId: 'user-1' }));
  });

  it('stops project event streams cleanly when the client cancels during load', async () => {
    let resolveEvents;
    controlPlane.getEvents.mockImplementationOnce(() => new Promise((resolve) => {
      resolveEvents = resolve;
    }));

    const response = await GET(
      new Request('http://test/api/workspace/acme/codesite/projects/proj-1/events/stream'),
      params(['projects', 'proj-1', 'events', 'stream']),
    );
    const reader = response.body.getReader();
    const read = reader.read();

    await reader.cancel();
    resolveEvents([
      { id: 'late-event', logicalTime: 9, eventType: 'flight_plan_filed', displayCallsign: 'ATLAS-1' },
    ]);

    await expect(read).resolves.toEqual(expect.objectContaining({ done: true }));
    expect(controlPlane.getEvents).toHaveBeenCalledWith('acme', 'proj-1', null, expect.objectContaining({ userId: 'user-1' }));
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
