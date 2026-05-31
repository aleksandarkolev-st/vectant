import { describe, it, expect } from 'vitest';
import { buildAuthHeaders, jsonSchemaToGemini, isAllowedHeaderName } from '../helpers.js';

describe('buildAuthHeaders', () => {
  it('builds a bearer header', () => {
    expect(buildAuthHeaders({ authType: 'bearer', secret: 'tok' }))
      .toEqual({ Authorization: 'Bearer tok' });
  });
  it('builds a custom header', () => {
    expect(buildAuthHeaders({ authType: 'header', headerName: 'X-Api-Key', secret: 'k' }))
      .toEqual({ 'X-Api-Key': 'k' });
  });
  it('returns an empty object for none', () => {
    expect(buildAuthHeaders({ authType: 'none' })).toEqual({});
  });
  it('returns {} when headerName is disallowed (Host)', () => {
    expect(buildAuthHeaders({ authType: 'header', headerName: 'Host', secret: 'x' }))
      .toEqual({});
  });
  it('returns {} when headerName is missing', () => {
    expect(buildAuthHeaders({ authType: 'header', secret: 'x' }))
      .toEqual({});
  });
  it('preserves original header casing for allowed custom header', () => {
    expect(buildAuthHeaders({ authType: 'header', headerName: 'X-Api-Key', secret: 'k' }))
      .toEqual({ 'X-Api-Key': 'k' });
  });
});

describe('isAllowedHeaderName', () => {
  it('accepts X-Api-Key', () => {
    expect(isAllowedHeaderName('X-Api-Key')).toBe(true);
  });
  it('rejects empty string', () => {
    expect(isAllowedHeaderName('')).toBe(false);
  });
  it('rejects non-string (null)', () => {
    expect(isAllowedHeaderName(null)).toBe(false);
  });
  it('rejects non-string (number)', () => {
    expect(isAllowedHeaderName(42)).toBe(false);
  });
  it('rejects Host (exact case)', () => {
    expect(isAllowedHeaderName('Host')).toBe(false);
  });
  it('rejects host (lowercase)', () => {
    expect(isAllowedHeaderName('host')).toBe(false);
  });
  it('rejects cookie (case-insensitive)', () => {
    expect(isAllowedHeaderName('Cookie')).toBe(false);
  });
  it('rejects authorization (case-insensitive)', () => {
    expect(isAllowedHeaderName('Authorization')).toBe(false);
  });
  it('rejects X-Forwarded-For (starts with x-forwarded-)', () => {
    expect(isAllowedHeaderName('X-Forwarded-For')).toBe(false);
  });
  it('rejects x-forwarded-host (lowercase variant)', () => {
    expect(isAllowedHeaderName('x-forwarded-host')).toBe(false);
  });
  it('rejects name with space (illegal char)', () => {
    expect(isAllowedHeaderName('X Api Key')).toBe(false);
  });
  it('rejects name with colon (illegal char)', () => {
    expect(isAllowedHeaderName('X:Key')).toBe(false);
  });
});

describe('jsonSchemaToGemini', () => {
  it('uppercases types recursively and preserves structure', () => {
    const out = jsonSchemaToGemini({
      type: 'object',
      properties: {
        title: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['title'],
    });
    expect(out).toEqual({
      type: 'OBJECT',
      properties: {
        title: { type: 'STRING' },
        tags: { type: 'ARRAY', items: { type: 'STRING' } },
      },
      required: ['title'],
    });
  });
  it('defaults missing/empty schema to an empty OBJECT', () => {
    expect(jsonSchemaToGemini(undefined)).toEqual({ type: 'OBJECT', properties: {} });
  });
  it('drops unsupported keywords (oneOf, $ref, allOf)', () => {
    const out = jsonSchemaToGemini({
      type: 'object',
      properties: { a: { type: 'string' } },
      oneOf: [{}],
      $ref: '#/x',
      allOf: [{}],
    });
    expect(out).not.toHaveProperty('oneOf');
    expect(out).not.toHaveProperty('$ref');
    expect(out).not.toHaveProperty('allOf');
    expect(out.type).toBe('OBJECT');
    expect(out.properties.a).toEqual({ type: 'STRING' });
  });
  it('truncates description longer than 512 chars to exactly 512', () => {
    const longDesc = 'x'.repeat(600);
    const out = jsonSchemaToGemini({ type: 'string', description: longDesc });
    expect(out.description.length).toBe(512);
  });
  it('does not throw on deeply nested schema and falls back to STRING at depth limit', () => {
    // Build 12 levels of nesting
    let schema = { type: 'string' };
    for (let i = 0; i < 12; i++) {
      schema = { type: 'object', properties: { next: schema } };
    }
    let result;
    expect(() => { result = jsonSchemaToGemini(schema); }).not.toThrow();
    expect(result.type).toBe('OBJECT');
    // Drill down 8 levels (MAX_DEPTH), the next level should be STRING fallback
    let node = result;
    for (let i = 0; i < 8; i++) {
      expect(node.type).toBe('OBJECT');
      node = node.properties.next;
    }
    // At depth 9 (index 8), should have hit the limit and returned STRING
    expect(node.type).toBe('STRING');
  });
});
