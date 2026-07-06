import { asArray, parseJson, stableJson } from './json';

export const PILOT_LICENSE_HEALTH_SCHEMA_VERSION = 'synthi.codesite.pilotLicenseHealth.v1';

const LEVEL_ORDER = ['Grounded', 'Student', 'VFR', 'IFR', 'Type-rated', 'Captain'];
const LEVEL_RANK = {
  grounded: 0,
  student: 1,
  vfr: 2,
  ifr: 3,
  'type-rated': 4,
  typerated: 4,
  type_rated: 4,
  captain: 5,
};
const CLASS_MIN_LEVEL = {
  A: 'Type-rated',
  B: 'IFR',
  C: 'VFR',
  D: 'Student',
};
const UNHEALTHY_STATUSES = new Set(['grounded', 'expired', 'suspended']);
const VIOLATION_HEALTH_STATUSES = new Set([...UNHEALTHY_STATUSES, 'unlicensed']);
const BLOCKING_DECISION_STATUSES = new Set(['block', 'blocked', 'deny', 'denied', 'hold', 'holding', 'quarantine', 'quarantined']);
const PILOT_LICENSE_VIOLATION_REASON_RE = /dojo_proof_required|pilot_license_(source_drift_expired|expired|suspended|grounded|unlicensed|missing|required|invalid|blocked|level_insufficient|level_required|airspace_not_authorized|scope_mismatch|critical_violation|failed_landings)/;
const EXPIRY_TRIGGER_KEYS = new Set(['source_drift', 'source-drift', 'repo_source_drift', 'policy_source_drift']);
const CRITICAL_VIOLATION_PATTERNS = [
  /entered_no_fly_zone/i,
  /no_fly/i,
  /mayday|ground_stop/i,
  /security/i,
  /clearance_not_active/i,
  /outside_clearance_route/i,
  /tool_not_in_clearance/i,
];

export function buildPilotLicenseHealthRecords(project = {}, { now = new Date() } = {}) {
  const zonePolicy = project.zonePolicy || parseJson(project.zonePolicyJson, {}) || {};
  const currentSourceDigest = sourceDigestForZonePolicy(zonePolicy);
  const sessions = sessionRecords(project);
  const executionPlans = asArray(project.executionPlans).map(normalizeExecutionPlan);
  const leases = asArray(project.mutationLeases).map(normalizeLease);
  const events = asArray(project.events).map(normalizeEvent);
  const policyDecisions = asArray(project.policyDecisions).map(normalizePolicyDecision);
  const inspectionRuns = asArray(project.inspectionRuns).map(normalizeInspectionRun);
  const incidents = asArray(project.incidents).map(normalizeIncident);

  return sessions
    .map((session) => buildSessionHealth({
      project,
      zonePolicy,
      currentSourceDigest,
      session,
      executionPlans,
      leases,
      events,
      policyDecisions,
      inspectionRuns,
      incidents,
      now,
    }))
    .sort((left, right) => String(left.displayCallsign || left.agentSessionId || '').localeCompare(String(right.displayCallsign || right.agentSessionId || '')));
}

export function pilotLicenseHealthForSession(records, session = {}) {
  const sessionId = typeof session === 'string' ? session : session?.id;
  const callsign = typeof session === 'string' ? null : session?.displayCallsign;
  return asArray(records).find((record) => (
    (sessionId && record.agentSessionId === sessionId)
    || (callsign && record.displayCallsign === callsign)
  )) || null;
}

export function buildPilotLicenseHealthForClearance(project = {}, {
  agentSession,
  executionPlan,
  requestedLease,
  dojoProof,
  now = new Date(),
} = {}) {
  const healthProject = {
    ...project,
    agentSessions: ensureSession(project.agentSessions, agentSession),
    executionPlans: ensureExecutionPlan(project.executionPlans, executionPlan),
  };
  const records = buildPilotLicenseHealthRecords(healthProject, { now });
  const base = pilotLicenseHealthForSession(records, agentSession || executionPlan?.agentSessionId) || buildSessionHealth({
    project: healthProject,
    zonePolicy: healthProject.zonePolicy || parseJson(healthProject.zonePolicyJson, {}) || {},
    currentSourceDigest: sourceDigestForZonePolicy(healthProject.zonePolicy || parseJson(healthProject.zonePolicyJson, {}) || {}),
    session: normalizeSession(agentSession || {
      id: executionPlan?.agentSessionId || null,
      displayCallsign: executionPlan?.displayCallsign || null,
    }),
    executionPlans: asArray(healthProject.executionPlans).map(normalizeExecutionPlan),
    leases: asArray(healthProject.mutationLeases).map(normalizeLease),
    events: asArray(healthProject.events).map(normalizeEvent),
    policyDecisions: asArray(healthProject.policyDecisions).map(normalizePolicyDecision),
    inspectionRuns: asArray(healthProject.inspectionRuns).map(normalizeInspectionRun),
    incidents: asArray(healthProject.incidents).map(normalizeIncident),
    now,
  });
  return applyClearanceProof(base, { dojoProof, executionPlan, requestedLease });
}

