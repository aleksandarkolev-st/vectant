import { describe, expect, it } from 'vitest';
import {
  applyPilotLicenseHealthGate,
  buildPilotLicenseHealthRecords,
  pilotLicenseRequirement,
} from '../pilotLicense.js';

function projectFixture(overrides = {}) {
  return {
    id: 'project-1',
    workspaceSlug: 'acme',
    zonePolicy: {
      zones: [
        { zoneKey: 'schema', class: 'B', paths: ['packages/schemas/**'] },
        { zoneKey: 'docs', class: 'D', paths: ['docs/**'] },
      ],
      compiler: {
        sourceDigest: 'sha256:source-v2',
        policyDigest: 'sha256:policy-v2',
      },
    },
    agentSessions: [{
      id: 'agent-1',
      projectId: 'project-1',
      displayCallsign: 'ATLAS-1',
      ownerUserId: 'user-1',
      dojoPilotLicenseRef: 'schema.level_2@2026-06-25',
      dojoProofRef: 'pcap-schema',
      dojoEvidenceRefs: ['dojo:evidence:checkride'],
      dojoDecisionDigest: 'sha256:decision',
      pilotLicenseSnapshot: {
        level: 2,
        repoScope: 'acme',
        authorizedAirspace: ['packages/schemas/**'],
        requiredRadar: ['api_contract', 'security'],
        earnedBy: ['dojo:evidence:checkride'],
        expiresOn: ['source_drift'],
        sourceDigest: 'sha256:source-v2',
      },
    }],
    executionPlans: [{
      id: 'plan-1',
      agentSessionId: 'agent-1',
      displayCallsign: 'ATLAS-1',
      route: ['packages/schemas/**'],
    }],
    mutationLeases: [{
      id: 'lease-1',
      executionPlanId: 'plan-1',
      agentSessionId: 'agent-1',
      displayCallsign: 'ATLAS-1',
      status: 'active',
      lease: { allowedPaths: ['packages/schemas/**'], requiredRadar: ['api_contract'] },
      dojoLicenseRef: 'schema.level_2@2026-06-25',
      dojoProofRef: 'pcap-schema',
      dojoEvidenceRefs: ['dojo:evidence:lease'],
    }],
    policyDecisions: [],
    events: [],
    inspectionRuns: [{
      id: 'inspect-1',
      executionPlanId: 'plan-1',
      displayCallsign: 'ATLAS-1',
      status: 'passed',
      evidenceRefs: ['test:passed'],
    }],
    incidents: [],
    ...overrides,
  };
}

