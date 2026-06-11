import { describe, expect, it } from 'vitest';
import { mergeProgramSession } from '../routeHelpers';

describe('mergeProgramSession health surfacing', () => {
  it('surfaces the live runtime healthState as lastHealthState', () => {
    const merged = mergeProgramSession(
      { id: 'ps-1', state: 'starting', lastHealthState: null },
      { state: 'running', activePorts: [3000], webPort: 3000, healthState: 'ok' },
    );
    expect(merged.lastHealthState).toBe('ok');
    expect(merged.webPort).toBe(3000);
    expect(merged.activePorts).toEqual([3000]);
  });

  it('falls back to the persisted lastHealthState when the runtime has none', () => {
    const merged = mergeProgramSession(
      { id: 'ps-1', state: 'stopped', lastHealthState: 'unhealthy' },
      null,
    );
    expect(merged.lastHealthState).toBe('unhealthy');
  });

  it('is null when neither side has a health state', () => {
    const merged = mergeProgramSession({ id: 'ps-1', state: 'starting' }, { state: 'starting' });
    expect(merged.lastHealthState).toBeNull();
  });
});
