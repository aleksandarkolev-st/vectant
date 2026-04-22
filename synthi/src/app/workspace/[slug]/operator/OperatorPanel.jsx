'use client';

// OperatorPanel — live view of a session's attached peers with a kill
// switch. Hosted at `/workspace/<slug>/operator`. Talks to the
// signaling server as role="operator" via `OperatorClient`; receives
// `presence` broadcasts and sends `kick-peer` on button click.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import OperatorClient from '@/services/operatorClient';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

const KICKABLE_ROLES = [
  {
    role: 'observer',
    label: 'MCP / observer peers',
    description:
      "Disconnects every observer slot (the Synthi MCP registers here). Use when an agent is misbehaving.",
  },
  {
    role: 'mcp-agent',
    label: 'mcp-agent peers',
    description:
      "Forward-compat slot for agents that register as mcp-agent rather than observer.",
  },
  {
    role: 'browser',
    label: 'Browser peer',
    description:
      "Drops the human browser session. Rarely what you want — prefer asking the user to close the tab.",
  },
];

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
    <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}

export default function OperatorPanel({ sessionId }) {
  const [connState, setConnState] = useState('connecting');
  const [presence, setPresence] = useState({ attachedHumans: 0, attachedAgents: 0 });
  const [lastKick, setLastKick] = useState(null);
  const [kicking, setKicking] = useState(null);
  const [error, setError] = useState(null);
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
    client.connect();
    return () => {
      offConn();
      offPresence();
      offEvicted();
      offError();
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
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Operator console</h1>
          <p className="text-muted-foreground text-sm">
            Session <code className="font-mono">{sessionId}</code>
          </p>
        </div>
        <StatusPill state={connState} />
      </header>

      {error ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Attached peers</CardTitle>
          <CardDescription>
            Live counts broadcast by the signaling server. Operators do not count — only peers
            that are part of the input/video loop.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-10 text-base">
          <div>
            <div className="text-muted-foreground text-xs uppercase tracking-wider">Humans</div>
            <div className="text-3xl font-semibold">{presence.attachedHumans}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs uppercase tracking-wider">Agents</div>
            <div className="text-3xl font-semibold">{presence.attachedAgents}</div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Kill switch</CardTitle>
          <CardDescription>
            Hard-disconnect every peer of a given role. The signaling server sends the targeted
            peer a final <code className="font-mono">{'{type:"evicted"}'}</code> frame and closes
            the socket; any in-flight MCP tool call the agent had pending returns a transport
            error on its side. Worker and operator roles are never kickable.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {KICKABLE_ROLES.map(({ role, label, description }) => (
            <div
              key={role}
              className="flex items-start justify-between gap-4 rounded-md border px-4 py-3"
            >
              <div className="min-w-0">
                <div className="font-medium">{label}</div>
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
        </CardContent>
      </Card>

      {lastKick ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Last kick</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            Role <code className="font-mono">{lastKick.role}</code> — kicked{' '}
            <strong>{lastKick.kicked}</strong> peer(s) at{' '}
            <span className="text-muted-foreground">
              {new Date(lastKick.at).toLocaleTimeString()}
            </span>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
