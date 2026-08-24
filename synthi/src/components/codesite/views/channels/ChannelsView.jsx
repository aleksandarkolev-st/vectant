"use client";

/**
 * Channels view — registered direct channels with one-click actions.
 * No curl required: open/accept/reject/close all happen from buttons here.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { ArrowLeftRight, Check, X } from "lucide-react";
import {
  fetchCodeSiteChannels,
  requestCodeSiteChannel,
  respondCodeSiteChannel,
} from "../../codesiteClient";
import { IconButton, Pill } from "../../ui";

const MODE_LABELS = {
  mediated_only: "🛡️ Mediated only",
  registered_direct: "⚖️ Registered direct",
  direct_preferred: "⚡ Direct preferred",
  open_local: "🧪 Open local (dev)",
};

function toneForStatus(status) {
  if (status === "active") return "clear";
  if (status === "requested") return "holding";
  if (status === "violation" || status === "rejected") return "blocked";
  return "idle";
}

export default function ChannelsView({
  workspaceSlug,
  project,
  acting = false,
}) {
  const [channels, setChannels] = useState([]);
  const [busyChannelId, setBusyChannelId] = useState(null);
  const [error, setError] = useState(null);
  const { data: authSession } = useSession();

  const projectId = project?.id || null;
  // Live sessions on the project — declared BEFORE anything derives from it.
  const sessions = useMemo(
    () => (project?.agentSessions || []).filter((s) => !s.endedAt),
    [project?.agentSessions],
  );
  const mode = project?.channelMode || "registered_direct";

  // The signed-in human's workspace identity (same value the IDE uses). A
  // channel is actionable when the viewer owns one of its two sessions —
  // matched via ownerUserId, never by positional fallback.
  const viewerWorkspaceUserId = authSession?.user?.id || authSession?.user?.email || null;
  const mySessions = useMemo(
    () => sessions.filter((s) => s.ownerUserId === viewerWorkspaceUserId),
    [sessions, viewerWorkspaceUserId],
  );
  const viewerSessionId = useMemo(() => {
    // Prefer an attached session the viewer actually owns. If several, pick
    // deterministically (most recent) rather than silently grabbing any.
    return [...mySessions].sort((a, b) =>
      String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")),
    )[0]?.id || null;
  }, [mySessions]);

  // The roster is scoped to the project's ACTUAL collaboration session, not
  // "every session ever attached". Sessions whose collaborationSessionId is
  // null (legacy/unbound) are shown only when the project itself has none.
  const projectCollabId = project?.collaborationSessionId || null;
  const inScopeSessions = useMemo(() => {
    if (!projectCollabId) return sessions;
    return sessions.filter((s) => s.collaborationSessionId === projectCollabId);
  }, [sessions, projectCollabId]);
  const rosterHeading = useMemo(() => {
    if (!projectCollabId) return "Agents attached to this project";
    const short = String(projectCollabId).length > 24
      ? `${String(projectCollabId).slice(0, 21)}…`
      : String(projectCollabId);
    return `Agents in collaboration session ${short}`;
  }, [projectCollabId]);

  // Session id → callsign map so channel rows read "SUBAGENT-A ↔ SUBAGENT-B"
  // instead of raw cuids. Falls back to the id for sessions already detached.
  const callsigns = useMemo(() => {
    const map = {};
    for (const s of sessions) {
      if (s.displayCallsign) map[s.id] = s.displayCallsign;
    }
    return map;
  }, [sessions]);
  const labelFor = useCallback(
    (sessionId) => callsigns[sessionId] || (sessionId ? `${sessionId.slice(0, 8)}…` : "?"),
    [callsigns],
  );

  const loadChannels = useCallback(async () => {
    if (!workspaceSlug || !projectId) return;
    try {
      setChannels(await fetchCodeSiteChannels(workspaceSlug, projectId));
      setError(null);
    } catch (err) {
      setError(err.message || "channels_fetch_failed");
    }
  }, [projectId, workspaceSlug]);

  useEffect(() => {
    loadChannels();
    const timer = setInterval(loadChannels, 5000);
    return () => clearInterval(timer);
  }, [loadChannels]);

  // A channel is actionable for the current viewer when the viewer owns one
  // of its two sessions (identity from the NextAuth session, see above).
  const handleAction = useCallback(
    async (channelId, action) => {
      const sessionId = viewerSessionId;
      if (!sessionId || busyChannelId) return;
      setBusyChannelId(channelId);
      try {
        await respondCodeSiteChannel(workspaceSlug, sessionId, channelId, action, {});
        await loadChannels();
        setError(null);
      } catch (err) {
        setError(err.message || `channel_${action}_failed`);
      } finally {
        setBusyChannelId(null);
      }
    },
    [busyChannelId, loadChannels, viewerSessionId, workspaceSlug],
  );

  const openChannelTo = useCallback(
    async (targetSessionId) => {
      if (!viewerSessionId || busyChannelId || targetSessionId === viewerSessionId) return;
      setBusyChannelId(targetSessionId);
      try {
        await requestCodeSiteChannel(workspaceSlug, viewerSessionId, {
          toSessionId: targetSessionId,
          transport: "websocket",
          purpose: "ui_open_channel",
          endpointRef: `ws://127.0.0.1:${Math.floor(Math.random() * 40000) + 10000}/ui`,
        });
        await loadChannels();
        setError(null);
      } catch (err) {
        setError(err.message || "channel_request_failed");
      } finally {
        setBusyChannelId(null);
      }
    },
    [busyChannelId, loadChannels, viewerSessionId, workspaceSlug],
  );

  const activeOrRequestedPairKeys = useMemo(() => {
    const keys = new Set();
    for (const c of channels) {
      if (["requested", "active"].includes(c.status)) {
        keys.add([c.fromSessionId, c.toSessionId].sort().join("::"));
      }
    }
    return keys;
  }, [channels]);

  if (!projectId) return null;

  return (
    <div className="grid content-start gap-3" data-testid="codesite-channels-view">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold">Direct channels</span>
        <Pill tone="default">{MODE_LABELS[mode] || mode}</Pill>
        {error ? <Pill tone="blocked">{String(error)}</Pill> : null}
        <IconButton title="Refresh channels" onClick={loadChannels}>
          <ArrowLeftRight className="h-3.5 w-3.5" />
        </IconButton>
      </div>

      {inScopeSessions.length < 2 ? (
        <div className="rounded border p-4 text-xs" style={{ color: "var(--text-muted)", borderColor: "var(--border-subtle)" }}>
          Attach at least two agent sessions to this project — each person attaches their own agent from their terminal. Channel controls appear here once two agents are present.
        </div>
      ) : (
        <div className="grid content-start gap-1">
          <div className="text-xs font-semibold">{rosterHeading}</div>
          {inScopeSessions.map((session) => {
            const pairKey = [viewerSessionId, session.id].sort().join("::");
            const alreadyPaired = activeOrRequestedPairKeys.has(pairKey);
            return (
              <div key={session.id} className="flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-2 text-xs" style={{ borderColor: "var(--border-subtle)" }}>
                <span>
                  <span className="font-medium">{session.displayCallsign || "agent"}</span>
                  <span style={{ color: "var(--text-muted)" }}>
                    {" "}· {session.agentProvider || "unknown"} · owner {session.ownerUserId}
                    {session.id === viewerSessionId ? " · this browser" : ""}
                  </span>
                </span>
                {session.id !== viewerSessionId ? (
                  <IconButton
                    title={`Open channel to ${session.displayCallsign || session.id}`}
                    variant="primary"
                    disabled={acting || busyChannelId === session.id || alreadyPaired}
                    onClick={() => openChannelTo(session.id)}
                  >
                    <ArrowLeftRight className="h-3.5 w-3.5" />
                    {alreadyPaired ? "Channel exists" : "Open channel"}
                  </IconButton>
                ) : (
                  <Pill tone="default">you</Pill>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Incoming requests: any session whose toSession matches shows Accept */}
      {channels.filter((c) => c.status === "requested").map((channel) => (
        <div key={channel.id} className="rounded border p-3" style={{ borderColor: "var(--border-subtle)" }} data-channel-id={channel.id} data-to-session={channel.toSessionId}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs">
              <span className="font-medium">{labelFor(channel.fromSessionId)}</span>
              {" → "}
              <span className="font-medium">{labelFor(channel.toSessionId)}</span>
              {" · "}
              <span style={{ color: "var(--text-muted)" }}>{channel.purpose}</span>
              {" · "}
              {channel.transport}
            </div>
            <div className="flex gap-1">
              <IconButton
                title="Accept channel"
                variant="primary"
                disabled={acting || busyChannelId === channel.id}
                onClick={() => handleAction(channel.id, "accept")}
              >
                <Check className="h-3.5 w-3.5" /> Accept
              </IconButton>
              <IconButton
                title="Reject channel"
                disabled={acting || busyChannelId === channel.id}
                onClick={() => handleAction(channel.id, "reject")}
              >
                <X className="h-3.5 w-3.5" /> Reject
              </IconButton>
            </div>
          </div>
        </div>
      ))}

      {/* All channels audit list */}
      {channels.length ? (
        <div className="grid content-start gap-1">
          {channels.map((channel) => (
            <div key={channel.id} className="flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-2 text-xs" style={{ borderColor: "var(--border-subtle)" }}>
              <span>
                {labelFor(channel.fromSessionId)}
                {" ↔ "}
                {labelFor(channel.toSessionId)}
                <span style={{ color: "var(--text-muted)" }}> · {channel.transport}{channel.messageCount ? ` · ${channel.messageCount} msgs` : ""}</span>
                {channel.purpose === "auto_open_direct_preferred" && (
                  <Pill tone="default">auto-opened</Pill>
                )}
              </span>
              <span className="flex items-center gap-2">
                <Pill tone={toneForStatus(channel.status)}>{channel.status}</Pill>
                {channel.status === "active" ? (
                  <IconButton
                    title="Close channel"
                    disabled={acting || busyChannelId === channel.id}
                    onClick={() => handleAction(channel.id, "close")}
                  >
                    Close
                  </IconButton>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      ) : sessions.length >= 2 ? (
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>
          No channels yet. Use “Open channel” on an agent card above.
        </div>
      ) : null}
    </div>
  );
}