export function applyPilotLicenseHealthGate(policy = {}, health = null) {
  const requirement = pilotLicenseRequirement(policy);
  const baseReasonCodes = unique(asArray(policy.reasonCodes));
  if (!requirement.required) {
    return {
      ...policy,
      pilotLicenseHealth: health,
      pilotLicenseRequirement: requirement,
      reasonCodes: unique([...baseReasonCodes, 'pilot_license_not_required_for_route']),
    };
  }

  const healthStatus = String(health?.status || 'unlicensed').toLowerCase();
  const levelRank = rankForLevel(health?.level);
  const routePaths = unique(asArray(policy.inspectedZones).flatMap((zone) => asArray(zone?.paths || zone?.path)));
  const repoScope = String(health?.repoScope || '').trim();
  const workspaceScope = String(health?.workspaceSlug || '').trim();
  const authorizedAirspace = asArray(health?.authorizedAirspace);
  const restrictedAirspace = asArray(health?.restrictedAirspace);
  const blockers = [];
  if (!health || healthStatus === 'unlicensed') blockers.push('pilot_license_required_for_restricted_airspace');
  if (UNHEALTHY_STATUSES.has(healthStatus)) blockers.push(`pilot_license_${healthStatus}`);
  if (health?.sourceDrift?.expired) blockers.push('pilot_license_source_drift_expired');
  if (levelRank < requirement.minimumLevelRank) blockers.push('pilot_license_level_insufficient');
  if (workspaceScope && !repoScope) blockers.push('pilot_license_repo_scope_missing');
  if (repoScope && workspaceScope && repoScope !== workspaceScope) blockers.push('pilot_license_repo_scope_mismatch');
  if (routePaths.length > 0 && authorizedAirspace.length === 0) blockers.push('pilot_license_airspace_not_authorized');
  if (routePaths.length > 0 && authorizedAirspace.length > 0 && !routePaths.every((routePath) => authorizedAirspace.some((pattern) => pathsOverlap(routePath, pattern)))) {
    blockers.push('pilot_license_airspace_not_authorized');
  }
  if (routePaths.length > 0 && restrictedAirspace.some((pattern) => routePaths.some((routePath) => pathsOverlap(routePath, pattern)))) {
    blockers.push('pilot_license_restricted_airspace_excluded');
  }

  if (!blockers.length) {
    return {
      ...policy,
      pilotLicenseHealth: health,
      pilotLicenseRequirement: requirement,
      reasonCodes: unique([
        ...baseReasonCodes,
        ...asArray(health?.reasonCodes).filter((code) => /^pilot_license_/.test(String(code))),
        'pilot_license_health_active',
        'pilot_license_level_authorized',
      ]),
    };
  }

  const status = 'blocked';
  const callsign = health?.displayCallsign || 'agent';
  return {
    ...policy,
    decision: 'block',
    status,
    pilotLicenseHealth: health,
    pilotLicenseRequirement: requirement,
    reasonCodes: unique([
      ...baseReasonCodes,
      ...asArray(health?.reasonCodes).filter((code) => /^pilot_license_/.test(String(code))),
      ...blockers,
    ]),
    towerInstruction: `Hold ${callsign}: ${requirement.minimumLevel} pilot license health is required for Class ${requirement.classes.join('/')} mutation airspace.`,
  };
}

export function pilotLicenseRequirement(policy = {}) {
  const classes = unique(asArray(policy.inspectedZones)
    .map((zone) => String(zone?.class || '').toUpperCase())
    .filter(Boolean));
  const requiredClasses = classes.filter((value) => ['A', 'B'].includes(value));
  if (!requiredClasses.length) {
    return {
      required: false,
      classes,
      minimumLevel: 'Student',
      minimumLevelRank: rankForLevel('Student'),
    };
  }
  const minimumLevel = requiredClasses
    .map((className) => CLASS_MIN_LEVEL[className] || 'Student')
    .sort((left, right) => rankForLevel(right) - rankForLevel(left))[0] || 'Student';
  return {
    required: true,
    classes: requiredClasses,
    minimumLevel,
    minimumLevelRank: rankForLevel(minimumLevel),
  };
}

export function pilotLicenseHealthSummary(records = []) {
  const normalized = asArray(records);
  const counts = countBy(normalized, (record) => record.status || 'unknown');
  const blockers = normalized.filter((record) => UNHEALTHY_STATUSES.has(String(record.status || '').toLowerCase()));
  return {
    schemaVersion: PILOT_LICENSE_HEALTH_SCHEMA_VERSION,
    statusCounts: counts,
    active: counts.active || 0,
    blocked: blockers.length,
    requiredActions: blockers.flatMap((record) => asArray(record.requiredAction)),
  };
}

