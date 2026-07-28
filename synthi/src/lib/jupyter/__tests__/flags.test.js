import { afterEach, describe, expect, it, vi } from 'vitest';
import { jupyterFlags } from '../flags';

afterEach(() => vi.unstubAllEnvs());

describe('Jupyter feature flags', () => {
  it('enables editing and execution by default', () => {
    vi.stubEnv('NEXT_PUBLIC_JUPYTER_NOTEBOOK_EDITING', '');
    vi.stubEnv('NEXT_PUBLIC_JUPYTER_AGENT_EXECUTION', '');
    expect(jupyterFlags.editing()).toBe(true);
    expect(jupyterFlags.execution()).toBe(true);
  });

  it('allows an explicit kill switch', () => {
    vi.stubEnv('NEXT_PUBLIC_JUPYTER_NOTEBOOK_EDITING', '0');
    vi.stubEnv('NEXT_PUBLIC_JUPYTER_AGENT_EXECUTION', '0');
    expect(jupyterFlags.editing()).toBe(false);
    expect(jupyterFlags.execution()).toBe(false);
  });
});
