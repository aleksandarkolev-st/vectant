import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildArtifactProjection, CODESITE_MCP_TOOLS, codesiteSchemas, quarantineReviewRecords, writeArtifactProjection } from '../artifacts.js';
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
    agentSessions: [{
      id: 'ags-1',
      displayCallsign: 'CODEX-04',
      ownerUserId: 'user-1',
      dojoPilotLicenseRef: 'schema.level_2@2026-06-25',
      dojoProofRef: 'pcap-schema',
      dojoEvidenceRefs: ['dojo:evidence:checkride'],
      dojoDecisionDigest: 'sha256:dojo-decision',
      pilotLicenseSnapshot: {
        level: 2,
        repoScope: 'acme',
        authorizedAirspace: ['packages/schemas/**'],
        requiredRadar: ['api_contract', 'security'],
        expiresOn: ['source_drift'],
        sourceDigest: 'sha256:compiler-source',
      },
    }],
    executionPlans: [{ id: 'plan-1', agentSessionId: 'ags-1', displayCallsign: 'CODEX-04', route: ['packages/schemas/auth/**'], status: 'filed' }],
    mutationLeases: [{
      id: 'lease-1',
      executionPlanId: 'plan-1',
      agentSessionId: 'ags-1',
      displayCallsign: 'CODEX-04',
      status: 'active',
      lease: { allowedPaths: ['packages/schemas/auth/**'], requiredRadar: ['api_contract'] },
      dojoLicenseRef: 'schema.level_2@2026-06-25',
      dojoProofRef: 'pcap-schema',
      dojoEvidenceRefs: ['dojo:evidence:lease'],
    }],
    mutationTxns: [{ id: 'txn-1', agentSessionId: 'ags-1', mutationLeaseId: 'lease-1', readSet: ['packages/schemas/auth/signup.ts'], writeSet: ['packages/schemas/auth/signup.ts'], invariants: ['api-contract:pass'] }],
    assumptions: [{ id: 'asm-1', ownerSessionId: 'ags-1', status: 'active', assumptionKey: 'auth.signup.v2' }],
    events: [
      { id: 'evt-1', eventType: 'clearance_issued', details: { mutationLeaseId: 'lease-1' } },
      {
        id: 'evt-denied-1',
        eventType: 'write_denied',
        displayCallsign: null,
        actorType: 'codesitefs',
        actorId: 'decision-deny-1',
        evidenceRefs: ['runtime:event:denied-write-1'],
        details: {
          path: 'infra/prod.env',
          source: 'runtime_pod_terminal',
          tool: 'terminal_exec',
          disposition: 'write_denied',
          reasonCodes: ['entered_no_fly_zone'],
          policyDecisionId: 'decision-deny-1',
          codesiteFsEvent: {
            type: null,
            source: 'runtime_pod_terminal',
            operation: 'write',
            path: 'infra/prod.env',
            details: {
              process_ancestry: ['python', 'bash', 'codex-cli'],
              reason_codes: ['entered_no_fly_zone'],
            },
          },
        },
        createdAt: '2026-07-01T00:00:30.000Z',
      },
      {
        id: 'evt-q1',
        eventType: 'write_quarantined',
        displayCallsign: 'CODEX-04',
        mutationLeaseId: 'lease-1',
        actorType: 'codesitefs',
        evidenceRefs: ['codesitefs:quarantine:sha256:review'],
        details: {
          transactionId: 'txn-1',
          quarantineId: 'qtn-signup-1',
          path: 'docs/review.md',
          quarantineEvidence: {
            path: 'docs/review.md',
            kind: 'modified',
            beforeDigest: 'sha256:before-review',
            afterDigest: 'sha256:after-review',
            evidenceRef: 'codesitefs:quarantine:sha256:review',
          },
        },
        createdAt: '2026-07-01T00:01:00.000Z',
      },
      {
        id: 'evt-q2',
        eventType: 'quarantine_replayed',
        displayCallsign: 'CODEX-04',
        mutationLeaseId: 'lease-1',
        evidenceRefs: ['codesitefs:quarantine:sha256:review'],
        details: {
          transactionId: 'txn-1',
          quarantineId: 'qtn-signup-1',
          paths: ['docs/review.md'],
          selectedChangeCount: 1,
          replayableChangeCount: 1,
          rejectedChangeCount: 0,
        },
        createdAt: '2026-07-01T00:02:00.000Z',
      },
    ],
    incidents: [{
      id: 'inc-1',
      category: 'black_box',
      severity: 'low',
      replayDigest: 'sha256:replay',
      participants: ['CODEX-04'],
      incidentReplay: {
        transactionId: 'txn-1',
        transaction: { id: 'txn-1', readSet: ['packages/schemas/auth/signup.ts'], writeSet: ['packages/schemas/auth/signup.ts'] },
        proofBundle: { id: 'proof-1', bundleDigest: 'sha256:bundle', incidentReplayDigest: 'sha256:replay' },
        handover: { exportPaths: ['projects/site_signup_email_verification/incidents/incident-replay-inc-1.jsonl'] },
        events: ['evt-1'],
        completeness: {
          score: 0.62,
          presentEventTypes: ['clearance.issued', 'transaction.committed', 'black_box.closed'],
          missingEventTypes: ['write.denied'],
        },
        causalEvents: [
          { eventId: 'evt-1', type: 'clearance.issued', transactionId: 'txn-1', details: { mutationLeaseId: 'lease-1' } },
          { eventId: 'evt-commit', type: 'transaction.committed', transactionId: 'txn-1', details: { proofBundleId: 'proof-1' } },
          { eventId: 'evt-close', type: 'black_box.closed', transactionId: 'txn-1', details: { proofBundleId: 'proof-1' } },
        ],
      },
    }],
	    proofBundles: [{ id: 'proof-1', transactionId: 'txn-1', readSetDigest: 'sha256:read', writeSetDigest: 'sha256:write', invariants: ['api-contract:pass'], evidenceRefs: ['ev-1'], repoState: { evidenceDigest: 'sha256:repo-state' }, incidentReplayDigest: 'sha256:replay', bundleDigest: 'sha256:bundle' }],
    lineProvenance: [{ filePath: 'packages/schemas/auth/signup.ts', lineAnchor: 'L1', displayCallsign: 'CODEX-04', proofBundleId: 'proof-1' }],
    policyDecisions: [{
      id: 'decision-deny-1',
      mutationLeaseId: null,
      displayCallsign: null,
      decision: 'block',
      reasonCodes: ['entered_no_fly_zone'],
      decisionBody: {
        towerInstruction: 'Write preflight blocked for infra/prod.env. Request clearance.',
      },
    }],
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
    counterfactualRuns: [],
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
    const project = projectFixture();
    project.incidents.push({
      id: 'inc-unrelated',
      category: 'black_box',
      severity: 'critical',
      replayDigest: 'sha256:unrelated-replay',
      participants: ['OTHER-02'],
      evidenceRefs: ['codesite:proof-bundle:proof-other', 'codesite:transaction:txn-other'],
      incidentReplay: {
        transactionId: 'txn-other',
        proofBundle: { id: 'proof-other', bundleDigest: 'sha256:other-bundle' },
        causalEvents: [
          { eventId: 'evt-other', type: 'transaction.committed', transactionId: 'txn-other', details: { proofBundleId: 'proof-other' } },
        ],
      },
    });
    const files = buildArtifactProjection(project, {
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
    expect(manifestTools).toContain('synthi_codesite_review_quarantine');
    expect(manifestTools).toContain('synthi_codesite_replay_quarantine');
    expect(manifestTools).toContain('synthi_codesite_apply_quarantine');
    expect(manifest.compiler_output).toBe('airspace/compiler-output.json');
    expect(manifest.metrics).toBe('projects/site_signup_email_verification/metrics.json');
    expect(manifest.quarantine_index).toBe('projects/site_signup_email_verification/quarantines/index.jsonl');
    expect(manifest.quarantine_root).toBe('projects/site_signup_email_verification/quarantines/');
    expect(manifest.filesystem_boundary_proof).toBe('projects/site_signup_email_verification/filesystem-boundary-proof.json');
    expect(manifest.filesystem_boundary_proof_index).toBe('projects/site_signup_email_verification/filesystem-boundary-proofs/index.jsonl');
    expect(manifest.pilot_license_health).toBe('projects/site_signup_email_verification/pilot-license-health.json');
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
    expect(paths).toContain('schemas/pilot-license-health.schema.json');
    expect(paths).toContain('schemas/codesitefs-quarantine.schema.json');
    expect(paths).toContain('projects/site_signup_email_verification/metrics.json');
    expect(paths).toContain('projects/site_signup_email_verification/pilot-license-health.json');
    expect(JSON.parse(files.find((file) => file.relativePath === 'projects/site_signup_email_verification/pilot-license-health.json').content)).toMatchObject({
      schemaVersion: 'synthi.codesite.pilotLicenseHealth.index.v1',
      summary: expect.objectContaining({ active: 1 }),
      records: [expect.objectContaining({
        displayCallsign: 'CODEX-04',
        status: 'active',
        level: 'IFR',
      })],
    });
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
    expect(paths).toContain('projects/site_signup_email_verification/quarantines/index.jsonl');
    expect(paths).toContain('projects/site_signup_email_verification/quarantines/qtn-signup-1.json');
    expect(files.find((file) => file.relativePath === 'projects/site_signup_email_verification/quarantines/index.jsonl').content).toContain('qtn-signup-1');
    expect(paths).toContain('projects/site_signup_email_verification/filesystem-boundary-proof.json');
    expect(paths).toContain('projects/site_signup_email_verification/filesystem-boundary-proofs/index.jsonl');
    expect(paths).toContain('projects/site_signup_email_verification/filesystem-boundary-proofs/fs-boundary-evt-denied-1.json');
    const boundaryProofIndex = JSON.parse(files.find((file) => file.relativePath === 'projects/site_signup_email_verification/filesystem-boundary-proof.json').content);
    expect(boundaryProofIndex.summary).toMatchObject({ total: 2, denied: 1, quarantined: 1, complete: 1, incomplete: 1 });
    expect(boundaryProofIndex.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventId: 'evt-denied-1',
        path: 'infra/prod.env',
        leaseState: 'no_active_clearance',
        process: expect.objectContaining({ display: 'python <- bash <- codex-cli' }),
        evidenceRefs: expect.arrayContaining(['event:evt-denied-1', 'runtime:event:denied-write-1']),
        proofComplete: true,
      }),
    ]));
    expect(JSON.parse(files.find((file) => file.relativePath === 'projects/site_signup_email_verification/quarantines/qtn-signup-1.json').content)).toMatchObject({
      quarantineId: 'qtn-signup-1',
      status: 'replayed',
      paths: ['docs/review.md'],
      changes: [expect.objectContaining({ path: 'docs/review.md' })],
      evidenceRefs: expect.arrayContaining(['codesitefs:quarantine:sha256:review']),
    });
    expect(paths).toContain('projects/site_signup_email_verification/flights/CODEX-04/flight-plan.json');
    expect(paths).toContain('projects/site_signup_email_verification/flights/CODEX-04/clearance.json');
    expect(paths).toContain('projects/site_signup_email_verification/flights/CODEX-04/transaction.json');
    expect(paths).toContain('projects/site_signup_email_verification/flights/CODEX-04/transponder.jsonl');
    expect(paths).toContain('projects/site_signup_email_verification/flights/CODEX-04/landing.json');
    expect(paths).toContain('projects/site_signup_email_verification/flights/CODEX-04/pilot-license-health.json');
    expect(paths).toContain('projects/site_signup_email_verification/flights/CODEX-04/black-box.json');
    expect(paths).toContain('projects/site_signup_email_verification/flight-plans/plan-1.json');
    expect(paths).toContain('projects/site_signup_email_verification/flights/CODEX-04/flight-plans/plan-1.json');
    expect(paths).toContain('projects/site_signup_email_verification/clearances/lease-1.json');
    expect(paths).toContain('projects/site_signup_email_verification/flights/CODEX-04/clearances/lease-1.json');
    expect(JSON.parse(files.find((file) => file.relativePath === 'projects/site_signup_email_verification/flights/CODEX-04/black-box.json').content).quarantines).toEqual([
      expect.objectContaining({ quarantineId: 'qtn-signup-1' }),
    ]);
    expect(JSON.parse(files.find((file) => file.relativePath === 'projects/site_signup_email_verification/flights/CODEX-04/black-box.json').content).filesystemBoundaryProofs).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventId: 'evt-q1', path: 'docs/review.md' }),
    ]));
    expect(JSON.parse(files.find((file) => file.relativePath === 'projects/site_signup_email_verification/flights/CODEX-04/black-box.json').content).causalReplays).toEqual(expect.arrayContaining([
      expect.objectContaining({
        replayDigest: 'sha256:replay',
        transactionId: 'txn-1',
        proofBundleId: 'proof-1',
        codeSiteBlackBox: 'sha256:replay',
      }),
    ]));
    expect(paths).toContain('projects/site_signup_email_verification/inbox/CODEX-04/evt-rfi.json');
    expect(JSON.parse(files.find((file) => file.relativePath === 'projects/site_signup_email_verification/inbox/CODEX-04/evt-rfi.json').content).redactedPayload.body.apiToken).toBe('[redacted]');
    expect(paths).toContain('projects/site_signup_email_verification/incidents/inc-1.json');
    expect(files.find((file) => file.relativePath === 'projects/site_signup_email_verification/incidents/incident-replay-inc-1.jsonl').content).toContain('clearance_issued');
	    expect(paths).toContain('projects/site_signup_email_verification/proof-bundles/proof-1.proof.json');
    const exportedProofBundle = JSON.parse(files.find((file) => file.relativePath === 'projects/site_signup_email_verification/proof-bundles/proof-1.proof.json').content);
	    expect(exportedProofBundle.repoState).toMatchObject({ evidenceDigest: 'sha256:repo-state' });
	    expect(exportedProofBundle.landingStatus).toBe('passed');
	    expect(exportedProofBundle.incidentReplayDigest).toBe('sha256:replay');
	    expect(exportedProofBundle.proofSignature).toMatchObject({ algorithm: 'hmac-sha256' });
    expect(exportedProofBundle.incidents.map((incident) => incident.id)).toEqual(['inc-1']);
	    expect(paths).toContain('projects/site_signup_email_verification/proof-bundles/proof-1.trailers.txt');
	    expect(files.find((file) => file.relativePath === 'projects/site_signup_email_verification/proof-bundles/proof-1.trailers.txt').content).toContain('CodeSite-Clearance: lease-1');
	    expect(files.find((file) => file.relativePath === 'projects/site_signup_email_verification/proof-bundles/proof-1.trailers.txt').content).toContain('CodeSite-Black-Box: sha256:replay');
	    expect(files.find((file) => file.relativePath === 'projects/site_signup_email_verification/proof-bundles/proof-1.trailers.txt').content).toContain('CodeSite-Proof-Signature: hmac-sha256:');
    expect(paths).toContain('projects/site_signup_email_verification/handover.md');
    const handover = files.find((file) => file.relativePath === 'projects/site_signup_email_verification/handover.md').content;
    expect(handover).toContain('## Causal Replay Packets');
    expect(handover).toContain('sha256:replay');
    expect(handover).toContain('CodeSite-Black-Box sha256:replay');
    expect(handover).toContain('Missing event kinds: write.denied');
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
    expect(codesiteSchemas()).toHaveProperty('filesystem-boundary-proof.schema.json');
    expect(codesiteSchemas()['filesystem-boundary-proof.schema.json'].properties).toMatchObject({
      requestedMutationLeaseId: { type: ['string', 'null'] },
      inspectedLeases: { type: 'array' },
      proofComplete: { type: 'boolean' },
      missingProofFields: { type: 'array', items: { type: 'string' } },
    });
    expect(codesiteSchemas()).toHaveProperty('inspection-run.schema.json');
    expect(codesiteSchemas()).toHaveProperty('metrics.schema.json');
	    expect(codesiteSchemas()).toHaveProperty('pilot-license-health.schema.json');
	    expect(codesiteSchemas()).toHaveProperty('codesitefs-quarantine.schema.json');
	    expect(codesiteSchemas()).toHaveProperty('incident-replay.schema.json');
	    expect(codesiteSchemas()['proof-bundle.schema.json'].properties).toHaveProperty('repoState');
    expect(codesiteSchemas()['control-state.schema.json'].properties).toHaveProperty('pendingQuarantines');
    expect(codesiteSchemas()['control-state.schema.json'].properties).toHaveProperty('pilotLicenseHealth');
    expect(codesiteSchemas()['control-state.schema.json'].properties).toHaveProperty('filesystemBoundaryProofs');
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

  it('keeps unselected quarantine paths pending after a partial apply', () => {
    const project = projectFixture();
    project.events = [
      {
        id: 'evt-q1',
        eventType: 'write_quarantined',
        displayCallsign: 'CODEX-04',
        mutationLeaseId: 'lease-1',
        evidenceRefs: ['codesitefs:quarantine:sha256:review'],
        details: {
          transactionId: 'txn-1',
          quarantineId: 'qtn-partial-1',
          path: 'docs/review.md',
          quarantineEvidence: {
            path: 'docs/review.md',
            kind: 'modified',
            evidenceRef: 'codesitefs:quarantine:sha256:review',
          },
        },
        createdAt: '2026-07-01T00:01:00.000Z',
      },
      {
        id: 'evt-q2',
        eventType: 'write_quarantined',
        displayCallsign: 'CODEX-04',
        mutationLeaseId: 'lease-1',
        evidenceRefs: ['codesitefs:quarantine:sha256:notes'],
        details: {
          transactionId: 'txn-1',
          quarantineId: 'qtn-partial-1',
          path: 'docs/notes.md',
          quarantineEvidence: {
            path: 'docs/notes.md',
            kind: 'created',
            evidenceRef: 'codesitefs:quarantine:sha256:notes',
          },
        },
        createdAt: '2026-07-01T00:01:30.000Z',
      },
      {
        id: 'evt-q3',
        eventType: 'quarantine_applied',
        displayCallsign: 'CODEX-04',
        mutationLeaseId: 'lease-1',
        evidenceRefs: ['codesitefs:quarantine:sha256:review'],
        details: {
          transactionId: 'txn-1',
          quarantineId: 'qtn-partial-1',
          paths: ['docs/review.md'],
          applied: [{ path: 'docs/review.md', evidenceRef: 'codesitefs:quarantine:sha256:review' }],
        },
        createdAt: '2026-07-01T00:02:00.000Z',
      },
    ];

    const [record] = quarantineReviewRecords(project);

    expect(record).toMatchObject({
      quarantineId: 'qtn-partial-1',
      status: 'partially_applied',
      appliedPaths: ['docs/review.md'],
      remainingPaths: ['docs/notes.md'],
    });
    const files = buildArtifactProjection(project, {
      projectId: project.id,
      workspaceSlug: project.workspaceSlug,
      towerState: 'holding',
    });
    expect(JSON.parse(files.find((file) => file.relativePath === `projects/${project.id}/quarantines/qtn-partial-1.json`).content)).toMatchObject({
      status: 'partially_applied',
      appliedPaths: ['docs/review.md'],
      remainingPaths: ['docs/notes.md'],
    });
  });

  it('keeps manifest paths pending when lifecycle events only select one applied path', () => {
    const project = projectFixture();
    project.events = [
      {
        id: 'evt-q0',
        eventType: 'quarantine_replayed',
        displayCallsign: 'CODEX-04',
        mutationLeaseId: 'lease-1',
        details: {
          transactionId: 'txn-1',
          quarantineId: 'qtn-stale-replay-1',
          paths: ['docs/review.md'],
          selectedChangeCount: 1,
          replayableChangeCount: 1,
          rejectedChangeCount: 0,
          manifestPaths: ['docs/review.md', 'docs/notes.md'],
          manifestChanges: [
            { path: 'docs/review.md', kind: 'modified', evidenceRef: 'codesitefs:quarantine:sha256:review' },
            { path: 'docs/notes.md', kind: 'created', evidenceRef: 'codesitefs:quarantine:sha256:notes' },
          ],
        },
        createdAt: '2026-07-01T00:00:30.000Z',
      },
      {
        id: 'evt-q1',
        eventType: 'quarantine_replayed',
        displayCallsign: 'CODEX-04',
        mutationLeaseId: 'lease-1',
        evidenceRefs: ['codesitefs:quarantine:sha256:review', 'codesitefs:quarantine:sha256:notes'],
        details: {
          transactionId: 'txn-1',
          quarantineId: 'qtn-manifest-partial-1',
          paths: ['docs/review.md'],
          selectedChangeCount: 1,
          replayableChangeCount: 1,
          rejectedChangeCount: 0,
          manifestPaths: ['docs/review.md', 'docs/notes.md'],
          manifestChanges: [
            { path: 'docs/review.md', kind: 'modified', evidenceRef: 'codesitefs:quarantine:sha256:review' },
            { path: 'docs/notes.md', kind: 'created', evidenceRef: 'codesitefs:quarantine:sha256:notes' },
          ],
        },
        createdAt: '2026-07-01T00:01:00.000Z',
      },
      {
        id: 'evt-q2',
        eventType: 'quarantine_applied',
        displayCallsign: 'CODEX-04',
        mutationLeaseId: 'lease-1',
        evidenceRefs: ['codesitefs:quarantine:sha256:review', 'codesitefs:quarantine:sha256:notes'],
        details: {
          transactionId: 'txn-1',
          quarantineId: 'qtn-manifest-partial-1',
          paths: ['docs/review.md'],
          applied: [{ path: 'docs/review.md', evidenceRef: 'codesitefs:quarantine:sha256:review' }],
          manifestPaths: ['docs/review.md', 'docs/notes.md'],
          manifestChanges: [
            { path: 'docs/review.md', kind: 'modified', evidenceRef: 'codesitefs:quarantine:sha256:review' },
            { path: 'docs/notes.md', kind: 'created', evidenceRef: 'codesitefs:quarantine:sha256:notes' },
          ],
        },
        createdAt: '2026-07-01T00:02:00.000Z',
      },
    ];

    const [record] = quarantineReviewRecords(project);

    expect(record).toMatchObject({
      quarantineId: 'qtn-manifest-partial-1',
      status: 'partially_applied',
      paths: ['docs/review.md', 'docs/notes.md'],
      appliedPaths: ['docs/review.md'],
      remainingPaths: ['docs/notes.md'],
    });
  });

  it('keeps successful replay lifecycle separate from later rejected replay attempts', () => {
    const project = projectFixture();
    project.events = [
      {
        id: 'evt-q0',
        eventType: 'quarantine_replayed',
        displayCallsign: 'CODEX-04',
        mutationLeaseId: 'lease-1',
        details: {
          transactionId: 'txn-1',
          quarantineId: 'qtn-stale-replay-1',
          paths: ['docs/review.md'],
          selectedChangeCount: 1,
          replayableChangeCount: 1,
          rejectedChangeCount: 0,
          manifestPaths: ['docs/review.md', 'docs/notes.md'],
          manifestChanges: [
            { path: 'docs/review.md', kind: 'modified', evidenceRef: 'codesitefs:quarantine:sha256:review' },
            { path: 'docs/notes.md', kind: 'created', evidenceRef: 'codesitefs:quarantine:sha256:notes' },
          ],
        },
        createdAt: '2026-07-01T00:00:30.000Z',
      },
      {
        id: 'evt-q1',
        eventType: 'quarantine_replayed',
        displayCallsign: 'CODEX-04',
        mutationLeaseId: 'lease-1',
        details: {
          transactionId: 'txn-1',
          quarantineId: 'qtn-stale-replay-1',
          paths: ['docs/review.md'],
          selectedChangeCount: 1,
          replayableChangeCount: 1,
          rejectedChangeCount: 0,
          manifestPaths: ['docs/review.md', 'docs/notes.md'],
          manifestChanges: [
            { path: 'docs/review.md', kind: 'modified', evidenceRef: 'codesitefs:quarantine:sha256:review' },
            { path: 'docs/notes.md', kind: 'created', evidenceRef: 'codesitefs:quarantine:sha256:notes' },
          ],
        },
        createdAt: '2026-07-01T00:01:00.000Z',
      },
      {
        id: 'evt-q2',
        eventType: 'quarantine_applied',
        displayCallsign: 'CODEX-04',
        mutationLeaseId: 'lease-1',
        details: {
          transactionId: 'txn-1',
          quarantineId: 'qtn-stale-replay-1',
          applied: [{ path: 'docs/review.md', evidenceRef: 'codesitefs:quarantine:sha256:review' }],
          manifestPaths: ['docs/review.md', 'docs/notes.md'],
          manifestChanges: [
            { path: 'docs/review.md', kind: 'modified', evidenceRef: 'codesitefs:quarantine:sha256:review' },
            { path: 'docs/notes.md', kind: 'created', evidenceRef: 'codesitefs:quarantine:sha256:notes' },
          ],
        },
        createdAt: '2026-07-01T00:02:00.000Z',
      },
      {
        id: 'evt-q3',
        eventType: 'quarantine_replayed',
        displayCallsign: 'CODEX-04',
        mutationLeaseId: 'lease-1',
        details: {
          transactionId: 'txn-1',
          quarantineId: 'qtn-stale-replay-1',
          paths: ['docs/review.md'],
          selectedChangeCount: 1,
          replayableChangeCount: 0,
          rejectedChangeCount: 1,
          rejected: [{ path: 'docs/review.md', reasonCodes: ['quarantine_replay_base_mismatch'] }],
          manifestPaths: ['docs/review.md', 'docs/notes.md'],
          manifestChanges: [
            { path: 'docs/review.md', kind: 'modified', evidenceRef: 'codesitefs:quarantine:sha256:review' },
            { path: 'docs/notes.md', kind: 'created', evidenceRef: 'codesitefs:quarantine:sha256:notes' },
          ],
        },
        createdAt: '2026-07-01T00:03:00.000Z',
      },
    ];

    const [record] = quarantineReviewRecords(project);

    expect(record).toMatchObject({
      quarantineId: 'qtn-stale-replay-1',
      status: 'partially_applied',
      lifecycle: {
        replayedAt: '2026-07-01T00:01:00.000Z',
        appliedAt: '2026-07-01T00:02:00.000Z',
      },
      successfulReplay: {
        attemptedAt: '2026-07-01T00:01:00.000Z',
        replayableChangeCount: 1,
        rejectedChangeCount: 0,
      },
      latestReplayAttempt: {
        attemptedAt: '2026-07-01T00:03:00.000Z',
        replayableChangeCount: 0,
        rejectedChangeCount: 1,
      },
      remainingPaths: ['docs/notes.md'],
    });
    expect(record.rejected).toEqual([
      { path: 'docs/review.md', reasonCodes: ['quarantine_replay_base_mismatch'] },
    ]);
    expect(record.replayAttempts).toHaveLength(3);
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
    const history = await fs.readFile(path.join(artifactRoot, 'artifact-path-history.jsonl'), 'utf8');
    expect(history).toContain('"action":"write"');
    expect(history).toContain('"action":"remove"');
    expect(history).toContain('projects/site_signup_email_verification/proof-bundles/proof-1.proof.json');
  });

  it('compacts repo-local artifact path history while retaining current proof paths', async () => {
    const previousMaxBytes = process.env.SYNTHI_CODESITE_ARTIFACT_PATH_HISTORY_MAX_BYTES;
    process.env.SYNTHI_CODESITE_ARTIFACT_PATH_HISTORY_MAX_BYTES = '65536';
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codesite-artifacts-history-'));
    const artifactRoot = path.join(root, '.synthi', 'codesite');
    try {
      for (let index = 0; index < 8; index += 1) {
        await writeArtifactProjection({
          ...projectFixture(),
          id: `site_signup_email_verification_${index}`,
          title: `Signup email verification ${index}`,
        }, null, artifactRoot);
      }

      const historyPath = path.join(artifactRoot, 'artifact-path-history.jsonl');
      const stat = await fs.stat(historyPath);
      const history = await fs.readFile(historyPath, 'utf8');
      expect(stat.size).toBeLessThan(131072);
      expect(history).toContain('synthi.codesite.artifactPathHistory.compaction.v1');
      expect(history).toContain('projects/site_signup_email_verification_7/proof-bundles/proof-1.proof.json');
    } finally {
      if (previousMaxBytes == null) {
        delete process.env.SYNTHI_CODESITE_ARTIFACT_PATH_HISTORY_MAX_BYTES;
      } else {
        process.env.SYNTHI_CODESITE_ARTIFACT_PATH_HISTORY_MAX_BYTES = previousMaxBytes;
      }
    }
  });
});

