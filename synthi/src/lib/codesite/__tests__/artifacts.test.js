import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildArtifactProjection, buildSharedKnowledgeRepoProjection, CODESITE_MCP_TOOLS, codesiteSchemas, quarantineReviewRecords, writeArtifactProjection } from '../artifacts.js';
import { buildProofBundle, formatCommitTrailers, verifyProofBundle } from '../proof.js';
import { buildKnowledgeRecord, buildKnowledgeReferenceRecords } from '../knowledgeRecords.js';

const KNOWLEDGE_SOURCE = Object.freeze({
  actorType: 'agent',
  actorId: 'agent-source',
  agentSessionId: 'agent-source',
});

function persistedKnowledge(input, id) {
  const encoded = buildKnowledgeRecord(input, {
    projectId: input.projectId,
    agentSessionId: input.source.agentSessionId,
    userId: 'user-source',
  });
  return {
    id,
    ...encoded.data,
    createdAt: new Date('2026-08-22T04:00:00.000Z'),
    updatedAt: new Date('2026-08-22T04:01:00.000Z'),
    references: buildKnowledgeReferenceRecords(input, id),
  };
}

function knowledgeInput(kind, overrides = {}) {
  const common = {
    kind,
    projectId: 'site_signup_email_verification',
    title: `${kind} title`,
    summary: `${kind} project-shareable summary`,
    source: { ...KNOWLEDGE_SOURCE },
    references: {
      paths: ['src/CharacterController.cpp'],
      symbols: ['CharacterController::Turn'],
      contracts: ['rotation.completed@v2'],
      workstreamIds: ['workstream-producer'],
      transactionIds: ['txn-1'],
    },
    evidenceRefs: ['test:rotation-contract:passed'],
    visibility: 'project',
    createdAt: '2026-08-22T04:00:00.000Z',
  };
  if (kind === 'discovery') return { ...common, confidence: 0.98, status: 'verified', ...overrides };
  if (kind === 'lead') return { ...common, confidence: 0.71, status: 'open', priority: 'high', ...overrides };
  if (kind === 'shared_skill') {
    return {
      ...common,
      status: 'published',
      skillKey: 'run-rotation-contract-tests',
      recipe: {
        commands: ['npm test -- rotation-contract --token "$DEPLOYMENT_ACCOUNT_TOKEN"'],
        requiredPermissions: [],
        requiredTools: ['npm'],
        requiredEnvironmentKeys: ['DEPLOYMENT_ACCOUNT_TOKEN'],
        usageConditions: ['Run in the project test environment.'],
        actionClass: 'read_only',
      },
      ...overrides,
    };
  }
  if (kind === 'impact_notice') {
    return {
      ...common,
      status: 'pending',
      sourceKnowledgeId: 'knowledge-discovery',
      recipientAgentSessionIds: ['agent-recipient'],
      responseAction: 'Refresh the affected transaction.',
      ...overrides,
    };
  }
  return {
    ...common,
    status: 'ready',
    fromAgentSessionId: 'agent-source',
    toAgentSessionId: 'agent-recipient',
    unresolvedRisks: ['Consumer verification remains.'],
    requiredActions: ['Run recipient validation.'],
    ...overrides,
  };
}

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
    expect(manifestTools).toEqual(expect.arrayContaining([
      'synthi_codesite_get_relevant_context',
      'synthi_codesite_record_discovery',
      'synthi_codesite_record_lead',
      'synthi_codesite_publish_shared_skill',
      'synthi_codesite_file_handoff',
      'synthi_codesite_get_shared_knowledge',
      'synthi_codesite_respond_impact_notice',
    ]));
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
    expect(paths.some((relativePath) => relativePath.includes('/inbox/'))).toBe(false);
    expect(manifest).not.toHaveProperty('inbox_root');
    expect(JSON.parse(files.find((file) => file.relativePath === 'projects/site_signup_email_verification/flights/CODEX-04/black-box.json').content)).not.toHaveProperty('inbox');
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
    expect(codesiteSchemas()['agent-session.schema.json'].properties).toHaveProperty(
      'providerSessionBound',
      { type: 'boolean' },
    );
    expect(codesiteSchemas()['agent-session.schema.json'].properties).not.toHaveProperty('providerSessionRef');
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

  it('keeps recipient-private inbox and provider delivery data out of shared repo artifacts', () => {
    const project = projectFixture();
    project.agentSessions[0] = {
      ...project.agentSessions[0],
      providerSessionRef: 'provider-private-ref-sentinel',
      agentAccessToken: 'agent-token-sentinel',
      privatePrompt: 'prompt-sentinel',
      terminalTranscript: 'transcript-sentinel',
      deliverySecret: 'secret-sentinel',
      deliveryPlan: {
        modes: ['durable_inbox', 'mcp_poll', 'repo_local_projection'],
        recipient: {
          providerSessionRef: 'provider-delivery-ref-sentinel',
        },
      },
    };
    project.inboxItems[0].redactedPayload = {
      body: {
        token: 'inbox-token-sentinel',
        prompt: 'inbox-prompt-sentinel',
        transcript: 'inbox-transcript-sentinel',
        secret: 'inbox-secret-sentinel',
      },
    };

    const files = buildArtifactProjection(project);
    const paths = files.map((file) => file.relativePath);
    const serialized = files.map((file) => file.content).join('\n');
    const sharedSession = JSON.parse(files.find((file) => file.relativePath.endsWith('/agent-session.json')).content);

    expect(paths.some((relativePath) => relativePath.includes('/inbox/'))).toBe(false);
    expect(JSON.parse(files.find((file) => file.relativePath === 'manifest.json').content)).not.toHaveProperty('inbox_root');
    expect(sharedSession).toMatchObject({
      providerSessionBound: true,
      deliveryPlan: {
        modes: ['durable_inbox', 'mcp_poll'],
        recipient: { providerSessionBound: true },
      },
    });
    expect(sharedSession).not.toHaveProperty('providerSessionRef');
    expect(serialized).not.toContain('providerSessionRef');
    for (const sentinel of [
      'provider-private-ref-sentinel',
      'provider-delivery-ref-sentinel',
      'agent-token-sentinel',
      'prompt-sentinel',
      'transcript-sentinel',
      'secret-sentinel',
      'inbox-token-sentinel',
      'inbox-prompt-sentinel',
      'inbox-transcript-sentinel',
      'inbox-secret-sentinel',
      'repo_local_projection',
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it('projects only project-shareable knowledge summaries and normalized references', () => {
    const project = projectFixture();
    project.knowledgeItems = [
      persistedKnowledge(knowledgeInput('discovery', {
        title: 'Producer owns rotation',
        summary: 'CharacterController owns the rotation event.',
      }), 'knowledge-discovery'),
      persistedKnowledge(knowledgeInput('lead', {
        title: 'Verify half-turn payload',
        summary: 'Confirm the consumer behavior after a half turn.',
      }), 'knowledge-lead'),
      persistedKnowledge(knowledgeInput('shared_skill', {
        title: 'Rotation contract validation',
        summary: 'Reusable validation for the shared rotation contract.',
      }), 'knowledge-skill'),
      persistedKnowledge(knowledgeInput('handoff', {
        title: 'Producer contract ready',
        summary: 'The producer contract is ready for consumer integration.',
      }), 'knowledge-handoff'),
    ];

    const files = buildArtifactProjection(project);
    const manifest = JSON.parse(files.find((file) => file.relativePath === 'manifest.json').content);
    const index = files.find((file) => file.relativePath === manifest.shared_knowledge);
    const records = index.content.trim().split('\n').map((line) => JSON.parse(line));

    expect(manifest).toMatchObject({
      shared_knowledge: 'projects/site_signup_email_verification/knowledge/index.jsonl',
      shared_knowledge_schema: 'schemas/shared-knowledge-summary.schema.json',
    });
    expect(records.map((record) => record.kind)).toEqual(['discovery', 'handoff', 'lead', 'shared_skill']);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        schemaVersion: 'synthi.codesite.sharedKnowledgeSummary.v1',
        kind: 'discovery',
        title: 'Producer owns rotation',
        summary: 'CharacterController owns the rotation event.',
        source: {
          actorType: 'agent',
          actorId: 'agent-source',
          agentSessionId: 'agent-source',
        },
        references: expect.objectContaining({
          paths: ['src/CharacterController.cpp'],
          symbols: ['CharacterController::Turn'],
          contracts: ['rotation.completed@v2'],
          workstreamIds: ['workstream-producer'],
          transactionIds: ['txn-1'],
        }),
      }),
    ]));
    for (const record of records) {
      expect(record).not.toHaveProperty('recipe');
      expect(record).not.toHaveProperty('payload');
      expect(record).not.toHaveProperty('evidenceRefs');
      expect(record).not.toHaveProperty('recipientAgentSessionIds');
      expect(record.source).not.toHaveProperty('terminalSessionId');
    }
  });

  it('fails closed for private, restricted, recipient-specific, malformed, and sensitive knowledge', () => {
    const project = projectFixture();
    const safeDiscovery = persistedKnowledge(knowledgeInput('discovery', {
      title: 'Safe discovery',
      summary: 'The producer owns the shared contract.',
    }), 'knowledge-safe');
    safeDiscovery.payloadJson = JSON.stringify({
      ...JSON.parse(safeDiscovery.payloadJson),
      providerSessionRef: 'provider-session-ref-sentinel',
      privatePrompt: 'provider-prompt-sentinel',
      terminalTranscript: 'terminal-transcript-sentinel',
      credential: 'credential-sentinel',
      token: 'token-sentinel',
      environmentValues: { DEPLOYMENT_ACCOUNT_TOKEN: 'env-value-sentinel' },
      accountState: { billing: 'account-state-sentinel' },
    });
    safeDiscovery.references[0].metadataJson = JSON.stringify({
      secret: 'reference-secret-sentinel',
      token: 'reference-token-sentinel',
    });

    const ownerPrivate = persistedKnowledge(knowledgeInput('discovery', {
      title: 'Owner private discovery',
      summary: 'owner-private-summary-sentinel',
      visibility: 'owner_private',
      redactionClass: 'owner_private',
    }), 'knowledge-owner-private');
    const restricted = persistedKnowledge(knowledgeInput('lead', {
      title: 'Restricted lead',
      summary: 'restricted-summary-sentinel',
      visibility: 'restricted',
    }), 'knowledge-restricted');
    const impactNotice = persistedKnowledge(knowledgeInput('impact_notice', {
      title: 'Recipient impact',
      summary: 'impact-recipient-summary-sentinel',
    }), 'knowledge-impact');
    const sensitiveSummary = persistedKnowledge(knowledgeInput('discovery', {
      title: 'Unsafe copied value',
      summary: 'apiToken=summary-token-value-sentinel',
    }), 'knowledge-sensitive-summary');
    const malformed = {
      id: 'knowledge-malformed',
      projectId: project.id,
      kind: 'discovery',
      status: 'verified',
      title: 'Malformed',
      summary: 'malformed-summary-sentinel',
      payloadJson: '{',
      scopeJson: '{',
    };
    project.knowledgeItems = [safeDiscovery, ownerPrivate, restricted, impactNotice, sensitiveSummary, malformed];
    project.inboxItems.push({
      id: 'private-impact-inbox',
      kind: 'impact_notice',
      redactedPayload: {
        prompt: 'inbox-prompt-sentinel',
        token: 'inbox-token-sentinel',
        recipientPayload: 'recipient-payload-sentinel',
      },
    });

    const files = buildArtifactProjection(project);
    const knowledgeIndex = files.find((file) => file.relativePath.endsWith('/knowledge/index.jsonl'));
    const knowledgeRecords = knowledgeIndex.content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const serialized = files.map((file) => file.content).join('\n');

    expect(knowledgeRecords).toHaveLength(1);
    expect(knowledgeRecords[0]).toMatchObject({ id: 'knowledge-safe', title: 'Safe discovery' });
    for (const sentinel of [
      'provider-session-ref-sentinel',
      'provider-prompt-sentinel',
      'terminal-transcript-sentinel',
      'credential-sentinel',
      'token-sentinel',
      'env-value-sentinel',
      'account-state-sentinel',
      'reference-secret-sentinel',
      'reference-token-sentinel',
      'owner-private-summary-sentinel',
      'restricted-summary-sentinel',
      'impact-recipient-summary-sentinel',
      'summary-token-value-sentinel',
      'malformed-summary-sentinel',
      'inbox-prompt-sentinel',
      'inbox-token-sentinel',
      'recipient-payload-sentinel',
      'DEPLOYMENT_ACCOUNT_TOKEN',
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it('exposes a fail-closed pure knowledge projection and strict summary schema', () => {
    const safe = knowledgeInput('handoff', {
      id: 'handoff-safe',
      title: 'Safe handoff',
      summary: 'Validated producer state is ready.',
    });
    const privateItem = knowledgeInput('discovery', {
      id: 'discovery-private',
      visibility: 'owner_private',
      redactionClass: 'owner_private',
    });
    const projected = buildSharedKnowledgeRepoProjection([
      safe,
      privateItem,
      { ...knowledgeInput('impact_notice'), id: 'impact-private' },
      { ...knowledgeInput('lead'), id: 'lead-malformed', providerPrompt: 'private' },
    ]);
    const schema = codesiteSchemas()['shared-knowledge-summary.schema.json'];

    expect(projected).toEqual([
      expect.objectContaining({ id: 'handoff-safe', kind: 'handoff', title: 'Safe handoff' }),
    ]);
    expect(schema).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining(['projectId', 'kind', 'title', 'summary', 'references']),
      properties: {
        kind: { enum: ['discovery', 'lead', 'shared_skill', 'handoff'] },
        references: { additionalProperties: false },
      },
    });
    expect(schema.properties).not.toHaveProperty('payload');
    expect(schema.properties).not.toHaveProperty('recipe');
    expect(schema.properties).not.toHaveProperty('evidenceRefs');
    expect(schema.properties).not.toHaveProperty('recipientAgentSessionIds');
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

  it('removes stale recipient inbox files recorded by the previous projection index', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codesite-artifacts-private-inbox-'));
    const artifactRoot = path.join(root, '.synthi', 'codesite');
    const staleRelativePath = 'projects/site_signup_email_verification/inbox/CODEX-04/evt-private.json';
    const stalePath = path.join(artifactRoot, staleRelativePath);
    await fs.mkdir(path.dirname(stalePath), { recursive: true });
    await fs.writeFile(stalePath, '{"secret":"stale-private-inbox"}\n', 'utf8');
    await fs.writeFile(
      path.join(artifactRoot, '.codesite-projection-files.json'),
      `${JSON.stringify([staleRelativePath], null, 2)}\n`,
      'utf8',
    );

    await writeArtifactProjection(projectFixture(), null, artifactRoot);

    await expect(fs.readFile(stalePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const index = JSON.parse(await fs.readFile(path.join(artifactRoot, '.codesite-projection-files.json'), 'utf8'));
    expect(index.some((relativePath) => relativePath.includes('/inbox/'))).toBe(false);
    const history = await fs.readFile(path.join(artifactRoot, 'artifact-path-history.jsonl'), 'utf8');
    expect(history).toContain(`"action":"remove"`);
    expect(history).toContain(staleRelativePath);
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
