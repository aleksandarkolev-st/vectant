import { describe, expect, it } from 'vitest';
import {
    routeChatAgentTask,
    selectExplicitExternalToolNames,
} from '../chat-tool-routing.js';

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
});
