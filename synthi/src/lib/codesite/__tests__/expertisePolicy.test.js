import { describe, expect, it } from 'vitest';
import {
  EXPERTISE_POLICY,
  EXPERTISE_POLICY_VERSION,
  resolveExpertisePolicy,
} from '../expertisePolicy';
import { normalizeExpertiseQuery } from '../agentExpertise';

describe('expertise policy configuration', () => {
  it('publishes a versioned default policy for scoring and query limits', () => {
    expect(EXPERTISE_POLICY.version).toBe(EXPERTISE_POLICY_VERSION);
    expect(EXPERTISE_POLICY.scoring.signalWeights.transaction_write).toBe(3);
    expect(EXPERTISE_POLICY.scoring.recencyHalfLifeMs).toBe(14 * 24 * 60 * 60 * 1000);
    expect(EXPERTISE_POLICY.limits).toMatchObject({ defaultLimit: 5, maxLimit: 10, maxReferencesPerType: 32 });
  });

  it('merges deployment-owned overrides without allowing unsafe bounds', () => {
    const policy = resolveExpertisePolicy({
      version: 'deployment.expertise-policy.v2',
      scoring: { recencyHalfLifeMs: 86_400_000, signalWeights: { transaction_write: 4 } },
      limits: { defaultLimit: 4, maxLimit: 6, maxReferencesPerType: 48 },
    });

    expect(policy.version).toBe('deployment.expertise-policy.v2');
    expect(policy.scoring.recencyHalfLifeMs).toBe(86_400_000);
    expect(policy.scoring.signalWeights.transaction_write).toBe(4);
    expect(policy.scoring.signalWeights.transaction_read).toBe(2);
    expect(policy.limits).toMatchObject({ defaultLimit: 4, maxLimit: 6, maxReferencesPerType: 48 });
    expect(normalizeExpertiseQuery({ paths: ['src/a.ts'], limit: 99 }, policy).limit).toBe(6);
  });
});
