'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  FileJson,
  FileSearch,
  GitCommit,
  Inbox,
  Layers,
  Map,
  Plus,
  Radar,
  RefreshCw,
  Route,
  ScrollText,
  ShieldCheck,
  Siren,
  Upload,
} from 'lucide-react';
import {
  createCodeSiteProject,
  createEmptyCodeSiteRadarState,
  exportCodeSiteArtifacts,
  fetchCodeSiteRadarState,
} from './codesiteClient';

const POLL_MS = 5000;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function compact(value, fallback = 'none') {
  if (value == null || value === '') return fallback;
  return String(value);
}

function hasEntries(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length);
}

function formatTime(value) {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return '';
  return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function statusTone(status) {
  const normalized = String(status || '').toLowerCase();
  if (['active', 'cleared', 'airborne', 'validated', 'passed', 'ok'].includes(normalized)) {
    return { background: 'color-mix(in srgb, #4ade80 16%, transparent)', color: 'var(--text-primary)' };
  }
  if (['holding', 'blocked', 'denied', 'mayday', 'failed', 'critical'].includes(normalized)) {
    return { background: 'color-mix(in srgb, #ff5757 18%, transparent)', color: 'var(--text-primary)' };
  }
  if (['pending', 'filed', 'preflight', 'open', 'running', 'warning', 'medium'].includes(normalized)) {
    return { background: 'color-mix(in srgb, #fbbf24 18%, transparent)', color: 'var(--text-primary)' };
  }
  return { background: 'var(--bg-elevated)', color: 'var(--text-secondary)' };
}

function riskTone(level) {
  const normalized = String(level || '').toLowerCase();
  if (['critical', 'high'].includes(normalized)) {
    return { background: 'color-mix(in srgb, #ff5757 20%, transparent)', color: 'var(--text-primary)' };
  }
  if (['medium', 'warning'].includes(normalized)) {
    return { background: 'color-mix(in srgb, #fbbf24 20%, transparent)', color: 'var(--text-primary)' };
  }
  if (['low', 'clear', 'none'].includes(normalized)) {
    return { background: 'color-mix(in srgb, #4ade80 16%, transparent)', color: 'var(--text-primary)' };
  }
  return { background: 'var(--bg-elevated)', color: 'var(--text-secondary)' };
}

function Pill({ children, tone = 'idle', className = '' }) {
  return (
    <span
      className={`inline-flex h-6 items-center rounded px-2 text-[11px] font-medium ${className}`}
      style={typeof tone === 'string' ? statusTone(tone) : tone}
    >
      {children}
    </span>
  );
}

function IconButton({ title, onClick, disabled, children, variant = 'neutral', testId, type = 'button' }) {
  const active = variant === 'primary';
  return (
    <button
      type={type}
      data-testid={testId}
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-9 items-center gap-1.5 rounded border px-3 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      style={{
        borderColor: active ? 'color-mix(in srgb, var(--accent-primary) 48%, var(--border-subtle))' : 'var(--border-subtle)',
        background: active ? 'color-mix(in srgb, var(--accent-primary) 18%, transparent)' : 'var(--bg-elevated)',
        color: 'var(--text-primary)',
      }}
    >
      {children}
    </button>
  );
}

function Section({ title, icon: Icon, children, right }) {
  return (
    <section className="border-t" style={{ borderColor: 'var(--border-subtle)' }}>
      <div className="flex min-h-10 items-center justify-between gap-3 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--accent-primary)' }} />
          <h3 className="truncate text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
            {title}
          </h3>
        </div>
        {right}
      </div>
      <div className="px-3 pb-3">{children}</div>
    </section>
  );
}

function Metric({ label, value, tone = null, testId }) {
  return (
    <div
      data-testid={testId}
      className="min-h-[68px] rounded border px-3 py-2"
      style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}
    >
      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="mt-1 flex items-end justify-between gap-2">
        <div className="font-mono text-xl leading-none tabular-nums" style={{ color: 'var(--text-primary)' }}>
          {value}
        </div>
        {tone ? <span className="h-2 w-2 rounded-full" style={riskTone(tone)} /> : null}
      </div>
    </div>
  );
}

