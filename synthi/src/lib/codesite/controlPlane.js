import prisma from '@/lib/prisma';
import { buildArtifactProjection, codesiteSchemas, writeArtifactProjection } from './artifacts';
import { asArray, parseJson, stringifyJson, stableJson } from './json';
import {
  classifyPath,
  compileZonePolicy,
  digest,
  evaluateLeaseRequest,
  evaluatePathMutation,
  normalizePath,
  normalizePathList,
  pathsForRoute,
  predictCollisions,
} from './policy';

const PROJECT_INCLUDE = {
  agentSessions: true,
  executionPlans: true,
  mutationLeases: true,
  mutationTxns: true,
  assumptions: true,
  policyDecisions: true,
  events: { orderBy: { createdAt: 'asc' } },
  incidents: true,
  inspectionRuns: true,
  proofBundles: true,
  lineProvenance: true,
  documents: true,
  counterfactualRuns: true,
  policyDeltas: true,
  inboxItems: true,
};

export async function listProjects(workspaceSlug) {
  const projects = await prisma.codeSiteProject.findMany({
    where: { workspaceSlug },
    orderBy: { updatedAt: 'desc' },
    include: {
      agentSessions: true,
      executionPlans: true,
      mutationLeases: true,
      incidents: true,
      inspectionRuns: true,
    },
  });
  return projects.map(projectSummary);
}

export async function createProject(workspaceSlug, actor, body = {}) {
  const title = String(body.title || body.request || 'CodeSite project').trim();
  const request = String(body.request || title).trim();
  const zonePolicy = compileZonePolicy(body.zonePolicy || body.zone_policy || {});
  const controlPlan = buildInitialControlPlan({ title, request, body, zonePolicy });

  const project = await prisma.codeSiteProject.create({
    data: {
      workspaceSlug,
      title,
      request,
      status: 'active',
      zonePolicyJson: stringifyJson(zonePolicy),
      controlPlanJson: stringifyJson(controlPlan),
      createdByUserId: actor?.userId || null,
    },
  });

  await upsertMutationZones(workspaceSlug, zonePolicy);
  await recordEvent(project.id, {
    eventType: 'tower_instruction',
    actorType: 'human',
    actorId: actor?.userId || null,
    details: {
      instruction: 'CodeSite project opened. File flight plans before mutation.',
      controlPlan,
    },
  });

  return getProject(workspaceSlug, project.id);
}

function buildInitialControlPlan({ title, request, body, zonePolicy }) {
  const missions = asArray(body.missions || body.executionPlans || body.execution_plans);
  return {
    version: 1,
    title,
    request,
    towerState: 'planning',
    selectedStrategy: body.strategy || 'airspace_survey_first',
    missions,
    routeIntersections: [],
    requiredRadar: ['clearance', 'type', 'test', 'handover'],
    zoneDigest: digest(zonePolicy),
    createdAt: new Date().toISOString(),
  };
}

async function upsertMutationZones(workspaceSlug, zonePolicy) {
  for (const zone of asArray(zonePolicy.zones)) {
    await prisma.codeSiteMutationZone.upsert({
      where: {
        workspaceSlug_zoneKey: {
          workspaceSlug,
          zoneKey: zone.zoneKey,
        },
      },
      update: {
        label: zone.label,
        zoneClass: zone.class,
        pathsJson: stringifyJson(zone.paths || []),
        rulesJson: stringifyJson(zone.rules || []),
        risk: zone.risk || 'medium',
      },
      create: {
        workspaceSlug,
        zoneKey: zone.zoneKey,
        label: zone.label,
        zoneClass: zone.class,
        pathsJson: stringifyJson(zone.paths || []),
        rulesJson: stringifyJson(zone.rules || []),
        risk: zone.risk || 'medium',
      },
    });
  }
}

export async function getProject(workspaceSlug, projectId) {
  const project = await prisma.codeSiteProject.findFirst({
    where: { id: projectId, workspaceSlug },
    include: PROJECT_INCLUDE,
  });
  if (!project) return null;
  return projectProjection(project);
}

export async function updateZonePolicy(workspaceSlug, projectId, body = {}) {
  const project = await requireProject(workspaceSlug, projectId);
  const previous = parseJson(project.zonePolicyJson, {});
  const next = compileZonePolicy({
    ...previous,
    ...(body.zonePolicy || body.zone_policy || body),
  });
  await prisma.codeSiteProject.update({
    where: { id: project.id },
    data: { zonePolicyJson: stringifyJson(next) },
  });
  await upsertMutationZones(workspaceSlug, next);
  await recordEvent(project.id, {
    eventType: 'tower_instruction',
    details: {
      instruction: 'Airspace policy updated.',
      zoneDigest: digest(next),
    },
  });
  return getProject(workspaceSlug, project.id);
}

export async function updateControlPlan(workspaceSlug, projectId, body = {}) {
  const project = await requireProject(workspaceSlug, projectId);
  const previous = parseJson(project.controlPlanJson, {});
  const next = {
    ...previous,
    ...body,
    updatedAt: new Date().toISOString(),
  };
  await prisma.codeSiteProject.update({
    where: { id: project.id },
    data: { controlPlanJson: stringifyJson(next) },
  });
  await recordEvent(project.id, {
    eventType: 'tower_instruction',
    details: {
      instruction: 'Tower control plan updated.',
      controlPlan: next,
    },
  });
  return getProject(workspaceSlug, project.id);
}

export async function createAgentSession(workspaceSlug, projectId, actor, body = {}) {
  const project = await requireProject(workspaceSlug, projectId);
  const callsign = String(body.displayCallsign || body.callsign || nextCallsign(body.agentProvider || 'AGENT')).toUpperCase();
  const session = await prisma.codeSiteAgentSession.create({
    data: {
      projectId: project.id,
      ownerUserId: body.ownerUserId || actor?.userId || 'unknown',
      agentProvider: String(body.agentProvider || body.provider || 'custom'),
      agentRuntime: body.agentRuntime || body.runtime || null,
      providerSessionRef: body.providerSessionRef || body.provider_session_ref || null,
      displayCallsign: callsign,
      status: body.status || 'registered',
      permissionsJson: stringifyJson(body.permissions || []),
      redactionPolicyJson: stringifyJson(body.redactionPolicy || body.redaction_policy || defaultRedactionPolicy()),
    },
  });
  await recordEvent(project.id, {
    eventType: 'transponder_update',
    displayCallsign: callsign,
    actorType: 'agent_session',
    actorId: session.id,
    details: {
      status: session.status,
      provider: session.agentProvider,
      runtime: session.agentRuntime,
      instruction: `${callsign} registered with tower.`,
    },
  });
  return sessionProjection(session);
}

function nextCallsign(provider) {
  const prefix = String(provider || 'AGENT').replace(/[^a-z0-9]/gi, '').slice(0, 6) || 'AGENT';
  return `${prefix}-${Math.floor(10 + Math.random() * 89)}`;
}

function defaultRedactionPolicy() {
  return {
    redactSecrets: true,
    redactPrivatePrompts: true,
    allowedDocumentKinds: ['rfi', 'change_order', 'inspection_request', 'inspection_result', 'mayday', 'handoff'],
  };
}

