import { createHash } from 'crypto';
import prisma from '@/lib/prisma';
import { CODE_SITE_EVENT_TYPES, compileZonePolicy, matchPathPattern, normalizePath } from './policy';
import { asArray, parseJson, stableJson } from './json';

const PROMOTED_POLICY_DELTA_STATES = new Set(['promoted', 'accepted', 'active', 'validated']);
const MINIMUM_PUBLISHED_CONFIDENCE = 0.65;
const MAX_ADVISORY_RADAR_AND_ACTIONS = 12;
// Local ingest decisions. Only ADOPTED advisories ever reach the clearance
// gate; muted/dismissed additionally leave the default visibility list.
const NOTAM_DECISION_ACTIONS = new Map([
  ['adopt', 'adopted'],
  ['mute', 'muted'],
  ['dismiss', 'dismissed'],
  ['reactivate', 'unreviewed'],
]);
const VISIBILITY_HIDDEN_STATES = new Set(['muted', 'dismissed']);

export function canonicalNotamPayload(input = {}) {
  return stableJson({
    sourcePolicyDeltaId: String(input.sourcePolicyDeltaId || ''),
    projectId: String(input.projectId || ''),
    workspaceSlug: String(input.workspaceSlug || ''),
    ruleCandidate: input.ruleCandidate ?? null,
    triggerConditions: input.triggerConditions ?? [],
    affectedZoneKey: input.affectedZoneKey ?? null,
    affectedRoutes: input.affectedRoutes ?? [],
    confidence: Number(input.confidence),
    expectedRiskReduction: input.expectedRiskReduction == null ? null : Number(input.expectedRiskReduction),
  });
}

export function notamAdvisoryKey(payload) {
  return `notam_${notamDigest(payload).slice(0, 16)}`;
}

export function notamDigest(payload) {
  return sha256(canonicalNotamPayload(payload));
}

/**
 * Integrity check over the stored columns. A notam whose canonical payload no
 * longer hashes to its stored digest is corrupt: it is suppressed everywhere
 * and never trusted.
 */
export function verifyNotamIntegrity(notam) {
  try {
    return notamDigest({
      sourcePolicyDeltaId: notam.sourcePolicyDeltaId,
      projectId: notam.projectId,
      workspaceSlug: notam.workspaceSlug,
      ruleCandidate: parseJson(notam.ruleCandidateJson, null),
      triggerConditions: parseJson(notam.triggerConditionsJson, []),
      affectedZoneKey: notam.affectedZoneKey,
      affectedRoutes: parseJson(notam.affectedRoutesJson, []),
      confidence: notam.confidence,
      expectedRiskReduction: notam.expectedRiskReduction,
    }) === notam.digestSha256;
  } catch (_) {
    return false;
  }
}