function buildSessionHealth({
  project,
  zonePolicy,
  currentSourceDigest,
  session,
  executionPlans,
  leases,
  events,
  policyDecisions,
  inspectionRuns,
  incidents,
  now,
}) {
  const snapshot = normalizeSnapshot(session.pilotLicenseSnapshot || session.pilotLicenseSnapshotJson);
  const relatedPlans = relatedExecutionPlans(executionPlans, session);
  const relatedLeases = relatedLeasesForSession(leases, session);
  const relatedInspections = relatedInspectionRuns(inspectionRuns, session, relatedPlans);
  const relatedEvents = relatedEventsForSession(events, session, relatedLeases, relatedPlans);
  const relatedDecisions = relatedPolicyDecisions(policyDecisions, session, relatedLeases);
  const relatedIncidents = relatedIncidentsForSession(incidents, session);
  const landingStats = landingStatsFor(relatedInspections);
  const violationStats = violationStatsFor({ events: relatedEvents, policyDecisions: relatedDecisions, incidents: relatedIncidents });
  const licenseRef = firstValue(
    session.dojoPilotLicenseRef,
    session.dojoLicenseRef,
    snapshot.licenseRef,
    snapshot.licenseId,
    snapshot.licenseVersion,
    ...relatedLeases.map((lease) => lease.dojoLicenseRef),
  );
  const proofRef = firstValue(session.dojoProofRef, snapshot.proofRef, ...relatedLeases.map((lease) => lease.dojoProofRef));
  const level = inferLicenseLevel(snapshot, licenseRef);
  const sourceDigest = firstValue(
    snapshot.sourceDigest,
    snapshot.sourceSnapshotDigest,
    snapshot.repoSourceDigest,
    snapshot.policySourceDigest,
  );
  const expiryTriggers = unique([
    ...asArray(snapshot.expiresOn),
    ...asArray(snapshot.expiryTriggers),
  ]).map((value) => String(value).toLowerCase());
  const sourceDrift = {
    monitored: expiryTriggers.some((trigger) => EXPIRY_TRIGGER_KEYS.has(trigger)),
    sourceDigest: sourceDigest || null,
    currentSourceDigest: currentSourceDigest || null,
    expired: false,
  };
  sourceDrift.expired = sourceDrift.monitored
    && Boolean(sourceDrift.sourceDigest && sourceDrift.currentSourceDigest)
    && sourceDrift.sourceDigest !== sourceDrift.currentSourceDigest;

  const reasonCodes = [];
  const explicitStatus = String(firstValue(snapshot.status, snapshot.licenseStatus, session.status) || '').toLowerCase();
  let status = licenseRef || hasMeaningfulSnapshot(snapshot) ? 'active' : 'unlicensed';
  if (isGrounded(explicitStatus, level)) {
    status = 'grounded';
    reasonCodes.push('pilot_license_grounded');
  } else if (isExpired(snapshot, now)) {
    status = 'expired';
    reasonCodes.push('pilot_license_time_expired');
  } else if (sourceDrift.expired) {
    status = 'expired';
    reasonCodes.push('pilot_license_source_drift_expired');
  } else if (violationStats.critical > 0) {
    status = 'suspended';
    reasonCodes.push('pilot_license_critical_violation_window');
  } else if (landingStats.failed >= 2) {
    status = 'suspended';
    reasonCodes.push('pilot_license_failed_landing_threshold');
  } else if (status === 'active') {
    reasonCodes.push('pilot_license_health_active');
    if (sourceDrift.monitored) reasonCodes.push('pilot_license_source_current');
    if (landingStats.passed >= 3 && violationStats.critical === 0) reasonCodes.push('pilot_license_privileges_earned_by_landings');
  } else {
    reasonCodes.push('pilot_license_not_on_file');
  }

  const requiredAction = requiredActionForStatus(status, session, reasonCodes);
  const evidenceRefs = unique([
    ...asArray(session.dojoEvidenceRefs),
    ...asArray(snapshot.evidenceRefs),
    ...asArray(snapshot.earnedBy).filter((value) => /^evidence:|^dojo:|^codesite:/.test(String(value))),
    ...relatedLeases.flatMap((lease) => asArray(lease.dojoEvidenceRefs)),
    ...relatedInspections.flatMap((run) => asArray(run.evidenceRefs)),
    ...relatedEvents.flatMap((event) => asArray(event.evidenceRefs)),
    ...relatedDecisions.map((decision) => decision.id ? `codesite:policy-decision:${decision.id}` : null),
    ...relatedIncidents.flatMap((incident) => asArray(incident.evidenceRefs)),
  ]);

  return {
    schemaVersion: PILOT_LICENSE_HEALTH_SCHEMA_VERSION,
    key: session.id || session.displayCallsign || licenseRef || 'pilot-license',
    projectId: project.id || session.projectId || null,
    workspaceSlug: project.workspaceSlug || null,
    agentSessionId: session.id || null,
    ownerUserId: session.ownerUserId || null,
    displayCallsign: session.displayCallsign || relatedPlans[0]?.displayCallsign || null,
    status,
    level,
    levelRank: rankForLevel(level),
    dojoPilotLicenseRef: session.dojoPilotLicenseRef || licenseRef || null,
    dojoLicenseRef: licenseRef || null,
    dojoProofRef: proofRef || null,
    dojoDecisionDigest: firstValue(session.dojoDecisionDigest, ...relatedLeases.map((lease) => lease.dojoDecisionDigest)) || null,
    repoScope: firstValue(snapshot.repoScope, snapshot.repo, project.workspaceSlug) || null,
    authorizedAirspace: unique([
      ...asArray(snapshot.authorizedAirspace),
      ...asArray(snapshot.authorizedPaths),
      ...relatedLeases.flatMap((lease) => asArray(lease.lease?.allowedPaths)),
    ]),
    restrictedAirspace: unique([
      ...asArray(snapshot.restrictedAirspace),
      ...relatedLeases.flatMap((lease) => asArray(lease.lease?.blockedPaths)),
    ]),
    requiredRadar: unique([
      ...asArray(snapshot.requiredRadar),
      ...relatedLeases.flatMap((lease) => asArray(lease.lease?.requiredRadar)),
    ]),
    earnedBy: unique([
      ...asArray(snapshot.earnedBy),
      ...asArray(snapshot.evidenceRecordIds),
      ...asArray(session.dojoEvidenceRefs),
    ]),
    expiresAt: firstValue(snapshot.expiresAt, snapshot.expiryAt, snapshot.validUntil) || null,
    expiresOn: expiryTriggers,
    sourceDrift,
    landingStats,
    violationStats,
    reasonCodes: unique(reasonCodes),
    requiredAction,
    evidenceRefs,
    lifecycle: {
      issuedAt: firstValue(snapshot.issuedAt, session.createdAt) || null,
      checkedAt: new Date().toISOString(),
      latestLandingAt: relatedInspections.map((run) => run.completedAt || run.requestedAt).filter(Boolean).sort().at(-1) || null,
      latestViolationAt: violationStats.latestAt,
      sourcePolicyDigest: firstValue(zonePolicy.policyDigest, zonePolicy.compiler?.policyDigest) || null,
    },
  };
}

