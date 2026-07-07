import { describe, expect, it } from 'vitest';
import { runHardGates } from '../hardGates';

const webConfig = {
  packageId: 'web', version: '1.0.0', displayName: 'Web', runtimeType: 'web',
  workingDir: '', install: ['npm ci'], launch: 'npm run dev', env: {}, ports: [3000],
  surfaces: [], health: null, permissions: ['program.launch', 'network.outbound'],
  source: 'vectant.programs.json', sourceHints: {},
};
const containerConfig = (over = {}) => ({
  packageId: 'tool', version: '1.0.0', displayName: 'Tool', runtimeType: 'container',
  workingDir: '', install: ['docker pull reg.io/me/tool:1'], env: {}, ports: [6901],
  launch: 'docker run --rm -p 6901:6901 -v "$PWD":/workspace reg.io/me/tool:1',
  surfaces: [], health: null, permissions: ['program.launch'],
  source: 'vectant.programs.json', sourceHints: {}, ...over,
});

describe('runHardGates', () => {
  it('passes a clean web manifest (no image required)', () => {
    expect(runHardGates({ config: webConfig })).toEqual({ ok: true, reasons: [] });
  });

  it('passes a clean container manifest whose launch references the source image', () => {
    expect(runHardGates({ config: containerConfig(), sourceImageRef: 'reg.io/me/tool:1' }))
      .toEqual({ ok: true, reasons: [] });
  });

  it('fails an invalid manifest schema (fail-closed)', () => {
    const r = runHardGates({ config: { ...webConfig, packageId: '../evil' } });
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.code === 'invalid_manifest' || x.field === 'packageId')).toBe(true);
  });

  it('fails an unknown / over-broad scope', () => {
    const r = runHardGates({ config: { ...webConfig, permissions: ['program.launch', 'host.root'] } });
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.code === 'unknown_scope')).toBe(true);
  });

  it('fails a host-escape in the launch command (docker.sock)', () => {
    const r = runHardGates({
      config: containerConfig({ launch: 'docker run -v /var/run/docker.sock:/var/run/docker.sock reg.io/me/tool:1' }),
      sourceImageRef: 'reg.io/me/tool:1',
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.code === 'host_escape')).toBe(true);
  });

  it('fails a host-escape in an install command (--privileged)', () => {
    const r = runHardGates({
      config: containerConfig({ install: ['docker run --privileged reg.io/me/tool:1 setup'] }),
      sourceImageRef: 'reg.io/me/tool:1',
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.code === 'host_escape')).toBe(true);
  });

  it('fails a container submission with no sourceImageRef (metadata)', () => {
    const r = runHardGates({ config: containerConfig() });
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.code === 'image_required')).toBe(true);
  });

  it('fails when the declared sourceImageRef is not referenced by the launch (metadata mismatch)', () => {
    const r = runHardGates({ config: containerConfig(), sourceImageRef: 'reg.io/SOMEONE_ELSE/x:9' });
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.code === 'image_mismatch')).toBe(true);
  });
});
