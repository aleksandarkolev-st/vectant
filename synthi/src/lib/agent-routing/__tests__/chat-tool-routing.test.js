import { describe, expect, it } from 'vitest';
import {
    routeChatAgentTask,
    selectExplicitExternalToolNames,
} from '../chat-tool-routing.js';
import { createSkillMetadataRegistry } from '../skill-metadata-registry.js';
import { formatSelectedSkillExecutionContext } from '../skill-execution-context.js';

describe('routeChatAgentTask', () => {
    it('selects the minimum workspace-write surface for an atomic implementation task', () => {
        const routed = routeChatAgentTask({ taskDescription: 'Create a new component.' });

        expect(routed.role).toBe('implementation');
        expect(routed.selectedToolIds).toEqual(['create_file', 'create_directory']);
        expect(routed.validation).toBe('independent');
        expect(routed.selectedToolIds).not.toContain('run_command');
    });

    it('routes a validation command without exposing workspace write tools', () => {
        const routed = routeChatAgentTask({ taskDescription: 'Run the test suite and report failures.' });

        expect(routed.role).toBe('debugging');
        expect(routed.selectedToolIds).toEqual(['run_command']);
        expect(routed.selectedToolIds).not.toContain('create_file');
    });

    it('adds bounded workspace-read context before modifying an existing file', () => {
        const routed = routeChatAgentTask({ taskDescription: 'Fix the existing authentication module.' });

        expect(routed.selectedToolIds).toEqual([
            'read_file',
            'list_directory',
            'create_file',
            'create_directory',
        ]);
    });

    it('selects external tools only when their metadata is explicitly relevant', () => {
        const selected = selectExplicitExternalToolNames(
            'Use github to create a pull request.',
            [
                { name: 'ext_0', description: '[github] Create a pull request' },
                { name: 'ext_1', description: '[linear] Create an issue' },
            ],
        );

        expect(selected).toEqual(['ext_0']);
    });

    it('returns repository skill metadata without loading skill bodies during routing', () => {
        const registry = createSkillMetadataRegistry({
            includeRepositorySkills: false,
            entries: {
                id: 'postgres-debugging',
                name: 'Postgres Debugging',
                description: 'Diagnose PostgreSQL failures.',
                categories: ['debugging'],
                keywords: ['postgres', 'database'],
                path: '.claude/skills/postgres-debugging/SKILL.md',
                toolGroups: ['database'],
                content: 'This must not be retained in metadata.',
            },
        });

        const routed = routeChatAgentTask({
            taskDescription: 'Fix the postgres connection failure.',
            registry,
        });

        expect(routed.selectedSkillIds).toEqual(['postgres-debugging']);
        expect(routed.selectedSkills).toEqual([expect.objectContaining({
            id: 'postgres-debugging',
            path: '.claude/skills/postgres-debugging/SKILL.md',
        })]);
        expect(JSON.stringify(routed)).not.toContain('This must not be retained');
    });

    it('formats only selected post-route skill bodies for execution', () => {
        const context = formatSelectedSkillExecutionContext({
            instructions: [
                { id: 'postgres-debugging', name: 'Postgres Debugging', content: 'Inspect database logs first.' },
                { id: 'unused', name: 'Unused', content: '' },
            ],
        });

        expect(context).toContain('[Skill: Postgres Debugging]');
        expect(context).toContain('Inspect database logs first.');
        expect(context).not.toContain('Unused');
    });
});