function PathList({ paths, empty = 'none', maxVisible = 4 }) {
  const list = asArray(paths);
  const visible = list.slice(0, maxVisible);
  if (visible.length === 0) {
    return <span style={{ color: 'var(--text-muted)' }}>{empty}</span>;
  }

  return (
    <div className="flex min-w-0 flex-wrap items-start gap-1 self-start">
      {visible.map((path) => (
        <code
          key={path}
          className="inline-block max-w-full truncate rounded border px-1.5 py-0.5 text-[10px] leading-4"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)', color: 'var(--text-secondary)' }}
          title={path}
        >
          {path}
        </code>
      ))}
      {list.length > visible.length ? (
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>+{list.length - visible.length}</span>
      ) : null}
    </div>
  );
}

function TagList({ items, empty = null, maxVisible = 5 }) {
  const list = asArray(items).filter(Boolean);
  const visible = list.slice(0, maxVisible);
  if (visible.length === 0) return empty ? <span style={{ color: 'var(--text-muted)' }}>{empty}</span> : null;

  return (
    <div className="mt-1 flex min-w-0 flex-wrap gap-1">
      {visible.map((item) => (
        <code
          key={item}
          className="max-w-full truncate rounded border px-1.5 py-0.5 text-[10px]"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)', color: 'var(--text-secondary)' }}
          title={item}
        >
          {item}
        </code>
      ))}
      {list.length > visible.length ? (
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>+{list.length - visible.length}</span>
      ) : null}
    </div>
  );
}

function Row({ children, testId }) {
  return (
    <div
      data-testid={testId}
      className="grid min-h-10 grid-cols-[minmax(76px,0.9fr)_minmax(0,1.5fr)_minmax(72px,0.8fr)] items-center gap-2 border-t py-2 text-xs first:border-t-0"
      style={{ borderColor: 'var(--border-subtle)' }}
    >
      {children}
    </div>
  );
}

function EmptyLine({ children = 'None' }) {
  return (
    <div className="rounded border px-3 py-3 text-xs" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
      {children}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3 p-3" data-testid="codesite-loading">
      {[0, 1, 2, 3].map((item) => (
        <div
          key={item}
          className="h-16 rounded border"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)', opacity: 0.75 }}
        />
      ))}
    </div>
  );
}

function zoneClass(zone) {
  return compact(zone?.class || zone?.zoneClass || zone?.risk || 'C').toUpperCase();
}

function zoneName(zone, index) {
  return compact(zone?.label || zone?.zoneKey || zone?.id || `zone-${index + 1}`);
}

function zonePaths(zone) {
  return asArray(zone?.paths || zone?.route || zone?.allowedPaths);
}

