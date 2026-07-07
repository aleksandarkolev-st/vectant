import { describe, expect, it, vi } from 'vitest';
import { generateManifestFromContext } from '../manifestGenerator';

describe('generateManifestFromContext', () => {
  it('returns the manifest from the client', async () => {
    const client = vi.fn().mockResolvedValue({ manifest: { packageId: 'x', version: '1.0.0' } });
    const out = await generateManifestFromContext({ files: { 'package.json': '{}' }, workspaceName: 'team' }, { client });
    expect(out).toEqual({ packageId: 'x', version: '1.0.0' });
    expect(client).toHaveBeenCalledWith({ files: { 'package.json': '{}' }, workspace_name: 'team' });
  });

  it('returns null when the engine returns an error / no manifest', async () => {
    expect(await generateManifestFromContext({ files: {}, workspaceName: 't' }, { client: vi.fn().mockResolvedValue({ error: 'x' }) })).toBeNull();
  });

  it('returns null when the client throws', async () => {
    expect(await generateManifestFromContext({ files: {}, workspaceName: 't' }, { client: vi.fn().mockRejectedValue(new Error('down')) })).toBeNull();
  });
});
