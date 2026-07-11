'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { Plug, RefreshCw, Trash2, CheckCircle2, XCircle, Circle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import AddConnectionDialog from './AddConnectionDialog';
import CliAccessSection from './CliAccessSection';
import GitProvidersSection from './GitProvidersSection';
import { fetchConnections, deleteConnection, testConnection, updateConnection } from './integrationsClient';

function relativeTime(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const HEALTH_ICON = {
  ok: { Icon: CheckCircle2, color: 'var(--accent-success)' },
  error: { Icon: XCircle, color: 'var(--accent-danger)' },
};

function HealthDot({ state }) {
  const entry = state && HEALTH_ICON[state] ? HEALTH_ICON[state] : (state && state !== 'ok' ? HEALTH_ICON.error : null);
  if (!entry) return <Circle className="w-3.5 h-3.5" style={{ color: 'var(--text-dim)' }} />;
  const { Icon, color } = entry;
  return <Icon className="w-3.5 h-3.5" style={{ color }} title={state} />;
}

export default function ConnectedToolsPanel() {
  const workspaceSlug = useSelector((s) => s.workspace?.slug || null);
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toolsByConn, setToolsByConn] = useState({}); // id -> [{name, description}]

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setConnections(await fetchConnections(workspaceSlug));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [workspaceSlug]);

  useEffect(() => { load(); }, [load]);

  const onTest = async (conn) => {
    try {
      const res = await testConnection(conn.id);
      if (res.ok) {
        setToolsByConn((m) => ({ ...m, [conn.id]: res.tools || [] }));
        toast.success(`${conn.name}: ${res.toolCount} tools available`);
      } else {
        toast.error(`${conn.name}: ${res.state}`);
      }
      load();
    } catch (e) {
      toast.error(e.message);
    }
  };

  const onToggleTool = async (conn, toolName) => {
    const current = new Set(conn.toolAllowlist || []);
    current.has(toolName) ? current.delete(toolName) : current.add(toolName);
    try {
      const updated = await updateConnection(conn.id, { toolAllowlist: [...current] });
      setConnections((cs) => cs.map((c) => (c.id === conn.id ? updated : c)));
    } catch (e) {
      toast.error(e.message);
    }
  };

  const onToggleEnabled = async (conn) => {
    try {
      const updated = await updateConnection(conn.id, { enabled: !conn.enabled });
      setConnections((cs) => cs.map((c) => (c.id === conn.id ? updated : c)));
    } catch (e) {
      toast.error(e.message);
    }
  };

  const onDelete = async (conn) => {
    try {
      await deleteConnection(conn.id);
      setConnections((cs) => cs.filter((c) => c.id !== conn.id));
      toast.success(`Removed "${conn.name}"`);
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <div className="vt-app-surface flex h-full flex-col" style={{ color: 'var(--text-primary)' }}>
      <div className="vt-toolbar flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
          <Plug className="w-3.5 h-3.5" /> Connected Tools
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="icon" onClick={load} title="Refresh"><RefreshCw className="w-3.5 h-3.5" /></Button>
          <AddConnectionDialog workspaceSlug={workspaceSlug} onCreated={() => load()} />
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
        {loading && (
          <div className="space-y-2 px-1 py-2">
            <div className="vt-skeleton h-12 rounded-[var(--radius-panel)]" />
            <div className="vt-skeleton h-12 rounded-[var(--radius-panel)]" />
          </div>
        )}
        {!loading && connections.length === 0 && (
          <div className="vt-empty-state text-center text-xs">
            No tools connected yet. Click "Add connection" to connect an MCP server
            (GitHub, Sentry, Linear, TesterArmy…).
          </div>
        )}

        {connections.map((conn) => {
          const tools = toolsByConn[conn.id] || [];
          const allow = new Set(conn.toolAllowlist || []);
          return (
            <div key={conn.id} className="vt-shell-panel">
              <div className="flex items-center justify-between px-2.5 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  <HealthDot state={conn.lastHealthState} />
                  <span className="text-sm truncate">{conn.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>
                    {conn.scope}
                  </span>
                  {conn.lastHealthAt && (
                    <span className="text-[10px]" style={{ color: 'var(--text-dim)' }}>
                      checked {relativeTime(conn.lastHealthAt)}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => onToggleEnabled(conn)} title={conn.enabled ? 'Enabled' : 'Disabled'}
                    className={`th-focus-ring rounded-[var(--radius-control)] border px-1.5 py-0.5 text-[10px] ${conn.enabled ? 'th-btn-active' : 'th-btn-ghost'}`}
                    style={{ color: conn.enabled ? 'var(--accent-success)' : 'var(--text-secondary)' }}>
                    {conn.enabled ? 'on' : 'off'}
                  </button>
                  <Button variant="ghost" size="icon" onClick={() => onTest(conn)} title="Test & list tools"><RefreshCw className="w-3.5 h-3.5" /></Button>
                  <Button variant="ghost" size="icon" onClick={() => onDelete(conn)} title="Remove"><Trash2 className="w-3.5 h-3.5" /></Button>
                </div>
              </div>

              {tools.length > 0 && (
                <div className="px-2.5 pb-2 flex flex-col gap-1 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                  <div className="text-[10px] uppercase tracking-wider pt-2" style={{ color: 'var(--text-muted)' }}>
                    Tool permissions
                  </div>
                  {tools.map((t) => (
                    <button
                      key={t.name}
                      type="button"
                      role="checkbox"
                      aria-checked={allow.has(t.name)}
                      onClick={() => onToggleTool(conn, t.name)}
                      className="th-focus-ring grid min-h-8 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2 rounded-[var(--radius-control)] border px-2 text-left text-xs"
                      style={{
                        borderColor: allow.has(t.name)
                          ? 'color-mix(in srgb, var(--accent-primary) 42%, var(--border-subtle))'
                          : 'var(--border-subtle)',
                        background: allow.has(t.name)
                          ? 'color-mix(in srgb, var(--accent-primary) 10%, var(--bg-panel))'
                          : 'color-mix(in srgb, var(--bg-editor) 56%, transparent)',
                      }}
                    >
                      <span
                        className="grid h-4 w-4 place-items-center rounded border"
                        style={{
                          borderColor: allow.has(t.name) ? 'var(--accent-primary)' : 'var(--border-medium)',
                          color: 'var(--accent-primary)',
                        }}
                      >
                        {allow.has(t.name) ? <CheckCircle2 className="h-3 w-3" /> : null}
                      </span>
                      <span className="truncate font-mono">{t.name}</span>
                      <span className="text-[10px]" style={{ color: allow.has(t.name) ? 'var(--accent-primary)' : 'var(--text-muted)' }}>
                        {allow.has(t.name) ? 'allowed' : 'blocked'}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {tools.length === 0 && (allow.size > 0) && (
                <div className="px-2.5 pb-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {allow.size} tool(s) enabled. Click test to refresh the list.
                </div>
              )}
            </div>
          );
        })}
        <CliAccessSection />
        <GitProvidersSection />
      </div>
    </div>
  );
}
