import { describe, expect, it } from 'vitest';
import { importDockerfile } from '../dockerfile';

describe('importDockerfile', () => {
  it('maps a Dockerfile to a build+run container program with EXPOSE ports', () => {
    const { config } = importDockerfile('FROM node:20\nEXPOSE 3000\n', { name: 'myapp', containerRuntime: true });
    expect(config.runtimeType).toBe('container');
    expect(config.install[0]).toMatch(/docker build -t/);
    expect(config.launch).toMatch(/docker run/);
    expect(config.launch).toContain('-p 3000:3000');
    // Container programs mount the workspace so they share /workspace with the editor.
    expect(config.launch).toContain('-v "$PWD":/workspace -w /workspace');
    expect(config.ports).toContain(3000);
  });

  it('builds a runnable command with no port flags when there is no EXPOSE', () => {
    const { config } = importDockerfile('FROM node:20\n', { name: 'app', containerRuntime: true });
    expect(config.ports).toEqual([]);
    expect(config.launch).toBe('docker run --rm -v "$PWD":/workspace -w /workspace app');
  });

  it('returns a null config when the container runtime is unavailable', () => {
    expect(importDockerfile('FROM scratch\n', { name: 'x', containerRuntime: false }).config).toBeNull();
  });

  it('returns a null config when the input is not a Dockerfile', () => {
    expect(importDockerfile('not a dockerfile', { name: 'x', containerRuntime: true }).config).toBeNull();
  });
});
