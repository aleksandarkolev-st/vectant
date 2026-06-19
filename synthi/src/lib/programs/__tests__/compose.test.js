import { describe, expect, it } from 'vitest';
import { importComposeFile } from '../compose';

const RAW = `services:
  web:
    image: nginx
    ports:
      - "8080:80"
`;

describe('importComposeFile', () => {
  it('maps a compose file to a container program (docker compose up + scraped host ports)', () => {
    const { config } = importComposeFile(RAW, { containerRuntime: true });
    expect(config.runtimeType).toBe('container');
    expect(config.launch).toBe('docker compose up');
    expect(config.ports).toContain(8080);
  });

  it('scrapes unquoted and IP-prefixed port forms', () => {
    const raw = `services:\n  a:\n    ports:\n      - 3000:3000\n      - "127.0.0.1:5000:5000"\n`;
    const { config } = importComposeFile(raw, { containerRuntime: true });
    expect(config.ports).toEqual(expect.arrayContaining([3000, 5000]));
  });

  it('returns a null config when the container runtime is unavailable', () => {
    expect(importComposeFile(RAW, { containerRuntime: false }).config).toBeNull();
  });

  it('rejects a compose file that mounts the docker socket (host escape)', () => {
    const bad = `services:\n  x:\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n`;
    let err;
    try { importComposeFile(bad, { containerRuntime: true }); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.code).toBe('host_escape');
  });

  it('rejects input that is not a compose file', () => {
    let err;
    try { importComposeFile('name: not-compose\n', { containerRuntime: true }); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.code).toBe('invalid_manifest');
  });
});
