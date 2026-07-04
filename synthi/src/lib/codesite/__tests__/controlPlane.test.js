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
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    codeSiteProject: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    codeSiteProjectMember: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    codeSiteExecutionPlan: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
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
      update: vi.fn(),
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
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    codeSitePermit: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    codeSiteDocumentReview: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    codeSiteRouteRevision: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    codeSiteCounterfactualRun: {
      create: vi.fn(),
    },
    codeSitePolicyDelta: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    codeSiteMutationZone: {
      findMany: vi.fn(),
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
  abortTransaction,
  attachProofBundleCommit,
  commitTransaction,
  acknowledgeInboxItem,
  applyRouteRevision,
  createAgentSession,
  createCounterfactualRun,
  createExecutionPlan,
  createProject,
  createIncident,
  createDocument,
  createInspectionRun,
  createPermit,
  createPolicyDelta,
  dryRunTransactionWrites,
  getAgentInbox,
  getAgentManifest,
  getControlState,
  getEvents,
  getIncidentReplay,
  getLineProvenance,
  getProject,
  getProofBundle,
  getSourceStateSince,
  openTransaction,
  preflightCodeSiteFsWrite,
  getWorkspaceActiveState,
  proposeRouteRevision,
  promotePolicyDelta,
  recordTransactionRead,
  recordTransactionQuarantineEvent,
  recordTransactionWrite,
  requestMutationLease,
  reviewDocument,
  reviewRouteRevision,
  shadowMergeSimulate,
  updateZonePolicy,
  validateTransaction,
} from '../controlPlane.js';
import { CODESITE_MCP_TOOLS } from '../artifacts.js';
import { digest } from '../policy.js';
import { buildProofBundle, proofCommitTrailers } from '../proof.js';
import { buildReadSnapshotEvidence } from '../repoSnapshot.js';

async function withEnvCleared(keys, callback) {
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

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

function repoStateFixture(ranges = [{
  filePath: 'synthi/prisma/schema.prisma',
  lineAnchor: 'synthi/prisma/schema.prisma#L12-L15',
  startLine: 12,
  endLine: 15,
  source: 'head_commit_diff',
}], overrides = {}) {
  const workspaceSlug = overrides.workspaceSlug || 'acme';
  const transactionId = overrides.transactionId || 'txn-1';
  const repoIdentity = {
    schemaVersion: 'synthi.codesite.repoIdentity.v1',
    workspaceSlug,
    transactionId,
    repoRootDigest: 'sha256:repo-root',
    gitTopLevelDigest: 'sha256:repo-root',
    gitCommonDirDigest: 'sha256:git-common-dir',
    gitTopLevelMatchesRepoRoot: true,
    source: 'collab-server',
  };
  repoIdentity.identityDigest = digest(repoIdentity);
  const repoState = {
    schemaVersion: 'synthi.codesite.repoStateEvidence.v1',
    workspaceSlug,
    transactionId,
    baseSnapshot: overrides.baseSnapshot || 'base',
    repoIdentity,
    gitHead: 'abc123',
    stagedDiffDigest: 'sha256:staged',
    worktreeDiffDigest: 'sha256:worktree',
    headDiffDigest: 'sha256:head-diff',
    changedLineRanges: ranges,
    writeFileDigests: [{
      path: 'synthi/prisma/schema.prisma',
      digest: 'sha256:file',
      size: 120,
      exists: true,
      changedLineRanges: ranges,
    }],
    generatedAt: '2026-06-29T23:02:30.000Z',
    source: 'collab-server',
  };
  repoState.evidenceDigest = digest(repoState);
  return repoState;
}

function passedLandingInspection(overrides = {}) {
  return {
    id: overrides.id || 'inspection-1',
    projectId: overrides.projectId || 'project-1',
    executionPlanId: overrides.executionPlanId || 'plan-1',
    displayCallsign: overrides.displayCallsign || 'ATLAS-1',
    status: overrides.status || 'completed',
    changedPathsJson: JSON.stringify(overrides.changedPaths || ['synthi/prisma/**']),
    inspectionSignalsJson: JSON.stringify(overrides.signals || [
      { key: 'typecheck', status: 'passed', evidenceRefs: ['runtime:event:typecheck-1'] },
      { key: 'tests', status: 'passed', evidenceRefs: ['runtime:event:tests-1'] },
    ]),
    evidenceRefsJson: JSON.stringify(overrides.evidenceRefs || ['runtime:event:inspection-1']),
    requestedAt: overrides.requestedAt || new Date('2026-06-29T23:02:00.000Z'),
    completedAt: overrides.completedAt || new Date('2026-06-29T23:03:00.000Z'),
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
      pilotLicenseSnapshotJson: JSON.stringify({
        level: 2,
        repoScope: 'acme',
        authorizedAirspace: ['synthi/prisma/**'],
        requiredRadar: ['api_contract', 'security'],
      }),
    },
  };
}

