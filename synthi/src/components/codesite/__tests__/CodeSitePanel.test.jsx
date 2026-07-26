/* @vitest-environment jsdom */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  applyCodeSiteRouteRevision: vi.fn(),
  applyCodeSiteQuarantine: vi.fn(),
  createCodeSiteProject: vi.fn(),
  exportCodeSiteArtifacts: vi.fn(),
  fetchCodeSiteCoreState: vi.fn(),
  fetchCodeSiteEvidenceSlice: vi.fn(),
  fetchCodeSiteLineProvenance: vi.fn(),
  fetchCodeSiteQuarantineSlice: vi.fn(),
  fetchCodeSiteRadarState: vi.fn(),
  issueCodeSitePermit: vi.fn(),
  proposeCodeSiteRouteRevision: vi.fn(),
  replayCodeSiteQuarantine: vi.fn(),
  resumeCodeSiteMayday: vi.fn(),
  reviewCodeSiteDocument: vi.fn(),
  reviewCodeSiteRouteRevision: vi.fn(),
  simulateCodeSiteShadowMerge: vi.fn(),
  subscribeCodeSiteProjectEvents: vi.fn(),
}));

function emptyState(workspaceSlug = 'acme') {
  return {
    workspaceSlug,
    projects: [],
    project: null,
    controlState: null,
    metrics: null,
    events: [],
    artifactPreview: null,
    selectedProjectId: null,
    counts: {
      projects: 0,
      activeFlights: 0,
      activeMutationLeases: 0,
      activeTransactions: 0,
      requiredActions: 0,
      events: 0,
      proofBundles: 0,
      incidents: 0,
      inspectionRuns: 0,
    },
    collisionForecast: { riskLevel: 'unknown', risks: [] },
  };
}

vi.mock('../codesiteClient', () => ({
  applyCodeSiteRouteRevision: h.applyCodeSiteRouteRevision,
  applyCodeSiteQuarantine: h.applyCodeSiteQuarantine,
  createCodeSiteProject: h.createCodeSiteProject,
  createEmptyCodeSiteRadarState: emptyState,
  exportCodeSiteArtifacts: h.exportCodeSiteArtifacts,
  fetchCodeSiteCoreState: h.fetchCodeSiteCoreState,
  fetchCodeSiteEvidenceSlice: h.fetchCodeSiteEvidenceSlice,
  fetchCodeSiteLineProvenance: h.fetchCodeSiteLineProvenance,
  fetchCodeSiteQuarantineSlice: h.fetchCodeSiteQuarantineSlice,
  fetchCodeSiteRadarState: h.fetchCodeSiteRadarState,
  issueCodeSitePermit: h.issueCodeSitePermit,
  proposeCodeSiteRouteRevision: h.proposeCodeSiteRouteRevision,
  replayCodeSiteQuarantine: h.replayCodeSiteQuarantine,
  resumeCodeSiteMayday: h.resumeCodeSiteMayday,
  reviewCodeSiteDocument: h.reviewCodeSiteDocument,
  reviewCodeSiteRouteRevision: h.reviewCodeSiteRouteRevision,
  simulateCodeSiteShadowMerge: h.simulateCodeSiteShadowMerge,
  subscribeCodeSiteProjectEvents: h.subscribeCodeSiteProjectEvents,
}));

import CodeSitePanel from '../CodeSitePanel';
import { groupForSection } from '../lib/sectionGroups';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root;
let container;
let lastResolvedState = null;

function renderPanel(props = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<CodeSitePanel workspaceSlug="acme" {...props} />);
  });
  return container;
}

