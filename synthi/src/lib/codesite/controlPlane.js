import { spawn } from 'child_process';
import path from 'path';
import prisma from '@/lib/prisma';
import { buildArtifactProjection, codesiteSchemas, writeArtifactProjection } from './artifacts';
import { asArray, parseJson, stringifyJson, stableJson } from './json';
import { buildProofBundle as buildPortableProofBundle } from './proof';
import {
  buildCodeSiteDojoProofInput,
  summarizeCodeSiteDojoProof,
  verifyCodeSiteDojoProof,
} from './dojoProof';
import {
  classifyPath,
  compileZonePolicy,
  digest,
  evaluateLeaseRequest,
  evaluatePathMutation,
  matchPathPattern,
  normalizePath,
  normalizePathList,
  pathsForRoute,
  predictCollisions,
} from './policy';
import { discoverRepoPolicySignals } from './repoPolicyCompiler';
import {
  buildReadSnapshotEvidence,
  normalizeReadSnapshotEvidence,
  resolveCodeSiteRepoRoot,
  validateReadSnapshotEvidence,
} from './repoSnapshot';

const EVENT_ORDER_BY = [{ logicalTime: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }];

const PROJECT_INCLUDE = {
  agentSessions: true,
  executionPlans: true,
  mutationLeases: true,
  mutationTxns: true,
  assumptions: true,
  policyDecisions: true,
  events: { orderBy: EVENT_ORDER_BY },
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
  const zonePolicy = compileProjectZonePolicy(body.zonePolicy || body.zone_policy || {}, body);
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
  const next = compileProjectZonePolicy({
    ...previous,
    ...(body.zonePolicy || body.zone_policy || body),
  }, body);
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

function compileProjectZonePolicy(input = {}, body = {}) {
  const requested = input || {};
  const repoSignals = requested.repoSignals
    || requested.repo_signals
    || body.repoSignals
    || body.repo_signals
    || (body.repoPolicyCompiler === false || body.repo_policy_compiler === false
      ? null
      : safeDiscoverRepoPolicySignals(body.repoRoot || body.repo_root || requested.repoRoot || requested.repo_root));
  return compileZonePolicy({
    ...requested,
    ...(repoSignals ? { repoSignals } : {}),
  });
}

function safeDiscoverRepoPolicySignals(root) {
  try {
    return discoverRepoPolicySignals({ root });
  } catch (error) {
    return {
      source: 'repo_policy_compiler_error',
      error: error?.message || String(error),
      files: [],
    };
  }
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
  const dojoProof = await verifyCodeSiteDojoProof(buildCodeSiteDojoProofInput(body), {
    workspaceSlug,
    projectId: plan.projectId,
    executionPlan,
    requestedLease,
    policy,
    requestedAction: body.dojoRequestedAction || body.dojo_requested_action || 'codesite.mutation.clearance',
  });
  const dojoProofSummary = summarizeCodeSiteDojoProof(dojoProof);
  const clearancePolicy = applyDojoClearanceGate(policy, dojoProof);
  const lease = await prisma.codeSiteMutationLease.create({
    data: {
      projectId: plan.projectId,
      executionPlanId: plan.id,
      agentSessionId: plan.agentSessionId,
      displayCallsign: plan.displayCallsign,
      status: clearancePolicy.status,
      leaseJson: stringifyJson({
        ...requestedLease,
        issuedBy: 'codesite_policy_engine',
        towerInstruction: clearancePolicy.towerInstruction,
        inspectedZones: clearancePolicy.inspectedZones,
        dojoProofVerification: dojoProofSummary.verification,
      }),
      dojoProofRef: dojoProof.proofRef,
      dojoLicenseRef: dojoProof.licenseRef,
      dojoEvidenceRefsJson: stringifyJson(dojoProof.evidenceRefs),
      dojoLedgerCheckpointHash: dojoProof.ledgerCheckpointHash,
      dojoDecisionDigest: dojoProof.decisionDigest,
      implementationStatusJson: stringifyJson(dojoProof.implementationStatus),
      expiresAt: requestedLease.expiresAt ? new Date(requestedLease.expiresAt) : null,
    },
  });
  const decision = await createPolicyDecision(plan.projectId, {
    mutationLeaseId: lease.id,
    displayCallsign: lease.displayCallsign,
    decision: clearancePolicy.decision,
    reasonCodes: clearancePolicy.reasonCodes,
    input: { executionPlan, requestedLease, dojoProof: dojoProofSummary },
    decisionJson: {
      status: clearancePolicy.status,
      towerInstruction: clearancePolicy.towerInstruction,
      inspectedZones: clearancePolicy.inspectedZones,
      dojoProof: dojoProofSummary,
    },
  });
  await recordEvent(plan.projectId, {
    mutationLeaseId: lease.id,
    eventType: clearancePolicy.decision === 'block' ? 'holding_pattern' : 'clearance_issued',
    displayCallsign: lease.displayCallsign,
    actorType: 'policy_engine',
    actorId: decision.id,
    details: {
      mutationLeaseId: lease.id,
      policyDecisionId: decision.id,
      status: clearancePolicy.status,
      reasonCodes: clearancePolicy.reasonCodes,
      towerInstruction: clearancePolicy.towerInstruction,
    },
  });
  return mutationLeaseProjection(lease, { policyDecision: policyDecisionProjection(decision) });
}

function applyDojoClearanceGate(policy, dojoProof = {}) {
  const restrictedZones = asArray(policy.inspectedZones).filter((zone) => ['A', 'B'].includes(String(zone?.class || '').toUpperCase()));
  if (restrictedZones.length === 0 || policy.decision === 'block') return policy;
  const verification = dojoProof.verification || {};
  const missing = [
    ...(!dojoProof.proofRef ? ['dojo_proof_ref_required'] : []),
    ...(!dojoProof.licenseRef ? ['dojo_license_ref_required'] : []),
    ...(!dojoProof.ledgerCheckpointHash ? ['dojo_ledger_checkpoint_required'] : []),
    ...(dojoProof.evidenceRefs.length === 0 ? ['dojo_evidence_refs_required'] : []),
    ...(dojoProof.implementationStatus?.executable !== true ? ['dojo_implementation_not_executable'] : []),
    ...(verification.ok === true && verification.signatureVerified === true ? [] : ['dojo_public_proof_verification_required']),
    ...asArray(verification.blockedBy),
  ];
  if (!missing.length) {
    return {
      ...policy,
      reasonCodes: unique([...policy.reasonCodes, 'dojo_clearance_proof_verified', 'dojo_public_proof_signature_verified']),
    };
  }
  return {
    ...policy,
    decision: 'block',
    status: 'blocked',
    reasonCodes: unique(['dojo_proof_required_for_restricted_airspace', ...missing]),
    towerInstruction: `Hold position: ${restrictedZones.map((zone) => zone.zoneKey).join(', ')} requires executable Dojo proof before clearance.`,
  };
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

export async function recordPolicyDecision(workspaceSlug, mutationLeaseId, body = {}) {
  const lease = await requireLease(workspaceSlug, mutationLeaseId);
  const decision = await createPolicyDecision(lease.projectId, {
    mutationLeaseId: lease.id,
    displayCallsign: lease.displayCallsign,
    decision: body.decision || 'tower_instruction',
    reasonCodes: asArray(body.reasonCodes || body.reason_codes || []),
    input: body.input || { mutationLeaseId, body },
    decisionJson: body.decisionBody || body.decision_body || body,
  });
  await recordEvent(lease.projectId, {
    mutationLeaseId: lease.id,
    eventType: 'tower_instruction',
    displayCallsign: lease.displayCallsign,
    actorType: 'policy_engine',
    actorId: decision.id,
    details: {
      policyDecisionId: decision.id,
      decision: decision.decision,
      reasonCodes: parseJson(decision.reasonCodesJson, []),
    },
  });
  return policyDecisionProjection(decision);
}

export async function openTransaction(workspaceSlug, mutationLeaseId, body = {}) {
  const lease = await requireLease(workspaceSlug, mutationLeaseId);
  if (lease.status !== 'active') {
    throw badRequest('clearance_not_active', { status: lease.status });
  }
  const leaseJson = parseJson(lease.leaseJson, {});
  const readSet = normalizePathList(body.readSet || body.read_set || []);
  const baseSnapshotEvidence = await buildTransactionSnapshotEvidence(readSet, body);
  const transaction = await prisma.codeSiteMutationTransaction.create({
    data: {
      projectId: lease.projectId,
      mutationLeaseId: lease.id,
      agentSessionId: lease.agentSessionId,
      baseSnapshot: body.baseSnapshot || body.base_snapshot || baseSnapshotEvidence?.snapshotDigest || digest({ workspaceSlug, mutationLeaseId, openedAt: Date.now() }),
      baseSnapshotEvidenceJson: stringifyJson(baseSnapshotEvidence),
      isolation: body.isolation || 'serializable',
      status: 'open',
      readSetJson: stringifyJson(readSet),
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
      baseSnapshotEvidenceDigest: baseSnapshotEvidence?.evidenceDigest || null,
      baseSnapshotStatus: baseSnapshotEvidence?.status || null,
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
  const codesiteFsEvent = body.codesiteFsEvent || body.codesite_fs_event || null;
  const codesiteFsEventType = ['write_denied', 'write_quarantined'].includes(codesiteFsEvent?.type)
    ? codesiteFsEvent.type
    : null;
  const writeEvidence = writeEvidenceFromBody(body, path, codesiteFsEvent);
  const semanticDependencyRefs = semanticSignalsFromWrite(body);
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
    details: {
      transactionId: transaction.id,
      path,
      tool: body.tool || 'file_write',
      zone: evaluation.zone,
      codesiteFsEvent,
      semanticDependencyRefs,
      ...writeEvidence,
    },
  });

  if (codesiteFsEventType) {
    const reasonCodes = codeSiteFsReasonCodes(codesiteFsEvent, evaluation.reasonCodes);
    const decision = await createPolicyDecision(transaction.projectId, {
      mutationLeaseId: transaction.mutationLeaseId,
      displayCallsign: transaction.mutationLease.displayCallsign,
      decision: codesiteFsEventType === 'write_quarantined' ? 'quarantine' : 'block',
      reasonCodes,
      input: { transactionId, path, tool: body.tool || 'file_write', codesiteFsEvent },
      decisionJson: {
        path,
        zone: evaluation.zone,
        codesiteFsEvent,
        towerInstruction: codesiteFsEventType === 'write_quarantined'
          ? `Write quarantined for ${path}. Review before landing.`
          : `Write denied for ${path}. File change order or request a new clearance.`,
      },
    });
    await recordEvent(transaction.projectId, {
      mutationLeaseId: transaction.mutationLeaseId,
      eventType: codesiteFsEventType,
      displayCallsign: transaction.mutationLease.displayCallsign,
      actorType: 'codesitefs',
      actorId: decision.id,
      details: {
        transactionId: transaction.id,
        path,
        reasonCodes,
        policyDecisionId: decision.id,
        zone: evaluation.zone,
        codesiteFsEvent,
      },
    });
    return {
      ok: false,
      quarantined: codesiteFsEventType === 'write_quarantined',
      transaction: transactionProjection(transaction),
      policyDecision: policyDecisionProjection(decision),
    };
  }

  const invalidatedTransactionAssumptions = await invalidatedAssumptionsForTransaction(transaction);
  if (invalidatedTransactionAssumptions.length > 0) {
    const reasonCodes = unique(['assumption_invalidated_write_blocked', 'rebase_required']);
    const decision = await createPolicyDecision(transaction.projectId, {
      mutationLeaseId: transaction.mutationLeaseId,
      displayCallsign: transaction.mutationLease.displayCallsign,
      decision: 'block',
      reasonCodes,
      input: {
        transactionId,
        path,
        tool: body.tool || 'file_write',
        invalidatedAssumptions: invalidatedTransactionAssumptions.map((assumption) => assumption.id),
      },
      decisionJson: {
        path,
        zone: evaluation.zone,
        invalidatedAssumptions: invalidatedTransactionAssumptions.map(assumptionProjection),
        towerInstruction: 'Hold position: transaction assumptions are stale. Rebase assumptions before further writes.',
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
        reasonCodes,
        policyDecisionId: decision.id,
        invalidatedAssumptions: invalidatedTransactionAssumptions.map(assumptionProjection),
      },
    });
    return {
      ok: false,
      transaction: transactionProjection(transaction),
      policyDecision: policyDecisionProjection(decision),
      invalidatedAssumptions: invalidatedTransactionAssumptions.map(assumptionProjection),
    };
  }

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
  const invalidated = await invalidateAssumptionsForWrite(transaction.projectId, {
    path,
    semanticDependencyRefs,
    invalidatedBy: transaction.mutationLease.displayCallsign,
  });
  await recordEvent(transaction.projectId, {
    mutationLeaseId: transaction.mutationLeaseId,
    eventType: 'write_allowed',
    displayCallsign: transaction.mutationLease.displayCallsign,
    actorType: 'transaction',
    actorId: transaction.id,
    details: {
      transactionId: transaction.id,
      path,
      zone: evaluation.zone,
      semanticDependencyRefs,
      invalidatedAssumptions: invalidated,
      ...writeEvidence,
    },
  });
  return { ok: true, transaction: transactionProjection(updated), invalidatedAssumptions: invalidated };
}

export async function dryRunTransactionWrites(workspaceSlug, transactionId, body = {}) {
  const transaction = await requireTransaction(workspaceSlug, transactionId);
  const project = await prisma.codeSiteProject.findUnique({ where: { id: transaction.projectId } });
  const zonePolicy = parseJson(project.zonePolicyJson, compileZonePolicy());
  const files = Array.isArray(body.files)
    ? body.files
    : asArray(body.writes || body.paths).map((path) => (typeof path === 'string' ? { path } : path));
  const results = files.map((file) => {
    const path = normalizePath(file?.path || file?.filePath || file?.file_path);
    if (!path) throw badRequest('invalid_path');
    const tool = file?.tool || body.tool || 'file_write';
    const evaluation = evaluatePathMutation({
      lease: transaction.mutationLease,
      path,
      tool,
      zonePolicy,
    });
    return {
      ok: evaluation.ok,
      path,
      tool,
      zone: evaluation.zone,
      reasonCodes: evaluation.reasonCodes,
      ...(evaluation.ok ? {} : {
        policyDecision: {
          decision: 'block',
          reasonCodes: evaluation.reasonCodes,
          decisionBody: {
            path,
            zone: evaluation.zone,
            towerInstruction: `Write denied for ${path}. File change order or request a new clearance.`,
          },
        },
      }),
    };
  });
  return { transaction: transactionProjection(transaction), results };
}

function writeEvidenceFromBody(body, path, codesiteFsEvent = null) {
  const lineProvenance = normalizeLineProvenanceInput(
    body.lineProvenance
      || body.line_provenance
      || body.hunks
      || body.lineAnchors
      || body.line_anchors
      || codesiteFsEvent?.details?.lineProvenance
      || codesiteFsEvent?.details?.line_provenance,
    path,
  );
  const evidenceRefs = unique([
    ...asArray(body.evidenceRefs || body.evidence_refs),
    ...asArray(codesiteFsEvent?.evidence_refs || codesiteFsEvent?.evidenceRefs),
  ].filter(Boolean));
  const processAncestry = unique([
    ...asArray(body.processAncestry || body.process_ancestry),
    ...asArray(codesiteFsEvent?.details?.process_ancestry || codesiteFsEvent?.details?.processAncestry),
  ].filter(Boolean));
  return {
    ...(lineProvenance.length ? { lineProvenance } : {}),
    ...(evidenceRefs.length ? { evidenceRefs } : {}),
    ...(processAncestry.length ? { processAncestry } : {}),
  };
}

function normalizeLineProvenanceInput(value, defaultPath) {
  return asArray(value).flatMap((item) => {
    if (typeof item === 'number') {
      const filePath = normalizePath(defaultPath);
      return filePath ? [{ filePath, startLine: item, lineAnchor: `${filePath}#L${item}` }] : [];
    }
    if (typeof item === 'string') {
      const filePath = normalizePath(defaultPath || item.split('#')[0]);
      return filePath ? [{ filePath, lineAnchor: item }] : [];
    }
    if (!item || typeof item !== 'object') return [];
    const filePath = normalizePath(item.filePath || item.file_path || item.path || defaultPath);
    if (!filePath) return [];
    const startLine = Number.isFinite(Number(item.startLine || item.start_line || item.line))
      ? Math.max(1, Math.floor(Number(item.startLine || item.start_line || item.line)))
      : null;
    const endLine = Number.isFinite(Number(item.endLine || item.end_line))
      ? Math.max(startLine || 1, Math.floor(Number(item.endLine || item.end_line)))
      : null;
    return [{
      filePath,
      lineAnchor: item.lineAnchor || item.line_anchor || (startLine ? `${filePath}#L${startLine}` : `${filePath}#codesite:hunk`),
      startLine,
      endLine,
      reasonRef: item.reasonRef || item.reason_ref || null,
      evidenceRefs: asArray(item.evidenceRefs || item.evidence_refs),
      processAncestry: asArray(item.processAncestry || item.process_ancestry),
      promptSummary: item.promptSummary || item.prompt_summary || null,
    }];
  });
}

function codeSiteFsReasonCodes(codesiteFsEvent, fallback = []) {
  const reasonCodes = asArray(
    codesiteFsEvent?.details?.reason_codes
    || codesiteFsEvent?.details?.reasonCodes
    || codesiteFsEvent?.reason_codes
    || codesiteFsEvent?.reasonCodes
  );
  return reasonCodes.length ? reasonCodes : asArray(fallback);
}

async function invalidatedAssumptionsForTransaction(transaction) {
  const assumptionRefs = parseJson(transaction.assumptionRefsJson, []);
  if (!assumptionRefs.length) return [];
  return prisma.codeSiteAssumptionLease.findMany({
    where: {
      id: { in: assumptionRefs },
      status: 'invalidated',
    },
  });
}

async function invalidateAssumptionsForWrite(projectId, { path, semanticDependencyRefs = [], invalidatedBy }) {
  const active = await prisma.codeSiteAssumptionLease.findMany({
    where: { projectId, status: 'active' },
  });
  const invalidated = [];
  for (const assumption of active) {
    const dependsOn = asArray(parseJson(assumption.dependsOnJson, []));
    const usedBy = asArray(parseJson(assumption.usedByJson, []));
    const matches = assumptionMatchesWrite({ dependsOn, usedBy, path, semanticDependencyRefs });
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
        semanticDependencyRefs,
      },
    });
  }
  return invalidated;
}

