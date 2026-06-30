import { describe, expect, it } from 'vitest';
import {
  codeSiteEvidenceRefsJson,
  firstCodeSiteRef,
  normalizeCodeSiteContext,
  normalizeCodeSiteEvidenceRefs,
  normalizeCodeSiteRef,
} from '../substrateIdentity';

describe('CodeSite substrate identity normalization', () => {
  it('bounds scalar refs and selects the first usable alias', () => {
    expect(normalizeCodeSiteRef(' project-1 ')).toBe('project-1');
    expect(normalizeCodeSiteRef('x'.repeat(256))).toBeNull();
    expect(normalizeCodeSiteRef({ id: 'project-1' })).toBeNull();
    expect(firstCodeSiteRef('', null, ' txn-1 ')).toBe('txn-1');
  });

  it('dedupes and caps evidence refs before storage', () => {
    const refs = Array.from({ length: 40 }, (_, index) => `evidence:${index}`);
    const normalized = normalizeCodeSiteEvidenceRefs([
      ' evidence:0 ',
      'evidence:0',
      ...refs,
      'x'.repeat(256),
      { ref: 'bad' },
    ]);
    expect(normalized).toHaveLength(32);
    expect(normalized[0]).toBe('evidence:0');
    expect(new Set(normalized).size).toBe(normalized.length);
    expect(codeSiteEvidenceRefsJson([' evidence:1 ', 'evidence:1'])).toBe(JSON.stringify(['evidence:1']));
  });

  it('normalizes context aliases into canonical fields', () => {
    expect(normalizeCodeSiteContext({
      projectId: 'project-1',
      transactionId: 'txn-1',
      leaseId: 'lease-1',
      agentSessionId: 'agent-1',
      evidenceRefs: ['evidence:1'],
    })).toEqual({
      projectId: 'project-1',
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
      agentSessionId: 'agent-1',
      evidenceRefs: ['evidence:1'],
    });
  });
});
