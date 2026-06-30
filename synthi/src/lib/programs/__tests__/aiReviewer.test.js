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

describe('aiDecision (3-way)', () => {
  const opts = { lowThreshold: 0.3, highThreshold: 0.7 };
  it('auto-approves low risk + safe scopes + no flags', () => {
    expect(aiDecision({ riskScore: 0.1, flags: [] }, cfg({ permissions: ['program.launch'] }), opts)).toBe('auto_approve');
  });
  it('auto-rejects when risk >= high threshold', () => {
    expect(aiDecision({ riskScore: 0.9, flags: [] }, cfg(), opts)).toBe('auto_reject');
  });
  it('auto-rejects when any flag is present (even at low risk)', () => {
    expect(aiDecision({ riskScore: 0.0, flags: ['obfuscation'] }, cfg(), opts)).toBe('auto_reject');
  });
  it('routes the middle band (no flags) to manual', () => {
    expect(aiDecision({ riskScore: 0.5, flags: [] }, cfg(), opts)).toBe('manual');
  });
  it('routes a sensitive scope (low risk, no flags) to manual', () => {
    expect(SENSITIVE_SCOPES).toContain('network.outbound');
    expect(aiDecision({ riskScore: 0.1, flags: [] }, cfg({ permissions: ['program.launch', 'network.outbound'] }), opts)).toBe('manual');
  });
});