export async function createExecutionPlan(workspaceSlug, projectId, body = {}) {
  const project = await requireProject(workspaceSlug, projectId);
  const agentSession = await requireAgentSession(project.id, body.agentSessionId || body.agent_session_id);
  const route = pathsForRoute(body.route || body.allowedPaths || []);
  const blockedZones = pathsForRoute(body.blockedZones || body.noFlyZones || body.no_fly_zones || []);
  const plan = await prisma.codeSiteExecutionPlan.create({
    data: {
      projectId: project.id,
      agentSessionId: agentSession.id,
      displayCallsign: body.displayCallsign || body.callsign || agentSession.displayCallsign,
      mission: String(body.mission || 'Code mutation flight'),
      domain: String(body.domain || body.altitude || 'implementation'),
      status: body.status || 'filed',
      routeJson: stringifyJson(route),
      blockedZonesJson: stringifyJson(blockedZones),
      abortJson: stringifyJson(body.abortConditions || body.abort_conditions || []),
      requestedToolsJson: stringifyJson(body.requestedTools || body.requested_tools || []),
      estimatedDurationMs: normalizeDurationMs(body.estimatedDurationMs || body.estimated_duration_ms || body.estimatedDuration),
    },
  });
  await recordEvent(project.id, {
    eventType: 'flight_plan_filed',
    displayCallsign: plan.displayCallsign,
    actorType: 'agent_session',
    actorId: agentSession.id,
    details: {
      executionPlanId: plan.id,
      mission: plan.mission,
      route,
      blockedZones,
    },
  });
  return executionPlanProjection(plan);
}

function normalizeDurationMs(value) {
  if (Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d+)\s*(ms|s|m|h)?$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] || 'ms').toLowerCase();
  return amount * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit] || 1);
}

export async function requestMutationLease(workspaceSlug, executionPlanId, body = {}) {
  const plan = await prisma.codeSiteExecutionPlan.findFirst({
    where: { id: executionPlanId, project: { workspaceSlug } },
    include: { project: true, agentSession: true },
  });
  if (!plan) throw notFound('execution_plan_not_found');

  const zonePolicy = parseJson(plan.project.zonePolicyJson, compileZonePolicy());
  const executionPlan = executionPlanProjection(plan);
  const requestedLease = {
    allowedPaths: body.allowedPaths || body.allowed_paths || executionPlan.route,
    blockedPaths: body.blockedPaths || body.blocked_paths || executionPlan.blockedZones,
    allowedTools: body.allowedTools || body.allowed_tools || body.tools || executionPlan.requestedTools,
    invariants: body.invariants || defaultInvariantsForRoute(executionPlan.route, zonePolicy),
    requiredRadar: body.requiredRadar || body.required_radar || defaultRadarForRoute(executionPlan.route, zonePolicy),
    expiresAt: body.expiresAt || body.expires_at || null,
  };
  const policy = evaluateLeaseRequest({ executionPlan, zonePolicy, requestedLease });
  const lease = await prisma.codeSiteMutationLease.create({
    data: {
      projectId: plan.projectId,
      executionPlanId: plan.id,
      agentSessionId: plan.agentSessionId,
      displayCallsign: plan.displayCallsign,
      status: policy.status,
      leaseJson: stringifyJson({
        ...requestedLease,
        issuedBy: 'codesite_policy_engine',
        towerInstruction: policy.towerInstruction,
        inspectedZones: policy.inspectedZones,
      }),
      dojoProofRef: body.dojoProofRef || body.dojo_proof_ref || null,
      dojoLicenseRef: body.dojoLicenseRef || body.dojo_license_ref || null,
      dojoEvidenceRefsJson: stringifyJson(body.dojoEvidenceRefs || body.dojo_evidence_refs || []),
      dojoLedgerCheckpointHash: body.dojoLedgerCheckpointHash || body.dojo_ledger_checkpoint_hash || null,
      dojoDecisionDigest: body.dojoDecisionDigest || body.dojo_decision_digest || null,
      implementationStatusJson: stringifyJson(body.implementationStatus || body.implementation_status || { executable: false, productionRuntime: false }),
      expiresAt: requestedLease.expiresAt ? new Date(requestedLease.expiresAt) : null,
    },
  });
  const decision = await createPolicyDecision(plan.projectId, {
    mutationLeaseId: lease.id,
    displayCallsign: lease.displayCallsign,
    decision: policy.decision,
    reasonCodes: policy.reasonCodes,
    input: { executionPlan, requestedLease },
    decisionJson: {
      status: policy.status,
      towerInstruction: policy.towerInstruction,
      inspectedZones: policy.inspectedZones,
    },
  });
  await recordEvent(plan.projectId, {
    mutationLeaseId: lease.id,
    eventType: policy.decision === 'block' ? 'holding_pattern' : 'clearance_issued',
    displayCallsign: lease.displayCallsign,
    actorType: 'policy_engine',
    actorId: decision.id,
    details: {
      mutationLeaseId: lease.id,
      policyDecisionId: decision.id,
      status: policy.status,
      reasonCodes: policy.reasonCodes,
      towerInstruction: policy.towerInstruction,
    },
  });
  return mutationLeaseProjection(lease, { policyDecision: policyDecisionProjection(decision) });
}

function defaultInvariantsForRoute(route, zonePolicy) {
  const classes = pathsForRoute(route).map((path) => classifyPath(path.replace(/\*\*?$/, 'index.ts'), zonePolicy)?.class);
  const invariants = ['clearance.diff.inside_route', 'no.secret.exposure'];
  if (classes.includes('A') || classes.includes('B')) invariants.push('restricted_airspace.inspector_required');
  return invariants;
}

function defaultRadarForRoute(route, zonePolicy) {
  const classes = pathsForRoute(route).map((path) => classifyPath(path.replace(/\*\*?$/, 'index.ts'), zonePolicy)?.class);
  const radar = ['clearance', 'handover'];
  if (classes.includes('A') || classes.includes('B')) radar.push('api_contract', 'security');
  if (classes.some((klass) => ['A', 'B', 'C'].includes(klass))) radar.push('typecheck', 'tests');
  return [...new Set(radar)];
}

export async function revokeMutationLease(workspaceSlug, mutationLeaseId, body = {}) {
  const lease = await requireLease(workspaceSlug, mutationLeaseId);
  const updated = await prisma.codeSiteMutationLease.update({
    where: { id: lease.id },
    data: {
      status: 'revoked',
      revokedAt: new Date(),
    },
  });
  await createPolicyDecision(lease.projectId, {
    mutationLeaseId: lease.id,
    displayCallsign: lease.displayCallsign,
    decision: 'revoke',
    reasonCodes: asArray(body.reasonCodes || body.reason_codes || ['tower_revocation']),
    input: { mutationLeaseId, body },
    decisionJson: { instruction: body.instruction || 'Clearance revoked. Hold position.' },
  });
  await recordEvent(lease.projectId, {
    mutationLeaseId: lease.id,
    eventType: 'ground_stop',
    displayCallsign: lease.displayCallsign,
    details: {
      reason: body.reason || 'tower_revocation',
      instruction: body.instruction || 'Clearance revoked. Hold position.',
    },
  });
  return mutationLeaseProjection(updated);
}

export async function openTransaction(workspaceSlug, mutationLeaseId, body = {}) {
  const lease = await requireLease(workspaceSlug, mutationLeaseId);
  if (lease.status !== 'active') {
    throw badRequest('clearance_not_active', { status: lease.status });
  }
  const leaseJson = parseJson(lease.leaseJson, {});
  const transaction = await prisma.codeSiteMutationTransaction.create({
    data: {
      projectId: lease.projectId,
      mutationLeaseId: lease.id,
      agentSessionId: lease.agentSessionId,
      baseSnapshot: body.baseSnapshot || body.base_snapshot || digest({ workspaceSlug, mutationLeaseId, openedAt: Date.now() }),
      isolation: body.isolation || 'serializable',
      status: 'open',
      readSetJson: stringifyJson(normalizePathList(body.readSet || body.read_set || [])),
      writeSetJson: stringifyJson(normalizePathList(body.writeSet || body.write_set || [])),
      observedReadSetJson: stringifyJson([]),
      observedWriteSetJson: stringifyJson([]),
      semanticDependencyRefsJson: stringifyJson(body.semanticDependencyRefs || body.semantic_dependency_refs || []),
      invariantsJson: stringifyJson(body.invariants || leaseJson.invariants || []),
      assumptionRefsJson: stringifyJson(body.assumptionRefs || body.assumption_refs || []),
    },
  });
  await recordEvent(lease.projectId, {
    mutationLeaseId: lease.id,
    eventType: 'transaction_opened',
    displayCallsign: lease.displayCallsign,
    actorType: 'agent_session',
    actorId: lease.agentSessionId,
    details: {
      transactionId: transaction.id,
      baseSnapshot: transaction.baseSnapshot,
      isolation: transaction.isolation,
    },
  });
  return transactionProjection(transaction);
}

