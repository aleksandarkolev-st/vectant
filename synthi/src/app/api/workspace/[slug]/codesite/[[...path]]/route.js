import {
  abortTransaction,
  acknowledgeInboxItem,
  attachAgentSession,
  attachProofBundleCommit,
  collisionPredict,
  commitTransaction,
  completeInspectionRun,
  createAgentKnowledgeItem,
  createAgentSession,
  createCounterfactualRun,
  createDocument,
  createExecutionPlan,
  createIncident,
  createInspectionRun,
  createPermit,
  createPolicyDelta,
  createProject,
  applyRouteRevision,
  dryRunTransactionWrites,
  detachAgentSession,
  eventCursor,
  exportArtifacts,
  getAgentInbox,
  getAgentManifest,
  getAgentSharedKnowledge,
  getControlState,
  getEvents,
  getIncidentReplay,
  getLineProvenance,
  getCodeSiteMetrics,
  getProofBundle,
  getProject,
  getRelevantAgentContext,
  recordAgentProjectObservation,
  createAgentExecutionPlan,
  recordRuntimeProjectObservation,
  getSchemas,
  getSourceStateSince,
  getTransaction,
  getWorkspaceActiveState,
  heartbeatAgentSession,
  listActiveTransactions,
  listPermits,
  listProjectKnowledge,
  listProjectMembers,
  listProjects,
  listRouteRevisions,
  openTransaction,
  preflightCodeSiteFsWrite,
  recordPolicyDecision,
  recordAssumption,
  recordTransactionQuarantineEvent,
  recordTransactionRead,
  recordTransactionWrite,
  proposeRouteRevision,
  requestMutationLease,
  resumeMaydayIncident,
  respondToAgentKnowledgeInbox,
  previewArtifacts,
  promotePolicyDelta,
  revokeProjectMember,
  revokeMutationLease,
  rejectPolicyDelta,
  reviewDocument,
  reviewRouteRevision,
  shadowMergeSimulate,
  upsertProjectMember,
  updateControlPlan,
  updateZonePolicy,
  validateTransaction,
} from '@/lib/codesite/controlPlane';
import {
  probeCodeSiteActivityBridge,
  probeCodeSiteDeploymentStatus,
} from '@/lib/codesite/activityBridgeReadiness';
import {
  enforceRateLimit,
  errorJson,
  handleCodesiteError,
  methodNotAllowed,
  okJson,
  parsePath,
  readJson,
  requireCodesiteAccess,
  routeNotFound,
} from '@/lib/codesite/routeHelpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request, { params }) {
  const { slug, path } = await params;
  const route = parsePath(path);
  if (route[0] === 'agent-sessions' && route[2] === 'relevant-context' && route.length === 3) {
    try {
      return okJson(await getRelevantAgentContext(slug, route[1], bearerToken(request)));
    } catch (error) {
      return handleCodesiteError(error);
    }
  }
  if (route[0] === 'agent-sessions' && route[2] === 'knowledge' && route.length === 3) {
    try {
      return okJson({
        knowledge: await getAgentSharedKnowledge(
          slug,
          route[1],
          bearerToken(request),
          requestQuery(request),
        ),
      });
    } catch (error) {
      return handleCodesiteError(error);
    }
  }
  const access = await requireCodesiteAccess(slug, 'read', request);
  if (!access.ok) return errorJson(access.status, access.error);

  try {
    if (route[0] === 'readiness' && route.length === 1) {
      if (!access.actor?.internalService) return errorJson(403, 'codesite_readiness_internal_auth_required');
      const bridge = await probeCodeSiteActivityBridge(request);
      return okJson({
        ok: bridge.ok,
        checks: {
          controlPlaneReachable: true,
          activityBridgeReachable: bridge.ok,
        },
        ...(bridge.ok ? {} : { code: bridge.code || 'activity_bridge_unavailable' }),
      }, { status: bridge.ok ? 200 : 503 });
    }

    if (route.length === 0 || route.join('/') === 'projects') {
      return okJson({ projects: await listProjects(slug, access.actor) });
    }

    if (route[0] === 'projects' && route.length === 2) {
      const project = await getProject(slug, route[1], access.actor);
      if (!project) return errorJson(404, 'project_not_found');
      return okJson({ project });
    }

    if (route[0] === 'projects' && route[2] === 'knowledge' && route.length === 3) {
      return okJson({
        knowledge: await listProjectKnowledge(slug, route[1], requestQuery(request), access.actor),
      });
    }

    if (route[0] === 'projects' && route[2] === 'deployment-status' && route.length === 3) {
      // PROJECT_INCLUDE reads the durable inbox relation, so a successful
      // project read proves both authorization and inbox-store reachability.
      const project = await getProject(slug, route[1], access.actor);
      if (!project) return errorJson(404, 'project_not_found');
      const serviceStatus = await probeCodeSiteDeploymentStatus(request);
      const checks = {
        controlPlaneReachable: { ok: true, code: 'project_query_succeeded' },
        activityBridgeReachable: {
          ok: serviceStatus.activityBridge.ok,
          code: serviceStatus.activityBridge.ok
            ? 'authenticated_activity_round_trip_succeeded'
            : (serviceStatus.activityBridge.code || 'activity_bridge_unavailable'),
        },
        overlayCapable: serviceStatus.capabilities.checks.overlayCapable,
        inboxDeliveryCapable: { ok: true, code: 'durable_inbox_query_succeeded' },
        runtimeEventAdapterHealthy: serviceStatus.capabilities.checks.runtimeEventAdapterHealthy,
      };
      return okJson({
        status: Object.values(checks).every((check) => check.ok) ? 'healthy' : 'degraded',
        checkedAt: new Date().toISOString(),
        checks,
      });
    }

    if (route[0] === 'projects' && route[2] === 'control-state') {
      return okJson(await getControlState(slug, route[1], access.actor));
    }

    if (route[0] === 'projects' && route[2] === 'metrics') {
      return okJson({ metrics: await getCodeSiteMetrics(slug, route[1], access.actor) });
    }

    if (route[0] === 'projects' && route[2] === 'members') {
      return okJson({ members: await listProjectMembers(slug, route[1], access.actor) });
    }

    if (route[0] === 'projects' && route[2] === 'permits') {
      return okJson({ permits: await listPermits(slug, route[1], access.actor) });
    }

    if (route[0] === 'projects' && route[2] === 'route-revisions') {
      return okJson({ routeRevisions: await listRouteRevisions(slug, route[1], access.actor) });
    }

    if (route[0] === 'projects' && route[2] === 'events' && route[3] !== 'stream') {
      const since = new URL(request.url).searchParams.get('since');
      return okJson({ events: await getEvents(slug, route[1], since, access.actor) });
    }

    if (route[0] === 'projects' && route[2] === 'events' && route[3] === 'stream') {
      return eventStreamResponse({
        signal: request.signal,
        initialSince: new URL(request.url).searchParams.get('since'),
        load: (since) => getEvents(slug, route[1], since, access.actor),
        eventName: (event) => event.eventType || 'codesite_event',
        idOf: eventCursor,
      });
    }

    if (route[0] === 'projects' && route[2] === 'agent-manifest') {
      return okJson(await getAgentManifest(slug, route[1], access.actor));
    }

    if (route[0] === 'projects' && route[2] === 'schemas') {
      return okJson(await getSchemas());
    }

    if (route[0] === 'projects' && route[2] === 'artifacts' && route[3] === 'preview') {
      const search = new URL(request.url).searchParams;
      const maxContentBytes = Number(search.get('maxContentBytes') || search.get('max_content_bytes') || NaN);
      return okJson(await previewArtifacts(slug, route[1], {
        includeContent: search.get('include') === 'content',
        ...(Number.isFinite(maxContentBytes) ? { maxContentBytes } : {}),
      }, access.actor));
    }

    if (route[0] === 'transactions' && route[1] === 'active' && route.length === 2) {
      return okJson({ activeTransactions: await listActiveTransactions(slug, access.actor) });
    }

    if (route[0] === 'active-state' && route.length === 1) {
      return okJson(await getWorkspaceActiveState(slug, access.actor));
    }

    if (route[0] === 'transactions' && route.length === 2) {
      const transaction = await getTransaction(slug, route[1], access.actor);
      if (!transaction) return errorJson(404, 'transaction_not_found');
      return okJson({ transaction });
    }

    if (route[0] === 'transactions' && route[2] === 'status') {
      const transaction = await getTransaction(slug, route[1], access.actor);
      if (!transaction) return errorJson(404, 'transaction_not_found');
      return okJson({ status: transaction.status, transaction });
    }

    if (route[0] === 'transactions' && route[2] === 'source-state-since') {
      return okJson(await getSourceStateSince(slug, route[1], access.actor));
    }

    if (route[0] === 'agent-sessions' && route[2] === 'inbox' && route[3] === 'stream') {
      return eventStreamResponse({
        signal: request.signal,
        load: () => getAgentInbox(slug, route[1], access.actor),
        eventName: () => 'codesite_inbox',
        idOf: (item) => item.eventId || item.id,
      });
    }

    if (route[0] === 'agent-sessions' && route[2] === 'inbox') {
      return okJson({ inbox: await getAgentInbox(slug, route[1], access.actor) });
    }

    if (route[0] === 'quarantines' && route.length <= 2) {
      return proxyCodeSiteQuarantine(request, slug, route, access.actor);
    }

    if (route[0] === 'provenance' && route[1] === 'line') {
      const search = new URL(request.url).searchParams;
      return okJson({
        lineProvenance: await getLineProvenance(slug, {
          projectId: search.get('projectId') || search.get('project_id'),
          filePath: search.get('filePath') || search.get('path'),
          lineAnchor: search.get('lineAnchor'),
          lineNumber: search.get('lineNumber') || search.get('line'),
        }, access.actor),
      });
    }

    if (route[0] === 'proof-bundles' && route[1]) {
      return okJson({ proofBundle: await getProofBundle(slug, route[1], access.actor) });
    }

    if (route[0] === 'incidents' && route[2] === 'replay') {
      return okJson(await getIncidentReplay(slug, route[1], access.actor));
    }

    return routeNotFound(route);
  } catch (error) {
    return handleCodesiteError(error);
  }
}