export async function publishFleetNotam(workspaceSlug, projectId, body = {}, actor = null) {
  const project = await requireProjectWithAccess(workspaceSlug, projectId, actor, 'write');

  const sourcePolicyDeltaId = String(body.policyDeltaId || body.policy_delta_id || '');
  if (!sourcePolicyDeltaId) throw badRequest('policy_delta_required');
  const sourcePolicyDelta = await prisma.codeSitePolicyDelta.findFirst({
    where: { id: sourcePolicyDeltaId },
  });
  if (!sourcePolicyDelta || sourcePolicyDelta.projectId !== projectId) {
    // Distinct failure mode: the delta either does not exist or belongs to a
    // different project — cross-project publication is forbidden.
    throw notFound('fleet_notam_source_delta_not_in_project');
  }
  if (!PROMOTED_POLICY_DELTA_STATES.has(sourcePolicyDelta.promotionState)
    || Number(sourcePolicyDelta.confidence) < MINIMUM_PUBLISHED_CONFIDENCE) {
    // Fail closed: only promoted, evidence-backed deltas may become fleet
    // advisories. Weak or unreviewed signals never broadcast.
    throw badRequest('fleet_notam_source_not_promoted');
  }

  const ruleCandidate = parseJson(sourcePolicyDelta.ruleCandidateJson, {});
  const affectedRoutes = asArray(ruleCandidate?.affectedRoutes).map(String).filter(Boolean);
  const triggerConditions = asArray(parseJson(sourcePolicyDelta.triggerConditionsJson, []));
  const payload = {
    sourcePolicyDeltaId,
    projectId,
    workspaceSlug,
    ruleCandidate,
    triggerConditions,
    affectedZoneKey: sourcePolicyDelta.affectedZoneKey || null,
    affectedRoutes,
    confidence: sourcePolicyDelta.confidence,
    expectedRiskReduction: sourcePolicyDelta.expectedRiskReduction ?? null,
  };
  const advisoryKey = notamAdvisoryKey(payload);
  const existing = await prisma.codeSiteFleetNotam.findUnique({
    where: { projectId_advisoryKey: { projectId, advisoryKey } },
  });
  if (existing && existing.status !== 'withdrawn') {
    return { ...fleetNotamProjection(existing, existing.ingestStates?.[0] || null), alreadyPublished: true };
  }

  const data = {
    projectId,
    workspaceSlug,
    sourcePolicyDeltaId,
    advisoryKey,
    title: String(body.title || body.summary || ruleCandidate?.title || ruleCandidate?.rule || 'Fleet advisory'),
    summary: String(body.summary || ruleCandidate?.summary || ruleCandidate?.instruction || ''),
    affectedZoneKey: payload.affectedZoneKey,
    affectedRoutesJson: JSON.stringify(affectedRoutes),
    triggerConditionsJson: JSON.stringify(triggerConditions),
    ruleCandidateJson: JSON.stringify(ruleCandidate),
    confidence: Number(payload.confidence),
    expectedRiskReduction: payload.expectedRiskReduction,
    digestSha256: notamDigest(payload),
    expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
  };
  let notam;
  let lostPublishRace = false;
  if (existing) {
    notam = await prisma.codeSiteFleetNotam.update({ where: { id: existing.id }, data });
  } else {
    try {
      notam = await prisma.codeSiteFleetNotam.create({ data });
    } catch (error) {
      if (error?.code !== 'P2002') throw error;
      notam = await prisma.codeSiteFleetNotam.findUnique({
        where: { projectId_advisoryKey: { projectId, advisoryKey } },
      });
      if (!notam) throw error;
      lostPublishRace = true;
    }
  }
  if (lostPublishRace) {
    return { ...fleetNotamProjection(notam), alreadyPublished: true };
  }
  try {
    await recordFleetEvent(projectId, {
      eventType: 'fleet_notam_published',
      actorType: actorTypeFor(actor),
      actorId: decisionActor(actor),
      details: {
        notamId: notam.id,
        advisoryKey,
        sourcePolicyDeltaId,
        digest: notam.digestSha256,
      },
    });
  } catch (error) {
    await delay(25);
    try {
      await recordFleetEvent(projectId, {
        eventType: 'fleet_notam_published',
        actorType: actorTypeFor(actor),
        actorId: decisionActor(actor),
        details: {
          notamId: notam.id,
          advisoryKey,
          sourcePolicyDeltaId,
          digest: notam.digestSha256,
        },
      });
    } catch {
      const uncommittedError = new Error('fleet_notam_event_uncommitted');
      uncommittedError.status = 500;
      uncommittedError.code = 'fleet_notam_event_uncommitted';
      uncommittedError.cause = error;
      throw uncommittedError;
    }
  }
  return fleetNotamProjection(notam);
}

/**
 * VISIBILITY plane. Every active, unexpired advisory from other projects is
 * returned here regardless of any local decision — visibility costs nothing
 * and requires no approval. This function never feeds clearance decisions.
 */