function AirspaceMap({ zones, noFlyZones, flights, risks }) {
  const lanes = zones.length ? zones : [
    { label: 'Allowed route', class: 'C', paths: flights.flatMap((flight) => asArray(flight.route)).slice(0, 4) },
  ];
  const visibleFlights = flights.slice(0, 5);

  return (
    <div className="space-y-2">
      <div
        className="relative overflow-hidden rounded border"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}
      >
        <div className="absolute inset-y-0 left-1/3 border-l" style={{ borderColor: 'var(--border-subtle)' }} />
        <div className="absolute inset-y-0 left-2/3 border-l" style={{ borderColor: 'var(--border-subtle)' }} />
        <div className="relative space-y-1 p-2">
          {lanes.slice(0, 5).map((zone, index) => {
            const relatedFlights = visibleFlights.filter((flight) => {
              const route = asArray(flight.route);
              const paths = zonePaths(zone);
              return route.some((path) => paths.some((zonePath) => path.includes(zonePath.replace('/**', '')) || zonePath.includes(path.replace('/**', ''))));
            });
            const hasRisk = risks.some((risk) => compact(risk.conflictZone || risk.path || risk.zoneKey, '').includes(zonePaths(zone)[0]?.replace('/**', '') || zoneName(zone, index)));
            return (
              <div
                key={zone.zoneKey || zone.id || index}
                className="grid min-h-[46px] grid-cols-[72px_minmax(0,1fr)_minmax(84px,auto)] items-center gap-2 rounded border px-2 py-1.5"
                style={{
                  borderColor: hasRisk ? 'color-mix(in srgb, #ff5757 36%, var(--border-subtle))' : 'var(--border-subtle)',
                  background: hasRisk ? 'color-mix(in srgb, #ff5757 7%, var(--bg-editor))' : 'var(--bg-editor)',
                }}
              >
                <div className="min-w-0">
                  <div className="truncate text-[11px] font-semibold">{zoneName(zone, index)}</div>
                  <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Class {zoneClass(zone)}</div>
                </div>
                <PathList paths={zonePaths(zone)} empty="route pending" />
                <div className="flex justify-end gap-1">
                  {relatedFlights.length ? relatedFlights.map((flight) => (
                    <Pill key={flight.id || flight.displayCallsign} tone={flight.status} className={hasRisk ? 'motion-safe:animate-pulse' : ''}>
                      {compact(flight.displayCallsign, 'agent')}
                    </Pill>
                  )) : <Pill>clear</Pill>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2 text-xs">
        <div className="rounded border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}>
          <div style={{ color: 'var(--text-muted)' }}>No-fly zones</div>
          <div className="mt-1"><PathList paths={noFlyZones} empty="none" /></div>
        </div>
        <div className="rounded border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}>
          <div style={{ color: 'var(--text-muted)' }}>Radar layers</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {['clearance', 'transaction', 'inspection', 'proof'].map((layer) => <Pill key={layer}>{layer}</Pill>)}
          </div>
        </div>
      </div>
    </div>
  );
}

function JsonPreview({ value, maxLines = 10 }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2);
  const lines = text.split('\n').slice(0, maxLines).join('\n');
  return (
    <pre
      aria-label="CodeSite JSON proof details"
      className="max-h-44 overflow-auto rounded border p-2 text-[10px] leading-4"
      style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)', color: 'var(--text-secondary)' }}
      tabIndex={0}
    >
      {lines}
    </pre>
  );
}

export default function CodeSitePanel({ workspaceSlug }) {
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [radarState, setRadarState] = useState(() => createEmptyCodeSiteRadarState(workspaceSlug));
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState(null);
  const [newProjectTitle, setNewProjectTitle] = useState('');
  const [exportResult, setExportResult] = useState(null);

  const loadRadar = useCallback(async ({ silent = false, projectId = selectedProjectId } = {}) => {
    if (!workspaceSlug) {
      setRadarState(createEmptyCodeSiteRadarState(workspaceSlug));
      setLoading(false);
      return;
    }

    if (!silent) setLoading(true);

    try {
      const next = await fetchCodeSiteRadarState(workspaceSlug, projectId);
      setRadarState(next);
      setError(null);
      if (next.selectedProjectId && next.selectedProjectId !== selectedProjectId) {
        setSelectedProjectId(next.selectedProjectId);
      }
    } catch (nextError) {
      setError({
        status: nextError.status,
        message: nextError.message || 'codesite_request_failed',
      });
    } finally {
      setLoading(false);
    }
  }, [selectedProjectId, workspaceSlug]);

  useEffect(() => {
    loadRadar();
  }, [loadRadar]);

  useEffect(() => {
    if (!workspaceSlug || !radarState.selectedProjectId) return undefined;
    const timer = window.setInterval(() => {
      loadRadar({ silent: true, projectId: radarState.selectedProjectId });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadRadar, radarState.selectedProjectId, workspaceSlug]);

  const handleCreateProject = useCallback(async (event) => {
    event?.preventDefault?.();
    if (!workspaceSlug || acting) return;

    const title = newProjectTitle.trim() || 'Coordination run';
    setActing(true);
    try {
      const project = await createCodeSiteProject(workspaceSlug, {
        title,
        request: title,
        zonePolicy: {
          zones: [],
          noFlyZones: [],
          classRules: {},
        },
      });
      setNewProjectTitle('');
      setSelectedProjectId(project?.id || null);
      await loadRadar({ projectId: project?.id || null });
    } catch (nextError) {
      setError({ status: nextError.status, message: nextError.message || 'codesite_create_failed' });
    } finally {
      setActing(false);
    }
  }, [acting, loadRadar, newProjectTitle, workspaceSlug]);

  const handleExportArtifacts = useCallback(async () => {
    if (!workspaceSlug || !radarState.selectedProjectId || acting) return;

    setActing(true);
    try {
      const result = await exportCodeSiteArtifacts(workspaceSlug, radarState.selectedProjectId);
      setExportResult(result);
      await loadRadar({ silent: true, projectId: radarState.selectedProjectId });
    } catch (nextError) {
      setError({ status: nextError.status, message: nextError.message || 'codesite_artifact_export_failed' });
    } finally {
      setActing(false);
    }
  }, [acting, loadRadar, radarState.selectedProjectId, workspaceSlug]);

  const currentProject = radarState.project;
  const controlState = radarState.controlState;
  const hasProjects = radarState.projects.length > 0;
  const risks = radarState.collisionForecast.risks;
  const activeFlights = asArray(controlState?.activeFlights);
  const activeLeases = asArray(controlState?.activeMutationLeases);
  const activeTransactions = asArray(controlState?.activeTransactions);
  const proofBundles = asArray(currentProject?.proofBundles);
  const inspectionRuns = asArray(currentProject?.inspectionRuns);
  const incidents = asArray(currentProject?.incidents);
  const inboxItems = asArray(currentProject?.inboxItems);
  const artifacts = asArray(radarState.artifactPreview?.files);
  const events = asArray(radarState.events).slice(-12).reverse();
  const zones = asArray(currentProject?.zonePolicy?.zones);
  const noFlyZones = asArray(currentProject?.zonePolicy?.noFlyZones || currentProject?.zonePolicy?.noFly)
    .map((zone) => (typeof zone === 'string' ? zone : zone?.pattern || zone?.path || zone?.id))
    .filter(Boolean);
  const lineProvenance = asArray(currentProject?.lineProvenance);
  const artifactContent = artifacts.find((file) => file.contentPreview)?.contentPreview;
  const artifactContentPath = artifacts.find((file) => file.contentPreview)?.path;

  const latestStatus = useMemo(() => {
    if (error?.status === 401) return 'auth';
    if (error?.status === 404) return 'missing';
    if (error) return 'error';
    return controlState?.towerState || currentProject?.status || 'idle';
  }, [controlState?.towerState, currentProject?.status, error]);

  return (
    <div
      data-testid="codesite-panel"
      className="flex h-full min-h-0 w-full flex-col overflow-hidden"
      style={{ background: 'var(--bg-sidebar)', color: 'var(--text-primary)' }}
    >
      <div className="shrink-0 border-b px-3 py-2" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Radar className="h-4 w-4 shrink-0" style={{ color: 'var(--accent-primary)' }} />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">CodeSite</div>
              <div className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {compact(workspaceSlug, 'No workspace')}
              </div>
            </div>
          </div>
          <Pill tone={latestStatus}>{latestStatus}</Pill>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {hasProjects ? (
            <div className="min-w-0 basis-full sm:min-w-[220px] sm:basis-0 sm:flex-1">
              <label htmlFor="codesite-project-select" className="sr-only">CodeSite project</label>
              <select
                id="codesite-project-select"
                data-testid="codesite-project-select"
                value={radarState.selectedProjectId || ''}
                onChange={(event) => setSelectedProjectId(event.target.value || null)}
                className="h-8 w-full min-w-0 truncate rounded border px-2 text-xs outline-none focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-[var(--attention-purple)] focus:[outline-style:solid]"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-elevated)', color: 'var(--text-primary)' }}
              >
                {radarState.projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.title}</option>
                ))}
              </select>
            </div>
          ) : null}

          <IconButton title="Refresh" onClick={() => loadRadar()} disabled={loading || acting} testId="codesite-refresh">
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </IconButton>
          <IconButton
            title="Export artifacts"
            onClick={handleExportArtifacts}
            disabled={!radarState.selectedProjectId || loading || acting}
            testId="codesite-export"
          >
            <Upload className="h-3.5 w-3.5" />
            Export
          </IconButton>
        </div>
      </div>

      {loading && !currentProject && !error ? (
        <LoadingSkeleton />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto" tabIndex={0} aria-label="CodeSite evidence sections">
          {error ? (
            <div className="m-3 rounded border px-3 py-2 text-xs" style={{ borderColor: 'color-mix(in srgb, #ff5757 38%, var(--border-subtle))', color: 'var(--text-primary)' }}>
              {error.status ? `${error.status}: ` : null}{error.message}
            </div>
          ) : null}

          {!hasProjects ? (
            <div className="p-3">
              <form
                data-testid="codesite-empty-state"
                onSubmit={handleCreateProject}
                className="rounded border p-3"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}
              >
                <div className="mb-2 text-sm font-medium">No CodeSite projects</div>
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <label htmlFor="codesite-new-project-title" className="mb-1 block text-[11px]" style={{ color: 'var(--text-muted)' }}>Project title</label>
                    <input
                      id="codesite-new-project-title"
                      value={newProjectTitle}
                      onChange={(event) => setNewProjectTitle(event.target.value)}
                      placeholder="Coordination run"
                      className="h-8 w-full min-w-0 rounded border px-2 text-xs outline-none focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-[var(--attention-purple)] focus:[outline-style:solid]"
                      style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)', color: 'var(--text-primary)' }}
                    />
                  </div>
                  <IconButton title="Open project" variant="primary" disabled={acting || !workspaceSlug} type="submit">
                    <Plus className="h-3.5 w-3.5" />
                    Open
                  </IconButton>
                </div>
              </form>
            </div>
          ) : null}

          {currentProject ? (
            <>
              <div className="p-3">
                <div className="mb-3 min-w-0">
                  <div className="truncate text-sm font-semibold">{currentProject.title}</div>
                  <div className="mt-1 truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {currentProject.request}
                  </div>
                </div>
                <div className="grid grid-cols-[repeat(auto-fit,minmax(112px,1fr))] gap-2">
                  <Metric label="Flights" value={radarState.counts.activeFlights} testId="codesite-metric-flights" />
                  <Metric label="Leases" value={radarState.counts.activeMutationLeases} />
                  <Metric label="Transactions" value={radarState.counts.activeTransactions} />
                  <Metric label="Required" value={radarState.counts.requiredActions} tone={radarState.counts.requiredActions ? 'high' : 'low'} />
                  <Metric label="Risk" value={compact(radarState.collisionForecast.riskLevel, 'unknown')} tone={radarState.collisionForecast.riskLevel} />
                </div>
              </div>

              <Section title="Airspace Map" icon={Map} right={<Pill>{zones.length || activeFlights.length}</Pill>}>
                <AirspaceMap zones={zones} noFlyZones={noFlyZones} flights={activeFlights} risks={risks} />
              </Section>

              <Section title="Collision Forecast" icon={AlertTriangle} right={<Pill tone={riskTone(radarState.collisionForecast.riskLevel)}>{compact(radarState.collisionForecast.riskLevel, 'unknown')}</Pill>}>
                {risks.length === 0 ? (
                  <EmptyLine>No forecasted collisions</EmptyLine>
                ) : (
                  <div className="space-y-2">
                    {risks.map((risk, index) => (
                      <div
                        key={`${risk.risk || risk.type || 'risk'}-${index}`}
                        className="rounded border px-3 py-2 text-xs"
                        style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">{compact(risk.risk || risk.type, 'collision')}</span>
                          <Pill tone={risk.severity || risk.riskLevel}>{compact(risk.severity || risk.riskLevel, 'risk')}</Pill>
                        </div>
                        <div className="mt-1 truncate" style={{ color: 'var(--text-muted)' }}>
                          {compact(risk.conflictZone || risk.path || risk.zoneKey, 'unknown zone')}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <Section title="Flights" icon={Route} right={<Pill>{activeFlights.length}</Pill>}>
                {activeFlights.length === 0 ? (
                  <EmptyLine>No active flights</EmptyLine>
                ) : (
                  <div>
                    {activeFlights.map((plan) => (
                      <Row key={plan.id} testId={`codesite-flight-${plan.id}`}>
                        <div className="min-w-0">
                          <div className="truncate font-medium">{compact(plan.displayCallsign, 'agent')}</div>
                          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{compact(plan.domain, 'implementation')}</div>
                        </div>
                        <div className="min-w-0">
                          <div className="truncate">{compact(plan.mission, 'Code mutation flight')}</div>
                          <PathList paths={plan.route || []} />
                        </div>
                        <div className="justify-self-end"><Pill tone={plan.status}>{plan.status}</Pill></div>
                      </Row>
                    ))}
                  </div>
                )}
              </Section>

              <Section title="Clearances" icon={ShieldCheck} right={<Pill>{activeLeases.length}</Pill>}>
                {activeLeases.length === 0 ? (
                  <EmptyLine>No active clearances</EmptyLine>
                ) : (
                  <div>
                    {activeLeases.map((lease) => (
                      <Row key={lease.id}>
                        <div className="min-w-0">
                          <div className="truncate font-medium">{compact(lease.displayCallsign, 'agent')}</div>
                          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{formatTime(lease.expiresAt) || 'open'}</div>
                        </div>
	                        <div className="min-w-0">
	                          <PathList paths={lease.lease?.allowedPaths || []} empty="route pending" />
                            <TagList
                              items={[
                                lease.dojoProofRef,
                                lease.dojoLicenseRef,
                                ...asArray(lease.dojoEvidenceRefs),
                                lease.dojoLedgerCheckpointHash,
                                lease.dojoDecisionDigest,
                              ]}
                              empty=""
                            />
	                        </div>
                        <div className="justify-self-end"><Pill tone={lease.status}>{lease.status}</Pill></div>
                      </Row>
                    ))}
                  </div>
                )}
              </Section>

              <Section title="Transactions And Proof" icon={GitCommit} right={<Pill>{proofBundles.length}</Pill>}>
                {activeTransactions.length === 0 && proofBundles.length === 0 ? (
                  <EmptyLine>No open transactions</EmptyLine>
                ) : (
                  <div>
                    {activeTransactions.map((transaction) => (
                      <Row key={transaction.id}>
                        <div className="min-w-0">
                          <div className="truncate font-mono text-[11px]">{transaction.id}</div>
                          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{formatTime(transaction.openedAt)}</div>
                        </div>
                        <div className="min-w-0">
                          <PathList paths={transaction.writeSet || transaction.observedWriteSet || []} empty="no writes" />
                        </div>
                        <div className="justify-self-end"><Pill tone={transaction.status}>{transaction.status}</Pill></div>
                      </Row>
                    ))}
                    {proofBundles.slice(-3).reverse().map((bundle) => (
                      <div key={bundle.id} className="border-t py-2 first:border-t-0" style={{ borderColor: 'var(--border-subtle)' }}>
                        <div className="grid min-h-10 grid-cols-[minmax(76px,0.9fr)_minmax(0,1.5fr)_minmax(72px,0.8fr)] items-center gap-2 text-xs">
                          <div className="min-w-0">
                            <div className="truncate font-mono text-[11px]">{bundle.id}</div>
                            <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>proof</div>
                          </div>
                          <div className="min-w-0 truncate font-mono text-[11px]" title={bundle.bundleDigest || bundle.readSetDigest}>
                            {bundle.bundleDigest || bundle.readSetDigest}
                          </div>
                          <div className="justify-self-end">
                            <CheckCircle2 className="h-4 w-4" style={{ color: 'color-mix(in srgb, #4ade80 70%, var(--text-primary))' }} />
                          </div>
                        </div>
	                        <div className="mt-1 grid gap-1 sm:grid-cols-2">
	                          <PathList paths={bundle.evidenceRefs || []} empty="no evidence refs" />
	                          <PathList paths={Object.entries(bundle.trailers || {}).map(([key, value]) => `${key}: ${value}`)} empty="no trailers" />
	                        </div>
	                        {bundle.repoState ? (
	                          <div className="mt-1">
	                            <PathList
	                              paths={[
	                                bundle.repoState.evidenceDigest && `repo-state:${bundle.repoState.evidenceDigest}`,
	                                bundle.repoState.gitHead && `git-head:${bundle.repoState.gitHead}`,
	                                bundle.repoState.worktreeDiffDigest && `worktree-diff:${bundle.repoState.worktreeDiffDigest}`,
	                                ...asArray(bundle.repoState.writeFileDigests).map((file) => `${file.path}:${file.digest || 'missing'}`),
	                              ].filter(Boolean)}
	                              empty="no repo-state evidence"
	                              maxVisible={6}
	                            />
	                          </div>
	                        ) : null}
	                      </div>
	                    ))}
                  </div>
                )}
              </Section>

              <Section title="Inspections And Incidents" icon={Siren} right={<Pill tone={incidents.length ? 'blocked' : 'active'}>{incidents.length}</Pill>}>
                {inspectionRuns.length === 0 && incidents.length === 0 ? (
                  <EmptyLine>No inspections or incidents</EmptyLine>
                ) : (
                  <div className="space-y-2">
                    {inspectionRuns.slice(-3).reverse().map((run) => (
                      <div key={run.id} className="rounded border px-3 py-2 text-xs" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate">{compact(run.displayCallsign, 'inspection')}</span>
                          <Pill tone={run.status}>{run.status}</Pill>
                        </div>
                        <div className="mt-1"><PathList paths={run.changedPaths || []} empty="no changed paths" /></div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {asArray(run.inspectionSignals).slice(0, 3).map((signal, index) => (
                            <Pill key={`${run.id}-signal-${index}`} tone={signal.status || run.status}>
                              {compact(signal.type || signal.kind, 'signal')}
                            </Pill>
                          ))}
                        </div>
                        <div className="mt-1"><PathList paths={run.evidenceRefs || []} empty="no evidence refs" /></div>
                      </div>
                    ))}
                    {incidents.slice(-3).reverse().map((incident) => (
                      <div key={incident.id} className="rounded border px-3 py-2 text-xs" style={{ borderColor: 'color-mix(in srgb, #ff5757 36%, var(--border-subtle))', background: 'var(--bg-surface)' }}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate">{compact(incident.category, 'incident')}</span>
                          <Pill tone={incident.severity}>{incident.severity}</Pill>
                        </div>
                        <div className="mt-1"><PathList paths={incident.affectedZones || []} empty="no affected zones" /></div>
                        <div className="mt-1 grid gap-1 sm:grid-cols-2">
                          <PathList paths={incident.participants || []} empty="no participants" />
                          <PathList paths={incident.evidenceRefs || []} empty="no evidence refs" />
                        </div>
                        <div className="mt-1 truncate font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          {incident.replayDigest || compact(incident.incidentReplay?.summary, 'no replay digest')}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <Section title="Artifact Projection" icon={FileJson} right={<Pill>{artifacts.length}</Pill>}>
                {exportResult ? (
                  <div className="mb-2 rounded border px-3 py-2 text-xs" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}>
                    {exportResult.written ? 'Artifacts written' : 'Preview only'}{exportResult.root ? `: ${exportResult.root}` : ''}
                  </div>
                ) : null}
                {artifacts.length === 0 ? (
                  <EmptyLine>No artifact preview</EmptyLine>
                ) : (
                  <div className="space-y-1">
                    {artifacts.slice(0, 10).map((file) => (
                      <div key={file.path} className="flex items-center justify-between gap-3 rounded border px-2 py-1.5 text-xs" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}>
                        <code className="min-w-0 truncate text-[10px]" title={file.path}>{file.path}</code>
                        <span className="shrink-0 font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>{file.bytes}b</span>
                      </div>
                    ))}
                    {artifactContent ? (
                      <div className="pt-2">
                        <div className="mb-1 flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                          <FileSearch className="h-3.5 w-3.5" />
                          <span className="min-w-0 truncate">{artifactContentPath}</span>
                        </div>
                        <JsonPreview value={artifactContent} maxLines={12} />
                      </div>
                    ) : null}
                  </div>
                )}
              </Section>

              <Section title="Black Box" icon={ScrollText} right={<Pill>{events.length}</Pill>}>
                {events.length === 0 ? (
                  <EmptyLine>No events recorded</EmptyLine>
                ) : (
                  <div className="space-y-1">
                    {events.map((event) => (
                      <div key={event.id} className="rounded border px-2 py-1.5 text-xs" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}>
                        <div className="grid min-h-9 grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-2">
                          <span className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>{formatTime(event.createdAt)}</span>
                          <span className="min-w-0 truncate">{event.eventType}</span>
                          <span className="max-w-[96px] truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>{event.displayCallsign || event.actorType || ''}</span>
                        </div>
                        {hasEntries(event.details) || asArray(event.evidenceRefs).length ? (
                          <div className="mt-1">
                            <JsonPreview
                              value={{
                                eventId: event.id,
                                logicalTime: event.logicalTime,
                                details: event.details || {},
                                evidenceRefs: event.evidenceRefs || [],
                              }}
                              maxLines={12}
                            />
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <Section title="Required Actions" icon={Inbox} right={<Pill tone={radarState.counts.requiredActions ? 'holding' : 'active'}>{radarState.counts.requiredActions}</Pill>}>
                {asArray(controlState?.requiredActions).length === 0 ? (
                  <EmptyLine>No blocking actions</EmptyLine>
                ) : (
                  <div className="space-y-1">
                    {controlState.requiredActions.map((action) => (
                      <div key={action} className="rounded border px-2 py-1.5 font-mono text-[11px]" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}>
                        {action}
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <Section title="Agent Inbox" icon={Inbox} right={<Pill tone={inboxItems.some((item) => item.status === 'pending') ? 'holding' : 'active'}>{inboxItems.length}</Pill>}>
                {inboxItems.length === 0 ? (
                  <EmptyLine>No routed inbox items</EmptyLine>
                ) : (
                  <div className="space-y-1">
                    {inboxItems.slice(-5).reverse().map((item) => (
                      <div key={item.id || item.eventId} className="rounded border px-2 py-1.5 text-xs" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}>
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate font-medium">{compact(item.kind, 'inbox')}</div>
                            <div className="truncate font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
                              {compact(item.agentSessionId, 'session')} / {compact(item.eventId, 'event')}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            {item.requiresResponse ? <Pill tone="holding">response</Pill> : null}
                            <Pill tone={item.status}>{compact(item.status, 'pending')}</Pill>
                          </div>
                        </div>
                        {hasEntries(item.redactedPayload) ? (
                          <div className="mt-1">
                            <JsonPreview value={item.redactedPayload} maxLines={6} />
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <Section title="Inspections Queue" icon={ClipboardCheck} right={<Pill>{inspectionRuns.length}</Pill>}>
                <div className="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-2">
                  <Metric label="Runs" value={inspectionRuns.length} />
                  <Metric label="Incidents" value={incidents.length} tone={incidents.length ? 'high' : 'low'} />
                  <Metric label="Events" value={radarState.counts.events} />
                  <Metric label="Proof" value={radarState.counts.proofBundles} />
                </div>
              </Section>

              <Section title="Line Provenance" icon={FileSearch} right={<Pill>{lineProvenance.length}</Pill>}>
                {lineProvenance.length === 0 ? (
                  <EmptyLine>No line provenance indexed</EmptyLine>
                ) : (
                  <div className="space-y-1">
                    {lineProvenance.slice(-5).reverse().map((row) => (
                      <div key={row.id || `${row.filePath}-${row.lineAnchor}`} className="rounded border px-2 py-1.5 text-xs" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}>
                        <div className="flex items-center justify-between gap-2">
                          <code className="min-w-0 truncate text-[10px]" title={row.filePath}>{row.filePath}</code>
                          <Pill>{compact(row.displayCallsign, 'agent')}</Pill>
                        </div>
                        <div className="mt-1 grid gap-1 sm:grid-cols-2">
                          <PathList paths={[row.lineAnchor, row.reasonRef].filter(Boolean)} empty="no anchor" />
                          <PathList paths={[...asArray(row.evidenceRefs), ...asArray(row.processAncestry)]} empty="no evidence refs" maxVisible={8} />
                        </div>
                        {row.promptSummary ? (
                          <div className="mt-1 truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>{row.promptSummary}</div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <Section title="Airspace Zones" icon={Layers} right={<Pill>{zones.length}</Pill>}>
                {zones.length === 0 ? (
                  <EmptyLine>No classified zones</EmptyLine>
                ) : (
                  <div className="space-y-1">
                    {zones.slice(0, 6).map((zone, index) => (
                      <div key={zone.zoneKey || zone.id || index} className="grid min-h-10 grid-cols-[minmax(76px,0.8fr)_minmax(0,1.6fr)_auto] items-center gap-2 rounded border px-2 py-1.5 text-xs" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}>
                        <div className="min-w-0">
                          <div className="truncate font-medium">{zoneName(zone, index)}</div>
                          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Class {zoneClass(zone)}</div>
                        </div>
                        <PathList paths={zonePaths(zone)} empty="no paths" />
                        <Pill tone={zone.risk || 'medium'}>{compact(zone.risk, 'risk')}</Pill>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <Section title="Radar Sources" icon={Activity}>
                <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2 text-xs">
                  <div className="rounded border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}>
                    <div style={{ color: 'var(--text-muted)' }}>Allowed paths</div>
                    <div className="mt-1"><PathList paths={controlState?.allowedPaths || []} /></div>
                  </div>
                  <div className="rounded border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}>
                    <div style={{ color: 'var(--text-muted)' }}>Blocked paths</div>
                    <div className="mt-1"><PathList paths={controlState?.blockedPaths || []} /></div>
                  </div>
                </div>
              </Section>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
