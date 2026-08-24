import { createHash } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prisma } = vi.hoisted(() => ({
  prisma: {
    codeSiteAgentChannel: {
      create: vi.fn(),
      findFirst: vi.fn(),
    },
    codeSiteEvent: {
      create: vi.fn(),
    },
    codeSiteProject: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('@/lib/prisma', () => ({
  default: prisma,
}));

import { autoOpenDirectChannels } from '../autoChannels.js';

function peerSession(overrides = {}) {
  return {
    id: 'peer-session',
    collaborationSessionId: 'collaboration-1',
    endedAt: null,
    capabilitiesJson: JSON.stringify(['codesite.channels.open']),
    ...overrides,
  };
}

function projectSession(overrides = {}) {
  return {
    id: 'initiator-session',
    projectId: 'project-1',
    collaborationSessionId: 'collaboration-1',
    displayCallsign: 'Initiator',
    ...overrides,
  };
}

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  delete process.env.SYNTHI_CODESITE_CHANNELS_DISABLED;
  delete process.env.SYNTHI_CODESITE_MIN_CHANNEL_MODE;

  prisma.codeSiteProject.findFirst.mockReset();
  prisma.codeSiteAgentChannel.findFirst.mockReset();
  prisma.codeSiteAgentChannel.create.mockReset();
  prisma.codeSiteEvent.create.mockReset();
});

describe('autoOpenDirectChannels', () => {
  it('opens only when the effective project mode is direct_preferred', async () => {
    const session = projectSession();
    const peer = peerSession({ id: 'capable-peer' });
    const created = { id: 'channel-1' };

    prisma.codeSiteProject.findFirst
      .mockResolvedValueOnce({
        id: session.projectId,
        channelMode: 'registered_direct',
        agentSessions: [peer],
      })
      .mockResolvedValueOnce({
        id: session.projectId,
        channelMode: 'direct_preferred',
        agentSessions: [peer],
      });
    prisma.codeSiteAgentChannel.findFirst.mockResolvedValue(null);
    prisma.codeSiteAgentChannel.create.mockResolvedValue(created);
    prisma.codeSiteEvent.create.mockResolvedValue({});

    await expect(autoOpenDirectChannels('workspace-1', session)).resolves.toEqual([]);
    expect(prisma.codeSiteAgentChannel.findFirst).not.toHaveBeenCalled();

    await expect(autoOpenDirectChannels('workspace-1', session)).resolves.toEqual([
      { channelId: 'channel-1', toSessionId: 'capable-peer' },
    ]);
    expect(prisma.codeSiteProject.findFirst).toHaveBeenCalledWith({
      where: { id: session.projectId, workspaceSlug: 'workspace-1' },
      include: { agentSessions: true },
    });
    expect(prisma.codeSiteAgentChannel.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fromSessionId: session.id,
        toSessionId: peer.id,
        status: 'active',
        purpose: 'auto_open_direct_preferred',
        transport: 'websocket',
      }),
    });
  });

  it('skips peers without codesite.channels.open capability', async () => {
    const session = projectSession();
    prisma.codeSiteProject.findFirst.mockResolvedValue({
      id: session.projectId,
      channelMode: 'direct_preferred',
      agentSessions: [
        peerSession({ id: 'uncapable-peer', capabilitiesJson: JSON.stringify(['other.capability']) }),
        peerSession({ id: 'malformed-capability-peer', capabilitiesJson: '{not-json' }),
      ],
    });

    await expect(autoOpenDirectChannels('workspace-1', session)).resolves.toEqual([]);
    expect(prisma.codeSiteAgentChannel.findFirst).not.toHaveBeenCalled();
    expect(prisma.codeSiteAgentChannel.create).not.toHaveBeenCalled();
  });

  it('records auto-open rather than acceptance audit events and hashes no responder token', async () => {
    const session = projectSession();
    const peer = peerSession({ id: 'capable-peer' });
    prisma.codeSiteProject.findFirst.mockResolvedValue({
      id: session.projectId,
      channelMode: 'direct_preferred',
      agentSessions: [peer],
    });
    prisma.codeSiteAgentChannel.findFirst.mockResolvedValue(null);
    prisma.codeSiteAgentChannel.create.mockResolvedValue({ id: 'channel-1' });
    prisma.codeSiteEvent.create.mockResolvedValue({});

    await autoOpenDirectChannels('workspace-1', session);

    const emptyTokenHash = `sha256:${createHash('sha256').update('').digest('hex')}`;
    expect(prisma.codeSiteAgentChannel.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ channelTokenHash: emptyTokenHash }),
    });
    expect(prisma.codeSiteEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.codeSiteEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventType: 'channel_auto_opened' }),
    });
    expect(prisma.codeSiteEvent.create).not.toHaveBeenCalledWith({
      data: expect.objectContaining({ eventType: 'channel_accepted' }),
    });
  });

  it('does not create a new channel when one is already active or requested', async () => {
    const session = projectSession();
    const peer = peerSession();
    prisma.codeSiteProject.findFirst.mockResolvedValue({
      id: session.projectId,
      channelMode: 'direct_preferred',
      agentSessions: [peer],
    });
    prisma.codeSiteAgentChannel.findFirst.mockResolvedValue({ id: 'existing-channel' });

    await expect(autoOpenDirectChannels('workspace-1', session)).resolves.toEqual([]);
    expect(prisma.codeSiteAgentChannel.findFirst).toHaveBeenCalledWith({
      where: {
        projectId: session.projectId,
        OR: [
          { fromSessionId: session.id, toSessionId: peer.id },
          { fromSessionId: peer.id, toSessionId: session.id },
        ],
        status: { in: ['requested', 'active'] },
      },
    });
    expect(prisma.codeSiteAgentChannel.create).not.toHaveBeenCalled();
    expect(prisma.codeSiteEvent.create).not.toHaveBeenCalled();
  });
});
