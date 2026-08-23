import prisma from '@/lib/prisma';
import {
  channelsDisabled,
  effectiveChannelMode,
  modeTransports,
} from './channelSecurity';
import { hashChannelToken, mintChannelToken } from './channelSecurity';

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
  if (!modeCheck.ok) return [];
  const transports = modeTransports(modeCheck.mode, process.env.NODE_ENV);
  if (!transports.includes('websocket')) return [];

  const now = new Date();
  const peers = (project.agentSessions || []).filter((peer) => (
    peer.id !== session.id
    && !peer.endedAt
    && peer.collaborationSessionId === session.collaborationSessionId
  ));
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
    const responderToken = mintChannelToken();
    const created = await prisma.codeSiteAgentChannel.create({
      data: {
        projectId: project.id,
        workspaceSlug,
        fromSessionId: session.id,
        toSessionId: peer.id,
        status: 'active',
        purpose: 'auto_open_direct_preferred',
        transport: 'websocket',
        channelTokenHash: hashChannelToken(responderToken),
        openedAt: now,
        maxDurationMs: 1_800_000,
        messageCount: 0,
      },
    });
    await prisma.codeSiteEvent.create({
      data: {
        projectId: project.id,
        workspaceSlug,
        eventType: 'channel_accepted',
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
