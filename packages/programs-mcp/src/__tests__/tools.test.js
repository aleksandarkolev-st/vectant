import { describe, expect, it } from 'vitest';
import { PROGRAMS_TOOLS } from '../tools.js';

const tool = (name) => PROGRAMS_TOOLS.find((t) => t.name === name);

describe('PROGRAMS_TOOLS', () => {
  it('advertises exactly the three tools with input schemas', () => {
    expect(PROGRAMS_TOOLS.map((t) => t.name)).toEqual([
      'describe_manifest_schema',
      'validate_manifest',
      'generate_manifest',
    ]);
    for (const t of PROGRAMS_TOOLS) {
      expect(typeof t.description).toBe('string');
      expect(t.inputSchema.type).toBe('object');
      expect(typeof t.handler).toBe('function');
    }
  });

  it('describe_manifest_schema returns the reference + markdown', async () => {
    const r = await tool('describe_manifest_schema').handler({});
    expect(r.structuredContent.fields.length).toBeGreaterThan(0);
    expect(r.text).toContain('vectant.programs.json');
  });

  it('validate_manifest passes a valid manifest', async () => {
    const r = await tool('validate_manifest').handler({ manifest: { packageId: 'x', version: '1.0.0', launch: 'run' } });
    expect(r.structuredContent.valid).toBe(true);
    expect(r.text).toContain('valid');
  });

  it('validate_manifest reports errors for an invalid manifest', async () => {
    const r = await tool('validate_manifest').handler({ manifest: { packageId: '../evil' } });
    expect(r.structuredContent.valid).toBe(false);
    expect(r.text).toContain('invalid');
  });

  it('generate_manifest returns the manifest when the injected backend succeeds', async () => {
    const generate = async () => ({ configured: true, manifest: { packageId: 'x', version: '1', launch: 'run' } });
    const r = await tool('generate_manifest').handler({ files: { 'package.json': '{}' } }, { generate });
    expect(r.structuredContent.manifest).toBeTruthy();
    expect(r.text).toContain('generated');
  });

  it('generate_manifest surfaces not_configured as text', async () => {
    const generate = async () => ({ configured: false, error: 'not_configured', message: 'set the URL' });
    const r = await tool('generate_manifest').handler({ files: { a: 'b' } }, { generate });
    expect(r.text).toContain('not_configured');
  });
});