export async function listFleetNotamsForProject(workspaceSlug, projectId, options = {}, actor = null) {
  const project = await requireProjectWithAccess(workspaceSlug, projectId, actor, 'read');
  const includeOwn = options.include_own === true || options.includeOwn === true;
  const includeMuted = options.include_muted === true || options.includeMuted === true;
  const routeFilter = normalizeRouteInput(options.route);
  const notams = await prisma.codeSiteFleetNotam.findMany({
    where: {
      workspaceSlug,
      status: 'active',
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      ...(includeOwn ? {} : { projectId: { not: project.id } }),
    },
    include: { ingestStates: { where: { projectId: project.id } } },
    orderBy: [{ publishedAt: 'asc' }, { id: 'asc' }],
  });

  const advisories = [];
  let suppressed = 0;
  for (const notam of notams) {
    const ingestState = notam.ingestStates[0] || null;
    if (!includeMuted && VISIBILITY_HIDDEN_STATES.has(ingestState?.state)) continue;
    if (!verifyNotamIntegrity(notam)) {
      suppressed += 1;
      continue;
    }
    if (routeFilter.length && !routeMatches(affectedRoutesOf(notam), routeFilter)) continue;
    advisories.push(fleetNotamProjection(notam, ingestState));
  }
  return { advisories, suppressed };
}

/**
 * Local sovereignty surface. Adopting is a write action by this project's own
 * writers; it only ever touches THIS project's ingest row and audit trail.
 */
export async function decideFleetNotam(workspaceSlug, projectId, notamId, body = {}, actor = null) {
  const action = String(body.state || '').trim().toLowerCase();
  if (!NOTAM_DECISION_ACTIONS.has(action)) throw badRequest('fleet_notam_decision_invalid');
  const state = NOTAM_DECISION_ACTIONS.get(action);
  const project = await requireProjectWithAccess(workspaceSlug, projectId, actor, 'write');
  const notam = await prisma.codeSiteFleetNotam.findFirst({
    where: { id: String(notamId || ''), workspaceSlug },
  });
  if (!notam) throw notFound('fleet_notam_not_found');

  const decidedAt = state === 'unreviewed' ? null : new Date();
  const reason = body.reason == null ? null : String(body.reason);
  const ingestState = await prisma.codeSiteNotamIngestState.upsert({
    where: { notamId_projectId: { notamId: notam.id, projectId: project.id } },
    create: {
      notamId: notam.id,
      projectId: project.id,
      workspaceSlug,
      state,
      decidedBy: decisionActor(actor),
      decidedAt,
      reason,
    },
    update: { state, decidedBy: decisionActor(actor), decidedAt, reason },
  });
  await recordFleetEvent(project.id, {
    eventType: `fleet_notam_${action}`,
    actorType: actorTypeFor(actor),
    actorId: decisionActor(actor),
    details: { notamId: notam.id, state, reason },
  });
  return {
    notamId: notam.id,
    projectId: project.id,
    state: ingestState.state,
    decidedBy: ingestState.decidedBy,
    decidedAt: ingestState.decidedAt,
  };
}

/**
 * EFFECT plane. Structurally separated from visibility: the where-clause below
 * selects ONLY advisories this project has explicitly adopted. Un-adopted
 * (unreviewed/muted/dismissed) advisories cannot reach clearance decisions by
 * construction, not by post-filtering. Advisories never block — they add
 * required radar, tower actions, and audited reason codes only.
 */
