import {
  abortTransaction,
  acknowledgeInboxItem,
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
  exportArtifacts,
  getAgentInbox,
  getAgentManifest,
  getControlState,
  getEvents,
  getIncidentReplay,
  getLineProvenance,
  getProofBundle,
  getProject,
  getSchemas,
  getSourceStateSince,
  getTransaction,
  listProjects,
  openTransaction,
  recordPolicyDecision,
  recordAssumption,
  recordTransactionRead,
  recordTransactionWrite,
  requestMutationLease,
  previewArtifacts,
  revokeMutationLease,
  shadowMergeSimulate,
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
      return okJson({ projects: await listProjects(slug) });
    }

    if (route[0] === 'projects' && route.length === 2) {
      const project = await getProject(slug, route[1]);
      if (!project) return errorJson(404, 'project_not_found');
      return okJson({ project });
    }

    if (route[0] === 'projects' && route[2] === 'control-state') {
      return okJson(await getControlState(slug, route[1]));
    }

    if (route[0] === 'projects' && route[2] === 'events' && route[3] !== 'stream') {
      const since = new URL(request.url).searchParams.get('since');
      return okJson({ events: await getEvents(slug, route[1], since) });
    }

    if (route[0] === 'projects' && route[2] === 'events' && route[3] === 'stream') {
      return eventStreamResponse({
        signal: request.signal,
        initialSince: new URL(request.url).searchParams.get('since'),
        load: (since) => getEvents(slug, route[1], since),
        eventName: (event) => event.eventType || 'codesite_event',
        idOf: (event) => event.id,
      });
    }

    if (route[0] === 'projects' && route[2] === 'agent-manifest') {
      return okJson(await getAgentManifest(slug, route[1]));
    }

    if (route[0] === 'projects' && route[2] === 'schemas') {
      return okJson(await getSchemas());
    }

    if (route[0] === 'projects' && route[2] === 'artifacts' && route[3] === 'preview') {
      const search = new URL(request.url).searchParams;
      return okJson(await previewArtifacts(slug, route[1], {
        includeContent: search.get('include') === 'content',
      }));
    }

    if (route[0] === 'transactions' && route.length === 2) {
      const transaction = await getTransaction(slug, route[1]);
      if (!transaction) return errorJson(404, 'transaction_not_found');
      return okJson({ transaction });
    }

    if (route[0] === 'transactions' && route[2] === 'status') {
      const transaction = await getTransaction(slug, route[1]);
      if (!transaction) return errorJson(404, 'transaction_not_found');
      return okJson({ status: transaction.status, transaction });
    }

    if (route[0] === 'transactions' && route[2] === 'source-state-since') {
      return okJson(await getSourceStateSince(slug, route[1]));
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

    if (route[0] === 'provenance' && route[1] === 'line') {
      const search = new URL(request.url).searchParams;
      return okJson({
        lineProvenance: await getLineProvenance(slug, {
          filePath: search.get('filePath') || search.get('path'),
          lineAnchor: search.get('lineAnchor'),
        }),
      });
    }

    if (route[0] === 'proof-bundles' && route[1]) {
      return okJson({ proofBundle: await getProofBundle(slug, route[1]) });
    }

    if (route[0] === 'incidents' && route[2] === 'replay') {
      return okJson(await getIncidentReplay(slug, route[1]));
    }

    return routeNotFound(route);
  } catch (error) {
    return handleCodesiteError(error);
  }
}

