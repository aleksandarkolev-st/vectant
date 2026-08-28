import { describe, expect, it } from 'vitest';
import { createSkillMetadataRegistry } from '../skill-metadata-registry.js';
import { routePipelineAgentTask } from '../agent-pipeline-routing.js';

const registry = createSkillMetadataRegistry({
  includeRepositorySkills: false,
  entries: [{
    id: 'synthi-frontend',
    name: 'Synthi Frontend',
    description: 'Synthi Next.js chat and API route workflow.',
    categories: ['integration', 'debugging', 'frontend'],
    keywords: ['synthi', 'frontend', 'chat', 'api'],
    path: '.claude/skills/synthi-frontend/SKILL.md',
    toolGroups: ['filesystem', 'service-runtime'],
    instructions: 'This must never be retained by routing metadata.',
  }],
});

describe('routePipelineAgentTask', () => {
  it('uses the atomic core while translating legacy chat agents to reusable roles', () => {
    const routed = routePipelineAgentTask({
      id: 'step-1',
      agentType: 'analyzer',
      instruction: 'Diagnose the Synthi chat API failure.',
      registry,
    });

    expect(routed.atomicTask).toEqual({
      id: 'step-1',
      description: 'Diagnose the Synthi chat API failure.',
      category: 'debugging',
    });
    expect(routed.routerRole).toBe('debugging');
    expect(routed.selectedSkills).toEqual([
      expect.objectContaining({ id: 'synthi-frontend' }),
    ]);
    expect(routed.selectedSkills[0]).not.toHaveProperty('instructions');
    expect(routed.selectedToolIds).toEqual(['get_diagnostics']);
    expect(routed.trace).toMatchObject({
      routerRole: 'debugging',
      skills: ['synthi-frontend'],
      tools: ['get_diagnostics'],
      validator: 'none',
    });
    expect(routed.trace.events).toEqual([
      expect.objectContaining({ event: 'routed' }),
    ]);
  });

  it('keeps no-match fallbacks narrow and capability-free', () => {
    const emptyRegistry = createSkillMetadataRegistry({ includeRepositorySkills: false });
    const routed = routePipelineAgentTask({
      id: 'step-2',
      agentType: 'reader',
      instruction: 'Inspect a proprietary artifact.',
      registry: emptyRegistry,
    });

    expect(routed.routerRole).toBe('research');
    expect(routed.selectedSkills).toEqual([]);
    expect(routed.selectedToolIds).toEqual([]);
  });
});
