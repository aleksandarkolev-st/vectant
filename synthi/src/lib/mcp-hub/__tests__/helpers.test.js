import { describe, it, expect } from 'vitest';
import { buildAuthHeaders, jsonSchemaToGemini } from '../helpers.js';

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
});