export async function fleetNotamClearanceGate({
  workspaceSlug,
  projectId,
  route,
  zonePolicy,
  events,
} = {}) {
  const emptyGate = {
    appliedNotams: [],
    reasonCodes: [],
    requiredRadar: [],
    requiredTowerActions: [],
    matchedRoutes: [],
    status: null,
    decision: null,
    towerInstruction: null,
  };
  if (!workspaceSlug || !projectId) return emptyGate;

  const requestRoute = normalizeRouteInput(route);
  const normalizedEvents = new Set(asArray(events).map(String).filter(Boolean));
  const zoneByKey = new Map(compileZonePolicy(zonePolicy || {}).zones.map((zone) => [zone.zoneKey, zone]));
  const candidates = await prisma.codeSiteFleetNotam.findMany({
    where: {
      workspaceSlug,
      status: 'active',
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      ingestStates: {
        some: { projectId, state: 'adopted' },
      },
    },
    include: { ingestStates: { where: { projectId } } },
    orderBy: [{ publishedAt: 'asc' }, { id: 'asc' }],
  });

  const matched = [];
  let suppressedCorrupt = 0;
  for (const notam of candidates) {
    if (!verifyNotamIntegrity(notam)) {
      suppressedCorrupt += 1;
      continue;
    }
    const zone = notam.affectedZoneKey ? zoneByKey.get(notam.affectedZoneKey) : null;
    if (routeMatches(affectedRoutesOf(notam), requestRoute)
      || eventMatches(parseJson(notam.triggerConditionsJson, []), normalizedEvents)
      || (zone && zoneIntersects(zone, requestRoute))) matched.push(notam);
  }
  if (!matched.length) {
    return {
      ...emptyGate,
      ...(suppressedCorrupt ? { reasonCodes: uniqueStrings(['fleet_notam_corrupt_suppressed']) } : {}),
    };
  }

  const capRaw = Number(process.env.SYNTHI_CODESITE_MAX_FLEET_NOTAMS_PER_ROUTE);
  const maxActive = Number.isFinite(capRaw) && capRaw > 0 ? Math.max(1, Math.floor(capRaw)) : 25;
  const applied = matched.slice(0, maxActive);
  const overflow = matched.length - applied.length;
  const requiredRadar = [];
  const requiredTowerActions = [];
  for (const notam of applied) {
    const ruleCandidate = parseJson(notam.ruleCandidateJson, {});
    requiredRadar.push(...['requiredRadar', 'required_radar', 'radar']
      .flatMap((field) => asArray(ruleCandidate?.[field])).map(String));
    requiredTowerActions.push(...['requiredTowerActions', 'required_tower_actions', 'actions']
      .flatMap((field) => asArray(ruleCandidate?.[field])).map(String));
  }
  const zoneKeys = uniqueStrings(applied
    .map((n) => n.affectedZoneKey)
    .filter((z) => typeof z === 'string' && z.trim()));
  return {
    appliedNotams: applied.map((notam) => notam.id).filter(Boolean),
    reasonCodes: uniqueStrings([
      'fleet_notam_enforced',
      ...applied.map((notam) => `fleet_notam:${notam.advisoryKey}`),
      ...(overflow > 0 ? [`fleet_notam_cap_truncated:${overflow}`] : []),
      ...(suppressedCorrupt ? ['fleet_notam_corrupt_suppressed'] : []),
    ]),
    requiredRadar: uniqueStrings(requiredRadar).slice(0, MAX_ADVISORY_RADAR_AND_ACTIONS),
    requiredTowerActions: uniqueStrings(requiredTowerActions).slice(0, MAX_ADVISORY_RADAR_AND_ACTIONS),
    matchedRoutes: [matchedRouteForNotams(applied, requestRoute)].filter(Boolean),
    status: 'enforced',
    decision: null,
    towerInstruction: `Adopted fleet advisories in effect: ${applied.length} NOTAM(s) overlap this route (${zoneKeys.length ? zoneKeys.join(', ') : 'unzoned'}). Required radar added before landing.`,
  };
}

/**
 * Compose the effect-plane gate into an existing policy decision.
 * Purely appendive: decisions are never changed or downgraded; only radar,
 * tower actions, reason codes, and the tower instruction are added.
 */
