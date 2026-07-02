import {
  abortTransaction,
  acknowledgeInboxItem,
  attachProofBundleCommit,
  collisionPredict,
  commitTransaction,
  completeInspectionRun,
  createAgentSession,
  createCounterfactualRun,
  createDocument,
  createExecutionPlan,
  createIncident,
  createInspectionRun,
  createPolicyDelta,
  createProject,
  dryRunTransactionWrites,
  eventCursor,
  exportArtifacts,
  getAgentInbox,
  getAgentManifest,
  getControlState,
  getEvents,
  getIncidentReplay,
  getLineProvenance,
  getCodeSiteMetrics,
  getProofBundle,
  getProject,
  getSchemas,
  getSourceStateSince,
  getTransaction,
  listProjectMembers,
  listProjects,
  openTransaction,
  preflightCodeSiteFsWrite,
  recordPolicyDecision,
  recordAssumption,
  recordTransactionQuarantineEvent,
  recordTransactionRead,
  recordTransactionWrite,
  requestMutationLease,
  resumeMaydayIncident,
  previewArtifacts,
  promotePolicyDelta,
  revokeProjectMember,
  revokeMutationLease,
  rejectPolicyDelta,
  shadowMergeSimulate,
  upsertProjectMember,
  updateControlPlan,
  updateZonePolicy,
  validateTransaction,
} from '@/lib/codesite/controlPlane';
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
  const access = await requireCodesiteAccess(slug, 'read');
  if (!access.ok) return errorJson(access.status, access.error);

  try {
    if (route.length === 0 || route.join('/') === 'projects') {
      return okJson({ projects: await listProjects(slug, access.actor) });
    }

    if (route[0] === 'projects' && route.length === 2) {
      const project = await getProject(slug, route[1], access.actor);
      if (!project) return errorJson(404, 'project_not_found');
      return okJson({ project });
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

export async function POST(request, { params }) {
  const { slug, path } = await params;
  const route = parsePath(path);
  const access = await requireCodesiteAccess(slug, postAccessMode(route));
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

    if (route[0] === 'projects' && route[2] === 'agent-sessions') {
      return okJson({ agentSession: await createAgentSession(slug, route[1], access.actor, body) }, { status: 201 });
    }

    if (route[0] === 'projects' && route[2] === 'execution-plans') {
      return okJson({ executionPlan: await createExecutionPlan(slug, route[1], body, access.actor) }, { status: 201 });
    }

    if (route[0] === 'execution-plans' && route[2] === 'mutation-leases') {
      return okJson({ mutationLease: await requestMutationLease(slug, route[1], body, access.actor) }, { status: 201 });
    }

    if (route[0] === 'mutation-leases' && route[2] === 'transactions') {
      return okJson({ transaction: await openTransaction(slug, route[1], body, access.actor) }, { status: 201 });
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
      return okJson(await commitTransaction(slug, route[1], body, access.actor));
    }

    if (route[0] === 'transactions' && route[2] === 'abort') {
      return okJson({ transaction: await abortTransaction(slug, route[1], body, access.actor) });
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

    if (route[0] === 'agent-sessions' && route[2] === 'inbox' && route[3]) {
      return okJson({ inboxItem: await acknowledgeInboxItem(slug, route[1], route[3], access.actor) });
    }

    return routeNotFound(route);
  } catch (error) {
    return handleCodesiteError(error);
  }
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
    'incidents',
    'incident-replays',
    'counterfactual-runs',
    'inspection-runs',
    'members',
    'collision-predict',
  ].includes(route[2])) return 'read';
  if (route[0] === 'incidents' && route[2] === 'resume') return 'read';
  if (route[0] === 'agent-sessions' && route[2] === 'inbox' && route[3]) return 'read';
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
      async function send() {
        if (closed) return;
        try {
          const items = await load(since);
          let emitted = 0;
          for (const item of Array.isArray(items) ? items : []) {
            const id = idOf(item);
            if (id && seen.has(id)) continue;
            if (id) {
              seen.add(id);
              since = id;
            }
            controller.enqueue(encoder.encode(`id: ${id || Date.now()}\nevent: ${eventName(item)}\ndata: ${JSON.stringify(item)}\n\n`));
            emitted += 1;
          }
          if (!emitted) controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
        } catch (error) {
          controller.enqueue(encoder.encode(`event: codesite_stream_error\ndata: ${JSON.stringify({ error: error?.message || 'stream_failed' })}\n\n`));
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
    const displayCallsign = body?.displayCallsign || body?.callsign;
    if (transactionId) {
      headers['x-codesite-mode'] = 'enforce';
      headers['x-codesite-transaction-id'] = transactionId;
    }
    if (mutationLeaseId) headers['x-codesite-lease-id'] = mutationLeaseId;
    if (displayCallsign) headers['x-codesite-callsign'] = displayCallsign;
    nextBody = JSON.stringify({
      ...(transactionId ? { transactionId } : {}),
      ...(mutationLeaseId ? { mutationLeaseId } : {}),
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

function codeSiteApiBaseUrl(request, url, slug) {
  const explicit = process.env.SYNTHI_CODESITE_API_BASE_URL || process.env.CODESITE_API_BASE_URL;
  if (explicit) {
    return explicit.replace('{workspace_slug}', encodeURIComponent(slug)).replace(/\/+$/, '');
  }
  const configuredOrigin = process.env.SYNTHI_CODESITE_BASE_URL || process.env.SYNTHI_APP_URL || process.env.NEXTAUTH_URL;
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