function approvedPermitFixture(overrides = {}) {
  const scope = {
    executionPlanId: 'plan-1',
    allowedPaths: ['synthi/prisma/**'],
    blockedPaths: [],
    affectedZones: ['schema'],
    contractRefs: ['auth.signup.v2'],
    ...(overrides.scope || {}),
  };
  return {
    id: overrides.id || 'permit-approved',
    projectId: 'project-1',
    executionPlanId: overrides.executionPlanId ?? 'plan-1',
    mutationLeaseId: overrides.mutationLeaseId ?? null,
    documentId: overrides.documentId ?? 'doc-1',
    permitType: overrides.permitType || 'schema_work_permit',
    status: overrides.status || 'issued',
    title: overrides.title || 'Schema work permit',
    scopeJson: JSON.stringify(scope),
    approvalJson: JSON.stringify(overrides.approval || { approved: true, approvedByUserId: 'reviewer-1' }),
    evidenceRefsJson: JSON.stringify(overrides.evidenceRefs || ['evidence:permit-review']),
    issuedByUserId: overrides.issuedByUserId || 'reviewer-1',
    issuedAt: new Date('2026-06-29T23:04:30.000Z'),
    expiresAt: null,
    closedAt: null,
    ...overrides,
    scopeJson: JSON.stringify(scope),
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
    expires_at: '2026-08-01T00:00:00.000Z',
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
    prisma.codeSiteProjectMember.findUnique.mockResolvedValue(null);
    prisma.codeSiteProjectMember.findFirst.mockImplementation(async ({ where } = {}) => {
      const userId = where?.userId;
      if (!['user-1', 'user-2', 'reviewer-1'].includes(userId)) return null;
      return {
        id: `member-${userId}`,
        projectId: where?.projectId || 'project-1',
        workspaceSlug: 'acme',
        userId,
        role: userId === 'reviewer-1' ? 'admin' : 'agent',
        permissionsJson: JSON.stringify(['project:read', 'project:write', 'project:members:manage', 'mayday:resume']),
        redactionPolicyJson: null,
        participationStatus: 'enabled',
        revokedAt: null,
        source: 'test',
        createdAt: new Date('2026-06-29T23:00:00.000Z'),
        updatedAt: new Date('2026-06-29T23:00:00.000Z'),
      };
    });
    prisma.codeSiteProjectMember.findMany.mockResolvedValue([]);
    prisma.codeSiteProjectMember.upsert.mockImplementation(async ({ create, update }) => ({
      id: 'member-1',
      createdAt: new Date('2026-06-29T23:00:00.000Z'),
      updatedAt: new Date('2026-06-29T23:00:00.000Z'),
      ...(create || {}),
      ...(update || {}),
    }));
    prisma.codeSiteProjectMember.update.mockImplementation(async ({ where, data }) => ({
      id: 'member-1',
      projectId: where.projectId_userId?.projectId || 'project-1',
      workspaceSlug: 'acme',
      userId: where.projectId_userId?.userId || 'user-2',
      role: 'agent',
      permissionsJson: JSON.stringify(['project:read']),
      redactionPolicyJson: null,
      participationStatus: 'enabled',
      source: 'test',
      createdAt: new Date('2026-06-29T23:00:00.000Z'),
      updatedAt: new Date('2026-06-29T23:00:00.000Z'),
      ...data,
    }));
    const transaction = transactionFixture();
    prisma.codeSiteMutationTransaction.findFirst.mockResolvedValue(transaction);
    prisma.codeSiteMutationTransaction.update.mockImplementation(async ({ data }) => ({
      ...transaction,
      ...data,
    }));
    prisma.codeSiteMutationTransaction.updateMany.mockResolvedValue({ count: 1 });
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
      createdByUserId: 'user-1',
      createdAt: new Date('2026-06-29T23:00:00.000Z'),
      updatedAt: new Date('2026-06-29T23:00:00.000Z'),
      members: [
        {
          id: 'member-owner',
          projectId: 'project-1',
          workspaceSlug: 'acme',
          userId: 'user-1',
          role: 'owner',
          permissionsJson: JSON.stringify(['project:read', 'project:write', 'project:members:manage', 'mayday:resume']),
          participationStatus: 'enabled',
          revokedAt: null,
        },
        {
          id: 'member-reviewer',
          projectId: 'project-1',
          workspaceSlug: 'acme',
          userId: 'reviewer-1',
          role: 'admin',
          permissionsJson: JSON.stringify(['project:read', 'project:write', 'project:members:manage', 'mayday:resume']),
          participationStatus: 'enabled',
          revokedAt: null,
        },
      ],
    });
    prisma.workspace.findUnique.mockResolvedValue({
      slug: 'acme',
      memberships: [
        { userId: 'user-1', role: 'member' },
        { userId: 'user-2', role: 'member' },
      ],
    });
    prisma.codeSiteMutationZone.upsert.mockResolvedValue({});
    prisma.codeSiteMutationZone.findMany.mockResolvedValue([]);
    prisma.codeSiteExecutionPlan.findFirst.mockResolvedValue(executionPlanFixture());
    prisma.codeSiteExecutionPlan.findMany.mockResolvedValue([]);
    prisma.codeSiteMutationTransaction.findMany.mockResolvedValue([]);
    prisma.codeSiteExecutionPlan.create.mockImplementation(async ({ data }) => ({
      id: `plan-${data.displayCallsign}`,
      filedAt: new Date('2026-06-29T23:01:00.000Z'),
      closedAt: null,
      ...data,
    }));
    prisma.codeSiteExecutionPlan.update.mockImplementation(async ({ where, data }) => ({
      id: where.id,
      projectId: 'project-1',
      agentSessionId: 'agent-1',
      displayCallsign: 'ATLAS-1',
      mission: 'Update schema',
      domain: 'schema',
      status: 'filed',
      routeJson: JSON.stringify(['synthi/prisma/**']),
      blockedZonesJson: JSON.stringify([]),
      abortJson: JSON.stringify([]),
      requestedToolsJson: JSON.stringify(['file_write']),
      estimatedDurationMs: null,
      filedAt: new Date('2026-06-29T22:59:00.000Z'),
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
    prisma.codeSiteDocument.findFirst.mockResolvedValue({
      id: 'doc-1',
      projectId: 'project-1',
      kind: 'change_order',
      status: 'pending_review',
      title: 'Route change',
      bodyJson: JSON.stringify({ summary: 'Route revision proposed' }),
      blocking: true,
      createdAt: new Date('2026-06-29T23:04:00.000Z'),
      resolvedAt: null,
      project: {
        id: 'project-1',
        workspaceSlug: 'acme',
        title: 'Signup',
        request: 'Build signup',
        status: 'active',
        createdByUserId: 'user-1',
        members: [
          {
            id: 'member-owner',
            projectId: 'project-1',
            workspaceSlug: 'acme',
            userId: 'user-1',
            role: 'owner',
            permissionsJson: JSON.stringify(['project:read', 'project:write']),
            participationStatus: 'enabled',
            revokedAt: null,
          },
        ],
        agentSessions: [],
      },
    });
    prisma.codeSiteDocument.findMany.mockResolvedValue([]);
    prisma.codeSiteDocument.update.mockImplementation(async ({ where, data }) => ({
      id: where.id,
      projectId: 'project-1',
      kind: 'change_order',
      status: 'pending_review',
      title: 'Route change',
      bodyJson: JSON.stringify({ summary: 'Route revision proposed' }),
      blocking: true,
      createdAt: new Date('2026-06-29T23:04:00.000Z'),
      resolvedAt: null,
      ...data,
    }));
    prisma.codeSitePermit.create.mockImplementation(async ({ data }) => ({
      id: 'permit-created',
      issuedAt: new Date('2026-06-29T23:04:30.000Z'),
      expiresAt: null,
      closedAt: null,
      ...data,
    }));
    prisma.codeSitePermit.findMany.mockResolvedValue([]);
    prisma.codeSiteDocumentReview.create.mockImplementation(async ({ data }) => ({
      id: 'review-created',
      requestedAt: new Date('2026-06-29T23:04:30.000Z'),
      reviewedAt: null,
      ...data,
    }));
    prisma.codeSiteDocumentReview.findMany.mockResolvedValue([]);
    prisma.codeSiteRouteRevision.create.mockImplementation(async ({ data }) => ({
      id: 'route-revision-created',
      createdAt: new Date('2026-06-29T23:05:00.000Z'),
      updatedAt: new Date('2026-06-29T23:05:00.000Z'),
      appliedAt: null,
      approvedByUserId: null,
      ...data,
    }));
    prisma.codeSiteRouteRevision.findMany.mockResolvedValue([]);
    prisma.codeSiteRouteRevision.findFirst.mockResolvedValue({
      id: 'route-revision-1',
      projectId: 'project-1',
      executionPlanId: 'plan-1',
      documentId: 'doc-1',
      status: 'approved',
      previousRouteJson: JSON.stringify(['synthi/prisma/**']),
      proposedRouteJson: JSON.stringify(['synthi/prisma/**', 'packages/schemas/**']),
      affectedLeasesJson: JSON.stringify([{ id: 'lease-1', status: 'active', displayCallsign: 'ATLAS-1' }]),
      approvalJson: JSON.stringify({ decision: 'approved', approved: true }),
      evidenceRefsJson: JSON.stringify(['evidence:route-review']),
      proposedByUserId: 'user-1',
      approvedByUserId: 'reviewer-1',
      appliedAt: null,
      createdAt: new Date('2026-06-29T23:05:00.000Z'),
      updatedAt: new Date('2026-06-29T23:05:00.000Z'),
      project: {
        id: 'project-1',
        workspaceSlug: 'acme',
        title: 'Signup',
        request: 'Build signup',
        status: 'active',
        createdByUserId: 'user-1',
        members: [
          {
            id: 'member-owner',
            projectId: 'project-1',
            workspaceSlug: 'acme',
            userId: 'user-1',
            role: 'owner',
            permissionsJson: JSON.stringify(['project:read', 'project:write']),
            participationStatus: 'enabled',
            revokedAt: null,
          },
        ],
        agentSessions: [],
      },
      executionPlan: executionPlanFixture(),
      document: {
        id: 'doc-1',
        projectId: 'project-1',
        kind: 'change_order',
        status: 'approved',
        title: 'Route change',
        bodyJson: JSON.stringify({ summary: 'Route revision approved' }),
        blocking: true,
        createdAt: new Date('2026-06-29T23:04:00.000Z'),
        resolvedAt: null,
      },
    });
    prisma.codeSiteRouteRevision.update.mockImplementation(async ({ where, data }) => ({
      id: where.id,
      projectId: 'project-1',
      executionPlanId: 'plan-1',
      documentId: 'doc-1',
      status: 'approved',
      previousRouteJson: JSON.stringify(['synthi/prisma/**']),
      proposedRouteJson: JSON.stringify(['synthi/prisma/**', 'packages/schemas/**']),
      affectedLeasesJson: JSON.stringify([{ id: 'lease-1', status: 'active', displayCallsign: 'ATLAS-1' }]),
      approvalJson: JSON.stringify({ decision: 'approved', approved: true }),
      evidenceRefsJson: JSON.stringify(['evidence:route-review']),
      proposedByUserId: 'user-1',
      approvedByUserId: 'reviewer-1',
      appliedAt: null,
      createdAt: new Date('2026-06-29T23:05:00.000Z'),
      updatedAt: new Date('2026-06-29T23:05:00.000Z'),
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
    let latestProofBundle = null;
    const defaultProofBundle = (id = 'proof-created') => ({
      id,
      projectId: 'project-1',
      transactionId: 'txn-1',
      commitSha: 'abc123',
      readSetDigest: 'sha256:read',
      writeSetDigest: 'sha256:write',
      invariantsJson: JSON.stringify(['clearance.diff.inside_route']),
      evidenceRefsJson: JSON.stringify(['runtime:event:inspection-1', 'codesite:transaction:txn-1', 'codesite:lease:lease-1']),
      dojoEvidenceRefsJson: JSON.stringify([]),
      repoStateJson: JSON.stringify(repoStateFixture()),
      incidentReplayDigest: null,
      landingStatus: null,
      bundleDigest: 'sha256:bundle',
      createdAt: new Date('2026-06-29T23:03:00.000Z'),
    });
    prisma.codeSiteProofBundle.create.mockImplementation(async ({ data }) => {
      latestProofBundle = {
        ...defaultProofBundle('proof-created'),
        ...data,
      };
      return latestProofBundle;
    });
    prisma.codeSiteProofBundle.update.mockImplementation(async ({ where, data }) => {
      latestProofBundle = {
        ...(latestProofBundle || defaultProofBundle(where.id)),
        id: where.id,
        ...data,
      };
      return latestProofBundle;
    });
    prisma.codeSiteLineProvenance.create.mockResolvedValue({ id: 'line-created' });
    prisma.codeSitePolicyDelta.create.mockImplementation(async ({ data }) => ({
      id: 'delta-created',
      createdAt: new Date('2026-06-29T23:13:00.000Z'),
      promotedAt: null,
      ...data,
    }));
    prisma.codeSitePolicyDelta.findFirst.mockResolvedValue(null);
    prisma.codeSitePolicyDelta.findMany.mockResolvedValue([]);
    prisma.codeSitePolicyDelta.update.mockImplementation(async ({ data }) => ({
      id: 'delta-updated',
      projectId: 'project-1',
      learnedFromIncidentsJson: JSON.stringify([]),
      affectedZoneKey: null,
      ruleCandidateJson: JSON.stringify({}),
      triggerConditionsJson: JSON.stringify([]),
      expectedRiskReduction: 0.3,
      confidence: 0.9,
      replayRefsJson: JSON.stringify([]),
      createdAt: new Date('2026-06-29T23:13:00.000Z'),
      promotedAt: null,
      ...data,
    }));
	  });

  it('reports workspace active-state with transaction, lease, and protected-zone authority', async () => {
    const transaction = {
      ...transactionFixture(),
      id: 'txn-active-1',
      projectId: 'project-1',
      mutationLeaseId: 'lease-active-1',
      agentSessionId: 'agent-1',
      project: {
        id: 'project-1',
        workspaceSlug: 'acme',
        members: [],
        agentSessions: [],
      },
      mutationLease: {
        id: 'lease-active-1',
        projectId: 'project-1',
        executionPlanId: 'plan-1',
        agentSessionId: 'agent-1',
        displayCallsign: 'ATLAS-1',
        status: 'active',
        leaseJson: JSON.stringify({
          allowedPaths: ['apps/web/**'],
          route: ['components/auth/**'],
          blockedPaths: ['api/auth/**'],
          noFlyZones: ['infra/prod/**'],
        }),
        issuedAt: new Date('2026-06-29T23:00:00.000Z'),
        expiresAt: null,
        revokedAt: null,
      },
      agentSession: {
        id: 'agent-1',
        projectId: 'project-1',
        ownerUserId: 'user-1',
        displayCallsign: 'ATLAS-1',
      },
    };
    prisma.codeSiteMutationTransaction.findMany.mockResolvedValueOnce([transaction]);
    prisma.codeSiteMutationLease.findMany.mockResolvedValueOnce([{
      ...transaction.mutationLease,
      project: { id: 'project-1', workspaceSlug: 'acme', members: [] },
      agentSession: transaction.agentSession,
      executionPlan: executionPlanFixture(),
    }]);
    prisma.codeSiteMutationZone.findMany.mockResolvedValueOnce([{
      id: 'zone-auth-api',
      workspaceSlug: 'acme',
      zoneKey: 'auth_api',
      label: 'Auth API',
      zoneClass: 'A',
      pathsJson: JSON.stringify(['api/auth/**']),
      rulesJson: JSON.stringify(['explicit_tower_clearance_required']),
      risk: 'critical',
      createdAt: new Date('2026-06-29T23:00:00.000Z'),
      updatedAt: new Date('2026-06-29T23:00:00.000Z'),
    }]);

    const state = await getWorkspaceActiveState('acme');

    expect(state.active).toBe(true);
    expect(state.ambiguous).toBe(false);
    expect(state.activeProjectIds).toEqual(['project-1']);
    expect(state.activeTransactions).toHaveLength(1);
    expect(state.activeTransactions[0]).toMatchObject({
      id: 'txn-active-1',
      transactionId: 'txn-active-1',
      mutationLeaseId: 'lease-active-1',
      executionPlanId: 'plan-1',
      allowedPaths: ['apps/web/**', 'components/auth/**'],
      blockedPaths: ['api/auth/**', 'infra/prod/**'],
    });
    expect(state.activeLeases).toHaveLength(1);
    expect(state.allowedPaths).toEqual(['apps/web/**', 'components/auth/**']);
    expect(state.blockedPaths).toEqual(['api/auth/**', 'infra/prod/**']);
    expect(state.protectedZones[0]).toMatchObject({
      zoneKey: 'auth_api',
      class: 'A',
      paths: ['api/auth/**'],
    });
  });

  it('serves the shared MCP tool contract from the agent manifest', async () => {
    const manifest = await getAgentManifest('acme', 'project-1');

    expect(manifest.mcpTools).toEqual(CODESITE_MCP_TOOLS);
    expect(manifest.mcpTools).toContain('synthi_codesite_get_inbox');
    expect(manifest.mcpTools).toContain('synthi_codesite_review_quarantine');
    expect(manifest.inboxRoot).toBe('projects/project-1/inbox/');
    expect(manifest.quarantineRoot).toBe('projects/project-1/quarantines/');
    expect(manifest.quarantineIndex).toBe('projects/project-1/quarantines/index.jsonl');
  });

  it('includes pending quarantine reviews in agent-readable control state', async () => {
    prisma.codeSiteProject.findFirst.mockResolvedValueOnce({
      id: 'project-1',
      workspaceSlug: 'acme',
      title: 'Quarantine run',
      request: 'Review quarantined write',
      status: 'active',
      createdByUserId: 'user-1',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      updatedAt: new Date('2026-07-01T00:03:00.000Z'),
      zonePolicyJson: JSON.stringify({ zones: [], noFlyZones: [] }),
      controlPlanJson: JSON.stringify({}),
      agentSessions: [{
        id: 'agent-1',
        projectId: 'project-1',
        ownerUserId: 'user-1',
        agentProvider: 'codex',
        agentRuntime: 'cli',
        providerSessionRef: null,
        displayCallsign: 'ATLAS-1',
        status: 'active',
        permissionsJson: JSON.stringify([]),
        redactionPolicyJson: JSON.stringify({}),
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        endedAt: null,
      }],
      executionPlans: [executionPlanFixture(['docs/**'])],
      mutationLeases: [{
        id: 'lease-1',
        projectId: 'project-1',
        executionPlanId: 'plan-1',
        agentSessionId: 'agent-1',
        displayCallsign: 'ATLAS-1',
        status: 'active',
        leaseJson: JSON.stringify({ allowedPaths: ['docs/**'], blockedPaths: [] }),
        dojoProofRef: null,
        dojoLicenseRef: null,
        dojoEvidenceRefsJson: JSON.stringify([]),
        dojoLedgerCheckpointHash: null,
        dojoDecisionDigest: null,
        implementationStatusJson: JSON.stringify({}),
        issuedAt: new Date('2026-07-01T00:00:00.000Z'),
        expiresAt: null,
        revokedAt: null,
      }],
      mutationTxns: [{
        ...transactionFixture(),
        writeSetJson: JSON.stringify(['docs/review.md']),
        observedWriteSetJson: JSON.stringify([]),
      }],
      assumptions: [],
      policyDecisions: [],
      events: [{
        id: 'evt-q1',
        projectId: 'project-1',
        mutationLeaseId: 'lease-1',
        eventType: 'write_quarantined',
        displayCallsign: 'ATLAS-1',
        actorType: 'codesitefs',
        actorId: 'qtn-1',
        evidenceRefsJson: JSON.stringify(['codesitefs:quarantine:sha256:review']),
        logicalTime: 9,
        createdAt: new Date('2026-07-01T00:02:00.000Z'),
        detailsJson: JSON.stringify({
          transactionId: 'txn-1',
          quarantineId: 'qtn-1',
          path: 'docs/review.md',
          quarantineEvidence: {
            path: 'docs/review.md',
            afterDigest: 'sha256:after-review',
            evidenceRef: 'codesitefs:quarantine:sha256:review',
          },
        }),
      }],
      incidents: [],
      inspectionRuns: [],
      proofBundles: [],
      lineProvenance: [],
      documents: [],
      counterfactualRuns: [],
      policyDeltas: [],
      inboxItems: [],
    });

    const state = await getControlState('acme', 'project-1');

    expect(state.pendingQuarantines).toEqual([
      expect.objectContaining({
        quarantineId: 'qtn-1',
        status: 'reviewable',
        transactionId: 'txn-1',
        paths: ['docs/review.md'],
        changeCount: 1,
      }),
    ]);
    expect(state.filesystemBoundaryProofs).toEqual([
      expect.objectContaining({
        eventId: 'evt-q1',
        disposition: 'write_quarantined',
        path: 'docs/review.md',
        mutationLeaseId: 'lease-1',
        leaseState: 'matched_clearance',
        proofComplete: false,
        missingProofFields: expect.arrayContaining(['reason', 'process']),
        evidenceRefs: expect.arrayContaining(['event:evt-q1', 'codesitefs:quarantine:sha256:review']),
      }),
    ]);
    expect(state.requiredActions).toContain('review_quarantine:qtn-1');
    expect(state.requiredActions).toContain('complete_filesystem_boundary_proof:fs-boundary-evt-q1');
    expect(state.towerState).toBe('holding');
  });

  it('keeps partially applied quarantines pending with remaining paths', async () => {
    prisma.codeSiteProject.findFirst.mockResolvedValueOnce({
      id: 'project-1',
      workspaceSlug: 'acme',
      title: 'Partial quarantine run',
      request: 'Apply one quarantined path',
      status: 'active',
      createdByUserId: 'user-1',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      updatedAt: new Date('2026-07-01T00:03:00.000Z'),
      zonePolicyJson: JSON.stringify({ zones: [], noFlyZones: [] }),
      controlPlanJson: JSON.stringify({}),
      agentSessions: [{
        id: 'agent-1',
        projectId: 'project-1',
        ownerUserId: 'user-1',
        agentProvider: 'codex',
        agentRuntime: 'cli',
        providerSessionRef: null,
        displayCallsign: 'ATLAS-1',
        status: 'active',
        permissionsJson: JSON.stringify([]),
        redactionPolicyJson: JSON.stringify({}),
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        endedAt: null,
      }],
      executionPlans: [executionPlanFixture(['docs/**'])],
      mutationLeases: [{
        id: 'lease-1',
        projectId: 'project-1',
        executionPlanId: 'plan-1',
        agentSessionId: 'agent-1',
        displayCallsign: 'ATLAS-1',
        status: 'active',
        leaseJson: JSON.stringify({ allowedPaths: ['docs/**'], blockedPaths: [] }),
        dojoProofRef: null,
        dojoLicenseRef: null,
        dojoEvidenceRefsJson: JSON.stringify([]),
        dojoLedgerCheckpointHash: null,
        dojoDecisionDigest: null,
        implementationStatusJson: JSON.stringify({}),
        issuedAt: new Date('2026-07-01T00:00:00.000Z'),
        expiresAt: null,
        revokedAt: null,
      }],
      mutationTxns: [{
        ...transactionFixture(),
        writeSetJson: JSON.stringify(['docs/review.md']),
        observedWriteSetJson: JSON.stringify(['docs/review.md']),
      }],
      assumptions: [],
      policyDecisions: [],
      events: [
        {
          id: 'evt-q1',
          projectId: 'project-1',
          mutationLeaseId: 'lease-1',
          eventType: 'write_quarantined',
          displayCallsign: 'ATLAS-1',
          actorType: 'codesitefs',
          actorId: 'qtn-1',
          evidenceRefsJson: JSON.stringify(['codesitefs:quarantine:sha256:review']),
          logicalTime: 9,
          createdAt: new Date('2026-07-01T00:02:00.000Z'),
          detailsJson: JSON.stringify({
            transactionId: 'txn-1',
            quarantineId: 'qtn-1',
            path: 'docs/review.md',
            quarantineEvidence: {
              path: 'docs/review.md',
              afterDigest: 'sha256:after-review',
              evidenceRef: 'codesitefs:quarantine:sha256:review',
            },
          }),
        },
        {
          id: 'evt-q2',
          projectId: 'project-1',
          mutationLeaseId: 'lease-1',
          eventType: 'write_quarantined',
          displayCallsign: 'ATLAS-1',
          actorType: 'codesitefs',
          actorId: 'qtn-1',
          evidenceRefsJson: JSON.stringify(['codesitefs:quarantine:sha256:notes']),
          logicalTime: 10,
          createdAt: new Date('2026-07-01T00:02:15.000Z'),
          detailsJson: JSON.stringify({
            transactionId: 'txn-1',
            quarantineId: 'qtn-1',
            path: 'docs/notes.md',
            quarantineEvidence: {
              path: 'docs/notes.md',
              afterDigest: 'sha256:after-notes',
              evidenceRef: 'codesitefs:quarantine:sha256:notes',
            },
          }),
        },
        {
          id: 'evt-q3',
          projectId: 'project-1',
          mutationLeaseId: 'lease-1',
          eventType: 'quarantine_applied',
          displayCallsign: 'ATLAS-1',
          actorType: 'codesitefs',
          actorId: 'qtn-1',
          evidenceRefsJson: JSON.stringify(['codesitefs:quarantine:sha256:review']),
          logicalTime: 11,
          createdAt: new Date('2026-07-01T00:02:30.000Z'),
          detailsJson: JSON.stringify({
            transactionId: 'txn-1',
            quarantineId: 'qtn-1',
            paths: ['docs/review.md'],
            applied: [{ path: 'docs/review.md', evidenceRef: 'codesitefs:quarantine:sha256:review' }],
          }),
        },
      ],
      incidents: [],
      inspectionRuns: [],
      proofBundles: [],
      lineProvenance: [],
      documents: [],
      counterfactualRuns: [],
      policyDeltas: [],
      inboxItems: [],
    });

    const state = await getControlState('acme', 'project-1');

    expect(state.pendingQuarantines).toEqual([
      expect.objectContaining({
        quarantineId: 'qtn-1',
        status: 'partially_applied',
        appliedPaths: ['docs/review.md'],
        remainingPaths: ['docs/notes.md'],
      }),
    ]);
    expect(state.requiredActions).toContain('review_quarantine:qtn-1');
    expect(state.towerState).toBe('holding');
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

  it('preserves explicit auto-workflow mission license metadata', async () => {
    await createProject('acme', { userId: 'user-1' }, {
      title: 'Update schema',
      request: 'Update schema contract',
      autoWorkflow: true,
      repoPolicyCompiler: false,
      missions: [{
        callsign: 'SCHEMA-01',
        domain: 'schema',
        mission: 'Schema first',
        route: ['synthi/prisma/**'],
        requestedTools: ['file_write', 'npm_test'],
        dojoPilotLicenseRef: 'schema.level_2@2026-06-25',
        dojoProofRef: 'pcap-schema-proof',
        dojoEvidenceRefs: ['dojo:evidence:checkride'],
        dojoDecisionDigest: 'sha256:decision',
        pilotLicenseSnapshot: {
          licenseLevel: 'IFR',
          repoScope: 'acme',
          authorizedAirspace: ['synthi/prisma/**'],
        },
      }],
    });

    const createdSession = prisma.codeSiteAgentSession.create.mock.calls.at(-1)[0].data;
    expect(createdSession).toMatchObject({
      dojoPilotLicenseRef: 'schema.level_2@2026-06-25',
      dojoProofRef: 'pcap-schema-proof',
      dojoDecisionDigest: 'sha256:decision',
    });
    expect(JSON.parse(createdSession.dojoEvidenceRefsJson)).toEqual(['dojo:evidence:checkride']);
    expect(JSON.parse(createdSession.pilotLicenseSnapshotJson)).toMatchObject({
      licenseLevel: 'IFR',
      repoScope: 'acme',
      authorizedAirspace: ['synthi/prisma/**'],
    });
  });

  it('preserves repo policy compiler provenance across policy updates', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codesite-policy-root-'));
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }));
    await fs.mkdir(path.join(root, 'packages/contracts/src'), { recursive: true });
    await fs.writeFile(path.join(root, 'packages/contracts/package.json'), JSON.stringify({
      name: '@acme/contracts',
      exports: { '.': './src/index.ts' },
    }));
    await fs.writeFile(path.join(root, 'packages/contracts/src/index.ts'), 'export type Signup = { email: string };\n');

    prisma.codeSiteProject.findFirst.mockResolvedValueOnce({
      id: 'project-1',
      workspaceSlug: 'acme',
      title: 'Policy provenance',
      request: 'Compile repo policy',
      status: 'active',
      zonePolicyJson: JSON.stringify({
        zones: [],
        compiler: {
          repoRoot: root,
          sourceDigest: 'sha256:previous-source',
          policyDigest: 'sha256:previous-policy',
          compilerVersion: 'previous',
          fileCount: 3,
          maxFiles: 12000,
          truncated: false,
        },
      }),
      controlPlanJson: JSON.stringify({}),
      createdAt: new Date('2026-06-29T23:00:00.000Z'),
      updatedAt: new Date('2026-06-29T23:00:00.000Z'),
    });

    await updateZonePolicy('acme', 'project-1', {
      zones: [{ zoneKey: 'docs', class: 'D', label: 'Docs', paths: ['docs/**'], risk: 'low' }],
    });

    const storedPolicy = JSON.parse(prisma.codeSiteProject.update.mock.calls.at(-1)[0].data.zonePolicyJson);
    expect(storedPolicy.compiler).toMatchObject({
      repoRoot: root,
      compilerVersion: '2026-07-01.1',
      maxFiles: 12000,
      truncated: false,
      source: 'repo_policy_compiler',
    });
    expect(storedPolicy.compiler.sourceDigest).toMatch(/^sha256:/);
    expect(storedPolicy.compiler.policyDigest).toMatch(/^sha256:/);
    expect(storedPolicy.policyDigest).toBe(storedPolicy.compiler.policyDigest);
    expect(storedPolicy.compiler.fileCount).toBeGreaterThan(0);
    expect(storedPolicy.compiler.compiledAt).toEqual(expect.any(String));
    await fs.rm(root, { recursive: true, force: true });
  });

  it('persists Dojo pilot license refs on agent sessions', async () => {
    const result = await createAgentSession('acme', 'project-1', { userId: 'user-1' }, {
      displayCallsign: 'PILOT-1',
      agentProvider: 'codex',
      agentRuntime: 'tmp-codex-cli',
      toolList: ['synthi_codesite_get_radar', 'synthi_codesite_apply_patch'],
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
        permissionsJson: JSON.stringify(['synthi_codesite_get_radar', 'synthi_codesite_apply_patch']),
        pilotLicenseSnapshotJson: JSON.stringify({ licenseClass: 'runtime', level: 2 }),
      }),
    }));
    expect(result).toMatchObject({
      displayCallsign: 'PILOT-1',
      permissions: ['synthi_codesite_get_radar', 'synthi_codesite_apply_patch'],
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

  it('holds restricted airspace clearances without approved governance evidence even with verified Dojo proof', async () => {
    const lease = await requestMutationLease('acme', 'plan-1', {
      allowedPaths: ['synthi/prisma/**'],
      ...signedDojoProofFixture(),
    });

    expect(lease.status).toBe('holding');
    expect(lease.dojoProofRef).toBe('pcap-auth-schema');
    expect(lease.dojoDecisionDigest).toMatch(/^sha256:/);
    expect(lease.policyDecision.reasonCodes).toEqual(expect.arrayContaining([
      'dojo_clearance_proof_verified',
      'dojo_public_proof_signature_verified',
      'pilot_license_health_active',
      'pilot_license_level_authorized',
      'governance_approval_required',
      'governance_permit_or_change_order_required',
    ]));
    expect(lease.lease.governancePolicy).toMatchObject({
      required: true,
      verified: false,
    });
    expect(lease.lease.towerInstruction).toContain('requires an approved work permit');
  });

  it('allows restricted airspace clearances with verified Dojo proof and an approved permit', async () => {
    prisma.codeSitePermit.findMany.mockResolvedValueOnce([approvedPermitFixture()]);

    const lease = await requestMutationLease('acme', 'plan-1', {
      allowedPaths: ['synthi/prisma/**'],
      ...signedDojoProofFixture(),
    });

    expect(lease.status).toBe('active');
    expect(lease.policyDecision.reasonCodes).toEqual(expect.arrayContaining([
      'dojo_clearance_proof_verified',
      'dojo_public_proof_signature_verified',
      'pilot_license_health_active',
      'pilot_license_level_authorized',
      'governance_clearance_evidence_verified',
    ]));
    expect(lease.pilotLicenseHealth).toMatchObject({
      status: 'active',
      level: 'IFR',
      dojoLicenseRef: 'schema.level_2@2026-06-25',
    });
    const storedLease = JSON.parse(prisma.codeSiteMutationLease.create.mock.calls.at(-1)[0].data.leaseJson);
    expect(storedLease.pilotLicenseHealth).toMatchObject({
      status: 'active',
      level: 'IFR',
      dojoProofRef: 'pcap-auth-schema',
    });
    expect(storedLease.governancePolicy).toMatchObject({
      required: true,
      verified: true,
      evidence: {
        permits: [expect.objectContaining({ id: 'permit-approved', status: 'issued' })],
      },
    });
  });

  it('blocks restricted clearances when the pilot license expired from source drift', async () => {
    const plan = executionPlanFixture(['synthi/prisma/**']);
    plan.project.zonePolicyJson = JSON.stringify({
      zones: [
        { zoneKey: 'schema', class: 'B', label: 'Schema', paths: ['synthi/prisma/**'], rules: [], risk: 'high' },
      ],
      compiler: {
        sourceDigest: 'sha256:source-v2',
        policyDigest: 'sha256:policy-v2',
      },
    });
    plan.agentSession = {
      ...plan.agentSession,
      dojoPilotLicenseRef: 'schema.level_2@2026-06-25',
      dojoProofRef: 'pcap-auth-schema',
      dojoEvidenceRefsJson: JSON.stringify(['dojo:evidence:checkride-1']),
      pilotLicenseSnapshotJson: JSON.stringify({
        level: 2,
        repoScope: 'acme',
        authorizedAirspace: ['synthi/prisma/**'],
        requiredRadar: ['api_contract', 'security'],
        expiresOn: ['source_drift'],
        sourceDigest: 'sha256:source-v1',
      }),
    };
    prisma.codeSiteExecutionPlan.findFirst.mockResolvedValue(plan);

    const lease = await requestMutationLease('acme', 'plan-1', {
      allowedPaths: ['synthi/prisma/**'],
      ...signedDojoProofFixture(),
    });

    expect(lease.status).toBe('blocked');
    expect(lease.policyDecision.reasonCodes).toEqual(expect.arrayContaining([
      'pilot_license_source_drift_expired',
      'pilot_license_expired',
    ]));
    expect(lease.pilotLicenseHealth).toMatchObject({
      status: 'expired',
      sourceDrift: {
        expired: true,
        sourceDigest: 'sha256:source-v1',
        currentSourceDigest: 'sha256:source-v2',
      },
    });
  });

  it('allows the verified schema-first leader through restricted collision airspace', async () => {
    prisma.codeSiteExecutionPlan.findFirst.mockResolvedValue(executionPlanFixture(['synthi/prisma/**']));
    prisma.codeSitePermit.findMany.mockResolvedValueOnce([approvedPermitFixture()]);
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

  it('records CodeSiteFS read observations into the observed read set and event log', async () => {
    const result = await recordTransactionRead('acme', 'txn-1', {
      path: 'openapi/auth.yaml',
      tool: 'file_read',
      evidenceRefs: ['proof:read-observed'],
      processAncestry: ['codex:test-read'],
      codesiteFsEvent: {
        type: 'read_observed',
        path: 'openapi/auth.yaml',
        tool: 'file_read',
        evidence_refs: ['codesitefs:read:openapi-auth'],
        details: {
          process_ancestry: ['bash', 'codex-cli'],
        },
      },
    });

    expect(result.readSet).toEqual(expect.arrayContaining(['openapi/auth.yaml']));
    expect(result.observedReadSet).toEqual(expect.arrayContaining(['openapi/auth.yaml']));
    expect(prisma.codeSiteMutationTransaction.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'txn-1' },
      data: expect.objectContaining({
        readSetJson: expect.stringContaining('openapi/auth.yaml'),
        observedReadSetJson: expect.stringContaining('openapi/auth.yaml'),
      }),
    }));
    expect(prisma.codeSiteEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: 'read_observed',
        actorType: 'codesitefs',
        evidenceRefsJson: JSON.stringify(['proof:read-observed', 'codesitefs:read:openapi-auth']),
        detailsJson: expect.stringContaining('codesiteFsEvent'),
      }),
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

  it('records transaction-scoped quarantine lifecycle events', async () => {
    const event = await recordTransactionQuarantineEvent('acme', 'txn-1', {
      eventType: 'quarantine_replayed',
      quarantineId: 'qtn-1',
      paths: ['docs/review.md'],
      evidenceRefs: ['codesitefs:quarantine:sha256:evidence'],
      details: { replayableChangeCount: 1 },
    });

    expect(event.eventType).toBe('quarantine_replayed');
    expect(event.actorType).toBe('codesitefs');
    expect(event.actorId).toBe('qtn-1');
    expect(event.mutationLeaseId).toBe('lease-1');
    expect(event.evidenceRefs).toEqual(['codesitefs:quarantine:sha256:evidence']);
    expect(event.details).toEqual(expect.objectContaining({
      transactionId: 'txn-1',
      quarantineId: 'qtn-1',
      paths: ['docs/review.md'],
      replayableChangeCount: 1,
    }));
  });

  it('rejects unsupported quarantine lifecycle event types', async () => {
    await expect(recordTransactionQuarantineEvent('acme', 'txn-1', {
      eventType: 'write_allowed',
      quarantineId: 'qtn-1',
    })).rejects.toMatchObject({
      code: 'invalid_quarantine_event_type',
      status: 400,
    });
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

  it('records a snapshot event when a serializable transaction opens with read snapshot evidence', async () => {
    const snapshot = {
      schemaVersion: 'synthi.codesite.readSnapshotEvidence.v1',
      status: 'recorded',
      readSet: ['synthi/prisma/schema-contract-read.txt'],
      fileDigests: [{ path: 'synthi/prisma/schema-contract-read.txt', digest: 'sha256:read-file', size: 32, exists: true }],
      missingPaths: [],
      skippedPaths: [],
      truncated: false,
      snapshotDigest: 'sha256:snapshot',
      evidenceDigest: 'sha256:snapshot-evidence',
    };
    prisma.codeSiteMutationTransaction.create.mockImplementationOnce(async ({ data }) => ({
      id: 'txn-snapshot',
      openedAt: new Date('2026-06-29T23:04:00.000Z'),
      closedAt: null,
      proofBundleDigest: null,
      ...data,
    }));

    const transaction = await openTransaction('acme', 'lease-1', {
      baseSnapshot: snapshot.snapshotDigest,
      baseSnapshotEvidence: snapshot,
      readSet: ['synthi/prisma/schema-contract-read.txt'],
      writeSet: ['synthi/prisma/schema.prisma'],
    });

    expect(transaction.id).toBe('txn-snapshot');
    const events = prisma.codeSiteEvent.create.mock.calls.map((call) => call[0].data);
    expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      'transaction_opened',
      'snapshot_taken',
    ]));
    const snapshotEvent = events.find((event) => event.eventType === 'snapshot_taken');
    expect(snapshotEvent).toMatchObject({
      mutationLeaseId: 'lease-1',
      displayCallsign: 'ATLAS-1',
      actorType: 'transaction',
      actorId: 'txn-snapshot',
      evidenceRefsJson: JSON.stringify(['codesite:read-snapshot:sha256:snapshot-evidence']),
    });
    expect(JSON.parse(snapshotEvent.detailsJson)).toMatchObject({
      transactionId: 'txn-snapshot',
      snapshotDigest: 'sha256:snapshot',
      evidenceDigest: 'sha256:snapshot-evidence',
      status: 'recorded',
      readSet: ['synthi/prisma/schema-contract-read.txt'],
      fileCount: 1,
      reason: 'serializable_transaction_open',
    });
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

  it('classifies landing inspection commands through first-class radar adapters', async () => {
    const adapters = [
      ['clearance', /^clearance:run:sha256:/],
      ['type', /^typecheck:run:sha256:/],
      ['tests', /^test:run:sha256:/],
      ['api_contract', /^api-contract:run:sha256:/],
      ['security', /^security:scan:sha256:/],
      ['migration', /^migration:plan:sha256:/],
      ['ui', /^ui:screenshot:sha256:/],
      ['accessibility', /^accessibility:audit:sha256:/],
      ['runtime', /^runtime:event:sha256:/],
      ['performance', /^performance:budget:sha256:/],
      ['handover', /^handover:packet:sha256:/],
    ];

    const run = await createInspectionRun('acme', 'project-1', {
      executionPlanId: 'plan-1',
      displayCallsign: 'RADAR-STACK-1',
      changedPaths: ['components/auth/SignupForm.tsx'],
      execute: true,
      commands: adapters.map(([adapter]) => ({
        adapter,
        command: process.execPath,
        args: ['-e', `console.log("${adapter} radar ok")`],
        timeoutMs: 5000,
      })),
    });

    expect(run.status).toBe('completed');
    for (const [adapter, prefix] of adapters) {
      const signal = run.inspectionSignals.find((item) => item.key === adapter);
      expect(signal).toMatchObject({
        key: adapter,
        status: 'passed',
        adapter: expect.objectContaining({ key: adapter }),
      });
      expect(signal.reasonCodes).toEqual(expect.arrayContaining([
        `${adapter}_radar_passed`,
        `${adapter}_adapter_executed`,
      ]));
      expect(signal.evidenceRefs).toEqual(expect.arrayContaining([expect.stringMatching(prefix)]));
      expect(run.evidenceRefs).toEqual(expect.arrayContaining([expect.stringMatching(prefix)]));
    }
  });

  it('canonicalizes manual adapter signals and required-radar aliases', async () => {
    const manualRun = await createInspectionRun('acme', 'project-1', {
      executionPlanId: 'plan-1',
      displayCallsign: 'RADAR-MANUAL-1',
      changedPaths: ['components/auth/SignupForm.tsx'],
      inspectionSignals: [{
        adapter: 'visual',
        status: 'passed',
        evidenceRefs: ['ui:screenshot:sha256:manual'],
      }],
      evidenceRefs: ['ui:screenshot:sha256:manual'],
    });
    expect(manualRun.inspectionSignals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'ui',
        status: 'passed',
        adapter: expect.objectContaining({ key: 'ui' }),
        evidenceRefs: ['ui:screenshot:sha256:manual'],
      }),
    ]));

    prisma.codeSiteMutationTransaction.findFirst.mockResolvedValue({
      ...transactionFixture(),
      writeSetJson: JSON.stringify(['components/auth/SignupForm.tsx']),
      observedWriteSetJson: JSON.stringify(['components/auth/SignupForm.tsx']),
      mutationLease: {
        ...transactionFixture().mutationLease,
        leaseJson: JSON.stringify({
          allowedPaths: ['components/auth/**'],
          blockedPaths: [],
          allowedTools: ['file_write'],
          requiredRadar: ['visual'],
        }),
      },
    });
    prisma.codeSiteEvent.findMany.mockResolvedValue([]);
    prisma.codeSiteInspectionRun.findMany.mockResolvedValue([{
      id: 'inspection-visual',
      projectId: 'project-1',
      executionPlanId: 'plan-1',
      displayCallsign: 'RADAR-MANUAL-1',
      status: 'completed',
      changedPathsJson: JSON.stringify(['components/auth/**']),
      inspectionSignalsJson: JSON.stringify([{
        adapter: 'visual',
        status: 'passed',
        evidenceRefs: ['ui:screenshot:sha256:manual'],
      }]),
      evidenceRefsJson: JSON.stringify(['ui:screenshot:sha256:manual']),
      requestedAt: new Date('2026-06-29T23:02:00.000Z'),
      completedAt: new Date('2026-06-29T23:03:00.000Z'),
    }]);

    const result = await validateTransaction('acme', 'txn-1');

    expect(result.decision.ok).toBe(true);
    expect(result.decision.reasonCodes).toContain('serializable_validation_passed');
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
    expect(prisma.codeSiteLineProvenance.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'project-1',
        transactionId: 'txn-1',
        filePath: 'synthi/prisma/schema.prisma',
        lineAnchor: 'synthi/prisma/schema.prisma#L7',
        startLine: 7,
        endLine: 9,
        displayCallsign: 'ATLAS-1',
        evidenceRefsJson: expect.stringContaining('event:'),
        processAncestryJson: expect.stringContaining('mcp:synthi_codesite_apply_patch'),
        promptSummary: 'Update schema field',
      }),
    });
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
    expect(prisma.codeSiteEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        projectId: 'project-1',
        eventType: 'transponder_update',
        actorType: 'agent_session',
        actorId: 'agent-1',
        detailsJson: expect.stringContaining('inbox_acknowledged'),
      }),
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

  it('issues construction permits against real project, plan, lease, and document refs', async () => {
    const result = await createPermit('acme', 'project-1', {
      permitType: 'schema_work_permit',
      executionPlanId: 'plan-1',
      mutationLeaseId: 'lease-1',
      documentId: 'doc-1',
      allowedPaths: ['synthi/prisma/**', 'packages/schemas/**'],
      blockedPaths: ['infra/prod/**'],
      affectedZones: ['schema'],
      contractRefs: ['auth.signup.v2'],
      evidenceRefs: ['evidence:permit-review'],
    }, { userId: 'user-1' });
    const permitCreate = prisma.codeSitePermit.create.mock.calls.at(-1)[0].data;
    const scope = JSON.parse(permitCreate.scopeJson);
    const approval = JSON.parse(permitCreate.approvalJson);
    const eventCreate = prisma.codeSiteEvent.create.mock.calls.at(-1)[0].data;

    expect(result.permit).toMatchObject({
      id: 'permit-created',
      projectId: 'project-1',
      executionPlanId: 'plan-1',
      mutationLeaseId: 'lease-1',
      documentId: 'doc-1',
      permitType: 'schema_work_permit',
      status: 'issued',
    });
    expect(scope).toMatchObject({
      executionPlanId: 'plan-1',
      mutationLeaseId: 'lease-1',
      allowedPaths: ['synthi/prisma/**', 'packages/schemas/**'],
      blockedPaths: ['infra/prod/**'],
      affectedZones: ['schema'],
      contractRefs: ['auth.signup.v2'],
    });
    expect(approval).toMatchObject({
      approved: true,
      approvedByUserId: 'user-1',
    });
    expect(eventCreate).toMatchObject({
      eventType: 'tower_instruction',
      actorType: 'permit',
      actorId: 'permit-created',
      evidenceRefsJson: JSON.stringify(['evidence:permit-review']),
    });
  });

  it('records document reviews as measured governance decisions', async () => {
    const result = await reviewDocument('acme', 'doc-1', {
      decision: 'approved',
      summary: 'Schema reroute approved by tower',
      routeRevisionId: 'route-revision-1',
      reviewTimeMs: 90_000,
      baselineReviewTimeMs: 300_000,
      evidenceRefs: ['evidence:review-session'],
    }, { userId: 'reviewer-1' });
    const reviewCreate = prisma.codeSiteDocumentReview.create.mock.calls.at(-1)[0].data;
    const reviewBody = JSON.parse(reviewCreate.bodyJson);
    const documentUpdate = prisma.codeSiteDocument.update.mock.calls.at(-1)[0].data;
    const eventCreate = prisma.codeSiteEvent.create.mock.calls.at(-1)[0].data;

    expect(result.review).toMatchObject({
      id: 'review-created',
      projectId: 'project-1',
      documentId: 'doc-1',
      reviewerUserId: 'reviewer-1',
      status: 'completed',
      decision: 'approved',
    });
    expect(reviewBody).toMatchObject({
      summary: 'Schema reroute approved by tower',
      routeRevisionId: 'route-revision-1',
      reviewTimeMs: 90_000,
      baselineReviewTimeMs: 300_000,
    });
    expect(documentUpdate.status).toBe('approved');
    expect(documentUpdate.resolvedAt).toBeInstanceOf(Date);
    expect(eventCreate).toMatchObject({
      eventType: 'tower_instruction',
      actorType: 'document_review',
      actorId: 'review-created',
      evidenceRefsJson: JSON.stringify(['evidence:review-session']),
    });
  });

  it('proposes, approves, and applies route revisions with affected clearance holds', async () => {
    prisma.codeSiteMutationLease.findMany.mockResolvedValueOnce([{
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
    }]);

    const proposed = await proposeRouteRevision('acme', 'plan-1', {
      title: 'Route auth schema through shared package',
      proposedRoute: ['synthi/prisma/**', 'packages/schemas/**'],
      affectedZones: ['schema'],
      contractRefs: ['auth.signup.v2'],
      evidenceRefs: ['evidence:route-proposal'],
    }, { userId: 'user-1' });
    const revisionCreate = prisma.codeSiteRouteRevision.create.mock.calls.at(-1)[0].data;
    expect(proposed.routeRevision).toMatchObject({
      id: 'route-revision-created',
      status: 'proposed',
      previousRoute: ['synthi/prisma/**'],
      proposedRoute: ['synthi/prisma/**', 'packages/schemas/**'],
    });
    expect(proposed.changeOrder).toMatchObject({
      id: 'doc-1',
      kind: 'change_order',
      status: 'pending_review',
    });
    expect(JSON.parse(revisionCreate.affectedLeasesJson)).toEqual([
      expect.objectContaining({ id: 'lease-1', status: 'active', displayCallsign: 'ATLAS-1' }),
    ]);

    prisma.codeSiteRouteRevision.findFirst.mockResolvedValueOnce({
      id: 'route-revision-1',
      projectId: 'project-1',
      executionPlanId: 'plan-1',
      documentId: 'doc-1',
      status: 'proposed',
      previousRouteJson: JSON.stringify(['synthi/prisma/**']),
      proposedRouteJson: JSON.stringify(['synthi/prisma/**', 'packages/schemas/**']),
      affectedLeasesJson: JSON.stringify([{ id: 'lease-1', status: 'active', displayCallsign: 'ATLAS-1' }]),
      approvalJson: JSON.stringify({ required: true }),
      evidenceRefsJson: JSON.stringify(['evidence:route-proposal']),
      proposedByUserId: 'user-1',
      approvedByUserId: null,
      appliedAt: null,
      createdAt: new Date('2026-06-29T23:05:00.000Z'),
      updatedAt: new Date('2026-06-29T23:05:00.000Z'),
      project: {
        id: 'project-1',
        workspaceSlug: 'acme',
        title: 'Signup',
        request: 'Build signup',
        status: 'active',
        createdByUserId: 'user-1',
        members: [{
          id: 'member-reviewer',
          projectId: 'project-1',
          workspaceSlug: 'acme',
          userId: 'reviewer-1',
          role: 'admin',
          permissionsJson: JSON.stringify(['project:read', 'project:write']),
          participationStatus: 'enabled',
          revokedAt: null,
        }],
        agentSessions: [],
      },
      executionPlan: executionPlanFixture(),
      document: null,
    });
    const reviewed = await reviewRouteRevision('acme', 'route-revision-1', {
      decision: 'approved',
      rationale: 'Schema-first reroute reduces stale frontend assumptions.',
      evidenceRefs: ['evidence:route-review'],
    }, { userId: 'reviewer-1' });
    const revisionUpdate = prisma.codeSiteRouteRevision.update.mock.calls.at(-1)[0].data;
    expect(reviewed.routeRevision).toMatchObject({
      id: 'route-revision-1',
      status: 'approved',
      approvedByUserId: 'reviewer-1',
    });
    expect(JSON.parse(revisionUpdate.approvalJson)).toMatchObject({
      decision: 'approved',
      approved: true,
      reviewedByUserId: 'reviewer-1',
    });

    prisma.codeSiteMutationLease.findMany.mockResolvedValueOnce([{
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
    }]);
    const applied = await applyRouteRevision('acme', 'route-revision-1', {
      evidenceRefs: ['evidence:route-apply'],
    }, { userId: 'user-1' });
    const planUpdate = prisma.codeSiteExecutionPlan.update.mock.calls.at(-1)[0].data;
    const leaseUpdate = prisma.codeSiteMutationLease.update.mock.calls.at(-1);
    const policyDecision = prisma.codeSitePolicyDecision.create.mock.calls.at(-1)[0].data;

    expect(applied.executionPlan).toMatchObject({
      id: 'plan-1',
      status: 'rerouted',
      route: ['synthi/prisma/**', 'packages/schemas/**'],
    });
    expect(planUpdate).toMatchObject({
      routeJson: JSON.stringify(['synthi/prisma/**', 'packages/schemas/**']),
      status: 'rerouted',
    });
    expect(leaseUpdate).toEqual([expect.objectContaining({
      where: { id: 'lease-1' },
      data: { status: 'suspended', revokedAt: null },
    })]);
    expect(policyDecision).toMatchObject({
      mutationLeaseId: 'lease-1',
      decision: 'hold',
      reasonCodesJson: JSON.stringify(['route_revision_applied', 'clearance_reissue_required']),
    });
    expect(applied.affectedLeases[0]).toMatchObject({ id: 'lease-1', status: 'suspended' });
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
    const replayEvents = [
      {
        id: 'event-transaction-opened',
        eventType: 'transaction_opened',
        mutationLeaseId: 'lease-1',
        actorId: 'txn-1',
        displayCallsign: 'ATLAS-1',
        createdAt: new Date('2026-06-29T23:00:00.000Z'),
        detailsJson: JSON.stringify({ transactionId: 'txn-1', baseSnapshot: 'base' }),
      },
      {
        id: 'event-snapshot',
        eventType: 'snapshot_taken',
        mutationLeaseId: 'lease-1',
        actorId: 'txn-1',
        displayCallsign: 'ATLAS-1',
        createdAt: new Date('2026-06-29T23:00:05.000Z'),
        detailsJson: JSON.stringify({ transactionId: 'txn-1', snapshotDigest: 'sha256:snapshot', readSet: ['synthi/prisma/schema.prisma'] }),
      },
      {
        id: 'event-assumption',
        eventType: 'assumption_recorded',
        mutationLeaseId: 'lease-1',
        actorId: 'txn-1',
        displayCallsign: 'ATLAS-1',
        createdAt: new Date('2026-06-29T23:00:10.000Z'),
        detailsJson: JSON.stringify({ transactionId: 'txn-1', assumptionId: 'assumption-1' }),
      },
      {
        id: 'event-clearance',
        eventType: 'clearance_issued',
        mutationLeaseId: 'lease-1',
        displayCallsign: 'ATLAS-1',
        createdAt: new Date('2026-06-29T23:00:15.000Z'),
        detailsJson: JSON.stringify({ allowedPaths: ['synthi/prisma/**'] }),
      },
      {
        id: 'event-write-attempted',
        eventType: 'write_attempted',
        mutationLeaseId: 'lease-1',
        actorId: 'txn-1',
        displayCallsign: 'ATLAS-1',
        createdAt: new Date('2026-06-29T23:00:20.000Z'),
        detailsJson: JSON.stringify({ transactionId: 'txn-1', path: 'synthi/prisma/schema.prisma' }),
      },
      {
        id: 'event-write-denied',
        eventType: 'write_denied',
        mutationLeaseId: 'lease-1',
        actorId: 'txn-1',
        displayCallsign: 'ATLAS-1',
        createdAt: new Date('2026-06-29T23:00:25.000Z'),
        detailsJson: JSON.stringify({ transactionId: 'txn-1', path: 'secrets/prod.env' }),
      },
      {
        id: 'event-shadow',
        eventType: 'shadow_run',
        displayCallsign: 'ATLAS-1',
        createdAt: new Date('2026-06-29T23:00:30.000Z'),
        detailsJson: JSON.stringify({ affectedZones: ['synthi/prisma/**'], counterfactualRunId: 'cfr-1' }),
      },
      {
        id: 'event-arbiter',
        eventType: 'arbiter_verdict',
        displayCallsign: 'ATLAS-1',
        createdAt: new Date('2026-06-29T23:00:35.000Z'),
        detailsJson: JSON.stringify({ affectedZones: ['synthi/prisma/**'], selected: 'schema-first' }),
      },
      {
        id: 'event-near-miss',
        eventType: 'near_miss',
        displayCallsign: 'ATLAS-1',
        createdAt: new Date('2026-06-29T23:00:40.000Z'),
        detailsJson: JSON.stringify({ affectedZones: ['synthi/prisma/**'], incidentId: 'incident-1' }),
      },
      {
        id: 'event-policy-delta',
        eventType: 'policy_delta_proposed',
        displayCallsign: 'ATLAS-1',
        createdAt: new Date('2026-06-29T23:00:45.000Z'),
        detailsJson: JSON.stringify({ affectedZones: ['synthi/prisma/**'], policyDeltaId: 'delta-1' }),
      },
      {
        id: 'event-aborted',
        eventType: 'transaction_aborted',
        mutationLeaseId: 'lease-1',
        actorId: 'txn-aborted',
        displayCallsign: 'ATLAS-1',
        createdAt: new Date('2026-06-29T23:00:50.000Z'),
        detailsJson: JSON.stringify({ transactionId: 'txn-aborted', reason: 'serializable_snapshot_required' }),
      },
      {
        id: 'event-inspection-result',
        eventType: 'inspection_result',
        mutationLeaseId: 'lease-1',
        displayCallsign: 'ATLAS-1',
        createdAt: new Date('2026-06-29T23:00:55.000Z'),
        detailsJson: JSON.stringify({ changedPaths: ['synthi/prisma/schema.prisma'], inspectionRunId: 'inspection-1' }),
      },
      {
        id: 'event-read-observed',
        eventType: 'read_observed',
        mutationLeaseId: 'lease-1',
        actorId: 'txn-1',
        actorType: 'codesitefs',
        displayCallsign: 'ATLAS-1',
        createdAt: new Date('2026-06-29T23:00:58.000Z'),
        detailsJson: JSON.stringify({
          transactionId: 'txn-1',
          path: 'synthi/prisma/schema.prisma',
          tool: 'file_read',
          codesiteFsEvent: {
            type: 'read_observed',
            path: 'synthi/prisma/schema.prisma',
            tool: 'file_read',
          },
          evidenceRefs: ['read:evidence'],
        }),
        evidenceRefsJson: JSON.stringify(['read:evidence']),
      },
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
    ];
    prisma.codeSiteEvent.findMany.mockImplementation(async (query = {}) => {
      const eventType = query.where?.eventType;
      if (typeof eventType === 'string') return replayEvents.filter((event) => event.eventType === eventType);
      if (Array.isArray(eventType?.in)) return replayEvents.filter((event) => eventType.in.includes(event.eventType));
      return replayEvents;
    });
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
    const proofUpdates = prisma.codeSiteProofBundle.update.mock.calls.map((call) => call[0]);
    const replayProofUpdate = proofUpdates.find((call) => call.data.incidentReplayDigest);
    const finalSignatureUpdate = proofUpdates.filter((call) => call.data.proofSignatureJson).at(-1);
    const evidenceRefs = JSON.parse(proofCreate.data.evidenceRefsJson);
    const incidentCreate = prisma.codeSiteIncident.create.mock.calls.at(-1)[0];
    const incidentUpdate = prisma.codeSiteIncident.update.mock.calls.at(-1)[0];
    const replay = JSON.parse(incidentUpdate.data.incidentReplayJson);
    const eventTypes = prisma.codeSiteEvent.create.mock.calls.map((call) => call[0].data.eventType);

    expect(result.transaction.status).toBe('committed');
    expect(result.proofBundle.commitSha).toBe('abc123');
    expect(result.proofBundle.incidentReplayDigest).toMatch(/^sha256:/);
    expect(result.proofBundle.incidentReplayDigest).not.toBe(result.proofBundle.bundleDigest);
    expect(result.proofBundle.landingStatus).toBe('completed');
    expect(result.proofBundle.portableDigest).toMatch(/^sha256:/);
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
      'CodeSite-Proof-Digest': expect.stringMatching(/^sha256:/),
      'CodeSite-Proof-Signature': expect.stringMatching(/^hmac-sha256:/),
    });
    expect(result.proofBundle.trailers['CodeSite-Proof-Digest']).toBe(result.proofBundle.portableDigest);
    expect(JSON.parse(finalSignatureUpdate.data.proofSignatureJson).payloadDigest).toBe(result.proofBundle.portableDigest);
    expect(result.proofBundle.trailers['CodeSite-Black-Box']).toBe(result.proofBundle.incidentReplayDigest);
    expect(proofCreate.data.landingStatus).toBe('completed');
    expect(replayProofUpdate).toMatchObject({
      where: { id: 'proof-created' },
      data: {
        incidentReplayDigest: result.proofBundle.incidentReplayDigest,
        landingStatus: 'completed',
      },
    });
    expect(finalSignatureUpdate.data).toMatchObject({
      proofSignatureJson: expect.stringContaining('proofSignature.v1'),
      signatureKeyId: expect.any(String),
    });
    expect(incidentCreate.data).toMatchObject({
      projectId: 'project-1',
      severity: 'low',
      category: 'black_box',
    });
    expect(JSON.parse(incidentCreate.data.participantsJson)).toEqual(['ATLAS-1']);
    expect(replay).toMatchObject({
      schemaVersion: 'synthi.codesite.incidentReplay.v1',
      category: 'black_box',
      transactionId: 'txn-1',
      transaction: expect.objectContaining({
        id: 'txn-1',
        status: 'committed',
        writeSet: ['synthi/prisma/schema.prisma'],
      }),
      proofBundle: expect.objectContaining({
        id: 'proof-created',
        bundleDigest: expect.stringMatching(/^sha256:/),
      }),
      handover: expect.objectContaining({
        proofBundleId: 'proof-created',
        exportPaths: expect.arrayContaining([
          expect.stringContaining('handover.md'),
          expect.stringContaining('proof-created.proof.json'),
        ]),
      }),
    });
    expect(replay.causalEvents.map((event) => event.type)).toEqual(expect.arrayContaining([
      'transaction.opened',
      'assumption.recorded',
      'clearance.issued',
      'read.observed',
      'write.attempted',
      'write.denied',
      'snapshot.taken',
      'shadow.run',
      'arbiter.verdict',
      'inspection.result',
      'near_miss.detected',
      'policy_delta.proposed',
      'write.allowed',
      'transaction.committed',
      'transaction.aborted',
      'black_box.closed',
    ]));
    expect(replay.completeness).toMatchObject({
      score: 1,
      missingEventTypes: [],
      missingEvidence: [],
    });
    expect(eventTypes).toEqual(expect.arrayContaining(['transaction_committed', 'black_box_closed']));
    expect(evidenceRefs).toEqual(expect.arrayContaining([
      'runtime:event:inspection-1',
      'runtime:event:typecheck-1',
      'runtime:event:tests-1',
      'codesite:inspection:inspection-1',
      expect.stringMatching(/^codesite:repo-state:sha256:/),
      'codesite:transaction:txn-1',
      'codesite:lease:lease-1',
    ]));
    expect(JSON.parse(proofCreate.data.repoStateJson)).toMatchObject({
      evidenceDigest: expect.stringMatching(/^sha256:/),
      repoIdentity: expect.objectContaining({
        identityDigest: expect.stringMatching(/^sha256:/),
        gitTopLevelMatchesRepoRoot: true,
      }),
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

  it('serializes overlapping proof-carrying commit races and blocks the stale loser', async () => {
    const repoRoot = path.basename(process.cwd()) === 'synthi'
      ? path.dirname(process.cwd())
      : process.cwd();
    const snapshot = await buildReadSnapshotEvidence(['synthi/prisma/schema.prisma'], { repoRoot });
    const openedAt = new Date('2026-06-29T23:00:00.000Z');
    const transactions = new Map([
      ['txn-race-a', {
        ...transactionFixture(),
        id: 'txn-race-a',
        readSetJson: JSON.stringify(['synthi/prisma/schema.prisma']),
        observedReadSetJson: JSON.stringify(['synthi/prisma/schema.prisma']),
        writeSetJson: JSON.stringify(['synthi/prisma/schema.prisma']),
        observedWriteSetJson: JSON.stringify(['synthi/prisma/schema.prisma']),
        baseSnapshot: snapshot.snapshotDigest,
        baseSnapshotEvidenceJson: JSON.stringify(snapshot),
        openedAt,
      }],
      ['txn-race-b', {
        ...transactionFixture(),
        id: 'txn-race-b',
        readSetJson: JSON.stringify(['synthi/prisma/schema.prisma']),
        observedReadSetJson: JSON.stringify(['synthi/prisma/schema.prisma']),
        writeSetJson: JSON.stringify(['synthi/prisma/schema.prisma']),
        observedWriteSetJson: JSON.stringify(['synthi/prisma/schema.prisma']),
        baseSnapshot: snapshot.snapshotDigest,
        baseSnapshotEvidenceJson: JSON.stringify(snapshot),
        openedAt,
      }],
    ]);
    const events = [
      {
        id: 'event-write-a',
        projectId: 'project-1',
        eventType: 'write_allowed',
        actorId: 'txn-race-a',
        displayCallsign: 'ATLAS-1',
        createdAt: openedAt,
        detailsJson: JSON.stringify({
          transactionId: 'txn-race-a',
          path: 'synthi/prisma/schema.prisma',
          lineProvenance: [{
            lineAnchor: 'synthi/prisma/schema.prisma#L12-L15',
            startLine: 12,
            endLine: 15,
            evidenceRefs: ['hunk:evidence:a'],
          }],
          evidenceRefs: ['write:evidence:a'],
        }),
      },
      {
        id: 'event-write-b',
        projectId: 'project-1',
        eventType: 'write_allowed',
        actorId: 'txn-race-b',
        displayCallsign: 'ATLAS-1',
        createdAt: openedAt,
        detailsJson: JSON.stringify({
          transactionId: 'txn-race-b',
          path: 'synthi/prisma/schema.prisma',
          lineProvenance: [{
            lineAnchor: 'synthi/prisma/schema.prisma#L12-L15',
            startLine: 12,
            endLine: 15,
            evidenceRefs: ['hunk:evidence:b'],
          }],
          evidenceRefs: ['write:evidence:b'],
        }),
      },
    ];
    const proofBundles = new Map();
    let eventSeq = 0;
    let proofSeq = 0;

    prisma.codeSiteMutationTransaction.findFirst.mockImplementation(async ({ where } = {}) => {
      const transaction = transactions.get(where?.id);
      return transaction ? { ...transaction } : null;
    });
    prisma.codeSiteMutationTransaction.update.mockImplementation(async ({ where, data }) => {
      const current = transactions.get(where.id);
      const next = { ...current, ...data };
      transactions.set(where.id, next);
      return { ...next };
    });
    prisma.codeSiteMutationTransaction.updateMany.mockImplementation(async ({ where, data }) => {
      const current = transactions.get(where.id);
      const allowedStatuses = where.status?.in || [];
      if (!current || !allowedStatuses.includes(current.status) || current.proofBundleDigest !== where.proofBundleDigest) {
        return { count: 0 };
      }
      transactions.set(where.id, { ...current, ...data });
      return { count: 1 };
    });
    prisma.codeSiteEvent.count.mockImplementation(async ({ where } = {}) => (
      events.filter((event) => !where?.projectId || event.projectId === where.projectId).length
    ));
    prisma.codeSiteEvent.create.mockImplementation(async ({ data }) => {
      const event = {
        id: `event-${data.eventType}-${eventSeq += 1}`,
        createdAt: new Date(`2026-06-29T23:04:${String(eventSeq).padStart(2, '0')}.000Z`),
        ...data,
      };
      events.push(event);
      return event;
    });
    prisma.codeSiteEvent.findMany.mockImplementation(async (query = {}) => {
      const eventType = query.where?.eventType;
      const createdAfter = query.where?.createdAt?.gt;
      return events.filter((event) => {
        if (query.where?.projectId && event.projectId !== query.where.projectId) return false;
        if (typeof eventType === 'string' && event.eventType !== eventType) return false;
        if (Array.isArray(eventType?.in) && !eventType.in.includes(event.eventType)) return false;
        if (createdAfter && !(event.createdAt > createdAfter)) return false;
        return true;
      });
    });
    prisma.codeSiteInspectionRun.findMany.mockResolvedValue([{
      id: 'inspection-race',
      projectId: 'project-1',
      executionPlanId: 'plan-1',
      displayCallsign: 'ATLAS-1',
      status: 'completed',
      changedPathsJson: JSON.stringify(['synthi/prisma/schema.prisma']),
      inspectionSignalsJson: JSON.stringify([
        { key: 'typecheck', status: 'passed', evidenceRefs: ['runtime:event:typecheck-race'] },
        { key: 'tests', status: 'passed', evidenceRefs: ['runtime:event:tests-race'] },
      ]),
      evidenceRefsJson: JSON.stringify(['runtime:event:inspection-race']),
      requestedAt: new Date('2026-06-29T23:02:00.000Z'),
      completedAt: new Date('2026-06-29T23:03:00.000Z'),
    }]);
    prisma.codeSiteProofBundle.create.mockImplementation(async ({ data }) => {
      const bundle = {
        id: `proof-race-${proofSeq += 1}`,
        createdAt: new Date(`2026-06-29T23:05:0${proofSeq}.000Z`),
        ...data,
      };
      proofBundles.set(bundle.id, bundle);
      return bundle;
    });
    prisma.codeSiteProofBundle.update.mockImplementation(async ({ where, data }) => {
      const current = proofBundles.get(where.id);
      const next = {
        ...current,
        ...data,
        project: { id: 'project-1', workspaceSlug: 'acme', zonePolicyJson: JSON.stringify({ zones: [] }) },
        transaction: {
          ...transactions.get(current.transactionId),
          project: { id: 'project-1', workspaceSlug: 'acme', zonePolicyJson: JSON.stringify({ zones: [] }) },
          mutationLease: transactionFixture().mutationLease,
          agentSession: transactionFixture().agentSession,
        },
      };
      proofBundles.set(where.id, next);
      return next;
    });

    const [first, second] = await Promise.all([
      commitTransaction('acme', 'txn-race-a', {
        commitSha: 'abc123',
        repoState: repoStateFixture(undefined, {
          transactionId: 'txn-race-a',
          baseSnapshot: snapshot.snapshotDigest,
        }),
      }),
      commitTransaction('acme', 'txn-race-b', {
        commitSha: 'def456',
        repoState: repoStateFixture(undefined, {
          transactionId: 'txn-race-b',
          baseSnapshot: snapshot.snapshotDigest,
        }),
      }),
    ]);
    const results = [first, second];
    const committed = results.filter((result) => result.transaction?.status === 'committed');
    const blocked = results.filter((result) => result.transaction?.status === 'blocked');
    const commitEvents = events.filter((event) => event.eventType === 'transaction_committed');

    expect(committed).toHaveLength(1);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].decision.reasonCodes).toContain('stale_read_detected');
    expect(blocked[0].decision.staleReads).toEqual([expect.objectContaining({
      eventType: 'transaction_committed',
      path: null,
    })]);
    expect(commitEvents).toHaveLength(1);
    expect(JSON.parse(commitEvents[0].detailsJson)).toMatchObject({
      writeSet: ['synthi/prisma/schema.prisma'],
    });
    expect(prisma.codeSiteProofBundle.create).toHaveBeenCalledTimes(1);
    expect(prisma.codeSiteMutationTransaction.updateMany).toHaveBeenCalledTimes(1);
    expect([...transactions.values()].filter((transaction) => transaction.status === 'committed')).toHaveLength(1);
    expect([...transactions.values()].filter((transaction) => transaction.status === 'blocked')).toHaveLength(1);
  });

  it('scores aborted transaction black boxes against the aborted lifecycle', async () => {
    const transaction = {
      ...transactionFixture(),
      id: 'txn-abort',
      readSetJson: JSON.stringify(['synthi/prisma/schema-contract-read.txt']),
      observedReadSetJson: JSON.stringify(['synthi/prisma/schema-contract-read.txt']),
      writeSetJson: JSON.stringify([]),
      observedWriteSetJson: JSON.stringify([]),
      baseSnapshotEvidenceJson: JSON.stringify({
        schemaVersion: 'synthi.codesite.readSnapshotEvidence.v1',
        snapshotDigest: 'sha256:base-snapshot',
        readSet: ['synthi/prisma/schema-contract-read.txt'],
      }),
    };
    prisma.codeSiteMutationTransaction.findFirst.mockResolvedValue(transaction);
    prisma.codeSiteMutationTransaction.update.mockImplementation(async ({ data }) => ({
      ...transaction,
      ...data,
    }));
    prisma.codeSiteEvent.findMany.mockResolvedValue([
      {
        id: 'event-open-abort',
        projectId: 'project-1',
        mutationLeaseId: 'lease-1',
        eventType: 'transaction_opened',
        displayCallsign: 'ATLAS-1',
        actorType: 'transaction',
        actorId: 'txn-abort',
        detailsJson: JSON.stringify({ transactionId: 'txn-abort', baseSnapshot: 'sha256:base-snapshot' }),
        evidenceRefsJson: JSON.stringify(['ev:open']),
        logicalTime: 1,
        createdAt: new Date('2026-06-29T23:00:00.000Z'),
      },
      {
        id: 'event-clearance-abort',
        projectId: 'project-1',
        mutationLeaseId: 'lease-1',
        eventType: 'clearance_issued',
        displayCallsign: 'ATLAS-1',
        actorType: 'policy_engine',
        actorId: 'decision-1',
        detailsJson: JSON.stringify({ mutationLeaseId: 'lease-1' }),
        evidenceRefsJson: JSON.stringify(['ev:clearance']),
        logicalTime: 2,
        createdAt: new Date('2026-06-29T23:00:10.000Z'),
      },
      {
        id: 'event-snapshot-abort',
        projectId: 'project-1',
        mutationLeaseId: 'lease-1',
        eventType: 'snapshot_taken',
        displayCallsign: 'ATLAS-1',
        actorType: 'transaction',
        actorId: 'txn-abort',
        detailsJson: JSON.stringify({
          transactionId: 'txn-abort',
          snapshotDigest: 'sha256:base-snapshot',
          readSet: ['synthi/prisma/schema-contract-read.txt'],
        }),
        evidenceRefsJson: JSON.stringify(['ev:snapshot']),
        logicalTime: 3,
        createdAt: new Date('2026-06-29T23:00:20.000Z'),
      },
      {
        id: 'event-near-abort',
        projectId: 'project-1',
        mutationLeaseId: 'lease-1',
        eventType: 'near_miss',
        displayCallsign: 'ATLAS-1',
        actorType: 'policy_engine',
        actorId: 'decision-near',
        detailsJson: JSON.stringify({ affectedZones: ['synthi/prisma/**'], prevented: true }),
        evidenceRefsJson: JSON.stringify(['ev:near']),
        logicalTime: 4,
        createdAt: new Date('2026-06-29T23:00:30.000Z'),
      },
    ]);

    await abortTransaction('acme', 'txn-abort', { reason: 'serializable_snapshot_changed' });

    const incidentUpdate = prisma.codeSiteIncident.update.mock.calls.at(-1)[0];
    const replay = JSON.parse(incidentUpdate.data.incidentReplayJson);

    expect(replay.transaction).toMatchObject({
      id: 'txn-abort',
      status: 'aborted',
    });
    expect(replay.causalEvents.map((event) => event.type)).toEqual(expect.arrayContaining([
      'transaction.opened',
      'clearance.issued',
      'snapshot.taken',
      'near_miss.detected',
      'transaction.aborted',
      'black_box.closed',
    ]));
    expect(replay.completeness).toMatchObject({
      score: 1,
      requiredEventTypes: expect.arrayContaining([
        'transaction.opened',
        'clearance.issued',
        'snapshot.taken',
        'near_miss.detected',
        'transaction.aborted',
        'black_box.closed',
      ]),
      missingEventTypes: [],
    });
    expect(replay.completeness.requiredEventTypes).not.toContain('transaction.committed');
  });

  it('scores committed black-box handovers incomplete without proof bundle evidence', async () => {
    prisma.codeSiteEvent.findMany.mockResolvedValue([]);

    const incident = await createIncident('acme', 'project-1', {
      category: 'black_box',
      severity: 'low',
      summary: 'Committed transaction handover without proof evidence.',
      participants: ['ATLAS-1'],
      affectedZones: ['synthi/prisma/**'],
      transactionContext: {
        id: 'txn-1',
        projectId: 'project-1',
        mutationLeaseId: 'lease-1',
        displayCallsign: 'ATLAS-1',
        status: 'committed',
      },
      handover: {
        status: 'committed',
        changedPaths: ['synthi/prisma/schema.prisma'],
        exportPaths: ['projects/project-1/handover.md'],
      },
    });

    expect(incident.category).toBe('black_box');
    expect(incident.incidentReplay.completeness.score).toBeLessThan(1);
    expect(incident.incidentReplay.completeness.requiredEvidence).toEqual(expect.arrayContaining([
      'proof_bundle_id',
      'proof_bundle_digest',
      'proof_bundle_evidence_refs',
      'handover_proof_bundle_id',
      'handover_proof_bundle_digest',
      'proof_bundle_export_path',
      'proof_trailers_export_path',
    ]));
    expect(incident.incidentReplay.completeness.missingEvidence).toEqual(expect.arrayContaining([
      'proof_bundle_id',
      'proof_bundle_digest',
      'proof_bundle_export_path',
      'proof_trailers_export_path',
    ]));
  });

  it('attaches a final git commit only when proof bundle trailers match', async () => {
    const transaction = {
      ...transactionFixture(),
      status: 'committed',
      closedAt: new Date('2026-06-29T23:05:00.000Z'),
    };
    const bundle = {
      id: 'proof-created',
      projectId: 'project-1',
      transactionId: 'txn-1',
      commitSha: null,
      readSetDigest: 'sha256:read',
      writeSetDigest: 'sha256:write',
      invariantsJson: JSON.stringify(['clearance.diff.inside_route']),
      evidenceRefsJson: JSON.stringify(['runtime:event:inspection-1']),
      dojoEvidenceRefsJson: JSON.stringify([]),
      repoStateJson: JSON.stringify(repoStateFixture()),
      incidentReplayDigest: 'sha256:blackbox',
      landingStatus: 'completed',
      bundleDigest: 'sha256:bundle',
      createdAt: new Date('2026-06-29T23:03:00.000Z'),
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
        agentSession: transaction.agentSession,
      },
    };
    const portable = buildProofBundle({
      project: { id: 'project-1', workspaceSlug: 'acme' },
      transaction: {
        id: 'txn-1',
        projectId: 'project-1',
        mutationLeaseId: 'lease-1',
        readSet: [],
        writeSet: ['synthi/prisma/schema.prisma'],
        invariants: ['clearance.diff.inside_route'],
      },
      mutationLease: { id: 'lease-1', displayCallsign: 'ATLAS-1' },
      proofBundle: {
        ...bundle,
        invariants: ['clearance.diff.inside_route'],
        evidenceRefs: ['runtime:event:inspection-1'],
        dojoEvidenceRefs: [],
        repoState: repoStateFixture(),
        incidentReplayDigest: 'sha256:blackbox',
      },
    });
    bundle.proofSignatureJson = JSON.stringify(portable.proofSignature);
    bundle.signatureKeyId = portable.proofSignature.keyId;
    const trailers = proofCommitTrailers(portable);
    prisma.codeSiteProofBundle.findFirst.mockResolvedValue(bundle);
    prisma.codeSiteProofBundle.update.mockImplementation(async ({ data }) => ({
      ...bundle,
      ...data,
    }));

    const result = await attachProofBundleCommit('acme', 'proof-created', {
      commitSha: 'abc1234',
      commitMessage: [
        'Land schema-first proof',
        '',
        ...Object.entries(trailers).map(([key, value]) => `${key}: ${value}`),
      ].join('\n'),
      trailers: { ...trailers, 'CodeSite-Proof-Digest': 'sha256:forged' },
      evidenceRefs: ['git:show:abc1234'],
    }, { userId: 'user-1' });

    expect(result.commitSha).toBe('abc1234');
    expect(result.evidenceRefs).toEqual(['runtime:event:inspection-1']);
    expect(result.trailers['CodeSite-Proof-Digest']).toBe(trailers['CodeSite-Proof-Digest']);
    expect(result.trailers['CodeSite-Proof-Signature']).toBe(trailers['CodeSite-Proof-Signature']);
    expect(prisma.codeSiteProofBundle.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'proof-created' },
      data: expect.objectContaining({
        commitSha: 'abc1234',
      }),
    }));
    expect(prisma.codeSiteProofBundle.update.mock.calls[0][0].data).not.toHaveProperty('evidenceRefsJson');
    const commitEvent = prisma.codeSiteEvent.create.mock.calls
      .map((call) => call[0].data)
      .find((event) => event.actorType === 'proof_bundle');
    expect(commitEvent).toMatchObject({
      mutationLeaseId: 'lease-1',
      eventType: 'inspection_result',
      displayCallsign: 'ATLAS-1',
      actorId: 'proof-created',
    });
    expect(JSON.parse(commitEvent.evidenceRefsJson)).toEqual(expect.arrayContaining([
      'git:commit:abc1234',
      expect.stringMatching(/^git:commit-message:sha256:/),
      'git:show:abc1234',
    ]));
    expect(JSON.parse(commitEvent.detailsJson)).toMatchObject({
      type: 'proof_bundle_commit_attached',
      proofBundleId: 'proof-created',
      transactionId: 'txn-1',
      commitSha: 'abc1234',
      trailerSource: 'git_commit_message',
      commitMessageDigest: expect.stringMatching(/^sha256:/),
      reasonCodes: ['proof_bundle_actual_commit_trailers_verified'],
    });
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
    expect(result.decision.reasonCodes).toEqual(expect.arrayContaining([
      'line_provenance_required',
      'repo_state_line_range_coverage_required',
    ]));
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
    expect(result.decision.reasonCodes).toEqual(expect.arrayContaining([
      'line_provenance_required',
      'repo_state_line_range_coverage_required',
    ]));
    expect(result.decision.missingLineProvenancePaths).toEqual(['synthi/prisma/schema.prisma']);
    expect(prisma.codeSiteProofBundle.create).not.toHaveBeenCalled();
  });

  it('rejects strict line provenance that does not cover repo-state diff ranges', async () => {
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
            lineAnchor: 'synthi/prisma/schema.prisma#L12-L15',
            startLine: 12,
            endLine: 15,
            evidenceRefs: ['hunk:evidence'],
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
    const forgedRepoState = repoStateFixture([{
      filePath: 'synthi/prisma/schema.prisma',
      lineAnchor: 'synthi/prisma/schema.prisma#L40-L42',
      startLine: 40,
      endLine: 42,
      source: 'head_commit_diff',
    }]);

    const result = await commitTransaction('acme', 'txn-1', { repoState: forgedRepoState });

    expect(result.decision.ok).toBe(false);
    expect(result.decision.reasonCodes).toEqual(expect.arrayContaining([
      'line_provenance_required',
      'repo_state_line_range_coverage_required',
    ]));
    expect(result.decision.lineProvenance?.uncoveredRepoStateRanges).toEqual([expect.objectContaining({
      filePath: 'synthi/prisma/schema.prisma',
      startLine: 40,
      endLine: 42,
    })]);
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

  it('blocks proof-carrying commits when repo-state evidence lacks managed workspace identity', async () => {
    prisma.codeSiteInspectionRun.findMany.mockResolvedValue([passedLandingInspection()]);
    const repoState = repoStateFixture();
    repoState.repoIdentity = null;
    delete repoState.evidenceDigest;
    repoState.evidenceDigest = digest(repoState);

    const result = await commitTransaction('acme', 'txn-1', { repoState });

    expect(result.decision.ok).toBe(false);
    expect(result.decision.reasonCodes).toEqual(expect.arrayContaining([
      'repo_state_identity_required',
    ]));
    expect(result.decision.reasonCodes).not.toContain('repo_state_digest_mismatch');
    expect(prisma.codeSiteProofBundle.create).not.toHaveBeenCalled();
  });

  it('blocks replayed repo-state evidence from a different workspace or transaction', async () => {
    prisma.codeSiteInspectionRun.findMany.mockResolvedValue([passedLandingInspection()]);
    const repoState = repoStateFixture(undefined, {
      workspaceSlug: 'other-workspace',
      transactionId: 'txn-other',
    });

    const result = await commitTransaction('acme', 'txn-1', { repoState });

    expect(result.decision.ok).toBe(false);
    expect(result.decision.reasonCodes).toEqual(expect.arrayContaining([
      'repo_state_workspace_mismatch',
      'repo_state_transaction_mismatch',
      'repo_state_identity_workspace_mismatch',
      'repo_state_identity_transaction_mismatch',
    ]));
    expect(prisma.codeSiteProofBundle.create).not.toHaveBeenCalled();
  });

  it('blocks tampered repo-state evidence whose digest no longer matches normalized content', async () => {
    prisma.codeSiteInspectionRun.findMany.mockResolvedValue([passedLandingInspection()]);
    const repoState = repoStateFixture();
    repoState.writeFileDigests[0].digest = 'sha256:forged-file';

    const result = await commitTransaction('acme', 'txn-1', { repoState });

    expect(result.decision.ok).toBe(false);
    expect(result.decision.reasonCodes).toEqual(expect.arrayContaining([
      'repo_state_digest_mismatch',
    ]));
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
      repoState: expect.objectContaining({
        evidenceDigest: expect.stringMatching(/^sha256:/),
        repoIdentity: expect.objectContaining({
          identityDigest: expect.stringMatching(/^sha256:/),
          gitTopLevelMatchesRepoRoot: true,
        }),
      }),
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

  it('scores shadow merge strategies from semantic repo signals and persists a rich counterfactual scene', async () => {
    const zonePolicy = {
      zones: [
        { zoneKey: 'schema', label: 'Schema contract', class: 'B', paths: ['packages/schemas/**'], rules: ['api_contract_radar_required'] },
        { zoneKey: 'api', label: 'Auth API', class: 'B', paths: ['api/auth/**'], rules: ['api_contract_radar_required'] },
        { zoneKey: 'ui', label: 'Signup UI', class: 'C', paths: ['app/signup/**'], rules: [] },
      ],
      semanticGraph: {
        files: [
          'packages/schemas/auth.ts',
          'api/auth/signup.ts',
          'app/signup/page.tsx',
          'tests/auth/signup.test.ts',
        ],
        importEdges: [
          { from: 'api/auth/signup.ts', imports: ['packages/schemas/auth.ts'] },
          { from: 'app/signup/page.tsx', imports: ['packages/schemas/auth.ts'] },
        ],
        testOwnership: [
          { testPath: 'tests/auth/signup.test.ts', covers: ['packages/schemas/auth.ts', 'api/auth/signup.ts'] },
        ],
        migrationLocks: [],
        packageExports: [{ packageName: '@acme/contracts', root: 'packages/schemas', exports: ['packages/schemas/auth.ts'] }],
        generatedClients: ['app/generated/auth-client.ts'],
      },
    };
    prisma.codeSiteProject.findFirst
      .mockResolvedValueOnce({
        id: 'project-1',
        workspaceSlug: 'acme',
        title: 'Signup coordination',
        request: 'Coordinate signup schema and UI',
        status: 'active',
        zonePolicyJson: JSON.stringify(zonePolicy),
        controlPlanJson: JSON.stringify({}),
        executionPlans: [
          {
            id: 'plan-schema',
            projectId: 'project-1',
            agentSessionId: 'agent-schema',
            displayCallsign: 'SCHEMA-01',
            mission: 'Change signup contract',
            domain: 'schema',
            status: 'preflight',
            routeJson: JSON.stringify(['packages/schemas/auth.ts']),
            blockedZonesJson: JSON.stringify([]),
            abortJson: JSON.stringify([]),
            requestedToolsJson: JSON.stringify(['file_write', 'npm_test']),
            estimatedDurationMs: 120000,
            filedAt: new Date('2026-06-29T23:00:00.000Z'),
            closedAt: null,
          },
          {
            id: 'plan-ui',
            projectId: 'project-1',
            agentSessionId: 'agent-ui',
            displayCallsign: 'UI-02',
            mission: 'Build signup UI',
            domain: 'frontend',
            status: 'preflight',
            routeJson: JSON.stringify(['app/signup/page.tsx']),
            blockedZonesJson: JSON.stringify([]),
            abortJson: JSON.stringify([]),
            requestedToolsJson: JSON.stringify(['file_write', 'npm_test']),
            estimatedDurationMs: 120000,
            filedAt: new Date('2026-06-29T23:00:00.000Z'),
            closedAt: null,
          },
        ],
        mutationLeases: [],
        incidents: [{
          id: 'incident-auth-1',
          severity: 'medium',
          category: 'near_miss',
          participantsJson: JSON.stringify(['UI-02']),
          affectedZonesJson: JSON.stringify(['packages/schemas/**']),
          evidenceRefsJson: JSON.stringify(['incident:auth-schema']),
        }],
        inspectionRuns: [{
          id: 'inspection-auth-1',
          status: 'passed',
          changedPathsJson: JSON.stringify(['packages/schemas/auth.ts']),
          inspectionSignalsJson: JSON.stringify([{ key: 'auth.signup.test', status: 'passed' }]),
          evidenceRefsJson: JSON.stringify(['test:auth-signup']),
        }],
      })
      .mockResolvedValueOnce({
        id: 'project-1',
        workspaceSlug: 'acme',
        title: 'Signup coordination',
        request: 'Coordinate signup schema and UI',
        status: 'active',
        zonePolicyJson: JSON.stringify(zonePolicy),
        controlPlanJson: JSON.stringify({}),
      });
    prisma.codeSiteCounterfactualRun.create.mockImplementation(async ({ data }) => ({
      id: 'cfr-shadow-1',
      shadowJobRef: data.shadowJobRef,
      baseSnapshot: data.baseSnapshot,
      createdAt: new Date('2026-06-29T23:12:00.000Z'),
      ...data,
    }));

    const result = await withEnvCleared([
      'SYNTHI_CODESITE_SHADOW_RUNNER_COMMAND_JSON',
      'SYNTHI_CODESITE_SHADOW_RUNNER_COMMAND',
      'SYNTHI_CODESITE_SHADOW_RUNNER_ARGS_JSON',
      'SYNTHI_CODESITE_SHADOW_RUNNER_CWD',
    ], () => shadowMergeSimulate('acme', 'project-1', {
      strategies: ['schema-first', 'frontend/backend parallel', 'single fullstack agent', 'test-first'],
    }));

    expect(result.selected).toBe('schema-first');
    expect(result.universes.map((universe) => universe.strategy)).toContain('frontend-backend-parallel');
    expect(result.universes.map((universe) => universe.strategy)).toContain('single-fullstack-agent');
    const schemaUniverse = result.universes.find((universe) => universe.strategy === 'schema-first');
    const parallelUniverse = result.universes.find((universe) => universe.strategy === 'frontend-backend-parallel');
    expect(schemaUniverse.avoidedRisks).toContain('semantic_collision');
    expect(schemaUniverse.requiredTowerActions).toContain('refresh_downstream_assumptions');
    expect(schemaUniverse.sourceSignals).toMatchObject({
      importGraphEdges: 2,
      testOwners: 1,
      priorIncidents: 1,
      inspectionRuns: 1,
      contractRiskCount: 1,
    });
    expect(parallelUniverse.unresolvedRisks).toContain('semantic_collision');
    expect(result.evidenceRefs).toContain('codesite:incident:incident-auth-1');
    expect(result.evidenceRefs).toContain('codesite:inspection:inspection-auth-1');
    expect(result.evidenceRefs.some((ref) => ref.startsWith('codesite:repo-policy:'))).toBe(true);
    expect(prisma.codeSiteCounterfactualRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        shadowJobRef: expect.stringMatching(/^codesite-shadow:/),
        baseSnapshot: expect.stringMatching(/^repo@/),
        validityStrength: 'strong',
        evidenceRefsJson: expect.stringContaining('codesite:repo-policy:'),
        universesJson: expect.stringContaining('frontend-backend-parallel'),
        arbiterVerdictJson: expect.stringContaining('policyDeltaCandidates'),
      }),
    }));
    expect(prisma.codeSiteEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: 'shadow_run',
        actorType: 'counterfactual',
      }),
    }));
    expect(prisma.codeSiteEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: 'arbiter_verdict',
        detailsJson: expect.stringContaining('schema-first'),
      }),
    }));
  });

  it('blocks read-only project members from persisting shadow merge simulations', async () => {
    prisma.codeSiteProject.findFirst.mockResolvedValueOnce({
      id: 'project-1',
      workspaceSlug: 'acme',
      title: 'Signup coordination',
      request: 'Coordinate signup schema and UI',
      status: 'active',
      createdByUserId: 'user-1',
      zonePolicyJson: JSON.stringify({ zones: [] }),
      controlPlanJson: JSON.stringify({}),
      members: [{
        id: 'member-viewer',
        projectId: 'project-1',
        workspaceSlug: 'acme',
        userId: 'viewer-1',
        role: 'viewer',
        permissionsJson: JSON.stringify(['project:read']),
        redactionPolicyJson: null,
        participationStatus: 'enabled',
        revokedAt: null,
      }],
      agentSessions: [],
      executionPlans: [],
      mutationLeases: [],
      incidents: [],
      inspectionRuns: [],
    });

    await expect(shadowMergeSimulate('acme', 'project-1', {
      strategies: ['schema-first'],
    }, { userId: 'viewer-1' })).rejects.toMatchObject({
      status: 403,
      code: 'codesite_project_write_forbidden',
    });
    expect(prisma.codeSiteCounterfactualRun.create).not.toHaveBeenCalled();
    expect(prisma.codeSiteEvent.create).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: 'shadow_run' }),
    }));
  });

  it('executes configured shadow runner and records execution-backed counterfactual evidence', async () => {
    const previousRunnerCommand = process.env.SYNTHI_CODESITE_SHADOW_RUNNER_COMMAND_JSON;
    const runnerPath = path.resolve(process.cwd(), 'scripts/codesite-shadow-runner.mjs');
    process.env.SYNTHI_CODESITE_SHADOW_RUNNER_COMMAND_JSON = JSON.stringify([process.execPath, runnerPath]);

    try {
      const zonePolicy = {
        zones: [
          { zoneKey: 'schema', label: 'Schema contract', class: 'B', paths: ['packages/schemas/**'], rules: ['api_contract_radar_required'] },
          { zoneKey: 'api', label: 'Auth API', class: 'B', paths: ['api/auth/**'], rules: ['api_contract_radar_required'] },
          { zoneKey: 'ui', label: 'Signup UI', class: 'C', paths: ['app/signup/**'], rules: [] },
        ],
        semanticGraph: {
          files: [
            'packages/schemas/auth.ts',
            'api/auth/signup.ts',
            'app/signup/page.tsx',
            'tests/auth/signup.test.ts',
          ],
          importEdges: [
            { from: 'api/auth/signup.ts', imports: ['packages/schemas/auth.ts'] },
            { from: 'app/signup/page.tsx', imports: ['packages/schemas/auth.ts'] },
          ],
          testOwnership: [
            { testPath: 'tests/auth/signup.test.ts', covers: ['packages/schemas/auth.ts', 'api/auth/signup.ts'] },
          ],
          migrationLocks: [],
          packageExports: [{ packageName: '@acme/contracts', root: 'packages/schemas', exports: ['packages/schemas/auth.ts'] }],
          generatedClients: ['app/generated/auth-client.ts'],
        },
      };
      const project = {
        id: 'project-1',
        workspaceSlug: 'acme',
        title: 'Signup coordination',
        request: 'Coordinate signup schema and UI',
        status: 'active',
        zonePolicyJson: JSON.stringify(zonePolicy),
        controlPlanJson: JSON.stringify({}),
        executionPlans: [
          {
            id: 'plan-schema',
            projectId: 'project-1',
            agentSessionId: 'agent-schema',
            displayCallsign: 'SCHEMA-01',
            mission: 'Change signup contract',
            domain: 'schema',
            status: 'preflight',
            routeJson: JSON.stringify(['packages/schemas/auth.ts']),
            blockedZonesJson: JSON.stringify([]),
            abortJson: JSON.stringify([]),
            requestedToolsJson: JSON.stringify(['file_write', 'npm_test']),
            estimatedDurationMs: 120000,
            filedAt: new Date('2026-06-29T23:00:00.000Z'),
            closedAt: null,
          },
          {
            id: 'plan-ui',
            projectId: 'project-1',
            agentSessionId: 'agent-ui',
            displayCallsign: 'UI-02',
            mission: 'Build signup UI',
            domain: 'frontend',
            status: 'preflight',
            routeJson: JSON.stringify(['app/signup/page.tsx']),
            blockedZonesJson: JSON.stringify([]),
            abortJson: JSON.stringify([]),
            requestedToolsJson: JSON.stringify(['file_write', 'npm_test']),
            estimatedDurationMs: 120000,
            filedAt: new Date('2026-06-29T23:00:00.000Z'),
            closedAt: null,
          },
        ],
        mutationLeases: [],
        incidents: [],
        inspectionRuns: [],
      };
      prisma.codeSiteProject.findFirst.mockResolvedValueOnce(project).mockResolvedValueOnce(project);
      prisma.codeSiteCounterfactualRun.create.mockImplementation(async ({ data }) => ({
        id: 'cfr-shadow-executed',
        shadowJobRef: data.shadowJobRef,
        baseSnapshot: data.baseSnapshot,
        createdAt: new Date('2026-06-29T23:12:00.000Z'),
        ...data,
      }));

      const result = await shadowMergeSimulate('acme', 'project-1', {
        strategies: ['schema-first', 'frontend-backend-parallel', 'single-fullstack-agent'],
      });

      expect(result.reason.shadowExecutionMode).toBe('external_runner');
      expect(result.shadowExecution).toMatchObject({
        status: 'completed',
        runner: expect.any(String),
        executionMode: 'risk_budget_evaluation',
      });
      expect(result.shadowExecution.evidenceRefs.some((ref) => ref.startsWith('codesite:shadow-runner:'))).toBe(true);
      expect(result.evidenceRefs.some((ref) => ref.startsWith('codesite:shadow-runner:'))).toBe(true);
      expect(result.universes.every((universe) => universe.execution?.status)).toBe(true);
      expect(result.universes.some((universe) => universe.execution.status === 'near_miss')).toBe(true);
      expect(result.universes.some((universe) => universe.execution.status === 'passed')).toBe(true);
      expect(prisma.codeSiteCounterfactualRun.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          validityStrength: 'executed',
          evidenceRefsJson: expect.stringContaining('codesite:shadow-runner:'),
          universesJson: expect.stringContaining('shadow_universe_executed'),
          arbiterVerdictJson: expect.stringContaining('external_runner'),
        }),
      }));
    } finally {
      if (previousRunnerCommand === undefined) {
        delete process.env.SYNTHI_CODESITE_SHADOW_RUNNER_COMMAND_JSON;
      } else {
        process.env.SYNTHI_CODESITE_SHADOW_RUNNER_COMMAND_JSON = previousRunnerCommand;
      }
    }
  });

  it('executes real shadow-universe repo commands in isolated worktrees', async () => {
    const previousRunnerCommand = process.env.SYNTHI_CODESITE_SHADOW_RUNNER_COMMAND_JSON;
    const previousAllowedRoot = process.env.SYNTHI_CODESITE_SHADOW_RUNNER_ALLOWED_ROOT;
    const previousAllowInline = process.env.SYNTHI_CODESITE_SHADOW_RUNNER_ALLOW_INLINE_COMMANDS;
    const previousAuthSecret = process.env.AUTH_SECRET;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const runnerPath = path.resolve(process.cwd(), 'scripts/codesite-shadow-runner.mjs');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codesite-shadow-repo-'));
    const repoRoot = path.join(root, 'repo');
    process.env.SYNTHI_CODESITE_SHADOW_RUNNER_COMMAND_JSON = JSON.stringify([process.execPath, runnerPath]);
    process.env.SYNTHI_CODESITE_SHADOW_RUNNER_ALLOWED_ROOT = root;
    process.env.SYNTHI_CODESITE_SHADOW_RUNNER_ALLOW_INLINE_COMMANDS = '1';
    process.env.AUTH_SECRET = 'shadow-runner-test-secret';
    process.env.DATABASE_URL = 'postgresql://shadow-runner-secret@example.invalid/db';

    try {
      await fs.mkdir(path.join(repoRoot, 'scripts'), { recursive: true });
      await fs.writeFile(path.join(repoRoot, 'contract.txt'), 'v1\n', 'utf8');
      await fs.writeFile(path.join(repoRoot, 'scripts', 'check-contract.mjs'), [
        "import fs from 'node:fs';",
        'if (process.env.AUTH_SECRET || process.env.DATABASE_URL) {',
        "  console.error('shadow command received server secret environment');",
        '  process.exit(1);',
        '}',
        "const contract = fs.readFileSync('contract.txt', 'utf8').trim();",
        "if (contract !== 'v2') {",
        "  console.error(`contract check failed: expected v2, received ${contract}`);",
        '  process.exit(1);',
        '}',
        "console.log('contract check passed: v2');",
        '',
      ].join('\n'), 'utf8');

      const zonePolicy = {
        zones: [
          { zoneKey: 'contract', label: 'Shared contract', class: 'B', paths: ['contract.txt'], rules: ['api_contract_radar_required'] },
          { zoneKey: 'consumer', label: 'Consumer', class: 'C', paths: ['app/**'], rules: [] },
        ],
        semanticGraph: {
          files: ['contract.txt', 'app/index.ts', 'scripts/check-contract.mjs'],
          importEdges: [{ from: 'app/index.ts', imports: ['contract.txt'] }],
          testOwnership: [{ testPath: 'scripts/check-contract.mjs', covers: ['contract.txt'] }],
        },
      };
      const project = {
        id: 'project-1',
        workspaceSlug: 'acme',
        title: 'Contract coordination',
        request: 'Land shared contract before consumers update',
        status: 'active',
        zonePolicyJson: JSON.stringify(zonePolicy),
        controlPlanJson: JSON.stringify({}),
        executionPlans: [
          {
            id: 'plan-contract',
            projectId: 'project-1',
            agentSessionId: 'agent-contract',
            displayCallsign: 'CONTRACT-01',
            mission: 'Change shared contract',
            domain: 'schema',
            status: 'preflight',
            routeJson: JSON.stringify(['contract.txt']),
            blockedZonesJson: JSON.stringify([]),
            abortJson: JSON.stringify([]),
            requestedToolsJson: JSON.stringify(['file_write', 'npm_test']),
            estimatedDurationMs: 120000,
            filedAt: new Date('2026-06-29T23:00:00.000Z'),
            closedAt: null,
          },
          {
            id: 'plan-consumer',
            projectId: 'project-1',
            agentSessionId: 'agent-consumer',
            displayCallsign: 'APP-02',
            mission: 'Update consumer',
            domain: 'frontend',
            status: 'preflight',
            routeJson: JSON.stringify(['app/index.ts']),
            blockedZonesJson: JSON.stringify([]),
            abortJson: JSON.stringify([]),
            requestedToolsJson: JSON.stringify(['file_write', 'npm_test']),
            estimatedDurationMs: 120000,
            filedAt: new Date('2026-06-29T23:00:00.000Z'),
            closedAt: null,
          },
        ],
        mutationLeases: [],
        incidents: [],
        inspectionRuns: [],
      };
      prisma.codeSiteProject.findFirst.mockResolvedValueOnce(project).mockResolvedValueOnce(project);
      prisma.codeSiteCounterfactualRun.create.mockImplementation(async ({ data }) => ({
        id: 'cfr-shadow-repo-executed',
        shadowJobRef: data.shadowJobRef,
        baseSnapshot: data.baseSnapshot,
        createdAt: new Date('2026-06-29T23:12:00.000Z'),
        ...data,
      }));

      const result = await shadowMergeSimulate('acme', 'project-1', {
        strategies: ['schema-first', 'frontend-backend-parallel'],
        shadowExecutionPlan: {
          repoRoot,
          commands: [{
            label: 'contract-check',
            command: process.execPath,
            args: ['scripts/check-contract.mjs'],
          }],
          universes: {
            'schema-first': {
              patches: [{ path: 'contract.txt', content: 'v2\n' }],
            },
          },
        },
      });

      expect(result.reason.shadowExecutionMode).toBe('external_runner');
      expect(result.shadowExecution).toMatchObject({
        status: 'completed',
        executionMode: 'repo_command_execution',
      });
      const schemaFirst = result.universes.find((universe) => universe.strategy === 'schema-first');
      const parallel = result.universes.find((universe) => universe.strategy === 'frontend-backend-parallel');
      expect(schemaFirst.execution).toMatchObject({
        status: 'passed',
        command: 'codesite-shadow-runner:repo-command-execution',
        exitCode: 0,
      });
      expect(parallel.execution).toMatchObject({
        status: 'near_miss',
        command: 'codesite-shadow-runner:repo-command-execution',
        exitCode: 1,
      });
      expect(schemaFirst.reasonCodes).toContain('shadow_universe_repo_commands_passed');
      expect(parallel.reasonCodes).toContain('shadow_universe_repo_commands_failed');
      expect(schemaFirst.evidenceRefs.some((ref) => ref.includes('codesite:shadow-command:schema-first:contract-check:'))).toBe(true);
      expect(prisma.codeSiteCounterfactualRun.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          validityStrength: 'executed',
          universesJson: expect.stringContaining('repo_command_execution'),
          evidenceRefsJson: expect.stringContaining('codesite:shadow-command:schema-first:contract-check:'),
        }),
      }));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      if (previousRunnerCommand === undefined) {
        delete process.env.SYNTHI_CODESITE_SHADOW_RUNNER_COMMAND_JSON;
      } else {
        process.env.SYNTHI_CODESITE_SHADOW_RUNNER_COMMAND_JSON = previousRunnerCommand;
      }
      if (previousAllowedRoot === undefined) {
        delete process.env.SYNTHI_CODESITE_SHADOW_RUNNER_ALLOWED_ROOT;
      } else {
        process.env.SYNTHI_CODESITE_SHADOW_RUNNER_ALLOWED_ROOT = previousAllowedRoot;
      }
      if (previousAllowInline === undefined) {
        delete process.env.SYNTHI_CODESITE_SHADOW_RUNNER_ALLOW_INLINE_COMMANDS;
      } else {
        process.env.SYNTHI_CODESITE_SHADOW_RUNNER_ALLOW_INLINE_COMMANDS = previousAllowInline;
      }
      if (previousAuthSecret === undefined) {
        delete process.env.AUTH_SECRET;
      } else {
        process.env.AUTH_SECRET = previousAuthSecret;
      }
      if (previousDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
    }
  });

  it('blocks shadow runner absolute command paths that only match an allowed basename', async () => {
    const previousRunnerCommand = process.env.SYNTHI_CODESITE_SHADOW_RUNNER_COMMAND_JSON;
    const previousAllowedRoot = process.env.SYNTHI_CODESITE_SHADOW_RUNNER_ALLOWED_ROOT;
    const previousAllowInline = process.env.SYNTHI_CODESITE_SHADOW_RUNNER_ALLOW_INLINE_COMMANDS;
    const runnerPath = path.resolve(process.cwd(), 'scripts/codesite-shadow-runner.mjs');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codesite-shadow-bin-'));
    const repoRoot = path.join(root, 'repo');
    const fakeNode = path.join(root, 'node');
    process.env.SYNTHI_CODESITE_SHADOW_RUNNER_COMMAND_JSON = JSON.stringify([process.execPath, runnerPath]);
    process.env.SYNTHI_CODESITE_SHADOW_RUNNER_ALLOWED_ROOT = root;
    process.env.SYNTHI_CODESITE_SHADOW_RUNNER_ALLOW_INLINE_COMMANDS = '1';

    try {
      await fs.mkdir(repoRoot, { recursive: true });
      await fs.writeFile(path.join(repoRoot, 'contract.txt'), 'v1\n', 'utf8');
      await fs.writeFile(fakeNode, '#!/bin/sh\necho fake node should not run\nexit 0\n', { mode: 0o755 });

      const project = {
        id: 'project-1',
        workspaceSlug: 'acme',
        title: 'Absolute binary guard',
        request: 'Do not run path-spoofed binaries',
        status: 'active',
        zonePolicyJson: JSON.stringify({ zones: [] }),
        controlPlanJson: JSON.stringify({}),
        executionPlans: [],
        mutationLeases: [],
        incidents: [],
        inspectionRuns: [],
      };
      prisma.codeSiteProject.findFirst.mockResolvedValueOnce(project).mockResolvedValueOnce(project);
      prisma.codeSiteCounterfactualRun.create.mockImplementation(async ({ data }) => ({
        id: 'cfr-shadow-blocked-bin',
        shadowJobRef: data.shadowJobRef,
        baseSnapshot: data.baseSnapshot,
        createdAt: new Date('2026-06-29T23:12:00.000Z'),
        ...data,
      }));

      const result = await shadowMergeSimulate('acme', 'project-1', {
        strategies: ['schema-first'],
        shadowExecutionPlan: {
          repoRoot,
          commands: [{
            label: 'fake-node',
            command: fakeNode,
            args: [],
          }],
        },
      });

      const schemaFirst = result.universes.find((universe) => universe.strategy === 'schema-first');
      expect(schemaFirst.execution).toMatchObject({
        status: 'near_miss',
        command: 'codesite-shadow-runner:repo-command-execution',
        exitCode: 126,
        executionMode: 'repo_command_execution',
      });
      expect(schemaFirst.reasonCodes).toContain('shadow_universe_repo_commands_failed');
      expect(JSON.stringify(schemaFirst)).not.toContain('fake node should not run');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      if (previousRunnerCommand === undefined) {
        delete process.env.SYNTHI_CODESITE_SHADOW_RUNNER_COMMAND_JSON;
      } else {
        process.env.SYNTHI_CODESITE_SHADOW_RUNNER_COMMAND_JSON = previousRunnerCommand;
      }
      if (previousAllowedRoot === undefined) {
        delete process.env.SYNTHI_CODESITE_SHADOW_RUNNER_ALLOWED_ROOT;
      } else {
        process.env.SYNTHI_CODESITE_SHADOW_RUNNER_ALLOWED_ROOT = previousAllowedRoot;
      }
      if (previousAllowInline === undefined) {
        delete process.env.SYNTHI_CODESITE_SHADOW_RUNNER_ALLOW_INLINE_COMMANDS;
      } else {
        process.env.SYNTHI_CODESITE_SHADOW_RUNNER_ALLOW_INLINE_COMMANDS = previousAllowInline;
      }
    }
  });

  it('keeps inline shadow repo commands disabled by default', async () => {
    const previousRunnerCommand = process.env.SYNTHI_CODESITE_SHADOW_RUNNER_COMMAND_JSON;
    const previousAllowedRoot = process.env.SYNTHI_CODESITE_SHADOW_RUNNER_ALLOWED_ROOT;
    const previousAllowInline = process.env.SYNTHI_CODESITE_SHADOW_RUNNER_ALLOW_INLINE_COMMANDS;
    const runnerPath = path.resolve(process.cwd(), 'scripts/codesite-shadow-runner.mjs');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codesite-shadow-disabled-'));
    const repoRoot = path.join(root, 'repo');
    const markerPath = path.join(repoRoot, 'command-ran.txt');
    process.env.SYNTHI_CODESITE_SHADOW_RUNNER_COMMAND_JSON = JSON.stringify([process.execPath, runnerPath]);
    process.env.SYNTHI_CODESITE_SHADOW_RUNNER_ALLOWED_ROOT = root;
    delete process.env.SYNTHI_CODESITE_SHADOW_RUNNER_ALLOW_INLINE_COMMANDS;

    try {
      await fs.mkdir(repoRoot, { recursive: true });
      await fs.writeFile(path.join(repoRoot, 'write-marker.mjs'), [
        "import fs from 'node:fs';",
        "fs.writeFileSync('command-ran.txt', 'executed');",
        '',
      ].join('\n'), 'utf8');

      const project = {
        id: 'project-1',
        workspaceSlug: 'acme',
        title: 'Inline disabled',
        request: 'Do not execute inline commands by default',
        status: 'active',
        zonePolicyJson: JSON.stringify({ zones: [] }),
        controlPlanJson: JSON.stringify({}),
        executionPlans: [],
        mutationLeases: [],
        incidents: [],
        inspectionRuns: [],
      };
      prisma.codeSiteProject.findFirst.mockResolvedValueOnce(project).mockResolvedValueOnce(project);
      prisma.codeSiteCounterfactualRun.create.mockImplementation(async ({ data }) => ({
        id: 'cfr-shadow-inline-disabled',
        shadowJobRef: data.shadowJobRef,
        baseSnapshot: data.baseSnapshot,
        createdAt: new Date('2026-06-29T23:12:00.000Z'),
        ...data,
      }));

      const result = await shadowMergeSimulate('acme', 'project-1', {
        strategies: ['schema-first'],
        shadowExecutionPlan: {
          repoRoot,
          commands: [{
            label: 'write-marker',
            command: process.execPath,
            args: ['write-marker.mjs'],
          }],
        },
      });

      const schemaFirst = result.universes.find((universe) => universe.strategy === 'schema-first');
      expect(schemaFirst.execution).toMatchObject({
        command: 'codesite-shadow-runner:evaluate-risk-budget',
        executionMode: 'risk_budget_evaluation',
      });
      await expect(fs.access(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      if (previousRunnerCommand === undefined) {
        delete process.env.SYNTHI_CODESITE_SHADOW_RUNNER_COMMAND_JSON;
      } else {
        process.env.SYNTHI_CODESITE_SHADOW_RUNNER_COMMAND_JSON = previousRunnerCommand;
      }
      if (previousAllowedRoot === undefined) {
        delete process.env.SYNTHI_CODESITE_SHADOW_RUNNER_ALLOWED_ROOT;
      } else {
        process.env.SYNTHI_CODESITE_SHADOW_RUNNER_ALLOWED_ROOT = previousAllowedRoot;
      }
      if (previousAllowInline === undefined) {
        delete process.env.SYNTHI_CODESITE_SHADOW_RUNNER_ALLOW_INLINE_COMMANDS;
      } else {
        process.env.SYNTHI_CODESITE_SHADOW_RUNNER_ALLOW_INLINE_COMMANDS = previousAllowInline;
      }
    }
  });

  it('applies promoted counterfactual policy deltas to future tower simulation', async () => {
    const zonePolicy = {
      zones: [
        { zoneKey: 'schema', label: 'Schema contract', class: 'B', paths: ['packages/schemas/**'], rules: ['api_contract_radar_required'] },
        { zoneKey: 'ui', label: 'Signup UI', class: 'C', paths: ['app/signup/**'], rules: [] },
      ],
      semanticGraph: {
        files: ['packages/schemas/auth.ts', 'app/signup/page.tsx', 'tests/auth/signup.test.ts'],
        importEdges: [{ from: 'app/signup/page.tsx', imports: ['packages/schemas/auth.ts'] }],
        testOwnership: [{ testPath: 'tests/auth/signup.test.ts', covers: ['packages/schemas/auth.ts', 'app/signup/page.tsx'] }],
        migrationLocks: [],
        packageExports: [{ packageName: '@acme/contracts', root: 'packages/schemas', exports: ['packages/schemas/auth.ts'] }],
        generatedClients: [],
      },
    };
    const project = {
      id: 'project-1',
      workspaceSlug: 'acme',
      title: 'Learned coordination',
      request: 'Coordinate signup schema and UI',
      status: 'active',
      zonePolicyJson: JSON.stringify(zonePolicy),
      controlPlanJson: JSON.stringify({}),
      executionPlans: [
        {
          id: 'plan-schema',
          projectId: 'project-1',
          agentSessionId: 'agent-schema',
          displayCallsign: 'SCHEMA-01',
          mission: 'Change signup contract',
          domain: 'schema',
          status: 'preflight',
          routeJson: JSON.stringify(['packages/schemas/auth.ts']),
          blockedZonesJson: JSON.stringify([]),
          abortJson: JSON.stringify([]),
          requestedToolsJson: JSON.stringify(['file_write']),
          filedAt: new Date('2026-06-29T23:00:00.000Z'),
          closedAt: null,
        },
        {
          id: 'plan-ui',
          projectId: 'project-1',
          agentSessionId: 'agent-ui',
          displayCallsign: 'UI-02',
          mission: 'Build signup UI',
          domain: 'frontend',
          status: 'preflight',
          routeJson: JSON.stringify(['app/signup/page.tsx']),
          blockedZonesJson: JSON.stringify([]),
          abortJson: JSON.stringify([]),
          requestedToolsJson: JSON.stringify(['file_write']),
          filedAt: new Date('2026-06-29T23:00:00.000Z'),
          closedAt: null,
        },
      ],
      mutationLeases: [],
      incidents: [],
      inspectionRuns: [],
    };
    prisma.codeSiteProject.findFirst.mockResolvedValueOnce(project).mockResolvedValueOnce(project);
    prisma.codeSitePolicyDelta.findMany.mockResolvedValueOnce([
      {
        id: 'delta-test-first',
        projectId: 'older-project',
        learnedFromIncidentsJson: JSON.stringify(['near-miss-signup-1']),
        affectedZoneKey: null,
        ruleCandidateJson: JSON.stringify({
          rule: 'contract_churn_requires_owned_tests',
          preferredStrategies: ['test-first'],
          avoidStrategies: ['schema-first', 'frontend-backend-parallel'],
          requiredTowerActions: ['run_owned_tests_before_landing'],
        }),
        triggerConditionsJson: JSON.stringify([{ risk: 'semantic_collision' }, { path: 'packages/schemas/**' }]),
        expectedRiskReduction: 0.6,
        confidence: 0.95,
        promotionState: 'promoted',
        replayRefsJson: JSON.stringify(['codesite:counterfactual-run:cfr-old']),
        createdAt: new Date('2026-06-29T23:12:00.000Z'),
        promotedAt: new Date('2026-06-29T23:13:00.000Z'),
      },
      {
        id: 'delta-proposed-ignored',
        projectId: 'older-project',
        learnedFromIncidentsJson: JSON.stringify([]),
        affectedZoneKey: null,
        ruleCandidateJson: JSON.stringify({ preferredStrategies: ['single-fullstack-agent'] }),
        triggerConditionsJson: JSON.stringify([{ risk: 'semantic_collision' }]),
        expectedRiskReduction: 0.6,
        confidence: 0.95,
        promotionState: 'proposed',
        replayRefsJson: JSON.stringify([]),
        createdAt: new Date('2026-06-29T23:12:00.000Z'),
        promotedAt: null,
      },
    ]);
    prisma.codeSiteCounterfactualRun.create.mockImplementation(async ({ data }) => ({
      id: 'cfr-shadow-learned',
      shadowJobRef: data.shadowJobRef,
      baseSnapshot: data.baseSnapshot,
      createdAt: new Date('2026-06-29T23:12:00.000Z'),
      ...data,
    }));

    const result = await shadowMergeSimulate('acme', 'project-1', {
      strategies: ['schema-first', 'frontend-backend-parallel', 'test-first'],
    });

    expect(result.selected).toBe('test-first');
    expect(result.appliedPolicyDeltas).toEqual(['delta-test-first']);
    expect(result.evidenceRefs).toContain('codesite:policy-delta:delta-test-first');
    const testUniverse = result.universes.find((universe) => universe.strategy === 'test-first');
    expect(testUniverse.reasonCodes).toEqual(expect.arrayContaining([
      'learned_policy_delta_preferred_strategy',
      'counterfactual_policy_delta_applied',
    ]));
    expect(testUniverse.learnedPolicyDeltaRefs).toEqual(['delta-test-first']);
    expect(testUniverse.sourceSignals.learnedPolicyDeltas).toBe(1);
    const schemaUniverse = result.universes.find((universe) => universe.strategy === 'schema-first');
    expect(schemaUniverse.reasonCodes).toContain('learned_policy_delta_avoided_strategy');
    expect(schemaUniverse.reasonCodes).not.toContain('learned_policy_delta_preferred_strategy');
  });

  it('requires policy deltas to start proposed before promotion governance', async () => {
    prisma.codeSiteProject.findFirst.mockResolvedValueOnce({
      id: 'project-1',
      workspaceSlug: 'acme',
    });

    await expect(createPolicyDelta('acme', 'project-1', {
      promotionState: 'active',
      ruleCandidate: { rule: 'test_first_for_contract_churn', preferredStrategies: ['test-first'] },
      confidence: 0.9,
    })).rejects.toMatchObject({
      code: 'policy_delta_create_must_start_proposed',
      status: 400,
    });
    expect(prisma.codeSitePolicyDelta.create).not.toHaveBeenCalled();
  });

  it('blocks policy delta promotion without replay validation evidence', async () => {
    prisma.codeSiteProject.findFirst.mockResolvedValueOnce({
      id: 'project-1',
      workspaceSlug: 'acme',
    });
    prisma.codeSitePolicyDelta.findFirst.mockResolvedValueOnce({
      id: 'delta-1',
      projectId: 'project-1',
      learnedFromIncidentsJson: JSON.stringify([]),
      affectedZoneKey: null,
      ruleCandidateJson: JSON.stringify({ rule: 'test_first_for_contract_churn', preferredStrategies: ['test-first'] }),
      triggerConditionsJson: JSON.stringify([]),
      expectedRiskReduction: 0.4,
      confidence: 0.9,
      promotionState: 'proposed',
      replayRefsJson: JSON.stringify([]),
      createdAt: new Date('2026-06-29T23:13:00.000Z'),
      promotedAt: null,
    });

    await expect(promotePolicyDelta('acme', 'project-1', 'delta-1', {}, { userId: 'reviewer-1' }))
      .rejects.toMatchObject({
        code: 'policy_delta_promotion_not_validated',
        status: 400,
        detail: {
          reasonCodes: expect.arrayContaining([
            'policy_delta_replay_validation_required',
            'policy_delta_replay_ref_required',
            'policy_delta_validation_evidence_required',
          ]),
        },
      });
    expect(prisma.codeSitePolicyDelta.update).not.toHaveBeenCalled();
  });

  it('promotes policy deltas only after replay validation and reviewer attribution', async () => {
    prisma.codeSiteProject.findFirst.mockResolvedValueOnce({
      id: 'project-1',
      workspaceSlug: 'acme',
    });
    prisma.codeSitePolicyDelta.findFirst.mockResolvedValueOnce({
      id: 'delta-1',
      projectId: 'project-1',
      learnedFromIncidentsJson: JSON.stringify(['near-miss-1']),
      affectedZoneKey: null,
      ruleCandidateJson: JSON.stringify({ rule: 'test_first_for_contract_churn', preferredStrategies: ['test-first'] }),
      triggerConditionsJson: JSON.stringify([{ risk: 'semantic_collision' }]),
      expectedRiskReduction: 0.4,
      confidence: 0.9,
      promotionState: 'proposed',
      replayRefsJson: JSON.stringify(['codesite:counterfactual-run:cfr-1']),
      createdAt: new Date('2026-06-29T23:13:00.000Z'),
      promotedAt: null,
    });

    const result = await promotePolicyDelta('acme', 'project-1', 'delta-1', {
      targetState: 'active',
      validation: {
        status: 'passed',
        evidenceRefs: ['replay:evidence:delta-1'],
      },
    }, { userId: 'reviewer-1' });

    expect(result.promotionState).toBe('active');
    const update = prisma.codeSitePolicyDelta.update.mock.calls[0][0];
    expect(update.data.promotionState).toBe('active');
    expect(JSON.parse(update.data.replayRefsJson)).toContain('codesite:counterfactual-run:cfr-1');
    expect(JSON.parse(update.data.ruleCandidateJson).promotion).toMatchObject({
      reviewedBy: 'reviewer-1',
      validationStatus: 'passed',
      evidenceRefs: ['replay:evidence:delta-1'],
    });
    expect(prisma.codeSiteEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: 'policy_delta_promoted',
        actorId: 'delta-1',
      }),
    }));
  });

  it('holds matching lease requests when active counterfactual policy requires sequencing', async () => {
    const plan = executionPlanFixture(['src/components/SignupForm.tsx']);
    plan.domain = 'frontend';
    plan.project.zonePolicyJson = JSON.stringify({
      zones: [
        { zoneKey: 'signup-ui', class: 'C', label: 'Signup UI', paths: ['src/components/**'], rules: [], risk: 'medium' },
      ],
      noFlyZones: ['secrets/**'],
    });
    prisma.codeSiteExecutionPlan.findFirst.mockResolvedValueOnce(plan);
    prisma.codeSitePolicyDelta.findMany.mockResolvedValueOnce([
      {
        id: 'delta-sequence-ui',
        projectId: 'older-project',
        learnedFromIncidentsJson: JSON.stringify(['near-miss-ui-1']),
        affectedZoneKey: 'Signup-UI',
        ruleCandidateJson: JSON.stringify({
          rule: 'sequence_frontend_after_contract_rfi',
          decision: 'hold',
          requiredRadar: ['visual'],
          requiredTowerActions: ['sequence_after_contract_response'],
        }),
        triggerConditionsJson: JSON.stringify([{ path: 'src/components/**' }]),
        expectedRiskReduction: 0.3,
        confidence: 0.9,
        promotionState: 'active',
        replayRefsJson: JSON.stringify(['codesite:counterfactual-run:cfr-ui']),
        createdAt: new Date('2026-06-29T23:12:00.000Z'),
        promotedAt: new Date('2026-06-29T23:13:00.000Z'),
      },
    ]);

    const lease = await requestMutationLease('acme', 'plan-1', {
      allowedPaths: ['src/components/SignupForm.tsx'],
      allowedTools: ['file_write'],
      requiredRadar: ['tests'],
    }, { userId: 'user-1' });

    expect(lease.status).toBe('holding');
    expect(lease.lease.requiredRadar).toEqual(expect.arrayContaining(['tests', 'visual']));
    expect(lease.lease.counterfactualPolicy).toMatchObject({
      appliedPolicyDeltas: ['delta-sequence-ui'],
      reasonCodes: expect.arrayContaining(['counterfactual_policy_delta_hold']),
    });
    expect(lease.policyDecision.reasonCodes).toEqual(expect.arrayContaining([
      'counterfactual_policy_delta_applied',
      'counterfactual_policy_delta_hold',
    ]));
  });

  it('treats migration-only simulator pressure as a single runway problem', async () => {
    const zonePolicy = {
      zones: [
        {
          zoneKey: 'migrations',
          label: 'Migration runway',
          class: 'A',
          paths: ['prisma/migrations/**'],
          rules: ['single_migration_runway_lock', 'migration_radar_required'],
        },
      ],
      semanticGraph: {
        files: [
          'prisma/migrations/202607010001_init/migration.sql',
          'prisma/migrations/202607010002_accounts/migration.sql',
        ],
        importEdges: [],
        testOwnership: [],
        migrationLocks: ['prisma/migrations/**'],
        packageExports: [],
        generatedClients: [],
      },
    };
    prisma.codeSiteProject.findFirst
      .mockResolvedValueOnce({
        id: 'project-1',
        workspaceSlug: 'acme',
        title: 'Migration coordination',
        request: 'Coordinate two migrations',
        status: 'active',
        zonePolicyJson: JSON.stringify(zonePolicy),
        controlPlanJson: JSON.stringify({}),
        executionPlans: [
          {
            id: 'plan-migration-a',
            projectId: 'project-1',
            displayCallsign: 'DB-01',
            mission: 'Add auth table',
            domain: 'backend',
            status: 'preflight',
            routeJson: JSON.stringify(['prisma/migrations/202607010001_init/migration.sql']),
            blockedZonesJson: JSON.stringify([]),
            abortJson: JSON.stringify([]),
            requestedToolsJson: JSON.stringify(['file_write', 'npm_test']),
            estimatedDurationMs: 120000,
            filedAt: new Date('2026-06-29T23:00:00.000Z'),
            closedAt: null,
          },
          {
            id: 'plan-migration-b',
            projectId: 'project-1',
            displayCallsign: 'DB-02',
            mission: 'Add accounts table',
            domain: 'backend',
            status: 'preflight',
            routeJson: JSON.stringify(['prisma/migrations/202607010002_accounts/migration.sql']),
            blockedZonesJson: JSON.stringify([]),
            abortJson: JSON.stringify([]),
            requestedToolsJson: JSON.stringify(['file_write', 'npm_test']),
            estimatedDurationMs: 120000,
            filedAt: new Date('2026-06-29T23:00:00.000Z'),
            closedAt: null,
          },
        ],
        mutationLeases: [],
        incidents: [],
        inspectionRuns: [],
      })
      .mockResolvedValueOnce({
        id: 'project-1',
        workspaceSlug: 'acme',
        title: 'Migration coordination',
        request: 'Coordinate two migrations',
        status: 'active',
        zonePolicyJson: JSON.stringify(zonePolicy),
        controlPlanJson: JSON.stringify({}),
      });
    prisma.codeSiteCounterfactualRun.create.mockImplementation(async ({ data }) => ({
      id: 'cfr-shadow-migration',
      shadowJobRef: data.shadowJobRef,
      baseSnapshot: data.baseSnapshot,
      createdAt: new Date('2026-06-29T23:12:00.000Z'),
      ...data,
    }));

    const result = await shadowMergeSimulate('acme', 'project-1', { strategies: [] });

    expect(result.selected).toBe('single-fullstack-agent');
    const selected = result.universes.find((universe) => universe.strategy === result.selected);
    const schema = result.universes.find((universe) => universe.strategy === 'schema-first');
    expect(selected.requiredTowerActions).toContain('single_migration_runway_lock');
    expect(selected.avoidedRisks).toContain('migration_collision');
    expect(selected.sourceSignals).toMatchObject({
      migrationRiskCount: 1,
      migrationLocks: 1,
      contractRiskCount: 0,
    });
    expect(schema.unresolvedRisks).toContain('migration_collision');
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
