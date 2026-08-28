'use strict';

const codeSiteActivityRegistry = require('./codesiteActivityRegistry');
const {
  configuredControlPlaneBaseUrl,
  trustedControlPlaneBaseUrl,
} = require('./codesiteControlPlaneTrust');

function codeSiteActivityInternalToken() {
  return process.env.COLLAB_INTERNAL_TOKEN || process.env.SYNTHI_COLLAB_INTERNAL_TOKEN || '';
}

function writeJsonResponse(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonRequestBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (!body.trim()) return {};
  return JSON.parse(body);
}

function enforceCodeSiteActivityAuth(req, res, options = {}) {
  const respond = options.writeJsonResponse || writeJsonResponse;
  const expected = codeSiteActivityInternalToken();
  if (!expected) {
    respond(res, 503, { error: 'codesite_activity_auth_unconfigured' });
    return false;
  }
  const provided = req?.headers?.['x-collab-internal-token'];
  if (provided === expected) return true;
  respond(res, 403, { error: 'codesite_activity_auth_required' });
  return false;
}

function codeSiteActivityFromRequest(slug, payload = {}, req = null) {
  const rawControlPlaneUrl = payload.controlPlaneUrl || payload.control_plane_url || req?.headers?.['x-codesite-control-plane-url'] || null;
  const configuredControlPlaneUrl = configuredControlPlaneBaseUrl(slug);
  const controlPlaneUrl = trustedControlPlaneBaseUrl(rawControlPlaneUrl, slug)
    || configuredControlPlaneUrl;
  return {
    ...payload,
    workspaceSlug: slug,
    transactionId: payload.transactionId || payload.transaction_id || payload.id,
    mutationLeaseId: payload.mutationLeaseId || payload.mutation_lease_id || payload.leaseId || payload.lease_id,
    agentSessionId: payload.agentSessionId || payload.agent_session_id,
    actorUserId: payload.actorUserId || payload.actor_user_id || payload.userId || req?.headers?.['x-user-id'] || null,
    effectiveUserId: payload.effectiveUserId || payload.effective_user_id || payload.filesystemUserId || payload.filesystem_user_id || null,
    controlPlaneUrl,
    controlPlaneTrusted: Boolean(controlPlaneUrl),
    status: payload.status || (payload.event === 'transaction_opened' ? 'open' : undefined),
    source: payload.source || 'codesite_route_activity',
    authoritative: true,
  };
}

async function handleCodeSiteActivityRequest(slug, req, res, options = {}) {
  const registry = options.activityRegistry || codeSiteActivityRegistry;
  const respond = options.writeJsonResponse || writeJsonResponse;
  const readBody = options.readJsonRequestBody || readJsonRequestBody;

  if (!enforceCodeSiteActivityAuth(req, res, { writeJsonResponse: respond })) {
    return true;
  }
  if (req.method === 'GET') {
    respond(res, 200, {
      workspaceSlug: slug,
      activeTransactions: registry.activeTransactionsForWorkspace(slug),
    });
    return true;
  }
  if (req.method === 'POST') {
    let payload;
    try {
      payload = await readBody(req);
    } catch (_) {
      respond(res, 400, { error: 'invalid_json_body' });
      return true;
    }
    const activity = codeSiteActivityFromRequest(slug, payload, req);
    const status = String(activity.status || '').toLowerCase();
    const event = String(payload.event || payload.eventType || payload.event_type || '').toLowerCase();
    const closesTransaction = ['transaction_committed', 'transaction_aborted', 'transaction_closed', 'closed'].includes(event)
      || (status && !registry.isWritableTransactionStatus(status));
    if (!closesTransaction && !activity.controlPlaneUrl) {
      respond(res, 503, {
        error: 'codesite_activity_control_plane_url_required',
        workspaceSlug: slug,
      });
      return true;
    }
    const record = closesTransaction
      ? registry.markTransactionClosed(activity, { source: activity.source })
      : registry.markTransactionActive(activity, { source: activity.source });
    respond(res, 200, {
      ok: true,
      workspaceSlug: slug,
      action: closesTransaction ? 'closed' : 'active',
      record,
      activeTransactions: registry.activeTransactionsForWorkspace(slug),
    });
    return true;
  }
  respond(res, 405, { error: 'method_not_allowed' });
  return true;
}

module.exports = {
  codeSiteActivityFromRequest,
  codeSiteActivityInternalToken,
  enforceCodeSiteActivityAuth,
  handleCodeSiteActivityRequest,
};