export async function getTransaction(workspaceSlug, transactionId) {
  const transaction = await prisma.codeSiteMutationTransaction.findFirst({
    where: { id: transactionId, project: { workspaceSlug } },
    include: { mutationLease: true, agentSession: true, proofBundles: true, lineProvenance: true },
  });
  if (!transaction) return null;
  return transactionProjection(transaction);
}

export async function recordTransactionRead(workspaceSlug, transactionId, body = {}) {
  const transaction = await requireTransaction(workspaceSlug, transactionId);
  const path = normalizePath(body.path || body.filePath || body.file_path);
  if (!path) throw badRequest('invalid_path');
  const observed = appendUnique(parseJson(transaction.observedReadSetJson, []), path);
  const declared = appendUnique(parseJson(transaction.readSetJson, []), path);
  const updated = await prisma.codeSiteMutationTransaction.update({
    where: { id: transaction.id },
    data: {
      readSetJson: stringifyJson(declared),
      observedReadSetJson: stringifyJson(observed),
    },
  });
  await recordEvent(transaction.projectId, {
    mutationLeaseId: transaction.mutationLeaseId,
    eventType: 'transponder_update',
    displayCallsign: transaction.mutationLease.displayCallsign,
    actorType: 'transaction',
    actorId: transaction.id,
    details: { type: 'read_recorded', transactionId: transaction.id, path },
  });
  return transactionProjection(updated);
}

export async function recordTransactionWrite(workspaceSlug, transactionId, body = {}) {
  const transaction = await requireTransaction(workspaceSlug, transactionId);
  const path = normalizePath(body.path || body.filePath || body.file_path);
  if (!path) throw badRequest('invalid_path');
  const project = await prisma.codeSiteProject.findUnique({ where: { id: transaction.projectId } });
  const zonePolicy = parseJson(project.zonePolicyJson, compileZonePolicy());
  const evaluation = evaluatePathMutation({
    lease: transaction.mutationLease,
    path,
    tool: body.tool || 'file_write',
    zonePolicy,
  });

  await recordEvent(transaction.projectId, {
    mutationLeaseId: transaction.mutationLeaseId,
    eventType: 'write_attempted',
    displayCallsign: transaction.mutationLease.displayCallsign,
    actorType: 'transaction',
    actorId: transaction.id,
    details: { transactionId: transaction.id, path, tool: body.tool || 'file_write', zone: evaluation.zone },
  });

  if (!evaluation.ok) {
    const decision = await createPolicyDecision(transaction.projectId, {
      mutationLeaseId: transaction.mutationLeaseId,
      displayCallsign: transaction.mutationLease.displayCallsign,
      decision: 'block',
      reasonCodes: evaluation.reasonCodes,
      input: { transactionId, path, tool: body.tool || 'file_write' },
      decisionJson: {
        path,
        zone: evaluation.zone,
        towerInstruction: `Write denied for ${path}. File change order or request a new clearance.`,
      },
    });
    await recordEvent(transaction.projectId, {
      mutationLeaseId: transaction.mutationLeaseId,
      eventType: 'write_denied',
      displayCallsign: transaction.mutationLease.displayCallsign,
      actorType: 'policy_engine',
      actorId: decision.id,
      details: {
        transactionId: transaction.id,
        path,
        reasonCodes: evaluation.reasonCodes,
        policyDecisionId: decision.id,
        zone: evaluation.zone,
      },
    });
    return {
      ok: false,
      transaction: transactionProjection(transaction),
      policyDecision: policyDecisionProjection(decision),
    };
  }

  const observed = appendUnique(parseJson(transaction.observedWriteSetJson, []), path);
  const declared = appendUnique(parseJson(transaction.writeSetJson, []), path);
  const updated = await prisma.codeSiteMutationTransaction.update({
    where: { id: transaction.id },
    data: {
      writeSetJson: stringifyJson(declared),
      observedWriteSetJson: stringifyJson(observed),
    },
  });
  const invalidated = await invalidateAssumptionsForPath(transaction.projectId, path, transaction.mutationLease.displayCallsign);
  await recordEvent(transaction.projectId, {
    mutationLeaseId: transaction.mutationLeaseId,
    eventType: 'write_allowed',
    displayCallsign: transaction.mutationLease.displayCallsign,
    actorType: 'transaction',
    actorId: transaction.id,
    details: { transactionId: transaction.id, path, zone: evaluation.zone, invalidatedAssumptions: invalidated },
  });
  return { ok: true, transaction: transactionProjection(updated), invalidatedAssumptions: invalidated };
}

async function invalidateAssumptionsForPath(projectId, path, invalidatedBy) {
  const active = await prisma.codeSiteAssumptionLease.findMany({
    where: { projectId, status: 'active' },
  });
  const invalidated = [];
  for (const assumption of active) {
    const dependsOn = asArray(parseJson(assumption.dependsOnJson, []));
    const usedBy = asArray(parseJson(assumption.usedByJson, []));
    const matches = [...dependsOn, ...usedBy].some((item) => {
      const candidate = typeof item === 'string' ? item : item?.path || item?.ref || '';
      return candidate === path || candidate.includes(path) || path.includes(candidate);
    });
    if (!matches) continue;
    const updated = await prisma.codeSiteAssumptionLease.update({
      where: { id: assumption.id },
      data: {
        status: 'invalidated',
        invalidatedBy,
        invalidatedAt: new Date(),
      },
    });
    invalidated.push(assumptionProjection(updated));
    await recordEvent(projectId, {
      eventType: 'assumption_invalidated',
      displayCallsign: assumption.displayCallsign,
      details: {
        assumptionId: assumption.id,
        assumptionKey: assumption.assumptionKey,
        invalidatedBy,
        path,
      },
    });
  }
  return invalidated;
}

export async function recordAssumption(workspaceSlug, transactionId, body = {}) {
  const transaction = await requireTransaction(workspaceSlug, transactionId);
  const key = String(body.assumptionKey || body.assumption_id || body.key || '').trim();
  if (!key) throw badRequest('assumption_key_required');
  const assumption = await prisma.codeSiteAssumptionLease.create({
    data: {
      projectId: transaction.projectId,
      ownerSessionId: transaction.agentSessionId,
      displayCallsign: transaction.mutationLease.displayCallsign,
      assumptionKey: key,
      dependsOnJson: stringifyJson(body.dependsOn || body.depends_on || []),
      usedByJson: stringifyJson(body.usedBy || body.used_by || []),
      status: 'active',
    },
  });
  const refs = appendUnique(parseJson(transaction.assumptionRefsJson, []), assumption.id);
  await prisma.codeSiteMutationTransaction.update({
    where: { id: transaction.id },
    data: { assumptionRefsJson: stringifyJson(refs) },
  });
  await recordEvent(transaction.projectId, {
    mutationLeaseId: transaction.mutationLeaseId,
    eventType: 'assumption_recorded',
    displayCallsign: transaction.mutationLease.displayCallsign,
    actorType: 'transaction',
    actorId: transaction.id,
    details: { transactionId: transaction.id, assumptionId: assumption.id, assumptionKey: key },
  });
  return assumptionProjection(assumption);
}

