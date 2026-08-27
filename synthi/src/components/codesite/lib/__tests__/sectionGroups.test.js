import { describe, expect, it } from 'vitest';
import { SECTION_GROUPS, groupForSection, groupSummary } from '../sectionGroups';

const ALL_SECTIONS = [
  'overview', 'radar', 'tower', 'channels', 'expertise', 'governance', 'runway',
  'quarantine', 'evidence', 'inspections', 'replay', 'simulator',
];

describe('section groups', () => {
  it('covers every section exactly once', () => {
    const covered = SECTION_GROUPS.flatMap((group) => group.sections);
    expect(covered.slice().sort()).toEqual(ALL_SECTIONS.slice().sort());
    expect(new Set(covered).size).toBe(ALL_SECTIONS.length);
  });

  it('maps every section to an existing group', () => {
    for (const section of ALL_SECTIONS) {
      const key = groupForSection(section);
      expect(SECTION_GROUPS.some((group) => group.key === key)).toBe(true);
    }
  });

  it('flags decisions as needing review when actions are pending', () => {
    const summary = groupSummary('decisions', { requiredActions: 3 }, { actionableQuarantines: 1 });
    expect(summary).toMatchObject({ detail: 'Needs review', count: 4, tone: 'high' });
  });

  it('reports decisions clear when nothing is pending', () => {
    expect(groupSummary('decisions', { requiredActions: 0 }, {})).toMatchObject({
      detail: 'Clear',
      count: 0,
    });
  });
});
