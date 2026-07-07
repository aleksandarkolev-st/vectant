import { describe, expect, it } from 'vitest';
import {
  referenceMarkdown, manifestReference, FIELDS, KNOWN_SCOPES,
  SUPPORTED_RUNTIME_TYPES, EXAMPLE_WEB, EXAMPLE_CONTAINER,
} from '../manifestSpec.js';
import { validateManifest } from '../validate.js';

describe('manifestSpec', () => {
  it('markdown reference names the format and a scope', () => {
    const md = referenceMarkdown();
    expect(md).toContain('vectant.programs.json');
    expect(md).toContain('runtimeType');
    expect(md).toContain('program.launch');
  });

  it('structured reference exposes fields, scopes, runtime types, and examples', () => {
    const ref = manifestReference();
    expect(ref.fields).toBe(FIELDS);
    expect(ref.scopes).toEqual(KNOWN_SCOPES);
    expect(ref.runtimeTypes).toEqual(SUPPORTED_RUNTIME_TYPES);
    expect(ref.examples.web).toEqual(EXAMPLE_WEB);
  });

  it('marks the three required fields', () => {
    const required = FIELDS.filter((f) => f.required).map((f) => f.name).sort();
    expect(required).toEqual(['launch', 'packageId', 'version']);
  });

  // Drift guard: the examples we teach must pass our own validator.
  it('both worked examples validate clean', () => {
    expect(validateManifest(EXAMPLE_WEB).valid).toBe(true);
    expect(validateManifest(EXAMPLE_CONTAINER).valid).toBe(true);
  });
});
