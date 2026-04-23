'use client';

// EscapeHatchPanel — drains the MCP's escape-hatch queue.
//
// The MCP keeps pending `synthi_request_human` / `synthi_annotate_and_ask`
// questions in-process. An opt-in HTTP bridge
// (mcp/synthi-mcp/src/operator_bridge/server.ts, SYNTHI_OPERATOR_BRIDGE_PORT)
// exposes those questions here. The agent is parked on its tool-call
// promise until we post an answer.
//
// For `request_human`: free-text answer.
// For `annotate_and_ask`: we render the screenshot and let the operator
// click a coordinate — the click is the answer
// (`{click_coords: {x, y}, frame_w, frame_h}`).
//
// Config lives in localStorage so operators can point at a different
// MCP without a rebuild:
//   synthi.operatorBridgeUrl   (default http://127.0.0.1:9465)
//   synthi.operatorBridgeToken (optional — matches SYNTHI_OPERATOR_BRIDGE_TOKEN)

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import {
  cancelPending,
  getPending,
  listPending,
  resolveBridgeToken,
  resolveBridgeUrl,
  sendAnswer,
  subscribeSse,
} from '@/services/escapeHatchClient';

const POLL_MS = 3000;

function useBridgeConfig() {
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  useEffect(() => {
    setUrl(resolveBridgeUrl());
    setToken(resolveBridgeToken());
  }, []);
  const save = useCallback((nextUrl, nextToken) => {
    if (typeof window === 'undefined') return;
    if (nextUrl) window.localStorage.setItem('synthi.operatorBridgeUrl', nextUrl);
    if (nextToken !== undefined) {
      if (nextToken) window.localStorage.setItem('synthi.operatorBridgeToken', nextToken);
      else window.localStorage.removeItem('synthi.operatorBridgeToken');
    }
    setUrl(nextUrl);
    setToken(nextToken ?? '');
  }, []);
  return { url, token, save };
}

function BridgeSettings({ url, token, onSave }) {
  const [draftUrl, setDraftUrl] = useState(url);
  const [draftToken, setDraftToken] = useState(token);
  useEffect(() => setDraftUrl(url), [url]);
  useEffect(() => setDraftToken(token), [token]);
  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        Operator bridge
      </div>
      <Input
        value={draftUrl}
        onChange={(e) => setDraftUrl(e.target.value)}
        placeholder="http://127.0.0.1:9465"
        className="h-8 text-xs"
      />
      <Input
        value={draftToken}
        onChange={(e) => setDraftToken(e.target.value)}
        placeholder="Optional X-Synthi-Operator-Token"
        className="h-8 text-xs"
      />
      <Button
        size="sm"
        variant="secondary"
        onClick={() => onSave(draftUrl.trim(), draftToken.trim())}
      >
        Save
      </Button>
    </div>
  );
}

