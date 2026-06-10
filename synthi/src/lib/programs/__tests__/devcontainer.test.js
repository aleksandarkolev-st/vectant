import { describe, expect, it } from 'vitest';

import { importDevcontainer } from '../devcontainer';
import { ProgramManifestError } from '../manifest';

/** Assert a thrown ProgramManifestError with a given code (and optional field). */
function expectManifestError(fn, code, field) {
  let thrown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, 'expected importDevcontainer to throw').toBeInstanceOf(ProgramManifestError);
  expect(thrown.code).toBe(code);
  if (field) expect(thrown.field).toBe(field);
}

describe('importDevcontainer — mapping', () => {
  it('maps image + forwardPorts + lifecycle commands to a web recipe', () => {
    const { config, strippedEnvKeys } = importDevcontainer({
      name: 'My Dev Server',
      image: 'node:20',
      forwardPorts: [3000],
      postCreateCommand: 'npm ci',
      postStartCommand: 'npm run dev',
    });

    expect(config.source).toBe('devcontainer.json');
    expect(config.runtimeType).toBe('web');
    expect(config.ports).toEqual([3000]);
    expect(config.install).toEqual(['npm ci']);
    expect(config.launch).toBe('npm run dev');
    expect(config.sourceHints.containerImage).toBe('node:20');
    expect(config.packageId).toBe('my-dev-server');
    expect(config.displayName).toBe('My Dev Server');
    expect(strippedEnvKeys).toEqual([]);
  });

  it('orders install commands onCreate → updateContent → postCreate and flattens array form', () => {
    const { config } = importDevcontainer({
      name: 'tool',
      onCreateCommand: 'echo create',
      updateContentCommand: 'echo update',
      postCreateCommand: ['npm', 'ci'],
    });
    expect(config.install).toEqual(['echo create', 'echo update', 'npm ci']);
  });

  it('defaults launch to a keep-alive and background runtime when no ports/postStart', () => {
    const { config } = importDevcontainer({ name: 'svc', image: 'alpine' });
    expect(config.launch).toBe('sleep infinity');
    expect(config.runtimeType).toBe('background');
    expect(config.ports).toEqual([]);
  });

  it('strips blocked platform env keys and reports them', () => {
    const { config, strippedEnvKeys } = importDevcontainer({
      name: 'app',
      containerEnv: { DATABASE_URL: 'postgres://secret', NODE_ENV: 'development' },
    });
    expect(strippedEnvKeys).toContain('DATABASE_URL');
    expect(config.env).toEqual({ NODE_ENV: 'development' });
  });

  it('ignores workspaceFolder (a container path) and records a warning', () => {
    const { config, warnings } = importDevcontainer({ name: 'app', workspaceFolder: '/workspaces/app' });
    expect(config.workingDir).toBe('');
    expect(warnings).toContain('ignored:workspaceFolder');
  });

  it('parses a JSON string input', () => {
    const { config } = importDevcontainer(JSON.stringify({ name: 'x', postStartCommand: 'run' }));
    expect(config.launch).toBe('run');
  });
});

describe('importDevcontainer — host-escape rejection', () => {
  it('rejects a docker.sock bind mount', () => {
    expectManifestError(
      () => importDevcontainer({ name: 'x', mounts: ['type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock'] }),
      'host_escape',
      'mounts',
    );
  });

  it('rejects --privileged runArgs', () => {
    expectManifestError(() => importDevcontainer({ name: 'x', runArgs: ['--privileged'] }), 'host_escape', 'runArgs');
  });

  it('rejects a privileged:true flag', () => {
    expectManifestError(() => importDevcontainer({ name: 'x', privileged: true }), 'host_escape', 'privileged');
  });

  it('rejects docker-in-docker features', () => {
    expectManifestError(
      () => importDevcontainer({ name: 'x', features: { 'ghcr.io/devcontainers/features/docker-in-docker:2': {} } }),
      'host_escape',
      'features',
    );
  });

  it('rejects an invalid (non-object) devcontainer', () => {
    expectManifestError(() => importDevcontainer('not json{'), 'invalid_manifest');
  });
});

describe('container-mode devcontainer import', () => {
  it('emits a container runtimeType with real docker build/run when enabled', () => {
    const { config } = importDevcontainer({
      name: 'Dev', image: 'node:20', forwardPorts: [3000], postStartCommand: 'npm run dev',
    }, { containerRuntime: true });
    expect(config.runtimeType).toBe('container');
    expect(config.install.join(' ')).toMatch(/docker pull node:20/);
    expect(config.launch).toMatch(/docker run/);
    expect(config.launch).toMatch(/-p 3000:3000/);
  });

  it('still rejects host-escape recipes in container mode', () => {
    expect(() => importDevcontainer(
      { name: 'x', image: 'node:20', privileged: true }, { containerRuntime: true }
    )).toThrow();
  });
});