export function mergeFleetNotamGate(policy, gateResult = {}) {
  if (policy.decision === 'block' || !asArray(gateResult.appliedNotams).length) return policy;
  return {
    ...policy,
    reasonCodes: uniqueStrings([...asArray(policy.reasonCodes), ...asArray(gateResult.reasonCodes)]),
    requiredRadar: uniqueStrings([...asArray(policy.requiredRadar), ...asArray(gateResult.requiredRadar)]),
    requiredTowerActions: uniqueStrings([
      ...asArray(policy.requiredTowerActions),
      ...asArray(gateResult.requiredTowerActions),
    ]),
    towerInstruction: gateResult.towerInstruction || policy.towerInstruction,
    fleetNotamGate: gateResult,
  };
}

/**
 * VISIBILITY-only radar surfacing: shows what is visible vs how much is
 * locally adopted. Radar never claims enforcement for un-adopted advisories.
 */
export function mergeFleetNotamForecast(forecast, visibility = {}) {
  if (!forecast || !(Number(visibility.visibleCount) > 0)) return forecast;
  return {
    ...forecast,
    risks: [
      ...asArray(forecast.risks),
      {
        risk: 'fleet_notam_advisory',
        severity: 'low',
        aircraft: [],
        conflictZone: asArray(visibility.matchedRoutes)[0] || null,
        recommendedResolution: {
          action: 'review_fleet_notams',
          steps: [
            'Review fleet advisories overlapping this route',
            'Adopt locally to enforce required radar at clearance',
          ],
        },
        fleetNotams: asArray(visibility.appliedNotams),
        visibleCount: Number(visibility.visibleCount) || 0,
        adoptedCount: Number(visibility.adoptedCount) || 0,
      },
    ],
  };
}

function normalizeRouteInput(route) {
  return asArray(route)
    .map((pathValue) => normalizePath(typeof pathValue === 'string' ? pathValue : pathValue?.pattern))
    .filter(Boolean);
}

function affectedRoutesOf(notam) {
  return asArray(parseJson(notam.affectedRoutesJson, [])).map(String).filter(Boolean);
}

function actorTypeFor(actor) {
  if (actor?.bypass) return 'system';
  if (actor?.userId) return 'user';
  if (actor?.agentSessionId) return 'agent_session';
  return 'system';
}

function routeMatches(affectedRoutes, requestedRoute) {
  return affectedRoutes.some((affectedRoute) => requestedRoute.some((requestedPath) =>
    matchPathPattern(requestedPath, affectedRoute)
    || matchPathPattern(affectedRoute, requestedPath)
    || pathRootsOverlap(requestedPath, affectedRoute)));
}

function eventMatches(triggerConditions, normalizedEvents) {
  return triggerConditions.some((condition) => (
    condition && typeof condition === 'object'
    && condition.event != null
    && normalizedEvents.has(String(condition.event))
  ));
}

function matchedRouteForNotams(notams, requestedRoute) {
  for (const notam of notams) {
    const matchedRoute = affectedRoutesOf(notam).find((affectedRoute) => requestedRoute.some((requestedPath) =>
      matchPathPattern(requestedPath, affectedRoute)
      || matchPathPattern(affectedRoute, requestedPath)
      || pathRootsOverlap(requestedPath, affectedRoute)));
    if (matchedRoute) return matchedRoute;
  }
  return null;
}

function zoneIntersects(zone, requestedRoute) {
  return asArray(zone.paths).some((zonePath) => requestedRoute.some((requestedPath) =>
    matchPathPattern(requestedPath, zonePath)
    || matchPathPattern(zonePath, requestedPath)
    || pathRootsOverlap(requestedPath, zonePath)));
}

function pathRootsOverlap(left, right) {
  const leftRoot = left.split('*')[0].replace(/\/+$/, '');
  const rightRoot = right.split('*')[0].replace(/\/+$/, '');
  if (!leftRoot || !rightRoot) return true;
  return leftRoot.startsWith(rightRoot) || rightRoot.startsWith(leftRoot);
}

