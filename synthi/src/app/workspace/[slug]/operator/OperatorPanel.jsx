'use client';

// OperatorPanel — content-only view for the operator console. Safe to
// drop into any shell (dialog, sheet, standalone page) because it owns
// no outer container padding. Renders:
//   - status pill + presence counters
//   - per-role kick switch buttons
//   - live event log (register / disconnect / kick) streamed from the
//     signaling server
//
// State lives here so both the dialog and a standalone-page embedding
// share one React lifecycle for the underlying OperatorClient.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import OperatorClient from '@/services/operatorClient';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

const KICKABLE_ROLES = [
  {
    role: 'observer',
    label: 'MCP / observer peers',
    description: 'Disconnects every observer slot (Synthi MCP registers here).',
  },
  {
    role: 'mcp-agent',
    label: 'mcp-agent peers',
    description: 'Forward-compat slot for agents on the mcp-agent role.',
  },
  {
    role: 'browser',
    label: 'Browser peer',
    description: 'Drops the human browser session. Rarely what you want.',
  },
];

const MAX_EVENTS = 200;

function StatusPill({ state }) {
  const { label, cls } = useMemo(() => {
    switch (state) {
      case 'connected':
        return { label: 'connected', cls: 'bg-emerald-500/20 text-emerald-400' };
      case 'connecting':
        return { label: 'connecting…', cls: 'bg-amber-500/20 text-amber-400' };
      case 'disconnected':
        return { label: 'disconnected', cls: 'bg-zinc-500/20 text-zinc-400' };
      case 'evicted':
        return { label: 'evicted', cls: 'bg-red-500/20 text-red-400' };
      default:
        return { label: state, cls: 'bg-zinc-500/20 text-zinc-400' };
    }
  }, [state]);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}
    >
      {label}
    </span>
  );
}

function formatEventLine(ev) {
  // Produce one compact line per event. Kept as plain strings so the
  // log view can render them in a <code> block without needing per-kind
  // markup; richer styling can land later if the UI gets busy.
  const ts = new Date(ev.tsMs ?? Date.now()).toLocaleTimeString();
  switch (ev.kind) {
    case 'peer_registered':
      return `${ts}  +  ${ev.role} joined  (${shortId(ev.peerId)})`;
    case 'peer_disconnected': {
      const flag = ev.disconnectKind === 'kick' ? 'KICKED' : 'left';
      return `${ts}  –  ${ev.role} ${flag}  (${shortId(ev.peerId)})`;
    }
    case 'kick_executed':
      return `${ts}  ⚡ kick  target=${ev.targetRole}  kicked=${ev.kicked}  reason=${ev.reason}`;
    default:
      return `${ts}  ?  ${JSON.stringify(ev)}`;
  }
}

function shortId(pid) {
  if (!pid || typeof pid !== 'string') return '';
  return pid.length > 8 ? `${pid.slice(0, 8)}…` : pid;
}

export default function OperatorPanel({ sessionId }) {
  const [connState, setConnState] = useState('connecting');
  const [presence, setPresence] = useState({ attachedHumans: 0, attachedAgents: 0 });
  const [lastKick, setLastKick] = useState(null);
  const [kicking, setKicking] = useState(null);
  const [error, setError] = useState(null);
  const [events, setEvents] = useState([]);
  const clientRef = useRef(null);

  useEffect(() => {
    if (!sessionId) return;
    const client = new OperatorClient({ sessionId });
    clientRef.current = client;
    const offConn = client.on('connection', (c) => setConnState(c.state));
    const offPresence = client.on('presence', (p) => setPresence(p));
    const offEvicted = client.on('evicted', (e) => {
      setConnState('evicted');
      setError(`Operator was evicted: ${e.reason}`);
    });
    const offError = client.on('error', () => {
      setError('Signaling connection error — see browser devtools.');
    });
    const offEvent = client.on('event', (ev) => {
      setEvents((prev) => {
        const next = [...prev, ev];
        if (next.length > MAX_EVENTS) next.splice(0, next.length - MAX_EVENTS);
        return next;
      });
    });
    client.connect();
    return () => {
      offConn();
      offPresence();
      offEvicted();
      offError();
      offEvent();
      client.disconnect();
      clientRef.current = null;
    };
  }, [sessionId]);

  const handleKick = useCallback(
    async (role) => {
      const client = clientRef.current;
      if (!client || connState !== 'connected') return;
      setKicking(role);
      setError(null);
      try {
        const result = await client.kickPeer(role, 'operator_kill_switch');
        setLastKick({
          role: result.targetRole,
          kicked: result.kicked,
          at: new Date().toISOString(),
        });
      } catch (err) {
        setError(`Kick failed: ${err.message ?? err}`);
      } finally {
        setKicking(null);
      }
    },
    [connState]
  );

  return (
    <div className="flex flex-col gap-5 text-sm">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-muted-foreground text-xs">
            Session <code className="font-mono">{sessionId}</code>
          </div>
        </div>
        <StatusPill state={connState} />
      </header>

      {error ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      ) : null}

      <section className="flex items-center gap-8 rounded-md border px-4 py-3">
        <div>
          <div className="text-muted-foreground text-[10px] uppercase tracking-wider">
            Humans
          </div>
          <div className="text-2xl font-semibold">{presence.attachedHumans}</div>
        </div>
        <div>
          <div className="text-muted-foreground text-[10px] uppercase tracking-wider">
            Agents
          </div>
          <div className="text-2xl font-semibold">{presence.attachedAgents}</div>
        </div>
      </section>

      <section className="space-y-2">
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Kill switch
        </div>
        {KICKABLE_ROLES.map(({ role, label, description }) => (
          <div
            key={role}
            className="flex items-start justify-between gap-3 rounded-md border px-3 py-2"
          >
            <div className="min-w-0">
              <div className="text-sm font-medium">{label}</div>
              <p className="text-muted-foreground text-xs">{description}</p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              disabled={connState !== 'connected' || kicking != null}
              onClick={() => handleKick(role)}
            >
              {kicking === role ? 'Kicking…' : 'Kick'}
            </Button>
          </div>
        ))}
        {lastKick ? (
          <div className="text-xs text-muted-foreground">
            Last: <code className="font-mono">{lastKick.role}</code> — kicked{' '}
            <strong>{lastKick.kicked}</strong> at{' '}
            {new Date(lastKick.at).toLocaleTimeString()}
          </div>
        ) : null}
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Event log
          </div>
          {events.length > 0 ? (
            <button
              type="button"
              onClick={() => setEvents([])}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          ) : null}
        </div>
        <ScrollArea className="h-48 rounded-md border">
          {events.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              (no events yet — peer register / disconnect / kick entries land here in real time)
            </div>
          ) : (
            <pre className="px-3 py-2 font-mono text-xs leading-relaxed">
              {events.map((ev, i) => (
                <div key={i}>{formatEventLine(ev)}</div>
              ))}
            </pre>
          )}
        </ScrollArea>
      </section>
    </div>
  );
}
