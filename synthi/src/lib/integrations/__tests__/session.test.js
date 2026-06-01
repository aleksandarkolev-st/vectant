import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getServerSessionMock, prismaMock } = vi.hoisted(() => ({
  getServerSessionMock: vi.fn(),
  prismaMock: { user: { findUnique: vi.fn() } },
}));
vi.mock('next-auth', () => ({ getServerSession: getServerSessionMock }));
vi.mock('@/app/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/prisma', () => ({ default: prismaMock }));

import { resolveActor } from '../session.js';

beforeEach(() => {
  getServerSessionMock.mockReset();
  prismaMock.user.findUnique.mockReset();
});

describe('resolveActor', () => {
  it('returns null when unauthenticated', async () => {
    getServerSessionMock.mockResolvedValue(null);
    expect(await resolveActor()).toBeNull();
  });
  it('returns null when the email has no matching user', async () => {
    getServerSessionMock.mockResolvedValue({ user: { email: 'a@b.c' } });
    prismaMock.user.findUnique.mockResolvedValue(null);
    expect(await resolveActor()).toBeNull();
  });
  it('maps an authenticated email to a userId', async () => {
    getServerSessionMock.mockResolvedValue({ user: { email: 'a@b.c' } });
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.c' });
    expect(await resolveActor()).toEqual({ userId: 'u1', email: 'a@b.c' });
  });
});
