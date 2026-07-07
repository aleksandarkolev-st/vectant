import { describe, expect, it, vi } from 'vitest';
import { evaluateImageSize } from '../imageSize';

/** A single-platform image manifest: total = config.size + Σ layers.size. */
const singleManifest = (bytes) => JSON.stringify({
  schemaVersion: 2,
  mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
  config: { size: 100 },
  layers: [{ size: 1000 }, { size: bytes - 1100 }],
});

/** A multi-arch index: no `layers`, must be resolved to a platform. */
const indexManifest = JSON.stringify({
  schemaVersion: 2,
  mediaType: 'application/vnd.oci.image.index.v1+json',
  manifests: [
    { platform: { os: 'linux', architecture: 'amd64' }, size: 500 },
    { platform: { os: 'linux', architecture: 'arm64' }, size: 500 },
  ],
});

describe('evaluateImageSize', () => {
  it('passes an image under the limit (config + layers summed)', async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: singleManifest(2000) });
    const res = await evaluateImageSize('reg.io/me/tool:1', { limitBytes: 5000, runner });
    expect(res.ok).toBe(true);
    expect(res.summary.sizeBytes).toBe(2000);
    expect(res.summary.limitBytes).toBe(5000);
  });

  it('rejects an image over the limit', async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: singleManifest(9000) });
    const res = await evaluateImageSize('reg.io/me/tool:1', { limitBytes: 5000, runner });
    expect(res.ok).toBe(false);
    expect(res.summary.sizeBytes).toBe(9000);
  });

  it('resolves a multi-arch index to a platform and sizes that manifest', async () => {
    const runner = vi.fn().mockImplementation((_sub, args) => {
      if (args.includes('--platform')) return Promise.resolve({ stdout: singleManifest(3000) });
      return Promise.resolve({ stdout: indexManifest });
    });
    const res = await evaluateImageSize('reg.io/me/multi:1', { limitBytes: 5000, runner, platform: 'linux/amd64' });
    expect(res.ok).toBe(true);
    expect(res.summary.sizeBytes).toBe(3000);
    // second call resolved the index with an explicit platform
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[1][1]).toContain('--platform');
    expect(runner.mock.calls[1][1]).toContain('linux/amd64');
  });

  it('fails closed when crane errors (cannot determine size)', async () => {
    const runner = vi.fn().mockRejectedValue(new Error('crane: MANIFEST_UNKNOWN'));
    const res = await evaluateImageSize('reg.io/me/tool:1', { limitBytes: 5000, runner });
    expect(res.ok).toBe(false);
    expect(res.summary.error).toContain('MANIFEST_UNKNOWN');
  });

  it('fails closed on malformed manifest JSON', async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: 'not json' });
    const res = await evaluateImageSize('reg.io/me/tool:1', { limitBytes: 5000, runner });
    expect(res.ok).toBe(false);
    expect(res.summary.error).toBeTruthy();
  });

  it('fails closed when the resolved manifest still has no layers', async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: indexManifest }); // index resolves to another index
    const res = await evaluateImageSize('reg.io/me/tool:1', { limitBytes: 5000, runner });
    expect(res.ok).toBe(false);
    expect(res.summary.error).toBeTruthy();
  });
});