function applyClearanceProof(health, { dojoProof, executionPlan, requestedLease } = {}) {
  if (!dojoProof?.licenseRef && !dojoProof?.proofRef) return health;
  const verificationOk = dojoProof.verification?.ok === true;
  const proofExecutable = dojoProof.implementationStatus?.executable === true;
  const proofEvidence = unique([
    dojoProof.proofRef,
    dojoProof.licenseRef,
    dojoProof.ledgerCheckpointHash,
    dojoProof.decisionDigest,
    ...asArray(dojoProof.evidenceRefs),
  ]);
  const proofLevel = inferLicenseLevel({}, dojoProof.licenseRef);
  const canPromote = verificationOk
    && proofExecutable
    && ['unlicensed', 'active'].includes(String(health.status || '').toLowerCase())
    && !health.sourceDrift?.expired;
  const nextStatus = canPromote ? 'active' : health.status;
  const nextReasonCodes = unique([
    ...asArray(health.reasonCodes).filter((code) => code !== 'pilot_license_not_on_file'),
    ...(canPromote ? ['pilot_license_from_verified_dojo_proof', 'pilot_license_health_active'] : []),
  ]);
  return {
    ...health,
    status: nextStatus,
    level: rankForLevel(proofLevel) > rankForLevel(health.level) ? proofLevel : health.level,
    levelRank: Math.max(rankForLevel(health.level), rankForLevel(proofLevel)),
    dojoLicenseRef: health.dojoLicenseRef || dojoProof.licenseRef || null,
    dojoPilotLicenseRef: health.dojoPilotLicenseRef || dojoProof.licenseRef || null,
    dojoProofRef: health.dojoProofRef || dojoProof.proofRef || null,
    dojoDecisionDigest: health.dojoDecisionDigest || dojoProof.decisionDigest || null,
    authorizedAirspace: unique(asArray(health.authorizedAirspace)),
    requiredRadar: unique([
      ...asArray(health.requiredRadar),
      ...asArray(requestedLease?.requiredRadar),
    ]),
    earnedBy: unique([
      ...asArray(health.earnedBy),
      ...asArray(dojoProof.evidenceRefs),
    ]),
    reasonCodes: nextReasonCodes.length ? nextReasonCodes : health.reasonCodes,
    evidenceRefs: unique([...asArray(health.evidenceRefs), ...proofEvidence]),
    lifecycle: {
      ...health.lifecycle,
      checkedAt: new Date().toISOString(),
      clearanceProofCheckedAt: dojoProof.verification?.checkedAt || null,
    },
  };
}

