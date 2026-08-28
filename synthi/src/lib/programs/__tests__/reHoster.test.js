import { describe, expect, it, vi } from 'vitest';
import { reHostImage, communityImageTarget, pinManifestImage } from '../reHoster';

describe('communityImageTarget', () => {
  it('builds an env-driven AR repo path namespaced by publisher + package', () => {
    const t = communityImageTarget({ publisher: 'team', packageId: 'tool' }, {
      host: 'europe-west1-docker.pkg.dev', project: 'proj', repo: 'community',
    });
    expect(t).toBe('europe-west1-docker.pkg.dev/proj/community/team/tool');
  });
});

describe('reHostImage', () => {
  it('crane-copies then resolves + returns the pinned AR digest ref', async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce({ stdout: '' })                       // crane copy
      .mockResolvedValueOnce({ stdout: 'sha256:deadbeef\n' });     // crane digest
    const out = await reHostImage('reg.io/me/tool:1', 'ar.host/p/community/team/tool', { runner });
    expect(out.digest).toBe('sha256:deadbeef');
    expect(out.ref).toBe('ar.host/p/community/team/tool@sha256:deadbeef');
    expect(runner).toHaveBeenNthCalledWith(1, 'copy', expect.arrayContaining(['reg.io/me/tool:1', 'ar.host/p/community/team/tool']));
    expect(runner).toHaveBeenNthCalledWith(2, 'digest', ['ar.host/p/community/team/tool']);
  });

  it('throws when crane copy fails (caller fails closed)', async () => {
    const runner = vi.fn().mockRejectedValue(new Error('crane copy: denied'));
    await expect(reHostImage('reg.io/me/tool:1', 'ar.host/p/x', { runner })).rejects.toThrow(/crane/i);
  });
});

describe('pinManifestImage', () => {
  it('rewrites the source ref to the AR digest ref in launch + install', () => {
    const config = {
      runtimeType: 'container',
      install: ['docker pull reg.io/me/tool:1'],
      launch: 'docker run --rm -p 6901:6901 -v "$PWD":/workspace reg.io/me/tool:1',
    };
    const pinned = pinManifestImage(config, 'reg.io/me/tool:1', 'ar.host/p/community/team/tool@sha256:deadbeef');
    expect(pinned.launch).toContain('ar.host/p/community/team/tool@sha256:deadbeef');
    expect(pinned.launch).not.toContain('reg.io/me/tool:1');
    expect(pinned.install[0]).toContain('@sha256:deadbeef');
    expect(config.launch).toContain('reg.io/me/tool:1'); // original not mutated
  });

  it('returns the config unchanged when there is no source ref (web/cli)', () => {
    const config = { runtimeType: 'web', install: ['npm ci'], launch: 'npm run dev' };
    expect(pinManifestImage(config, null, null)).toEqual(config);
  });
});
