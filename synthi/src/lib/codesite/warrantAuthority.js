import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { parseJson, stableJson, stringifyJson } from './json.js';

const MAX_CHAIN_DEPTH = 8;

export class WarrantAuthorityError extends Error {
  constructor(code, status = 403) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/**
 * Transactional, provider-neutral warrant state machine. CodeSite calls this
 * only after it has authenticated the csa credential and resolved a canonical
 * principal. Nothing here knows a runtime, agent brand, or bearer format.
 */
export async function executeWarrantAuthority(db, context, operation, body = {}) {
  const scope = requiredScope(context);
  const policy = requiredPolicy(context.policy);
  return withinProjectTransaction(db, scope.projectId, async (tx) => {
    switch (operation) {
      case 'issue': return issue(tx, scope, policy, body);
      case 'attenuate': return attenuate(tx, scope, policy, body);
      case 'check': return check(tx, scope, body);
      case 'list': return list(tx, scope);
      case 'revoke': return revoke(tx, scope, body);
      case 'renew': return renew(tx, scope, policy, body);
      case 'reserve': return reserve(tx, scope, body);
      case 'settle': return settle(tx, scope, body);
      default: throw new WarrantAuthorityError('warrant_authority_operation_invalid', 400);
    }
  });
}

async function withinProjectTransaction(db, projectId, operation) {
  if (typeof db?.$transaction !== 'function') {
    throw new WarrantAuthorityError('warrant_authority_transaction_required', 503);
  }
  return db.$transaction(async (tx) => {
    // This ORM update serializes warrant mutations per project as well as the
    // Serializable transaction isolation level. It is not a hand-written lock.
    await tx.codeSiteProject.update({ where: { id: projectId }, data: { updatedAt: new Date() } });
    return operation(tx);
  }, { isolationLevel: 'Serializable' });
}

async function issue(db, scope, policy, body) {
  const now = new Date();
  const input = object(body);
  const audience = principal(input.audience);
  const grants = grantsOf(input.grants);
  const subject = requiredString(input.subject, 'warrant_subject_required');
  const ttlMs = positiveInt(input.ttl_ms, 'warrant_ttl_invalid');
  const delegation = delegationOf(input.delegation, input.seal === true);
  const active = await db.codeSiteWarrant.count({
    where: { projectId: scope.projectId, workspaceSlug: scope.workspace, status: 'active', expiresAt: { gt: now } },
  });
  if (active >= policy.maxActive) throw new WarrantAuthorityError('warrant_ceiling_reached', 409);
  const warrantId = `wr_${randomUUID()}`;
  const bearer = input.seal === true ? `wb_${randomUUID().replaceAll('-', '')}` : undefined;
  const record = await db.codeSiteWarrant.create({
    data: {
      id: warrantId,
      projectId: scope.projectId,
      workspaceSlug: scope.workspace,
      subject,
      audienceJson: stringifyJson(audience),
      grantsJson: stringifyJson(grants),
      issuedAt: now,
      expiresAt: new Date(now.getTime() + Math.min(ttlMs, policy.maxTtlMs)),
      sealed: bearer !== undefined,
      ...(bearer === undefined ? {} : { bearerHash: hash(bearer) }),
      rootWarrantId: warrantId,
      ...(delegation === undefined ? {} : { delegationJson: stringifyJson(delegation), delegationDepth: 0 }),
      budgets: { create: budgetsFor(grants) },
    },
    include: { budgets: true },
  });
  await db.codeSiteWarrantLineage.create({
    data: { projectId: scope.projectId, descendantWarrantId: record.id, ancestorWarrantId: record.id, depth: 0 },
  });
  await appendAudit(db, scope, 'warrant_issued', { warrantId: record.id, principal: scope.principal });
  return { warrant: projection(record), ...(bearer === undefined ? {} : { bearer }) };
}

async function attenuate(db, scope, policy, body) {
  const input = object(body);
  const now = new Date();
  const parentId = requiredString(input.parent_warrant_id, 'warrant_parent_required');
  const parent = await loadWarrant(db, scope, parentId, true);
  ensureActive(parent, now);
  const parentAudience = audienceOf(parent);
  const requestedAudience = input.audience === undefined ? parentAudience : principal(input.audience);
  const grants = grantsOf(input.grants);
  const subject = requiredString(input.subject, 'warrant_subject_required');
  const bearer = optionalString(input.bearer);
  const delegation = delegationOfJson(parent.delegationJson);
  if (bearer !== undefined) {
    ensurePrincipal(parentAudience, scope.principal);
    if (!parent.sealed || !parent.bearerHash || !hashesMatch(bearer, parent.bearerHash)) {
      throw new WarrantAuthorityError('bearer_mismatch');
    }
    if (!delegation) throw new WarrantAuthorityError('delegation_not_permitted');
  }
  const lineage = await lineageFor(db, scope, parent.id);
  if (lineage.length >= MAX_CHAIN_DEPTH) throw new WarrantAuthorityError('delegation_chain_depth_exhausted', 409);
  const nextDepth = (parent.delegationDepth ?? 0) + 1;
  if (delegation && nextDepth > delegation.max_depth) {
    throw new WarrantAuthorityError('delegation_depth_exhausted', 409);
  }
  for (const grant of grants) validateAttenuatedGrant(grant, grantsOfJson(parent.grantsJson), parent.budgets, delegation);
  const requestedTtl = input.ttl_ms === undefined
    ? parent.expiresAt.getTime() - now.getTime()
    : positiveInt(input.ttl_ms, 'warrant_ttl_invalid');
  const effectiveTtl = Math.min(
    requestedTtl,
    parent.expiresAt.getTime() - now.getTime(),
    delegation?.max_child_ttl_ms ?? Number.MAX_SAFE_INTEGER,
    policy.maxTtlMs,
  );
  if (effectiveTtl <= 0) throw new WarrantAuthorityError('warrant_ttl_invalid', 400);
  const childBearer = parent.sealed || input.seal === true ? `wb_${randomUUID().replaceAll('-', '')}` : undefined;
  const warrantId = `wr_${randomUUID()}`;
  const child = await db.codeSiteWarrant.create({
    data: {
      id: warrantId,
      projectId: scope.projectId,
      workspaceSlug: scope.workspace,
      subject,
      audienceJson: stringifyJson(requestedAudience),
      grantsJson: stringifyJson(grants),
      issuedAt: now,
      expiresAt: new Date(now.getTime() + effectiveTtl),
      sealed: childBearer !== undefined,
      ...(childBearer === undefined ? {} : { bearerHash: hash(childBearer) }),
      parentWarrantId: parent.id,
      rootWarrantId: parent.rootWarrantId,
      ...(delegation === undefined ? {} : { delegationJson: stringifyJson(delegation), delegationDepth: nextDepth }),
      budgets: { create: budgetsFor(grants) },
    },
    include: { budgets: true },
  });
  await db.codeSiteWarrantLineage.createMany({
    data: [
      { projectId: scope.projectId, descendantWarrantId: child.id, ancestorWarrantId: child.id, depth: 0 },
      ...lineage.map((row) => ({
        projectId: scope.projectId,
        descendantWarrantId: child.id,
        ancestorWarrantId: row.ancestorWarrantId,
        depth: row.depth + 1,
      })),
    ],
  });
  await appendAudit(db, scope, 'warrant_attenuated', { warrantId: child.id, parentWarrantId: parent.id, principal: scope.principal });
  return { warrant: projection(child), ...(childBearer === undefined ? {} : { bearer: childBearer }) };
}

async function check(db, scope, body) {
  const input = object(body);
  const warrant = await loadWarrant(db, scope, requiredString(input.warrant_id, 'warrant_id_required'), true);
  const lineage = await lineageFor(db, scope, warrant.id);
  return decisionFor(warrant, lineage, scope.principal, requiredString(input.tool, 'warrant_tool_required'), record(input.args), optionalString(input.bearer), new Date());
}

async function list(db, scope) {
  const warrants = await db.codeSiteWarrant.findMany({
    where: { projectId: scope.projectId, workspaceSlug: scope.workspace },
    include: { budgets: true },
    orderBy: { createdAt: 'asc' },
  });
  return { warrants: warrants.map(projection) };
}

async function revoke(db, scope, body) {
  const warrantId = requiredString(object(body).warrant_id, 'warrant_id_required');
  await loadWarrant(db, scope, warrantId, false);
  const descendants = await db.codeSiteWarrantLineage.findMany({
    where: { projectId: scope.projectId, ancestorWarrantId: warrantId },
    select: { descendantWarrantId: true },
  });
  const result = await db.codeSiteWarrant.updateMany({
    where: { id: { in: descendants.map((row) => row.descendantWarrantId) }, projectId: scope.projectId, status: 'active' },
    data: { status: 'revoked', revokedAt: new Date() },
  });
  await appendAudit(db, scope, 'warrant_revoked', { warrantId, revokedCount: result.count, principal: scope.principal });
  return { revoked_count: result.count };
}

async function renew(db, scope, policy, body) {
  const input = object(body);
  const warrant = await loadWarrant(db, scope, requiredString(input.warrant_id, 'warrant_id_required'), true);
  const now = new Date();
  ensureActive(warrant, now);
  ensurePrincipal(audienceOf(warrant), scope.principal);
  if (warrant.sealed && (!warrant.bearerHash || !hashesMatch(optionalString(input.bearer), warrant.bearerHash))) {
    throw new WarrantAuthorityError('bearer_mismatch');
  }
  const lineage = await lineageFor(db, scope, warrant.id);
  const ancestorExpiry = lineage.slice(1).reduce((value, row) => Math.min(value, row.ancestor.expiresAt.getTime()), Number.MAX_SAFE_INTEGER);
  const totalExpiry = Math.min(warrant.issuedAt.getTime() + policy.maxTtlMs, ancestorExpiry);
  const extension = positiveInt(input.ttl_ms, 'warrant_ttl_invalid');
  const nextExpiry = Math.min(warrant.expiresAt.getTime() + extension, totalExpiry);
  if (nextExpiry <= warrant.expiresAt.getTime()) throw new WarrantAuthorityError('warrant_renewal_ceiling_reached', 409);
  const updated = await db.codeSiteWarrant.update({
    where: { id: warrant.id }, data: { expiresAt: new Date(nextExpiry) }, include: { budgets: true },
  });
  for (const [tool, count] of Object.entries(record(input.add_invocations) ?? {})) {
    const grant = grantsOfJson(warrant.grantsJson).find((item) => item.tool === tool);
    if (!grant || grant.max_invocations === undefined) throw new WarrantAuthorityError('warrant_top_up_not_permitted', 400);
    const amount = positiveInt(count, 'warrant_top_up_invalid');
    const budget = updated.budgets.find((item) => item.tool === tool);
    if (!budget) throw new WarrantAuthorityError('warrant_budget_corrupt', 503);
    await db.codeSiteWarrantBudget.update({
      where: { warrantId_tool: { warrantId: warrant.id, tool } },
      data: { remainingInvocations: Math.min(budget.remainingInvocations + amount, Math.min(grant.max_invocations, policy.maxInvocations)) },
    });
  }
  const refreshed = await loadWarrant(db, scope, warrant.id, true);
  await appendAudit(db, scope, 'warrant_renewed', { warrantId: warrant.id, principal: scope.principal });
  return { warrant: projection(refreshed) };
}

async function reserve(db, scope, body) {
  const input = object(body);
  const warrantId = requiredString(input.warrant_id, 'warrant_id_required');
  const tool = requiredString(input.tool, 'warrant_tool_required');
  const idempotencyKey = requiredString(input.idempotency_key, 'warrant_request_id_required');
  if (idempotencyKey.length > 256) throw new WarrantAuthorityError('warrant_request_id_invalid', 400);
  const requestDigest = hash(stableJson({ warrantId, tool, args: record(input.args) ?? {}, principal: scope.principal }));
  const prior = await db.codeSiteWarrantReceipt.findUnique({
    where: { projectId_idempotencyKey: { projectId: scope.projectId, idempotencyKey } },
  });
  if (prior) {
    if (prior.requestDigest !== requestDigest || prior.warrantId !== warrantId || prior.tool !== tool) {
      throw new WarrantAuthorityError('warrant_idempotency_key_reused', 409);
    }
    return { ...deny(`receipt_${prior.status}`, 'This request identifier has already been processed.'), reservation: { receipt_id: prior.id, status: prior.status } };
  }
  const warrant = await loadWarrant(db, scope, warrantId, true);
  const lineage = await lineageFor(db, scope, warrant.id);
  const decision = decisionFor(warrant, lineage, scope.principal, tool, record(input.args), optionalString(input.bearer), new Date());
  if (!decision.allowed) return decision;
  for (const row of lineage) {
    const budget = row.ancestor.budgets.find((item) => item.tool === tool);
    if (!budget) continue;
    const updated = await db.codeSiteWarrantBudget.updateMany({
      where: { id: budget.id, remainingInvocations: { gt: 0 } },
      data: { remainingInvocations: { decrement: 1 } },
    });
    // A conditional write that loses its final slot must abort the entire
    // Serializable transaction so an earlier ancestor decrement cannot leak.
    if (updated.count !== 1) throw new WarrantAuthorityError('warrant_reservation_race', 409);
  }
  const receipt = await db.codeSiteWarrantReceipt.create({
    data: {
      projectId: scope.projectId,
      workspaceSlug: scope.workspace,
      idempotencyKey,
      warrantId: warrant.id,
      tool,
      principalJson: stringifyJson(scope.principal),
      requestDigest,
    },
  });
  await appendAudit(db, scope, 'warrant_reserved', { warrantId: warrant.id, receiptId: receipt.id, tool, principal: scope.principal });
  return {
    ...decision,
    reservation: {
      receipt_id: receipt.id,
      status: 'reserved',
      ...(receipt.reservedAt instanceof Date ? { reserved_at_ms: receipt.reservedAt.getTime() } : {}),
    },
  };
}

async function settle(db, scope, body) {
  const input = object(body);
  const receipt = await db.codeSiteWarrantReceipt.findFirst({
    where: { id: requiredString(input.receipt_id, 'warrant_receipt_id_required'), projectId: scope.projectId, workspaceSlug: scope.workspace },
  });
  if (!receipt) throw new WarrantAuthorityError('warrant_receipt_not_found', 404);
  ensurePrincipal(principal(parseJson(receipt.principalJson, null)), scope.principal);
  if (receipt.status !== 'reserved') return { receipt: receiptProjection(receipt) };
  const outcome = requiredString(input.outcome, 'warrant_receipt_outcome_required');
  if (!['succeeded', 'failed', 'unknown'].includes(outcome)) throw new WarrantAuthorityError('warrant_receipt_outcome_invalid', 400);
  if (outcome === 'failed') {
    const lineage = await lineageFor(db, scope, receipt.warrantId);
    for (const row of lineage) {
      const budget = row.ancestor.budgets.find((item) => item.tool === receipt.tool);
      if (budget) await db.codeSiteWarrantBudget.update({ where: { id: budget.id }, data: { remainingInvocations: { increment: 1 } } });
    }
  }
  const updated = await db.codeSiteWarrantReceipt.update({
    where: { id: receipt.id },
    data: { status: outcome, settledAt: new Date(), ...(outcome === 'succeeded' ? {} : { failureCode: optionalString(input.failure_code) ?? outcome }) },
  });
  await appendAudit(db, scope, `warrant_${outcome}`, { warrantId: receipt.warrantId, receiptId: receipt.id, tool: receipt.tool, principal: scope.principal });
  return { receipt: receiptProjection(updated) };
}

async function loadWarrant(db, scope, warrantId, includeBudgets) {
  const record = await db.codeSiteWarrant.findFirst({
    where: { id: warrantId, projectId: scope.projectId, workspaceSlug: scope.workspace },
    ...(includeBudgets ? { include: { budgets: true } } : {}),
  });
  if (!record) throw new WarrantAuthorityError('no_such_warrant', 404);
  return record;
}

async function lineageFor(db, scope, warrantId) {
  const lineage = await db.codeSiteWarrantLineage.findMany({
    where: { projectId: scope.projectId, descendantWarrantId: warrantId },
    include: { ancestor: { include: { budgets: true } } },
    orderBy: { depth: 'asc' },
  });
  if (
    lineage.length === 0
    || lineage.length > MAX_CHAIN_DEPTH
    || lineage[0].depth !== 0
    || lineage[0].ancestorWarrantId !== warrantId
  ) throw new WarrantAuthorityError('warrant_lineage_corrupt', 503);
  return lineage;
}

function decisionFor(warrant, lineage, actingPrincipal, tool, args, bearer, now) {
  if (warrant.status !== 'active') return deny('revoked', 'This warrant has been revoked.');
  if (now >= warrant.expiresAt) return deny('expired', 'This warrant has expired.');
  try { ensurePrincipal(audienceOf(warrant), actingPrincipal); } catch { return deny('principal_mismatch', 'This warrant is bound to a different authenticated principal.'); }
  if (warrant.sealed && (!warrant.bearerHash || !hashesMatch(bearer, warrant.bearerHash))) {
    return deny('bearer_mismatch', 'This warrant is sealed; the call must prove possession with its bearer secret.');
  }
  const covering = grantsOfJson(warrant.grantsJson).filter((grant) => grant.tool === tool);
  if (covering.length === 0) return deny('tool_not_covered', `This warrant does not cover the '${tool}' capability.`);
  if (!covering.some((grant) => grantAccepts(grant, args))) return deny('arg_out_of_scope', 'The requested arguments are outside this warrant scope.');
  for (const row of lineage) {
    if (row.ancestor.status !== 'active' || now >= row.ancestor.expiresAt) return deny('revoked', 'An ancestor warrant is no longer active.');
    const budget = row.ancestor.budgets.find((item) => item.tool === tool);
    if (budget && budget.remainingInvocations <= 0) return deny('invocations_exhausted', `This warrant used up its allowance for '${tool}'.`);
  }
  return { allowed: true, warrant_id: warrant.id };
}

async function appendAudit(db, scope, eventType, payload) {
  const current = await db.codeSiteWarrantAuditHead.findUnique({ where: { projectId: scope.projectId } });
  await verifyAuditChain(db, scope, current);
  const previousHash = current?.headHash ?? hash(stableJson({ projectId: scope.projectId, workspace: scope.workspace, event: 'warrant_genesis' }));
  const sequence = (current?.sequence ?? 0) + 1;
  const event = { sequence, eventType, occurredAt: new Date().toISOString(), payload };
  const eventHash = hash(`${previousHash}\n${stableJson(event)}`);
  await db.codeSiteWarrantAuditOutbox.create({
    data: { projectId: scope.projectId, workspaceSlug: scope.workspace, sequence, eventType, eventJson: stringifyJson(event), previousHash, eventHash },
  });
  await db.codeSiteWarrantAuditHead.upsert({
    where: { projectId: scope.projectId },
    create: { projectId: scope.projectId, sequence, headHash: eventHash },
    update: { sequence, headHash: eventHash },
  });
}

async function verifyAuditChain(db, scope, head) {
  const events = await db.codeSiteWarrantAuditOutbox.findMany({
    where: { projectId: scope.projectId, workspaceSlug: scope.workspace },
    orderBy: { sequence: 'asc' },
  });
  let previousHash = hash(stableJson({ projectId: scope.projectId, workspace: scope.workspace, event: 'warrant_genesis' }));
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.sequence !== index + 1 || event.previousHash !== previousHash) {
      throw new WarrantAuthorityError('warrant_audit_chain_corrupt', 503);
    }
    const parsed = parseJson(event.eventJson, null);
    if (!parsed || hash(`${previousHash}\n${stableJson(parsed)}`) !== event.eventHash) {
      throw new WarrantAuthorityError('warrant_audit_chain_corrupt', 503);
    }
    previousHash = event.eventHash;
  }
  if ((head === null || head === undefined) && events.length !== 0) {
    throw new WarrantAuthorityError('warrant_audit_chain_corrupt', 503);
  }
  if (head && (head.sequence !== events.length || head.headHash !== previousHash)) {
    throw new WarrantAuthorityError('warrant_audit_chain_corrupt', 503);
  }
}

