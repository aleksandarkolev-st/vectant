import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  callAgentWorkflowTool,
  getAgentWorkflowState,
  openAgentWorkflowExternalUrl,
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

  it('uses current-host bridge defaults and localStorage overrides', () => {
    expect(resolveAgentWorkflowBridgeUrl()).toBe('http://localhost:9466');
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

  it('opens external urls through the runtime browser bridge', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        opened: { tab_id: 'external-auth-tab', navigation_started: true },
      }),
    });

    const authUrl = 'https://auth.example.test/oauth?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fcallback';
    const body = await openAgentWorkflowExternalUrl({
      url: 'http://bridge.test',
      token: 'secret',
      targetUrl: authUrl,
      runtime: {
        runtimeScope: 'ws-demo-user-demo',
        workspaceSlug: 'demo',
        runtimeKind: 'private',
        filesystemUserId: 'user-a',
        actorUserId: 'user-a',
      },
    });

    expect(body.opened.tab_id).toBe('external-auth-tab');
    expect(fetch).toHaveBeenCalledWith(
      'http://bridge.test/browser-workflows/open-external',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Synthi-Workflow-Token': 'secret',
          'X-Synthi-Runtime-Scope': 'ws-demo-user-demo',
          'X-Synthi-Workspace-Slug': 'demo',
          'X-Synthi-Runtime-Kind': 'private',
          'X-Synthi-Filesystem-User-Id': 'user-a',
          'X-Synthi-Actor-User-Id': 'user-a',
        },
        body: JSON.stringify({ url: authUrl }),
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