export async function POST(request, { params }) {
  const { slug, path } = await params;
  const route = parsePath(path);
  const access = await requireCodesiteAccess(slug, 'write');
  if (!access.ok) return errorJson(access.status, access.error);
  const limited = enforceRateLimit(access.actor, route.join('/'), route.includes('events') ? 'audit' : 'crud');
  if (limited) return limited;
  const body = await readJson(request);

  try {
    if (route.join('/') === 'projects') {
      return okJson({ project: await createProject(slug, access.actor, body) }, { status: 201 });
    }

    if (route[0] === 'projects' && route[2] === 'zone-policy') {
      return okJson({ project: await updateZonePolicy(slug, route[1], body) });
    }

    if (route[0] === 'projects' && route[2] === 'control-plan') {
      return okJson({ project: await updateControlPlan(slug, route[1], body) });
    }

    if (route[0] === 'projects' && route[2] === 'agent-sessions') {
      return okJson({ agentSession: await createAgentSession(slug, route[1], access.actor, body) }, { status: 201 });
    }

    if (route[0] === 'projects' && route[2] === 'execution-plans') {
      return okJson({ executionPlan: await createExecutionPlan(slug, route[1], body) }, { status: 201 });
    }

    if (route[0] === 'execution-plans' && route[2] === 'mutation-leases') {
      return okJson({ mutationLease: await requestMutationLease(slug, route[1], body) }, { status: 201 });
    }

    if (route[0] === 'mutation-leases' && route[2] === 'transactions') {
      return okJson({ transaction: await openTransaction(slug, route[1], body) }, { status: 201 });
    }

    if (route[0] === 'mutation-leases' && route[2] === 'revoke') {
      return okJson({ mutationLease: await revokeMutationLease(slug, route[1], body) });
    }

    if (route[0] === 'mutation-leases' && route[2] === 'policy-decisions') {
      return okJson({ policyDecision: await recordPolicyDecision(slug, route[1], body) }, { status: 201 });
    }

    if (route[0] === 'transactions' && route[2] === 'record-read') {
      return okJson({ transaction: await recordTransactionRead(slug, route[1], body) });
    }

    if (route[0] === 'transactions' && route[2] === 'record-write') {
      return okJson(await recordTransactionWrite(slug, route[1], body));
    }

    if (route[0] === 'transactions' && route[2] === 'assumptions') {
      return okJson({ assumption: await recordAssumption(slug, route[1], body) }, { status: 201 });
    }

    if (route[0] === 'transactions' && route[2] === 'validate') {
      return okJson(await validateTransaction(slug, route[1]));
    }

    if (route[0] === 'transactions' && route[2] === 'preview') {
      return okJson(await validateTransaction(slug, route[1]));
    }

    if (route[0] === 'transactions' && route[2] === 'dry-run-patch') {
      return okJson(await dryRunTransactionWrites(slug, route[1], { ...body, tool: body.tool || 'dry_run_patch' }));
    }

    if (route[0] === 'transactions' && route[2] === 'commit') {
      return okJson(await commitTransaction(slug, route[1], body));
    }

    if (route[0] === 'transactions' && route[2] === 'abort') {
      return okJson({ transaction: await abortTransaction(slug, route[1], body) });
    }

    if (route[0] === 'transactions' && route[2] === 'source-state-since') {
      return okJson(await getSourceStateSince(slug, route[1]));
    }

    if (route[0] === 'projects' && route[2] === 'collision-predict') {
      return okJson(await collisionPredict(slug, route[1]));
    }

    if (route[0] === 'projects' && route[2] === 'shadow-merge-simulate') {
      return okJson(await shadowMergeSimulate(slug, route[1], body));
    }

    if (route[0] === 'projects' && route[2] === 'documents') {
      return okJson(await createDocument(slug, route[1], body, access.actor), { status: 201 });
    }

    if (route[0] === 'projects' && route[2] === 'incidents') {
      return okJson({ incident: await createIncident(slug, route[1], body) }, { status: 201 });
    }

    if (route[0] === 'projects' && route[2] === 'incident-replays') {
      return okJson({ incident: await createIncident(slug, route[1], body) }, { status: 201 });
    }

    if (route[0] === 'projects' && route[2] === 'policy-deltas') {
      return okJson({ policyDelta: await createPolicyDelta(slug, route[1], body) }, { status: 201 });
    }

    if (route[0] === 'projects' && route[2] === 'counterfactual-runs') {
      return okJson({ counterfactualRun: await createCounterfactualRun(slug, route[1], body) }, { status: 201 });
    }

    if (route[0] === 'projects' && route[2] === 'inspection-runs') {
      return okJson({ inspectionRun: await createInspectionRun(slug, route[1], body) }, { status: 201 });
    }

    if (route[0] === 'projects' && route[2] === 'artifacts' && route[3] === 'export') {
      return okJson(await exportArtifacts(slug, route[1]));
    }

    if (route[0] === 'inspection-runs' && route[2] === 'complete') {
      return okJson({ inspectionRun: await completeInspectionRun(slug, route[1], body) });
    }

    if (route[0] === 'agent-sessions' && route[2] === 'inbox' && route[3]) {
      return okJson({ inboxItem: await acknowledgeInboxItem(slug, route[1], route[3], access.actor) });
    }

    return routeNotFound(route);
  } catch (error) {
    return handleCodesiteError(error);
  }
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

export function PUT() {
  return methodNotAllowed('PUT');
}

export function DELETE() {
  return methodNotAllowed('DELETE');
}
