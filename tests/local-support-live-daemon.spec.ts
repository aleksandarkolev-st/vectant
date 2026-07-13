import { test, expect } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let daemon: ChildProcess;
let upstreamServer: Server;
let workspace: string;
let baseUrl: string;
let credentials: Record<string, string>;
let previewPort: number;
let upstreamHeaders: Record<string, string | string[] | undefined> = {};

test.describe.configure({ mode: 'serial' });

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
  const upstreamPort = await new Promise<number>((resolve, reject) => {
    upstreamServer = createServer((req, res) => {
      upstreamHeaders = { ...req.headers };
      if (req.url === '/relative-redirect') {
        res.statusCode = 302;
        res.setHeader('Location', '/hello');
        return res.end();
      }
      if (req.url === '/external-redirect') {
        res.statusCode = 302;
        res.setHeader('Location', 'https://example.com/outside');
        return res.end();
      }
      if (req.url === '/private-redirect') {
        res.statusCode = 302;
        res.setHeader('Location', 'http://127.0.0.1:9/private');
        return res.end();
      }
      res.setHeader('Set-Cookie', 'session=secret');
      res.setHeader('Content-Security-Policy', 'unsafe-inline');
      res.setHeader('X-Live-Upstream', 'yes');
      res.end('preview-live-ok');
    });
    upstreamServer.once('error', reject);
    upstreamServer.listen(0, '127.0.0.1', () => {
      const address = upstreamServer.address();
      if (!address || typeof address === 'string') return reject(new Error('preview upstream address unavailable'));
      resolve(address.port);
    });
  });
  previewPort = upstreamPort;
  daemon = spawn(executable, [workspace, String(upstreamPort)], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('live daemon did not become ready')), 30_000);
    daemon.stdout?.on('data', (chunk: Buffer) => {
      const line = chunk.toString();
      const match = line.match(/LIVE_TEST_DAEMON_READY (http:\/\/127\.0\.0\.1:\d+) token=(\S+) control=(\S+) preview_token=(\S+) preview_host=(\S+) process_identity=(\S+)/);
      if (match) {
        clearTimeout(timeout);
        baseUrl = match[1];
        credentials = {
          token: match[2],
          control: match[3],
          previewToken: match[4],
          previewHost: match[5],
          processIdentity: match[6],
        };
        resolve();
      }
    });
    daemon.once('exit', (code) => reject(new Error(`live daemon exited before readiness: ${code}`)));
  });
});

