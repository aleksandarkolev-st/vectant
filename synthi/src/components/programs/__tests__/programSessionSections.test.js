import { describe, expect, it } from 'vitest';
import {
  buildProgramSessionSections,
  canRestartProgramSession,
  formatProgramSessionAge,
  formatProgramSessionPorts,
  isActiveProgramSession,
} from '../programSessionSections';

describe('buildProgramSessionSections', () => {
  it('keeps running states in the running section and sorts newest first', () => {
    const sections = buildProgramSessionSections([
      { id: 'stopped', state: 'stopped', updatedAt: '2026-06-01T10:00:00.000Z' },
      { id: 'starting', state: 'starting', updatedAt: '2026-06-01T13:00:00.000Z' },
      { id: 'running', state: 'running', updatedAt: '2026-06-01T12:00:00.000Z' },
      { id: 'crashed', state: 'crashed', updatedAt: '2026-06-01T11:00:00.000Z' },
    ]);

    expect(sections.running.map((session) => session.id)).toEqual(['starting', 'running']);
    expect(sections.recent.map((session) => session.id)).toEqual(['crashed', 'stopped']);
  });

  it('caps recent sessions to the requested limit', () => {
    const sections = buildProgramSessionSections([
      { id: '1', state: 'stopped', updatedAt: '2026-06-01T10:00:00.000Z' },
      { id: '2', state: 'stopped', updatedAt: '2026-06-01T11:00:00.000Z' },
      { id: '3', state: 'stopped', updatedAt: '2026-06-01T12:00:00.000Z' },
    ], { recentLimit: 2 });

    expect(sections.recent.map((session) => session.id)).toEqual(['3', '2']);
  });
});

describe('program session helpers', () => {
  it('recognizes active and restartable states', () => {
    expect(isActiveProgramSession({ state: 'running' })).toBe(true);
    expect(isActiveProgramSession({ state: 'starting' })).toBe(true);
    expect(isActiveProgramSession({ state: 'stopped' })).toBe(false);
    expect(canRestartProgramSession({ state: 'crashed' })).toBe(true);
    expect(canRestartProgramSession({ state: 'running' })).toBe(false);
  });

  it('formats ages and ports defensively', () => {
    expect(formatProgramSessionAge({ updatedAt: '2026-06-01T12:00:00.000Z' }, Date.parse('2026-06-01T12:30:00.000Z'))).toBe('30m ago');
    expect(formatProgramSessionAge({ updatedAt: null })).toBeNull();
    expect(formatProgramSessionPorts({ activePorts: [3000, 5173] })).toBe('3000, 5173');
    expect(formatProgramSessionPorts({ activePorts: [] })).toBeNull();
  });
});