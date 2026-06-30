import { describe, expect, it, vi } from 'vitest';
import { assessSubmission, aiDecision, SENSITIVE_SCOPES } from '../aiReviewer';

const cfg = (over = {}) => ({ runtimeType: 'container', permissions: ['program.launch'], launch: 'docker run x', ...over });

describe('assessSubmission', () => {
  it('returns the parsed risk assessment from the client', async () => {
    const client = vi.fn().mockResolvedValue({ risk_score: 0.1, flags: [], rationale: 'fine' });
    const out = await assessSubmission({ config: cfg(), scanSummary: { decisiveCves: [] }, description: 'd' }, { client });
    expect(out).toEqual({ riskScore: 0.1, flags: [], rationale: 'fine' });
    expect(client).toHaveBeenCalledTimes(1);
  });

  it('fails closed (max risk) when the client throws', async () => {
    const client = vi.fn().mockRejectedValue(new Error('engine down'));
    const out = await assessSubmission({ config: cfg() }, { client });
    expect(out.riskScore).toBe(1);
    expect(out.flags).toContain('ai_unavailable');
  });

  it('fails closed when the client returns a malformed shape', async () => {
    const client = vi.fn().mockResolvedValue({ nope: true });
    const out = await assessSubmission({ config: cfg() }, { client });
    expect(out.riskScore).toBe(1);
    expect(out.flags).toContain('ai_unavailable');
  });
});

describe('aiDecision (conservative)', () => {
  const threshold = 0.3;
  it('auto-approves low risk + safe scopes + no flags', () => {
    expect(aiDecision({ riskScore: 0.1, flags: [] }, cfg({ permissions: ['program.launch'] }), { threshold })).toBe('auto_approve');
  });
  it('routes to manual when a sensitive scope is present', () => {
    expect(SENSITIVE_SCOPES).toContain('network.outbound');
    expect(aiDecision({ riskScore: 0.1, flags: [] }, cfg({ permissions: ['program.launch', 'network.outbound'] }), { threshold })).toBe('manual');
  });
  it('routes to manual when risk exceeds threshold', () => {
    expect(aiDecision({ riskScore: 0.9, flags: [] }, cfg(), { threshold })).toBe('manual');
  });
  it('routes to manual when any flag is present', () => {
    expect(aiDecision({ riskScore: 0.0, flags: ['obfuscation'] }, cfg(), { threshold })).toBe('manual');
  });
});
