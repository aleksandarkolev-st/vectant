import { describe, expect, it } from 'vitest';

import { parseProgramManifest, ProgramManifestError, KNOWN_SCOPES, SUPPORTED_RUNTIME_TYPES } from '../manifest';

/** Assert a thrown ProgramManifestError with a given code (and optional field). */
function expectManifestError(fn, code, field) {
  let thrown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, 'expected parseProgramManifest to throw').toBeInstanceOf(ProgramManifestError);
  expect(thrown.name).toBe('ProgramManifestError');
  expect(thrown.code).toBe(code);
  if (field) expect(thrown.field).toBe(field);
}

describe('parseProgramManifest — valid manifests', () => {
  it('normalizes a full manifest and preserves every declared field', () => {
    const full = {
      packageId: 'my-dev-server',
      version: '1.2.0',
      displayName: 'My Dev Server',
      runtimeType: 'web',
      workingDir: 'apps/web',
      install: ['npm ci'],
      launch: 'npm run dev',
      env: { NODE_ENV: 'development', PORT: '3000' },
      ports: [3000, 9229],
      surfaces: ['app', 'logs', 'terminal', 'ports', 'health', 'settings'],
      health: { type: 'http', target: 'http://localhost:3000/health', intervalMs: 5000 },
      permissions: ['workspace.files.read', 'workspace.files.write', 'network.outbound', 'ports.expose'],
    };

    const cfg = parseProgramManifest(full);

    expect(cfg.packageId).toBe('my-dev-server');
    expect(cfg.version).toBe('1.2.0');
    expect(cfg.displayName).toBe('My Dev Server');
    expect(cfg.runtimeType).toBe('web');
    expect(cfg.workingDir).toBe('apps/web');
    expect(cfg.install).toEqual(['npm ci']);
    expect(cfg.launch).toBe('npm run dev');
    expect(cfg.env).toEqual({ NODE_ENV: 'development', PORT: '3000' });
    expect(cfg.ports).toEqual([3000, 9229]);
    expect(cfg.surfaces).toEqual(['app', 'logs', 'terminal', 'ports', 'health', 'settings']);
    expect(cfg.health).toEqual({ type: 'http', target: 'http://localhost:3000/health', intervalMs: 5000 });
    expect(cfg.source).toBe('vectant.programs.json');
    expect(cfg.sourceHints).toEqual({});
  });

  it('always implies the program.launch scope even when omitted', () => {
    const cfg = parseProgramManifest({
      packageId: 'my-dev-server',
      version: '1.2.0',
      launch: 'npm run dev',
      permissions: ['network.outbound'],
    });
    expect(cfg.permissions).toContain('program.launch');
    expect(cfg.permissions).toContain('network.outbound');
    // de-duplicated and all within KNOWN_SCOPES
    expect(new Set(cfg.permissions).size).toBe(cfg.permissions.length);
    cfg.permissions.forEach((scope) => expect(KNOWN_SCOPES).toContain(scope));
  });

  it('fills sensible defaults for a minimal manifest', () => {
    const cfg = parseProgramManifest({ packageId: 'tool', version: '0.0.1', launch: './run.sh' });

    expect(cfg.runtimeType).toBe('cli');
    expect(cfg.workingDir).toBe('');
    expect(cfg.install).toEqual([]);
    expect(cfg.env).toEqual({});
    expect(cfg.ports).toEqual([]);
    expect(cfg.permissions).toEqual(['program.launch']);
    expect(cfg.health).toBeNull();
    expect(cfg.displayName).toBe('tool');
    expect(cfg.surfaces).toEqual(expect.arrayContaining(['terminal', 'logs', 'health', 'settings']));
    expect(cfg.surfaces).not.toContain('app');
    expect(cfg.surfaces).not.toContain('ports');
  });

  it('parses a JSON string input', () => {
    const cfg = parseProgramManifest(JSON.stringify({ packageId: 'tool', version: '1', launch: 'x' }));
    expect(cfg.packageId).toBe('tool');
  });
});

describe('parseProgramManifest — fail-closed validation', () => {
  it('rejects a manifest missing the launch command', () => {
    expectManifestError(() => parseProgramManifest({ packageId: 'x', version: '1' }), 'missing_field', 'launch');
  });

  it('rejects an invalid packageId (spaces / uppercase / punctuation)', () => {
    expectManifestError(() => parseProgramManifest({ packageId: 'Bad ID!', version: '1', launch: 'x' }), 'invalid_field', 'packageId');
  });

  it('rejects a packageId containing path traversal', () => {
    expectManifestError(() => parseProgramManifest({ packageId: '../escape', version: '1', launch: 'x' }), 'invalid_field', 'packageId');
  });

  it('rejects a workingDir that escapes the workspace (relative)', () => {
    expectManifestError(
      () => parseProgramManifest({ packageId: 'x', version: '1', launch: 'x', workingDir: '../secrets' }),
      'path_escape',
      'workingDir',
    );
  });

  it('rejects an absolute workingDir', () => {
    expectManifestError(
      () => parseProgramManifest({ packageId: 'x', version: '1', launch: 'x', workingDir: '/etc' }),
      'path_escape',
      'workingDir',
    );
  });

  it('rejects an unknown permission scope', () => {
    expectManifestError(
      () => parseProgramManifest({ packageId: 'x', version: '1', launch: 'x', permissions: ['bogus.scope'] }),
      'unknown_scope',
      'permissions',
    );
  });

  it('rejects an out-of-range port', () => {
    expectManifestError(
      () => parseProgramManifest({ packageId: 'x', version: '1', launch: 'x', ports: [70000] }),
      'invalid_port',
      'ports',
    );
  });

  it('rejects a non-integer port', () => {
    expectManifestError(
      () => parseProgramManifest({ packageId: 'x', version: '1', launch: 'x', ports: ['abc'] }),
      'invalid_port',
      'ports',
    );
  });

  it('accepts the gui runtimeType and derives an app (stream) surface', () => {
    const cfg = parseProgramManifest({ packageId: 'paint', version: '1.0.0', launch: 'xeyes', runtimeType: 'gui' });
    expect(cfg.runtimeType).toBe('gui');
    expect(cfg.surfaces).toContain('app');
    expect(cfg.surfaces).toContain('logs');
    expect(cfg.surfaces).toContain('settings');
  });

  it('still rejects an unknown runtimeType', () => {
    expectManifestError(
      () => parseProgramManifest({ packageId: 'x', version: '1', launch: 'x', runtimeType: 'wat' }),
      'invalid_field',
      'runtimeType',
    );
  });

  it('normalizes an optional description (trimmed, defaults to empty string)', () => {
    const cfg = parseProgramManifest({ packageId: 'web', version: '1.0.0', launch: 'npm run dev', description: '  A dev server  ' });
    expect(cfg.description).toBe('A dev server');
    const noDesc = parseProgramManifest({ packageId: 'web', version: '1.0.0', launch: 'npm run dev' });
    expect(noDesc.description).toBe('');
  });

  it('rejects a non-object / empty input', () => {
    expectManifestError(() => parseProgramManifest(null), 'invalid_manifest');
    expectManifestError(() => parseProgramManifest('not json{'), 'invalid_manifest');
  });
});

describe('container runtime type', () => {
  it('accepts runtimeType "container"', () => {
    expect(SUPPORTED_RUNTIME_TYPES).toContain('container');
    const cfg = parseProgramManifest({
      packageId: 'x', version: '1.0.0', runtimeType: 'container',
      launch: 'docker run --rm hello-world',
    });
    expect(cfg.runtimeType).toBe('container');
  });
});
