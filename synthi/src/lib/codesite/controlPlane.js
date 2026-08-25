import { spawn } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import prisma from '@/lib/prisma';
import { autoOpenDirectChannels } from './autoChannels';
import { enforceRateLimit } from './routeHelpers';
import {
  channelsDisabled,
  channelMaxDurationMs,
  effectiveChannelMode,
  hashChannelToken,
  mintChannelToken,
  modeTransports,
  CHANNEL_GRANT_WINDOW_MS,
} from './channelSecurity';
import { buildArtifactProjection, CODESITE_MCP_TOOLS, codesiteSchemas, quarantineReviewRecords, writeArtifactProjection } from './artifacts';
import { buildFilesystemBoundaryProofRecords } from './filesystemBoundaryProof';
import { asArray, parseJson, stringifyJson, stableJson } from './json';
import { buildProofBundle as buildPortableProofBundle, proofCommitTrailers } from './proof';
import { buildCodeSiteMetrics } from './metrics';
import {
  buildCodeSiteDojoProofInput,
  summarizeCodeSiteDojoProof,
  verifyCodeSiteDojoProof,
} from './dojoProof';
import {
  applyPilotLicenseHealthGate,
  buildPilotLicenseHealthForClearance,
  buildPilotLicenseHealthRecords,
  pilotLicenseHealthSummary,
} from './pilotLicense';
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
  validateCodeSiteEventType,
} from './policy';
import { discoverRepoPolicySignals, REPO_POLICY_COMPILER_VERSION } from './repoPolicyCompiler';
import {
  buildReadSnapshotEvidence,
  normalizeReadSnapshotEvidence,
  resolveCodeSiteRepoRoot,
  validateReadSnapshotEvidence,
} from './repoSnapshot';
import {
  codeSiteEvidenceRefsJson,
  firstCodeSiteRef,
} from './substrateIdentity';
import {
  buildKnowledgeRecord,
  buildKnowledgeReferenceRecords,
  projectKnowledgeRecord,
} from './knowledgeRecords';
import { buildKnowledgeDeliveryPlan } from './knowledgeRouting';
import { validateKnowledgeResponse } from './knowledgeResponses';
import {
  deliveryAllowedOrigins,
  endpointDeliveryAllowed,
  signDeliveryEnvelope,
} from './deliverySecurity';
import { createProjectCoordinationBus, ProjectCoordinationBusError } from './projectCoordinationBus';
import { canonicalKnowledgeEventType } from './knowledgeEvents';
import { getCodeSiteRuntimeConfig } from './runtimeConfig';
import {
  buildObservationCoordinationInput,
  normalizeProjectObservation,
  normalizeRuntimeObservedObservation,
  normalizeSourceChangedObservation,
} from './projectObservation';

const EVENT_ORDER_BY = [{ logicalTime: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }];
const ACTIVE_FLIGHT_STATUSES = ['filed', 'preflight', 'cleared', 'taxiing', 'airborne', 'holding', 'rerouted', 'landing_requested'];
const SUPPORTED_TRANSACTION_ISOLATION = 'serializable';
const DEFAULT_TOWER_SIMULATION_STRATEGIES = [
  'schema-first',
  'backend-first',
  'frontend-backend-parallel',
  'single-fullstack-agent',
  'test-first',
];
const MAX_JSON_COMMAND_OUTPUT_CHARS = 2 * 1024 * 1024;
const RADAR_INSPECTION_ADAPTERS = [
  { key: 'clearance', label: 'Clearance radar', evidencePrefix: 'clearance:run', aliases: ['clearance', 'diff', 'scope'] },
  { key: 'type', label: 'Type radar', evidencePrefix: 'typecheck:run', aliases: ['type', 'typecheck', 'tsc', 'schema_compatibility'] },
  { key: 'tests', label: 'Test radar', evidencePrefix: 'test:run', aliases: ['test', 'tests', 'unit_tests', 'integration_tests', 'e2e', 'vitest', 'jest', 'playwright'] },
  { key: 'api_contract', label: 'API contract radar', evidencePrefix: 'api-contract:run', aliases: ['api', 'api_contract', 'contract', 'openapi', 'schema_contract'] },
  { key: 'security', label: 'Security radar', evidencePrefix: 'security:scan', aliases: ['security', 'secret', 'secrets', 'auth', 'injection', 'rate_limit'] },
  { key: 'migration', label: 'Migration radar', evidencePrefix: 'migration:plan', aliases: ['migration', 'migrations', 'rollback', 'database'] },
  { key: 'ui', label: 'UI radar', evidencePrefix: 'ui:screenshot', aliases: ['ui', 'visual', 'screenshot', 'responsive', 'visual_drift'] },
  { key: 'accessibility', label: 'Accessibility radar', evidencePrefix: 'accessibility:audit', aliases: ['accessibility', 'a11y', 'labels', 'keyboard', 'contrast'] },
  { key: 'runtime', label: 'Runtime radar', evidencePrefix: 'runtime:event', aliases: ['runtime', 'health', 'ports', 'logs', 'start'] },
  { key: 'performance', label: 'Performance radar', evidencePrefix: 'performance:budget', aliases: ['performance', 'perf', 'latency', 'bundle', 'query_budget'] },
  { key: 'handover', label: 'Handover radar', evidencePrefix: 'handover:packet', aliases: ['handover', 'handoff', 'packet', 'review_packet'] },
];
const PROMOTED_POLICY_DELTA_STATES = new Set(['promoted', 'accepted', 'active', 'validated']);
const POLICY_DELTA_PROMOTION_TARGET_STATES = new Set(['shadowed', ...PROMOTED_POLICY_DELTA_STATES]);
const GOVERNANCE_APPROVED_PERMIT_STATUSES = new Set(['issued', 'active', 'approved']);
const GOVERNANCE_APPROVED_DOCUMENT_STATUSES = new Set(['approved', 'resolved', 'closed', 'accepted', 'answered']);
const GOVERNANCE_APPROVED_ROUTE_REVISION_STATUSES = new Set(['approved', 'applied']);
const GOVERNANCE_DOCUMENT_KINDS = new Set(['change_order', 'rfi', 'submittal', 'permit']);
const COMMITTABLE_TRANSACTION_STATUSES = new Set(['open', 'validated']);
const projectCommitLandingLocks = new Map();
const SHADOW_RUNNER_EVIDENCE_REQUIRED_ENV_KEYS = [
  'SYNTHI_CODESITE_REQUIRE_SHADOW_RUNNER_EVIDENCE',
  'SYNTHI_CODESITE_SHADOW_RUNNER_EVIDENCE_REQUIRED',
];
const SHADOW_MERGE_MATURITY_ENV_KEYS = [
  'SYNTHI_CODESITE_SHADOW_MERGE_PROOF_MATURITY',
];
const BLACK_BOX_MINIMUM_EVENT_TYPES = [
  'transaction.opened',
  'assumption.recorded',
  'clearance.issued',
  'read.observed',
  'write.attempted',
  'write.denied',
  'snapshot.taken',
  'shadow.run',
  'arbiter.verdict',
  'inspection.result',
  'near_miss.detected',
  'policy_delta.proposed',
  'transaction.committed',
  'transaction.aborted',
];
const TRANSACTION_BLACK_BOX_EVENT_TYPES = new Set([
  'flight_plan_filed',
  'clearance_requested',
  'clearance_issued',
  'transaction_opened',
  'transaction_validated',
  'transaction_committed',
  'transaction_aborted',
  'assumption_recorded',
  'assumption_invalidated',
  'read_observed',
  'write_attempted',
  'write_allowed',
  'write_denied',
  'write_quarantined',
  'quarantine_reviewed',
  'quarantine_replayed',
  'quarantine_applied',
  'snapshot_taken',
  'transponder_update',
  'route_deviation',
  'holding_pattern',
  'tower_instruction',
  'rfi',
  'change_order',
  'mayday',
  'ground_stop',
  'landing_requested',
  'radar_result',
  'inspection_result',
  'shadow_run',
  'arbiter_verdict',
  'near_miss',
  'policy_delta_proposed',
  'policy_delta_promoted',
  'policy_delta_rejected',
  'black_box_closed',
]);

const PROJECT_INCLUDE = {
  members: true,
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
  permits: true,
  documentReviews: true,
  routeRevisions: true,
  counterfactualRuns: true,
  policyDeltas: true,
  inboxItems: true,
  knowledgeItems: { include: { references: true } },
};

const PROJECT_READ_ROLES = new Set(['owner', 'admin', 'operator', 'agent', 'observer', 'viewer', 'read']);
const PROJECT_WRITE_ROLES = new Set(['owner', 'admin', 'operator', 'agent', 'write']);
const PROJECT_MEMBER_MANAGE_ROLES = new Set(['owner', 'admin', 'tower']);
const PROJECT_MAYDAY_RESUME_ROLES = new Set(['owner', 'admin', 'tower']);

function actorUserId(actor = null) {
  return actor?.userId || actor?.workspaceUserId || null;
}

function projectMembershipDelegate() {
  return prisma.codeSiteProjectMember || null;
}

function projectRoleAllows(role, mode = 'read') {
  const normalized = String(role || '').toLowerCase();
  if (mode === 'members:manage') return PROJECT_MEMBER_MANAGE_ROLES.has(normalized);
  if (mode === 'mayday:resume') return PROJECT_MAYDAY_RESUME_ROLES.has(normalized);
  if (mode === 'write') return PROJECT_WRITE_ROLES.has(normalized);
  return PROJECT_READ_ROLES.has(normalized) || PROJECT_WRITE_ROLES.has(normalized);
}

function projectPermissionAllows(member, mode = 'read') {
  if (!member || member.revokedAt || member.participationStatus === 'disabled') return false;
  const permissions = parseJson(member.permissionsJson, null);
  if (!Array.isArray(permissions) || permissions.length === 0) {
    return projectRoleAllows(member.role, mode);
  }
  const set = new Set(permissions.map((permission) => String(permission || '').toLowerCase()));
  if (set.has('*') || set.has('project:*')) return true;
  if (mode === 'members:manage') return set.has('project:members:manage');
  if (mode === 'mayday:resume') return set.has('mayday:resume') || set.has('mayday:override_resume');
  if (mode === 'write') return set.has('project:write');
  return set.has('project:read') || set.has('project:write');
}

function rolePermissions(role) {
  const normalized = String(role || '').toLowerCase();
  if (['owner', 'admin', 'tower'].includes(normalized)) {
    return [
      'project:read',
      'project:write',
      'project:members:manage',
      'agent:any',
      'document:file',
      'inspection:manage',
      'mayday:declare',
      'mayday:resume',
      'mayday:override_resume',
    ];
  }
  if (['operator', 'agent', 'contributor'].includes(normalized)) {
    return ['project:read', 'project:write', 'agent:own', 'document:file', 'mayday:declare'];
  }
  if (normalized === 'inspector') {
    return ['project:read', 'document:file', 'inspection:manage', 'mayday:declare'];
  }
  return ['project:read'];
}

function projectMembershipProjection(member) {
  return {
    id: member.id,
    projectId: member.projectId,
    workspaceSlug: member.workspaceSlug,
    userId: member.userId,
    role: member.role,
    permissions: parseJson(member.permissionsJson, []),
    redactionPolicy: parseJson(member.redactionPolicyJson, null),
    participationStatus: member.participationStatus || 'enabled',
    source: member.source,
    createdByUserId: member.createdByUserId || null,
    revokedAt: member.revokedAt || null,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
  };
}

export async function upsertProjectMember(workspaceSlugOrInput, projectIdArg, bodyArg = {}, actorArg = null) {
  if (typeof workspaceSlugOrInput === 'object' && workspaceSlugOrInput) {
    return upsertProjectMemberRecord(workspaceSlugOrInput);
  }
  const workspaceSlug = workspaceSlugOrInput;
  const project = await requireProject(workspaceSlug, projectIdArg, actorArg, 'members:manage');
  const userId = bodyArg.userId || bodyArg.user_id || bodyArg.ownerUserId || bodyArg.owner_user_id;
  if (!userId) throw badRequest('codesite_project_member_user_required');
  const member = await upsertProjectMemberRecord({
    projectId: project.id,
    workspaceSlug,
    userId,
    role: bodyArg.role || 'agent',
    permissions: bodyArg.permissions,
    redactionPolicy: bodyArg.redactionPolicy || bodyArg.redaction_policy,
    participationStatus: bodyArg.participationStatus || bodyArg.participation_status || 'enabled',
    source: 'project_member_api',
    createdByUserId: actorUserId(actorArg),
  });
  await recordEvent(project.id, {
    eventType: 'tower_instruction',
    actorType: 'human',
    actorId: actorUserId(actorArg),
    details: {
      type: 'project_member_upserted',
      userId,
      role: member?.role || bodyArg.role || 'agent',
      participationStatus: member?.participationStatus || bodyArg.participationStatus || 'enabled',
    },
  });
  return projectMembershipProjection(member);
}

async function upsertProjectMemberRecord({ projectId, workspaceSlug, userId, role = 'agent', permissions = null, redactionPolicy = null, participationStatus = 'enabled', source = 'agent_session_owner', createdByUserId = null }) {
  const delegate = projectMembershipDelegate();
  if (!delegate || !projectId || !workspaceSlug || !userId) return null;
  const existing = await delegate.findUnique({
    where: { projectId_userId: { projectId, userId } },
  }).catch(() => null);
  const nextRole = projectPermissionAllows(existing, 'write') ? existing.role : role;
  const nextPermissions = permissions || existing?.permissionsJson && parseJson(existing.permissionsJson, null) || rolePermissions(nextRole);
  return delegate.upsert({
    where: { projectId_userId: { projectId, userId } },
    update: {
      workspaceSlug,
      role: nextRole,
      source: existing?.source || source,
      permissionsJson: stringifyJson(nextPermissions),
      redactionPolicyJson: redactionPolicy == null ? existing?.redactionPolicyJson || null : stringifyJson(redactionPolicy),
      participationStatus: participationStatus || existing?.participationStatus || 'enabled',
      revokedAt: null,
    },
    create: {
      projectId,
      workspaceSlug,
      userId,
      role,
      permissionsJson: stringifyJson(permissions || rolePermissions(role)),
      redactionPolicyJson: redactionPolicy == null ? null : stringifyJson(redactionPolicy),
      participationStatus: participationStatus || 'enabled',
      source,
      createdByUserId,
    },
  }).catch(() => null);
}

async function upsertMissionProjectMembers({ projectId, workspaceSlug, missions = [], createdByUserId = null }) {
  const ownerIds = unique(asArray(missions).flatMap((mission) => [
    mission?.ownerUserId,
    mission?.owner_user_id,
    mission?.userId,
    mission?.user_id,
  ]).filter(Boolean));
  await Promise.all(ownerIds.map((userId) => upsertProjectMember({
    projectId,
    workspaceSlug,
    userId,
    role: 'agent',
    source: 'mission_owner',
    createdByUserId,
  })));
}

export async function listProjectMembers(workspaceSlug, projectId, actor = null) {
  const project = await requireProject(workspaceSlug, projectId, actor, 'read');
  const delegate = projectMembershipDelegate();
  const members = delegate
    ? await delegate.findMany({ where: { projectId: project.id }, orderBy: [{ revokedAt: 'asc' }, { createdAt: 'asc' }] }).catch(() => [])
    : [];
  return members.map(projectMembershipProjection);
}

export async function revokeProjectMember(workspaceSlug, projectId, userId, body = {}, actor = null) {
  const project = await requireProject(workspaceSlug, projectId, actor, 'members:manage');
  const delegate = projectMembershipDelegate();
  if (!delegate) throw badRequest('codesite_project_membership_unavailable');
  const member = await delegate.findUnique({ where: { projectId_userId: { projectId: project.id, userId } } });
  if (!member) throw notFound('codesite_project_member_not_found');
  if (member.userId === project.createdByUserId && member.role === 'owner') {
    throw badRequest('codesite_project_owner_revoke_forbidden');
  }
  const updated = await delegate.update({
    where: { projectId_userId: { projectId: project.id, userId } },
    data: {
      revokedAt: new Date(),
      participationStatus: 'disabled',
      source: body.reason ? `revoked:${String(body.reason).slice(0, 80)}` : 'revoked',
    },
  });
  await recordEvent(project.id, {
    eventType: 'tower_instruction',
    actorType: 'human',
    actorId: actorUserId(actor),
    details: {
      type: 'project_member_revoked',
      userId,
      reason: body.reason || null,
    },
  });
  return projectMembershipProjection(updated);
}

function projectHasLegacyActorAccess(project, actor = null, mode = 'read') {
  const userId = actorUserId(actor);
  if (!userId) return false;
  if (project.createdByUserId && project.createdByUserId === userId) return true;
  if (mode === 'read') {
    return asArray(project.agentSessions).some((session) => session.ownerUserId === userId);
  }
  return false;
}

async function actorCanAccessProject(project, actor = null, mode = 'read') {
  if (!actor || actor.bypass) return true;
  const userId = actorUserId(actor);
  if (!userId) return false;
  if (projectHasLegacyActorAccess(project, actor, mode)) return true;
  const embedded = asArray(project.members).find((member) => member.userId === userId);
  if (projectPermissionAllows(embedded, mode)) return true;
  const delegate = projectMembershipDelegate();
  if (!delegate || !project?.id) return false;
  const member = await delegate.findFirst({
    where: {
      projectId: project.id,
      userId,
    },
  }).catch(() => null);
  return projectPermissionAllows(member, mode);
}

async function requireProjectAccess(project, actor = null, mode = 'read') {
  if (await actorCanAccessProject(project, actor, mode)) return project;
  throw forbidden(mode === 'write' ? 'codesite_project_write_forbidden' : 'codesite_project_not_found', {
    projectId: project?.id || null,
    actorUserId: actorUserId(actor),
  });
}

export async function listProjects(workspaceSlug, actor = null) {
  const projects = await prisma.codeSiteProject.findMany({
    where: { workspaceSlug },
    orderBy: { updatedAt: 'desc' },
    include: {
      members: true,
      agentSessions: true,
      executionPlans: true,
      mutationLeases: true,
      incidents: true,
      inspectionRuns: true,
    },
  });
  const visible = [];
  for (const project of projects) {
    if (await actorCanAccessProject(project, actor, 'read')) {
      visible.push(project);
    }
  }
  return visible.map(projectSummary);
}

export async function createProject(workspaceSlug, actor, body = {}) {
  const title = String(body.title || body.request || 'CodeSite project').trim();
  const request = String(body.request || title).trim();
  // Coordination mode (docs/CHANNEL_MODES_TRADEOFFS.md): validated against the
  // ladder and any workspace floor at creation time â€” fail closed.
  const requestedMode = String(body.channelMode || body.channel_mode || 'registered_direct').trim().toLowerCase();
  const modeCheck = effectiveChannelMode(requestedMode);
  if (!modeCheck.ok) throw badRequest(modeCheck.reasonCode, modeCheck.detail);
  const zonePolicy = compileProjectZonePolicy(body.zonePolicy || body.zone_policy || {}, body);
  const controlPlan = buildInitialControlPlan({ title, request, body, zonePolicy });

  const project = await prisma.codeSiteProject.create({
    data: {
      workspaceSlug,
      title,
      request,
      status: 'active',
      channelMode: modeCheck.mode,
      zonePolicyJson: stringifyJson(zonePolicy),
      controlPlanJson: stringifyJson(controlPlan),
      createdByUserId: actor?.userId || null,
    },
  });
  await upsertProjectMember({
    projectId: project.id,
    workspaceSlug,
    userId: actor?.userId,
    role: 'owner',
    source: 'project_creator',
    createdByUserId: actor?.userId || null,
  });
  await upsertMissionProjectMembers({
    projectId: project.id,
    workspaceSlug,
    missions: asArray(controlPlan.missions),
    createdByUserId: actor?.userId || null,
  });

  await upsertMutationZones(workspaceSlug, zonePolicy);
  const workflowBootstrap = await bootstrapAutomaticWorkflow({
    project,
    actor,
    zonePolicy,
    controlPlan,
    body,
  });
  if (workflowBootstrap.enabled) {
    await prisma.codeSiteProject.update({
      where: { id: project.id },
      data: {
        controlPlanJson: stringifyJson({
          ...controlPlan,
          towerState: 'preflight',
          selectedStrategy: workflowBootstrap.selectedStrategy,
          missions: workflowBootstrap.missions,
          routeIntersections: workflowBootstrap.forecast.risks,
          automaticWorkflow: {
            enabled: true,
            agentSessionIds: workflowBootstrap.agentSessions.map((session) => session.id),
            executionPlanIds: workflowBootstrap.executionPlans.map((plan) => plan.id),
            collisionForecast: workflowBootstrap.forecast,
            operational: workflowBootstrap.operational,
            summary: workflowBootstrap.summary,
          },
        }),
      },
    });
  }
  await recordEvent(project.id, {
    eventType: 'tower_instruction',
    actorType: 'human',
    actorId: actor?.userId || null,
    details: {
      instruction: workflowBootstrap.enabled
        ? `Tower filed ${workflowBootstrap.executionPlans.length} initial flight plans.`
        : 'CodeSite project opened. File flight plans before mutation.',
      controlPlan,
      automaticWorkflow: workflowBootstrap.enabled ? workflowBootstrap.summary : null,
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

async function bootstrapAutomaticWorkflow({ project, actor, zonePolicy, controlPlan, body = {} }) {
  const enabled = body.autoWorkflow === true
    || body.auto_workflow === true
    || body.automaticWorkflow === true
    || body.automatic_workflow === true
    || body.towerAutoPlan === true
    || body.tower_auto_plan === true;
  if (!enabled) {
    return {
      enabled: false,
      missions: asArray(controlPlan.missions),
      forecast: { riskLevel: 'low', risks: [] },
      selectedStrategy: controlPlan.selectedStrategy,
      agentSessions: [],
      executionPlans: [],
      summary: null,
    };
  }

  const missions = normalizeAutomaticMissions(controlPlan.missions, zonePolicy, project.request);
  const pseudoPlans = missions.map((mission) => ({
    id: mission.key,
    displayCallsign: mission.callsign,
    route: mission.route,
  }));
  const forecast = predictCollisions({ executionPlans: pseudoPlans, leases: [], zonePolicy });
  const selectedStrategy = selectTowerStrategy(forecast, missions, body.strategy || controlPlan.selectedStrategy);
  const agentSessions = [];
  const executionPlans = [];
  for (let index = 0; index < missions.length; index += 1) {
    const mission = missions[index];
    const status = planStatusForAutomaticMission(mission, index, selectedStrategy, forecast);
    const session = await prisma.codeSiteAgentSession.create({
      data: {
        projectId: project.id,
        ownerUserId: mission.ownerUserId || actor?.userId || 'codesite-tower',
        agentProvider: mission.agentProvider || 'codex',
        agentRuntime: mission.agentRuntime || 'tower-auto-plan',
        providerSessionRef: null,
        displayCallsign: mission.callsign,
        status: 'registered',
        permissionsJson: stringifyJson(['codesite:mutation', 'codesite:inbox']),
        redactionPolicyJson: stringifyJson(defaultRedactionPolicy()),
        dojoPilotLicenseRef: firstCodeSiteRef(mission.dojoPilotLicenseRef, mission.dojo_license_ref),
        dojoProofRef: firstCodeSiteRef(mission.dojoProofRef, mission.dojo_proof_ref),
        dojoEvidenceRefsJson: codeSiteEvidenceRefsJson(mission.dojoEvidenceRefs || mission.dojo_evidence_refs),
        dojoDecisionDigest: firstCodeSiteRef(mission.dojoDecisionDigest, mission.dojo_decision_digest),
        pilotLicenseSnapshotJson: stringifyJson(mission.pilotLicenseSnapshot || mission.pilot_license_snapshot || null),
      },
    });
    agentSessions.push(session);
    await upsertProjectMember({
      projectId: project.id,
      workspaceSlug: project.workspaceSlug,
      userId: session.ownerUserId,
      role: 'agent',
      source: 'automatic_agent_session',
      createdByUserId: actor?.userId || null,
    });
    await recordEvent(project.id, {
      eventType: 'transponder_update',
      displayCallsign: session.displayCallsign,
      actorType: 'agent_session',
      actorId: session.id,
      details: {
        status: session.status,
        provider: session.agentProvider,
        runtime: session.agentRuntime,
        instruction: `${session.displayCallsign} registered by tower automatic workflow.`,
      },
    });
    const plan = await prisma.codeSiteExecutionPlan.create({
      data: {
        projectId: project.id,
        agentSessionId: session.id,
        displayCallsign: mission.callsign,
        mission: mission.mission,
        domain: mission.domain,
        status,
        routeJson: stringifyJson(mission.route),
        blockedZonesJson: stringifyJson(mission.blockedZones),
        abortJson: stringifyJson(mission.abortConditions),
        requestedToolsJson: stringifyJson(mission.requestedTools),
        estimatedDurationMs: mission.estimatedDurationMs,
      },
    });
    executionPlans.push(plan);
    await recordEvent(project.id, {
      eventType: 'flight_plan_filed',
      displayCallsign: plan.displayCallsign,
      actorType: 'agent_session',
      actorId: session.id,
      details: {
        executionPlanId: plan.id,
        mission: plan.mission,
        route: mission.route,
        status,
        automaticWorkflow: true,
        towerInstruction: status === 'holding'
          ? 'Hold position until schema-first route lands and assumptions refresh.'
          : 'Proceed to preflight and request clearance.',
      },
    });
  }
  const operational = await bootstrapAutomaticWorkflowOperations({
    project,
    actor,
    missions,
    agentSessions,
    executionPlans,
    zonePolicy,
    body,
  });
  return {
    enabled: true,
    missions,
    forecast,
    selectedStrategy,
    agentSessions,
    executionPlans,
    operational,
    summary: {
      selectedStrategy,
      riskLevel: forecast.riskLevel,
      missionCount: missions.length,
      heldFlights: executionPlans.filter((plan) => plan.status === 'holding').map((plan) => plan.displayCallsign),
      clearances: operational.clearances.length,
      transactions: operational.transactions.length,
      inspections: operational.inspections.length,
      proofBundles: operational.proofBundles.length,
      skippedFlights: operational.skipped,
    },
  };
}

async function bootstrapAutomaticWorkflowOperations({
  project,
  actor,
  missions,
  agentSessions,
  executionPlans,
  zonePolicy,
  body = {},
}) {
  const enabled = body.autoWorkflowOperations !== false
    && body.auto_workflow_operations !== false
    && body.operationalBootstrap !== false
    && body.operational_bootstrap !== false;
  const result = {
    enabled,
    clearances: [],
    transactions: [],
    inspections: [],
    proofBundles: [],
    skipped: [],
  };
  if (!enabled) return result;

  const evidenceByCallsign = automaticWorkflowEvidenceByCallsign(body);
  for (let index = 0; index < executionPlans.length; index += 1) {
    const plan = executionPlans[index];
    const mission = missions[index] || {};
    const session = agentSessions[index];
    if (!automaticWorkflowPlanReadyForOperations(plan)) {
      result.skipped.push({
        displayCallsign: plan.displayCallsign,
        reason: 'flight_not_ready_for_clearance',
        status: plan.status,
      });
      continue;
    }
    const actorForSession = { ...(actor || {}), userId: session?.ownerUserId || actor?.userId || 'codesite-tower' };
    const planWithContext = { ...plan, project, agentSession: session };
    const evidence = evidenceByCallsign.get(plan.displayCallsign) || {};
    const lease = await requestMutationLeaseForPlan(project.workspaceSlug, planWithContext, {
      allowedPaths: mission.route,
      blockedPaths: mission.blockedZones,
      allowedTools: mission.requestedTools,
      requiredRadar: evidence.requiredRadar || evidence.required_radar || automaticWorkflowRequiredRadar(mission.route, zonePolicy),
      invariants: evidence.invariants || automaticWorkflowInvariants(mission.route, zonePolicy),
      dojoProofRef: mission.dojoProofRef,
      dojoLicenseRef: mission.dojoPilotLicenseRef,
      dojoEvidenceRefs: mission.dojoEvidenceRefs,
      dojoDecisionDigest: mission.dojoDecisionDigest,
      dojoImplementationStatus: mission.pilotLicenseSnapshot?.implementationStatus,
    }, actorForSession);
    result.clearances.push({ id: lease.id, status: lease.status, displayCallsign: lease.displayCallsign });
    if (lease.status !== 'active') {
      result.skipped.push({
        displayCallsign: lease.displayCallsign,
        reason: 'clearance_not_active',
        status: lease.status,
      });
      continue;
    }

    const writeSet = normalizePathList(evidence.writeSet || evidence.write_set || evidence.changedPaths || evidence.changed_paths || []);
    const transaction = await createMutationTransactionForLease(project.workspaceSlug, {
      ...lease,
      project,
      agentSession: session,
      leaseJson: stringifyJson(lease.lease || {}),
    }, {
      readSet: normalizePathList(evidence.readSet || evidence.read_set || []),
      writeSet,
      semanticDependencyRefs: evidence.semanticDependencyRefs || evidence.semantic_dependency_refs || [],
      invariants: evidence.invariants || lease.lease?.invariants || [],
      assumptionRefs: evidence.assumptionRefs || evidence.assumption_refs || [],
      baseSnapshot: evidence.baseSnapshot || evidence.base_snapshot || null,
      baseSnapshotEvidence: evidence.baseSnapshotEvidence || evidence.base_snapshot_evidence || null,
      skipRepoSnapshot: evidence.skipRepoSnapshot ?? evidence.skip_repo_snapshot ?? writeSet.length === 0,
    });
    result.transactions.push({ id: transaction.id, status: transaction.status, displayCallsign: lease.displayCallsign });

    const inspection = await createAutomaticWorkflowInspection({
      project,
      plan,
      lease,
      transaction,
      evidence,
      writeSet,
      zonePolicy,
    });
    result.inspections.push({ id: inspection.id, status: inspection.status, displayCallsign: inspection.displayCallsign });

    if (writeSet.length === 0) {
      const closeout = await closeAutomaticNoopTransaction({
        project,
        lease,
        transaction,
        inspection,
        evidence,
      });
      result.proofBundles.push(closeout.proofBundle);
      continue;
    }

    const landingEvidence = automaticWorkflowLandingEvidence({
      evidence,
      writeSet,
      lease,
      transaction,
    });
    if (!landingEvidence.ok) {
      result.skipped.push({
        displayCallsign: lease.displayCallsign,
        transactionId: transaction.id,
        reason: 'write_evidence_requires_agent_landing',
        writeSet,
        missingEvidence: landingEvidence.missingEvidence,
        missingInspectionSignals: landingEvidence.missingInspectionSignals,
      });
      continue;
    }

    for (const write of landingEvidence.writes) {
      await recordTransactionWrite(project.workspaceSlug, transaction.id, write, actorForSession);
    }
    const committed = await commitTransaction(project.workspaceSlug, transaction.id, {
      repoState: landingEvidence.repoState,
      commitSha: evidence.commitSha || evidence.commit_sha || null,
      evidenceRefs: landingEvidence.commitEvidenceRefs,
    }, actorForSession);
    if (!committed?.proofBundle) {
      result.skipped.push({
        displayCallsign: lease.displayCallsign,
        transactionId: transaction.id,
        reason: 'write_landing_blocked',
        decision: committed?.decision || committed?.transaction?.commitDecision || null,
      });
      result.transactions[result.transactions.length - 1] = {
        id: committed?.transaction?.id || transaction.id,
        status: committed?.transaction?.status || 'blocked',
        displayCallsign: lease.displayCallsign,
      };
      continue;
    }
    result.proofBundles.push(committed.proofBundle);
    result.transactions[result.transactions.length - 1] = {
      id: committed.transaction.id,
      status: committed.transaction.status,
      displayCallsign: lease.displayCallsign,
      proofBundleDigest: committed.transaction.proofBundleDigest,
    };
  }
  return result;
}

function automaticWorkflowPlanReadyForOperations(plan = {}) {
  return ['preflight', 'filed', 'active'].includes(String(plan.status || '').toLowerCase());
}

function automaticWorkflowEvidenceByCallsign(body = {}) {
  const entries = [
    ...asArray(body.autoWorkflowEvidence || body.auto_workflow_evidence || body.workflowEvidence || body.workflow_evidence),
    ...Object.entries(body.autoWorkflowEvidenceByCallsign || body.auto_workflow_evidence_by_callsign || {})
      .map(([callsign, evidence]) => ({ displayCallsign: callsign, ...(evidence || {}) })),
  ];
  return new Map(entries
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => [String(entry.displayCallsign || entry.callsign || '').toUpperCase(), entry])
    .filter(([callsign]) => callsign));
}

function automaticWorkflowRequiredRadar(route, zonePolicy) {
  return unique([...defaultRadarForRoute(route, zonePolicy), 'handover']);
}

function automaticWorkflowInvariants(route, zonePolicy) {
  return unique([...defaultInvariantsForRoute(route, zonePolicy), 'handover.packet.complete']);
}

function automaticWorkflowLandingEvidence({
  evidence = {},
  writeSet = [],
  lease,
  transaction,
}) {
  const writes = automaticWorkflowWriteEvidence(evidence, writeSet);
  const repoState = normalizeRepoStateEvidence(evidence.repoState || evidence.repo_state);
  const requiredSignals = unique(asArray(lease.lease?.requiredRadar)
    .map(canonicalInspectionSignal)
    .filter(Boolean));
  const inspectionSignals = automaticWorkflowExplicitInspectionSignals(evidence);
  const missingWriteEvidence = writeSet.filter((path) => !writes.some((write) => normalizePath(write.path) === path));
  const missingInspectionSignals = requiredSignals.filter((signal) => (
    !inspectionSignals.some((inspectionSignal) =>
      canonicalInspectionSignal(signalKey(inspectionSignal)) === signal
      && signalEvidenceRefs(inspectionSignal).some(isDurableInspectionEvidenceRef))
  ));
  const missingEvidence = [
    ...(missingWriteEvidence.length ? ['write_line_provenance'] : []),
    ...(!repoState ? ['repo_state'] : []),
    ...(missingInspectionSignals.length ? ['landing_inspection_signals'] : []),
  ];
  return {
    ok: missingEvidence.length === 0,
    writes,
    repoState,
    inspectionSignals,
    missingEvidence: unique(missingEvidence),
    missingInspectionSignals,
    commitEvidenceRefs: unique([
      ...asArray(evidence.evidenceRefs || evidence.evidence_refs),
      ...asArray(evidence.commitEvidenceRefs || evidence.commit_evidence_refs),
      ...inspectionSignals.flatMap(signalEvidenceRefs),
      `codesite:transaction:${transaction.id}`,
    ]),
  };
}

function automaticWorkflowWriteEvidence(evidence = {}, writeSet = []) {
  const entries = asArray(
    evidence.writes
    || evidence.writeEvidence
    || evidence.write_evidence
    || evidence.writeEvents
    || evidence.write_events,
  ).filter((entry) => entry && typeof entry === 'object');
  const byPath = new Map(entries
    .map((entry) => [normalizePath(entry.path || entry.filePath || entry.file_path), entry])
    .filter(([path]) => path));
  return writeSet
    .map((path) => {
      const entry = byPath.get(path);
      if (!entry) return null;
      const lineProvenance = strictLineProvenanceRows(
        entry.lineProvenance || entry.line_provenance,
        path,
      );
      const changedLineRanges = strictLineProvenanceRows(
        entry.changedLineRanges || entry.changed_line_ranges || entry.diffLineRanges || entry.diff_line_ranges,
        path,
      );
      const evidenceRefs = unique([
        ...asArray(entry.evidenceRefs || entry.evidence_refs),
        ...lineProvenance.flatMap((row) => asArray(row.evidenceRefs)),
      ]);
      if (!lineProvenance.length || !evidenceRefs.some(isDurableInspectionEvidenceRef)) return null;
      return {
        path,
        tool: entry.tool || 'file_write',
        evidenceRefs,
        lineProvenance,
        changedLineRanges: changedLineRanges.length ? changedLineRanges : lineProvenance,
        processAncestry: entry.processAncestry || entry.process_ancestry || [],
        semanticDependencyRefs: entry.semanticDependencyRefs || entry.semantic_dependency_refs || [],
      };
    })
    .filter(Boolean);
}

function automaticWorkflowExplicitInspectionSignals(evidence = {}) {
  return asArray(
    evidence.inspectionSignals
    || evidence.inspection_signals
    || evidence.radarResults
    || evidence.radar_results
    || evidence.landingSignals
    || evidence.landing_signals,
  )
    .map(normalizeInspectionSignalPayload)
    .filter(Boolean);
}

async function createAutomaticWorkflowInspection({
  project,
  plan,
  lease,
  transaction,
  evidence = {},
  writeSet = [],
  zonePolicy,
}) {
  const requiredSignals = unique(asArray(lease.lease?.requiredRadar || automaticWorkflowRequiredRadar(plan.route, zonePolicy))
    .map(canonicalInspectionSignal)
    .filter(Boolean));
  const evidenceRefs = unique([
    ...asArray(evidence.evidenceRefs || evidence.evidence_refs),
    ...automaticWorkflowExplicitInspectionSignals(evidence).flatMap(signalEvidenceRefs),
    `clearance:run:${lease.id}`,
    `handover:packet:${transaction.id}`,
  ]);
  const explicitSignals = automaticWorkflowExplicitInspectionSignals(evidence);
  const signals = requiredSignals.map((signal) => {
    const explicit = explicitSignals.find((item) => canonicalInspectionSignal(signalKey(item)) === signal);
    if (explicit) return explicit;
    return {
      key: signal,
      status: writeSet.length ? 'requested' : 'passed',
      evidenceRefs,
    };
  });
  const missingWriteEvidence = writeSet.length > 0
    && signals.some((signal) => !signalEvidenceRefs(signal).some(isDurableInspectionEvidenceRef));
  const run = await prisma.codeSiteInspectionRun.create({
    data: {
      projectId: project.id,
      executionPlanId: plan.id,
      displayCallsign: lease.displayCallsign,
      status: missingWriteEvidence ? 'requested' : 'completed',
      changedPathsJson: stringifyJson(writeSet),
      inspectionSignalsJson: stringifyJson(signals),
      evidenceRefsJson: stringifyJson(evidenceRefs),
      completedAt: missingWriteEvidence ? null : new Date(),
    },
  });
  await recordEvent(project.id, {
    mutationLeaseId: lease.id,
    eventType: 'landing_requested',
    displayCallsign: lease.displayCallsign,
    actorType: 'inspection',
    actorId: run.id,
    evidenceRefs,
    details: {
      inspectionRunId: run.id,
      transactionId: transaction.id,
      automaticWorkflow: true,
      changedPaths: writeSet,
      inspectionEvidenceRefs: evidenceRefs,
    },
  });
  await recordEvent(project.id, {
    mutationLeaseId: lease.id,
    eventType: 'inspection_result',
    displayCallsign: lease.displayCallsign,
    actorType: 'inspection',
    actorId: run.id,
    evidenceRefs,
    details: {
      inspectionRunId: run.id,
      transactionId: transaction.id,
      status: run.status,
      signals,
      changedPaths: writeSet,
      inspectionEvidenceRefs: evidenceRefs,
      automaticWorkflow: true,
    },
  });
  return run;
}

async function closeAutomaticNoopTransaction({
  project,
  lease,
  transaction,
  inspection,
  evidence = {},
}) {
  const transactionWithContext = {
    ...transaction,
    project,
    mutationLease: {
      ...lease,
      leaseJson: stringifyJson(lease.lease || {}),
    },
  };
  const inspectionEvidenceRefs = inspectionEvidenceRefsFromRun(inspection);
  const proofBundle = await createProofBundleForTransaction(transactionWithContext, {
    commitSha: evidence.commitSha || evidence.commit_sha || null,
    evidenceRefs: unique([
      ...asArray(evidence.evidenceRefs || evidence.evidence_refs),
      ...inspectionEvidenceRefs,
      `handover:packet:${transaction.id}`,
    ]),
    inspectionEvidenceRefs,
    inspectionRunRefs: [inspection.id],
    landingStatus: 'landed-noop',
  });
  const committedAt = new Date();
  const updated = await prisma.codeSiteMutationTransaction.update({
    where: { id: transaction.id },
    data: {
      status: 'committed',
      proofBundleDigest: proofBundle.bundleDigest,
      commitDecisionJson: stringifyJson({
        ok: true,
        isolation: transaction.isolation,
        reasonCodes: ['automatic_workflow_noop_closeout', 'serializable_commit_landed'],
        committedAt: committedAt.toISOString(),
      }),
      closedAt: committedAt,
    },
  });
  const commitEvent = await recordEvent(project.id, {
    mutationLeaseId: lease.id,
    eventType: 'transaction_committed',
    displayCallsign: lease.displayCallsign,
    actorType: 'transaction',
    actorId: transaction.id,
    evidenceRefs: proofBundleEvidenceRefs(proofBundle),
    details: {
      transactionId: transaction.id,
      proofBundleId: proofBundle.id,
      proofBundleDigest: proofBundle.bundleDigest,
      writeSet: [],
      inspectionRunIds: [inspection.id],
      inspectionEvidenceRefs,
      automaticWorkflow: true,
      noCodeMutation: true,
    },
  });
  const closeout = await closeTransactionBlackBox(project.workspaceSlug, {
    ...transactionWithContext,
    status: updated.status,
    proofBundleDigest: proofBundle.bundleDigest,
    closedAt: updated.closedAt,
  }, {
    body: {
      reason: 'automatic_workflow_noop_closeout',
      handover: {
        status: 'completed',
        proofBundleId: proofBundle.id,
        proofBundleDigest: proofBundle.bundleDigest,
      },
    },
    bundle: proofBundle,
    terminalEvent: commitEvent,
    validationDecision: {
      ok: true,
      reasonCodes: ['automatic_workflow_noop_closeout'],
    },
    inspectionDecision: {
      ok: true,
      reasonCodes: ['landing_inspection_passed'],
      inspectionRuns: [inspection],
      evidenceRefs: inspectionEvidenceRefs,
    },
    landingStatus: 'landed-noop',
  });
  return {
    transaction: updated,
    proofBundle: proofBundleProjection(closeout?.proofBundle || proofBundle, {
      transaction: transactionWithContext,
      mutationLease: transactionWithContext.mutationLease,
      landingRuns: [inspection],
      portableProofBundle: closeout?.portableProofBundle || null,
    }),
  };
}

function inspectionEvidenceRefsFromRun(run) {
  return unique([
    ...asArray(parseJson(run.evidenceRefsJson, [])),
    ...asArray(parseJson(run.inspectionSignalsJson, [])).flatMap((signal) =>
      asArray(signal?.evidenceRefs || signal?.evidence_refs)),
    `codesite:inspection:${run.id}`,
  ]);
}

function normalizeAutomaticMissions(inputMissions, zonePolicy, request) {
  const explicit = asArray(inputMissions);
  const missions = explicit.length ? explicit : inferMissionsFromAirspace(zonePolicy, request);
  return missions.map((mission, index) => normalizeAutomaticMission(mission, index));
}

function inferMissionsFromAirspace(zonePolicy, request) {
  const zones = asArray(zonePolicy?.zones);
  const authoredZones = zones.filter((zone) => zone?.source !== 'compiled_default');
  const candidateZones = authoredZones.length ? authoredZones : zones;
  const sorted = candidateZones
    .filter((zone) => asArray(zone.paths).length > 0)
    .sort((left, right) => zonePriority(left) - zonePriority(right));
  const inferred = [];
  for (const zone of sorted) {
    const domain = domainForZone(zone);
    if (inferred.some((mission) => mission.domain === domain)) continue;
    inferred.push({
      mission: missionTitleForDomain(domain, request),
      domain,
      callsign: callsignForDomain(domain, inferred.length),
      route: asArray(zone.paths),
      requestedTools: domain === 'inspection' ? ['read_file', 'npm_test'] : ['file_write', 'npm_test'],
      abortConditions: ['shared contract changed', 'required radar failed'],
    });
    if (inferred.length >= 4) break;
  }
  if (inferred.length) return inferred;
  return [{
    mission: `Coordinate ${request || 'requested work'}`,
    domain: 'implementation',
    callsign: 'CODEX-01',
    route: ['docs/**'],
    requestedTools: ['file_write'],
    abortConditions: ['required radar failed'],
  }];
}

function normalizeAutomaticMission(mission, index) {
  const domain = String(mission.domain || mission.altitude || domainForRoute(mission.route) || 'implementation').toLowerCase();
  const route = pathsForRoute(mission.route || mission.allowedPaths || mission.allowed_paths || ['docs/**']);
  return {
    key: mission.key || mission.id || `mission-${index + 1}`,
    mission: String(mission.mission || mission.title || mission.request || missionTitleForDomain(domain)).trim(),
    domain,
    callsign: String(mission.displayCallsign || mission.callsign || callsignForDomain(domain, index)).toUpperCase(),
    route,
    blockedZones: pathsForRoute(mission.blockedZones || mission.noFlyZones || mission.no_fly_zones || []),
    requestedTools: asArray(mission.requestedTools || mission.requested_tools || ['file_write', 'npm_test']),
    abortConditions: asArray(mission.abortConditions || mission.abort_conditions || ['required radar failed']),
    estimatedDurationMs: normalizeDurationMs(mission.estimatedDurationMs || mission.estimated_duration_ms || mission.estimatedDuration),
    agentProvider: mission.agentProvider || mission.provider || 'codex',
    agentRuntime: mission.agentRuntime || mission.runtime || 'tower-auto-plan',
    ownerUserId: mission.ownerUserId || mission.owner_user_id || null,
    dojoPilotLicenseRef: firstCodeSiteRef(mission.dojoPilotLicenseRef, mission.dojo_pilot_license_ref, mission.dojoLicenseRef, mission.dojo_license_ref),
    dojoProofRef: firstCodeSiteRef(mission.dojoProofRef, mission.dojo_proof_ref),
    dojoEvidenceRefs: asArray(mission.dojoEvidenceRefs || mission.dojo_evidence_refs || mission.evidenceRefs || mission.evidence_refs),
    dojoDecisionDigest: firstCodeSiteRef(mission.dojoDecisionDigest, mission.dojo_decision_digest),
    pilotLicenseSnapshot: mission.pilotLicenseSnapshot || mission.pilot_license_snapshot || null,
  };
}

function zonePriority(zone) {
  const klass = String(zone?.class || '').toUpperCase();
  const rank = { A: 0, B: 1, C: 2, D: 3 }[klass] ?? 4;
  return rank;
}

function domainForZone(zone) {
  const haystack = `${zone?.zoneKey || ''} ${zone?.label || ''} ${asArray(zone?.paths).join(' ')}`.toLowerCase();
  if (/schema|openapi|contract|prisma|migration|package|export/.test(haystack)) return 'schema';
  if (/test|spec|e2e|playwright|vitest/.test(haystack)) return 'inspection';
  if (/web|ui|frontend|component|app/.test(haystack)) return 'frontend';
  if (/api|auth|billing|backend|server/.test(haystack)) return 'backend';
  if (/infra|deploy|k8s|terraform/.test(haystack)) return 'infra';
  return 'implementation';
}

function domainForRoute(route = []) {
  return domainForZone({ paths: route });
}

function callsignForDomain(domain, index) {
  const prefixes = {
    schema: 'SCHEMA',
    backend: 'API',
    frontend: 'UI',
    inspection: 'TEST',
    infra: 'INFRA',
    implementation: 'CODEX',
  };
  return `${prefixes[domain] || 'CODEX'}-${String(index + 1).padStart(2, '0')}`;
}

function missionTitleForDomain(domain, request = 'requested work') {
  const titles = {
    schema: `Stabilize shared contract for ${request}`,
    backend: `Implement backend route for ${request}`,
    frontend: `Implement frontend flow for ${request}`,
    inspection: `Run landing radar for ${request}`,
    infra: `Prepare infrastructure changes for ${request}`,
    implementation: `Implement ${request}`,
  };
  return titles[domain] || titles.implementation;
}

function selectTowerStrategy(forecast, missions, requestedStrategy) {
  if (requestedStrategy && requestedStrategy !== 'airspace_survey_first') return requestedStrategy;
  if (forecast.riskLevel === 'high' && missions.some((mission) => mission.domain === 'schema')) return 'schema-first';
  if (missions.some((mission) => mission.domain === 'inspection')) return 'test-first';
  return 'parallel-with-clearances';
}

function planStatusForAutomaticMission(mission, index, selectedStrategy, forecast) {
  if (selectedStrategy === 'schema-first' && mission.domain !== 'schema' && forecast.riskLevel === 'high') return 'holding';
  return index === 0 ? 'preflight' : 'filed';
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

export async function getProject(workspaceSlug, projectId, actor = null) {
  const project = await prisma.codeSiteProject.findFirst({
    where: { id: projectId, workspaceSlug },
    include: PROJECT_INCLUDE,
  });
  if (!project) return null;
  await requireProjectAccess(project, actor, 'read');
  return projectProjection(project);
}

export async function updateZonePolicy(workspaceSlug, projectId, body = {}, actor = null) {
  const project = await requireProject(workspaceSlug, projectId, actor, 'write');
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
  return getProject(workspaceSlug, project.id, actor);
}

function compileProjectZonePolicy(input = {}, body = {}) {
  const requested = input || {};
  const previousCompiler = requested.compiler || {};
  const repoRoot = body.repoRoot
    || body.repo_root
    || requested.repoRoot
    || requested.repo_root
    || previousCompiler.repoRoot
    || null;
  const repoSignals = requested.repoSignals
    || requested.repo_signals
    || body.repoSignals
    || body.repo_signals
    || (body.repoPolicyCompiler === false || body.repo_policy_compiler === false
      ? null
      : safeDiscoverRepoPolicySignals(repoRoot));
  const compiled = compileZonePolicy({
    ...requested,
    ...(repoSignals ? { repoSignals } : {}),
  });
  return attachRepoPolicyCompilerMetadata(compiled, {
    repoSignals,
    repoRoot,
    previousCompiler,
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
      repoRoot: root || null,
      compilerVersion: REPO_POLICY_COMPILER_VERSION,
      maxFiles: null,
      fileCount: 0,
      truncated: false,
      digest: digest({ source: 'repo_policy_compiler_error', root: root || null, error: error?.message || String(error) }),
    };
  }
}

function attachRepoPolicyCompilerMetadata(policy, { repoSignals, repoRoot, previousCompiler } = {}) {
  const sourceDigest = repoSignals?.digest || policy?.semanticGraph?.sourceDigest || previousCompiler?.sourceDigest || null;
  const resolvedRepoRoot = repoSignals?.repoRoot || repoRoot || previousCompiler?.repoRoot || null;
  const compilerVersion = repoSignals?.compilerVersion || previousCompiler?.compilerVersion || REPO_POLICY_COMPILER_VERSION;
  return {
    ...policy,
    compiler: {
      compilerVersion,
      repoRoot: resolvedRepoRoot,
      maxFiles: repoSignals?.maxFiles ?? previousCompiler?.maxFiles ?? null,
      sourceDigest,
      policyDigest: policy.policyDigest || digest({
        zones: policy.zones,
        noFlyZones: policy.noFlyZones,
        classRules: policy.classRules,
        semanticGraph: policy.semanticGraph,
        policySources: policy.policySources,
      }),
      compiledAt: new Date().toISOString(),
      fileCount: repoSignals
        ? (repoSignals.fileCount ?? asArray(repoSignals.files).length)
        : (previousCompiler?.fileCount ?? 0),
      truncated: Boolean(repoSignals?.truncated ?? previousCompiler?.truncated ?? false),
      source: repoSignals?.source || previousCompiler?.source || 'repo_policy_compiler',
      error: repoSignals?.error || null,
    },
  };
}

export async function updateControlPlan(workspaceSlug, projectId, body = {}, actor = null) {
  const project = await requireProject(workspaceSlug, projectId, actor, 'write');
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
  return getProject(workspaceSlug, project.id, actor);
}

export async function createAgentSession(workspaceSlug, projectId, actor, body = {}) {
  const project = await requireProject(workspaceSlug, projectId, actor, 'write');
  const callsign = String(body.displayCallsign || body.callsign || nextCallsign(body.agentProvider || 'AGENT')).toUpperCase();
  const requestedOwnerUserId = body.ownerUserId || body.owner_user_id || null;
  const ownerUserId = requestedOwnerUserId || actor?.userId || 'unknown';
  const permissions = body.permissions || body.toolList || body.tool_list || body.tools || [];
  requireActorOwnsUserId(ownerUserId, actor, 'agent_session_owner_forbidden');
  const session = await prisma.codeSiteAgentSession.create({
    data: {
      projectId: project.id,
      ownerUserId,
      agentProvider: String(body.agentProvider || body.provider || 'custom'),
      agentRuntime: body.agentRuntime || body.runtime || null,
      providerSessionRef: body.providerSessionRef || body.provider_session_ref || null,
      displayCallsign: callsign,
      status: body.status || 'registered',
      permissionsJson: stringifyJson(permissions),
      redactionPolicyJson: stringifyJson(body.redactionPolicy || body.redaction_policy || defaultRedactionPolicy()),
      dojoPilotLicenseRef: firstCodeSiteRef(body.dojoPilotLicenseRef, body.dojo_pilot_license_ref, body.dojoLicenseRef, body.dojo_license_ref),
      dojoProofRef: firstCodeSiteRef(body.dojoProofRef, body.dojo_proof_ref),
      dojoEvidenceRefsJson: codeSiteEvidenceRefsJson(body.dojoEvidenceRefs || body.dojo_evidence_refs || body.evidenceRefs || body.evidence_refs),
      dojoDecisionDigest: firstCodeSiteRef(body.dojoDecisionDigest, body.dojo_decision_digest),
      pilotLicenseSnapshotJson: stringifyJson(body.pilotLicenseSnapshot || body.pilot_license_snapshot || null),
    },
  });
  await upsertProjectMember({
    projectId: project.id,
    workspaceSlug,
    userId: ownerUserId,
    role: 'agent',
    source: 'agent_session_owner',
    createdByUserId: actor?.userId || null,
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
      permissions,
      instruction: `${callsign} registered with tower.`,
    },
  });
  return sessionProjection(session);
}

const AGENT_DELIVERY_CHANNEL_TYPES = new Set([
  'managed_sse',
  'mcp_poll',
  'repo_projection',
]);
const AGENT_ACCESS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const AGENT_CONTEXT_HEARTBEAT_MAX_AGE_MS = 5 * 60 * 1000;
const AGENT_CONTEXT_MAX_BYTES = 64 * 1024;

function agentAccessTokenHash(token) {
  return createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function mintAgentAccessToken(now = new Date()) {
  const token = `csa_${randomBytes(32).toString('base64url')}`;
  return {
    token,
    hash: agentAccessTokenHash(token),
    issuedAt: now,
    expiresAt: new Date(now.getTime() + AGENT_ACCESS_TOKEN_TTL_MS),
  };
}

function requiredAgentBinding(value, code, maxLength = 256) {
  const normalized = String(value || '').trim();
  if (!normalized) throw badRequest(code);
  if (normalized.length > maxLength) throw badRequest(`${code}_too_long`);
  return normalized;
}

function optionalAgentBinding(value, code, maxLength = 256) {
  if (value == null || value === '') return null;
  return requiredAgentBinding(value, code, maxLength);
}

function normalizedAgentProvider(value) {
  const provider = requiredAgentBinding(value, 'agent_provider_required', 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(provider)) throw badRequest('agent_provider_invalid');
  return provider;
}

function normalizedAgentStringList(value, code) {
  const list = unique(asArray(value).map((entry) => String(entry || '').trim()).filter(Boolean));
  if (list.length > 128 || list.some((entry) => entry.length > 256)) throw badRequest(code);
  return list;
}

function normalizedAgentDeliveryChannel(value = {}) {
  const channel = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const type = String(channel.type || 'mcp_poll').trim().toLowerCase();
  if (!AGENT_DELIVERY_CHANNEL_TYPES.has(type)) throw badRequest('agent_delivery_channel_invalid');
  if (channel.url || channel.endpoint || channel.callbackUrl || channel.callback_url) {
    throw badRequest('agent_delivery_external_endpoint_forbidden');
  }
  return {
    type,
    channelId: optionalAgentBinding(channel.channelId || channel.channel_id, 'agent_delivery_channel_id_invalid', 256),
  };
}

function normalizedAgentExecutionHost(value = {}) {
  const host = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    type: optionalAgentBinding(host.type, 'agent_execution_host_type_invalid', 64) || 'workspace_terminal',
    hostId: optionalAgentBinding(host.hostId || host.host_id, 'agent_execution_host_id_invalid', 256),
    platform: optionalAgentBinding(host.platform, 'agent_execution_host_platform_invalid', 64),
  };
}

function automaticAgentCallsign(provider, identity) {
  const prefix = String(provider || 'agent').replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase() || 'AGENT';
  const suffix = digest(identity).replace(/^sha256:/, '').slice(0, 6).toUpperCase();
  return `${prefix}-${suffix}`;
}

function agentAttachmentIdentity(body = {}) {
  const ownerUserId = requiredAgentBinding(body.ownerUserId || body.owner_user_id, 'agent_owner_required');
  const collaborationUserId = requiredAgentBinding(
    body.collaborationUserId || body.collaboration_user_id || body.workspaceUserId || body.workspace_user_id,
    'agent_collaboration_user_required',
  );
  const effectiveWorkspaceUserId = requiredAgentBinding(
    body.effectiveWorkspaceUserId || body.effective_workspace_user_id || body.filesystemUserId || body.filesystem_user_id,
    'agent_effective_workspace_user_required',
  );
  const collaborationSessionId = requiredAgentBinding(
    body.collaborationSessionId || body.collaboration_session_id,
    'agent_collaboration_session_required',
  );
  const terminalSessionId = optionalAgentBinding(
    body.terminalSessionId || body.terminal_session_id,
    'agent_terminal_session_invalid',
  );
  const runtimeSessionId = optionalAgentBinding(
    body.runtimeSessionId || body.runtime_session_id,
    'agent_runtime_session_invalid',
  );
  if (!terminalSessionId && !runtimeSessionId) throw badRequest('agent_terminal_or_runtime_session_required');
  const agentProvider = normalizedAgentProvider(body.agentProvider || body.agent_provider || body.provider);
  return {
    ownerUserId,
    collaborationUserId,
    effectiveWorkspaceUserId,
    collaborationSessionId,
    terminalSessionId,
    runtimeSessionId,
    runtimeScope: requiredAgentBinding(body.runtimeScope || body.runtime_scope, 'agent_runtime_scope_required'),
    agentProvider,
    providerSessionRef: requiredAgentBinding(
      body.providerSessionRef || body.provider_session_ref,
      'agent_provider_session_required',
    ),
    activeMutationLeaseId: optionalAgentBinding(
      body.activeMutationLeaseId || body.active_mutation_lease_id || body.mutationLeaseId || body.mutation_lease_id,
      'agent_mutation_lease_invalid',
    ),
    activeTransactionId: optionalAgentBinding(
      body.activeTransactionId || body.active_transaction_id || body.transactionId || body.transaction_id,
      'agent_transaction_invalid',
    ),
  };
}

function requireAgentAttachAuthority(authority, identity) {
  if (
    !authority?.internalService
    || authority.collaborationMembershipVerified !== true
    || authority.actorUserId !== identity.ownerUserId
    || authority.collaborationUserId !== identity.collaborationUserId
    || authority.effectiveWorkspaceUserId !== identity.effectiveWorkspaceUserId
    || authority.collaborationSessionId !== identity.collaborationSessionId
    || authority.runtimeScope !== identity.runtimeScope
  ) {
    throw forbidden('agent_attach_authority_forbidden');
  }
}

function assertAgentAttachmentMatch(session, identity) {
  const exact = [
    ['projectId', identity.projectId],
    ['workspaceSlug', identity.workspaceSlug],
    ['ownerUserId', identity.ownerUserId],
    ['collaborationUserId', identity.collaborationUserId],
    ['effectiveWorkspaceUserId', identity.effectiveWorkspaceUserId],
    ['collaborationSessionId', identity.collaborationSessionId],
    ['terminalSessionId', identity.terminalSessionId],
    ['runtimeSessionId', identity.runtimeSessionId],
    ['runtimeScope', identity.runtimeScope],
    ['agentProvider', identity.agentProvider],
    ['providerSessionRef', identity.providerSessionRef],
    ['activeMutationLeaseId', identity.activeMutationLeaseId],
    ['activeTransactionId', identity.activeTransactionId],
  ];
  const mismatches = exact
    .filter(([field, expected]) => (session?.[field] || null) !== (expected || null))
    .map(([field]) => field);
  if (mismatches.length) {
    throw forbidden('agent_session_resume_identity_mismatch', {
      agentSessionId: session?.id || null,
      mismatches,
    });
  }
}

function projectAgentMember(project, userId) {
  return asArray(project?.members).find((member) => member?.userId === userId) || null;
}

async function bindProjectCollaborationSession(project, identity) {
  if (project.collaborationSessionId && project.collaborationSessionId !== identity.collaborationSessionId) {
    throw forbidden('agent_project_collaboration_mismatch');
  }
  const existingMember = projectAgentMember(project, identity.ownerUserId);
  if (existingMember && !projectPermissionAllows(existingMember, 'read')) {
    throw forbidden('agent_project_membership_revoked');
  }
  if (project.collaborationSessionId) return project;

  const mayEstablishBinding = project.createdByUserId === identity.ownerUserId
    || Boolean(existingMember && ['owner', 'admin'].includes(String(existingMember.role || '').toLowerCase()));
  if (!mayEstablishBinding) throw forbidden('agent_project_collaboration_binding_forbidden');

  const result = await prisma.codeSiteProject.updateMany({
    where: { id: project.id, collaborationSessionId: null },
    data: { collaborationSessionId: identity.collaborationSessionId },
  });
  if (result.count === 1) return { ...project, collaborationSessionId: identity.collaborationSessionId };
  const winner = await prisma.codeSiteProject.findFirst({
    where: { id: project.id, workspaceSlug: identity.workspaceSlug },
    include: { members: true },
  });
  if (winner?.collaborationSessionId !== identity.collaborationSessionId) {
    throw forbidden('agent_project_collaboration_mismatch');
  }
  return winner;
}

function agentAttachmentCandidateWhere(identity) {
  return {
    OR: [
      ...(identity.terminalSessionId ? [{
        collaborationSessionId: identity.collaborationSessionId,
        terminalSessionId: identity.terminalSessionId,
        endedAt: null,
      }] : []),
      ...(identity.runtimeSessionId ? [{
        collaborationSessionId: identity.collaborationSessionId,
        runtimeSessionId: identity.runtimeSessionId,
        endedAt: null,
      }] : []),
      {
        projectId: identity.projectId,
        ownerUserId: identity.ownerUserId,
        agentProvider: identity.agentProvider,
        providerSessionRef: identity.providerSessionRef,
        endedAt: null,
      },
    ],
  };
}

async function findAgentAttachmentCandidates(identity) {
  return prisma.codeSiteAgentSession.findMany({
    where: agentAttachmentCandidateWhere(identity),
  });
}

function singleAgentAttachmentCandidate(candidates) {
  const candidateIds = unique(candidates.map((candidate) => candidate.id));
  if (candidateIds.length > 1) {
    throw forbidden('agent_session_binding_collision', { agentSessionIds: candidateIds });
  }
  return candidates[0] || null;
}

async function verifyAgentMutationBindings(identity, sessionId) {
  if (!identity.activeMutationLeaseId && !identity.activeTransactionId) return;
  if (!sessionId) throw forbidden('agent_attach_mutation_context_forbidden');
  if (identity.activeMutationLeaseId) {
    const lease = await prisma.codeSiteMutationLease.findFirst({
      where: {
        id: identity.activeMutationLeaseId,
        projectId: identity.projectId,
        agentSessionId: sessionId,
        status: { in: ['active', 'holding'] },
      },
    });
    if (!lease) throw forbidden('agent_mutation_lease_binding_mismatch');
  }
  if (identity.activeTransactionId) {
    const transaction = await prisma.codeSiteMutationTransaction.findFirst({
      where: {
        id: identity.activeTransactionId,
        projectId: identity.projectId,
        agentSessionId: sessionId,
        mutationLeaseId: identity.activeMutationLeaseId || undefined,
        status: { in: ['open', 'prepared'] },
      },
    });
    if (!transaction) throw forbidden('agent_transaction_binding_mismatch');
  }
}

function isAgentBindingUniqueConflict(error) {
  return error?.code === 'P2002';
}

export async function attachAgentSession(workspaceSlug, projectId, body = {}, authority = null) {
  const identity = {
    ...agentAttachmentIdentity(body),
    workspaceSlug: requiredAgentBinding(workspaceSlug, 'workspace_required'),
    projectId: requiredAgentBinding(projectId, 'project_required'),
  };
  requireAgentAttachAuthority(authority, identity);
  let project = await prisma.codeSiteProject.findFirst({
    where: { id: identity.projectId, workspaceSlug: identity.workspaceSlug },
    include: { members: true },
  });
  if (!project) throw notFound('codesite_project_not_found');
  if (project.status !== 'active') throw forbidden('codesite_project_inactive');
  project = await bindProjectCollaborationSession(project, identity);

  const capabilities = normalizedAgentStringList(body.capabilities || body.tools || [], 'agent_capabilities_invalid');
  const subscriptions = normalizedAgentStringList(body.subscriptions || [], 'agent_subscriptions_invalid');
  const deliveryChannel = normalizedAgentDeliveryChannel(body.deliveryChannel || body.delivery_channel || {});
  const executionHost = normalizedAgentExecutionHost(body.executionHost || body.execution_host || {});

  const candidates = await findAgentAttachmentCandidates(identity);
  let existing = singleAgentAttachmentCandidate(candidates);
  if (existing) assertAgentAttachmentMatch(existing, identity);
  await verifyAgentMutationBindings(identity, existing?.id || null);

  const member = await upsertProjectMemberRecord({
    projectId: project.id,
    workspaceSlug: identity.workspaceSlug,
    userId: identity.ownerUserId,
    role: 'agent',
    source: 'collab_agent_attach',
    createdByUserId: identity.ownerUserId,
  });
  if (!member) throw serviceUnavailable('agent_project_membership_persistence_failed');

  const now = new Date();
  const credentialFor = (candidate) => {
    const expired = !candidate?.agentAccessTokenExpiresAt
      || new Date(candidate.agentAccessTokenExpiresAt).getTime() <= now.getTime();
    return !candidate || !candidate.agentAccessTokenHash || expired || body.rotateAgentAccessToken === true
      ? mintAgentAccessToken(now)
      : null;
  };
  let accessCredential = credentialFor(existing);
  let session;
  let eventType;
  const resumeExisting = async (candidate) => {
    assertAgentAttachmentMatch(candidate, identity);
    await verifyAgentMutationBindings(identity, candidate.id);
    return prisma.codeSiteAgentSession.update({
      where: { id: candidate.id },
      data: {
        agentRuntime: body.agentRuntime || body.agent_runtime || candidate.agentRuntime || null,
        status: 'attached',
        permissionsJson: stringifyJson(capabilities),
        capabilitiesJson: stringifyJson(capabilities),
        executionHostJson: stringifyJson(executionHost),
        subscriptionsJson: stringifyJson(subscriptions),
        deliveryChannelJson: stringifyJson(deliveryChannel),
        ...(accessCredential ? {
          agentAccessTokenHash: accessCredential.hash,
          agentAccessTokenIssuedAt: accessCredential.issuedAt,
          agentAccessTokenExpiresAt: accessCredential.expiresAt,
        } : {}),
        attachedAt: candidate.attachedAt || now,
        lastHeartbeatAt: now,
        detachedAt: null,
        endedAt: null,
      },
    });
  };
  if (existing) {
    session = await resumeExisting(existing);
    eventType = 'agent_resumed';
  } else {
    const callsign = String(
      body.displayCallsign
      || body.display_callsign
      || body.callsign
      || automaticAgentCallsign(identity.agentProvider, identity),
    ).trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]{1,31}$/.test(callsign)) throw badRequest('agent_callsign_invalid');
    const createData = {
      projectId: project.id,
      workspaceSlug: identity.workspaceSlug,
      ownerUserId: identity.ownerUserId,
      collaborationUserId: identity.collaborationUserId,
      effectiveWorkspaceUserId: identity.effectiveWorkspaceUserId,
      collaborationSessionId: identity.collaborationSessionId,
      terminalSessionId: identity.terminalSessionId,
      runtimeSessionId: identity.runtimeSessionId,
      runtimeScope: identity.runtimeScope,
      agentProvider: identity.agentProvider,
      agentRuntime: body.agentRuntime || body.agent_runtime || 'terminal',
      providerSessionRef: identity.providerSessionRef,
      displayCallsign: callsign,
      status: 'attached',
      permissionsJson: stringifyJson(capabilities),
      redactionPolicyJson: stringifyJson(body.redactionPolicy || body.redaction_policy || defaultRedactionPolicy()),
      capabilitiesJson: stringifyJson(capabilities),
      executionHostJson: stringifyJson(executionHost),
      subscriptionsJson: stringifyJson(subscriptions),
      deliveryChannelJson: stringifyJson(deliveryChannel),
      attachSource: 'collab_terminal_adapter',
      bindingVersion: 1,
      agentAccessTokenHash: accessCredential.hash,
      agentAccessTokenIssuedAt: accessCredential.issuedAt,
      agentAccessTokenExpiresAt: accessCredential.expiresAt,
      activeMutationLeaseId: identity.activeMutationLeaseId,
      activeTransactionId: identity.activeTransactionId,
      attachedAt: now,
      lastHeartbeatAt: now,
    };
    try {
      session = await prisma.codeSiteAgentSession.create({ data: createData });
      eventType = 'agent_attached';
    } catch (error) {
      if (!isAgentBindingUniqueConflict(error)) throw error;
      existing = singleAgentAttachmentCandidate(await findAgentAttachmentCandidates(identity));
      if (!existing) throw error;
      accessCredential = credentialFor(existing);
      session = await resumeExisting(existing);
      eventType = 'agent_resumed';
    }
  }
  const event = await recordEvent(project.id, {
    eventType,
    displayCallsign: session.displayCallsign,
    actorType: 'agent_session',
    actorId: session.id,
    details: {
      ownerUserId: identity.ownerUserId,
      collaborationUserId: identity.collaborationUserId,
      effectiveWorkspaceUserId: identity.effectiveWorkspaceUserId,
      collaborationSessionId: identity.collaborationSessionId,
      terminalSessionId: identity.terminalSessionId,
      runtimeSessionId: identity.runtimeSessionId,
      runtimeScope: identity.runtimeScope,
      provider: identity.agentProvider,
      status: session.status,
      subscriptions,
      deliveryChannel: deliveryChannel.type,
    },
  });
  return {
    session: sessionProjection(session),
    event: eventProjection(event),
    resumed: eventType === 'agent_resumed',
    agentAccessToken: accessCredential?.token || null,
    agentAccessTokenExpiresAt: accessCredential?.expiresAt || session.agentAccessTokenExpiresAt || null,
  };
}

async function requireAttachedAgentSession(workspaceSlug, sessionId, body, authority) {
  const session = await prisma.codeSiteAgentSession.findFirst({
    where: { id: sessionId, project: { workspaceSlug } },
  });
  if (!session) throw notFound('agent_session_not_found');
  if (session.endedAt) throw forbidden('agent_session_ended');
  const identity = {
    ...agentAttachmentIdentity(body),
    workspaceSlug,
    projectId: session.projectId,
  };
  requireAgentAttachAuthority(authority, identity);
  assertAgentAttachmentMatch(session, identity);
  await verifyAgentMutationBindings(identity, session.id);
  return session;
}

export async function heartbeatAgentSession(workspaceSlug, sessionId, body = {}, authority = null) {
  const session = await requireAttachedAgentSession(workspaceSlug, sessionId, body, authority);
  const now = new Date();
  const updated = await prisma.codeSiteAgentSession.update({
    where: { id: session.id },
    data: { status: 'attached', lastHeartbeatAt: now, detachedAt: null, endedAt: null },
  });
  const event = await recordEvent(session.projectId, {
    eventType: 'agent_heartbeat',
    displayCallsign: session.displayCallsign,
    actorType: 'agent_session',
    actorId: session.id,
    details: { status: 'attached', terminalSessionId: session.terminalSessionId },
  });
  return { session: sessionProjection(updated), event: eventProjection(event) };
}

export async function detachAgentSession(workspaceSlug, sessionId, body = {}, authority = null) {
  const session = await requireAttachedAgentSession(workspaceSlug, sessionId, body, authority);
  const now = new Date();
  const updated = await prisma.codeSiteAgentSession.update({
    where: { id: session.id },
    data: { status: 'detached', detachedAt: now, endedAt: body.ended === true ? now : null },
  });
  const event = await recordEvent(session.projectId, {
    eventType: 'agent_detached',
    displayCallsign: session.displayCallsign,
    actorType: 'agent_session',
    actorId: session.id,
    details: {
      status: 'detached',
      terminalSessionId: session.terminalSessionId,
      reason: String(body.reason || 'terminal_detached').slice(0, 120),
    },
  });
  return { session: sessionProjection(updated), event: eventProjection(event) };
}

function boundedAgentContextValue(value, depth = 0) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 2048);
  if (value instanceof Date) return value.toISOString();
  if (depth >= 5) return '[depth-limited]';
  if (Array.isArray(value)) return value.slice(0, 32).map((entry) => boundedAgentContextValue(entry, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/(token|secret|credential|prompt|transcript|providerSessionRef)/i.test(key))
      .slice(0, 48)
      .map(([key, entry]) => [key, boundedAgentContextValue(entry, depth + 1)]));
  }
  return String(value).slice(0, 2048);
}

function trimAgentContextToLimit(context) {
  const collections = [
    () => context.inbox,
    () => context.sharedKnowledge?.impactNotices,
    () => context.sharedKnowledge?.handoffs,
    () => context.sharedKnowledge?.leads,
    () => context.sharedKnowledge?.discoveries,
    () => context.sharedKnowledge?.skills,
    () => context.inspections,
    () => context.transactions,
    () => context.leases,
    () => context.workstreams,
  ];
  const contentBudget = AGENT_CONTEXT_MAX_BYTES - 256;
  let serialized = stableJson(context);
  while (Buffer.byteLength(serialized, 'utf8') > contentBudget) {
    const target = collections.map((read) => read()).find((value) => value?.length > 0);
    if (!target) break;
    target.pop();
    context.truncated = true;
    serialized = stableJson(context);
  }
  if (Buffer.byteLength(serialized, 'utf8') > contentBudget) {
    context.constraints = { truncated: true };
    context.sourceState = { truncated: true };
    context.truncated = true;
  }
  context.bytes = Buffer.byteLength(stableJson(context), 'utf8');
  return context;
}

function requiredAgentCapabilities(value) {
  if (value == null || value === '') return [];
  const capabilities = unique(asArray(value).map((entry) => String(entry || '').trim()).filter(Boolean));
  if (capabilities.length === 0
    || capabilities.length > 32
    || capabilities.some((capability) => capability.length > 128 || !/^[a-z0-9][a-z0-9.*:_-]*$/i.test(capability))) {
    throw forbidden('agent_capability_required');
  }
  return capabilities;
}

export async function requireAgentTokenAuthority(
  workspaceSlug,
  sessionId,
  agentAccessToken,
  { requiredCapability = null, now = new Date() } = {},
) {
  const token = String(agentAccessToken || '').trim();
  const normalizedWorkspaceSlug = String(workspaceSlug || '').trim();
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedWorkspaceSlug
    || !normalizedSessionId
    || !/^csa_[A-Za-z0-9_-]{32,128}$/.test(token)) {
    throw forbidden('agent_access_token_invalid');
  }
  const session = await prisma.codeSiteAgentSession.findFirst({
    where: {
      id: normalizedSessionId,
      workspaceSlug: normalizedWorkspaceSlug,
      agentAccessTokenHash: agentAccessTokenHash(token),
      endedAt: null,
    },
    include: { project: { include: { members: true } } },
  });
  if (!session) throw forbidden('agent_access_token_invalid');

  const authorizedAt = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  const authorizedAtMs = authorizedAt.getTime();
  if (!Number.isFinite(authorizedAtMs)) throw forbidden('agent_access_token_invalid');
  const expiresAtMs = session.agentAccessTokenExpiresAt
    ? new Date(session.agentAccessTokenExpiresAt).getTime()
    : Number.NaN;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= authorizedAtMs) {
    throw forbidden('agent_access_token_expired');
  }
  if (session.status !== 'attached') throw forbidden('agent_session_not_attached');
  const heartbeatAtMs = session.lastHeartbeatAt
    ? new Date(session.lastHeartbeatAt).getTime()
    : Number.NaN;
  const heartbeatAgeMs = authorizedAtMs - heartbeatAtMs;
  if (!Number.isFinite(heartbeatAtMs)
    || heartbeatAgeMs < 0
    || heartbeatAgeMs > AGENT_CONTEXT_HEARTBEAT_MAX_AGE_MS) {
    throw forbidden('agent_session_heartbeat_stale');
  }
  if (!session.project || session.project.status !== 'active') throw forbidden('codesite_project_inactive');
  const member = projectAgentMember(session.project, session.ownerUserId);
  if (!member || !projectPermissionAllows(member, 'read')) throw forbidden('agent_project_membership_revoked');

  const capabilities = unique(asArray(parseJson(session.capabilitiesJson, []))
    .map((capability) => String(capability || '').trim())
    .filter(Boolean));
  const requiredCapabilities = requiredAgentCapabilities(requiredCapability);
  if (requiredCapabilities.some((capability) => !capabilities.includes(capability))) {
    throw forbidden('agent_capability_required', { requiredCapabilities });
  }
  return {
    session,
    project: session.project,
    member,
    capabilities,
    authorizedAt,
  };
}

export function agentChannelRateLimitKey(session) {
  return `${session.id}:${session.ownerUserId}`;
}

export async function requireAgentChannelRateAuthority(
  workspaceSlug,
  sessionId,
  agentAccessToken,
  action = 'channels',
) {
  const authority = await requireAgentTokenAuthority(workspaceSlug, sessionId, agentAccessToken);
  const response = enforceRateLimit(
    { userId: agentChannelRateLimitKey(authority.session) },
    action,
    'channels',
  );
  return response ? { response } : { authority };
}

export async function getRelevantAgentContext(workspaceSlug, sessionId, agentAccessToken) {
  const { session, authorizedAt: now } = await requireAgentTokenAuthority(
    workspaceSlug,
    sessionId,
    agentAccessToken,
    { requiredCapability: 'codesite.context.read' },
  );

  const [workstreams, leases, transactions, inbox, inspections, knowledgeRows, peerSessions] = await Promise.all([
    prisma.codeSiteExecutionPlan.findMany({
      where: { projectId: session.projectId, status: { in: ['filed', 'active', 'holding', 'blocked'] } },
      orderBy: { filedAt: 'desc' },
      take: 24,
    }),
    prisma.codeSiteMutationLease.findMany({
      where: { projectId: session.projectId, agentSessionId: session.id, status: { in: ['active', 'holding'] } },
      orderBy: { issuedAt: 'desc' },
      take: 16,
    }),
    prisma.codeSiteMutationTransaction.findMany({
      where: { projectId: session.projectId, agentSessionId: session.id, status: { in: ['open', 'prepared', 'blocked'] } },
      orderBy: { openedAt: 'desc' },
      take: 16,
    }),
    prisma.codeSiteAgentInboxItem.findMany({
      where: {
        projectId: session.projectId,
        status: { in: ['unread', 'pending'] },
        OR: [
          { agentSessionId: session.id },
          { recipientUserId: session.ownerUserId },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 32,
    }),
    prisma.codeSiteInspectionRun.findMany({
      where: { projectId: session.projectId, status: { in: ['required', 'queued', 'running', 'failed'] } },
      orderBy: { requestedAt: 'desc' },
      take: 24,
    }),
    prisma.codeSiteKnowledgeItem.findMany({
      where: {
        projectId: session.projectId,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      include: { references: true },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    }),
    prisma.codeSiteAgentSession.findMany({
      where: {
        projectId: session.projectId,
        id: { not: session.id },
        endedAt: null,
        status: { in: ['attached', 'detached'] },
      },
      select: {
        id: true,
        displayCallsign: true,
        ownerUserId: true,
        agentProvider: true,
        terminalSessionId: true,
        runtimeSessionId: true,
        status: true,
        attachedAt: true,
        lastHeartbeatAt: true,
      },
      orderBy: { attachedAt: 'desc' },
      take: 24,
    }),
  ]);

  const relevantKnowledge = visibleKnowledgeRowsForSession(
    knowledgeRows,
    session,
    workstreams,
    transactions,
    inbox,
  ).map(projectKnowledgeRecord).filter(Boolean);

  const projectControl = boundedAgentContextValue(parseJson(session.project.controlPlanJson, {}));
  const zonePolicy = boundedAgentContextValue(parseJson(session.project.zonePolicyJson, {}));
  const context = {
    contextVersion: 'synthi.codesite.agentContext.v1',
    generatedAt: now.toISOString(),
    maxBytes: AGENT_CONTEXT_MAX_BYTES,
    truncated: false,
    agent: {
      id: session.id,
      callsign: session.displayCallsign,
      ownerUserId: session.ownerUserId,
      collaborationUserId: session.collaborationUserId,
      effectiveWorkspaceUserId: session.effectiveWorkspaceUserId,
      collaborationSessionId: session.collaborationSessionId,
      terminalSessionId: session.terminalSessionId,
      runtimeSessionId: session.runtimeSessionId,
      runtimeScope: session.runtimeScope,
      provider: session.agentProvider,
      capabilities: parseJson(session.capabilitiesJson, []),
      subscriptions: parseJson(session.subscriptionsJson, []),
    },
    project: {
      id: session.projectId,
      workspaceSlug,
      title: String(session.project.title || '').slice(0, 512),
      request: String(session.project.request || '').slice(0, 2048),
    },
    workstreams: workstreams.map((plan) => boundedAgentContextValue({
      id: plan.id,
      ownerAgentSessionId: plan.agentSessionId,
      callsign: plan.displayCallsign,
      mission: plan.mission,
      domain: plan.domain,
      status: plan.status,
      route: parseJson(plan.routeJson, []),
      blockedZones: parseJson(plan.blockedZonesJson, []),
    })),
    leases: leases.map((lease) => boundedAgentContextValue({
      id: lease.id,
      status: lease.status,
      executionPlanId: lease.executionPlanId,
      route: parseJson(lease.leaseJson, {}),
      expiresAt: lease.expiresAt,
    })),
    transactions: transactions.map((transaction) => boundedAgentContextValue({
      id: transaction.id,
      status: transaction.status,
      mutationLeaseId: transaction.mutationLeaseId,
      baseSnapshot: transaction.baseSnapshot,
      writeSet: parseJson(transaction.writeSetJson, []),
      observedWriteSet: parseJson(transaction.observedWriteSetJson, []),
    })),
    inbox: inbox.map((item) => boundedAgentContextValue({
      id: item.id,
      kind: item.kind,
      status: item.status,
      requiresResponse: item.requiresResponse,
      eventId: item.eventId,
      documentId: item.documentId,
      knowledgeItemId: item.knowledgeItemId,
      payload: parseJson(item.redactedPayloadJson, {}),
      createdAt: item.createdAt,
    })),
    sourceState: boundedAgentContextValue({
      activeTransactionId: session.activeTransactionId || null,
      activeMutationLeaseId: session.activeMutationLeaseId || null,
      routes: workstreams.filter((plan) => plan.agentSessionId === session.id).map((plan) => parseJson(plan.routeJson, [])),
    }),
    constraints: {
      controlPlan: projectControl,
      zonePolicy,
    },
    inspections: inspections.map((inspection) => boundedAgentContextValue({
      id: inspection.id,
      executionPlanId: inspection.executionPlanId,
      type: inspection.type,
      status: inspection.status,
      result: parseJson(inspection.resultJson, null),
    })),
    sharedKnowledge: {
      discoveries: relevantKnowledge.filter((item) => item.kind === 'discovery').slice(0, 24),
      leads: relevantKnowledge.filter((item) => item.kind === 'lead').slice(0, 24),
      skills: relevantKnowledge.filter((item) => item.kind === 'shared_skill').slice(0, 24),
      handoffs: relevantKnowledge.filter((item) => item.kind === 'handoff').slice(0, 24),
      impactNotices: relevantKnowledge.filter((item) => item.kind === 'impact_notice').slice(0, 24),
      phaseAvailable: true,
    },
    peerAgents: peerSessions.map((peer) => boundedAgentContextValue({
      id: peer.id,
      callsign: peer.displayCallsign,
      ownerUserId: peer.ownerUserId,
      provider: peer.agentProvider,
      terminalSessionId: peer.terminalSessionId,
      runtimeSessionId: peer.runtimeSessionId,
      status: peer.status,
      attachedAt: peer.attachedAt,
      lastHeartbeatAt: peer.lastHeartbeatAt,
    })),
  };
  return trimAgentContextToLimit(context);
}

const KNOWLEDGE_CREATE_KINDS = new Set(['discovery', 'lead', 'shared_skill', 'handoff']);
const KNOWLEDGE_QUERY_KINDS = new Set([...KNOWLEDGE_CREATE_KINDS, 'impact_notice']);

function nextKnowledgeId(prefix = 'knw') {
  return `${prefix}_${randomBytes(18).toString('base64url')}`;
}

function knowledgeEventType(item) {
  if (item.kind === 'discovery') return 'discovery_recorded';
  if (item.kind === 'lead') return item.status === 'resolved' ? 'lead_resolved' : 'lead_opened';
  if (item.kind === 'shared_skill') return item.status === 'published' ? 'shared_skill_published' : 'shared_skill_updated';
  if (item.kind === 'handoff') return 'handoff_ready';
  return 'impact_notice_created';
}

function knowledgeResponseEventType(kind, action) {
  if (kind === 'lead') {
    if (action === 'claim') return 'lead_claimed';
    if (action === 'resolve') return 'lead_resolved';
    if (action === 'dismiss') return 'lead_dismissed';
  }
  if (kind === 'handoff' && ['accept', 'acknowledge'].includes(action)) return 'handoff_acknowledged';
  return 'impact_notice_responded';
}

function knowledgeScope(row) {
  return parseJson(row?.scopeJson, {});
}

function knowledgeVisibility(row) {
  return String(knowledgeScope(row).visibility || 'project');
}

function validateKnowledgeQuery(input = {}) {
  const kind = String(input.kind || '').trim().toLowerCase();
  if (kind && !KNOWLEDGE_QUERY_KINDS.has(kind)) throw badRequest('knowledge_kind_invalid');
  const status = String(input.status || '').trim().toLowerCase();
  if (status && !/^[a-z][a-z0-9_]{0,63}$/.test(status)) throw badRequest('knowledge_status_invalid');
  const limitValue = Number(input.limit || 50);
  const limit = Number.isInteger(limitValue) ? Math.min(Math.max(limitValue, 1), 100) : 50;
  const since = input.since ? new Date(input.since) : null;
  if (since && !Number.isFinite(since.getTime())) throw badRequest('knowledge_since_invalid');
  return { kind: kind || null, status: status || null, limit, since };
}

function knowledgeWhere(projectId, query) {
  return {
    projectId,
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.since ? { updatedAt: { gt: query.since } } : {}),
    OR: [
      { expiresAt: null },
      { expiresAt: { gt: new Date() } },
    ],
  };
}

function knowledgeIdsFromInbox(inbox) {
  return new Set(asArray(inbox).map((item) => item.knowledgeItemId).filter(Boolean));
}

function visibleKnowledgeRowsForSession(rows, session, executionPlans, transactions, inbox) {
  const inboxKnowledgeIds = knowledgeIdsFromInbox(inbox);
  return rows.filter((row) => {
    const visibility = knowledgeVisibility(row);
    const owned = row.createdByAgentSessionId === session.id
      || row.ownerAgentSessionId === session.id
      || row.createdByUserId === session.ownerUserId
      || row.ownerUserId === session.ownerUserId;
    if (visibility === 'owner_private') return owned;
    if (visibility === 'restricted' && !owned && !inboxKnowledgeIds.has(row.id)) return false;
    if (owned || inboxKnowledgeIds.has(row.id)) return true;
    if (row.kind === 'shared_skill' && row.status === 'published') return true;
    const projected = projectKnowledgeRecord(row);
    if (!projected) return false;
    return buildKnowledgeDeliveryPlan({
      item: {
        ...projected,
        createdByAgentSessionId: row.createdByAgentSessionId,
      },
      sessions: [session],
      executionPlans,
      transactions,
    }).length > 0;
  });
}

async function loadRelevantKnowledgeForSession(session, queryInput = {}, state = {}) {
  const query = validateKnowledgeQuery(queryInput);
  const [rows, executionPlans, transactions, inbox] = await Promise.all([
    state.rows || prisma.codeSiteKnowledgeItem.findMany({
      where: knowledgeWhere(session.projectId, query),
      include: { references: true },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    }),
    state.executionPlans || prisma.codeSiteExecutionPlan.findMany({
      where: { projectId: session.projectId, agentSessionId: session.id, status: { in: ['filed', 'active', 'holding', 'blocked'] } },
      orderBy: { filedAt: 'desc' },
      take: 32,
    }),
    state.transactions || prisma.codeSiteMutationTransaction.findMany({
      where: { projectId: session.projectId, agentSessionId: session.id, status: { in: ['open', 'prepared', 'blocked', 'validated'] } },
      orderBy: { openedAt: 'desc' },
      take: 32,
    }),
    state.inbox || prisma.codeSiteAgentInboxItem.findMany({
      where: { projectId: session.projectId, agentSessionId: session.id, knowledgeItemId: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
  ]);
  return visibleKnowledgeRowsForSession(rows, session, executionPlans, transactions, inbox)
    .slice(0, query.limit)
    .map(projectKnowledgeRecord)
    .filter(Boolean);
}

async function requireKnowledgeReferenceTargets(projectId, item, state) {
  const refs = item.references;
  const sessionIds = new Set(state.sessions.map((session) => session.id));
  const workstreamIds = new Set(state.executionPlans.map((plan) => plan.id));
  const transactionIds = new Set(state.transactions.map((transaction) => transaction.id));
  const missing = {
    agentSessionIds: refs.agentSessionIds.filter((id) => !sessionIds.has(id)),
    workstreamIds: refs.workstreamIds.filter((id) => !workstreamIds.has(id)),
    transactionIds: refs.transactionIds.filter((id) => !transactionIds.has(id)),
  };
  if (item.kind === 'handoff' && !sessionIds.has(item.toAgentSessionId)) {
    missing.agentSessionIds.push(item.toAgentSessionId);
  }
  if (item.kind === 'lead' && item.ownerAgentSessionId && !sessionIds.has(item.ownerAgentSessionId)) {
    missing.agentSessionIds.push(item.ownerAgentSessionId);
  }
  if (Object.values(missing).some((ids) => ids.length)) {
    throw badRequest('knowledge_reference_outside_project', { projectId, missing });
  }
}

async function createKnowledgeWithClient(db, record, knowledgeId, eventInput) {
  const created = await db.codeSiteKnowledgeItem.create({
    data: { id: knowledgeId, ...record.data },
  });
  const referenceRows = buildKnowledgeReferenceRecords(record.normalized, knowledgeId);
  if (referenceRows.length) await db.codeSiteKnowledgeReference.createMany({ data: referenceRows });
  const event = await publishKnowledgeCoordinationEventWithClient(
    db,
    record.normalized.projectId,
    eventInput,
  );
  const updated = await db.codeSiteKnowledgeItem.update({
    where: { id: knowledgeId },
    data: { sourceEventId: event.id },
  });
  return {
    row: { ...created, ...updated, references: referenceRows },
    event,
  };
}

async function publishKnowledgeCoordinationEventWithClient(db, projectId, input) {
  const eventId = nextKnowledgeId('evt');
  let storedEvent = null;
  const bus = createProjectCoordinationBus({
    normalize: async () => ({
      id: eventId,
      projectId,
      eventType: validateCodeSiteEventType(input.eventType),
      payload: {
        displayCallsign: input.displayCallsign || null,
        actorType: input.actorType || null,
        actorId: input.actorId || null,
        details: input.details || {},
        evidenceRefs: input.evidenceRefs || [],
      },
    }),
    redact: async (event) => event,
    classify: async (event) => ({
      ...event,
      classification: {
        class: event.eventType,
        redactionClass: event.eventType.startsWith('impact_notice') ? 'project_notice' : 'project_fact',
      },
    }),
    correlate: async (event) => ({
      ...event,
      correlation: {
        knowledgeItemId: event.payload.details.knowledgeItemId || null,
        sourceKnowledgeItemId: event.payload.details.sourceKnowledgeItemId || null,
        recipientAgentSessionId: event.payload.details.recipientAgentSessionId || null,
        targetTransactionIds: asArray(event.payload.details.targetTransactionIds),
        references: event.payload.details.references || null,
      },
    }),
    authorize: async (event) => ({
      allowed: event.projectId === projectId,
      recipients: unique([
        event.payload.details.recipientAgentSessionId,
        ...asArray(event.payload.details.recipientAgentSessionIds),
      ].filter(Boolean)),
    }),
    persist: async (event) => {
      storedEvent = await recordEventWithClient(db, projectId, {
        id: event.id,
        mutationLeaseId: input.mutationLeaseId,
        eventType: event.eventType,
        displayCallsign: event.payload.displayCallsign,
        actorType: event.payload.actorType,
        actorId: event.payload.actorId,
        details: event.payload.details,
        evidenceRefs: event.payload.evidenceRefs,
      }, { syncArtifacts: false });
      return {
        ...event,
        persisted: {
          id: storedEvent.id,
          logicalTime: storedEvent.logicalTime ?? null,
          createdAt: storedEvent.createdAt instanceof Date
            ? storedEvent.createdAt.toISOString()
            : String(storedEvent.createdAt || ''),
        },
      };
    },
    route: async (event, { authorization }) => ({
      eventId: event.id,
      mode: 'durable_relevance_router',
      recipientAgentSessionIds: authorization.recipients,
    }),
  });
  await bus.publish({
    id: eventId,
    projectId,
    eventType: input.eventType,
    payload: {
      displayCallsign: input.displayCallsign || null,
      actorType: input.actorType || null,
      actorId: input.actorId || null,
      details: input.details || {},
      evidenceRefs: input.evidenceRefs || [],
    },
  });
  if (!storedEvent) throw new Error('knowledge_coordination_event_not_persisted');
  return storedEvent;
}

async function persistKnowledgeAndImpacts(authority, record, deliveryPlan) {
  const sourceKnowledgeId = nextKnowledgeId('knw');
  const source = record.normalized.source;
  const projectId = authority.session?.projectId || record.normalized.projectId;
  return prisma.$transaction(async (db) => {
    const persistedSource = await createKnowledgeWithClient(db, record, sourceKnowledgeId, {
      eventType: knowledgeEventType(record.normalized),
      displayCallsign: authority.session?.displayCallsign || null,
      actorType: source.actorType === 'agent' ? 'agent_session' : source.actorType,
      actorId: source.actorId,
      evidenceRefs: record.normalized.evidenceRefs,
      details: {
        knowledgeItemId: sourceKnowledgeId,
        kind: record.normalized.kind,
        status: record.normalized.status,
        title: record.normalized.title,
        references: record.normalized.references,
        confidence: record.normalized.confidence,
      },
    });
    const impacts = [];
    for (const target of deliveryPlan) {
      const impactId = nextKnowledgeId('imp');
      const impactInput = {
        kind: 'impact_notice',
        projectId,
        title: `Impact: ${record.normalized.title}`.slice(0, 160),
        summary: record.normalized.summary,
        status: 'pending',
        source: { actorType: 'system', actorId: sourceKnowledgeId },
        references: {
          ...record.normalized.references,
          agentSessionIds: unique([...record.normalized.references.agentSessionIds, target.agentSessionId]),
          transactionIds: unique([...record.normalized.references.transactionIds, ...target.transactionIds]),
        },
        evidenceRefs: record.normalized.evidenceRefs,
        confidence: record.normalized.confidence,
        sourceKnowledgeId,
        recipientAgentSessionIds: [target.agentSessionId],
        requiresResponse: true,
      };
      const impactRecord = buildKnowledgeRecord(impactInput, { projectId });
      impactRecord.data.dedupeKey = target.dedupeKey;
      impactRecord.data.targetTransactionId = target.transactionIds[0] || null;
      const impact = await createKnowledgeWithClient(db, impactRecord, impactId, {
        eventType: 'impact_notice_created',
        actorType: 'knowledge_router',
        actorId: sourceKnowledgeId,
        evidenceRefs: record.normalized.evidenceRefs,
        details: {
          knowledgeItemId: impactId,
          sourceKnowledgeItemId: sourceKnowledgeId,
          recipientAgentSessionId: target.agentSessionId,
          targetTransactionIds: target.transactionIds,
          reasons: target.reasons,
          deliveryState: target.deliveryState,
        },
      });
      const inboxItem = await db.codeSiteAgentInboxItem.create({
        data: {
          projectId,
          agentSessionId: target.agentSessionId,
          recipientUserId: target.recipientUserId,
          eventId: impact.event.id,
          knowledgeItemId: impactId,
          kind: 'impact_notice',
          requiresResponse: true,
          status: 'pending',
          redactedPayloadJson: stringifyJson({
            knowledgeItemId: impactId,
            sourceKnowledgeItemId: sourceKnowledgeId,
            title: impactInput.title,
            summary: impactInput.summary,
            references: impactInput.references,
            reasons: target.reasons,
            targetTransactionIds: target.transactionIds,
          }),
        },
      });
      impacts.push({ knowledge: projectKnowledgeRecord(impact.row), inboxItem: inboxProjection(inboxItem) });
    }
    return {
      knowledge: projectKnowledgeRecord(persistedSource.row),
      event: eventProjection(persistedSource.event),
      impacts,
    };
  });
}

export async function createAgentKnowledgeItem(workspaceSlug, sessionId, agentAccessToken, body = {}) {
  const authority = await requireAgentTokenAuthority(workspaceSlug, sessionId, agentAccessToken, {
    requiredCapability: 'codesite.knowledge.write',
  });
  const requestedKind = String(body.kind || body.type || '').trim().toLowerCase().replace(/[ -]+/g, '_');
  if (!KNOWLEDGE_CREATE_KINDS.has(requestedKind)) throw badRequest('agent_knowledge_kind_forbidden');
  if (body.projectId && body.projectId !== authority.session.projectId) throw forbidden('knowledge_project_mismatch');
  const input = {
    ...body,
    kind: requestedKind,
    projectId: authority.session.projectId,
    source: {
      ...(body.source && typeof body.source === 'object' ? body.source : {}),
      actorType: 'agent',
      actorId: authority.session.id,
      agentSessionId: authority.session.id,
      terminalSessionId: authority.session.terminalSessionId || null,
    },
    ...(requestedKind === 'handoff' ? { fromAgentSessionId: authority.session.id } : {}),
  };
  const record = buildKnowledgeRecord(input, {
    projectId: authority.session.projectId,
    agentSessionId: authority.session.id,
    userId: authority.session.ownerUserId,
  });
  const [sessions, executionPlans, transactions] = await Promise.all([
    prisma.codeSiteAgentSession.findMany({
      where: { projectId: authority.session.projectId, endedAt: null, status: { in: ['attached', 'detached'] } },
    }),
    prisma.codeSiteExecutionPlan.findMany({
      where: { projectId: authority.session.projectId, status: { in: ['filed', 'active', 'holding', 'blocked'] } },
    }),
    prisma.codeSiteMutationTransaction.findMany({
      where: { projectId: authority.session.projectId, status: { in: ['open', 'prepared', 'blocked', 'validated'] } },
    }),
  ]);
  const routingState = { sessions, executionPlans, transactions };
  await requireKnowledgeReferenceTargets(authority.session.projectId, record.normalized, routingState);
  const existing = await prisma.codeSiteKnowledgeItem.findFirst({
    where: { projectId: authority.session.projectId, dedupeKey: record.data.dedupeKey },
    include: { references: true },
  });
  if (existing) return { knowledge: projectKnowledgeRecord(existing), event: null, impacts: [], duplicate: true };
  const deliveryPlan = buildKnowledgeDeliveryPlan({
    item: { ...record.normalized, id: 'pending', createdByAgentSessionId: authority.session.id },
    sessions,
    executionPlans,
    transactions,
  });
  const result = await persistKnowledgeAndImpacts(authority, record, deliveryPlan);
  await syncArtifactsForProject(authority.session.projectId, { reason: 'knowledge_recorded', eventId: result.event?.id });
  return { ...result, duplicate: false };
}

const MAX_OBSERVATION_BODY_BYTES = 256 * 1024;

function coordinationStageError(code, details) {
  return new ProjectCoordinationBusError(code, { stage: 'authorize', status: 403, details });
}

function runtimeObservationInboxTargets(projectId, observation, { sessions, executionPlans, transactions }) {
  const projected = {
    id: `obs:${observation.id}`,
    kind: 'runtime_observation',
    createdByAgentSessionId: null,
    references: observation.payload.references,
  };
  return buildKnowledgeDeliveryPlan({
    item: projected,
    sessions,
    executionPlans,
    transactions,
  });
}

const MAX_ROUTE_TARGETS = 32;

/**
 * Shared relevance-routed impact delivery for coordination facts (runtime
 * observations, landed source changes). Persists one causal event and durable
 * inbox notices for every eligible agent whose routes/subscriptions intersect
 * the referenced paths. Never notifies the producing agent itself unless that
 * agent is also an explicit reference target.
 */
async function deliverCoordinationImpacts(projectId, { eventType, normalized, actorId = null }) {
  const coordinationInput = buildObservationCoordinationInput(normalized, { actorId });
  if (!coordinationInput) return { event: null, notifiedAgentSessionIds: [] };

  let storedEvent = null;
  const storedInboxItems = [];
  const bus = createProjectCoordinationBus({
    normalize: async () => ({
      id: normalized.id,
      projectId,
      eventType: coordinationInput.eventType,
      payload: {
        displayCallsign: null,
        actorType: 'adapter',
        actorId: coordinationInput.actorId,
        details: coordinationInput.details,
        evidenceRefs: coordinationInput.evidenceRefs,
      },
    }),
    redact: async (event) => event,
    classify: async (event) => ({
      ...event,
      classification: { class: event.eventType, redactionClass: 'project_fact' },
    }),
    correlate: async (event) => ({
      ...event,
      correlation: {
        observationId: normalized.id,
        producer: normalized.producer,
        references: normalized.payload.references,
        targetTransactionIds: normalized.payload.references.transactionIds,
      },
    }),
    authorize: async (event) => ({ allowed: event.projectId === projectId, recipients: [] }),
    persist: async (event) => {
      storedEvent = await recordEventWithClient(prisma, projectId, {
        id: event.id,
        mutationLeaseId: coordinationInput.mutationLeaseId,
        eventType: event.eventType,
        displayCallsign: event.payload.displayCallsign,
        actorType: event.payload.actorType,
        actorId: event.payload.actorId,
        details: event.payload.details,
        evidenceRefs: event.payload.evidenceRefs,
      }, { syncArtifacts: false });
      return {
        ...event,
        persisted: {
          id: storedEvent.id,
          logicalTime: storedEvent.logicalTime ?? null,
          createdAt: storedEvent.createdAt instanceof Date
            ? storedEvent.createdAt.toISOString()
            : String(storedEvent.createdAt || ''),
        },
      };
    },
    route: async (event) => {
      const [sessions, executionPlans, transactions] = await Promise.all([
        prisma.codeSiteAgentSession.findMany({
          where: { projectId, endedAt: null, status: { in: ['attached', 'detached'] } },
        }),
        prisma.codeSiteExecutionPlan.findMany({
          where: { projectId, status: { in: ['filed', 'active', 'holding', 'blocked'] } },
        }),
        prisma.codeSiteMutationTransaction.findMany({
          where: { projectId, status: { in: ['open', 'prepared', 'blocked', 'validated'] } },
        }),
      ]);
      const projected = {
        id: `obs:${normalized.id}`,
        kind: eventType === 'source_changed_observed' ? 'source_change' : 'runtime_observation',
        createdByAgentSessionId: normalized.payload.references.agentSessionIds[0] || null,
        references: normalized.payload.references,
      };
      const targets = buildKnowledgeDeliveryPlan({
        item: projected,
        sessions,
        executionPlans,
        transactions,
      }).slice(0, MAX_ROUTE_TARGETS);
      for (const target of targets) {
        const inboxItem = await prisma.codeSiteAgentInboxItem.create({
          data: {
            projectId,
            agentSessionId: target.agentSessionId,
            recipientUserId: target.recipientUserId,
            eventId: storedEvent?.id || event.id,
            kind: eventType === 'source_changed_observed' ? 'source_changed' : 'runtime_observed',
            requiresResponse: false,
            status: 'unread',
            redactedPayloadJson: stringifyJson({
              observationId: normalized.id,
              title: eventType === 'source_changed_observed'
                ? `Source changed: ${normalized.producer.kind}`
                : `Runtime: ${normalized.producer.kind}`,
              references: normalized.payload.references,
              fact: normalized.payload.fact,
              occurredAt: normalized.occurredAt,
              reasons: target.reasons,
              evidenceRefs: normalized.payload.evidenceRefs,
            }),
          },
        });
        storedInboxItems.push(inboxProjection(inboxItem));
      }
      return {
        eventId: event.id,
        mode: 'durable_relevance_router',
        recipientAgentSessionIds: unique(targets.map((target) => target.agentSessionId)),
      };
    },
  });
  await bus.publish({
    id: normalized.id,
    projectId,
    eventType: coordinationInput.eventType,
    payload: {
      displayCallsign: null,
      actorType: 'adapter',
      actorId: coordinationInput.actorId,
      details: coordinationInput.details,
      evidenceRefs: coordinationInput.evidenceRefs,
    },
  });
  if (!storedEvent) throw new Error('coordination_event_not_persisted');
  return {
    event: eventProjection(storedEvent),
    notifiedAgentSessionIds: storedInboxItems.map((item) => item.agentSessionId),
    inboxItems: storedInboxItems,
  };
}

async function notifySourceChangeImpacts(projectId, input) {
  try {
    const normalized = normalizeSourceChangedObservation({
      eventType: 'source_changed',
      producer: { kind: input.producerKind, eventId: input.producerEventId },
      occurredAt: input.occurredAt,
      refs: {
        transactionIds: [input.transactionId].filter(Boolean),
        mutationLeaseIds: [input.mutationLeaseId].filter(Boolean),
        agentSessionIds: [input.agentSessionId].filter(Boolean),
        paths: input.paths || [],
      },
      evidenceRefs: input.evidenceRefs || [],
      fact: input.fact,
    });
    await deliverCoordinationImpacts(projectId, {
      eventType: 'source_changed_observed',
      normalized,
      actorId: input.transactionId,
    });
  } catch (error) {
    // Landing must never fail because impact routing failed; the commit event
    // above is already durable and the failure is observable in server logs.
    console.error('[CodeSite] source-change impact routing failed', {
      projectId,
      transactionId: input.transactionId,
      error: error?.message || String(error),
    });
  }
}

export async function recordRuntimeProjectObservation(workspaceSlug, projectId, body = {}) {
  const project = await prisma.codeSiteProject.findFirst({
    where: { id: String(projectId || ''), workspaceSlug },
    include: { members: true },
  });
  if (!project) throw notFound('codesite_project_not_found');
  if (project.status !== 'active') throw forbidden('codesite_project_inactive');
  // Workstream F: the internal adapter endpoint accepts both runtime and
  // source-change observations; the event type in the body decides which
  // normalizer validates it (runtime facts vs source-change facts).
  const requestedEventType = body.eventType === 'source_changed' ? 'source_changed' : 'runtime_observed';
  const normalized = requestedEventType === 'source_changed'
    ? normalizeSourceChangedObservation({
      eventType: 'source_changed',
      ...body,
      projectId: project.id,
    })
    : normalizeRuntimeObservedObservation({
      eventType: 'runtime_observed',
      ...body,
      projectId: project.id,
    });
  const coordinationInput = buildObservationCoordinationInput(normalized, {
    actorId: typeof body.adapterSessionId === 'string' ? body.adapterSessionId : null,
  });
  if (!coordinationInput) throw badRequest('observation_coordination_unmappable');

  let storedEvent = null;
  let storedInboxItems = [];
  const bus = createProjectCoordinationBus({
    normalize: async () => ({
      id: normalized.id,
      projectId: project.id,
      eventType: coordinationInput.eventType,
      payload: {
        displayCallsign: null,
        actorType: 'adapter',
        actorId: coordinationInput.actorId,
        details: coordinationInput.details,
        evidenceRefs: coordinationInput.evidenceRefs,
      },
    }),
    redact: async (event) => event,
    classify: async (event) => ({
      ...event,
      classification: { class: event.eventType, redactionClass: 'project_fact' },
    }),
    correlate: async (event) => ({
      ...event,
      correlation: {
        observationId: normalized.id,
        producer: normalized.producer,
        references: normalized.payload.references,
        targetTransactionIds: normalized.payload.references.transactionIds,
      },
    }),
    authorize: async (event) => ({ allowed: event.projectId === project.id, recipients: [] }),
    persist: async (event) => {
      storedEvent = await recordEventWithClient(prisma, project.id, {
        id: event.id,
        mutationLeaseId: coordinationInput.mutationLeaseId,
        eventType: event.eventType,
        displayCallsign: event.payload.displayCallsign,
        actorType: event.payload.actorType,
        actorId: event.payload.actorId,
        details: event.payload.details,
        evidenceRefs: event.payload.evidenceRefs,
      }, { syncArtifacts: false });
      return {
        ...event,
        persisted: {
          id: storedEvent.id,
          logicalTime: storedEvent.logicalTime ?? null,
          createdAt: storedEvent.createdAt instanceof Date
            ? storedEvent.createdAt.toISOString()
            : String(storedEvent.createdAt || ''),
        },
      };
    },
    route: async (event) => {
      const [sessions, executionPlans, transactions] = await Promise.all([
        prisma.codeSiteAgentSession.findMany({
          where: { projectId: project.id, endedAt: null, status: { in: ['attached', 'detached'] } },
        }),
        prisma.codeSiteExecutionPlan.findMany({
          where: { projectId: project.id, status: { in: ['filed', 'active', 'holding', 'blocked'] } },
        }),
        prisma.codeSiteMutationTransaction.findMany({
          where: { projectId: project.id, status: { in: ['open', 'prepared', 'blocked', 'validated'] } },
        }),
      ]);
      const targets = runtimeObservationInboxTargets(project.id, normalized, {
        sessions,
        executionPlans,
        transactions,
      }).slice(0, 32);
      storedInboxItems = [];
      for (const target of targets) {
        const inboxItem = await prisma.codeSiteAgentInboxItem.create({
          data: {
            projectId: project.id,
            agentSessionId: target.agentSessionId,
            recipientUserId: target.recipientUserId,
            eventId: storedEvent?.id || event.id,
            kind: 'runtime_observed',
            requiresResponse: false,
            status: 'unread',
            redactedPayloadJson: stringifyJson({
              observationId: normalized.id,
              title: `Runtime: ${normalized.producer.kind}`,
              references: normalized.payload.references,
              fact: normalized.payload.fact,
              occurredAt: normalized.occurredAt,
              reasons: target.reasons,
              evidenceRefs: normalized.payload.evidenceRefs,
            }),
          },
        });
        storedInboxItems.push(inboxProjection(inboxItem));
      }
      return {
        eventId: event.id,
        mode: 'durable_relevance_router',
        recipientAgentSessionIds: unique(targets.map((target) => target.agentSessionId)),
      };
    },
  });
  await bus.publish({
    id: normalized.id,
    projectId: project.id,
    eventType: coordinationInput.eventType,
    payload: {
      displayCallsign: null,
      actorType: 'adapter',
      actorId: coordinationInput.actorId,
      details: coordinationInput.details,
      evidenceRefs: coordinationInput.evidenceRefs,
    },
  });
  if (!storedEvent) throw new Error('runtime_observation_event_not_persisted');
  return {
    observation: {
      id: normalized.id,
      schemaVersion: normalized.schemaVersion,
      eventType: normalized.eventType,
      producer: normalized.producer,
      occurredAt: normalized.occurredAt,
      references: normalized.payload.references,
      fact: normalized.payload.fact,
      evidenceRefs: normalized.payload.evidenceRefs,
    },
    event: eventProjection(storedEvent),
    notifiedAgentSessionIds: storedInboxItems.map((item) => item.agentSessionId),
    inboxItems: storedInboxItems,
  };
}

export async function recordAgentProjectObservation(workspaceSlug, sessionId, agentAccessToken, body = {}, options = {}) {
  const authority = await requireAgentTokenAuthority(workspaceSlug, sessionId, agentAccessToken, {
    requiredCapability: 'codesite.observations.write',
    now: options.now,
  });
  const session = authority.session;
  if (Buffer.byteLength(JSON.stringify(body ?? {}), 'utf8') > MAX_OBSERVATION_BODY_BYTES) {
    throw badRequest('observation_payload_too_large', { maxBytes: MAX_OBSERVATION_BODY_BYTES });
  }
  const normalized = normalizeProjectObservation({
    ...body,
    projectId: session.projectId,
  });
  if (normalized.payload.references.agentSessionIds.length
    && !normalized.payload.references.agentSessionIds.includes(session.id)) {
    throw forbidden('observation_agent_session_mismatch');
  }
  if (normalized.payload.providerSessionBound && !session.providerSessionRef) {
    throw badRequest('observation_provider_binding_unavailable');
  }
  const coordinationInput = buildObservationCoordinationInput(normalized, {
    actorId: session.terminalSessionId || session.runtimeSessionId || session.id,
  });
  if (!coordinationInput) throw badRequest('observation_coordination_unmappable');

  let storedEvent = null;
  const bus = createProjectCoordinationBus({
    normalize: async () => ({
      id: normalized.id,
      projectId: session.projectId,
      eventType: coordinationInput.eventType,
      payload: {
        displayCallsign: session.displayCallsign || null,
        actorType: coordinationInput.actorType,
        actorId: coordinationInput.actorId,
        details: coordinationInput.details,
        evidenceRefs: coordinationInput.evidenceRefs,
      },
    }),
    redact: async (event) => event,
    classify: async (event) => ({
      ...event,
      classification: {
        class: event.eventType,
        redactionClass: 'project_fact',
      },
    }),
    correlate: async (event) => ({
      ...event,
      correlation: {
        observationId: normalized.id,
        producer: normalized.producer,
        references: normalized.payload.references,
        targetTransactionIds: normalized.payload.references.transactionIds,
        targetAgentSessionIds: normalized.payload.references.agentSessionIds,
      },
    }),
    authorize: async (event) => {
      const transactionIds = normalized.payload.references.transactionIds;
      const ownerSessionIds = new Set();
      if (transactionIds.length) {
        const ownedTransactions = await prisma.codeSiteMutationTransaction.findMany({
          where: {
            projectId: session.projectId,
            id: { in: transactionIds },
            status: { in: ['open', 'prepared', 'blocked', 'validated'] },
          },
          select: { id: true, agentSessionId: true },
        });
        const knownTransactionIds = new Set(ownedTransactions.map((transaction) => transaction.id));
        for (const transaction of ownedTransactions) {
          if (transaction.agentSessionId) ownerSessionIds.add(transaction.agentSessionId);
        }
        if (knownTransactionIds.size !== transactionIds.length) {
          throw coordinationStageError('observation_transaction_outside_project', transactionIds);
        }
      }
      return {
        allowed: event.projectId === session.projectId,
        recipients: unique([
          ...normalized.payload.references.agentSessionIds,
          ...ownerSessionIds,
        ]),
      };
    },
    persist: async (event) => {
      storedEvent = await recordEventWithClient(prisma, session.projectId, {
        id: event.id,
        mutationLeaseId: coordinationInput.mutationLeaseId,
        eventType: event.eventType,
        displayCallsign: event.payload.displayCallsign,
        actorType: event.payload.actorType,
        actorId: event.payload.actorId,
        details: event.payload.details,
        evidenceRefs: event.payload.evidenceRefs,
      }, { syncArtifacts: false });
      return {
        ...event,
        persisted: {
          id: storedEvent.id,
          logicalTime: storedEvent.logicalTime ?? null,
          createdAt: storedEvent.createdAt instanceof Date
            ? storedEvent.createdAt.toISOString()
            : String(storedEvent.createdAt || ''),
        },
      };
    },
    route: async (event, { authorization }) => ({
      eventId: event.id,
      mode: 'durable_relevance_router',
      recipientAgentSessionIds: authorization.recipients,
    }),
  });
  await bus.publish({
    id: normalized.id,
    projectId: session.projectId,
    eventType: coordinationInput.eventType,
    payload: {
      displayCallsign: session.displayCallsign || null,
      actorType: coordinationInput.actorType,
      actorId: coordinationInput.actorId,
      details: coordinationInput.details,
      evidenceRefs: coordinationInput.evidenceRefs,
    },
  });
  if (!storedEvent) throw new Error('observation_event_not_persisted');
  return {
    observation: {
      id: normalized.id,
      schemaVersion: normalized.schemaVersion,
      eventType: normalized.eventType,
      producer: normalized.producer,
      occurredAt: normalized.occurredAt,
      references: normalized.payload.references,
      fact: normalized.payload.fact,
      evidenceRefs: normalized.payload.evidenceRefs,
    },
    event: eventProjection(storedEvent),
  };
}

export async function getAgentSharedKnowledge(workspaceSlug, sessionId, agentAccessToken, query = {}) {
  const { session } = await requireAgentTokenAuthority(workspaceSlug, sessionId, agentAccessToken, {
    requiredCapability: 'codesite.knowledge.read',
  });
  return loadRelevantKnowledgeForSession(session, query);
}

export async function listProjectKnowledge(workspaceSlug, projectId, query = {}, actor = null) {
  const project = await requireProject(workspaceSlug, projectId, actor, 'read');
  const normalized = validateKnowledgeQuery(query);
  const rows = await prisma.codeSiteKnowledgeItem.findMany({
    where: knowledgeWhere(project.id, normalized),
    include: { references: true },
    orderBy: { updatedAt: 'desc' },
    take: normalized.limit,
  });
  const userId = actorUserId(actor);
  return rows.filter((row) => {
    const visibility = knowledgeVisibility(row);
    if (visibility === 'project') return true;
    return Boolean(userId && (row.createdByUserId === userId || row.ownerUserId === userId));
  }).map(projectKnowledgeRecord).filter(Boolean);
}

export async function respondToAgentKnowledgeInbox(
  workspaceSlug,
  sessionId,
  inboxItemId,
  agentAccessToken,
  body = {},
) {
  const authority = await requireAgentTokenAuthority(workspaceSlug, sessionId, agentAccessToken, {
    requiredCapability: 'codesite.inbox.respond',
  });
  const inboxItem = await prisma.codeSiteAgentInboxItem.findFirst({
    where: {
      id: inboxItemId,
      projectId: authority.session.projectId,
      agentSessionId: authority.session.id,
    },
    include: { knowledgeItem: { include: { references: true } } },
  });
  if (!inboxItem || !inboxItem.knowledgeItem) throw notFound('knowledge_inbox_item_not_found');
  const response = validateKnowledgeResponse(inboxItem.knowledgeItem.kind, body);
  if (inboxItem.respondedAt) {
    const previous = parseJson(inboxItem.responseJson, {});
    if (inboxItem.responseAction === response.action && stableJson(previous) === stableJson(response)) {
      return {
        inboxItem: inboxProjection(inboxItem),
        knowledge: projectKnowledgeRecord(inboxItem.knowledgeItem),
        response,
        duplicate: true,
      };
    }
    throw conflict('knowledge_inbox_already_responded', { inboxItemId });
  }
  const now = new Date();
  const updated = await prisma.$transaction(async (db) => {
    const nextInbox = await db.codeSiteAgentInboxItem.update({
      where: { id: inboxItem.id },
      data: {
        status: response.action === 'acknowledge' ? 'acknowledged' : 'responded',
        responseAction: response.action,
        responseJson: stringifyJson(response),
        respondedAt: now,
        acknowledgedAt: now,
      },
    });
    let nextKnowledge = inboxItem.knowledgeItem;
    if (response.targetStatus) {
      nextKnowledge = await db.codeSiteKnowledgeItem.update({
        where: { id: inboxItem.knowledgeItem.id },
        data: {
          status: response.targetStatus,
          ...(response.targetStatus === 'resolved' ? { resolvedAt: now } : {}),
          ...(inboxItem.knowledgeItem.kind === 'lead' && response.action === 'claim'
            ? { ownerAgentSessionId: authority.session.id, ownerUserId: authority.session.ownerUserId }
            : {}),
          ...(inboxItem.knowledgeItem.kind === 'handoff' && response.action === 'accept'
            ? { ownerAgentSessionId: authority.session.id, ownerUserId: authority.session.ownerUserId }
            : {}),
        },
      });
    }
    const event = await recordEventWithClient(db, authority.session.projectId, {
      eventType: knowledgeResponseEventType(inboxItem.knowledgeItem.kind, response.action),
      displayCallsign: authority.session.displayCallsign,
      actorType: 'agent_session',
      actorId: authority.session.id,
      evidenceRefs: response.evidenceRefs,
      details: {
        inboxItemId: inboxItem.id,
        knowledgeItemId: inboxItem.knowledgeItem.id,
        kind: inboxItem.knowledgeItem.kind,
        action: response.action,
        reason: response.reason,
        targetStatus: response.targetStatus,
      },
    }, { syncArtifacts: false });
    return { nextInbox, nextKnowledge, event };
  });
  await syncArtifactsForProject(authority.session.projectId, {
    reason: 'knowledge_inbox_responded',
    eventId: updated.event.id,
  });
  return {
    inboxItem: inboxProjection(updated.nextInbox),
    knowledge: projectKnowledgeRecord({
      ...inboxItem.knowledgeItem,
      ...updated.nextKnowledge,
      references: inboxItem.knowledgeItem.references,
    }),
    response,
    event: eventProjection(updated.event),
    duplicate: false,
  };
}

function nextCallsign(provider) {
  const prefix = String(provider || 'AGENT').replace(/[^a-z0-9]/gi, '').slice(0, 6) || 'AGENT';
  return `${prefix}-${Math.floor(10 + Math.random() * 89)}`;
}

function defaultRedactionPolicy() {
  return {
    acceptsTowerMessages: true,
    redactSecrets: true,
    redactPrivatePrompts: true,
    allowAttachments: false,
    visibleZones: ['**'],
    allowedDocumentKinds: [
      'rfi',
      'change_order',
      'inspection_request',
      'inspection_result',
      'mayday',
      'handoff',
      'stop_work',
      'punch',
      'tower_instruction',
    ],
  };
}

export async function createExecutionPlan(workspaceSlug, projectId, body = {}, actor = null) {
  const project = await requireProject(workspaceSlug, projectId, actor, 'write');
  const agentSession = await requireAgentSession(project.id, body.agentSessionId || body.agent_session_id);
  requireAgentSessionOwnerAccess(agentSession, actor, 'execution_plan_agent_forbidden');
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

export async function createAgentExecutionPlan(workspaceSlug, sessionId, agentAccessToken, body = {}, options = {}) {
  const authority = await requireAgentTokenAuthority(workspaceSlug, sessionId, agentAccessToken, {
    requiredCapability: 'codesite.plans.write',
    now: options.now,
  });
  const session = authority.session;
  const requestedSessionId = String(body.agentSessionId || body.agent_session_id || '').trim();
  if (requestedSessionId && requestedSessionId !== session.id) {
    throw forbidden('execution_plan_agent_forbidden');
  }
  // direct_preferred fast lane: filing a plan auto-opens channels to peers in
  // the same shared session (docs/CHANNEL_MODES_TRADEOFFS.md Mode 3). Failures
  // here never block the plan itself â€” channels are an optimization.
  try {
    await autoOpenDirectChannels(workspaceSlug, session);
  } catch (err) {
    console.error('[codesite] auto-open failed', err);
  }
  return createExecutionPlan(workspaceSlug, session.projectId, {
    ...body,
    agentSessionId: session.id,
    displayCallsign: session.displayCallsign,
  }, { internalService: true, bypass: true, agentOwnerUserId: session.ownerUserId });
}

export async function requestAgentMutationLease(workspaceSlug, sessionId, agentAccessToken, body = {}, options = {}) {
  const authority = await requireAgentTokenAuthority(workspaceSlug, sessionId, agentAccessToken, {
    requiredCapability: 'codesite.plans.write',
    now: options.now,
  });
  const session = authority.session;
  const executionPlanId = String(body.executionPlanId || body.execution_plan_id || '').trim();
  if (!executionPlanId) throw badRequest('execution_plan_required');
  return requestMutationLease(workspaceSlug, executionPlanId, body, {
    internalService: true,
    bypass: true,
    agentOwnerUserId: session.ownerUserId,
  });
}

export async function openAgentTransaction(workspaceSlug, sessionId, agentAccessToken, body = {}, options = {}) {
  const authority = await requireAgentTokenAuthority(workspaceSlug, sessionId, agentAccessToken, {
    requiredCapability: 'codesite.plans.write',
    now: options.now,
  });
  const session = authority.session;
  const mutationLeaseId = String(body.mutationLeaseId || body.mutation_lease_id || '').trim();
  if (!mutationLeaseId) throw badRequest('mutation_lease_required');
  // Â§9.5 negative: an agent may only open transactions on leases that belong
  // to its OWN agent session. Verify ownership explicitly instead of relying
  // on the blanket bypass actor.
  const lease = await prisma.codeSiteMutationLease.findFirst({
    where: {
      id: mutationLeaseId,
      project: { workspaceSlug },
      agentSessionId: session.id,
    },
    select: { id: true },
  });
  if (!lease) throw forbidden('mutation_lease_agent_forbidden', { mutationLeaseId });
  return openTransaction(workspaceSlug, mutationLeaseId, body, {
    internalService: true,
    bypass: true,
    agentOwnerUserId: session.ownerUserId,
  });
}

export async function recordAgentTransactionWrite(workspaceSlug, sessionId, agentAccessToken, transactionId, body = {}, options = {}) {
  const authority = await requireAgentTokenAuthority(workspaceSlug, sessionId, agentAccessToken, {
    requiredCapability: 'codesite.plans.write', now: options.now,
  });
  const transaction = await prisma.codeSiteMutationTransaction.findFirst({
    where: { id: transactionId, project: { workspaceSlug }, agentSessionId: authority.session.id },
    select: { id: true },
  });
  if (!transaction) throw forbidden('transaction_agent_forbidden', { transactionId });
  return recordTransactionWrite(workspaceSlug, transactionId, body, {
    internalService: true, bypass: true, agentOwnerUserId: authority.session.ownerUserId,
  });
}

export async function commitAgentTransaction(workspaceSlug, sessionId, agentAccessToken, transactionId, body = {}, options = {}) {
  const authority = await requireAgentTokenAuthority(workspaceSlug, sessionId, agentAccessToken, {
    requiredCapability: 'codesite.plans.write', now: options.now,
  });
  const transaction = await prisma.codeSiteMutationTransaction.findFirst({
    where: { id: transactionId, project: { workspaceSlug }, agentSessionId: authority.session.id },
    select: { id: true },
  });
  if (!transaction) throw forbidden('transaction_agent_forbidden', { transactionId });
  return commitTransaction(workspaceSlug, transactionId, body, {
    internalService: true, bypass: true, agentOwnerUserId: authority.session.ownerUserId,
  });
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

export async function requestMutationLease(workspaceSlug, executionPlanId, body = {}, actor = null) {
  const plan = await prisma.codeSiteExecutionPlan.findFirst({
    where: { id: executionPlanId, project: { workspaceSlug } },
    include: { project: true, agentSession: true },
  });
  if (!plan) throw notFound('execution_plan_not_found');
  requireAgentSessionOwnerAccess(plan.agentSession, actor, 'mutation_lease_agent_forbidden');
  return requestMutationLeaseForPlan(workspaceSlug, plan, body, actor);
}

async function requestMutationLeaseForPlan(workspaceSlug, plan, body = {}, actor = null) {
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
  await recordEvent(plan.projectId, {
    eventType: 'clearance_requested',
    displayCallsign: plan.displayCallsign,
    actorType: 'agent_session',
    actorId: plan.agentSessionId,
    details: {
      executionPlanId: plan.id,
      requestedLease,
      route: executionPlan.route,
      blockedZones: executionPlan.blockedZones,
    },
  });
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
  const collisionAvoidance = await collisionAvoidanceForLeaseRequest({
    projectId: plan.projectId,
    executionPlan,
    requestedLease,
    zonePolicy,
  });
  const counterfactualPolicy = await counterfactualPolicyGateForLeaseRequest({
    workspaceSlug,
    executionPlan,
    requestedLease,
    zonePolicy,
    collisionAvoidance,
  });
  const pilotLicenseHealth = await pilotLicenseHealthForLeaseRequest({
    workspaceSlug,
    plan,
    executionPlan,
    requestedLease,
    zonePolicy,
    dojoProof,
  });
  const governancePolicy = await governancePolicyGateForLeaseRequest({
    projectId: plan.projectId,
    executionPlan,
    requestedLease,
    zonePolicy,
    body,
  });
  const clearancePolicy = applyGovernancePolicyGate(
    applyCounterfactualPolicyGate(
      applyPilotLicenseHealthGate(
        applyTowerCollisionGate(applyDojoClearanceGate(policy, dojoProof), collisionAvoidance),
        pilotLicenseHealth,
      ),
      counterfactualPolicy,
    ),
    governancePolicy,
  );
  const finalRequestedLease = {
    ...requestedLease,
    requiredRadar: unique([
      ...asArray(requestedLease.requiredRadar),
      ...asArray(counterfactualPolicy.requiredRadar),
      ...asArray(governancePolicy.requiredRadar),
    ]),
  };
  const lease = await prisma.codeSiteMutationLease.create({
    data: {
      projectId: plan.projectId,
      executionPlanId: plan.id,
      agentSessionId: plan.agentSessionId,
      displayCallsign: plan.displayCallsign,
      status: clearancePolicy.status,
      leaseJson: stringifyJson({
        ...finalRequestedLease,
        issuedBy: 'codesite_policy_engine',
        towerInstruction: clearancePolicy.towerInstruction,
        inspectedZones: clearancePolicy.inspectedZones,
        dojoProofVerification: dojoProofSummary.verification,
        pilotLicenseHealth: clearancePolicy.pilotLicenseHealth || pilotLicenseHealth || null,
        pilotLicenseRequirement: clearancePolicy.pilotLicenseRequirement || null,
        collisionAvoidance: clearancePolicy.collisionAvoidance || null,
        counterfactualPolicy: counterfactualPolicy.appliedPolicyDeltas.length ? counterfactualPolicy : null,
        governancePolicy: governancePolicy.required ? governancePolicy : null,
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
    input: {
      executionPlan,
      requestedLease: finalRequestedLease,
      dojoProof: dojoProofSummary,
      pilotLicenseHealth: clearancePolicy.pilotLicenseHealth || pilotLicenseHealth || null,
      governancePolicy: governancePolicy.required ? governancePolicy : null,
    },
    decisionJson: {
      status: clearancePolicy.status,
      towerInstruction: clearancePolicy.towerInstruction,
      inspectedZones: clearancePolicy.inspectedZones,
      dojoProof: dojoProofSummary,
      pilotLicenseHealth: clearancePolicy.pilotLicenseHealth || pilotLicenseHealth || null,
      pilotLicenseRequirement: clearancePolicy.pilotLicenseRequirement || null,
      collisionAvoidance: clearancePolicy.collisionAvoidance || null,
      counterfactualPolicy: counterfactualPolicy.appliedPolicyDeltas.length ? counterfactualPolicy : null,
      governancePolicy: governancePolicy.required ? governancePolicy : null,
    },
  });
  await recordEvent(plan.projectId, {
    mutationLeaseId: lease.id,
    eventType: clearancePolicy.status === 'active' ? 'clearance_issued' : 'holding_pattern',
    displayCallsign: lease.displayCallsign,
    actorType: 'policy_engine',
    actorId: decision.id,
    details: {
      mutationLeaseId: lease.id,
      policyDecisionId: decision.id,
      status: clearancePolicy.status,
      reasonCodes: clearancePolicy.reasonCodes,
      towerInstruction: clearancePolicy.towerInstruction,
      pilotLicenseHealth: clearancePolicy.pilotLicenseHealth || pilotLicenseHealth || null,
      pilotLicenseRequirement: clearancePolicy.pilotLicenseRequirement || null,
      collisionAvoidance: clearancePolicy.collisionAvoidance || null,
      counterfactualPolicy: counterfactualPolicy.appliedPolicyDeltas.length ? counterfactualPolicy : null,
      governancePolicy: governancePolicy.required ? governancePolicy : null,
    },
  });
  if (clearancePolicy.collisionAvoidance) {
    await recordEvent(plan.projectId, {
      mutationLeaseId: lease.id,
      eventType: 'near_miss',
      displayCallsign: lease.displayCallsign,
      actorType: 'policy_engine',
      actorId: decision.id,
      evidenceRefs: [`codesite:policy-decision:${decision.id}`],
      details: {
        mutationLeaseId: lease.id,
        policyDecisionId: decision.id,
        prevented: true,
        collisionAvoidance: clearancePolicy.collisionAvoidance,
      },
    });
  }
  return mutationLeaseProjection(lease, { policyDecision: policyDecisionProjection(decision) });
}

async function pilotLicenseHealthForLeaseRequest({
  workspaceSlug,
  plan,
  executionPlan,
  requestedLease,
  zonePolicy,
  dojoProof,
}) {
  const project = await prisma.codeSiteProject.findUnique({
    where: { id: plan.projectId },
    include: PROJECT_INCLUDE,
  });
  const healthProject = project || {
    ...plan.project,
    id: plan.projectId,
    workspaceSlug,
    zonePolicyJson: plan.project?.zonePolicyJson || stringifyJson(zonePolicy),
    agentSessions: [plan.agentSession].filter(Boolean),
    executionPlans: [plan].filter(Boolean),
    mutationLeases: [],
    policyDecisions: [],
    events: [],
    inspectionRuns: [],
    incidents: [],
  };
  return buildPilotLicenseHealthForClearance({
    ...healthProject,
    workspaceSlug: healthProject.workspaceSlug || workspaceSlug,
    zonePolicy,
    zonePolicyJson: healthProject.zonePolicyJson || stringifyJson(zonePolicy),
  }, {
    agentSession: plan.agentSession,
    executionPlan,
    requestedLease,
    dojoProof,
  });
}

async function collisionAvoidanceForLeaseRequest({ projectId, executionPlan, requestedLease, zonePolicy }) {
  const otherPlans = await prisma.codeSiteExecutionPlan.findMany({
    where: {
      projectId,
      id: { not: executionPlan.id },
      status: { in: ACTIVE_FLIGHT_STATUSES },
    },
  });
  const activeLeases = await prisma.codeSiteMutationLease.findMany({
    where: { projectId, status: 'active' },
  });
  const requestedPlan = {
    ...executionPlan,
    route: pathsForRoute(requestedLease.allowedPaths || executionPlan.route),
  };
  const forecast = predictCollisions({
    executionPlans: [requestedPlan, ...otherPlans.map(executionPlanProjection)],
    leases: activeLeases.map((lease) => mutationLeaseProjection(lease)),
    zonePolicy,
  });
  const currentCallsign = requestedPlan.displayCallsign;
  const risk = asArray(forecast.risks)
    .filter((item) => asArray(item.aircraft).includes(currentCallsign))
    .find((item) => item.severity === 'high');
  if (!risk) return { forecast, risk: null };
  if (schemaFirstLeaderForRisk(requestedPlan, risk)) {
    return {
      forecast,
      risk: null,
      schemaFirstLeader: true,
      reasonCodes: ['schema_first_leader_clearance'],
      towerInstruction: `Schema-first clearance issued for ${currentCallsign}. Dependent overlapping flights remain in holding until this contract lands.`,
    };
  }
  return {
    forecast,
    risk,
    decision: 'hold',
    status: 'holding',
    reasonCodes: unique(['collision_avoidance_hold', risk.risk, `${risk.recommendedResolution?.action || 'tower_sequence'}_recommended`]),
    towerInstruction: towerCollisionInstruction(risk),
  };
}

function applyTowerCollisionGate(policy, collisionAvoidance = null) {
  if (collisionAvoidance?.schemaFirstLeader && policy.decision !== 'block') {
    return {
      ...policy,
      reasonCodes: unique([...policy.reasonCodes, ...collisionAvoidance.reasonCodes]),
      towerInstruction: collisionAvoidance.towerInstruction || policy.towerInstruction,
      collisionAvoidance,
    };
  }
  if (!collisionAvoidance?.risk || policy.decision === 'block') return policy;
  return {
    ...policy,
    decision: collisionAvoidance.decision,
    status: collisionAvoidance.status,
    reasonCodes: unique([...policy.reasonCodes, ...collisionAvoidance.reasonCodes]),
    towerInstruction: collisionAvoidance.towerInstruction,
    collisionAvoidance,
  };
}

function schemaFirstLeaderForRisk(plan, risk) {
  if (risk?.recommendedResolution?.action !== 'schema_first') return false;
  const declaredIntent = [
    plan?.domain,
    plan?.mission,
    plan?.displayCallsign,
  ].join(' ').toLowerCase();
  if (declaredIntent.trim()) {
    return /\b(schema|contract|openapi|prisma)\b|^schema-/.test(declaredIntent);
  }
  const routeIntent = pathsForRoute(plan?.route).join(' ').toLowerCase();
  return /\b(schema|contract|openapi|prisma)\b|packages\/schemas/.test(routeIntent);
}

function towerCollisionInstruction(risk) {
  const action = risk.recommendedResolution?.action || 'sequence_flights';
  const aircraft = asArray(risk.aircraft).filter(Boolean).join(' and ') || 'affected flights';
  return `Hold position: ${risk.risk} risk in ${risk.conflictZone}. Tower recommends ${action} for ${aircraft}.`;
}

async function counterfactualPolicyGateForLeaseRequest({ workspaceSlug, executionPlan, requestedLease, zonePolicy, collisionAvoidance }) {
  const learnedDeltas = await promotedPolicyDeltasForWorkspace(workspaceSlug);
  if (!learnedDeltas.length) {
    return emptyCounterfactualPolicyGate();
  }
  const route = pathsForRoute(requestedLease.allowedPaths || executionPlan.route);
  const semanticGraph = zonePolicy?.semanticGraph || zonePolicy?.repoSignals || {};
  const footprint = towerRouteFootprint({
    plan: { ...executionPlan, route },
    zonePolicy,
    semanticGraph,
    priorIncidents: [],
    inspectionRuns: [],
  });
  const collisionRisks = asArray(collisionAvoidance?.risks || collisionAvoidance?.risk)
    .map((risk) => (typeof risk === 'string' ? { risk } : risk))
    .filter(Boolean);
  const signals = {
    footprints: [footprint],
    forecast: { risks: collisionRisks },
    migrationLocks: asArray(semanticGraph.migrationLocks).filter((lock) =>
      route.some((pattern) => towerPathsOverlap(lock, pattern))),
    packageExports: footprint.packageExports,
  };
  const applied = [];
  const requiredRadar = [];
  const requiredTowerActions = [];
  for (const delta of learnedDeltas) {
    if (!learnedPolicyDeltaApplies(delta, signals)) continue;
    const candidate = delta.ruleCandidate || {};
    applied.push(delta);
    requiredRadar.push(...asArray(candidate.requiredRadar || candidate.required_radar || candidate.radar));
    requiredTowerActions.push(...asArray(candidate.requiredTowerActions || candidate.required_tower_actions || candidate.actions));
  }
  const hold = applied.some((delta) => learnedPolicyDeltaHoldsLease(delta));
  return {
    appliedPolicyDeltas: applied.map((delta) => delta.id).filter(Boolean),
    reasonCodes: unique([
      ...(applied.length ? ['counterfactual_policy_delta_applied'] : []),
      ...(hold ? ['counterfactual_policy_delta_hold'] : []),
    ]),
    requiredRadar: unique(requiredRadar.map(String).filter(Boolean)),
    requiredTowerActions: unique(requiredTowerActions.map(String).filter(Boolean)),
    status: hold ? 'holding' : null,
    decision: hold ? 'hold' : null,
    towerInstruction: hold
      ? `Hold position: learned counterfactual policy requires tower sequencing for ${route.join(', ')}.`
      : null,
  };
}

function emptyCounterfactualPolicyGate() {
  return {
    appliedPolicyDeltas: [],
    reasonCodes: [],
    requiredRadar: [],
    requiredTowerActions: [],
    status: null,
    decision: null,
    towerInstruction: null,
  };
}

function applyCounterfactualPolicyGate(policy, counterfactualPolicy = {}) {
  if (policy.decision === 'block' || !asArray(counterfactualPolicy.appliedPolicyDeltas).length) return policy;
  const reasonCodes = unique([
    ...asArray(policy.reasonCodes),
    ...asArray(counterfactualPolicy.reasonCodes),
  ]);
  const towerInstruction = counterfactualPolicy.towerInstruction || policy.towerInstruction;
  if (counterfactualPolicy.decision === 'hold') {
    return {
      ...policy,
      decision: 'hold',
      status: 'holding',
      reasonCodes,
      towerInstruction,
      counterfactualPolicy,
    };
  }
  return {
    ...policy,
    reasonCodes,
    towerInstruction,
    counterfactualPolicy,
  };
}

async function governancePolicyGateForLeaseRequest({
  projectId,
  executionPlan,
  requestedLease,
  zonePolicy,
  body = {},
}) {
  const route = pathsForRoute(requestedLease.allowedPaths || requestedLease.route || executionPlan?.route);
  const restrictedZones = uniqueById(route
    .map((pathValue) => classifyPath(samplePathForGovernancePattern(pathValue), zonePolicy))
    .filter((zone) => ['A', 'B'].includes(String(zone?.class || '').toUpperCase()))
    .map((zone) => ({
      zoneKey: zone.zoneKey,
      label: zone.label,
      class: String(zone.class || '').toUpperCase(),
      path: zone.path,
    })));
  if (!restrictedZones.length) {
    return emptyGovernancePolicyGate();
  }

  const permitIds = unique(asArray(body.permitId || body.permit_id || body.permitIds || body.permit_ids).filter(Boolean));
  const documentIds = unique(asArray(body.documentId || body.document_id || body.documentIds || body.document_ids).filter(Boolean));
  const routeRevisionIds = unique(asArray(body.routeRevisionId || body.route_revision_id || body.routeRevisionIds || body.route_revision_ids).filter(Boolean));
  const [permits, routeRevisions, documents] = await Promise.all([
    prisma.codeSitePermit.findMany({
      where: {
        projectId,
        status: { in: [...GOVERNANCE_APPROVED_PERMIT_STATUSES] },
      },
      orderBy: { issuedAt: 'desc' },
    }),
    prisma.codeSiteRouteRevision.findMany({
      where: {
        projectId,
        status: { in: [...GOVERNANCE_APPROVED_ROUTE_REVISION_STATUSES] },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.codeSiteDocument.findMany({
      where: {
        projectId,
        kind: { in: [...GOVERNANCE_DOCUMENT_KINDS] },
        status: { in: [...GOVERNANCE_APPROVED_DOCUMENT_STATUSES] },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const matchingPermits = permits.filter((permit) =>
    governancePermitCoversLease(permit, { executionPlan, route, permitIds }));
  const matchingRouteRevisions = routeRevisions.filter((revision) =>
    governanceRouteRevisionCoversLease(revision, { executionPlan, route, routeRevisionIds }));
  const matchingDocuments = documents.filter((document) =>
    governanceDocumentCoversLease(document, { executionPlan, route, documentIds }));
  const evidence = {
    permits: matchingPermits.map((permit) => ({
      id: permit.id,
      permitType: permit.permitType,
      status: permit.status,
      executionPlanId: permit.executionPlanId || parseJson(permit.scopeJson, {})?.executionPlanId || null,
      documentId: permit.documentId || null,
      evidenceRefs: parseJson(permit.evidenceRefsJson, []),
    })),
    routeRevisions: matchingRouteRevisions.map((revision) => ({
      id: revision.id,
      status: revision.status,
      executionPlanId: revision.executionPlanId,
      documentId: revision.documentId || null,
      evidenceRefs: parseJson(revision.evidenceRefsJson, []),
    })),
    documents: matchingDocuments.map((document) => ({
      id: document.id,
      kind: document.kind,
      status: document.status,
      evidenceRefs: parseJson(document.bodyJson, {})?.evidenceRefs || [],
    })),
  };
  const verified = evidence.permits.length > 0
    || evidence.routeRevisions.length > 0
    || evidence.documents.length > 0;
  if (verified) {
    return {
      required: true,
      verified: true,
      restrictedZones,
      evidence,
      requiredRadar: ['governance'],
      reasonCodes: ['governance_clearance_evidence_verified'],
      towerInstruction: null,
    };
  }
  return {
    required: true,
    verified: false,
    restrictedZones,
    evidence,
    requiredRadar: ['governance'],
    reasonCodes: ['governance_approval_required', 'governance_permit_or_change_order_required'],
    towerInstruction: `Hold position: ${restrictedZones.map((zone) => zone.zoneKey).join(', ')} requires an approved work permit, change order, or route revision before clearance.`,
  };
}

function emptyGovernancePolicyGate() {
  return {
    required: false,
    verified: true,
    restrictedZones: [],
    evidence: { permits: [], routeRevisions: [], documents: [] },
    requiredRadar: [],
    reasonCodes: [],
    towerInstruction: null,
  };
}

function applyGovernancePolicyGate(policy, governancePolicy = emptyGovernancePolicyGate()) {
  if (policy.decision === 'block' || !governancePolicy.required) return policy;
  const reasonCodes = unique([
    ...asArray(policy.reasonCodes),
    ...asArray(governancePolicy.reasonCodes),
  ]);
  if (governancePolicy.verified) {
    return {
      ...policy,
      reasonCodes,
      governancePolicy,
    };
  }
  return {
    ...policy,
    decision: 'hold',
    status: 'holding',
    reasonCodes,
    towerInstruction: governancePolicy.towerInstruction || policy.towerInstruction,
    governancePolicy,
  };
}

function governancePermitCoversLease(permit, { executionPlan, route, permitIds = [] }) {
  if (!GOVERNANCE_APPROVED_PERMIT_STATUSES.has(String(permit.status || '').toLowerCase())) return false;
  if (permitIds.length && !permitIds.includes(permit.id)) return false;
  const scope = parseJson(permit.scopeJson, {});
  const executionPlanRef = permit.executionPlanId || scope.executionPlanId || scope.execution_plan_id || null;
  const planMatches = executionPlanRef && executionPlanRef === executionPlan.id;
  if (executionPlanRef && !planMatches) return false;
  const permitRoute = pathsForRoute(scope.allowedPaths || scope.allowed_paths || scope.route || scope.paths || []);
  if (!permitRoute.length) return Boolean(planMatches || permitIds.includes(permit.id));
  return routeCoveredByGovernance(permitRoute, route);
}

function governanceRouteRevisionCoversLease(revision, { executionPlan, route, routeRevisionIds = [] }) {
  if (!GOVERNANCE_APPROVED_ROUTE_REVISION_STATUSES.has(String(revision.status || '').toLowerCase())) return false;
  if (routeRevisionIds.length && !routeRevisionIds.includes(revision.id)) return false;
  if (revision.executionPlanId && revision.executionPlanId !== executionPlan.id) return false;
  const revisionRoute = pathsForRoute(parseJson(revision.proposedRouteJson, []));
  return revisionRoute.length ? routeCoveredByGovernance(revisionRoute, route) : true;
}

function governanceDocumentCoversLease(document, { executionPlan, route, documentIds = [] }) {
  if (!GOVERNANCE_DOCUMENT_KINDS.has(String(document.kind || '').toLowerCase())) return false;
  if (!GOVERNANCE_APPROVED_DOCUMENT_STATUSES.has(String(document.status || '').toLowerCase())) return false;
  if (documentIds.length && !documentIds.includes(document.id)) return false;
  const body = parseJson(document.bodyJson, {});
  const executionPlanRef = body.executionPlanId || body.execution_plan_id || body.projectRefs?.executionPlanId || body.routing?.projectRefs?.executionPlanId || null;
  const planMatches = executionPlanRef && executionPlanRef === executionPlan.id;
  if (executionPlanRef && !planMatches) return false;
  const documentRoute = pathsForRoute(body.proposedRoute || body.proposed_route || body.allowedPaths || body.allowed_paths || body.route || body.paths || []);
  if (!documentRoute.length) return Boolean(planMatches || documentIds.includes(document.id));
  return routeCoveredByGovernance(documentRoute, route);
}

function routeCoveredByGovernance(governanceRoute = [], requestedRoute = []) {
  const normalizedGovernance = pathsForRoute(governanceRoute);
  const normalizedRequested = pathsForRoute(requestedRoute);
  if (!normalizedRequested.length) return false;
  return normalizedRequested.every((requested) =>
    normalizedGovernance.some((approved) => governancePatternsOverlap(approved, requested)));
}

function governancePatternsOverlap(left, right) {
  const leftPattern = String(left || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  const rightPattern = String(right || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!leftPattern || !rightPattern) return false;
  if (leftPattern === rightPattern) return true;
  const leftSample = samplePathForGovernancePattern(leftPattern);
  const rightSample = samplePathForGovernancePattern(rightPattern);
  return matchPathPattern(leftSample, rightPattern)
    || matchPathPattern(rightSample, leftPattern);
}

function samplePathForGovernancePattern(pattern) {
  return normalizePath(String(pattern || '')
    .replace(/\*\*/g, 'index')
    .replace(/\*/g, 'index')
    .replace(/\/index$/, '/index.ts')) || normalizePath(pattern);
}

function learnedPolicyDeltaHoldsLease(delta) {
  const candidate = delta.ruleCandidate || {};
  const text = learnedRuleText(candidate);
  const actions = asArray(candidate.requiredTowerActions || candidate.required_tower_actions || candidate.actions)
    .map((action) => String(action || '').toLowerCase());
  return candidate.hold === true
    || ['hold', 'holding'].includes(String(candidate.decision || candidate.enforcement || '').toLowerCase())
    || actions.some((action) => /(^|[_ -])(hold|wait|sequence|gate)([_ -]|$)/.test(action))
    || /(^|[_ -])(hold|wait|sequence|gate)([_ -]|$)/.test(text);
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

export async function revokeMutationLease(workspaceSlug, mutationLeaseId, body = {}, actor = null) {
  const lease = await requireLease(workspaceSlug, mutationLeaseId);
  requireLeaseActorAccess(lease, actor);
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

export async function recordPolicyDecision(workspaceSlug, mutationLeaseId, body = {}, actor = null) {
  const lease = await requireLease(workspaceSlug, mutationLeaseId);
  await requireProjectAccess(lease.project || await requireProject(workspaceSlug, lease.projectId), actor, 'write');
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

export async function openTransaction(workspaceSlug, mutationLeaseId, body = {}, actor = null) {
  const lease = await requireLease(workspaceSlug, mutationLeaseId);
  requireLeaseActorAccess(lease, actor);
  const transaction = await createMutationTransactionForLease(workspaceSlug, lease, body);
  return transactionProjection(transaction);
}

async function createMutationTransactionForLease(workspaceSlug, lease, body = {}) {
  if (lease.status !== 'active') {
    throw badRequest('clearance_not_active', { status: lease.status });
  }
  const leaseJson = parseJson(lease.leaseJson, {});
  const readSet = normalizePathList(body.readSet || body.read_set || []);
  const writeSet = normalizePathList(body.writeSet || body.write_set || []);
  const semanticDependencyRefs = body.semanticDependencyRefs || body.semantic_dependency_refs || [];
  const isolation = normalizeTransactionIsolation(body.isolation);
  const snapshotReadSet = serializableSnapshotReadSet(
    { isolation },
    readSet,
    [],
    dependencyPathRefs(semanticDependencyRefs),
  );
  const baseSnapshotEvidence = await buildTransactionSnapshotEvidence(
    usesSerializableIsolation({ isolation }) ? unique([...readSet, ...snapshotReadSet]) : readSet,
    {
      ...body,
      writeSet,
      scope: usesSerializableIsolation({ isolation }) ? 'repo_wide' : body.scope,
    },
  );
  const transaction = await prisma.codeSiteMutationTransaction.create({
    data: {
      projectId: lease.projectId,
      mutationLeaseId: lease.id,
      agentSessionId: lease.agentSessionId,
      baseSnapshot: body.baseSnapshot || body.base_snapshot || baseSnapshotEvidence?.snapshotDigest || digest({ workspaceSlug, mutationLeaseId: lease.id, openedAt: Date.now() }),
      baseSnapshotEvidenceJson: stringifyJson(baseSnapshotEvidence),
      isolation,
      status: 'open',
      readSetJson: stringifyJson(readSet),
      writeSetJson: stringifyJson(writeSet),
      observedReadSetJson: stringifyJson([]),
      observedWriteSetJson: stringifyJson([]),
      semanticDependencyRefsJson: stringifyJson(semanticDependencyRefs),
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
  if (baseSnapshotEvidence?.snapshotDigest) {
    await recordEvent(lease.projectId, {
      mutationLeaseId: lease.id,
      eventType: 'snapshot_taken',
      displayCallsign: lease.displayCallsign,
      actorType: 'transaction',
      actorId: transaction.id,
      evidenceRefs: [
        baseSnapshotEvidence.evidenceDigest && `codesite:read-snapshot:${baseSnapshotEvidence.evidenceDigest}`,
      ].filter(Boolean),
      details: {
        transactionId: transaction.id,
        baseSnapshot: transaction.baseSnapshot,
        snapshotDigest: baseSnapshotEvidence.snapshotDigest,
        evidenceDigest: baseSnapshotEvidence.evidenceDigest || null,
        status: baseSnapshotEvidence.status || 'recorded',
        readSet: normalizePathList(baseSnapshotEvidence.readSet || readSet),
        fileCount: asArray(baseSnapshotEvidence.fileDigests).length,
        missingPaths: asArray(baseSnapshotEvidence.missingPaths),
        reason: 'serializable_transaction_open',
      },
    });
  }
  return transaction;
}

export async function getTransaction(workspaceSlug, transactionId, actor = null) {
  const transaction = await prisma.codeSiteMutationTransaction.findFirst({
    where: { id: transactionId, project: { workspaceSlug } },
    include: { mutationLease: true, agentSession: true, proofBundles: true, lineProvenance: true },
  });
  if (!transaction) return null;
  requireTransactionActorAccess(transaction, actor);
  return transactionProjection(transaction);
}

const WORKSPACE_ACTIVE_TRANSACTION_STATUSES = ['open', 'validated', 'committing', 'blocked'];

export async function listActiveTransactions(workspaceSlug, actor = null) {
  const transactions = await prisma.codeSiteMutationTransaction.findMany({
    where: {
      project: { workspaceSlug },
      status: { in: WORKSPACE_ACTIVE_TRANSACTION_STATUSES },
    },
    include: {
      project: {
        include: {
          members: true,
          agentSessions: true,
        },
      },
      mutationLease: true,
      agentSession: true,
    },
    orderBy: { openedAt: 'desc' },
  });
  const visible = [];
  for (const transaction of transactions) {
    if (await actorCanAccessProject(transaction.project, actor, 'read')) {
      visible.push(activeTransactionProjection(transaction));
    }
  }
  return visible;
}

export async function getWorkspaceActiveState(workspaceSlug, actor = null) {
  const transactions = await prisma.codeSiteMutationTransaction.findMany({
    where: {
      project: { workspaceSlug },
      status: { in: WORKSPACE_ACTIVE_TRANSACTION_STATUSES },
    },
    include: {
      project: {
        include: {
          members: true,
          agentSessions: true,
        },
      },
      mutationLease: true,
      agentSession: true,
    },
    orderBy: { openedAt: 'desc' },
  });
  const visibleTransactions = [];
  const visibleProjectIds = new Set();
  for (const transaction of transactions) {
    if (await actorCanAccessProject(transaction.project, actor, 'read')) {
      visibleTransactions.push(activeTransactionProjection(transaction));
      visibleProjectIds.add(transaction.projectId);
    }
  }
  const activeLeases = [];
  if (visibleProjectIds.size) {
    const leases = await prisma.codeSiteMutationLease.findMany({
      where: {
        projectId: { in: [...visibleProjectIds] },
        status: 'active',
      },
      include: {
        project: {
          include: {
            members: true,
          },
        },
        agentSession: true,
        executionPlan: true,
      },
      orderBy: { issuedAt: 'desc' },
    });
    for (const lease of leases) {
      if (await actorCanAccessProject(lease.project, actor, 'read')) {
        activeLeases.push(mutationLeaseProjection(lease));
      }
    }
  }
  const zones = await prisma.codeSiteMutationZone.findMany({
    where: { workspaceSlug },
    orderBy: [{ zoneClass: 'asc' }, { zoneKey: 'asc' }],
  });
  const allowedPaths = unique(activeLeases.flatMap((lease) => leaseAuthorityAllowedPaths(lease)));
  const blockedPaths = unique(activeLeases.flatMap((lease) => leaseAuthorityBlockedPaths(lease)));
  const protectedZones = zones.map((zone) => ({
    id: zone.id,
    workspaceSlug: zone.workspaceSlug,
    zoneKey: zone.zoneKey,
    label: zone.label,
    class: zone.zoneClass,
    paths: parseJson(zone.pathsJson, []),
    rules: parseJson(zone.rulesJson, []),
    risk: zone.risk,
    createdAt: zone.createdAt,
    updatedAt: zone.updatedAt,
  }));
  const activeProjectIds = unique([
    ...visibleTransactions.map((transaction) => transaction.projectId),
    ...activeLeases.map((lease) => lease.projectId),
  ].filter(Boolean));
  return {
    workspaceSlug,
    generatedAt: new Date().toISOString(),
    active: visibleTransactions.length > 0,
    ambiguous: activeProjectIds.length > 1 || visibleTransactions.length > 1,
    activeProjectIds,
    activeTransactions: visibleTransactions,
    activeLeases,
    allowedPaths,
    blockedPaths,
    protectedZones,
  };
}

export async function recordTransactionRead(workspaceSlug, transactionId, body = {}, actor = null) {
  const transaction = await requireOpenTransaction(workspaceSlug, transactionId, actor);
  const path = normalizePath(body.path || body.filePath || body.file_path);
  if (!path) throw badRequest('invalid_path');
  const codesiteFsEvent = body.codesiteFsEvent || body.codesite_fs_event || null;
  const readEvidenceRefs = unique([
    ...asArray(body.evidenceRefs || body.evidence_refs),
    ...asArray(codesiteFsEvent?.evidence_refs || codesiteFsEvent?.evidenceRefs),
  ]);
  const processAncestry = unique([
    ...asArray(body.processAncestry || body.process_ancestry),
    ...asArray(codesiteFsEvent?.details?.process_ancestry || codesiteFsEvent?.details?.processAncestry),
  ]);
  const isCodeSiteFsRead = codesiteFsEvent?.type === 'read_observed';
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
    eventType: isCodeSiteFsRead ? 'read_observed' : 'transponder_update',
    displayCallsign: transaction.mutationLease.displayCallsign,
    actorType: isCodeSiteFsRead ? 'codesitefs' : 'transaction',
    actorId: transaction.id,
    evidenceRefs: readEvidenceRefs,
    details: {
      type: 'read_recorded',
      transactionId: transaction.id,
      path,
      tool: body.tool || codesiteFsEvent?.tool || 'file_read',
      codesiteFsEvent,
      processAncestry,
    },
  });
  return transactionProjection(updated);
}

export async function recordTransactionWrite(workspaceSlug, transactionId, body = {}, actor = null) {
  const transaction = await requireOpenTransaction(workspaceSlug, transactionId, actor);
  const path = normalizePath(body.path || body.filePath || body.file_path);
  if (!path) throw badRequest('invalid_path');
  const codesiteFsEvent = body.codesiteFsEvent || body.codesite_fs_event || null;
  const codesiteFsEventType = ['write_denied', 'write_quarantined'].includes(codesiteFsEvent?.type)
    ? codesiteFsEvent.type
    : null;
  const writeEvidence = writeEvidenceFromBody(body, path, codesiteFsEvent);
  const writeEvidenceRefs = asArray(writeEvidence.evidenceRefs);
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
    evidenceRefs: writeEvidenceRefs,
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
      evidenceRefs: writeEvidenceRefs,
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
      evidenceRefs: writeEvidenceRefs,
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
      evidenceRefs: writeEvidenceRefs,
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
  const allowedEvent = await recordEvent(transaction.projectId, {
    mutationLeaseId: transaction.mutationLeaseId,
    eventType: 'write_allowed',
    displayCallsign: transaction.mutationLease.displayCallsign,
    actorType: 'transaction',
    actorId: transaction.id,
    evidenceRefs: writeEvidenceRefs,
    details: {
      transactionId: transaction.id,
      path,
      zone: evaluation.zone,
      semanticDependencyRefs,
      invalidatedAssumptions: invalidated,
      ...writeEvidence,
    },
  });
  await persistAllowedWriteLineProvenance(transaction, allowedEvent, {
    ...writeEvidence,
    path,
  });
  return { ok: true, transaction: transactionProjection(updated), invalidatedAssumptions: invalidated };
}

const QUARANTINE_TRANSACTION_EVENT_TYPES = new Set([
  'quarantine_reviewed',
  'quarantine_replayed',
  'quarantine_applied',
]);

export async function recordTransactionQuarantineEvent(workspaceSlug, transactionId, body = {}, actor = null) {
  const transaction = await requireOpenTransaction(workspaceSlug, transactionId, actor);
  const eventType = String(body.eventType || body.event_type || '').trim();
  if (!QUARANTINE_TRANSACTION_EVENT_TYPES.has(eventType)) {
    throw badRequest('invalid_quarantine_event_type', {
      eventType: eventType || null,
      allowedEventTypes: [...QUARANTINE_TRANSACTION_EVENT_TYPES],
    });
  }
  const quarantineId = body.quarantineId || body.quarantine_id || null;
  const paths = asArray(body.paths || body.changedPaths || body.changed_paths)
    .map((item) => normalizePath(item))
    .filter(Boolean);
  const event = await recordEvent(transaction.projectId, {
    mutationLeaseId: transaction.mutationLeaseId,
    eventType,
    displayCallsign: transaction.mutationLease.displayCallsign,
    actorType: 'codesitefs',
    actorId: quarantineId || transaction.id,
    evidenceRefs: asArray(body.evidenceRefs || body.evidence_refs),
    details: {
      ...(body.details && typeof body.details === 'object' ? body.details : {}),
      transactionId: transaction.id,
      quarantineId,
      paths,
      rejected: asArray(body.rejected),
    },
  });
  return eventProjection(event);
}

export async function dryRunTransactionWrites(workspaceSlug, transactionId, body = {}, actor = null) {
  const transaction = await requireOpenTransaction(workspaceSlug, transactionId, actor);
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

export async function preflightCodeSiteFsWrite(workspaceSlug, projectId, body = {}, actor = null) {
  const project = await requireProject(workspaceSlug, projectId, actor, 'write');
  const path = normalizePath(body.path || body.filePath || body.file_path);
  if (!path) throw badRequest('invalid_path');
  const tool = body.tool || body.operation || body.source || 'file_write';
  const source = body.source || body.adapter || body.runtime || 'codesitefs';
  const requestedDisposition = body.disposition || body.type || body.eventType || body.event_type || null;
  const codesiteFsEvent = {
    type: requestedDisposition,
    source,
    operation: body.operation || 'write',
    path,
    details: body.details || {},
    evidence_refs: body.evidenceRefs || body.evidence_refs || [],
  };
  const writeEvidence = writeEvidenceFromBody(body, path, codesiteFsEvent);
  const evidenceRefs = asArray(writeEvidence.evidenceRefs);
  const zonePolicy = parseJson(project.zonePolicyJson, compileZonePolicy());
  const activeLeases = await prisma.codeSiteMutationLease.findMany({
    where: { projectId: project.id, status: 'active' },
    include: { agentSession: true },
    orderBy: { issuedAt: 'desc' },
  });
  const requestedLeaseId = body.mutationLeaseId || body.mutation_lease_id || null;
  const candidateLeases = requestedLeaseId
    ? [requireActiveCodeSiteFsLease(activeLeases, requestedLeaseId, actor)]
    : activeLeases.filter((lease) => actorCanUseLease(lease, actor));
  const evaluations = candidateLeases.map((lease) => ({
    lease,
    evaluation: evaluatePathMutation({ lease, path, tool, zonePolicy }),
  }));
  const match = evaluations.find((item) => item.evaluation.ok);
  const strongestBlock = chooseCodeSiteFsBlock(evaluations, path, zonePolicy);
  const forcedQuarantine = requestedDisposition === 'write_quarantined' || body.quarantine === true;
  const allowed = Boolean(match) && !forcedQuarantine && requestedDisposition !== 'write_denied';
  const disposition = allowed ? 'write_allowed' : (forcedQuarantine ? 'write_quarantined' : 'write_denied');
  const decision = await createPolicyDecision(project.id, {
    mutationLeaseId: match?.lease?.id || null,
    displayCallsign: match?.lease?.displayCallsign || body.displayCallsign || body.display_callsign || null,
    decision: allowed ? 'allow' : (disposition === 'write_quarantined' ? 'quarantine' : 'block'),
    reasonCodes: allowed ? match.evaluation.reasonCodes : strongestBlock.reasonCodes,
    input: {
      projectId,
      path,
      tool,
      source,
      requestedDisposition,
      activeLeaseIds: candidateLeases.map((lease) => lease.id),
    },
    decisionJson: {
      path,
      tool,
      source,
      zone: allowed ? match.evaluation.zone : strongestBlock.zone,
      matchedLeaseId: match?.lease?.id || null,
      inspectedLeases: evaluations.map((item) => ({
        mutationLeaseId: item.lease.id,
        displayCallsign: item.lease.displayCallsign,
        ok: item.evaluation.ok,
        reasonCodes: item.evaluation.reasonCodes,
      })),
      towerInstruction: allowed
        ? `Write preflight allowed for ${path}. Apply through the active transaction-aware adapter.`
        : `Write preflight blocked for ${path}. Request clearance or quarantine outside the real repo.`,
    },
  });
  await recordEvent(project.id, {
    mutationLeaseId: match?.lease?.id || null,
    eventType: disposition,
    displayCallsign: match?.lease?.displayCallsign || body.displayCallsign || body.display_callsign || null,
    actorType: 'codesitefs',
    actorId: decision.id,
    evidenceRefs,
    details: {
      projectId,
      path,
      tool,
      source,
      disposition,
      prevented: disposition !== 'write_allowed',
      reasonCodes: allowed ? match.evaluation.reasonCodes : strongestBlock.reasonCodes,
      policyDecisionId: decision.id,
      matchedLeaseId: match?.lease?.id || null,
      zone: allowed ? match.evaluation.zone : strongestBlock.zone,
      codesiteFsEvent,
      ...writeEvidence,
    },
  });
  return {
    ok: allowed,
    disposition,
    path,
    source,
    tool,
    matchedLease: match ? mutationLeaseProjection(match.lease) : null,
    policyDecision: policyDecisionProjection(decision),
    reasonCodes: allowed ? match.evaluation.reasonCodes : strongestBlock.reasonCodes,
  };
}

function requireActiveCodeSiteFsLease(activeLeases, requestedLeaseId, actor) {
  const lease = activeLeases.find((item) => item.id === requestedLeaseId);
  if (!lease) throw badRequest('mutation_lease_not_active', { mutationLeaseId: requestedLeaseId });
  requireLeaseActorAccess(lease, actor);
  return lease;
}

function actorCanUseLease(lease, actor = null) {
  if (!actor || actor.bypass) return true;
  return Boolean(actor.userId && lease.agentSession?.ownerUserId === actor.userId);
}

function chooseCodeSiteFsBlock(evaluations, path, zonePolicy) {
  if (!evaluations.length) {
    return {
      reasonCodes: ['active_clearance_required'],
      zone: classifyPath(path, zonePolicy),
    };
  }
  const noFly = evaluations.find((item) => item.evaluation.reasonCodes.includes('entered_no_fly_zone'));
  if (noFly) return noFly.evaluation;
  const outside = evaluations.find((item) => item.evaluation.reasonCodes.includes('outside_clearance_route'));
  if (outside) return outside.evaluation;
  return evaluations[0].evaluation;
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
  const changedLineRanges = strictLineProvenanceRows(
    body.changedLineRanges
      || body.changed_line_ranges
      || body.changedRanges
      || body.changed_ranges
      || codesiteFsEvent?.details?.changedLineRanges
      || codesiteFsEvent?.details?.changed_line_ranges,
    path,
  );
  const dojoSourceRefs = unique([
    ...asArray(body.dojoSourceRefs || body.dojo_source_refs),
    ...asArray(codesiteFsEvent?.details?.dojoSourceRefs || codesiteFsEvent?.details?.dojo_source_refs),
  ].filter(Boolean));
  return {
    ...(lineProvenance.length ? { lineProvenance } : {}),
    ...(changedLineRanges.length ? { changedLineRanges } : {}),
    ...(evidenceRefs.length ? { evidenceRefs } : {}),
    ...(dojoSourceRefs.length ? { dojoSourceRefs } : {}),
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
      source: item.source || item.diffSource || item.diff_source || null,
      reasonRef: item.reasonRef || item.reason_ref || null,
      evidenceRefs: asArray(item.evidenceRefs || item.evidence_refs),
      processAncestry: asArray(item.processAncestry || item.process_ancestry),
      dojoSourceRefs: asArray(item.dojoSourceRefs || item.dojo_source_refs),
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
    const invalidationEvent = await recordEvent(projectId, {
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
    await publishAssumptionInvalidationKnowledge(projectId, {
      assumption,
      path,
      semanticDependencyRefs,
      invalidatedBy,
      invalidationEvent,
    });
  }
  return invalidated;
}

async function publishAssumptionInvalidationKnowledge(projectId, {
  assumption,
  path,
  semanticDependencyRefs,
  invalidatedBy,
  invalidationEvent,
}) {
  const [sessions, executionPlans, transactions] = await Promise.all([
    prisma.codeSiteAgentSession.findMany({
      where: { projectId, endedAt: null, status: { in: ['attached', 'detached'] } },
    }),
    prisma.codeSiteExecutionPlan.findMany({
      where: { projectId, status: { in: ['filed', 'active', 'holding', 'blocked'] } },
    }),
    prisma.codeSiteMutationTransaction.findMany({
      where: { projectId, status: { in: ['open', 'prepared', 'blocked', 'validated'] } },
    }),
  ]);
  const usedBy = asArray(parseJson(assumption.usedByJson, []));
  const dependentTransactions = transactions.filter((transaction) => (
    transaction.agentSessionId === assumption.ownerSessionId
    || asArray(parseJson(transaction.assumptionRefsJson, [])).includes(assumption.id)
    || usedBy.includes(transaction.id)
  ));
  const contractRefs = unique(asArray(semanticDependencyRefs)
    .map((reference) => typeof reference === 'string' ? reference : reference?.ref || reference?.raw)
    .filter(Boolean));
  const agentSessionIds = unique([
    assumption.ownerSessionId,
    ...dependentTransactions.map((transaction) => transaction.agentSessionId),
  ].filter(Boolean));
  const references = {
    paths: path ? [path] : [],
    contracts: contractRefs,
    agentSessionIds,
    transactionIds: dependentTransactions.map((transaction) => transaction.id),
  };
  if (!Object.values(references).some((values) => values.length)) return null;
  const knowledgeInput = {
    kind: 'discovery',
    projectId,
    title: `Assumption invalidated: ${assumption.assumptionKey}`.slice(0, 160),
    summary: `Assumption ${assumption.assumptionKey} was invalidated by ${invalidatedBy}; affected work must refresh, rebase, or abort.`,
    status: 'verified',
    source: { actorType: 'system', actorId: assumption.id },
    references,
    evidenceRefs: [`event:${invalidationEvent.id}`],
    confidence: 1,
    verification: 'verified',
    tags: ['assumption', 'invalidation'],
  };
  const record = buildKnowledgeRecord(knowledgeInput, { projectId });
  const existing = await prisma.codeSiteKnowledgeItem.findFirst({
    where: { projectId, dedupeKey: record.data.dedupeKey },
    include: { references: true },
  });
  if (existing) return { knowledge: projectKnowledgeRecord(existing), duplicate: true, impacts: [] };
  const deliveryPlan = buildKnowledgeDeliveryPlan({
    item: { ...record.normalized, id: 'pending-assumption-invalidation' },
    sessions,
    executionPlans,
    transactions: dependentTransactions,
  });
  const result = await persistKnowledgeAndImpacts({ session: { projectId } }, record, deliveryPlan);
  await syncArtifactsForProject(projectId, {
    reason: 'assumption_invalidation_routed',
    eventId: result.event?.id,
  });
  return { ...result, duplicate: false };
}

function assumptionMatchesWrite({ dependsOn, usedBy, path, semanticDependencyRefs }) {
  void usedBy;
  if (dependsOn.some((item) => assumptionPathMatchesWrite(item, path))) return true;
  const writeSignals = normalizeSemanticRefs(semanticDependencyRefs);
  if (!writeSignals.length) return false;
  const assumptionSignals = normalizeSemanticRefs(dependsOn);
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

export async function recordAssumption(workspaceSlug, transactionId, body = {}, actor = null) {
  const transaction = await requireOpenTransaction(workspaceSlug, transactionId, actor);
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

export async function validateTransaction(workspaceSlug, transactionId, actor = null) {
  return validateTransactionWithClient(prisma, workspaceSlug, transactionId, actor);
}

async function validateTransactionWithClient(db, workspaceSlug, transactionId, actor = null, options = {}) {
  const transaction = await requireTransaction(workspaceSlug, transactionId, actor, db);
  const project = await db.codeSiteProject.findUnique({ where: { id: transaction.projectId } });
  const zonePolicy = parseJson(project.zonePolicyJson, compileZonePolicy());
  const writeSet = parseJson(transaction.writeSetJson, []);
  const observedWriteSet = parseJson(transaction.observedWriteSetJson, []);
  const readSet = parseJson(transaction.readSetJson, []);
  const observedReadSet = parseJson(transaction.observedReadSetJson, []);
  const semanticDependencyRefs = dependencyPathRefs(parseJson(transaction.semanticDependencyRefsJson, []));
  const snapshotReadSet = serializableSnapshotReadSet(transaction, readSet, observedReadSet, semanticDependencyRefs);
  const lease = transaction.mutationLease;
  const blockedWrites = [...new Set([...writeSet, ...observedWriteSet])]
    .map((path) => ({ path, evaluation: evaluatePathMutation({ lease, path, zonePolicy }) }))
    .filter((entry) => !entry.evaluation.ok);
  const invalidAssumptions = await db.codeSiteAssumptionLease.findMany({
    where: {
      id: { in: parseJson(transaction.assumptionRefsJson, []) },
      status: 'invalidated',
    },
  });
  const staleReads = await findStaleReadEvents(transaction, unique([...readSet, ...semanticDependencyRefs]), db);
  const repoSnapshot = await validateTransactionSnapshot(transaction, snapshotReadSet);
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
  const updated = await db.codeSiteMutationTransaction.update({
    where: { id: transaction.id },
    data: {
      status: ok ? 'validated' : 'blocked',
      commitDecisionJson: stringifyJson(decision),
    },
  });
  await recordEventWithClient(db, transaction.projectId, {
    mutationLeaseId: transaction.mutationLeaseId,
    eventType: 'transaction_validated',
    displayCallsign: lease.displayCallsign,
    actorType: 'transaction',
    actorId: transaction.id,
    details: { transactionId: transaction.id, decision },
  }, { syncArtifacts: options.syncArtifacts });
  return { decision, transaction: transactionProjection(updated) };
}

async function blockTransactionWithDecision(db, transaction, decision, towerInstruction = null) {
  const updated = await db.codeSiteMutationTransaction.update({
    where: { id: transaction.id },
    data: {
      status: 'blocked',
      commitDecisionJson: stringifyJson(decision),
    },
  });
  await recordEventWithClient(db, transaction.projectId, {
    mutationLeaseId: transaction.mutationLeaseId,
    eventType: 'transaction_validated',
    displayCallsign: transaction.mutationLease.displayCallsign,
    actorType: 'transaction',
    actorId: transaction.id,
    details: {
      transactionId: transaction.id,
      decision,
      ...(towerInstruction ? { towerInstruction } : {}),
    },
  });
  return { decision, transaction: transactionProjection(updated) };
}

export async function getSourceStateSince(workspaceSlug, transactionId, actor = null) {
  const transaction = await requireTransaction(workspaceSlug, transactionId, actor);
  const readSet = parseJson(transaction.readSetJson, []);
  const writeSet = parseJson(transaction.writeSetJson, []);
  const observedReadSet = parseJson(transaction.observedReadSetJson, []);
  const observedWriteSet = parseJson(transaction.observedWriteSetJson, []);
  const semanticDependencyRefs = dependencyPathRefs(parseJson(transaction.semanticDependencyRefsJson, []));
  const snapshotReadSet = serializableSnapshotReadSet(transaction, readSet, observedReadSet, semanticDependencyRefs);
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
      repoSnapshot: await validateTransactionSnapshot(transaction, snapshotReadSet),
      changedPaths,
      staleReads: staleReadEventsFrom(transaction, unique([...readSet, ...semanticDependencyRefs]), events),
    },
  };
}

async function sourceStateEventsSince(transaction, db = prisma) {
  return db.codeSiteEvent.findMany({
    where: {
      projectId: transaction.projectId,
      createdAt: { gt: transaction.openedAt },
      eventType: { in: ['write_allowed', 'write_quarantined', 'transaction_committed'] },
    },
    orderBy: { createdAt: 'asc' },
  });
}

async function findStaleReadEvents(transaction, readSet, db = prisma) {
  if (!readSet.length) return [];
  const events = await sourceStateEventsSince(transaction, db);
  return staleReadEventsFrom(transaction, readSet, events);
}

async function buildTransactionSnapshotEvidence(readSet, body = {}) {
  const explicitEvidence = body.baseSnapshotEvidence || body.base_snapshot_evidence;
  if (explicitEvidence) return normalizeReadSnapshotEvidence(explicitEvidence);
  if (body.baseSnapshot || body.base_snapshot) {
    return null;
  }
  if (body.repoSnapshot === false || body.repo_snapshot === false || body.skipRepoSnapshot === true || body.skip_repo_snapshot === true) {
    return null;
  }
  return buildReadSnapshotEvidence(readSet, {
    repoRoot: body.repoRoot || body.repo_root,
    scope: body.scope || body.snapshotScope || body.snapshot_scope,
    excludePaths: transactionSnapshotExcludedPaths(body, readSet),
    source: 'codesite_control_plane',
  });
}

async function validateTransactionSnapshot(transaction, requiredReadSet = null) {
  const evidence = parseJson(transaction.baseSnapshotEvidenceJson, null);
  const validation = await validateReadSnapshotEvidence(evidence, {
    excludePaths: transactionSnapshotExcludedPaths(transaction, requiredReadSet),
  });
  return enforceSerializableSnapshotCoverage(transaction, validation, requiredReadSet);
}

function transactionSnapshotExcludedPaths(source = {}, protectedReadSet = []) {
  const protectedPaths = normalizePathList(protectedReadSet);
  return unique([
    ...normalizePathList(source.writeSet || source.write_set || parseJson(source.writeSetJson, [])),
    ...normalizePathList(source.observedWriteSet || source.observed_write_set || parseJson(source.observedWriteSetJson, [])),
  ]).filter((writePath) => !protectedPaths.some((readPath) => sourcePathsOverlap(readPath, writePath)));
}

function serializableSnapshotReadSet(transaction, readSet = [], observedReadSet = [], semanticDependencyRefs = []) {
  if (!usesSerializableIsolation(transaction)) return [];
  return unique([
    ...normalizePathList(readSet),
    ...normalizePathList(observedReadSet),
    ...normalizePathList(semanticDependencyRefs),
  ]);
}

function usesSerializableIsolation(transaction) {
  return normalizeIsolationValue(transaction?.isolation) === SUPPORTED_TRANSACTION_ISOLATION;
}

function normalizeTransactionIsolation(value) {
  const isolation = normalizeIsolationValue(value);
  if (isolation !== SUPPORTED_TRANSACTION_ISOLATION) {
    throw badRequest('unsupported_transaction_isolation', {
      requestedIsolation: value,
      supportedIsolation: SUPPORTED_TRANSACTION_ISOLATION,
    });
  }
  return isolation;
}

function normalizeIsolationValue(value) {
  if (value == null) return SUPPORTED_TRANSACTION_ISOLATION;
  return String(value).trim().toLowerCase();
}

function enforceSerializableSnapshotCoverage(transaction, validation, requiredReadSet = []) {
  const required = normalizePathList(requiredReadSet);
  if (!usesSerializableIsolation(transaction) || required.length === 0) return validation;

  const expected = normalizeReadSnapshotEvidence(parseJson(transaction.baseSnapshotEvidenceJson, null));
  const snapshotReadSet = normalizePathList(expected?.readSet || []);
  const missingReadSet = required.filter((readPath) => (
    !snapshotReadSet.some((snapshotPath) => snapshotCoversReadPath(snapshotPath, readPath))
  ));
  const requiresSnapshot = !expected || expected.status === 'empty' || validation.reasonCodes.includes('repo_snapshot_not_recorded');
  const repoWideRequired = expected?.scope !== 'repo_wide';
  const repoWideDrifted = validation.reasonCodes.includes('repo_snapshot_repo_manifest_drift_detected');
  const repoWideTruncated = Boolean(expected?.repoManifestTruncated || expected?.truncated);
  const skippedRequiredPaths = required.filter((readPath) => (
    asArray(expected?.skippedPaths).some((skipped) => skipped.path && snapshotCoversReadPath(skipped.path, readPath))
    || asArray(expected?.repoManifestSkippedPaths).some((skipped) => skipped.path && snapshotCoversReadPath(skipped.path, readPath))
  ));
  if (!requiresSnapshot && missingReadSet.length === 0 && !repoWideRequired && !repoWideDrifted && !repoWideTruncated && skippedRequiredPaths.length === 0) {
    return validation;
  }

  return {
    ...validation,
    ok: false,
    reasonCodes: unique([
      ...validation.reasonCodes,
      ...(requiresSnapshot ? ['repo_snapshot_required_for_serializable'] : []),
      ...(missingReadSet.length ? ['repo_snapshot_read_set_coverage_required'] : []),
      ...(repoWideRequired ? ['repo_snapshot_repo_wide_evidence_required'] : []),
      ...(repoWideDrifted ? ['repo_snapshot_repo_manifest_drift_detected'] : []),
      ...(repoWideTruncated ? ['repo_snapshot_truncated_for_serializable'] : []),
      ...(skippedRequiredPaths.length ? ['repo_snapshot_skipped_required_paths'] : []),
    ]),
    requiredReadSet: required,
    snapshotReadSet,
    missingReadSet,
    skippedRequiredPaths,
  };
}

function snapshotCoversReadPath(snapshotPath, readPath) {
  return snapshotPath === readPath || matchPathPattern(readPath, snapshotPath);
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

export async function commitTransaction(workspaceSlug, transactionId, body = {}, actor = null) {
  const transaction = await requireTransaction(workspaceSlug, transactionId, actor);
  const landing = await withSerializableProjectCommitLanding(transaction.projectId, async (db) => (
    landTransactionWithClient(db, workspaceSlug, transactionId, body, actor)
  ));
  if (!landing?.committed) {
    if (landing?.artifactSync) await syncArtifactsForProject(landing.projectId, landing.artifactSync);
    return landing;
  }

  const {
    updated,
    transaction: landedTransaction,
    bundle: landedBundle,
    commitEvent,
    validation,
    inspectionDecision,
    repoStateDecision,
    lineProvenanceDecision,
    landingStatus,
  } = landing;
  let bundle = landedBundle;
  const closeout = await closeTransactionBlackBox(workspaceSlug, {
    ...landedTransaction,
    status: updated.status,
    proofBundleDigest: bundle.bundleDigest,
    closedAt: updated.closedAt,
  }, {
    body,
    bundle,
    terminalEvent: commitEvent,
    validationDecision: validation.decision,
    inspectionDecision,
    repoStateDecision,
    lineProvenanceDecision,
    landingStatus,
  });
  if (closeout?.proofBundle) bundle = closeout.proofBundle;
  return {
    transaction: transactionProjection(updated),
    proofBundle: proofBundleProjection(bundle, {
      transaction: landedTransaction,
      mutationLease: landedTransaction.mutationLease,
      landingRuns: inspectionDecision.inspectionRuns,
      portableProofBundle: closeout?.portableProofBundle || null,
    }),
  };
}

async function landTransactionWithClient(db, workspaceSlug, transactionId, body = {}, actor = null) {
  const current = await requireTransaction(workspaceSlug, transactionId, actor, db);
  if (!isCommittableTransactionStatus(current.status)) {
    return {
      committed: false,
      projectId: current.projectId,
      decision: {
        ok: false,
        isolation: current.isolation,
        reasonCodes: ['transaction_not_committable'],
        status: current.status,
        validatedAt: new Date().toISOString(),
      },
      transaction: transactionProjection(current),
    };
  }

  const validation = await validateTransactionWithClient(db, workspaceSlug, transactionId, actor, { syncArtifacts: false });
  if (!validation.decision.ok) {
    return {
      ...validation,
      committed: false,
      projectId: current.projectId,
      artifactSync: { reason: 'transaction_landing_blocked', eventId: null },
    };
  }

  const transaction = await requireTransaction(workspaceSlug, transactionId, actor, db);
  const inspectionDecision = await verifyLandingInspections(transaction, db);
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
    const blocked = await blockTransactionWithDecision(
      db,
      transaction,
      decision,
      'Landing inspection evidence is required before a proof-carrying commit can land.',
    );
    return { ...blocked, committed: false, projectId: transaction.projectId, artifactSync: { reason: 'landing_inspection_blocked', eventId: null } };
  }

  const repoStateDecision = verifyRepoStateEvidence(transaction, body, workspaceSlug);
  if (!repoStateDecision.ok) {
    const decision = {
      ok: false,
      isolation: transaction.isolation,
      reasonCodes: repoStateDecision.reasonCodes,
      missingRepoStatePaths: repoStateDecision.missingPaths,
      repoState: repoStateDecision.repoState,
      validatedAt: new Date().toISOString(),
    };
    const blocked = await blockTransactionWithDecision(
      db,
      transaction,
      decision,
      'Repo-state evidence is required before a proof-carrying commit can land.',
    );
    return { ...blocked, committed: false, projectId: transaction.projectId, artifactSync: { reason: 'repo_state_blocked', eventId: null } };
  }

  const lineProvenanceDecision = await verifyLineProvenanceEvidence(transaction, db, repoStateDecision.repoState);
  if (!lineProvenanceDecision.ok) {
    const decision = {
      ok: false,
      isolation: transaction.isolation,
      reasonCodes: lineProvenanceDecision.reasonCodes,
      missingLineProvenancePaths: lineProvenanceDecision.missingPaths,
      lineProvenance: lineProvenanceDecision,
      validatedAt: new Date().toISOString(),
    };
    const blocked = await blockTransactionWithDecision(
      db,
      transaction,
      decision,
      'Line-level causal provenance is required for every changed path before landing.',
    );
    return { ...blocked, committed: false, projectId: transaction.projectId, artifactSync: { reason: 'line_provenance_blocked', eventId: null } };
  }

  const fence = await db.codeSiteMutationTransaction.updateMany({
    where: {
      id: transaction.id,
      status: { in: [...COMMITTABLE_TRANSACTION_STATUSES] },
      proofBundleDigest: null,
    },
    data: {
      status: 'committing',
      commitDecisionJson: stringifyJson({
        ...validation.decision,
        reasonCodes: unique([...validation.decision.reasonCodes, 'serializable_landing_gate_entered']),
        landingGateEnteredAt: new Date().toISOString(),
      }),
    },
  });
  if (fence.count !== 1) {
    const refreshed = await requireTransaction(workspaceSlug, transactionId, actor, db);
    return {
      committed: false,
      projectId: transaction.projectId,
      decision: {
        ok: false,
        isolation: refreshed.isolation,
        reasonCodes: ['serializable_commit_fence_lost'],
        status: refreshed.status,
        validatedAt: new Date().toISOString(),
      },
      transaction: transactionProjection(refreshed),
    };
  }

  const landingStatus = inspectionDecision.inspectionRuns.at(-1)?.status || 'committed';
  const bundle = await createProofBundleForTransaction(transaction, {
    ...body,
    inspectionEvidenceRefs: inspectionDecision.evidenceRefs,
    inspectionRunRefs: inspectionDecision.inspectionRuns.map((run) => run.id),
    repoState: repoStateDecision.repoState,
    landingStatus,
  }, db);
  const committedAt = new Date();
  const updated = await db.codeSiteMutationTransaction.update({
    where: { id: transaction.id },
    data: {
      status: 'committed',
      proofBundleDigest: bundle.bundleDigest,
      commitDecisionJson: stringifyJson({
        ...validation.decision,
        reasonCodes: unique([...validation.decision.reasonCodes, 'serializable_commit_landed']),
        committedAt: committedAt.toISOString(),
      }),
      closedAt: committedAt,
    },
  });
  await seedLineProvenance(transaction, bundle, db);
  const writeSet = unique([
    ...parseJson(transaction.writeSetJson, []),
    ...parseJson(transaction.observedWriteSetJson, []),
  ]);
  const commitEvent = await recordEventWithClient(db, transaction.projectId, {
    mutationLeaseId: transaction.mutationLeaseId,
    eventType: 'transaction_committed',
    displayCallsign: transaction.mutationLease.displayCallsign,
    actorType: 'transaction',
    actorId: transaction.id,
    details: {
      transactionId: transaction.id,
      proofBundleId: bundle.id,
      proofBundleDigest: bundle.bundleDigest,
      writeSet,
      repoStateDigest: repoStateDecision.repoState?.evidenceDigest || null,
      inspectionRunIds: inspectionDecision.inspectionRuns.map((run) => run.id),
      inspectionEvidenceRefs: inspectionDecision.evidenceRefs,
    },
  }, { syncArtifacts: false });
  await notifySourceChangeImpacts(transaction.projectId, {
    producerKind: 'codesite_landing',
    producerEventId: `${transaction.id}:${bundle.bundleDigest}`,
    occurredAt: committedAt.toISOString(),
    transactionId: transaction.id,
    mutationLeaseId: transaction.mutationLeaseId,
    agentSessionId: transaction.agentSessionId,
    paths: writeSet,
    fact: {
      changeKind: 'landed',
      proofBundleId: bundle.id,
      proofBundleDigest: bundle.bundleDigest,
      repoStateDigest: repoStateDecision.repoState?.evidenceDigest || null,
      reasonCodes: ['serializable_commit_landed'],
    },
    evidenceRefs: inspectionDecision.evidenceRefs,
  });
  return {
    committed: true,
    projectId: transaction.projectId,
    updated,
    transaction,
    bundle,
    commitEvent,
    validation,
    inspectionDecision,
    repoStateDecision,
    lineProvenanceDecision,
    landingStatus,
  };
}

function isCommittableTransactionStatus(status) {
  return COMMITTABLE_TRANSACTION_STATUSES.has(String(status || '').toLowerCase());
}

async function withSerializableProjectCommitLanding(projectId, callback) {
  return enqueueProjectCommitLanding(projectId, async () => {
    if (typeof prisma.$transaction === 'function') {
      return prisma.$transaction(async (tx) => {
        await lockProjectForSerializableCommit(tx, projectId);
        return callback(tx);
      }, { isolationLevel: 'Serializable' });
    }
    await lockProjectForSerializableCommit(prisma, projectId);
    return callback(prisma);
  });
}

function enqueueProjectCommitLanding(projectId, callback) {
  const key = String(projectId || 'unknown');
  const previous = projectCommitLandingLocks.get(key) || Promise.resolve();
  const run = previous.catch(() => null).then(callback);
  const cleanup = run.finally(() => {
    if (projectCommitLandingLocks.get(key) === cleanup) {
      projectCommitLandingLocks.delete(key);
    }
  });
  projectCommitLandingLocks.set(key, cleanup);
  return run;
}

async function lockProjectForSerializableCommit(db, projectId) {
  if (!projectId || !db?.codeSiteProject?.update) return null;
  return db.codeSiteProject.update({
    where: { id: projectId },
    data: { updatedAt: new Date() },
  });
}

export async function abortTransaction(workspaceSlug, transactionId, body = {}, actor = null) {
  const transaction = await requireTransaction(workspaceSlug, transactionId, actor);
  const updated = await prisma.codeSiteMutationTransaction.update({
    where: { id: transaction.id },
    data: {
      status: 'aborted',
      commitDecisionJson: stringifyJson({ reason: body.reason || 'aborted_by_tower', abortedAt: new Date().toISOString() }),
      closedAt: new Date(),
    },
  });
  const abortEvent = await recordEvent(transaction.projectId, {
    mutationLeaseId: transaction.mutationLeaseId,
    eventType: 'transaction_aborted',
    displayCallsign: transaction.mutationLease.displayCallsign,
    actorType: 'transaction',
    actorId: transaction.id,
    details: { transactionId: transaction.id, reason: body.reason || 'aborted_by_tower' },
  });
  await closeTransactionBlackBox(workspaceSlug, {
    ...transaction,
    status: updated.status,
    commitDecisionJson: updated.commitDecisionJson,
    closedAt: updated.closedAt,
  }, {
    body,
    terminalEvent: abortEvent,
    terminalStatus: 'aborted',
    landingStatus: 'aborted',
  });
  return transactionProjection(updated);
}

async function createProofBundleForTransaction(transaction, body = {}, db = prisma) {
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
  const created = await db.codeSiteProofBundle.create({
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
      landingStatus: normalizeProofLandingStatus(body.landingStatus || body.landing_status),
      bundleDigest,
    },
  });
  return signProofBundleRecord(created, {
    project: transaction.project,
    transaction,
    mutationLease: transaction.mutationLease,
  }, db);
}

function proofBundleEvidenceRefs(proofBundle = {}) {
  return unique([
    ...asArray(proofBundle.evidenceRefs || proofBundle.evidence_refs),
    ...asArray(parseJson(proofBundle.evidenceRefsJson, [])),
  ].map(String).filter(Boolean));
}

function normalizeProofLandingStatus(value) {
  const status = String(value || '').trim();
  return status || null;
}

async function signProofBundleRecord(bundle, context = {}, db = prisma) {
  const portable = proofBundlePortable(bundle, context);
  return db.codeSiteProofBundle.update({
    where: { id: bundle.id },
    data: {
      proofSignatureJson: stringifyJson(portable.proofSignature),
      signatureKeyId: portable.proofSignature?.keyId || null,
    },
    include: {
      project: true,
      transaction: {
        include: {
          agentSession: true,
          mutationLease: true,
          project: true,
        },
      },
    },
  });
}

function verifyRepoStateEvidence(transaction, body = {}, workspaceSlug = null) {
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
  const identity = repoState.repoIdentity || null;
  const expectedWorkspaceSlug = workspaceSlug || transaction.project?.workspaceSlug || transaction.workspaceSlug || null;
  const workspaceMismatch = Boolean(expectedWorkspaceSlug && repoState.workspaceSlug !== expectedWorkspaceSlug);
  const transactionMismatch = repoState.transactionId !== transaction.id;
  const baseSnapshotMismatch = Boolean(transaction.baseSnapshot && repoState.baseSnapshot !== transaction.baseSnapshot);
  const identityWorkspaceMismatch = Boolean(identity && expectedWorkspaceSlug && identity.workspaceSlug !== expectedWorkspaceSlug);
  const identityTransactionMismatch = Boolean(identity && identity.transactionId !== transaction.id);
  const reasonCodes = [
    ...(!repoState.evidenceDigest ? ['repo_state_digest_required'] : []),
    ...(repoState.evidenceDigest && repoState.evidenceDigestVerified === false ? ['repo_state_digest_mismatch'] : []),
    ...(!repoState.worktreeDiffDigest && !repoState.stagedDiffDigest ? ['repo_state_diff_digest_required'] : []),
    ...(workspaceMismatch ? ['repo_state_workspace_mismatch'] : []),
    ...(transactionMismatch ? ['repo_state_transaction_mismatch'] : []),
    ...(baseSnapshotMismatch ? ['repo_state_base_snapshot_mismatch'] : []),
    ...(!identity ? ['repo_state_identity_required'] : []),
    ...(identity && !identity.identityDigest ? ['repo_state_identity_digest_required'] : []),
    ...(identity?.identityDigest && identity.identityDigestVerified === false ? ['repo_state_identity_digest_mismatch'] : []),
    ...(identity && (!identity.repoRootDigest || !identity.gitTopLevelDigest || !identity.gitCommonDirDigest) ? ['repo_state_managed_root_digest_required'] : []),
    ...(identity && identity.gitTopLevelMatchesRepoRoot !== true ? ['repo_state_managed_root_mismatch'] : []),
    ...(identityWorkspaceMismatch ? ['repo_state_identity_workspace_mismatch'] : []),
    ...(identityTransactionMismatch ? ['repo_state_identity_transaction_mismatch'] : []),
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
    repoIdentity: normalizeRepoIdentityEvidence(input.repoIdentity || input.repo_identity || input.managedRoot || input.managed_root),
    gitHead: input.gitHead || input.git_head || null,
    stagedDiffDigest: input.stagedDiffDigest || input.staged_diff_digest || null,
    worktreeDiffDigest: input.worktreeDiffDigest || input.worktree_diff_digest || null,
    headDiffDigest: input.headDiffDigest || input.head_diff_digest || input.commitDiffDigest || input.commit_diff_digest || null,
    changedLineRanges: strictLineProvenanceRows(
      input.changedLineRanges
        || input.changed_line_ranges
        || input.diffLineRanges
        || input.diff_line_ranges
        || input.hunkRanges
        || input.hunk_ranges,
      null,
    ),
    writeFileDigests: normalizeRepoStateFiles(input.writeFileDigests || input.write_file_digests || input.fileDigests || input.files),
    generatedAt: input.generatedAt || input.generated_at || null,
    source: input.source || 'collab-server',
  };
  const computedEvidenceDigest = digest(repoStateDigestPayload(normalized));
  normalized.evidenceDigest = evidenceDigest || computedEvidenceDigest;
  normalized.computedEvidenceDigest = computedEvidenceDigest;
  normalized.evidenceDigestVerified = normalized.evidenceDigest === computedEvidenceDigest;
  return normalized;
}

function normalizeRepoIdentityEvidence(input) {
  if (!input || typeof input !== 'object') return null;
  const identityDigest = input.identityDigest || input.identity_digest || input.digest || null;
  const normalized = {
    schemaVersion: input.schemaVersion || input.schema_version || 'synthi.codesite.repoIdentity.v1',
    workspaceSlug: input.workspaceSlug || input.workspace_slug || null,
    transactionId: input.transactionId || input.transaction_id || null,
    repoRootDigest: input.repoRootDigest || input.repo_root_digest || input.rootDigest || input.root_digest || null,
    gitTopLevelDigest: input.gitTopLevelDigest || input.git_top_level_digest || input.gitToplevelDigest || input.git_toplevel_digest || null,
    gitCommonDirDigest: input.gitCommonDirDigest || input.git_common_dir_digest || input.gitDirDigest || input.git_dir_digest || null,
    gitTopLevelMatchesRepoRoot: normalizeOptionalBoolean(input.gitTopLevelMatchesRepoRoot ?? input.git_top_level_matches_repo_root ?? input.gitToplevelMatchesRepoRoot ?? input.git_toplevel_matches_repo_root),
    source: input.source || 'collab-server',
  };
  const computedIdentityDigest = digest(repoIdentityDigestPayload(normalized));
  normalized.identityDigest = identityDigest || computedIdentityDigest;
  normalized.computedIdentityDigest = computedIdentityDigest;
  normalized.identityDigestVerified = normalized.identityDigest === computedIdentityDigest;
  return normalized;
}

function normalizeOptionalBoolean(value) {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
  }
  return null;
}

function repoStateDigestPayload(repoState) {
  const {
    evidenceDigest: _evidenceDigest,
    computedEvidenceDigest: _computedEvidenceDigest,
    evidenceDigestVerified: _evidenceDigestVerified,
    ...payload
  } = repoState || {};
  if (payload.repoIdentity) {
    payload.repoIdentity = repoIdentityDigestCarrier(payload.repoIdentity);
  }
  payload.changedLineRanges = asArray(payload.changedLineRanges).map(repoStateLineRangeDigestCarrier);
  payload.writeFileDigests = asArray(payload.writeFileDigests).map((file) => ({
    ...file,
    changedLineRanges: asArray(file.changedLineRanges).map(repoStateLineRangeDigestCarrier),
  }));
  return payload;
}

function repoIdentityDigestCarrier(identity) {
  const {
    computedIdentityDigest: _computedIdentityDigest,
    identityDigestVerified: _identityDigestVerified,
    ...payload
  } = identity || {};
  return payload;
}

function repoStateLineRangeDigestCarrier(range) {
  const payload = {
    filePath: range?.filePath || null,
    lineAnchor: range?.lineAnchor || null,
    startLine: range?.startLine ?? null,
    endLine: range?.endLine ?? null,
  };
  if (range?.source) payload.source = range.source;
  if (range?.reasonRef) payload.reasonRef = range.reasonRef;
  if (asArray(range?.evidenceRefs).length) payload.evidenceRefs = asArray(range.evidenceRefs);
  if (asArray(range?.processAncestry).length) payload.processAncestry = asArray(range.processAncestry);
  if (asArray(range?.dojoSourceRefs).length) payload.dojoSourceRefs = asArray(range.dojoSourceRefs);
  if (range?.promptSummary) payload.promptSummary = range.promptSummary;
  return payload;
}

function repoIdentityDigestPayload(identity) {
  const {
    identityDigest: _identityDigest,
    computedIdentityDigest: _computedIdentityDigest,
    identityDigestVerified: _identityDigestVerified,
    ...payload
  } = identity || {};
  return payload;
}

function normalizeRepoStateFiles(files) {
  return asArray(files)
    .map((item) => ({
      path: normalizePath(item?.path || item?.filePath || item?.file_path),
      digest: item?.digest || item?.contentDigest || item?.content_digest || null,
      size: Number.isFinite(item?.size) ? item.size : null,
      exists: item?.exists !== false,
      changedLineRanges: strictLineProvenanceRows(
        item?.changedLineRanges
          || item?.changed_line_ranges
          || item?.diffLineRanges
          || item?.diff_line_ranges
          || item?.hunkRanges
          || item?.hunk_ranges,
        normalizePath(item?.path || item?.filePath || item?.file_path),
      ),
    }))
    .filter((item) => item.path);
}

async function verifyLandingInspections(transaction, db = prisma) {
  const changedPaths = unique([
    ...parseJson(transaction.writeSetJson, []),
    ...parseJson(transaction.observedWriteSetJson, []),
  ]);
  if (changedPaths.length === 0) {
    return { ok: true, reasonCodes: ['no_write_set_no_landing_required'], inspectionRuns: [], evidenceRefs: [] };
  }

  const runs = await db.codeSiteInspectionRun.findMany({
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
    .map(canonicalInspectionSignal)
    .filter(Boolean);
  const invariantSignals = asArray(parseJson(transaction.invariantsJson, []))
    .filter((invariant) => /[:_.-]pass$/i.test(String(invariant || '')))
    .map(canonicalInspectionSignal)
    .filter(Boolean);
  const required = unique([...requiredRadar, ...invariantSignals]);
  return required.length ? required : ['landing'];
}

function inspectionSatisfiesSignal(run, requiredSignal) {
  const signals = asArray(parseJson(run.inspectionSignalsJson, []));
  return signals.some((signal) => {
    if (inspectionSignalFailed(signal)) return false;
    return canonicalInspectionSignal(signalKey(signal)) === canonicalInspectionSignal(requiredSignal)
      && inspectionSignalHasDurableEvidence(run, signal);
  });
}

function signalKey(signal) {
  if (typeof signal === 'string') return signal;
  const adapter = signal?.adapter;
  const adapterKey = typeof adapter === 'string'
    ? adapter
    : adapter?.key || adapter?.signal || adapter?.type || adapter?.name || '';
  return signal?.key || signal?.signal || signal?.type || signal?.name || signal?.radar || adapterKey || signal?.inspector || '';
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

function radarInspectionAdapterFor(value) {
  const normalized = normalizeInspectionSignal(value);
  if (!normalized) return null;
  return RADAR_INSPECTION_ADAPTERS.find((adapter) =>
    adapter.key === normalized || adapter.aliases.some((alias) => normalizeInspectionSignal(alias) === normalized)) || null;
}

function canonicalInspectionSignal(value) {
  const normalized = normalizeInspectionSignal(value);
  const adapter = radarInspectionAdapterFor(normalized);
  return adapter?.key || normalized;
}

function inspectionSignalAdapterValue(signal) {
  if (!signal || typeof signal !== 'object') return null;
  const adapter = signal.adapter;
  if (typeof adapter === 'string') return adapter;
  if (adapter && typeof adapter === 'object') {
    return adapter.key || adapter.signal || adapter.type || adapter.name || null;
  }
  return signal.radar || signal.radarKey || signal.radar_key || null;
}

function radarInspectionAdapterProjection(adapter) {
  if (!adapter) return null;
  return {
    key: adapter.key,
    label: adapter.label,
    evidencePrefix: adapter.evidencePrefix,
  };
}

function normalizeInspectionSignalPayload(signal) {
  const key = normalizeInspectionSignal(signalKey(signal));
  const adapter = radarInspectionAdapterFor(inspectionSignalAdapterValue(signal) || key);
  if (typeof signal === 'string') {
    return {
      key: adapter?.key || key,
      status: 'requested',
      evidenceRefs: [],
      ...(adapter ? { adapter: radarInspectionAdapterProjection(adapter) } : {}),
    };
  }
  if (!signal || typeof signal !== 'object') return null;
  return {
    ...signal,
    key: adapter?.key || key,
    ...(adapter ? { adapter: radarInspectionAdapterProjection(adapter) } : {}),
  };
}

function inspectionSignalHasDurableEvidence(run, signal) {
  const signalRefs = signalEvidenceRefs(signal);
  const refs = signalRefs.length ? signalRefs : inspectionEvidenceRefs(run);
  if (canonicalInspectionSignal(signalKey(signal)) === 'governance'
    && refs.some(isDurableGovernanceInspectionEvidenceRef)) {
    return true;
  }
  return refs.some(isDurableInspectionEvidenceRef);
}

function signalEvidenceRefs(signal) {
  if (typeof signal === 'string') return [];
  return asArray(signal?.evidenceRefs || signal?.evidence_refs || signal?.evidenceRef || signal?.evidence_ref);
}

function isDurableInspectionEvidenceRef(ref) {
  return /^(runtime:event|program:event|dojo:evidence|mcp:audit|shadow:job|test:run|typecheck:run|api-contract:run|security:scan|migration:plan|ui:screenshot|accessibility:audit|performance:budget|handover:packet|clearance:run|artifact:sha256|codesite:repo-state):/i.test(String(ref || ''));
}

function isDurableGovernanceInspectionEvidenceRef(ref) {
  return /^codesite:(permit|route-revision|document):/i.test(String(ref || ''));
}

async function seedLineProvenance(transaction, bundle, db = prisma) {
  const eventRows = await lineProvenanceRowsFromWriteEvents(transaction, bundle, db);
  for (const row of eventRows) {
    await db.codeSiteLineProvenance.create({ data: row });
  }
  return { seededRows: eventRows.length, coveredPaths: unique(eventRows.map((row) => row.filePath)) };
}

async function verifyLineProvenanceEvidence(transaction, db = prisma, repoState = null) {
  const paths = unique([
    ...parseJson(transaction.writeSetJson, []),
    ...parseJson(transaction.observedWriteSetJson, []),
  ]);
  if (!paths.length) {
    return { ok: true, reasonCodes: ['no_write_set_no_line_provenance_required'], missingPaths: [] };
  }
  const events = await db.codeSiteEvent.findMany({
    where: {
      projectId: transaction.projectId,
      eventType: 'write_allowed',
    },
    orderBy: { createdAt: 'asc' },
  });
  const transactionEvents = events
    .map((event) => ({ event, details: parseJson(event.detailsJson, {}) }))
    .filter(({ event, details }) => eventBelongsToTransaction(event, details, transaction));
  const allRows = transactionEvents
    .flatMap(({ details }) => strictLineProvenanceRows(details.lineProvenance || details.line_provenance, normalizePath(details.path)));
  const coveredPaths = new Set(transactionEvents
    .flatMap(({ details }) => strictLineProvenanceRows(details.lineProvenance || details.line_provenance, normalizePath(details.path)))
    .map((row) => row.filePath));
  const repoStateRanges = repoStateChangedLineRanges(repoState, paths);
  const eventExpectedRanges = transactionEvents
    .flatMap(({ details }) => strictLineProvenanceRows(details.changedLineRanges || details.changed_line_ranges, normalizePath(details.path)));
  const expectedRanges = repoStateRanges.length ? repoStateRanges : eventExpectedRanges;
  const missingRepoStateRangePaths = repoState
    ? paths.filter((filePath) => !repoStateRanges.some((range) => lineProvenanceFileCoversPath(range.filePath, filePath)))
    : [];
  const uncoveredRepoStateRanges = expectedRanges.filter((expectedRange) => (
    !allRows.some((row) => lineProvenanceRowCoversRange(row, expectedRange))
  ));
  const uncoveredWriteEvents = transactionEvents
    .map(({ event, details }) => {
      const path = normalizePath(details.path);
      const rows = strictLineProvenanceRows(details.lineProvenance || details.line_provenance, path);
      const eventRanges = strictLineProvenanceRows(details.changedLineRanges || details.changed_line_ranges, path);
      const missingPathCoverage = path && !lineProvenanceRowsCoverPath(rows, path);
      const missingRangeCoverage = eventRanges.filter((expectedRange) => (
        !rows.some((row) => lineProvenanceRowCoversRange(row, expectedRange))
      ));
      return {
        eventId: event.id,
        path,
        missingPathCoverage,
        missingRangeCoverage,
      };
    })
    .filter((item) => item.path && (item.missingPathCoverage || item.missingRangeCoverage.length));
  const missingPaths = paths.filter((filePath) => !lineProvenanceCoversPath(coveredPaths, filePath));
  const missingEventPaths = unique(uncoveredWriteEvents.map((event) => event.path));
  const missingActualRangePaths = unique(uncoveredRepoStateRanges.map((range) => range.filePath));
  const allMissingPaths = unique([
    ...missingPaths,
    ...missingEventPaths,
    ...missingRepoStateRangePaths,
    ...missingActualRangePaths,
  ]);
  const reasonCodes = [
    ...(allMissingPaths.length || uncoveredWriteEvents.length || uncoveredRepoStateRanges.length ? ['line_provenance_required'] : []),
    ...(missingRepoStateRangePaths.length ? ['repo_state_line_ranges_required'] : []),
    ...(uncoveredRepoStateRanges.length ? ['repo_state_line_range_coverage_required'] : []),
  ];
  return {
    ok: reasonCodes.length === 0,
    reasonCodes: reasonCodes.length ? unique(reasonCodes) : ['line_provenance_verified'],
    missingPaths: allMissingPaths,
    uncoveredWriteEvents,
    uncoveredRepoStateRanges,
    expectedRanges,
  };
}

function repoStateChangedLineRanges(repoState, paths = []) {
  if (!repoState) return [];
  const pathList = normalizePathList(paths);
  const fromTopLevel = strictLineProvenanceRows(repoState.changedLineRanges || repoState.changed_line_ranges, null);
  const fromFiles = asArray(repoState.writeFileDigests || repoState.write_file_digests || repoState.files)
    .flatMap((file) => strictLineProvenanceRows(
      file?.changedLineRanges
        || file?.changed_line_ranges
        || file?.diffLineRanges
        || file?.diff_line_ranges
        || file?.hunkRanges
        || file?.hunk_ranges,
      normalizePath(file?.path || file?.filePath || file?.file_path),
    ));
  const ranges = uniqueLineProvenanceRanges([...fromTopLevel, ...fromFiles]);
  if (!pathList.length) return ranges;
  return ranges.filter((range) => pathList.some((filePath) => lineProvenanceFileCoversPath(range.filePath, filePath)));
}

function uniqueLineProvenanceRanges(ranges) {
  const seen = new Set();
  const result = [];
  for (const range of ranges) {
    if (!range?.filePath) continue;
    const key = `${range.filePath}:${range.startLine}:${range.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(range);
  }
  return result;
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
    lineProvenanceFileCoversPath(coveredPath, path)
  ));
}

function lineProvenanceRowsCoverPath(rows, path) {
  return rows.some((row) => lineProvenanceFileCoversPath(row.filePath, path));
}

function lineProvenanceFileCoversPath(provenancePath, path) {
  return provenancePath === path || matchPathPattern(provenancePath, path) || matchPathPattern(path, provenancePath);
}

function lineProvenanceRowCoversRange(row, expectedRange) {
  if (!lineProvenanceFileCoversPath(row.filePath, expectedRange.filePath)) return false;
  return row.startLine <= expectedRange.startLine && row.endLine >= expectedRange.endLine;
}

async function persistAllowedWriteLineProvenance(transaction, event, writeEvidence = {}) {
  const defaultPath = normalizePath(writeEvidence.path);
  const rows = strictLineProvenanceRows(writeEvidence.lineProvenance || writeEvidence.line_provenance, defaultPath);
  for (const row of rows) {
    await prisma.codeSiteLineProvenance.create({
      data: {
        projectId: transaction.projectId,
        transactionId: transaction.id,
        filePath: row.filePath,
        lineAnchor: row.lineAnchor,
        startLine: row.startLine,
        endLine: row.endLine,
        displayCallsign: transaction.mutationLease.displayCallsign,
        reasonRef: row.reasonRef || `event:${event.id}`,
        evidenceRefsJson: stringifyJson(unique([
          `transaction:${transaction.id}`,
          `event:${event.id}`,
          ...asArray(writeEvidence.evidenceRefs || writeEvidence.evidence_refs),
          ...asArray(row.evidenceRefs),
        ].filter(Boolean))),
        dojoSourceRefsJson: stringifyJson(unique([
          ...asArray(writeEvidence.dojoSourceRefs || writeEvidence.dojo_source_refs),
          ...asArray(row.dojoSourceRefs || row.dojo_source_refs),
        ].filter(Boolean))),
        processAncestryJson: stringifyJson(unique([
          ...asArray(writeEvidence.processAncestry || writeEvidence.process_ancestry),
          ...asArray(row.processAncestry),
        ].filter(Boolean))),
        promptSummary: row.promptSummary || writeEvidence.promptSummary || writeEvidence.prompt_summary || 'CodeSite allowed write',
      },
    });
  }
  return rows.length;
}

async function lineProvenanceRowsFromWriteEvents(transaction, bundle, db = prisma) {
  const events = await db.codeSiteEvent.findMany({
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
        startLine: row.startLine,
        endLine: row.endLine,
        displayCallsign: transaction.mutationLease.displayCallsign,
        reasonRef: row.reasonRef || `event:${event.id}`,
        evidenceRefsJson: stringifyJson(unique([
          `proof:${bundle.id}`,
          `transaction:${transaction.id}`,
          `event:${event.id}`,
          ...asArray(details.evidenceRefs || details.evidence_refs),
          ...asArray(row.evidenceRefs),
        ].filter(Boolean))),
        dojoSourceRefsJson: stringifyJson(unique([
          ...asArray(details.dojoSourceRefs || details.dojo_source_refs),
          ...asArray(row.dojoSourceRefs || row.dojo_source_refs),
        ].filter(Boolean))),
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
  const project = await requireProject(workspaceSlug, projectId, actor, 'write');
  const kind = String(body.kind || body.type || 'rfi');
  const routing = await validateDocumentRouting(workspaceSlug, project.id, body, actor);
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
  await syncArtifactsForProject(project.id, { reason: 'document_inbox_routed', eventId: event.id });
  return { document: documentProjection(document), inboxItems: inboxItems.map(inboxProjection) };
}

export async function listPermits(workspaceSlug, projectId, actor = null) {
  const project = await requireProject(workspaceSlug, projectId, actor, 'read');
  const permits = await prisma.codeSitePermit.findMany({
    where: { projectId: project.id },
    orderBy: { issuedAt: 'desc' },
  });
  return permits.map(permitProjection);
}

export async function createPermit(workspaceSlug, projectId, body = {}, actor = null) {
  const project = await requireProject(workspaceSlug, projectId, actor, 'write');
  const executionPlanId = body.executionPlanId || body.execution_plan_id || null;
  const mutationLeaseId = body.mutationLeaseId || body.mutation_lease_id || body.clearanceId || body.clearance_id || null;
  if (executionPlanId) {
    const plan = await prisma.codeSiteExecutionPlan.findFirst({ where: { id: executionPlanId, projectId: project.id } });
    if (!plan) throw notFound('execution_plan_not_found');
  }
  if (mutationLeaseId) {
    const lease = await prisma.codeSiteMutationLease.findFirst({ where: { id: mutationLeaseId, projectId: project.id } });
    if (!lease) throw notFound('mutation_lease_not_found');
  }
  const documentId = body.documentId || body.document_id || null;
  if (documentId) await requireDocument(project.id, documentId);
  const permitType = String(body.permitType || body.permit_type || body.kind || 'work_permit');
  const status = String(body.status || (body.approved === false ? 'requested' : 'issued'));
  const scope = {
    executionPlanId,
    mutationLeaseId,
    allowedPaths: pathsForRoute(body.allowedPaths || body.allowed_paths || body.route || []),
    blockedPaths: pathsForRoute(body.blockedPaths || body.blocked_paths || body.noFlyZones || body.no_fly_zones || []),
    affectedZones: asArray(body.affectedZones || body.affected_zones),
    contractRefs: asArray(body.contractRefs || body.contract_refs),
    expiresAt: body.expiresAt || body.expires_at || null,
    ...(body.scope && typeof body.scope === 'object' ? body.scope : {}),
  };
  const approval = {
    approved: ['issued', 'active', 'approved'].includes(status),
    approvedByUserId: body.approvedByUserId || body.approved_by_user_id || actorUserId(actor),
    rationale: body.rationale || body.reason || null,
    reviewRef: body.reviewRef || body.review_ref || null,
  };
  const permit = await prisma.codeSitePermit.create({
    data: {
      projectId: project.id,
      executionPlanId,
      mutationLeaseId,
      documentId,
      permitType,
      status,
      title: String(body.title || defaultPermitTitle(permitType, executionPlanId, mutationLeaseId)),
      scopeJson: stringifyJson(scope),
      approvalJson: stringifyJson(approval),
      evidenceRefsJson: stringifyJson(asArray(body.evidenceRefs || body.evidence_refs)),
      issuedByUserId: actorUserId(actor),
      expiresAt: body.expiresAt || body.expires_at ? new Date(body.expiresAt || body.expires_at) : null,
      closedAt: body.closedAt || body.closed_at ? new Date(body.closedAt || body.closed_at) : null,
    },
  });
  const event = await recordEvent(project.id, {
    eventType: 'tower_instruction',
    displayCallsign: body.displayCallsign || body.display_callsign || null,
    actorType: 'permit',
    actorId: permit.id,
    details: {
      permitId: permit.id,
      permitType,
      status,
      executionPlanId,
      mutationLeaseId,
      documentId,
      scope,
      approval,
    },
    evidenceRefs: asArray(body.evidenceRefs || body.evidence_refs),
  });
  await syncArtifactsForProject(project.id, { reason: 'permit_recorded', eventId: event.id });
  return { permit: permitProjection(permit), event };
}

export async function reviewDocument(workspaceSlug, documentId, body = {}, actor = null) {
  const document = await prisma.codeSiteDocument.findFirst({
    where: { id: documentId, project: { workspaceSlug } },
    include: { project: { include: { members: true, agentSessions: true } } },
  });
  if (!document) throw notFound('document_not_found');
  await requireProjectAccess(document.project, actor, 'write');
  const decision = normalizeReviewDecision(body.decision || body.status || body.outcome || 'approved');
  const nextStatus = documentStatusForReviewDecision(decision);
  const reasonCodes = unique([
    ...asArray(body.reasonCodes || body.reason_codes),
    `document_${decision}`,
  ]);
  const reviewedAt = new Date();
  const review = await prisma.codeSiteDocumentReview.create({
    data: {
      projectId: document.projectId,
      documentId: document.id,
      reviewerUserId: body.reviewerUserId || body.reviewer_user_id || actorUserId(actor),
      status: decision === 'pending' ? 'pending' : 'completed',
      decision,
      reasonCodesJson: stringifyJson(reasonCodes),
      bodyJson: stringifyJson({
        summary: body.summary || body.rationale || body.reason || null,
        routeRevisionId: body.routeRevisionId || body.route_revision_id || null,
        permitId: body.permitId || body.permit_id || null,
        reviewTimeMs: normalizePositiveInt(body.reviewTimeMs || body.review_time_ms),
        baselineReviewTimeMs: normalizePositiveInt(body.baselineReviewTimeMs || body.baseline_review_time_ms),
      }),
      evidenceRefsJson: stringifyJson(asArray(body.evidenceRefs || body.evidence_refs)),
      reviewedAt: decision === 'pending' ? null : reviewedAt,
    },
  });
  const updatedDocument = await prisma.codeSiteDocument.update({
    where: { id: document.id },
    data: {
      status: nextStatus,
      resolvedAt: ['approved', 'rejected'].includes(nextStatus) ? reviewedAt : null,
    },
  });
  const event = await recordEvent(document.projectId, {
    eventType: 'tower_instruction',
    displayCallsign: body.displayCallsign || body.display_callsign || null,
    actorType: 'document_review',
    actorId: review.id,
    details: {
      documentId: document.id,
      reviewId: review.id,
      kind: document.kind,
      decision,
      status: nextStatus,
      reasonCodes,
    },
    evidenceRefs: asArray(body.evidenceRefs || body.evidence_refs),
  });
  await syncArtifactsForProject(document.projectId, { reason: 'document_reviewed', eventId: event.id });
  return {
    document: documentProjection(updatedDocument),
    review: documentReviewProjection(review),
    event,
  };
}

export async function listRouteRevisions(workspaceSlug, projectId, actor = null) {
  const project = await requireProject(workspaceSlug, projectId, actor, 'read');
  const revisions = await prisma.codeSiteRouteRevision.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: 'desc' },
  });
  return revisions.map(routeRevisionProjection);
}

export async function proposeRouteRevision(workspaceSlug, executionPlanId, body = {}, actor = null) {
  const plan = await prisma.codeSiteExecutionPlan.findFirst({
    where: { id: executionPlanId, project: { workspaceSlug } },
    include: { project: { include: { members: true, agentSessions: true } } },
  });
  if (!plan) throw notFound('execution_plan_not_found');
  await requireProjectAccess(plan.project, actor, 'write');
  const previousRoute = pathsForRoute(parseJson(plan.routeJson, []));
  const proposedRoute = pathsForRoute(body.proposedRoute || body.proposed_route || body.route || body.nextRoute || body.next_route || []);
  if (!proposedRoute.length) throw badRequest('route_revision_proposed_route_required');
  const suppliedDocumentId = body.documentId || body.document_id || null;
  let document = suppliedDocumentId ? await requireDocument(plan.projectId, suppliedDocumentId) : null;
  if (!document && body.createChangeOrder !== false && body.create_change_order !== false) {
    document = await prisma.codeSiteDocument.create({
      data: {
        projectId: plan.projectId,
        kind: 'change_order',
        status: 'pending_review',
        title: String(body.title || `Route change for ${plan.displayCallsign}`),
        bodyJson: stringifyJson(redactDocumentBody({
          summary: body.summary || body.reason || 'Route revision proposed',
          executionPlanId: plan.id,
          previousRoute,
          proposedRoute,
          affectedZones: asArray(body.affectedZones || body.affected_zones),
          contractRefs: asArray(body.contractRefs || body.contract_refs),
        })),
        blocking: body.blocking !== false,
      },
    });
  }
  const affectedLeases = await prisma.codeSiteMutationLease.findMany({
    where: {
      projectId: plan.projectId,
      executionPlanId: plan.id,
      status: { in: ['active', 'issued', 'holding', 'suspended'] },
    },
    orderBy: { issuedAt: 'desc' },
  });
  const revision = await prisma.codeSiteRouteRevision.create({
    data: {
      projectId: plan.projectId,
      executionPlanId: plan.id,
      documentId: document?.id || null,
      status: String(body.status || 'proposed'),
      previousRouteJson: stringifyJson(previousRoute),
      proposedRouteJson: stringifyJson(proposedRoute),
      affectedLeasesJson: stringifyJson(affectedLeases.map((lease) => ({
        id: lease.id,
        status: lease.status,
        displayCallsign: lease.displayCallsign,
        mutationLeaseId: lease.id,
      }))),
      approvalJson: stringifyJson({ required: true }),
      evidenceRefsJson: stringifyJson(asArray(body.evidenceRefs || body.evidence_refs)),
      proposedByUserId: actorUserId(actor),
    },
  });
  const event = await recordEvent(plan.projectId, {
    eventType: 'route_deviation',
    displayCallsign: plan.displayCallsign,
    actorType: 'route_revision',
    actorId: revision.id,
    details: {
      routeRevisionId: revision.id,
      executionPlanId: plan.id,
      documentId: document?.id || null,
      previousRoute,
      proposedRoute,
      affectedLeaseIds: affectedLeases.map((lease) => lease.id),
      towerInstruction: 'Route revision proposed; hold affected clearances until review is approved and applied.',
    },
    evidenceRefs: asArray(body.evidenceRefs || body.evidence_refs),
  });
  await syncArtifactsForProject(plan.projectId, { reason: 'route_revision_proposed', eventId: event.id });
  return {
    routeRevision: routeRevisionProjection(revision),
    changeOrder: document ? documentProjection(document) : null,
    event,
  };
}

export async function reviewRouteRevision(workspaceSlug, routeRevisionId, body = {}, actor = null) {
  const revision = await requireRouteRevision(workspaceSlug, routeRevisionId, actor, 'write');
  const decision = normalizeReviewDecision(body.decision || body.status || body.outcome || 'approved');
  const approved = decision === 'approved';
  const nextStatus = approved ? 'approved' : (decision === 'rejected' ? 'rejected' : 'needs_info');
  const approval = {
    ...parseJson(revision.approvalJson, {}),
    decision,
    approved,
    reviewedByUserId: body.reviewerUserId || body.reviewer_user_id || actorUserId(actor),
    rationale: body.rationale || body.reason || body.summary || null,
    reviewedAt: new Date().toISOString(),
  };
  const updated = await prisma.codeSiteRouteRevision.update({
    where: { id: revision.id },
    data: {
      status: nextStatus,
      approvalJson: stringifyJson(approval),
      approvedByUserId: approved ? approval.reviewedByUserId : null,
    },
  });
  const event = await recordEvent(revision.projectId, {
    eventType: 'tower_instruction',
    displayCallsign: revision.executionPlan?.displayCallsign || null,
    actorType: 'route_revision',
    actorId: revision.id,
    details: {
      routeRevisionId: revision.id,
      executionPlanId: revision.executionPlanId,
      decision,
      status: nextStatus,
      approval,
    },
    evidenceRefs: asArray(body.evidenceRefs || body.evidence_refs),
  });
  if (revision.documentId) {
    await reviewDocument(workspaceSlug, revision.documentId, {
      decision,
      summary: body.summary || body.rationale || body.reason || null,
      routeRevisionId: revision.id,
      evidenceRefs: body.evidenceRefs || body.evidence_refs,
    }, actor);
  }
  await syncArtifactsForProject(revision.projectId, { reason: 'route_revision_reviewed', eventId: event.id });
  return { routeRevision: routeRevisionProjection(updated), event };
}

export async function applyRouteRevision(workspaceSlug, routeRevisionId, body = {}, actor = null) {
  let revision = await requireRouteRevision(workspaceSlug, routeRevisionId, actor, 'write');
  if (revision.status !== 'approved') {
    if (body.approve === true || body.approved === true) {
      const reviewed = await reviewRouteRevision(workspaceSlug, routeRevisionId, { ...body, decision: 'approved' }, actor);
      revision = await requireRouteRevision(workspaceSlug, reviewed.routeRevision.id, actor, 'write');
    } else {
      throw badRequest('route_revision_not_approved', { status: revision.status });
    }
  }
  const proposedRoute = pathsForRoute(parseJson(revision.proposedRouteJson, []));
  if (!proposedRoute.length) throw badRequest('route_revision_proposed_route_required');
  const now = new Date();
  const updatedPlan = await prisma.codeSiteExecutionPlan.update({
    where: { id: revision.executionPlanId },
    data: {
      routeJson: stringifyJson(proposedRoute),
      status: 'rerouted',
    },
  });
  const affectedRefs = parseJson(revision.affectedLeasesJson, []);
  const affectedLeaseIds = unique([
    ...affectedRefs.map((lease) => lease.id || lease.mutationLeaseId).filter(Boolean),
    ...asArray(body.affectedLeaseIds || body.affected_lease_ids),
  ]);
  const affectedLeases = [];
  const policyDecisions = [];
  if (affectedLeaseIds.length) {
    const leases = await prisma.codeSiteMutationLease.findMany({
      where: { id: { in: affectedLeaseIds }, projectId: revision.projectId },
    });
    for (const lease of leases) {
      const nextStatus = body.revokeAffectedLeases || body.revoke_affected_leases ? 'revoked' : 'suspended';
      const updatedLease = await prisma.codeSiteMutationLease.update({
        where: { id: lease.id },
        data: {
          status: nextStatus,
          revokedAt: nextStatus === 'revoked' ? now : lease.revokedAt,
        },
      });
      affectedLeases.push(mutationLeaseProjection(updatedLease));
      const decision = await createPolicyDecision(revision.projectId, {
        mutationLeaseId: lease.id,
        displayCallsign: lease.displayCallsign,
        decision: nextStatus === 'revoked' ? 'revoke' : 'hold',
        reasonCodes: ['route_revision_applied', 'clearance_reissue_required'],
        input: {
          routeRevisionId: revision.id,
          previousRoute: parseJson(revision.previousRouteJson, []),
          proposedRoute,
        },
        decisionJson: {
          routeRevisionId: revision.id,
          previousStatus: lease.status,
          status: nextStatus,
          appliedByUserId: actorUserId(actor),
        },
      });
      policyDecisions.push(policyDecisionProjection(decision));
    }
  }
  const approval = {
    ...parseJson(revision.approvalJson, {}),
    appliedByUserId: actorUserId(actor),
    appliedAt: now.toISOString(),
  };
  const updatedRevision = await prisma.codeSiteRouteRevision.update({
    where: { id: revision.id },
    data: {
      status: 'applied',
      approvalJson: stringifyJson(approval),
      appliedAt: now,
    },
  });
  const event = await recordEvent(revision.projectId, {
    eventType: 'tower_instruction',
    displayCallsign: updatedPlan.displayCallsign,
    actorType: 'route_revision',
    actorId: revision.id,
    details: {
      routeRevisionId: revision.id,
      executionPlanId: updatedPlan.id,
      previousRoute: parseJson(revision.previousRouteJson, []),
      proposedRoute,
      affectedLeaseIds,
      affectedLeaseStatus: affectedLeases.map((lease) => ({ id: lease.id, status: lease.status })),
      towerInstruction: 'Route revision applied. Affected clearances must be reissued before further writes.',
    },
    evidenceRefs: unique([
      ...parseJson(revision.evidenceRefsJson, []),
      ...asArray(body.evidenceRefs || body.evidence_refs),
    ]),
  });
  await syncArtifactsForProject(revision.projectId, { reason: 'route_revision_applied', eventId: event.id });
  return {
    routeRevision: routeRevisionProjection(updatedRevision),
    executionPlan: executionPlanProjection(updatedPlan),
    affectedLeases,
    policyDecisions,
    event,
  };
}

function defaultDocumentTitle(kind) {
  return {
    rfi: 'Request for information',
    change_order: 'Change order',
    submittal: 'Submittal',
    handover: 'Handover packet',
    permit: 'Work permit',
    mayday: 'Mayday',
    stop_work: 'Stop-work order',
    punch: 'Punch item',
  }[kind] || 'CodeSite document';
}

function defaultPermitTitle(permitType, executionPlanId = null, mutationLeaseId = null) {
  const label = String(permitType || 'work_permit')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
  const ref = mutationLeaseId || executionPlanId;
  return ref ? `${label} for ${ref}` : label;
}

function normalizeReviewDecision(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['approve', 'approved', 'accept', 'accepted', 'pass', 'passed', 'issued'].includes(normalized)) return 'approved';
  if (['reject', 'rejected', 'deny', 'denied', 'fail', 'failed'].includes(normalized)) return 'rejected';
  if (['needs_info', 'needs_information', 'more_info', 'revise', 'revisions_requested', 'changes_requested'].includes(normalized)) {
    return 'needs_info';
  }
  if (['pending', 'open', 'requested'].includes(normalized)) return 'pending';
  return normalized || 'approved';
}

function documentStatusForReviewDecision(decision) {
  return {
    approved: 'approved',
    rejected: 'rejected',
    needs_info: 'needs_info',
    pending: 'pending_review',
  }[decision] || 'reviewed';
}

function normalizePositiveInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
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

async function validateDocumentRouting(workspaceSlug, projectId, body = {}, actor = null) {
  const fromSessionId = body.fromSessionId || body.from_session || body.sourceSessionId || body.source_session || null;
  const targetSessionIds = unique(asArray(body.toSessionId || body.to_session || body.recipients || []));
  const kind = String(body.kind || body.type || 'rfi');
  const fromSession = fromSessionId
    ? await prisma.codeSiteAgentSession.findFirst({ where: { id: fromSessionId, projectId } })
    : null;
  if (fromSessionId && !fromSession) throw notFound('source_agent_session_not_found');
  if (actor && !actor.bypass && !fromSession) throw forbidden('document_sender_session_required');
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
  if (!actor?.bypass) {
    await requireWorkspaceSessionMembers(workspaceSlug, [fromSession, ...targetSessions].filter(Boolean));
  }
  const blockedRecipients = targetSessions
    .map((session) => ({
      session,
      decision: evaluateRecipientDocumentPolicy(session, { kind, body, fromSession }),
    }))
    .filter(({ decision }) => !decision.ok)
    .map(({ session, decision }) => ({
      agentSessionId: session.id,
      displayCallsign: session.displayCallsign,
      reasonCodes: decision.reasonCodes,
      affectedZones: decision.affectedZones,
      visibleZones: decision.visibleZones,
    }));
  if (blockedRecipients.length) {
    throw badRequest('document_recipient_policy_blocked', { blockedRecipients });
  }
  return { fromSession, targetSessions };
}

async function requireWorkspaceSessionMembers(workspaceSlug, sessions = []) {
  const ownerUserIds = unique(sessions.map((session) => session?.ownerUserId).filter(Boolean));
  if (!ownerUserIds.length) return;
  const workspace = await prisma.workspace.findUnique({
    where: { slug: workspaceSlug },
    include: { memberships: { where: { userId: { in: ownerUserIds } } } },
  });
  const memberUserIds = new Set(asArray(workspace?.memberships).map((membership) => membership.userId));
  const missing = ownerUserIds.filter((userId) => !memberUserIds.has(userId));
  if (missing.length) {
    throw badRequest('document_session_owner_not_workspace_member', { userIds: missing });
  }
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

function redactDocumentBody(body, policy = defaultRedactionPolicy()) {
  return redactValue(body, '', normalizeDocumentPolicy(policy));
}

function redactValue(input, key = '', policy = defaultRedactionPolicy()) {
  if (shouldRedactField(key, policy)) return '[redacted]';
  if (shouldDropField(key, policy)) return undefined;
  if (Array.isArray(input)) return input.map((item) => redactValue(item, key, policy)).filter((item) => item !== undefined);
  if (!input || typeof input !== 'object') {
    return isSensitiveValue(input, policy) ? '[redacted]' : input;
  }
  return Object.fromEntries(
    Object.entries(input)
      .map(([entryKey, value]) => [entryKey, redactValue(value, entryKey, policy)])
      .filter(([, value]) => value !== undefined),
  );
}

function shouldRedactField(key, policy) {
  const name = String(key || '');
  if (!name) return false;
  if (policy.redactSecrets !== false && /secret|token|password|api[_-]?key|credential|authorization|cookie/i.test(name)) {
    return true;
  }
  if (policy.redactPrivatePrompts !== false && /private[_-]?prompt|prompt[_-]?transcript|raw[_-]?prompt|cli[_-]?history|terminal[_-]?(history|transcript|session)|session[_-]?memory|conversation[_-]?(history|transcript)|raw[_-]?(trace|session|memory)/i.test(name)) {
    return true;
  }
  return documentPolicyFields(policy, ['redactedFields', 'redacted_fields', 'privateFields', 'private_fields'])
    .some((field) => normalizedPolicyField(field) === normalizedPolicyField(name));
}

function shouldDropField(key, policy) {
  const name = String(key || '');
  if (!name) return false;
  if (policy.allowAttachments === false || policy.attachments === false || policy.redactAttachments === true || policy.redact_attachments === true) {
    if (/^attachments?$|^fileAttachments$|^file_attachments$|^files$/i.test(name)) return true;
  }
  return documentPolicyFields(policy, ['droppedFields', 'dropped_fields', 'omittedFields', 'omitted_fields'])
    .some((field) => normalizedPolicyField(field) === normalizedPolicyField(name));
}

function isSensitiveValue(value, policy = defaultRedactionPolicy()) {
  if (policy.redactSecrets === false) return false;
  if (typeof value !== 'string') return false;
  return /(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{12,}|AKIA[0-9A-Z]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~+/-]+=*|(?:DATABASE_URL|[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*=|(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s]+)/.test(value);
}

async function routeDocumentToInbox(projectId, document, event, body, targetSessions = null) {
  const sessions = targetSessions || [];
  const created = [];
  for (const session of sessions) {
    const recipientBody = redactDocumentBody(parseJson(document.bodyJson, {}), sessionDocumentPolicy(session));
    const deliveryTargets = deliveryTargetsForSession(session, body);
    const payload = {
      documentId: document.id,
      eventId: event.id,
      kind: document.kind,
      title: document.title,
      body: recipientBody,
      redaction: {
        policyApplied: true,
        recipientSessionId: session.id,
      },
      delivery: buildInboxDeliveryPlan(session, deliveryTargets),
    };
    const inboxItem = await prisma.codeSiteAgentInboxItem.create({
      data: {
        projectId,
        agentSessionId: session.id,
        recipientUserId: session.ownerUserId,
        eventId: event.id,
        documentId: document.id,
        kind: document.kind,
        requiresResponse: Boolean(body.requiresResponse || body.requires_response || document.blocking),
        redactedPayloadJson: stringifyJson(payload),
      },
    });
    created.push(await dispatchInboxDeliveryAdapters(inboxItem, payload, deliveryTargets));
  }
  return created;
}

function buildInboxDeliveryPlan(session, deliveryTargets = []) {
  const outboundModes = deliveryTargets.map((target) => target.mode);
  return {
    modes: unique([
      'durable_inbox',
      'sse_stream',
      'mcp_poll',
      ...outboundModes,
    ]),
    targets: deliveryTargets.map(publicDeliveryTarget),
    adapterStatus: deliveryTargets.length ? 'pending' : 'not_configured',
    recipient: {
      agentSessionId: session.id,
      provider: session.agentProvider || null,
      runtime: session.agentRuntime || null,
      providerSessionBound: Boolean(session.providerSessionRef),
    },
  };
}

function deliveryTargetsForSession(session = {}, body = {}) {
  const policy = sessionDocumentPolicy(session);
  const targetInputs = [
    ...asArray(policy.deliveryTargets || policy.delivery_targets),
    ...asArray(body.deliveryTargets || body.delivery_targets),
  ];
  return uniqueByDeliveryTarget(targetInputs
    .map((target) => normalizeDeliveryTarget(target, session))
    .filter(Boolean)
    .filter((target) => deliveryTargetMatchesSession(target, session)));
}

function normalizeDeliveryTarget(target, session = {}) {
  if (!target) return null;
  const raw = typeof target === 'string' ? { endpoint: target, mode: 'webhook' } : target;
  if (!raw || typeof raw !== 'object') return null;
  const mode = normalizeDeliveryMode(raw.mode || raw.type || raw.kind || raw.deliveryMode || raw.delivery_mode);
  if (!mode) return null;
  const endpoint = raw.endpoint || raw.url || raw.webhookUrl || raw.webhook_url || raw.callbackUrl || raw.callback_url || null;
  return {
    mode,
    endpoint: endpoint ? String(endpoint) : null,
    provider: raw.provider || session.agentProvider || null,
    recipientSessionId: raw.agentSessionId || raw.agent_session_id || raw.recipientSessionId || raw.recipient_session_id || null,
    recipientUserId: raw.recipientUserId || raw.recipient_user_id || null,
    label: raw.label || raw.name || null,
  };
}

function normalizeDeliveryMode(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ['webhook', 'provider_callback', 'a2a', 'task_comment'].includes(normalized) ? normalized : null;
}

function deliveryTargetMatchesSession(target, session = {}) {
  if (target.recipientSessionId && target.recipientSessionId !== session.id) return false;
  if (target.recipientUserId && target.recipientUserId !== session.ownerUserId) return false;
  return true;
}

function uniqueByDeliveryTarget(targets = []) {
  const seen = new Set();
  return targets.filter((target) => {
    const key = stableJson({
      mode: target.mode,
      endpoint: sanitizeDeliveryEndpoint(target.endpoint),
      provider: target.provider || null,
      recipientSessionId: target.recipientSessionId || null,
      recipientUserId: target.recipientUserId || null,
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function publicDeliveryTarget(target = {}) {
  return {
    mode: target.mode,
    endpoint: sanitizeDeliveryEndpoint(target.endpoint),
    provider: target.provider || null,
    label: target.label || null,
  };
}

function sanitizeDeliveryEndpoint(endpoint) {
  if (!endpoint) return null;
  try {
    const parsed = new URL(endpoint);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch (_) {
    return '[invalid_endpoint]';
  }
}

async function dispatchInboxDeliveryAdapters(inboxItem, payload, deliveryTargets = []) {
  const attempts = [];
  for (const target of deliveryTargets) {
    attempts.push(await dispatchInboxDeliveryTarget(inboxItem, payload, target));
  }
  if (!attempts.length) return inboxItem;
  const nextPayload = {
    ...payload,
    delivery: {
      ...payload.delivery,
      adapterStatus: attempts.some((attempt) => attempt.status === 'delivered') ? 'delivered' : 'attempted',
      attempts,
    },
  };
  return prisma.codeSiteAgentInboxItem.update({
    where: { id: inboxItem.id },
    data: { redactedPayloadJson: stringifyJson(nextPayload) },
  });
}

async function dispatchInboxDeliveryTarget(inboxItem, payload, target) {
  const startedAt = new Date().toISOString();
  const publicTarget = publicDeliveryTarget(target);
  if (!target.endpoint) {
    return { ...publicTarget, status: 'skipped', reason: 'endpoint_missing', startedAt, completedAt: new Date().toISOString() };
  }
  // Workstream F.2: fail-closed origin allowlist. With no allowlist configured,
  // external delivery is refused entirely.
  const allowlistCheck = endpointDeliveryAllowed(target.endpoint, deliveryAllowedOrigins());
  if (!allowlistCheck.ok) {
    return { ...publicTarget, status: 'skipped', reason: allowlistCheck.reason, startedAt, completedAt: new Date().toISOString() };
  }
  let parsed;
  try {
    parsed = new URL(target.endpoint);
  } catch (_) {
    return { ...publicTarget, status: 'skipped', reason: 'endpoint_invalid', startedAt, completedAt: new Date().toISOString() };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ...publicTarget, status: 'skipped', reason: 'endpoint_protocol_unsupported', startedAt, completedAt: new Date().toISOString() };
  }
  if (typeof fetch !== 'function') {
    return { ...publicTarget, status: 'skipped', reason: 'fetch_unavailable', startedAt, completedAt: new Date().toISOString() };
  }

  const timeoutMs = getCodeSiteRuntimeConfig().inboxDeliveryTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 1500);
  try {
    const bodyText = JSON.stringify({
      deliveryMode: target.mode,
      inboxItemId: inboxItem.id,
      projectId: inboxItem.projectId,
      agentSessionId: inboxItem.agentSessionId,
      recipientUserId: inboxItem.recipientUserId,
      eventId: inboxItem.eventId,
      documentId: inboxItem.documentId,
      payload,
    });
    // Workstream F.2: signed envelope â€” HMAC over timestamp+nonce+body digest
    // gives receivers sender authentication and replay protection.
    const signatureHeaders = signDeliveryEnvelope(bodyText);
    const response = await fetch(target.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Synthi-CodeSite/1.0',
        ...signatureHeaders,
      },
      body: bodyText,
      signal: controller.signal,
    });
    return {
      ...publicTarget,
      status: response.ok ? 'delivered' : 'failed',
      httpStatus: response.status,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      ...publicTarget,
      status: 'failed',
      reason: error?.name === 'AbortError' ? 'timeout' : 'request_failed',
      startedAt,
      completedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function evaluateRecipientDocumentPolicy(session, { kind, body = {}, fromSession = null } = {}) {
  const policy = sessionDocumentPolicy(session);
  const reasonCodes = [];
  const normalizedKind = String(kind || '').toLowerCase();
  const allowedKinds = documentPolicyFields(policy, ['allowedDocumentKinds', 'allowed_document_kinds'])
    .map((entry) => entry.toLowerCase());
  const affectedZones = documentAffectedZones(body);
  const visibleZones = recipientVisibleZones(policy);
  const mutedSenders = documentPolicyFields(policy, [
    'mutedAgentSessionIds',
    'muted_agent_session_ids',
    'blockedAgentSessionIds',
    'blocked_agent_session_ids',
    'mutedSenders',
    'muted_senders',
  ]);

  if (documentPolicyOptedOut(policy)) reasonCodes.push('recipient_opted_out');
  if (!allowedKinds.includes(normalizedKind)) reasonCodes.push('document_kind_not_allowed');
  if (fromSession?.id && mutedSenders.includes(fromSession.id)) reasonCodes.push('sender_muted');
  if (!affectedZonesVisibleToRecipient(affectedZones, visibleZones)) reasonCodes.push('affected_zone_not_visible');

  return {
    ok: reasonCodes.length === 0,
    reasonCodes,
    affectedZones,
    visibleZones,
  };
}

function sessionDocumentPolicy(session = {}) {
  return normalizeDocumentPolicy(parseJson(session.redactionPolicyJson, {}));
}

function normalizeDocumentPolicy(policy = {}) {
  const raw = policy && typeof policy === 'object' ? policy : {};
  const merged = {
    ...defaultRedactionPolicy(),
    ...raw,
  };
  if (raw.accepts_tower_messages !== undefined && raw.acceptsTowerMessages === undefined) {
    merged.acceptsTowerMessages = raw.accepts_tower_messages;
  }
  if (raw.allowed_document_kinds !== undefined && raw.allowedDocumentKinds === undefined) {
    merged.allowedDocumentKinds = raw.allowed_document_kinds;
  }
  if (raw.visible_zones !== undefined && raw.visibleZones === undefined) {
    merged.visibleZones = raw.visible_zones;
  }
  if (raw.allowedZones !== undefined && raw.visibleZones === undefined && raw.visible_zones === undefined) {
    merged.visibleZones = raw.allowedZones;
  }
  if (raw.allowed_zones !== undefined && raw.visibleZones === undefined && raw.visible_zones === undefined) {
    merged.visibleZones = raw.allowed_zones;
  }
  if (raw.allowedPaths !== undefined && raw.visibleZones === undefined && raw.visible_zones === undefined && raw.allowedZones === undefined && raw.allowed_zones === undefined) {
    merged.visibleZones = raw.allowedPaths;
  }
  if (raw.allowed_paths !== undefined && raw.visibleZones === undefined && raw.visible_zones === undefined && raw.allowedZones === undefined && raw.allowed_zones === undefined) {
    merged.visibleZones = raw.allowed_paths;
  }
  if (raw.readableZones !== undefined && raw.visibleZones === undefined && raw.visible_zones === undefined && raw.allowedZones === undefined && raw.allowed_zones === undefined && raw.allowedPaths === undefined && raw.allowed_paths === undefined) {
    merged.visibleZones = raw.readableZones;
  }
  if (raw.readable_zones !== undefined && raw.visibleZones === undefined && raw.visible_zones === undefined && raw.allowedZones === undefined && raw.allowed_zones === undefined && raw.allowedPaths === undefined && raw.allowed_paths === undefined) {
    merged.visibleZones = raw.readable_zones;
  }
  if (raw.allowed_zones !== undefined && raw.allowedZones === undefined) {
    merged.allowedZones = raw.allowed_zones;
  }
  if (raw.allowed_paths !== undefined && raw.allowedPaths === undefined) {
    merged.allowedPaths = raw.allowed_paths;
  }
  if (raw.allow_attachments !== undefined && raw.allowAttachments === undefined) {
    merged.allowAttachments = raw.allow_attachments;
  }
  if (raw.redacted_fields !== undefined && raw.redactedFields === undefined) {
    merged.redactedFields = raw.redacted_fields;
  }
  return merged;
}

function documentPolicyOptedOut(policy = {}) {
  return policy.acceptsTowerMessages === false
    || policy.accepts_tower_messages === false
    || policy.documentInboxEnabled === false
    || policy.document_inbox_enabled === false
    || policy.receiveDocuments === false
    || policy.receive_documents === false
    || policy.optOut === true
    || policy.opt_out === true;
}

function documentPolicyFields(policy = {}, keys = []) {
  const value = keys.map((key) => policy[key]).find((candidate) => candidate !== undefined && candidate !== null);
  return unique(asArray(value).map((entry) => String(entry)).filter(Boolean));
}

function recipientVisibleZones(policy = {}) {
  const explicit = documentPolicyFields(policy, [
    'visibleZones',
    'visible_zones',
    'allowedZones',
    'allowed_zones',
    'allowedPaths',
    'allowed_paths',
    'readableZones',
    'readable_zones',
  ]);
  return pathsForRoute(explicit);
}

function documentAffectedZones(body = {}) {
  const payload = body.body && typeof body.body === 'object' ? body.body : {};
  return unique([
    ...asArray(body.affectedZones || body.affected_zones),
    ...asArray(body.affectedZone || body.affected_zone),
    ...asArray(body.affectedZoneKey || body.affected_zone_key),
    ...asArray(body.zoneKey || body.zone_key),
    ...asArray(payload.affectedZones || payload.affected_zones),
    ...asArray(payload.affectedZone || payload.affected_zone),
    ...asArray(payload.affectedZoneKey || payload.affected_zone_key),
    ...asArray(payload.zoneKey || payload.zone_key),
  ].map((entry) => String(entry).replace(/\\/g, '/').replace(/^\/+/, '')).filter(Boolean));
}

function affectedZonesVisibleToRecipient(affectedZones = [], visibleZones = ['**']) {
  if (!affectedZones.length) return true;
  if (visibleZones.includes('**')) return true;
  if (!visibleZones.length) return false;
  return affectedZones.every((affectedZone) => visibleZones.some((visibleZone) => (
    affectedZone === visibleZone
    || pathPatternsOverlap(affectedZone, visibleZone)
  )));
}

function normalizedPolicyField(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

async function loadAgentInbox(workspaceSlug, session) {
  const items = await prisma.codeSiteAgentInboxItem.findMany({
    where: { agentSessionId: session.id },
    orderBy: { createdAt: 'asc' },
  });
  return items.map(inboxProjection);
}

async function acknowledgeAgentInboxItem(workspaceSlug, session, eventId) {
  const item = await prisma.codeSiteAgentInboxItem.findFirst({
    where: { agentSessionId: session.id, eventId, project: { workspaceSlug } },
  });
  if (!item) throw notFound('inbox_item_not_found');
  const updated = await prisma.codeSiteAgentInboxItem.update({
    where: { id: item.id },
    data: { status: 'acknowledged', acknowledgedAt: new Date() },
  });
  await recordEvent(session.projectId, {
    eventType: 'transponder_update',
    displayCallsign: session.displayCallsign,
    actorType: 'agent_session',
    actorId: session.id,
    details: {
      type: 'inbox_acknowledged',
      inboxItemId: item.id,
      eventId: item.eventId,
      documentId: item.documentId,
      status: 'acknowledged',
    },
  });
  return inboxProjection(updated);
}

export async function getAgentInboxForAgent(
  workspaceSlug,
  agentSessionId,
  agentAccessToken,
) {
  const { session, authorizedAt: now } = await requireAgentTokenAuthority(
    workspaceSlug,
    agentSessionId,
    agentAccessToken,
  );
  return loadAgentInbox(workspaceSlug, session);
}

export async function acknowledgeInboxItemForAgent(
  workspaceSlug,
  agentSessionId,
  eventId,
  agentAccessToken,
) {
  const { session } = await requireAgentTokenAuthority(
    workspaceSlug,
    agentSessionId,
    agentAccessToken,
  );
  return acknowledgeAgentInboxItem(workspaceSlug, session, eventId);
}

export async function getAgentInbox(workspaceSlug, agentSessionId, actor = null) {
  const session = await prisma.codeSiteAgentSession.findFirst({
    where: { id: agentSessionId, project: { workspaceSlug } },
  });
  if (!session) throw notFound('agent_session_not_found');
  requireAgentInboxAccess(session, actor);
  return loadAgentInbox(workspaceSlug, session);
}

export async function acknowledgeInboxItem(workspaceSlug, agentSessionId, eventId, actor = null) {
  const session = await prisma.codeSiteAgentSession.findFirst({
    where: { id: agentSessionId, project: { workspaceSlug } },
  });
  if (!session) throw notFound('agent_session_not_found');
  requireAgentInboxAccess(session, actor);
  return acknowledgeAgentInboxItem(workspaceSlug, session, eventId);
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

export async function createIncident(workspaceSlug, projectId, body = {}, actor = null) {
  const project = await requireProject(workspaceSlug, projectId, actor, 'write');
  const category = String(body.category || body.kind || 'near_miss').toLowerCase();
  const participants = unique([
    ...oneOrMany(body.participants),
    ...oneOrMany(body.displayCallsign || body.callsign),
  ].map(String).filter(Boolean));
  const affectedZones = affectedZonesForIncident(project, body, category);
  const evidenceRefs = unique(asArray(body.evidenceRefs || body.evidence_refs || []));
  const policyDelta = body.policyDelta || body.policy_delta || null;
  const initialEvents = await findIncidentReplayEvents(project.id, {
    body,
    participants,
    affectedZones,
  });
  const replay = buildIncidentReplayPacket({
    project,
    incident: {
      id: null,
      severity: body.severity || 'medium',
      category,
      participants,
      affectedZones,
      evidenceRefs,
      policyDelta,
      createdAt: new Date().toISOString(),
    },
    body,
    events: initialEvents,
  });
  const incident = await prisma.codeSiteIncident.create({
    data: {
      projectId: project.id,
      severity: body.severity || 'medium',
      category,
      participantsJson: stringifyJson(participants),
      affectedZonesJson: stringifyJson(affectedZones),
      incidentReplayJson: stringifyJson(replay),
      replayDigest: digest(replay),
      timelineEventRefsJson: stringifyJson(replay.eventRefs),
      policyDeltaJson: stringifyJson(policyDelta),
      evidenceRefsJson: stringifyJson(evidenceRefs),
    },
  });
  const incidentEvent = await recordEvent(project.id, {
    eventType: category === 'near_miss' ? 'near_miss' : 'mayday',
    displayCallsign: body.displayCallsign || body.callsign || null,
    actorType: 'incident',
    actorId: incident.id,
    evidenceRefs,
    details: {
      incidentId: incident.id,
      severity: incident.severity,
      category: incident.category,
      replayDigest: incident.replayDigest,
      affectedZones,
    },
  });
  const incidentPolicyDelta = await persistIncidentPolicyDeltaCandidate(project, incident, {
    category,
    affectedZones,
    evidenceRefs,
    policyDelta,
    body,
  });
  const policyDeltaEvent = incidentPolicyDelta
    ? await recordIncidentPolicyDeltaEvent(project.id, incident, incidentPolicyDelta, evidenceRefs)
    : null;
  const counterfactualManualEditLinks = await appendCounterfactualManualEditsFromIncident(project.id, incident, {
    body,
    affectedZones,
    evidenceRefs,
    policyDelta: incidentPolicyDelta || policyDelta,
  });

  if (category !== 'mayday') {
    return finalizeIncidentReplay(project, incident, body, {
      participants,
      affectedZones,
      evidenceRefs,
      policyDelta: incidentPolicyDelta || policyDelta,
      counterfactualManualEditLinks,
      timelineEventRefs: [incidentEvent.id, policyDeltaEvent?.id].filter(Boolean),
      extraEvents: [incidentEvent, policyDeltaEvent].filter(Boolean),
    });
  }

  const workflow = await applyMaydayGroundStop(project, incident, body, {
    affectedZones,
    participants,
    incidentEvent,
  });
  const timelineEventRefs = unique([
    ...asArray(body.timelineEventRefs || body.timeline_event_refs),
    incidentEvent.id,
    policyDeltaEvent?.id,
    ...workflow.timelineEventRefs,
  ].filter(Boolean));
  const updated = await finalizeIncidentReplay(project, incident, body, {
    participants,
    affectedZones,
    evidenceRefs,
    policyDelta: incidentPolicyDelta || policyDelta,
    counterfactualManualEditLinks,
    timelineEventRefs,
    extraEvents: [incidentEvent, policyDeltaEvent].filter(Boolean),
    maydayWorkflow: workflow.replay,
  });
  return {
    ...updated,
    maydayWorkflow: workflow.summary,
  };
}

export async function resumeMaydayIncident(workspaceSlug, incidentId, body = {}, actor = null) {
  const incident = await prisma.codeSiteIncident.findFirst({
    where: { id: incidentId, project: { workspaceSlug } },
    include: { project: { include: PROJECT_INCLUDE } },
  });
  if (!incident) throw notFound('incident_not_found');
  if (incident.category !== 'mayday') throw badRequest('incident_not_mayday');
  await requireProjectAccess(incident.project, actor, 'mayday:resume');
  const approval = body.approved === true || body.approval === true || body.humanApproval === true || body.human_approval === true;
  const rationale = String(body.rationale || body.reason || body.summary || '').trim();
  if (!approval) throw badRequest('mayday_resume_human_approval_required');
  if (!rationale) throw badRequest('mayday_resume_rationale_required');

  const stopWork = await findStopWorkDocumentForIncident(incident.projectId, incident.id);
  if (!stopWork) throw badRequest('mayday_stop_work_document_required');
  const stopWorkBody = parseJson(stopWork.bodyJson, {});
  const suspendedLeaseIds = unique([
    ...asArray(stopWorkBody.suspendedLeaseIds),
    ...asArray(parseJson(incident.incidentReplayJson, {})?.maydayWorkflow?.suspendedLeases).map((lease) => lease.id),
  ].filter(Boolean));
  if (!suspendedLeaseIds.length) throw badRequest('mayday_resume_no_suspended_leases');
  const inspectionRunIds = unique([
    ...asArray(body.inspectionRunIds || body.inspection_run_ids),
    stopWorkBody.inspectorRunId,
    parseJson(incident.incidentReplayJson, {})?.maydayWorkflow?.inspectorRunId,
  ].filter(Boolean));
  const inspectionDecision = await validateMaydayResumeInspections(incident.projectId, inspectionRunIds, body);
  if (!inspectionDecision.ok) {
    throw badRequest('mayday_resume_inspection_required', inspectionDecision);
  }

  const leases = await prisma.codeSiteMutationLease.findMany({
    where: { id: { in: suspendedLeaseIds }, projectId: incident.projectId },
  });
  const foundLeaseIds = new Set(leases.map((lease) => lease.id));
  const missingLeaseIds = suspendedLeaseIds.filter((id) => !foundLeaseIds.has(id));
  const blockedLeases = leases
    .filter((lease) => lease.status !== 'suspended' || lease.revokedAt || (lease.expiresAt && new Date(lease.expiresAt).getTime() <= Date.now()))
    .map((lease) => ({
      id: lease.id,
      status: lease.status,
      revokedAt: lease.revokedAt || null,
      expiresAt: lease.expiresAt || null,
    }));
  if (missingLeaseIds.length || blockedLeases.length) {
    throw badRequest('mayday_resume_lease_blocked', { missingLeaseIds, blockedLeases });
  }

  const resumedLeases = [];
  const policyDecisions = [];
  const events = [];
  for (const lease of leases) {
    const updated = await prisma.codeSiteMutationLease.update({
      where: { id: lease.id },
      data: { status: 'active' },
    });
    resumedLeases.push(mutationLeaseProjection(updated));
    const decision = await createPolicyDecision(incident.projectId, {
      mutationLeaseId: lease.id,
      displayCallsign: lease.displayCallsign,
      decision: 'allow',
      reasonCodes: ['human_resume_approved', 'inspection_passed', 'mayday_ground_stop_resolved'],
      input: {
        incidentId: incident.id,
        approval,
        rationale,
        inspectionRunIds,
      },
      decisionJson: {
        incidentId: incident.id,
        previousStatus: lease.status,
        status: 'active',
        resumedByUserId: actorUserId(actor),
        rationale,
      },
    });
    policyDecisions.push(policyDecisionProjection(decision));
  }

  const approvedAt = new Date();
  const resolvedBody = {
    ...stopWorkBody,
    resumeGate: {
      ...(stopWorkBody.resumeGate || {}),
      requiresHumanApproval: true,
      status: 'approved',
      approvedByUserId: actorUserId(actor),
      approvedAt: approvedAt.toISOString(),
      rationale,
      inspectionRunIds,
      resumedLeaseIds: resumedLeases.map((lease) => lease.id),
    },
  };
  const resolvedDocument = await prisma.codeSiteDocument.update({
    where: { id: stopWork.id },
    data: {
      status: 'resolved',
      blocking: false,
      resolvedAt: approvedAt,
      bodyJson: stringifyJson(resolvedBody),
    },
  });
  const resumeEvent = await recordEvent(incident.projectId, {
    eventType: 'mayday_resumed',
    actorType: 'human',
    actorId: actorUserId(actor),
    evidenceRefs: unique([
      ...asArray(body.evidenceRefs || body.evidence_refs),
      ...inspectionDecision.evidenceRefs,
      `codesite:incident:${incident.id}`,
      `codesite:document:${resolvedDocument.id}`,
    ]),
    details: {
      incidentId: incident.id,
      documentId: resolvedDocument.id,
      resumedLeaseIds: resumedLeases.map((lease) => lease.id),
      inspectionRunIds,
      rationale,
      reasonCodes: ['human_resume_approved', 'inspection_passed', 'mayday_ground_stop_resolved'],
    },
  });
  events.push(resumeEvent);

  const priorReplay = parseJson(incident.incidentReplayJson, {});
  const updatedIncident = await finalizeIncidentReplay(incident.project, incident, {
    ...body,
    timelineEventRefs: unique([
      ...asArray(priorReplay.eventRefs),
      resumeEvent.id,
    ]),
  }, {
    participants: parseJson(incident.participantsJson, []),
    affectedZones: parseJson(incident.affectedZonesJson, []),
    evidenceRefs: unique([
      ...parseJson(incident.evidenceRefsJson, []),
      ...asArray(body.evidenceRefs || body.evidence_refs),
      ...inspectionDecision.evidenceRefs,
    ]),
    timelineEventRefs: unique([
      ...asArray(priorReplay.eventRefs),
      resumeEvent.id,
    ]),
    extraEvents: events,
    maydayWorkflow: {
      ...(priorReplay.maydayWorkflow || {}),
      humanResumeRequired: false,
      resumeGate: resolvedBody.resumeGate,
      resumedLeases: resumedLeases.map((lease) => ({ id: lease.id, displayCallsign: lease.displayCallsign, status: lease.status })),
      policyDecisionIds: policyDecisions.map((decision) => decision.id),
    },
  });

  return {
    ok: true,
    incident: updatedIncident,
    resumedLeases,
    stopWorkDocument: documentProjection(resolvedDocument),
    policyDecisions,
    event: eventProjection(resumeEvent),
  };
}

async function findStopWorkDocumentForIncident(projectId, incidentId) {
  const documents = await prisma.codeSiteDocument.findMany({
    where: { projectId, kind: 'stop_work', status: { in: ['open', 'blocked', 'pending'] } },
    orderBy: { createdAt: 'desc' },
  });
  return documents.find((document) => parseJson(document.bodyJson, {})?.incidentId === incidentId) || null;
}

async function validateMaydayResumeInspections(projectId, inspectionRunIds = [], body = {}) {
  if (!inspectionRunIds.length) {
    return { ok: false, reasonCodes: ['mayday_resume_inspection_run_required'], inspectionRunIds: [] };
  }
  const runs = await prisma.codeSiteInspectionRun.findMany({
    where: { projectId, id: { in: inspectionRunIds } },
  });
  const evidenceRefs = unique(runs.flatMap((run) => parseJson(run.evidenceRefsJson, [])));
  const missingRunIds = inspectionRunIds.filter((id) => !runs.some((run) => run.id === id));
  const incompleteRuns = runs.filter((run) => !['completed', 'passed', 'green'].includes(String(run.status || '').toLowerCase()));
  const badSignals = runs.flatMap((run) => parseJson(run.inspectionSignalsJson, [])
    .filter((signal) => ['failed', 'blocked', 'red'].includes(String(signal.status || '').toLowerCase()))
    .map((signal) => ({ inspectionRunId: run.id, key: signal.key || null, status: signal.status })));
  const override = body.override === true || body.overrideResume === true || body.override_resume === true;
  const reasonCodes = [
    ...(missingRunIds.length ? ['mayday_resume_inspection_missing'] : []),
    ...(incompleteRuns.length ? ['mayday_resume_inspection_incomplete'] : []),
    ...(!evidenceRefs.length ? ['mayday_resume_inspection_evidence_required'] : []),
    ...(badSignals.length && !override ? ['mayday_resume_failed_signal_override_required'] : []),
  ];
  return {
    ok: reasonCodes.length === 0,
    reasonCodes,
    inspectionRunIds,
    missingRunIds,
    incompleteRunIds: incompleteRuns.map((run) => run.id),
    badSignals,
    evidenceRefs,
  };
}

async function recordIncidentPolicyDeltaEvent(projectId, incident, policyDelta, evidenceRefs = []) {
  return recordEvent(projectId, {
    eventType: 'policy_delta_proposed',
    displayCallsign: null,
    actorType: 'incident',
    actorId: incident.id,
    evidenceRefs,
    details: {
      incidentId: incident.id,
      policyDelta,
      reason: 'incident_replay_policy_delta',
    },
  });
}

async function persistIncidentPolicyDeltaCandidate(project, incident, context = {}) {
  const candidate = context.policyDelta || inferIncidentPolicyDeltaCandidate(project, incident, context);
  if (!candidate) return null;
  const ruleCandidate = normalizePolicyDeltaRuleCandidate(candidate.ruleCandidate || candidate.rule_candidate || candidate);
  const triggerConditions = asArray(candidate.triggerConditions || candidate.trigger_conditions || candidate.affectedRoutes || candidate.affected_routes || context.affectedZones)
    .map((item) => (typeof item === 'string' ? { path: item } : item))
    .filter(Boolean);
  const affectedZones = policyDeltaAffectedZones(ruleCandidate, triggerConditions, candidate);
  const delta = await prisma.codeSitePolicyDelta.create({
    data: {
      projectId: project.id,
      learnedFromIncidentsJson: stringifyJson(unique([
        incident.id,
        ...asArray(candidate.learnedFromIncidents || candidate.learned_from_incidents || candidate.affectedIncidents || candidate.affected_incidents),
      ].filter(Boolean))),
      affectedZoneKey: candidate.affectedZoneKey || candidate.affected_zone_key || affectedZoneKeyForPaths(affectedZones) || null,
      ruleCandidateJson: stringifyJson(ruleCandidate),
      triggerConditionsJson: stringifyJson(triggerConditions.length ? triggerConditions : pathTriggerConditions(affectedZones)),
      expectedRiskReduction: typeof candidate.expectedRiskReduction === 'number'
        ? candidate.expectedRiskReduction
        : candidate.expected_risk_reduction ?? incidentRiskReduction(incident),
      confidence: typeof candidate.confidence === 'number'
        ? candidate.confidence
        : incidentPolicyConfidence(incident, context),
      promotionState: 'proposed',
      replayRefsJson: stringifyJson(unique([
        `incident:${incident.id}`,
        `codesite:incident:${incident.id}`,
        incident.replayDigest && `replay:${incident.replayDigest}`,
        ...asArray(candidate.replayRefs || candidate.replay_refs),
        ...asArray(context.evidenceRefs),
      ].filter(Boolean))),
      promotedAt: null,
    },
  });
  return policyDeltaProjection(delta);
}

function inferIncidentPolicyDeltaCandidate(project, incident, context = {}) {
  if (String(incident.category || context.category || '').toLowerCase() !== 'near_miss') return null;
  const affectedZones = unique(pathsForRoute(context.affectedZones || parseJson(incident.affectedZonesJson, [])));
  const participants = parseJson(incident.participantsJson, []);
  const evidenceRefs = asArray(context.evidenceRefs);
  if (!affectedZones.length && !evidenceRefs.length) return null;
  return {
    learnedFromIncidents: [incident.id],
    affectedZoneKey: affectedZoneKeyForPaths(affectedZones),
    affectedRoutes: affectedZones,
    ruleCandidate: {
      rule: 'near_miss_replay_requires_airspace_rule',
      learningSignals: ['near_miss_policy_delta'],
      requiredTowerActions: [
        'replay_near_miss_before_matching_clearance',
        'require_tower_sequence_for_repeated_zone',
      ],
      participants,
      evidenceBasis: {
        category: incident.category,
        severity: incident.severity,
        evidenceRefs,
        projectId: project.id,
      },
    },
    triggerConditions: [
      ...pathTriggerConditions(affectedZones),
      { event: 'near_miss.detected' },
    ],
    expectedRiskReduction: incidentRiskReduction(incident),
    confidence: incidentPolicyConfidence(incident, context),
  };
}

function incidentRiskReduction(incident) {
  const severity = String(incident.severity || '').toLowerCase();
  if (severity === 'critical') return 0.36;
  if (severity === 'high') return 0.3;
  if (severity === 'medium') return 0.22;
  return 0.16;
}

function incidentPolicyConfidence(incident, context = {}) {
  const severity = String(incident.severity || '').toLowerCase();
  const base = ({ critical: 0.82, high: 0.76, medium: 0.7, low: 0.64 }[severity] || 0.68);
  return roundTo(clamp(base + Math.min(0.08, asArray(context.evidenceRefs).length * 0.02), 0.5, 0.94), 3);
}

async function appendCounterfactualManualEditsFromIncident(projectId, incident, context = {}) {
  const manualEdits = incidentManualEdits(context.body, incident, context);
  const refs = counterfactualRunRefsFromIncidentContext(context.body, context.evidenceRefs);
  if (!manualEdits.length || (!refs.runIds.length && !refs.shadowJobRefs.length)) {
    return { linkedRunIds: [], manualEditCount: manualEdits.length };
  }
  const rows = await prisma.codeSiteCounterfactualRun.findMany?.({
    where: {
      projectId,
      OR: [
        ...(refs.runIds.length ? [{ id: { in: refs.runIds } }] : []),
        ...(refs.shadowJobRefs.length ? [{ shadowJobRef: { in: refs.shadowJobRefs } }] : []),
      ],
    },
  });
  const runs = Array.isArray(rows) ? rows : [];
  for (const run of runs) {
    const existing = parseJson(run.laterManualEditsJson, []);
    const merged = uniqueByStableJson([...asArray(existing), ...manualEdits]);
    await prisma.codeSiteCounterfactualRun.update?.({
      where: { id: run.id },
      data: { laterManualEditsJson: stringifyJson(merged) },
    });
  }
  return {
    linkedRunIds: runs.map((run) => run.id).filter(Boolean),
    manualEditCount: manualEdits.length,
    unresolvedRunIds: refs.runIds.filter((id) => !runs.some((run) => run.id === id)),
    unresolvedShadowJobRefs: refs.shadowJobRefs.filter((ref) => !runs.some((run) => run.shadowJobRef === ref)),
  };
}

function incidentManualEdits(body = {}, incident, context = {}) {
  const explicit = asArray(
    body.laterManualEdits ||
    body.later_manual_edits ||
    body.manualEdits ||
    body.manual_edits ||
    body.manualRewrites ||
    body.manual_rewrites,
  );
  const inferred = explicit.length ? [] : pathsForRoute([
    ...asArray(body.changedPaths || body.changed_paths),
    ...asArray(body.writeSet || body.write_set),
    ...asArray(context.affectedZones),
  ]).map((pathValue) => ({
    path: pathValue,
    reason: body.reason || body.summary || 'incident_reported_manual_rewrite',
  }));
  return [...explicit, ...inferred]
    .map((edit) => {
      const row = typeof edit === 'object' && edit ? edit : { summary: String(edit) };
      return {
        ...row,
        incidentId: incident.id,
        incidentCategory: incident.category,
        incidentSeverity: incident.severity,
        evidenceRefs: unique([
          ...asArray(row.evidenceRefs || row.evidence_refs),
          ...asArray(context.evidenceRefs),
        ].map(String).filter(Boolean)),
        policyDeltaId: context.policyDelta?.id || row.policyDeltaId || row.policy_delta_id || null,
      };
    })
    .filter((edit) => counterfactualPathRefs(edit).length || edit.summary || edit.reason || edit.evidenceRefs.length);
}

function counterfactualRunRefsFromIncidentContext(body = {}, evidenceRefs = []) {
  const rawRefs = [
    ...asArray(body.counterfactualRunId || body.counterfactual_run_id),
    ...asArray(body.counterfactualRunIds || body.counterfactual_run_ids),
    ...asArray(body.counterfactualRuns || body.counterfactual_runs),
    ...asArray(body.replayRefs || body.replay_refs),
    ...asArray(evidenceRefs),
  ].flatMap((value) => {
    if (!value) return [];
    if (typeof value === 'object') return [value.id, value.ref, value.counterfactualRunId, value.counterfactual_run_id].filter(Boolean);
    return [String(value)];
  });
  const runIds = [];
  const shadowJobRefs = [
    ...asArray(body.shadowJobRef || body.shadow_job_ref).map(String).filter(Boolean),
    ...asArray(body.shadowJobRefs || body.shadow_job_refs).map(String).filter(Boolean),
  ];
  for (const ref of rawRefs) {
    const runMatch = String(ref).match(/^codesite:counterfactual-run:(.+)$/);
    const shadowMatch = String(ref).match(/^shadow:job:(.+)$/);
    if (runMatch) runIds.push(runMatch[1]);
    else if (shadowMatch) shadowJobRefs.push(shadowMatch[1]);
    else if (/^cfr[-_a-zA-Z0-9]+/.test(String(ref))) runIds.push(String(ref));
  }
  return {
    runIds: unique(runIds),
    shadowJobRefs: unique(shadowJobRefs),
  };
}

async function finalizeIncidentReplay(project, incident, body = {}, context = {}) {
  const selectedEvents = await findIncidentReplayEvents(project.id, {
    body,
    participants: context.participants,
    affectedZones: context.affectedZones,
    timelineEventRefs: context.timelineEventRefs,
    extraEvents: context.extraEvents,
  });
  const replay = buildIncidentReplayPacket({
    project,
    incident: {
      id: incident.id,
      severity: incident.severity,
      category: incident.category,
      participants: context.participants,
      affectedZones: context.affectedZones,
      evidenceRefs: context.evidenceRefs,
      policyDelta: context.policyDelta,
      counterfactualManualEditLinks: context.counterfactualManualEditLinks,
      createdAt: incident.createdAt,
    },
    body,
    events: selectedEvents,
    maydayWorkflow: context.maydayWorkflow,
  });
  const updated = await prisma.codeSiteIncident.update({
    where: { id: incident.id },
    data: {
      timelineEventRefsJson: stringifyJson(replay.eventRefs),
      incidentReplayJson: stringifyJson(replay),
      replayDigest: digest(replay),
      policyDeltaJson: stringifyJson(context.policyDelta || null),
    },
  });
  await syncArtifactsForProject(project.id, { reason: 'incident_replay_finalized' });
  return incidentProjection(updated);
}

async function closeTransactionBlackBox(workspaceSlug, transaction, context = {}) {
  const project = await requireProject(workspaceSlug, transaction.projectId);
  const body = transactionBlackBoxReplayBody(transaction, context);
  const participants = body.participants;
  const affectedZones = body.affectedZones;
  const existing = await findExistingTransactionBlackBoxIncident(project.id, transaction.id);
  const initialEvents = await findTransactionBlackBoxEvents(project.id, transaction, {
    participants,
    affectedZones,
    extraEvents: [context.terminalEvent].filter(Boolean),
    proofBundle: context.bundle,
  });
  const baseIncident = transactionBlackBoxIncidentEnvelope(existing, body, project);
  const priorReplay = parseJson(existing?.incidentReplayJson, existing?.incidentReplay || {});
  const initialReplay = buildIncidentReplayPacket({
    project,
    incident: baseIncident,
    body,
    events: initialEvents,
  });
  let incident = existing
    ? await prisma.codeSiteIncident.update({
      where: { id: existing.id },
      data: {
        severity: body.severity,
        participantsJson: stringifyJson(participants),
        affectedZonesJson: stringifyJson(affectedZones),
        incidentReplayJson: stringifyJson(initialReplay),
        replayDigest: digest(initialReplay),
        timelineEventRefsJson: stringifyJson(initialReplay.eventRefs),
        policyDeltaJson: stringifyJson(null),
        evidenceRefsJson: stringifyJson(body.evidenceRefs),
      },
    })
    : await prisma.codeSiteIncident.create({
      data: {
        projectId: project.id,
        severity: body.severity,
        category: 'black_box',
        participantsJson: stringifyJson(participants),
        affectedZonesJson: stringifyJson(affectedZones),
        incidentReplayJson: stringifyJson(initialReplay),
        replayDigest: digest(initialReplay),
        timelineEventRefsJson: stringifyJson(initialReplay.eventRefs),
        policyDeltaJson: stringifyJson(null),
        evidenceRefsJson: stringifyJson(body.evidenceRefs),
      },
    });

  const closeAlreadyRecorded = asArray(priorReplay.causalEvents).some((event) => (
    event.type === 'black_box.closed'
    && event.details?.transactionId === transaction.id
    && (!context.bundle?.id || event.details?.proofBundleId === context.bundle.id)
  ));
  const closeEvent = closeAlreadyRecorded ? null : await recordEvent(project.id, {
    mutationLeaseId: transaction.mutationLeaseId,
    eventType: 'black_box_closed',
    displayCallsign: transaction.mutationLease?.displayCallsign || null,
    actorType: 'transaction',
    actorId: transaction.id,
    evidenceRefs: body.evidenceRefs,
    details: {
      transactionId: transaction.id,
      incidentId: incident.id,
      proofBundleId: context.bundle?.id || null,
      proofBundleDigest: context.bundle?.bundleDigest || null,
      landingStatus: context.landingStatus || context.terminalStatus || transaction.status,
      status: context.terminalStatus || transaction.status,
      readSet: body.transactionContext.readSet,
      writeSet: body.transactionContext.writeSet,
      exportedPaths: body.handover.exportPaths,
      reason: 'transaction_black_box_closeout',
    },
  });

  const finalEvents = await findTransactionBlackBoxEvents(project.id, transaction, {
    participants,
    affectedZones,
    extraEvents: [context.terminalEvent, closeEvent].filter(Boolean),
    proofBundle: context.bundle,
  });
  const finalReplay = buildIncidentReplayPacket({
    project,
    incident: {
      ...baseIncident,
      id: incident.id,
      createdAt: incident.createdAt,
    },
    body,
    events: finalEvents,
  });
  const replayDigest = digest(finalReplay);
  incident = await prisma.codeSiteIncident.update({
    where: { id: incident.id },
    data: {
      incidentReplayJson: stringifyJson(finalReplay),
      replayDigest,
      timelineEventRefsJson: stringifyJson(finalReplay.eventRefs),
    },
  });

  let proofBundle = context.bundle || null;
  if (context.bundle?.id) {
    const landingRuns = asArray(context.inspectionDecision?.inspectionRuns);
    const lineProvenance = await prisma.codeSiteLineProvenance.findMany({
      where: { proofBundleId: context.bundle.id },
      orderBy: { createdAt: 'asc' },
    });
    proofBundle = await prisma.codeSiteProofBundle.update({
      where: { id: context.bundle.id },
      data: {
        incidentReplayDigest: replayDigest,
        landingStatus: context.bundle.landingStatus || context.landingStatus || context.terminalStatus || transaction.status || null,
      },
    });
    proofBundle = await signProofBundleRecord(proofBundle, {
      project,
      transaction,
      mutationLease: transaction.mutationLease,
      landingStatus: context.landingStatus || context.terminalStatus || transaction.status || null,
      incidents: [incident],
      landingRuns,
      lineProvenance,
    });
  }
  await syncArtifactsForProject(project.id, {
    reason: 'transaction_black_box_closed',
    eventId: closeEvent?.id || context.terminalEvent?.id || null,
  });
  return {
    incident: incidentProjection(incident),
    replay: finalReplay,
    replayDigest,
    proofBundle,
    portableProofBundle: proofBundle ? proofBundlePortable(proofBundle, {
      project,
      transaction,
      mutationLease: transaction.mutationLease,
      incidents: [incident],
      landingRuns: asArray(context.inspectionDecision?.inspectionRuns),
      lineProvenance: proofBundle?.id
        ? await prisma.codeSiteLineProvenance.findMany({
          where: { proofBundleId: proofBundle.id },
          orderBy: { createdAt: 'asc' },
        })
        : [],
    }) : null,
    event: closeEvent,
  };
}

function transactionBlackBoxReplayBody(transaction, context = {}) {
  const readSet = parseJson(transaction.readSetJson, []);
  const observedReadSet = parseJson(transaction.observedReadSetJson, []);
  const writeSet = parseJson(transaction.writeSetJson, []);
  const observedWriteSet = parseJson(transaction.observedWriteSetJson, []);
  const semanticDependencyRefs = parseJson(transaction.semanticDependencyRefsJson, []);
  const assumptionRefs = parseJson(transaction.assumptionRefsJson, []);
  const changedPaths = unique([...writeSet, ...observedWriteSet]);
  const affectedZones = unique(pathsForRoute([
    ...readSet,
    ...observedReadSet,
    ...changedPaths,
    ...dependencyPathRefs(semanticDependencyRefs),
  ]));
  const displayCallsign = transaction.mutationLease?.displayCallsign || null;
  const repoState = context.repoStateDecision?.repoState || null;
  const inspectionRuns = asArray(context.inspectionDecision?.inspectionRuns).map((run) => (
    run?.changedPathsJson ? inspectionProjection(run) : run
  ));
  const proofBundle = proofBundleBlackBoxContext(context.bundle);
  const evidenceRefs = unique([
    ...asArray(context.body?.evidenceRefs || context.body?.evidence_refs),
    ...proofBundle.evidenceRefs,
    ...asArray(context.inspectionDecision?.evidenceRefs),
    ...(repoState?.evidenceDigest ? [`codesite:repo-state:${repoState.evidenceDigest}`] : []),
    ...(context.bundle?.id ? [`codesite:proof-bundle:${context.bundle.id}`] : []),
    `codesite:transaction:${transaction.id}`,
    `codesite:lease:${transaction.mutationLeaseId}`,
  ]);
  const transactionStatus = context.terminalStatus || transaction.status || 'closed';
  const exportPaths = transactionBlackBoxExportPaths(transaction.projectId, transaction.id, displayCallsign, context.bundle?.id);
  return {
    category: 'black_box',
    severity: transactionStatus === 'aborted' ? 'warning' : 'low',
    summary: `Transaction ${transaction.id} black-box handover ${transactionStatus}.`,
    participants: unique([displayCallsign].filter(Boolean)),
    affectedZones,
    evidenceRefs,
    transactionContext: {
      id: transaction.id,
      projectId: transaction.projectId,
      mutationLeaseId: transaction.mutationLeaseId,
      agentSessionId: transaction.agentSessionId,
      displayCallsign,
      baseSnapshot: transaction.baseSnapshot,
      baseSnapshotEvidence: parseJson(transaction.baseSnapshotEvidenceJson, null),
      isolation: transaction.isolation,
      status: transactionStatus,
      readSet,
      observedReadSet,
      writeSet,
      observedWriteSet,
      semanticDependencyRefs,
      assumptionRefs,
      validationDecision: context.validationDecision || parseJson(transaction.commitDecisionJson, null),
      repoState,
      lineProvenance: context.lineProvenanceDecision || null,
      openedAt: transaction.openedAt,
      closedAt: transaction.closedAt,
    },
    proofBundle,
    handover: {
      status: transactionStatus,
      landingStatus: context.landingStatus || transactionStatus,
      changedPaths,
      inspectionRuns,
      inspectionRunIds: inspectionRuns.map((run) => run.id).filter(Boolean),
      repoStateDigest: repoState?.evidenceDigest || null,
      proofBundleId: context.bundle?.id || null,
      proofBundleDigest: context.bundle?.bundleDigest || null,
      exportPaths,
    },
  };
}

function transactionBlackBoxIncidentEnvelope(existing, body, project) {
  return {
    id: existing?.id || null,
    severity: body.severity,
    category: 'black_box',
    participants: body.participants,
    affectedZones: body.affectedZones,
    evidenceRefs: body.evidenceRefs,
    policyDelta: null,
    createdAt: existing?.createdAt || new Date().toISOString(),
    projectId: project.id,
  };
}

function proofBundleBlackBoxContext(bundle) {
  if (!bundle) {
    return {
      id: null,
      transactionId: null,
      commitSha: null,
      readSetDigest: null,
      writeSetDigest: null,
      bundleDigest: null,
      incidentReplayDigest: null,
      evidenceRefs: [],
      repoState: null,
    };
  }
  return {
    id: bundle.id,
    transactionId: bundle.transactionId,
    commitSha: bundle.commitSha || null,
    readSetDigest: bundle.readSetDigest,
    writeSetDigest: bundle.writeSetDigest,
    bundleDigest: bundle.bundleDigest,
    incidentReplayDigest: bundle.incidentReplayDigest || null,
    evidenceRefs: parseJson(bundle.evidenceRefsJson, bundle.evidenceRefs || []),
    repoState: parseJson(bundle.repoStateJson, bundle.repoState || null),
  };
}

function transactionBlackBoxExportPaths(projectId, transactionId, displayCallsign, proofBundleId) {
  const projectDir = `projects/${projectId}`;
  return [
    `${projectDir}/handover.md`,
    `${projectDir}/events.jsonl`,
    `${projectDir}/incidents/incident-replay-<incident-id>.jsonl`,
    `${projectDir}/flights/${safeArtifactSegment(displayCallsign || 'unknown')}/black-box.json`,
    `${projectDir}/flights/${safeArtifactSegment(displayCallsign || 'unknown')}/transaction-${transactionId}.json`,
    ...(proofBundleId ? [`${projectDir}/proof-bundles/${proofBundleId}.proof.json`] : []),
    ...(proofBundleId ? [`${projectDir}/proof-bundles/${proofBundleId}.trailers.txt`] : []),
  ];
}

function safeArtifactSegment(value) {
  return String(value || 'unknown')
    .replace(/[^a-z0-9_.-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'unknown';
}

async function findExistingTransactionBlackBoxIncident(projectId, transactionId) {
  const incidents = await prisma.codeSiteIncident.findMany({
    where: { projectId, category: 'black_box' },
    orderBy: { createdAt: 'asc' },
  });
  return asArray(incidents).find((incident) => incidentBlackBoxReferencesTransaction(incident, transactionId)) || null;
}

function incidentBlackBoxReferencesTransaction(incident, transactionId) {
  const replay = parseJson(incident.incidentReplayJson, incident.incidentReplay || {});
  const evidenceRefs = parseJson(incident.evidenceRefsJson, incident.evidenceRefs || []);
  return replay.transaction?.id === transactionId
    || replay.transactionId === transactionId
    || evidenceRefs.includes(`codesite:transaction:${transactionId}`)
    || asArray(replay.causalEvents).some((event) => event.transactionId === transactionId || event.details?.transactionId === transactionId);
}

function incidentReferencesProofBundle(incident, bundle) {
  if (!incident || !bundle) return false;
  const replay = parseJson(incident.incidentReplayJson, incident.incidentReplay || {});
  const evidenceRefs = parseJson(incident.evidenceRefsJson, incident.evidenceRefs || []);
  return evidenceRefs.includes(`codesite:proof-bundle:${bundle.id}`)
    || replay.proofBundle?.id === bundle.id
    || replay.proofBundleId === bundle.id
    || replay.proof_bundle_id === bundle.id
    || replay.handover?.proofBundleId === bundle.id
    || replay.handover?.proof_bundle_id === bundle.id
    || (bundle.incidentReplayDigest && incident.replayDigest === bundle.incidentReplayDigest)
    || (incident.category === 'black_box' && incidentBlackBoxReferencesTransaction(incident, bundle.transactionId));
}

async function findTransactionBlackBoxEvents(projectId, transaction, context = {}) {
  let rows = [];
  try {
    rows = asArray(await prisma.codeSiteEvent.findMany({
      where: { projectId },
      orderBy: EVENT_ORDER_BY,
    }));
  } catch (_) {
    rows = [];
  }
  const events = rows.map(eventProjection);
  const selected = events.filter((event) => transactionBlackBoxEventSelected(event, transaction, context));
  const byId = new Map(selected.map((event) => [event.id, event]));
  for (const event of asArray(context.extraEvents).map(safeReplayEventProjection).filter(Boolean)) {
    if (event.id && !byId.has(event.id)) byId.set(event.id, event);
  }
  return [...byId.values()].sort(compareReplayEvents);
}

function transactionBlackBoxEventSelected(event, transaction, context = {}) {
  if (!event) return false;
  const details = event.details || {};
  const explicitRefs = new Set([
    ...asArray(context.timelineEventRefs),
    ...asArray(context.eventRefs),
    ...asArray(context.extraEvents).map((item) => item?.id).filter(Boolean),
  ]);
  if (explicitRefs.has(event.id) || explicitRefs.has(event.eventType) || explicitRefs.has(replayEventType(event.eventType))) {
    return true;
  }
  if (!TRANSACTION_BLACK_BOX_EVENT_TYPES.has(event.eventType)) return false;
  const eventTransactionId = details.transactionId || details.transaction_id || (event.actorType === 'transaction' ? event.actorId : null);
  if (eventTransactionId === transaction.id) return true;
  const eventLeaseId = event.mutationLeaseId || details.mutationLeaseId || details.mutation_lease_id;
  if (eventLeaseId && eventLeaseId === transaction.mutationLeaseId) return true;
  if (context.proofBundle?.id && details.proofBundleId === context.proofBundle.id) return true;
  const displayCallsign = transaction.mutationLease?.displayCallsign;
  if (displayCallsign && event.displayCallsign === displayCallsign) return true;
  return eventTouchesAffectedZones(event, context.affectedZones);
}

async function findIncidentReplayEvents(projectId, context = {}) {
  const explicitRefs = new Set(unique([
    ...asArray(context.timelineEventRefs),
    ...asArray(context.body?.timelineEventRefs || context.body?.timeline_event_refs),
    ...asArray(context.body?.incidentReplay?.eventRefs || context.body?.incident_replay?.eventRefs),
    ...asArray(context.body?.incidentReplay?.events || context.body?.incident_replay?.events),
  ].filter(Boolean)));
  let rows = [];
  try {
    rows = asArray(await prisma.codeSiteEvent.findMany({
      where: { projectId },
      orderBy: EVENT_ORDER_BY,
    }));
  } catch (_) {
    rows = [];
  }
  const events = rows.map(eventProjection);
  const selected = events.filter((event) => incidentReplayEventSelected(event, {
    explicitRefs,
    participants: context.participants,
    affectedZones: context.affectedZones,
  }));
  const byId = new Map(selected.map((event) => [event.id, event]));
  for (const event of asArray(context.extraEvents).map(safeReplayEventProjection)) {
    if (event?.id && !byId.has(event.id)) byId.set(event.id, event);
  }
  return [...byId.values()].sort(compareReplayEvents);
}

function safeReplayEventProjection(event) {
  if (!event) return null;
  if (event.details || event.evidenceRefs) return event;
  return {
    id: event.id,
    projectId: event.projectId,
    mutationLeaseId: event.mutationLeaseId,
    eventType: event.eventType,
    displayCallsign: event.displayCallsign,
    actorType: event.actorType,
    actorId: event.actorId,
    details: parseJson(event.detailsJson, event.details || {}),
    evidenceRefs: parseJson(event.evidenceRefsJson, event.evidenceRefs || []),
    logicalTime: event.logicalTime,
    createdAt: event.createdAt,
  };
}

function incidentReplayEventSelected(event, context = {}) {
  if (!event) return false;
  const explicitRefs = context.explicitRefs || new Set();
  if (explicitRefs.has(event.id) || explicitRefs.has(event.eventType) || explicitRefs.has(replayEventType(event.eventType))) {
    return true;
  }
  const participants = new Set(asArray(context.participants));
  if (event.displayCallsign && participants.has(event.displayCallsign)) return true;
  return eventTouchesAffectedZones(event, context.affectedZones);
}

function eventTouchesAffectedZones(event, affectedZones = []) {
  const zones = asArray(affectedZones);
  if (!zones.length) return false;
  const details = event.details || {};
  const paths = unique(normalizePathList([
    details.path,
    details.zone?.path,
    ...asArray(details.changedPaths || details.writeSet || details.readSet || details.allowedPaths),
    ...asArray(details.zone?.paths),
    ...asArray(details.affectedZones),
  ]));
  if (!paths.length) return false;
  return paths.some((eventPath) => zones.some((zonePath) => pathPatternsOverlap(eventPath, zonePath)));
}

function compareReplayEvents(left, right) {
  const leftTime = Number.isFinite(left.logicalTime) ? left.logicalTime : Number.MAX_SAFE_INTEGER;
  const rightTime = Number.isFinite(right.logicalTime) ? right.logicalTime : Number.MAX_SAFE_INTEGER;
  if (leftTime !== rightTime) return leftTime - rightTime;
  const leftWall = new Date(left.createdAt || 0).getTime();
  const rightWall = new Date(right.createdAt || 0).getTime();
  if (leftWall !== rightWall) return leftWall - rightWall;
  return String(left.id || '').localeCompare(String(right.id || ''));
}

function buildIncidentReplayPacket({ project, incident, body = {}, events = [], maydayWorkflow = null }) {
  const causalEvents = events.map(normalizeIncidentReplayEvent).filter(Boolean);
  const evidenceRefs = unique([
    ...asArray(incident.evidenceRefs),
    ...causalEvents.flatMap((event) => asArray(event.evidenceRefs)),
  ]);
  const transactionContext = body.transactionContext || body.transaction_context || null;
  const proofBundle = body.proofBundle || body.proof_bundle || null;
  const handover = body.handover || null;
  const completeness = incidentReplayCompleteness(causalEvents, {
    category: incident.category,
    transactionContext,
    proofBundle,
    handover,
  });
  return {
    schemaVersion: 'synthi.codesite.incidentReplay.v1',
    incidentId: incident.id,
    projectId: project.id,
    category: incident.category,
    severity: incident.severity,
    summary: body.summary || body.reason || 'CodeSite incident',
    generatedAt: new Date().toISOString(),
    eventRefs: causalEvents.map((event) => event.eventId),
    causalEvents,
    evidenceRefs,
    routeContext: incidentReplayRouteContext(project, incident.affectedZones),
    participants: asArray(incident.participants),
    affectedZones: asArray(incident.affectedZones),
    policyDelta: incident.policyDelta || null,
    completeness,
    ...(incident.counterfactualManualEditLinks ? { counterfactualManualEditLinks: incident.counterfactualManualEditLinks } : {}),
    ...(transactionContext ? { transaction: transactionContext, transactionId: transactionContext.id || null } : {}),
    ...(proofBundle ? { proofBundle } : {}),
    ...(handover ? { handover } : {}),
    ...(maydayWorkflow ? { maydayWorkflow } : {}),
    ...(body.incidentReplay || body.incident_replay ? { operatorSuppliedReplay: body.incidentReplay || body.incident_replay } : {}),
  };
}

function normalizeIncidentReplayEvent(event) {
  const projected = safeReplayEventProjection(event);
  if (!projected?.id || !projected.eventType) return null;
  const details = projected.details || {};
  const evidenceRefs = unique([
    ...asArray(projected.evidenceRefs),
    ...asArray(details.evidenceRefs || details.evidence_refs),
    ...asArray(details.inspectionEvidenceRefs || details.inspection_evidence_refs),
    ...asArray(details.dojoEvidenceRefs || details.dojo_evidence_refs),
  ]);
  const pathValue = details.path
    || asArray(details.changedPaths || details.writeSet || details.allowedPaths)[0]
    || null;
  return {
    eventId: projected.id,
    projectId: projected.projectId,
    transactionId: details.transactionId || details.transaction_id || (projected.actorType === 'transaction' ? projected.actorId : null),
    mutationLeaseId: projected.mutationLeaseId || details.mutationLeaseId || details.mutation_lease_id || null,
    agentSessionId: details.agentSessionId || details.agent_session_id || null,
    displayCallsign: projected.displayCallsign,
    type: replayEventType(projected.eventType),
    logicalTime: projected.logicalTime,
    wallTime: projected.createdAt,
    zoneKey: details.zone?.zoneKey || details.zoneKey || details.zone_key || details.affectedZoneKey || details.affected_zone_key || null,
    path: pathValue,
    policyDecisionId: details.policyDecisionId || details.policy_decision_id || null,
    evidenceRefs,
    details,
  };
}

function replayEventType(eventType) {
  const knowledgeEventType = canonicalKnowledgeEventType(eventType);
  if (knowledgeEventType) return knowledgeEventType;
  return {
    transaction_opened: 'transaction.opened',
    assumption_recorded: 'assumption.recorded',
    assumption_invalidated: 'assumption.invalidated',
    clearance_issued: 'clearance.issued',
    holding_pattern: 'clearance.holding',
    read_observed: 'read.observed',
    write_attempted: 'write.attempted',
    write_denied: 'write.denied',
    write_quarantined: 'write.quarantined',
    write_allowed: 'write.allowed',
    snapshot_taken: 'snapshot.taken',
    shadow_run: 'shadow.run',
    arbiter_verdict: 'arbiter.verdict',
    inspection_result: 'inspection.result',
    landing_requested: 'inspection.requested',
    near_miss: 'near_miss.detected',
    policy_delta_proposed: 'policy_delta.proposed',
    transaction_committed: 'transaction.committed',
    transaction_aborted: 'transaction.aborted',
    transaction_validated: 'transaction.validated',
    ground_stop: 'ground_stop.issued',
    mayday: 'mayday.declared',
    mayday_resumed: 'mayday.resumed',
    rfi: 'document.rfi',
    change_order: 'document.change_order',
    tower_instruction: 'tower.instruction',
    transponder_update: 'transponder.update',
    flight_plan_filed: 'flight_plan.filed',
    radar_result: 'radar.result',
    black_box_closed: 'black_box.closed',
  }[eventType] || String(eventType || 'unknown').replace(/_/g, '.');
}

function incidentReplayCompleteness(causalEvents = [], context = {}) {
  const observedTypes = unique(causalEvents.map((event) => event.type).filter(Boolean));
  const observed = new Set(observedTypes);
  const required = incidentReplayRequiredEventTypes(observed, context);
  const present = required.filter((type) => observed.has(type));
  const missing = required.filter((type) => !observed.has(type));
  const requiredEvidence = incidentReplayRequiredEvidence(context);
  const presentEvidence = requiredEvidence.filter((item) => item.present).map((item) => item.key);
  const missingEvidence = requiredEvidence.filter((item) => !item.present).map((item) => item.key);
  const totalRequired = required.length + requiredEvidence.length;
  const totalPresent = present.length + presentEvidence.length;
  return {
    score: totalRequired ? Number((totalPresent / totalRequired).toFixed(2)) : 1,
    eventScore: required.length ? Number((present.length / required.length).toFixed(2)) : 1,
    evidenceScore: requiredEvidence.length ? Number((presentEvidence.length / requiredEvidence.length).toFixed(2)) : 1,
    requiredEventTypes: required,
    presentEventTypes: present,
    missingEventTypes: missing,
    requiredEvidence: requiredEvidence.map((item) => item.key),
    presentEvidence,
    missingEvidence,
    observedEventTypes: observedTypes,
    totalEvents: causalEvents.length,
  };
}

function incidentReplayRequiredEventTypes(observed, context = {}) {
  const transactionContext = context.transactionContext || context.transaction || null;
  if (context.category !== 'black_box' || !transactionContext) return BLACK_BOX_MINIMUM_EVENT_TYPES;
  const hasProofBundle = Boolean(context.proofBundle?.id || context.proofBundle?.bundleDigest || context.handover?.proofBundleId);
  if (hasProofBundle) return BLACK_BOX_MINIMUM_EVENT_TYPES;

  const required = [
    'transaction.opened',
    'clearance.issued',
    'black_box.closed',
  ];
  const optionalWhenObserved = [
    'assumption.recorded',
    'write.attempted',
    'write.denied',
    'write.quarantined',
    'write.allowed',
    'snapshot.taken',
    'shadow.run',
    'arbiter.verdict',
    'inspection.result',
    'near_miss.detected',
    'policy_delta.proposed',
  ];
  for (const type of optionalWhenObserved) {
    if (observed.has(type)) required.push(type);
  }

  const status = String(transactionContext.status || '').toLowerCase();
  if (status === 'committed' || observed.has('transaction.committed')) {
    required.push('transaction.committed');
  } else if (status === 'aborted' || observed.has('transaction.aborted')) {
    required.push('transaction.aborted');
  }
  return unique(required);
}

function incidentReplayRequiredEvidence(context = {}) {
  if (context.category !== 'black_box' || !committedBlackBoxHandover(context)) return [];
  const proofBundle = context.proofBundle || {};
  const handover = context.handover || {};
  const proofBundleId = proofBundle.id || handover.proofBundleId || handover.proof_bundle_id || null;
  const proofBundleDigest = proofBundle.bundleDigest || proofBundle.bundle_digest || handover.proofBundleDigest || handover.proof_bundle_digest || null;
  const proofBundleEvidenceRefs = asArray(proofBundle.evidenceRefs || proofBundle.evidence_refs);
  const exportPaths = asArray(handover.exportPaths || handover.export_paths);
  return [
    { key: 'proof_bundle_id', present: Boolean(proofBundleId) },
    { key: 'proof_bundle_digest', present: Boolean(proofBundleDigest) },
    { key: 'proof_bundle_evidence_refs', present: proofBundleEvidenceRefs.length > 0 },
    { key: 'handover_proof_bundle_id', present: Boolean(handover.proofBundleId || handover.proof_bundle_id) },
    { key: 'handover_proof_bundle_digest', present: Boolean(handover.proofBundleDigest || handover.proof_bundle_digest) },
    { key: 'proof_bundle_export_path', present: exportPaths.some((item) => String(item || '').endsWith('.proof.json')) },
    { key: 'proof_trailers_export_path', present: exportPaths.some((item) => String(item || '').endsWith('.trailers.txt')) },
  ];
}

function committedBlackBoxHandover(context = {}) {
  const status = String(
    context.handover?.status
      || context.transactionContext?.status
      || context.transaction?.status
      || '',
  ).toLowerCase();
  return ['committed', 'landed', 'closed'].includes(status);
}

function incidentReplayRouteContext(project, affectedZones = []) {
  const zonePolicy = parseJson(project.zonePolicyJson, compileZonePolicy());
  return {
    affectedZones: asArray(affectedZones),
    zones: asArray(zonePolicy.zones).map((zone) => ({
      zoneKey: zone.zoneKey,
      class: zone.class,
      label: zone.label,
      paths: asArray(zone.paths),
      risk: zone.risk || null,
      rules: asArray(zone.rules),
    })),
    noFlyZones: asArray(zonePolicy.noFlyZones),
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

export async function createInspectionRun(workspaceSlug, projectId, body = {}, actor = null) {
  const project = await requireProject(workspaceSlug, projectId, actor, 'write');
  const shouldExecute = inspectionExecutionRequested(body);
  const run = await prisma.codeSiteInspectionRun.create({
    data: {
      projectId: project.id,
      executionPlanId: body.executionPlanId || body.execution_plan_id || null,
      displayCallsign: body.displayCallsign || body.callsign || 'INSPECT-01',
      status: shouldExecute ? 'running' : body.status || 'requested',
      changedPathsJson: stringifyJson(normalizePathList(body.changedPaths || body.changed_paths || [])),
      inspectionSignalsJson: stringifyJson(asArray(body.inspectionSignals || body.inspection_signals || [])
        .map(normalizeInspectionSignalPayload)
        .filter(Boolean)),
      evidenceRefsJson: stringifyJson(body.evidenceRefs || body.evidence_refs || []),
    },
  });
  await recordEvent(project.id, {
    eventType: 'landing_requested',
    displayCallsign: run.displayCallsign,
    actorType: 'inspection',
    actorId: run.id,
    evidenceRefs: parseJson(run.evidenceRefsJson, []),
    details: {
      inspectionRunId: run.id,
      status: run.status,
      changedPaths: parseJson(run.changedPathsJson, []),
      inspectionEvidenceRefs: parseJson(run.evidenceRefsJson, []),
    },
  });
  if (!shouldExecute) return inspectionProjection(run);
  const executed = await executeInspectionRun(project, run, body);
  return inspectionProjection(executed);
}

export async function completeInspectionRun(workspaceSlug, inspectionRunId, body = {}, actor = null) {
  const run = await prisma.codeSiteInspectionRun.findFirst({
    where: { id: inspectionRunId, project: { workspaceSlug } },
  });
  if (!run) throw notFound('inspection_run_not_found');
  await requireProject(workspaceSlug, run.projectId, actor, 'write');
  if (inspectionExecutionRequested(body)) {
    const project = await requireProject(workspaceSlug, run.projectId, actor, 'write');
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
      inspectionSignalsJson: stringifyJson(asArray(body.inspectionSignals || body.inspection_signals || parseJson(run.inspectionSignalsJson, []))
        .map(normalizeInspectionSignalPayload)
        .filter(Boolean)),
      evidenceRefsJson: stringifyJson(body.evidenceRefs || body.evidence_refs || parseJson(run.evidenceRefsJson, [])),
      completedAt: new Date(),
    },
  });
  const inspectionEvidenceRefs = parseJson(updated.evidenceRefsJson, []);
  await recordEvent(run.projectId, {
    eventType: 'inspection_result',
    displayCallsign: run.displayCallsign,
    actorType: 'inspection',
    actorId: run.id,
    evidenceRefs: inspectionEvidenceRefs,
    details: {
      inspectionRunId: run.id,
      status: updated.status,
      changedPaths: parseJson(run.changedPathsJson, []),
      signals: parseJson(updated.inspectionSignalsJson, []),
      inspectionEvidenceRefs,
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
    const adapter = radarInspectionAdapterFor(executable);
    return {
      key: adapter?.key || normalizeInspectionSignal(executable) || `command_${index + 1}`,
      adapterKey: adapter?.key || null,
      executable,
      args,
      cwd: null,
      timeoutMs: null,
    };
  }
  if (!command || typeof command !== 'object') return null;
  const executable = String(command.command || command.executable || command.bin || '').trim();
  if (!executable) return null;
  const adapter = radarInspectionAdapterFor(command.adapter || command.radar || command.key || command.signal || command.name || executable);
  return {
    key: adapter?.key || normalizeInspectionSignal(command.key || command.signal || command.name || executable) || `command_${index + 1}`,
    adapterKey: adapter?.key || null,
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
  const adapter = radarInspectionAdapterFor(spec.adapterKey || spec.key);
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
    durableInspectionCommandRef(spec.key, evidenceDigest, adapter),
    `artifact:${evidenceDigest}`,
  ]);
  return {
    key: spec.key,
    ...(adapter ? { adapter: radarInspectionAdapterProjection(adapter) } : {}),
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
    reasonCodes: [
      `${adapter?.key || spec.key}_radar_${status}`,
      ...(adapter ? [`${adapter.key}_adapter_executed`] : []),
    ],
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
  const { inspectionMaxTimeoutMs: max, inspectionTimeoutMs: fallback } = getCodeSiteRuntimeConfig();
  const requested = Number(value || fallback);
  const timeout = Number.isFinite(requested) && requested > 0 ? requested : fallback;
  return Math.min(timeout, max);
}

function parseOptionalNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function runCommand(executable, args, { cwd, timeoutMs }) {
  const captureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesite-command-'));
  const stdoutPath = path.join(captureDir, 'stdout.log');
  const stderrPath = path.join(captureDir, 'stderr.log');
  const stdoutHandle = await fs.open(stdoutPath, 'w+');
  const stderrHandle = await fs.open(stderrPath, 'w+');
  let commandResult = null;
  try {
    commandResult = await new Promise((resolve) => {
      const child = spawn(executable, args, {
        cwd,
        env: process.env,
        shell: false,
        stdio: ['ignore', stdoutHandle.fd, stderrHandle.fd],
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);

      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({
          exitCode: 127,
          signal: null,
          timedOut,
          spawnError: error?.message || String(error),
        });
      });
      child.on('close', (exitCode, signal) => {
        clearTimeout(timer);
        resolve({
          exitCode: Number.isInteger(exitCode) ? exitCode : null,
          signal,
          timedOut,
          spawnError: null,
        });
      });
    });
  } finally {
    await stdoutHandle.close().catch(() => {});
    await stderrHandle.close().catch(() => {});
  }

  const stdoutFull = await readCommandCapture(stdoutPath);
  const stderrBase = await readCommandCapture(stderrPath);
  const stderrText = stderrBase.text;
  const stderrFull = commandResult?.spawnError ? `${stderrText}${stderrText ? '\n' : ''}${commandResult.spawnError}` : stderrText;
  await fs.rm(captureDir, { recursive: true, force: true }).catch(() => {});
  return {
    ...commandResult,
    stdout: stdoutFull.text,
    stdoutTail: stdoutFull.tail,
    stdoutTruncated: stdoutFull.truncated,
    stderr: stderrFull.slice(0, MAX_JSON_COMMAND_OUTPUT_CHARS),
    stderrTail: tail(stderrFull),
    stderrTruncated: stderrFull.length > MAX_JSON_COMMAND_OUTPUT_CHARS,
  };
}

async function readCommandCapture(filePath) {
  const text = await fs.readFile(filePath, 'utf8').catch(() => '');
  return {
    text: text.slice(0, MAX_JSON_COMMAND_OUTPUT_CHARS),
    tail: tail(text),
    truncated: text.length > MAX_JSON_COMMAND_OUTPUT_CHARS,
  };
}

function runJsonCommand(executable, args, { cwd, timeoutMs, input }) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stdoutTail = '';
    let stdoutTruncated = false;
    let stderr = '';
    let stderrTail = '';
    let stderrTruncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdoutTail = tail(`${stdoutTail}${text}`);
      const next = `${stdout}${text}`;
      if (!stdoutTruncated && next.length <= MAX_JSON_COMMAND_OUTPUT_CHARS) {
        stdout = next;
      } else if (!stdoutTruncated) {
        stdout = next.slice(0, MAX_JSON_COMMAND_OUTPUT_CHARS);
        stdoutTruncated = true;
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderrTail = tail(`${stderrTail}${text}`);
      const next = `${stderr}${text}`;
      if (!stderrTruncated && next.length <= MAX_JSON_COMMAND_OUTPUT_CHARS) {
        stderr = next;
      } else if (!stderrTruncated) {
        stderr = next.slice(0, MAX_JSON_COMMAND_OUTPUT_CHARS);
        stderrTruncated = true;
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: 127,
        signal: null,
        timedOut,
        stdout,
        stdoutTail,
        stdoutTruncated,
        stderr,
        stderrTail: tail(`${stderrTail}${error?.message || String(error)}`),
        stderrTruncated,
      });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal,
        timedOut,
        stdout,
        stdoutTail,
        stdoutTruncated,
        stderr,
        stderrTail,
        stderrTruncated,
      });
    });
    child.stdin.end(`${JSON.stringify(input || {})}\n`);
  });
}

function tail(value, limit = 8000) {
  const text = String(value || '');
  return text.length > limit ? text.slice(-limit) : text;
}

function durableInspectionCommandRef(key, evidenceDigest, adapter = null) {
  if (adapter?.evidencePrefix) return `${adapter.evidencePrefix}:${evidenceDigest}`;
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

export async function createCounterfactualRun(workspaceSlug, projectId, body = {}, actor = null) {
  const project = await requireProject(workspaceSlug, projectId, actor, 'write');
  const arbiterVerdict = body.arbiterVerdict || body.arbiter_verdict || body.outcome || null;
  const affectedZones = counterfactualAffectedZones(body, arbiterVerdict);
  const inferredPolicyDeltaCandidates = inferCounterfactualPolicyDeltaCandidates(body, arbiterVerdict, affectedZones);
  const baseSnapshot = body.baseSnapshot || body.base_snapshot || body.repoSnapshot || body.repo_snapshot || digest({ projectId, at: Date.now() });
  const choiceScene = counterfactualChoiceSceneContract(body, arbiterVerdict, {
    affectedZones,
    baseSnapshot,
    inferredPolicyDeltaCandidates,
  });
  const persistedArbiterVerdict = enrichArbiterVerdictWithLearnedCandidates(arbiterVerdict, inferredPolicyDeltaCandidates, choiceScene);
  const run = await prisma.codeSiteCounterfactualRun.create({
    data: {
      projectId: project.id,
      shadowJobRef: body.shadowJobRef || body.shadow_job_ref || null,
      baseSnapshot,
      universesJson: stringifyJson(body.universes || body.choices || body.choiceScene || body.choice_scene || []),
      arbiterVerdictJson: stringifyJson(persistedArbiterVerdict),
      userChoiceJson: stringifyJson(choiceScene.userChoice),
      laterManualEditsJson: stringifyJson(body.laterManualEdits || body.later_manual_edits || []),
      validityStrength: body.validityStrength || body.validity_strength || 'weak',
      evidenceRefsJson: stringifyJson(body.evidenceRefs || body.evidence_refs || []),
    },
  });
  await persistCounterfactualPolicyDeltaCandidates(project.id, run, persistedArbiterVerdict, {
    evidenceRefs: body.evidenceRefs || body.evidence_refs || [],
    inferredCandidates: inferredPolicyDeltaCandidates,
  });
  await recordEvent(project.id, {
    eventType: 'shadow_run',
    actorType: 'counterfactual',
    actorId: run.id,
    details: {
      counterfactualRunId: run.id,
      shadowJobRef: run.shadowJobRef,
      validityStrength: run.validityStrength,
      affectedZones,
    },
  });
  if (arbiterVerdict) {
    await recordEvent(project.id, {
      eventType: 'arbiter_verdict',
      actorType: 'counterfactual',
      actorId: run.id,
      evidenceRefs: body.evidenceRefs || body.evidence_refs || [],
      details: {
        counterfactualRunId: run.id,
        shadowJobRef: run.shadowJobRef,
        arbiterVerdict: persistedArbiterVerdict,
        selected: persistedArbiterVerdict?.selected || persistedArbiterVerdict?.winner || persistedArbiterVerdict?.verdict || null,
        validityStrength: run.validityStrength,
        affectedZones,
      },
    });
  }
  return counterfactualProjection(run);
}

export async function createPolicyDelta(workspaceSlug, projectId, body = {}, actor = null) {
  const project = await requireProject(workspaceSlug, projectId, actor, 'write');
  const requestedPromotionState = String(body.promotionState || body.promotion_state || 'proposed').toLowerCase();
  if (requestedPromotionState !== 'proposed') {
    throw badRequest('policy_delta_create_must_start_proposed', {
      requestedPromotionState,
      instruction: 'Create the policy delta as proposed, then promote it with replay validation evidence.',
    });
  }
  const ruleCandidate = normalizePolicyDeltaRuleCandidate(body.ruleCandidate || body.rule_candidate || body);
  const triggerConditions = asArray(body.triggerConditions || body.trigger_conditions || []);
  const affectedZones = policyDeltaAffectedZones(ruleCandidate, triggerConditions, body);
  const delta = await prisma.codeSitePolicyDelta.create({
    data: {
      projectId: project.id,
      learnedFromIncidentsJson: stringifyJson(body.learnedFromIncidents || body.learned_from_incidents || []),
      affectedZoneKey: body.affectedZoneKey || body.affected_zone_key || null,
      ruleCandidateJson: stringifyJson(ruleCandidate),
      triggerConditionsJson: stringifyJson(triggerConditions),
      expectedRiskReduction: typeof body.expectedRiskReduction === 'number' ? body.expectedRiskReduction : body.expected_risk_reduction,
      confidence: typeof body.confidence === 'number' ? body.confidence : 0.5,
      promotionState: 'proposed',
      replayRefsJson: stringifyJson(body.replayRefs || body.replay_refs || []),
      promotedAt: null,
    },
  });
  await recordEvent(project.id, {
    eventType: 'policy_delta_proposed',
    actorType: 'policy_delta',
    actorId: delta.id,
    details: {
      policyDeltaId: delta.id,
      affectedZoneKey: delta.affectedZoneKey,
      confidence: delta.confidence,
      affectedZones,
      triggerConditions,
      ruleCandidate,
    },
  });
  return policyDeltaProjection(delta);
}

export async function promotePolicyDelta(workspaceSlug, projectId, policyDeltaId, body = {}, actor = null) {
  const project = await requireProject(workspaceSlug, projectId, actor, 'write');
  const delta = await prisma.codeSitePolicyDelta.findFirst({
    where: { id: policyDeltaId, projectId: project.id },
  });
  if (!delta) throw notFound('policy_delta_not_found');
  const targetState = String(body.targetState || body.target_state || body.promotionState || body.promotion_state || 'promoted').toLowerCase();
  if (!POLICY_DELTA_PROMOTION_TARGET_STATES.has(targetState)) {
    throw badRequest('policy_delta_invalid_promotion_state', { targetState });
  }
  const validation = await validatePolicyDeltaPromotion(project.id, delta, body, actor);
  if (!validation.ok) {
    throw badRequest('policy_delta_promotion_not_validated', validation);
  }
  const currentRuleCandidate = parseJson(delta.ruleCandidateJson, {});
  const promotedAt = new Date();
  const promotedRuleCandidate = {
    ...currentRuleCandidate,
    promotion: {
      reviewedBy: validation.reviewedBy,
      targetState,
      validationStatus: validation.validationStatus,
      replayRefs: validation.replayRefs,
      evidenceRefs: validation.evidenceRefs,
      reasonCodes: validation.reasonCodes,
      promotedAt: promotedAt.toISOString(),
    },
  };
  const updated = await prisma.codeSitePolicyDelta.update({
    where: { id: delta.id },
    data: {
      promotionState: targetState,
      promotedAt,
      replayRefsJson: stringifyJson(validation.replayRefs),
      ruleCandidateJson: stringifyJson(promotedRuleCandidate),
    },
  });
  await recordEvent(project.id, {
    eventType: 'policy_delta_promoted',
    actorType: 'policy_delta',
    actorId: delta.id,
    evidenceRefs: validation.evidenceRefs,
    details: {
      policyDeltaId: delta.id,
      targetState,
      reviewedBy: validation.reviewedBy,
      validationStatus: validation.validationStatus,
      replayRefs: validation.replayRefs,
      reasonCodes: validation.reasonCodes,
    },
  });
  return policyDeltaProjection(updated);
}

export async function rejectPolicyDelta(workspaceSlug, projectId, policyDeltaId, body = {}, actor = null) {
  const project = await requireProject(workspaceSlug, projectId, actor, 'write');
  const delta = await prisma.codeSitePolicyDelta.findFirst({
    where: { id: policyDeltaId, projectId: project.id },
  });
  if (!delta) throw notFound('policy_delta_not_found');
  const reviewedBy = body.reviewedBy || body.reviewed_by || body.reviewerId || body.reviewer_id || actor?.userId || actor?.workspaceUserId || null;
  const reason = body.reason || body.rationale || 'policy_delta_rejected';
  const replayRefs = unique([
    ...asArray(parseJson(delta.replayRefsJson, [])),
    ...asArray(body.replayRefs || body.replay_refs),
  ]);
  const updated = await prisma.codeSitePolicyDelta.update({
    where: { id: delta.id },
    data: {
      promotionState: 'rejected',
      replayRefsJson: stringifyJson(replayRefs),
      promotedAt: null,
    },
  });
  await recordEvent(project.id, {
    eventType: 'policy_delta_rejected',
    actorType: 'policy_delta',
    actorId: delta.id,
    evidenceRefs: body.evidenceRefs || body.evidence_refs || [],
    details: {
      policyDeltaId: delta.id,
      reviewedBy,
      reason,
      replayRefs,
    },
  });
  return policyDeltaProjection(updated);
}

async function validatePolicyDeltaPromotion(projectId, delta, body = {}, actor = null) {
  const projection = policyDeltaProjection(delta);
  const validation = body.validation || body.replayValidation || body.replay_validation || {};
  const validationStatus = String(
    body.validationStatus ||
    body.validation_status ||
    body.replayValidationStatus ||
    body.replay_validation_status ||
    validation.status ||
    validation.result ||
    '',
  ).toLowerCase();
  const replayRefs = unique([
    ...asArray(projection.replayRefs),
    ...asArray(body.replayRefs || body.replay_refs),
    ...asArray(validation.replayRefs || validation.replay_refs),
    ...asArray(body.validatedReplayRefs || body.validated_replay_refs),
  ].map(String).filter(Boolean));
  const evidenceRefs = unique([
    ...asArray(body.evidenceRefs || body.evidence_refs),
    ...asArray(validation.evidenceRefs || validation.evidence_refs),
  ].map(String).filter(Boolean));
  const reviewedBy = body.reviewedBy ||
    body.reviewed_by ||
    body.reviewerId ||
    body.reviewer_id ||
    body.approvedBy ||
    body.approved_by ||
    actor?.userId ||
    actor?.workspaceUserId ||
    null;
  const reasonCodes = [];
  const confidence = Number(projection.confidence || 0);
  if (confidence < 0.65) reasonCodes.push('policy_delta_confidence_below_threshold');
  if (!reviewedBy) reasonCodes.push('policy_delta_reviewer_required');
  if (!['ok', 'pass', 'passed', 'valid', 'validated', 'accepted', 'approved'].includes(validationStatus)) {
    reasonCodes.push('policy_delta_replay_validation_required');
  }
  if (!replayRefs.some(isDurablePolicyReplayRef)) {
    reasonCodes.push('policy_delta_replay_ref_required');
  }
  if (!evidenceRefs.length) reasonCodes.push('policy_delta_validation_evidence_required');
  if (evidenceRefs.length && !evidenceRefs.some(isDurablePolicyEvidenceRef)) {
    reasonCodes.push('policy_delta_durable_evidence_ref_required');
  }
  const replayResolution = await resolvePolicyDeltaReplayRefs(projectId, replayRefs);
  reasonCodes.push(...replayResolution.reasonCodes);
  if (!projection.ruleCandidate || !Object.keys(projection.ruleCandidate).length) {
    reasonCodes.push('policy_delta_rule_candidate_required');
  }
  return {
    ok: reasonCodes.length === 0,
    reasonCodes: unique(reasonCodes),
    replayRefs,
    evidenceRefs,
    reviewedBy,
    validationStatus,
    confidence,
    replayResolution,
  };
}

function isDurablePolicyReplayRef(ref) {
  return /^(codesite:counterfactual-run:|shadow:job:|replay:|incident:|codesite:incident:|dojo:|runtime:event:)/.test(String(ref || ''));
}

function isDurablePolicyEvidenceRef(ref) {
  return /^(replay:|dojo:|codesite:|shadow:job:|runtime:event:|incident:|inspection:|test:|api-contract:|ui:screenshot:)/.test(String(ref || ''));
}

async function resolvePolicyDeltaReplayRefs(projectId, replayRefs = []) {
  const refs = unique(asArray(replayRefs).map(String).filter(Boolean));
  const counterfactualRunIds = refs.flatMap((ref) => {
    const match = ref.match(/^codesite:counterfactual-run:(.+)$/);
    return match ? [match[1]] : [];
  });
  const shadowJobRefs = refs.flatMap((ref) => {
    const match = ref.match(/^shadow:job:(.+)$/);
    return match ? [match[1]] : [];
  });
  const incidentIds = refs.flatMap((ref) => {
    const match = ref.match(/^(?:codesite:)?incident:(.+)$/);
    return match ? [match[1]] : [];
  });
  const resolution = {
    resolvedCounterfactualRunIds: [],
    resolvedShadowJobRefs: [],
    resolvedIncidentIds: [],
    externalReplayRefs: refs.filter((ref) => /^(replay:|dojo:|runtime:event:)/.test(ref)),
    reasonCodes: [],
  };
  if (counterfactualRunIds.length || shadowJobRefs.length) {
    const rows = await prisma.codeSiteCounterfactualRun.findMany?.({
      where: {
        projectId,
        OR: [
          ...(counterfactualRunIds.length ? [{ id: { in: counterfactualRunIds } }] : []),
          ...(shadowJobRefs.length ? [{ shadowJobRef: { in: shadowJobRefs } }] : []),
        ],
      },
    });
    const foundRuns = Array.isArray(rows) ? rows : [];
    resolution.resolvedCounterfactualRunIds = foundRuns.map((row) => row.id).filter(Boolean);
    resolution.resolvedShadowJobRefs = foundRuns.map((row) => row.shadowJobRef).filter(Boolean);
    const missingCounterfactualRuns = counterfactualRunIds.filter((id) => !resolution.resolvedCounterfactualRunIds.includes(id));
    const missingShadowJobs = shadowJobRefs.filter((ref) => !resolution.resolvedShadowJobRefs.includes(ref));
    if (missingCounterfactualRuns.length) resolution.reasonCodes.push('policy_delta_counterfactual_run_ref_unresolved');
    if (missingShadowJobs.length) resolution.reasonCodes.push('policy_delta_shadow_job_ref_unresolved');
  }
  if (incidentIds.length) {
    const rows = await prisma.codeSiteIncident.findMany?.({
      where: { projectId, id: { in: incidentIds } },
    });
    const foundIncidents = Array.isArray(rows) ? rows : [];
    resolution.resolvedIncidentIds = foundIncidents.map((row) => row.id).filter(Boolean);
    if (incidentIds.some((id) => !resolution.resolvedIncidentIds.includes(id))) {
      resolution.reasonCodes.push('policy_delta_incident_ref_unresolved');
    }
  }
  return {
    ...resolution,
    ok: resolution.reasonCodes.length === 0,
  };
}

function enrichArbiterVerdictWithLearnedCandidates(arbiterVerdict, inferredCandidates = [], choiceScene = null) {
  const base = arbiterVerdict && typeof arbiterVerdict === 'object' ? { ...arbiterVerdict } : {};
  const suppliedCandidates = asArray(arbiterVerdict?.policyDeltaCandidates || arbiterVerdict?.policy_delta_candidates);
  const policyDeltaCandidates = uniquePolicyDeltaCandidates([
    ...suppliedCandidates,
    ...asArray(inferredCandidates),
  ]);
  if (choiceScene) base.choiceScene = choiceScene;
  if (!policyDeltaCandidates.length) return Object.keys(base).length ? base : arbiterVerdict;
  return {
    ...base,
    policyDeltaCandidates,
    counterfactualLearning: {
      ...(arbiterVerdict?.counterfactualLearning || arbiterVerdict?.counterfactual_learning || {}),
      candidateCount: policyDeltaCandidates.length,
      inferredCandidateCount: asArray(inferredCandidates).length,
      learningSignals: unique(policyDeltaCandidates.flatMap((candidate) => asArray(candidate.learningSignals || candidate.learning_signals))),
    },
  };
}

function counterfactualChoiceSceneContract(body = {}, arbiterVerdict = null, context = {}) {
  const choices = asArray(body.universes || body.choices || body.choiceScene || body.choice_scene || arbiterVerdict?.universes || arbiterVerdict?.choices)
    .map((choice) => {
      const universe = normalizeCounterfactualUniverse(choice);
      if (!universe) return null;
      return {
        universe: universe.strategy || choice.universe || choice.name || choice.id || 'unknown',
        result: universe.result || 'unknown',
        inspectionCost: universe.inspectionCost,
        staleAssumptions: universe.staleAssumptions,
        predictedCollisionRisk: universe.predictedCollisionRisk,
        reworkRiskReduction: universe.reworkRiskReduction,
        affectedRoutes: universe.paths,
        evidenceRefs: universe.evidenceRefs,
        incidents: universe.incidentRefs,
      };
    })
    .filter(Boolean);
  const userChoice = body.userChoice || body.user_choice || null;
  const humanOverride = body.humanOverride || body.human_override || arbiterVerdict?.humanOverride || arbiterVerdict?.human_override || null;
  const applyResult = body.applyResult || body.apply_result || body.outcome || body.result || arbiterVerdict?.applyResult || arbiterVerdict?.apply_result || null;
  return {
    repoSnapshot: context.baseSnapshot,
    shadowJobRef: body.shadowJobRef || body.shadow_job_ref || arbiterVerdict?.shadowJobRef || arbiterVerdict?.shadow_job_ref || null,
    choices,
    arbiterVerdict: arbiterVerdict?.selected || arbiterVerdict?.winner || arbiterVerdict?.verdict || null,
    userChoice,
    humanOverride,
    applyResult,
    laterManualEdits: asArray(body.laterManualEdits || body.later_manual_edits),
    validityStrength: body.validityStrength || body.validity_strength || arbiterVerdict?.validityStrength || arbiterVerdict?.validity_strength || 'weak',
    affectedZones: context.affectedZones || [],
    resultingPolicyDeltaCandidateCount: asArray(context.inferredPolicyDeltaCandidates).length
      + asArray(arbiterVerdict?.policyDeltaCandidates || arbiterVerdict?.policy_delta_candidates).length,
  };
}

function inferCounterfactualPolicyDeltaCandidates(body = {}, arbiterVerdict = null, affectedZones = []) {
  const scene = normalizeCounterfactualLearningScene(body, arbiterVerdict, affectedZones);
  const candidates = [
    inferFlightSplitPolicyDelta(scene),
    inferRecurringNearMissPolicyDelta(scene),
    inferAirspaceClassPolicyDelta(scene),
    inferInspectorPolicyDelta(scene),
    inferTowerReroutePolicyDelta(scene),
    inferClearanceViolationPolicyDelta(scene),
    inferSchemaFirstPolicyDelta(scene),
    inferBlackBoxPatternPolicyDelta(scene),
  ].filter(Boolean);
  return uniquePolicyDeltaCandidates(candidates);
}

function normalizeCounterfactualLearningScene(body = {}, arbiterVerdict = null, affectedZones = []) {
  const universes = asArray(body.universes || body.choices || body.choiceScene || body.choice_scene || arbiterVerdict?.universes || arbiterVerdict?.choices)
    .map(normalizeCounterfactualUniverse)
    .filter(Boolean);
  const selectedName = normalizeTowerStrategyName(
    arbiterVerdict?.selected ||
    arbiterVerdict?.winner ||
    arbiterVerdict?.verdict ||
    body.selected ||
    body.winner ||
    body.humanOverride?.selected ||
    body.human_override?.selected,
  );
  const selectedUniverse = universes.find((universe) => universe.strategy === selectedName)
    || universes.find((universe) => universe.selected)
    || universes.find((universe) => universe.result === 'passed')
    || null;
  const laterManualEdits = asArray(body.laterManualEdits || body.later_manual_edits)
    .map(normalizeCounterfactualManualEdit)
    .filter(Boolean);
  const evidenceRefs = unique([
    ...asArray(body.evidenceRefs || body.evidence_refs),
    ...asArray(arbiterVerdict?.evidenceRefs || arbiterVerdict?.evidence_refs),
    ...universes.flatMap((universe) => universe.evidenceRefs),
  ].map(String).filter(Boolean));
  const incidentRefs = unique([
    ...counterfactualIncidentRefs(body),
    ...counterfactualIncidentRefs(arbiterVerdict || {}),
    ...universes.flatMap((universe) => universe.incidentRefs),
    ...laterManualEdits.flatMap((edit) => edit.incidentRefs),
    ...evidenceRefs.flatMap(incidentRefsFromEvidenceRef),
  ].filter(Boolean));
  const paths = unique(pathsForRoute([
    ...affectedZones,
    ...counterfactualPathRefs(body),
    ...counterfactualPathRefs(arbiterVerdict || {}),
    ...universes.flatMap((universe) => universe.paths),
    ...laterManualEdits.flatMap((edit) => edit.paths),
  ]));
  return {
    body,
    arbiterVerdict,
    universes,
    selectedUniverse,
    laterManualEdits,
    evidenceRefs,
    incidentRefs,
    paths,
    validityStrength: String(body.validityStrength || body.validity_strength || arbiterVerdict?.validityStrength || arbiterVerdict?.validity_strength || 'weak').toLowerCase(),
    humanOverride: body.humanOverride || body.human_override || arbiterVerdict?.humanOverride || arbiterVerdict?.human_override || null,
    signals: {
      airspaceClasses: counterfactualSignalRows(body, arbiterVerdict, universes, laterManualEdits, [
        'airspaceClassFeedback',
        'airspace_class_feedback',
        'airspaceClasses',
        'airspace_classes',
        'zoneClassFeedback',
        'zone_class_feedback',
      ]),
      inspections: counterfactualSignalRows(body, arbiterVerdict, universes, laterManualEdits, [
        'inspectionFindings',
        'inspection_findings',
        'inspectors',
        'inspectionSignals',
        'inspection_signals',
        'inspections',
      ]),
      reroutes: counterfactualSignalRows(body, arbiterVerdict, universes, laterManualEdits, [
        'towerReroutes',
        'tower_reroutes',
        'reroutes',
        'rerouteEvents',
        'reroute_events',
      ]),
      clearanceViolations: counterfactualSignalRows(body, arbiterVerdict, universes, laterManualEdits, [
        'clearanceViolations',
        'clearance_violations',
        'agentViolations',
        'agent_violations',
        'violations',
      ]),
      blackBoxPatterns: counterfactualSignalRows(body, arbiterVerdict, universes, laterManualEdits, [
        'blackBoxPatterns',
        'black_box_patterns',
        'escapedPatterns',
        'escaped_patterns',
        'escapedAttacks',
        'escaped_attacks',
        'dojoFindings',
        'dojo_findings',
      ]),
    },
  };
}

function normalizeCounterfactualUniverse(universe) {
  if (!universe || typeof universe !== 'object') return null;
  const strategy = normalizeTowerStrategyName(universe.strategy || universe.universe || universe.name || universe.id);
  const result = String(universe.result || universe.status || universe.outcome || '').toLowerCase();
  return {
    raw: universe,
    strategy,
    result,
    selected: Boolean(universe.selected || universe.winner),
    paths: counterfactualPathRefs(universe),
    incidentRefs: counterfactualIncidentRefs(universe),
    evidenceRefs: asArray(universe.evidenceRefs || universe.evidence_refs).map(String).filter(Boolean),
    predictedCollisionRisk: numericValue(universe.predictedCollisionRisk ?? universe.predicted_collision_risk ?? universe.collisionRisk ?? universe.collision_risk),
    staleAssumptions: numericValue(universe.staleAssumptions ?? universe.stale_assumptions),
    inspectionCost: numericValue(universe.inspectionCost ?? universe.inspection_cost),
    reworkRiskReduction: numericValue(universe.reworkRiskReduction ?? universe.rework_risk_reduction ?? universe.savedRework ?? universe.saved_rework),
    manualRewriteCount: numericValue(universe.manualRewriteCount ?? universe.manual_rewrite_count ?? universe.laterManualRewriteCount ?? universe.later_manual_rewrite_count),
  };
}

function normalizeCounterfactualManualEdit(edit) {
  if (!edit) return null;
  const row = typeof edit === 'object' ? edit : { summary: String(edit) };
  return {
    raw: row,
    paths: counterfactualPathRefs(row),
    incidentRefs: counterfactualIncidentRefs(row),
    reason: String(row.reason || row.cause || row.summary || row.kind || row.type || ''),
    count: numericValue(row.count ?? row.rewriteCount ?? row.rewrite_count) || 1,
  };
}

function inferFlightSplitPolicyDelta(scene) {
  const selected = scene.selectedUniverse;
  if (!selected?.strategy) return null;
  const riskyUniverses = scene.universes.filter((universe) =>
    universe.strategy && universe.strategy !== selected.strategy && counterfactualUniverseIndicatesNearMiss(universe));
  if (!riskyUniverses.length) return null;
  return counterfactualCandidate(scene, {
    rule: 'flight_split_reduced_collision',
    learningSignals: ['flight_split_reduced_collisions'],
    preferredStrategies: [selected.strategy],
    avoidStrategies: riskyUniverses.map((universe) => universe.strategy),
    requiredTowerActions: ['prefer_recorded_low_collision_split', 'replay_near_miss_before_parallel_clearance'],
    triggerConditions: [
      ...pathTriggerConditions(counterfactualChoiceRoutePaths(scene)),
      ...riskTriggerConditions(riskyUniverses),
    ],
    expectedRiskReduction: riskReductionFromSignals(scene, riskyUniverses.length + 2),
    confidence: confidenceFromScene(scene, riskyUniverses.length + 1),
  });
}

function inferRecurringNearMissPolicyDelta(scene) {
  const nearMissRefs = unique([
    ...scene.incidentRefs,
    ...scene.universes.filter(counterfactualUniverseIndicatesNearMiss).flatMap((universe) => universe.incidentRefs),
  ]);
  const nearMissUniverses = scene.universes.filter(counterfactualUniverseIndicatesNearMiss);
  if (nearMissRefs.length < 2 && nearMissUniverses.length < 2) return null;
  return counterfactualCandidate(scene, {
    rule: 'recurring_near_miss_airspace_rule',
    learningSignals: ['recurring_near_misses'],
    preferredStrategies: scene.selectedUniverse?.strategy ? [scene.selectedUniverse.strategy] : [],
    avoidStrategies: nearMissUniverses.map((universe) => universe.strategy).filter(Boolean),
    requiredTowerActions: ['promote_repeated_near_miss_to_airspace_rule', 'require_shadow_replay_before_clearance'],
    triggerConditions: [
      ...pathTriggerConditions(scene.paths),
      { event: 'near_miss.detected' },
    ],
    expectedRiskReduction: riskReductionFromSignals(scene, nearMissRefs.length + nearMissUniverses.length),
    confidence: confidenceFromScene(scene, nearMissRefs.length + nearMissUniverses.length),
    learnedFromIncidents: nearMissRefs,
  });
}

function inferAirspaceClassPolicyDelta(scene) {
  const calibrationSignals = scene.signals.airspaceClasses.filter((signal) => {
    const text = counterfactualSignalText(signal);
    return /too[_ -]?strict|over[_ -]?restricted|too[_ -]?loose|under[_ -]?protected|class[_ -]?mismatch|calibration/.test(text);
  });
  if (!calibrationSignals.length) return null;
  return counterfactualCandidate(scene, {
    rule: 'calibrate_airspace_class_from_counterfactual_outcome',
    learningSignals: ['airspace_classes_calibrated'],
    requiredTowerActions: ['review_zone_class_before_next_clearance', 'adjust_airspace_class_after_replay'],
    triggerConditions: [
      ...pathTriggerConditions(pathsFromSignals(calibrationSignals, scene.paths)),
      ...calibrationSignals.map((signal) => ({ classCalibration: signal.kind || signal.status || signal.outcome || 'counterfactual_airspace_feedback' })),
    ],
    expectedRiskReduction: riskReductionFromSignals(scene, calibrationSignals.length + 1),
    confidence: confidenceFromScene(scene, calibrationSignals.length),
  });
}

function inferInspectorPolicyDelta(scene) {
  const caughtSignals = scene.signals.inspections.filter((signal) => {
    const text = counterfactualSignalText(signal);
    return signal.caughtRealIssue === true || signal.caught_real_issue === true || /caught|blocked|failed|regression|real[_ -]?issue|unsafe/.test(text);
  });
  if (!caughtSignals.length) return null;
  return counterfactualCandidate(scene, {
    rule: 'inspector_real_issue_gate',
    learningSignals: ['inspectors_caught_real_issues'],
    requiredTowerActions: ['require_matching_inspector_before_landing', 'attach_inspection_evidence_to_clearance'],
    triggerConditions: [
      ...pathTriggerConditions(pathsFromSignals(caughtSignals, scene.paths)),
      ...caughtSignals.map((signal) => ({ inspector: signal.inspector || signal.adapter || signal.radar || signal.kind || 'inspection' })),
    ],
    expectedRiskReduction: riskReductionFromSignals(scene, caughtSignals.length + 1),
    confidence: confidenceFromScene(scene, caughtSignals.length + 1),
  });
}

function inferTowerReroutePolicyDelta(scene) {
  const savedReroutes = scene.signals.reroutes.filter((signal) => {
    const text = counterfactualSignalText(signal);
    const saved = numericValue(signal.savedWork ?? signal.saved_work ?? signal.reworkSaved ?? signal.rework_saved ?? signal.hoursSaved ?? signal.hours_saved);
    return saved > 0 || signal.savedWork === true || signal.saved_work === true || /saved|reduced[_ -]?rework|avoided[_ -]?collision|reroute/.test(text);
  });
  if (!savedReroutes.length) return null;
  return counterfactualCandidate(scene, {
    rule: 'prefer_tower_reroute_that_saved_work',
    learningSignals: ['tower_reroutes_saved_work'],
    preferredStrategies: scene.selectedUniverse?.strategy ? [scene.selectedUniverse.strategy] : [],
    requiredTowerActions: ['offer_recorded_reroute_before_ground_stop', 'replay_reroute_evidence_before_commit'],
    triggerConditions: [
      ...pathTriggerConditions(pathsFromSignals(savedReroutes, scene.paths)),
      { towerAction: 'reroute' },
    ],
    expectedRiskReduction: riskReductionFromSignals(scene, savedReroutes.length + 2),
    confidence: confidenceFromScene(scene, savedReroutes.length + 1),
  });
}

function inferClearanceViolationPolicyDelta(scene) {
  const violations = scene.signals.clearanceViolations.filter((signal) => {
    const text = counterfactualSignalText(signal);
    return signal.violation === true || signal.violated === true || /violate|outside[_ -]?clearance|unauthorized|no[_ -]?fly|route[_ -]?deviation/.test(text);
  });
  if (!violations.length) return null;
  return counterfactualCandidate(scene, {
    rule: 'enforce_clearance_after_agent_violation',
    learningSignals: ['agents_violated_clearances'],
    requiredTowerActions: ['deny_out_of_clearance_writes', 'require_route_revision_for_deviation'],
    triggerConditions: [
      ...pathTriggerConditions(pathsFromSignals(violations, scene.paths)),
      ...violations.map((signal) => ({ agent: signal.agent || signal.callsign || signal.displayCallsign || signal.display_callsign || 'agent' })),
    ],
    expectedRiskReduction: riskReductionFromSignals(scene, violations.length + 2),
    confidence: confidenceFromScene(scene, violations.length + 1),
  });
}

function inferSchemaFirstPolicyDelta(scene) {
  const schemaUniverse = scene.universes.find((universe) => universe.strategy === 'schema-first');
  if (!schemaUniverse) return null;
  const riskyAlternatives = scene.universes.filter((universe) =>
    universe.strategy && universe.strategy !== 'schema-first' && (
      counterfactualUniverseIndicatesNearMiss(universe)
      || Number(universe.manualRewriteCount || 0) > Number(schemaUniverse.manualRewriteCount || 0)
      || Number(universe.staleAssumptions || 0) > Number(schemaUniverse.staleAssumptions || 0)
    ));
  const schemaSavedRework = Number(schemaUniverse.reworkRiskReduction || 0) > 0
    || scene.laterManualEdits.some((edit) => /schema|contract|downstream|generated/.test(edit.reason.toLowerCase()));
  if (!schemaSavedRework && !riskyAlternatives.length) return null;
  return counterfactualCandidate(scene, {
    rule: 'schema_first_policy_reduced_rework',
    learningSignals: ['schema_first_reduced_rework'],
    preferredStrategies: ['schema-first'],
    avoidStrategies: riskyAlternatives.map((universe) => universe.strategy),
    requiredTowerActions: ['issue_schema_clearance_before_dependents', 'refresh_downstream_assumptions_after_contract'],
    triggerConditions: [
      ...pathTriggerConditions(scene.paths.filter(isSchemaSurface).length ? scene.paths.filter(isSchemaSurface) : scene.paths),
      { risk: 'semantic_collision' },
    ],
    expectedRiskReduction: riskReductionFromSignals(scene, riskyAlternatives.length + 2),
    confidence: confidenceFromScene(scene, riskyAlternatives.length + 1),
  });
}

function inferBlackBoxPatternPolicyDelta(scene) {
  const patterns = scene.signals.blackBoxPatterns.filter((signal) => {
    const text = counterfactualSignalText(signal);
    return signal.promoteToRule === true || signal.promote_to_rule === true || /escape|escaped|black[_ -]?box|dojo|pattern|attack|invariant/.test(text);
  });
  if (!patterns.length) return null;
  return counterfactualCandidate(scene, {
    rule: 'promote_black_box_pattern_to_airspace_rule',
    learningSignals: ['black_box_patterns_became_airspace_rules'],
    requiredTowerActions: ['convert_black_box_escape_to_zone_rule', 'require_replay_for_matching_pattern'],
    triggerConditions: [
      ...pathTriggerConditions(pathsFromSignals(patterns, scene.paths)),
      ...patterns.map((signal) => ({ blackBoxPattern: signal.pattern || signal.rule || signal.name || signal.kind || 'escaped_pattern' })),
    ],
    expectedRiskReduction: riskReductionFromSignals(scene, patterns.length + 2),
    confidence: confidenceFromScene(scene, patterns.length + 1),
  });
}

function counterfactualCandidate(scene, {
  rule,
  learningSignals = [],
  preferredStrategies = [],
  avoidStrategies = [],
  requiredTowerActions = [],
  triggerConditions = [],
  expectedRiskReduction = 0.18,
  confidence = 0.7,
  learnedFromIncidents = null,
} = {}) {
  const affectedRoutes = scene.paths.slice(0, 12);
  return {
    learnedFromIncidents: unique(asArray(learnedFromIncidents ?? scene.incidentRefs).map(String).filter(Boolean)),
    affectedZoneKey: affectedZoneKeyForPaths(affectedRoutes),
    affectedRoutes,
    ruleCandidate: normalizePolicyDeltaRuleCandidate({
      rule,
      learningSignals: unique(asArray(learningSignals).map(String).filter(Boolean)),
      preferredStrategies: unique(asArray(preferredStrategies).map(normalizeTowerStrategyName).filter(Boolean)),
      avoidStrategies: unique(asArray(avoidStrategies).map(normalizeTowerStrategyName).filter(Boolean)),
      requiredTowerActions: unique(asArray(requiredTowerActions).map(String).filter(Boolean)),
      evidenceBasis: {
        validityStrength: scene.validityStrength,
        incidentRefs: scene.incidentRefs,
        evidenceRefs: scene.evidenceRefs,
        humanOverride: scene.humanOverride || null,
        laterManualEditCount: scene.laterManualEdits.length,
      },
    }),
    triggerConditions: uniqueByStableJson(triggerConditions.length ? triggerConditions : pathTriggerConditions(affectedRoutes)),
    expectedRiskReduction: roundTo(clamp(expectedRiskReduction, 0.05, 0.6), 3),
    confidence: roundTo(clamp(confidence, 0.5, 0.98), 3),
    learningSignals: unique(asArray(learningSignals).map(String).filter(Boolean)),
  };
}

function counterfactualUniverseIndicatesNearMiss(universe) {
  const text = counterfactualSignalText(universe.raw || universe);
  return ['near_miss', 'near-miss', 'risk', 'collision', 'failed', 'blocked'].includes(universe.result)
    || Number(universe.predictedCollisionRisk || 0) >= 0.55
    || Number(universe.staleAssumptions || 0) >= 2
    || /near[_ -]?miss|collision|conflict|blocked|failed/.test(text);
}

function counterfactualSignalRows(body, arbiterVerdict, universes, laterManualEdits, keys) {
  const rows = [];
  for (const source of [body, arbiterVerdict || {}, ...universes.map((universe) => universe.raw), ...laterManualEdits.map((edit) => edit.raw)]) {
    if (!source || typeof source !== 'object') continue;
    for (const key of keys) {
      rows.push(...asArray(source[key]));
    }
  }
  return rows
    .map((row) => (row && typeof row === 'object' ? row : { value: row }))
    .filter((row) => row.value !== undefined || Object.keys(row).length > 0);
}

function counterfactualPathRefs(source = {}) {
  if (!source || typeof source !== 'object') return [];
  return unique(pathsForRoute([
    ...asArray(source.affectedRoutes || source.affected_routes),
    ...asArray(source.routes || source.route),
    ...asArray(source.changedPaths || source.changed_paths),
    ...asArray(source.allowedPaths || source.allowed_paths),
    ...asArray(source.writeSet || source.write_set),
    ...asArray(source.paths || source.path),
    ...asArray(source.affectedZones || source.affected_zones),
    ...asArray(source.zone || source.zoneKey || source.zone_key),
    ...asArray(source.triggerConditions || source.trigger_conditions).flatMap((condition) =>
      condition && typeof condition === 'object'
        ? [condition.path, condition.route, condition.zone, condition.zoneKey, condition.zone_key]
        : [condition]),
  ].filter(Boolean)));
}

function counterfactualIncidentRefs(source = {}) {
  if (!source || typeof source !== 'object') return [];
  const rawRefs = [
    ...asArray(source.learnedFromIncidents || source.learned_from_incidents),
    ...asArray(source.incidents),
    ...asArray(source.nearMisses || source.near_misses),
    ...asArray(source.affectedIncidents || source.affected_incidents),
    ...asArray(source.incidentRefs || source.incident_refs),
  ];
  return unique(rawRefs.flatMap((value) => {
    if (!value) return [];
    if (typeof value === 'object') return [value.id || value.incidentId || value.incident_id || value.ref || value.name].filter(Boolean).map(String);
    return [String(value)];
  }));
}

function incidentRefsFromEvidenceRef(ref) {
  const match = String(ref || '').match(/(?:codesite:)?incident:([^/:\s]+)/i);
  return match ? [match[1]] : [];
}

function pathTriggerConditions(paths) {
  return unique(pathsForRoute(paths).slice(0, 8)).map((pathValue) => ({ path: pathValue }));
}

function counterfactualChoiceRoutePaths(scene) {
  const paths = unique(pathsForRoute(asArray(scene.universes).flatMap((universe) => universe.paths)));
  return paths.length ? paths : scene.paths;
}

function riskTriggerConditions(universes) {
  return unique(asArray(universes).flatMap((universe) => {
    const raw = universe.raw || {};
    return [
      ...asArray(raw.unresolvedRisks || raw.unresolved_risks),
      ...asArray(raw.risks),
      raw.risk,
    ];
  }).filter(Boolean).map(String)).map((risk) => ({ risk }));
}

function pathsFromSignals(signals, fallbackPaths = []) {
  const paths = unique(pathsForRoute(asArray(signals).flatMap(counterfactualPathRefs)));
  return paths.length ? paths : fallbackPaths;
}

function affectedZoneKeyForPaths(paths = []) {
  const firstPath = pathsForRoute(paths)[0] || null;
  if (!firstPath) return null;
  return patternRoot(firstPath) || firstPath;
}

function counterfactualSignalText(signal = {}) {
  if (typeof signal === 'string') return signal.toLowerCase();
  if (!signal || typeof signal !== 'object') return '';
  return [
    signal.value,
    signal.result,
    signal.status,
    signal.outcome,
    signal.kind,
    signal.type,
    signal.reason,
    signal.summary,
    signal.message,
    signal.rule,
    signal.pattern,
    signal.name,
  ].map((value) => String(value || '').toLowerCase()).join(' ');
}

function confidenceFromScene(scene, signalWeight = 0) {
  const validity = {
    executed: 0.88,
    strong: 0.82,
    moderate: 0.74,
    simulated: 0.66,
    weak: 0.58,
  }[scene.validityStrength] || 0.58;
  return clamp(validity
    + Math.min(0.08, scene.evidenceRefs.length * 0.01)
    + Math.min(0.06, scene.incidentRefs.length * 0.015)
    + Math.min(0.06, Number(signalWeight || 0) * 0.015)
    + (scene.laterManualEdits.length ? 0.03 : 0), 0.5, 0.98);
}

function riskReductionFromSignals(scene, signalWeight = 0) {
  const selectedReduction = Number(scene.selectedUniverse?.reworkRiskReduction || 0);
  return clamp(0.14 + Math.min(0.18, Number(signalWeight || 0) * 0.025) + Math.min(0.18, selectedReduction * 0.35), 0.05, 0.6);
}

function numericValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function uniqueByStableJson(rows) {
  const seen = new Set();
  return asArray(rows).filter((row) => {
    const key = stableJson(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function persistCounterfactualPolicyDeltaCandidates(projectId, run, arbiterVerdict, context = {}) {
  const candidates = uniquePolicyDeltaCandidates([
    ...asArray(arbiterVerdict?.policyDeltaCandidates || arbiterVerdict?.policy_delta_candidates),
    ...asArray(context.inferredCandidates),
  ]);
  if (!candidates.length) return [];
  const created = [];
  for (const candidate of candidates) {
    const ruleCandidate = normalizePolicyDeltaRuleCandidate(candidate.ruleCandidate || candidate.rule_candidate || candidate);
    const triggerConditions = asArray(candidate.triggerConditions || candidate.trigger_conditions || candidate.affectedRoutes || candidate.affected_routes)
      .map((item) => (typeof item === 'string' ? { path: item } : item))
      .filter(Boolean);
    const affectedZones = policyDeltaAffectedZones(ruleCandidate, triggerConditions, candidate);
    const delta = await prisma.codeSitePolicyDelta.create({
      data: {
        projectId,
        learnedFromIncidentsJson: stringifyJson(candidate.learnedFromIncidents || candidate.learned_from_incidents || candidate.affectedIncidents || candidate.affected_incidents || []),
        affectedZoneKey: candidate.affectedZoneKey || candidate.affected_zone_key || null,
        ruleCandidateJson: stringifyJson(ruleCandidate),
        triggerConditionsJson: stringifyJson(triggerConditions),
        expectedRiskReduction: typeof candidate.expectedRiskReduction === 'number' ? candidate.expectedRiskReduction : candidate.expected_risk_reduction,
        confidence: typeof candidate.confidence === 'number' ? candidate.confidence : 0.5,
        promotionState: 'proposed',
        replayRefsJson: stringifyJson(unique([
          `codesite:counterfactual-run:${run.id}`,
          run.shadowJobRef && `shadow:job:${run.shadowJobRef}`,
          ...asArray(candidate.replayRefs || candidate.replay_refs),
          ...asArray(context.evidenceRefs),
        ].filter(Boolean))),
        promotedAt: null,
      },
    });
    created.push(delta);
    await recordEvent(projectId, {
      eventType: 'policy_delta_proposed',
      actorType: 'counterfactual',
      actorId: run.id,
      evidenceRefs: context.evidenceRefs,
      details: {
        policyDeltaId: delta.id,
        counterfactualRunId: run.id,
        shadowJobRef: run.shadowJobRef,
        promotionState: 'proposed',
        confidence: delta.confidence,
        affectedZones,
        triggerConditions,
        ruleCandidate,
      },
    });
  }
  return created.map(policyDeltaProjection);
}

function counterfactualAffectedZones(body = {}, arbiterVerdict = null) {
  const universes = asArray(body.universes || body.choices || body.choiceScene || body.choice_scene);
  const candidates = asArray(arbiterVerdict?.policyDeltaCandidates || arbiterVerdict?.policy_delta_candidates);
  return unique(pathsForRoute([
    ...asArray(body.affectedZones || body.affected_zones || body.affectedRoutes || body.affected_routes),
    ...universes.flatMap((universe) => [
      ...asArray(universe?.route || universe?.routes || universe?.affectedRoutes || universe?.affected_routes),
      ...asArray(universe?.changedPaths || universe?.changed_paths || universe?.writeSet || universe?.write_set),
    ]),
    ...candidates.flatMap(policyDeltaCandidateRoutes),
  ]));
}

function policyDeltaAffectedZones(ruleCandidate = {}, triggerConditions = [], source = {}) {
  return unique(pathsForRoute([
    ...policyDeltaCandidateRoutes(ruleCandidate),
    ...policyDeltaCandidateRoutes(source),
    ...asArray(triggerConditions),
  ]));
}

function policyDeltaCandidateRoutes(candidate = {}) {
  const ruleCandidate = candidate.ruleCandidate || candidate.rule_candidate || {};
  return [
    ...asArray(candidate.affectedRoutes || candidate.affected_routes),
    ...asArray(candidate.routes || candidate.route),
    ...asArray(candidate.changedPaths || candidate.changed_paths),
    ...asArray(candidate.allowedPaths || candidate.allowed_paths),
    ...asArray(candidate.writeSet || candidate.write_set),
    ...asArray(candidate.triggerConditions || candidate.trigger_conditions),
    ...asArray(ruleCandidate.affectedRoutes || ruleCandidate.affected_routes),
    ...asArray(ruleCandidate.routes || ruleCandidate.route),
    ...asArray(ruleCandidate.changedPaths || ruleCandidate.changed_paths),
    ...asArray(ruleCandidate.allowedPaths || ruleCandidate.allowed_paths),
    ...asArray(ruleCandidate.writeSet || ruleCandidate.write_set),
    ...asArray(ruleCandidate.triggerConditions || ruleCandidate.trigger_conditions),
  ];
}

function uniquePolicyDeltaCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false;
    const key = stableJson(normalizePolicyDeltaRuleCandidate(candidate.ruleCandidate || candidate.rule_candidate || candidate));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizePolicyDeltaRuleCandidate(candidate = {}) {
  const preferredStrategies = unique(asArray(candidate.preferredStrategies || candidate.preferred_strategies || candidate.preferredStrategy || candidate.preferred_strategy || candidate.strategy)
    .map(normalizeTowerStrategyName)
    .filter(Boolean));
  const avoidStrategies = unique(asArray(candidate.avoidStrategies || candidate.avoid_strategies || candidate.avoidStrategy || candidate.avoid_strategy || candidate.blockedStrategies || candidate.blocked_strategies)
    .map(normalizeTowerStrategyName)
    .filter(Boolean));
  return {
    ...candidate,
    rule: candidate.rule || candidate.candidate || candidate.name || 'counterfactual_policy_delta',
    ...(preferredStrategies.length ? { preferredStrategies } : {}),
    ...(avoidStrategies.length ? { avoidStrategies } : {}),
    ...(candidate.requiredTowerActions || candidate.required_tower_actions
      ? { requiredTowerActions: asArray(candidate.requiredTowerActions || candidate.required_tower_actions).map(String).filter(Boolean) }
      : {}),
  };
}

export async function getControlState(workspaceSlug, projectId, actor = null) {
  const project = await prisma.codeSiteProject.findFirst({
    where: { id: projectId, workspaceSlug },
    include: PROJECT_INCLUDE,
  });
  if (!project) throw notFound('project_not_found');
  await requireProjectAccess(project, actor, 'write');
  const projection = projectProjection(project);
  return buildControlState(workspaceSlug, projection);
}

export async function getCodeSiteMetrics(workspaceSlug, projectId, actor = null) {
  const project = await prisma.codeSiteProject.findFirst({
    where: { id: projectId, workspaceSlug },
    include: PROJECT_INCLUDE,
  });
  if (!project) throw notFound('project_not_found');
  await requireProjectAccess(project, actor, 'write');
  const projection = projectProjection(project);
  const controlState = buildControlState(workspaceSlug, projection);
  return buildCodeSiteMetrics({ project: projection, controlState, workspaceSlug });
}

function buildControlState(workspaceSlug, projection) {
  const activeLeases = projection.mutationLeases.filter((lease) => lease.status === 'active');
  const baseCollisionForecast = predictCollisions({
    executionPlans: projection.executionPlans,
    leases: projection.mutationLeases,
    transactions: projection.mutationTxns,
    inspectionRuns: projection.inspectionRuns,
    zonePolicy: projection.zonePolicy,
  });
  const learnedPolicyDeltas = asArray(projection.policyDeltas).map(normalizeLearnedPolicyDelta).filter(Boolean);
  const collisionForecast = learnedPolicyDeltas.length
    ? applyCounterfactualPolicyHintsToForecast(baseCollisionForecast, learnedPolicyDeltas, buildTowerSimulationSignals({
      project: projection,
      executionPlans: projection.executionPlans,
      mutationLeases: projection.mutationLeases,
      forecast: baseCollisionForecast,
      zonePolicy: projection.zonePolicy,
      learnedPolicyDeltas,
    }))
    : baseCollisionForecast;
  const pilotLicenseHealth = buildPilotLicenseHealthRecords(projection);
  const pilotLicenseSummary = pilotLicenseHealthSummary(pilotLicenseHealth);
  const filesystemBoundaryProofs = buildFilesystemBoundaryProofRecords(projection);
  const pendingQuarantines = quarantineReviewRecords(projection)
    .filter((record) => record.status !== 'applied')
    .map((record) => ({
      quarantineId: record.quarantineId,
      status: record.status,
      transactionId: record.transactionId,
      mutationLeaseId: record.mutationLeaseId,
      displayCallsign: record.displayCallsign,
      paths: record.paths,
      changeCount: record.changes.length,
      appliedPaths: record.appliedPaths,
      remainingPaths: record.remainingPaths,
      latestReplayAttempt: record.latestReplayAttempt,
      successfulReplay: record.successfulReplay,
      evidenceRefs: record.evidenceRefs,
      lifecycle: record.lifecycle,
    }));
  const requiredActions = [
    ...projection.assumptions
      .filter((assumption) => assumption.status === 'invalidated')
      .map((assumption) => `rebase_assumption:${assumption.id}`),
    ...projection.inboxItems
      .filter((item) => item.status === 'pending' && item.requiresResponse)
      .map((item) => `ack_event:${item.eventId || item.id}`),
    ...pendingQuarantines.map((record) => `review_quarantine:${record.quarantineId}`),
    ...openMaydayResumeActions(projection),
    ...filesystemBoundaryProofs
      .filter((record) => !record.proofComplete)
      .map((record) => `complete_filesystem_boundary_proof:${record.proofId}`),
    ...pilotLicenseHealth.map((record) => record.requiredAction).filter(Boolean),
  ];
  return {
    projectId: projection.id,
    workspaceSlug,
    towerState: requiredActions.length ? 'holding' : 'active',
    status: projection.status,
    activeFlights: projection.executionPlans.filter((plan) => ['filed', 'preflight', 'cleared', 'taxiing', 'airborne', 'holding'].includes(plan.status)),
    activeMutationLeases: activeLeases,
    activeTransactions: projection.mutationTxns.filter((txn) => WORKSPACE_ACTIVE_TRANSACTION_STATUSES.includes(txn.status)),
    allowedPaths: unique(activeLeases.flatMap((lease) => pathsForRoute(lease.lease.allowedPaths || []))),
    blockedPaths: unique(activeLeases.flatMap((lease) => pathsForRoute(lease.lease.blockedPaths || []))),
    pendingQuarantines,
    pilotLicenseHealth,
    pilotLicenseSummary,
    filesystemBoundaryProofs,
    requiredActions,
    eventsSince: eventCursor(projection.events.at(-1)),
    inboxUrl: `/api/workspace/${encodeURIComponent(workspaceSlug)}/codesite/agent-sessions/:agentSessionId/inbox`,
    collisionForecast,
    updatedAt: new Date().toISOString(),
  };
}

function openMaydayResumeActions(projection) {
  const hasOpenStopWork = asArray(projection.documents).some((document) => (
    document.kind === 'stop_work'
    && ['open', 'blocked', 'pending'].includes(String(document.status || '').toLowerCase())
  ));
  if (!hasOpenStopWork) return [];
  const incidentIds = asArray(projection.incidents)
    .filter((incident) => (
      incident.category === 'mayday'
      && incident.incidentReplay?.maydayWorkflow?.humanResumeRequired !== false
      && incident.incidentReplay?.maydayWorkflow?.resumeGate?.status !== 'approved'
    ))
    .map((incident) => incident.id);
  return unique(incidentIds).map((incidentId) => `resume_mayday:${incidentId}`);
}

export async function getEvents(workspaceSlug, projectId, since, actor = null) {
  const project = await requireProject(workspaceSlug, projectId, actor, 'read');
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

export async function getAgentManifest(workspaceSlug, projectId, actor = null) {
  await requireProject(workspaceSlug, projectId, actor, 'read');
  return {
    version: 1,
    projectId,
    controlState: `projects/${projectId}/control-state.json`,
    events: `projects/${projectId}/events.jsonl`,
    schemas: 'schemas/',
    inboxRoot: `projects/${projectId}/inbox/`,
    quarantineRoot: `projects/${projectId}/quarantines/`,
    quarantineIndex: `projects/${projectId}/quarantines/index.jsonl`,
    proofBundleRoot: `projects/${projectId}/proof-bundles/`,
    mcpTools: CODESITE_MCP_TOOLS,
  };
}

export async function getSchemas() {
  return codesiteSchemas();
}

export async function previewArtifacts(workspaceSlug, projectId, options = {}, actor = null) {
  const projectRow = await prisma.codeSiteProject.findFirst({
    where: { id: projectId, workspaceSlug },
    include: PROJECT_INCLUDE,
  });
  if (!projectRow) throw notFound('project_not_found');
  await requireProjectAccess(projectRow, actor, 'read');
  const project = artifactProjectProjection(projectRow);
  const controlState = buildControlState(workspaceSlug, project);
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

export async function exportArtifacts(workspaceSlug, projectId, actor = null) {
  const projectRow = await prisma.codeSiteProject.findFirst({
    where: { id: projectId, workspaceSlug },
    include: PROJECT_INCLUDE,
  });
  if (!projectRow) throw notFound('project_not_found');
  await requireProjectAccess(projectRow, actor, 'read');
  const project = artifactProjectProjection(projectRow);
  const controlState = buildControlState(workspaceSlug, project);
  const files = buildArtifactProjection(project, controlState).map((file) => file.relativePath);
  const event = await recordEvent(projectId, {
    eventType: 'black_box_closed',
    actorType: 'artifact_projection',
    actorId: projectId,
    details: {
      written: true,
      root: null,
      reason: 'explicit_export',
      files,
    },
  });
  return syncArtifactsForProject(projectId, { reason: 'artifact_export_closed', eventId: event.id, force: true });
}

export async function collisionPredict(workspaceSlug, projectId, actor = null) {
  const project = await prisma.codeSiteProject.findFirst({
    where: { id: projectId, workspaceSlug },
    include: { members: true, agentSessions: true, executionPlans: true, mutationLeases: true, incidents: true, inspectionRuns: true },
  });
  if (!project) throw notFound('project_not_found');
  await requireProjectAccess(project, actor, 'read');
  const executionPlans = project.executionPlans.map(executionPlanProjection);
  const mutationLeases = project.mutationLeases.map(mutationLeaseProjection);
  const zonePolicy = parseJson(project.zonePolicyJson, compileZonePolicy());
  const forecast = predictCollisions({
    executionPlans,
    leases: mutationLeases,
    zonePolicy,
  });
  const learnedPolicyDeltas = await promotedPolicyDeltasForWorkspace(workspaceSlug);
  if (!learnedPolicyDeltas.length) return forecast;
  const signals = buildTowerSimulationSignals({
    project,
    executionPlans,
    mutationLeases,
    forecast,
    zonePolicy,
    learnedPolicyDeltas,
  });
  return applyCounterfactualPolicyHintsToForecast(forecast, learnedPolicyDeltas, signals);
}

export async function shadowMergeSimulate(workspaceSlug, projectId, body = {}, actor = null) {
  const project = await prisma.codeSiteProject.findFirst({
    where: { id: projectId, workspaceSlug },
    include: {
      members: true,
      agentSessions: true,
      executionPlans: true,
      mutationLeases: true,
      incidents: true,
      inspectionRuns: true,
    },
  });
  if (!project) throw notFound('project_not_found');
  await requireProjectAccess(project, actor, 'write');
  const zonePolicy = parseJson(project.zonePolicyJson, compileZonePolicy());
  const executionPlans = asArray(project.executionPlans).map(executionPlanProjection);
  const mutationLeases = asArray(project.mutationLeases).map(mutationLeaseProjection);
  const learnedPolicyDeltas = await promotedPolicyDeltasForWorkspace(workspaceSlug);
  const forecast = predictCollisions({
    executionPlans,
    leases: mutationLeases,
    zonePolicy,
  });
  const requestedStrategies = asArray(
    body.strategies
    ?? body.strategy
    ?? body.coordinationStrategies
    ?? body.coordination_strategies
    ?? DEFAULT_TOWER_SIMULATION_STRATEGIES,
  );
  // Workstream E: an explicit empty universes list can never constitute an
  // executed merge proof â€” the runner fails it, so reject before dispatch.
  if (body.universes !== undefined && asArray(body.universes).length === 0) {
    throw badRequest('shadow_universes_required');
  }
  const strategies = unique(requestedStrategies
    .map(normalizeTowerStrategyName)
    .filter(Boolean));
  const strategySet = strategies.length ? strategies : DEFAULT_TOWER_SIMULATION_STRATEGIES;
  const towerSignals = buildTowerSimulationSignals({
    project,
    executionPlans,
    mutationLeases,
    forecast,
    zonePolicy,
    learnedPolicyDeltas,
  });
  const universes = strategySet.map((strategy) => scoreTowerStrategy(strategy, towerSignals));
  const selected = universes.slice().sort((a, b) => {
    const policyPriority = Number(b.counterfactualPolicyPriority || 0) - Number(a.counterfactualPolicyPriority || 0);
    if (policyPriority !== 0) return policyPriority;
    if (a.predictedCollisionRisk !== b.predictedCollisionRisk) return a.predictedCollisionRisk - b.predictedCollisionRisk;
    if (asArray(a.unresolvedRisks).length !== asArray(b.unresolvedRisks).length) {
      return asArray(a.unresolvedRisks).length - asArray(b.unresolvedRisks).length;
    }
    if (a.inspectionCost !== b.inspectionCost) return a.inspectionCost - b.inspectionCost;
    return a.staleAssumptions - b.staleAssumptions;
  })[0];
  const shadowJobRef = body.shadowJobRef || body.shadow_job_ref || `codesite-shadow:${digest({
    projectId,
    strategies: strategySet,
    forecast,
    sourceDigest: towerSignals.sourceDigest,
  })}`;
  const baseSnapshot = body.baseSnapshot || body.base_snapshot || `repo@${digest({
    projectId,
    policyDigest: towerSignals.policyDigest,
    routes: towerSignals.routeDigest,
  })}`;
  const evidenceRefs = unique([
    'codesite:shadow_merge_simulator',
    `codesite:repo-policy:${towerSignals.policyDigest}`,
    `codesite:collision-forecast:${digest(forecast)}`,
    ...towerSignals.priorIncidents.map((incident) => `codesite:incident:${incident.id}`).filter(Boolean),
    ...towerSignals.inspectionRuns.map((run) => `codesite:inspection:${run.id}`).filter(Boolean),
    ...towerSignals.learnedPolicyDeltas.map((delta) => `codesite:policy-delta:${delta.id}`).filter(Boolean),
  ]);
  const policyDeltaCandidates = buildTowerPolicyDeltaCandidates(towerSignals, selected);
  const shadowExecutionPlan = normalizeShadowExecutionPlan(body);
  const shadowEvidenceRequirement = shadowRunnerEvidenceRequirement(body);
  const shadowExecution = await runConfiguredShadowRunner({
    workspaceSlug,
    projectId,
    shadowJobRef,
    baseSnapshot,
    strategySet,
    universes,
    selected,
    forecast,
    towerSignals,
    shadowExecutionPlan,
  });
  const shadowExecutionCompleted = shadowExecution?.status === 'completed';
  const shadowExecutionEvidenceRefs = shadowRunnerEvidenceRefs(shadowExecution);
  const shadowEvidencePolicy = evaluateShadowRunnerEvidencePolicy({
    requirement: shadowEvidenceRequirement,
    shadowExecution,
    evidenceRefs: shadowExecutionEvidenceRefs,
  });
  if (!shadowEvidencePolicy.ok) {
    await recordShadowRunnerEvidencePolicyFailure(project.id, {
      shadowJobRef,
      baseSnapshot,
      strategySet,
      selected,
      forecast,
      policy: shadowEvidencePolicy,
    });
    throw badRequest('shadow_runner_evidence_required', shadowEvidencePolicy);
  }
  const mergedEvidenceRefs = unique([
    ...evidenceRefs,
    ...shadowExecutionEvidenceRefs,
    ...(shadowExecution ? [`codesite:shadow-runner:${digest(shadowExecution)}`] : []),
  ]);
  const mergedUniverses = Array.isArray(shadowExecution?.universes) && shadowExecution.universes.length
    ? mergeExecutedShadowUniverses(universes, shadowExecution.universes)
    : universes;
  const result = {
    selected: selected.strategy,
    appliedPolicyDeltas: selected.learnedPolicyDeltaRefs || [],
    // Unified discriminator required by Workstream E: every consumer (UI,
    // release gate, agents) reads this instead of the three legacy vocabularies.
    resultKind: shadowExecutionCompleted ? 'executed' : 'forecast',
    reason: {
      reasonCodes: selected.reasonCodes,
      staleAssumptions: selected.staleAssumptions,
      inspectionCost: selected.inspectionCost,
      predictedCollisionRisk: selected.predictedCollisionRisk,
      riskLevel: forecast.riskLevel,
      sourceSignals: selected.sourceSignals,
      learnedPolicyDeltaRefs: selected.learnedPolicyDeltaRefs || [],
      shadowExecutionMode: shadowExecution ? 'external_runner' : 'control_plane_simulator',
      shadowExecutionPolicy: shadowEvidencePolicy,
    },
    universes: mergedUniverses,
    shadowJobRef,
    baseSnapshot,
    evidenceRefs: mergedEvidenceRefs,
    policyDeltaCandidates,
    shadowExecution: shadowExecution ? {
      status: shadowExecution.status || 'completed',
      runner: shadowExecution.runner || shadowExecution.runnerId || shadowExecution.runner_id || 'configured-shadow-runner',
      executionMode: shadowExecution.executionMode || shadowExecution.execution_mode || null,
      evidenceRefs: shadowExecutionEvidenceRefs,
      universeCount: asArray(shadowExecution.universes).length,
      // Workstream E runtime/cost evidence rollup: aggregate wall time across
      // universes and their validation commands so reviewers can compare the
      // measured execution cost of each route without parsing raw evidence.
      runtimeMs: asArray(shadowExecution.universes).reduce((sum, universe) => {
        const universeMs = Number(universe?.durationMs) || 0;
        const commandMs = asArray(universe?.commands)
          .reduce((inner, command) => inner + (Number(command?.durationMs) || 0), 0);
        return sum + Math.max(universeMs, commandMs);
      }, 0),
      commandCount: asArray(shadowExecution.universes)
        .reduce((sum, universe) => sum + asArray(universe?.commands).length, 0),
      passedUniverses: asArray(shadowExecution.universes)
        .filter((universe) => universe?.status === 'passed').length,
      failedUniverses: asArray(shadowExecution.universes)
        .filter((universe) => universe?.status === 'failed').length,
      digest: digest(shadowExecution),
    } : null,
    repoSignals: towerSignals.summary,
  };
  await createCounterfactualRun(workspaceSlug, projectId, {
    shadowJobRef,
    baseSnapshot,
    universes: mergedUniverses,
    arbiterVerdict: result,
    validityStrength: shadowExecutionCompleted ? 'executed' : towerSignals.summary.signalStrength,
    evidenceRefs: mergedEvidenceRefs,
  }, actor);
  return result;
}

function normalizeShadowExecutionPlan(body = {}) {
  const plan = body.shadowExecutionPlan
    || body.shadow_execution_plan
    || body.shadowExecution
    || body.shadow_execution
    || null;
  if (!plan || typeof plan !== 'object') return null;
  return plan;
}

function shadowRunnerEvidenceRequirement(body = {}) {
  const sources = [];
  const optionEntries = [
    ['requireExternalRunnerEvidence', body.requireExternalRunnerEvidence],
    ['require_external_runner_evidence', body.require_external_runner_evidence],
    ['requireShadowRunnerEvidence', body.requireShadowRunnerEvidence],
    ['require_shadow_runner_evidence', body.require_shadow_runner_evidence],
    ['requireRunnerEvidence', body.requireRunnerEvidence],
    ['require_runner_evidence', body.require_runner_evidence],
  ];
  for (const [key, value] of optionEntries) {
    if (configValueEnabled(value)) sources.push(`option:${key}`);
  }
  const proofMaturity = body.proofMaturity || body.proof_maturity || body.maturity || null;
  if (configValueRequiresMatureProof(proofMaturity)) sources.push('option:proofMaturity');
  for (const key of SHADOW_RUNNER_EVIDENCE_REQUIRED_ENV_KEYS) {
    if (configValueEnabled(process.env[key])) sources.push(`env:${key}`);
  }
  for (const key of SHADOW_MERGE_MATURITY_ENV_KEYS) {
    if (configValueRequiresMatureProof(process.env[key])) sources.push(`env:${key}`);
  }
  return {
    required: sources.length > 0,
    sources: unique(sources),
  };
}

function configValueEnabled(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
  return /^(1|true|on|yes|required|require|strict|mature)$/i.test(String(value).trim());
}

function configValueRequiresMatureProof(value) {
  if (value == null || value === false) return false;
  return /^(mature|strict|external_runner|external-runner|runner|required|require)$/i.test(String(value).trim());
}

function shadowRunnerEvidenceRefs(shadowExecution) {
  if (!shadowExecution) return [];
  return unique([
    ...asArray(shadowExecution.evidenceRefs || shadowExecution.evidence_refs),
    ...asArray(shadowExecution.universes).flatMap((universe) => asArray(universe?.evidenceRefs || universe?.evidence_refs)),
  ].map(String).filter(Boolean));
}

function evaluateShadowRunnerEvidencePolicy({ requirement, shadowExecution, evidenceRefs = [] }) {
  const required = Boolean(requirement?.required);
  const status = shadowExecution?.status || null;
  const runner = shadowExecution?.runner || shadowExecution?.runnerId || shadowExecution?.runner_id || null;
  const executionMode = shadowExecution?.executionMode || shadowExecution?.execution_mode || null;
  const base = {
    ok: true,
    required,
    sources: asArray(requirement?.sources),
    status: required ? 'satisfied' : 'not_required',
    shadowExecutionStatus: status,
    shadowExecutionMode: shadowExecution ? 'external_runner' : 'control_plane_simulator',
    runner,
    executionMode,
    evidenceRefs,
    reasonCodes: required
      ? ['shadow_runner_evidence_required', 'shadow_runner_evidence_satisfied']
      : ['shadow_runner_evidence_not_required'],
  };
  if (!required) return base;
  if (!shadowExecution) {
    return {
      ...base,
      ok: false,
      status: 'blocked',
      failureCode: 'shadow_runner_not_configured',
      reasonCodes: [
        'shadow_runner_evidence_required',
        'shadow_runner_not_configured',
        'control_plane_shadow_simulator_fallback_blocked',
      ],
    };
  }
  if (status !== 'completed') {
    return {
      ...base,
      ok: false,
      status: 'blocked',
      failureCode: 'shadow_runner_execution_failed',
      reasonCodes: [
        'shadow_runner_evidence_required',
        'shadow_runner_execution_failed',
        'control_plane_shadow_simulator_fallback_blocked',
      ],
    };
  }
  if (!evidenceRefs.length) {
    return {
      ...base,
      ok: false,
      status: 'blocked',
      failureCode: 'shadow_runner_evidence_missing',
      reasonCodes: [
        'shadow_runner_evidence_required',
        'shadow_runner_evidence_missing',
        'control_plane_shadow_simulator_fallback_blocked',
      ],
    };
  }
  return base;
}

async function recordShadowRunnerEvidencePolicyFailure(projectId, {
  shadowJobRef,
  baseSnapshot,
  strategySet = [],
  selected = null,
  forecast = null,
  policy,
}) {
  const details = {
    type: 'shadow_runner_evidence_policy',
    status: 'blocked',
    decision: 'block',
    shadowJobRef,
    baseSnapshot,
    selected: selected?.strategy || selected || null,
    strategies: strategySet,
    riskLevel: forecast?.riskLevel || null,
    reasonCodes: asArray(policy?.reasonCodes),
    requiredBy: asArray(policy?.sources),
    shadowExecutionStatus: policy?.shadowExecutionStatus || null,
    shadowExecutionMode: policy?.shadowExecutionMode || null,
    runner: policy?.runner || null,
    executionMode: policy?.executionMode || null,
    failureCode: policy?.failureCode || 'shadow_runner_evidence_required',
    fallback: {
      attempted: 'control_plane_simulator',
      allowed: false,
    },
    instruction: 'Configure an external shadow runner or disable the explicit runner-evidence requirement for simulator-only runs.',
  };
  const evidenceRefs = unique([
    ...asArray(policy?.evidenceRefs),
    `codesite:shadow-runner-policy:${digest(details)}`,
  ]);
  await recordEvent(projectId, {
    eventType: 'ground_stop',
    actorType: 'counterfactual',
    actorId: shadowJobRef,
    evidenceRefs,
    details: {
      ...details,
      evidenceRefs,
    },
  });
}

async function runConfiguredShadowRunner(input) {
  const command = configuredShadowRunnerCommand();
  if (!command) return null;
  const timeoutMs = normalizeShadowRunnerTimeout();
  const inputDigest = digest(input);
  const commandDigest = digest({ executable: command.executable, args: command.args, cwd: command.cwd || null });
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesite-shadow-runner-'));
  const outputPath = path.join(outputDir, 'result.json');
  try {
    const runnerInput = {
      schemaVersion: 'synthi.codesite.shadowRunnerInput.v1',
      ...input,
      outputPath,
    };
    const result = await runJsonCommand(command.executable, command.args, {
      cwd: command.cwd || process.cwd(),
      timeoutMs,
      input: runnerInput,
    });
    const outputText = await fs.readFile(outputPath, 'utf8').catch(() => null);
    if (result.exitCode !== 0) {
      return {
        schemaVersion: 'synthi.codesite.shadowRunnerResult.v1',
        status: 'failed',
        runner: command.executable,
        inputDigest,
        commandDigest,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        stdoutTail: result.stdoutTail,
        stderrTail: result.stderrTail,
        outputPathWritten: Boolean(outputText),
        evidenceRefs: [`codesite:shadow-runner-failed:${digest(result)}`],
      };
    }
    if (!outputText && result.stdoutTruncated) {
      return {
        schemaVersion: 'synthi.codesite.shadowRunnerResult.v1',
        status: 'failed',
        runner: command.executable,
        inputDigest,
        commandDigest,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        stdoutTail: result.stdoutTail,
        stderrTail: result.stderrTail,
        failureCode: 'shadow_runner_output_too_large',
        evidenceRefs: [`codesite:shadow-runner-output-too-large:${digest(result)}`],
      };
    }
    const resultText = outputText || result.stdout || result.stdoutTail || '{}';
    try {
      const parsed = JSON.parse(resultText);
      const stdoutDigest = digest(result.stdout || '');
      const stderrDigest = digest(result.stderr || '');
      const outputArtifactDigest = outputText ? digest(outputText) : null;
      const output = {
        schemaVersion: 'synthi.codesite.shadowRunnerResult.v1',
        status: 'completed',
        runner: command.executable,
        ...parsed,
        inputDigest,
        commandDigest,
        stdoutDigest,
        stderrDigest,
        outputArtifactDigest,
      };
      const resultDigest = digest({
        schemaVersion: output.schemaVersion,
        status: output.status,
        runner: output.runner,
        executionMode: output.executionMode || output.execution_mode || null,
        selected: output.selected || null,
        inputDigest,
        commandDigest,
        stdoutDigest,
        stderrDigest,
        outputArtifactDigest,
        universeDigests: asArray(output.universes).map((universe) => digest(universe)),
      });
      output.resultDigest = resultDigest;
      output.evidenceRefs = unique([
        ...asArray(parsed.evidenceRefs || parsed.evidence_refs),
        `codesite:shadow-runner-input:${inputDigest}`,
        `codesite:shadow-runner-command:${commandDigest}`,
        ...(outputArtifactDigest ? [`codesite:shadow-runner-output-artifact:${outputArtifactDigest}`] : []),
        `codesite:shadow-runner-output:${stdoutDigest}`,
        `codesite:shadow-runner-result:${resultDigest}`,
      ]);
      return output;
    } catch (error) {
      return {
        schemaVersion: 'synthi.codesite.shadowRunnerResult.v1',
        status: 'failed',
        runner: command.executable,
        inputDigest,
        commandDigest,
        exitCode: result.exitCode,
        parseError: error?.message || String(error),
        stdoutTail: result.stdoutTail,
        stderrTail: result.stderrTail,
        outputPathWritten: Boolean(outputText),
        evidenceRefs: [`codesite:shadow-runner-invalid-json:${digest(result)}`],
      };
    }
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
  }
}

function configuredShadowRunnerCommand() {
  const json = process.env.SYNTHI_CODESITE_SHADOW_RUNNER_COMMAND_JSON;
  if (json) {
    try {
      const parsed = JSON.parse(json);
      const list = Array.isArray(parsed) ? parsed : asArray(parsed.command || parsed.argv);
      const [executable, ...args] = list.map(String).filter(Boolean);
      if (executable) return { executable, args, cwd: parsed.cwd || parsed.workingDirectory || parsed.working_directory || null };
    } catch (_) {
      return null;
    }
  }
  const executable = process.env.SYNTHI_CODESITE_SHADOW_RUNNER_COMMAND;
  if (!executable) return null;
  const args = process.env.SYNTHI_CODESITE_SHADOW_RUNNER_ARGS_JSON
    ? parseJson(process.env.SYNTHI_CODESITE_SHADOW_RUNNER_ARGS_JSON, [])
    : [];
  return { executable, args: asArray(args).map(String), cwd: process.env.SYNTHI_CODESITE_SHADOW_RUNNER_CWD || null };
}

function normalizeShadowRunnerTimeout() {
  return getCodeSiteRuntimeConfig().shadowRunnerTimeoutMs;
}

function mergeExecutedShadowUniverses(simulatedUniverses, executedUniverses) {
  const executedByStrategy = new Map(asArray(executedUniverses)
    .map((universe) => [normalizeTowerStrategyName(universe.strategy || universe.universe), universe])
    .filter(([strategy]) => strategy));
  return asArray(simulatedUniverses).map((universe) => {
    const executed = executedByStrategy.get(normalizeTowerStrategyName(universe.strategy));
    if (!executed) return universe;
    return {
      ...universe,
      execution: {
        status: executed.status || executed.result || 'completed',
        evidenceRefs: asArray(executed.evidenceRefs || executed.evidence_refs),
        command: executed.command || null,
        executionMode: executed.executionMode || executed.execution_mode || null,
        exitCode: Number.isFinite(Number(executed.exitCode)) ? Number(executed.exitCode) : null,
        outputDigest: executed.outputDigest || executed.output_digest || null,
      },
      reasonCodes: unique([...asArray(universe.reasonCodes), ...asArray(executed.reasonCodes || executed.reason_codes)]),
      evidenceRefs: unique([...asArray(universe.evidenceRefs), ...asArray(executed.evidenceRefs || executed.evidence_refs)]),
    };
  });
}

function buildTowerSimulationSignals({ project, executionPlans, mutationLeases, forecast, zonePolicy, learnedPolicyDeltas = [] }) {
  const semanticGraph = zonePolicy?.semanticGraph || {};
  const priorIncidents = asArray(project.incidents).map(towerIncidentSignal);
  const inspectionRuns = asArray(project.inspectionRuns).map(towerInspectionSignal);
  const learnedDeltas = asArray(learnedPolicyDeltas).map(normalizeLearnedPolicyDelta).filter(Boolean);
  const activeLeases = mutationLeases.filter((lease) => lease.status === 'active');
  const footprints = executionPlans.map((plan) => towerRouteFootprint({
    plan,
    zonePolicy,
    semanticGraph,
    priorIncidents,
    inspectionRuns,
  }));
  const contractRisks = asArray(forecast.risks).filter((risk) =>
    ['contract_collision', 'semantic_collision'].includes(risk.risk)
    || (risk.risk === 'wake_turbulence' && risk.wake?.kind !== 'migration'));
  const migrationRisks = asArray(forecast.risks).filter((risk) =>
    risk.risk === 'migration_collision'
    || (risk.risk === 'wake_turbulence' && risk.wake?.kind === 'migration'));
  const severityPoints = asArray(forecast.risks).reduce((sum, risk) => {
    const severity = String(risk.severity || '').toLowerCase();
    return sum + ({ critical: 8, high: 5, medium: 3, low: 1 }[severity] || 2);
  }, 0);
  const zones = unique(footprints.flatMap((footprint) => footprint.zones.map((zone) => zone.zoneKey || zone.label || zone.class).filter(Boolean)));
  const schemaOwners = unique(footprints.flatMap((footprint) => footprint.schemaOwners));
  const testOwners = unique(footprints.flatMap((footprint) => footprint.tests));
  const missingTestRoutes = footprints
    .filter((footprint) => footprint.route.length > 0 && footprint.tests.length === 0)
    .flatMap((footprint) => footprint.route);
  const migrationLocks = unique(footprints.flatMap((footprint) => footprint.migrationLocks));
  const packageExports = unique(footprints.flatMap((footprint) => footprint.packageExports));
  const importEdges = unique(footprints.flatMap((footprint) => footprint.importEdges));
  const downstreamDependents = unique(footprints.flatMap((footprint) => footprint.importedBy));
  const restrictedClasses = unique(footprints.flatMap((footprint) => footprint.zoneClasses.filter((klass) => ['A', 'B'].includes(klass))));
  const activeLeaseLocks = activeLeases.flatMap((lease) => pathsForRoute(lease.lease?.allowedPaths || lease.lease?.route || []));
  const routeDigest = digest(footprints.map((footprint) => ({ planId: footprint.planId, route: footprint.route })));
  const policyDigest = digest(zonePolicy);
  const sourceDigest = digest({
    semanticGraphDigest: semanticGraph.sourceDigest || digest(semanticGraph),
    policyDigest,
    routeDigest,
    incidents: priorIncidents.map((incident) => incident.id),
    inspections: inspectionRuns.map((run) => run.id),
    learnedPolicyDeltas: learnedDeltas.map((delta) => ({
      id: delta.id,
      ruleCandidate: delta.ruleCandidate,
      triggerConditions: delta.triggerConditions,
      confidence: delta.confidence,
    })),
  });
  const summary = {
    signalStrength: sourceSignalStrength({ semanticGraph, priorIncidents, inspectionRuns }),
    planCount: executionPlans.length,
    activeLeaseCount: activeLeases.length,
    forecastRiskCount: asArray(forecast.risks).length,
    highRiskCount: asArray(forecast.risks).filter((risk) => ['critical', 'high'].includes(String(risk.severity || '').toLowerCase())).length,
    contractRiskCount: contractRisks.length,
    migrationRiskCount: migrationRisks.length,
    classAOrBZones: restrictedClasses.length,
    importGraphEdges: importEdges.length,
    downstreamDependents: downstreamDependents.length,
    testOwners: testOwners.length,
    missingTestRoutes: unique(missingTestRoutes).length,
    schemaOwners: schemaOwners.length,
    migrationLocks: migrationLocks.length,
    packageExports: packageExports.length,
    priorIncidents: priorIncidents.length,
    learnedPolicyDeltas: learnedDeltas.length,
    activeLeaseLocks: unique(activeLeaseLocks).length,
    inspectionRuns: inspectionRuns.length,
  };
  const rawStaleAssumptionPressure = contractRisks.length
    + Math.ceil(downstreamDependents.length / 2)
    + migrationLocks.length
    + packageExports.length
    + priorIncidents.filter((incident) => ['critical', 'high', 'medium'].includes(String(incident.severity).toLowerCase())).length;
  const baseInspectionCost = 2
    + executionPlans.length
    + restrictedClasses.length
    + Math.ceil(testOwners.length / 2)
    + migrationLocks.length
    + Math.ceil(priorIncidents.length / 2)
    + unique(missingTestRoutes).length;
  return {
    project,
    forecast,
    footprints,
    priorIncidents,
    learnedPolicyDeltas: learnedDeltas,
    inspectionRuns,
    activeLeases,
    semanticGraph,
    severityPoints,
    contractRisks,
    migrationRisks,
    schemaOwners,
    testOwners,
    missingTestRoutes: unique(missingTestRoutes),
    migrationLocks,
    packageExports,
    importEdges,
    downstreamDependents,
    restrictedClasses,
    activeLeaseLocks: unique(activeLeaseLocks),
    rawStaleAssumptionPressure,
    baseInspectionCost,
    policyDigest,
    routeDigest,
    sourceDigest,
    summary,
  };
}

function towerRouteFootprint({ plan, zonePolicy, semanticGraph, priorIncidents, inspectionRuns }) {
  const route = pathsForRoute(plan.route);
  const files = normalizePathList(asArray(semanticGraph.files));
  const routeFiles = files.filter((file) => route.some((pattern) => towerPathsOverlap(file, pattern)));
  const routeSurface = unique([...route, ...routeFiles]);
  const zones = route.map((pattern) => classifyPath(pattern.replace(/\*\*?$/, 'index.ts'), zonePolicy)).filter(Boolean);
  const imports = [];
  const importedBy = [];
  const importEdges = [];
  for (const edge of asArray(semanticGraph.importEdges)) {
    const from = normalizePath(edge.from);
    const imported = normalizePathList(edge.imports);
    if (!from) continue;
    if (routeSurface.some((pattern) => towerPathsOverlap(from, pattern))) {
      imports.push(...imported);
      importEdges.push(`${from}->${imported.join(',')}`);
    }
    if (imported.some((target) => routeSurface.some((pattern) => towerPathsOverlap(target, pattern)))) {
      importedBy.push(from);
      importEdges.push(`${from}->${imported.join(',')}`);
    }
  }
  const tests = asArray(semanticGraph.testOwnership)
    .filter((owner) => asArray(owner.covers).some((covered) =>
      [...routeSurface, ...imports, ...importedBy].some((pattern) => towerPathsOverlap(covered, pattern))))
    .map((owner) => owner.testPath)
    .filter(Boolean);
  const migrationLocks = asArray(semanticGraph.migrationLocks)
    .filter((lock) => route.some((pattern) => towerPathsOverlap(lock, pattern)));
  const packageExports = asArray(semanticGraph.packageExports)
    .filter((entry) => {
      const candidates = unique([
        entry.root && `${String(entry.root).replace(/\/+$/, '')}/**`,
        ...asArray(entry.exports),
      ].filter(Boolean));
      return candidates.some((candidate) => routeSurface.some((pattern) => towerPathsOverlap(candidate, pattern)));
    })
    .map((entry) => entry.packageName || entry.root)
    .filter(Boolean);
  const generatedClients = asArray(semanticGraph.generatedClients)
    .filter((client) => routeSurface.some((pattern) => towerPathsOverlap(client, pattern)) || routeSurface.some(isSchemaSurface));
  const incidents = priorIncidents.filter((incident) =>
    incident.affectedZones.some((zone) => routeSurface.some((pattern) => towerPathsOverlap(zone, pattern))));
  const inspections = inspectionRuns.filter((run) =>
    run.changedPaths.some((changedPath) => routeSurface.some((pattern) => towerPathsOverlap(changedPath, pattern))));
  const schemaOwners = routeSurface.filter(isSchemaSurface);
  return {
    planId: plan.id,
    displayCallsign: plan.displayCallsign,
    domain: plan.domain,
    route,
    routeFiles,
    zones,
    zoneClasses: unique(zones.map((zone) => String(zone.class || 'C').toUpperCase())),
    zoneRules: unique(zones.flatMap((zone) => asArray(zone.rules))),
    imports: unique(imports),
    importedBy: unique(importedBy),
    importEdges: unique(importEdges),
    tests: unique(tests),
    migrationLocks: unique(migrationLocks),
    packageExports: unique(packageExports),
    generatedClients: unique(generatedClients),
    schemaOwners: unique(schemaOwners),
    incidents,
    inspections,
  };
}

function normalizeTowerStrategyName(strategy) {
  const normalized = String(strategy || '')
    .trim()
    .toLowerCase()
    .replace(/\s*\/\s*/g, '-')
    .replace(/[_\s]+/g, '-');
  const aliases = {
    'frontend-backend-parallel': 'frontend-backend-parallel',
    'frontend-backend': 'frontend-backend-parallel',
    parallel: 'frontend-backend-parallel',
    'schema-first': 'schema-first',
    'backend-first': 'backend-first',
    'single-fullstack-agent': 'single-fullstack-agent',
    'single-fullstack': 'single-fullstack-agent',
    fullstack: 'single-fullstack-agent',
    'test-first': 'test-first',
  };
  return aliases[normalized] || normalized;
}

function scoreTowerStrategy(strategy, signals) {
  const normalized = normalizeTowerStrategyName(strategy);
  const sourceSignals = strategySourceSignals(signals);
  const baseRisk = signals.severityPoints
    + (signals.summary.contractRiskCount * 3)
    + (signals.summary.classAOrBZones * 2)
    + signals.summary.migrationLocks
    + Math.ceil(signals.summary.downstreamDependents / 2)
    + signals.summary.activeLeaseLocks;
  const staleBase = signals.rawStaleAssumptionPressure;
  const costBase = signals.baseInspectionCost;
  const hasSchemaContractPressure = signals.summary.contractRiskCount > 0
    || signals.summary.schemaOwners > 0
    || signals.summary.packageExports > 0;
  const hasMigrationPressure = signals.summary.migrationLocks > 0
    || signals.summary.migrationRiskCount > 0;
  const hasSchemaPressure = hasSchemaContractPressure || hasMigrationPressure;
  const hasTestPressure = signals.summary.testOwners > 0 || signals.summary.missingTestRoutes > 0;
  const profiles = {
    'schema-first': {
      riskMultiplier: hasSchemaContractPressure ? 0.34 : (hasMigrationPressure ? 0.72 : 0.72),
      staleMultiplier: hasSchemaContractPressure ? 0.12 : (hasMigrationPressure ? 0.5 : 0.45),
      costDelta: hasSchemaContractPressure ? 1 : 2,
      reasonCodes: hasSchemaContractPressure
        ? ['schema_airspace_first', 'downstream_assumptions_refresh_after_contract']
        : ['schema_first_has_limited_effect_without_contract_pressure'],
    },
    'backend-first': {
      riskMultiplier: hasSchemaPressure ? 0.78 : 0.7,
      staleMultiplier: hasSchemaPressure ? 0.72 : 0.45,
      costDelta: 2 + Math.ceil(signals.summary.downstreamDependents / 3),
      reasonCodes: ['backend_route_before_ui', 'api_surface_stabilized_before_frontend'],
    },
    'frontend-backend-parallel': {
      riskMultiplier: hasSchemaPressure ? 1.25 : 0.58,
      staleMultiplier: hasSchemaPressure ? 1.2 : 0.4,
      costDelta: hasSchemaPressure ? 3 : -1,
      reasonCodes: hasSchemaPressure
        ? ['parallelism_crosses_contract_airspace', 'requires_extra_assumption_refresh']
        : ['parallel_routes_have_low_semantic_overlap'],
    },
    'single-fullstack-agent': {
      riskMultiplier: hasMigrationPressure && !hasSchemaContractPressure ? 0.3 : 0.44,
      staleMultiplier: 0.3,
      costDelta: Math.max(2, signals.summary.planCount * 2),
      reasonCodes: hasMigrationPressure
        ? ['single_writer_reduces_merge_collision', 'single_migration_runway_lock']
        : ['single_writer_reduces_merge_collision', 'higher_serial_inspection_cost'],
    },
    'test-first': {
      riskMultiplier: hasTestPressure ? 0.62 : 0.8,
      staleMultiplier: hasSchemaPressure ? 0.45 : 0.28,
      costDelta: 2 + Math.ceil(signals.summary.testOwners / 2),
      reasonCodes: ['test_ownership_before_landing', 'inspection_radar_runs_before_mutation'],
    },
  };
  const profile = profiles[normalized] || {
    riskMultiplier: 0.9,
    staleMultiplier: 0.7,
    costDelta: 2,
    reasonCodes: ['custom_strategy_scored_from_repo_signals'],
  };
  const learnedMemory = learnedPolicyMemoryForStrategy(normalized, signals);
  const riskResolution = resolveTowerStrategyRisks(normalized, signals, {
    hasSchemaContractPressure,
    hasMigrationPressure,
    hasTestPressure,
  });
  const adjustedRisk = Math.max(0, baseRisk * profile.riskMultiplier);
  const unresolvedRiskPenalty = riskResolution.unresolvedRisks.length * 0.18;
  const predictedCollisionRisk = clamp(roundTo((adjustedRisk / 28) + unresolvedRiskPenalty + learnedMemory.riskDelta, 3), 0, 1);
  const staleAssumptions = Math.max(0, Math.round((staleBase * profile.staleMultiplier) + learnedMemory.staleDelta));
  const inspectionCost = Math.max(1, Math.round(costBase + profile.costDelta + learnedMemory.costDelta + (predictedCollisionRisk * 4)));
  const reworkRiskReduction = roundTo(Math.max(0, 1 - (adjustedRisk / Math.max(1, baseRisk || adjustedRisk || 1))), 3);
  const result = riskResolution.unresolvedRisks.length > 0
    ? (predictedCollisionRisk <= 0.55 ? 'review' : 'risk')
    : (predictedCollisionRisk <= 0.28 && staleAssumptions <= 1 ? 'passed' : (predictedCollisionRisk <= 0.55 ? 'review' : 'risk'));
  return {
    strategy: normalized,
    result,
    predictedCollisionRisk,
    staleAssumptions,
    inspectionCost,
    reworkRiskReduction,
    confidence: confidenceForSignalStrength(signals.summary.signalStrength, sourceSignals),
    avoidedRisks: riskResolution.avoidedRisks,
    unresolvedRisks: riskResolution.unresolvedRisks,
    requiredTowerActions: riskResolution.requiredTowerActions,
    counterfactualPolicyPriority: learnedMemory.priority,
    reasonCodes: unique([
      ...profile.reasonCodes,
      ...riskResolution.reasonCodes,
      ...(signals.summary.priorIncidents ? ['prior_incidents_weighted'] : []),
      ...(signals.summary.migrationLocks ? ['migration_lock_weighted'] : []),
      ...(signals.summary.importGraphEdges ? ['import_graph_weighted'] : []),
      ...(signals.summary.testOwners ? ['test_ownership_weighted'] : []),
      ...learnedMemory.reasonCodes,
    ]),
    learnedPolicyDeltaRefs: learnedMemory.policyDeltaRefs,
    sourceSignals,
  };
}

function resolveTowerStrategyRisks(strategy, signals, pressure = {}) {
  const avoidedRisks = [];
  const unresolvedRisks = [];
  const requiredTowerActions = [];
  const reasonCodes = [];
  for (const risk of asArray(signals.forecast.risks)) {
    const riskName = risk.risk || risk.type || 'collision';
    const recommendedAction = risk.recommendedResolution?.action || risk.wake?.requiredWaits?.[0] || null;
    const towerAction = recommendedAction || actionForRiskName(riskName);
    if (towerAction) requiredTowerActions.push(towerAction);
    const resolved = strategyResolvesRisk(strategy, riskName, recommendedAction, pressure);
    if (resolved) {
      avoidedRisks.push(riskName);
      reasonCodes.push(`${riskName}_mitigated`);
    } else {
      unresolvedRisks.push(riskName);
    }
  }
  if (pressure.hasMigrationPressure) requiredTowerActions.push('single_migration_runway_lock');
  if (pressure.hasSchemaContractPressure) requiredTowerActions.push('refresh_downstream_assumptions');
  if (pressure.hasTestPressure) requiredTowerActions.push('run_owned_tests_before_landing');
  return {
    avoidedRisks: unique(avoidedRisks),
    unresolvedRisks: unique(unresolvedRisks),
    requiredTowerActions: unique(requiredTowerActions),
    reasonCodes: unique(reasonCodes),
  };
}

function strategyResolvesRisk(strategy, riskName, recommendedAction, pressure = {}) {
  if (riskName === 'migration_collision' || recommendedAction === 'single_migration_runway_lock') {
    return strategy === 'single-fullstack-agent' || strategy === 'test-first';
  }
  if (['contract_collision', 'semantic_collision', 'wake_turbulence'].includes(riskName) || recommendedAction === 'schema_first') {
    return strategy === 'schema-first' || strategy === 'single-fullstack-agent' || strategy === 'test-first';
  }
  if (riskName === 'test_collision' || recommendedAction === 'sequence_test_radar') {
    return strategy === 'test-first' || strategy === 'single-fullstack-agent';
  }
  if (riskName === 'file_collision') {
    return strategy === 'single-fullstack-agent' || (!pressure.hasSchemaContractPressure && strategy !== 'frontend-backend-parallel');
  }
  return strategy === 'single-fullstack-agent';
}

function actionForRiskName(riskName) {
  if (riskName === 'migration_collision') return 'single_migration_runway_lock';
  if (['contract_collision', 'semantic_collision'].includes(riskName)) return 'schema_first';
  if (riskName === 'test_collision') return 'sequence_test_radar';
  if (riskName === 'wake_turbulence') return 'hold_for_wake_turbulence';
  if (riskName === 'file_collision') return 'sequence_flights';
  return null;
}

function confidenceForSignalStrength(signalStrength, sourceSignals) {
  const base = { strong: 0.86, moderate: 0.7, simulated: 0.52 }[signalStrength] || 0.5;
  const bonus = Math.min(0.1, (
    sourceSignals.importGraphEdges
    + sourceSignals.testOwners
    + sourceSignals.priorIncidents
    + sourceSignals.inspectionRuns
  ) / 200);
  return roundTo(Math.min(0.95, base + bonus), 2);
}

function strategySourceSignals(signals) {
  return {
    forecastRiskCount: signals.summary.forecastRiskCount,
    highRiskCount: signals.summary.highRiskCount,
    contractRiskCount: signals.summary.contractRiskCount,
    migrationRiskCount: signals.summary.migrationRiskCount,
    importGraphEdges: signals.summary.importGraphEdges,
    downstreamDependents: signals.summary.downstreamDependents,
    testOwners: signals.summary.testOwners,
    missingTestRoutes: signals.summary.missingTestRoutes,
    schemaOwners: signals.summary.schemaOwners,
    migrationLocks: signals.summary.migrationLocks,
    packageExports: signals.summary.packageExports,
    priorIncidents: signals.summary.priorIncidents,
    learnedPolicyDeltas: signals.summary.learnedPolicyDeltas,
    activeLeaseLocks: signals.summary.activeLeaseLocks,
    inspectionRuns: signals.summary.inspectionRuns,
    signalStrength: signals.summary.signalStrength,
  };
}

async function promotedPolicyDeltasForWorkspace(workspaceSlug) {
  const rows = await prisma.codeSitePolicyDelta.findMany({
    where: {
      project: { workspaceSlug },
      promotionState: { in: [...PROMOTED_POLICY_DELTA_STATES] },
      confidence: { gte: 0.65 },
    },
    orderBy: [{ promotedAt: 'desc' }, { createdAt: 'desc' }],
    take: 50,
  });
  return rows.map(normalizeLearnedPolicyDelta).filter(Boolean);
}

function normalizeLearnedPolicyDelta(delta) {
  if (!delta) return null;
  const projection = delta.ruleCandidate ? delta : policyDeltaProjection(delta);
  const promotionState = String(projection.promotionState || '').toLowerCase();
  const confidence = Number(projection.confidence || 0);
  if (!PROMOTED_POLICY_DELTA_STATES.has(promotionState) || confidence < 0.65) return null;
  return {
    id: projection.id,
    projectId: projection.projectId,
    learnedFromIncidents: asArray(projection.learnedFromIncidents),
    affectedZoneKey: projection.affectedZoneKey || null,
    ruleCandidate: normalizePolicyDeltaRuleCandidate(projection.ruleCandidate || {}),
    triggerConditions: asArray(projection.triggerConditions),
    expectedRiskReduction: typeof projection.expectedRiskReduction === 'number' ? projection.expectedRiskReduction : 0.12,
    confidence,
    promotionState,
    replayRefs: asArray(projection.replayRefs),
  };
}

function learnedPolicyMemoryForStrategy(strategy, signals) {
  const memory = {
    riskDelta: 0,
    staleDelta: 0,
    costDelta: 0,
    priority: 0,
    reasonCodes: [],
    policyDeltaRefs: [],
  };
  for (const delta of asArray(signals.learnedPolicyDeltas)) {
    if (!learnedPolicyDeltaApplies(delta, signals)) continue;
    const policy = learnedPolicyStrategyPolicy(delta);
    if (!policy.preferredStrategies.length && !policy.avoidStrategies.length) continue;
    const confidence = clamp(Number(delta.confidence || 0.5), 0, 1);
    const riskReduction = clamp(Number(delta.expectedRiskReduction || 0.12), 0.02, 0.6) * confidence;
    if (policy.preferredStrategies.includes(strategy)) {
      memory.riskDelta -= riskReduction;
      memory.staleDelta -= Math.max(1, Math.round(confidence * 2));
      memory.costDelta -= Math.max(1, Math.round(confidence * 3));
      memory.priority += confidence;
      memory.reasonCodes.push('learned_policy_delta_preferred_strategy');
      memory.policyDeltaRefs.push(delta.id);
    }
    if (policy.avoidStrategies.includes(strategy)) {
      memory.riskDelta += riskReduction;
      memory.staleDelta += Math.max(1, Math.round(confidence * 2));
      memory.costDelta += Math.max(1, Math.round(confidence * 2));
      memory.priority -= confidence;
      memory.reasonCodes.push('learned_policy_delta_avoided_strategy');
      memory.policyDeltaRefs.push(delta.id);
    }
  }
  return {
    riskDelta: roundTo(memory.riskDelta, 3),
    staleDelta: memory.staleDelta,
    costDelta: memory.costDelta,
    priority: roundTo(memory.priority, 3),
    reasonCodes: unique([
      ...(memory.policyDeltaRefs.length ? ['counterfactual_policy_delta_applied'] : []),
      ...memory.reasonCodes,
    ]),
    policyDeltaRefs: unique(memory.policyDeltaRefs),
  };
}

function learnedPolicyStrategyPolicy(delta) {
  const candidate = delta.ruleCandidate || {};
  const explicitPreferred = unique([
    ...asArray(candidate.preferredStrategy || candidate.preferred_strategy || candidate.strategy),
    ...asArray(candidate.preferredStrategies || candidate.preferred_strategies),
  ].map(normalizeTowerStrategyName).filter(Boolean));
  const explicitAvoid = unique([
    ...asArray(candidate.avoidStrategy || candidate.avoid_strategy),
    ...asArray(candidate.avoidStrategies || candidate.avoid_strategies),
    ...asArray(candidate.blockedStrategies || candidate.blocked_strategies),
  ].map(normalizeTowerStrategyName).filter(Boolean));
  const fallbackPreferred = fallbackPreferredStrategiesForRule(candidate)
    .map(normalizeTowerStrategyName)
    .filter((strategy) => strategy && !explicitAvoid.includes(strategy));
  const preferredStrategies = unique([...explicitPreferred, ...fallbackPreferred]);
  const fallbackAvoid = fallbackAvoidStrategiesForRule(candidate)
    .map(normalizeTowerStrategyName)
    .filter((strategy) => strategy && !explicitPreferred.includes(strategy) && !preferredStrategies.includes(strategy));
  const avoidStrategies = unique([...explicitAvoid, ...fallbackAvoid]);
  return { preferredStrategies, avoidStrategies };
}

function fallbackPreferredStrategiesForRule(candidate = {}) {
  const text = learnedRuleText(candidate);
  if (/test[_ -]?first|require[_ -]?test[_ -]?owner|radar[_ -]?first/.test(text)) return ['test-first'];
  if (/single[_ -]?migration[_ -]?runway|single[_ -]?writer/.test(text)) return ['single-fullstack-agent'];
  if (/schema[_ -]?first|refresh[_ -]?downstream[_ -]?assumptions|contract/.test(text)) return ['schema-first'];
  return [];
}

function fallbackAvoidStrategiesForRule(candidate = {}) {
  const text = learnedRuleText(candidate);
  if (/hold[_ -]?parallel|avoid[_ -]?parallel|parallel.*contract|contract.*parallel/.test(text)) return ['frontend-backend-parallel'];
  if (/schema[_ -]?first|refresh[_ -]?downstream[_ -]?assumptions/.test(text)) return ['frontend-backend-parallel'];
  return [];
}

function learnedRuleText(candidate = {}) {
  return [
    candidate.rule,
    candidate.candidate,
    candidate.name,
    candidate.reason,
    candidate.rationale,
  ].map((value) => String(value || '').toLowerCase()).join(' ');
}

function learnedPolicyDeltaApplies(delta, signals) {
  const surface = learnedPolicySurface(signals);
  const affectedZoneKey = String(delta.affectedZoneKey || '').toLowerCase();
  if (affectedZoneKey && !surface.some((entry) => learnedSurfaceEntryMatches(entry, affectedZoneKey))) return false;
  const conditions = asArray(delta.triggerConditions);
  if (!conditions.length) return true;
  return conditions.every((condition) => learnedTriggerMatches(condition, surface));
}

function learnedTriggerMatches(condition, surface) {
  if (typeof condition === 'string') {
    const value = condition.toLowerCase();
    return surface.some((entry) => learnedSurfaceEntryMatches(entry, value));
  }
  if (!condition || typeof condition !== 'object') return true;
  const values = [
    condition.path,
    condition.route,
    condition.zone,
    condition.zoneKey,
    condition.zone_key,
    condition.risk,
    condition.domain,
    condition.packageName,
    condition.package_name,
  ].flatMap((value) => asArray(value)).map((value) => String(value || '').toLowerCase()).filter(Boolean);
  if (!values.length) return true;
  return values.every((value) => surface.some((entry) => learnedSurfaceEntryMatches(entry, value)));
}

function learnedSurfaceEntryMatches(entry, expected) {
  const entryText = String(entry || '').toLowerCase();
  const expectedText = String(expected || '').toLowerCase();
  if (!entryText || !expectedText) return false;
  if (entryText.includes(expectedText) || pathPatternsOverlap(entryText, expectedText)) return true;
  const entryAliases = learnedSurfaceAliases(entryText);
  const expectedAliases = learnedSurfaceAliases(expectedText);
  return entryAliases.some((alias) => expectedAliases.includes(alias));
}

function learnedSurfaceAliases(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s*\/\s*/g, '-')
    .replace(/[_\s]+/g, '-');
  const aliases = new Set([normalized]);
  if (/(semantic|contract|schema|openapi|prisma).*(collision|conflict|drift)|(collision|conflict|drift).*(semantic|contract|schema|openapi|prisma)/.test(normalized)) {
    aliases.add('semantic-collision');
    aliases.add('contract-collision');
  }
  return [...aliases].filter(Boolean);
}

function learnedPolicySurface(signals) {
  return unique([
    ...asArray(signals.footprints).flatMap((footprint) => [
      footprint.domain,
      ...asArray(footprint.route),
      ...asArray(footprint.routeFiles),
      ...asArray(footprint.schemaOwners),
      ...asArray(footprint.packageExports),
      ...asArray(footprint.zones).flatMap((zone) => [zone.zoneKey, zone.label, zone.class, ...asArray(zone.paths)]),
    ]),
    ...asArray(signals.forecast?.risks).flatMap((risk) => [risk.risk, risk.type, risk.conflictZone, risk.recommendedResolution?.action]),
    ...asArray(signals.migrationLocks),
    ...asArray(signals.packageExports),
  ].map((entry) => String(entry || '').toLowerCase()).filter(Boolean));
}

function applyCounterfactualPolicyHintsToForecast(forecast, learnedPolicyDeltas = [], signals = {}) {
  const applicable = asArray(learnedPolicyDeltas)
    .filter((delta) => learnedPolicyDeltaApplies(delta, signals))
    .map(counterfactualPolicyHint)
    .filter(Boolean);
  if (!applicable.length) return forecast;
  return {
    ...forecast,
    regretMemoryPolicyHints: applicable,
    risks: asArray(forecast.risks).map((risk) => {
      const riskSignals = {
        ...signals,
        forecast: { ...(signals.forecast || {}), risks: [risk] },
      };
      const riskHints = asArray(learnedPolicyDeltas)
        .filter((delta) => learnedPolicyDeltaApplies(delta, riskSignals))
        .map(counterfactualPolicyHint)
        .filter(Boolean);
      return riskHints.length
        ? { ...risk, regretMemoryPolicyHints: riskHints }
        : risk;
    }),
  };
}

function counterfactualPolicyHint(delta) {
  if (!delta?.id) return null;
  const candidate = delta.ruleCandidate || {};
  return {
    policyDeltaId: delta.id,
    learnedFromIncidents: delta.learnedFromIncidents,
    affectedZoneKey: delta.affectedZoneKey,
    rule: candidate.rule || 'counterfactual_policy_delta',
    triggerConditions: delta.triggerConditions,
    expectedRiskReduction: delta.expectedRiskReduction,
    confidence: delta.confidence,
    promotionState: delta.promotionState,
    requiredTowerActions: asArray(candidate.requiredTowerActions || candidate.required_tower_actions || candidate.actions),
    preferredStrategies: asArray(candidate.preferredStrategies || candidate.preferred_strategies),
    avoidStrategies: asArray(candidate.avoidStrategies || candidate.avoid_strategies),
  };
}

function buildTowerPolicyDeltaCandidates(signals, selected) {
  const candidates = [];
  if (signals.summary.missingTestRoutes > 0) {
    candidates.push({
      rule: 'require_test_owner_for_mutation_route',
      affectedRoutes: signals.missingTestRoutes.slice(0, 8),
      expectedRiskReduction: 0.18,
      confidence: 0.72,
    });
  }
  if (signals.summary.migrationLocks > 0) {
    candidates.push({
      rule: 'single_migration_runway_lock',
      affectedRoutes: signals.migrationLocks.slice(0, 8),
      expectedRiskReduction: 0.24,
      confidence: 0.82,
    });
  }
  if (signals.summary.priorIncidents > 0 && selected?.predictedCollisionRisk > 0.28) {
    candidates.push({
      rule: 'incident_weighted_preflight_hold',
      affectedIncidents: signals.priorIncidents.map((incident) => incident.id).filter(Boolean).slice(0, 8),
      expectedRiskReduction: 0.16,
      confidence: 0.68,
    });
  }
  return candidates;
}

function towerIncidentSignal(incident = {}) {
  return {
    id: incident.id,
    severity: incident.severity || 'medium',
    category: incident.category || 'near_miss',
    participants: parseJson(incident.participantsJson, incident.participants || []),
    affectedZones: normalizePathList(parseJson(incident.affectedZonesJson, incident.affectedZones || [])),
    evidenceRefs: parseJson(incident.evidenceRefsJson, incident.evidenceRefs || []),
  };
}

function towerInspectionSignal(run = {}) {
  return {
    id: run.id,
    status: run.status || 'pending',
    changedPaths: normalizePathList(parseJson(run.changedPathsJson, run.changedPaths || [])),
    inspectionSignals: parseJson(run.inspectionSignalsJson, run.inspectionSignals || []),
    evidenceRefs: parseJson(run.evidenceRefsJson, run.evidenceRefs || []),
  };
}

function sourceSignalStrength({ semanticGraph, priorIncidents, inspectionRuns }) {
  const signalCount = [
    asArray(semanticGraph.importEdges).length,
    asArray(semanticGraph.testOwnership).length,
    asArray(semanticGraph.migrationLocks).length,
    asArray(semanticGraph.packageExports).length,
    asArray(priorIncidents).length,
    asArray(inspectionRuns).length,
  ].filter(Boolean).length;
  if (signalCount >= 4) return 'strong';
  if (signalCount >= 2) return 'moderate';
  return 'simulated';
}

function isSchemaSurface(pathValue) {
  return /(schema|prisma|openapi|packages\/schemas|package\.json|exports?)/i.test(String(pathValue || ''));
}

function towerPathsOverlap(left, right) {
  const leftPath = normalizePath(left);
  const rightPath = normalizePath(right);
  if (!leftPath || !rightPath) return false;
  if (leftPath === rightPath) return true;
  if (matchPathPattern(leftPath, rightPath) || matchPathPattern(rightPath, leftPath)) return true;
  const leftRoot = leftPath.split('*')[0].replace(/\/+$/, '');
  const rightRoot = rightPath.split('*')[0].replace(/\/+$/, '');
  return Boolean(leftRoot && rightRoot && (leftRoot.startsWith(rightRoot) || rightRoot.startsWith(leftRoot)));
}

function roundTo(value, places = 2) {
  const factor = 10 ** places;
  return Math.round(Number(value || 0) * factor) / factor;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export async function getLineProvenance(workspaceSlug, { projectId, filePath, lineAnchor, lineNumber } = {}, actor = null) {
  if (projectId) await requireProject(workspaceSlug, projectId, actor, 'read');
  const requestedLine = normalizeLineNumber(lineNumber);
  const baseWhere = {
    project: { workspaceSlug },
    ...(projectId ? { projectId } : {}),
    ...(filePath ? { filePath: normalizePath(filePath) || filePath } : {}),
    ...(lineAnchor ? { lineAnchor } : {}),
  };
  const include = {
    transaction: {
      include: {
        mutationLease: {
          include: { agentSession: true },
        },
        agentSession: true,
        proofBundles: true,
      },
    },
  };
  if (requestedLine) {
    const [rangedRows, legacyRows] = await Promise.all([
      prisma.codeSiteLineProvenance.findMany({
        where: {
          ...baseWhere,
          startLine: { lte: requestedLine },
          OR: [
            { endLine: { gte: requestedLine } },
            { endLine: null },
          ],
        },
        include,
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      prisma.codeSiteLineProvenance.findMany({
        where: {
          ...baseWhere,
          startLine: null,
        },
        include,
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
    ]);
    return uniqueById([...rangedRows, ...legacyRows])
      .map(lineProvenanceProjection)
      .filter((row) => lineProvenanceIncludesLine(row, requestedLine))
      .slice(0, 50);
  }
  const rows = await prisma.codeSiteLineProvenance.findMany({
    where: baseWhere,
    include,
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return rows.map(lineProvenanceProjection);
}

export async function getProofBundle(workspaceSlug, bundleId, actor = null) {
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
  await requireProjectAccess(bundle.project, actor, 'read');
  const incidents = (await prisma.codeSiteIncident.findMany({
    where: { projectId: bundle.projectId },
    orderBy: { createdAt: 'asc' },
  })).filter((incident) => incidentReferencesProofBundle(incident, bundle));
  const lineProvenance = await prisma.codeSiteLineProvenance.findMany({
    where: { proofBundleId: bundle.id },
    orderBy: { createdAt: 'asc' },
  });
  const landingRuns = await prisma.codeSiteInspectionRun.findMany({
    where: {
      projectId: bundle.projectId,
      ...(bundle.transaction?.mutationLease?.executionPlanId ? { executionPlanId: bundle.transaction.mutationLease.executionPlanId } : {}),
    },
    orderBy: [{ completedAt: 'asc' }, { requestedAt: 'asc' }],
  });
  const projection = proofBundleProjection(bundle, {
    transaction: bundle.transaction,
    mutationLease: bundle.transaction?.mutationLease,
    landingRuns,
  });
  const portableProofBundle = buildPortableProofBundle({
    project: projectProjection(bundle.project),
    transaction: transactionProjection(bundle.transaction),
    mutationLease: bundle.transaction?.mutationLease ? mutationLeaseProjection(bundle.transaction.mutationLease) : null,
    proofBundle: projection,
    incidents: incidents.map(incidentProjection),
    landingRuns: landingRuns.map(inspectionProjection),
    lineProvenance: lineProvenance.map(lineProvenanceProjection),
  });
  return {
    ...proofBundleProjection(bundle, {
      transaction: bundle.transaction,
      mutationLease: bundle.transaction?.mutationLease,
      landingRuns,
      portableProofBundle,
    }),
    portableProofBundle,
  };
}

export async function attachProofBundleCommit(workspaceSlug, bundleId, body = {}, actor = null) {
  const bundle = await prisma.codeSiteProofBundle.findFirst({
    where: { id: bundleId, project: { workspaceSlug } },
    include: {
      project: true,
      transaction: {
        include: {
          agentSession: true,
          mutationLease: true,
        },
      },
    },
  });
  if (!bundle) throw notFound('proof_bundle_not_found');
  requireTransactionActorAccess(bundle.transaction, actor);

  const commitSha = normalizeGitCommitSha(body.commitSha || body.commit_sha || body.sha);
  if (!commitSha) throw badRequest('git_commit_sha_required');
  const commitMessage = normalizeCommitMessage(
    body.commitMessage
      || body.commit_message
      || body.gitCommitMessage
      || body.git_commit_message
      || body.gitCommit?.message
      || body.git_commit?.message,
  );
  const suppliedTrailers = commitMessage
    ? normalizeCommitTrailers(commitMessage)
    : normalizeCommitTrailers(body.trailers || body.commitTrailers || body.commit_trailers);
  const trailerSource = commitMessage ? 'git_commit_message' : 'supplied_commit_trailers';
  const portableContext = await loadProofBundlePortableContext(bundle);
  const expectedTrailers = proofBundleProjection(bundle, {
    transaction: bundle.transaction,
    mutationLease: bundle.transaction?.mutationLease,
    ...portableContext,
  }).trailers;
  const mismatchedTrailers = Object.entries(expectedTrailers)
    .filter(([, value]) => value != null && value !== '')
    .filter(([key, value]) => suppliedTrailers[key] !== String(value))
    .map(([key, value]) => ({ key, expected: String(value), actual: suppliedTrailers[key] || null }));
  if (mismatchedTrailers.length > 0) {
    throw badRequest('proof_bundle_commit_trailers_mismatch', { mismatchedTrailers });
  }

  const trailerDigest = digest(suppliedTrailers);
  const commitMessageDigest = commitMessage ? digest(commitMessage) : null;
  const commitEvidenceRefs = unique([
    `git:commit:${commitSha}`,
    `git:trailers:${trailerDigest}`,
    ...(commitMessageDigest ? [`git:commit-message:${commitMessageDigest}`] : []),
    ...asArray(body.evidenceRefs || body.evidence_refs),
  ]);
  const updated = await prisma.codeSiteProofBundle.update({
    where: { id: bundle.id },
    data: {
      commitSha,
    },
    include: {
      project: true,
      transaction: {
        include: {
          agentSession: true,
          mutationLease: true,
        },
      },
    },
  });
  await recordEvent(bundle.projectId, {
    mutationLeaseId: bundle.transaction?.mutationLeaseId || null,
    eventType: 'inspection_result',
    displayCallsign: bundle.transaction?.mutationLease?.displayCallsign || null,
    actorType: 'proof_bundle',
    actorId: bundle.id,
    evidenceRefs: commitEvidenceRefs,
    details: {
      type: 'proof_bundle_commit_attached',
      proofBundleId: bundle.id,
      transactionId: bundle.transactionId,
      commitSha,
      trailerDigest,
      trailerSource,
      commitMessageDigest,
      evidenceRefs: commitEvidenceRefs,
      reasonCodes: trailerSource === 'git_commit_message'
        ? ['proof_bundle_actual_commit_trailers_verified']
        : ['proof_bundle_commit_trailers_verified'],
    },
  });
  return proofBundleProjection(updated, {
    transaction: updated.transaction,
    mutationLease: updated.transaction?.mutationLease,
    ...portableContext,
  });
}

function normalizeCommitMessage(value) {
  const text = String(value || '').trim();
  return text ? text : null;
}

function normalizeGitCommitSha(value) {
  const sha = String(value || '').trim();
  return /^[0-9a-f]{7,64}$/i.test(sha) ? sha : null;
}

function normalizeCommitTrailers(input) {
  if (typeof input === 'string') {
    return Object.fromEntries(input.split(/\r?\n/)
      .map((line) => line.match(/^([A-Za-z0-9-]+):\s*(.*)$/))
      .filter(Boolean)
      .map((match) => [match[1], match[2]]));
  }
  if (!input || typeof input !== 'object') return {};
  return Object.fromEntries(Object.entries(input)
    .filter(([key, value]) => key && value != null && value !== '')
    .map(([key, value]) => [key, String(value)]));
}

export async function getIncidentReplay(workspaceSlug, incidentId, actor = null) {
  const incident = await prisma.codeSiteIncident.findFirst({
    where: { id: incidentId, project: { workspaceSlug } },
    include: { project: { include: { events: { orderBy: EVENT_ORDER_BY } } } },
  });
  if (!incident) throw notFound('incident_not_found');
  await requireProjectAccess(incident.project, actor, 'read');
  const projectedIncident = incidentProjection(incident);
  const timeline = incidentReplayTimeline(projectedIncident, incident.project.events.map(eventProjection));
  const replay = projectedIncident.incidentReplay;
  return {
    incident: projectedIncident,
    replay,
    blackBox: replay,
    timeline,
    completeness: replay?.completeness || incidentReplayCompleteness(timeline.map((entry) => entry.event).filter(Boolean)),
    replayDigest: projectedIncident.replayDigest || digest(replay || timeline),
  };
}

function incidentReplayTimeline(incident, events) {
  const causalEvents = asArray(incident.incidentReplay?.causalEvents);
  if (causalEvents.length) {
    return [
      ...causalEvents.map((event, index) => ({
        sequence: index + 1,
        source: 'incident_replay',
        event,
      })),
      {
        sequence: causalEvents.length + 1,
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
    event: normalizeIncidentReplayEvent(event),
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
  return recordEventWithClient(prisma, projectId, input);
}

async function recordEventWithClient(db, projectId, input, options = {}) {
  const eventType = validateCodeSiteEventType(input.eventType);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const logicalTime = await db.codeSiteEvent.count({ where: { projectId } });
    try {
      const event = await db.codeSiteEvent.create({
        data: {
          ...(input.id ? { id: input.id } : {}),
          projectId,
          mutationLeaseId: input.mutationLeaseId || null,
          eventType,
          displayCallsign: input.displayCallsign || null,
          actorType: input.actorType || null,
          actorId: input.actorId || null,
          detailsJson: stringifyJson(input.details || {}),
          evidenceRefsJson: stringifyJson(input.evidenceRefs || []),
          logicalTime: logicalTime + 1,
        },
      });
      if (options.syncArtifacts !== false) {
        await syncArtifactsForProject(projectId, { reason: 'event_recorded', eventId: event.id });
      }
      return event;
    } catch (error) {
      if (!isLogicalTimeConflict(error)) throw error;
    }
  }
  throw new Error('codesite_event_logical_time_conflict');
}

async function syncArtifactsForProject(projectId, context = {}) {
  if (!context.force && !autoArtifactSyncEnabled()) return null;
  try {
    const project = await prisma.codeSiteProject.findUnique({
      where: { id: projectId },
      include: PROJECT_INCLUDE,
    });
    if (!project) return null;
    const projection = artifactProjectProjection(project);
    const controlState = buildControlState(project.workspaceSlug, projection);
    const result = await writeArtifactProjection(projection, controlState);
    return {
      eventId: context.eventId || null,
      reason: context.reason || null,
      ...result,
    };
  } catch (error) {
    console.warn('[CodeSite] artifact auto-sync failed', {
      projectId,
      eventId: context.eventId || null,
      reason: context.reason || null,
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

async function requireProject(workspaceSlug, projectId, actor = null, mode = 'read') {
  const project = await prisma.codeSiteProject.findFirst({
    where: { id: projectId, workspaceSlug },
    include: {
      members: true,
      agentSessions: true,
    },
  });
  if (!project) throw notFound('project_not_found');
  return requireProjectAccess(project, actor, mode);
}

async function requireAgentSession(projectId, agentSessionId) {
  if (!agentSessionId) throw badRequest('agent_session_required');
  const session = await prisma.codeSiteAgentSession.findFirst({ where: { id: agentSessionId, projectId } });
  if (!session) throw notFound('agent_session_not_found');
  return session;
}

async function requireDocument(projectId, documentId) {
  if (!documentId) throw badRequest('document_required');
  const document = await prisma.codeSiteDocument.findFirst({ where: { id: documentId, projectId } });
  if (!document) throw notFound('document_not_found');
  return document;
}

async function requireRouteRevision(workspaceSlug, routeRevisionId, actor = null, mode = 'read') {
  if (!routeRevisionId) throw badRequest('route_revision_required');
  const revision = await prisma.codeSiteRouteRevision.findFirst({
    where: { id: routeRevisionId, project: { workspaceSlug } },
    include: {
      project: { include: { members: true, agentSessions: true } },
      executionPlan: true,
      document: true,
    },
  });
  if (!revision) throw notFound('route_revision_not_found');
  await requireProjectAccess(revision.project, actor, mode);
  return revision;
}

async function requireLease(workspaceSlug, mutationLeaseId) {
  const lease = await prisma.codeSiteMutationLease.findFirst({
    where: { id: mutationLeaseId, project: { workspaceSlug } },
    include: { agentSession: true },
  });
  if (!lease) throw notFound('mutation_lease_not_found');
  return lease;
}

async function requireTransaction(workspaceSlug, transactionId, actor = null, db = prisma) {
  const transaction = await db.codeSiteMutationTransaction.findFirst({
    where: { id: transactionId, project: { workspaceSlug } },
    include: { project: true, mutationLease: true, agentSession: true },
  });
  if (!transaction) throw notFound('transaction_not_found');
  requireTransactionActorAccess(transaction, actor);
  return transaction;
}

async function requireOpenTransaction(workspaceSlug, transactionId, actor = null) {
  const transaction = await requireTransaction(workspaceSlug, transactionId, actor);
  if (transaction.status !== 'open') {
    throw badRequest('transaction_not_open', {
      transactionId: transaction.id,
      status: transaction.status,
    });
  }
  return transaction;
}

function requireTransactionActorAccess(transaction, actor = null) {
  if (!actor || actor.bypass) return;
  const ownerUserId = transaction.agentSession?.ownerUserId;
  if (!actor.userId || !ownerUserId || ownerUserId !== actor.userId) {
    throw forbidden('transaction_actor_mismatch', {
      transactionId: transaction.id,
      agentSessionId: transaction.agentSessionId,
      actorUserId: actor.userId || null,
    });
  }
}

function requireActorOwnsUserId(ownerUserId, actor = null, code = 'agent_owner_forbidden') {
  if (!actor || actor.bypass) return;
  if (!actor.userId || !ownerUserId || actor.userId !== ownerUserId) {
    throw forbidden(code, {
      ownerUserId: ownerUserId || null,
      actorUserId: actor.userId || null,
    });
  }
}

function requireAgentSessionOwnerAccess(session, actor = null, code = 'agent_session_owner_forbidden') {
  requireActorOwnsUserId(session?.ownerUserId, actor, code);
}

function requireLeaseActorAccess(lease, actor = null) {
  if (!actor || actor.bypass) return;
  const ownerUserId = lease.agentSession?.ownerUserId;
  if (!actor.userId || !ownerUserId || ownerUserId !== actor.userId) {
    throw forbidden('mutation_lease_actor_mismatch', {
      mutationLeaseId: lease.id,
      agentSessionId: lease.agentSessionId,
      actorUserId: actor.userId || null,
    });
  }
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

function conflict(code, detail) {
  const error = new Error(code);
  error.status = 409;
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

function serviceUnavailable(code, detail) {
  const error = new Error(code);
  error.status = 503;
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

function uniqueById(rows) {
  const seen = new Set();
  return asArray(rows).filter((row) => {
    const key = row?.id || stableJson(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function projectSummary(project) {
  return {
    id: project.id,
    workspaceSlug: project.workspaceSlug,
    collaborationSessionId: project.collaborationSessionId || null,
    title: project.title,
    request: project.request,
    status: project.status,
    // Coordination mode surfaced so agents and UI can see the guarantees.
    channelMode: project.channelMode || 'registered_direct',
    createdByUserId: project.createdByUserId,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    counts: {
      members: project.members?.filter((member) => !member.revokedAt)?.length || 0,
      agentSessions: project.agentSessions?.length || 0,
      executionPlans: project.executionPlans?.length || 0,
      mutationLeases: project.mutationLeases?.length || 0,
      incidents: project.incidents?.length || 0,
      inspectionRuns: project.inspectionRuns?.length || 0,
      permits: project.permits?.length || 0,
      documentReviews: project.documentReviews?.length || 0,
      routeRevisions: project.routeRevisions?.length || 0,
    },
  };
}

function projectProjection(project) {
  const projectionNow = Date.now();
  const mutationTxns = asArray(project.mutationTxns);
  const mutationLeases = asArray(project.mutationLeases);
  const inspectionRuns = asArray(project.inspectionRuns);
  const incidents = asArray(project.incidents);
  const lineProvenance = asArray(project.lineProvenance);
  return {
    ...projectSummary(project),
    zonePolicy: parseJson(project.zonePolicyJson, {}),
    controlPlan: parseJson(project.controlPlanJson, {}),
    members: asArray(project.members).map(projectMembershipProjection),
    agentSessions: asArray(project.agentSessions).map(sessionProjection),
    agentRegistry: asArray(project.agentSessions).map((session) => agentRegistryProjection(session, projectionNow)),
    executionPlans: asArray(project.executionPlans).map(executionPlanProjection),
    mutationLeases: mutationLeases.map(mutationLeaseProjection),
    mutationTxns: mutationTxns.map(transactionProjection),
    assumptions: asArray(project.assumptions).map(assumptionProjection),
    policyDecisions: asArray(project.policyDecisions).map(policyDecisionProjection),
    events: asArray(project.events).map(eventProjection),
    incidents: asArray(project.incidents).map(incidentProjection),
    inspectionRuns: inspectionRuns.map(inspectionProjection),
    proofBundles: asArray(project.proofBundles).map((bundle) => {
      const transaction = mutationTxns.find((item) => item.id === bundle.transactionId) || null;
      const mutationLease = mutationLeases.find((item) => item.id === transaction?.mutationLeaseId) || null;
      const landingRuns = inspectionRuns.filter((run) => (
        mutationLease?.executionPlanId
          ? run.executionPlanId === mutationLease.executionPlanId
          : run.displayCallsign === mutationLease?.displayCallsign
      ));
      const bundleIncidents = incidents.filter((incident) => incidentReferencesProofBundle(incident, bundle));
      const bundleLineProvenance = lineProvenance.filter((row) => row.proofBundleId === bundle.id);
      return proofBundleProjection(bundle, {
        transaction,
        mutationLease,
        landingRuns,
        incidents: bundleIncidents,
        lineProvenance: bundleLineProvenance,
        portableProofBundle: proofBundlePortable(bundle, {
          project,
          transaction,
          mutationLease,
          landingRuns,
          incidents: bundleIncidents,
          lineProvenance: bundleLineProvenance,
        }),
      });
    }),
    lineProvenance: asArray(project.lineProvenance).map(lineProvenanceProjection),
    documents: asArray(project.documents).map(documentSummaryProjection),
    permits: asArray(project.permits).map(permitProjection),
    documentReviews: asArray(project.documentReviews).map(documentReviewProjection),
    routeRevisions: asArray(project.routeRevisions).map(routeRevisionProjection),
    counterfactualRuns: asArray(project.counterfactualRuns).map(counterfactualProjection),
    policyDeltas: asArray(project.policyDeltas).map(policyDeltaProjection),
    inboxItems: asArray(project.inboxItems).map(inboxSummaryProjection),
  };
}

function agentPresence(session, now = Date.now()) {
  if (session.endedAt) return { presence: 'ended', reason: 'session_ended' };
  if (session.status === 'detached' || session.detachedAt) return { presence: 'offline', reason: 'session_detached' };
  if (session.status !== 'attached') return { presence: 'offline', reason: 'session_not_attached' };
  const heartbeatAt = session.lastHeartbeatAt ? new Date(session.lastHeartbeatAt).getTime() : Number.NaN;
  if (!Number.isFinite(heartbeatAt)) return { presence: 'offline', reason: 'heartbeat_missing' };
  return now - heartbeatAt <= AGENT_CONTEXT_HEARTBEAT_MAX_AGE_MS
    ? { presence: 'online', reason: 'heartbeat_fresh' }
    : { presence: 'offline', reason: 'heartbeat_stale' };
}

function agentRegistryProjection(session, now = Date.now()) {
  const presence = agentPresence(session, now);
  return {
    id: session.id,
    displayCallsign: session.displayCallsign,
    provider: session.agentProvider,
    ownerUserId: session.ownerUserId,
    collaborationUserId: session.collaborationUserId || null,
    terminalSessionId: session.terminalSessionId || null,
    runtimeSessionId: session.runtimeSessionId || null,
    executionHost: parseJson(session.executionHostJson, {}),
    subscriptions: parseJson(session.subscriptionsJson, []),
    providerSessionBound: Boolean(session.providerSessionRef),
    presence: presence.presence,
    presenceReason: presence.reason,
    status: session.status,
    lastHeartbeatAt: session.lastHeartbeatAt || null,
    attachedAt: session.attachedAt || null,
    detachedAt: session.detachedAt || null,
    endedAt: session.endedAt || null,
  };
}

function artifactProjectProjection(project) {
  return {
    ...projectProjection(project),
    inboxItems: asArray(project.inboxItems).map(inboxProjection),
  };
}

function sessionProjection(session) {
  return {
    id: session.id,
    projectId: session.projectId,
    ownerUserId: session.ownerUserId,
    workspaceSlug: session.workspaceSlug || null,
    collaborationUserId: session.collaborationUserId || null,
    effectiveWorkspaceUserId: session.effectiveWorkspaceUserId || null,
    collaborationSessionId: session.collaborationSessionId || null,
    terminalSessionId: session.terminalSessionId || null,
    runtimeSessionId: session.runtimeSessionId || null,
    runtimeScope: session.runtimeScope || null,
    agentProvider: session.agentProvider,
    agentRuntime: session.agentRuntime,
    providerSessionBound: Boolean(session.providerSessionRef),
    displayCallsign: session.displayCallsign,
    status: session.status,
    permissions: parseJson(session.permissionsJson, []),
    redactionPolicy: parseJson(session.redactionPolicyJson, {}),
    capabilities: parseJson(session.capabilitiesJson, parseJson(session.permissionsJson, [])),
    executionHost: parseJson(session.executionHostJson, {}),
    subscriptions: parseJson(session.subscriptionsJson, []),
    deliveryChannel: parseJson(session.deliveryChannelJson, {}),
    attachSource: session.attachSource || null,
    bindingVersion: session.bindingVersion || null,
    agentAccessTokenExpiresAt: session.agentAccessTokenExpiresAt || null,
    activeMutationLeaseId: session.activeMutationLeaseId || null,
    activeTransactionId: session.activeTransactionId || null,
    dojoPilotLicenseRef: session.dojoPilotLicenseRef || null,
    dojoProofRef: session.dojoProofRef || null,
    dojoEvidenceRefs: parseJson(session.dojoEvidenceRefsJson, []),
    dojoDecisionDigest: session.dojoDecisionDigest || null,
    pilotLicenseSnapshot: parseJson(session.pilotLicenseSnapshotJson, null),
    attachedAt: session.attachedAt || null,
    lastHeartbeatAt: session.lastHeartbeatAt || null,
    detachedAt: session.detachedAt || null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt || session.createdAt,
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
  const leaseBody = parseJson(lease.leaseJson, {});
  return {
    id: lease.id,
    projectId: lease.projectId,
    executionPlanId: lease.executionPlanId,
    agentSessionId: lease.agentSessionId,
    displayCallsign: lease.displayCallsign,
    status: lease.status,
    lease: leaseBody,
    pilotLicenseHealth: leaseBody.pilotLicenseHealth || null,
    pilotLicenseRequirement: leaseBody.pilotLicenseRequirement || null,
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

function leaseAuthorityAllowedPaths(lease = {}) {
  const body = lease.lease || parseJson(lease.leaseJson, {});
  return pathsForRoute([
    ...asArray(body.allowedPaths || body.allowed_paths),
    ...asArray(body.route),
  ]);
}

function leaseAuthorityBlockedPaths(lease = {}) {
  const body = lease.lease || parseJson(lease.leaseJson, {});
  return pathsForRoute([
    ...asArray(body.blockedPaths || body.blocked_paths),
    ...asArray(body.noFlyZones || body.no_fly_zones),
  ]);
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

function activeTransactionProjection(transaction) {
  const projected = transactionProjection(transaction);
  const lease = transaction.mutationLease ? mutationLeaseProjection(transaction.mutationLease) : null;
  return {
    ...projected,
    transactionId: transaction.id,
    workspaceSlug: transaction.project?.workspaceSlug || null,
    mutationLeaseId: transaction.mutationLeaseId,
    agentSessionId: transaction.agentSessionId,
    executionPlanId: transaction.mutationLease?.executionPlanId || null,
    actorUserId: transaction.agentSession?.ownerUserId || null,
    effectiveUserId: transaction.agentSession?.ownerUserId || null,
    displayCallsign: transaction.mutationLease?.displayCallsign || transaction.agentSession?.displayCallsign || null,
    lease: lease?.lease || null,
    allowedPaths: lease ? leaseAuthorityAllowedPaths(lease) : [],
    blockedPaths: lease ? leaseAuthorityBlockedPaths(lease) : [],
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

function proofBundleCoreProjection(bundle, context = {}) {
  const transaction = context.transaction || bundle.transaction || null;
  const mutationLease = context.mutationLease || transaction?.mutationLease || null;
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
    baseSnapshot: transaction?.baseSnapshot || null,
    baseSnapshotEvidence: transaction ? parseJson(transaction.baseSnapshotEvidenceJson, null) : null,
    incidentReplayDigest: bundle.incidentReplayDigest,
    landingStatus: bundle.landingStatus || context.landingStatus || null,
    bundleDigest: bundle.bundleDigest,
    proofSignature: parseJson(bundle.proofSignatureJson, null),
    signatureKeyId: bundle.signatureKeyId || null,
    createdAt: bundle.createdAt,
  };
}

function proofBundleProjectIdentity(project, projectId = null) {
  return {
    id: project?.id || projectId || null,
    workspaceSlug: project?.workspaceSlug || null,
  };
}

function proofBundlePortable(bundle, context = {}) {
  const transaction = context.transaction || bundle.transaction || null;
  const mutationLease = context.mutationLease || transaction?.mutationLease || null;
  const project = context.project || bundle.project || transaction?.project || null;
  const projection = proofBundleCoreProjection(bundle, context);
  return buildPortableProofBundle({
    project: proofBundleProjectIdentity(project, bundle.projectId),
    transaction: transaction
      ? transactionProjection(transaction)
      : {
        id: bundle.transactionId,
        projectId: bundle.projectId,
        mutationLeaseId: null,
      },
    mutationLease: mutationLease ? mutationLeaseProjection(mutationLease) : null,
    proofBundle: projection,
    incidents: asArray(context.incidents).map((incident) => (
      incident?.participantsJson != null ? incidentProjection(incident) : incident
    )),
    landingRuns: asArray(context.landingRuns).map((run) => (
      run?.changedPathsJson != null ? inspectionProjection(run) : run
    )),
    lineProvenance: asArray(context.lineProvenance).map((row) => (
      row?.evidenceRefsJson != null ? lineProvenanceProjection(row) : row
    )),
  });
}

async function loadProofBundlePortableContext(bundle, db = prisma) {
  const transaction = bundle.transaction || null;
  const mutationLease = transaction?.mutationLease || null;
  const [incidents, lineProvenance, landingRuns] = await Promise.all([
    db.codeSiteIncident.findMany({
      where: { projectId: bundle.projectId },
      orderBy: { createdAt: 'asc' },
    }).then((incidents) => incidents.filter((incident) => incidentReferencesProofBundle(incident, bundle))),
    db.codeSiteLineProvenance.findMany({
      where: { proofBundleId: bundle.id },
      orderBy: { createdAt: 'asc' },
    }),
    db.codeSiteInspectionRun.findMany({
      where: {
        projectId: bundle.projectId,
        ...(mutationLease?.executionPlanId ? { executionPlanId: mutationLease.executionPlanId } : {}),
      },
      orderBy: [{ completedAt: 'asc' }, { requestedAt: 'asc' }],
    }),
  ]);
  const context = {
    project: bundle.project || transaction?.project || null,
    transaction,
    mutationLease,
    incidents,
    landingRuns,
    lineProvenance,
  };
  return {
    ...context,
    portableProofBundle: proofBundlePortable(bundle, context),
  };
}

function proofBundleProjection(bundle, context = {}) {
  const transaction = context.transaction || bundle.transaction || null;
  const mutationLease = context.mutationLease || transaction?.mutationLease || null;
  const projection = proofBundleCoreProjection(bundle, context);
  const portable = context.portableProofBundle || buildPortableProofBundle({
    project: proofBundleProjectIdentity(bundle.project, bundle.projectId),
    transaction: transaction
      ? transactionProjection(transaction)
      : {
        id: bundle.transactionId,
        projectId: bundle.projectId,
        mutationLeaseId: bundle.transaction?.mutationLeaseId || null,
      },
    mutationLease: mutationLease ? mutationLeaseProjection(mutationLease) : null,
    proofBundle: projection,
    landingRuns: asArray(context.landingRuns).map((run) => (
      run?.changedPathsJson ? inspectionProjection(run) : run
    )),
  });
  return {
    ...projection,
    portableDigest: portable.portableDigest || null,
    trailers: proofCommitTrailers(portable),
  };
}

function lineProvenanceProjection(row) {
  const anchorRange = parsedLineRange(row.lineAnchor);
  const startLine = row.startLine || anchorRange.startLine;
  const endLine = row.endLine || anchorRange.endLine;
  const transaction = row.transaction || null;
  const mutationLease = transaction?.mutationLease || null;
  const agentSession = transaction?.agentSession || mutationLease?.agentSession || null;
  return {
    id: row.id,
    projectId: row.projectId,
    transactionId: row.transactionId,
    filePath: row.filePath,
    lineAnchor: row.lineAnchor,
    startLine,
    endLine,
    displayCallsign: row.displayCallsign,
    reasonRef: row.reasonRef,
    evidenceRefs: parseJson(row.evidenceRefsJson, []),
    dojoSourceRefs: parseJson(row.dojoSourceRefsJson, []),
    proofBundleId: row.proofBundleId,
    processAncestry: parseJson(row.processAncestryJson, []),
    promptSummary: row.promptSummary,
    transaction: transaction ? transactionProjection(transaction) : null,
    mutationLease: mutationLease ? mutationLeaseProjection(mutationLease) : null,
    agentSession: agentSession ? sessionProjection(agentSession) : null,
    proofBundles: asArray(transaction?.proofBundles).map((bundle) => proofBundleProjection(bundle, {
      transaction,
      mutationLease,
    })),
    createdAt: row.createdAt,
  };
}

function normalizeLineNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : null;
}

function lineProvenanceIncludesLine(row, lineNumber) {
  const range = {
    startLine: row.startLine || parsedLineRange(row.lineAnchor).startLine,
    endLine: row.endLine || parsedLineRange(row.lineAnchor).endLine,
  };
  if (!range.startLine) return false;
  return lineNumber >= range.startLine && lineNumber <= (range.endLine || range.startLine);
}

function parsedLineRange(lineAnchor) {
  const match = String(lineAnchor || '').match(/#?L(\d+)(?:-L?(\d+))?/i);
  if (!match) return { startLine: null, endLine: null };
  const startLine = Math.max(1, Number(match[1]));
  const endLine = Math.max(startLine, Number(match[2] || match[1]));
  return { startLine, endLine };
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

function documentSummaryProjection(document) {
  return {
    id: document.id,
    projectId: document.projectId,
    kind: document.kind,
    status: document.status,
    title: document.title,
    blocking: document.blocking,
    createdAt: document.createdAt,
    resolvedAt: document.resolvedAt,
  };
}

function permitProjection(permit) {
  return {
    id: permit.id,
    projectId: permit.projectId,
    executionPlanId: permit.executionPlanId,
    mutationLeaseId: permit.mutationLeaseId,
    documentId: permit.documentId,
    permitType: permit.permitType,
    status: permit.status,
    title: permit.title,
    scope: parseJson(permit.scopeJson, {}),
    approval: parseJson(permit.approvalJson, {}),
    evidenceRefs: parseJson(permit.evidenceRefsJson, []),
    issuedByUserId: permit.issuedByUserId,
    issuedAt: permit.issuedAt,
    expiresAt: permit.expiresAt,
    closedAt: permit.closedAt,
  };
}

function documentReviewProjection(review) {
  return {
    id: review.id,
    projectId: review.projectId,
    documentId: review.documentId,
    reviewerUserId: review.reviewerUserId,
    status: review.status,
    decision: review.decision,
    reasonCodes: parseJson(review.reasonCodesJson, []),
    body: parseJson(review.bodyJson, {}),
    evidenceRefs: parseJson(review.evidenceRefsJson, []),
    requestedAt: review.requestedAt,
    reviewedAt: review.reviewedAt,
  };
}

function routeRevisionProjection(revision) {
  return {
    id: revision.id,
    projectId: revision.projectId,
    executionPlanId: revision.executionPlanId,
    documentId: revision.documentId,
    status: revision.status,
    previousRoute: parseJson(revision.previousRouteJson, []),
    proposedRoute: parseJson(revision.proposedRouteJson, []),
    affectedLeases: parseJson(revision.affectedLeasesJson, []),
    approval: parseJson(revision.approvalJson, {}),
    evidenceRefs: parseJson(revision.evidenceRefsJson, []),
    proposedByUserId: revision.proposedByUserId,
    approvedByUserId: revision.approvedByUserId,
    appliedAt: revision.appliedAt,
    createdAt: revision.createdAt,
    updatedAt: revision.updatedAt,
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
    knowledgeItemId: item.knowledgeItemId || null,
    kind: item.kind,
    requiresResponse: item.requiresResponse,
    status: item.status,
    redactedPayload: parseJson(item.redactedPayloadJson, {}),
    createdAt: item.createdAt,
    acknowledgedAt: item.acknowledgedAt,
    responseAction: item.responseAction || null,
    respondedAt: item.respondedAt || null,
  };
}

function inboxSummaryProjection(item) {
  return {
    id: item.id,
    projectId: item.projectId,
    agentSessionId: item.agentSessionId,
    eventId: item.eventId,
    documentId: item.documentId,
    knowledgeItemId: item.knowledgeItemId || null,
    kind: item.kind,
    requiresResponse: item.requiresResponse,
    status: item.status,
    payloadAvailable: Boolean(item.redactedPayloadJson),
    createdAt: item.createdAt,
    acknowledgedAt: item.acknowledgedAt,
    responseAction: item.responseAction || null,
    respondedAt: item.respondedAt || null,
  };
}

function counterfactualProjection(run) {
  const arbiterVerdict = parseJson(run.arbiterVerdictJson, null);
  return {
    id: run.id,
    projectId: run.projectId,
    shadowJobRef: run.shadowJobRef,
    baseSnapshot: run.baseSnapshot,
    universes: parseJson(run.universesJson, []),
    arbiterVerdict,
    // Unified forecast|executed discriminator (Workstream E): derived from the
    // persisted verdict when present, otherwise from validityStrength.
    resultKind: arbiterVerdict?.resultKind
      || ((run.validityStrength === 'executed') ? 'executed' : 'forecast'),
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

// ---------------------------------------------------------------------------
// Registered direct channels (docs/REGISTERED_DIRECT_CHANNELS_DESIGN.md)
// ---------------------------------------------------------------------------

function agentChannelProjection(channel) {
  return {
    id: channel.id,
    projectId: channel.projectId,
    workspaceSlug: channel.workspaceSlug,
    fromSessionId: channel.fromSessionId,
    toSessionId: channel.toSessionId,
    status: channel.status,
    purpose: channel.purpose || null,
    transport: channel.transport || null,
    fromEndpointRef: channel.fromEndpointRef || null,
    // The responder's endpoint is only revealed after acceptance â€” exposing
    // it is the responder's choice, made in /accept.
    toEndpointRef: channel.status === 'requested' ? null : (channel.toEndpointRef || null),
    maxDurationMs: channel.maxDurationMs ?? null,
    grantExpiresAt: channel.grantExpiresAt ?? null,
    openedAt: channel.openedAt ?? null,
    closedAt: channel.closedAt ?? null,
    summaryDigest: channel.summaryDigest || null,
    messageCount: channel.messageCount ?? 0,
    createdAt: channel.createdAt,
  };
}

async function recordChannelEvent(projectId, {
  eventType,
  actorType = 'agent_session',
  actorId = null,
  channelId = null,
  evidenceRefs = [],
  details = {},
}) {
  return recordEvent(projectId, {
    eventType,
    actorType,
    actorId,
    evidenceRefs: unique([...asArray(evidenceRefs)]),
    details: { channelId, ...details },
  });
}

/**
 * Initiate a registered direct channel. Gates (all fail-closed):
 * kill switch, project mode ladder, workspace floor, transport allowed by
 * mode, capability `codesite.channels.open` on BOTH sessions, liveness of
 * both sessions, self-pairing, duplicate active pair, per-session cap.
 */
export async function requestAgentChannel(workspaceSlug, sessionId, agentAccessToken, body = {}, options = {}) {
  if (channelsDisabled()) throw forbidden('codesite_channels_disabled');
  const authority = await requireAgentTokenAuthority(workspaceSlug, sessionId, agentAccessToken, {
    requiredCapability: 'codesite.channels.open',
    now: options.now,
  });
  const fromSession = authority.session;
  const toSessionId = String(body.toSessionId || body.to_session_id || '').trim();
  if (!toSessionId) throw badRequest('channel_target_required');
  if (toSessionId === fromSession.id) throw badRequest('channel_self_pairing_forbidden');
  const purpose = String(body.purpose || 'coordination').trim().slice(0, 256);
  const transport = String(body.transport || '').trim().toLowerCase();
  // Design Â§8: endpoints are advertised as ws:// or wss:// host:port refs.
  const rawEndpoint = String(body.endpointRef || body.endpoint_ref || '').trim();
  if (rawEndpoint && !/^wss?:\/\/[^\s]{1,500}$/.test(rawEndpoint)) {
    throw badRequest('channel_endpoint_invalid');
  }
  const endpointRef = rawEndpoint || null;

  const project = await prisma.codeSiteProject.findFirst({
    where: { id: fromSession.projectId, workspaceSlug },
  });
  if (!project) throw notFound('codesite_project_not_found');

  const modeCheck = effectiveChannelMode(project.channelMode);
  if (!modeCheck.ok) throw forbidden(modeCheck.reasonCode, modeCheck.detail);
  if (!modeTransports(modeCheck.mode).includes(transport)) {
    throw badRequest('channel_transport_not_allowed_in_mode', { mode: modeCheck.mode });
  }

  const toSession = await prisma.codeSiteAgentSession.findFirst({
    where: { id: toSessionId, projectId: fromSession.projectId, workspaceSlug, endedAt: null },
  });
  if (!toSession) throw notFound('agent_session_not_found');

  // Both sides must hold the channels capability; the initiator's was checked
  // by requireAgentTokenAuthority, the responder's is verified here.
  const toCapabilities = unique(asArray(parseJson(toSession.capabilitiesJson, []))
    .map((capability) => String(capability || '').trim())
    .filter(Boolean));
  if (!toCapabilities.includes('codesite.channels.open')) {
    throw forbidden('channel_responder_capability_missing', { requiredCapabilities: ['codesite.channels.open'] });
  }

  const existingActive = await prisma.codeSiteAgentChannel.findFirst({
    where: {
      projectId: project.id,
      status: 'active',
      OR: [
        { fromSessionId: fromSession.id, toSessionId: toSession.id },
        { fromSessionId: toSession.id, toSessionId: fromSession.id },
      ],
    },
  });
  if (existingActive) throw badRequest('channel_already_active', { channelId: existingActive.id });

  const activeCount = await prisma.codeSiteAgentChannel.count({
    where: {
      projectId: project.id,
      status: 'active',
      OR: [{ fromSessionId: fromSession.id }, { toSessionId: fromSession.id }],
    },
  });
  const maxActive = getCodeSiteRuntimeConfig().maxActiveChannels;
  if (activeCount >= maxActive) {
    throw forbidden('channel_concurrency_cap_reached', { activeCount, maxActive });
  }

  const durationMs = channelMaxDurationMs(body.maxDurationMs ?? body.max_duration_ms);
  const channel = await prisma.codeSiteAgentChannel.create({
    data: {
      projectId: project.id,
      workspaceSlug,
      fromSessionId: fromSession.id,
      toSessionId: toSession.id,
      status: 'requested',
      purpose,
      transport,
      fromEndpointRef: endpointRef,
      maxDurationMs: durationMs,
      grantExpiresAt: new Date(Date.now() + CHANNEL_GRANT_WINDOW_MS),
    },
  });
  // Design Â§7: the initiator receives its direction's token immediately â€”
  // frames it sends are keyed with this; the responder gets the other
  // direction's token only upon acceptance. Stored hash covers both.
  const initiatorToken = mintChannelToken();
  await prisma.codeSiteAgentChannel.update({
    where: { id: channel.id },
    // Both directions' token hashes are stored as `fromHash|toHash` (pipe â€”
    // a hex digest never contains one). The initiator's half is written now;
    // the responder's half replaces the toHalf slot at accept time. Either
    // side verifies its own token against its half via verifyChannelToken.
    data: {
      channelTokenHash: [
        hashChannelToken(initiatorToken),
        hashChannelToken(''),
      ].join('|'),
    },
  });
  await recordChannelEvent(project.id, {
    eventType: 'channel_requested',
    actorId: fromSession.id,
    channelId: channel.id,
    details: {
      toSessionId: toSession.id,
      transport,
      purpose,
      mode: modeCheck.mode,
    },
  });
  return { ...agentChannelProjection(channel), channelToken: initiatorToken };
}

/**
 * Design Â§7: tokens/channels expire at openedAt + maxDurationMs. Enforced
 * lazily whenever a channel is touched â€” an expired active channel is flipped
 * to 'expired' before any other logic runs.
 */
async function sweepExpiredChannel(channel) {
  if (
    channel?.status === 'active'
    && channel.openedAt
    && channel.maxDurationMs
    && Date.now() - new Date(channel.openedAt).getTime() > channel.maxDurationMs
  ) {
    const expired = await prisma.codeSiteAgentChannel.update({
      where: { id: channel.id },
      data: { status: 'expired', closedAt: new Date() },
    });
    await recordChannelEvent(channel.projectId, {
      eventType: 'channel_closed',
      actorId: null,
      channelId: channel.id,
      details: { reasonCode: 'channel_duration_expired' },
    });
    return expired;
  }
  return channel;
}

/**
 * Responder accepts a requested channel. Mints the channel token, stores only
 * its hash, and returns it once â€” inside this authenticated response. Also
 * records the responder's endpoint and activates the channel.
 */
export async function acceptAgentChannel(workspaceSlug, sessionId, agentAccessToken, channelId, body = {}, options = {}) {
  if (channelsDisabled()) throw forbidden('codesite_channels_disabled');
  const authority = await requireAgentTokenAuthority(workspaceSlug, sessionId, agentAccessToken, {
    requiredCapability: 'codesite.channels.open',
    now: options.now,
  });
  const session = authority.session;
  const found = await prisma.codeSiteAgentChannel.findFirst({
    where: { id: String(channelId || ''), workspaceSlug },
  });
  const channel = await sweepExpiredChannel(found);
  if (!channel) throw notFound('channel_not_found');
  if (channel.toSessionId !== session.id) throw forbidden('channel_responder_mismatch');
  if (channel.status !== 'requested') throw badRequest('channel_not_requestable', { status: channel.status });
  if (channel.grantExpiresAt && new Date(channel.grantExpiresAt).getTime() < Date.now()) {
    await prisma.codeSiteAgentChannel.update({
      where: { id: channel.id },
      data: { status: 'expired' },
    });
    throw badRequest('channel_grant_expired');
  }
  const endpointRef = String(body.endpointRef || body.endpoint_ref || '').trim() || null;
  const token = mintChannelToken();
  // Design Â§7: acceptance is single-shot. A conditional update makes a
  // concurrent double-accept lose deterministically instead of minting two
  // tokens with last-write-wins.
  const claim = await prisma.codeSiteAgentChannel.updateMany({
    where: { id: channel.id, status: 'requested' },
    data: {
      status: 'active',
      toEndpointRef: endpointRef,
      // Replace only the responder (toHalf) of `fromHash|toHash`, so the
      // initiator's request-time hash survives activation and both sides can
      // verify their own tokens via verifyChannelToken.
      channelTokenHash: [
        String(channel.channelTokenHash || `${hashChannelToken('')}|${hashChannelToken('')}`).split('|')[0],
        hashChannelToken(token),
      ].join('|'),
      openedAt: new Date(),
    },
  });
  if (claim.count !== 1) throw badRequest('channel_already_accepted');
  const updated = await prisma.codeSiteAgentChannel.findUnique({ where: { id: channel.id } });
  await recordChannelEvent(channel.projectId, {
    eventType: 'channel_accepted',
    actorId: session.id,
    channelId: channel.id,
    details: { fromSessionId: channel.fromSessionId, transport: channel.transport },
  });
  return { ...agentChannelProjection(updated), channelToken: token };
}

/** Responder declines a requested channel with an optional reason code. */
export async function rejectAgentChannel(workspaceSlug, sessionId, agentAccessToken, channelId, body = {}, options = {}) {
  const authority = await requireAgentTokenAuthority(workspaceSlug, sessionId, agentAccessToken, {
    requiredCapability: 'codesite.channels.open',
    now: options.now,
  });
  const session = authority.session;
  const channel = await prisma.codeSiteAgentChannel.findFirst({
    where: { id: String(channelId || ''), workspaceSlug },
  });
  if (!channel) throw notFound('channel_not_found');
  if (channel.toSessionId !== session.id) throw forbidden('channel_responder_mismatch');
  if (channel.status !== 'requested') throw badRequest('channel_not_requestable', { status: channel.status });
  const reasonCode = String(body.reasonCode || body.reason_code || 'declined').slice(0, 128);
  const updated = await prisma.codeSiteAgentChannel.update({
    where: { id: channel.id },
    data: { status: 'rejected' },
  });
  await recordChannelEvent(channel.projectId, {
    eventType: 'channel_rejected',
    actorId: session.id,
    channelId: channel.id,
    details: { fromSessionId: channel.fromSessionId, reasonCode },
  });
  return agentChannelProjection(updated);
}

/**
 * Close an active channel (either side). Records the transcript summary
 * digest both sides maintained â€” disputes can later be checked against it
 * without storing payloads.
 */
export async function closeAgentChannel(workspaceSlug, sessionId, agentAccessToken, channelId, body = {}, options = {}) {
  const authority = await requireAgentTokenAuthority(workspaceSlug, sessionId, agentAccessToken, {
    requiredCapability: 'codesite.channels.open',
    now: options.now,
  });
  const session = authority.session;
  // Design Â§8: close is idempotent â€” if the channel is already closed,
  // return the record unchanged so both participants can call this.
  const existing = await prisma.codeSiteAgentChannel.findFirst({
    where: { id: String(channelId || ''), workspaceSlug },
  });
  if (existing?.status === 'closed') return agentChannelProjection(existing);
  const found = await sweepExpiredChannel(existing);
  const channel = found ?? existing;
  if (!channel) throw notFound('channel_not_found');
  if (channel.fromSessionId !== session.id && channel.toSessionId !== session.id) {
    throw forbidden('channel_participant_mismatch');
  }
  // An already-expired channel is terminal â€” report the sweep result instead
  // of re-closing (keeps the timeline's expiry record intact).
  if (channel.status === 'expired') {
    return agentChannelProjection(channel);
  }
  if (!['active', 'requested'].includes(channel.status)) {
    throw badRequest('channel_not_closable', { status: channel.status });
  }
  // The summary digest is provided by the closing side; both sides maintain a
  // hash chain over the transcript so digests should match. Store what was
  // reported plus who reported it.
  // The summary digest must look like a real transcript hash â€” junk defeats
  // the dispute mechanism (design Â§7).
  const rawDigest = String(body.summaryDigest || body.summary_digest || '').trim();
  if (rawDigest && !/^sha256:[0-9a-f]{64}$/.test(rawDigest)) {
    throw badRequest('channel_summary_digest_invalid');
  }
  const summaryDigest = rawDigest || null;
  const rawCount = Number(body.messageCount);
  const updated = await prisma.codeSiteAgentChannel.update({
    where: { id: channel.id },
    data: {
      status: 'closed',
      closedAt: new Date(),
      summaryDigest,
      messageCount: Number.isFinite(rawCount)
        ? Math.max(0, Math.min(1_000_000, Math.floor(rawCount)))
        : channel.messageCount,
    },
  });
  await recordChannelEvent(channel.projectId, {
    eventType: 'channel_closed',
    actorId: session.id,
    channelId: channel.id,
    details: {
      closedBySessionId: session.id,
      summaryDigest,
      messageCount: updated.messageCount,
    },
  });
  return agentChannelProjection(updated);
}

/**
 * Design Â§9: transports self-report MAC/replay failures so the control plane
 * can record channel_violation events. Participant-gated.
 */
export async function reportAgentChannelViolation(workspaceSlug, sessionId, agentAccessToken, channelId, body = {}, options = {}) {
  const authority = await requireAgentTokenAuthority(workspaceSlug, sessionId, agentAccessToken, {
    requiredCapability: 'codesite.channels.open',
    now: options.now,
  });
  const session = authority.session;
  const channel = await prisma.codeSiteAgentChannel.findFirst({
    where: { id: String(channelId || ''), workspaceSlug },
  });
  if (!channel) throw notFound('channel_not_found');
  if (channel.fromSessionId !== session.id && channel.toSessionId !== session.id) {
    throw forbidden('channel_participant_mismatch');
  }
  const violationCode = String(body.violationCode || body.violation_code || 'unspecified').slice(0, 128);
  const updated = await prisma.codeSiteAgentChannel.update({
    where: { id: channel.id },
    data: { status: 'violation', closedAt: new Date() },
  });
  await recordChannelEvent(channel.projectId, {
    eventType: 'channel_violation',
    actorId: session.id,
    channelId: channel.id,
    details: {
      reportedBySessionId: session.id,
      violationCode,
      peerSessionId: channel.fromSessionId === session.id ? channel.toSessionId : channel.fromSessionId,
    },
  });
  return agentChannelProjection(updated);
}

const CHANNEL_PAGE_DEFAULT_LIMIT = 100;
const CHANNEL_PAGE_MAX_LIMIT = 200;
const CHANNEL_CURSOR_VERSION = 'v1';

function encodeChannelPageCursor(channel) {
  return Buffer.from(JSON.stringify({
    v: CHANNEL_CURSOR_VERSION,
    createdAt: channel.createdAt.toISOString(),
    id: channel.id,
  })).toString('base64url');
}

function decodeChannelPageCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (parsed?.v !== CHANNEL_CURSOR_VERSION || typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') {
      throw new Error('cursor_shape_invalid');
    }
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime()) || !parsed.id.trim()) {
      throw new Error('cursor_value_invalid');
    }
    return { createdAt, id: parsed.id };
  } catch (error) {
    throw badRequest('invalid_cursor', 'channels_cursor_unreadable');
  }
}

/** Audit view of channels for a project. Members only; no tokens ever. */
export async function listProjectChannels(workspaceSlug, projectId, actor = null, query = {}) {
  const project = await prisma.codeSiteProject.findFirst({
    where: { id: String(projectId || ''), workspaceSlug },
    include: { members: true },
  });
  if (!project) throw notFound('project_not_found');
  await requireProjectAccess(project, actor, 'read');
  const requestedLimit = query.limit == null || query.limit === ''
    ? Number.NaN
    : Number(query.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), CHANNEL_PAGE_MAX_LIMIT)
    : CHANNEL_PAGE_DEFAULT_LIMIT;
  const status = String(query.status || '').trim() || undefined;
  const cursor = query.cursor ? decodeChannelPageCursor(query.cursor) : null;
  const createdAtFilter = cursor?.createdAt instanceof Date ? cursor.createdAt.toISOString() : null;
  const channels = await prisma.codeSiteAgentChannel.findMany({
    where: {
      projectId: project.id,
      ...(status ? { status } : {}),
      ...(cursor ? {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  const hasMore = channels.length > limit;
  const page = hasMore ? channels.slice(0, limit) : channels;
  return {
    channels: page.map(agentChannelProjection),
    ...(hasMore && page.length ? { nextCursor: encodeChannelPageCursor(page.at(-1)) } : {}),
  };
}