function projection(record) {
  return {
    warrant_id: record.id, subject: record.subject, audience: audienceOf(record), grants: grantsOfJson(record.grantsJson),
    issued_at_ms: record.issuedAt.getTime(), expires_at_ms: record.expiresAt.getTime(),
    ...(record.parentWarrantId ? { parent_warrant_id: record.parentWarrantId } : {}),
    root_warrant_id: record.rootWarrantId, status: record.status,
    ...(record.sealed ? { sealed: true } : {}),
    ...(record.delegationJson ? { delegation: delegationOfJson(record.delegationJson), delegation_depth: record.delegationDepth ?? 0 } : {}),
  };
}

function receiptProjection(receipt) {
  return {
    receipt_id: receipt.id,
    status: receipt.status,
    ...(receipt.reservedAt instanceof Date ? { reserved_at_ms: receipt.reservedAt.getTime() } : {}),
  };
}
function deny(reason_code, human_reason) { return { allowed: false, reason_code, human_reason }; }
function ensureActive(warrant, now) {
  if (warrant.status !== 'active') throw new WarrantAuthorityError('warrant_revoked', 409);
  if (now >= warrant.expiresAt) throw new WarrantAuthorityError('warrant_expired', 409);
}
function requiredScope(value) {
  const scope = object(value);
  return { projectId: requiredString(scope.projectId, 'warrant_project_required'), workspace: requiredString(scope.workspace, 'warrant_workspace_required'), principal: principal(scope.principal) };
}
function requiredPolicy(value) {
  const policy = object(value);
  return { maxActive: positiveInt(policy.maxActive, 'warrant_policy_invalid'), maxTtlMs: positiveInt(policy.maxTtlMs, 'warrant_policy_invalid'), maxInvocations: positiveInt(policy.maxInvocations, 'warrant_policy_invalid') };
}
function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WarrantAuthorityError('warrant_payload_invalid', 400); return value; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined; }
function requiredString(value, code) { if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\r\n]/.test(value)) throw new WarrantAuthorityError(code, 400); return value.trim(); }
function optionalString(value) { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function positiveInt(value, code) { if (!Number.isSafeInteger(value) || value <= 0) throw new WarrantAuthorityError(code, 400); return value; }
function principal(value) {
  const raw = object(value);
  const issuer = requiredString(raw.issuer, 'warrant_principal_invalid'); const subject = requiredString(raw.subject, 'warrant_principal_invalid'); const workspace = requiredString(raw.workspace, 'warrant_principal_invalid');
  const project = raw.project === undefined ? undefined : requiredString(raw.project, 'warrant_principal_invalid');
  return { issuer, subject, workspace, ...(project === undefined ? {} : { project }) };
}
function audienceOf(record) { return principal(parseJson(record.audienceJson, null)); }
function samePrincipal(left, right) { return left.issuer === right.issuer && left.subject === right.subject && left.workspace === right.workspace && left.project === right.project; }
function ensurePrincipal(expected, actual) { if (!samePrincipal(expected, actual)) throw new WarrantAuthorityError('principal_mismatch'); }
function hashesMatch(value, expected) { if (!value || !expected) return false; const left = Buffer.from(hash(value)); const right = Buffer.from(expected); return left.length === right.length && timingSafeEqual(left, right); }
function hash(value) { return createHash('sha256').update(String(value)).digest('hex'); }
function grantsOf(value) {
  if (!Array.isArray(value) || value.length === 0) throw new WarrantAuthorityError('warrant_grants_invalid', 400);
  return value.map((raw) => { const entry = object(raw); const tool = requiredString(entry.tool, 'warrant_grants_invalid'); const constraints = entry.arg_constraints === undefined ? undefined : constraintMap(entry.arg_constraints); const max = entry.max_invocations === undefined ? undefined : positiveInt(entry.max_invocations, 'warrant_grants_invalid'); return { tool, ...(constraints === undefined ? {} : { arg_constraints: constraints }), ...(max === undefined ? {} : { max_invocations: max }) }; });
}
function grantsOfJson(value) { return grantsOf(parseJson(value, [])); }
function constraintMap(value) { const raw = object(value); const output = {}; for (const [key, pattern] of Object.entries(raw)) { if (typeof pattern !== 'string' || !pattern) throw new WarrantAuthorityError('warrant_constraints_invalid', 400); output[key] = pattern; } return output; }
function budgetsFor(grants) { const remaining = new Map(); for (const grant of grants) if (grant.max_invocations !== undefined) remaining.set(grant.tool, Math.min(remaining.get(grant.tool) ?? grant.max_invocations, grant.max_invocations)); return [...remaining].map(([tool, maximumInvocations]) => ({ tool, maximumInvocations, remainingInvocations: maximumInvocations })); }
function delegationOf(value, sealed) { if (value === undefined) return undefined; if (!sealed) throw new WarrantAuthorityError('warrant_delegation_requires_seal', 400); const raw = object(value); const policy = { max_depth: positiveInt(raw.max_depth, 'warrant_delegation_invalid') }; if (policy.max_depth >= MAX_CHAIN_DEPTH) throw new WarrantAuthorityError('warrant_delegation_invalid', 400); if (raw.max_child_ttl_ms !== undefined) policy.max_child_ttl_ms = positiveInt(raw.max_child_ttl_ms, 'warrant_delegation_invalid'); if (raw.max_child_invocations !== undefined) policy.max_child_invocations = positiveInt(raw.max_child_invocations, 'warrant_delegation_invalid'); return policy; }
function delegationOfJson(value) { return value ? delegationOf(parseJson(value, null), true) : undefined; }
function validateAttenuatedGrant(child, parentGrants, parentBudgets, delegation) {
  const parent = parentGrants.find((grant) => grant.tool === child.tool); if (!parent) throw new WarrantAuthorityError('warrant_attenuation_tool_not_covered', 400);
  for (const [key, pattern] of Object.entries(child.arg_constraints ?? {})) if (parent.arg_constraints?.[key] !== undefined && parent.arg_constraints[key] !== pattern) throw new WarrantAuthorityError('warrant_attenuation_constraint_widened', 400);
  if (child.max_invocations !== undefined) { const budget = parentBudgets.find((item) => item.tool === child.tool); if (budget && child.max_invocations > budget.remainingInvocations) throw new WarrantAuthorityError('warrant_attenuation_budget_exceeded', 400); }
  if (delegation?.max_child_invocations !== undefined && (child.max_invocations === undefined || child.max_invocations > delegation.max_child_invocations)) throw new WarrantAuthorityError('warrant_attenuation_policy_exceeded', 400);
}
function grantAccepts(grant, args) { for (const [key, pattern] of Object.entries(grant.arg_constraints ?? {})) { const value = args?.[key]; if (value === undefined) continue; if (typeof value !== 'string' || !glob(pattern, value)) return false; } return true; }
function glob(pattern, value) { let source = ''; for (let index = 0; index < pattern.length; index += 1) { const char = pattern[index]; if (char === '*') { if (pattern[index + 1] === '*') { source += '[\\s\\S]*'; index += 1; } else source += '[^.]*'; } else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); } return new RegExp(`^${source}$`).test(value); }
