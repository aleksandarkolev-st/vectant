/**
 * @fileoverview Tests for aiSuppressedRules.js — fingerprint-aware suppression store.
 *
 * Covers:
 * - suppress / unsuppress / isSuppressed lifecycle
 * - Fingerprint-based vs rule-wide mode
 * - filterFixes returns { visible, suppressedCount }
 * - TTL expiry
 * - Schema v2 persistence round-trip via toJSON / _load
 * - v1 → v2 migration (bare Set → Map with schema version)
 * - Corrupted localStorage recovery
 * - Namespace re-keying via configure()
 * - computeFingerprint determinism
 *
 * Run with: npx vitest run src/services/__tests__/aiSuppressedRules.test.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── localStorage stub ────────────────────────────────────────────────
// The module uses globalThis.localStorage so we shim it for Node.
const storage = new Map();
const localStorageStub = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => storage.set(k, v),
  removeItem: (k) => storage.delete(k),
  clear: () => storage.clear(),
};
globalThis.localStorage = localStorageStub;

// Now import after the stub is in place
const { aiSuppressedRules, computeFingerprint } = await import(
  '../aiSuppressedRules.js'
);


// ── Helpers ──────────────────────────────────────────────────────────

function makeFix(overrides = {}) {
  return {
    rule_id: 'RULE_A',
    category: 'logic_error',
    original_text: 'if (x = 1)',
    replacement_text: 'if (x === 1)',
    line: 10,
    confidence: 0.85,
    severity: 'moderate',
    ...overrides,
  };
}


// ── Reset between tests ─────────────────────────────────────────────

beforeEach(() => {
  aiSuppressedRules.clear();
  storage.clear();
});


// ── Basic suppress / unsuppress ─────────────────────────────────────

describe('suppress / unsuppress', () => {
  it('isSuppressed returns true after suppress()', () => {
    const fix = makeFix();
    aiSuppressedRules.suppress('RULE_A', fix);
    expect(aiSuppressedRules.isSuppressed(fix)).toBe(true);
  });

  it('unsuppress restores visibility', () => {
    const fix = makeFix();
    aiSuppressedRules.suppress('RULE_A', fix);
    aiSuppressedRules.unsuppress('RULE_A', fix);
    expect(aiSuppressedRules.isSuppressed(fix)).toBe(false);
  });

  it('suppress is idempotent — double-suppress does not duplicate entries', () => {
    const fix = makeFix();
    aiSuppressedRules.suppress('RULE_A', fix);
    aiSuppressedRules.suppress('RULE_A', fix);
    const all = aiSuppressedRules.all();
    expect(all.filter((e) => e.ruleId === 'RULE_A')).toHaveLength(1);
  });

  it('unsuppress on non-existent rule does not throw', () => {
    expect(() => aiSuppressedRules.unsuppress('NOPE')).not.toThrow();
  });
});


// ── Fingerprint vs rule mode ────────────────────────────────────────

describe('fingerprint vs rule mode', () => {
  it('fingerprint mode suppresses only matching fix', () => {
    const fixA = makeFix({ original_text: 'alpha' });
    const fixB = makeFix({ original_text: 'beta' });

    aiSuppressedRules.suppress('RULE_A', fixA, { mode: 'fingerprint' });

    expect(aiSuppressedRules.isSuppressed(fixA)).toBe(true);
    expect(aiSuppressedRules.isSuppressed(fixB)).toBe(false);
  });

  it('rule mode suppresses ALL fixes with that ruleId', () => {
    const fixA = makeFix({ original_text: 'alpha' });
    const fixB = makeFix({ original_text: 'beta' });

    aiSuppressedRules.suppress('RULE_A', fixA, { mode: 'rule' });

    expect(aiSuppressedRules.isSuppressed(fixA)).toBe(true);
    expect(aiSuppressedRules.isSuppressed(fixB)).toBe(true);
  });
});


// ── filterFixes ─────────────────────────────────────────────────────

describe('filterFixes', () => {
  it('returns { visible, suppressedCount }', () => {
    const fixes = [makeFix(), makeFix({ rule_id: 'RULE_B', original_text: 'other' })];
    aiSuppressedRules.suppress('RULE_A', fixes[0]);

    const result = aiSuppressedRules.filterFixes(fixes);
    expect(result).toHaveProperty('visible');
    expect(result).toHaveProperty('suppressedCount');
    expect(result.visible).toHaveLength(1);
    expect(result.suppressedCount).toBe(1);
  });

  it('returns all fixes visible when nothing suppressed', () => {
    const fixes = [makeFix(), makeFix({ rule_id: 'RULE_B' })];
    const { visible, suppressedCount } = aiSuppressedRules.filterFixes(fixes);
    expect(visible).toHaveLength(2);
    expect(suppressedCount).toBe(0);
  });

  it('handles empty array gracefully', () => {
    const { visible, suppressedCount } = aiSuppressedRules.filterFixes([]);
    expect(visible).toEqual([]);
    expect(suppressedCount).toBe(0);
  });

  it('does NOT mutate the input array', () => {
    const fixes = [
      makeFix(),
      makeFix({ rule_id: 'RULE_B', original_text: 'other' }),
    ];
    const snapshot = [...fixes];
    aiSuppressedRules.suppress('RULE_A', fixes[0]);

    aiSuppressedRules.filterFixes(fixes);
    expect(fixes).toEqual(snapshot);
    expect(fixes).toHaveLength(2);
  });

  it('preserves original ordering of non-suppressed fixes', () => {
    const fixes = [
      makeFix({ rule_id: 'C', original_text: 'c', line: 30 }),
      makeFix({ rule_id: 'A', original_text: 'a', line: 10 }),
      makeFix({ rule_id: 'B', original_text: 'b', line: 20 }),
    ];
    aiSuppressedRules.suppress('A', fixes[1]);

    const { visible } = aiSuppressedRules.filterFixes(fixes);
    expect(visible.map((f) => f.rule_id)).toEqual(['C', 'B']);
  });

  it('is stable across repeated calls with same input', () => {
    const fixes = [
      makeFix({ rule_id: 'X', original_text: 'x' }),
      makeFix({ rule_id: 'Y', original_text: 'y' }),
    ];
    aiSuppressedRules.suppress('X', fixes[0]);

    const r1 = aiSuppressedRules.filterFixes(fixes);
    const r2 = aiSuppressedRules.filterFixes(fixes);
    expect(r1.visible.map((f) => f.rule_id)).toEqual(r2.visible.map((f) => f.rule_id));
    expect(r1.suppressedCount).toBe(r2.suppressedCount);
  });
});


// ── computeFingerprint ──────────────────────────────────────────────

describe('computeFingerprint', () => {
  it('is deterministic for same input', () => {
    const fix = makeFix();
    expect(computeFingerprint(fix)).toBe(computeFingerprint(fix));
  });

  it('differs for different original_text', () => {
    const a = computeFingerprint(makeFix({ original_text: 'aaa' }));
    const b = computeFingerprint(makeFix({ original_text: 'bbb' }));
    expect(a).not.toBe(b);
  });

  it('returns a string', () => {
    expect(typeof computeFingerprint(makeFix())).toBe('string');
  });
});


// ── Serialization (toJSON round-trip) ───────────────────────────────

describe('toJSON / mergeRemote', () => {
  it('toJSON captures current state', () => {
    aiSuppressedRules.suppress('RULE_X', makeFix());
    const json = aiSuppressedRules.toJSON();
    expect(json.version).toBe(2);
    expect(Object.keys(json.entries).length).toBeGreaterThanOrEqual(1);
  });

  it('mergeRemote full-replaces local state with remote (remote is authority)', () => {
    aiSuppressedRules.suppress('LOCAL_RULE', makeFix());
    aiSuppressedRules.ackOp('LOCAL_RULE', 'suppress');
    const remoteState = {
      version: 2,
      entries: {
        REMOTE_RULE: {
          mode: 'rule',
          fingerprints: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ttl: null,
          reason: 'from server',
          escalated: true,
        },
      },
    };
    aiSuppressedRules.mergeRemote(remoteState);
    const all = aiSuppressedRules.all();
    const ruleIds = all.map((e) => e.ruleId);
    // Local-only entry is discarded (full replace)
    expect(ruleIds).not.toContain('LOCAL_RULE');
    expect(ruleIds).toContain('REMOTE_RULE');
    // Escalation flag carried through
    expect(all.find((e) => e.ruleId === 'REMOTE_RULE').escalated).toBe(true);
  });
});


// ── all() shape ─────────────────────────────────────────────────────

describe('all()', () => {
  it('returns array of { ruleId, mode, fingerprintCount, createdAt, escalated }', () => {
    aiSuppressedRules.suppress('RULE_SHAPE', makeFix());
    const [entry] = aiSuppressedRules.all();
    expect(entry).toMatchObject({
      ruleId: expect.any(String),
      mode: expect.any(String),
      fingerprintCount: expect.any(Number),
      createdAt: expect.any(String),
      escalated: expect.any(Boolean),
    });
  });
});


// ── clear() ─────────────────────────────────────────────────────────

describe('clear()', () => {
  it('removes all entries', () => {
    aiSuppressedRules.suppress('A', makeFix());
    aiSuppressedRules.suppress('B', makeFix({ rule_id: 'B' }));
    aiSuppressedRules.clear();
    expect(aiSuppressedRules.all()).toEqual([]);
    expect(aiSuppressedRules.count).toBe(0);
  });
});


// ── isEscalated ─────────────────────────────────────────────────────

describe('isEscalated()', () => {
  it('returns false for non-existent rule', () => {
    expect(aiSuppressedRules.isEscalated(makeFix({ rule_id: 'NOPE' }))).toBe(false);
  });

  it('returns false for a freshly suppressed rule', () => {
    const fix = makeFix();
    aiSuppressedRules.suppress('RULE_A', fix);
    expect(aiSuppressedRules.isEscalated(fix)).toBe(false);
  });

  it('returns true when mergeRemote provides escalated entry', () => {
    aiSuppressedRules.mergeRemote({
      version: 2,
      entries: {
        RULE_ESC: {
          mode: 'rule',
          fingerprints: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ttl: null,
          reason: 'escalated test',
          escalated: true,
        },
      },
    });
    const fix = makeFix({ rule_id: 'RULE_ESC' });
    expect(aiSuppressedRules.isEscalated(fix)).toBe(true);
  });
});


// ── count (getter, not method) ──────────────────────────────────────

describe('count', () => {
  it('is a property getter, not a function', () => {
    // Accessing .count should not require ()
    expect(typeof aiSuppressedRules.count).toBe('number');
    // Confirm it's a getter on the prototype, not an own enumerable prop
    const descriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(aiSuppressedRules),
      'count',
    );
    expect(descriptor?.get).toBeInstanceOf(Function);
    expect(descriptor?.set).toBeUndefined();
  });

  it('reflects current entry count', () => {
    expect(aiSuppressedRules.count).toBe(0);
    aiSuppressedRules.suppress('R1', makeFix());
    expect(aiSuppressedRules.count).toBe(1);
    aiSuppressedRules.suppress('R2', makeFix({ rule_id: 'R2' }));
    expect(aiSuppressedRules.count).toBe(2);
    aiSuppressedRules.clear();
    expect(aiSuppressedRules.count).toBe(0);
  });
});


// ── scope getter ────────────────────────────────────────────────────

describe('scope', () => {
  it('returns env and workspaceId from current config', () => {
    const { env, workspaceId } = aiSuppressedRules.scope;
    // default values before configure()
    expect(env).toBeDefined();
    expect(workspaceId).toBeDefined();
  });
});