test.afterAll(() => {
  daemon?.kill();
  upstreamServer?.close();
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

test('real preview gateway forwards only approved browser traffic and revokes it', async ({ request }) => {
  const headers = {
    origin: 'https://app.vectant.dev',
    'sec-fetch-site': 'same-site',
    'x-vectant-csrf': 'live-test-csrf-token-012345678901',
    authorization: `Bearer ${credentials.token}`,
    host: credentials.previewHost,
  };
  const query = (requestId: string, token = credentials.previewToken) =>
    `request_id=${requestId}&preview_token=${token}&process_identity=${credentials.processIdentity}`;

  const preview = await request.get(`${baseUrl}/v1/preview/${previewPort}/hello?${query('preview_live_ok')}`, { headers });
  expect(preview.ok()).toBeTruthy();
  expect(await preview.text()).toBe('preview-live-ok');
  expect(preview.headers()['set-cookie']).toBeUndefined();
  expect(preview.headers()['content-security-policy']).toContain("default-src 'self'");
  expect(preview.headers()['x-live-upstream']).toBe('yes');
  expect(upstreamHeaders.cookie).toBeUndefined();
  expect(upstreamHeaders.authorization).toBeUndefined();
  expect(upstreamHeaders['x-api-key']).toBeUndefined();
  expect(upstreamHeaders['x-csrf-token']).toBeUndefined();
  expect(upstreamHeaders['proxy-authorization']).toBeUndefined();

  const credentialHeaders = await request.get(`${baseUrl}/v1/preview/${previewPort}/hello?${query('preview_credential_headers')}`, {
    headers: {
      ...headers,
      cookie: 'session=browser-secret',
      'x-api-key': 'browser-api-secret',
      'x-csrf-token': 'browser-csrf-secret',
      'proxy-authorization': 'Basic dXNlcjpwYXNz',
    },
  });
  expect(credentialHeaders.status()).toBe(403);
  await expect(credentialHeaders.json()).resolves.toMatchObject({ reason: 'credential_header_blocked' });

  const badOrigin = await request.get(`${baseUrl}/v1/preview/${previewPort}/hello?${query('preview_bad_origin')}`, {
    headers: { ...headers, origin: 'https://evil.example' },
  });
  expect(badOrigin.status()).toBe(403);
  await expect(badOrigin.json()).resolves.toMatchObject({ reason: 'bad_origin' });

  const serviceWorker = await request.get(`${baseUrl}/v1/preview/${previewPort}/service-worker.js?${query('preview_service_worker')}`, { headers });
  expect(serviceWorker.status()).toBe(403);
  await expect(serviceWorker.json()).resolves.toMatchObject({ reason: 'service_worker_path_blocked' });

  const encodedServiceWorker = await request.get(`${baseUrl}/v1/preview/${previewPort}/service%2Dworker.js?${query('preview_encoded_service_worker')}`, { headers });
  expect(encodedServiceWorker.status()).toBe(403);

  const relativeRedirect = await request.get(`${baseUrl}/v1/preview/${previewPort}/relative-redirect?${query('preview_relative_redirect')}`, { headers, maxRedirects: 0 });
  expect(relativeRedirect.status()).toBe(302);
  expect(relativeRedirect.headers().location).toBe('/hello');

  const externalRedirect = await request.get(`${baseUrl}/v1/preview/${previewPort}/external-redirect?${query('preview_external_redirect')}`, { headers, maxRedirects: 0 });
  expect(externalRedirect.status()).toBe(302);
  expect(externalRedirect.headers().location).toBe('https://example.com/outside');

  const privateRedirect = await request.get(`${baseUrl}/v1/preview/${previewPort}/private-redirect?${query('preview_private_redirect')}`, { headers });
  expect(privateRedirect.status()).toBe(403);
  await expect(privateRedirect.json()).resolves.toMatchObject({ reason: 'redirect_target_not_approved' });

  const badToken = await request.get(`${baseUrl}/v1/preview/${previewPort}/hello?${query('preview_bad_token', 'wrong-preview-token-012345678901234567890')}`, { headers });
  expect(badToken.status()).toBe(403);
  await expect(badToken.json()).resolves.toMatchObject({ reason: 'preview_token_invalid' });

  for (const [method, requestId] of [
    ['post', 'preview_post_blocked'],
    ['put', 'preview_put_blocked'],
    ['patch', 'preview_patch_blocked'],
    ['delete', 'preview_delete_blocked'],
  ] as const) {
    const response = await request[method](`${baseUrl}/v1/preview/${previewPort}/hello?${query(requestId)}`, {
      headers,
      data: method === 'get' || method === 'delete' ? undefined : 'mutation=allowed',
    });
    expect(response.ok(), `${method.toUpperCase()} must be forwarded`).toBeTruthy();
    await expect(response.text()).resolves.toBe('preview-live-ok');
  }

  const revoked = await request.post(`${baseUrl}/v1/port/revoke/${previewPort}/preview_revoke`, {
    headers: { ...headers, 'x-vectant-local-control-secret': credentials.control },
  });
  expect(revoked.ok()).toBeTruthy();
  const afterRevoke = await request.get(`${baseUrl}/v1/preview/${previewPort}/hello?${query('preview_after_revoke')}`, { headers });
  expect(afterRevoke.status()).toBe(403);
});