function sessionRecords(project) {
  const byKey = new Map();
  for (const session of asArray(project.agentSessions).map(normalizeSession)) {
    byKey.set(sessionKey(session), session);
  }
  for (const lease of asArray(project.mutationLeases).map(normalizeLease)) {
    const key = lease.agentSessionId || `callsign:${lease.displayCallsign}`;
    if (!key || byKey.has(key)) continue;
    byKey.set(key, normalizeSession({
      id: lease.agentSessionId || null,
      projectId: lease.projectId,
      displayCallsign: lease.displayCallsign,
      dojoPilotLicenseRef: lease.dojoLicenseRef,
      dojoProofRef: lease.dojoProofRef,
      dojoEvidenceRefs: lease.dojoEvidenceRefs,
      dojoDecisionDigest: lease.dojoDecisionDigest,
    }));
  }
  return [...byKey.values()];
}

function normalizeSession(session = {}) {
  return {
    ...session,
    id: session.id || session.agentSessionId || null,
    displayCallsign: session.displayCallsign || session.display_callsign || null,
    dojoPilotLicenseRef: session.dojoPilotLicenseRef || session.dojo_pilot_license_ref || null,
    dojoLicenseRef: session.dojoLicenseRef || session.dojo_license_ref || null,
    dojoProofRef: session.dojoProofRef || session.dojo_proof_ref || null,
    dojoEvidenceRefs: asArray(session.dojoEvidenceRefs || session.dojo_evidence_refs || parseJson(session.dojoEvidenceRefsJson, [])),
    dojoDecisionDigest: session.dojoDecisionDigest || session.dojo_decision_digest || null,
    pilotLicenseSnapshot: normalizeSnapshot(session.pilotLicenseSnapshot || session.pilot_license_snapshot || session.pilotLicenseSnapshotJson),
  };
}

function normalizeSnapshot(value) {
  const raw = parseJson(value, value && typeof value === 'object' ? value : {});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return {
    ...raw,
    licenseRef: firstValue(raw.licenseRef, raw.license_ref, raw.licenseId, raw.license_id, raw.licenseVersion, raw.license_version),
    licenseId: firstValue(raw.licenseId, raw.license_id),
    licenseVersion: firstValue(raw.licenseVersion, raw.license_version),
    licenseLevel: firstValue(raw.licenseLevel, raw.license_level, raw.level, raw.tier),
    licenseStatus: firstValue(raw.licenseStatus, raw.license_status),
    repoScope: firstValue(raw.repoScope, raw.repo_scope),
    authorizedAirspace: asArray(raw.authorizedAirspace || raw.authorized_airspace || raw.airspace || raw.authorizedPaths || raw.authorized_paths),
    authorizedPaths: asArray(raw.authorizedPaths || raw.authorized_paths),
    restrictedAirspace: asArray(raw.restrictedAirspace || raw.restricted_airspace || raw.restrictedPaths || raw.restricted_paths),
    requiredRadar: asArray(raw.requiredRadar || raw.required_radar),
    earnedBy: asArray(raw.earnedBy || raw.earned_by),
    evidenceRecordIds: asArray(raw.evidenceRecordIds || raw.evidence_record_ids),
    evidenceRefs: asArray(raw.evidenceRefs || raw.evidence_refs),
    expiresAt: firstValue(raw.expiresAt, raw.expires_at, raw.validUntil, raw.valid_until),
    expiryAt: firstValue(raw.expiryAt, raw.expiry_at),
    validUntil: firstValue(raw.validUntil, raw.valid_until),
    expiresOn: asArray(raw.expiresOn || raw.expires_on),
    expiryTriggers: asArray(raw.expiryTriggers || raw.expiry_triggers),
    sourceDigest: firstValue(raw.sourceDigest, raw.source_digest),
    sourceSnapshotDigest: firstValue(raw.sourceSnapshotDigest, raw.source_snapshot_digest),
    repoSourceDigest: firstValue(raw.repoSourceDigest, raw.repo_source_digest),
    policySourceDigest: firstValue(raw.policySourceDigest, raw.policy_source_digest),
    proofRef: firstValue(raw.proofRef, raw.proof_ref),
    issuedAt: firstValue(raw.issuedAt, raw.issued_at),
  };
}

function normalizeExecutionPlan(plan = {}) {
  return {
    ...plan,
    id: plan.id || null,
    agentSessionId: plan.agentSessionId || plan.agent_session_id || null,
    displayCallsign: plan.displayCallsign || plan.display_callsign || null,
    route: asArray(plan.route || parseJson(plan.routeJson, [])),
  };
}

function normalizeLease(lease = {}) {
  const leaseBody = lease.lease || parseJson(lease.leaseJson, {}) || {};
  return {
    ...lease,
    id: lease.id || null,
    projectId: lease.projectId || lease.project_id || null,
    executionPlanId: lease.executionPlanId || lease.execution_plan_id || null,
    agentSessionId: lease.agentSessionId || lease.agent_session_id || null,
    displayCallsign: lease.displayCallsign || lease.display_callsign || null,
    status: lease.status || null,
    lease: leaseBody,
    dojoProofRef: lease.dojoProofRef || lease.dojo_proof_ref || null,
    dojoLicenseRef: lease.dojoLicenseRef || lease.dojo_license_ref || null,
    dojoEvidenceRefs: asArray(lease.dojoEvidenceRefs || lease.dojo_evidence_refs || parseJson(lease.dojoEvidenceRefsJson, [])),
    dojoDecisionDigest: lease.dojoDecisionDigest || lease.dojo_decision_digest || null,
  };
}

