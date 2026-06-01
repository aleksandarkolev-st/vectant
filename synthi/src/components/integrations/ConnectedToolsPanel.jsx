'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { Plug, RefreshCw, Trash2, CheckCircle2, XCircle, Circle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import AddConnectionDialog from './AddConnectionDialog';
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
  ok: { Icon: CheckCircle2, color: 'var(--accent-success, #4ade80)' },
  error: { Icon: XCircle, color: 'var(--accent-danger, #ff5757)' },
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
    <div className="flex flex-col h-full" style={{ color: 'var(--text-primary)' }}>
      <div className="flex items-center justify-between px-3 py-2 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
          <Plug className="w-3.5 h-3.5" /> Connected Tools
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="icon" onClick={load} title="Refresh"><RefreshCw className="w-3.5 h-3.5" /></Button>
          <AddConnectionDialog workspaceSlug={workspaceSlug} onCreated={() => load()} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
        {loading && <div className="text-xs px-2 py-3" style={{ color: 'var(--text-muted)' }}>Loading…</div>}
        {!loading && connections.length === 0 && (
          <div className="text-xs px-2 py-6 text-center" style={{ color: 'var(--text-muted)' }}>
            No tools connected yet. Click "Add connection" to connect an MCP server
            (GitHub, Sentry, Linear, TesterArmy…).
          </div>
        )}

        {connections.map((conn) => {
          const tools = toolsByConn[conn.id] || [];
          const allow = new Set(conn.toolAllowlist || []);
          return (
            <div key={conn.id} className="rounded-lg border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}>
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
                    className="text-[10px] px-1.5 py-0.5 rounded"
                    style={{ background: conn.enabled ? 'color-mix(in srgb, #4ade80 18%, transparent)' : 'var(--bg-elevated)', color: 'var(--text-secondary)' }}>
                    {conn.enabled ? 'on' : 'off'}
                  </button>
                  <Button variant="ghost" size="icon" onClick={() => onTest(conn)} title="Test & list tools"><RefreshCw className="w-3.5 h-3.5" /></Button>
                  <Button variant="ghost" size="icon" onClick={() => onDelete(conn)} title="Remove"><Trash2 className="w-3.5 h-3.5" /></Button>
                </div>
              </div>

              {tools.length > 0 && (
                <div className="px-2.5 pb-2 flex flex-col gap-1 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                  <div className="text-[10px] uppercase tracking-wider pt-2" style={{ color: 'var(--text-muted)' }}>
                    Tools the AI may use
                  </div>
                  {tools.map((t) => (
                    <label key={t.name} className="flex items-center gap-2 text-xs cursor-pointer">
                      <input type="checkbox" checked={allow.has(t.name)} onChange={() => onToggleTool(conn, t.name)} />
                      <span className="font-mono">{t.name}</span>
                    </label>
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
      </div>
    </div>
  );
}
