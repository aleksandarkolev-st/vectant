import { describe, expect, it } from 'vitest';
import {
  REPOSITORY_SKILL_METADATA,
  createSkillMetadataRegistry,
  repositorySkillRegistry,
} from '../skill-metadata-registry.js';
import { loadSelectedSkillInstructions } from '../selective-skill-loader.js';

describe('skill metadata registry', () => {
  it('returns deterministic metadata without skill instruction content', () => {
    const first = repositorySkillRegistry.search('synthi frontend');
    const second = repositorySkillRegistry.search('synthi frontend');

    expect(first).toEqual(second);
    expect(first.map((skill) => skill.id)).toContain('synthi-frontend');
    expect(first).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'synthi-frontend',
        path: '.claude/skills/synthi-frontend/SKILL.md',
      }),
    ]));
    expect(JSON.stringify(first)).not.toContain('# Synthi Frontend');
    expect(Object.keys(first[0])).not.toContain('content');
    expect(REPOSITORY_SKILL_METADATA.map((skill) => skill.id)).toEqual(expect.arrayContaining([
      'synthi-frontend',
      'synthi-backend',
      'synthi-ai-backend',
    ]));
  });

  it('accepts dynamic metadata while discarding any attempted instruction body', () => {
    const registry = createSkillMetadataRegistry({
      includeRepositorySkills: false,
      entries: {
        id: 'postgres-debugging',
        name: 'Postgres Debugging',
        description: 'Diagnose PostgreSQL failures.',
        categories: ['debugging', 'data'],
        keywords: ['postgres', 'database'],
        path: '.claude/skills/postgres-debugging/SKILL.md',
        toolGroups: ['database', 'shell'],
        content: 'this must never be kept in registry metadata',
      },
    });

    expect(registry.lookup('postgres-debugging')).toEqual({
      id: 'postgres-debugging',
      name: 'Postgres Debugging',
      description: 'Diagnose PostgreSQL failures.',
      categories: ['data', 'debugging'],
      keywords: ['database', 'postgres'],
      path: '.claude/skills/postgres-debugging/SKILL.md',
      toolGroups: ['database', 'shell'],
    });
  });

  it('loads only explicitly selected skill instructions and enforces body bounds', async () => {
    const readPaths = [];
    const result = await loadSelectedSkillInstructions(
      ['synthi-frontend'],
      {
        repositoryRoot: '/repository',
        maxCharsPerSkill: 10,
        readText: async (filePath) => {
          readPaths.push(filePath);
          return '# Synthi Frontend instructions';
        },
      },
    );

    expect(readPaths).toHaveLength(1);
    expect(readPaths[0].replaceAll('\\', '/')).toMatch(/\/repository\/\.claude\/skills\/synthi-frontend\/SKILL\.md$/);
    expect(result).toEqual({
      instructions: [{
        id: 'synthi-frontend',
        name: 'Synthi Frontend',
        path: '.claude/skills/synthi-frontend/SKILL.md',
        content: '# Synthi F',
        truncated: true,
      }],
      unknownSkillIds: [],
      unavailableSkillIds: [],
      omittedSkillIds: [],
    });
  });

  it('reports unknown selected skills without reading any unrelated instruction body', async () => {
    const readText = vi.fn(async () => 'should not be read');
    const result = await loadSelectedSkillInstructions(['missing-skill'], { readText });

    expect(result.instructions).toEqual([]);
    expect(result.unknownSkillIds).toEqual(['missing-skill']);
    expect(result.unavailableSkillIds).toEqual([]);
    expect(readText).not.toHaveBeenCalled();
  });
});
