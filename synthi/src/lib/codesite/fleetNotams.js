import { createHash } from 'crypto';
import prisma from '@/lib/prisma';
import {
  badRequest,
  notFound,
  requireProject,
  requireProjectAccess,
  recordEvent,
} from './controlPlane';
import {
  compileZonePolicy,
  matchPathPattern,
  normalizePath,
} from './policy';
import { asArray, parseJson, stableJson } from './json';
import { getCodeSiteRuntimeConfig } from './runtimeConfig';

const PROMOTED_POLICY_DELTA_STATES = new Set(['promoted', 'accepted', 'active', 'validated']);
const MINIMUM_PUBLISHED_CONFIDENCE = 0.65;
const MAX_ADVISORY_RADAR_AND_ACTIONS = 12;
const ACTIVE_NOTAM_STATUS = 'active';
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
  const project = await prisma.codeSiteProject.findFirst({
    where: { id: String(projectId || ''), workspaceSlug },
    include: { members: true },
  });
  if (!project) throw notFound('project_not_found');
  await requireProjectAccess(project, actor, 'write');

  return publishFleetNotamForProject(workspaceSlug, project, body, actor);
}

async function publishFleetNotamForProject(
  workspaceSlug,
  project,
  body = {},
  actor = null,
  { supersedesNotamId = null } = {},
) {
  const projectId = project.id;

  const sourcePolicyDeltaId = String(body.policyDeltaId || body.policy_delta_id || '');
  if (!sourcePolicyDeltaId) throw badRequest('policy_delta_required');
  const sourcePolicyDelta = await prisma.codeSitePolicyDelta.findFirst({
    where: { id: sourcePolicyDeltaId, projectId },
  });
  if (!sourcePolicyDelta
    || !PROMOTED_POLICY_DELTA_STATES.has(sourcePolicyDelta.promotionState)
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
  if (existing) {
    if (isNotamActive(existing)) {
      return {
        ...fleetNotamProjection(existing, existing.ingestStates?.[0] || null),
        alreadyPublished: true,
      };
    }
    throw badRequest('fleet_notam_republish_requires_new_source_delta', {
      notamId: existing.id,
      status: existing.status,
    });
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
    expiresAt: parseNotamExpiry(body.expiresAt || body.expires_at),
    supersedesNotamId,
  };
  let notam;
  try {
    notam = await prisma.codeSiteFleetNotam.create({ data });
  } catch (error) {
    // The unique advisory key is the idempotency boundary. Two concurrent
    // publish requests for the same promoted delta should both get the winner,
    // never a database error or a second audit event.
    if (!isNotamKeyConflict(error)) throw error;
    const winner = await prisma.codeSiteFleetNotam.findUnique({
      where: { projectId_advisoryKey: { projectId, advisoryKey } },
    });
    if (winner && isNotamActive(winner)) {
      return { ...fleetNotamProjection(winner), alreadyPublished: true };
    }
    throw error;
  }
  await recordPublishedFleetNotamEvent(projectId, {
    notamId: notam.id,
    advisoryKey,
    sourcePolicyDeltaId,
    digest: notam.digestSha256,
  }, actor);
  return { ...fleetNotamProjection(notam), alreadyPublished: false };
}

/**
 * An origin project can withdraw only its own active publication. Subscriber
 * decisions remain as historical local evidence, but a withdrawn publication
 * is excluded from visibility and clearance immediately.
 */
export async function withdrawFleetNotam(workspaceSlug, projectId, notamId, body = {}, actor = null) {
  const project = await requireProject(workspaceSlug, projectId, actor, 'write');
  const notam = await prisma.codeSiteFleetNotam.findFirst({
    where: { id: String(notamId || ''), projectId: project.id, workspaceSlug },
  });
  if (!notam) throw notFound('fleet_notam_not_found');
  if (notam.status === 'withdrawn') {
    return { ...fleetNotamProjection(notam), alreadyWithdrawn: true };
  }
  if (notam.status !== ACTIVE_NOTAM_STATUS) {
    throw badRequest('fleet_notam_not_active', { notamId: notam.id, status: notam.status });
  }

  const reason = notamLifecycleReason(body);
  const withdrawnAt = new Date();
  const updated = await prisma.codeSiteFleetNotam.update({
    where: { id: notam.id },
    data: {
      status: 'withdrawn',
      lifecycleChangedAt: withdrawnAt,
      lifecycleChangedBy: decisionActor(actor),
      lifecycleReason: reason,
    },
  });
  await recordEvent(project.id, {
    eventType: 'fleet_notam_withdrawn',
    actorType: actorTypeFor(actor),
    actorId: decisionActor(actor),
    details: { notamId: notam.id, advisoryKey: notam.advisoryKey, reason },
  });
  return fleetNotamProjection(updated);
}

/**
 * Replacing an advisory is intentionally explicit. A new promoted delta is
 * published first, then the old publication records the replacement's id.
 * Clearance can therefore never observe the old and new rules as one merged
 * policy: only the replacement remains active.
 */
export async function supersedeFleetNotam(workspaceSlug, projectId, notamId, body = {}, actor = null) {
  const project = await requireProject(workspaceSlug, projectId, actor, 'write');
  const previous = await prisma.codeSiteFleetNotam.findFirst({
    where: { id: String(notamId || ''), projectId: project.id, workspaceSlug },
  });
  if (!previous) throw notFound('fleet_notam_not_found');
  if (previous.status === 'superseded' && previous.supersededByNotamId) {
    return { ...fleetNotamProjection(previous), alreadySuperseded: true };
  }
  if (previous.status !== ACTIVE_NOTAM_STATUS) {
    throw badRequest('fleet_notam_not_active', { notamId: previous.id, status: previous.status });
  }

  const replacementDeltaId = String(body.policyDeltaId || body.policy_delta_id || '');
  if (!replacementDeltaId) throw badRequest('policy_delta_required');
  if (replacementDeltaId === previous.sourcePolicyDeltaId) {
    throw badRequest('fleet_notam_supersession_source_unchanged');
  }

  const replacement = await publishFleetNotamForProject(workspaceSlug, project, {
    ...body,
    policyDeltaId: replacementDeltaId,
  }, actor, { supersedesNotamId: previous.id });
  if (replacement.notamId === previous.id) {
    throw badRequest('fleet_notam_supersession_self_reference');
  }

  const reason = notamLifecycleReason(body);
  const supersededAt = new Date();
  const updated = await prisma.codeSiteFleetNotam.update({
    where: { id: previous.id },
    data: {
      status: 'superseded',
      supersededByNotamId: replacement.notamId,
      lifecycleChangedAt: supersededAt,
      lifecycleChangedBy: decisionActor(actor),
      lifecycleReason: reason,
    },
  });
  await recordEvent(project.id, {
    eventType: 'fleet_notam_superseded',
    actorType: actorTypeFor(actor),
    actorId: decisionActor(actor),
    details: {
      notamId: previous.id,
      replacementNotamId: replacement.notamId,
      replacementPolicyDeltaId: replacementDeltaId,
      reason,
    },
  });
  return {
    supersededNotam: fleetNotamProjection(updated),
    replacementNotam: replacement,
  };
}

/**
 * VISIBILITY plane. Every active, unexpired advisory from other projects is
 * returned here regardless of any local decision — visibility costs nothing
 * and requires no approval. This function never feeds clearance decisions.
 */
export async function listFleetNotamsForProject(workspaceSlug, projectId, options = {}, actor = null) {
  const project = await requireProject(workspaceSlug, projectId, actor, 'read');
  const includeOwn = options.include_own === true || options.includeOwn === true;
  const includeMuted = options.include_muted === true || options.includeMuted === true;
  const includeInactive = options.include_inactive === true || options.includeInactive === true;
  const routeFilter = normalizeRouteInput(options.route);
  const notams = await prisma.codeSiteFleetNotam.findMany({
    where: {
      workspaceSlug,
      ...(includeOwn ? {} : { projectId: { not: project.id } }),
      ...(includeInactive ? {} : {
        status: ACTIVE_NOTAM_STATUS,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      }),
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
  const project = await requireProject(workspaceSlug, projectId, actor, 'write');
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
  await recordEvent(project.id, {
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
      status: ACTIVE_NOTAM_STATUS,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      ingestStates: {
        some: { projectId, state: 'adopted' },
      },
    },
    include: { ingestStates: { where: { projectId } } },
    orderBy: [{ publishedAt: 'asc' }, { id: 'asc' }],
  }) || [];

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

  const maxActive = Math.max(1, Number(getCodeSiteRuntimeConfig().maxActiveFleetNotamsPerRoute) || 25);
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
  const zoneKeys = uniqueStrings(applied.map((notam) => notam.affectedZoneKey));
  return {
    appliedNotams: applied.map((notam) => notam.id).filter(Boolean),
    reasonCodes: uniqueStrings([
      'fleet_notam_enforced',
      ...applied.map((notam) => `fleet_notam:${notam.advisoryKey}`),
      ...(overflow > 0 ? ['fleet_notam_cap_truncated', `fleet_notam_cap_truncated:${overflow}`] : []),
      ...(suppressedCorrupt ? ['fleet_notam_corrupt_suppressed'] : []),
    ]),
    requiredRadar: uniqueStrings(requiredRadar).slice(0, MAX_ADVISORY_RADAR_AND_ACTIONS),
    requiredTowerActions: uniqueStrings(requiredTowerActions).slice(0, MAX_ADVISORY_RADAR_AND_ACTIONS),
    matchedRoutes: [matchedRouteForNotams(applied, requestRoute)].filter(Boolean),
    status: 'enforced',
    decision: null,
    towerInstruction: `Adopted fleet advisories in effect: ${applied.length} NOTAM(s) overlap this route (${zoneKeys.join(', ')}). Required radar added before landing.`,
  };
}

/**
 * Compose the effect-plane gate into an existing policy decision.
 * Purely appendive: decisions are never changed or downgraded; only radar,
 * tower actions, reason codes, and the tower instruction are added.
 */
export function mergeFleetNotamGate(policy, gateResult = {}) {
  if (!asArray(gateResult.appliedNotams).length) return policy;
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
    sourcePolicyDeltaId: notam.sourcePolicyDeltaId,
    originWorkspaceSlug: notam.workspaceSlug,
    originProjectId: notam.projectId,
    status: notam.status,
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
    supersedesNotamId: notam.supersedesNotamId || null,
    supersededByNotamId: notam.supersededByNotamId || null,
    lifecycleChangedAt: notam.lifecycleChangedAt || null,
    lifecycleChangedBy: notam.lifecycleChangedBy || null,
    lifecycleReason: notam.lifecycleReason || null,
    ingestState: state,
    locallyDecidedBy: ingestState?.decidedBy || null,
    locallyDecidedAt: ingestState?.decidedAt || null,
    locallyDecisionReason: ingestState?.reason || null,
    effect: state === 'adopted' && isNotamActive(notam) ? 'adopted' : 'visibility_only',
  };
}

function parseNotamExpiry(value) {
  if (value == null || String(value).trim() === '') return null;
  const expiresAt = new Date(value);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw badRequest('fleet_notam_expiry_invalid');
  }
  return expiresAt;
}

function notamLifecycleReason(body = {}) {
  const reason = body.reason == null ? '' : String(body.reason).trim();
  if (reason.length > 2_000) throw badRequest('fleet_notam_lifecycle_reason_too_long');
  return reason || null;
}

function isNotamActive(notam) {
  if (notam?.status !== ACTIVE_NOTAM_STATUS) return false;
  const expiresAt = notam?.expiresAt ? new Date(notam.expiresAt).getTime() : null;
  return expiresAt == null || (Number.isFinite(expiresAt) && expiresAt > Date.now());
}

function isNotamKeyConflict(error) {
  if (error?.code !== 'P2002') return false;
  const targetValue = error?.meta?.target;
  const target = Array.isArray(targetValue) ? targetValue.join(',') : String(targetValue || '');
  return !target || target.includes('projectId_advisoryKey')
    || (target.includes('projectId') && target.includes('advisoryKey'));
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

async function recordPublishedFleetNotamEvent(projectId, details, actor) {
  const input = {
    eventType: 'fleet_notam_published',
    actorType: actorTypeFor(actor),
    actorId: decisionActor(actor),
    details,
  };
  try {
    await recordEvent(projectId, input);
  } catch (firstError) {
    // recordEvent already retries the per-project logical clock. A separate
    // attempt after yielding gives simultaneously published distinct NOTAMs a
    // fresh clock snapshot, while preserving the exact same audit payload.
    await new Promise((resolve) => setTimeout(resolve, 25));
    try {
      await recordEvent(projectId, input);
    } catch (retryError) {
      const error = new Error('fleet_notam_event_uncommitted');
      error.status = 500;
      error.code = 'fleet_notam_event_uncommitted';
      error.detail = {
        notamId: details.notamId,
        firstFailure: firstError?.code || firstError?.message || null,
        retryFailure: retryError?.code || retryError?.message || null,
      };
      throw error;
    }
  }
}