async function flush(times = 4) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function setNativeInputValue(element, value) {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
  descriptor?.set?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function laneNamed(name) {
  return [...container.querySelectorAll('[data-testid="codesite-scope-matrix-row"]')]
    .find((lane) => lane.textContent.includes(name));
}

async function confirmGovernanceReview(rationale = 'Reviewed replay, evidence, scope, and operator impact.') {
  const gate = container.querySelector('[data-testid="codesite-governance-review-gate"]');
  expect(gate).toBeTruthy();
  const textarea = gate.querySelector('[data-testid="codesite-governance-review-rationale"]');
  const confirm = gate.querySelector('[data-testid="codesite-governance-review-confirm"]');
  await act(async () => {
    setNativeInputValue(textarea, rationale);
  });
  await flush();
  expect(confirm.disabled).toBe(false);
  await act(async () => {
    confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

// Navigation is two levels now: a group tile, then a section within that group.
// This is a helper change only -- no assertion moved.
async function selectSection(key) {
  const groupKey = groupForSection(key);
  const tile = container.querySelector(
    `[data-testid="codesite-command-tile"][data-codesite-group-key="${groupKey}"]`,
  );
  if (!tile) throw new Error(`no command tile for group "${groupKey}"`);
  await act(async () => {
    tile.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();

  const tab = container.querySelector(
    `[data-testid="codesite-desktop-section-tab"][data-codesite-section-key="${key}"]`,
  );
  if (!tab) throw new Error(`no view tab for section "${key}" in group "${groupKey}"`);
  await act(async () => {
    tab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

function radarState() {
  return {
    workspaceSlug: 'acme',
    projects: [{ id: 'proj-1', title: 'Checkout coordination', counts: {} }],
    project: {
      id: 'proj-1',
      title: 'Checkout coordination',
      request: 'Coordinate checkout mutations',
      status: 'active',
      zonePolicy: {
        zones: [
          { zoneKey: 'api-zone', label: 'API airspace', class: 'B', paths: ['api/checkout/**'], risk: 'medium' },
          { zoneKey: 'api-check-zone', label: 'Health API airspace', class: 'C', paths: ['api/check/**'], risk: 'low' },
        ],
        noFlyZones: ['secrets/**'],
      },
      proofBundles: [{
        id: 'proof-1',
        transactionId: 'txn-1',
        bundleDigest: 'digest-proof-1',
        incidentReplayDigest: 'sha256:incident',
        readSetDigest: 'digest-read',
        evidenceRefs: ['test:checkout'],
        trailers: {
          'CodeSite-Project': 'proj-1',
          'CodeSite-Flight': 'ATLAS-1',
          'CodeSite-Clearance': 'lease-1',
          'CodeSite-Landing': 'completed',
          'CodeSite-Transaction': 'txn-1',
          'CodeSite-Black-Box': 'sha256:incident',
        },
      }],
      incidents: [{
        id: 'incident-1',
        category: 'black_box',
        severity: 'low',
        participants: ['ATLAS-1'],
        affectedZones: ['api/**'],
        evidenceRefs: ['incident:evidence'],
        replayDigest: 'sha256:incident',
        createdAt: '2026-06-29T23:36:00.000Z',
        incidentReplay: {
          schemaVersion: 'synthi.codesite.incidentReplay.v1',
          summary: 'Transaction txn-1 black-box handover committed.',
          transactionId: 'txn-1',
          transaction: {
            id: 'txn-1',
            mutationLeaseId: 'lease-1',
            displayCallsign: 'ATLAS-1',
            status: 'committed',
            readSet: ['api/checkout/schema.ts'],
            writeSet: ['api/checkout/route.js'],
          },
          proofBundle: {
            id: 'proof-1',
            bundleDigest: 'digest-proof-1',
            incidentReplayDigest: 'sha256:incident',
          },
          handover: {
            exportPaths: [
              'projects/proj-1/incidents/incident-replay-incident-1.jsonl',
              'projects/proj-1/handover.md',
              'projects/proj-1/proof-bundles/proof-1.proof.json',
            ],
          },
          completeness: {
            score: 0.62,
            presentEventTypes: ['transaction.committed', 'black_box.closed'],
            missingEventTypes: ['write.denied', 'transaction.aborted'],
          },
          causalEvents: [
            {
              eventId: 'event-commit',
              type: 'transaction.committed',
              transactionId: 'txn-1',
              logicalTime: 10,
              displayCallsign: 'ATLAS-1',
              path: 'api/checkout/route.js',
              evidenceRefs: ['test:checkout'],
              details: { transactionId: 'txn-1', proofBundleId: 'proof-1' },
            },
            {
              eventId: 'event-close',
              type: 'black_box.closed',
              transactionId: 'txn-1',
              logicalTime: 11,
              displayCallsign: 'ATLAS-1',
              evidenceRefs: ['incident:evidence'],
              details: { transactionId: 'txn-1', proofBundleId: 'proof-1' },
            },
          ],
        },
      }, {
        id: 'incident-mayday-1',
        category: 'mayday',
        status: 'open',
        severity: 'high',
        participants: ['ATLAS-1'],
        affectedZones: ['api/checkout/**'],
        evidenceRefs: ['incident:mayday:evidence'],
        replayDigest: 'sha256:mayday-replay',
        createdAt: '2026-06-29T23:38:00.000Z',
        incidentReplay: {
          maydayWorkflow: {
            inspectorRunId: 'inspection-mayday-1',
            suspendedLeases: [{ id: 'lease-1' }],
          },
        },
      }],
      documents: [{
        id: 'doc-1',
        kind: 'rfi',
        title: 'Need schema owner',
        status: 'pending',
        bodyJson: { question: 'Who owns the checkout schema?' },
        evidenceRefs: ['rfi:checkout-schema-owner'],
      }],
      permits: [{
        id: 'permit-1',
        permitType: 'restricted_route',
        title: 'Checkout restricted route permit',
        status: 'issued',
        scope: { allowedPaths: ['api/checkout/**'], route: ['api/checkout/**'] },
        evidenceRefs: ['permit:checkout'],
      }],
      routeRevisions: [{
        id: 'route-rev-1',
        executionPlanId: 'plan-1',
        status: 'proposed',
        previousRoute: ['api/checkout/**'],
        proposedRoute: ['api/checkout/v2/**'],
        affectedLeases: ['lease-1'],
        evidenceRefs: ['route-revision:proposal'],
      }, {
        id: 'route-rev-2',
        executionPlanId: 'plan-1',
        status: 'approved',
        previousRoute: ['api/checkout/**'],
        proposedRoute: ['api/payments/**'],
        affectedLeases: ['lease-1'],
        evidenceRefs: ['route-revision:approved'],
      }],
      inspectionRuns: [{
        id: 'inspection-1',
        displayCallsign: 'QA-1',
        status: 'passed',
        changedPaths: ['api/checkout/**'],
        inspectionSignals: [{ type: 'test', status: 'passed' }],
        evidenceRefs: ['runtime:event:inspection-1', 'test:checkout'],
      }, {
        id: 'inspection-mayday-1',
        displayCallsign: 'QA-MAYDAY',
        status: 'passed',
        changedPaths: ['api/checkout/**'],
        inspectionSignals: [{ type: 'recovery', status: 'passed' }],
        evidenceRefs: ['runtime:event:inspection-mayday-1', 'incident:mayday:evidence'],
      }],
      lineProvenance: [{
        id: 'line-1',
        transactionId: 'txn-1',
        filePath: 'api/checkout/route.js',
        lineAnchor: 'L42',
        startLine: 42,
        endLine: 44,
        displayCallsign: 'ATLAS-1',
        reasonRef: 'rfi:checkout',
        evidenceRefs: ['proof-1', 'hunk:checkout'],
        dojoSourceRefs: ['dojo:source:checkout-contract'],
        proofBundleId: 'proof-1',
        processAncestry: ['mcp:synthi_codesite_apply_patch'],
        promptSummary: 'Add checkout route',
      }],
      counterfactualRuns: [{
        id: 'cfr-1',
        shadowJobRef: 'codesite-shadow:checkout',
        baseSnapshot: 'repo@sha256:base',
        validityStrength: 'strong',
        evidenceRefs: ['codesite:shadow_merge_simulator', 'codesite:repo-policy:checkout'],
        universes: [
          {
            strategy: 'schema-first',
            result: 'passed',
            predictedCollisionRisk: 0.18,
            staleAssumptions: 0,
            inspectionCost: 7,
            confidence: 0.88,
            avoidedRisks: ['semantic_collision'],
            unresolvedRisks: [],
            requiredTowerActions: ['schema_first', 'refresh_downstream_assumptions'],
            reasonCodes: ['schema_airspace_first', 'semantic_collision_mitigated'],
            sourceSignals: {
              importGraphEdges: 2,
              testOwners: 1,
              contractRiskCount: 1,
              priorIncidents: 1,
              inspectionRuns: 1,
              signalStrength: 'strong',
            },
          },
          {
            strategy: 'frontend-backend-parallel',
            result: 'risk',
            predictedCollisionRisk: 0.72,
            staleAssumptions: 2,
            inspectionCost: 12,
            confidence: 0.88,
            avoidedRisks: [],
            unresolvedRisks: ['semantic_collision'],
            requiredTowerActions: ['schema_first', 'refresh_downstream_assumptions'],
            reasonCodes: ['parallelism_crosses_contract_airspace'],
            sourceSignals: {
              importGraphEdges: 2,
              testOwners: 1,
              contractRiskCount: 1,
              priorIncidents: 1,
              inspectionRuns: 1,
              signalStrength: 'strong',
            },
          },
        ],
        arbiterVerdict: {
          selected: 'schema-first',
          universes: [
            {
              strategy: 'schema-first',
              result: 'passed',
              predictedCollisionRisk: 0.18,
              staleAssumptions: 0,
              inspectionCost: 7,
              confidence: 0.88,
              avoidedRisks: ['semantic_collision'],
              unresolvedRisks: [],
              requiredTowerActions: ['schema_first', 'refresh_downstream_assumptions'],
              reasonCodes: ['schema_airspace_first', 'semantic_collision_mitigated'],
              sourceSignals: {
                importGraphEdges: 2,
                testOwners: 1,
                contractRiskCount: 1,
                priorIncidents: 1,
                inspectionRuns: 1,
                signalStrength: 'strong',
              },
            },
            {
              strategy: 'frontend-backend-parallel',
              result: 'risk',
              predictedCollisionRisk: 0.72,
              staleAssumptions: 2,
              inspectionCost: 12,
              confidence: 0.88,
              avoidedRisks: [],
              unresolvedRisks: ['semantic_collision'],
              requiredTowerActions: ['schema_first', 'refresh_downstream_assumptions'],
              reasonCodes: ['parallelism_crosses_contract_airspace'],
              sourceSignals: {
                importGraphEdges: 2,
                testOwners: 1,
                contractRiskCount: 1,
                priorIncidents: 1,
                inspectionRuns: 1,
                signalStrength: 'strong',
              },
            },
          ],
          evidenceRefs: ['codesite:shadow_merge_simulator', 'codesite:repo-policy:checkout'],
        },
        createdAt: '2026-06-29T23:40:00.000Z',
      }],
      inboxItems: [{
        id: 'inbox-1',
        agentSessionId: 'agent-1',
        recipientUserId: 'user-1',
        eventId: 'event-1',
        documentId: 'doc-1',
        kind: 'rfi',
        requiresResponse: true,
        status: 'pending',
        redactedPayload: { title: 'Need schema owner', documentId: 'doc-1' },
      }],
    },
    controlState: {
      projectId: 'proj-1',
      towerState: 'holding',
      activeFlights: [{
        id: 'plan-1',
        displayCallsign: 'ATLAS-1',
        mission: 'Checkout API',
        domain: 'backend',
        status: 'holding',
        route: ['api/checkout/**'],
      }],
      activeMutationLeases: [{
        id: 'lease-1',
        displayCallsign: 'ATLAS-1',
        status: 'active',
        lease: { allowedPaths: ['api/checkout/**'] },
        dojoProofRef: 'pcap-checkout-schema',
        dojoLicenseRef: 'schema.level_2@2026-06-25',
        dojoEvidenceRefs: ['dojo:evidence:checkride-1'],
        dojoLedgerCheckpointHash: 'sha256:ledger',
        dojoDecisionDigest: 'sha256:dojo-decision',
        pilotLicenseHealth: {
          status: 'active',
          level: 'IFR',
          dojoLicenseRef: 'schema.level_2@2026-06-25',
        },
        pilotLicenseRequirement: { minimumLevel: 'IFR' },
        expiresAt: '2026-06-29T23:59:00.000Z',
      }],
      activeTransactions: [{
        id: 'txn-1',
        mutationLeaseId: 'lease-1',
        status: 'open',
        writeSet: ['api/checkout/route.js'],
        openedAt: '2026-06-29T23:30:00.000Z',
      }],
      requiredActions: ['ack_event:event-1'],
      pilotLicenseHealth: [{
        key: 'agent-1',
        agentSessionId: 'agent-1',
        displayCallsign: 'ATLAS-1',
        status: 'active',
        level: 'IFR',
        dojoLicenseRef: 'schema.level_2@2026-06-25',
        dojoProofRef: 'pcap-checkout-schema',
        dojoDecisionDigest: 'sha256:dojo-decision',
        authorizedAirspace: ['api/checkout/**'],
        requiredRadar: ['api_contract', 'security'],
        earnedBy: ['dojo:evidence:checkride-1'],
        sourceDrift: {
          monitored: true,
          sourceDigest: 'sha256:source-v1',
          currentSourceDigest: 'sha256:source-v1',
          expired: false,
        },
        landingStats: { total: 3, passed: 3, failed: 0 },
        violationStats: { total: 0, critical: 0 },
        reasonCodes: ['pilot_license_health_active', 'pilot_license_source_current'],
        requiredAction: null,
        evidenceRefs: ['dojo:evidence:checkride-1'],
      }],
      filesystemBoundaryProofs: [
        {
          proofId: 'fs-boundary-event-denied',
          eventId: 'event-denied',
          eventType: 'write_denied',
          disposition: 'write_denied',
          prevented: true,
          quarantined: false,
          path: 'secrets/prod.env',
          transactionId: 'txn-1',
          mutationLeaseId: null,
          requestedMutationLeaseId: null,
          inspectedLeases: [{ mutationLeaseId: 'lease-1', displayCallsign: 'ATLAS-1', ok: false, reasonCodes: ['entered_no_fly_zone'] }],
          displayCallsign: 'ATLAS-1',
          leaseState: 'inspected_clearance_rejected',
          reasonCodes: ['entered_no_fly_zone'],
          reason: 'Write denied before repo mutation.',
          boundary: { source: 'runtime_pod_terminal', tool: 'terminal_exec', operation: 'write' },
          process: { ancestry: ['python', 'bash', 'codex-cli'], display: 'python <- bash <- codex-cli' },
          evidence: { refs: ['event:event-denied', 'runtime:event:denied-write'], lineProvenanceCount: 0 },
          evidenceRefs: ['event:event-denied', 'runtime:event:denied-write'],
          proofComplete: true,
          missingProofFields: [],
          createdAt: '2026-06-29T23:33:00.000Z',
        },
        {
          proofId: 'fs-boundary-event-incomplete',
          eventId: 'event-incomplete',
          eventType: 'write_denied',
          disposition: 'write_denied',
          prevented: true,
          quarantined: false,
          path: 'api/checkout/route.js',
          transactionId: null,
          mutationLeaseId: null,
          displayCallsign: null,
          leaseState: 'no_active_clearance',
          reasonCodes: [],
          reason: '',
          boundary: { source: 'codesitefs', tool: 'file_write', operation: 'write' },
          process: { ancestry: [], display: null },
          evidence: { refs: ['event:event-incomplete'], lineProvenanceCount: 0 },
          evidenceRefs: ['event:event-incomplete'],
          proofComplete: false,
          missingProofFields: ['reason', 'process'],
          createdAt: '2026-06-29T23:34:00.000Z',
        },
      ],
      allowedPaths: ['api/checkout/**'],
      blockedPaths: ['secrets/**'],
      collisionForecast: {
        riskLevel: 'medium',
        risks: [{ risk: 'write_overlap', severity: 'medium', conflictZone: 'api/checkout/**' }],
        runwayOccupancy: [{
          runway: 'api/checkout/**',
          route: ['api/checkout/**'],
          occupiedBy: 'ATLAS-1',
          mutationLeaseId: 'lease-1',
          runwayClass: 'B',
          diffPaths: ['api/checkout/route.js'],
          pendingInspections: ['api_contract_radar', 'landing_inspection', 'inspection:QA-1'],
          eligibleFlights: ['QA-1', 'DOCS-2'],
        }],
      },
    },
    metrics: {
      schemaVersion: 'synthi.codesite.metrics.v1',
      projectId: 'proj-1',
      status: 'measured',
      summary: {
        collisionsAvoided: 2,
        codeSiteFsBlockedWrites: 1,
        lineProvenanceCoverage: 0.67,
        blackBoxCompletenessScore: 0.82,
      },
      sections: {
        atc: [
          { key: 'collisionsPredicted', label: 'Collisions predicted', unit: 'count', value: 3, status: 'measured', sampleSize: 3 },
          { key: 'collisionsAvoided', label: 'Collisions avoided', unit: 'count', value: 2, status: 'measured', sampleSize: 2 },
        ],
        transaction: [
          { key: 'codeSiteFsBlockedWrites', label: 'CodeSiteFS blocked writes', unit: 'count', value: 1, status: 'measured', sampleSize: 1 },
          { key: 'lineProvenanceCoverage', label: 'Lines with causal provenance coverage', unit: 'ratio', value: 0.67, status: 'measured', sampleSize: 1 },
        ],
        quality: [
          { key: 'testsRedAtLanding', label: 'Tests red at landing', unit: 'count', value: 0, status: 'measured', sampleSize: 0 },
        ],
        trust: [
          { key: 'blackBoxCompletenessScore', label: 'Black-box completeness score', unit: 'ratio', value: 0.82, status: 'measured', sampleSize: 1 },
          { key: 'humanReviewTimeSavedMs', label: 'Human review time saved', unit: 'duration_ms', value: null, status: 'not_instrumented', sampleSize: 0 },
        ],
      },
    },
    events: [
      {
        id: 'event-1',
        eventType: 'flight_plan_filed',
        displayCallsign: 'ATLAS-1',
        logicalTime: 7,
        details: { executionPlanId: 'plan-1', mission: 'Checkout API' },
        evidenceRefs: ['event:evidence'],
        createdAt: '2026-06-29T23:31:00.000Z',
      },
      {
        id: 'event-2',
        eventType: 'clearance_issued',
        displayCallsign: 'ATLAS-1',
        logicalTime: 8,
        details: { leaseId: 'lease-1', route: 'api/checkout/**' },
        evidenceRefs: ['event:evidence:lease'],
        createdAt: '2026-06-29T23:32:00.000Z',
      },
      {
        id: 'event-3',
        eventType: 'write_quarantined',
        displayCallsign: 'ATLAS-1',
        mutationLeaseId: 'lease-1',
        logicalTime: 9,
        details: {
          transactionId: 'txn-1',
          path: 'docs/review.md',
          quarantineId: 'qtn-checkout-1',
          quarantineEvidence: {
            path: 'docs/review.md',
            kind: 'modified',
            beforeDigest: 'sha256:before-review',
            afterDigest: 'sha256:after-review',
            evidenceRef: 'codesitefs:quarantine:sha256:review',
          },
        },
        evidenceRefs: ['codesitefs:quarantine:sha256:review'],
        createdAt: '2026-06-29T23:33:00.000Z',
      },
    ],
    quarantines: [{
      quarantineId: 'qtn-checkout-1',
      status: 'reviewable',
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
      displayCallsign: 'ATLAS-1',
      paths: ['docs/review.md', 'docs/notes.md', 'docs/escape-link.txt'],
      changes: [
        {
          path: 'docs/review.md',
          kind: 'modified',
          quarantineEvidence: {
            path: 'docs/review.md',
            kind: 'modified',
            beforeDigest: 'sha256:before-review',
            afterDigest: 'sha256:after-review',
            evidenceRef: 'codesitefs:quarantine:sha256:review',
          },
        },
        {
          path: 'docs/notes.md',
          kind: 'created',
          quarantineEvidence: {
            path: 'docs/notes.md',
            kind: 'created',
            beforeDigest: null,
            afterDigest: 'sha256:after-notes',
            evidenceRef: 'codesitefs:quarantine:sha256:notes',
          },
        },
        {
          path: 'docs/escape-link.txt',
          kind: 'modified',
          quarantineEvidence: {
            path: 'docs/escape-link.txt',
            kind: 'modified',
            beforeDigest: 'sha256:before-escape',
            afterDigest: 'sha256:after-escape',
            evidenceRef: 'codesitefs:quarantine:sha256:escape',
          },
        },
      ],
      symlinkSanitization: {
        sanitized: [{
          path: 'docs/escape-link.txt',
          target: '/tmp/outside-target.txt',
          resolvedTarget: '/tmp/outside-target.txt',
          reason: 'quarantine_symlink_escape_replaced',
        }],
      },
      evidenceRefs: ['proof:quarantine-review', 'codesitefs:quarantine:sha256:review'],
      lifecycle: {
        capturedAt: '2026-06-29T23:33:00.000Z',
        reviewedAt: null,
        replayedAt: null,
        appliedAt: null,
      },
    }],
    artifactPreview: { files: [{ path: 'projects/proj-1/control-state.json', bytes: 1200, contentPreview: '{\\n  \"towerState\": \"holding\"\\n}\\n' }] },
    selectedProjectId: 'proj-1',
    counts: {
      projects: 1,
      activeFlights: 1,
      activeMutationLeases: 1,
      activeTransactions: 1,
      requiredActions: 1,
      events: 3,
      proofBundles: 1,
      incidents: 1,
      inspectionRuns: 2,
      quarantines: 1,
    },
    collisionForecast: {
      riskLevel: 'medium',
      risks: [{ risk: 'write_overlap', severity: 'medium', conflictZone: 'api/checkout/**' }],
    },
  };
}

describe('CodeSitePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The panel loads core on mount and each view's slice when it mounts, but
    // every test here configures one whole-state fixture via
    // `fetchCodeSiteRadarState`. Delegating the core fetch to it keeps those
    // fixtures authoritative — including their `mockResolvedValueOnce` chains,
    // since the delegate calls through to the same mock — and the slice mocks
    // then serve the matching parts of whichever state core last resolved.
    lastResolvedState = null;
    h.fetchCodeSiteCoreState.mockImplementation(async (...args) => {
      lastResolvedState = await h.fetchCodeSiteRadarState(...args);
      return lastResolvedState;
    });
    h.fetchCodeSiteEvidenceSlice.mockImplementation(async () => ({
      metrics: lastResolvedState?.metrics ?? null,
      artifactPreview: lastResolvedState?.artifactPreview ?? null,
    }));
    h.fetchCodeSiteQuarantineSlice.mockImplementation(async () => ({
      quarantines: lastResolvedState?.quarantines ?? [],
      quarantineError: lastResolvedState?.quarantineError ?? null,
    }));
    h.exportCodeSiteArtifacts.mockResolvedValue({ written: false, files: [] });
    h.fetchCodeSiteLineProvenance.mockResolvedValue([]);
    h.subscribeCodeSiteProjectEvents.mockImplementation((_workspaceSlug, _projectId, { onStatus } = {}) => {
      onStatus?.('live');
      return vi.fn();
    });
    h.issueCodeSitePermit.mockResolvedValue({
      permit: { id: 'permit-2', status: 'issued' },
      event: { eventType: 'tower_instruction' },
    });
    h.reviewCodeSiteDocument.mockResolvedValue({
      document: { id: 'doc-1', status: 'approved' },
      review: { id: 'doc-review-1', decision: 'approved' },
      event: { eventType: 'tower_instruction' },
    });
    h.proposeCodeSiteRouteRevision.mockResolvedValue({
      routeRevision: { id: 'route-rev-3', status: 'proposed' },
      event: { eventType: 'route_deviation' },
    });
    h.reviewCodeSiteRouteRevision.mockResolvedValue({
      routeRevision: { id: 'route-rev-1', status: 'approved' },
      event: { eventType: 'tower_instruction' },
    });
    h.applyCodeSiteRouteRevision.mockResolvedValue({
      routeRevision: { id: 'route-rev-2', status: 'applied' },
      event: { eventType: 'tower_instruction' },
    });
    h.resumeCodeSiteMayday.mockResolvedValue({
      incident: { id: 'incident-mayday-1', status: 'resumed' },
      event: { eventType: 'mayday_resumed' },
    });
    h.replayCodeSiteQuarantine.mockResolvedValue({
      ok: true,
      mode: 'replay',
      replay: [{ path: 'docs/review.md', kind: 'modified', evidenceRef: 'codesitefs:quarantine:sha256:review' }],
      rejected: [],
      timelineEvents: { replayed: { eventType: 'quarantine_replayed' } },
    });
    h.applyCodeSiteQuarantine.mockResolvedValue({
      ok: true,
      applied: [{ path: 'docs/review.md', kind: 'modified', evidenceRef: 'codesitefs:quarantine:sha256:review' }],
      timelineEvent: { eventType: 'quarantine_applied' },
    });
    h.simulateCodeSiteShadowMerge.mockResolvedValue({
      selected: 'test-first',
      universes: [{
        strategy: 'test-first',
        result: 'passed',
        predictedCollisionRisk: 0.16,
        staleAssumptions: 0,
        inspectionCost: 8,
        confidence: 0.9,
        avoidedRisks: ['test_collision'],
        unresolvedRisks: [],
        requiredTowerActions: ['run_owned_tests_before_landing'],
        reasonCodes: ['test_ownership_before_landing'],
        sourceSignals: {
          testOwners: 2,
          importGraphEdges: 1,
          signalStrength: 'strong',
        },
      }],
      evidenceRefs: ['codesite:shadow_merge_simulator', 'codesite:repo-policy:rerun'],
    });
  });

  afterEach(() => {
    if (root) {
      act(() => root.unmount());
      root = undefined;
    }
    if (container) {
      container.remove();
      container = undefined;
    }
  });

  it('mounts only the selected view', async () => {
    h.fetchCodeSiteRadarState.mockResolvedValue(radarState());
    renderPanel();
    await flush();

    // Overview is the landing view: no governance console in the DOM yet.
    expect(container.querySelector('[data-testid="codesite-governance-console"]')).toBeNull();

    await selectSection('governance');
    expect(container.querySelector('[data-testid="codesite-governance-console"]')).toBeTruthy();
    // And switching away unmounts it.
    await selectSection('quarantine');
    expect(container.querySelector('[data-testid="codesite-governance-console"]')).toBeNull();
    expect(container.querySelector('[data-testid="codesite-quarantine-review"]')).toBeTruthy();
  });

  it('renders overview status on first paint', async () => {
    h.fetchCodeSiteRadarState.mockResolvedValue(radarState());
    renderPanel();
    await flush();

    expect(container.querySelector('[data-testid="codesite-panel"]')).toBeTruthy();
    expect(container.textContent).toContain('Checkout coordination');
    expect(container.textContent).toContain('ATLAS-1');
    expect(container.querySelector('[data-testid="codesite-responsive-proof-target"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="codesite-tower-now"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="codesite-metric-flights"]').textContent).toContain('1');
    expect(container.querySelector('[data-testid="codesite-metric-permits"]').textContent).toContain('1');
    expect(container.querySelector('[data-testid="codesite-tower-now-clearance"]').textContent).toContain('1');
    expect(container.querySelector('[data-testid="codesite-tower-now-mayday"]').textContent).toContain('1');
    expect(container.querySelector('[data-testid="codesite-mobile-section-tabs"]')).toBeTruthy();
    expect(h.subscribeCodeSiteProjectEvents).toHaveBeenCalledWith(
      'acme',
      'proj-1',
      expect.objectContaining({
        onEvent: expect.any(Function),
        onStatus: expect.any(Function),
      }),
    );
  });

  it('surfaces required actions on the overview with a drill-in to governance', async () => {
    const state = radarState();
    state.controlState.requiredActions = [{
      kind: 'review_document',
      title: 'Review checkout schema RFI',
      owner: 'ATLAS-1',
      documentId: 'doc-1',
      severity: 'high',
    }];
    h.fetchCodeSiteRadarState.mockResolvedValue(state);
    renderPanel();
    await flush();

    const digest = container.querySelector('[data-testid="codesite-overview-attention"]');
    expect(digest).toBeTruthy();
    expect(digest.textContent).toContain('Review checkout schema RFI');

    await act(async () => {
      digest.querySelector('[data-testid="codesite-overview-attention-drill"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(container.querySelector('[data-testid="codesite-governance-console"]')).toBeTruthy();
  });

  it('renders the workspace graph under the graph view', async () => {
    h.fetchCodeSiteRadarState.mockResolvedValue(radarState());
    renderPanel();
    await flush();
    await selectSection('radar');

    expect(container.textContent).toContain('Workspace Graph');
    const scopeTopology = container.querySelector('[data-testid="codesite-scope-topology"]');
    const matrixRows = container.querySelectorAll('[data-testid="codesite-scope-matrix-row"]');
    const agentNodes = container.querySelectorAll('[data-testid="codesite-scope-agent-node"]');
    const pathNodes = container.querySelectorAll('[data-testid="codesite-scope-path-node"]');
    const guardrailNodes = container.querySelectorAll('[data-testid="codesite-scope-guardrail-node"]');
    expect(scopeTopology).toBeTruthy();
    expect(container.querySelector('[data-testid="codesite-work-graph"]')).toBeTruthy();
    expect(scopeTopology.textContent).toContain('Workspace Graph');
    expect(scopeTopology.textContent).toContain('Paths -> Agents -> Checks');
    expect(scopeTopology.textContent).toContain('Paths');
    expect(scopeTopology.textContent).toContain('Agents');
    expect(scopeTopology.textContent).toContain('Checks');
    expect(matrixRows).toHaveLength(2);
    expect(agentNodes).toHaveLength(2);
    expect(pathNodes).toHaveLength(2);
    expect(guardrailNodes).toHaveLength(2);
    expect(pathNodes[0].textContent).toContain('Shared contract');
    expect(scopeTopology.textContent).toContain('Conflicts');
    expect(scopeTopology.textContent).toContain('Commit checks');
    expect(scopeTopology.textContent).not.toContain('Conflict area');
    expect(scopeTopology.textContent).not.toContain('Event trace');
    expect(container.textContent).toContain('Commit checks');
    expect(container.textContent).toContain('QA-1');
    expect(container.textContent).toContain('passed');
    expect(laneNamed('API work scope').textContent).toContain('ATLAS-1');
    expect(laneNamed('Health API work scope').textContent).not.toContain('ATLAS-1');
    expect(container.textContent).toContain('API work scope');
    expect(container.textContent).toContain('write_overlap');
    expect(container.querySelector('[data-testid="codesite-scope-topology"]')).toBeTruthy();
  });

  it('renders the activity feed and audit log under the activity view', async () => {
    h.fetchCodeSiteRadarState.mockResolvedValue(radarState());
    renderPanel();
    await flush();
    await selectSection('tower');

    expect(container.querySelector('[data-testid="codesite-activity-feed"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="codesite-event-stream-status"]').textContent).toContain('Live updates connected');
    expect(container.textContent).toContain('logicalTime');
    expect(container.textContent).toContain('event:evidence');
    expect(container.textContent).toContain('Agent Inbox');
    expect(container.textContent).toContain('Need schema owner');
  });

  it('renders locks evidence under the locks view', async () => {
    h.fetchCodeSiteRadarState.mockResolvedValue(radarState());
    renderPanel();
    await flush();
    await selectSection('runway');

    expect(container.textContent).toContain('ATLAS-1');
    expect(container.textContent).toContain('pcap-checkout-schema');
    expect(container.textContent).toContain('schema.level_2@2026-06-25');
    expect(container.textContent).toContain('dojo:evidence:checkride-1');
    expect(container.textContent).toContain('Path Locks');
    expect(container.textContent).toContain('Agent Readiness');
    expect(container.querySelector('[data-testid="codesite-pilot-license-health"]').textContent).toContain('IFR');
    expect(container.querySelector('[data-testid="codesite-pilot-license-health"]').textContent).toContain('pilot_license_source_current');
    expect(container.textContent).toContain('agent:active');
    expect(container.textContent).toContain('min:IFR');
    const runwayRow = container.querySelector('[data-testid="codesite-runway-row"]');
    expect(runwayRow.textContent).toContain('api/checkout/**');
    expect(runwayRow.textContent).toContain('ATLAS-1');
    expect(runwayRow.textContent).toContain('api/checkout/route.js');
    expect(runwayRow.textContent).toContain('api_contract_radar');
    expect(runwayRow.textContent).toContain('inspection:QA-1');
    expect(runwayRow.textContent).toContain('QA-1');
  });

  it('reviews and applies a quarantine under the quarantine view', async () => {
    h.fetchCodeSiteRadarState.mockResolvedValue(radarState());
    renderPanel();
    await flush();
    await selectSection('quarantine');

    expect(container.textContent).toContain('Filesystem Boundary Evidence');
    const boundaryProof = container.querySelector('[data-testid="codesite-filesystem-boundary-proof"]');
    expect(boundaryProof).toBeTruthy();
    expect(boundaryProof.textContent).toContain('secrets/prod.env');
    expect(boundaryProof.textContent).toContain('lease-1');
    expect(boundaryProof.textContent).toContain('inspected_clearance_rejected');
    expect(boundaryProof.textContent).toContain('entered_no_fly_zone');
    expect(boundaryProof.textContent).toContain('python <- bash <- codex-cli');
    expect(boundaryProof.textContent).toContain('runtime:event:denied-write');
    expect(boundaryProof.textContent).toContain('incomplete');
    expect(boundaryProof.textContent).toContain('missing process');
    expect(container.textContent).toContain('Quarantine Review');
    expect(container.querySelector('[data-testid="codesite-quarantine-review"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="codesite-quarantine-summary"]').textContent).toContain('qtn-checkout-1');
    expect(container.querySelector('[data-testid="codesite-quarantine-summary"]').textContent).toContain('txn-1');
    expect(container.textContent).toContain('docs/review.md');
    expect(container.textContent).toContain('docs/notes.md');
    expect(container.textContent).toContain('quarantine_symlink_escape_replaced');
    expect(container.querySelector('[data-testid="codesite-quarantine-symlink-guard"]').textContent).toContain('/tmp/outside-target.txt');
    expect(container.querySelector('[data-testid="codesite-quarantine-apply-button"]').disabled).toBe(true);
    const quarantineRows = [...container.querySelectorAll('[data-testid="codesite-quarantine-change-row"]')];
    const reviewRow = quarantineRows.find((row) => row.textContent.includes('docs/review.md'));
    const notesRow = quarantineRows.find((row) => row.textContent.includes('docs/notes.md'));
    expect(reviewRow).toBeTruthy();
    expect(notesRow).toBeTruthy();
    await act(async () => {
      reviewRow.querySelector('[data-testid="codesite-quarantine-path-toggle"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    // The toggle is a <span> swatch inside the row; checkbox semantics live on
    // the row button itself (role="checkbox" aria-checked), so assert there.
    expect(reviewRow.getAttribute('aria-checked')).toBe('true');
    expect(notesRow.getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      container.querySelector('[data-testid="codesite-quarantine-replay-button"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(h.replayCodeSiteQuarantine).toHaveBeenCalledWith('acme', 'qtn-checkout-1', expect.objectContaining({
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
      displayCallsign: 'ATLAS-1',
      paths: ['docs/review.md'],
    }));
    expect(container.querySelector('[data-testid="codesite-quarantine-replay-result"]').textContent).toContain('docs/review.md');
    expect(container.querySelector('[data-testid="codesite-quarantine-apply-button"]').disabled).toBe(false);
    await act(async () => {
      container.querySelector('[data-testid="codesite-quarantine-apply-button"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(h.applyCodeSiteQuarantine).toHaveBeenCalledWith('acme', 'qtn-checkout-1', expect.objectContaining({
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
      displayCallsign: 'ATLAS-1',
      paths: ['docs/review.md'],
    }));
    expect(container.querySelector('[data-testid="codesite-quarantine-apply-result"]').textContent).toContain('docs/review.md');
    expect(container.querySelector('[data-testid="codesite-quarantine-summary"]').textContent).toContain('partially_applied');
    expect(container.querySelector('[data-testid="codesite-quarantine-summary"]').textContent).toContain('2 pending');
    expect(container.querySelector('[data-testid="codesite-quarantine-timeline"]').textContent).toContain('Captured');
  });

  it('exports the artifact projection from the evidence view', async () => {
    h.fetchCodeSiteRadarState.mockResolvedValue(radarState());
    renderPanel();
    await flush();
    await selectSection('evidence');

    expect(container.textContent).toContain('Success Metrics');
    expect(container.textContent).toContain('Collisions avoided');
    expect(container.textContent).toContain('CodeSiteFS blocked writes');
    expect(container.textContent).toContain('Line coverage');
    expect(container.textContent).toContain('67%');
    expect(container.textContent).toContain('Black box');
    expect(container.textContent).toContain('82%');
    expect(container.textContent).toContain('CodeSite-Clearance');
    expect(container.textContent).toContain('CodeSite-Transaction');
    expect(container.textContent).toContain('projects/proj-1/control-state.json');
    expect(container.textContent).toContain('towerState');

    await act(async () => {
      container.querySelector('[data-testid="codesite-export"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(h.exportCodeSiteArtifacts).toHaveBeenCalledWith('acme', 'proj-1');
  });

  it('renders replay handover and lineage under the replay view', async () => {
    h.fetchCodeSiteRadarState.mockResolvedValue(radarState());
    renderPanel();
    await flush();
    await selectSection('replay');

    const replayHandover = container.querySelector('[data-testid="codesite-causal-replay-handover"]');
    expect(replayHandover).toBeTruthy();
    expect(replayHandover.textContent).toContain('txn-1');
    expect(replayHandover.textContent).toContain('proof-1');
    expect(replayHandover.textContent).toContain('sha256:incident');
    expect(replayHandover.textContent).toContain('Event evidence digest');
    expect(replayHandover.textContent).toContain('transaction.committed');
    expect(replayHandover.textContent).toContain('black_box.closed');
    expect(replayHandover.textContent).toContain('write.denied');
    expect(replayHandover.textContent).toContain('incident-replay-incident-1.jsonl');
    expect(container.textContent).toContain('Lineage Inspector');
    expect(container.textContent).toContain('api/checkout/route.js');
    expect(container.textContent).toContain('L42-L44');
    expect(container.textContent).toContain('hunk:checkout');

    h.fetchCodeSiteLineProvenance.mockResolvedValueOnce([{
      ...radarState().project.lineProvenance[0],
      transaction: { id: 'txn-1', mutationLeaseId: 'lease-1' },
      mutationLease: { id: 'lease-1', displayCallsign: 'ATLAS-1' },
      proofBundles: [{ id: 'proof-1', bundleDigest: 'digest-proof-1' }],
    }]);
    await act(async () => {
      container.querySelector('[data-testid="codesite-lineage-row"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(h.fetchCodeSiteLineProvenance).toHaveBeenCalledWith('acme', {
      projectId: 'proj-1',
      filePath: 'api/checkout/route.js',
      lineAnchor: 'L42',
      lineNumber: 42,
    });
    const inspector = container.querySelector('[data-testid="codesite-line-inspector"]');
    expect(inspector.textContent).toContain('L42-L44 causal trace');
    expect(inspector.textContent).toContain('txn-1');
    expect(inspector.textContent).toContain('ATLAS-1 / lease-1');
    expect(inspector.textContent).toContain('rfi:checkout');
    expect(inspector.textContent).toContain('digest-proof-1');
    expect(inspector.textContent).toContain('runtime:event:inspection-1');
    expect(inspector.textContent).toContain('dojo:source:checkout-contract');
    expect(inspector.textContent).toContain('mcp:synthi_codesite_apply_patch');
    expect(inspector.textContent).toContain('Add checkout route');
  });

  it('runs the coordination simulator under the simulator view', async () => {
    h.fetchCodeSiteRadarState.mockResolvedValue(radarState());
    renderPanel();
    await flush();
    await selectSection('simulator');

    expect(container.textContent).toContain('Coordination Simulator');
    expect(container.querySelector('[data-testid="codesite-tower-selected"]').textContent).toContain('schema-first');
    expect(container.textContent).toContain('frontend-backend-parallel');
    expect(container.textContent).toContain('refresh_downstream_assumptions');
    expect(container.textContent).toContain('importGraphEdges:2');
    expect(container.textContent).toContain('codesite:repo-policy:checkout');

    await act(async () => {
      container.querySelector('[data-testid="codesite-run-tower-simulator"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(h.simulateCodeSiteShadowMerge).toHaveBeenCalledWith('acme', 'proj-1');
    expect(container.querySelector('[data-testid="codesite-tower-selected"]').textContent).toContain('test-first');
    expect(container.textContent).toContain('run_owned_tests_before_landing');
  });

  it('runs the governance queue from the governance view', async () => {
    h.fetchCodeSiteRadarState.mockResolvedValue(radarState());
    renderPanel();
    await flush();
    await selectSection('governance');

    expect(container.querySelector('[data-testid="codesite-governance-console"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="codesite-document-row"]').textContent).toContain('Need schema owner');
    expect(container.querySelector('[data-testid="codesite-route-revision-row"]').textContent).toContain('api/checkout/v2/**');
    expect(container.querySelector('[data-testid="codesite-mayday-banner"]').textContent).toContain('1 open');
    expect(container.querySelector('[data-testid="codesite-ground-stop-row"]').textContent).toContain('paused incident');
    expect(container.querySelector('[data-testid="codesite-ground-stop-row"]').textContent).toContain('inspection-mayday-1');
    const requiredAction = container.querySelector('[data-testid="codesite-required-action-row"]');
    expect(requiredAction).toBeTruthy();
    expect(requiredAction.textContent).toContain('ack_event:event-1');
    expect(requiredAction.textContent).toContain('medium');
    expect(requiredAction.textContent).toContain('owner: event-1');
    expect(requiredAction.querySelector('[data-testid="codesite-required-action-review"]')).toBeTruthy();

    await act(async () => {
      container.querySelector('[data-testid="codesite-issue-permit-button"]')
        .closest('form')
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(h.issueCodeSitePermit).not.toHaveBeenCalled();
    await confirmGovernanceReview('Approval reviewed against route, evidence, and protected scope.');
    expect(h.issueCodeSitePermit).toHaveBeenCalledWith('acme', 'proj-1', expect.objectContaining({
      permitType: 'restricted_route',
      executionPlanId: 'plan-1',
      mutationLeaseId: 'lease-1',
      allowedPaths: ['api/checkout/**'],
      route: ['api/checkout/**'],
      scope: { allowedPaths: ['api/checkout/**'], route: ['api/checkout/**'] },
      approval: expect.objectContaining({
        rationale: 'Approval reviewed against route, evidence, and protected scope.',
      }),
      evidenceRefs: ['codesite:ui:permit:proj-1'],
    }));

    await act(async () => {
      container.querySelector('[data-testid="codesite-document-approve-button"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    await confirmGovernanceReview('Document reviewed with evidence and recipient impact.');
    expect(h.reviewCodeSiteDocument).toHaveBeenCalledWith('acme', 'doc-1', expect.objectContaining({
      decision: 'approved',
      summary: 'Document reviewed with evidence and recipient impact.',
      reviewTimeMs: 90_000,
      baselineReviewTimeMs: 300_000,
      evidenceRefs: ['codesite:ui:document-review:doc-1'],
    }));

    await act(async () => {
      container.querySelector('[data-testid="codesite-route-propose-button"]')
        .closest('form')
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    await confirmGovernanceReview('Route proposal reviewed for affected lease and replay evidence.');
    expect(h.proposeCodeSiteRouteRevision).toHaveBeenCalledWith('acme', 'plan-1', expect.objectContaining({
      proposedRoute: ['api/checkout/**'],
      reason: 'operator_reroute: Route proposal reviewed for affected lease and replay evidence.',
      affectedLeases: ['lease-1'],
      evidenceRefs: ['codesite:ui:route-revision:proj-1'],
    }));

    const routeRows = [...container.querySelectorAll('[data-testid="codesite-route-revision-row"]')];
    const proposedRouteRow = routeRows.find((row) => row.textContent.includes('api/checkout/v2/**'));
    const approvedRouteRow = routeRows.find((row) => row.textContent.includes('api/payments/**'));
    await act(async () => {
      proposedRouteRow.querySelector('[data-testid="codesite-route-review-button"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    await confirmGovernanceReview('Route review checked scope, evidence, and downstream impact.');
    expect(h.reviewCodeSiteRouteRevision).toHaveBeenCalledWith('acme', 'route-rev-1', expect.objectContaining({
      decision: 'approved',
      reason: 'Route review checked scope, evidence, and downstream impact.',
      evidenceRefs: ['codesite:ui:route-review:route-rev-1'],
    }));

    await act(async () => {
      approvedRouteRow.querySelector('[data-testid="codesite-route-apply-button"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    await confirmGovernanceReview('Route application reviewed against active clearance and proof refs.');
    expect(h.applyCodeSiteRouteRevision).toHaveBeenCalledWith('acme', 'route-rev-2', expect.objectContaining({
      appliedBy: 'codesite_governance_console',
      rationale: 'Route application reviewed against active clearance and proof refs.',
      evidenceRefs: ['codesite:ui:route-apply:route-rev-2'],
    }));

    await act(async () => {
      container.querySelector('[data-testid="codesite-resume-mayday-submit"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    await confirmGovernanceReview('Mayday resume reviewed against recovery inspection and replay.');
    expect(h.resumeCodeSiteMayday).toHaveBeenCalledWith('acme', 'incident-mayday-1', expect.objectContaining({
      approved: true,
      humanApproval: true,
      rationale: 'Mayday resume reviewed against recovery inspection and replay.',
      inspectionRunIds: ['inspection-mayday-1'],
      replayRefs: ['sha256:mayday-replay'],
      evidenceRefs: ['codesite:ui:mayday-resume:incident-mayday-1'],
    }));
  });

  it('renders inspections and incidents under the inspections view', async () => {
    h.fetchCodeSiteRadarState.mockResolvedValue(radarState());
    renderPanel();
    await flush();
    await selectSection('inspections');

    expect(container.textContent).toContain('Inspections & Incidents');
    expect(container.textContent).toContain('QA-1');
    expect(container.textContent).toContain('Inspections Queue');
  });

  it('exposes show-all controls for capped governance queues', async () => {
    const state = radarState();
    state.project.documents = Array.from({ length: 6 }, (_, index) => ({
      id: `doc-${index + 1}`,
      kind: 'rfi',
      title: `Document ${index + 1}`,
      status: 'pending',
    }));
    state.project.routeRevisions = Array.from({ length: 6 }, (_, index) => ({
      id: `route-rev-${index + 1}`,
      executionPlanId: 'plan-1',
      status: index === 5 ? 'approved' : 'proposed',
      proposedRoute: [`api/checkout/v${index + 1}/**`],
    }));
    state.project.incidents = [
      ...state.project.incidents.filter((incident) => incident.category !== 'mayday'),
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `incident-mayday-${index + 1}`,
        category: 'mayday',
        status: 'open',
        severity: 'high',
        affectedZones: ['api/checkout/**'],
        incidentReplay: { maydayWorkflow: { inspectorRunId: 'inspection-mayday-1' } },
      })),
    ];
    h.fetchCodeSiteRadarState.mockResolvedValue(state);

    renderPanel();
    await flush();
    await selectSection('governance');

    expect(container.querySelector('[data-testid="codesite-documents-show-all"]').textContent)
      .toContain('Show all documents (6)');
    expect(container.querySelector('[data-testid="codesite-route-revisions-show-all"]').textContent)
      .toContain('Show all plan changes (6)');
    expect(container.querySelector('[data-testid="codesite-maydays-show-all"]').textContent)
      .toContain('Show all paused incidents (4)');
  });

  it('routes structured required actions into the governance review gate', async () => {
    const state = radarState();
    state.controlState.requiredActions = [{
      kind: 'review_document',
      title: 'Review checkout schema RFI',
      owner: 'ATLAS-1',
      documentId: 'doc-1',
      severity: 'high',
      evidenceRefs: ['rfi:checkout-schema-owner'],
      scope: ['api/checkout/**'],
    }];
    h.fetchCodeSiteRadarState.mockResolvedValue(state);

    renderPanel();
    await flush();
    await selectSection('governance');

    await act(async () => {
      container.querySelector('[data-testid="codesite-required-action-review"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();

    expect(container.querySelector('[data-testid="codesite-governance-review-gate"]')).toBeTruthy();
    expect(h.reviewCodeSiteDocument).not.toHaveBeenCalled();
    await confirmGovernanceReview('Required action reviewed with evidence and scope.');
    expect(h.reviewCodeSiteDocument).toHaveBeenCalledWith('acme', 'doc-1', expect.objectContaining({
      decision: 'approved',
      summary: 'Required action reviewed with evidence and scope.',
    }));
  });

  it('routes a required action for a proposed plan change into the review gate', async () => {
    const state = radarState();
    // route-rev-1 is `proposed`: reviewable, not yet appliable.
    state.controlState.requiredActions = [{
      kind: 'review_route_revision',
      title: 'Approve checkout reroute',
      owner: 'ATLAS-1',
      routeRevisionId: 'route-rev-1',
      severity: 'high',
      evidenceRefs: ['route-revision:proposal'],
      scope: ['api/checkout/v2/**'],
    }];
    h.fetchCodeSiteRadarState.mockResolvedValue(state);

    renderPanel();
    await flush();
    await selectSection('governance');

    await act(async () => {
      container.querySelector('[data-testid="codesite-required-action-review"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();

    expect(container.querySelector('[data-testid="codesite-governance-review-gate"]')).toBeTruthy();
    await confirmGovernanceReview('Plan change approved from the required actions queue.');
    expect(h.reviewCodeSiteRouteRevision).toHaveBeenCalledWith('acme', 'route-rev-1', expect.objectContaining({
      decision: 'approved',
    }));
  });

  it('shows active workstreams in the workspace graph without radar markers', async () => {
    const state = radarState();
    state.controlState.activeFlights = state.controlState.activeFlights.map((flight) => ({
      ...flight,
      status: 'airborne',
    }));
    h.fetchCodeSiteRadarState.mockResolvedValue(state);

    renderPanel();
    await flush();
    await selectSection('radar');

    expect(container.querySelectorAll('[data-testid="codesite-scope-agent-node"]')).toHaveLength(2);
    expect(container.querySelector('[data-testid="codesite-scope-topology"]').textContent).toContain('ATLAS-1');
    expect(container.querySelector('[data-testid="codesite-scope-topology"]').textContent).not.toContain('holding pattern');
  });

  it('summarizes the latest activity tail in the graph evidence guardrail', async () => {
    const state = radarState();
    state.project.inspectionRuns = [];
    state.collisionForecast.risks = [];
    state.controlState.collisionForecast.risks = [];
    state.events = [
      'flight_plan_filed',
      'clearance_requested',
      'clearance_issued',
      'transaction_opened',
      'write_attempted',
      'write_allowed',
      'transaction_validated',
      'landing_requested',
      'inspection_result',
    ].map((eventType, index) => ({
      id: `event-${index + 1}`,
      eventType,
      displayCallsign: 'ATLAS-1',
      logicalTime: index + 1,
      details: { index },
      evidenceRefs: [`event:evidence:${index + 1}`],
      createdAt: `2026-06-29T23:${String(31 + index).padStart(2, '0')}:00.000Z`,
    }));
    state.counts.events = state.events.length;

    h.fetchCodeSiteRadarState.mockResolvedValue(state);
    renderPanel();
    await flush();
    await selectSection('radar');

    const guardrails = [...container.querySelectorAll('[data-testid="codesite-scope-guardrail-node"]')];
    const evidenceGuardrail = guardrails.find((node) => node.textContent.includes('Evidence'));
    expect(evidenceGuardrail).toBeTruthy();
    expect(evidenceGuardrail.textContent).toContain('7 events');
    expect(container.querySelector('[data-testid="codesite-replay-trace"]')).toBeFalsy();
  });

  it('opens the first project from the empty state', async () => {
    h.fetchCodeSiteRadarState
      .mockResolvedValueOnce(emptyState())
      .mockResolvedValue(radarState());
    h.createCodeSiteProject.mockResolvedValue({ id: 'proj-1', title: 'Landing project' });

    renderPanel();
    await flush();

    expect(container.querySelector('[data-testid="codesite-empty-state"]')).toBeTruthy();
    const input = container.querySelector('input');
    act(() => {
      setNativeInputValue(input, 'Landing project');
    });

    await act(async () => {
      container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();

    expect(h.createCodeSiteProject).toHaveBeenCalledWith(
      'acme',
      expect.objectContaining({ title: 'Landing project', request: 'Landing project' }),
    );
    expect(container.textContent).toContain('Checkout coordination');
  });

  it('filters the operating queue by saved view', async () => {
    h.fetchCodeSiteRadarState.mockResolvedValue(radarState());
    renderPanel();
    await flush();

    const queue = () => container.querySelector('[data-testid="codesite-operating-model"]');
    const savedView = (name) =>
      container.querySelector(`[data-testid="codesite-saved-view-${name}"]`);

    expect(savedView('active').getAttribute('aria-pressed')).toBe('true');
    const before = queue().textContent;
    expect(before).toContain('Workstreams');

    await act(async () => {
      savedView('review').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(savedView('review').getAttribute('aria-pressed')).toBe('true');
    expect(savedView('active').getAttribute('aria-pressed')).toBe('false');
    expect(queue().textContent).not.toBe(before);
    expect(queue().textContent).toContain('Governance');
    expect(queue().textContent).not.toContain('Workstreams');

    await act(async () => {
      savedView('evidence').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(queue().textContent).toContain('Evidence');
    expect(queue().textContent).not.toContain('Governance');
  });

  it('takes core on mount and the evidence slice only when Evidence opens', async () => {
    h.fetchCodeSiteRadarState.mockResolvedValue(radarState());
    renderPanel();
    await flush();

    // First paint takes core only. The quarantine fan-out still runs, because
    // the Overview digest counts quarantines, but it runs after core rather
    // than blocking it. Evidence has no Overview consumer, so nothing should
    // pay for it until that view is opened.
    expect(h.fetchCodeSiteCoreState).toHaveBeenCalled();
    expect(h.fetchCodeSiteQuarantineSlice).toHaveBeenCalled();
    expect(h.fetchCodeSiteEvidenceSlice).not.toHaveBeenCalled();

    await selectSection('governance');
    expect(h.fetchCodeSiteEvidenceSlice).not.toHaveBeenCalled();

    await selectSection('evidence');
    expect(h.fetchCodeSiteEvidenceSlice).toHaveBeenCalled();
  });

  it('refreshes everything when the user asks explicitly', async () => {
    h.fetchCodeSiteRadarState.mockResolvedValue(radarState());
    renderPanel();
    await flush();
    h.fetchCodeSiteRadarState.mockClear();
    h.fetchCodeSiteCoreState.mockClear();

    await act(async () => {
      container
        .querySelector('[data-testid="codesite-refresh"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    // Refresh is the one path that still pays for the composite fetch, because
    // it is the user asking for everything rather than the panel guessing. The
    // core mock delegates to the composite mock, so a plain "was called" check
    // would also pass for a core load — the composite has to be called strictly
    // more often than core for the direct call to be proven.
    expect(h.fetchCodeSiteRadarState).toHaveBeenCalledWith('acme', 'proj-1');
    expect(h.fetchCodeSiteRadarState.mock.calls.length).toBeGreaterThan(
      h.fetchCodeSiteCoreState.mock.calls.length,
    );
  });
});
