const BASE = '/api/workspace';

async function parseJson(response) {
  return response.json().catch(() => ({}));
}

async function request(path, init = {}) {
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const body = await parseJson(response);

  if (!response.ok) {
    const error = new Error(body?.error || `codesite_request_failed_${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

function uniqueValues(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean).map((value) => String(value)))];
}

function codeSiteBase(workspaceSlug) {
  return `${BASE}/${encodeURIComponent(workspaceSlug)}/codesite`;
}

function projectBase(workspaceSlug, projectId) {
  return `${codeSiteBase(workspaceSlug)}/projects/${encodeURIComponent(projectId)}`;
}

export function createEmptyCodeSiteRadarState(workspaceSlug = '') {
  return {
    workspaceSlug,
    projects: [],
    project: null,
    controlState: null,
    metrics: null,
    events: [],
    quarantines: [],
    quarantineError: null,
    artifactPreview: null,
    selectedProjectId: null,
    counts: {
      projects: 0,
      activeFlights: 0,
      activeMutationLeases: 0,
      activeTransactions: 0,
      requiredActions: 0,
      events: 0,
      proofBundles: 0,
      incidents: 0,
      inspectionRuns: 0,
      quarantines: 0,
    },
    collisionForecast: {
      riskLevel: 'unknown',
      risks: [],
      runwayOccupancy: [],
      wakeTurbulence: [],
    },
  };
}

export function normalizeCodeSiteRadarState({
  workspaceSlug = '',
  projects = [],
  project = null,
  controlState = null,
  metrics = null,
  events = [],
  quarantines = [],
  quarantineError = null,
  artifactPreview = null,
  selectedProjectId = null,
} = {}) {
  const normalizedProjects = Array.isArray(projects) ? projects.filter(Boolean) : [];
  const normalizedEvents = Array.isArray(events) ? events.filter(Boolean) : [];
  const normalizedQuarantines = Array.isArray(quarantines) ? quarantines.filter(Boolean) : [];
  const normalizedControl = controlState || null;
  const normalizedProject = project || null;
  const forecast = normalizedControl?.collisionForecast || { riskLevel: 'unknown', risks: [] };

  return {
    workspaceSlug,
    projects: normalizedProjects,
    project: normalizedProject,
    controlState: normalizedControl,
    metrics,
    events: normalizedEvents,
    quarantines: normalizedQuarantines,
    quarantineError,
    artifactPreview,
    selectedProjectId: selectedProjectId || normalizedProject?.id || normalizedControl?.projectId || normalizedProjects[0]?.id || null,
    counts: {
      projects: normalizedProjects.length,
      activeFlights: normalizedControl?.activeFlights?.length || 0,
      activeMutationLeases: normalizedControl?.activeMutationLeases?.length || 0,
      activeTransactions: normalizedControl?.activeTransactions?.length || 0,
      requiredActions: normalizedControl?.requiredActions?.length || 0,
      events: normalizedEvents.length || normalizedProject?.events?.length || 0,
      proofBundles: normalizedProject?.proofBundles?.length || 0,
      incidents: normalizedProject?.incidents?.length || 0,
      inspectionRuns: normalizedProject?.inspectionRuns?.length || 0,
      quarantines: normalizedQuarantines.length,
    },
    collisionForecast: {
      ...forecast,
      risks: Array.isArray(forecast?.risks) ? forecast.risks : [],
      runwayOccupancy: Array.isArray(forecast?.runwayOccupancy) ? forecast.runwayOccupancy : [],
      wakeTurbulence: Array.isArray(forecast?.wakeTurbulence) ? forecast.wakeTurbulence : [],
    },
  };
}

export async function fetchCodeSiteProjects(workspaceSlug) {
  if (!workspaceSlug) return [];
  const body = await request(`${codeSiteBase(workspaceSlug)}/projects`);
  return body.projects || [];
}

export async function fetchCodeSiteProject(workspaceSlug, projectId) {
  if (!workspaceSlug || !projectId) return null;
  const body = await request(projectBase(workspaceSlug, projectId));
  return body.project || null;
}

export async function fetchCodeSiteDeploymentStatus(workspaceSlug, projectId) {
  if (!workspaceSlug || !projectId) return null;
  return request(`${projectBase(workspaceSlug, projectId)}/deployment-status`);
}

export async function fetchCodeSiteControlState(workspaceSlug, projectId) {
  if (!workspaceSlug || !projectId) return null;
  return request(`${projectBase(workspaceSlug, projectId)}/control-state`);
}

export async function fetchCodeSiteEvents(workspaceSlug, projectId) {
  if (!workspaceSlug || !projectId) return [];
  const body = await request(`${projectBase(workspaceSlug, projectId)}/events`);
  return body.events || [];
}

export async function fetchCodeSiteMetrics(workspaceSlug, projectId) {
  if (!workspaceSlug || !projectId) return null;
  const body = await request(`${projectBase(workspaceSlug, projectId)}/metrics`);
  return body.metrics || null;
}

export function subscribeCodeSiteProjectEvents(workspaceSlug, projectId, { onEvent, onStatus } = {}) {
  if (!workspaceSlug || !projectId || typeof window === 'undefined' || typeof window.EventSource !== 'function') {
    onStatus?.('unavailable');
    return () => {};
  }

  const source = new window.EventSource(`${projectBase(workspaceSlug, projectId)}/events/stream`);
  const eventTypes = [
    'tower_instruction',
    'holding_pattern',
    'ground_stop',
    'mayday',
    'mayday_resumed',
    'near_miss',
    'clearance_requested',
    'clearance_issued',
    'transponder_update',
    'snapshot_taken',
    'read_observed',
    'write_attempted',
    'write_allowed',
    'write_denied',
    'write_quarantined',
    'quarantine_reviewed',
    'quarantine_replayed',
    'quarantine_applied',
    'transaction_opened',
    'transaction_validated',
    'transaction_committed',
    'transaction_aborted',
    'policy_delta_proposed',
    'policy_delta_promoted',
    'policy_delta_rejected',
    'rfi',
    'change_order',
    'route_deviation',
    'landing_requested',
    'inspection_result',
    'radar_result',
    'shadow_run',
    'arbiter_verdict',
    'black_box_closed',
    'incident_reported',
    'codesite_stream_error',
  ];

  const handleEvent = (event) => {
    try {
      onEvent?.(JSON.parse(event.data));
    } catch (_) {
      onEvent?.({ eventType: event.type, details: { raw: event.data } });
    }
  };

  source.onopen = () => onStatus?.('live');
  source.onerror = () => onStatus?.('reconnecting');
  source.onmessage = handleEvent;
  for (const eventType of eventTypes) {
    source.addEventListener(eventType, handleEvent);
  }

  return () => {
    for (const eventType of eventTypes) {
      source.removeEventListener(eventType, handleEvent);
    }
    source.onmessage = null;
    source.close();
  };
}

export async function fetchCodeSiteArtifactPreview(workspaceSlug, projectId) {
  if (!workspaceSlug || !projectId) return null;
  return request(`${projectBase(workspaceSlug, projectId)}/artifacts/preview?include=content`);
}

export async function issueCodeSitePermit(workspaceSlug, projectId, payload = {}) {
  if (!workspaceSlug || !projectId) return null;
  return request(`${projectBase(workspaceSlug, projectId)}/permits`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function reviewCodeSiteDocument(workspaceSlug, documentId, payload = {}) {
  if (!workspaceSlug || !documentId) return null;
  return request(`${codeSiteBase(workspaceSlug)}/documents/${encodeURIComponent(documentId)}/reviews`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function proposeCodeSiteRouteRevision(workspaceSlug, executionPlanId, payload = {}) {
  if (!workspaceSlug || !executionPlanId) return null;
  return request(`${codeSiteBase(workspaceSlug)}/execution-plans/${encodeURIComponent(executionPlanId)}/route-revisions`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function reviewCodeSiteRouteRevision(workspaceSlug, routeRevisionId, payload = {}) {
  if (!workspaceSlug || !routeRevisionId) return null;
  return request(`${codeSiteBase(workspaceSlug)}/route-revisions/${encodeURIComponent(routeRevisionId)}/review`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function applyCodeSiteRouteRevision(workspaceSlug, routeRevisionId, payload = {}) {
  if (!workspaceSlug || !routeRevisionId) return null;
  return request(`${codeSiteBase(workspaceSlug)}/route-revisions/${encodeURIComponent(routeRevisionId)}/apply`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function resumeCodeSiteMayday(workspaceSlug, incidentId, payload = {}) {
  if (!workspaceSlug || !incidentId) return null;
  return request(`${codeSiteBase(workspaceSlug)}/incidents/${encodeURIComponent(incidentId)}/resume`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function fetchCodeSiteQuarantines(workspaceSlug, filters = {}) {
  if (!workspaceSlug) return [];
  const search = new URLSearchParams();
  if (filters.transactionId) search.set('transactionId', filters.transactionId);
  if (filters.status) search.set('status', filters.status);
  if (filters.userId) search.set('userId', filters.userId);
  if (filters.filesystemUserId) search.set('filesystemUserId', filters.filesystemUserId);
  if (filters.runtimeScope) search.set('runtimeScope', filters.runtimeScope);
  const suffix = search.toString() ? `?${search.toString()}` : '';
  const body = await request(`${codeSiteBase(workspaceSlug)}/quarantines${suffix}`);
  return body.quarantines || [];
}

export async function fetchCodeSiteQuarantine(workspaceSlug, quarantineId) {
  if (!workspaceSlug || !quarantineId) return null;
  const body = await request(`${codeSiteBase(workspaceSlug)}/quarantines/${encodeURIComponent(quarantineId)}`);
  return body.quarantine || null;
}

export async function replayCodeSiteQuarantine(workspaceSlug, quarantineId, payload = {}) {
  if (!workspaceSlug || !quarantineId) return null;
  return request(`${codeSiteBase(workspaceSlug)}/quarantines/${encodeURIComponent(quarantineId)}/replay`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function applyCodeSiteQuarantine(workspaceSlug, quarantineId, payload = {}) {
  if (!workspaceSlug || !quarantineId) return null;
  return request(`${codeSiteBase(workspaceSlug)}/quarantines/${encodeURIComponent(quarantineId)}/apply`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function fetchCodeSiteLineProvenance(workspaceSlug, { projectId, filePath, lineAnchor, lineNumber } = {}) {
  if (!workspaceSlug || !filePath) return [];
  const search = new URLSearchParams({ filePath });
  if (projectId) search.set('projectId', projectId);
  if (lineAnchor) search.set('lineAnchor', lineAnchor);
  if (lineNumber) search.set('lineNumber', String(lineNumber));
  const body = await request(`${codeSiteBase(workspaceSlug)}/provenance/line?${search.toString()}`);
  return body.lineProvenance || [];
}

export async function createCodeSiteProject(workspaceSlug, payload = {}) {
  const body = await request(`${codeSiteBase(workspaceSlug)}/projects`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return body.project || null;
}

export async function exportCodeSiteArtifacts(workspaceSlug, projectId) {
  if (!workspaceSlug || !projectId) return null;
  return request(`${projectBase(workspaceSlug, projectId)}/artifacts/export`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function simulateCodeSiteShadowMerge(workspaceSlug, projectId, payload = {}) {
  if (!workspaceSlug || !projectId) return null;
  return request(`${projectBase(workspaceSlug, projectId)}/shadow-merge-simulate`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/**
 * The three requests every view needs: `project` drives the proof bundles,
 * incidents, inspection runs and counterfactual runs; `controlState` drives
 * every `counts.*` the Overview renders plus the required actions and the
 * collision forecast; `events` drives the Activity view and seeds the
 * quarantine merge. Nothing outside this trio blocks first paint.
 */
async function fetchCodeSiteCoreSlice(workspaceSlug, projectId) {
  const [project, controlState, events] = await Promise.all([
    fetchCodeSiteProject(workspaceSlug, projectId),
    fetchCodeSiteControlState(workspaceSlug, projectId),
    fetchCodeSiteEvents(workspaceSlug, projectId),
  ]);
  return { project, controlState, events };
}

/** Consumed only by the Evidence view (metrics deck and artifact list). */
export async function fetchCodeSiteEvidenceSlice(workspaceSlug, projectId) {
  if (!workspaceSlug || !projectId) return { metrics: null, artifactPreview: null };
  const [metrics, artifactPreview] = await Promise.all([
    fetchCodeSiteMetrics(workspaceSlug, projectId).catch(() => null),
    fetchCodeSiteArtifactPreview(workspaceSlug, projectId).catch(() => null),
  ]);
  return { metrics, artifactPreview };
}

/**
 * The expensive one: it fans out one request per distinct transaction id, and
 * those ids are only known once the core slice has resolved — so it is a second
 * serial wave. Split out not to defer it to a single view (the Overview's
 * digest counts quarantines too) but so it stops blocking first paint. Callers
 * merge it with `controlState.pendingQuarantines` and the event log, both core,
 * so the quarantine list still populates while this is in flight.
 *
 * Takes no project id: the quarantine endpoint is scoped by transaction, not by
 * project, which is exactly why the ids have to come from the core slice first.
 */
export async function fetchCodeSiteQuarantineSlice(workspaceSlug, core = {}) {
  const { project, controlState, events } = core;
  const transactionIds = uniqueValues([
    ...(Array.isArray(controlState?.activeTransactions) ? controlState.activeTransactions.map((transaction) => transaction.id) : []),
    ...(Array.isArray(project?.mutationTxns) ? project.mutationTxns.map((transaction) => transaction.id) : []),
    ...(Array.isArray(events) ? events.map((event) => event.details?.transactionId || event.details?.transaction_id) : []),
  ]);
  if (!workspaceSlug || !transactionIds.length) {
    return { quarantines: [], quarantineError: null };
  }
  try {
    const groups = await Promise.all(transactionIds.map((transactionId) => fetchCodeSiteQuarantines(workspaceSlug, { transactionId })));
    const seen = new Set();
    const quarantines = groups.flat().filter((record) => {
      const key = record?.quarantineId || record?.id;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { quarantines, quarantineError: null };
  } catch (error) {
    return {
      quarantines: [],
      quarantineError: {
        message: error?.message || 'codesite_quarantine_fetch_failed',
        status: error?.status || null,
      },
    };
  }
}

/**
 * First paint: 1 + 3 requests in two waves, with no per-transaction fan-out.
 * Per-view slices load when their view mounts.
 */
export async function fetchCodeSiteCoreState(workspaceSlug, selectedProjectId = null) {
  if (!workspaceSlug) {
    return createEmptyCodeSiteRadarState(workspaceSlug);
  }

  const projects = await fetchCodeSiteProjects(workspaceSlug);
  const projectId = selectedProjectId || projects[0]?.id || null;

  if (!projectId) {
    return normalizeCodeSiteRadarState({ workspaceSlug, projects });
  }

  const core = await fetchCodeSiteCoreSlice(workspaceSlug, projectId);
  return normalizeCodeSiteRadarState({
    workspaceSlug,
    projects,
    ...core,
    selectedProjectId: projectId,
  });
}

/**
 * The composite fetch: core plus every per-view slice. Retained because callers
 * and tests depend on it by name, and because a caller that genuinely wants
 * everything at once should not have to compose the slices itself. Request
 * count and wave depth are unchanged from before the split — the evidence slice
 * runs alongside the core slice, and the quarantine fan-out still follows both.
 */
export async function fetchCodeSiteRadarState(workspaceSlug, selectedProjectId = null) {
  if (!workspaceSlug) {
    return createEmptyCodeSiteRadarState(workspaceSlug);
  }

  const projects = await fetchCodeSiteProjects(workspaceSlug);
  const projectId = selectedProjectId || projects[0]?.id || null;

  if (!projectId) {
    return normalizeCodeSiteRadarState({ workspaceSlug, projects });
  }

  const [core, evidence] = await Promise.all([
    fetchCodeSiteCoreSlice(workspaceSlug, projectId),
    fetchCodeSiteEvidenceSlice(workspaceSlug, projectId),
  ]);
  const quarantine = await fetchCodeSiteQuarantineSlice(workspaceSlug, core);

  return normalizeCodeSiteRadarState({
    workspaceSlug,
    projects,
    ...core,
    ...evidence,
    ...quarantine,
    selectedProjectId: projectId,
  });
}