describe('CodeSite pilot license health', () => {
  it('derives active license health from Dojo refs, license scope, source digest, and landing evidence', () => {
    const [record] = buildPilotLicenseHealthRecords(projectFixture(), {
      now: new Date('2026-07-01T00:00:00.000Z'),
    });

    expect(record).toMatchObject({
      schemaVersion: 'synthi.codesite.pilotLicenseHealth.v1',
      displayCallsign: 'ATLAS-1',
      status: 'active',
      level: 'IFR',
      repoScope: 'acme',
      sourceDrift: {
        monitored: true,
        sourceDigest: 'sha256:source-v2',
        currentSourceDigest: 'sha256:source-v2',
        expired: false,
      },
      landingStats: { total: 1, passed: 1, failed: 0 },
    });
    expect(record.authorizedAirspace).toEqual(expect.arrayContaining(['packages/schemas/**']));
    expect(record.requiredRadar).toEqual(expect.arrayContaining(['api_contract', 'security']));
    expect(record.evidenceRefs).toEqual(expect.arrayContaining(['dojo:evidence:checkride', 'dojo:evidence:lease', 'test:passed']));
  });

  it('expires source-drift licenses when the repo policy source digest changes', () => {
    const [record] = buildPilotLicenseHealthRecords(projectFixture({
      zonePolicy: {
        zones: [{ zoneKey: 'schema', class: 'B', paths: ['packages/schemas/**'] }],
        compiler: { sourceDigest: 'sha256:source-v3', policyDigest: 'sha256:policy-v3' },
      },
    }), {
      now: new Date('2026-07-01T00:00:00.000Z'),
    });

    expect(record.status).toBe('expired');
    expect(record.reasonCodes).toEqual(expect.arrayContaining(['pilot_license_source_drift_expired']));
    expect(record.requiredAction).toBe('renew_pilot_license_source:agent-1');
  });

  it('suspends licenses after repeated failed landings or critical violations', () => {
    const [record] = buildPilotLicenseHealthRecords(projectFixture({
      inspectionRuns: [{
        id: 'inspect-1',
        executionPlanId: 'plan-1',
        displayCallsign: 'ATLAS-1',
        status: 'failed',
      }, {
        id: 'inspect-2',
        executionPlanId: 'plan-1',
        displayCallsign: 'ATLAS-1',
        status: 'passed',
        inspectionSignals: [{ key: 'security', status: 'failed' }],
      }],
      events: [{
        id: 'evt-1',
        eventType: 'write_denied',
        displayCallsign: 'ATLAS-1',
        details: { reasonCodes: ['entered_no_fly_zone'] },
        evidenceRefs: ['codesitefs:block'],
      }],
    }), {
      now: new Date('2026-07-01T00:00:00.000Z'),
    });

    expect(record.status).toBe('suspended');
    expect(record.violationStats.critical).toBeGreaterThan(0);
    expect(record.reasonCodes).toEqual(expect.arrayContaining(['pilot_license_critical_violation_window']));
  });

  it('attributes pilot-license policy violations to the matching session only', () => {
    const records = buildPilotLicenseHealthRecords(projectFixture({
      agentSessions: [
        projectFixture().agentSessions[0],
        {
          ...projectFixture().agentSessions[0],
          id: 'agent-2',
          displayCallsign: 'BETA-2',
          pilotLicenseSnapshot: {
            ...projectFixture().agentSessions[0].pilotLicenseSnapshot,
            sourceDigest: 'sha256:source-v1',
          },
        },
      ],
      executionPlans: [
        projectFixture().executionPlans[0],
        {
          id: 'plan-2',
          agentSessionId: 'agent-2',
          displayCallsign: 'BETA-2',
          route: ['packages/schemas/**'],
        },
      ],
      mutationLeases: [],
      inspectionRuns: [],
      policyDecisions: [{
        id: 'decision-active',
        decision: 'inspect',
        reasonCodes: ['pilot_license_health_active', 'pilot_license_source_current'],
        decisionBody: {
          status: 'active',
          pilotLicenseHealth: {
            key: 'agent-1',
            agentSessionId: 'agent-1',
            displayCallsign: 'ATLAS-1',
            status: 'active',
          },
        },
      }, {
        id: 'decision-stale',
        decision: 'block',
        reasonCodes: ['pilot_license_source_drift_expired', 'pilot_license_expired'],
        decisionBody: {
          status: 'blocked',
          pilotLicenseHealth: {
            key: 'agent-2',
            agentSessionId: 'agent-2',
            displayCallsign: 'BETA-2',
            status: 'expired',
          },
        },
      }],
    }), {
      now: new Date('2026-07-01T00:00:00.000Z'),
    });

    const active = records.find((record) => record.displayCallsign === 'ATLAS-1');
    const stale = records.find((record) => record.displayCallsign === 'BETA-2');
    expect(active.violationStats.total).toBe(0);
    expect(stale.violationStats.total).toBe(1);
    expect(stale.evidenceRefs).toEqual(expect.arrayContaining(['codesite:policy-decision:decision-stale']));
    expect(stale.evidenceRefs).not.toEqual(expect.arrayContaining(['codesite:policy-decision:decision-active']));
  });

  it('blocks restricted clearances when health is below the required airspace level', () => {
    const policy = {
      decision: 'inspect',
      status: 'active',
      reasonCodes: ['restricted_airspace_requires_inspection'],
      inspectedZones: [{ zoneKey: 'schema', class: 'B' }],
    };
    const health = {
      status: 'active',
      level: 'VFR',
      levelRank: 2,
      displayCallsign: 'ATLAS-1',
      reasonCodes: ['pilot_license_health_active'],
    };

    expect(pilotLicenseRequirement(policy)).toMatchObject({
      required: true,
      minimumLevel: 'IFR',
    });
    expect(applyPilotLicenseHealthGate(policy, health)).toMatchObject({
      decision: 'block',
      status: 'blocked',
      reasonCodes: expect.arrayContaining(['pilot_license_level_insufficient']),
    });
  });

  it('blocks restricted clearances outside the pilot authorized airspace and repo scope', () => {
    const policy = {
      decision: 'inspect',
      status: 'active',
      reasonCodes: ['restricted_airspace_requires_inspection'],
      inspectedZones: [{ zoneKey: 'schema', class: 'B', paths: ['packages/schemas/**'] }],
    };
    const health = {
      workspaceSlug: 'acme',
      repoScope: 'other-workspace',
      status: 'active',
      level: 'IFR',
      levelRank: 3,
      displayCallsign: 'ATLAS-1',
      authorizedAirspace: ['docs/**'],
      restrictedAirspace: ['secrets/**'],
      reasonCodes: ['pilot_license_health_active'],
    };

    expect(applyPilotLicenseHealthGate(policy, health)).toMatchObject({
      decision: 'block',
      status: 'blocked',
      reasonCodes: expect.arrayContaining([
        'pilot_license_repo_scope_mismatch',
        'pilot_license_airspace_not_authorized',
      ]),
    });
  });
});
