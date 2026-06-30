import { describe, expect, it } from 'vitest';
import {
  CODE_SITE_EVENT_TYPES,
  classifyPath,
  compileZonePolicy,
  evaluateLeaseRequest,
  evaluatePathMutation,
  predictCollisions,
  validateCodeSiteEventType,
} from '../policy.js';

describe('CodeSite airspace policy', () => {
  it('accepts only documented black-box event types', () => {
    expect(validateCodeSiteEventType('write_denied')).toBe('write_denied');
    expect(validateCodeSiteEventType(' black_box_closed ')).toBe('black_box_closed');
    expect(CODE_SITE_EVENT_TYPES).toContain('arbiter_verdict');
    expect(() => validateCodeSiteEventType('agent_chat_message')).toThrow(/codesite_event_type_invalid:agent_chat_message/);
  });

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

  it('compiles repo-derived airspace from ownership, contracts, migrations, exports, deploy config, secrets, and incidents', () => {
    const policy = compileZonePolicy({
      repoSignals: {
        codeowners: [{ pattern: 'api/auth/**', owners: ['@security'] }],
        openapi: ['openapi/auth.yaml'],
        prisma: {
          schemas: ['synthi/prisma/schema.prisma'],
          migrations: ['synthi/prisma/migrations'],
        },
        packageExports: [{
          packageName: '@acme/contracts',
          root: 'packages/contracts',
          exports: ['packages/contracts/src/index.ts'],
        }],
        deployment: ['infra/prod/kustomization.yaml'],
        secretPatterns: ['private-secrets/**'],
        pastIncidents: [{
          severity: 'critical',
          category: 'contract_drift',
          affectedPaths: ['packages/schemas/auth/**'],
          refs: ['incident:signup'],
        }],
      },
    });

    expect(policy.policySources).toMatchObject({
      codeowners: 1,
      openapi: 1,
      prismaSchemas: 1,
      prismaMigrations: 1,
      packageExports: 1,
      deployment: 1,
      pastIncidents: 1,
    });
    expect(policy.noFlyZones).toEqual(expect.arrayContaining(['private-secrets/**', 'secrets/**']));
    expect(policy.zones).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'repo_codeowners', class: 'A', paths: ['api/auth/**'] }),
      expect.objectContaining({ source: 'repo_openapi', class: 'B', paths: ['openapi/auth.yaml'] }),
      expect.objectContaining({ source: 'repo_prisma_migration', class: 'A', paths: ['synthi/prisma/migrations/**'] }),
      expect.objectContaining({ source: 'repo_package_exports', class: 'B', paths: expect.arrayContaining(['packages/contracts/**']) }),
      expect.objectContaining({ source: 'repo_deployment_config', class: 'A', paths: ['infra/prod/kustomization.yaml'] }),
      expect.objectContaining({ source: 'repo_past_incident', class: 'A', paths: ['packages/schemas/auth/**'] }),
    ]));
  });

  it('predicts semantic contract collisions from import and test graph signals without path overlap', () => {
    const policy = compileZonePolicy({
      repoSignals: {
        files: [
          'synthi/src/components/auth/SignupForm.tsx',
          'synthi/src/components/auth/SignupForm.test.tsx',
          'packages/schemas/auth/signup.ts',
        ],
        importGraph: [{
          from: 'synthi/src/components/auth/SignupForm.tsx',
          imports: ['packages/schemas/auth/signup.ts'],
        }],
        testGraph: [{
          testPath: 'synthi/src/components/auth/SignupForm.test.tsx',
          covers: ['synthi/src/components/auth/SignupForm.tsx', 'packages/schemas/auth/signup.ts'],
        }],
      },
    });

    const forecast = predictCollisions({
      zonePolicy: policy,
      leases: [],
      executionPlans: [
        { displayCallsign: 'CLAUDE-17', route: ['synthi/src/components/auth/**'] },
        { displayCallsign: 'CODEX-04', route: ['packages/schemas/auth/**'] },
      ],
    });

    expect(forecast.riskLevel).toBe('high');
    expect(forecast.risks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        risk: 'semantic_collision',
        severity: 'high',
        conflictZone: 'packages/schemas/auth/signup.ts',
        recommendedResolution: expect.objectContaining({ action: 'schema_first' }),
      }),
    ]));
  });

  it('predicts a single runway lock for independent migration routes', () => {
    const policy = compileZonePolicy({
      repoSignals: {
        prisma: {
          migrations: ['synthi/prisma/migrations'],
        },
      },
    });

    const forecast = predictCollisions({
      zonePolicy: policy,
      leases: [],
      executionPlans: [
        { displayCallsign: 'DB-01', route: ['synthi/prisma/migrations/20260630_add_user/**'] },
        { displayCallsign: 'DB-02', route: ['synthi/prisma/migrations/20260630_add_team/**'] },
      ],
    });

    expect(forecast.risks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        risk: 'migration_collision',
        recommendedResolution: expect.objectContaining({ action: 'single_migration_runway_lock' }),
      }),
    ]));
  });

  it('models migration runway occupancy and wake turbulence for dependent test flights', () => {
    const policy = compileZonePolicy({
      repoSignals: {
        prisma: {
          migrations: ['synthi/prisma/migrations'],
        },
        testGraph: [{
          testPath: 'tests/db/migration-order.test.ts',
          covers: ['synthi/prisma/migrations/20260630_add_user/steps.sql'],
        }],
        generatedClients: ['synthi/src/generated/prisma/client.ts'],
      },
    });

    const forecast = predictCollisions({
      zonePolicy: policy,
      leases: [{
        id: 'lease-db-1',
        status: 'active',
        displayCallsign: 'DB-01',
        leaseJson: JSON.stringify({
          allowedPaths: ['synthi/prisma/migrations/20260630_add_user/**'],
        }),
      }],
      executionPlans: [
        { displayCallsign: 'TEST-02', route: ['tests/db/**'] },
        { displayCallsign: 'CLIENT-03', route: ['synthi/src/generated/prisma/**'] },
      ],
    });

    expect(forecast.runwayOccupancy).toEqual([
      expect.objectContaining({
        runway: 'synthi/prisma/migrations/20260630_add_user/**',
        occupiedBy: 'DB-01',
        runwayClass: 'A',
        pendingInspections: expect.arrayContaining(['migration_runway_lock', 'landing_inspection']),
      }),
    ]);
    expect(forecast.wakeTurbulence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        risk: 'wake_turbulence',
        severity: 'high',
        aircraft: expect.arrayContaining(['DB-01', 'TEST-02', 'CLIENT-03']),
        wake: expect.objectContaining({
          kind: 'migration',
          requiredWaits: expect.arrayContaining(['backend_test_wait', 'migration_rollback_radar', 'schema_client_refresh']),
        }),
        recommendedResolution: expect.objectContaining({ action: 'hold_for_wake_turbulence' }),
      }),
    ]));
  });

  it('models package export wake turbulence for downstream importers', () => {
    const policy = compileZonePolicy({
      repoSignals: {
        files: [
          'packages/contracts/src/index.ts',
          'synthi/src/app/checkout/page.tsx',
        ],
        packageExports: [{
          packageName: '@acme/contracts',
          root: 'packages/contracts',
          exports: ['packages/contracts/src/index.ts'],
        }],
        importGraph: [{
          from: 'synthi/src/app/checkout/page.tsx',
          imports: ['packages/contracts/src/index.ts'],
        }],
      },
    });

    const forecast = predictCollisions({
      zonePolicy: policy,
      leases: [{
        id: 'lease-contracts-1',
        status: 'active',
        displayCallsign: 'PKG-01',
        leaseJson: JSON.stringify({
          allowedPaths: ['packages/contracts/src/index.ts'],
        }),
      }],
      executionPlans: [
        { displayCallsign: 'WEB-02', route: ['synthi/src/app/checkout/**'] },
      ],
    });

    expect(forecast.wakeTurbulence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        risk: 'wake_turbulence',
        severity: 'medium',
        aircraft: expect.arrayContaining(['PKG-01', 'WEB-02']),
        wake: expect.objectContaining({
          kind: 'package_export',
          affectedFlights: ['WEB-02'],
          requiredWaits: expect.arrayContaining(['downstream_package_radar', 'importer_refresh']),
          downstreamSignals: expect.objectContaining({ packageExports: ['@acme/contracts'] }),
        }),
      }),
    ]));
  });
});