function bearerToken(request) {
  const authorization = String(request.headers.get('authorization') || '');
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function requestQuery(request) {
  return Object.fromEntries(new URL(request.url).searchParams.entries());
}

export async function POST(request, { params }) {
  const { slug, path } = await params;
  const route = parsePath(path);
  if (route[0] === 'agent-sessions'
    && route[2] === 'inbox'
    && route[4] === 'respond'
    && route.length === 5) {
    try {
      return okJson(await respondToAgentKnowledgeInbox(
        slug,
        route[1],
        route[3],
        bearerToken(request),
        await readJson(request),
      ));
    } catch (error) {
      return handleCodesiteError(error);
    }
  }
  if (route[0] === 'agent-sessions' && route[2] === 'knowledge' && route.length === 3) {
    try {
      return okJson(await createAgentKnowledgeItem(
        slug,
        route[1],
        bearerToken(request),
        await readJson(request),
      ), { status: 201 });
    } catch (error) {
      return handleCodesiteError(error);
    }
  }
  if (route[0] === 'agent-sessions' && route[2] === 'observations' && route.length === 3) {
    try {
      return okJson(await recordAgentProjectObservation(
        slug,
        route[1],
        bearerToken(request),
        await readJson(request),
      ), { status: 201 });
    } catch (error) {
      return handleCodesiteError(error);
    }
  }
  if (route[0] === 'agent-sessions' && route[2] === 'execution-plans' && route.length === 3) {
    try {
      return okJson({ executionPlan: await createAgentExecutionPlan(
        slug,
        route[1],
        bearerToken(request),
        await readJson(request),
      ) }, { status: 201 });
    } catch (error) {
      return handleCodesiteError(error);
    }
  }
  const access = await requireCodesiteAccess(slug, postAccessMode(route), request);
  if (!access.ok) return errorJson(access.status, access.error);
  const limited = enforceRateLimit(access.actor, route.join('/'), route.includes('events') ? 'audit' : 'crud');
  if (limited) return limited;
  const body = await readJson(request);

  try {
    if (route.join('/') === 'projects') {
      return okJson({ project: await createProject(slug, access.actor, body) }, { status: 201 });
    }

    if (route[0] === 'projects' && route[2] === 'zone-policy') {
      return okJson({ project: await updateZonePolicy(slug, route[1], body, access.actor) });
    }

    if (route[0] === 'projects' && route[2] === 'control-plan') {
      return okJson({ project: await updateControlPlan(slug, route[1], body, access.actor) });
    }

    if (route[0] === 'projects' && route[2] === 'agent-sessions' && route[3] === 'attach') {
      const authority = internalAgentLifecycleAuthority(access.actor, body);
      if (!authority) return errorJson(403, 'agent_lifecycle_internal_auth_required');
      return okJson(await attachAgentSession(slug, route[1], body, authority), { status: 201 });
    }

    if (route[0] === 'agent-sessions' && route[2] === 'heartbeat') {
      const authority = internalAgentLifecycleAuthority(access.actor, body);
      if (!authority) return errorJson(403, 'agent_lifecycle_internal_auth_required');
      return okJson(await heartbeatAgentSession(slug, route[1], body, authority));
    }

    if (route[0] === 'agent-sessions' && route[2] === 'detach') {
      const authority = internalAgentLifecycleAuthority(access.actor, body);
      if (!authority) return errorJson(403, 'agent_lifecycle_internal_auth_required');
      return okJson(await detachAgentSession(slug, route[1], body, authority));
    }

    if (route[0] === 'projects' && route[2] === 'agent-sessions' && route.length === 3) {
      return okJson({ agentSession: await createAgentSession(slug, route[1], access.actor, body) }, { status: 201 });
    }

    if (route[0] === 'projects' && route[2] === 'execution-plans') {
      return okJson({ executionPlan: await createExecutionPlan(slug, route[1], body, access.actor) }, { status: 201 });
    }

    if (route[0] === 'execution-plans' && route[2] === 'mutation-leases') {
      return okJson({ mutationLease: await requestMutationLease(slug, route[1], body, access.actor) }, { status: 201 });
    }

    if (route[0] === 'mutation-leases' && route[2] === 'transactions') {
      const transaction = await openTransaction(slug, route[1], body, access.actor);
      await notifyCollabCodeSiteActivity(request, slug, {
        event: 'transaction_opened',
        transactionId: transaction.id,
        mutationLeaseId: transaction.mutationLeaseId || route[1],
        agentSessionId: transaction.agentSessionId || body.agentSessionId || body.agent_session_id || null,
        status: transaction.status || 'open',
        actorUserId: access.actor?.userId || null,
        effectiveUserId: access.actor?.workspaceUserId || access.actor?.userId || null,
      });
      return okJson({ transaction }, { status: 201 });
    }

    if (route[0] === 'mutation-leases' && route[2] === 'revoke') {
      return okJson({ mutationLease: await revokeMutationLease(slug, route[1], body, access.actor) });
    }

    if (route[0] === 'mutation-leases' && route[2] === 'policy-decisions') {
      return okJson({ policyDecision: await recordPolicyDecision(slug, route[1], body, access.actor) }, { status: 201 });
    }

    if (route[0] === 'transactions' && route[2] === 'record-read') {
      return okJson({ transaction: await recordTransactionRead(slug, route[1], body, access.actor) });
    }

    if (route[0] === 'transactions' && route[2] === 'record-write') {
      return okJson(await recordTransactionWrite(slug, route[1], body, access.actor));
    }

    if (route[0] === 'transactions' && route[2] === 'quarantine-events') {
      return okJson({ event: await recordTransactionQuarantineEvent(slug, route[1], body, access.actor) }, { status: 201 });
    }

    if (route[0] === 'quarantines' && route[1] && ['replay', 'apply'].includes(route[2])) {
      return proxyCodeSiteQuarantine(request, slug, route, access.actor, body);
    }

    if (route[0] === 'transactions' && route[2] === 'assumptions') {
      return okJson({ assumption: await recordAssumption(slug, route[1], body, access.actor) }, { status: 201 });
    }

    if (route[0] === 'transactions' && route[2] === 'validate') {
      return okJson(await validateTransaction(slug, route[1], access.actor));
    }

    if (route[0] === 'transactions' && route[2] === 'preview') {
      return okJson(await validateTransaction(slug, route[1], access.actor));
    }

    if (route[0] === 'transactions' && route[2] === 'dry-run-patch') {
      return okJson(await dryRunTransactionWrites(slug, route[1], { ...body, tool: body.tool || 'dry_run_patch' }, access.actor));
    }

    if (route[0] === 'transactions' && route[2] === 'commit') {
      const result = await commitTransaction(slug, route[1], body, access.actor);
      const transactionStatus = result.transaction?.status || result.status || (result.decision?.ok ? 'validated' : 'blocked');
      const proofBundleDigest = result.proofBundle?.bundleDigest
        || result.proofBundle?.digest
        || result.transaction?.proofBundleDigest
        || null;
      const committed = transactionStatus === 'committed' && Boolean(proofBundleDigest || result.proofBundle);
      await notifyCollabCodeSiteActivity(request, slug, {
        event: committed ? 'transaction_committed' : 'transaction_blocked',
        transactionId: route[1],
        mutationLeaseId: result.transaction?.mutationLeaseId || result.mutationLeaseId || body.mutationLeaseId || body.mutation_lease_id || null,
        agentSessionId: result.transaction?.agentSessionId || result.agentSessionId || body.agentSessionId || body.agent_session_id || null,
        status: transactionStatus,
        proofBundleDigest,
        actorUserId: access.actor?.userId || null,
        effectiveUserId: access.actor?.workspaceUserId || access.actor?.userId || null,
      });
      return okJson(result);
    }

    if (route[0] === 'transactions' && route[2] === 'abort') {
      const transaction = await abortTransaction(slug, route[1], body, access.actor);
      await notifyCollabCodeSiteActivity(request, slug, {
        event: 'transaction_aborted',
        transactionId: route[1],
        mutationLeaseId: transaction.mutationLeaseId || body.mutationLeaseId || body.mutation_lease_id || null,
        agentSessionId: transaction.agentSessionId || body.agentSessionId || body.agent_session_id || null,
        status: transaction.status || 'aborted',
        actorUserId: access.actor?.userId || null,
        effectiveUserId: access.actor?.workspaceUserId || access.actor?.userId || null,
      });
      return okJson({ transaction });
    }

    if (route[0] === 'transactions' && route[2] === 'source-state-since') {
      return okJson(await getSourceStateSince(slug, route[1], access.actor));
    }

    if (route[0] === 'proof-bundles' && route[2] === 'commit') {
      return okJson({ proofBundle: await attachProofBundleCommit(slug, route[1], body, access.actor) });
    }

    if (route[0] === 'projects' && route[2] === 'members' && route.length === 3) {
      return okJson({ member: await upsertProjectMember(slug, route[1], body, access.actor) }, { status: 201 });
    }

    if (route[0] === 'projects' && route[2] === 'members' && route[4] === 'revoke') {
      return okJson({ member: await revokeProjectMember(slug, route[1], route[3], body, access.actor) });
    }

    if (route[0] === 'projects' && route[2] === 'observations' && route.length === 3) {
      if (!access.actor?.internalService) return errorJson(403, 'codesite_observations_internal_auth_required');
      return okJson(await recordRuntimeProjectObservation(slug, route[1], body), { status: 201 });
    }

    if (route[0] === 'projects' && route[2] === 'collision-predict') {
      return okJson(await collisionPredict(slug, route[1], access.actor));
    }

    if (route[0] === 'projects' && route[2] === 'shadow-merge-simulate') {
      return okJson(await shadowMergeSimulate(slug, route[1], body, access.actor));
    }

    if (route[0] === 'projects' && route[2] === 'codesitefs-events') {
      return okJson(await preflightCodeSiteFsWrite(slug, route[1], body, access.actor), { status: 201 });
    }

    if (route[0] === 'projects' && route[2] === 'documents') {
      return okJson(await createDocument(slug, route[1], body, access.actor), { status: 201 });
    }

    if (route[0] === 'projects' && route[2] === 'permits') {
      return okJson(await createPermit(slug, route[1], body, access.actor), { status: 201 });
    }

    if (route[0] === 'documents' && route[2] === 'reviews') {
      return okJson(await reviewDocument(slug, route[1], body, access.actor), { status: 201 });
    }

    if (route[0] === 'execution-plans' && route[2] === 'route-revisions') {
      return okJson(await proposeRouteRevision(slug, route[1], body, access.actor), { status: 201 });
    }

    if (route[0] === 'route-revisions' && route[2] === 'review') {
      return okJson(await reviewRouteRevision(slug, route[1], body, access.actor));
    }

    if (route[0] === 'route-revisions' && route[2] === 'apply') {
      return okJson(await applyRouteRevision(slug, route[1], body, access.actor));
    }

    if (route[0] === 'projects' && route[2] === 'incidents') {
      return okJson({ incident: await createIncident(slug, route[1], body, access.actor) }, { status: 201 });
    }

    if (route[0] === 'projects' && route[2] === 'incident-replays') {
      return okJson({ incident: await createIncident(slug, route[1], body, access.actor) }, { status: 201 });
    }

    if (route[0] === 'incidents' && route[2] === 'resume') {
      return okJson(await resumeMaydayIncident(slug, route[1], body, access.actor));
    }

    if (route[0] === 'projects' && route[2] === 'policy-deltas' && route[4] === 'promote') {
      return okJson({ policyDelta: await promotePolicyDelta(slug, route[1], route[3], body, access.actor) });
    }

    if (route[0] === 'projects' && route[2] === 'policy-deltas' && route[4] === 'reject') {
      return okJson({ policyDelta: await rejectPolicyDelta(slug, route[1], route[3], body, access.actor) });
    }

    if (route[0] === 'projects' && route[2] === 'policy-deltas') {
      return okJson({ policyDelta: await createPolicyDelta(slug, route[1], body, access.actor) }, { status: 201 });
    }

    if (route[0] === 'projects' && route[2] === 'counterfactual-runs') {
      return okJson({ counterfactualRun: await createCounterfactualRun(slug, route[1], body, access.actor) }, { status: 201 });
    }

    if (route[0] === 'projects' && route[2] === 'inspection-runs') {
      return okJson({ inspectionRun: await createInspectionRun(slug, route[1], body, access.actor) }, { status: 201 });
    }

    if (route[0] === 'projects' && route[2] === 'artifacts' && route[3] === 'export') {
      return okJson(await exportArtifacts(slug, route[1], access.actor));
    }

    if (route[0] === 'inspection-runs' && route[2] === 'complete') {
      return okJson({ inspectionRun: await completeInspectionRun(slug, route[1], body, access.actor) });
    }

    if (route[0] === 'agent-sessions' && route[2] === 'inbox' && route[3] && route.length === 4) {
      return okJson({ inboxItem: await acknowledgeInboxItem(slug, route[1], route[3], access.actor) });
    }

    return routeNotFound(route);
  } catch (error) {
    return handleCodesiteError(error);
  }
}

function internalAgentLifecycleAuthority(actor, body = {}) {
  if (!actor?.internalService) return null;
  return {
    internalService: true,
    collaborationMembershipVerified: body.collaborationMembershipVerified === true
      || body.collaboration_membership_verified === true,
    actorUserId: body.ownerUserId || body.owner_user_id || null,
    collaborationUserId: body.collaborationUserId || body.collaboration_user_id || body.workspaceUserId || body.workspace_user_id || null,
    effectiveWorkspaceUserId: body.effectiveWorkspaceUserId || body.effective_workspace_user_id || body.filesystemUserId || body.filesystem_user_id || null,
    collaborationSessionId: body.collaborationSessionId || body.collaboration_session_id || null,
    runtimeScope: body.runtimeScope || body.runtime_scope || null,
  };
}

function postAccessMode(route) {
  if (route[0] === 'projects' && route[2] === 'agent-sessions') return 'read';
  if (route[0] === 'projects' && route[2] === 'execution-plans') return 'read';
  if (route[0] === 'execution-plans' && route[2] === 'mutation-leases') return 'read';
  if (route[0] === 'mutation-leases' && route[2] === 'transactions') return 'read';
  if (route[0] === 'transactions' && [
    'record-read',
    'record-write',
    'quarantine-events',
    'assumptions',
    'validate',
    'preview',
    'dry-run-patch',
    'commit',
    'abort',
    'source-state-since',
  ].includes(route[2])) return 'read';
  if (route[0] === 'quarantines' && ['replay', 'apply'].includes(route[2])) return 'write';
  if (route[0] === 'projects' && [
    'codesitefs-events',
    'documents',
    'permits',
    'route-revisions',
    'incidents',
    'incident-replays',
    'counterfactual-runs',
    'inspection-runs',
    'members',
    'collision-predict',
    'observations',
  ].includes(route[2])) return 'read';
  if (route[0] === 'documents' && route[2] === 'reviews') return 'read';
  if (route[0] === 'execution-plans' && route[2] === 'route-revisions') return 'read';
  if (route[0] === 'route-revisions' && ['review', 'apply'].includes(route[2])) return 'read';
  if (route[0] === 'incidents' && route[2] === 'resume') return 'read';
  if (route[0] === 'agent-sessions' && route[2] === 'inbox' && route[3] && route.length === 4) return 'read';
  if (route[0] === 'proof-bundles' && route[2] === 'commit') return 'read';
  return 'write';
}

function eventStreamResponse({ signal, initialSince = null, load, eventName, idOf }) {
  const encoder = new TextEncoder();
  let since = initialSince || null;
  const seen = new Set();
  let timer = null;
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      function safeEnqueue(payload) {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(payload));
          return true;
        } catch (_) {
          closed = true;
          if (timer) windowClearInterval(timer);
          return false;
        }
      }

      async function send() {
        if (closed) return;
        try {
          const items = await load(since);
          if (closed) return;
          let emitted = 0;
          for (const item of Array.isArray(items) ? items : []) {
            if (closed) return;
            const id = idOf(item);
            if (id && seen.has(id)) continue;
            if (id) {
              seen.add(id);
              since = id;
            }
            if (!safeEnqueue(`id: ${id || Date.now()}\nevent: ${eventName(item)}\ndata: ${JSON.stringify(item)}\n\n`)) return;
            emitted += 1;
          }
          if (!emitted) safeEnqueue(`: heartbeat ${Date.now()}\n\n`);
        } catch (error) {
          safeEnqueue(`event: codesite_stream_error\ndata: ${JSON.stringify({ error: error?.message || 'stream_failed' })}\n\n`);
        }
      }

      const close = () => {
        if (closed) return;
        closed = true;
        if (timer) windowClearInterval(timer);
        try {
          controller.close();
        } catch (_) {}
      };

      signal?.addEventListener('abort', close, { once: true });
      await send();
      timer = windowSetInterval(send, 1500);
    },
    cancel() {
      closed = true;
      if (timer) windowClearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
    },
  });
}

