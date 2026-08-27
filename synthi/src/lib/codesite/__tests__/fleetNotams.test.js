import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { prisma } = vi.hoisted(() => ({
  prisma: {
    codeSiteProject: { findFirst: vi.fn() },
    codeSitePolicyDelta: { findFirst: vi.fn() },
    codeSiteFleetNotam: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    codeSiteNotamIngestState: { upsert: vi.fn() },
    codeSiteEvent: { count: vi.fn(), create: vi.fn() },
  },
}));

vi.mock('@/lib/prisma', () => ({ default: prisma }));

import {
  canonicalNotamPayload,
  decideFleetNotam,
  fleetNotamClearanceGate,
  listFleetNotamsForProject,
  mergeFleetNotamGate,
  notamAdvisoryKey,
  notamDigest,
  publishFleetNotam,
  supersedeFleetNotam,
  verifyNotamIntegrity,
  withdrawFleetNotam,
} from '../fleetNotams';

const actor = { bypass: true };

function advisoryRow(overrides = {}) {
  const values = {
    id: 'notam-row',
    projectId: 'origin-project',
    workspaceSlug: 'workspace',
    sourcePolicyDeltaId: 'delta',
    title: 'Schema drift hazard',
    summary: 'Validate contracts before landing',
    affectedZoneKey: 'zone_a',
    affectedRoutesJson: JSON.stringify(['packages/api/**']),
    triggerConditionsJson: JSON.stringify([{ event: 'schema_changed' }]),
    ruleCandidateJson: JSON.stringify({
      requiredRadar: ['contract-diff'],
      requiredTowerActions: ['validate-schema'],
    }),
    confidence: 0.9,
    expectedRiskReduction: 0.4,
    status: 'active',
    publishedAt: new Date('2026-08-26T00:00:00.000Z'),
    expiresAt: null,
    ...overrides,
  };
  return {
    ...values,
    digestSha256: notamDigest(payloadFromRow(values)),
  };
}

function payloadFromRow(row) {
  return {
    sourcePolicyDeltaId: row.sourcePolicyDeltaId,
    projectId: row.projectId,
    workspaceSlug: row.workspaceSlug,
    ruleCandidate: JSON.parse(row.ruleCandidateJson),
    triggerConditions: JSON.parse(row.triggerConditionsJson),
    affectedZoneKey: row.affectedZoneKey,
    affectedRoutes: JSON.parse(row.affectedRoutesJson),
    confidence: row.confidence,
    expectedRiskReduction: row.expectedRiskReduction,
  };
}

function promotedDelta() {
  return {
    id: 'delta',
    projectId: 'origin-project',
    promotionState: 'promoted',
    confidence: 0.92,
    expectedRiskReduction: 0.35,
    affectedZoneKey: 'zone_a',
    triggerConditionsJson: JSON.stringify([{ event: 'schema_changed' }]),
    ruleCandidateJson: JSON.stringify({
      title: 'Schema drift hazard',
      summary: 'Validate contracts before landing',
      requiredRadar: ['contract-diff'],
      requiredTowerActions: ['validate-schema'],
      affectedRoutes: ['packages/api/**'],
    }),
  };
}

beforeEach(() => {
  delete process.env.SYNTHI_CODESITE_MAX_FLEET_NOTAMS_PER_ROUTE;
  Object.values(prisma).forEach((delegate) => Object.values(delegate).forEach((method) => method.mockReset()));
  prisma.codeSiteEvent.count.mockResolvedValue(0);
  prisma.codeSiteEvent.create.mockImplementation(async ({ data }) => ({ id: 'event-1', ...data }));
});

afterEach(() => {
  delete process.env.SYNTHI_CODESITE_MAX_FLEET_NOTAMS_PER_ROUTE;
});