function assumptionMatchesWrite({ dependsOn, usedBy, path, semanticDependencyRefs }) {
  const assumptionRefs = [...dependsOn, ...usedBy];
  if (assumptionRefs.some((item) => assumptionPathMatchesWrite(item, path))) return true;
  const writeSignals = normalizeSemanticRefs(semanticDependencyRefs);
  if (!writeSignals.length) return false;
  const assumptionSignals = normalizeSemanticRefs(assumptionRefs);
  return assumptionSignals.some((assumptionRef) => writeSignals.some((writeRef) => semanticRefsConflict(assumptionRef, writeRef)));
}

function assumptionPathMatchesWrite(item, writePath) {
  const candidate = typeof item === 'string'
    ? item
    : item?.path || item?.filePath || item?.file_path || item?.sourcePath || item?.source_path || item?.dependencyPath || item?.dependency_path;
  const normalized = normalizePath(candidate);
  return normalized && sourcePathsOverlap(normalized, writePath);
}

function semanticSignalsFromWrite(body = {}) {
  return normalizeSemanticRefs([
    body.semanticDependencyRefs,
    body.semantic_dependency_refs,
    body.semanticRefs,
    body.semantic_refs,
    body.contractRefs,
    body.contract_refs,
    body.schemaRefs,
    body.schema_refs,
    body.invalidates,
    body.invalidatesRefs,
    body.invalidates_refs,
    body.invalidatedRefs,
    body.invalidated_refs,
  ]);
}