export async function validateTransaction(workspaceSlug, transactionId) {
  const transaction = await requireTransaction(workspaceSlug, transactionId);
  const project = await prisma.codeSiteProject.findUnique({ where: { id: transaction.projectId } });
  const zonePolicy = parseJson(project.zonePolicyJson, compileZonePolicy());
  const writeSet = parseJson(transaction.writeSetJson, []);
  const observedWriteSet = parseJson(transaction.observedWriteSetJson, []);
  const readSet = parseJson(transaction.readSetJson, []);
  const lease = transaction.mutationLease;
  const blockedWrites = [...new Set([...writeSet, ...observedWriteSet])]
    .map((path) => ({ path, evaluation: evaluatePathMutation({ lease, path, zonePolicy }) }))
    .filter((entry) => !entry.evaluation.ok);
  const invalidAssumptions = await prisma.codeSiteAssumptionLease.findMany({
    where: {
      id: { in: parseJson(transaction.assumptionRefsJson, []) },
      status: 'invalidated',
    },
  });
  const staleReads = await findStaleReadEvents(transaction, readSet);
  const ok = blockedWrites.length === 0 && invalidAssumptions.length === 0 && staleReads.length === 0;
  const decision = {
    ok,
    isolation: transaction.isolation,
    reasonCodes: [
      ...(blockedWrites.length ? ['write_outside_clearance'] : []),
      ...(invalidAssumptions.length ? ['assumption_invalidated'] : []),
      ...(staleReads.length ? ['stale_read_detected'] : []),
      ...(ok ? ['serializable_validation_passed'] : []),
    ],
    blockedWrites,
    invalidAssumptions: invalidAssumptions.map(assumptionProjection),
    staleReads,
    validatedAt: new Date().toISOString(),
  };
  const updated = await prisma.codeSiteMutationTransaction.update({
    where: { id: transaction.id },
    data: {
      status: ok ? 'validated' : 'blocked',
      commitDecisionJson: stringifyJson(decision),
    },
  });
  await recordEvent(transaction.projectId, {
    mutationLeaseId: transaction.mutationLeaseId,
    eventType: 'transaction_validated',
    displayCallsign: lease.displayCallsign,
    actorType: 'transaction',
    actorId: transaction.id,
    details: { transactionId: transaction.id, decision },
  });
  return { decision, transaction: transactionProjection(updated) };
}

async function findStaleReadEvents(transaction, readSet) {
  if (!readSet.length) return [];
  const events = await prisma.codeSiteEvent.findMany({
    where: {
      projectId: transaction.projectId,
      createdAt: { gt: transaction.openedAt },
      eventType: { in: ['write_allowed', 'transaction_committed'] },
    },
    orderBy: { createdAt: 'asc' },
  });
  return events
    .map((event) => ({ event, details: parseJson(event.detailsJson, {}) }))
    .filter(({ event, details }) => !eventBelongsToTransaction(event, details, transaction))
    .filter(({ details }) => {
      const paths = normalizePathList([details.path, ...asArray(details.writeSet || details.changedPaths || [])]);
      return readSet.some((readPath) => paths.includes(readPath));
    })
    .map(({ event, details }) => ({
      eventId: event.id,
      eventType: event.eventType,
      path: details.path || null,
      displayCallsign: event.displayCallsign,
      createdAt: event.createdAt,
    }));
}

function eventBelongsToTransaction(event, details, transaction) {
  return details.transactionId === transaction.id || event.actorId === transaction.id;
}

export async function commitTransaction(workspaceSlug, transactionId, body = {}) {
  const validation = await validateTransaction(workspaceSlug, transactionId);
  if (!validation.decision.ok) return validation;
  const transaction = await requireTransaction(workspaceSlug, transactionId);
  const bundle = await createProofBundleForTransaction(transaction, body);
  const updated = await prisma.codeSiteMutationTransaction.update({
    where: { id: transaction.id },
    data: {
      status: 'committed',
      proofBundleDigest: bundle.bundleDigest,
      closedAt: new Date(),
    },
  });
  await seedLineProvenance(transaction, bundle);
  await recordEvent(transaction.projectId, {
    mutationLeaseId: transaction.mutationLeaseId,
    eventType: 'transaction_committed',
    displayCallsign: transaction.mutationLease.displayCallsign,
    actorType: 'transaction',
    actorId: transaction.id,
    details: {
      transactionId: transaction.id,
      proofBundleId: bundle.id,
      proofBundleDigest: bundle.bundleDigest,
      writeSet: parseJson(transaction.writeSetJson, []),
    },
  });
  return { transaction: transactionProjection(updated), proofBundle: proofBundleProjection(bundle) };
}

export async function abortTransaction(workspaceSlug, transactionId, body = {}) {
  const transaction = await requireTransaction(workspaceSlug, transactionId);
  const updated = await prisma.codeSiteMutationTransaction.update({
    where: { id: transaction.id },
    data: {
      status: 'aborted',
      commitDecisionJson: stringifyJson({ reason: body.reason || 'aborted_by_tower', abortedAt: new Date().toISOString() }),
      closedAt: new Date(),
    },
  });
  await recordEvent(transaction.projectId, {
    mutationLeaseId: transaction.mutationLeaseId,
    eventType: 'transaction_aborted',
    displayCallsign: transaction.mutationLease.displayCallsign,
    actorType: 'transaction',
    actorId: transaction.id,
    details: { transactionId: transaction.id, reason: body.reason || 'aborted_by_tower' },
  });
  return transactionProjection(updated);
}

async function createProofBundleForTransaction(transaction, body = {}) {
  const readSet = parseJson(transaction.readSetJson, []);
  const writeSet = parseJson(transaction.writeSetJson, []);
  const invariants = parseJson(transaction.invariantsJson, []);
  const evidenceRefs = asArray(body.evidenceRefs || body.evidence_refs || []).concat([
    `codesite:transaction:${transaction.id}`,
    `codesite:lease:${transaction.mutationLeaseId}`,
  ]);
  const bundleDigest = digest({
    transactionId: transaction.id,
    leaseId: transaction.mutationLeaseId,
    readSet,
    writeSet,
    invariants,
    evidenceRefs,
  });
  return prisma.codeSiteProofBundle.create({
    data: {
      projectId: transaction.projectId,
      transactionId: transaction.id,
      commitSha: body.commitSha || body.commit_sha || null,
      readSetDigest: digest(readSet),
      writeSetDigest: digest(writeSet),
      invariantsJson: stringifyJson(invariants),
      evidenceRefsJson: stringifyJson(evidenceRefs),
      dojoEvidenceRefsJson: stringifyJson(body.dojoEvidenceRefs || body.dojo_evidence_refs || []),
      incidentReplayDigest: body.incidentReplayDigest || body.incident_replay_digest || null,
      bundleDigest,
    },
  });
}

async function seedLineProvenance(transaction, bundle) {
  const paths = parseJson(transaction.writeSetJson, []);
  for (const filePath of paths) {
    await prisma.codeSiteLineProvenance.create({
      data: {
        projectId: transaction.projectId,
        transactionId: transaction.id,
        filePath,
        lineAnchor: `${filePath}#codesite:${transaction.id}`,
        displayCallsign: transaction.mutationLease.displayCallsign,
        reasonRef: `transaction:${transaction.id}`,
        evidenceRefsJson: stringifyJson([`proof:${bundle.id}`, `transaction:${transaction.id}`]),
        dojoSourceRefsJson: stringifyJson([]),
        proofBundleId: bundle.id,
        processAncestryJson: stringifyJson([]),
        promptSummary: 'CodeSite transaction commit',
      },
    });
  }
}