describe('CodeSite proof utilities', () => {
  it('builds verifiable proof bundles and commit trailers', () => {
    const bundle = buildProofBundle({
      project: { id: 'project-1', workspaceSlug: 'acme' },
      transaction: {
        id: 'txn-1',
        projectId: 'project-1',
        mutationLeaseId: 'lease-1',
        readSet: ['a.ts'],
        writeSet: ['b.ts'],
        invariants: ['typecheck:pass'],
        baseSnapshot: 'sha256:base-snapshot',
        baseSnapshotEvidence: {
          snapshotDigest: 'sha256:base-snapshot',
          evidenceDigest: 'sha256:base-snapshot-evidence',
          scope: 'repo_wide',
        },
      },
      mutationLease: { id: 'lease-1', displayCallsign: 'CODEX-04' },
	      proofBundle: { id: 'proof-1', transactionId: 'txn-1', readSetDigest: 'sha256:read', writeSetDigest: 'sha256:write', invariants: ['typecheck:pass'], evidenceRefs: ['ev-1'], repoState: { evidenceDigest: 'sha256:repo-state' }, bundleDigest: 'sha256:bundle' },
      landingRuns: [{ id: 'inspect-1', status: 'passed' }],
	    });

	    expect(verifyProofBundle(bundle)).toMatchObject({ ok: true });
	    expect(bundle.proofSignature).toMatchObject({ algorithm: 'hmac-sha256' });
	    expect(bundle.repoState).toMatchObject({ evidenceDigest: 'sha256:repo-state' });
    expect(bundle.baseSnapshotEvidence).toMatchObject({ evidenceDigest: 'sha256:base-snapshot-evidence' });
    expect(bundle.landingStatus).toBe('passed');
    expect(formatCommitTrailers(bundle)).toContain('CodeSite-Project: project-1');
    expect(formatCommitTrailers(bundle)).toContain('CodeSite-Flight: CODEX-04');
    expect(formatCommitTrailers(bundle)).toContain('CodeSite-Clearance: lease-1');
    expect(formatCommitTrailers(bundle)).toContain('CodeSite-Landing: passed');
    expect(formatCommitTrailers(bundle)).toContain('CodeSite-Transaction: txn-1');
    expect(formatCommitTrailers(bundle)).toContain('CodeSite-Lease: lease-1');
    expect(formatCommitTrailers(bundle)).toContain('CodeSite-Base-Snapshot: sha256:base-snapshot');
    expect(formatCommitTrailers(bundle)).toContain('CodeSite-Base-Snapshot-Evidence: sha256:base-snapshot-evidence');
    expect(formatCommitTrailers(bundle)).toContain('CodeSite-Proof-Signature: hmac-sha256:');
  });
});