const windowSetInterval = globalThis.setInterval.bind(globalThis);
const windowClearInterval = globalThis.clearInterval.bind(globalThis);

async function proxyCodeSiteQuarantine(request, slug, route, actor, body = null) {
  const collabBase = resolveServerCollabHttpUrl();
  const sourceUrl = new URL(request.url);
  const action = route[2] || null;
  const quarantineId = route[1] || null;
  const targetPath = quarantineId
    ? `/codesitefs/quarantines/${encodeURIComponent(slug)}/${encodeURIComponent(quarantineId)}${action ? `/${action}` : ''}`
    : `/codesitefs/quarantines/${encodeURIComponent(slug)}`;
  const targetUrl = new URL(`${collabBase}${targetPath}`);
  const identity = quarantineRuntimeIdentity(body, sourceUrl, actor);
  if (identity.error) return identity.error;
  const { actorUserId, filesystemUserId, runtimeScope } = identity;

  if (!action) {
    if (actorUserId) targetUrl.searchParams.set('userId', actorUserId);
    if (filesystemUserId) targetUrl.searchParams.set('filesystemUserId', filesystemUserId);
    if (runtimeScope) targetUrl.searchParams.set('runtimeScope', runtimeScope);
    for (const key of ['transactionId', 'status']) {
      const value = sourceUrl.searchParams.get(key);
      if (value) targetUrl.searchParams.set(key, value);
    }
  }

  const headers = {
    accept: 'application/json',
    'x-codesite-control-plane-url': codeSiteApiBaseUrl(request, sourceUrl, slug),
  };
  const queryTransactionId = sourceUrl.searchParams.get('transactionId') || sourceUrl.searchParams.get('transaction_id');
  const queryMutationLeaseId = sourceUrl.searchParams.get('mutationLeaseId') || sourceUrl.searchParams.get('mutation_lease_id');
  const queryAgentSessionId = sourceUrl.searchParams.get('agentSessionId') || sourceUrl.searchParams.get('agent_session_id');
  const queryDisplayCallsign = sourceUrl.searchParams.get('displayCallsign') || sourceUrl.searchParams.get('callsign');
  if (!action && queryTransactionId) {
    headers['x-codesite-mode'] = 'enforce';
    headers['x-codesite-transaction-id'] = queryTransactionId;
  }
  if (!action && queryMutationLeaseId) headers['x-codesite-lease-id'] = queryMutationLeaseId;
  if (!action && queryAgentSessionId) headers['x-codesite-agent-session-id'] = queryAgentSessionId;
  if (!action && queryDisplayCallsign) headers['x-codesite-callsign'] = queryDisplayCallsign;
  const authorization = request.headers.get('authorization');
  const cookie = request.headers.get('cookie');
  if (authorization) headers.authorization = authorization;
  if (cookie) headers.cookie = cookie;
  if (actorUserId) headers['x-user-id'] = actorUserId;
  if (filesystemUserId) headers['x-runtime-fs-user-id'] = filesystemUserId;
  if (runtimeScope) headers['x-runtime-scope'] = runtimeScope;

  let nextBody = null;
  if (action) {
    const selectedPaths = Array.isArray(body?.paths)
      ? body.paths
      : Array.isArray(body?.selectedPaths)
        ? body.selectedPaths
        : Array.isArray(body?.selected_paths)
          ? body.selected_paths
          : [];
    const normalizedSelectedPaths = selectedPaths
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean);
    if (normalizedSelectedPaths.length === 0) {
      return errorJson(400, 'missing_selected_paths', { quarantineId, action });
    }
    headers['content-type'] = 'application/json';
    const transactionId = body?.transactionId || body?.transaction_id;
    const mutationLeaseId = body?.mutationLeaseId || body?.mutation_lease_id;
    const agentSessionId = body?.agentSessionId || body?.agent_session_id;
    const displayCallsign = body?.displayCallsign || body?.callsign;
    if (transactionId) {
      headers['x-codesite-mode'] = 'enforce';
      headers['x-codesite-transaction-id'] = transactionId;
    }
    if (mutationLeaseId) headers['x-codesite-lease-id'] = mutationLeaseId;
    if (agentSessionId) headers['x-codesite-agent-session-id'] = agentSessionId;
    if (displayCallsign) headers['x-codesite-callsign'] = displayCallsign;
    nextBody = JSON.stringify({
      ...(transactionId ? { transactionId } : {}),
      ...(mutationLeaseId ? { mutationLeaseId } : {}),
      ...(agentSessionId ? { agentSessionId } : {}),
      ...(displayCallsign ? { displayCallsign } : {}),
      ...(body?.evidenceRefs ? { evidenceRefs: body.evidenceRefs } : {}),
      ...(body?.evidence_refs ? { evidence_refs: body.evidence_refs } : {}),
      ...(body?.processAncestry ? { processAncestry: body.processAncestry } : {}),
      ...(body?.process_ancestry ? { process_ancestry: body.process_ancestry } : {}),
      userId: actorUserId,
      filesystemUserId,
      runtimeScope,
      paths: normalizedSelectedPaths,
      codesite: {
        ...(body?.codesite || body?.codeSite || {}),
        enforce: true,
        mode: 'enforce',
        workspaceSlug: slug,
        transactionId,
        mutationLeaseId,
        agentSessionId,
        displayCallsign,
        controlPlaneUrl: codeSiteApiBaseUrl(request, sourceUrl, slug),
        cookie,
      },
    });
  }

  let response;
  try {
    response = await fetch(targetUrl, {
      method: action ? 'POST' : 'GET',
      headers,
      body: nextBody,
    });
  } catch (error) {
    const detail = {
      target: targetUrl.origin,
      reason: error?.cause?.code || error?.code || error?.message || 'fetch_failed',
    };
    if (!action) {
      return okJson({
        ok: false,
        quarantines: [],
        quarantine: null,
        unavailable: true,
        error: 'quarantine_runtime_unavailable',
        detail,
      });
    }
    return errorJson(503, 'quarantine_runtime_unavailable', detail);
  }
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (_) {
    payload = { text };
  }
  return okJson(payload, { status: response.status });
}

