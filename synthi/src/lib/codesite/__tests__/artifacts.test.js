import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildArtifactProjection, CODESITE_MCP_TOOLS, codesiteSchemas, writeArtifactProjection } from '../artifacts.js';
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
      semanticGraph: {
        sourceDigest: 'sha256:compiler-source',
        importEdges: [{ from: 'components/auth/SignupForm.tsx', imports: ['packages/schemas/auth/signup.ts'] }],
        testOwnership: [],
      },
      policySources: { repoSignals: 1, importEdges: 1 },
      policyDigest: 'sha256:policy',
      compiler: {
        compilerVersion: '2026-07-01.1',
        repoRoot: '/repo',
        sourceDigest: 'sha256:compiler-source',
        policyDigest: 'sha256:policy',
        compiledAt: '2026-07-01T00:00:00.000Z',
        fileCount: 42,
        maxFiles: 12000,
        truncated: false,
        source: 'repo_policy_compiler',
      },
    },
    controlPlan: { selectedStrategy: 'schema-first' },
    agentSessions: [{ id: 'ags-1', displayCallsign: 'CODEX-04', ownerUserId: 'user-1' }],
    executionPlans: [{ id: 'plan-1', agentSessionId: 'ags-1', displayCallsign: 'CODEX-04', route: ['packages/schemas/auth/**'], status: 'filed' }],
    mutationLeases: [{ id: 'lease-1', executionPlanId: 'plan-1', agentSessionId: 'ags-1', displayCallsign: 'CODEX-04', status: 'active', lease: { allowedPaths: ['packages/schemas/auth/**'] } }],
    mutationTxns: [{ id: 'txn-1', agentSessionId: 'ags-1', mutationLeaseId: 'lease-1', readSet: ['packages/schemas/auth/signup.ts'], writeSet: ['packages/schemas/auth/signup.ts'], invariants: ['api-contract:pass'] }],
    assumptions: [{ id: 'asm-1', ownerSessionId: 'ags-1', status: 'active', assumptionKey: 'auth.signup.v2' }],
    events: [{ id: 'evt-1', eventType: 'clearance_issued', details: { mutationLeaseId: 'lease-1' } }],
    incidents: [{ id: 'inc-1', category: 'near_miss', severity: 'medium', replayDigest: 'sha256:replay', incidentReplay: { events: ['evt-1'] } }],
	    proofBundles: [{ id: 'proof-1', transactionId: 'txn-1', readSetDigest: 'sha256:read', writeSetDigest: 'sha256:write', invariants: ['api-contract:pass'], evidenceRefs: ['ev-1'], repoState: { evidenceDigest: 'sha256:repo-state' }, bundleDigest: 'sha256:bundle' }],
    lineProvenance: [{ filePath: 'packages/schemas/auth/signup.ts', lineAnchor: 'L1', displayCallsign: 'CODEX-04', proofBundleId: 'proof-1' }],
    policyDecisions: [],
    inspectionRuns: [{
      id: 'inspect-1',
      executionPlanId: 'plan-1',
      displayCallsign: 'CODEX-04',
      status: 'passed',
      changedPaths: ['packages/schemas/auth/signup.ts'],
      inspectionSignals: [{ type: 'test', status: 'passed' }],
      evidenceRefs: ['test:auth'],
    }],
    documents: [],
    counterfactualRuns: [{
      id: 'cfr-1',
      shadowJobRef: 'shadow-job-1',
      baseSnapshot: 'repo@sha256:base',
      universes: [{ strategy: 'schema-first', predictedCollisionRisk: 0.1 }],
      arbiterVerdict: { selected: 'schema-first' },
      validityStrength: 'simulated',
      evidenceRefs: ['codesite:shadow_merge_simulator'],
    }],
    policyDeltas: [],
    inboxItems: [{
      id: 'inbox-1',
      agentSessionId: 'ags-1',
      eventId: 'evt-rfi',
      kind: 'rfi',
      status: 'pending',
      requiresResponse: true,
      redactedPayload: { body: { question: 'Confirm payload', apiToken: '[redacted]' } },
    }],
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
    const manifest = JSON.parse(files.find((file) => file.relativePath === 'manifest.json').content);
    const manifestTools = manifest.mcp_tools;
    expect(manifestTools).toEqual(CODESITE_MCP_TOOLS);
    expect(manifestTools).toContain('synthi_codesite_get_radar');
    expect(manifestTools).toContain('synthi_codesite_get_metrics');
    expect(manifestTools).toContain('synthi_codesite_preflight_write');
    expect(manifestTools).toContain('synthi_codesite_get_inbox');
    expect(manifest.compiler_output).toBe('airspace/compiler-output.json');
    expect(manifest.metrics).toBe('projects/site_signup_email_verification/metrics.json');
    expect(paths).toContain('airspace/compiler-output.json');
    expect(JSON.parse(files.find((file) => file.relativePath === 'airspace/compiler-output.json').content)).toMatchObject({
      schemaVersion: 'synthi.codesite.repoPolicyCompilerOutput.v1',
      policyDigest: 'sha256:policy',
      compiler: {
        compilerVersion: '2026-07-01.1',
        repoRoot: '/repo',
        sourceDigest: 'sha256:compiler-source',
        fileCount: 42,
      },
      semanticGraph: expect.objectContaining({ sourceDigest: 'sha256:compiler-source' }),
    });
    expect(paths).toContain('schemas/agent-session.schema.json');
    expect(paths).toContain('schemas/clearance.schema.json');
    expect(paths).toContain('schemas/execution-plan.schema.json');
    expect(paths).toContain('schemas/inspection-run.schema.json');
    expect(paths).toContain('schemas/incident.schema.json');
    expect(paths).toContain('schemas/incident-replay.schema.json');
    expect(paths).toContain('schemas/metrics.schema.json');
    expect(paths).toContain('projects/site_signup_email_verification/metrics.json');
    expect(JSON.parse(files.find((file) => file.relativePath === 'projects/site_signup_email_verification/metrics.json').content)).toMatchObject({
      schemaVersion: 'synthi.codesite.metrics.v1',
      summary: expect.objectContaining({
        collisionsPredicted: expect.any(Number),
        lineProvenanceCoverage: expect.any(Number),
      }),
      sections: expect.objectContaining({
        atc: expect.any(Array),
        transaction: expect.any(Array),
        quality: expect.any(Array),
        trust: expect.any(Array),
      }),
    });
    expect(paths).toContain('projects/site_signup_email_verification/events.jsonl');
    expect(paths).toContain('projects/site_signup_email_verification/flights/CODEX-04/flight-plan.json');
    expect(paths).toContain('projects/site_signup_email_verification/flights/CODEX-04/clearance.json');
    expect(paths).toContain('projects/site_signup_email_verification/flights/CODEX-04/transaction.json');
    expect(paths).toContain('projects/site_signup_email_verification/flights/CODEX-04/transponder.jsonl');
    expect(paths).toContain('projects/site_signup_email_verification/flights/CODEX-04/landing.json');
    expect(paths).toContain('projects/site_signup_email_verification/flights/CODEX-04/black-box.json');
    expect(paths).toContain('projects/site_signup_email_verification/inbox/CODEX-04/evt-rfi.json');
    expect(JSON.parse(files.find((file) => file.relativePath === 'projects/site_signup_email_verification/inbox/CODEX-04/evt-rfi.json').content).redactedPayload.body.apiToken).toBe('[redacted]');
    expect(paths).toContain('projects/site_signup_email_verification/near-misses/inc-1.json');
    expect(files.find((file) => file.relativePath === 'projects/site_signup_email_verification/incidents/incident-replay-inc-1.jsonl').content).toContain('clearance_issued');
    expect(paths).toContain('projects/site_signup_email_verification/counterfactual-runs/cfr-1.json');
    expect(JSON.parse(files.find((file) => file.relativePath === 'projects/site_signup_email_verification/counterfactual-runs/cfr-1.json').content).arbiterVerdict.selected).toBe('schema-first');
	    expect(paths).toContain('projects/site_signup_email_verification/proof-bundles/proof-1.proof.json');
	    expect(JSON.parse(files.find((file) => file.relativePath === 'projects/site_signup_email_verification/proof-bundles/proof-1.proof.json').content).repoState).toMatchObject({ evidenceDigest: 'sha256:repo-state' });
	    expect(JSON.parse(files.find((file) => file.relativePath === 'projects/site_signup_email_verification/proof-bundles/proof-1.proof.json').content).landingStatus).toBe('passed');
	    expect(paths).toContain('projects/site_signup_email_verification/proof-bundles/proof-1.trailers.txt');
	    expect(files.find((file) => file.relativePath === 'projects/site_signup_email_verification/proof-bundles/proof-1.trailers.txt').content).toContain('CodeSite-Clearance: lease-1');
    expect(paths).toContain('projects/site_signup_email_verification/handover.md');
  });

  it('shares schemas used by API schema discovery', () => {
    expect(codesiteSchemas()).toHaveProperty('mutation-transaction.schema.json');
    expect(codesiteSchemas()['mutation-transaction.schema.json'].properties.isolation).toMatchObject({
      enum: ['serializable'],
    });
    expect(codesiteSchemas()['event.schema.json']).toMatchObject({
      title: 'CodeSite Event',
      required: ['eventType', 'details'],
    });
    expect(codesiteSchemas()['event.schema.json'].properties.eventType.enum).toContain('write_denied');
    expect(codesiteSchemas()['event.schema.json'].properties.eventType.enum).toContain('black_box_closed');
    expect(codesiteSchemas()).toHaveProperty('agent-session.schema.json');
    expect(codesiteSchemas()['agent-session.schema.json'].properties).toHaveProperty('dojoPilotLicenseRef');
    expect(codesiteSchemas()).toHaveProperty('codesitefs-prewrite.schema.json');
    expect(codesiteSchemas()).toHaveProperty('inspection-run.schema.json');
	    expect(codesiteSchemas()).toHaveProperty('metrics.schema.json');
	    expect(codesiteSchemas()).toHaveProperty('incident-replay.schema.json');
	    expect(codesiteSchemas()['proof-bundle.schema.json'].properties).toHaveProperty('repoState');
    expect(codesiteSchemas()['line-provenance.schema.json'].properties).toMatchObject({
      startLine: { type: ['number', 'null'] },
      endLine: { type: ['number', 'null'] },
      dojoSourceRefs: { type: 'array', items: { type: 'string' } },
    });
    expect(codesiteSchemas()['proof-bundle.schema.json'].required).toEqual(expect.arrayContaining([
      'schemaVersion',
      'projectId',
      'transactionId',
      'mutationLeaseId',
      'evidenceRefs',
      'portableDigest',
    ]));
	  });

  it('writes the repo-local artifact tree when an artifact root is available', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codesite-artifacts-'));
    const result = await writeArtifactProjection(projectFixture(), null, path.join(root, '.synthi', 'codesite'));

    expect(result.written).toBe(true);
    expect(result.files).toContain('manifest.json');
    await expect(fs.readFile(path.join(root, '.synthi', 'codesite', 'manifest.json'), 'utf8')).resolves.toContain('synthi_codesite_get_radar');
    await expect(fs.readFile(path.join(root, '.synthi', 'codesite', 'projects/site_signup_email_verification/metrics.json'), 'utf8')).resolves.toContain('synthi.codesite.metrics.v1');
  });

  it('atomically refreshes the repo-local artifact tree and removes stale projected files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codesite-artifacts-refresh-'));
    const artifactRoot = path.join(root, '.synthi', 'codesite');
    await writeArtifactProjection(projectFixture(), null, artifactRoot);
    const proofPath = path.join(artifactRoot, 'projects/site_signup_email_verification/proof-bundles/proof-1.proof.json');
    await expect(fs.readFile(proofPath, 'utf8')).resolves.toContain('proof-1');

    const withoutProof = {
      ...projectFixture(),
      proofBundles: [],
      lineProvenance: [],
    };
    await writeArtifactProjection(withoutProof, null, artifactRoot);

    await expect(fs.readFile(proofPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(artifactRoot, '.codesite-projection-files.json'), 'utf8')).resolves.toContain('manifest.json');
  });
});

