'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Globe, HeartPulse, RotateCcw, ScrollText, Settings2, Square, TerminalSquare } from 'lucide-react';
import { toast } from 'sonner';
import TerminalPane from '@/app/workspace/TerminalPane.jsx';
import {
  fetchProgramSession,
  fetchProgramSessionEvents,
  getProgramSessionAppUrl,
  restartProgramSessionRuntime,
  stopProgramSessionRuntime,
} from '@/services/programSessionClient';

const SUBTABS = [
  { id: 'app', label: 'App', Icon: Globe },
  { id: 'logs', label: 'Logs', Icon: ScrollText },
  { id: 'terminal', label: 'Terminal', Icon: TerminalSquare },
  { id: 'ports', label: 'Ports', Icon: Activity },
  { id: 'health', label: 'Health', Icon: HeartPulse },
  { id: 'settings', label: 'Settings', Icon: Settings2 },
];

function formatTimestamp(value) {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return new Date(timestamp).toLocaleString();
}

function formatEventData(data) {
  if (!data || typeof data !== 'object') {
    return data == null ? '' : String(data);
  }
  return JSON.stringify(data, null, 2);
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

export default function ProgramSessionPanel({ workspaceSlug, sessionId, title = 'Program Session' }) {
  const [activeTab, setActiveTab] = useState('app');
  const [session, setSession] = useState(null);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!workspaceSlug || !sessionId) {
      setSession(null);
      setEvents([]);
      setLoading(false);
      return;
    }

    if (!silent) {
      setLoading(true);
    }

    try {
      const [nextSession, nextEvents] = await Promise.all([
        fetchProgramSession(workspaceSlug, sessionId),
        fetchProgramSessionEvents(workspaceSlug, sessionId),
      ]);
      setSession(nextSession);
      setEvents(nextEvents);
      setError(null);
    } catch (nextError) {
      setError(nextError.message || 'Failed to load program session');
    } finally {
      setLoading(false);
    }
  }, [workspaceSlug, sessionId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!workspaceSlug || !sessionId) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      load({ silent: true });
    }, 5000);

    return () => window.clearInterval(timer);
  }, [load, sessionId, workspaceSlug]);

  const appUrl = useMemo(() => getProgramSessionAppUrl(session?.webPort ?? null), [session?.webPort]);
  const ports = Array.isArray(session?.activePorts) ? session.activePorts : [];

  const handleStop = useCallback(async () => {
    if (!workspaceSlug || !sessionId) return;

    setActing(true);
    try {
      const next = await stopProgramSessionRuntime(workspaceSlug, sessionId);
      setSession(next);
      toast.success('Program stopped');
      await load({ silent: true });
    } catch (nextError) {
      toast.error(nextError.message || 'Failed to stop program');
    } finally {
      setActing(false);
    }
  }, [load, sessionId, workspaceSlug]);

  const handleRestart = useCallback(async () => {
    if (!workspaceSlug || !sessionId) return;

    setActing(true);
    try {
      const next = await restartProgramSessionRuntime(workspaceSlug, sessionId);
      setSession(next);
      toast.success('Program restarted');
      await load({ silent: true });
    } catch (nextError) {
      toast.error(nextError.message || 'Failed to restart program');
    } finally {
      setActing(false);
    }
  }, [load, sessionId, workspaceSlug]);

  return (
    <div className="h-full min-h-0 flex flex-col" style={{ background: 'var(--bg-editor)', color: 'var(--text-primary)' }}>
      <div className="px-4 py-3 border-b flex items-center justify-between gap-3" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{title}</div>
          <div className="flex items-center gap-2 mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            <span>{sessionId}</span>
            {session?.state ? (
              <span className="px-1.5 py-0.5 rounded uppercase tracking-wider" style={stateTone(session.state)}>
                {session.state}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleRestart}
            disabled={acting}
            className="h-8 px-2.5 rounded border text-xs inline-flex items-center gap-1.5"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
          >
            <RotateCcw className="w-3.5 h-3.5" /> Restart
          </button>
          <button
            type="button"
            onClick={handleStop}
            disabled={acting}
            className="h-8 px-2.5 rounded border text-xs inline-flex items-center gap-1.5"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
          >
            <Square className="w-3.5 h-3.5" /> Stop
          </button>
        </div>
      </div>

      <div className="px-3 py-2 border-b flex items-center gap-1 overflow-x-auto" style={{ borderColor: 'var(--border-subtle)' }}>
        {SUBTABS.map(({ id, label, Icon }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTab(id)}
              className="h-8 px-3 rounded-md text-xs inline-flex items-center gap-1.5 whitespace-nowrap"
              style={active
                ? { background: 'color-mix(in srgb, var(--accent-primary) 18%, transparent)', color: 'var(--text-primary)' }
                : { color: 'var(--text-muted)' }}
            >
              <Icon className="w-3.5 h-3.5" /> {label}
            </button>
          );
        })}
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {loading ? (
          <div className="h-full flex items-center justify-center text-sm" style={{ color: 'var(--text-muted)' }}>Loading session…</div>
        ) : error ? (
          <div className="h-full flex items-center justify-center text-sm px-6 text-center" style={{ color: 'var(--text-muted)' }}>{error}</div>
        ) : activeTab === 'app' ? (
          appUrl ? (
            <iframe
              title={`${title} app`}
              src={appUrl}
              className="w-full h-full border-0"
              sandbox="allow-same-origin allow-scripts allow-forms allow-modals allow-popups allow-downloads"
              allow="clipboard-read; clipboard-write"
            />
          ) : (
            <div className="h-full flex items-center justify-center text-sm px-6 text-center" style={{ color: 'var(--text-muted)' }}>
              No web port is active for this session yet.
            </div>
          )
        ) : activeTab === 'logs' ? (
          <div className="h-full overflow-auto px-4 py-3 flex flex-col gap-3">
            {events.length === 0 ? (
              <div className="text-sm" style={{ color: 'var(--text-muted)' }}>No runtime events yet.</div>
            ) : events.map((event, index) => (
              <div key={`${event.type}-${event.createdAt}-${index}`} className="rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}>
                <div className="flex items-center justify-between gap-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                  <span className="uppercase tracking-wider">{event.type}</span>
                  <span>{formatTimestamp(event.createdAt) || 'unknown time'}</span>
                </div>
                {event.data ? (
                  <pre className="mt-2 text-xs whitespace-pre-wrap break-words" style={{ color: 'var(--text-secondary)' }}>{formatEventData(event.data)}</pre>
                ) : null}
              </div>
            ))}
          </div>
        ) : activeTab === 'terminal' ? (
          <div className="h-full min-h-0">
            <TerminalPane
              terminalId={`program-session-${sessionId}`}
              paneSide="main"
              workspaceSlug={workspaceSlug}
              fixedSessionId={sessionId}
            />
          </div>
        ) : activeTab === 'ports' ? (
          <div className="h-full overflow-auto px-4 py-3 flex flex-col gap-2">
            {ports.length === 0 ? (
              <div className="text-sm" style={{ color: 'var(--text-muted)' }}>No exposed ports.</div>
            ) : ports.map((port) => (
              <div key={port} className="rounded-md border px-3 py-2 flex items-center justify-between" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}>
                <span className="text-sm">Port {port}</span>
                {typeof session?.webPort === 'number' && port === session.webPort ? (
                  <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'color-mix(in srgb, #60a5fa 18%, transparent)', color: 'var(--text-primary)' }}>App</span>
                ) : null}
              </div>
            ))}
          </div>
        ) : activeTab === 'health' ? (
          <div className="h-full overflow-auto px-4 py-3 flex flex-col gap-3">
            <div className="rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}>
              <div className="text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Runtime state</div>
              <div className="mt-2 text-sm">{session?.state || 'unknown'}</div>
            </div>
            <div className="rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}>
              <div className="text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Last health signal</div>
              <div className="mt-2 text-sm">{session?.lastHealthState || 'No health checks recorded yet'}</div>
            </div>
            <div className="rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}>
              <div className="text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Timestamps</div>
              <div className="mt-2 text-sm flex flex-col gap-1" style={{ color: 'var(--text-secondary)' }}>
                <span>Started: {formatTimestamp(session?.startedAt) || 'unknown'}</span>
                <span>Ended: {formatTimestamp(session?.endedAt) || 'still active'}</span>
                <span>Updated: {formatTimestamp(session?.updatedAt) || 'unknown'}</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="h-full overflow-auto px-4 py-3 flex flex-col gap-3">
            <div className="rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}>
              <div className="text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Session settings</div>
              <div className="mt-2 text-sm flex flex-col gap-1" style={{ color: 'var(--text-secondary)' }}>
                <span>ID: {sessionId}</span>
                <span>Runtime: {session?.runtimeType || 'cli'}</span>
                <span>Workspace: {workspaceSlug}</span>
              </div>
            </div>
            <div className="rounded-md border p-3 flex items-center justify-between gap-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}>
              <div>
                <div className="text-sm font-medium">Lifecycle</div>
                <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>Use the existing managed runtime controls for this session.</div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleRestart}
                  disabled={acting}
                  className="h-8 px-2.5 rounded border text-xs inline-flex items-center gap-1.5"
                  style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                >
                  <RotateCcw className="w-3.5 h-3.5" /> Restart
                </button>
                <button
                  type="button"
                  onClick={handleStop}
                  disabled={acting}
                  className="h-8 px-2.5 rounded border text-xs inline-flex items-center gap-1.5"
                  style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                >
                  <Square className="w-3.5 h-3.5" /> Stop
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}