import { describe, expect, it } from 'vitest';
import { validateManifest } from '../validate.js';
import { EXAMPLE_WEB, EXAMPLE_CONTAINER } from '../manifestSpec.js';

describe('validateManifest', () => {
  it('accepts the reference web example', () => {
    const r = validateManifest(EXAMPLE_WEB);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('accepts the reference container example', () => {
    const r = validateManifest(EXAMPLE_CONTAINER);
    expect(r.valid).toBe(true);
  });

  it('accepts a JSON string, not just an object', () => {
    const r = validateManifest(JSON.stringify(EXAMPLE_WEB));
    expect(r.valid).toBe(true);
  });

  it('rejects non-JSON text', () => {
    const r = validateManifest('{ not json');
    expect(r.valid).toBe(false);
    expect(r.errors[0].code).toBe('invalid_manifest');
  });

  it('rejects a non-object (array)', () => {
    const r = validateManifest('[]');
    expect(r.valid).toBe(false);
    expect(r.errors[0].code).toBe('invalid_manifest');
  });

  it('collects ALL problems in one pass (missing version + bad packageId + unknown scope)', () => {
    const r = validateManifest({ packageId: '../evil', launch: 'run', permissions: ['host.root'] });
    expect(r.valid).toBe(false);
    const codes = r.errors.map((e) => e.code);
    expect(codes).toContain('invalid_field'); // packageId
    expect(codes).toContain('missing_field'); // version
    expect(codes).toContain('unknown_scope'); // host.root
  });

  it('requires a launch command', () => {
    const r = validateManifest({ packageId: 'x', version: '1.0.0' });
    expect(r.errors.some((e) => e.field === 'launch' && e.code === 'missing_field')).toBe(true);
  });

  it('flags an unknown runtimeType', () => {
    const r = validateManifest({ packageId: 'x', version: '1.0.0', launch: 'run', runtimeType: 'wasm' });
    expect(r.errors.some((e) => e.field === 'runtimeType')).toBe(true);
  });

  it('flags an out-of-range port', () => {
    const r = validateManifest({ packageId: 'x', version: '1.0.0', launch: 'run', ports: [70000] });
    expect(r.errors.some((e) => e.code === 'invalid_port')).toBe(true);
  });

  it('flags a workingDir that escapes the workspace', () => {
    const r = validateManifest({ packageId: 'x', version: '1.0.0', launch: 'run', workingDir: '../../etc' });
    expect(r.errors.some((e) => e.code === 'path_escape')).toBe(true);
  });

  it('flags a host-escape in the launch command (docker.sock)', () => {
    const r = validateManifest({
      packageId: 'x', version: '1.0.0', runtimeType: 'container',
      launch: 'docker run -v /var/run/docker.sock:/var/run/docker.sock reg.io/me/x:1',
    });
    expect(r.errors.some((e) => e.code === 'host_escape')).toBe(true);
  });

  it('flags a host-escape in an install command (--privileged)', () => {
    const r = validateManifest({
      packageId: 'x', version: '1.0.0', launch: 'docker run reg.io/me/x:1',
      install: ['docker run --privileged reg.io/me/x:1 setup'],
    });
    expect(r.errors.some((e) => e.code === 'host_escape')).toBe(true);
  });

  it('does not flag the legitimate workspace mount', () => {
    const r = validateManifest({
      packageId: 'x', version: '1.0.0', runtimeType: 'container',
      launch: 'docker run -v "$PWD":/workspace reg.io/me/x:1',
    });
    expect(r.valid).toBe(true);
  });
});