describe('CodeSite proof utilities', () => {
  it('builds verifiable proof bundles and commit trailers', () => {
    const bundle = buildProofBundle({
      project: { id: 'project-1', workspaceSlug: 'acme' },
      transaction: { id: 'txn-1', projectId: 'project-1', mutationLeaseId: 'lease-1', readSet: ['a.ts'], writeSet: ['b.ts'], invariants: ['typecheck:pass'] },
      mutationLease: { id: 'lease-1', displayCallsign: 'CODEX-04' },
	      proofBundle: { id: 'proof-1', transactionId: 'txn-1', readSetDigest: 'sha256:read', writeSetDigest: 'sha256:write', invariants: ['typecheck:pass'], evidenceRefs: ['ev-1'], repoState: { evidenceDigest: 'sha256:repo-state' }, bundleDigest: 'sha256:bundle' },
      landingRuns: [{ id: 'inspect-1', status: 'passed' }],
	    });

	    expect(verifyProofBundle(bundle)).toMatchObject({ ok: true });
	    expect(bundle.repoState).toMatchObject({ evidenceDigest: 'sha256:repo-state' });
    expect(bundle.landingStatus).toBe('passed');
    expect(formatCommitTrailers(bundle)).toContain('CodeSite-Project: project-1');
    expect(formatCommitTrailers(bundle)).toContain('CodeSite-Flight: CODEX-04');
    expect(formatCommitTrailers(bundle)).toContain('CodeSite-Clearance: lease-1');
    expect(formatCommitTrailers(bundle)).toContain('CodeSite-Landing: passed');
    expect(formatCommitTrailers(bundle)).toContain('CodeSite-Transaction: txn-1');
    expect(formatCommitTrailers(bundle)).toContain('CodeSite-Lease: lease-1');
  });
});