function quarantineRuntimeIdentity(body, sourceUrl, actor) {
  const actorIds = [actor?.userId, actor?.workspaceUserId].filter(Boolean).map(String);
  const actorUserId = actorIds[0] || '';
  const requestedUserId = body?.userId || body?.actorUserId || sourceUrl.searchParams.get('userId') || '';
  const requestedFilesystemUserId = body?.filesystemUserId
    || body?.filesystem_user_id
    || sourceUrl.searchParams.get('filesystemUserId')
    || sourceUrl.searchParams.get('filesystem_user_id')
    || '';
  for (const [field, value] of [
    ['userId', requestedUserId],
    ['filesystemUserId', requestedFilesystemUserId],
  ]) {
    if (value && !actorIds.includes(String(value))) {
      return {
        error: errorJson(403, 'codesite_runtime_identity_mismatch', {
          field,
          actorUserId,
        }),
      };
    }
  }
  return {
    actorUserId,
    filesystemUserId: requestedFilesystemUserId || actorUserId,
    runtimeScope: body?.runtimeScope || body?.runtime_scope || sourceUrl.searchParams.get('runtimeScope') || '',
  };
}

function resolveServerCollabHttpUrl() {
  return String(
    process.env.COLLAB_SERVER_URL
    || process.env.SYNTHI_COLLAB_SERVER_URL
    || process.env.NEXT_PUBLIC_COLLAB_SERVER_URL
    || process.env.COLLAB_URL
    || 'http://localhost:1234'
  ).replace(/\/+$/, '').replace(/^ws/i, 'http');
}