function normalizeEvent(event = {}) {
  const details = event.details || parseJson(event.detailsJson, {}) || {};
  return {
    ...event,
    displayCallsign: event.displayCallsign || event.display_callsign || null,
    mutationLeaseId: event.mutationLeaseId || event.mutation_lease_id || null,
    actorId: event.actorId || event.actor_id || null,
    details,
    reasonCodes: unique([
      ...asArray(details.reasonCodes || details.reason_codes),
      ...asArray(details.decision?.reasonCodes || details.decision?.reason_codes),
      ...asArray(details.codesiteFsEvent?.details?.reasonCodes || details.codesiteFsEvent?.details?.reason_codes),
    ]),
    evidenceRefs: asArray(event.evidenceRefs || event.evidence_refs || details.evidenceRefs || details.evidence_refs),
    createdAt: event.createdAt || event.created_at || null,
  };
}

function normalizePolicyDecision(decision = {}) {
  const body = decision.decisionBody || decision.decisionJson || parseJson(decision.decisionJson, {}) || {};
  return {
    ...decision,
    id: decision.id || null,
    mutationLeaseId: decision.mutationLeaseId || decision.mutation_lease_id || null,
    displayCallsign: decision.displayCallsign || decision.display_callsign || null,
    decision: decision.decision || body.decision || null,
    reasonCodes: asArray(decision.reasonCodes || parseJson(decision.reasonCodesJson, [])),
    decisionBody: body,
    createdAt: decision.createdAt || decision.created_at || null,
  };
}

function normalizeInspectionRun(run = {}) {
  return {
    ...run,
    id: run.id || null,
    executionPlanId: run.executionPlanId || run.execution_plan_id || null,
    displayCallsign: run.displayCallsign || run.display_callsign || null,
    status: run.status || null,
    inspectionSignals: asArray(run.inspectionSignals || run.inspection_signals || parseJson(run.inspectionSignalsJson, [])),
    evidenceRefs: asArray(run.evidenceRefs || run.evidence_refs || parseJson(run.evidenceRefsJson, [])),
    requestedAt: run.requestedAt || run.requested_at || null,
    completedAt: run.completedAt || run.completed_at || null,
  };
}

function normalizeIncident(incident = {}) {
  return {
    ...incident,
    category: incident.category || null,
    severity: incident.severity || null,
    participants: asArray(incident.participants || parseJson(incident.participantsJson, [])),
    affectedZones: asArray(incident.affectedZones || parseJson(incident.affectedZonesJson, [])),
    evidenceRefs: asArray(incident.evidenceRefs || parseJson(incident.evidenceRefsJson, [])),
    createdAt: incident.createdAt || incident.created_at || null,
  };
}

function relatedExecutionPlans(plans, session) {
  return asArray(plans).filter((plan) => (
    (session.id && plan.agentSessionId === session.id)
    || (session.displayCallsign && plan.displayCallsign === session.displayCallsign)
  ));
}

function relatedLeasesForSession(leases, session) {
  return asArray(leases).filter((lease) => (
    (session.id && lease.agentSessionId === session.id)
    || (session.displayCallsign && lease.displayCallsign === session.displayCallsign)
  ));
}

function relatedInspectionRuns(runs, session, plans) {
  const planIds = new Set(asArray(plans).map((plan) => plan.id).filter(Boolean));
  return asArray(runs).filter((run) => (
    (run.executionPlanId && planIds.has(run.executionPlanId))
    || (session.displayCallsign && run.displayCallsign === session.displayCallsign)
  ));
}

function relatedEventsForSession(events, session, leases, plans) {
  const leaseIds = new Set(asArray(leases).map((lease) => lease.id).filter(Boolean));
  const planIds = new Set(asArray(plans).map((plan) => plan.id).filter(Boolean));
  return asArray(events).filter((event) => (
    (session.displayCallsign && event.displayCallsign === session.displayCallsign)
    || (event.mutationLeaseId && leaseIds.has(event.mutationLeaseId))
    || (event.details?.executionPlanId && planIds.has(event.details.executionPlanId))
    || (event.details?.execution_plan_id && planIds.has(event.details.execution_plan_id))
  ));
}

