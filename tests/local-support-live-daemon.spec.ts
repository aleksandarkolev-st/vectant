import { test, expect } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let daemon: ChildProcess;
let workspace: string;
let baseUrl: string;

test.beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'vectant-live-daemon-'));
  execFileSync('cargo', [
    'build',
    '--manifest-path', 'backend/vectant-local-support-app/Cargo.toml',
    '--features', 'live-test-daemon',
    '--bin', 'local-support-test-daemon',
  ], { stdio: 'inherit' });

  const executable = join(
    process.cwd(),
    'backend', 'vectant-local-support-app', 'target', 'debug',
    process.platform === 'win32' ? 'local-support-test-daemon.exe' : 'local-support-test-daemon',
  );
  daemon = spawn(executable, [workspace], { stdio: ['ignore', 'pipe', 'pipe'] });
  baseUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('live daemon did not become ready')), 30_000);
    daemon.stdout?.on('data', (chunk: Buffer) => {
      const line = chunk.toString();
      const match = line.match(/LIVE_TEST_DAEMON_READY (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    daemon.once('exit', (code) => reject(new Error(`live daemon exited before readiness: ${code}`)));
  });
});

test.afterAll(() => {
  daemon?.kill();
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

test('real daemon health and protected status boundary are observable over loopback', async ({ request }) => {
  const health = await request.get(`${baseUrl}/health`);
  expect(health.ok()).toBeTruthy();
  await expect(health.json()).resolves.toMatchObject({
    ok: true,
    service: 'vectant-local-support-app',
  });

  const status = await request.get(`${baseUrl}/v1/status/live_status_request`);
  expect(status.status()).toBe(403);
  await expect(status.json()).resolves.toMatchObject({ decision: 'denied' });
});
