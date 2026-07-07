import { describe, expect, it } from 'vitest';
import { createProgramsMcpServer } from '../server.js';
import { PROGRAMS_TOOLS } from '../tools.js';

// Smoke test: imports the real MCP SDK (hoisted) and asserts the glue builds.
describe('createProgramsMcpServer', () => {
  it('builds a server instance without throwing', () => {
    expect(createProgramsMcpServer()).toBeTruthy();
  });

  it('binds the three tools', () => {
    expect(PROGRAMS_TOOLS.map((t) => t.name).sort()).toEqual([
      'describe_manifest_schema',
      'generate_manifest',
      'validate_manifest',
    ]);
  });
});
