import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prisma } = vi.hoisted(() => ({
  prisma: {
    codeSiteMutationTransaction: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    codeSiteProject: {
      findUnique: vi.fn(),
    },
    codeSiteAssumptionLease: {
      findMany: vi.fn(),
    },
    codeSiteEvent: {
      count: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
    },
    codeSitePolicyDecision: {
      create: vi.fn(),
    },
    codeSiteProofBundle: {
      create: vi.fn(),
      findFirst: vi.fn(),
    },
    codeSiteInspectionRun: {
      findMany: vi.fn(),
    },
    codeSiteIncident: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    codeSiteLineProvenance: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/prisma', () => ({
  default: prisma,
}));

import {
  commitTransaction,
  getIncidentReplay,
  getProofBundle,
  getSourceStateSince,
  recordTransactionWrite,
  validateTransaction,
} from '../controlPlane.js';

function transactionFixture() {
  return {
    id: 'txn-1',
    projectId: 'project-1',
    mutationLeaseId: 'lease-1',
    agentSessionId: 'agent-1',
    baseSnapshot: 'base',
    isolation: 'serializable',
    status: 'open',
    readSetJson: JSON.stringify(['synthi/prisma/schema.prisma']),
    observedReadSetJson: JSON.stringify(['synthi/prisma/schema.prisma']),
    writeSetJson: JSON.stringify(['synthi/prisma/schema.prisma']),
    observedWriteSetJson: JSON.stringify(['synthi/prisma/schema.prisma']),
    semanticDependencyRefsJson: JSON.stringify([]),
    invariantsJson: JSON.stringify(['clearance.diff.inside_route']),
    assumptionRefsJson: JSON.stringify([]),
    commitDecisionJson: null,
    proofBundleDigest: null,
    openedAt: new Date('2026-06-29T23:00:00.000Z'),
    closedAt: null,
    mutationLease: {
      id: 'lease-1',
      status: 'active',
      displayCallsign: 'ATLAS-1',
      leaseJson: JSON.stringify({
        allowedPaths: ['synthi/prisma/**'],
        blockedPaths: ['secrets/**'],
        allowedTools: ['file_write'],
        requiredRadar: ['typecheck', 'tests'],
      }),
      executionPlanId: 'plan-1',
    },
  };
}

describe('CodeSite control plane transaction validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const transaction = transactionFixture();
    prisma.codeSiteMutationTransaction.findFirst.mockResolvedValue(transaction);
    prisma.codeSiteMutationTransaction.update.mockImplementation(async ({ data }) => ({
      ...transaction,
      ...data,
    }));
    prisma.codeSiteProject.findUnique.mockResolvedValue({
      id: 'project-1',
      zonePolicyJson: JSON.stringify({
        zones: [
          { zoneKey: 'schema', class: 'B', label: 'Schema', paths: ['synthi/prisma/**'], rules: [], risk: 'high' },
        ],
        noFlyZones: ['secrets/**'],
      }),
    });
    prisma.codeSiteAssumptionLease.findMany.mockResolvedValue([]);
    prisma.codeSiteEvent.count.mockResolvedValue(1);
    prisma.codeSiteEvent.create.mockResolvedValue({ id: 'event-validation' });
    prisma.codeSitePolicyDecision.create.mockImplementation(async ({ data }) => ({
      id: 'decision-1',
      createdAt: new Date('2026-06-29T23:01:00.000Z'),
      ...data,
    }));
    prisma.codeSiteInspectionRun.findMany.mockResolvedValue([]);
    prisma.codeSiteProofBundle.create.mockImplementation(async ({ data }) => ({
      id: 'proof-created',
      createdAt: new Date('2026-06-29T23:03:00.000Z'),
      ...data,
    }));
    prisma.codeSiteLineProvenance.create.mockResolvedValue({ id: 'line-created' });
  });

  it('does not mark a transaction stale because of its own write event', async () => {
    prisma.codeSiteEvent.findMany.mockResolvedValue([
      {
        id: 'event-own-write',
        eventType: 'write_allowed',
        actorId: 'txn-1',
        displayCallsign: 'ATLAS-1',
        createdAt: new Date('2026-06-29T23:01:00.000Z'),
        detailsJson: JSON.stringify({
          transactionId: 'txn-1',
          path: 'synthi/prisma/schema.prisma',
        }),
      },
    ]);

    const result = await validateTransaction('acme', 'txn-1');

    expect(result.decision.ok).toBe(true);
    expect(result.decision.reasonCodes).toContain('serializable_validation_passed');
    expect(result.decision.reasonCodes).not.toContain('stale_read_detected');
    expect(prisma.codeSiteMutationTransaction.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'txn-1' },
      data: expect.objectContaining({ status: 'validated' }),
    }));
  });

  it('returns source-state since a transaction without mutating validation state', async () => {
    prisma.codeSiteEvent.findMany.mockResolvedValue([
      {
        id: 'event-other-write',
        eventType: 'write_allowed',
        actorId: 'txn-other',
        displayCallsign: 'BETA-2',
        createdAt: new Date('2026-06-29T23:02:00.000Z'),
        detailsJson: JSON.stringify({
          transactionId: 'txn-other',
          path: 'synthi/prisma/schema.prisma',
        }),
      },
    ]);

    const result = await getSourceStateSince('acme', 'txn-1');

    expect(result.sourceState.changedPaths).toEqual(['synthi/prisma/schema.prisma']);
    expect(result.sourceState.staleReads).toEqual([expect.objectContaining({
      eventId: 'event-other-write',
      displayCallsign: 'BETA-2',
    })]);
    expect(prisma.codeSiteMutationTransaction.update).not.toHaveBeenCalled();
    expect(prisma.codeSiteEvent.create).not.toHaveBeenCalled();
  });

  it('records CodeSiteFS denied write evidence before returning a block decision', async () => {
    const result = await recordTransactionWrite('acme', 'txn-1', {
      path: 'synthi/prisma/schema.prisma',
      tool: 'file_write',
      codesiteFsEvent: {
        type: 'write_denied',
        transaction_id: 'txn-1',
        path: 'synthi/prisma/schema.prisma',
        details: {
          reason_codes: ['outside_clearance_route'],
          process_ancestry: ['collab-server', 'exec'],
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.policyDecision).toMatchObject({
      decision: 'block',
      reasonCodes: ['outside_clearance_route'],
    });
    expect(prisma.codeSiteEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: 'write_attempted',
        detailsJson: expect.stringContaining('codesiteFsEvent'),
      }),
    }));
    expect(prisma.codeSiteEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: 'write_denied',
        actorType: 'codesitefs',
        detailsJson: expect.stringContaining('outside_clearance_route'),
      }),
    }));
  });

  it('blocks proof-carrying commits until landing inspection evidence covers the write set', async () => {
    prisma.codeSiteEvent.findMany.mockResolvedValue([
      {
        id: 'event-own-write',
        eventType: 'write_allowed',
        actorId: 'txn-1',
        displayCallsign: 'ATLAS-1',
        createdAt: new Date('2026-06-29T23:01:00.000Z'),
        detailsJson: JSON.stringify({
          transactionId: 'txn-1',
          path: 'synthi/prisma/schema.prisma',
        }),
      },
    ]);

    const result = await commitTransaction('acme', 'txn-1');

    expect(result.decision.ok).toBe(false);
    expect(result.decision.reasonCodes).toEqual(expect.arrayContaining([
      'inspection_path_coverage_required',
      'inspection_signal_required',
      'inspection_evidence_required',
    ]));
    expect(prisma.codeSiteProofBundle.create).not.toHaveBeenCalled();
    expect(prisma.codeSiteMutationTransaction.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'txn-1' },
      data: expect.objectContaining({
        status: 'blocked',
        commitDecisionJson: expect.stringContaining('inspection_evidence_required'),
      }),
    }));
  });

  it('lands proof-carrying commits only after passed inspections become proof evidence', async () => {
    prisma.codeSiteEvent.findMany.mockResolvedValue([
      {
        id: 'event-own-write',
        eventType: 'write_allowed',
        actorId: 'txn-1',
        displayCallsign: 'ATLAS-1',
        createdAt: new Date('2026-06-29T23:01:00.000Z'),
        detailsJson: JSON.stringify({
          transactionId: 'txn-1',
          path: 'synthi/prisma/schema.prisma',
        }),
      },
    ]);
    prisma.codeSiteInspectionRun.findMany.mockResolvedValue([{
      id: 'inspection-1',
      projectId: 'project-1',
      executionPlanId: 'plan-1',
      displayCallsign: 'ATLAS-1',
      status: 'completed',
      changedPathsJson: JSON.stringify(['synthi/prisma/**']),
      inspectionSignalsJson: JSON.stringify([
        { key: 'typecheck', status: 'passed', evidenceRefs: ['typecheck:pass'] },
        { key: 'tests', status: 'passed', evidenceRefs: ['tests:pass'] },
      ]),
      evidenceRefsJson: JSON.stringify(['runtime:event:inspection-1']),
      requestedAt: new Date('2026-06-29T23:02:00.000Z'),
      completedAt: new Date('2026-06-29T23:03:00.000Z'),
    }]);

    const result = await commitTransaction('acme', 'txn-1', { commitSha: 'abc123' });
    const proofCreate = prisma.codeSiteProofBundle.create.mock.calls.at(-1)[0];
    const evidenceRefs = JSON.parse(proofCreate.data.evidenceRefsJson);

    expect(result.transaction.status).toBe('committed');
    expect(result.proofBundle.commitSha).toBe('abc123');
    expect(evidenceRefs).toEqual(expect.arrayContaining([
      'runtime:event:inspection-1',
      'typecheck:pass',
      'tests:pass',
      'codesite:inspection:inspection-1',
      'codesite:transaction:txn-1',
      'codesite:lease:lease-1',
    ]));
    expect(prisma.codeSiteLineProvenance.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        proofBundleId: 'proof-created',
        filePath: 'synthi/prisma/schema.prisma',
      }),
    }));
  });

  it('returns portable proof material with proof bundle lookups', async () => {
    const transaction = transactionFixture();
    prisma.codeSiteProofBundle.findFirst.mockResolvedValue({
      id: 'proof-1',
      projectId: 'project-1',
      transactionId: 'txn-1',
      commitSha: 'abc123',
      readSetDigest: 'sha256:read',
      writeSetDigest: 'sha256:write',
      invariantsJson: JSON.stringify(['clearance.diff.inside_route']),
      evidenceRefsJson: JSON.stringify(['test:pass']),
      dojoEvidenceRefsJson: JSON.stringify(['dojo:proof']),
      incidentReplayDigest: 'sha256:incident',
      bundleDigest: 'sha256:bundle',
      createdAt: new Date('2026-06-29T23:10:00.000Z'),
      project: {
        id: 'project-1',
        workspaceSlug: 'acme',
        title: 'Proof project',
        request: 'Prove it',
        status: 'active',
        zonePolicyJson: JSON.stringify({ zones: [] }),
        controlPlanJson: JSON.stringify({}),
        createdAt: new Date('2026-06-29T23:00:00.000Z'),
        updatedAt: new Date('2026-06-29T23:00:00.000Z'),
      },
      transaction: {
        ...transaction,
        mutationLease: transaction.mutationLease,
      },
    });
    prisma.codeSiteIncident.findMany.mockResolvedValue([]);
    prisma.codeSiteLineProvenance.findMany.mockResolvedValue([{
      id: 'line-1',
      projectId: 'project-1',
      transactionId: 'txn-1',
      filePath: 'synthi/prisma/schema.prisma',
      lineAnchor: 'L1',
      displayCallsign: 'ATLAS-1',
      reasonRef: 'transaction:txn-1',
      evidenceRefsJson: JSON.stringify(['proof:proof-1']),
      dojoSourceRefsJson: JSON.stringify([]),
      proofBundleId: 'proof-1',
      processAncestryJson: JSON.stringify([]),
      promptSummary: 'CodeSite transaction commit',
      createdAt: new Date('2026-06-29T23:11:00.000Z'),
    }]);

    const proof = await getProofBundle('acme', 'proof-1');

    expect(proof.bundleDigest).toBe('sha256:bundle');
    expect(proof.portableProofBundle).toMatchObject({
      schemaVersion: 'synthi.codesite.proofBundle.v1',
      projectId: 'project-1',
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
      readSetDigest: 'sha256:read',
      writeSetDigest: 'sha256:write',
    });
    expect(proof.portableProofBundle.portableDigest).toMatch(/^sha256:/);
  });

  it('builds incident replay timelines from referenced events', async () => {
    prisma.codeSiteIncident.findFirst.mockResolvedValue({
      id: 'incident-1',
      projectId: 'project-1',
      severity: 'warning',
      category: 'near_miss',
      participantsJson: JSON.stringify(['ATLAS-1']),
      affectedZonesJson: JSON.stringify(['synthi/prisma/**']),
      incidentReplayJson: JSON.stringify({ events: ['write_allowed'], summary: 'Predicted collision' }),
      replayDigest: 'sha256:replay',
      timelineEventRefsJson: JSON.stringify(['evt-1']),
      policyDeltaJson: JSON.stringify(null),
      evidenceRefsJson: JSON.stringify(['collision:evidence']),
      createdAt: new Date('2026-06-29T23:12:00.000Z'),
      project: {
        events: [{
          id: 'evt-1',
          projectId: 'project-1',
          mutationLeaseId: 'lease-1',
          eventType: 'write_allowed',
          displayCallsign: 'ATLAS-1',
          actorType: 'transaction',
          actorId: 'txn-1',
          detailsJson: JSON.stringify({ path: 'synthi/prisma/schema.prisma' }),
          evidenceRefsJson: JSON.stringify([]),
          logicalTime: 1,
          createdAt: new Date('2026-06-29T23:11:00.000Z'),
        }],
      },
    });

    const replay = await getIncidentReplay('acme', 'incident-1');

    expect(replay.replayDigest).toBe('sha256:replay');
    expect(replay.timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'codesite_event',
        event: expect.objectContaining({ eventType: 'write_allowed' }),
      }),
      expect.objectContaining({
        source: 'incident_record',
      }),
    ]));
  });
});