function resolveConfiguredCollabHttpUrl() {
  const configured = process.env.COLLAB_SERVER_URL
    || process.env.SYNTHI_COLLAB_SERVER_URL
    || process.env.NEXT_PUBLIC_COLLAB_SERVER_URL
    || process.env.COLLAB_URL;
  return configured ? String(configured).replace(/\/+$/, '').replace(/^ws/i, 'http') : '';
}

function shortNotificationSignal(ms = 1500) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  return undefined;
}

async function notifyCollabCodeSiteActivity(request, slug, payload = {}) {
  const collabUrl = resolveConfiguredCollabHttpUrl();
  if (!collabUrl || typeof fetch !== 'function') return null;
  const requestUrl = new URL(request.url);
  const targetUrl = new URL(`/codesite/activity/${encodeURIComponent(slug)}`, `${collabUrl}/`);
  const internalToken = process.env.COLLAB_INTERNAL_TOKEN || process.env.SYNTHI_COLLAB_INTERNAL_TOKEN || '';
  const headers = {
    'content-type': 'application/json',
    'x-user-id': payload.actorUserId || '',
    'x-codesite-control-plane-url': codeSiteApiBaseUrl(request, requestUrl, slug),
  };
  if (internalToken) headers['x-collab-internal-token'] = internalToken;
  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...payload,
        workspaceSlug: slug,
        controlPlaneUrl: codeSiteApiBaseUrl(request, requestUrl, slug),
        source: payload.source || 'next_codesite_route',
      }),
      signal: shortNotificationSignal(),
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    console.warn('[CodeSite] Failed to notify collab activity registry', {
      workspaceSlug: slug,
      transactionId: payload.transactionId || null,
      reason: error?.cause?.code || error?.code || error?.message || 'fetch_failed',
    });
    return null;
  }
}

