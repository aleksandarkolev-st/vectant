import { describe, expect, it } from 'vitest';
import { validateIndependentAgentResult } from '../independent-agent-validator.js';

describe('validateIndependentAgentResult', () => {
  it('accepts a completed result whose tool calls stay inside the routed selection', async () => {
    await expect(validateIndependentAgentResult({
      routing: { tools: ['read_file'] },
      result: {
        output: 'Read the requested file.',
        toolCalls: [{ tool: 'read_file', success: true }],
      },
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      status: 'validated',
      toolCallCount: 1,
      rejectedToolIds: [],
    }));
  });

  it('rejects tool calls that were not in the authoritative route', async () => {
    await expect(validateIndependentAgentResult({
      routing: { tools: ['read_file'] },
      result: {
        output: 'Attempted a write.',
        toolCalls: [{ tool: 'write_code', success: true }],
      },
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: 'rejected',
      rejectedToolIds: ['write_code'],
    }));
  });
});