function RequestHumanEntry({ entry, onAnswer, onCancel, busy }) {
  const [text, setText] = useState('');
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="text-xs text-muted-foreground">
        <code className="font-mono">{entry.pending_id.slice(0, 18)}…</code> ·{' '}
        {entry.source_tool}
      </div>
      <div className="text-sm">{entry.question}</div>
      <Textarea
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Answer (string or JSON)…"
        className="font-mono text-xs"
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={busy || !text.trim()}
          onClick={() => {
            let parsed = text;
            try {
              parsed = JSON.parse(text);
            } catch {
              /* send as string */
            }
            onAnswer(parsed);
          }}
        >
          Send answer
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={busy}
          onClick={() => onCancel('operator_declined')}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function AnnotateAndAskEntry({ entry, full, onAnswer, onCancel, busy }) {
  const imgRef = useRef(null);
  const [coords, setCoords] = useState(null);
  const src = useMemo(() => {
    const b64 = full?.screenshot_base64;
    return b64 ? `data:image/png;base64,${b64}` : null;
  }, [full]);

  const handleClick = useCallback(
    (evt) => {
      if (!imgRef.current) return;
      const rect = imgRef.current.getBoundingClientRect();
      const px = evt.clientX - rect.left;
      const py = evt.clientY - rect.top;
      // Map from rendered-px → natural-px so the click answer survives
      // CSS scaling. The agent gets original-screenshot-native coords.
      const nw = imgRef.current.naturalWidth || rect.width;
      const nh = imgRef.current.naturalHeight || rect.height;
      const sx = Math.round((px / rect.width) * nw);
      const sy = Math.round((py / rect.height) * nh);
      setCoords({
        rendered: { x: Math.round(px), y: Math.round(py), w: Math.round(rect.width), h: Math.round(rect.height) },
        natural: { x: sx, y: sy, w: nw, h: nh },
      });
    },
    [],
  );

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="text-xs text-muted-foreground">
        <code className="font-mono">{entry.pending_id.slice(0, 18)}…</code> ·{' '}
        {entry.source_tool}
      </div>
      <div className="text-sm">{entry.question}</div>
      {src ? (
        <div className="relative inline-block">
          <img
            ref={imgRef}
            src={src}
            alt="Agent-supplied frame"
            onClick={handleClick}
            className="max-h-96 max-w-full cursor-crosshair rounded border"
          />
          {coords ? (
            <span
              className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-amber-400 bg-amber-400/30"
              style={{ left: coords.rendered.x, top: coords.rendered.y }}
            />
          ) : null}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">
          (screenshot still loading…)
        </div>
      )}
      {coords ? (
        <div className="text-xs text-muted-foreground">
          Click at <code className="font-mono">({coords.natural.x}, {coords.natural.y})</code>{' '}
          of <code className="font-mono">{coords.natural.w}×{coords.natural.h}</code>
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">
          Click a point on the screenshot to annotate.
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={busy || !coords}
          onClick={() =>
            onAnswer({
              click_coords: { x: coords.natural.x, y: coords.natural.y },
              frame_w: coords.natural.w,
              frame_h: coords.natural.h,
            })
          }
        >
          Send click
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={busy}
          onClick={() => onCancel('operator_declined')}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

export default function EscapeHatchPanel() {
  const { url, token, save } = useBridgeConfig();
  const [entries, setEntries] = useState([]);
  const [fullEntries, setFullEntries] = useState({});
  const [lastError, setLastError] = useState(null);
  const [streamState, setStreamState] = useState('idle');
  const [busyId, setBusyId] = useState(null);
  const [operatorId] = useState(() => {
    if (typeof window === 'undefined') return '';
    const existing = window.localStorage?.getItem('synthi.operatorId');
    if (existing) return existing;
    const fresh = `op-${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage?.setItem('synthi.operatorId', fresh);
    return fresh;
  });

  const refreshList = useCallback(async () => {
    if (!url) return;
    try {
      const body = await listPending({ url, token });
      setEntries(body.entries ?? []);
      setLastError(null);
    } catch (err) {
      setLastError(err.message ?? String(err));
    }
  }, [url, token]);

  // Fetch full entries (with screenshots) lazily as new pending_ids appear.
  useEffect(() => {
    if (!url) return;
    const needed = entries
      .filter((e) => e.kind === 'annotate_and_ask' && !fullEntries[e.pending_id])
      .map((e) => e.pending_id);
    if (needed.length === 0) return;
    let cancelled = false;
    (async () => {
      const next = { ...fullEntries };
      for (const id of needed) {
        try {
          const entry = await getPending({ url, token, pendingId: id });
          if (entry) next[id] = entry;
        } catch {
          // skip; next poll retries
        }
      }
      if (!cancelled) setFullEntries(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [entries, fullEntries, url, token]);

  // Polling — works with token-gated bridges where EventSource can't attach headers.
  useEffect(() => {
    if (!url) return undefined;
    let active = true;
    const tick = async () => {
      if (!active) return;
      await refreshList();
      if (active) setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      active = false;
    };
  }, [url, refreshList]);

  // SSE — only used when no token (EventSource can't send custom headers).
  useEffect(() => {
    if (!url || token) return undefined;
    setStreamState('connecting');
    const unsub = subscribeSse({
      url,
      onEvent: ({ type, data }) => {
        setStreamState('connected');
        if (type === 'snapshot' && data?.entries) {
          setEntries(data.entries);
        } else if (type === 'pending' && data) {
          setEntries((prev) => [...prev.filter((e) => e.pending_id !== data.pending_id), data]);
        } else if (type === 'resolved' && data?.pending_id) {
          setEntries((prev) => prev.filter((e) => e.pending_id !== data.pending_id));
          setFullEntries((prev) => {
            const next = { ...prev };
            delete next[data.pending_id];
            return next;
          });
        }
      },
      onError: () => {
        setStreamState('error');
      },
    });
    return () => {
      setStreamState('idle');
      unsub();
    };
  }, [url, token]);

  const submitAnswer = useCallback(
    async (pendingId, answer) => {
      setBusyId(pendingId);
      try {
        await sendAnswer({ url, token, pendingId, answer, operatorId });
        setEntries((prev) => prev.filter((e) => e.pending_id !== pendingId));
        setFullEntries((prev) => {
          const next = { ...prev };
          delete next[pendingId];
          return next;
        });
      } catch (err) {
        setLastError(err.message ?? String(err));
      } finally {
        setBusyId(null);
      }
    },
    [url, token, operatorId],
  );

  const submitCancel = useCallback(
    async (pendingId, reason) => {
      setBusyId(pendingId);
      try {
        await cancelPending({ url, token, pendingId, reason });
        setEntries((prev) => prev.filter((e) => e.pending_id !== pendingId));
      } catch (err) {
        setLastError(err.message ?? String(err));
      } finally {
        setBusyId(null);
      }
    },
    [url, token],
  );

  return (
    <div className="flex flex-col gap-3 text-sm">
      <BridgeSettings url={url} token={token} onSave={save} />
      {lastError ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {lastError}
        </div>
      ) : null}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {entries.length} pending · operator <code className="font-mono">{operatorId}</code>
        </span>
        <span>
          stream: {token ? 'polling (token-gated)' : streamState}
        </span>
      </div>
      <ScrollArea className="max-h-[420px] pr-1">
        {entries.length === 0 ? (
          <div className="rounded-md border px-3 py-6 text-center text-xs text-muted-foreground">
            No pending escape-hatch questions. When an agent calls
            <code className="mx-1 font-mono">synthi_request_human</code>
            or <code className="mx-1 font-mono">synthi_annotate_and_ask</code>,
            entries land here in real time.
          </div>
        ) : (
          <div className="space-y-2">
            {entries.map((entry) =>
              entry.kind === 'annotate_and_ask' ? (
                <AnnotateAndAskEntry
                  key={entry.pending_id}
                  entry={entry}
                  full={fullEntries[entry.pending_id]}
                  busy={busyId === entry.pending_id}
                  onAnswer={(ans) => submitAnswer(entry.pending_id, ans)}
                  onCancel={(reason) => submitCancel(entry.pending_id, reason)}
                />
              ) : (
                <RequestHumanEntry
                  key={entry.pending_id}
                  entry={entry}
                  busy={busyId === entry.pending_id}
                  onAnswer={(ans) => submitAnswer(entry.pending_id, ans)}
                  onCancel={(reason) => submitCancel(entry.pending_id, reason)}
                />
              ),
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
