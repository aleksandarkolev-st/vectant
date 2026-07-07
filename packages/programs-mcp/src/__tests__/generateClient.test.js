import { describe, expect, it, vi } from 'vitest';
import { generateManifest, generateConfig } from '../generateClient.js';

const configured = { configured: true, url: 'https://api.example/generate', token: 't', tokenHeader: 'x-synthi-internal-token' };
const okRes = (body) => ({ ok: true, json: async () => body });

describe('generateConfig', () => {
  it('is unconfigured without a URL', () => {
    expect(generateConfig({}).configured).toBe(false);
  });
  it('is configured with a URL and defaults the token header', () => {
    const c = generateConfig({ VECTANT_MANIFEST_GENERATE_URL: 'https://x/y' });
    expect(c.configured).toBe(true);
    expect(c.tokenHeader).toBe('x-synthi-internal-token');
  });
});

describe('generateManifest', () => {
  it('returns not_configured when no URL is set', async () => {
    const r = await generateManifest({ files: { 'package.json': '{}' } }, { config: generateConfig({}) });
    expect(r.configured).toBe(false);
    expect(r.error).toBe('not_configured');
  });

  it('rejects an empty files map', async () => {
    const r = await generateManifest({ files: {} }, { config: configured, fetchImpl: vi.fn() });
    expect(r.error).toBe('no_files');
  });

  it('posts files and returns the manifest, sending the token header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okRes({ manifest: { packageId: 'x', version: '1.0.0', launch: 'run' } }));
    const r = await generateManifest({ files: { 'package.json': '{}' }, workspaceName: 'demo' }, { config: configured, fetchImpl });
    expect(r.manifest).toEqual({ packageId: 'x', version: '1.0.0', launch: 'run' });
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe(configured.url);
    expect(opts.headers['x-synthi-internal-token']).toBe('t');
    expect(JSON.parse(opts.body)).toEqual({ files: { 'package.json': '{}' }, workspace_name: 'demo' });
  });

  it('surfaces an HTTP error structurally', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 502 });
    const r = await generateManifest({ files: { a: 'b' } }, { config: configured, fetchImpl });
    expect(r.error).toBe('http_error');
    expect(r.status).toBe(502);
  });

  it('surfaces a network failure structurally (never throws)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await generateManifest({ files: { a: 'b' } }, { config: configured, fetchImpl });
    expect(r.error).toBe('request_failed');
    expect(r.message).toContain('ECONNREFUSED');
  });

  it('reports a missing manifest in the response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okRes({ error: 'nope' }));
    const r = await generateManifest({ files: { a: 'b' } }, { config: configured, fetchImpl });
    expect(r.error).toBe('no_manifest');
  });
});
