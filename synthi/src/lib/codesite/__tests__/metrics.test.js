import { describe, expect, it } from 'vitest';
import { buildCodeSiteMetrics } from '../metrics.js';

describe('CodeSite success metrics', () => {
  it('derives ATC, transaction, quality, and trust metrics from persisted CodeSite evidence', () => {
    const metrics = buildCodeSiteMetrics({
      workspaceSlug: 'acme',
      controlState: {
        collisionForecast: {
          risks: [{ id: 'risk-1', risk: 'write_overlap', conflictZone: 'api/auth/**' }],
        },
      },
      project: {
        id: 'project-1',
        workspaceSlug: 'acme',
        executionPlans: [{
          id: 'plan-1',
          displayCallsign: 'ATLAS-1',
          status: 'holding',
          filedAt: '2026-07-01T00:00:00.000Z',
        }],
        mutationLeases: [{
          id: 'lease-1',
          executionPlanId: 'plan-1',
          displayCallsign: 'ATLAS-1',
          status: 'active',
          issuedAt: '2026-07-01T00:05:00.000Z',
        }],
        mutationTxns: [{
          id: 'txn-1',
          mutationLeaseId: 'lease-1',
          status: 'committed',
          writeSet: ['api/auth/route.ts'],
          observedWriteSet: ['api/auth/route.ts'],
          commitDecision: { reasonCodes: ['serializable_validation_passed'] },
        }, {
          id: 'txn-2',
          mutationLeaseId: 'lease-1',
          status: 'aborted',
          writeSet: ['api/auth/schema.ts'],
          observedWriteSet: ['api/auth/schema.ts'],
        }],
        assumptions: [{
          id: 'assumption-1',
          status: 'invalidated',
          assumptionKey: 'auth.signup.v1',
        }],
        policyDecisions: [{
          id: 'decision-hold',
          decision: 'hold',
          reasonCodes: ['collision_avoidance_hold', 'schema_first_leader_clearance'],
        }, {
          id: 'decision-nofly',
          decision: 'block',
          reasonCodes: ['entered_no_fly_zone'],
          decisionBody: {
            path: 'infra/prod/secrets.env',
            tool: 'terminal_exec',
          },
        }],
        events: [{
          id: 'event-write-attempt',
          eventType: 'write_attempted',
          mutationLeaseId: 'lease-1',
          actorType: 'transaction',
          actorId: 'txn-1',
          details: {
            transactionId: 'txn-1',
            path: 'api/auth/route.ts',
          },
        }, {
          id: 'event-write-ok',
          eventType: 'write_allowed',
          mutationLeaseId: 'lease-1',
          actorType: 'transaction',
          actorId: 'txn-1',
          details: {
            transactionId: 'txn-1',
            path: 'api/auth/route.ts',
            invalidatedAssumptions: ['assumption-1'],
          },
          evidenceRefs: ['write:evidence'],
        }, {
          id: 'event-denied',
          eventType: 'write_denied',
          actorType: 'codesitefs',
          details: {
            path: 'infra/prod/secrets.env',
            reasonCodes: ['entered_no_fly_zone'],
            codesiteFsEvent: { source: 'terminal' },
          },
          evidenceRefs: ['codesitefs:block'],
        }, {
          id: 'event-quarantine',
          eventType: 'write_quarantined',
          actorType: 'codesitefs',
          details: { path: 'tmp/quarantine/output.txt' },
        }, {
          id: 'event-validate',
          eventType: 'transaction_validated',
          details: {
            decision: {
              reasonCodes: ['stale_read_detected'],
              staleReads: [{ eventId: 'event-write-ok' }],
            },
          },
        }, {
          id: 'event-ground-stop',
          eventType: 'ground_stop',
          details: { reasonCodes: ['mayday_ground_stop'] },
        }, {
          id: 'event-black-box',
          eventType: 'black_box_closed',
          details: {
            proofBundleId: 'proof-1',
            verifier: { command: 'node verify-black-box.mjs', status: 'passed' },
          },
        }, {
          id: 'event-tower-plan',
          eventType: 'tower_instruction',
          details: {
            route: ['api/auth/**'],
            towerInstruction: 'Flight plan filed for api/auth/**',
          },
        }],
        incidents: [{
          id: 'incident-1',
          category: 'near_miss',
          severity: 'medium',
          affectedZones: ['api/auth/**'],
          replayDigest: 'sha256:replay',
          incidentReplay: {
            completeness: { score: 0.77 },
          },
          evidenceRefs: ['incident:evidence'],
        }],
        inspectionRuns: [{
          id: 'inspection-1',
          executionPlanId: 'plan-1',
          displayCallsign: 'QA-1',
          status: 'passed',
          changedPaths: ['api/auth/**'],
          inspectionSignals: [
            { key: 'tests', status: 'failed', evidenceRefs: ['test:red'] },
            { key: 'security', status: 'failed', evidenceRefs: ['security:finding'] },
            { key: 'migration', status: 'passed', evidenceRefs: ['migration:plan'] },
          ],
          evidenceRefs: ['inspection:evidence'],
        }],
        proofBundles: [{
          id: 'proof-1',
          bundleDigest: 'sha256:bundle',
          evidenceRefs: ['proof:evidence'],
        }],
        documentReviews: [{
          id: 'review-1',
          documentId: 'document-1',
          status: 'completed',
          decision: 'approved',
          reasonCodes: ['document_approved'],
          body: {
            reviewTimeMs: 90_000,
            baselineReviewTimeMs: 300_000,
          },
          evidenceRefs: ['document-review:evidence'],
        }],
        lineProvenance: [{
          id: 'line-1',
          filePath: 'api/auth/route.ts',
          evidenceRefs: ['line:evidence'],
        }],
        counterfactualRuns: [{
          id: 'counterfactual-1',
          universes: [{
            strategy: 'schema-first',
            result: 'passed',
            predictedCollisionRisk: 0.2,
            avoidedRisks: ['merge_conflict', 'semantic_collision'],
            reasonCodes: ['semantic_collision_mitigated'],
          }, {
            strategy: 'parallel',
            result: 'risk',
            predictedCollisionRisk: 0.8,
            unresolvedRisks: ['semantic_collision'],
          }],
          arbiterVerdict: { selected: 'schema-first' },
          userChoice: { selected: 'schema-first' },
          evidenceRefs: ['shadow:job:1'],
        }],
        policyDeltas: [{
          id: 'delta-1',
          promotionState: 'active',
          learnedFromIncidents: ['incident-1'],
        }],
      },
    });

    expect(metrics.schemaVersion).toBe('synthi.codesite.metrics.v1');
    expect(metrics.summary.collisionsPredicted).toBeGreaterThanOrEqual(3);
    expect(metrics.summary.collisionsAvoided).toBeGreaterThanOrEqual(2);
    expect(metrics.summary.nearMissesReplayed).toBe(1);
    expect(metrics.summary.noFlyViolationsBlocked).toBe(1);
    expect(metrics.summary.codeSiteFsBlockedWrites).toBe(1);
    expect(metrics.summary.illegalWritesQuarantined).toBe(1);
    expect(metrics.summary.proofBundlesVerifiedOutsideUi).toBe(1);
    expect(metrics.summary.staleReadsDetected).toBe(1);
    expect(metrics.summary.assumptionInvalidationsBeforeWrite).toBe(1);
    expect(metrics.summary.serializableTransactionAbortRate).toBe(0.5);
    expect(metrics.summary.shadowMergeSimulatorAccuracy).toBe(1);
    expect(metrics.summary.lineProvenanceCoverage).toBe(0.5);
    expect(metrics.summary.securityFindingsBeforeMerge).toBe(1);
    expect(metrics.summary.testsRedAtLanding).toBe(1);
    expect(metrics.summary.blackBoxCompletenessScore).toBe(0.77);
    expect(metrics.summary.flightsReroutedByTower).toBe(0);
    expect(metrics.summary.percentageWritesWithValidClearance).toBe(0.3333);
    expect(metrics.summary.repeatedNearMissesConvertedToAirspaceRules).toBe(1);
    expect(metrics.summary.humanReviewTimeSavedMs).toBe(210_000);
    expect(metrics.sections.trust.find((row) => row.key === 'humanReviewTimeSavedMs')).toMatchObject({
      status: 'measured',
      value: 210_000,
      detail: {
        samples: 1,
        baselineReviewTimeMs: 300_000,
        reviewTimeMs: 90_000,
        reviewOverrunMs: 0,
      },
    });
    expect(metrics.sections.trust.find((row) => row.key === 'humanReviewTimeSavedMs').evidenceRefs)
      .toEqual(expect.arrayContaining(['document-review:review-1', 'document-review:evidence']));
    expect(metrics.evidence.dataSources.documentReviews).toBe(1);
    expect(metrics.evidence.reasonCodeCounts).toMatchObject({
      entered_no_fly_zone: expect.any(Number),
      collision_avoidance_hold: 1,
      document_approved: 1,
    });
  });

  it('keeps human review savings uninstrumented until review baselines exist', () => {
    const metrics = buildCodeSiteMetrics({
      workspaceSlug: 'acme',
      project: {
        id: 'project-review-gap',
        workspaceSlug: 'acme',
        documentReviews: [{
          id: 'review-without-baseline',
          status: 'completed',
          decision: 'approved',
          body: { reviewTimeMs: 45_000 },
          evidenceRefs: ['document-review:no-baseline'],
        }],
      },
    });

    const row = metrics.sections.trust.find((item) => item.key === 'humanReviewTimeSavedMs');
    expect(row).toMatchObject({
      status: 'not_instrumented',
      value: null,
      source: 'instrumentation_gap',
    });
    expect(row.detail).toContain('baselineReviewTimeMs');
    expect(metrics.evidence.dataSources.documentReviews).toBe(1);
  });

  it('does not treat stored proof bundles as externally verified without verifier evidence', () => {
    const metrics = buildCodeSiteMetrics({
      workspaceSlug: 'acme',
      project: {
        id: 'project-2',
        workspaceSlug: 'acme',
        proofBundles: [{ id: 'proof-2', bundleDigest: 'sha256:bundle-only' }],
      },
    });

    const proofMetric = metrics.sections.transaction.find((row) => row.key === 'proofBundlesVerifiedOutsideUi');
    expect(proofMetric).toMatchObject({
      status: 'not_instrumented',
      value: null,
      source: 'instrumentation_gap',
    });
    expect(proofMetric.detail).toContain('no external verifier');
  });

  it('scores pilot-license health records as trust evidence', () => {
    const metrics = buildCodeSiteMetrics({
      workspaceSlug: 'acme',
      controlState: {
        pilotLicenseHealth: [{
          key: 'agent-1',
          displayCallsign: 'ATLAS-1',
          status: 'active',
          reasonCodes: ['pilot_license_health_active'],
          evidenceRefs: ['dojo:evidence:active'],
        }, {
          key: 'agent-2',
          displayCallsign: 'BETA-2',
          status: 'expired',
          reasonCodes: ['pilot_license_source_drift_expired'],
          evidenceRefs: ['dojo:evidence:expired'],
        }],
      },
      project: {
        id: 'project-license',
        workspaceSlug: 'acme',
        mutationLeases: [{
          id: 'lease-1',
          displayCallsign: 'ATLAS-1',
          status: 'active',
        }, {
          id: 'lease-2',
          displayCallsign: 'BETA-2',
          status: 'blocked',
        }],
      },
    });

    const row = metrics.sections.trust.find((item) => item.key === 'pilotLicenseViolationRate');
    expect(row).toMatchObject({
      status: 'measured',
      value: 0.5,
      sampleSize: 1,
    });
    expect(row.evidenceRefs).toEqual(expect.arrayContaining(['dojo:evidence:expired']));
    expect(metrics.evidence.pilotLicenseStatusCounts).toMatchObject({ active: 1, expired: 1 });
    expect(metrics.evidence.reasonCodeCounts).toMatchObject({
      pilot_license_source_drift_expired: 1,
    });
  });

  it('deduplicates pilot-license violations without counting healthy license decisions', () => {
    const metrics = buildCodeSiteMetrics({
      workspaceSlug: 'acme',
      controlState: {
        pilotLicenseHealth: [{
          key: 'agent-active',
          displayCallsign: 'ACTIVE-IFR',
          status: 'active',
          requiredAirspaceClass: 'B',
          reasonCodes: ['pilot_license_health_active', 'pilot_license_source_current'],
          evidenceRefs: ['pilot-health:active'],
        }, {
          key: 'agent-stale',
          displayCallsign: 'STALE-IFR',
          status: 'expired',
          requiredAirspaceClass: 'B',
          reasonCodes: ['pilot_license_source_drift_expired'],
          evidenceRefs: ['pilot-health:stale'],
        }],
      },
      project: {
        id: 'project-duplicate-license-evidence',
        workspaceSlug: 'acme',
        mutationLeases: [{
          id: 'lease-active',
          displayCallsign: 'ACTIVE-IFR',
          status: 'active',
        }, {
          id: 'lease-stale',
          displayCallsign: 'STALE-IFR',
          status: 'blocked',
        }],
        policyDecisions: [{
          id: 'decision-active',
          decision: 'inspect',
          reasonCodes: ['pilot_license_health_active', 'pilot_license_source_current'],
          decisionBody: {
            displayCallsign: 'ACTIVE-IFR',
            requiredAirspaceClass: 'B',
            status: 'active',
          },
          evidenceRefs: ['policy:active'],
        }, {
          id: 'decision-stale',
          decision: 'block',
          reasonCodes: ['pilot_license_source_drift_expired'],
          decisionBody: {
            displayCallsign: 'STALE-IFR',
            requiredAirspaceClass: 'B',
          },
          evidenceRefs: ['policy:stale'],
        }],
      },
    });

    const row = metrics.sections.trust.find((item) => item.key === 'pilotLicenseViolationRate');
    expect(row).toMatchObject({
      status: 'measured',
      value: 0.5,
      sampleSize: 3,
    });
    expect(row.detail).toMatchObject({ numerator: 1, denominator: 2 });
    expect(row.evidenceRefs).toEqual(expect.arrayContaining(['pilot-health:stale', 'policy:stale']));
    expect(row.evidenceRefs).not.toEqual(expect.arrayContaining(['pilot-health:active', 'policy:active']));
  });

  it('counts pilot-attributed denied writes as separate trust attempts', () => {
    const metrics = buildCodeSiteMetrics({
      workspaceSlug: 'acme',
      controlState: {
        pilotLicenseHealth: [{
          key: 'agent-active',
          displayCallsign: 'ACTIVE-IFR',
          status: 'active',
          evidenceRefs: ['pilot-health:active'],
        }, {
          key: 'agent-stale',
          displayCallsign: 'STALE-IFR',
          status: 'expired',
          reasonCodes: ['pilot_license_source_drift_expired'],
          evidenceRefs: ['pilot-health:stale'],
        }],
      },
      project: {
        id: 'project-write-license-evidence',
        workspaceSlug: 'acme',
        mutationLeases: [{
          id: 'lease-active',
          displayCallsign: 'ACTIVE-IFR',
          status: 'active',
        }, {
          id: 'lease-stale',
          displayCallsign: 'STALE-IFR',
          status: 'blocked',
        }],
        policyDecisions: [{
          id: 'decision-stale',
          decision: 'block',
          reasonCodes: ['pilot_license_source_drift_expired'],
          decisionBody: {
            displayCallsign: 'STALE-IFR',
            pilotLicenseHealth: {
              key: 'agent-stale',
              displayCallsign: 'STALE-IFR',
              status: 'expired',
            },
          },
          evidenceRefs: ['policy:stale'],
        }, {
          id: 'decision-write-denied',
          decision: 'block',
          reasonCodes: ['entered_no_fly_zone'],
          decisionBody: {
            path: 'secrets/prod.env',
            source: 'codesitefs',
          },
          displayCallsign: 'STALE-IFR',
          evidenceRefs: ['policy:write-denied'],
        }],
        events: [{
          id: 'event-write-denied',
          eventType: 'write_denied',
          displayCallsign: 'STALE-IFR',
          details: {
            path: 'secrets/prod.env',
            reasonCodes: ['entered_no_fly_zone'],
          },
          evidenceRefs: ['codesitefs:denied'],
        }],
      },
    });

    const row = metrics.sections.trust.find((item) => item.key === 'pilotLicenseViolationRate');
    expect(row).toMatchObject({
      status: 'measured',
      value: 0.6667,
    });
    expect(row.detail).toMatchObject({ numerator: 2, denominator: 3 });
    expect(row.evidenceRefs).toEqual(expect.arrayContaining(['policy:stale', 'codesitefs:denied']));
  });
});
