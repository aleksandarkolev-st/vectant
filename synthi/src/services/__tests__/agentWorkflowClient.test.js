import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  callAgentWorkflowTool,
  getAgentWorkflowState,
  resolveAgentWorkflowBridgeToken,
  resolveAgentWorkflowBridgeUrl,
} from '../agentWorkflowClient';

describe('agentWorkflowClient', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('uses local bridge defaults and localStorage overrides', () => {
    expect(resolveAgentWorkflowBridgeUrl()).toBe('http://127.0.0.1:9466');
    expect(resolveAgentWorkflowBridgeToken()).toBe('');

    window.localStorage.setItem('synthi.agentWorkflowBridgeUrl', 'http://127.0.0.1:9555');
    window.localStorage.setItem('synthi.agentWorkflowBridgeToken', 'token-a');

    expect(resolveAgentWorkflowBridgeUrl()).toBe('http://127.0.0.1:9555');
    expect(resolveAgentWorkflowBridgeToken()).toBe('token-a');
  });

  it('fetches workflow panel state with the workflow token header', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, state: { workflow: { stepCount: 1 } } }),
    });

    const state = await getAgentWorkflowState({
      url: 'http://bridge.test',
      token: 'secret',
    });

    expect(state.workflow.stepCount).toBe(1);
    expect(fetch).toHaveBeenCalledWith(
      'http://bridge.test/browser-workflows/state',
      expect.objectContaining({
        headers: { 'X-Synthi-Workflow-Token': 'secret' },
      }),
    );
  });

  it('posts tool calls through the workflow bridge', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        tool: 'synthi_browser_compile_workflow',
        state: { workflow: { contractStatus: 'compiled' } },
      }),
    });

    const body = await callAgentWorkflowTool({
      url: 'http://bridge.test',
      token: 'secret',
      tool: 'synthi_browser_compile_workflow',
      arguments: { workspace_id: 'workspace-a' },
    });

    expect(body.state.workflow.contractStatus).toBe('compiled');
    expect(fetch).toHaveBeenCalledWith(
      'http://bridge.test/browser-workflows/tool',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Synthi-Workflow-Token': 'secret',
        },
        body: JSON.stringify({
          tool: 'synthi_browser_compile_workflow',
          arguments: { workspace_id: 'workspace-a' },
        }),
      }),
    );
  });

  it('raises bridge error codes from non-2xx responses', async () => {
    fetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: 'unauthorized' }),
    });

    await expect(getAgentWorkflowState({ url: 'http://bridge.test' })).rejects.toThrow('unauthorized');
  });
});
