import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prisma } = vi.hoisted(() => ({
  prisma: {
    codeSiteMutationTransaction: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    codeSiteProject: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    codeSiteExecutionPlan: {
      findFirst: vi.fn(),
    },
    codeSiteMutationLease: {
      create: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    codeSiteAgentSession: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    codeSiteAgentInboxItem: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    codeSiteAssumptionLease: {
      findMany: vi.fn(),
    },
    codeSiteEvent: {
      count: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
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
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    codeSiteIncident: {
      create: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    codeSiteLineProvenance: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    codeSiteDocument: {
      create: vi.fn(),
    },
  },
}));

vi.mock('@/lib/prisma', () => ({
  default: prisma,
}));

import {
  commitTransaction,
  acknowledgeInboxItem,
  createIncident,
  createDocument,
  createInspectionRun,
  dryRunTransactionWrites,
  getAgentInbox,
  getEvents,
  getIncidentReplay,
  getProofBundle,
  getSourceStateSince,
  recordTransactionWrite,
  requestMutationLease,
  validateTransaction,
} from '../controlPlane.js';
import { buildReadSnapshotEvidence } from '../repoSnapshot.js';

function transactionFixture() {
  return {
    id: 'txn-1',
    projectId: 'project-1',
    mutationLeaseId: 'lease-1',
    agentSessionId: 'agent-1',
    baseSnapshot: 'base',
    baseSnapshotEvidenceJson: null,
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

function repoStateFixture() {
  return {
    schemaVersion: 'synthi.codesite.repoStateEvidence.v1',
    workspaceSlug: 'acme',
    transactionId: 'txn-1',
    baseSnapshot: 'base',
    gitHead: 'abc123',
    stagedDiffDigest: 'sha256:staged',
    worktreeDiffDigest: 'sha256:worktree',
    writeFileDigests: [{
      path: 'synthi/prisma/schema.prisma',
      digest: 'sha256:file',
      size: 120,
      exists: true,
    }],
    generatedAt: '2026-06-29T23:02:30.000Z',
    source: 'collab-server',
    evidenceDigest: 'sha256:repo-state',
  };
}

function executionPlanFixture(route = ['synthi/prisma/**']) {
  return {
    id: 'plan-1',
    projectId: 'project-1',
    agentSessionId: 'agent-1',
    displayCallsign: 'ATLAS-1',
    mission: 'Update schema',
    domain: 'schema',
    status: 'filed',
    routeJson: JSON.stringify(route),
    blockedZonesJson: JSON.stringify([]),
    abortJson: JSON.stringify([]),
    requestedToolsJson: JSON.stringify(['file_write']),
    estimatedDurationMs: null,
    filedAt: new Date('2026-06-29T22:59:00.000Z'),
    closedAt: null,
    project: {
      id: 'project-1',
      workspaceSlug: 'acme',
      zonePolicyJson: JSON.stringify({
        zones: [
          { zoneKey: 'schema', class: 'B', label: 'Schema', paths: ['synthi/prisma/**'], rules: [], risk: 'high' },
          { zoneKey: 'docs', class: 'D', label: 'Docs', paths: ['docs/**'], rules: [], risk: 'low' },
        ],
        noFlyZones: ['secrets/**'],
      }),
    },
    agentSession: {
      id: 'agent-1',
      projectId: 'project-1',
      ownerUserId: 'user-1',
      displayCallsign: 'ATLAS-1',
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
    prisma.codeSiteProject.findFirst.mockResolvedValue({
      id: 'project-1',
      workspaceSlug: 'acme',
      title: 'Signup',
      request: 'Build signup',
      status: 'active',
      zonePolicyJson: JSON.stringify({ zones: [] }),
      controlPlanJson: JSON.stringify({}),
      createdAt: new Date('2026-06-29T23:00:00.000Z'),
      updatedAt: new Date('2026-06-29T23:00:00.000Z'),
    });
    prisma.codeSiteExecutionPlan.findFirst.mockResolvedValue(executionPlanFixture());
    prisma.codeSiteMutationLease.create.mockImplementation(async ({ data }) => ({
      id: 'lease-created',
      issuedAt: new Date('2026-06-29T23:00:00.000Z'),
      expiresAt: null,
      revokedAt: null,
      ...data,
    }));
    prisma.codeSiteMutationLease.findMany.mockResolvedValue([]);
    prisma.codeSiteMutationLease.update.mockImplementation(async ({ where, data }) => ({
      id: where.id,
      projectId: 'project-1',
      executionPlanId: 'plan-1',
      agentSessionId: 'agent-1',
      displayCallsign: where.id === 'lease-api' ? 'API-01' : 'DOCS-01',
      status: data.status,
      leaseJson: JSON.stringify({ allowedPaths: where.id === 'lease-api' ? ['api/auth/**'] : ['docs/**'] }),
      issuedAt: new Date('2026-06-29T23:00:00.000Z'),
      expiresAt: null,
      revokedAt: null,
    }));
    prisma.codeSiteAssumptionLease.findMany.mockResolvedValue([]);
    prisma.codeSiteAgentSession.findFirst.mockResolvedValue({
      id: 'agent-1',
      projectId: 'project-1',
      ownerUserId: 'user-1',
      displayCallsign: 'ATLAS-1',
    });
    prisma.codeSiteAgentSession.findMany.mockResolvedValue([{
      id: 'agent-2',
      projectId: 'project-1',
      ownerUserId: 'user-2',
      displayCallsign: 'BETA-2',
    }]);
    prisma.codeSiteDocument.create.mockImplementation(async ({ data }) => ({
      id: 'doc-1',
      createdAt: new Date('2026-06-29T23:04:00.000Z'),
      resolvedAt: null,
      ...data,
    }));
    prisma.codeSiteAgentInboxItem.create.mockImplementation(async ({ data }) => ({
      id: 'inbox-created',
      status: 'pending',
      createdAt: new Date('2026-06-29T23:04:00.000Z'),
      acknowledgedAt: null,
      ...data,
    }));
    prisma.codeSiteAgentInboxItem.findMany.mockResolvedValue([]);
    prisma.codeSiteAgentInboxItem.findFirst.mockResolvedValue({
      id: 'inbox-1',
      projectId: 'project-1',
      agentSessionId: 'agent-1',
      recipientUserId: 'user-1',
      eventId: 'evt-1',
      documentId: 'doc-1',
      kind: 'rfi',
      requiresResponse: true,
      status: 'pending',
      redactedPayloadJson: JSON.stringify({ title: 'RFI' }),
      createdAt: new Date('2026-06-29T23:04:00.000Z'),
      acknowledgedAt: null,
    });
    prisma.codeSiteAgentInboxItem.update.mockImplementation(async ({ data }) => ({
      id: 'inbox-1',
      projectId: 'project-1',
      agentSessionId: 'agent-1',
      recipientUserId: 'user-1',
      eventId: 'evt-1',
      documentId: 'doc-1',
      kind: 'rfi',
      requiresResponse: true,
      status: 'pending',
      redactedPayloadJson: JSON.stringify({ title: 'RFI' }),
      createdAt: new Date('2026-06-29T23:04:00.000Z'),
      acknowledgedAt: null,
      ...data,
    }));
    prisma.codeSiteEvent.count.mockResolvedValue(1);
    prisma.codeSiteEvent.create.mockResolvedValue({ id: 'event-validation' });
    prisma.codeSiteEvent.findFirst.mockResolvedValue(null);
    prisma.codeSitePolicyDecision.create.mockImplementation(async ({ data }) => ({
      id: 'decision-1',
      createdAt: new Date('2026-06-29T23:01:00.000Z'),
      ...data,
    }));
    prisma.codeSiteInspectionRun.findMany.mockResolvedValue([]);
    prisma.codeSiteInspectionRun.create.mockImplementation(async ({ data }) => ({
      id: 'inspection-created',
      requestedAt: new Date('2026-06-29T23:05:00.000Z'),
      completedAt: null,
      ...data,
    }));
    prisma.codeSiteInspectionRun.findFirst.mockResolvedValue({
      id: 'inspection-1',
      projectId: 'project-1',
      executionPlanId: 'plan-1',
      displayCallsign: 'ATLAS-1',
      status: 'requested',
      changedPathsJson: JSON.stringify(['components/auth/SignupForm.tsx']),
      inspectionSignalsJson: JSON.stringify([]),
      evidenceRefsJson: JSON.stringify([]),
      requestedAt: new Date('2026-06-29T23:05:00.000Z'),
      completedAt: null,
    });
    prisma.codeSiteInspectionRun.update.mockImplementation(async ({ where, data }) => ({
      id: where.id,
      projectId: 'project-1',
      executionPlanId: 'plan-1',
      displayCallsign: 'ATLAS-1',
      status: 'requested',
      changedPathsJson: JSON.stringify(['components/auth/SignupForm.tsx']),
      inspectionSignalsJson: JSON.stringify([]),
      evidenceRefsJson: JSON.stringify([]),
      requestedAt: new Date('2026-06-29T23:05:00.000Z'),
      completedAt: null,
      ...data,
    }));
    prisma.codeSiteIncident.create.mockImplementation(async ({ data }) => ({
      id: 'incident-created',
      createdAt: new Date('2026-06-29T23:05:00.000Z'),
      ...data,
    }));
    prisma.codeSiteIncident.update.mockImplementation(async ({ where, data }) => ({
      id: where.id,
      projectId: 'project-1',
      severity: 'critical',
      category: 'mayday',
      participantsJson: JSON.stringify(['API-01']),
      affectedZonesJson: JSON.stringify(['api/auth/**']),
      incidentReplayJson: data.incidentReplayJson,
      replayDigest: data.replayDigest,
      timelineEventRefsJson: data.timelineEventRefsJson,
      policyDeltaJson: JSON.stringify(null),
      evidenceRefsJson: JSON.stringify(['runtime:event:mayday']),
      createdAt: new Date('2026-06-29T23:05:00.000Z'),
    }));
    prisma.codeSiteProofBundle.create.mockImplementation(async ({ data }) => ({
      id: 'proof-created',
      createdAt: new Date('2026-06-29T23:03:00.000Z'),
      ...data,
    }));
    prisma.codeSiteLineProvenance.create.mockResolvedValue({ id: 'line-created' });
	  });

  it('blocks restricted airspace clearances without executable Dojo proof', async () => {
    const lease = await requestMutationLease('acme', 'plan-1', {
      allowedPaths: ['synthi/prisma/**'],
    });

    expect(lease.status).toBe('blocked');
    expect(lease.policyDecision.reasonCodes).toEqual(expect.arrayContaining([
      'dojo_proof_required_for_restricted_airspace',
      'dojo_proof_ref_required',
      'dojo_license_ref_required',
      'dojo_evidence_refs_required',
      'dojo_implementation_not_executable',
    ]));
    expect(prisma.codeSiteMutationLease.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'blocked',
        dojoProofRef: null,
        implementationStatusJson: expect.stringContaining('executable'),
      }),
    }));
  });

  it('allows restricted airspace clearances with executable Dojo proof refs', async () => {
    const lease = await requestMutationLease('acme', 'plan-1', {
      allowedPaths: ['synthi/prisma/**'],
      dojoProofRef: 'pcap-auth-schema',
      dojoLicenseRef: 'schema.level_2@2026-06-25',
      dojoEvidenceRefs: ['dojo:evidence:checkride-1'],
      dojoLedgerCheckpointHash: 'sha256:ledger',
      dojoDecisionDigest: 'sha256:decision',
      implementationStatus: { executable: true, productionRuntime: false },
    });

    expect(lease.status).toBe('active');
    expect(lease.dojoProofRef).toBe('pcap-auth-schema');
    expect(lease.policyDecision.reasonCodes).toContain('dojo_clearance_proof_verified');
  });

  it('allows low-risk clearances without Dojo proof', async () => {
    prisma.codeSiteExecutionPlan.findFirst.mockResolvedValue(executionPlanFixture(['docs/**']));

    const lease = await requestMutationLease('acme', 'plan-docs', {
      allowedPaths: ['docs/**'],
    });

    expect(lease.status).toBe('active');
    expect(lease.policyDecision.reasonCodes).toContain('route_inside_clearance');
    expect(lease.policyDecision.reasonCodes).not.toContain('dojo_proof_required_for_restricted_airspace');
  });

  it('turns mayday declarations into ground stops with suspended leases and inspector dispatch', async () => {
    prisma.codeSiteProject.findFirst.mockResolvedValue({
      id: 'project-1',
      workspaceSlug: 'acme',
      title: 'Signup',
      request: 'Build signup',
      status: 'active',
      zonePolicyJson: JSON.stringify({
        zones: [
          { zoneKey: 'auth_api', class: 'A', label: 'Auth API', paths: ['api/auth/**'], rules: [], risk: 'critical' },
          { zoneKey: 'docs', class: 'D', label: 'Docs', paths: ['docs/**'], rules: [], risk: 'low' },
        ],
        noFlyZones: [],
      }),
      controlPlanJson: JSON.stringify({ strategy: 'schema-first' }),
      createdAt: new Date('2026-06-29T23:00:00.000Z'),
      updatedAt: new Date('2026-06-29T23:00:00.000Z'),
    });
    prisma.codeSiteMutationLease.findMany.mockResolvedValue([
      {
        id: 'lease-api',
        projectId: 'project-1',
        executionPlanId: 'plan-api',
        agentSessionId: 'agent-api',
        displayCallsign: 'API-01',
        status: 'active',
        leaseJson: JSON.stringify({ allowedPaths: ['api/auth/**'] }),
        issuedAt: new Date('2026-06-29T23:00:00.000Z'),
        expiresAt: null,
        revokedAt: null,
      },
      {
        id: 'lease-docs',
        projectId: 'project-1',
        executionPlanId: 'plan-docs',
        agentSessionId: 'agent-docs',
        displayCallsign: 'DOCS-01',
        status: 'active',
        leaseJson: JSON.stringify({ allowedPaths: ['docs/**'] }),
        issuedAt: new Date('2026-06-29T23:00:00.000Z'),
        expiresAt: null,
        revokedAt: null,
      },
    ]);

    const incident = await createIncident('acme', 'project-1', {
      category: 'mayday',
      severity: 'critical',
      reason: 'auth bypass detected',
      displayCallsign: 'API-01',
      participants: ['API-01'],
      affectedZones: ['auth_api'],
      evidenceRefs: ['runtime:event:mayday'],
    });
    const eventTypes = prisma.codeSiteEvent.create.mock.calls.map((call) => call[0].data.eventType);
    const stopWorkBody = JSON.parse(prisma.codeSiteDocument.create.mock.calls.at(-1)[0].data.bodyJson);
    const inspectionRun = prisma.codeSiteInspectionRun.create.mock.calls.at(-1)[0].data;
    const inspectionSignals = JSON.parse(inspectionRun.inspectionSignalsJson);

    expect(incident.category).toBe('mayday');
    expect(incident.maydayWorkflow).toMatchObject({
      suspendedLeases: 1,
      inspectorRunId: 'inspection-created',
      stopWorkDocumentId: 'doc-1',
      humanResumeRequired: true,
    });
    expect(prisma.codeSiteMutationLease.update).toHaveBeenCalledTimes(1);
    expect(prisma.codeSiteMutationLease.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'lease-api' },
      data: { status: 'suspended' },
    }));
    expect(prisma.codeSitePolicyDecision.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        mutationLeaseId: 'lease-api',
        decision: 'hold',
        reasonCodesJson: expect.stringContaining('mayday_ground_stop'),
      }),
    }));
    expect(eventTypes).toEqual(expect.arrayContaining([
      'mayday',
      'snapshot_taken',
      'ground_stop',
      'landing_requested',
    ]));
    expect(inspectionRun).toMatchObject({
      displayCallsign: 'SEC-01',
      status: 'requested',
      changedPathsJson: JSON.stringify(['api/auth/**']),
    });
    expect(inspectionSignals.map((signal) => signal.key)).toEqual(expect.arrayContaining(['auth', 'security']));
    expect(stopWorkBody.resumeGate).toMatchObject({
      requiresHumanApproval: true,
      status: 'blocked',
    });
    expect(stopWorkBody.suspendedLeaseIds).toEqual(['lease-api']);
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
          lineProvenance: [{
            lineAnchor: 'synthi/prisma/schema.prisma#L12',
            startLine: 12,
            endLine: 15,
            evidenceRefs: ['hunk:evidence'],
            processAncestry: ['mcp:synthi_codesite_apply_patch'],
            promptSummary: 'Add auth schema field',
          }],
          evidenceRefs: ['write:evidence'],
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

  it('detects stale reads through route overlap and semantic dependency refs', async () => {
    prisma.codeSiteMutationTransaction.findFirst.mockResolvedValue({
      ...transactionFixture(),
      readSetJson: JSON.stringify(['packages/schemas/**']),
      observedReadSetJson: JSON.stringify(['packages/schemas/auth/signup.ts']),
      semanticDependencyRefsJson: JSON.stringify([{ path: 'openapi/**' }]),
    });
    prisma.codeSiteEvent.findMany.mockResolvedValue([
      {
        id: 'event-schema-write',
        eventType: 'write_allowed',
        actorId: 'txn-other',
        displayCallsign: 'BETA-2',
        createdAt: new Date('2026-06-29T23:02:00.000Z'),
        detailsJson: JSON.stringify({
          transactionId: 'txn-other',
          path: 'packages/schemas/auth/signup.ts',
        }),
      },
      {
        id: 'event-openapi-commit',
        eventType: 'transaction_committed',
        actorId: 'txn-openapi',
        displayCallsign: 'GAMMA-3',
        createdAt: new Date('2026-06-29T23:03:00.000Z'),
        detailsJson: JSON.stringify({
          transactionId: 'txn-openapi',
          writeSet: ['openapi/auth.yaml'],
        }),
      },
    ]);

    const result = await validateTransaction('acme', 'txn-1');

    expect(result.decision.ok).toBe(false);
    expect(result.decision.reasonCodes).toContain('stale_read_detected');
    expect(result.decision.staleReads).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventId: 'event-schema-write' }),
      expect.objectContaining({ eventId: 'event-openapi-commit' }),
    ]));
    expect(prisma.codeSiteMutationTransaction.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'txn-1' },
      data: expect.objectContaining({ status: 'blocked' }),
    }));
  });

  it('blocks serializable validation when the recorded repo read snapshot drifts', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codesite-control-snapshot-'));
    await fs.mkdir(path.join(root, 'packages', 'schemas'), { recursive: true });
    await fs.writeFile(path.join(root, 'packages', 'schemas', 'auth.ts'), 'export const version = 1;\n', 'utf8');
    const snapshot = await buildReadSnapshotEvidence(['packages/schemas/auth.ts'], { repoRoot: root });

    prisma.codeSiteMutationTransaction.findFirst.mockResolvedValue({
      ...transactionFixture(),
      baseSnapshot: snapshot.snapshotDigest,
      baseSnapshotEvidenceJson: JSON.stringify(snapshot),
      readSetJson: JSON.stringify(['packages/schemas/auth.ts']),
      writeSetJson: JSON.stringify(['components/auth/SignupForm.tsx']),
      observedWriteSetJson: JSON.stringify([]),
      mutationLease: {
        ...transactionFixture().mutationLease,
        leaseJson: JSON.stringify({
          allowedPaths: ['components/auth/**'],
          blockedPaths: [],
          allowedTools: ['file_write'],
          requiredRadar: ['typecheck', 'tests'],
        }),
      },
    });
    prisma.codeSiteEvent.findMany.mockResolvedValue([]);
    await fs.writeFile(path.join(root, 'packages', 'schemas', 'auth.ts'), 'export const version = 2;\n', 'utf8');

    const result = await validateTransaction('acme', 'txn-1');

    expect(result.decision.ok).toBe(false);
    expect(result.decision.reasonCodes).toContain('repo_snapshot_drift_detected');
    expect(result.decision.repoSnapshot.driftedPaths).toEqual([
      expect.objectContaining({ path: 'packages/schemas/auth.ts' }),
    ]);
    expect(prisma.codeSiteMutationTransaction.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'txn-1' },
      data: expect.objectContaining({ status: 'blocked' }),
    }));
  });

  it('executes landing inspection commands and records durable radar evidence', async () => {
    const run = await createInspectionRun('acme', 'project-1', {
      executionPlanId: 'plan-1',
      displayCallsign: 'ATLAS-1',
      changedPaths: ['components/auth/SignupForm.tsx'],
      execute: true,
      commands: [{
        key: 'tests',
        command: process.execPath,
        args: ['-e', 'console.log("codesite inspection ok")'],
        timeoutMs: 5000,
      }],
    });

    expect(run.status).toBe('completed');
    expect(run.inspectionSignals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'tests',
        status: 'passed',
        exitCode: 0,
        stdoutTail: expect.stringContaining('codesite inspection ok'),
        evidenceRefs: expect.arrayContaining([expect.stringMatching(/^test:run:sha256:/)]),
      }),
    ]));
    expect(run.evidenceRefs).toEqual(expect.arrayContaining([expect.stringMatching(/^test:run:sha256:/)]));
    expect(prisma.codeSiteEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: 'radar_result',
        actorId: 'inspection-created',
      }),
    }));
    expect(prisma.codeSiteEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: 'inspection_result',
        actorId: 'inspection-created',
      }),
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

  it('resumes project events by logical time instead of lexicographic ids', async () => {
    prisma.codeSiteEvent.findFirst.mockResolvedValue({
      id: 'z-last-emitted',
      logicalTime: 7,
    });
    prisma.codeSiteEvent.findMany.mockResolvedValue([
      {
        id: 'a-later-event',
        projectId: 'project-1',
        mutationLeaseId: null,
        eventType: 'inspection_result',
        displayCallsign: 'INSPECT-1',
        actorType: 'inspection',
        actorId: 'inspection-1',
        detailsJson: JSON.stringify({ status: 'completed' }),
        evidenceRefsJson: JSON.stringify(['runtime:event:inspection-1']),
        logicalTime: 8,
        createdAt: new Date('2026-06-29T23:05:00.000Z'),
      },
    ]);

    const events = await getEvents('acme', 'project-1', 'z-last-emitted');

    expect(events).toEqual([expect.objectContaining({
      id: 'a-later-event',
      logicalTime: 8,
      details: { status: 'completed' },
    })]);
    expect(prisma.codeSiteEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        projectId: 'project-1',
        logicalTime: { gt: 7 },
      },
      orderBy: [{ logicalTime: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    }));
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

  it('records allowed write line provenance for the causal line inspector', async () => {
    const result = await recordTransactionWrite('acme', 'txn-1', {
      path: 'synthi/prisma/schema.prisma',
      tool: 'file_write',
      evidenceRefs: ['write:evidence'],
      codesiteFsEvent: {
        type: 'write_allowed',
        evidence_refs: ['fs:event:evidence'],
        details: {
          process_ancestry: ['mcp:synthi_codesite_apply_patch'],
          lineProvenance: [{
            startLine: 7,
            endLine: 9,
            evidenceRefs: ['hunk:evidence'],
            promptSummary: 'Update schema field',
          }],
        },
      },
    });
    const allowedEvent = prisma.codeSiteEvent.create.mock.calls
      .map((call) => call[0])
      .find((call) => call.data.eventType === 'write_allowed');
    const details = JSON.parse(allowedEvent.data.detailsJson);

    expect(result.ok).toBe(true);
    expect(details).toMatchObject({
      transactionId: 'txn-1',
      path: 'synthi/prisma/schema.prisma',
      evidenceRefs: ['write:evidence', 'fs:event:evidence'],
      processAncestry: ['mcp:synthi_codesite_apply_patch'],
    });
    expect(details.lineProvenance).toEqual([expect.objectContaining({
      filePath: 'synthi/prisma/schema.prisma',
      lineAnchor: 'synthi/prisma/schema.prisma#L7',
      startLine: 7,
      endLine: 9,
      evidenceRefs: ['hunk:evidence'],
      promptSummary: 'Update schema field',
    })]);
  });

  it('previews transaction writes without mutating write sets, events, or policy decisions', async () => {
    const result = await dryRunTransactionWrites('acme', 'txn-1', {
      files: [
        { path: 'synthi/prisma/schema.prisma' },
        { path: 'secrets/prod.env' },
      ],
    });

    expect(result.results).toEqual([
      expect.objectContaining({
        ok: true,
        path: 'synthi/prisma/schema.prisma',
        tool: 'file_write',
      }),
      expect.objectContaining({
        ok: false,
        path: 'secrets/prod.env',
        reasonCodes: expect.arrayContaining(['entered_no_fly_zone']),
        policyDecision: expect.objectContaining({ decision: 'block' }),
      }),
    ]);
    expect(prisma.codeSiteMutationTransaction.update).not.toHaveBeenCalled();
    expect(prisma.codeSiteEvent.create).not.toHaveBeenCalled();
    expect(prisma.codeSitePolicyDecision.create).not.toHaveBeenCalled();
  });

  it('gates agent inbox reads and acknowledgements to the owning user session', async () => {
    await expect(getAgentInbox('acme', 'agent-1', { userId: 'user-2' })).rejects.toMatchObject({
      status: 403,
      code: 'agent_inbox_forbidden',
    });
    expect(prisma.codeSiteAgentInboxItem.findMany).not.toHaveBeenCalled();

    const inbox = await getAgentInbox('acme', 'agent-1', { userId: 'user-1' });
    const acknowledged = await acknowledgeInboxItem('acme', 'agent-1', 'evt-1', { userId: 'user-1' });

    expect(inbox).toEqual([]);
    expect(acknowledged).toMatchObject({ status: 'acknowledged', eventId: 'evt-1' });
    expect(prisma.codeSiteAgentInboxItem.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'inbox-1' },
      data: expect.objectContaining({ status: 'acknowledged' }),
    }));
  });

  it('routes tower-mediated documents with recursive redaction and inbox ACL metadata', async () => {
    const result = await createDocument('acme', 'project-1', {
      kind: 'rfi',
      title: 'Need schema owner approval',
      fromSessionId: 'agent-1',
      toSessionId: 'agent-2',
      executionPlanId: 'plan-1',
      blocking: true,
      body: {
        question: 'Can signup payload include displayName?',
        nested: {
          apiKey: 'sk-secret-value-123456',
          privatePrompt: 'raw local prompt',
        },
      },
    }, { userId: 'user-1' });
    const documentCreate = prisma.codeSiteDocument.create.mock.calls.at(-1)[0];
    const savedBody = JSON.parse(documentCreate.data.bodyJson);

    expect(result.inboxItems).toHaveLength(1);
    expect(savedBody.nested.apiKey).toBe('[redacted]');
    expect(savedBody.nested.privatePrompt).toBe('[redacted]');
    expect(savedBody.routing).toMatchObject({
      fromSessionId: 'agent-1',
      toSessionIds: ['agent-2'],
      projectRefs: { executionPlanId: 'plan-1' },
    });
    expect(prisma.codeSiteAgentInboxItem.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        agentSessionId: 'agent-2',
        recipientUserId: 'user-2',
        requiresResponse: true,
      }),
    }));
  });

  it('rejects cross-agent documents without sender ownership or project references', async () => {
    await expect(createDocument('acme', 'project-1', {
      kind: 'rfi',
      fromSessionId: 'agent-1',
      toSessionId: 'agent-2',
      executionPlanId: 'plan-1',
    }, { userId: 'user-2' })).rejects.toMatchObject({
      status: 403,
      code: 'document_sender_forbidden',
    });

    await expect(createDocument('acme', 'project-1', {
      kind: 'rfi',
      fromSessionId: 'agent-1',
      toSessionId: 'agent-2',
    }, { userId: 'user-1' })).rejects.toMatchObject({
      status: 400,
      code: 'document_project_reference_required',
    });
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
          lineProvenance: [{
            lineAnchor: 'synthi/prisma/schema.prisma#L12',
            startLine: 12,
            endLine: 15,
            evidenceRefs: ['hunk:evidence'],
            processAncestry: ['mcp:synthi_codesite_apply_patch'],
            promptSummary: 'Add auth schema field',
          }],
          evidenceRefs: ['write:evidence'],
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
          lineProvenance: [{
            lineAnchor: 'synthi/prisma/schema.prisma#L12',
            startLine: 12,
            endLine: 15,
            evidenceRefs: ['hunk:evidence'],
            processAncestry: ['mcp:synthi_codesite_apply_patch'],
            promptSummary: 'Add auth schema field',
          }],
          evidenceRefs: ['write:evidence'],
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
        { key: 'typecheck', status: 'passed', evidenceRefs: ['runtime:event:typecheck-1'] },
        { key: 'tests', status: 'passed', evidenceRefs: ['runtime:event:tests-1'] },
      ]),
      evidenceRefsJson: JSON.stringify(['runtime:event:inspection-1']),
      requestedAt: new Date('2026-06-29T23:02:00.000Z'),
      completedAt: new Date('2026-06-29T23:03:00.000Z'),
    }]);

    const result = await commitTransaction('acme', 'txn-1', { commitSha: 'abc123', repoState: repoStateFixture() });
    const proofCreate = prisma.codeSiteProofBundle.create.mock.calls.at(-1)[0];
    const evidenceRefs = JSON.parse(proofCreate.data.evidenceRefsJson);

    expect(result.transaction.status).toBe('committed');
    expect(result.proofBundle.commitSha).toBe('abc123');
    expect(evidenceRefs).toEqual(expect.arrayContaining([
      'runtime:event:inspection-1',
      'runtime:event:typecheck-1',
      'runtime:event:tests-1',
      'codesite:inspection:inspection-1',
      'codesite:repo-state:sha256:repo-state',
      'codesite:transaction:txn-1',
      'codesite:lease:lease-1',
    ]));
    expect(JSON.parse(proofCreate.data.repoStateJson)).toMatchObject({
      evidenceDigest: 'sha256:repo-state',
      writeFileDigests: [expect.objectContaining({ path: 'synthi/prisma/schema.prisma' })],
    });
    expect(prisma.codeSiteLineProvenance.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        proofBundleId: 'proof-created',
        filePath: 'synthi/prisma/schema.prisma',
        lineAnchor: 'synthi/prisma/schema.prisma#L12',
        evidenceRefsJson: expect.stringContaining('hunk:evidence'),
        processAncestryJson: expect.stringContaining('mcp:synthi_codesite_apply_patch'),
        promptSummary: 'Add auth schema field',
      }),
    }));
  });

  it('blocks proof-carrying commits when changed paths lack line provenance evidence', async () => {
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
          evidenceRefs: ['write:evidence'],
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
        { key: 'typecheck', status: 'passed', evidenceRefs: ['runtime:event:typecheck-1'] },
        { key: 'tests', status: 'passed', evidenceRefs: ['runtime:event:tests-1'] },
      ]),
      evidenceRefsJson: JSON.stringify(['runtime:event:inspection-1']),
      requestedAt: new Date('2026-06-29T23:02:00.000Z'),
      completedAt: new Date('2026-06-29T23:03:00.000Z'),
    }]);

    const result = await commitTransaction('acme', 'txn-1', { commitSha: 'abc123', repoState: repoStateFixture() });

    expect(result.decision.ok).toBe(false);
    expect(result.decision.reasonCodes).toEqual(['line_provenance_required']);
    expect(result.decision.missingLineProvenancePaths).toEqual(['synthi/prisma/schema.prisma']);
    expect(prisma.codeSiteProofBundle.create).not.toHaveBeenCalled();
    expect(prisma.codeSiteLineProvenance.create).not.toHaveBeenCalled();
    expect(prisma.codeSiteMutationTransaction.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'txn-1' },
      data: expect.objectContaining({
        status: 'blocked',
        commitDecisionJson: expect.stringContaining('line_provenance_required'),
      }),
    }));
  });

  it('rejects path-only line provenance without numeric changed ranges', async () => {
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
          lineProvenance: ['synthi/prisma/schema.prisma#L12'],
          evidenceRefs: ['write:evidence'],
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
        { key: 'typecheck', status: 'passed', evidenceRefs: ['runtime:event:typecheck-1'] },
        { key: 'tests', status: 'passed', evidenceRefs: ['runtime:event:tests-1'] },
      ]),
      evidenceRefsJson: JSON.stringify(['runtime:event:inspection-1']),
      requestedAt: new Date('2026-06-29T23:02:00.000Z'),
      completedAt: new Date('2026-06-29T23:03:00.000Z'),
    }]);

    const result = await commitTransaction('acme', 'txn-1', { repoState: repoStateFixture() });

    expect(result.decision.ok).toBe(false);
    expect(result.decision.reasonCodes).toEqual(['line_provenance_required']);
    expect(result.decision.missingLineProvenancePaths).toEqual(['synthi/prisma/schema.prisma']);
    expect(prisma.codeSiteProofBundle.create).not.toHaveBeenCalled();
  });

  it('blocks proof-carrying commits when passed inspections lack repo-state evidence', async () => {
    prisma.codeSiteEvent.findMany.mockResolvedValue([]);
    prisma.codeSiteInspectionRun.findMany.mockResolvedValue([{
      id: 'inspection-1',
      projectId: 'project-1',
      executionPlanId: 'plan-1',
      displayCallsign: 'ATLAS-1',
      status: 'completed',
      changedPathsJson: JSON.stringify(['synthi/prisma/**']),
      inspectionSignalsJson: JSON.stringify([
        { key: 'typecheck', status: 'passed', evidenceRefs: ['runtime:event:typecheck-1'] },
        { key: 'tests', status: 'passed', evidenceRefs: ['runtime:event:tests-1'] },
      ]),
      evidenceRefsJson: JSON.stringify(['runtime:event:inspection-1']),
      requestedAt: new Date('2026-06-29T23:02:00.000Z'),
      completedAt: new Date('2026-06-29T23:03:00.000Z'),
    }]);

    const result = await commitTransaction('acme', 'txn-1');

    expect(result.decision.ok).toBe(false);
    expect(result.decision.reasonCodes).toContain('repo_state_evidence_required');
    expect(prisma.codeSiteProofBundle.create).not.toHaveBeenCalled();
  });

  it('rejects synthetic landing pass strings without executable inspection evidence', async () => {
    prisma.codeSiteEvent.findMany.mockResolvedValue([]);
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
      evidenceRefsJson: JSON.stringify(['inspection:claimed']),
      requestedAt: new Date('2026-06-29T23:02:00.000Z'),
      completedAt: new Date('2026-06-29T23:03:00.000Z'),
    }]);

    const result = await commitTransaction('acme', 'txn-1', { repoState: repoStateFixture() });

    expect(result.decision.ok).toBe(false);
    expect(result.decision.reasonCodes).toEqual(expect.arrayContaining([
      'inspection_signal_required',
      'inspection_executable_evidence_required',
    ]));
    expect(prisma.codeSiteProofBundle.create).not.toHaveBeenCalled();
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
      repoStateJson: JSON.stringify(repoStateFixture()),
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
      repoState: expect.objectContaining({ evidenceDigest: 'sha256:repo-state' }),
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