function normalizeSemanticRefs(values) {
  const refs = asArray(values).flatMap((value) => {
    if (Array.isArray(value)) return normalizeSemanticRefs(value);
    const parsed = parseSemanticRef(value);
    return parsed ? [parsed] : [];
  });
  const seen = new Set();
  return refs.filter((ref) => {
    const key = stableJson(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseSemanticRef(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const match = trimmed.match(/^(.+?)@([^/@]+)$/);
    return {
      ref: normalizeSemanticRefKey(match ? match[1] : trimmed),
      version: match ? String(match[2]).trim() : null,
      raw: trimmed,
      invalidates: true,
    };
  }
  if (typeof value !== 'object') return null;
  const ref = value.ref
    || value.key
    || value.id
    || value.contract
    || value.contractRef
    || value.contract_ref
    || value.schema
    || value.schemaRef
    || value.schema_ref
    || value.dependency
    || value.dependencyRef
    || value.dependency_ref;
  const pathRef = value.path || value.filePath || value.file_path || value.sourcePath || value.source_path || value.dependencyPath || value.dependency_path;
  const normalizedRef = normalizeSemanticRefKey(ref);
  const normalizedPath = normalizePath(pathRef);
  if (!normalizedRef && !normalizedPath) return null;
  return {
    ...(normalizedRef ? { ref: normalizedRef } : {}),
    ...(normalizedPath ? { path: normalizedPath } : {}),
    version: value.version || value.toVersion || value.to_version || value.schemaVersion || value.schema_version || null,
    fromVersion: value.fromVersion || value.from_version || null,
    raw: value.raw || ref || pathRef || null,
    invalidates: value.invalidates !== false,
  };
}

function normalizeSemanticRefKey(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/^semantic:/, '').replace(/^contract:/, '').replace(/^schema:/, '');
  return normalized ? normalized.toLowerCase() : null;
}

function semanticRefsConflict(assumptionRef, writeRef) {
  if (assumptionRef.path && writeRef.path && sourcePathsOverlap(assumptionRef.path, writeRef.path)) return true;
  if (!assumptionRef.ref || !writeRef.ref) return false;
  const sameBase = assumptionRef.ref === writeRef.ref
    || assumptionRef.ref.startsWith(`${writeRef.ref}.`)
    || writeRef.ref.startsWith(`${assumptionRef.ref}.`);
  if (!sameBase) return false;
  if (assumptionRef.version && writeRef.version) return assumptionRef.version !== writeRef.version;
  if (assumptionRef.version && writeRef.fromVersion) return assumptionRef.version === writeRef.fromVersion;
  return writeRef.invalidates !== false;
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
  const semanticDependencyRefs = dependencyPathRefs(parseJson(transaction.semanticDependencyRefsJson, []));
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
  const staleReads = await findStaleReadEvents(transaction, unique([...readSet, ...semanticDependencyRefs]));
  const repoSnapshot = await validateTransactionSnapshot(transaction);
  const ok = blockedWrites.length === 0 && invalidAssumptions.length === 0 && staleReads.length === 0 && repoSnapshot.ok;
  const decision = {
    ok,
    isolation: transaction.isolation,
    reasonCodes: [
      ...(blockedWrites.length ? ['write_outside_clearance'] : []),
      ...(invalidAssumptions.length ? ['assumption_invalidated'] : []),
      ...(staleReads.length ? ['stale_read_detected'] : []),
      ...(!repoSnapshot.ok ? repoSnapshot.reasonCodes : []),
      ...(repoSnapshot.ok && repoSnapshot.reasonCodes.includes('repo_snapshot_stable') ? ['repo_snapshot_stable'] : []),
      ...(ok ? ['serializable_validation_passed'] : []),
    ],
    blockedWrites,
    invalidAssumptions: invalidAssumptions.map(assumptionProjection),
    staleReads,
    repoSnapshot,
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

export async function getSourceStateSince(workspaceSlug, transactionId) {
  const transaction = await requireTransaction(workspaceSlug, transactionId);
  const readSet = parseJson(transaction.readSetJson, []);
  const writeSet = parseJson(transaction.writeSetJson, []);
  const observedReadSet = parseJson(transaction.observedReadSetJson, []);
  const observedWriteSet = parseJson(transaction.observedWriteSetJson, []);
  const semanticDependencyRefs = dependencyPathRefs(parseJson(transaction.semanticDependencyRefsJson, []));
  const events = await sourceStateEventsSince(transaction);
  const externalEvents = events
    .map((event) => ({ event, details: parseJson(event.detailsJson, {}) }))
    .filter(({ event, details }) => !eventBelongsToTransaction(event, details, transaction));
  const changedPaths = [...new Set(externalEvents.flatMap(({ details }) => (
    normalizePathList([details.path, ...asArray(details.writeSet || details.changedPaths || [])])
  )))].sort();

  return {
    transaction: transactionProjection(transaction),
    sourceState: {
      transactionId: transaction.id,
      openedAt: transaction.openedAt,
      checkedAt: new Date().toISOString(),
      readSet,
      observedReadSet,
      writeSet,
      observedWriteSet,
      semanticDependencyRefs,
      repoSnapshot: await validateTransactionSnapshot(transaction),
      changedPaths,
      staleReads: staleReadEventsFrom(transaction, unique([...readSet, ...semanticDependencyRefs]), events),
    },
  };
}

async function sourceStateEventsSince(transaction) {
  return prisma.codeSiteEvent.findMany({
    where: {
      projectId: transaction.projectId,
      createdAt: { gt: transaction.openedAt },
      eventType: { in: ['write_allowed', 'write_quarantined', 'transaction_committed'] },
    },
    orderBy: { createdAt: 'asc' },
  });
}

async function findStaleReadEvents(transaction, readSet) {
  if (!readSet.length) return [];
  const events = await sourceStateEventsSince(transaction);
  return staleReadEventsFrom(transaction, readSet, events);
}

async function buildTransactionSnapshotEvidence(readSet, body = {}) {
  const explicitEvidence = body.baseSnapshotEvidence || body.base_snapshot_evidence;
  if (explicitEvidence) return normalizeReadSnapshotEvidence(explicitEvidence);
  if (body.repoSnapshot === false || body.repo_snapshot === false || body.skipRepoSnapshot === true || body.skip_repo_snapshot === true) {
    return null;
  }
  return buildReadSnapshotEvidence(readSet, {
    repoRoot: body.repoRoot || body.repo_root,
    source: 'codesite_control_plane',
  });
}

async function validateTransactionSnapshot(transaction) {
  const evidence = parseJson(transaction.baseSnapshotEvidenceJson, null);
  return validateReadSnapshotEvidence(evidence);
}

function staleReadEventsFrom(transaction, readSet, events = []) {
  const readPaths = normalizePathList(readSet);
  if (!readPaths.length) return [];
  return events
    .map((event) => ({ event, details: parseJson(event.detailsJson, {}) }))
    .filter(({ event, details }) => !eventBelongsToTransaction(event, details, transaction))
    .filter(({ details }) => {
      const paths = normalizePathList([details.path, ...asArray(details.writeSet || details.changedPaths || [])]);
      return readPaths.some((readPath) => paths.some((writePath) => sourcePathsOverlap(readPath, writePath)));
    })
    .map(({ event, details }) => ({
      eventId: event.id,
      eventType: event.eventType,
      path: details.path || null,
      displayCallsign: event.displayCallsign,
      createdAt: event.createdAt,
    }));
}

function dependencyPathRefs(refs) {
  return normalizePathList(asArray(refs).flatMap((ref) => {
    if (typeof ref === 'string') return ref;
    return [
      ref?.path,
      ref?.pattern,
      ref?.sourcePath,
      ref?.source_path,
      ref?.dependencyPath,
      ref?.dependency_path,
    ];
  }));
}

function sourcePathsOverlap(readPath, writePath) {
  if (!readPath || !writePath) return false;
  if (readPath === writePath) return true;
  if (matchPathPattern(writePath, readPath) || matchPathPattern(readPath, writePath)) return true;
  const readRoot = String(readPath).split('*')[0].replace(/\/+$/, '');
  const writeRoot = String(writePath).split('*')[0].replace(/\/+$/, '');
  if (!readRoot || !writeRoot) return true;
  return readRoot.startsWith(writeRoot) || writeRoot.startsWith(readRoot);
}

function eventBelongsToTransaction(event, details, transaction) {
  return details.transactionId === transaction.id || event.actorId === transaction.id;
}

export async function commitTransaction(workspaceSlug, transactionId, body = {}) {
  const validation = await validateTransaction(workspaceSlug, transactionId);
  if (!validation.decision.ok) return validation;
  const transaction = await requireTransaction(workspaceSlug, transactionId);
  const inspectionDecision = await verifyLandingInspections(transaction);
  if (!inspectionDecision.ok) {
    const decision = {
      ok: false,
      isolation: transaction.isolation,
      reasonCodes: inspectionDecision.reasonCodes,
      missingInspectionPaths: inspectionDecision.missingPaths,
      missingInspectionSignals: inspectionDecision.missingSignals,
      inspectionRuns: inspectionDecision.inspectionRuns.map(inspectionProjection),
      validatedAt: new Date().toISOString(),
    };
    const updated = await prisma.codeSiteMutationTransaction.update({
      where: { id: transaction.id },
      data: {
        status: 'blocked',
        commitDecisionJson: stringifyJson(decision),
      },
    });
    await recordEvent(transaction.projectId, {
      mutationLeaseId: transaction.mutationLeaseId,
      eventType: 'transaction_validated',
      displayCallsign: transaction.mutationLease.displayCallsign,
      actorType: 'transaction',
      actorId: transaction.id,
      details: {
        transactionId: transaction.id,
        decision,
        towerInstruction: 'Landing inspection evidence is required before a proof-carrying commit can land.',
      },
    });
    return { decision, transaction: transactionProjection(updated) };
  }

  const repoStateDecision = verifyRepoStateEvidence(transaction, body);
  if (!repoStateDecision.ok) {
    const decision = {
      ok: false,
      isolation: transaction.isolation,
      reasonCodes: repoStateDecision.reasonCodes,
      missingRepoStatePaths: repoStateDecision.missingPaths,
      repoState: repoStateDecision.repoState,
      validatedAt: new Date().toISOString(),
    };
    const updated = await prisma.codeSiteMutationTransaction.update({
      where: { id: transaction.id },
      data: {
        status: 'blocked',
        commitDecisionJson: stringifyJson(decision),
      },
    });
    await recordEvent(transaction.projectId, {
      mutationLeaseId: transaction.mutationLeaseId,
      eventType: 'transaction_validated',
      displayCallsign: transaction.mutationLease.displayCallsign,
      actorType: 'transaction',
      actorId: transaction.id,
      details: {
        transactionId: transaction.id,
        decision,
        towerInstruction: 'Repo-state evidence is required before a proof-carrying commit can land.',
      },
    });
    return { decision, transaction: transactionProjection(updated) };
  }

  const lineProvenanceDecision = await verifyLineProvenanceEvidence(transaction);
  if (!lineProvenanceDecision.ok) {
    const decision = {
      ok: false,
      isolation: transaction.isolation,
      reasonCodes: lineProvenanceDecision.reasonCodes,
      missingLineProvenancePaths: lineProvenanceDecision.missingPaths,
      validatedAt: new Date().toISOString(),
    };
    const updated = await prisma.codeSiteMutationTransaction.update({
      where: { id: transaction.id },
      data: {
        status: 'blocked',
        commitDecisionJson: stringifyJson(decision),
      },
    });
    await recordEvent(transaction.projectId, {
      mutationLeaseId: transaction.mutationLeaseId,
      eventType: 'transaction_validated',
      displayCallsign: transaction.mutationLease.displayCallsign,
      actorType: 'transaction',
      actorId: transaction.id,
      details: {
        transactionId: transaction.id,
        decision,
        towerInstruction: 'Line-level causal provenance is required for every changed path before landing.',
      },
    });
    return { decision, transaction: transactionProjection(updated) };
  }

  const bundle = await createProofBundleForTransaction(transaction, {
    ...body,
    inspectionEvidenceRefs: inspectionDecision.evidenceRefs,
    inspectionRunRefs: inspectionDecision.inspectionRuns.map((run) => run.id),
    repoState: repoStateDecision.repoState,
  });
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
      repoStateDigest: repoStateDecision.repoState?.evidenceDigest || null,
      inspectionRunIds: inspectionDecision.inspectionRuns.map((run) => run.id),
      inspectionEvidenceRefs: inspectionDecision.evidenceRefs,
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
  const repoState = normalizeRepoStateEvidence(body.repoState || body.repo_state);
  const evidenceRefs = unique([
    ...asArray(body.evidenceRefs || body.evidence_refs || []),
    ...asArray(body.inspectionEvidenceRefs || body.inspection_evidence_refs || []),
    ...asArray(body.inspectionRunRefs || body.inspection_run_refs || []).map((id) => `codesite:inspection:${id}`),
    ...(repoState?.evidenceDigest ? [`codesite:repo-state:${repoState.evidenceDigest}`] : []),
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
    repoState,
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
      repoStateJson: stringifyJson(repoState),
      incidentReplayDigest: body.incidentReplayDigest || body.incident_replay_digest || null,
      bundleDigest,
    },
  });
}

function verifyRepoStateEvidence(transaction, body = {}) {
  const changedPaths = unique([
    ...parseJson(transaction.writeSetJson, []),
    ...parseJson(transaction.observedWriteSetJson, []),
  ]);
  if (changedPaths.length === 0) {
    return { ok: true, reasonCodes: ['no_write_set_no_repo_state_required'], missingPaths: [], repoState: null };
  }
  const repoState = normalizeRepoStateEvidence(body.repoState || body.repo_state);
  if (!repoState) {
    return { ok: false, reasonCodes: ['repo_state_evidence_required'], missingPaths: changedPaths, repoState: null };
  }
  const fileDigests = asArray(repoState.writeFileDigests || repoState.fileDigests || repoState.files);
  const coveredPaths = new Set(fileDigests.map((item) => normalizePath(item?.path)).filter(Boolean));
  const missingPaths = changedPaths.filter((changedPath) => (
    !coveredPaths.has(changedPath)
    && !fileDigests.some((item) => matchPathPattern(changedPath, item?.pathPattern || item?.pattern))
  ));
  const reasonCodes = [
    ...(!repoState.evidenceDigest ? ['repo_state_digest_required'] : []),
    ...(!repoState.worktreeDiffDigest && !repoState.stagedDiffDigest ? ['repo_state_diff_digest_required'] : []),
    ...(missingPaths.length ? ['repo_state_write_path_coverage_required'] : []),
  ];
  return {
    ok: reasonCodes.length === 0,
    reasonCodes: reasonCodes.length ? reasonCodes : ['repo_state_evidence_verified'],
    missingPaths,
    repoState,
  };
}

function normalizeRepoStateEvidence(input) {
  if (!input || typeof input !== 'object') return null;
  const evidenceDigest = input.evidenceDigest || input.evidence_digest || input.digest;
  const normalized = {
    schemaVersion: input.schemaVersion || input.schema_version || 'synthi.codesite.repoStateEvidence.v1',
    workspaceSlug: input.workspaceSlug || input.workspace_slug || null,
    transactionId: input.transactionId || input.transaction_id || null,
    baseSnapshot: input.baseSnapshot || input.base_snapshot || null,
    gitHead: input.gitHead || input.git_head || null,
    stagedDiffDigest: input.stagedDiffDigest || input.staged_diff_digest || null,
    worktreeDiffDigest: input.worktreeDiffDigest || input.worktree_diff_digest || null,
    writeFileDigests: normalizeRepoStateFiles(input.writeFileDigests || input.write_file_digests || input.fileDigests || input.files),
    generatedAt: input.generatedAt || input.generated_at || null,
    source: input.source || 'collab-server',
  };
  normalized.evidenceDigest = evidenceDigest || digest(normalized);
  return normalized;
}

function normalizeRepoStateFiles(files) {
  return asArray(files)
    .map((item) => ({
      path: normalizePath(item?.path || item?.filePath || item?.file_path),
      digest: item?.digest || item?.contentDigest || item?.content_digest || null,
      size: Number.isFinite(item?.size) ? item.size : null,
      exists: item?.exists !== false,
    }))
    .filter((item) => item.path);
}

async function verifyLandingInspections(transaction) {
  const changedPaths = unique([
    ...parseJson(transaction.writeSetJson, []),
    ...parseJson(transaction.observedWriteSetJson, []),
  ]);
  if (changedPaths.length === 0) {
    return { ok: true, reasonCodes: ['no_write_set_no_landing_required'], inspectionRuns: [], evidenceRefs: [] };
  }

  const runs = await prisma.codeSiteInspectionRun.findMany({
    where: { projectId: transaction.projectId },
    orderBy: [{ completedAt: 'desc' }, { requestedAt: 'desc' }],
  });
  const scopedRuns = runs.filter((run) => inspectionRunInTransactionScope(run, transaction));
  const passedRuns = scopedRuns.filter(inspectionRunPassed);
  const coveringRuns = passedRuns.filter((run) => inspectionCoversAllPaths(run, changedPaths));
  const evidenceRefs = unique(coveringRuns.flatMap(inspectionEvidenceRefs));
  const durableEvidenceRefs = evidenceRefs.filter(isDurableInspectionEvidenceRef);
  const requiredSignals = requiredInspectionSignals(transaction);
  const missingPaths = changedPaths.filter((path) => !coveringRuns.some((run) => inspectionCoversPath(run, path)));
  const missingSignals = requiredSignals.filter((signal) => (
    signal !== 'landing' && !coveringRuns.some((run) => inspectionSatisfiesSignal(run, signal))
  ));

  if (requiredSignals.includes('landing') && coveringRuns.length === 0) {
    missingSignals.push('landing');
  }

  const reasonCodes = [
    ...(missingPaths.length ? ['inspection_path_coverage_required'] : []),
    ...(missingSignals.length ? ['inspection_signal_required'] : []),
    ...(evidenceRefs.length === 0 ? ['inspection_evidence_required'] : []),
    ...(evidenceRefs.length > 0 && durableEvidenceRefs.length === 0 ? ['inspection_executable_evidence_required'] : []),
  ];

  return {
    ok: reasonCodes.length === 0,
    reasonCodes: reasonCodes.length ? reasonCodes : ['landing_inspection_passed'],
    missingPaths,
    missingSignals,
    inspectionRuns: coveringRuns,
    evidenceRefs,
  };
}

function inspectionRunInTransactionScope(run, transaction) {
  if (run.executionPlanId && transaction.mutationLease.executionPlanId) {
    return run.executionPlanId === transaction.mutationLease.executionPlanId;
  }
  return !run.displayCallsign || run.displayCallsign === transaction.mutationLease.displayCallsign;
}

function inspectionRunPassed(run) {
  const status = normalizeInspectionSignal(run.status);
  if (['failed', 'failure', 'blocked', 'red', 'go_around'].includes(status)) return false;
  const signals = asArray(parseJson(run.inspectionSignalsJson, []));
  return signals.every((signal) => !inspectionSignalFailed(signal));
}

function inspectionSignalFailed(signal) {
  if (typeof signal === 'string') {
    return /(^|[:_.-])(fail|failed|failure|blocked|red|error)([:_.-]|$)/i.test(signal);
  }
  const status = normalizeInspectionSignal(signal?.status || signal?.result || signal?.outcome || signal?.verdict || 'passed');
  return ['failed', 'failure', 'blocked', 'red', 'error'].includes(status);
}

function inspectionCoversAllPaths(run, changedPaths) {
  return changedPaths.every((path) => inspectionCoversPath(run, path));
}

function inspectionCoversPath(run, path) {
  const changedPaths = normalizePathList(parseJson(run.changedPathsJson, []));
  if (changedPaths.length === 0) return false;
  return changedPaths.some((pattern) => {
    const rel = normalizePath(pattern);
    return rel === path || matchPathPattern(path, pattern);
  });
}

function inspectionEvidenceRefs(run) {
  const signalRefs = asArray(parseJson(run.inspectionSignalsJson, []))
    .flatMap((signal) => asArray(signal?.evidenceRefs || signal?.evidence_refs || signal?.evidenceRef || signal?.evidence_ref));
  return unique([
    ...asArray(parseJson(run.evidenceRefsJson, [])),
    ...signalRefs,
    `codesite:inspection:${run.id}`,
  ].filter(Boolean));
}

function requiredInspectionSignals(transaction) {
  const lease = parseJson(transaction.mutationLease.leaseJson, {});
  const requiredRadar = asArray(lease.requiredRadar || lease.required_radar)
    .map(normalizeInspectionSignal)
    .filter(Boolean);
  const invariantSignals = asArray(parseJson(transaction.invariantsJson, []))
    .filter((invariant) => /[:_.-]pass$/i.test(String(invariant || '')))
    .map(normalizeInspectionSignal)
    .filter(Boolean);
  const required = unique([...requiredRadar, ...invariantSignals]);
  return required.length ? required : ['landing'];
}

function inspectionSatisfiesSignal(run, requiredSignal) {
  const signals = asArray(parseJson(run.inspectionSignalsJson, []));
  return signals.some((signal) => {
    if (inspectionSignalFailed(signal)) return false;
    return normalizeInspectionSignal(signalKey(signal)) === requiredSignal
      && inspectionSignalHasDurableEvidence(run, signal);
  });
}

function signalKey(signal) {
  if (typeof signal === 'string') return signal;
  return signal?.key || signal?.signal || signal?.type || signal?.name || signal?.inspector || '';
}

function normalizeInspectionSignal(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[:.-]+/g, '_')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_pass(ed)?$/, '')
    .replace(/^_+|_+$/g, '');
}

function inspectionSignalHasDurableEvidence(run, signal) {
  const signalRefs = signalEvidenceRefs(signal);
  const refs = signalRefs.length ? signalRefs : inspectionEvidenceRefs(run);
  return refs.some(isDurableInspectionEvidenceRef);
}

function signalEvidenceRefs(signal) {
  if (typeof signal === 'string') return [];
  return asArray(signal?.evidenceRefs || signal?.evidence_refs || signal?.evidenceRef || signal?.evidence_ref);
}

function isDurableInspectionEvidenceRef(ref) {
  return /^(runtime:event|program:event|dojo:evidence|mcp:audit|shadow:job|test:run|typecheck:run|artifact:sha256|codesite:repo-state):/i.test(String(ref || ''));
}

async function seedLineProvenance(transaction, bundle) {
  const eventRows = await lineProvenanceRowsFromWriteEvents(transaction, bundle);
  for (const row of eventRows) {
    await prisma.codeSiteLineProvenance.create({ data: row });
  }
  return { seededRows: eventRows.length, coveredPaths: unique(eventRows.map((row) => row.filePath)) };
}

async function verifyLineProvenanceEvidence(transaction) {
  const paths = unique([
    ...parseJson(transaction.writeSetJson, []),
    ...parseJson(transaction.observedWriteSetJson, []),
  ]);
  if (!paths.length) {
    return { ok: true, reasonCodes: ['no_write_set_no_line_provenance_required'], missingPaths: [] };
  }
  const events = await prisma.codeSiteEvent.findMany({
    where: {
      projectId: transaction.projectId,
      eventType: 'write_allowed',
    },
    orderBy: { createdAt: 'asc' },
  });
  const coveredPaths = new Set(events
    .map((event) => ({ event, details: parseJson(event.detailsJson, {}) }))
    .filter(({ event, details }) => eventBelongsToTransaction(event, details, transaction))
    .flatMap(({ details }) => strictLineProvenanceRows(details.lineProvenance || details.line_provenance, normalizePath(details.path)))
    .map((row) => row.filePath));
  const missingPaths = paths.filter((filePath) => !lineProvenanceCoversPath(coveredPaths, filePath));
  return {
    ok: missingPaths.length === 0,
    reasonCodes: missingPaths.length ? ['line_provenance_required'] : ['line_provenance_verified'],
    missingPaths,
  };
}

function strictLineProvenanceRows(value, defaultPath) {
  return normalizeLineProvenanceInput(value, defaultPath).filter(isStrictLineProvenanceRow);
}

function isStrictLineProvenanceRow(row) {
  return Number.isInteger(row?.startLine)
    && Number.isInteger(row?.endLine)
    && row.startLine >= 1
    && row.endLine >= row.startLine
    && /#L\d+/i.test(String(row.lineAnchor || ''));
}

function lineProvenanceCoversPath(coveredPaths, path) {
  if (coveredPaths.has(path)) return true;
  return [...coveredPaths].some((coveredPath) => (
    matchPathPattern(coveredPath, path) || matchPathPattern(path, coveredPath)
  ));
}

async function lineProvenanceRowsFromWriteEvents(transaction, bundle) {
  const events = await prisma.codeSiteEvent.findMany({
    where: {
      projectId: transaction.projectId,
      eventType: 'write_allowed',
    },
    orderBy: { createdAt: 'asc' },
  });
  return events
    .map((event) => ({ event, details: parseJson(event.detailsJson, {}) }))
    .filter(({ event, details }) => eventBelongsToTransaction(event, details, transaction))
    .flatMap(({ event, details }) => {
      const defaultPath = normalizePath(details.path);
      const rows = strictLineProvenanceRows(details.lineProvenance || details.line_provenance, defaultPath);
      return rows.map((row) => ({
        projectId: transaction.projectId,
        transactionId: transaction.id,
        filePath: row.filePath,
        lineAnchor: row.lineAnchor,
        displayCallsign: transaction.mutationLease.displayCallsign,
        reasonRef: row.reasonRef || `event:${event.id}`,
        evidenceRefsJson: stringifyJson(unique([
          `proof:${bundle.id}`,
          `transaction:${transaction.id}`,
          `event:${event.id}`,
          ...asArray(details.evidenceRefs || details.evidence_refs),
          ...asArray(row.evidenceRefs),
        ].filter(Boolean))),
        dojoSourceRefsJson: stringifyJson([]),
        proofBundleId: bundle.id,
        processAncestryJson: stringifyJson(unique([
          ...asArray(details.processAncestry || details.process_ancestry),
          ...asArray(row.processAncestry),
        ].filter(Boolean))),
        promptSummary: row.promptSummary || details.promptSummary || details.prompt_summary || 'CodeSite write event',
      }));
    });
}

export async function createDocument(workspaceSlug, projectId, body = {}, actor = null) {
  const project = await requireProject(workspaceSlug, projectId);
  const kind = String(body.kind || body.type || 'rfi');
  const routing = await validateDocumentRouting(project.id, body, actor);
  const document = await prisma.codeSiteDocument.create({
    data: {
      projectId: project.id,
      kind,
      status: body.status || 'open',
      title: String(body.title || defaultDocumentTitle(kind)),
      bodyJson: stringifyJson(redactDocumentBody({
        ...(body.body || body),
        routing: {
          fromSessionId: routing.fromSession?.id || null,
          toSessionIds: routing.targetSessions.map((session) => session.id),
          projectRefs: documentProjectRefs(body),
        },
      })),
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
  const inboxItems = await routeDocumentToInbox(project.id, document, event, body, routing.targetSessions);
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

async function validateDocumentRouting(projectId, body = {}, actor = null) {
  const fromSessionId = body.fromSessionId || body.from_session || body.sourceSessionId || body.source_session || null;
  const targetSessionIds = unique(asArray(body.toSessionId || body.to_session || body.recipients || []));
  const fromSession = fromSessionId
    ? await prisma.codeSiteAgentSession.findFirst({ where: { id: fromSessionId, projectId } })
    : null;
  if (fromSessionId && !fromSession) throw notFound('source_agent_session_not_found');
  if (fromSession && actor && !actor.bypass && actor.userId !== fromSession.ownerUserId) {
    throw forbidden('document_sender_forbidden');
  }
  if (!hasDocumentProjectRef(body)) {
    throw badRequest('document_project_reference_required');
  }
  const targetSessions = targetSessionIds.length
    ? await prisma.codeSiteAgentSession.findMany({ where: { projectId, id: { in: targetSessionIds } } })
    : [];
  const foundTargetIds = new Set(targetSessions.map((session) => session.id));
  const missingTargetIds = targetSessionIds.filter((id) => !foundTargetIds.has(id));
  if (missingTargetIds.length) {
    throw badRequest('document_recipient_not_in_project', { missingTargetIds });
  }
  return { fromSession, targetSessions };
}

function hasDocumentProjectRef(body = {}) {
  return Object.values(documentProjectRefs(body)).some((value) => (
    Array.isArray(value) ? value.length > 0 : Boolean(value)
  ));
}

function documentProjectRefs(body = {}) {
  return {
    executionPlanId: body.executionPlanId || body.execution_plan_id || null,
    mutationLeaseId: body.mutationLeaseId || body.mutation_lease_id || body.clearanceId || body.clearance_id || null,
    transactionId: body.transactionId || body.transaction_id || null,
    affectedZones: asArray(body.affectedZones || body.affected_zones || body.affectedZone || body.affected_zone),
    contractRefs: asArray(body.contractRefs || body.contract_refs || body.contractRef || body.contract_ref),
    inspectionRunId: body.inspectionRunId || body.inspection_run_id || null,
    incidentId: body.incidentId || body.incident_id || null,
  };
}

function redactDocumentBody(body) {
  return redactValue(body);
}

function redactValue(input, key = '') {
  if (isSensitiveKey(key)) return '[redacted]';
  if (Array.isArray(input)) return input.map((item) => redactValue(item, key));
  if (!input || typeof input !== 'object') {
    return isSensitiveValue(input) ? '[redacted]' : input;
  }
  return Object.fromEntries(
    Object.entries(input).map(([entryKey, value]) => [entryKey, redactValue(value, entryKey)]),
  );
}

function isSensitiveKey(key) {
  return /secret|token|password|api[_-]?key|private[_-]?prompt|credential|authorization|cookie/i.test(String(key || ''));
}

function isSensitiveValue(value) {
  if (typeof value !== 'string') return false;
  return /(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{12,}|AKIA[0-9A-Z]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/.test(value);
}

async function routeDocumentToInbox(projectId, document, event, body, targetSessions = null) {
  const sessions = targetSessions || [];
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

export async function getAgentInbox(workspaceSlug, agentSessionId, actor = null) {
  const session = await prisma.codeSiteAgentSession.findFirst({
    where: { id: agentSessionId, project: { workspaceSlug } },
  });
  if (!session) throw notFound('agent_session_not_found');
  requireAgentInboxAccess(session, actor);
  const items = await prisma.codeSiteAgentInboxItem.findMany({
    where: { agentSessionId },
    orderBy: { createdAt: 'asc' },
  });
  return items.map(inboxProjection);
}

export async function acknowledgeInboxItem(workspaceSlug, agentSessionId, eventId, actor = null) {
  const session = await prisma.codeSiteAgentSession.findFirst({
    where: { id: agentSessionId, project: { workspaceSlug } },
  });
  if (!session) throw notFound('agent_session_not_found');
  requireAgentInboxAccess(session, actor);
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

function requireAgentInboxAccess(session, actor) {
  if (actor?.bypass) return;
  if (!actor?.userId || session.ownerUserId !== actor.userId) {
    throw forbidden('agent_inbox_forbidden', {
      agentSessionId: session.id,
      recipientUserId: session.ownerUserId,
    });
  }
}

export async function createIncident(workspaceSlug, projectId, body = {}) {
  const project = await requireProject(workspaceSlug, projectId);
  const category = String(body.category || body.kind || 'near_miss').toLowerCase();
  const participants = unique([
    ...oneOrMany(body.participants),
    ...oneOrMany(body.displayCallsign || body.callsign),
  ].map(String).filter(Boolean));
  const affectedZones = affectedZonesForIncident(project, body, category);
  const replay = body.incidentReplay || body.incident_replay || {
    eventRefs: asArray(body.timelineEventRefs || body.timeline_event_refs || []),
    summary: body.summary || body.reason || 'CodeSite incident',
  };
  const incident = await prisma.codeSiteIncident.create({
    data: {
      projectId: project.id,
      severity: body.severity || 'medium',
      category,
      participantsJson: stringifyJson(participants),
      affectedZonesJson: stringifyJson(affectedZones),
      incidentReplayJson: stringifyJson(replay),
      replayDigest: digest(replay),
      timelineEventRefsJson: stringifyJson(body.timelineEventRefs || body.timeline_event_refs || []),
      policyDeltaJson: stringifyJson(body.policyDelta || body.policy_delta || null),
      evidenceRefsJson: stringifyJson(body.evidenceRefs || body.evidence_refs || []),
    },
  });
  const incidentEvent = await recordEvent(project.id, {
    eventType: category === 'near_miss' ? 'near_miss' : 'mayday',
    displayCallsign: body.displayCallsign || body.callsign || null,
    actorType: 'incident',
    actorId: incident.id,
    details: {
      incidentId: incident.id,
      severity: incident.severity,
      category: incident.category,
      replayDigest: incident.replayDigest,
      affectedZones,
    },
  });

  if (category !== 'mayday') return incidentProjection(incident);

  const workflow = await applyMaydayGroundStop(project, incident, body, {
    affectedZones,
    participants,
    incidentEvent,
  });
  const timelineEventRefs = unique([
    ...asArray(body.timelineEventRefs || body.timeline_event_refs),
    incidentEvent.id,
    ...workflow.timelineEventRefs,
  ]);
  const incidentReplay = {
    ...replay,
    eventRefs: timelineEventRefs,
    maydayWorkflow: workflow.replay,
  };
  const updated = await prisma.codeSiteIncident.update({
    where: { id: incident.id },
    data: {
      timelineEventRefsJson: stringifyJson(timelineEventRefs),
      incidentReplayJson: stringifyJson(incidentReplay),
      replayDigest: digest(incidentReplay),
    },
  });
  return {
    ...incidentProjection(updated),
    maydayWorkflow: workflow.summary,
  };
}

async function applyMaydayGroundStop(project, incident, body = {}, context = {}) {
  const affectedZones = context.affectedZones || [];
  const participants = context.participants || [];
  const evidenceRefs = unique([
    ...asArray(body.evidenceRefs || body.evidence_refs),
    `codesite:incident:${incident.id}`,
  ]);
  const snapshot = emergencySnapshot(project, incident, {
    affectedZones,
    participants,
    reason: body.reason || body.summary || 'mayday',
  });
  const snapshotEvent = await recordEvent(project.id, {
    eventType: 'snapshot_taken',
    displayCallsign: body.displayCallsign || body.callsign || null,
    actorType: 'incident',
    actorId: incident.id,
    evidenceRefs,
    details: {
      incidentId: incident.id,
      reason: 'mayday_ground_stop',
      snapshot,
    },
  });
  const suspended = await suspendLeasesForMayday(project, incident, body, affectedZones);
  const inspector = await dispatchMaydayInspector(project, incident, body, affectedZones, evidenceRefs);
  const stopWork = await openStopWorkDocument(project, incident, body, affectedZones, {
    snapshotDigest: snapshot.digest,
    suspendedLeaseIds: suspended.leases.map((lease) => lease.id),
    inspectorRunId: inspector.run.id,
  });
  const timelineEventRefs = unique([
    snapshotEvent.id,
    ...suspended.events.map((event) => event.id),
    inspector.event.id,
    stopWork.event.id,
  ]);
  return {
    timelineEventRefs,
    replay: {
      snapshot,
      suspendedLeases: suspended.leases.map((lease) => ({
        id: lease.id,
        displayCallsign: lease.displayCallsign,
        previousStatus: lease.previousStatus,
        status: lease.status,
      })),
      inspectorRunId: inspector.run.id,
      stopWorkDocumentId: stopWork.document.id,
      humanResumeRequired: true,
    },
    summary: {
      snapshotDigest: snapshot.digest,
      suspendedLeases: suspended.leases.length,
      inspectorRunId: inspector.run.id,
      stopWorkDocumentId: stopWork.document.id,
      humanResumeRequired: true,
    },
  };
}

async function suspendLeasesForMayday(project, incident, body, affectedZones) {
  const activeLeases = await prisma.codeSiteMutationLease.findMany({
    where: { projectId: project.id, status: 'active' },
  });
  const matchingLeases = activeLeases.filter((lease) => leaseIntersectsAffectedZones(lease, affectedZones));
  const leases = [];
  const events = [];
  for (const lease of matchingLeases) {
    const updated = await prisma.codeSiteMutationLease.update({
      where: { id: lease.id },
      data: { status: 'suspended' },
    });
    const decision = await createPolicyDecision(project.id, {
      mutationLeaseId: lease.id,
      displayCallsign: lease.displayCallsign,
      decision: 'hold',
      reasonCodes: unique(['mayday_ground_stop', ...maydayReasonCodes(body)]),
      input: {
        incidentId: incident.id,
        affectedZones,
        lease: mutationLeaseProjection(lease),
      },
      decisionJson: {
        incidentId: incident.id,
        affectedZones,
        previousStatus: lease.status,
        status: 'suspended',
        humanResumeRequired: true,
        towerInstruction: `Ground stop: ${lease.displayCallsign} suspended until human tower approval.`,
      },
    });
    const event = await recordEvent(project.id, {
      mutationLeaseId: lease.id,
      eventType: 'ground_stop',
      displayCallsign: lease.displayCallsign,
      actorType: 'incident',
      actorId: incident.id,
      details: {
        incidentId: incident.id,
        policyDecisionId: decision.id,
        affectedZones,
        previousStatus: lease.status,
        status: 'suspended',
        humanResumeRequired: true,
        towerInstruction: `Ground stop: ${lease.displayCallsign} suspended until human tower approval.`,
      },
    });
    leases.push({ ...mutationLeaseProjection(updated), previousStatus: lease.status });
    events.push(event);
  }
  if (events.length === 0) {
    events.push(await recordEvent(project.id, {
      eventType: 'ground_stop',
      displayCallsign: body.displayCallsign || body.callsign || null,
      actorType: 'incident',
      actorId: incident.id,
      details: {
        incidentId: incident.id,
        affectedZones,
        humanResumeRequired: true,
        towerInstruction: 'Ground stop issued. No active clearances intersected the affected airspace.',
      },
    }));
  }
  return { leases, events };
}

async function dispatchMaydayInspector(project, incident, body, affectedZones, evidenceRefs) {
  const inspectorCallsign = body.inspectorCallsign || body.inspector_callsign || inspectorForMayday(body);
  const run = await prisma.codeSiteInspectionRun.create({
    data: {
      projectId: project.id,
      executionPlanId: body.executionPlanId || body.execution_plan_id || null,
      displayCallsign: inspectorCallsign,
      status: 'requested',
      changedPathsJson: stringifyJson(affectedZones),
      inspectionSignalsJson: stringifyJson(maydayInspectionSignals(body)),
      evidenceRefsJson: stringifyJson(evidenceRefs),
    },
  });
  const event = await recordEvent(project.id, {
    eventType: 'landing_requested',
    displayCallsign: inspectorCallsign,
    actorType: 'inspection',
    actorId: run.id,
    evidenceRefs,
    details: {
      incidentId: incident.id,
      inspectionRunId: run.id,
      status: 'requested',
      changedPaths: affectedZones,
      reason: 'mayday_inspector_dispatched',
    },
  });
  return { run: inspectionProjection(run), event };
}

async function openStopWorkDocument(project, incident, body, affectedZones, workflow) {
  const document = await prisma.codeSiteDocument.create({
    data: {
      projectId: project.id,
      kind: 'stop_work',
      status: 'open',
      title: body.stopWorkTitle || body.stop_work_title || `Ground stop: ${body.reason || body.summary || incident.category}`,
      bodyJson: stringifyJson(redactDocumentBody({
        incidentId: incident.id,
        severity: incident.severity,
        category: incident.category,
        reason: body.reason || body.summary || 'mayday',
        affectedZones,
        suspendedLeaseIds: workflow.suspendedLeaseIds,
        inspectorRunId: workflow.inspectorRunId,
        snapshotDigest: workflow.snapshotDigest,
        resumeGate: {
          requiresHumanApproval: true,
          status: 'blocked',
          instruction: 'Human tower approval is required before affected clearances resume.',
        },
      })),
      blocking: true,
    },
  });
  const event = await recordEvent(project.id, {
    eventType: 'ground_stop',
    actorType: 'document',
    actorId: document.id,
    details: {
      incidentId: incident.id,
      documentId: document.id,
      kind: document.kind,
      blocking: true,
      humanResumeRequired: true,
    },
  });
  return { document: documentProjection(document), event };
}

function affectedZonesForIncident(project, body = {}, category = 'near_miss') {
  const explicit = unique([
    ...oneOrMany(body.affectedZones || body.affected_zones),
    ...oneOrMany(body.affectedZone || body.affected_zone),
    ...oneOrMany(body.affectedAirspace || body.affected_airspace),
  ].map(String).filter(Boolean));
  const zonePolicy = parseJson(project.zonePolicyJson, compileZonePolicy());
  const zones = asArray(zonePolicy.zones);
  const expanded = explicit.flatMap((entry) => {
    const zone = zones.find((candidate) => candidate.zoneKey === entry || candidate.label === entry);
    return zone ? asArray(zone.paths) : [entry];
  });
  if (expanded.length) return unique(pathsForRoute(expanded));
  if (category === 'mayday') return defaultMaydayAffectedZones(body);
  return [];
}

function defaultMaydayAffectedZones(body = {}) {
  const reason = String(body.reason || body.type || body.maydayType || body.mayday_type || '').toLowerCase();
  if (/migration|drop column|destructive/.test(reason)) return ['db/migrations/**', 'synthi/prisma/**'];
  if (/secret|credential|token|key/.test(reason)) return ['**/.env', '**/.env.*', 'secrets/**'];
  if (/auth|permission|bypass/.test(reason)) return ['api/auth/**', 'backend/collab-server/permissionMiddleware.js'];
  if (/contract|schema|openapi/.test(reason)) return ['packages/schemas/**', 'openapi/**', 'synthi/prisma/**'];
  if (/infra|production|deploy/.test(reason)) return ['infra/prod/**', 'infra/production/**', 'k8s/**'];
  return ['**'];
}

function oneOrMany(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function leaseIntersectsAffectedZones(lease, affectedZones) {
  if (!affectedZones.length) return true;
  const leaseJson = parseJson(lease.leaseJson, {});
  const leasePaths = unique(pathsForRoute([
    ...asArray(leaseJson.allowedPaths || leaseJson.route),
    ...asArray(leaseJson.blockedPaths || leaseJson.noFlyZones),
  ]));
  if (!leasePaths.length) return true;
  return leasePaths.some((leasePath) => affectedZones.some((zonePath) => pathPatternsOverlap(leasePath, zonePath)));
}

function pathPatternsOverlap(first, second) {
  if (!first || !second) return false;
  if (first === second || first === '**' || second === '**') return true;
  const firstRoot = patternRoot(first);
  const secondRoot = patternRoot(second);
  if (!firstRoot || !secondRoot) return true;
  return firstRoot === secondRoot
    || firstRoot.startsWith(`${secondRoot}/`)
    || secondRoot.startsWith(`${firstRoot}/`)
    || matchPathPattern(firstRoot, second)
    || matchPathPattern(secondRoot, first);
}

function patternRoot(pattern) {
  return String(pattern || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('*')[0]
    .replace(/\/+$/, '');
}

function maydayReasonCodes(body = {}) {
  const reason = String(body.reason || body.type || body.maydayType || body.mayday_type || 'mayday').toLowerCase();
  const codes = [];
  if (/migration|drop column|destructive/.test(reason)) codes.push('destructive_migration');
  if (/secret|credential|token|key/.test(reason)) codes.push('secret_exposure');
  if (/auth|permission|bypass/.test(reason)) codes.push('auth_risk');
  if (/contract|schema|openapi/.test(reason)) codes.push('contract_drift');
  if (/infra|production|deploy/.test(reason)) codes.push('production_infra_touch');
  return codes.length ? codes : ['mayday_declared'];
}

function maydayInspectionSignals(body = {}) {
  const codes = maydayReasonCodes(body);
  const signals = [
    'clearance',
    ...codes.map((code) => code.replace(/_risk$/, '').replace(/_touch$/, '')),
  ];
  if (codes.includes('destructive_migration')) signals.push('migration', 'security');
  if (codes.includes('secret_exposure') || codes.includes('auth_risk')) signals.push('security');
  if (codes.includes('contract_drift')) signals.push('api_contract', 'tests');
  if (codes.includes('production_infra_touch')) signals.push('runtime', 'security');
  return unique(signals).map((key) => ({
    key,
    status: 'requested',
    evidenceRefs: [],
  }));
}

function inspectorForMayday(body = {}) {
  const codes = maydayReasonCodes(body);
  if (codes.includes('destructive_migration')) return 'DB-INSPECT-02';
  if (codes.includes('secret_exposure') || codes.includes('auth_risk')) return 'SEC-01';
  if (codes.includes('contract_drift')) return 'API-INSPECT-01';
  if (codes.includes('production_infra_touch')) return 'RUNTIME-INSPECT-01';
  return 'SAFETY-INSPECT-01';
}

function emergencySnapshot(project, incident, details = {}) {
  const payload = {
    schemaVersion: 'synthi.codesite.emergencySnapshot.v1',
    projectId: project.id,
    workspaceSlug: project.workspaceSlug,
    incidentId: incident.id,
    reason: details.reason || null,
    affectedZones: details.affectedZones || [],
    participants: details.participants || [],
    projectStatus: project.status,
    zonePolicyDigest: digest(parseJson(project.zonePolicyJson, {})),
    controlPlanDigest: digest(parseJson(project.controlPlanJson, {})),
    createdAt: new Date().toISOString(),
  };
  return {
    ...payload,
    digest: digest(payload),
  };
}

export async function createInspectionRun(workspaceSlug, projectId, body = {}) {
  const project = await requireProject(workspaceSlug, projectId);
  const shouldExecute = inspectionExecutionRequested(body);
  const run = await prisma.codeSiteInspectionRun.create({
    data: {
      projectId: project.id,
      executionPlanId: body.executionPlanId || body.execution_plan_id || null,
      displayCallsign: body.displayCallsign || body.callsign || 'INSPECT-01',
      status: shouldExecute ? 'running' : body.status || 'requested',
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
  if (!shouldExecute) return inspectionProjection(run);
  const executed = await executeInspectionRun(project, run, body);
  return inspectionProjection(executed);
}

export async function completeInspectionRun(workspaceSlug, inspectionRunId, body = {}) {
  const run = await prisma.codeSiteInspectionRun.findFirst({
    where: { id: inspectionRunId, project: { workspaceSlug } },
  });
  if (!run) throw notFound('inspection_run_not_found');
  if (inspectionExecutionRequested(body)) {
    const project = await requireProject(workspaceSlug, run.projectId);
    const running = await prisma.codeSiteInspectionRun.update({
      where: { id: run.id },
      data: { status: 'running' },
    });
    return inspectionProjection(await executeInspectionRun(project, running, body));
  }
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

async function executeInspectionRun(project, run, body = {}) {
  const commandSpecs = normalizeInspectionCommands(body);
  if (commandSpecs.length === 0) {
    const failed = await prisma.codeSiteInspectionRun.update({
      where: { id: run.id },
      data: {
        status: 'failed',
        inspectionSignalsJson: stringifyJson([
          ...asArray(parseJson(run.inspectionSignalsJson, [])),
          {
            key: 'inspection_command',
            status: 'failed',
            reason: 'inspection_command_required',
            evidenceRefs: [],
          },
        ]),
        evidenceRefsJson: stringifyJson(parseJson(run.evidenceRefsJson, [])),
        completedAt: new Date(),
      },
    });
    await recordInspectionExecutionEvents(project.id, failed, [{
      key: 'inspection_command',
      status: 'failed',
      reason: 'inspection_command_required',
      evidenceRefs: [],
    }]);
    return failed;
  }

  const repoRoot = resolveCodeSiteRepoRoot({ repoRoot: body.repoRoot || body.repo_root });
  const startedSignals = asArray(parseJson(run.inspectionSignalsJson, []));
  const commandSignals = [];
  for (const spec of commandSpecs) {
    commandSignals.push(await runInspectionCommand(spec, repoRoot));
  }
  const evidenceRefs = unique([
    ...parseJson(run.evidenceRefsJson, []),
    ...commandSignals.flatMap((signal) => asArray(signal.evidenceRefs || signal.evidence_refs)),
  ]);
  const status = commandSignals.every((signal) => normalizeInspectionSignal(signal.status) === 'passed') ? 'completed' : 'failed';
  const updated = await prisma.codeSiteInspectionRun.update({
    where: { id: run.id },
    data: {
      status,
      inspectionSignalsJson: stringifyJson([...startedSignals, ...commandSignals]),
      evidenceRefsJson: stringifyJson(evidenceRefs),
      completedAt: new Date(),
    },
  });
  await recordInspectionExecutionEvents(project.id, updated, commandSignals);
  return updated;
}

function inspectionExecutionRequested(body = {}) {
  return body.execute === true
    || body.autoRun === true
    || body.auto_run === true
    || asArray(body.commands || body.inspectionCommands || body.inspection_commands).length > 0;
}

function normalizeInspectionCommands(body = {}) {
  return asArray(body.commands || body.inspectionCommands || body.inspection_commands)
    .map((command, index) => normalizeInspectionCommand(command, index))
    .filter(Boolean);
}

function normalizeInspectionCommand(command, index) {
  if (Array.isArray(command)) {
    const [executable, ...args] = command.map((part) => String(part));
    if (!executable) return null;
    return {
      key: normalizeInspectionSignal(executable) || `command_${index + 1}`,
      executable,
      args,
      cwd: null,
      timeoutMs: null,
    };
  }
  if (!command || typeof command !== 'object') return null;
  const executable = String(command.command || command.executable || command.bin || '').trim();
  if (!executable) return null;
  return {
    key: normalizeInspectionSignal(command.key || command.signal || command.name || executable) || `command_${index + 1}`,
    executable,
    args: asArray(command.args || command.argv).map((arg) => String(arg)),
    cwd: normalizePath(command.cwd || command.workingDirectory || command.working_directory) || null,
    timeoutMs: parseOptionalNumber(command.timeoutMs ?? command.timeout_ms),
  };
}

async function runInspectionCommand(spec, repoRoot) {
  const startedAt = new Date();
  const cwd = resolveInspectionCwd(repoRoot, spec.cwd);
  const timeoutMs = normalizeInspectionTimeout(spec.timeoutMs);
  const result = await runCommand(spec.executable, spec.args, { cwd, timeoutMs });
  const completedAt = new Date();
  const status = result.exitCode === 0 && !result.timedOut ? 'passed' : 'failed';
  const evidenceDigest = digest({
    key: spec.key,
    executable: spec.executable,
    args: spec.args,
    cwd: path.relative(repoRoot, cwd) || '.',
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    stdoutTail: result.stdoutTail,
    stderrTail: result.stderrTail,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
  });
  const evidenceRefs = unique([
    durableInspectionCommandRef(spec.key, evidenceDigest),
    `artifact:${evidenceDigest}`,
  ]);
  return {
    key: spec.key,
    status,
    command: {
      executable: spec.executable,
      args: spec.args,
      cwd: path.relative(repoRoot, cwd) || '.',
      timeoutMs,
    },
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: completedAt.getTime() - startedAt.getTime(),
    stdoutTail: result.stdoutTail,
    stderrTail: result.stderrTail,
    evidenceDigest,
    evidenceRefs,
    source: 'codesite_inspection_executor',
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
  };
}

function resolveInspectionCwd(repoRoot, cwd) {
  const root = path.resolve(repoRoot || process.cwd());
  if (!cwd) return root;
  const target = path.resolve(root, cwd);
  const relative = path.relative(root, target);
  if (relative && (relative.startsWith('..') || path.isAbsolute(relative))) {
    throw badRequest('inspection_cwd_outside_repo', { cwd });
  }
  return target;
}

function normalizeInspectionTimeout(value) {
  const max = Number(process.env.SYNTHI_CODESITE_INSPECTION_MAX_TIMEOUT_MS || 120000);
  const fallback = Number(process.env.SYNTHI_CODESITE_INSPECTION_TIMEOUT_MS || 30000);
  const requested = Number(value || fallback);
  const timeout = Number.isFinite(requested) && requested > 0 ? requested : fallback;
  return Math.min(timeout, Number.isFinite(max) && max > 0 ? max : 120000);
}

function parseOptionalNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function runCommand(executable, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout = tail(`${stdout}${chunk.toString('utf8')}`);
    });
    child.stderr.on('data', (chunk) => {
      stderr = tail(`${stderr}${chunk.toString('utf8')}`);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: 127,
        signal: null,
        timedOut,
        stdoutTail: stdout,
        stderrTail: tail(`${stderr}${error?.message || String(error)}`),
      });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal,
        timedOut,
        stdoutTail: stdout,
        stderrTail: stderr,
      });
    });
  });
}

function tail(value, limit = 8000) {
  const text = String(value || '');
  return text.length > limit ? text.slice(-limit) : text;
}

function durableInspectionCommandRef(key, evidenceDigest) {
  const normalized = normalizeInspectionSignal(key);
  if (/typecheck|tsc/.test(normalized)) return `typecheck:run:${evidenceDigest}`;
  if (/test|vitest|jest|playwright|spec/.test(normalized)) return `test:run:${evidenceDigest}`;
  if (/security|secret|auth/.test(normalized)) return `runtime:event:${evidenceDigest}`;
  return `artifact:${evidenceDigest}`;
}

async function recordInspectionExecutionEvents(projectId, run, signals) {
  await recordEvent(projectId, {
    eventType: 'radar_result',
    displayCallsign: run.displayCallsign,
    actorType: 'inspection',
    actorId: run.id,
    details: {
      inspectionRunId: run.id,
      status: run.status,
      signals,
    },
  });
  await recordEvent(projectId, {
    eventType: 'inspection_result',
    displayCallsign: run.displayCallsign,
    actorType: 'inspection',
    actorId: run.id,
    details: {
      inspectionRunId: run.id,
      status: run.status,
      signals,
    },
  });
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
  return buildControlState(workspaceSlug, projection);
}

function buildControlState(workspaceSlug, projection) {
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
    projectId: projection.id,
    workspaceSlug,
    towerState: requiredActions.length ? 'holding' : 'active',
    status: projection.status,
    activeFlights: projection.executionPlans.filter((plan) => ['filed', 'preflight', 'cleared', 'taxiing', 'airborne', 'holding'].includes(plan.status)),
    activeMutationLeases: activeLeases,
    activeTransactions: projection.mutationTxns.filter((txn) => ['open', 'validated', 'blocked'].includes(txn.status)),
    allowedPaths: unique(activeLeases.flatMap((lease) => pathsForRoute(lease.lease.allowedPaths || []))),
    blockedPaths: unique(activeLeases.flatMap((lease) => pathsForRoute(lease.lease.blockedPaths || []))),
    requiredActions,
    eventsSince: eventCursor(projection.events.at(-1)),
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
  const where = await eventWhereSince(project.id, since);
  const events = await prisma.codeSiteEvent.findMany({
    where,
    orderBy: EVENT_ORDER_BY,
  });
  return events.map(eventProjection);
}

export function eventCursor(event) {
  if (!event) return null;
  const logicalTime = Number(event.logicalTime);
  if (Number.isSafeInteger(logicalTime) && logicalTime >= 0) return `lt:${logicalTime}`;
  return event.id || null;
}

async function eventWhereSince(projectId, since) {
  const cursor = parseEventCursor(since);
  if (!cursor) return { projectId };
  if (cursor.logicalTime !== null) {
    return { projectId, logicalTime: { gt: cursor.logicalTime } };
  }
  const anchor = await prisma.codeSiteEvent.findFirst({
    where: { projectId, id: cursor.id },
    select: { logicalTime: true },
  });
  const anchorLogicalTime = Number(anchor?.logicalTime);
  if (Number.isSafeInteger(anchorLogicalTime) && anchorLogicalTime >= 0) {
    return { projectId, logicalTime: { gt: anchorLogicalTime } };
  }
  return { projectId };
}

function parseEventCursor(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const logicalMatch = raw.match(/^lt:(\d+)$/i) || raw.match(/^(\d+)$/);
  if (logicalMatch) return { logicalTime: Number(logicalMatch[1]), id: null };
  return { logicalTime: null, id: raw };
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
      'synthi_codesite_apply_patch',
      'synthi_codesite_predict_collision',
    ],
  };
}

export async function getSchemas() {
  return codesiteSchemas();
}

export async function previewArtifacts(workspaceSlug, projectId, options = {}) {
  const project = await getProject(workspaceSlug, projectId);
  if (!project) throw notFound('project_not_found');
  const controlState = await getControlState(workspaceSlug, projectId);
  const files = buildArtifactProjection(project, controlState);
  const includeContent = Boolean(options.includeContent || options.include_content);
  const maxContentBytes = Number.isFinite(options.maxContentBytes) ? Math.max(0, options.maxContentBytes) : 4096;
  return {
    projectId,
    files: files.map((file) => ({
      path: file.relativePath,
      bytes: Buffer.byteLength(file.content, 'utf8'),
      ...(includeContent ? { contentPreview: file.content.slice(0, maxContentBytes) } : {}),
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
    include: {
      project: true,
      transaction: {
        include: {
          mutationLease: true,
        },
      },
    },
  });
  if (!bundle) throw notFound('proof_bundle_not_found');
  const incidents = await prisma.codeSiteIncident.findMany({
    where: { projectId: bundle.projectId },
    orderBy: { createdAt: 'asc' },
  });
  const lineProvenance = await prisma.codeSiteLineProvenance.findMany({
    where: { proofBundleId: bundle.id },
    orderBy: { createdAt: 'asc' },
  });
  const projection = proofBundleProjection(bundle);
  return {
    ...projection,
    portableProofBundle: buildPortableProofBundle({
      project: projectProjection(bundle.project),
      transaction: transactionProjection(bundle.transaction),
      mutationLease: bundle.transaction?.mutationLease ? mutationLeaseProjection(bundle.transaction.mutationLease) : null,
      proofBundle: projection,
      incidents: incidents.map(incidentProjection),
      lineProvenance: lineProvenance.map(lineProvenanceProjection),
    }),
  };
}

export async function getIncidentReplay(workspaceSlug, incidentId) {
  const incident = await prisma.codeSiteIncident.findFirst({
    where: { id: incidentId, project: { workspaceSlug } },
    include: { project: { include: { events: { orderBy: EVENT_ORDER_BY } } } },
  });
  if (!incident) throw notFound('incident_not_found');
  const projectedIncident = incidentProjection(incident);
  const timeline = incidentReplayTimeline(projectedIncident, incident.project.events.map(eventProjection));
  return {
    incident: projectedIncident,
    replay: projectedIncident.incidentReplay,
    timeline,
    replayDigest: projectedIncident.replayDigest || digest(timeline),
  };
}

function incidentReplayTimeline(incident, events) {
  const refs = new Set([
    ...asArray(incident.timelineEventRefs),
    ...asArray(incident.incidentReplay?.eventRefs),
    ...asArray(incident.incidentReplay?.events),
  ].filter(Boolean));
  const participants = new Set(asArray(incident.participants));
  const selected = events.filter((event) => (
    refs.has(event.id)
    || refs.has(event.eventType)
    || participants.has(event.displayCallsign)
  ));
  const eventTimeline = selected.map((event, index) => ({
    sequence: index + 1,
    source: 'codesite_event',
    event,
  }));
  return [
    ...eventTimeline,
    {
      sequence: eventTimeline.length + 1,
      source: 'incident_record',
      event: {
        id: incident.id,
        severity: incident.severity,
        category: incident.category,
        affectedZones: incident.affectedZones,
        evidenceRefs: incident.evidenceRefs,
        createdAt: incident.createdAt,
      },
    },
  ];
}

async function recordEvent(projectId, input) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const logicalTime = await prisma.codeSiteEvent.count({ where: { projectId } });
    try {
      const event = await prisma.codeSiteEvent.create({
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
      await syncArtifactsAfterEvent(projectId, event);
      return event;
    } catch (error) {
      if (!isLogicalTimeConflict(error)) throw error;
    }
  }
  throw new Error('codesite_event_logical_time_conflict');
}

async function syncArtifactsAfterEvent(projectId, event) {
  if (!autoArtifactSyncEnabled()) return null;
  try {
    const project = await prisma.codeSiteProject.findUnique({
      where: { id: projectId },
      include: PROJECT_INCLUDE,
    });
    if (!project) return null;
    const projection = projectProjection(project);
    const controlState = buildControlState(project.workspaceSlug, projection);
    const result = await writeArtifactProjection(projection, controlState);
    return {
      eventId: event?.id || null,
      ...result,
    };
  } catch (error) {
    console.warn('[CodeSite] artifact auto-sync failed', {
      projectId,
      eventId: event?.id || null,
      error: error?.message || String(error),
    });
    return null;
  }
}

function autoArtifactSyncEnabled() {
  const configured = process.env.SYNTHI_CODESITE_AUTO_ARTIFACT_SYNC;
  if (/^(0|false|off|no)$/i.test(String(configured || ''))) return false;
  if (/^(1|true|on|yes)$/i.test(String(configured || ''))) return true;
  if (process.env.NODE_ENV === 'test' || process.env.VITEST_WORKER_ID) return false;
  return true;
}

function isLogicalTimeConflict(error) {
  const targetValue = error?.meta?.target;
  const target = Array.isArray(targetValue) ? targetValue.join(',') : String(targetValue || '');
  return error?.code === 'P2002'
    && (
      (target.includes('projectId') && target.includes('logicalTime'))
      || target.includes('CodeSiteEvent_projectId_logicalTime')
    );
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

function forbidden(code, detail) {
  const error = new Error(code);
  error.status = 403;
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
    baseSnapshotEvidence: parseJson(transaction.baseSnapshotEvidenceJson, null),
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
    repoState: parseJson(bundle.repoStateJson, null),
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
