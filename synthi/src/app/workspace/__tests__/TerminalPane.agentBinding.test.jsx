/* @vitest-environment jsdom */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sockets: [],
  fetchCalls: [],
  gatewayBinding: null,
  terminals: [],
}));

class FakeTerminal {
  constructor() {
    this.cols = 100;
    this.rows = 30;
    this.options = {};
    this.writes = [];
    h.terminals.push(this);
  }
  loadAddon() {}
  open() {}
  onData(handler) { this.dataHandler = handler; return { dispose: vi.fn() }; }
  onBinary(handler) { this.binaryHandler = handler; return { dispose: vi.fn() }; }
  onSelectionChange(handler) { this.selectionHandler = handler; return { dispose: vi.fn() }; }
  write(value) { this.writes.push(value); }
  getSelection() { return ''; }
  clearSelection() {}
  paste() {}
  refresh() {}
  focus() {}
  scrollToTop() {}
  dispose() {}
}

class FakeFitAddon {
  fit() {}
  dispose() {}
}

class FakeWebLinksAddon {
  dispose() {}
}

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.OPEN;
    this.sent = [];
    h.sockets.push(this);
  }
  send(value) { this.sent.push(value); }
  close() { this.readyState = FakeWebSocket.CLOSED; }
  emitMessage(payload) { this.onmessage?.({ data: JSON.stringify(payload) }); }
}

vi.mock('xterm', () => ({ Terminal: FakeTerminal }));
vi.mock('xterm-addon-fit', () => ({ FitAddon: FakeFitAddon }));
vi.mock('xterm-addon-web-links', () => ({ WebLinksAddon: FakeWebLinksAddon }));
vi.mock('xterm-addon-webgl', () => ({ WebglAddon: class FakeWebglAddon {} }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: { user: { id: 'owner-1' } } }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@/components/ThemeProvider', () => ({ useTheme: () => ({ terminalTheme: {} }) }));
vi.mock('@/hooks/useCollabSession', () => ({
  useSessionPermissions: () => ({ canTerminal: true, role: 'hosting' }),
}));
vi.mock('@/lib/collab-url', () => ({
  resolveCollabHttpUrl: () => 'http://collab.test',
  resolveCollabWsUrl: () => 'ws://collab.test',
}));
vi.mock('@/services/runtimeScope', () => ({
  getWorkspaceRuntimeIdentity: () => ({
    runtimeScope: 'ws-team-collab-1',
    runtimeKind: 'collaboration',
    filesystemUserId: 'shared-owner',
    collabSessionId: 'collab-1',
  }),
}));
vi.mock('@/components/docking-wm/components/ContextMenu', () => ({
  ContextMenu: () => null,
  useContextMenu: () => ({ menuState: null, openMenu: vi.fn(), closeMenu: vi.fn() }),
}));
vi.mock('@/lib/terminal-preview-links', () => ({
  isRuntimeLoopbackUrl: () => false,
  buildLoopbackCallbackBridgeUrl: () => null,
  findTerminalLoopbackAuthLinks: () => [],
  parseTerminalUrl: () => null,
  resolveTerminalLinkUrl: async () => null,
  terminalLinkHasNestedLoopbackCallback: () => false,
  terminalLinkNeedsRuntimeResolution: () => false,
}));
vi.mock('@/lib/terminal-color-overrides', () => ({
  TERMINAL_COLOR_KEYS: [],
  getTerminalOverrides: () => ({}),
  setTerminalOverrides: vi.fn(),
  subscribeTerminalOverrides: () => vi.fn(),
  applyOverridesToTheme: (theme) => theme,
}));

import TerminalPane from '../TerminalPane';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root;
let container;

async function flushUntil(predicate, attempts = 20) {
  for (let index = 0; index < attempts; index += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (predicate()) return;
  }
  throw new Error('condition_not_reached');
}

async function renderPane(props = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<TerminalPane
      terminalId={`terminal-${Math.random()}`}
      workspaceSlug="team"
      workspaceName="Shared Team"
      {...props}
    />);
  });
}