export async function createDocument(workspaceSlug, projectId, body = {}) {
  const project = await requireProject(workspaceSlug, projectId);
  const kind = String(body.kind || body.type || 'rfi');
  const document = await prisma.codeSiteDocument.create({
    data: {
      projectId: project.id,
      kind,
      status: body.status || 'open',
      title: String(body.title || defaultDocumentTitle(kind)),
      bodyJson: stringifyJson(redactDocumentBody(body.body || body)),
      blocking: Boolean(body.blocking),
    },
  });
  const event = await recordEvent(project.id, {
    eventType: eventTypeForDocument(kind),
    displayCallsign: body.fromCallsign || body.from_session || null,
    actorType: 'document',
    actorId: document.id,
    details: {
      documentId: document.id,
      kind,
      title: document.title,
      blocking: document.blocking,
      fromSession: body.fromSessionId || body.from_session || null,
      toSession: body.toSessionId || body.to_session || null,
    },
  });
  const inboxItems = await routeDocumentToInbox(project.id, document, event, body);
  return { document: documentProjection(document), inboxItems: inboxItems.map(inboxProjection) };
}

function defaultDocumentTitle(kind) {
  return {
    rfi: 'Request for information',
    change_order: 'Change order',
    mayday: 'Mayday',
    stop_work: 'Stop-work order',
    punch: 'Punch item',
  }[kind] || 'CodeSite document';
}

function eventTypeForDocument(kind) {
  return {
    rfi: 'rfi',
    change_order: 'change_order',
    mayday: 'mayday',
    stop_work: 'ground_stop',
    inspection_request: 'landing_requested',
    inspection_result: 'inspection_result',
  }[kind] || 'tower_instruction';
}

function redactDocumentBody(body) {
  const redacted = { ...body };
  for (const key of Object.keys(redacted)) {
    if (/secret|token|password|api[_-]?key|privatePrompt/i.test(key)) {
      redacted[key] = '[redacted]';
    }
  }
  return redacted;
}

async function routeDocumentToInbox(projectId, document, event, body) {
  const targetSessionIds = asArray(body.toSessionId || body.to_session || body.recipients || []);
  if (targetSessionIds.length === 0) return [];
  const sessions = await prisma.codeSiteAgentSession.findMany({
    where: { projectId, id: { in: targetSessionIds } },
  });
  const created = [];
  for (const session of sessions) {
    created.push(await prisma.codeSiteAgentInboxItem.create({
      data: {
        projectId,
        agentSessionId: session.id,
        recipientUserId: session.ownerUserId,
        eventId: event.id,
        documentId: document.id,
        kind: document.kind,
        requiresResponse: Boolean(body.requiresResponse || body.requires_response || document.blocking),
        redactedPayloadJson: stringifyJson({
          documentId: document.id,
          eventId: event.id,
          kind: document.kind,
          title: document.title,
          body: parseJson(document.bodyJson, {}),
        }),
      },
    }));
  }
  return created;
}

export async function getAgentInbox(workspaceSlug, agentSessionId) {
  const session = await prisma.codeSiteAgentSession.findFirst({
    where: { id: agentSessionId, project: { workspaceSlug } },
  });
  if (!session) throw notFound('agent_session_not_found');
  const items = await prisma.codeSiteAgentInboxItem.findMany({
    where: { agentSessionId },
    orderBy: { createdAt: 'asc' },
  });
  return items.map(inboxProjection);
}

export async function acknowledgeInboxItem(workspaceSlug, agentSessionId, eventId) {
  const item = await prisma.codeSiteAgentInboxItem.findFirst({
    where: { agentSessionId, eventId, project: { workspaceSlug } },
  });
  if (!item) throw notFound('inbox_item_not_found');
  const updated = await prisma.codeSiteAgentInboxItem.update({
    where: { id: item.id },
    data: { status: 'acknowledged', acknowledgedAt: new Date() },
  });
  return inboxProjection(updated);
}

export async function createIncident(workspaceSlug, projectId, body = {}) {
  const project = await requireProject(workspaceSlug, projectId);
  const replay = body.incidentReplay || body.incident_replay || {
    eventRefs: asArray(body.timelineEventRefs || body.timeline_event_refs || []),
    summary: body.summary || body.reason || 'CodeSite incident',
  };
  const incident = await prisma.codeSiteIncident.create({
    data: {
      projectId: project.id,
      severity: body.severity || 'medium',
      category: body.category || body.kind || 'near_miss',
      participantsJson: stringifyJson(body.participants || []),
      affectedZonesJson: stringifyJson(body.affectedZones || body.affected_zones || []),
      incidentReplayJson: stringifyJson(replay),
      replayDigest: digest(replay),
      timelineEventRefsJson: stringifyJson(body.timelineEventRefs || body.timeline_event_refs || []),
      policyDeltaJson: stringifyJson(body.policyDelta || body.policy_delta || null),
      evidenceRefsJson: stringifyJson(body.evidenceRefs || body.evidence_refs || []),
    },
  });
  await recordEvent(project.id, {
    eventType: incident.category === 'near_miss' ? 'near_miss' : 'mayday',
    displayCallsign: body.displayCallsign || body.callsign || null,
    actorType: 'incident',
    actorId: incident.id,
    details: {
      incidentId: incident.id,
      severity: incident.severity,
      category: incident.category,
      replayDigest: incident.replayDigest,
    },
  });
  return incidentProjection(incident);
}

export async function createInspectionRun(workspaceSlug, projectId, body = {}) {
  const project = await requireProject(workspaceSlug, projectId);
  const run = await prisma.codeSiteInspectionRun.create({
    data: {
      projectId: project.id,
      executionPlanId: body.executionPlanId || body.execution_plan_id || null,
      displayCallsign: body.displayCallsign || body.callsign || 'INSPECT-01',
      status: body.status || 'requested',
      changedPathsJson: stringifyJson(normalizePathList(body.changedPaths || body.changed_paths || [])),
      inspectionSignalsJson: stringifyJson(body.inspectionSignals || body.inspection_signals || []),
      evidenceRefsJson: stringifyJson(body.evidenceRefs || body.evidence_refs || []),
    },
  });
  await recordEvent(project.id, {
    eventType: 'landing_requested',
    displayCallsign: run.displayCallsign,
    actorType: 'inspection',
    actorId: run.id,
    details: { inspectionRunId: run.id, status: run.status, changedPaths: parseJson(run.changedPathsJson, []) },
  });
  return inspectionProjection(run);
}

export async function completeInspectionRun(workspaceSlug, inspectionRunId, body = {}) {
  const run = await prisma.codeSiteInspectionRun.findFirst({
    where: { id: inspectionRunId, project: { workspaceSlug } },
  });
  if (!run) throw notFound('inspection_run_not_found');
  const updated = await prisma.codeSiteInspectionRun.update({
    where: { id: run.id },
    data: {
      status: body.status || 'completed',
      inspectionSignalsJson: stringifyJson(body.inspectionSignals || body.inspection_signals || parseJson(run.inspectionSignalsJson, [])),
      evidenceRefsJson: stringifyJson(body.evidenceRefs || body.evidence_refs || parseJson(run.evidenceRefsJson, [])),
      completedAt: new Date(),
    },
  });
  await recordEvent(run.projectId, {
    eventType: 'inspection_result',
    displayCallsign: run.displayCallsign,
    actorType: 'inspection',
    actorId: run.id,
    details: {
      inspectionRunId: run.id,
      status: updated.status,
      signals: parseJson(updated.inspectionSignalsJson, []),
    },
  });
  return inspectionProjection(updated);
}

