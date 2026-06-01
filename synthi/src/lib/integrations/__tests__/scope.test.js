import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted so the mock state exists before the hoisted vi.mock factory runs.
const { prismaMock } = vi.hoisted(() => ({
  prismaMock: { workspace: { findUnique: vi.fn() } },
}));
vi.mock('@/lib/prisma', () => ({ default: prismaMock }));

import { canReadScope, canWriteScope } from '../scope.js';

beforeEach(() => {
  prismaMock.workspace.findUnique.mockReset();
});

// Stub the workspace lookup to return the actor's membership (with role), or no membership.
function stubMembership(role) {
  prismaMock.workspace.findUnique.mockResolvedValue({
    id: 'w',
    memberships: role ? [{ userId: 'u1', role }] : [],
  });
}

// R1-9 authorization matrix:
//   action            | personal      | workspace
//   view/list/test     | owner only    | any member
//   create/edit/delete | owner only    | role ∈ {owner, admin}
describe('canReadScope (view / list / test — member-level)', () => {
  it('allows the owner of a personal connection', async () => {
    expect(await canReadScope({ userId: 'u1' }, { scope: 'personal', ownerUserId: 'u1' })).toBe(true);
  });
  it('denies a personal connection for a different user', async () => {
    expect(await canReadScope({ userId: 'u1' }, { scope: 'personal', ownerUserId: 'u2' })).toBe(false);
  });
  it('allows any workspace member (role member) to read', async () => {
    stubMembership('member');
    expect(await canReadScope({ userId: 'u1' }, { scope: 'workspace', workspaceSlug: 'team' })).toBe(true);
  });
  it('denies a non-member from reading a workspace connection', async () => {
    stubMembership(null);
    expect(await canReadScope({ userId: 'u1' }, { scope: 'workspace', workspaceSlug: 'team' })).toBe(false);
  });
  it('denies when the actor has no userId', async () => {
    expect(await canReadScope({}, { scope: 'personal', ownerUserId: 'u1' })).toBe(false);
  });
});

describe('canWriteScope (create / edit / delete / enable / allowlist)', () => {
  it('allows the owner of a personal connection', async () => {
    expect(await canWriteScope({ userId: 'u1' }, { scope: 'personal', ownerUserId: 'u1' })).toBe(true);
  });
  it('denies a personal connection for a different user', async () => {
    expect(await canWriteScope({ userId: 'u1' }, { scope: 'personal', ownerUserId: 'u2' })).toBe(false);
  });
  it('allows a workspace owner to write', async () => {
    stubMembership('owner');
    expect(await canWriteScope({ userId: 'u1' }, { scope: 'workspace', workspaceSlug: 'team' })).toBe(true);
  });
  it('allows a workspace admin to write', async () => {
    stubMembership('admin');
    expect(await canWriteScope({ userId: 'u1' }, { scope: 'workspace', workspaceSlug: 'team' })).toBe(true);
  });
  it('denies a plain workspace member (role member) from writing', async () => {
    stubMembership('member');
    expect(await canWriteScope({ userId: 'u1' }, { scope: 'workspace', workspaceSlug: 'team' })).toBe(false);
  });
  it('denies a non-member from writing', async () => {
    stubMembership(null);
    expect(await canWriteScope({ userId: 'u1' }, { scope: 'workspace', workspaceSlug: 'team' })).toBe(false);
  });
  it('denies an unknown scope', async () => {
    expect(await canWriteScope({ userId: 'u1' }, { scope: 'bogus' })).toBe(false);
  });
});
