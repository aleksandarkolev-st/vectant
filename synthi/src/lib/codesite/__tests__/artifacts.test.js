import { describe, expect, it } from 'vitest';
import { buildArtifactProjection, codesiteSchemas } from '../artifacts.js';
import { buildProofBundle, formatCommitTrailers, verifyProofBundle } from '../proof.js';

function projectFixture() {
  return {
    id: 'site_signup_email_verification',
    workspaceSlug: 'acme',
    title: 'Signup email verification',
    request: 'Build signup with email verification',
    status: 'active',
    zonePolicy: {
      zones: [{ zoneKey: 'class_b', class: 'B', paths: ['packages/schemas/**'], rules: ['change_order_for_mutation'] }],
      noFlyZones: ['infra/prod/**'],
      classRules: { B: ['change_order_for_mutation'] },
    },
    controlPlan: { selectedStrategy: 'schema-first' },
    agentSessions: [{ id: 'ags-1', displayCallsign: 'CODEX-04', ownerUserId: 'user-1' }],
    executionPlans: [{ id: 'plan-1', agentSessionId: 'ags-1', displayCallsign: 'CODEX-04', route: ['packages/schemas/auth/**'], status: 'filed' }],
    mutationLeases: [{ id: 'lease-1', agentSessionId: 'ags-1', displayCallsign: 'CODEX-04', status: 'active', lease: { allowedPaths: ['packages/schemas/auth/**'] } }],
    mutationTxns: [{ id: 'txn-1', agentSessionId: 'ags-1', mutationLeaseId: 'lease-1', readSet: ['packages/schemas/auth/signup.ts'], writeSet: ['packages/schemas/auth/signup.ts'], invariants: ['api-contract:pass'] }],
    assumptions: [{ id: 'asm-1', ownerSessionId: 'ags-1', status: 'active', assumptionKey: 'auth.signup.v2' }],
    events: [{ id: 'evt-1', eventType: 'clearance_issued', details: { mutationLeaseId: 'lease-1' } }],
    incidents: [{ id: 'inc-1', category: 'near_miss', severity: 'medium', replayDigest: 'sha256:replay', incidentReplay: { events: ['evt-1'] } }],
    proofBundles: [{ id: 'proof-1', transactionId: 'txn-1', readSetDigest: 'sha256:read', writeSetDigest: 'sha256:write', invariants: ['api-contract:pass'], evidenceRefs: ['ev-1'], bundleDigest: 'sha256:bundle' }],
    lineProvenance: [{ filePath: 'packages/schemas/auth/signup.ts', lineAnchor: 'L1', displayCallsign: 'CODEX-04', proofBundleId: 'proof-1' }],
    policyDecisions: [],
    inspectionRuns: [],
    documents: [],
    counterfactualRuns: [],
    policyDeltas: [],
    inboxItems: [],
  };
}

describe('CodeSite artifact projection', () => {
  it('emits agent-readable manifest, schemas, flight files, events, handover, and proof files', () => {
    const files = buildArtifactProjection(projectFixture(), {
      projectId: 'site_signup_email_verification',
      collisionForecast: { riskLevel: 'high', risks: [{ severity: 'high', risk: 'contract_collision', conflictZone: 'packages/schemas/auth/**' }] },
    });
    const paths = files.map((file) => file.relativePath);

    expect(paths).toContain('manifest.json');
    expect(paths).toContain('schemas/execution-plan.schema.json');
    expect(paths).toContain('projects/site_signup_email_verification/events.jsonl');
    expect(paths).toContain('projects/site_signup_email_verification/flights/CODEX-04/flight-plan.json');
    expect(paths).toContain('projects/site_signup_email_verification/flights/CODEX-04/clearance.json');
    expect(paths).toContain('projects/site_signup_email_verification/near-misses/inc-1.json');
    expect(paths).toContain('projects/site_signup_email_verification/proof-bundles/proof-1.proof.json');
    expect(paths).toContain('projects/site_signup_email_verification/proof-bundles/proof-1.trailers.txt');
    expect(paths).toContain('projects/site_signup_email_verification/handover.md');
  });

  it('shares schemas used by API schema discovery', () => {
    expect(codesiteSchemas()).toHaveProperty('mutation-transaction.schema.json');
    expect(codesiteSchemas()['event.schema.json']).toMatchObject({
      title: 'CodeSite Event',
      required: ['eventType', 'details'],
    });
  });
});

describe('CodeSite proof utilities', () => {
  it('builds verifiable proof bundles and commit trailers', () => {
    const bundle = buildProofBundle({
      project: { id: 'project-1', workspaceSlug: 'acme' },
      transaction: { id: 'txn-1', projectId: 'project-1', mutationLeaseId: 'lease-1', readSet: ['a.ts'], writeSet: ['b.ts'], invariants: ['typecheck:pass'] },
      mutationLease: { id: 'lease-1', displayCallsign: 'CODEX-04' },
      proofBundle: { id: 'proof-1', transactionId: 'txn-1', readSetDigest: 'sha256:read', writeSetDigest: 'sha256:write', invariants: ['typecheck:pass'], evidenceRefs: ['ev-1'], bundleDigest: 'sha256:bundle' },
    });

    expect(verifyProofBundle(bundle)).toMatchObject({ ok: true });
    expect(formatCommitTrailers(bundle)).toContain('CodeSite-Transaction: txn-1');
    expect(formatCommitTrailers(bundle)).toContain('CodeSite-Lease: lease-1');
  });
});
