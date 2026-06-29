import { describe, expect, it } from 'vitest';
import {
  classifyPath,
  compileZonePolicy,
  evaluateLeaseRequest,
  evaluatePathMutation,
  predictCollisions,
} from '../policy.js';

describe('CodeSite airspace policy', () => {
  it('classifies critical and shared repo airspace from compiled defaults', () => {
    const policy = compileZonePolicy();

    expect(classifyPath('api/auth/signup.ts', policy)).toMatchObject({
      class: 'A',
      zoneKey: 'class_a',
    });
    expect(classifyPath('packages/schemas/auth/signup.ts', policy)).toMatchObject({
      class: 'B',
      zoneKey: 'class_b',
    });
    expect(classifyPath('docs/README.md', policy)).toMatchObject({
      class: 'D',
      zoneKey: 'class_d',
    });
  });

  it('blocks a lease request that enters a no-fly route', () => {
    const policy = compileZonePolicy({ noFlyZones: ['api/auth/**'] });
    const decision = evaluateLeaseRequest({
      zonePolicy: policy,
      executionPlan: {
        route: ['api/auth/**'],
        blockedZones: [],
      },
      requestedLease: {
        allowedPaths: ['api/auth/**'],
      },
    });

    expect(decision).toMatchObject({
      decision: 'block',
      status: 'blocked',
      reasonCodes: ['entered_no_fly_zone'],
    });
  });

  it('requires inspection for restricted but allowed airspace', () => {
    const policy = compileZonePolicy();
    const decision = evaluateLeaseRequest({
      zonePolicy: policy,
      executionPlan: {
        route: ['packages/schemas/auth/**'],
        blockedZones: [],
      },
      requestedLease: {
        allowedPaths: ['packages/schemas/auth/**'],
      },
    });

    expect(decision.decision).toBe('inspect');
    expect(decision.status).toBe('active');
    expect(decision.reasonCodes).toContain('restricted_airspace_requires_inspection');
  });

  it('denies writes outside the active mutation lease route', () => {
    const policy = compileZonePolicy();
    const lease = {
      status: 'active',
      leaseJson: JSON.stringify({
        allowedPaths: ['synthi/src/components/**'],
        blockedPaths: ['api/**'],
        allowedTools: ['file_write'],
      }),
    };

    expect(evaluatePathMutation({ lease, path: 'synthi/src/components/Button.jsx', tool: 'file_write', zonePolicy: policy })).toMatchObject({
      ok: true,
      reasonCodes: ['inside_clearance_route'],
    });
    expect(evaluatePathMutation({ lease, path: 'api/auth/signup.ts', tool: 'file_write', zonePolicy: policy })).toMatchObject({
      ok: false,
      reasonCodes: ['entered_no_fly_zone'],
    });
    expect(evaluatePathMutation({ lease, path: 'synthi/src/app/page.jsx', tool: 'file_write', zonePolicy: policy })).toMatchObject({
      ok: false,
      reasonCodes: ['outside_clearance_route'],
    });
  });

  it('predicts schema-first resolution for shared contract route overlap', () => {
    const policy = compileZonePolicy();
    const forecast = predictCollisions({
      zonePolicy: policy,
      executionPlans: [
        { displayCallsign: 'CLAUDE-17', route: ['packages/schemas/auth/**'] },
        { displayCallsign: 'CODEX-04', route: ['packages/schemas/auth/signup.ts'] },
      ],
      leases: [],
    });

    expect(forecast.riskLevel).toBe('high');
    expect(forecast.risks[0]).toMatchObject({
      risk: 'contract_collision',
      severity: 'high',
      recommendedResolution: {
        action: 'schema_first',
      },
    });
  });
});