export async function createCounterfactualRun(workspaceSlug, projectId, body = {}) {
  const project = await requireProject(workspaceSlug, projectId);
  const run = await prisma.codeSiteCounterfactualRun.create({
    data: {
      projectId: project.id,
      shadowJobRef: body.shadowJobRef || body.shadow_job_ref || null,
      baseSnapshot: body.baseSnapshot || body.base_snapshot || digest({ projectId, at: Date.now() }),
      universesJson: stringifyJson(body.universes || []),
      arbiterVerdictJson: stringifyJson(body.arbiterVerdict || body.arbiter_verdict || null),
      userChoiceJson: stringifyJson(body.userChoice || body.user_choice || null),
      laterManualEditsJson: stringifyJson(body.laterManualEdits || body.later_manual_edits || []),
      validityStrength: body.validityStrength || body.validity_strength || 'weak',
      evidenceRefsJson: stringifyJson(body.evidenceRefs || body.evidence_refs || []),
    },
  });
  await recordEvent(project.id, {
    eventType: 'shadow_run',
    actorType: 'counterfactual',
    actorId: run.id,
    details: { counterfactualRunId: run.id, shadowJobRef: run.shadowJobRef, validityStrength: run.validityStrength },
  });
  return counterfactualProjection(run);
}

export async function createPolicyDelta(workspaceSlug, projectId, body = {}) {
  const project = await requireProject(workspaceSlug, projectId);
  const delta = await prisma.codeSitePolicyDelta.create({
    data: {
      projectId: project.id,
      learnedFromIncidentsJson: stringifyJson(body.learnedFromIncidents || body.learned_from_incidents || []),
      affectedZoneKey: body.affectedZoneKey || body.affected_zone_key || null,
      ruleCandidateJson: stringifyJson(body.ruleCandidate || body.rule_candidate || {}),
      triggerConditionsJson: stringifyJson(body.triggerConditions || body.trigger_conditions || []),
      expectedRiskReduction: typeof body.expectedRiskReduction === 'number' ? body.expectedRiskReduction : body.expected_risk_reduction,
      confidence: typeof body.confidence === 'number' ? body.confidence : 0.5,
      promotionState: body.promotionState || body.promotion_state || 'proposed',
      replayRefsJson: stringifyJson(body.replayRefs || body.replay_refs || []),
    },
  });
  await recordEvent(project.id, {
    eventType: 'policy_delta_proposed',
    actorType: 'policy_delta',
    actorId: delta.id,
    details: { policyDeltaId: delta.id, affectedZoneKey: delta.affectedZoneKey, confidence: delta.confidence },
  });
  return policyDeltaProjection(delta);
}

export async function getControlState(workspaceSlug, projectId) {
  const project = await prisma.codeSiteProject.findFirst({
    where: { id: projectId, workspaceSlug },
    include: PROJECT_INCLUDE,
  });
  if (!project) throw notFound('project_not_found');
  const projection = projectProjection(project);
  const activeLeases = projection.mutationLeases.filter((lease) => lease.status === 'active');
  const requiredActions = [
    ...projection.assumptions
      .filter((assumption) => assumption.status === 'invalidated')
      .map((assumption) => `rebase_assumption:${assumption.id}`),
    ...projection.inboxItems
      .filter((item) => item.status === 'pending' && item.requiresResponse)
      .map((item) => `ack_event:${item.eventId || item.id}`),
  ];
  return {
    projectId: project.id,
    workspaceSlug,
    towerState: requiredActions.length ? 'holding' : 'active',
    status: project.status,
    activeFlights: projection.executionPlans.filter((plan) => ['filed', 'preflight', 'cleared', 'taxiing', 'airborne', 'holding'].includes(plan.status)),
    activeMutationLeases: activeLeases,
    activeTransactions: projection.mutationTxns.filter((txn) => ['open', 'validated', 'blocked'].includes(txn.status)),
    allowedPaths: unique(activeLeases.flatMap((lease) => pathsForRoute(lease.lease.allowedPaths || []))),
    blockedPaths: unique(activeLeases.flatMap((lease) => pathsForRoute(lease.lease.blockedPaths || []))),
    requiredActions,
    eventsSince: projection.events.at(-1)?.id || null,
    inboxUrl: `/api/workspace/${encodeURIComponent(workspaceSlug)}/codesite/agent-sessions/:agentSessionId/inbox`,
    collisionForecast: predictCollisions({
      executionPlans: projection.executionPlans,
      leases: projection.mutationLeases,
      zonePolicy: projection.zonePolicy,
    }),
    updatedAt: new Date().toISOString(),
  };
}

export async function getEvents(workspaceSlug, projectId, since) {
  const project = await requireProject(workspaceSlug, projectId);
  const events = await prisma.codeSiteEvent.findMany({
    where: {
      projectId: project.id,
      ...(since ? { id: { gt: since } } : {}),
    },
    orderBy: { createdAt: 'asc' },
  });
  return events.map(eventProjection);
}

export async function getAgentManifest(workspaceSlug, projectId) {
  await requireProject(workspaceSlug, projectId);
  return {
    version: 1,
    projectId,
    controlState: `projects/${projectId}/control-state.json`,
    events: `projects/${projectId}/events.jsonl`,
    schemas: 'schemas/',
    inboxRoot: `projects/${projectId}/inbox/`,
    proofBundleRoot: `projects/${projectId}/proof-bundles/`,
    mcpTools: [
      'synthi_codesite_next_event',
      'synthi_codesite_ack_event',
      'synthi_codesite_open_transaction',
      'synthi_codesite_validate_transaction',
      'synthi_codesite_predict_collision',
    ],
  };
}

export async function getSchemas() {
  return codesiteSchemas();
}

export async function previewArtifacts(workspaceSlug, projectId) {
  const project = await getProject(workspaceSlug, projectId);
  if (!project) throw notFound('project_not_found');
  const controlState = await getControlState(workspaceSlug, projectId);
  const files = buildArtifactProjection(project, controlState);
  return {
    projectId,
    files: files.map((file) => ({
      path: file.relativePath,
      bytes: Buffer.byteLength(file.content, 'utf8'),
    })),
  };
}

export async function exportArtifacts(workspaceSlug, projectId) {
  const project = await getProject(workspaceSlug, projectId);
  if (!project) throw notFound('project_not_found');
  const controlState = await getControlState(workspaceSlug, projectId);
  const result = await writeArtifactProjection(project, controlState);
  await recordEvent(projectId, {
    eventType: 'black_box_closed',
    actorType: 'artifact_projection',
    actorId: projectId,
    details: {
      written: result.written,
      root: result.root || null,
      reason: result.reason || null,
      files: result.files,
    },
  });
  return result;
}

export async function collisionPredict(workspaceSlug, projectId) {
  const project = await prisma.codeSiteProject.findFirst({
    where: { id: projectId, workspaceSlug },
    include: { executionPlans: true, mutationLeases: true },
  });
  if (!project) throw notFound('project_not_found');
  return predictCollisions({
    executionPlans: project.executionPlans.map(executionPlanProjection),
    leases: project.mutationLeases.map(mutationLeaseProjection),
    zonePolicy: parseJson(project.zonePolicyJson, compileZonePolicy()),
  });
}

export async function shadowMergeSimulate(workspaceSlug, projectId, body = {}) {
  const forecast = await collisionPredict(workspaceSlug, projectId);
  const strategies = asArray(body.strategies || [
    'schema-first',
    'frontend-backend-parallel',
    'single-fullstack-agent',
    'test-first',
  ]);
  const universes = strategies.map((strategy) => {
    const schemaFirst = strategy === 'schema-first';
    const riskPenalty = forecast.risks.length * (schemaFirst ? 1 : 3);
    const staleAssumptions = schemaFirst ? 0 : forecast.risks.filter((risk) => risk.risk === 'contract_collision').length;
    return {
      strategy,
      result: riskPenalty <= 2 ? 'passed' : 'risk',
      predictedCollisionRisk: Math.min(1, riskPenalty / 10),
      staleAssumptions,
      inspectionCost: 2 + riskPenalty,
    };
  });
  const selected = universes.slice().sort((a, b) => {
    if (a.staleAssumptions !== b.staleAssumptions) return a.staleAssumptions - b.staleAssumptions;
    return a.inspectionCost - b.inspectionCost;
  })[0];
  const result = {
    selected: selected.strategy,
    reason: {
      staleAssumptions: selected.staleAssumptions,
      inspectionCost: selected.inspectionCost,
      riskLevel: forecast.riskLevel,
    },
    universes,
  };
  await createCounterfactualRun(workspaceSlug, projectId, {
    universes,
    arbiterVerdict: result,
    validityStrength: 'simulated',
    evidenceRefs: ['codesite:shadow_merge_simulator'],
  });
  return result;
}

