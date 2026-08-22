import { describe, expect, it } from 'vitest';
import {
  appendTerminalAgentBindingParams,
  assertGatewayAgentBinding,
  createTerminalAgentLaunch,
  normalizeAgentLaunchCommand,
  normalizeTerminalAgentBinding,
  requestTerminalGatewayToken,
  terminalAgentBindingMatches,
} from '../terminalAgentBinding';

describe('terminal agent binding', () => {
  it.each(['gemini-cli', 'aider', 'my_agent.v2', 'custom.runtime-7'])(
    'accepts an arbitrary validated provider identifier: %s',
    (provider) => {
      expect(normalizeTerminalAgentBinding({
        projectId: 'project:shared-1',
        provider,
        providerSessionRef: `session-${provider}`,
      })).toMatchObject({ provider });
    },
  );

  it('normalizes provider case and preserves a restored session reference exactly', () => {
    const restored = normalizeTerminalAgentBinding({
      projectId: 'project-1',
      provider: 'MY_AGENT.V2',
      providerSessionRef: 'stable-session-reference',
    });
    expect(restored).toEqual({
      projectId: 'project-1',
      provider: 'my_agent.v2',
      providerSessionRef: 'stable-session-reference',
    });
  });

  it.each([
    {},
    { projectId: 'project-1' },
    { projectId: 'project-1', provider: 'aider' },
    { projectId: '../escape', provider: 'aider', providerSessionRef: 'session-1' },
    { projectId: 'project-1', provider: 'not a provider', providerSessionRef: 'session-1' },
    { projectId: 'project-1', provider: 'aider', providerSessionRef: 'contains space' },
  ])('rejects partial or malformed binding %#', (value) => {
    expect(() => normalizeTerminalAgentBinding(value)).toThrow('invalid_terminal_agent_binding');
  });

  it('appends the exact same canonical fields to independently built URL params', () => {
    const binding = {
      projectId: 'project-1',
      provider: 'Gemini-CLI',
      providerSessionRef: 'session-1',
    };
    const tokenParams = appendTerminalAgentBindingParams(new URLSearchParams(), binding);
    const socketParams = appendTerminalAgentBindingParams(new URLSearchParams(), binding);
    expect(tokenParams.toString()).toBe(socketParams.toString());
    expect(Object.fromEntries(tokenParams)).toEqual({
      codeSiteProjectId: 'project-1',
      agentProvider: 'gemini-cli',
      providerSessionRef: 'session-1',
    });
  });

  it('creates distinct secure references without provider-specific behavior', () => {
    let sequence = 0;
    const first = createTerminalAgentLaunch({
      projectId: 'project-1',
      provider: 'aider',
      command: 'aider --model local',
      createProviderSessionRef: () => `session-${++sequence}`,
    });
    const second = createTerminalAgentLaunch({
      projectId: 'project-1',
      provider: 'aider',
      command: 'aider --model local',
      createProviderSessionRef: () => `session-${++sequence}`,
    });
    expect(first.binding.providerSessionRef).not.toBe(second.binding.providerSessionRef);
    expect(first.command).toBe('aider --model local');
  });

  it('rejects multiline commands and compares all binding fields exactly', () => {
    expect(() => normalizeAgentLaunchCommand('agent\nsecond-command')).toThrow(
      'invalid_terminal_agent_launch_command',
    );
    expect(terminalAgentBindingMatches(
      { projectId: 'project-1', provider: 'aider', providerSessionRef: 'session-1' },
      { projectId: 'project-1', provider: 'aider', providerSessionRef: 'session-1' },
    )).toBe(true);
    expect(terminalAgentBindingMatches(
      { projectId: 'project-1', provider: 'aider', providerSessionRef: 'session-1' },
      { projectId: 'project-1', provider: 'aider', providerSessionRef: 'session-2' },
    )).toBe(false);
  });

  it('fails closed when the token projection omits or changes any requested binding field', () => {
    const requested = { projectId: 'project-1', provider: 'aider', providerSessionRef: 'session-1' };
    expect(assertGatewayAgentBinding(requested, { ...requested })).toEqual(requested);
    expect(() => assertGatewayAgentBinding(requested, null)).toThrow(
      'terminal_gateway_agent_binding_mismatch',
    );
    for (const returned of [
      { ...requested, projectId: 'project-2' },
      { ...requested, provider: 'gemini-cli' },
      { ...requested, providerSessionRef: 'session-2' },
    ]) {
      expect(() => assertGatewayAgentBinding(requested, returned)).toThrow(
        'terminal_gateway_agent_binding_mismatch',
      );
    }
    expect(() => assertGatewayAgentBinding(null, requested)).toThrow(
      'terminal_gateway_agent_binding_mismatch',
    );
  });

  it('requests a signed token with the exact binding and rejects a mismatched projection', async () => {
    const requested = { projectId: 'project-1', provider: 'acme_agent.v2', providerSessionRef: 'session-1' };
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ token: 'signed-token', agentBinding: requested }),
      };
    };
    const gateway = await requestTerminalGatewayToken('shared-workspace', {
      collabSessionId: 'collab-1',
      agentBinding: requested,
      fetchImpl,
    });
    const url = new URL(calls[0].url, 'http://local.test');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      workspaceSlug: 'shared-workspace',
      collabSessionId: 'collab-1',
      codeSiteProjectId: 'project-1',
      agentProvider: 'acme_agent.v2',
      providerSessionRef: 'session-1',
    });
    expect(calls[0].options).toMatchObject({ method: 'GET', credentials: 'same-origin' });
    expect(gateway.token).toBe('signed-token');

    await expect(requestTerminalGatewayToken('shared-workspace', {
      collabSessionId: 'collab-1',
      agentBinding: requested,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ token: 'signed-token', agentBinding: { ...requested, provider: 'other' } }),
      }),
    })).rejects.toThrow('terminal_gateway_agent_binding_mismatch');
  });
});
