import { describe, expect, it } from 'vitest';
import { detectRepoProgram } from '../repoDetect';

const compose = `services:
  web:
    image: nginx
    ports:
      - "8080:80"
`;

describe('detectRepoProgram', () => {
  it('prefers compose over devcontainer over Dockerfile', () => {
    const r = detectRepoProgram({ files: { 'docker-compose.yml': compose, 'Dockerfile': 'FROM x\n' }, containerRuntime: true });
    expect(r.source).toBe('docker-compose.yml');
    expect(r.config.launch).toBe('docker compose up');
  });

  it('detects a devcontainer with an image as a container when no compose is present', () => {
    const dc = JSON.stringify({ name: 'dev', image: 'node:20', forwardPorts: [3000] });
    const r = detectRepoProgram({ files: { 'devcontainer.json': dc }, containerRuntime: true });
    expect(r.source).toBe('devcontainer.json');
    expect(r.config.runtimeType).toBe('container');
  });

  it('falls to Dockerfile when no compose/devcontainer', () => {
    const r = detectRepoProgram({ files: { 'Dockerfile': 'FROM node:20\nEXPOSE 3000\n' }, containerRuntime: true });
    expect(r.source).toBe('Dockerfile');
  });

  it('returns null when the container runtime capability is off', () => {
    expect(detectRepoProgram({ files: { 'docker-compose.yml': compose }, containerRuntime: false })).toBeNull();
  });

  it('returns null when nothing container-like is detected', () => {
    expect(detectRepoProgram({ files: { 'README.md': 'hi' }, containerRuntime: true })).toBeNull();
  });
});