export async function getLineProvenance(workspaceSlug, { filePath, lineAnchor } = {}) {
  const where = {
    project: { workspaceSlug },
    ...(filePath ? { filePath: normalizePath(filePath) || filePath } : {}),
    ...(lineAnchor ? { lineAnchor } : {}),
  };
  const rows = await prisma.codeSiteLineProvenance.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return rows.map(lineProvenanceProjection);
}

export async function getProofBundle(workspaceSlug, bundleId) {
  const bundle = await prisma.codeSiteProofBundle.findFirst({
    where: { id: bundleId, project: { workspaceSlug } },
  });
  if (!bundle) throw notFound('proof_bundle_not_found');
  return proofBundleProjection(bundle);
}

export async function getIncidentReplay(workspaceSlug, incidentId) {
  const incident = await prisma.codeSiteIncident.findFirst({
    where: { id: incidentId, project: { workspaceSlug } },
  });
  if (!incident) throw notFound('incident_not_found');
  return {
    incident: incidentProjection(incident),
    replay: parseJson(incident.incidentReplayJson, {}),
  };
}

async function recordEvent(projectId, input) {
  const logicalTime = await prisma.codeSiteEvent.count({ where: { projectId } });
  return prisma.codeSiteEvent.create({
    data: {
      projectId,
      mutationLeaseId: input.mutationLeaseId || null,
      eventType: input.eventType,
      displayCallsign: input.displayCallsign || null,
      actorType: input.actorType || null,
      actorId: input.actorId || null,
      detailsJson: stringifyJson(input.details || {}),
      evidenceRefsJson: stringifyJson(input.evidenceRefs || []),
      logicalTime: logicalTime + 1,
    },
  });
}

async function createPolicyDecision(projectId, input) {
  return prisma.codeSitePolicyDecision.create({
    data: {
      projectId,
      mutationLeaseId: input.mutationLeaseId || null,
      displayCallsign: input.displayCallsign || null,
      decision: input.decision,
      reasonCodesJson: stringifyJson(input.reasonCodes || []),
      inputDigest: digest(input.input || {}),
      decisionJson: stringifyJson(input.decisionJson || {}),
    },
  });
}

async function requireProject(workspaceSlug, projectId) {
  const project = await prisma.codeSiteProject.findFirst({ where: { id: projectId, workspaceSlug } });
  if (!project) throw notFound('project_not_found');
  return project;
}

async function requireAgentSession(projectId, agentSessionId) {
  if (!agentSessionId) throw badRequest('agent_session_required');
  const session = await prisma.codeSiteAgentSession.findFirst({ where: { id: agentSessionId, projectId } });
  if (!session) throw notFound('agent_session_not_found');
  return session;
}

async function requireLease(workspaceSlug, mutationLeaseId) {
  const lease = await prisma.codeSiteMutationLease.findFirst({
    where: { id: mutationLeaseId, project: { workspaceSlug } },
  });
  if (!lease) throw notFound('mutation_lease_not_found');
  return lease;
}

async function requireTransaction(workspaceSlug, transactionId) {
  const transaction = await prisma.codeSiteMutationTransaction.findFirst({
    where: { id: transactionId, project: { workspaceSlug } },
    include: { mutationLease: true, agentSession: true },
  });
  if (!transaction) throw notFound('transaction_not_found');
  return transaction;
}

function notFound(code) {
  const error = new Error(code);
  error.status = 404;
  error.code = code;
  return error;
}

function badRequest(code, detail) {
  const error = new Error(code);
  error.status = 400;
  error.code = code;
  error.detail = detail;
  return error;
}

function appendUnique(values, value) {
  return unique([...asArray(values), value].filter(Boolean));
}

function unique(values) {
  return [...new Set(values)];
}

function projectSummary(project) {
  return {
    id: project.id,
    workspaceSlug: project.workspaceSlug,
    title: project.title,
    request: project.request,
    status: project.status,
    createdByUserId: project.createdByUserId,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    counts: {
      agentSessions: project.agentSessions?.length || 0,
      executionPlans: project.executionPlans?.length || 0,
      mutationLeases: project.mutationLeases?.length || 0,
      incidents: project.incidents?.length || 0,
      inspectionRuns: project.inspectionRuns?.length || 0,
    },
  };
}

function projectProjection(project) {
  return {
    ...projectSummary(project),
    zonePolicy: parseJson(project.zonePolicyJson, {}),
    controlPlan: parseJson(project.controlPlanJson, {}),
    agentSessions: asArray(project.agentSessions).map(sessionProjection),
    executionPlans: asArray(project.executionPlans).map(executionPlanProjection),
    mutationLeases: asArray(project.mutationLeases).map(mutationLeaseProjection),
    mutationTxns: asArray(project.mutationTxns).map(transactionProjection),
    assumptions: asArray(project.assumptions).map(assumptionProjection),
    policyDecisions: asArray(project.policyDecisions).map(policyDecisionProjection),
    events: asArray(project.events).map(eventProjection),
    incidents: asArray(project.incidents).map(incidentProjection),
    inspectionRuns: asArray(project.inspectionRuns).map(inspectionProjection),
    proofBundles: asArray(project.proofBundles).map(proofBundleProjection),
    lineProvenance: asArray(project.lineProvenance).map(lineProvenanceProjection),
    documents: asArray(project.documents).map(documentProjection),
    counterfactualRuns: asArray(project.counterfactualRuns).map(counterfactualProjection),
    policyDeltas: asArray(project.policyDeltas).map(policyDeltaProjection),
    inboxItems: asArray(project.inboxItems).map(inboxProjection),
  };
}

function sessionProjection(session) {
  return {
    id: session.id,
    projectId: session.projectId,
    ownerUserId: session.ownerUserId,
    agentProvider: session.agentProvider,
    agentRuntime: session.agentRuntime,
    providerSessionRef: session.providerSessionRef,
    displayCallsign: session.displayCallsign,
    status: session.status,
    permissions: parseJson(session.permissionsJson, []),
    redactionPolicy: parseJson(session.redactionPolicyJson, {}),
    createdAt: session.createdAt,
    endedAt: session.endedAt,
  };
}

function executionPlanProjection(plan) {
  return {
    id: plan.id,
    projectId: plan.projectId,
    agentSessionId: plan.agentSessionId,
    displayCallsign: plan.displayCallsign,
    mission: plan.mission,
    domain: plan.domain,
    status: plan.status,
    route: parseJson(plan.routeJson, []),
    blockedZones: parseJson(plan.blockedZonesJson, []),
    abortConditions: parseJson(plan.abortJson, []),
    requestedTools: parseJson(plan.requestedToolsJson, []),
    estimatedDurationMs: plan.estimatedDurationMs,
    filedAt: plan.filedAt,
    closedAt: plan.closedAt,
  };
}

function mutationLeaseProjection(lease, extra = {}) {
  return {
    id: lease.id,
    projectId: lease.projectId,
    executionPlanId: lease.executionPlanId,
    agentSessionId: lease.agentSessionId,
    displayCallsign: lease.displayCallsign,
    status: lease.status,
    lease: parseJson(lease.leaseJson, {}),
    dojoProofRef: lease.dojoProofRef,
    dojoLicenseRef: lease.dojoLicenseRef,
    dojoEvidenceRefs: parseJson(lease.dojoEvidenceRefsJson, []),
    dojoLedgerCheckpointHash: lease.dojoLedgerCheckpointHash,
    dojoDecisionDigest: lease.dojoDecisionDigest,
    implementationStatus: parseJson(lease.implementationStatusJson, {}),
    issuedAt: lease.issuedAt,
    expiresAt: lease.expiresAt,
    revokedAt: lease.revokedAt,
    ...extra,
  };
}