describe('canonicalization and integrity', () => {
  it('is stable across property order and produces the specified key formats', () => {
    const base = {
      sourcePolicyDeltaId: 'delta',
      projectId: 'origin-project',
      workspaceSlug: 'workspace',
      ruleCandidate: { requiredRadar: ['contract-diff'] },
      triggerConditions: [{ event: 'schema_changed' }],
      affectedZoneKey: 'zone_a',
      affectedRoutes: ['packages/api/**'],
      confidence: 0.9,
      expectedRiskReduction: 0.3,
    };
    const reordered = {
      expectedRiskReduction: 0.3,
      confidence: 0.9,
      affectedRoutes: ['packages/api/**'],
      affectedZoneKey: 'zone_a',
      triggerConditions: [{ event: 'schema_changed' }],
      ruleCandidate: { requiredRadar: ['contract-diff'] },
      workspaceSlug: 'workspace',
      projectId: 'origin-project',
      sourcePolicyDeltaId: 'delta',
    };
    expect(canonicalNotamPayload(base)).toBe(canonicalNotamPayload(reordered));
    expect(notamAdvisoryKey(base)).toMatch(/^notam_[0-9a-f]{16}$/);
    expect(notamDigest(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(notamAdvisoryKey(base)).toBe(notamAdvisoryKey(reordered));
  });

  it('verifies stored integrity and rejects altered payloads', () => {
    const row = advisoryRow();
    expect(verifyNotamIntegrity(row)).toBe(true);
    expect(verifyNotamIntegrity({ ...row, affectedRoutesJson: '["other/**"]' })).toBe(false);
  });
});

describe('visibility and effect separation', () => {
  it('shows both planes in visibility while returning only adopted rows from clearance', async () => {
    const unreviewed = advisoryRow({ id: 'visible-unadopted' });
    const adopted = advisoryRow({ id: 'visible-adopted' });
    unreviewed.ingestStates = [];
    adopted.ingestStates = [{
      state: 'adopted', decidedBy: 'user-1', decidedAt: new Date('2026-08-26T01:00:00.000Z'),
    }];
    prisma.codeSiteProject.findFirst.mockResolvedValue({ id: 'subscriber', workspaceSlug: 'workspace' });
    prisma.codeSiteFleetNotam.findMany.mockResolvedValue([unreviewed, adopted]);
    const visibility = await listFleetNotamsForProject('workspace', 'subscriber', {
      route: 'packages/api/routes.ts',
    }, actor);
    expect(visibility.advisories.map((notam) => [notam.notamId, notam.effect])).toEqual([
      ['visible-unadopted', 'visibility_only'],
      ['visible-adopted', 'adopted'],
    ]);

    prisma.codeSiteFleetNotam.findMany.mockResolvedValue([adopted]);
    const gate = await fleetNotamClearanceGate({
      workspaceSlug: 'workspace', projectId: 'subscriber', route: ['packages/api/routes.ts'],
    });
    expect(gate.appliedNotams).toEqual(['visible-adopted']);
    expect(gate.status).toBe('enforced');
    expect(gate.decision).toBeNull();
  });

  it('returns the exact empty gate shape when nothing is adopted despite visibility', async () => {
    prisma.codeSiteFleetNotam.findMany.mockResolvedValue([]);
    const gate = await fleetNotamClearanceGate({
      workspaceSlug: 'workspace', projectId: 'subscriber', route: ['packages/api/**'],
    });
    expect(gate).toEqual({
      appliedNotams: [], reasonCodes: [], requiredRadar: [], requiredTowerActions: [],
      status: null, decision: null, towerInstruction: null,
    });
  });

  it('removes muted advisories by default and restores them as visibility only', async () => {
    const muted = advisoryRow();
    muted.ingestStates = [{ state: 'muted', decidedBy: 'user-1', decidedAt: new Date() }];
    prisma.codeSiteProject.findFirst.mockResolvedValue({ id: 'subscriber', workspaceSlug: 'workspace' });
    prisma.codeSiteFleetNotam.findMany.mockResolvedValue([muted]);
    await expect(listFleetNotamsForProject('workspace', 'subscriber', {}, actor))
      .resolves.toEqual({ advisories: [], suppressed: 0 });
    const restored = await listFleetNotamsForProject('workspace', 'subscriber', { includeMuted: true }, actor);
    expect(restored.advisories).toHaveLength(1);
    expect(restored.advisories[0].effect).toBe('visibility_only');
    prisma.codeSiteFleetNotam.findMany.mockResolvedValue([]);
    const gate = await fleetNotamClearanceGate({
      workspaceSlug: 'workspace', projectId: 'subscriber', route: ['packages/api/**'],
    });
    expect(gate.status).toBeNull();
  });
});

describe('gate matching, integrity, and caps', () => {
  it('uses an adopted-only where clause and matches route, zone, or trigger events', async () => {
    prisma.codeSiteFleetNotam.findMany.mockResolvedValue([]);
    await fleetNotamClearanceGate({ workspaceSlug: 'workspace', projectId: 'subscriber' });
    const where = prisma.codeSiteFleetNotam.findMany.mock.calls[0][0].where;
    expect(where.ingestStates.some).toEqual({ projectId: 'subscriber', state: 'adopted' });

    const routeMatch = advisoryRow({ id: 'route-match' });
    const zoneMatch = advisoryRow({ id: 'zone-match', affectedRoutesJson: '[]' });
    const eventMatch = advisoryRow({ id: 'event-match', affectedRoutesJson: '[]', affectedZoneKey: null });
    const nonMatch = advisoryRow({
      id: 'non-match', affectedRoutesJson: '["frontend/**"]', affectedZoneKey: null,
      triggerConditionsJson: '[]',
    });
    prisma.codeSiteFleetNotam.findMany.mockResolvedValue([routeMatch, zoneMatch, eventMatch, nonMatch]);
    const gate = await fleetNotamClearanceGate({
      workspaceSlug: 'workspace',
      projectId: 'subscriber',
      route: ['packages/api/file.ts'],
      zonePolicy: { zones: [{ zoneKey: 'zone_a', paths: ['packages/api/**'] }] },
      events: ['schema_changed'],
    });
    expect(gate.appliedNotams).toEqual(['route-match', 'zone-match', 'event-match']);
    expect(gate.reasonCodes).toContain('fleet_notam_enforced');
  });

  it('suppresses corrupt advisories and truncates overflow oldest first', async () => {
    process.env.SYNTHI_CODESITE_MAX_FLEET_NOTAMS_PER_ROUTE = '1';
    const corrupt = advisoryRow({ id: 'corrupt' });
    corrupt.digestSha256 = 'bad';
    const applied = advisoryRow({ id: 'applied' });
    const overflow = advisoryRow({ id: 'overflow', sourcePolicyDeltaId: 'delta-two' });
    prisma.codeSiteFleetNotam.findMany.mockResolvedValue([corrupt, applied, overflow]);
    const gate = await fleetNotamClearanceGate({
      workspaceSlug: 'workspace', projectId: 'subscriber', route: ['packages/api/**'],
    });
    expect(gate.appliedNotams).toEqual(['applied']);
    expect(gate.requiredRadar).toEqual(['contract-diff']);
    expect(gate.reasonCodes).toContain('fleet_notam_cap_truncated');
  });
});

describe('merge purity', () => {
  it('never changes decisions while appending reasons and unioning radar', () => {
    for (const decision of ['allow', 'block', 'hold']) {
      const policy = {
        decision,
        status: decision === 'allow' ? 'active' : 'holding',
        reasonCodes: ['existing'], requiredRadar: ['unit-test'], requiredTowerActions: [],
        towerInstruction: null,
      };
      const gate = {
        appliedNotams: ['notam-row'], reasonCodes: ['fleet_notam_enforced'],
        requiredRadar: ['unit-test', 'contract-diff'], requiredTowerActions: ['validate-schema'],
        towerInstruction: 'Adopted fleet advisories in effect.',
      };
      const merged = mergeFleetNotamGate(policy, gate);
      expect(merged.decision).toBe(decision);
      expect(merged.status).toBe(policy.status);
      expect(merged.reasonCodes).toEqual(['existing', 'fleet_notam_enforced']);
      expect(merged.requiredRadar).toEqual(['unit-test', 'contract-diff']);
    }
  });
});

describe('publishing, decisions, and listing scope', () => {
  it('publishes a promoted delta and audits only the origin project', async () => {
    prisma.codeSiteProject.findFirst.mockResolvedValue({ id: 'origin-project', workspaceSlug: 'workspace' });
    prisma.codeSitePolicyDelta.findFirst.mockResolvedValue(promotedDelta());
    prisma.codeSiteFleetNotam.findUnique.mockResolvedValue(null);
    prisma.codeSiteFleetNotam.create.mockImplementation(async ({ data }) => ({ id: 'created-notam', ...data }));
    const result = await publishFleetNotam(
      'workspace', 'origin-project', { policy_delta_id: 'delta' }, actor,
    );
    expect(result.alreadyPublished).toBe(false);
    expect(result.advisoryKey).toMatch(/^notam_[0-9a-f]{16}$/);
    expect(prisma.codeSiteEvent.create.mock.calls[0][0].data.projectId).toBe('origin-project');
    expect(prisma.codeSiteEvent.create.mock.calls[0][0].data.eventType).toBe('fleet_notam_published');
  });

  it('fails closed when the source delta is not promoted', async () => {
    prisma.codeSiteProject.findFirst.mockResolvedValue({ id: 'origin-project', workspaceSlug: 'workspace' });
    prisma.codeSitePolicyDelta.findFirst.mockResolvedValue({ ...promotedDelta(), promotionState: 'proposed' });
    await expect(publishFleetNotam(
      'workspace', 'origin-project', { policy_delta_id: 'delta' }, actor,
    )).rejects.toMatchObject({ code: 'fleet_notam_source_not_promoted' });
    expect(prisma.codeSiteFleetNotam.create).not.toHaveBeenCalled();
  });

  it('returns an existing publication without another create or event', async () => {
    prisma.codeSiteProject.findFirst.mockResolvedValue({ id: 'origin-project', workspaceSlug: 'workspace' });
    prisma.codeSitePolicyDelta.findFirst.mockResolvedValue(promotedDelta());
    prisma.codeSiteFleetNotam.findUnique.mockResolvedValue(advisoryRow());
    const result = await publishFleetNotam(
      'workspace', 'origin-project', { policy_delta_id: 'delta' }, actor,
    );
    expect(result.alreadyPublished).toBe(true);
    expect(prisma.codeSiteFleetNotam.create).not.toHaveBeenCalled();
    expect(prisma.codeSiteEvent.create).not.toHaveBeenCalled();
  });

  it('resolves a concurrent unique-key winner without a second event', async () => {
    prisma.codeSiteProject.findFirst.mockResolvedValue({ id: 'origin-project', workspaceSlug: 'workspace' });
    prisma.codeSitePolicyDelta.findFirst.mockResolvedValue(promotedDelta());
    prisma.codeSiteFleetNotam.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(advisoryRow());
    prisma.codeSiteFleetNotam.create.mockRejectedValue({
      code: 'P2002', meta: { target: ['projectId', 'advisoryKey'] },
    });

    const result = await publishFleetNotam(
      'workspace', 'origin-project', { policy_delta_id: 'delta' }, actor,
    );

    expect(result.alreadyPublished).toBe(true);
    expect(prisma.codeSiteEvent.create).not.toHaveBeenCalled();
  });

  it('retries a conflicted audit clock and surfaces a typed failure only when it remains uncommitted', async () => {
    prisma.codeSiteProject.findFirst.mockResolvedValue({ id: 'origin-project', workspaceSlug: 'workspace' });
    prisma.codeSitePolicyDelta.findFirst.mockResolvedValue(promotedDelta());
    prisma.codeSiteFleetNotam.findUnique.mockResolvedValue(null);
    prisma.codeSiteFleetNotam.create.mockImplementation(async ({ data }) => ({ id: 'created-notam', ...data }));
    prisma.codeSiteEvent.create.mockRejectedValue({
      code: 'P2002', meta: { target: ['projectId', 'logicalTime'] },
    });

    await expect(publishFleetNotam(
      'workspace', 'origin-project', { policy_delta_id: 'delta' }, actor,
    )).rejects.toMatchObject({
      status: 500,
      code: 'fleet_notam_event_uncommitted',
      detail: expect.objectContaining({ notamId: 'created-notam' }),
    });
    expect(prisma.codeSiteEvent.create).toHaveBeenCalledTimes(16);
  });

  it('never reactivates a withdrawn publication with the same source delta', async () => {
    prisma.codeSiteProject.findFirst.mockResolvedValue({ id: 'origin-project', workspaceSlug: 'workspace' });
    prisma.codeSitePolicyDelta.findFirst.mockResolvedValue(promotedDelta());
    prisma.codeSiteFleetNotam.findUnique.mockResolvedValue(advisoryRow({ status: 'withdrawn' }));

    await expect(publishFleetNotam(
      'workspace', 'origin-project', { policy_delta_id: 'delta' }, actor,
    )).rejects.toMatchObject({ code: 'fleet_notam_republish_requires_new_source_delta' });
    expect(prisma.codeSiteFleetNotam.create).not.toHaveBeenCalled();
  });

  it('upserts only the subscribing project’s ingest state and audit event', async () => {
    prisma.codeSiteProject.findFirst.mockResolvedValue({ id: 'subscriber', workspaceSlug: 'workspace' });
    prisma.codeSiteFleetNotam.findFirst.mockResolvedValue(advisoryRow());
    prisma.codeSiteNotamIngestState.upsert.mockImplementation(async ({ where, create }) => ({
      ...create,
      notamId: where.notamId_projectId.notamId,
      projectId: where.notamId_projectId.projectId,
    }));
    const result = await decideFleetNotam(
      'workspace', 'subscriber', 'notam-row', { state: 'adopt', reason: 'same near miss' },
      { bypass: true, userId: 'writer' },
    );
    expect(result).toMatchObject({ projectId: 'subscriber', state: 'adopted', decidedBy: 'writer' });
    expect(prisma.codeSiteNotamIngestState.upsert.mock.calls[0][0].where)
      .toEqual({ notamId_projectId: { notamId: 'notam-row', projectId: 'subscriber' } });
    expect(prisma.codeSiteEvent.create.mock.calls[0][0].data.projectId).toBe('subscriber');
    expect(prisma.codeSiteEvent.create.mock.calls[0][0].data.eventType).toBe('fleet_notam_adopt');
  });

  it('excludes own publications unless ownership is explicitly requested', async () => {
    prisma.codeSiteProject.findFirst.mockResolvedValue({ id: 'subscriber', workspaceSlug: 'workspace' });
    prisma.codeSiteFleetNotam.findMany.mockResolvedValue([]);
    await listFleetNotamsForProject('workspace', 'subscriber', {}, actor);
    expect(prisma.codeSiteFleetNotam.findMany.mock.calls[0][0].where.projectId).toEqual({ not: 'subscriber' });
    await listFleetNotamsForProject('workspace', 'subscriber', { includeOwn: true }, actor);
    expect(prisma.codeSiteFleetNotam.findMany.mock.calls[1][0].where.projectId).toBeUndefined();
  });

  it('withdraws only an active origin publication and records lifecycle evidence', async () => {
    const active = advisoryRow({ projectId: 'origin-project' });
    const withdrawn = { ...active, status: 'withdrawn', lifecycleReason: 'narrower rule published' };
    prisma.codeSiteProject.findFirst.mockResolvedValue({ id: 'origin-project', workspaceSlug: 'workspace' });
    prisma.codeSiteFleetNotam.findFirst.mockResolvedValue(active);
    prisma.codeSiteFleetNotam.update.mockResolvedValue(withdrawn);

    const result = await withdrawFleetNotam(
      'workspace', 'origin-project', active.id, { reason: 'narrower rule published' }, { bypass: true, userId: 'writer' },
    );

    expect(result.status).toBe('withdrawn');
    expect(prisma.codeSiteFleetNotam.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: active.id },
      data: expect.objectContaining({ status: 'withdrawn', lifecycleChangedBy: 'writer' }),
    }));
    expect(prisma.codeSiteEvent.create.mock.calls.at(-1)[0].data.eventType).toBe('fleet_notam_withdrawn');
  });

  it('supersedes an active origin publication with a distinct promoted delta', async () => {
    const previous = advisoryRow({ id: 'previous-notam', projectId: 'origin-project' });
    const replacementDelta = { ...promotedDelta(), id: 'delta-replacement' };
    const superseded = {
      ...previous,
      status: 'superseded',
      supersededByNotamId: 'replacement-notam',
      lifecycleReason: 'narrower contract condition',
    };
    prisma.codeSiteProject.findFirst.mockResolvedValue({ id: 'origin-project', workspaceSlug: 'workspace' });
    prisma.codeSiteFleetNotam.findFirst.mockResolvedValue(previous);
    prisma.codeSitePolicyDelta.findFirst.mockResolvedValue(replacementDelta);
    prisma.codeSiteFleetNotam.findUnique.mockResolvedValue(null);
    prisma.codeSiteFleetNotam.create.mockImplementation(async ({ data }) => ({
      id: 'replacement-notam', status: 'active', ...data,
    }));
    prisma.codeSiteFleetNotam.update.mockResolvedValue(superseded);

    const result = await supersedeFleetNotam(
      'workspace', 'origin-project', previous.id,
      { policy_delta_id: 'delta-replacement', reason: 'narrower contract condition' },
      { bypass: true, userId: 'writer' },
    );

    expect(result.supersededNotam).toMatchObject({
      status: 'superseded', supersededByNotamId: 'replacement-notam',
    });
    expect(result.replacementNotam).toMatchObject({ notamId: 'replacement-notam', supersedesNotamId: previous.id });
    expect(prisma.codeSiteFleetNotam.create.mock.calls[0][0].data.supersedesNotamId).toBe(previous.id);
    expect(prisma.codeSiteFleetNotam.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'superseded', supersededByNotamId: 'replacement-notam' }),
    }));
    expect(prisma.codeSiteEvent.create.mock.calls.at(-1)[0].data.eventType).toBe('fleet_notam_superseded');
  });
});
