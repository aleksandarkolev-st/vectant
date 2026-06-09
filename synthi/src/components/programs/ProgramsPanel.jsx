'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Command, Play, RefreshCw, RotateCcw, Square, Activity, Globe, Package, Download, ShieldCheck, X, Store, UploadCloud } from 'lucide-react';
import { toast } from 'sonner';
import {
  fetchProgramSessions,
  launchProgramSession,
  restartProgramSession,
  stopProgramSession,
  fetchInstalledPrograms,
  installWorkspaceProgram,
  launchInstalledProgram,
  publishWorkspaceProgram,
  fetchMarketplace,
  installPublishedProgram,
} from './programsClient';
import {
  buildProgramSessionSections,
  canRestartProgramSession,
  formatProgramSessionAge,
  formatProgramSessionPorts,
  isActiveProgramSession,
} from './programSessionSections';
import { activateTabAction, openTab, selectNodes, selectTabs, setFocusedTabGroup } from '@/components/docking-wm/state/layout-slice';
import { IDE_PANEL } from '@/components/docking-wm/panels/panel-types';

function sessionLabel(session) {
  if (!session?.id) {
    return 'Program session';
  }
  return `Session ${String(session.id).slice(0, 8)}`;
}

function stateTone(state) {
  switch (String(state || '').toLowerCase()) {
    case 'running':
      return { background: 'color-mix(in srgb, #4ade80 16%, transparent)', color: 'var(--text-primary)' };
    case 'starting':
    case 'restarting':
      return { background: 'color-mix(in srgb, #60a5fa 18%, transparent)', color: 'var(--text-primary)' };
    case 'crashed':
      return { background: 'color-mix(in srgb, #ff5757 18%, transparent)', color: 'var(--text-primary)' };
    default:
      return { background: 'var(--bg-elevated)', color: 'var(--text-secondary)' };
  }
}

function findProgramSessionTab(nodes, tabs, programSessionId) {
  for (const [groupId, node] of Object.entries(nodes || {})) {
    if (node?.type !== 'tabgroup') continue;
    for (const tabId of node.tabs || []) {
      const tab = tabs?.[tabId];
      if (tab?.panelType === IDE_PANEL.PROGRAM_SESSION && tab?.data?.programSessionId === programSessionId) {
        return { groupId, tabId, tab };
      }
    }
  }
  return null;
}

function findEditorGroupId(nodes, tabs) {
  for (const [groupId, node] of Object.entries(nodes || {})) {
    if (node?.type !== 'tabgroup') continue;
    if ((node.tabs || []).some((tabId) => tabs?.[tabId]?.panelType === IDE_PANEL.EDITOR)) {
      return groupId;
    }
  }

  return Object.entries(nodes || {}).find(([, node]) => node?.type === 'tabgroup')?.[0] || null;
}

