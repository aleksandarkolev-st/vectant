import { spawn } from 'child_process';
import path from 'path';
import prisma from '@/lib/prisma';
import { buildArtifactProjection, CODESITE_MCP_TOOLS, codesiteSchemas, writeArtifactProjection } from './artifacts';
import { asArray, parseJson, stringifyJson, stableJson } from './json';
import { buildProofBundle as buildPortableProofBundle, proofCommitTrailers } from './proof';
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
const PROMOTED_POLICY_DELTA_STATES = new Set(['accepted', 'active', 'promoted', 'validated']);
const BLACK_BOX_MINIMUM_EVENT_TYPES = [
  'transaction.opened',
  'assumption.recorded',
  'clearance.issued',
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
  return {
    enabled: true,
    missions,
    forecast,
    selectedStrategy,
    agentSessions,
    executionPlans,
    summary: {
      selectedStrategy,
      riskLevel: forecast.riskLevel,
      missionCount: missions.length,
      heldFlights: executionPlans.filter((plan) => plan.status === 'holding').map((plan) => plan.displayCallsign),
    },
  };
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
  const requestedOwnerUserId = body.ownerUserId || body.owner_user_id || null;
  const ownerUserId = requestedOwnerUserId || actor?.userId || 'unknown';
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
      permissionsJson: stringifyJson(body.permissions || []),
      redactionPolicyJson: stringifyJson(body.redactionPolicy || body.redaction_policy || defaultRedactionPolicy()),
      dojoPilotLicenseRef: firstCodeSiteRef(body.dojoPilotLicenseRef, body.dojo_pilot_license_ref, body.dojoLicenseRef, body.dojo_license_ref),
      dojoProofRef: firstCodeSiteRef(body.dojoProofRef, body.dojo_proof_ref),
      dojoEvidenceRefsJson: codeSiteEvidenceRefsJson(body.dojoEvidenceRefs || body.dojo_evidence_refs || body.evidenceRefs || body.evidence_refs),
      dojoDecisionDigest: firstCodeSiteRef(body.dojoDecisionDigest, body.dojo_decision_digest),
      pilotLicenseSnapshotJson: stringifyJson(body.pilotLicenseSnapshot || body.pilot_license_snapshot || null),
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
  const project = await requireProject(workspaceSlug, projectId);
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
  const clearancePolicy = applyCounterfactualPolicyGate(
    applyTowerCollisionGate(applyDojoClearanceGate(policy, dojoProof), collisionAvoidance),
    counterfactualPolicy,
  );
  const finalRequestedLease = {
    ...requestedLease,
    requiredRadar: unique([
      ...asArray(requestedLease.requiredRadar),
      ...asArray(counterfactualPolicy.requiredRadar),
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
        collisionAvoidance: clearancePolicy.collisionAvoidance || null,
        counterfactualPolicy: counterfactualPolicy.appliedPolicyDeltas.length ? counterfactualPolicy : null,
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
    input: { executionPlan, requestedLease: finalRequestedLease, dojoProof: dojoProofSummary },
    decisionJson: {
      status: clearancePolicy.status,
      towerInstruction: clearancePolicy.towerInstruction,
      inspectedZones: clearancePolicy.inspectedZones,
      dojoProof: dojoProofSummary,
      collisionAvoidance: clearancePolicy.collisionAvoidance || null,
      counterfactualPolicy: counterfactualPolicy.appliedPolicyDeltas.length ? counterfactualPolicy : null,
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
      collisionAvoidance: clearancePolicy.collisionAvoidance || null,
      counterfactualPolicy: counterfactualPolicy.appliedPolicyDeltas.length ? counterfactualPolicy : null,
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

export async function openTransaction(workspaceSlug, mutationLeaseId, body = {}, actor = null) {
  const lease = await requireLease(workspaceSlug, mutationLeaseId);
  requireLeaseActorAccess(lease, actor);
  if (lease.status !== 'active') {
    throw badRequest('clearance_not_active', { status: lease.status });
  }
  const leaseJson = parseJson(lease.leaseJson, {});
  const readSet = normalizePathList(body.readSet || body.read_set || []);
  const isolation = normalizeTransactionIsolation(body.isolation);
  const baseSnapshotEvidence = await buildTransactionSnapshotEvidence(readSet, body);
  const transaction = await prisma.codeSiteMutationTransaction.create({
    data: {
      projectId: lease.projectId,
      mutationLeaseId: lease.id,
      agentSessionId: lease.agentSessionId,
      baseSnapshot: body.baseSnapshot || body.base_snapshot || baseSnapshotEvidence?.snapshotDigest || digest({ workspaceSlug, mutationLeaseId, openedAt: Date.now() }),
      baseSnapshotEvidenceJson: stringifyJson(baseSnapshotEvidence),
      isolation,
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

export async function getTransaction(workspaceSlug, transactionId, actor = null) {
  const transaction = await prisma.codeSiteMutationTransaction.findFirst({
    where: { id: transactionId, project: { workspaceSlug } },
    include: { mutationLease: true, agentSession: true, proofBundles: true, lineProvenance: true },
  });
  if (!transaction) return null;
  requireTransactionActorAccess(transaction, actor);
  return transactionProjection(transaction);
}

export async function recordTransactionRead(workspaceSlug, transactionId, body = {}, actor = null) {
  const transaction = await requireOpenTransaction(workspaceSlug, transactionId, actor);
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
  await recordEvent(transaction.projectId, {
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
  return { ok: true, transaction: transactionProjection(updated), invalidatedAssumptions: invalidated };
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
  const project = await requireProject(workspaceSlug, projectId);
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
  const transaction = await requireTransaction(workspaceSlug, transactionId, actor);
  const project = await prisma.codeSiteProject.findUnique({ where: { id: transaction.projectId } });
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
  const invalidAssumptions = await prisma.codeSiteAssumptionLease.findMany({
    where: {
      id: { in: parseJson(transaction.assumptionRefsJson, []) },
      status: 'invalidated',
    },
  });
  const staleReads = await findStaleReadEvents(transaction, unique([...readSet, ...semanticDependencyRefs]));
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

async function validateTransactionSnapshot(transaction, requiredReadSet = null) {
  const evidence = parseJson(transaction.baseSnapshotEvidenceJson, null);
  const validation = await validateReadSnapshotEvidence(evidence);
  return enforceSerializableSnapshotCoverage(transaction, validation, requiredReadSet);
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
  if (!requiresSnapshot && missingReadSet.length === 0) return validation;

  return {
    ...validation,
    ok: false,
    reasonCodes: unique([
      ...validation.reasonCodes,
      ...(requiresSnapshot ? ['repo_snapshot_required_for_serializable'] : []),
      ...(missingReadSet.length ? ['repo_snapshot_read_set_coverage_required'] : []),
    ]),
    requiredReadSet: required,
    snapshotReadSet,
    missingReadSet,
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
  const validation = await validateTransaction(workspaceSlug, transactionId, actor);
  if (!validation.decision.ok) return validation;
  const transaction = await requireTransaction(workspaceSlug, transactionId, actor);
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
      lineProvenance: lineProvenanceDecision,
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
  return {
    transaction: transactionProjection(updated),
    proofBundle: proofBundleProjection(bundle, {
      transaction,
      mutationLease: transaction.mutationLease,
      landingRuns: inspectionDecision.inspectionRuns,
    }),
  };
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
  const transactionEvents = events
    .map((event) => ({ event, details: parseJson(event.detailsJson, {}) }))
    .filter(({ event, details }) => eventBelongsToTransaction(event, details, transaction));
  const coveredPaths = new Set(transactionEvents
    .flatMap(({ details }) => strictLineProvenanceRows(details.lineProvenance || details.line_provenance, normalizePath(details.path)))
    .map((row) => row.filePath));
  const uncoveredWriteEvents = transactionEvents
    .map(({ event, details }) => {
      const path = normalizePath(details.path);
      const rows = strictLineProvenanceRows(details.lineProvenance || details.line_provenance, path);
      const expectedRanges = strictLineProvenanceRows(details.changedLineRanges || details.changed_line_ranges, path);
      const missingPathCoverage = path && !lineProvenanceRowsCoverPath(rows, path);
      const missingRangeCoverage = expectedRanges.filter((expectedRange) => (
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
  const allMissingPaths = unique([...missingPaths, ...missingEventPaths]);
  return {
    ok: allMissingPaths.length === 0 && uncoveredWriteEvents.length === 0,
    reasonCodes: allMissingPaths.length || uncoveredWriteEvents.length ? ['line_provenance_required'] : ['line_provenance_verified'],
    missingPaths: allMissingPaths,
    uncoveredWriteEvents,
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
  const project = await requireProject(workspaceSlug, projectId);
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
          body: recipientBody,
          redaction: {
            policyApplied: true,
            recipientSessionId: session.id,
          },
        }),
      },
    }));
  }
  return created;
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
  const policyDeltaEvent = policyDelta
    ? await recordIncidentPolicyDeltaEvent(project.id, incident, policyDelta, evidenceRefs)
    : null;

  if (category !== 'mayday') {
    return finalizeIncidentReplay(project, incident, body, {
      participants,
      affectedZones,
      evidenceRefs,
      policyDelta,
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
    policyDelta,
    timelineEventRefs,
    extraEvents: [incidentEvent, policyDeltaEvent].filter(Boolean),
    maydayWorkflow: workflow.replay,
  });
  return {
    ...updated,
    maydayWorkflow: workflow.summary,
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
    },
  });
  await syncArtifactsForProject(project.id, { reason: 'incident_replay_finalized' });
  return incidentProjection(updated);
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
  const completeness = incidentReplayCompleteness(causalEvents);
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
  return {
    transaction_opened: 'transaction.opened',
    assumption_recorded: 'assumption.recorded',
    assumption_invalidated: 'assumption.invalidated',
    clearance_issued: 'clearance.issued',
    holding_pattern: 'clearance.holding',
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
    rfi: 'document.rfi',
    change_order: 'document.change_order',
    tower_instruction: 'tower.instruction',
    transponder_update: 'transponder.update',
    flight_plan_filed: 'flight_plan.filed',
    radar_result: 'radar.result',
    black_box_closed: 'black_box.closed',
  }[eventType] || String(eventType || 'unknown').replace(/_/g, '.');
}

function incidentReplayCompleteness(causalEvents = []) {
  const observedTypes = unique(causalEvents.map((event) => event.type).filter(Boolean));
  const observed = new Set(observedTypes);
  const present = BLACK_BOX_MINIMUM_EVENT_TYPES.filter((type) => observed.has(type));
  const missing = BLACK_BOX_MINIMUM_EVENT_TYPES.filter((type) => !observed.has(type));
  return {
    score: BLACK_BOX_MINIMUM_EVENT_TYPES.length ? Number((present.length / BLACK_BOX_MINIMUM_EVENT_TYPES.length).toFixed(2)) : 1,
    presentEventTypes: present,
    missingEventTypes: missing,
    observedEventTypes: observedTypes,
    totalEvents: causalEvents.length,
  };
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
  const arbiterVerdict = body.arbiterVerdict || body.arbiter_verdict || null;
  const run = await prisma.codeSiteCounterfactualRun.create({
    data: {
      projectId: project.id,
      shadowJobRef: body.shadowJobRef || body.shadow_job_ref || null,
      baseSnapshot: body.baseSnapshot || body.base_snapshot || digest({ projectId, at: Date.now() }),
      universesJson: stringifyJson(body.universes || []),
      arbiterVerdictJson: stringifyJson(arbiterVerdict),
      userChoiceJson: stringifyJson(body.userChoice || body.user_choice || null),
      laterManualEditsJson: stringifyJson(body.laterManualEdits || body.later_manual_edits || []),
      validityStrength: body.validityStrength || body.validity_strength || 'weak',
      evidenceRefsJson: stringifyJson(body.evidenceRefs || body.evidence_refs || []),
    },
  });
  await persistCounterfactualPolicyDeltaCandidates(project.id, run, arbiterVerdict, {
    evidenceRefs: body.evidenceRefs || body.evidence_refs || [],
  });
  await recordEvent(project.id, {
    eventType: 'shadow_run',
    actorType: 'counterfactual',
    actorId: run.id,
    details: { counterfactualRunId: run.id, shadowJobRef: run.shadowJobRef, validityStrength: run.validityStrength },
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
        arbiterVerdict,
        selected: arbiterVerdict.selected || arbiterVerdict.winner || arbiterVerdict.verdict || null,
        validityStrength: run.validityStrength,
      },
    });
  }
  return counterfactualProjection(run);
}

export async function createPolicyDelta(workspaceSlug, projectId, body = {}) {
  const project = await requireProject(workspaceSlug, projectId);
  const promotionState = String(body.promotionState || body.promotion_state || 'proposed').toLowerCase();
  const ruleCandidate = normalizePolicyDeltaRuleCandidate(body.ruleCandidate || body.rule_candidate || body);
  const delta = await prisma.codeSitePolicyDelta.create({
    data: {
      projectId: project.id,
      learnedFromIncidentsJson: stringifyJson(body.learnedFromIncidents || body.learned_from_incidents || []),
      affectedZoneKey: body.affectedZoneKey || body.affected_zone_key || null,
      ruleCandidateJson: stringifyJson(ruleCandidate),
      triggerConditionsJson: stringifyJson(body.triggerConditions || body.trigger_conditions || []),
      expectedRiskReduction: typeof body.expectedRiskReduction === 'number' ? body.expectedRiskReduction : body.expected_risk_reduction,
      confidence: typeof body.confidence === 'number' ? body.confidence : 0.5,
      promotionState,
      replayRefsJson: stringifyJson(body.replayRefs || body.replay_refs || []),
      promotedAt: PROMOTED_POLICY_DELTA_STATES.has(promotionState) ? (body.promotedAt ? new Date(body.promotedAt) : new Date()) : null,
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

async function persistCounterfactualPolicyDeltaCandidates(projectId, run, arbiterVerdict, context = {}) {
  const candidates = uniquePolicyDeltaCandidates(asArray(arbiterVerdict?.policyDeltaCandidates || arbiterVerdict?.policy_delta_candidates));
  if (!candidates.length) return [];
  const created = [];
  for (const candidate of candidates) {
    const ruleCandidate = normalizePolicyDeltaRuleCandidate(candidate);
    const triggerConditions = asArray(candidate.triggerConditions || candidate.trigger_conditions || candidate.affectedRoutes || candidate.affected_routes)
      .map((item) => (typeof item === 'string' ? { path: item } : item))
      .filter(Boolean);
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
        ruleCandidate,
      },
    });
  }
  return created.map(policyDeltaProjection);
}

function uniquePolicyDeltaCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false;
    const key = stableJson(normalizePolicyDeltaRuleCandidate(candidate));
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
    mcpTools: CODESITE_MCP_TOOLS,
  };
}

export async function getSchemas() {
  return codesiteSchemas();
}

export async function previewArtifacts(workspaceSlug, projectId, options = {}) {
  const projectRow = await prisma.codeSiteProject.findFirst({
    where: { id: projectId, workspaceSlug },
    include: PROJECT_INCLUDE,
  });
  if (!projectRow) throw notFound('project_not_found');
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

export async function exportArtifacts(workspaceSlug, projectId) {
  const projectRow = await prisma.codeSiteProject.findFirst({
    where: { id: projectId, workspaceSlug },
    include: PROJECT_INCLUDE,
  });
  if (!projectRow) throw notFound('project_not_found');
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
  const project = await prisma.codeSiteProject.findFirst({
    where: { id: projectId, workspaceSlug },
    include: {
      executionPlans: true,
      mutationLeases: true,
      incidents: true,
      inspectionRuns: true,
    },
  });
  if (!project) throw notFound('project_not_found');
  const zonePolicy = parseJson(project.zonePolicyJson, compileZonePolicy());
  const executionPlans = project.executionPlans.map(executionPlanProjection);
  const mutationLeases = project.mutationLeases.map(mutationLeaseProjection);
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
  const result = {
    selected: selected.strategy,
    appliedPolicyDeltas: selected.learnedPolicyDeltaRefs || [],
    reason: {
      reasonCodes: selected.reasonCodes,
      staleAssumptions: selected.staleAssumptions,
      inspectionCost: selected.inspectionCost,
      predictedCollisionRisk: selected.predictedCollisionRisk,
      riskLevel: forecast.riskLevel,
      sourceSignals: selected.sourceSignals,
      learnedPolicyDeltaRefs: selected.learnedPolicyDeltaRefs || [],
    },
    universes,
    shadowJobRef,
    baseSnapshot,
    evidenceRefs,
    policyDeltaCandidates,
    repoSignals: towerSignals.summary,
  };
  await createCounterfactualRun(workspaceSlug, projectId, {
    shadowJobRef,
    baseSnapshot,
    universes,
    arbiterVerdict: result,
    validityStrength: towerSignals.summary.signalStrength,
    evidenceRefs,
  });
  return result;
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
      memory.reasonCodes.push('learned_policy_delta_preferred_strategy');
      memory.policyDeltaRefs.push(delta.id);
    }
    if (policy.avoidStrategies.includes(strategy)) {
      memory.riskDelta += riskReduction;
      memory.staleDelta += Math.max(1, Math.round(confidence * 2));
      memory.costDelta += Math.max(1, Math.round(confidence * 2));
      memory.reasonCodes.push('learned_policy_delta_avoided_strategy');
      memory.policyDeltaRefs.push(delta.id);
    }
  }
  return {
    riskDelta: roundTo(memory.riskDelta, 3),
    staleDelta: memory.staleDelta,
    costDelta: memory.costDelta,
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
  if (affectedZoneKey && !surface.some((entry) => entry.includes(affectedZoneKey))) return false;
  const conditions = asArray(delta.triggerConditions);
  if (!conditions.length) return true;
  return conditions.every((condition) => learnedTriggerMatches(condition, surface));
}

function learnedTriggerMatches(condition, surface) {
  if (typeof condition === 'string') {
    const value = condition.toLowerCase();
    return surface.some((entry) => entry.includes(value) || pathPatternsOverlap(entry, value));
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
  return values.every((value) => surface.some((entry) => entry.includes(value) || pathPatternsOverlap(entry, value)));
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

export async function getLineProvenance(workspaceSlug, { projectId, filePath, lineAnchor, lineNumber } = {}) {
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
  return {
    ...projection,
    portableProofBundle: buildPortableProofBundle({
      project: projectProjection(bundle.project),
      transaction: transactionProjection(bundle.transaction),
      mutationLease: bundle.transaction?.mutationLease ? mutationLeaseProjection(bundle.transaction.mutationLease) : null,
      proofBundle: projection,
      incidents: incidents.map(incidentProjection),
      landingRuns: landingRuns.map(inspectionProjection),
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
  const eventType = validateCodeSiteEventType(input.eventType);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const logicalTime = await prisma.codeSiteEvent.count({ where: { projectId } });
    try {
      const event = await prisma.codeSiteEvent.create({
        data: {
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
      await syncArtifactsForProject(projectId, { reason: 'event_recorded', eventId: event.id });
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
    include: { agentSession: true },
  });
  if (!lease) throw notFound('mutation_lease_not_found');
  return lease;
}

async function requireTransaction(workspaceSlug, transactionId, actor = null) {
  const transaction = await prisma.codeSiteMutationTransaction.findFirst({
    where: { id: transactionId, project: { workspaceSlug } },
    include: { mutationLease: true, agentSession: true },
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
  const mutationTxns = asArray(project.mutationTxns);
  const mutationLeases = asArray(project.mutationLeases);
  const inspectionRuns = asArray(project.inspectionRuns);
  return {
    ...projectSummary(project),
    zonePolicy: parseJson(project.zonePolicyJson, {}),
    controlPlan: parseJson(project.controlPlanJson, {}),
    agentSessions: asArray(project.agentSessions).map(sessionProjection),
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
      return proofBundleProjection(bundle, { transaction, mutationLease, landingRuns });
    }),
    lineProvenance: asArray(project.lineProvenance).map(lineProvenanceProjection),
    documents: asArray(project.documents).map(documentSummaryProjection),
    counterfactualRuns: asArray(project.counterfactualRuns).map(counterfactualProjection),
    policyDeltas: asArray(project.policyDeltas).map(policyDeltaProjection),
    inboxItems: asArray(project.inboxItems).map(inboxSummaryProjection),
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
    agentProvider: session.agentProvider,
    agentRuntime: session.agentRuntime,
    providerSessionRef: session.providerSessionRef,
    displayCallsign: session.displayCallsign,
    status: session.status,
    permissions: parseJson(session.permissionsJson, []),
    redactionPolicy: parseJson(session.redactionPolicyJson, {}),
    dojoPilotLicenseRef: session.dojoPilotLicenseRef || null,
    dojoProofRef: session.dojoProofRef || null,
    dojoEvidenceRefs: parseJson(session.dojoEvidenceRefsJson, []),
    dojoDecisionDigest: session.dojoDecisionDigest || null,
    pilotLicenseSnapshot: parseJson(session.pilotLicenseSnapshotJson, null),
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

function proofBundleProjection(bundle, context = {}) {
  const transaction = context.transaction || bundle.transaction || null;
  const mutationLease = context.mutationLease || transaction?.mutationLease || null;
  const projection = {
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
  };
  const portable = buildPortableProofBundle({
    project: bundle.project ? projectProjection(bundle.project) : { id: bundle.projectId },
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

function inboxSummaryProjection(item) {
  return {
    id: item.id,
    projectId: item.projectId,
    agentSessionId: item.agentSessionId,
    eventId: item.eventId,
    documentId: item.documentId,
    kind: item.kind,
    requiresResponse: item.requiresResponse,
    status: item.status,
    payloadAvailable: Boolean(item.redactedPayloadJson),
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