function codeSiteApiBaseUrl(request, url, slug) {
  const explicit = process.env.SYNTHI_CODESITE_API_BASE_URL || process.env.CODESITE_API_BASE_URL;
  if (explicit) {
    return explicit.replace('{workspace_slug}', encodeURIComponent(slug)).replace(/\/+$/, '');
  }
  const configuredOrigin = process.env.SYNTHI_CODESITE_BASE_URL
    || process.env.SYNTHI_APP_INTERNAL_URL
    || process.env.SYNTHI_APP_URL
    || process.env.NEXTAUTH_URL;
  const requestHost = request.headers.get('x-forwarded-host') || request.headers.get('host') || '';
  const requestProto = request.headers.get('x-forwarded-proto') || url.protocol.replace(/:$/, '') || 'http';
  const originFromHost = requestHost ? `${requestProto}://${requestHost}` : '';
  const bindOnlyHost = ['0.0.0.0', '::', '[::]'].includes(url.hostname);
  const origin = String(configuredOrigin || (bindOnlyHost ? originFromHost : url.origin) || url.origin).replace(/\/+$/, '');
  return `${origin}/api/workspace/${encodeURIComponent(slug)}/codesite`;
}

export function PUT() {
  return methodNotAllowed('PUT');
}

export function DELETE() {
  return methodNotAllowed('DELETE');
}