function SessionCard({ session, acting, onOpen, onStop, onRestart }) {
  const isActive = isActiveProgramSession(session);
  const ports = formatProgramSessionPorts(session);
  const age = formatProgramSessionAge(session);

  return (
    <div
      className="rounded-lg border px-3 py-2 flex flex-col gap-2"
      style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex flex-col gap-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium truncate">{sessionLabel(session)}</span>
            <span
              className="text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider"
              style={stateTone(session.state)}
            >
              {session.state || 'unknown'}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            <span>{String(session.runtimeType || 'cli').toUpperCase()}</span>
            {age ? <span>{age}</span> : null}
            {typeof session.webPort === 'number' ? (
              <span className="inline-flex items-center gap-1">
                <Globe className="w-3 h-3" /> :{session.webPort}
              </span>
            ) : null}
            {ports ? (
              <span className="inline-flex items-center gap-1">
                <Activity className="w-3 h-3" /> {ports}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onOpen(session)}
            className="text-[11px] px-2 py-1 rounded border transition-colors"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
          >
            Open
          </button>
          {isActive ? (
            <button
              type="button"
              onClick={() => onStop(session)}
              disabled={acting}
              className="text-[11px] px-2 py-1 rounded border transition-colors"
              style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
            >
              <span className="inline-flex items-center gap-1">
                <Square className="w-3 h-3" /> Stop
              </span>
            </button>
          ) : canRestartProgramSession(session) ? (
            <button
              type="button"
              onClick={() => onRestart(session)}
              disabled={acting}
              className="text-[11px] px-2 py-1 rounded border transition-colors"
              style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
            >
              <span className="inline-flex items-center gap-1">
                <RotateCcw className="w-3 h-3" /> Restart
              </span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ConsentPrompt({ requested = [], busy, onApprove, onCancel }) {
  return (
    <div
      className="rounded-lg border px-3 py-3 flex flex-col gap-2"
      data-testid="consent-prompt"
      style={{ borderColor: 'color-mix(in srgb, var(--accent-primary) 35%, var(--border-subtle))', background: 'var(--bg-surface)' }}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <ShieldCheck className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} /> Permission consent required
      </div>
      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
        This program requests the following scopes:
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {requested.map((scope) => (
          <li
            key={scope}
            className="text-[11px] px-1.5 py-0.5 rounded border"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
          >
            {scope}
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-end gap-2 mt-1">
        <button
          type="button"
          onClick={onCancel}
          className="text-[11px] px-2 py-1 rounded border inline-flex items-center gap-1"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
        >
          <X className="w-3 h-3" /> Cancel
        </button>
        <button
          type="button"
          data-testid="approve-consent"
          onClick={onApprove}
          disabled={busy}
          className="text-[11px] px-2 py-1 rounded inline-flex items-center gap-1 font-medium disabled:opacity-50"
          style={{ background: 'var(--brand-gradient-horizontal)', color: '#fff' }}
        >
          <ShieldCheck className="w-3 h-3" /> {busy ? 'Approving…' : 'Approve & install'}
        </button>
      </div>
    </div>
  );
}

function SectionHeader({ icon: Icon, label, count }) {
  return (
    <div className="flex items-center justify-between">
      <h3 className="text-xs font-semibold uppercase tracking-wider inline-flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
        {Icon ? <Icon className="w-3.5 h-3.5" /> : null} {label}
      </h3>
      {typeof count === 'number' ? (
        <span className="text-[11px] px-1.5 py-0.5 rounded-full" style={{ background: 'var(--bg-elevated)', color: 'var(--text-dim)' }}>{count}</span>
      ) : null}
    </div>
  );
}

function InstallCard({ install, acting, canManage, onLaunch }) {
  return (
    <div
      className="rounded-lg border px-3 py-2 flex items-center justify-between gap-3 transition-colors hover:bg-[var(--bg-elevated)]"
      style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}
    >
      <div className="min-w-0 flex items-center gap-2">
        <Package className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-muted)' }} />
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{install.packageId || 'program'}</div>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            v{install.version} · {install.status}
          </div>
        </div>
      </div>
      {canManage ? (
        <button
          type="button"
          data-testid={`launch-install-${install.id}`}
          onClick={() => onLaunch(install)}
          disabled={acting}
          className="text-[11px] px-2 py-1 rounded border inline-flex items-center gap-1 disabled:opacity-50"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
        >
          <Play className="w-3 h-3" /> Launch
        </button>
      ) : null}
    </div>
  );
}

export default function ProgramsPanel() {
  const dispatch = useDispatch();
  const workspaceSlug = useSelector((state) => state.workspace?.slug || null);
  const workspaceRole = useSelector((state) => state.workspace?.role || null);
  const nodes = useSelector(selectNodes);
  const tabs = useSelector(selectTabs);
  const [command, setCommand] = useState('npm run dev');
  const [sessions, setSessions] = useState([]);
  const [installs, setInstalls] = useState([]);
  const [marketplace, setMarketplace] = useState([]);
  const [marketQuery, setMarketQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [consent, setConsent] = useState(null);
  const [actingSessionId, setActingSessionId] = useState(null);

  // Members get a read-only view; owner/admin (or unknown role — the API still
  // enforces) can launch / install. 'member' is the only role denied here.
  const canManage = workspaceRole !== 'member';

  const load = useCallback(async () => {
    if (!workspaceSlug) {
      setSessions([]);
      setInstalls([]);
      setMarketplace([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const [nextSessions, nextInstalls, nextMarket] = await Promise.all([
        fetchProgramSessions(workspaceSlug),
        fetchInstalledPrograms(workspaceSlug).catch(() => []),
        fetchMarketplace(workspaceSlug, marketQuery).catch(() => []),
      ]);
      setSessions(nextSessions);
      setInstalls(nextInstalls);
      setMarketplace(Array.isArray(nextMarket) ? nextMarket : []);
    } catch (error) {
      toast.error(error.message || 'Failed to load programs');
    } finally {
      setLoading(false);
    }
  }, [workspaceSlug, marketQuery]);

  useEffect(() => {
    load();
  }, [load]);

  const sections = useMemo(() => buildProgramSessionSections(sessions), [sessions]);

  const openProgramSession = useCallback((session) => {
    if (!session?.id) return;

    const existing = findProgramSessionTab(nodes, tabs, session.id);
    if (existing) {
      dispatch(setFocusedTabGroup(existing.groupId));
      dispatch(activateTabAction({ tabId: existing.tabId }));
      return;
    }

    const targetTabGroupId = findEditorGroupId(nodes, tabs);
    if (!targetTabGroupId) return;

    dispatch(openTab({
      panelType: IDE_PANEL.PROGRAM_SESSION,
      title: sessionLabel(session),
      targetTabGroupId,
      data: {
        programSessionId: session.id,
        workspaceSlug,
        title: sessionLabel(session),
      },
    }));
    dispatch(setFocusedTabGroup(targetTabGroupId));
  }, [dispatch, nodes, tabs, workspaceSlug]);

  const handleLaunch = useCallback(async (event) => {
    event.preventDefault();
    const trimmed = command.trim();
    if (!workspaceSlug || !trimmed) {
      return;
    }

    setLaunching(true);
    try {
      const launched = await launchProgramSession(workspaceSlug, {
        command: trimmed,
        runtimeType: 'cli',
        grantScopes: ['program.launch'],
      });
      toast.success('Program launched');
      if (launched?.session) {
        openProgramSession(launched.session);
      }
      await load();
    } catch (error) {
      if (error?.status === 409) {
        toast.error('Launch consent is required before the first workspace program run.');
      } else {
        toast.error(error.message || 'Failed to launch program');
      }
    } finally {
      setLaunching(false);
    }
  }, [command, load, openProgramSession, workspaceSlug]);

  const handleStop = useCallback(async (session) => {
    if (!workspaceSlug || !session?.id) return;

    setActingSessionId(session.id);
    try {
      await stopProgramSession(workspaceSlug, session.id);
      toast.success(`${sessionLabel(session)} stopped`);
      await load();
    } catch (error) {
      toast.error(error.message || 'Failed to stop program');
    } finally {
      setActingSessionId(null);
    }
  }, [load, workspaceSlug]);

  const handleRestart = useCallback(async (session) => {
    if (!workspaceSlug || !session?.id) return;

    setActingSessionId(session.id);
    try {
      await restartProgramSession(workspaceSlug, session.id);
      toast.success(`${sessionLabel(session)} restarted`);
      await load();
    } catch (error) {
      toast.error(error.message || 'Failed to restart program');
    } finally {
      setActingSessionId(null);
    }
  }, [load, workspaceSlug]);

  const handleInstall = useCallback(async (grantScopes) => {
    if (!workspaceSlug) return;

    setInstalling(true);
    try {
      await installWorkspaceProgram(workspaceSlug, grantScopes ? { grantScopes } : {});
      toast.success('Program installed');
      setConsent(null);
      await load();
    } catch (error) {
      if (error?.status === 409) {
        setConsent({ requested: error.body?.requested || [] });
      } else if (error?.status === 404) {
        toast.error('No vectant.programs.json or devcontainer.json found in this workspace.');
      } else if (error?.status === 422) {
        toast.error(error.body?.message || 'Invalid manifest');
      } else {
        toast.error(error.message || 'Failed to install program');
      }
    } finally {
      setInstalling(false);
    }
  }, [load, workspaceSlug]);

  const handleLaunchInstall = useCallback(async (install) => {
    if (!workspaceSlug || !install?.id) return;

    setActingSessionId(install.id);
    try {
      const result = await launchInstalledProgram(workspaceSlug, install.id);
      toast.success('Program launched');
      if (result?.session) {
        openProgramSession(result.session);
      }
      await load();
    } catch (error) {
      toast.error(error.message || 'Failed to launch program');
    } finally {
      setActingSessionId(null);
    }
  }, [load, openProgramSession, workspaceSlug]);

  const handlePublish = useCallback(async () => {
    if (!workspaceSlug) return;

    setPublishing(true);
    try {
      const { program } = await publishWorkspaceProgram(workspaceSlug);
      toast.success(`Published ${program?.packageId || 'program'}`);
      await load();
    } catch (error) {
      if (error?.status === 422) toast.error(error.body?.message || 'Invalid manifest');
      else if (error?.status === 404) toast.error('No vectant.programs.json or devcontainer.json found in this workspace.');
      else toast.error(error.body?.message || error.message || 'Failed to publish');
    } finally {
      setPublishing(false);
    }
  }, [load, workspaceSlug]);

  const handleInstallPublished = useCallback(async (item, grantScopes) => {
    if (!workspaceSlug || !item?.packageId) return;

    try {
      await installPublishedProgram(workspaceSlug, item.packageId, item.latestVersion, grantScopes);
      toast.success(`Installed ${item.packageId}`);
      setConsent(null);
      await load();
    } catch (error) {
      if (error?.status === 409) setConsent({ requested: error.body?.requested || [], published: item });
      else toast.error(error.body?.message || error.message || 'Failed to install');
    }
  }, [load, workspaceSlug]);

  return (
    <div className="flex flex-col h-full min-h-0" style={{ color: 'var(--text-primary)' }}>
      <div className="flex items-center justify-between px-3 py-2 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
          <Command className="w-3.5 h-3.5" /> Programs
        </div>
        <button
          type="button"
          onClick={load}
          className="h-7 w-7 rounded border flex items-center justify-center"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
          title="Refresh"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-4">
        {canManage ? (
        <form
          onSubmit={handleLaunch}
          className="rounded-lg border p-3 flex flex-col gap-3"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">Launch Command</div>
              <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                Phase 1 runs ad hoc workspace commands only. Marketplace and installs stay out of this panel.
              </div>
            </div>
          </div>

          <label className="flex flex-col gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
            Command
            <input
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="npm run dev"
              className="h-10 rounded-md border px-3 text-sm outline-none"
              style={{
                borderColor: 'var(--border-medium)',
                background: 'var(--bg-editor)',
                color: 'var(--text-primary)',
              }}
            />
          </label>

          <div className="flex items-center justify-between gap-3">
            <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
              Launching records workspace consent through the program-session API.
            </div>
            <button
              type="submit"
              disabled={!workspaceSlug || launching || !command.trim()}
              className="h-9 px-3 rounded-md inline-flex items-center gap-2 text-sm font-medium disabled:opacity-50"
              style={{
                background: 'var(--brand-gradient-horizontal)',
                color: '#fff',
              }}
            >
              <Play className="w-4 h-4" /> {launching ? 'Launching…' : 'Launch'}
            </button>
          </div>
        </form>
        ) : null}

        {canManage && consent ? (
          <ConsentPrompt
            requested={consent.requested}
            busy={installing}
            onApprove={() =>
              consent.published
                ? handleInstallPublished(consent.published, consent.requested)
                : handleInstall(consent.requested)
            }
            onCancel={() => setConsent(null)}
          />
        ) : null}

        {canManage ? (
          <div
            className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}
          >
            <div className="min-w-0">
              <div className="text-sm font-medium">Install from manifest</div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Detects vectant.programs.json or devcontainer.json in this workspace.
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                data-testid="install-from-manifest"
                onClick={() => handleInstall()}
                disabled={!workspaceSlug || installing}
                className="h-9 px-3 rounded-md inline-flex items-center gap-2 text-sm font-medium border disabled:opacity-50"
                style={{ borderColor: 'var(--border-medium)', color: 'var(--text-primary)' }}
              >
                <Download className="w-4 h-4" /> {installing ? 'Installing…' : 'Install'}
              </button>
              <button
                type="button"
                data-testid="publish-program"
                onClick={handlePublish}
                disabled={!workspaceSlug || publishing}
                className="h-9 px-3 rounded-md inline-flex items-center gap-2 text-sm font-medium border disabled:opacity-50"
                style={{ borderColor: 'var(--border-medium)', color: 'var(--text-primary)' }}
                title="Publish this workspace's recipe to the marketplace"
              >
                <UploadCloud className="w-4 h-4" /> {publishing ? 'Publishing…' : 'Publish'}
              </button>
            </div>
          </div>
        ) : null}

        <section className="flex flex-col gap-2">
          <SectionHeader icon={Package} label="Installed" count={installs.length} />
          {installs.length === 0 ? (
            <div className="text-xs rounded-lg border px-3 py-4" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
              No installed programs yet.
            </div>
          ) : (
            installs.map((install) => (
              <InstallCard
                key={install.id}
                install={install}
                acting={actingSessionId === install.id}
                canManage={canManage}
                onLaunch={handleLaunchInstall}
              />
            ))
          )}
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <SectionHeader icon={Store} label="Marketplace" count={marketplace.length} />
            <input
              value={marketQuery}
              onChange={(event) => setMarketQuery(event.target.value)}
              placeholder="Search published programs"
              className="h-7 w-40 rounded border px-2 text-[11px] outline-none"
              style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)', color: 'var(--text-primary)' }}
            />
          </div>
          {marketplace.length === 0 ? (
            <div className="text-xs rounded-lg border px-3 py-4" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
              No published programs yet.
            </div>
          ) : (
            marketplace.map((item) => (
              <div
                key={item.packageId}
                data-testid={`marketplace-item-${item.packageId}`}
                className="group rounded-lg border px-3 py-2.5 flex items-center justify-between gap-3 transition-colors hover:bg-[var(--bg-elevated)]"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}
              >
                <div className="min-w-0 flex items-start gap-2.5">
                  <div
                    className="mt-0.5 h-8 w-8 shrink-0 rounded-md flex items-center justify-center"
                    style={{ background: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)' }}
                  >
                    <Package className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-sm font-medium truncate">{item.displayName || item.packageId}</span>
                      {item.verified ? (
                        <span
                          data-testid={`verified-badge-${item.packageId}`}
                          title="Official Vectant program"
                          className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full shrink-0"
                          style={{ background: 'var(--brand-gradient-horizontal)', color: '#fff' }}
                        >
                          <ShieldCheck className="w-3 h-3" /> Verified
                        </span>
                      ) : null}
                    </div>
                    {item.description ? (
                      <div className="text-[11px] mt-0.5 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                        {item.description}
                      </div>
                    ) : null}
                    <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {item.packageId} · {item.installCount || 0} installs
                    </div>
                  </div>
                </div>
                {canManage ? (
                  <button
                    type="button"
                    data-testid={`install-published-${item.packageId}`}
                    onClick={() => handleInstallPublished(item, undefined)}
                    className="shrink-0 h-7 px-2.5 rounded-md border text-[11px] inline-flex items-center gap-1 transition-colors"
                    style={{ borderColor: 'var(--border-medium)', color: 'var(--text-primary)' }}
                  >
                    <Download className="w-3 h-3" /> Install
                  </button>
                ) : null}
              </div>
            ))
          )}
        </section>

        <section className="flex flex-col gap-2">
          <SectionHeader label="Running" count={sections.running.length} />
          {loading ? (
            <div className="text-xs px-1 py-3" style={{ color: 'var(--text-muted)' }}>Loading…</div>
          ) : sections.running.length === 0 ? (
            <div className="text-xs rounded-lg border px-3 py-4" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
              No managed program sessions are running.
            </div>
          ) : (
            sections.running.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                acting={actingSessionId === session.id}
                onOpen={openProgramSession}
                onStop={handleStop}
                onRestart={handleRestart}
              />
            ))
          )}
        </section>

        <section className="flex flex-col gap-2">
          <SectionHeader label="Recent" count={sections.recent.length} />
          {sections.recent.length === 0 ? (
            <div className="text-xs rounded-lg border px-3 py-4" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
              No recent program sessions yet.
            </div>
          ) : (
            sections.recent.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                acting={actingSessionId === session.id}
                onOpen={openProgramSession}
                onStop={handleStop}
                onRestart={handleRestart}
              />
            ))
          )}
        </section>
      </div>
    </div>
  );
}