function relatedPolicyDecisions(decisions, session, leases) {
  const leaseIds = new Set(asArray(leases).map((lease) => lease.id).filter(Boolean));
  const sessionIds = new Set([
    session.id,
    ...asArray(leases).map((lease) => lease.agentSessionId),
  ].filter(Boolean));
  const callsigns = new Set([
    session.displayCallsign,
    ...asArray(leases).map((lease) => lease.displayCallsign),
  ].filter(Boolean));
  return asArray(decisions).filter((decision) => (
    (decision.mutationLeaseId && leaseIds.has(decision.mutationLeaseId))
    || (decision.decisionBody?.mutationLeaseId && leaseIds.has(decision.decisionBody.mutationLeaseId))
    || (decision.displayCallsign && callsigns.has(decision.displayCallsign))
    || (decision.decisionBody?.displayCallsign && callsigns.has(decision.decisionBody.displayCallsign))
    || (decision.decisionBody?.callsign && callsigns.has(decision.decisionBody.callsign))
    || (decision.decisionBody?.pilotLicenseHealth?.agentSessionId && sessionIds.has(decision.decisionBody.pilotLicenseHealth.agentSessionId))
    || (decision.decisionBody?.pilotLicenseHealth?.key && sessionIds.has(decision.decisionBody.pilotLicenseHealth.key))
    || (decision.decisionBody?.pilotLicenseHealth?.displayCallsign && callsigns.has(decision.decisionBody.pilotLicenseHealth.displayCallsign))
  ));
}

function relatedIncidentsForSession(incidents, session) {
  return asArray(incidents).filter((incident) => (
    asArray(incident.participants).includes(session.displayCallsign)
    || asArray(incident.participants).includes(session.id)
  ));
}

function landingStatsFor(runs) {
  const failed = asArray(runs).filter(inspectionFailed);
  const passed = asArray(runs).filter((run) => !inspectionFailed(run) && String(run.status || '').toLowerCase() === 'passed');
  return {
    total: asArray(runs).length,
    passed: passed.length,
    failed: failed.length,
    evidenceRefs: unique(asArray(runs).flatMap((run) => asArray(run.evidenceRefs))),
  };
}

function violationStatsFor({ events, policyDecisions, incidents }) {
  const eventViolations = asArray(events)
    .filter((event) => ['write_denied', 'ground_stop', 'near_miss'].includes(event.eventType)
      || asArray(event.reasonCodes).some(isCriticalViolationCode));
  const decisionViolations = asArray(policyDecisions)
    .filter((decision) => isPilotLicenseViolationDecision(decision) || isNoFlyBlockDecision(decision));
  const incidentViolations = asArray(incidents)
    .filter((incident) => ['critical', 'high'].includes(String(incident.severity || '').toLowerCase())
      || /mayday|security|near_miss|ground/i.test(String(incident.category || '')));
  const all = [...eventViolations, ...decisionViolations, ...incidentViolations];
  const critical = all.filter((item) => {
    const text = stableJson([
      item.eventType,
      item.category,
      item.severity,
      item.reasonCodes,
      item.details,
    ]);
    return CRITICAL_VIOLATION_PATTERNS.some((pattern) => pattern.test(text));
  });
  return {
    total: all.length,
    critical: critical.length,
    latestAt: all.map((item) => item.createdAt).filter(Boolean).sort().at(-1) || null,
    evidenceRefs: unique(all.flatMap((item) => asArray(item.evidenceRefs || (item.id ? [`codesite:${item.id}`] : [])))),
  };
}

function inspectionFailed(run) {
  const status = String(run?.status || '').toLowerCase();
  return ['failed', 'failure', 'blocked', 'go_around', 'red'].includes(status)
    || asArray(run?.inspectionSignals).some((signal) => ['failed', 'failure', 'blocked', 'red', 'error'].includes(String(signal?.status || signal?.result || '').toLowerCase()));
}

function inferLicenseLevel(snapshot = {}, licenseRef = null) {
  const explicit = normalizeLevelName(snapshot.licenseLevel);
  if (explicit) return explicit;
  const numericLevelInput = firstValue(snapshot.level, snapshot.licenseLevel);
  if (numericLevelInput !== null) {
    const numericLevel = Number(numericLevelInput);
    if (Number.isFinite(numericLevel)) {
      if (numericLevel <= 0) return 'Grounded';
      if (numericLevel === 1) return 'VFR';
      if (numericLevel === 2) return 'IFR';
      if (numericLevel === 3) return 'Type-rated';
      return 'Captain';
    }
  }
  const ref = String(licenseRef || '').toLowerCase();
  const levelMatch = ref.match(/level[_-]?(\d+)/);
  if (levelMatch) {
    const level = Number(levelMatch[1]);
    if (level <= 0) return 'Grounded';
    if (level === 1) return 'VFR';
    if (level === 2) return 'IFR';
    if (level === 3) return 'Type-rated';
    return 'Captain';
  }
  if (ref.includes('captain')) return 'Captain';
  if (ref.includes('type') || ref.includes('class_a')) return 'Type-rated';
  if (ref.includes('ifr') || ref.includes('schema')) return 'IFR';
  if (ref.includes('vfr')) return 'VFR';
  return licenseRef || hasMeaningfulSnapshot(snapshot) ? 'Student' : 'Student';
}