function decodedBinarySends(socket) {
  return socket.sent
    .filter((value) => ArrayBuffer.isView(value))
    .map((value) => new TextDecoder().decode(value));
}

describe('TerminalPane agent binding integration', () => {
  beforeEach(() => {
    h.sockets.length = 0;
    h.fetchCalls.length = 0;
    h.terminals.length = 0;
    h.gatewayBinding = null;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('ResizeObserver', class ResizeObserver {
      observe() {}
      disconnect() {}
    });
    vi.stubGlobal('requestAnimationFrame', (callback) => setTimeout(callback, 0));
    vi.stubGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      h.fetchCalls.push({ url, options });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          token: 'signed-token',
          runtimeScope: 'ws-team-collab-1',
          filesystemUserId: 'shared-owner',
          ...(h.gatewayBinding ? { agentBinding: h.gatewayBinding } : {}),
        }),
      };
    }));
  });

  afterEach(async () => {
    if (root) await act(async () => { root.unmount(); });
    root = null;
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
  });

  it('uses the exact binding for token and socket, then starts once on fresh readiness', async () => {
    const binding = {
      projectId: 'project-1',
      provider: 'acme_agent.v2',
      providerSessionRef: 'provider-session-1',
    };
    h.gatewayBinding = binding;
    await renderPane({ agentBinding: binding, agentLaunchCommand: 'agent-host --profile local' });
    await flushUntil(() => h.sockets.length === 1);

    const tokenUrl = new URL(h.fetchCalls[0].url, 'http://local.test');
    const socketUrl = new URL(h.sockets[0].url);
    for (const params of [tokenUrl.searchParams, socketUrl.searchParams]) {
      expect(params.get('codeSiteProjectId')).toBe('project-1');
      expect(params.get('agentProvider')).toBe('acme_agent.v2');
      expect(params.get('providerSessionRef')).toBe('provider-session-1');
    }
    expect(decodedBinarySends(h.sockets[0])).toEqual([]);

    await act(async () => {
      h.sockets[0].emitMessage({
        type: 'ready',
        sessionId: 'terminal-server-1',
        shell: 'bash',
        pid: 123,
        reattached: false,
      });
      h.sockets[0].emitMessage({
        type: 'ready',
        sessionId: 'terminal-server-1',
        shell: 'bash',
        pid: 123,
        reattached: false,
      });
      h.sockets[0].emitMessage({
        type: 'ready',
        sessionId: 'terminal-server-2',
        shell: 'bash',
        pid: 124,
        reattached: true,
      });
    });
    expect(decodedBinarySends(h.sockets[0])).toEqual(['agent-host --profile local\r']);
  });

  it.each([
    null,
    { projectId: 'project-2', provider: 'acme_agent.v2', providerSessionRef: 'provider-session-1' },
    { projectId: 'project-1', provider: 'other', providerSessionRef: 'provider-session-1' },
    { projectId: 'project-1', provider: 'acme_agent.v2', providerSessionRef: 'provider-session-2' },
  ])('constructs no socket when the signed gateway projection does not match: %#', async (returned) => {
    const binding = {
      projectId: 'project-1',
      provider: 'acme_agent.v2',
      providerSessionRef: 'provider-session-1',
    };
    h.gatewayBinding = returned;
    await renderPane({ agentBinding: binding, agentLaunchCommand: 'agent-host' });
    await flushUntil(() => h.fetchCalls.length === 1);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(h.sockets).toHaveLength(0);
  });

  it('keeps an ordinary terminal completely unbound', async () => {
    await renderPane();
    await flushUntil(() => h.sockets.length === 1);
    const tokenUrl = new URL(h.fetchCalls[0].url, 'http://local.test');
    const socketUrl = new URL(h.sockets[0].url);
    for (const params of [tokenUrl.searchParams, socketUrl.searchParams]) {
      expect(params.has('codeSiteProjectId')).toBe(false);
      expect(params.has('agentProvider')).toBe(false);
      expect(params.has('providerSessionRef')).toBe(false);
    }
  });
});
