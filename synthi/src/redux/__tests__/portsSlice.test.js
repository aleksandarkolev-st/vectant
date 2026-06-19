import { describe, expect, it } from 'vitest';

import reducer, {
  initialPortsState,
  setContainerPorts,
  setRuntimePorts,
  clearRuntimePorts,
} from '../portsSlice';

describe('portsSlice', () => {
  it('setContainerPorts replaces the container (local/worker hybrid) ports list', () => {
    const s = reducer(initialPortsState, setContainerPorts([3000, 5173]));
    expect(s.containerPorts).toEqual([3000, 5173]);
  });

  // Slice 4: sysbox runtime-pod ports + scope are tracked SEPARATELY from the
  // local/worker container ports (they route through a different proxy path).
  it('setRuntimePorts stores the sysbox runtime ports + scope independently', () => {
    const s = reducer(initialPortsState, setRuntimePorts({ runtimeScope: 'ws-a:u1', ports: [8080] }));
    expect(s.runtimePorts).toEqual([8080]);
    expect(s.runtimeScope).toBe('ws-a:u1');
    expect(s.containerPorts).toEqual([]); // untouched
  });

  it('setRuntimePorts tolerates missing / non-array payloads', () => {
    expect(reducer(initialPortsState, setRuntimePorts({})).runtimePorts).toEqual([]);
    expect(reducer(initialPortsState, setRuntimePorts({ ports: 'nope', runtimeScope: 'x' })).runtimePorts).toEqual([]);
  });

  it('clearRuntimePorts resets the runtime ports + scope', () => {
    const seeded = reducer(initialPortsState, setRuntimePorts({ runtimeScope: 'ws-a:u1', ports: [8080] }));
    const s = reducer(seeded, clearRuntimePorts());
    expect(s.runtimePorts).toEqual([]);
    expect(s.runtimeScope).toBeNull();
  });
});