function fleetNotamProjection(notam, ingestState = null) {
  const state = ingestState?.state || 'unreviewed';
  return {
    notamId: notam.id,
    advisoryKey: notam.advisoryKey,
    originWorkspaceSlug: notam.workspaceSlug,
    originProjectId: notam.projectId,
    title: notam.title,
    summary: notam.summary,
    affectedZoneKey: notam.affectedZoneKey,
    affectedRoutes: affectedRoutesOf(notam),
    triggerConditions: asArray(parseJson(notam.triggerConditionsJson, [])),
    ruleCandidate: parseJson(notam.ruleCandidateJson, {}),
    confidence: notam.confidence,
    expectedRiskReduction: notam.expectedRiskReduction,
    publishedAt: notam.publishedAt,
    expiresAt: notam.expiresAt,
    digestSha256: notam.digestSha256,
    ingestState: state,
    locallyDecidedBy: ingestState?.decidedBy || null,
    locallyDecidedAt: ingestState?.decidedAt || null,
    effect: state === 'adopted' ? 'adopted' : 'visibility_only',
  };
}


/**
 * Audit-event persistence mirroring controlPlane.recordEvent: validates the
 * event type against the closed CodeSite set and stores a durable row.
 */
async function recordFleetEvent(projectId, input) {
  const eventType = String(input.eventType || '').trim();
  if (!CODE_SITE_EVENT_TYPES.includes(eventType)) {
    const error = new Error(`codesite_event_type_invalid:${eventType || 'missing'}`);
    error.code = 'CODESITE_EVENT_TYPE_INVALID';
    error.status = 422;
    throw error;
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const logicalTime = await prisma.codeSiteEvent.count({ where: { projectId } });
    try {
      return await prisma.codeSiteEvent.create({
        data: {
          projectId,
          mutationLeaseId: input.mutationLeaseId || null,
          eventType,
          displayCallsign: input.displayCallsign || null,
          actorType: input.actorType || null,
          actorId: input.actorId || null,
          detailsJson: JSON.stringify(input.details || {}),
          evidenceRefsJson: JSON.stringify(input.evidenceRefs || []),
          logicalTime: logicalTime + 1,
        },
      });
    } catch (error) {
      if (!String(error?.message || '').includes('Unique constraint')) throw error;
      const retryDelay = 25 * (2 ** attempt) + Math.floor(Math.random() * 40);
      await delay(retryDelay);
    }
  }
  throw new Error('codesite_event_logical_time_conflict');
}

function badRequest(code, detail) {
  const error = new Error(code);
  error.status = 400;
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function notFound(code) {
  const error = new Error(code);
  error.status = 404;
  error.code = code;
  return error;
}

/**
 * Project load + membership authorization. Mirrors controlPlane.requireProject:
 * fail-closed on missing project or insufficient role for the requested mode.
 */
async function requireProjectWithAccess(workspaceSlug, projectId, actor = null, mode = 'read') {
  const project = await prisma.codeSiteProject.findFirst({
    where: { id: String(projectId || ''), workspaceSlug },
    include: { members: true },
  });
  if (!project) throw notFound('project_not_found');
  if (actor?.bypass) return project;
  const userId = actor?.userId || actor?.workspaceUserId || actor?.id || null;
  if (userId && asArray(project.members).some((member) => (
    member.userId === userId
    && !member.revokedAt
    && member.participationStatus !== 'disabled'))) {
    return project;
  }
  // Workspace-level actors (e.g. workspace admins acting across projects)
  // pass through the route layer's requireCodesiteAccess; the project check
  // here guards project-scoped membership. Fail closed otherwise.
  if (actor?.internalService) return project;
  throw forbidden(mode === 'write' ? 'codesite_project_write_forbidden' : 'codesite_project_not_found');
}

function forbidden(code) {
  const error = new Error(code);
  error.status = 403;
  error.code = code;
  return error;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function uniqueStrings(values) {
  return [...new Set(asArray(values).map(String).filter(Boolean))];
}

function decisionActor(actor) {
  return actor?.userId || actor?.workspaceUserId || actor?.agentSessionId || actor?.id || null;
}
