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
  artifactPreview = null,
  selectedProjectId = null,
} = {}) {
  const normalizedProjects = Array.isArray(projects) ? projects.filter(Boolean) : [];
  const normalizedEvents = Array.isArray(events) ? events.filter(Boolean) : [];
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

export async function fetchCodeSiteArtifactPreview(workspaceSlug, projectId) {
  if (!workspaceSlug || !projectId) return null;
  return request(`${projectBase(workspaceSlug, projectId)}/artifacts/preview?include=content`);
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

export async function fetchCodeSiteRadarState(workspaceSlug, selectedProjectId = null) {
  if (!workspaceSlug) {
    return createEmptyCodeSiteRadarState(workspaceSlug);
  }

  const projects = await fetchCodeSiteProjects(workspaceSlug);
  const projectId = selectedProjectId || projects[0]?.id || null;

  if (!projectId) {
    return normalizeCodeSiteRadarState({ workspaceSlug, projects });
  }

  const [project, controlState, events, metrics, artifactPreview] = await Promise.all([
    fetchCodeSiteProject(workspaceSlug, projectId),
    fetchCodeSiteControlState(workspaceSlug, projectId),
    fetchCodeSiteEvents(workspaceSlug, projectId),
    fetchCodeSiteMetrics(workspaceSlug, projectId).catch(() => null),
    fetchCodeSiteArtifactPreview(workspaceSlug, projectId).catch(() => null),
  ]);

  return normalizeCodeSiteRadarState({
    workspaceSlug,
    projects,
    project,
    controlState,
    metrics,
    events,
    artifactPreview,
    selectedProjectId: projectId,
  });
}
