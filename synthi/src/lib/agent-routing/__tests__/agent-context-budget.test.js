import { describe, expect, it } from 'vitest';
import {
    DEFAULT_AGENT_CONTEXT_CHAR_BUDGET,
    limitAgentContext,
} from '../agent-context-budget.js';

describe('limitAgentContext', () => {
    it('leaves context within the execution budget unchanged', () => {
        expect(limitAgentContext('small context')).toBe('small context');
    });

    it('keeps the newest context and remains within the requested budget', () => {
        const value = `old-${'x'.repeat(200)}-latest`;
        const result = limitAgentContext(value, 160);

        expect(result.length).toBe(160);
        expect(result).toContain('latest');
        expect(result).toContain('x');
    });

    it('uses the default budget for an invalid override', () => {
        const value = 'x'.repeat(DEFAULT_AGENT_CONTEXT_CHAR_BUDGET + 1);
        expect(limitAgentContext(value, Number.NaN)).toHaveLength(DEFAULT_AGENT_CONTEXT_CHAR_BUDGET);
    });
});