function transactionProjection(transaction) {
  return {
    id: transaction.id,
    projectId: transaction.projectId,
    mutationLeaseId: transaction.mutationLeaseId,
    agentSessionId: transaction.agentSessionId,
    baseSnapshot: transaction.baseSnapshot,
    isolation: transaction.isolation,
    status: transaction.status,
    readSet: parseJson(transaction.readSetJson, []),
    observedReadSet: parseJson(transaction.observedReadSetJson, []),
    writeSet: parseJson(transaction.writeSetJson, []),
    observedWriteSet: parseJson(transaction.observedWriteSetJson, []),
    semanticDependencyRefs: parseJson(transaction.semanticDependencyRefsJson, []),
    invariants: parseJson(transaction.invariantsJson, []),
    assumptionRefs: parseJson(transaction.assumptionRefsJson, []),
    commitDecision: parseJson(transaction.commitDecisionJson, null),
    proofBundleDigest: transaction.proofBundleDigest,
    openedAt: transaction.openedAt,
    closedAt: transaction.closedAt,
  };
}

function assumptionProjection(assumption) {
  return {
    id: assumption.id,
    projectId: assumption.projectId,
    ownerSessionId: assumption.ownerSessionId,
    displayCallsign: assumption.displayCallsign,
    assumptionKey: assumption.assumptionKey,
    dependsOn: parseJson(assumption.dependsOnJson, []),
    usedBy: parseJson(assumption.usedByJson, []),
    status: assumption.status,
    invalidatedBy: assumption.invalidatedBy,
    invalidatedAt: assumption.invalidatedAt,
    createdAt: assumption.createdAt,
  };
}

function policyDecisionProjection(decision) {
  return {
    id: decision.id,
    projectId: decision.projectId,
    mutationLeaseId: decision.mutationLeaseId,
    displayCallsign: decision.displayCallsign,
    decision: decision.decision,
    reasonCodes: parseJson(decision.reasonCodesJson, []),
    inputDigest: decision.inputDigest,
    decisionBody: parseJson(decision.decisionJson, {}),
    createdAt: decision.createdAt,
  };
}

function eventProjection(event) {
  return {
    id: event.id,
    projectId: event.projectId,
    mutationLeaseId: event.mutationLeaseId,
    eventType: event.eventType,
    displayCallsign: event.displayCallsign,
    actorType: event.actorType,
    actorId: event.actorId,
    details: parseJson(event.detailsJson, {}),
    evidenceRefs: parseJson(event.evidenceRefsJson, []),
    logicalTime: event.logicalTime,
    createdAt: event.createdAt,
  };
}

function proofBundleProjection(bundle) {
  return {
    id: bundle.id,
    projectId: bundle.projectId,
    transactionId: bundle.transactionId,
    commitSha: bundle.commitSha,
    readSetDigest: bundle.readSetDigest,
    writeSetDigest: bundle.writeSetDigest,
    invariants: parseJson(bundle.invariantsJson, []),
    evidenceRefs: parseJson(bundle.evidenceRefsJson, []),
    dojoEvidenceRefs: parseJson(bundle.dojoEvidenceRefsJson, []),
    incidentReplayDigest: bundle.incidentReplayDigest,
    bundleDigest: bundle.bundleDigest,
    createdAt: bundle.createdAt,
    trailers: {
      'CodeSite-Transaction': bundle.transactionId,
      'CodeSite-Read-Set': bundle.readSetDigest,
      'CodeSite-Write-Set': bundle.writeSetDigest,
      'CodeSite-Black-Box': bundle.incidentReplayDigest || bundle.bundleDigest,
    },
  };
}

function lineProvenanceProjection(row) {
  return {
    id: row.id,
    projectId: row.projectId,
    transactionId: row.transactionId,
    filePath: row.filePath,
    lineAnchor: row.lineAnchor,
    displayCallsign: row.displayCallsign,
    reasonRef: row.reasonRef,
    evidenceRefs: parseJson(row.evidenceRefsJson, []),
    dojoSourceRefs: parseJson(row.dojoSourceRefsJson, []),
    proofBundleId: row.proofBundleId,
    processAncestry: parseJson(row.processAncestryJson, []),
    promptSummary: row.promptSummary,
    createdAt: row.createdAt,
  };
}

function inspectionProjection(run) {
  return {
    id: run.id,
    projectId: run.projectId,
    executionPlanId: run.executionPlanId,
    displayCallsign: run.displayCallsign,
    status: run.status,
    changedPaths: parseJson(run.changedPathsJson, []),
    inspectionSignals: parseJson(run.inspectionSignalsJson, []),
    evidenceRefs: parseJson(run.evidenceRefsJson, []),
    requestedAt: run.requestedAt,
    completedAt: run.completedAt,
  };
}

function incidentProjection(incident) {
  return {
    id: incident.id,
    projectId: incident.projectId,
    severity: incident.severity,
    category: incident.category,
    participants: parseJson(incident.participantsJson, []),
    affectedZones: parseJson(incident.affectedZonesJson, []),
    incidentReplay: parseJson(incident.incidentReplayJson, {}),
    replayDigest: incident.replayDigest,
    timelineEventRefs: parseJson(incident.timelineEventRefsJson, []),
    policyDelta: parseJson(incident.policyDeltaJson, null),
    evidenceRefs: parseJson(incident.evidenceRefsJson, []),
    createdAt: incident.createdAt,
  };
}

function documentProjection(document) {
  return {
    id: document.id,
    projectId: document.projectId,
    kind: document.kind,
    status: document.status,
    title: document.title,
    body: parseJson(document.bodyJson, {}),
    blocking: document.blocking,
    createdAt: document.createdAt,
    resolvedAt: document.resolvedAt,
  };
}

function inboxProjection(item) {
  return {
    id: item.id,
    projectId: item.projectId,
    agentSessionId: item.agentSessionId,
    recipientUserId: item.recipientUserId,
    eventId: item.eventId,
    documentId: item.documentId,
    kind: item.kind,
    requiresResponse: item.requiresResponse,
    status: item.status,
    redactedPayload: parseJson(item.redactedPayloadJson, {}),
    createdAt: item.createdAt,
    acknowledgedAt: item.acknowledgedAt,
  };
}

function counterfactualProjection(run) {
  return {
    id: run.id,
    projectId: run.projectId,
    shadowJobRef: run.shadowJobRef,
    baseSnapshot: run.baseSnapshot,
    universes: parseJson(run.universesJson, []),
    arbiterVerdict: parseJson(run.arbiterVerdictJson, null),
    userChoice: parseJson(run.userChoiceJson, null),
    laterManualEdits: parseJson(run.laterManualEditsJson, []),
    validityStrength: run.validityStrength,
    evidenceRefs: parseJson(run.evidenceRefsJson, []),
    createdAt: run.createdAt,
  };
}

function policyDeltaProjection(delta) {
  return {
    id: delta.id,
    projectId: delta.projectId,
    learnedFromIncidents: parseJson(delta.learnedFromIncidentsJson, []),
    affectedZoneKey: delta.affectedZoneKey,
    ruleCandidate: parseJson(delta.ruleCandidateJson, {}),
    triggerConditions: parseJson(delta.triggerConditionsJson, []),
    expectedRiskReduction: delta.expectedRiskReduction,
    confidence: delta.confidence,
    promotionState: delta.promotionState,
    replayRefs: parseJson(delta.replayRefsJson, []),
    createdAt: delta.createdAt,
    promotedAt: delta.promotedAt,
  };
}
