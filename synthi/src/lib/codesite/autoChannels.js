import prisma from '@/lib/prisma';
import {
  channelsDisabled,
  effectiveChannelMode,
  modeTransports,
} from './channelSecurity';
import { hashChannelToken } from './channelSecurity';
import { asArray, parseJson, unique } from './json';

/**
 * direct_preferred auto-open (docs/CHANNEL_MODES_TRADEOFFS.md Mode 3):
 * when an agent files an execution plan in a direct_preferred project,
 * channels are opened automatically to every other capable agent in the
 * same shared session — no manual request step. Auto-accepted by design:
 * the mode itself is the standing agreement between the humans running the
 * agents. Every auto channel still lands in the causal timeline.
 */
export async function autoOpenDirectChannels(workspaceSlug, session) {
  if (channelsDisabled()) return [];
  const project = await prisma.codeSiteProject.findFirst({
    where: { id: session.projectId, workspaceSlug },
    include: { agentSessions: true },
  });
  if (!project) return [];
  // Only the fast lane auto-opens. registered_direct keeps the governed
  // request/accept handshake; mediated_only has no direct channels at all.
  const modeCheck = effectiveChannelMode(project.channelMode || 'registered_direct');
  if (!modeCheck.ok || modeCheck.mode !== 'direct_preferred') return [];
  const transports = modeTransports(modeCheck.mode, process.env.NODE_ENV);
  if (!transports.includes('websocket')) return [];

  const now = new Date();
  // Mode 3 is a standing agreement, but only between *capable* agents: the
  // responder must hold codesite.channels.open exactly as the manual
  // request/accept path requires (fail-closed).
  const peers = (project.agentSessions || []).filter((peer) => {
    if (peer.id === session.id || peer.endedAt) return false;
    if (peer.collaborationSessionId !== session.collaborationSessionId) return false;
    const peerCapabilities = unique(asArray(parseJson(peer.capabilitiesJson, []))
      .map((capability) => String(capability || '').trim())
      .filter(Boolean));
    return peerCapabilities.includes('codesite.channels.open');
  });
  const opened = [];
  for (const peer of peers) {
    const duplicate = await prisma.codeSiteAgentChannel.findFirst({
      where: {
        projectId: project.id,
        OR: [
          { fromSessionId: session.id, toSessionId: peer.id },
          { fromSessionId: peer.id, toSessionId: session.id },
        ],
        status: { in: ['requested', 'active'] },
      },
    });
    if (duplicate) continue;
    // No responder token is minted here — tokens are minted where they can be
    // delivered. The initiator keeps its own token from plan-filing context;
    // the peer opens its direction on demand via the manual request path,
    // which delivers a real token inside an authenticated response.
    const created = await prisma.codeSiteAgentChannel.create({
      data: {
        projectId: project.id,
        workspaceSlug,
        fromSessionId: session.id,
        toSessionId: peer.id,
        status: 'active',
        purpose: 'auto_open_direct_preferred',
        transport: 'websocket',
        channelTokenHash: hashChannelToken(''),
        openedAt: now,
        maxDurationMs: 1_800_000,
        messageCount: 0,
      },
    });
    await prisma.codeSiteEvent.create({
      data: {
        projectId: project.id,
        workspaceSlug,
        // Not 'channel_accepted' — nothing was accepted. The auto-open is its
        // own audit event type so the causal timeline stays truthful.
        eventType: 'channel_auto_opened',
        actorType: 'agent_session',
        actorId: session.id,
        detailsJson: JSON.stringify({
          channelId: created.id,
          fromSessionId: session.id,
          toSessionId: peer.id,
          transport: 'websocket',
          reasonCode: 'direct_preferred_auto_open',
        }),
      },
    });
    opened.push({ channelId: created.id, toSessionId: peer.id });
  }
  return opened;
}