function normalizeLevelName(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (!normalized) return null;
  if (normalized === 'type-rated' || normalized === 'type rated') return 'Type-rated';
  const match = LEVEL_ORDER.find((level) => level.toLowerCase() === normalized);
  return match || null;
}

function rankForLevel(level) {
  const normalized = String(level || 'Student').trim().toLowerCase().replace(/\s+/g, '-');
  return LEVEL_RANK[normalized] ?? LEVEL_RANK[normalized.replace(/-/g, '_')] ?? LEVEL_RANK.student;
}

function isGrounded(status, level) {
  return ['grounded', 'revoked', 'suspended_grounded'].includes(status) || rankForLevel(level) === 0;
}

function isExpired(snapshot, now) {
  const expiresAt = firstValue(snapshot.expiresAt, snapshot.expiryAt, snapshot.validUntil);
  if (!expiresAt) return false;
  const expiryMs = Date.parse(expiresAt);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  return Number.isFinite(expiryMs) && Number.isFinite(nowMs) && expiryMs <= nowMs;
}

function requiredActionForStatus(status, session, reasonCodes) {
  if (status === 'active') return null;
  if (status === 'unlicensed') return null;
  const key = session.id || session.displayCallsign || 'unknown';
  if (reasonCodes.includes('pilot_license_source_drift_expired')) return `renew_pilot_license_source:${key}`;
  if (status === 'suspended') return `review_pilot_license:${key}`;
  if (status === 'expired') return `renew_pilot_license:${key}`;
  if (status === 'grounded') return `recertify_pilot_license:${key}`;
  return null;
}

function hasMeaningfulSnapshot(snapshot) {
  return Boolean(snapshot && typeof snapshot === 'object' && Object.keys(snapshot).length);
}

function sourceDigestForZonePolicy(zonePolicy = {}) {
  return firstValue(
    zonePolicy.compiler?.sourceDigest,
    zonePolicy.compiler?.source_digest,
    zonePolicy.semanticGraph?.sourceDigest,
    zonePolicy.semanticGraph?.source_digest,
    zonePolicy.sourceDigest,
    zonePolicy.source_digest,
  );
}

function ensureSession(sessions, session) {
  const values = asArray(sessions);
  if (!session) return values;
  const normalized = normalizeSession(session);
  const key = sessionKey(normalized);
  if (values.some((item) => sessionKey(normalizeSession(item)) === key)) return values;
  return [...values, normalized];
}

function ensureExecutionPlan(plans, plan) {
  const values = asArray(plans);
  if (!plan) return values;
  const normalized = normalizeExecutionPlan(plan);
  if (values.some((item) => normalizeExecutionPlan(item).id === normalized.id)) return values;
  return [...values, normalized];
}

function sessionKey(session) {
  return session?.id || `callsign:${session?.displayCallsign || 'unknown'}`;
}

function isCriticalViolationCode(code) {
  return CRITICAL_VIOLATION_PATTERNS.some((pattern) => pattern.test(String(code || '')));
}

function isPilotLicenseViolationDecision(decision) {
  const healthStatus = String(decision?.decisionBody?.pilotLicenseHealth?.status || '').toLowerCase();
  if (VIOLATION_HEALTH_STATUSES.has(healthStatus)) return true;
  const hasUnhealthyReason = asArray(decision?.reasonCodes)
    .some((code) => PILOT_LICENSE_VIOLATION_REASON_RE.test(String(code)));
  if (!hasUnhealthyReason) return false;
  const decisionStatus = String(decision?.decision || decision?.decisionBody?.status || '').toLowerCase();
  if (!decisionStatus) return true;
  return BLOCKING_DECISION_STATUSES.has(decisionStatus);
}

function isNoFlyBlockDecision(decision) {
  const hasNoFlyReason = asArray(decision?.reasonCodes)
    .some((code) => /entered_no_fly_zone|no_fly/i.test(String(code)));
  if (!hasNoFlyReason) return false;
  const decisionStatus = String(decision?.decision || decision?.decisionBody?.status || '').toLowerCase();
  if (!decisionStatus) return true;
  return BLOCKING_DECISION_STATUSES.has(decisionStatus);
}

function pathsOverlap(left, right) {
  if (left === right) return true;
  const leftRoot = String(left || '').split('*')[0].replace(/\\/g, '/').replace(/\/+$/, '');
  const rightRoot = String(right || '').split('*')[0].replace(/\\/g, '/').replace(/\/+$/, '');
  if (!leftRoot || !rightRoot) return true;
  return leftRoot.startsWith(rightRoot) || rightRoot.startsWith(leftRoot);
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') ?? null;
}

function countBy(values, keyFn) {
  const counts = {};
  for (const value of asArray(values)) {
    const key = keyFn(value);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function unique(values) {
  return [...new Set(asArray(values).flat().filter((value) => value !== undefined && value !== null && value !== '').map((value) => String(value)))];
}
