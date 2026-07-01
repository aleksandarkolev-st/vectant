import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalDojoProofPayload,
  createEd25519DojoProofSigner,
  generateEd25519DojoProofKeyPair,
} from '../../../../../mcp/synthi-mcp/dist/dojo/proof/signing.js';

const { prisma } = vi.hoisted(() => ({
  prisma: {
    codeSiteMutationTransaction: {
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    codeSiteProject: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    codeSiteExecutionPlan: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    codeSiteMutationLease: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    codeSiteAgentSession: {
      create: vi.fn(),
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
      create: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
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
    codeSiteCounterfactualRun: {
      create: vi.fn(),
    },
    codeSiteMutationZone: {
      upsert: vi.fn(),
    },
    workspace: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/prisma', () => ({
  default: prisma,
}));

import {
  commitTransaction,
  acknowledgeInboxItem,
  createAgentSession,
  createCounterfactualRun,
  createExecutionPlan,
  createProject,
  createIncident,
  createDocument,
  createInspectionRun,
  dryRunTransactionWrites,
  getAgentInbox,
  getAgentManifest,
  getEvents,
  getIncidentReplay,
  getLineProvenance,
  getProject,
  getProofBundle,
  getSourceStateSince,
  openTransaction,
  preflightCodeSiteFsWrite,
  recordTransactionWrite,
  requestMutationLease,
  validateTransaction,
} from '../controlPlane.js';
import { CODESITE_MCP_TOOLS } from '../artifacts.js';
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
    readSetJson: JSON.stringify([]),
    observedReadSetJson: JSON.stringify([]),
    writeSetJson: JSON.stringify(['synthi/prisma/schema.prisma']),
    observedWriteSetJson: JSON.stringify(['synthi/prisma/schema.prisma']),
    semanticDependencyRefsJson: JSON.stringify([]),
    invariantsJson: JSON.stringify(['clearance.diff.inside_route']),
    assumptionRefsJson: JSON.stringify([]),
    commitDecisionJson: null,
    proofBundleDigest: null,
    openedAt: new Date('2026-06-29T23:00:00.000Z'),
    closedAt: null,
    agentSession: {
      id: 'agent-1',
      projectId: 'project-1',
      ownerUserId: 'user-1',
      displayCallsign: 'ATLAS-1',
    },
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

function signedDojoProofFixture() {
  const keyPair = generateEd25519DojoProofKeyPair('dojo-test-key');
  const signer = createEd25519DojoProofSigner({
    key_id: keyPair.key_id,
    private_key_pem: keyPair.private_key_pem,
  });
  const unsignedCapsule = {
    schema_version: 'synthi.dojo.proofCapsule.v1',
    capsule_id: 'pcap-auth-schema',
    skill_id: 'codesite.schema',
    skill_version: '2026-06-25.1',
    requested_action: 'codesite.mutation.clearance',
    license_version: 'schema.level_2@2026-06-25',
    issuer: 'dojo-test-issuer',
    key_id: keyPair.key_id,
    nonce: 'nonce-codesite-test-1',
    ledger_checkpoint_hash: 'a'.repeat(64),
    evidence_claims: [{
      claim: 'codesite.restricted_mutation',
      satisfied: true,
      evidence_refs: ['evidence:ev-checkride-1'],
    }],
    evidence_record_ids: ['ev-checkride-1'],
    issued_at: '2026-06-29T00:00:00.000Z',
    expires_at: '2026-07-02T00:00:00.000Z',
    signature_algorithm: 'ed25519',
  };
  const signature = signer.sign(canonicalDojoProofPayload(unsignedCapsule));
  return {
    dojoProofCapsule: {
      ...unsignedCapsule,
      signature: signature.signature,
    },
    dojoProofKey: {
      schema_version: 'synthi.dojo.proofKey.v1',
      tenant_id: 'acme',
      key_id: keyPair.key_id,
      issuer: 'dojo-test-issuer',
      algorithm: 'ed25519',
      signing_provider: 'ed25519-local',
      key_custody: 'local',
      public_key_pem: keyPair.public_key_pem,
      status: 'active',
      created_at: '2026-06-29T00:00:00.000Z',
      retain_for_forensic_verification: false,
    },
    dojoRequiredEvidenceClaims: ['codesite.restricted_mutation'],
    implementationStatus: { executable: true, productionRuntime: false },
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
    prisma.codeSiteProject.create.mockImplementation(async ({ data }) => ({
      id: 'project-created',
      createdAt: new Date('2026-06-29T23:00:00.000Z'),
      updatedAt: new Date('2026-06-29T23:00:00.000Z'),
      ...data,
    }));
    prisma.codeSiteProject.update.mockImplementation(async ({ where, data }) => ({
      id: where.id,
      workspaceSlug: 'acme',
      title: 'Signup',
      request: 'Build signup',
      status: 'active',
      zonePolicyJson: JSON.stringify({ zones: [] }),
      controlPlanJson: data.controlPlanJson,
      createdAt: new Date('2026-06-29T23:00:00.000Z'),
      updatedAt: new Date('2026-06-29T23:00:00.000Z'),
    }));
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
    prisma.workspace.findUnique.mockResolvedValue({
      slug: 'acme',
      memberships: [
        { userId: 'user-1', role: 'member' },
        { userId: 'user-2', role: 'member' },
      ],
    });
    prisma.codeSiteMutationZone.upsert.mockResolvedValue({});
    prisma.codeSiteExecutionPlan.findFirst.mockResolvedValue(executionPlanFixture());
    prisma.codeSiteExecutionPlan.findMany.mockResolvedValue([]);
    prisma.codeSiteExecutionPlan.create.mockImplementation(async ({ data }) => ({
      id: `plan-${data.displayCallsign}`,
      filedAt: new Date('2026-06-29T23:01:00.000Z'),
      closedAt: null,
      ...data,
    }));
    prisma.codeSiteMutationLease.create.mockImplementation(async ({ data }) => ({
      id: 'lease-created',
      issuedAt: new Date('2026-06-29T23:00:00.000Z'),
      expiresAt: null,
      revokedAt: null,
      ...data,
    }));
    prisma.codeSiteMutationLease.findFirst.mockResolvedValue({
      id: 'lease-1',
      projectId: 'project-1',
      executionPlanId: 'plan-1',
      agentSessionId: 'agent-1',
      displayCallsign: 'ATLAS-1',
      status: 'active',
      leaseJson: JSON.stringify({ allowedPaths: ['synthi/prisma/**'] }),
      issuedAt: new Date('2026-06-29T23:00:00.000Z'),
      expiresAt: null,
      revokedAt: null,
      agentSession: {
        id: 'agent-1',
        projectId: 'project-1',
        ownerUserId: 'user-1',
        displayCallsign: 'ATLAS-1',
      },
    });
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
    prisma.codeSiteAssumptionLease.create.mockImplementation(async ({ data }) => ({
      id: 'assumption-created',
      createdAt: new Date('2026-06-29T23:02:00.000Z'),
      invalidatedAt: null,
      invalidatedBy: null,
      ...data,
    }));
    prisma.codeSiteAssumptionLease.findMany.mockResolvedValue([]);
    prisma.codeSiteAssumptionLease.update.mockImplementation(async ({ where, data }) => ({
      id: where.id,
      projectId: 'project-1',
      ownerSessionId: 'agent-1',
      displayCallsign: 'ATLAS-1',
      assumptionKey: 'auth.signup.schema',
      dependsOnJson: JSON.stringify([{ ref: 'auth.signup.schema', version: 'v1' }]),
      usedByJson: JSON.stringify(['components/auth/SignupForm.tsx']),
      createdAt: new Date('2026-06-29T23:02:00.000Z'),
      ...data,
    }));
    prisma.codeSiteAgentSession.findFirst.mockResolvedValue({
      id: 'agent-1',
      projectId: 'project-1',
      ownerUserId: 'user-1',
      displayCallsign: 'ATLAS-1',
    });
    prisma.codeSiteAgentSession.create.mockImplementation(async ({ data }) => ({
      id: `agent-${data.displayCallsign}`,
      createdAt: new Date('2026-06-29T23:01:00.000Z'),
      endedAt: null,
      ...data,
    }));
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
    let eventSeq = 0;
    prisma.codeSiteEvent.count.mockResolvedValue(1);
    prisma.codeSiteEvent.create.mockImplementation(async ({ data }) => ({
      id: `event-${data.eventType || 'codesite'}-${eventSeq += 1}`,
      createdAt: new Date('2026-06-29T23:04:00.000Z'),
      ...data,
    }));
    prisma.codeSiteEvent.findFirst.mockResolvedValue(null);
    prisma.codeSiteEvent.findMany.mockResolvedValue([]);
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
    let latestIncident = null;
    prisma.codeSiteIncident.create.mockImplementation(async ({ data }) => {
      latestIncident = {
        id: 'incident-created',
        createdAt: new Date('2026-06-29T23:05:00.000Z'),
        ...data,
      };
      return latestIncident;
    });
    prisma.codeSiteIncident.update.mockImplementation(async ({ where, data }) => ({
      ...(latestIncident || {
        id: where.id,
        projectId: 'project-1',
        severity: 'critical',
        category: 'mayday',
        participantsJson: JSON.stringify(['API-01']),
        affectedZonesJson: JSON.stringify(['api/auth/**']),
        policyDeltaJson: JSON.stringify(null),
        evidenceRefsJson: JSON.stringify(['runtime:event:mayday']),
        createdAt: new Date('2026-06-29T23:05:00.000Z'),
      }),
      ...data,
    }));
    prisma.codeSiteProofBundle.create.mockImplementation(async ({ data }) => ({
      id: 'proof-created',
      createdAt: new Date('2026-06-29T23:03:00.000Z'),
      ...data,
    }));
    prisma.codeSiteLineProvenance.create.mockResolvedValue({ id: 'line-created' });
	  });

  it('serves the shared MCP tool contract from the agent manifest', async () => {
    const manifest = await getAgentManifest('acme', 'project-1');

    expect(manifest.mcpTools).toEqual(CODESITE_MCP_TOOLS);
    expect(manifest.mcpTools).toContain('synthi_codesite_get_inbox');
    expect(manifest.inboxRoot).toBe('projects/project-1/inbox/');
  });

  it('bootstraps automatic tower workflow with schema-first holding plans', async () => {
    await createProject('acme', { userId: 'user-1' }, {
      title: 'Build signup',
      request: 'Build signup with email verification',
      autoWorkflow: true,
      zonePolicy: {
        zones: [
          { zoneKey: 'schema', class: 'B', label: 'Shared schema', paths: ['packages/schemas/**'], rules: [], risk: 'high' },
          { zoneKey: 'frontend', class: 'C', label: 'Frontend UI', paths: ['components/auth/**'], rules: [], risk: 'medium' },
        ],
        repoSignals: {
          files: ['packages/schemas/auth.ts', 'components/auth/SignupForm.tsx'],
          importEdges: [{ from: 'components/auth/SignupForm.tsx', imports: ['packages/schemas/auth.ts'] }],
        },
      },
    });

    expect(prisma.codeSiteAgentSession.create).toHaveBeenCalledTimes(2);
    expect(prisma.codeSiteExecutionPlan.create).toHaveBeenCalledTimes(2);
    const createdPlans = prisma.codeSiteExecutionPlan.create.mock.calls.map((call) => call[0].data);
    expect(createdPlans.map((plan) => plan.domain)).toEqual(['schema', 'frontend']);
    expect(createdPlans[0]).toMatchObject({ displayCallsign: 'SCHEMA-01', status: 'preflight' });
    expect(createdPlans[1]).toMatchObject({ displayCallsign: 'UI-02', status: 'holding' });
    const controlPlan = JSON.parse(prisma.codeSiteProject.update.mock.calls.at(-1)[0].data.controlPlanJson);
    expect(controlPlan.selectedStrategy).toBe('schema-first');
    expect(controlPlan.automaticWorkflow).toMatchObject({
      enabled: true,
      collisionForecast: { riskLevel: 'high' },
    });
    expect(controlPlan.routeIntersections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        risk: 'semantic_collision',
        recommendedResolution: expect.objectContaining({ action: 'schema_first' }),
      }),
    ]));
    expect(prisma.codeSiteEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: 'flight_plan_filed',
        detailsJson: expect.stringContaining('Hold position until schema-first route lands'),
      }),
    }));
  });

  it('persists Dojo pilot license refs on agent sessions', async () => {
    const result = await createAgentSession('acme', 'project-1', { userId: 'user-1' }, {
      displayCallsign: 'PILOT-1',
      agentProvider: 'codex',
      agentRuntime: 'tmp-codex-cli',
      dojoPilotLicenseRef: 'license:codex-runtime@2026-06-30',
      dojoProofRef: 'proof:pilot-session',
      dojoEvidenceRefs: ['dojo:evidence:pilot-session'],
      dojoDecisionDigest: 'sha256:pilotdecision',
      pilotLicenseSnapshot: { licenseClass: 'runtime', level: 2 },
    });

    expect(prisma.codeSiteAgentSession.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        dojoPilotLicenseRef: 'license:codex-runtime@2026-06-30',
        dojoProofRef: 'proof:pilot-session',
        dojoEvidenceRefsJson: JSON.stringify(['dojo:evidence:pilot-session']),
        dojoDecisionDigest: 'sha256:pilotdecision',
        pilotLicenseSnapshotJson: JSON.stringify({ licenseClass: 'runtime', level: 2 }),
      }),
    }));
    expect(result).toMatchObject({
      displayCallsign: 'PILOT-1',
      dojoPilotLicenseRef: 'license:codex-runtime@2026-06-30',
      dojoProofRef: 'proof:pilot-session',
      dojoEvidenceRefs: ['dojo:evidence:pilot-session'],
      dojoDecisionDigest: 'sha256:pilotdecision',
      pilotLicenseSnapshot: { licenseClass: 'runtime', level: 2 },
    });
  });

  it('bounds Dojo pilot refs before writing agent sessions', async () => {
    const result = await createAgentSession('acme', 'project-1', { userId: 'user-1' }, {
      displayCallsign: 'PILOT-2',
      agentProvider: 'codex',
      agentRuntime: 'tmp-codex-cli',
      dojoPilotLicenseRef: { ref: 'license:bad-shape' },
      dojoProofRef: { ref: 'proof:bad-shape' },
      dojoEvidenceRefs: ['dojo:evidence:1', 'dojo:evidence:1', 'x'.repeat(256)],
      dojoDecisionDigest: 'x'.repeat(256),
    });

    expect(prisma.codeSiteAgentSession.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        dojoPilotLicenseRef: null,
        dojoProofRef: null,
        dojoEvidenceRefsJson: JSON.stringify(['dojo:evidence:1']),
        dojoDecisionDigest: null,
      }),
    }));
    expect(result).toMatchObject({
      displayCallsign: 'PILOT-2',
      dojoPilotLicenseRef: null,
      dojoProofRef: null,
      dojoEvidenceRefs: ['dojo:evidence:1'],
      dojoDecisionDigest: null,
    });
  });

  it('binds agent sessions, execution plans, and clearances to the owning user', async () => {
    await expect(createAgentSession('acme', 'project-1', { userId: 'user-1' }, {
      displayCallsign: 'PILOT-3',
      ownerUserId: 'user-2',
    })).rejects.toMatchObject({
      status: 403,
      code: 'agent_session_owner_forbidden',
    });

    await expect(createExecutionPlan('acme', 'project-1', {
      agentSessionId: 'agent-1',
      route: ['synthi/prisma/**'],
    }, { userId: 'user-2' })).rejects.toMatchObject({
      status: 403,
      code: 'execution_plan_agent_forbidden',
    });

    await expect(requestMutationLease('acme', 'plan-1', {
      allowedPaths: ['synthi/prisma/**'],
    }, { userId: 'user-2' })).rejects.toMatchObject({
      status: 403,
      code: 'mutation_lease_agent_forbidden',
    });
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
      'dojo_public_proof_capsule_required',
      'dojo_public_proof_key_required',
    ]));
    expect(prisma.codeSiteMutationLease.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'blocked',
        dojoProofRef: null,
        implementationStatusJson: expect.stringContaining('executable'),
      }),
    }));
  });

  it('blocks restricted airspace clearances with metadata-only Dojo proof refs', async () => {
    const lease = await requestMutationLease('acme', 'plan-1', {
      allowedPaths: ['synthi/prisma/**'],
      dojoProofRef: 'pcap-auth-schema',
      dojoLicenseRef: 'schema.level_2@2026-06-25',
      dojoEvidenceRefs: ['dojo:evidence:checkride-1'],
      dojoLedgerCheckpointHash: 'sha256:ledger',
      dojoDecisionDigest: 'sha256:decision',
      implementationStatus: { executable: true, productionRuntime: false },
    });

    expect(lease.status).toBe('blocked');
    expect(lease.dojoProofRef).toBe('pcap-auth-schema');
    expect(lease.policyDecision.reasonCodes).toEqual(expect.arrayContaining([
      'dojo_public_proof_verification_required',
      'dojo_public_proof_capsule_required',
      'dojo_public_proof_key_required',
    ]));
  });

  it('allows restricted airspace clearances with a verified Dojo proof capsule', async () => {
    const lease = await requestMutationLease('acme', 'plan-1', {
      allowedPaths: ['synthi/prisma/**'],
      ...signedDojoProofFixture(),
    });

    expect(lease.status).toBe('active');
    expect(lease.dojoProofRef).toBe('pcap-auth-schema');
    expect(lease.dojoDecisionDigest).toMatch(/^sha256:/);
    expect(lease.policyDecision.reasonCodes).toEqual(expect.arrayContaining([
      'dojo_clearance_proof_verified',
      'dojo_public_proof_signature_verified',
    ]));
  });

  it('allows the verified schema-first leader through restricted collision airspace', async () => {
    prisma.codeSiteExecutionPlan.findFirst.mockResolvedValue(executionPlanFixture(['synthi/prisma/**']));
    prisma.codeSiteExecutionPlan.findMany.mockResolvedValue([{
      ...executionPlanFixture(['synthi/prisma/**']),
      id: 'plan-api',
      displayCallsign: 'API-02',
      domain: 'backend',
      mission: 'Implement dependent API',
      status: 'holding',
    }]);

    const lease = await requestMutationLease('acme', 'plan-1', {
      allowedPaths: ['synthi/prisma/**'],
      ...signedDojoProofFixture(),
    });

    expect(lease.status).toBe('active');
    expect(lease.policyDecision.reasonCodes).toEqual(expect.arrayContaining([
      'schema_first_leader_clearance',
      'dojo_clearance_proof_verified',
      'dojo_public_proof_signature_verified',
    ]));
    expect(lease.policyDecision.reasonCodes).not.toContain('collision_avoidance_hold');
    expect(lease.lease.towerInstruction).toContain('Schema-first clearance issued');
  });

  it('holds high-risk collision clearances before issuing active mutation rights', async () => {
    prisma.codeSiteExecutionPlan.findFirst.mockResolvedValue({
      ...executionPlanFixture(['synthi/prisma/**']),
      displayCallsign: 'API-02',
      domain: 'backend',
      mission: 'Implement dependent API',
    });
    prisma.codeSiteExecutionPlan.findMany.mockResolvedValue([
      {
        ...executionPlanFixture(['synthi/prisma/**']),
        id: 'plan-schema-active',
        displayCallsign: 'SCHEMA-01',
        domain: 'schema',
        status: 'airborne',
      },
    ]);

    const lease = await requestMutationLease('acme', 'plan-1', {
      allowedPaths: ['synthi/prisma/**'],
      ...signedDojoProofFixture(),
    });

    expect(lease.status).toBe('holding');
    expect(lease.policyDecision.decision).toBe('hold');
    expect(lease.policyDecision.reasonCodes).toEqual(expect.arrayContaining([
      'collision_avoidance_hold',
      'contract_collision',
      'schema_first_recommended',
    ]));
    expect(lease.lease.collisionAvoidance.risk).toEqual(expect.objectContaining({
      risk: 'contract_collision',
      severity: 'high',
      conflictZone: 'synthi/prisma/**',
      recommendedResolution: expect.objectContaining({ action: 'schema_first' }),
    }));
    const eventTypes = prisma.codeSiteEvent.create.mock.calls.map((call) => call[0].data.eventType);
    expect(eventTypes).toEqual(expect.arrayContaining(['holding_pattern', 'near_miss']));
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

  it('closes near-miss incidents as causal black-box replay packets', async () => {
    prisma.codeSiteEvent.findMany.mockResolvedValue([
      {
        id: 'evt-open',
        projectId: 'project-1',
        mutationLeaseId: 'lease-1',
        eventType: 'transaction_opened',
        displayCallsign: 'ATLAS-1',
        actorType: 'agent_session',
        actorId: 'agent-1',
        detailsJson: JSON.stringify({ transactionId: 'txn-1', baseSnapshot: 'repo@sha256:base' }),
        evidenceRefsJson: JSON.stringify(['ev:snapshot']),
        logicalTime: 1,
        createdAt: new Date('2026-06-29T23:00:00.000Z'),
      },
      {
        id: 'evt-clearance',
        projectId: 'project-1',
        mutationLeaseId: 'lease-1',
        eventType: 'clearance_issued',
        displayCallsign: 'ATLAS-1',
        actorType: 'policy_engine',
        actorId: 'decision-1',
        detailsJson: JSON.stringify({ mutationLeaseId: 'lease-1', policyDecisionId: 'decision-1' }),
        evidenceRefsJson: JSON.stringify(['ev:clearance']),
        logicalTime: 2,
        createdAt: new Date('2026-06-29T23:01:00.000Z'),
      },
      {
        id: 'evt-attempt',
        projectId: 'project-1',
        mutationLeaseId: 'lease-1',
        eventType: 'write_attempted',
        displayCallsign: 'ATLAS-1',
        actorType: 'transaction',
        actorId: 'txn-1',
        detailsJson: JSON.stringify({ transactionId: 'txn-1', path: 'synthi/prisma/schema.prisma', tool: 'file_write' }),
        evidenceRefsJson: JSON.stringify(['ev:attempt']),
        logicalTime: 3,
        createdAt: new Date('2026-06-29T23:02:00.000Z'),
      },
      {
        id: 'evt-denied',
        projectId: 'project-1',
        mutationLeaseId: 'lease-1',
        eventType: 'write_denied',
        displayCallsign: 'ATLAS-1',
        actorType: 'policy_engine',
        actorId: 'decision-2',
        detailsJson: JSON.stringify({
          transactionId: 'txn-1',
          path: 'synthi/prisma/schema.prisma',
          policyDecisionId: 'decision-2',
          reasonCodes: ['entered_no_fly_zone'],
        }),
        evidenceRefsJson: JSON.stringify(['ev:denied']),
        logicalTime: 4,
        createdAt: new Date('2026-06-29T23:03:00.000Z'),
      },
      {
        id: 'evt-inspection',
        projectId: 'project-1',
        mutationLeaseId: null,
        eventType: 'inspection_result',
        displayCallsign: 'ATLAS-1',
        actorType: 'inspection_run',
        actorId: 'inspection-1',
        detailsJson: JSON.stringify({ changedPaths: ['synthi/prisma/schema.prisma'], inspectionEvidenceRefs: ['ev:inspection'] }),
        evidenceRefsJson: JSON.stringify(['ev:inspection']),
        logicalTime: 5,
        createdAt: new Date('2026-06-29T23:04:00.000Z'),
      },
      {
        id: 'evt-near',
        projectId: 'project-1',
        mutationLeaseId: 'lease-1',
        eventType: 'near_miss',
        displayCallsign: 'ATLAS-1',
        actorType: 'policy_engine',
        actorId: 'decision-3',
        detailsJson: JSON.stringify({ affectedZones: ['synthi/prisma/**'], prevented: true }),
        evidenceRefsJson: JSON.stringify(['ev:near-miss']),
        logicalTime: 6,
        createdAt: new Date('2026-06-29T23:05:00.000Z'),
      },
    ]);

    const incident = await createIncident('acme', 'project-1', {
      category: 'near_miss',
      severity: 'warning',
      summary: 'Schema write prevented before landing.',
      displayCallsign: 'ATLAS-1',
      participants: ['ATLAS-1'],
      affectedZones: ['synthi/prisma/**'],
      timelineEventRefs: ['evt-open', 'evt-clearance', 'evt-attempt', 'evt-denied', 'evt-inspection', 'evt-near'],
      evidenceRefs: ['collision:evidence'],
      policyDelta: { rule: 'schema_first_for_auth' },
    });
    const replay = incident.incidentReplay;
    const replayTypes = replay.causalEvents.map((event) => event.type);

    expect(incident.category).toBe('near_miss');
    expect(replay.schemaVersion).toBe('synthi.codesite.incidentReplay.v1');
    expect(replayTypes).toEqual(expect.arrayContaining([
      'transaction.opened',
      'clearance.issued',
      'write.attempted',
      'write.denied',
      'inspection.result',
      'near_miss.detected',
      'policy_delta.proposed',
    ]));
    expect(replay.eventRefs).toEqual(expect.arrayContaining(['evt-open', 'evt-denied', 'evt-near']));
    expect(replay.evidenceRefs).toEqual(expect.arrayContaining(['collision:evidence', 'ev:denied', 'ev:inspection']));
    expect(replay.routeContext.affectedZones).toEqual(['synthi/prisma/**']);
    expect(replay.completeness.totalEvents).toBeGreaterThanOrEqual(7);
    expect(replay.completeness).toMatchObject({
      presentEventTypes: expect.arrayContaining(['write.denied', 'near_miss.detected']),
      missingEventTypes: expect.arrayContaining(['shadow.run']),
    });
    expect(incident.timelineEventRefs).toEqual(expect.arrayContaining(['evt-open', 'evt-denied', 'evt-near']));
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

  it('blocks serializable validation when repo read snapshot evidence is skipped', async () => {
    prisma.codeSiteMutationTransaction.findFirst.mockResolvedValue({
      ...transactionFixture(),
      readSetJson: JSON.stringify(['synthi/prisma/schema.prisma']),
      observedReadSetJson: JSON.stringify(['synthi/prisma/schema.prisma']),
      baseSnapshotEvidenceJson: null,
    });
    prisma.codeSiteEvent.findMany.mockResolvedValue([]);

    const result = await validateTransaction('acme', 'txn-1');

    expect(result.decision.ok).toBe(false);
    expect(result.decision.reasonCodes).toEqual(expect.arrayContaining([
      'repo_snapshot_required_for_serializable',
      'repo_snapshot_read_set_coverage_required',
    ]));
    expect(result.decision.repoSnapshot.missingReadSet).toEqual(['synthi/prisma/schema.prisma']);
    expect(prisma.codeSiteMutationTransaction.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'txn-1' },
      data: expect.objectContaining({ status: 'blocked' }),
    }));
  });

  it('blocks serializable validation when snapshot evidence misses observed or semantic reads', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codesite-control-snapshot-coverage-'));
    await fs.mkdir(path.join(root, 'synthi', 'prisma'), { recursive: true });
    await fs.writeFile(path.join(root, 'synthi', 'prisma', 'schema.prisma'), 'model User { id String @id }\n', 'utf8');
    const snapshot = await buildReadSnapshotEvidence(['synthi/prisma/schema.prisma'], { repoRoot: root });
    prisma.codeSiteMutationTransaction.findFirst.mockResolvedValue({
      ...transactionFixture(),
      baseSnapshot: snapshot.snapshotDigest,
      baseSnapshotEvidenceJson: JSON.stringify(snapshot),
      readSetJson: JSON.stringify(['synthi/prisma/schema.prisma']),
      observedReadSetJson: JSON.stringify(['synthi/prisma/schema.prisma', 'openapi/auth.yaml']),
      semanticDependencyRefsJson: JSON.stringify([{ path: 'packages/schemas/**' }]),
    });
    prisma.codeSiteEvent.findMany.mockResolvedValue([]);

    const result = await validateTransaction('acme', 'txn-1');

    expect(result.decision.ok).toBe(false);
    expect(result.decision.reasonCodes).toContain('repo_snapshot_read_set_coverage_required');
    expect(result.decision.repoSnapshot.reasonCodes).toContain('repo_snapshot_read_set_coverage_required');
    expect(result.decision.repoSnapshot.missingReadSet).toEqual([
      'openapi/auth.yaml',
      'packages/schemas/**',
    ]);
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

  it('invalidates versioned semantic assumptions when a write changes the depended contract', async () => {
    const activeAssumption = {
      id: 'asm-signup-v1',
      projectId: 'project-1',
      ownerSessionId: 'agent-2',
      displayCallsign: 'CLAUDE-17',
      assumptionKey: 'auth.signup.schema.v1',
      dependsOnJson: JSON.stringify([{ ref: 'auth.signup.schema', version: 'v1' }]),
      usedByJson: JSON.stringify(['components/auth/SignupForm.tsx']),
      status: 'active',
      invalidatedBy: null,
      invalidatedAt: null,
      createdAt: new Date('2026-06-29T23:00:00.000Z'),
    };
    prisma.codeSiteAssumptionLease.findMany.mockResolvedValue([activeAssumption]);
    prisma.codeSiteAssumptionLease.update.mockImplementation(async ({ data }) => ({
      ...activeAssumption,
      ...data,
    }));

    const result = await recordTransactionWrite('acme', 'txn-1', {
      path: 'synthi/prisma/schema.prisma',
      semanticRefs: [{ ref: 'auth.signup.schema', version: 'v2' }],
    });

    expect(result.ok).toBe(true);
    expect(result.invalidatedAssumptions).toEqual([
      expect.objectContaining({
        id: 'asm-signup-v1',
        status: 'invalidated',
        invalidatedBy: 'ATLAS-1',
      }),
    ]);
    expect(prisma.codeSiteAssumptionLease.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'asm-signup-v1' },
      data: expect.objectContaining({
        status: 'invalidated',
        invalidatedBy: 'ATLAS-1',
      }),
    }));
    expect(prisma.codeSiteEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: 'assumption_invalidated',
        detailsJson: expect.stringContaining('auth.signup.schema'),
      }),
    }));
  });

  it('does not invalidate an assumption when writing a declared consumer path', async () => {
    const activeAssumption = {
      id: 'asm-consumer',
      projectId: 'project-1',
      ownerSessionId: 'agent-1',
      displayCallsign: 'ATLAS-1',
      assumptionKey: 'auth.signup.schema.v2',
      dependsOnJson: JSON.stringify([{ ref: 'auth.signup.schema', version: 'v2' }]),
      usedByJson: JSON.stringify(['synthi/prisma/schema.prisma']),
      status: 'active',
      invalidatedBy: null,
      invalidatedAt: null,
      createdAt: new Date('2026-06-29T23:00:00.000Z'),
    };
    prisma.codeSiteAssumptionLease.findMany.mockResolvedValue([activeAssumption]);

    const result = await recordTransactionWrite('acme', 'txn-1', {
      path: 'synthi/prisma/schema.prisma',
    });

    expect(result.ok).toBe(true);
    expect(result.invalidatedAssumptions).toEqual([]);
    expect(prisma.codeSiteAssumptionLease.update).not.toHaveBeenCalled();
    expect(prisma.codeSiteEvent.create).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: 'assumption_invalidated',
      }),
    }));
  });

  it('blocks further writes when the transaction has invalidated assumptions', async () => {
    const staleAssumption = {
      id: 'asm-stale',
      projectId: 'project-1',
      ownerSessionId: 'agent-1',
      displayCallsign: 'ATLAS-1',
      assumptionKey: 'auth.signup.schema.v1',
      dependsOnJson: JSON.stringify([{ ref: 'auth.signup.schema', version: 'v1' }]),
      usedByJson: JSON.stringify(['components/auth/SignupForm.tsx']),
      status: 'invalidated',
      invalidatedBy: 'SCHEMA-01',
      invalidatedAt: new Date('2026-06-29T23:03:00.000Z'),
      createdAt: new Date('2026-06-29T23:00:00.000Z'),
    };
    prisma.codeSiteMutationTransaction.findFirst.mockResolvedValue({
      ...transactionFixture(),
      assumptionRefsJson: JSON.stringify(['asm-stale']),
    });
    prisma.codeSiteAssumptionLease.findMany.mockResolvedValue([staleAssumption]);

    const result = await recordTransactionWrite('acme', 'txn-1', {
      path: 'synthi/prisma/schema.prisma',
    });

    expect(result.ok).toBe(false);
    expect(result.policyDecision.decision).toBe('block');
    expect(result.policyDecision.reasonCodes).toEqual(expect.arrayContaining([
      'assumption_invalidated_write_blocked',
      'rebase_required',
    ]));
    expect(prisma.codeSiteMutationTransaction.update).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        observedWriteSetJson: expect.any(String),
      }),
    }));
  });

  it('rejects write recording after a transaction is no longer open', async () => {
    prisma.codeSiteMutationTransaction.findFirst.mockResolvedValue({
      ...transactionFixture(),
      status: 'validated',
      closedAt: new Date('2026-06-29T23:04:00.000Z'),
    });

    await expect(recordTransactionWrite('acme', 'txn-1', {
      path: 'synthi/prisma/schema.prisma',
    })).rejects.toMatchObject({
      code: 'transaction_not_open',
      status: 400,
      detail: expect.objectContaining({
        transactionId: 'txn-1',
        status: 'validated',
      }),
    });
    expect(prisma.codeSiteMutationTransaction.update).not.toHaveBeenCalled();
    expect(prisma.codeSiteEvent.create).not.toHaveBeenCalled();
  });

  it('rejects transaction operations from a non-owner workspace actor', async () => {
    await expect(recordTransactionWrite('acme', 'txn-1', {
      path: 'synthi/prisma/schema.prisma',
    }, {
      userId: 'user-2',
      email: 'other@example.test',
    })).rejects.toMatchObject({
      code: 'transaction_actor_mismatch',
      status: 403,
      detail: expect.objectContaining({
        transactionId: 'txn-1',
        agentSessionId: 'agent-1',
        actorUserId: 'user-2',
      }),
    });
    expect(prisma.codeSiteMutationTransaction.update).not.toHaveBeenCalled();
    expect(prisma.codeSiteEvent.create).not.toHaveBeenCalled();
  });

  it('rejects transaction opening from a non-owner workspace actor', async () => {
    await expect(openTransaction('acme', 'lease-1', {}, {
      userId: 'user-2',
      email: 'other@example.test',
    })).rejects.toMatchObject({
      code: 'mutation_lease_actor_mismatch',
      status: 403,
      detail: expect.objectContaining({
        mutationLeaseId: 'lease-1',
        agentSessionId: 'agent-1',
        actorUserId: 'user-2',
      }),
    });
    expect(prisma.codeSiteMutationTransaction.create).not.toHaveBeenCalled();
    expect(prisma.codeSiteMutationTransaction.update).not.toHaveBeenCalled();
  });

  it('rejects non-serializable transaction isolation requests', async () => {
    await expect(openTransaction('acme', 'lease-1', {
      isolation: 'read_committed',
    })).rejects.toMatchObject({
      code: 'unsupported_transaction_isolation',
      status: 400,
      detail: {
        requestedIsolation: 'read_committed',
        supportedIsolation: 'serializable',
      },
    });
    expect(prisma.codeSiteMutationTransaction.create).not.toHaveBeenCalled();
  });

  it.each(['', false, 0])('rejects invalid explicit transaction isolation value %j', async (isolation) => {
    await expect(openTransaction('acme', 'lease-1', {
      isolation,
    })).rejects.toMatchObject({
      code: 'unsupported_transaction_isolation',
      status: 400,
      detail: {
        requestedIsolation: isolation,
        supportedIsolation: 'serializable',
      },
    });
    expect(prisma.codeSiteMutationTransaction.create).not.toHaveBeenCalled();
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
    prisma.codeSiteMutationTransaction.findFirst.mockResolvedValue({
      ...transactionFixture(),
      readSetJson: JSON.stringify(['synthi/prisma/schema.prisma']),
      observedReadSetJson: JSON.stringify(['synthi/prisma/schema.prisma']),
    });
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

  it('blocks unmanaged CodeSiteFS preflight writes when no active clearance covers the path', async () => {
    prisma.codeSiteMutationLease.findMany.mockResolvedValue([]);

    const result = await preflightCodeSiteFsWrite('acme', 'project-1', {
      path: 'backend/collab-server/permissionMiddleware.js',
      source: 'runtime_pod_terminal',
      tool: 'terminal_exec',
      processAncestry: ['runtime-pod', 'bash'],
      evidenceRefs: ['runtime:event:terminal-write-1'],
    }, { userId: 'user-1' });

    expect(result).toMatchObject({
      ok: false,
      disposition: 'write_denied',
      path: 'backend/collab-server/permissionMiddleware.js',
      reasonCodes: ['active_clearance_required'],
      matchedLease: null,
      policyDecision: {
        decision: 'block',
        reasonCodes: ['active_clearance_required'],
      },
    });
    expect(prisma.codeSitePolicyDecision.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        mutationLeaseId: null,
        decision: 'block',
        inputDigest: expect.any(String),
        decisionJson: expect.stringContaining('runtime_pod_terminal'),
      }),
    }));
    expect(prisma.codeSiteEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: 'write_denied',
        actorType: 'codesitefs',
        evidenceRefsJson: JSON.stringify(['runtime:event:terminal-write-1']),
        detailsJson: expect.stringContaining('active_clearance_required'),
      }),
    }));
  });

  it('allows CodeSiteFS preflight writes when an active lease matches path and tool', async () => {
    prisma.codeSiteMutationLease.findMany.mockResolvedValue([{
      id: 'lease-terminal-1',
      projectId: 'project-1',
      executionPlanId: 'plan-1',
      agentSessionId: 'agent-1',
      displayCallsign: 'RUNTIME-1',
      status: 'active',
      leaseJson: JSON.stringify({
        allowedPaths: ['backend/collab-server/**'],
        allowedTools: ['terminal_exec'],
      }),
      issuedAt: new Date('2026-06-29T23:00:00.000Z'),
      expiresAt: null,
      revokedAt: null,
      agentSession: {
        id: 'agent-1',
        projectId: 'project-1',
        ownerUserId: 'user-1',
        displayCallsign: 'RUNTIME-1',
      },
    }]);

    const result = await preflightCodeSiteFsWrite('acme', 'project-1', {
      path: 'backend/collab-server/terminalService.js',
      source: 'runtime_pod_terminal',
      tool: 'terminal_exec',
    }, { userId: 'user-1' });

    expect(result).toMatchObject({
      ok: true,
      disposition: 'write_allowed',
      path: 'backend/collab-server/terminalService.js',
      reasonCodes: ['inside_clearance_route'],
      matchedLease: {
        id: 'lease-terminal-1',
        displayCallsign: 'RUNTIME-1',
      },
      policyDecision: {
        decision: 'allow',
        mutationLeaseId: 'lease-terminal-1',
      },
    });
    expect(prisma.codeSiteEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        mutationLeaseId: 'lease-terminal-1',
        eventType: 'write_allowed',
        actorType: 'codesitefs',
        detailsJson: expect.stringContaining('inside_clearance_route'),
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

  it('summarizes documents and inbox payloads in project-wide snapshots', async () => {
    prisma.codeSiteProject.findFirst.mockResolvedValueOnce({
      id: 'project-1',
      workspaceSlug: 'acme',
      title: 'Signup',
      request: 'Build signup',
      status: 'active',
      zonePolicyJson: JSON.stringify({ zones: [] }),
      controlPlanJson: JSON.stringify({}),
      createdAt: new Date('2026-06-29T23:00:00.000Z'),
      updatedAt: new Date('2026-06-29T23:00:00.000Z'),
      agentSessions: [],
      executionPlans: [],
      mutationLeases: [],
      mutationTxns: [],
      assumptions: [],
      policyDecisions: [],
      events: [],
      incidents: [],
      inspectionRuns: [],
      proofBundles: [],
      lineProvenance: [],
      documents: [{
        id: 'doc-private',
        projectId: 'project-1',
        kind: 'rfi',
        status: 'open',
        title: 'Private RFI',
        bodyJson: JSON.stringify({ question: 'private payload' }),
        blocking: true,
        createdAt: new Date('2026-06-29T23:04:00.000Z'),
        resolvedAt: null,
      }],
      counterfactualRuns: [],
      policyDeltas: [],
      inboxItems: [{
        id: 'inbox-private',
        projectId: 'project-1',
        agentSessionId: 'agent-2',
        recipientUserId: 'user-2',
        eventId: 'evt-private',
        documentId: 'doc-private',
        kind: 'rfi',
        requiresResponse: true,
        status: 'pending',
        redactedPayloadJson: JSON.stringify({ body: { question: 'recipient-only' } }),
        createdAt: new Date('2026-06-29T23:04:00.000Z'),
        acknowledgedAt: null,
      }],
    });

    const project = await getProject('acme', 'project-1');

    expect(project.documents[0]).toMatchObject({
      id: 'doc-private',
      title: 'Private RFI',
      blocking: true,
    });
    expect(project.documents[0]).not.toHaveProperty('body');
    expect(project.inboxItems[0]).toMatchObject({
      id: 'inbox-private',
      agentSessionId: 'agent-2',
      eventId: 'evt-private',
      payloadAvailable: true,
    });
    expect(project.inboxItems[0]).not.toHaveProperty('redactedPayload');
    expect(project.inboxItems[0]).not.toHaveProperty('recipientUserId');
  });

  it('keeps proof bundle commit trailers complete in project snapshots', async () => {
    const transaction = transactionFixture();
    prisma.codeSiteProject.findFirst.mockResolvedValueOnce({
      id: 'project-1',
      workspaceSlug: 'acme',
      title: 'Signup',
      request: 'Build signup',
      status: 'active',
      zonePolicyJson: JSON.stringify({ zones: [] }),
      controlPlanJson: JSON.stringify({}),
      createdAt: new Date('2026-06-29T23:00:00.000Z'),
      updatedAt: new Date('2026-06-29T23:00:00.000Z'),
      agentSessions: [],
      executionPlans: [],
      mutationLeases: [transaction.mutationLease],
      mutationTxns: [transaction],
      assumptions: [],
      policyDecisions: [],
      events: [],
      incidents: [],
      inspectionRuns: [{
        id: 'inspection-1',
        projectId: 'project-1',
        executionPlanId: 'plan-1',
        displayCallsign: 'ATLAS-1',
        status: 'completed',
        changedPathsJson: JSON.stringify(['synthi/prisma/schema.prisma']),
        inspectionSignalsJson: JSON.stringify([]),
        evidenceRefsJson: JSON.stringify(['runtime:event:inspection-1']),
        requestedAt: new Date('2026-06-29T23:02:00.000Z'),
        completedAt: new Date('2026-06-29T23:03:00.000Z'),
      }],
      proofBundles: [{
        id: 'proof-1',
        projectId: 'project-1',
        transactionId: 'txn-1',
        commitSha: null,
        readSetDigest: 'sha256:read',
        writeSetDigest: 'sha256:write',
        invariantsJson: JSON.stringify(['clearance.diff.inside_route']),
        evidenceRefsJson: JSON.stringify(['runtime:event:inspection-1']),
        dojoEvidenceRefsJson: JSON.stringify([]),
        repoStateJson: JSON.stringify(repoStateFixture()),
        incidentReplayDigest: 'sha256:incident',
        bundleDigest: 'sha256:bundle',
        createdAt: new Date('2026-06-29T23:04:00.000Z'),
      }],
      lineProvenance: [],
      documents: [],
      counterfactualRuns: [],
      policyDeltas: [],
      inboxItems: [],
    });

    const project = await getProject('acme', 'project-1');

    expect(project.proofBundles[0].trailers).toMatchObject({
      'CodeSite-Project': 'project-1',
      'CodeSite-Flight': 'ATLAS-1',
      'CodeSite-Clearance': 'lease-1',
      'CodeSite-Landing': 'completed',
      'CodeSite-Transaction': 'txn-1',
    });
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
        databaseUrl: 'DATABASE_URL=postgres://user:pass@localhost:5432/app',
        bearerHeader: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature',
        cliHistory: 'codex run --with-env DATABASE_URL=postgres://user:pass@localhost/app',
        attachments: [{ name: 'raw-session.txt', content: 'local session memory' }],
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
    expect(savedBody.databaseUrl).toBe('[redacted]');
    expect(savedBody.bearerHeader).toBe('[redacted]');
    expect(savedBody.cliHistory).toBe('[redacted]');
    expect(savedBody.attachments).toBeUndefined();
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

  it('blocks tower documents when recipient policy opts out, mutes sender, or hides affected zones', async () => {
    prisma.codeSiteAgentSession.findMany.mockResolvedValueOnce([{
      id: 'agent-2',
      projectId: 'project-1',
      ownerUserId: 'user-2',
      displayCallsign: 'BETA-2',
      redactionPolicyJson: JSON.stringify({ acceptsTowerMessages: false }),
    }]);
    await expect(createDocument('acme', 'project-1', {
      kind: 'rfi',
      fromSessionId: 'agent-1',
      toSessionId: 'agent-2',
      executionPlanId: 'plan-1',
    }, { userId: 'user-1' })).rejects.toMatchObject({
      status: 400,
      code: 'document_recipient_policy_blocked',
      detail: {
        blockedRecipients: [expect.objectContaining({
          agentSessionId: 'agent-2',
          reasonCodes: ['recipient_opted_out'],
        })],
      },
    });

    prisma.codeSiteAgentSession.findMany.mockResolvedValueOnce([{
      id: 'agent-2',
      projectId: 'project-1',
      ownerUserId: 'user-2',
      displayCallsign: 'BETA-2',
      redactionPolicyJson: JSON.stringify({ mutedAgentSessionIds: ['agent-1'] }),
    }]);
    await expect(createDocument('acme', 'project-1', {
      kind: 'rfi',
      fromSessionId: 'agent-1',
      toSessionId: 'agent-2',
      executionPlanId: 'plan-1',
    }, { userId: 'user-1' })).rejects.toMatchObject({
      status: 400,
      code: 'document_recipient_policy_blocked',
      detail: {
        blockedRecipients: [expect.objectContaining({
          agentSessionId: 'agent-2',
          reasonCodes: ['sender_muted'],
        })],
      },
    });

    prisma.codeSiteAgentSession.findMany.mockResolvedValueOnce([{
      id: 'agent-2',
      projectId: 'project-1',
      ownerUserId: 'user-2',
      displayCallsign: 'BETA-2',
      redactionPolicyJson: JSON.stringify({ visibleZones: ['docs/**'] }),
    }]);
    await expect(createDocument('acme', 'project-1', {
      kind: 'rfi',
      fromSessionId: 'agent-1',
      toSessionId: 'agent-2',
      affectedZones: ['synthi/prisma/**'],
    }, { userId: 'user-1' })).rejects.toMatchObject({
      status: 400,
      code: 'document_recipient_policy_blocked',
      detail: {
        blockedRecipients: [expect.objectContaining({
          agentSessionId: 'agent-2',
          reasonCodes: ['affected_zone_not_visible'],
          affectedZones: ['synthi/prisma/**'],
          visibleZones: ['docs/**'],
        })],
      },
    });

    expect(prisma.codeSiteDocument.create).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ title: 'Blocked policy message' }),
    }));
  });

  it('blocks document delivery when a participant session owner is no longer a workspace member', async () => {
    prisma.workspace.findUnique.mockResolvedValueOnce({
      slug: 'acme',
      memberships: [{ userId: 'user-1', role: 'member' }],
    });

    await expect(createDocument('acme', 'project-1', {
      kind: 'rfi',
      fromSessionId: 'agent-1',
      toSessionId: 'agent-2',
      executionPlanId: 'plan-1',
    }, { userId: 'user-1' })).rejects.toMatchObject({
      status: 400,
      code: 'document_session_owner_not_workspace_member',
      detail: { userIds: ['user-2'] },
    });
  });

  it('applies recipient document kind and payload redaction policy before inbox delivery', async () => {
    prisma.codeSiteAgentSession.findMany.mockResolvedValueOnce([{
      id: 'agent-2',
      projectId: 'project-1',
      ownerUserId: 'user-2',
      displayCallsign: 'BETA-2',
      redactionPolicyJson: JSON.stringify({ allowedDocumentKinds: ['rfi'] }),
    }]);
    await expect(createDocument('acme', 'project-1', {
      kind: 'change_order',
      fromSessionId: 'agent-1',
      toSessionId: 'agent-2',
      executionPlanId: 'plan-1',
    }, { userId: 'user-1' })).rejects.toMatchObject({
      status: 400,
      code: 'document_recipient_policy_blocked',
      detail: {
        blockedRecipients: [expect.objectContaining({
          reasonCodes: ['document_kind_not_allowed'],
        })],
      },
    });

    prisma.codeSiteAgentSession.findMany.mockResolvedValueOnce([{
      id: 'agent-2',
      projectId: 'project-1',
      ownerUserId: 'user-2',
      displayCallsign: 'BETA-2',
      redactionPolicyJson: JSON.stringify({
        allowedDocumentKinds: ['rfi'],
        visibleZones: ['synthi/prisma/**'],
        allowAttachments: false,
        redactedFields: ['internalNotes'],
      }),
    }]);

    const result = await createDocument('acme', 'project-1', {
      kind: 'rfi',
      title: 'Schema RFI',
      fromSessionId: 'agent-1',
      toSessionId: 'agent-2',
      affectedZones: ['synthi/prisma/**'],
      body: {
        question: 'Can this migration land?',
        internalNotes: 'visible only to tower',
        attachments: [{ name: 'raw-plan.txt', content: 'local scratchpad' }],
        nested: {
          privatePrompt: 'raw prompt transcript',
        },
      },
    }, { userId: 'user-1' });
    const inboxCreate = prisma.codeSiteAgentInboxItem.create.mock.calls.at(-1)[0];
    const payload = JSON.parse(inboxCreate.data.redactedPayloadJson);

    expect(result.inboxItems).toHaveLength(1);
    expect(payload.body.question).toBe('Can this migration land?');
    expect(payload.body.internalNotes).toBe('[redacted]');
    expect(payload.body.attachments).toBeUndefined();
    expect(payload.body.nested.privatePrompt).toBe('[redacted]');
    expect(payload.redaction).toMatchObject({
      policyApplied: true,
      recipientSessionId: 'agent-2',
    });
  });

  it('rejects cross-agent documents without sender ownership or project references', async () => {
    await expect(createDocument('acme', 'project-1', {
      kind: 'rfi',
      toSessionId: 'agent-2',
      executionPlanId: 'plan-1',
    }, { userId: 'user-1' })).rejects.toMatchObject({
      status: 403,
      code: 'document_sender_session_required',
    });

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
    expect(result.proofBundle.trailers).toMatchObject({
      'CodeSite-Project': 'project-1',
      'CodeSite-Flight': 'ATLAS-1',
      'CodeSite-Clearance': 'lease-1',
      'CodeSite-Landing': 'completed',
      'CodeSite-Transaction': 'txn-1',
      'CodeSite-Lease': 'lease-1',
      'CodeSite-Read-Set': expect.stringMatching(/^sha256:/),
      'CodeSite-Write-Set': expect.stringMatching(/^sha256:/),
      'CodeSite-Black-Box': expect.stringMatching(/^sha256:/),
    });
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
        startLine: 12,
        endLine: 15,
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

  it('blocks proof-carrying commits when any write event lacks strict line provenance', async () => {
    prisma.codeSiteEvent.findMany.mockResolvedValue([
      {
        id: 'event-covered-write',
        eventType: 'write_allowed',
        actorId: 'txn-1',
        displayCallsign: 'ATLAS-1',
        createdAt: new Date('2026-06-29T23:01:00.000Z'),
        detailsJson: JSON.stringify({
          transactionId: 'txn-1',
          path: 'synthi/prisma/schema.prisma',
          lineProvenance: [{
            lineAnchor: 'synthi/prisma/schema.prisma#L12-L15',
            startLine: 12,
            endLine: 15,
            evidenceRefs: ['hunk:evidence'],
          }],
          evidenceRefs: ['write:evidence:covered'],
        }),
      },
      {
        id: 'event-uncovered-write',
        eventType: 'write_allowed',
        actorId: 'txn-1',
        displayCallsign: 'ATLAS-1',
        createdAt: new Date('2026-06-29T23:02:00.000Z'),
        detailsJson: JSON.stringify({
          transactionId: 'txn-1',
          path: 'synthi/prisma/schema.prisma',
          evidenceRefs: ['write:evidence:uncovered'],
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
    expect(result.decision.lineProvenance?.uncoveredWriteEvents).toEqual([expect.objectContaining({
      eventId: 'event-uncovered-write',
      path: 'synthi/prisma/schema.prisma',
      missingPathCoverage: true,
    })]);
    expect(prisma.codeSiteProofBundle.create).not.toHaveBeenCalled();
    expect(prisma.codeSiteLineProvenance.create).not.toHaveBeenCalled();
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
      startLine: 1,
      endLine: 3,
      displayCallsign: 'ATLAS-1',
      reasonRef: 'transaction:txn-1',
      evidenceRefsJson: JSON.stringify(['proof:proof-1']),
      dojoSourceRefsJson: JSON.stringify(['dojo:evidence:line-1']),
      proofBundleId: 'proof-1',
      processAncestryJson: JSON.stringify([]),
      promptSummary: 'CodeSite transaction commit',
      createdAt: new Date('2026-06-29T23:11:00.000Z'),
    }]);
    prisma.codeSiteInspectionRun.findMany.mockResolvedValue([{
      id: 'inspection-landing',
      projectId: 'project-1',
      executionPlanId: 'plan-1',
      displayCallsign: 'ATLAS-1',
      status: 'landed-with-punch',
      changedPathsJson: JSON.stringify(['synthi/prisma/schema.prisma']),
      inspectionSignalsJson: JSON.stringify([]),
      evidenceRefsJson: JSON.stringify(['inspection:landing']),
      requestedAt: new Date('2026-06-29T23:08:00.000Z'),
      completedAt: new Date('2026-06-29T23:09:00.000Z'),
    }]);

    const proof = await getProofBundle('acme', 'proof-1');

    expect(proof.bundleDigest).toBe('sha256:bundle');
    expect(proof.portableProofBundle).toMatchObject({
      schemaVersion: 'synthi.codesite.proofBundle.v1',
      projectId: 'project-1',
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
      landingStatus: 'landed-with-punch',
      readSetDigest: 'sha256:read',
      writeSetDigest: 'sha256:write',
      repoState: expect.objectContaining({ evidenceDigest: 'sha256:repo-state' }),
      lineProvenance: [expect.objectContaining({
        filePath: 'synthi/prisma/schema.prisma',
        startLine: 1,
        endLine: 3,
        reasonRef: 'transaction:txn-1',
        evidenceRefs: ['proof:proof-1'],
        dojoSourceRefs: ['dojo:evidence:line-1'],
      })],
    });
    expect(proof.portableProofBundle.portableDigest).toMatch(/^sha256:/);
  });

  it('looks up line provenance by line number and returns causal context', async () => {
    const transaction = transactionFixture();
    const proofBundle = {
      id: 'proof-1',
      projectId: 'project-1',
      transactionId: 'txn-1',
      commitSha: 'abc123',
      readSetDigest: 'sha256:read',
      writeSetDigest: 'sha256:write',
      invariantsJson: JSON.stringify(['clearance.diff.inside_route']),
      evidenceRefsJson: JSON.stringify(['test:checkout']),
      dojoEvidenceRefsJson: JSON.stringify([]),
      repoStateJson: JSON.stringify(null),
      incidentReplayDigest: 'sha256:incident',
      bundleDigest: 'sha256:bundle',
      createdAt: new Date('2026-06-29T23:10:00.000Z'),
    };
    prisma.codeSiteLineProvenance.findMany.mockResolvedValueOnce([
      {
        id: 'line-match',
        projectId: 'project-1',
        transactionId: 'txn-1',
        filePath: 'synthi/prisma/schema.prisma',
        lineAnchor: 'synthi/prisma/schema.prisma#L12-L15',
        startLine: 12,
        endLine: 15,
        displayCallsign: 'ATLAS-1',
        reasonRef: 'event:event-1',
        evidenceRefsJson: JSON.stringify(['hunk:evidence']),
        dojoSourceRefsJson: JSON.stringify([]),
        proofBundleId: 'proof-1',
        processAncestryJson: JSON.stringify(['mcp:synthi_codesite_apply_patch']),
        promptSummary: 'Add auth schema field',
        createdAt: new Date('2026-06-29T23:11:00.000Z'),
        transaction: {
          ...transaction,
          proofBundles: [proofBundle],
        },
      },
    ]).mockResolvedValueOnce([]);

    const rows = await getLineProvenance('acme', {
      projectId: 'project-1',
      filePath: 'synthi/prisma/schema.prisma',
      lineNumber: 13,
    });

    expect(prisma.codeSiteLineProvenance.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({
        projectId: 'project-1',
        filePath: 'synthi/prisma/schema.prisma',
        startLine: { lte: 13 },
        OR: [
          { endLine: { gte: 13 } },
          { endLine: null },
        ],
      }),
      include: expect.objectContaining({ transaction: expect.any(Object) }),
      take: 50,
    }));
    expect(prisma.codeSiteLineProvenance.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({
        projectId: 'project-1',
        filePath: 'synthi/prisma/schema.prisma',
        startLine: null,
      }),
      include: expect.objectContaining({ transaction: expect.any(Object) }),
      take: 200,
    }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'line-match',
      startLine: 12,
      endLine: 15,
      transaction: { id: 'txn-1', mutationLeaseId: 'lease-1' },
      mutationLease: { id: 'lease-1', displayCallsign: 'ATLAS-1' },
      agentSession: { id: 'agent-1', ownerUserId: 'user-1' },
      proofBundles: [expect.objectContaining({ id: 'proof-1', bundleDigest: 'sha256:bundle' })],
    });
  });

  it('records arbiter verdict events for counterfactual runs', async () => {
    prisma.codeSiteProject.findFirst.mockResolvedValue({
      id: 'project-1',
      workspaceSlug: 'acme',
      title: 'Counterfactual project',
      request: 'Choose safest route',
      status: 'active',
      zonePolicyJson: JSON.stringify({ zones: [] }),
      controlPlanJson: JSON.stringify({}),
      createdAt: new Date('2026-06-29T23:00:00.000Z'),
      updatedAt: new Date('2026-06-29T23:00:00.000Z'),
    });
    prisma.codeSiteCounterfactualRun.create.mockResolvedValue({
      id: 'cfr-1',
      projectId: 'project-1',
      shadowJobRef: 'shadow-job-1',
      baseSnapshot: 'repo@sha256:base',
      universesJson: JSON.stringify([{ strategy: 'schema-first' }]),
      arbiterVerdictJson: JSON.stringify({ selected: 'schema-first' }),
      userChoiceJson: JSON.stringify(null),
      laterManualEditsJson: JSON.stringify([]),
      validityStrength: 'simulated',
      evidenceRefsJson: JSON.stringify(['shadow:job:shadow-job-1']),
      createdAt: new Date('2026-06-29T23:12:00.000Z'),
    });
    prisma.codeSiteEvent.count.mockResolvedValue(7);

    const result = await createCounterfactualRun('acme', 'project-1', {
      shadowJobRef: 'shadow-job-1',
      baseSnapshot: 'repo@sha256:base',
      universes: [{ strategy: 'schema-first' }],
      arbiterVerdict: { selected: 'schema-first' },
      validityStrength: 'simulated',
      evidenceRefs: ['shadow:job:shadow-job-1'],
    });

    expect(result.id).toBe('cfr-1');
    expect(prisma.codeSiteEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: 'shadow_run',
        actorId: 'cfr-1',
      }),
    }));
    expect(prisma.codeSiteEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: 'arbiter_verdict',
        actorId: 'cfr-1',
        evidenceRefsJson: JSON.stringify(['shadow:job:shadow-job-1']),
        detailsJson: expect.stringContaining('schema-first'),
      }),
    }));
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
        event: expect.objectContaining({
          type: 'write.allowed',
          path: 'synthi/prisma/schema.prisma',
        }),
      }),
      expect.objectContaining({
        source: 'incident_record',
      }),
    ]));
    expect(replay.completeness.observedEventTypes).toEqual(expect.arrayContaining(['write.allowed']));
  });
});
