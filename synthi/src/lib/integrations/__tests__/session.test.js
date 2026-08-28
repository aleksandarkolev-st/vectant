import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ getServerSession: vi.fn(), findUnique: vi.fn() }));

vi.mock('next-auth', () => ({ getServerSession: h.getServerSession }));
vi.mock('@/app/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/prisma', () => ({ default: { user: { findUnique: h.findUnique } } }));

import { resolveActor } from '../session';

beforeEach(() => {
  vi.clearAllMocks();
  h.findUnique.mockResolvedValue({ id: 'cuid_db', email: 'a@b.c' });
});

describe('resolveActor', () => {
  it('returns the DB userId plus workspaceUserId = session.user.id (the IDE repo-dir id)', async () => {
    h.getServerSession.mockResolvedValue({ user: { id: '242593757', email: 'a@b.c' } });
    const actor = await resolveActor();
    expect(actor).toEqual({ userId: 'cuid_db', email: 'a@b.c', workspaceUserId: '242593757' });
  });

  it('falls back workspaceUserId to email when session.user.id is absent (mirrors the IDE)', async () => {
    h.getServerSession.mockResolvedValue({ user: { email: 'a@b.c' } });
    const actor = await resolveActor();
    expect(actor.workspaceUserId).toBe('a@b.c');
  });

  it('returns null when unauthenticated', async () => {
    h.getServerSession.mockResolvedValue(null);
    expect(await resolveActor()).toBeNull();
  });

  it('returns null when the authenticated email has no matching DB user', async () => {
    h.getServerSession.mockResolvedValue({ user: { id: '242593757', email: 'a@b.c' } });
    h.findUnique.mockResolvedValue(null);
    expect(await resolveActor()).toBeNull();
  });
});
