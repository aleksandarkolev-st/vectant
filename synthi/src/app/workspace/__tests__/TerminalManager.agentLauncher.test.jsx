/* @vitest-environment jsdom */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  paneProps: new Map(),
  fetchCodeSiteProjects: vi.fn(),
  dispatch: vi.fn(),
  collaboration: {
    role: 'hosting',
    session: { id: 'collab-1' },
    permissions: { canTerminal: true },
  },
  openMenu: vi.fn(),
  closeMenu: vi.fn(),
}));

vi.mock('next/dynamic', () => ({
  default: () => function MockTerminalPane(props) {
    h.paneProps.set(`${props.terminalId}:${props.paneSide}`, props);
    return null;
  },
}));

vi.mock('react-redux', () => ({ useDispatch: () => h.dispatch }));
vi.mock('@/redux/workspaceSlice', () => ({ fetchFilesThunk: vi.fn((slug) => ({ type: 'files', slug })) }));
vi.mock('@/hooks/useCollabSession', () => ({ useCollabSession: () => h.collaboration }));
vi.mock('@/components/codesite/codesiteClient', () => ({
  fetchCodeSiteProjects: (...args) => h.fetchCodeSiteProjects(...args),
}));
vi.mock('../ShellSelector', () => ({
  default: () => null,
  getShellMeta: (shell) => ({ label: shell || 'Terminal', color: '#888', icon: '>' }),
}));
vi.mock('@/components/docking-wm/components/ContextMenu', () => ({
  ContextMenu: () => null,
  useContextMenu: () => ({ menuState: null, openMenu: h.openMenu, closeMenu: h.closeMenu }),
}));

import TerminalManager from '../TerminalManager';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container;
let root;
let uuidSequence;

async function flush(times = 5) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

function setNativeValue(element, value) {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
  descriptor?.set?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<TerminalManager visible workspaceSlug="team" workspaceName="Shared Team" />);
  });
  await flush();
}

async function unmount() {
  if (root) {
    await act(async () => { root.unmount(); });
    root = null;
  }
  container?.remove();
  container = null;
}

async function launchAgent({
  provider = 'acme_agent.v2',
  command = 'agent-host --profile local',
  projectId = null,
} = {}) {
  if (!container.querySelector('[data-testid="terminal-agent-launcher"]')) {
    await act(async () => {
      container.querySelector('[data-testid="terminal-agent-launcher-toggle"]').click();
    });
  }
  if (projectId) {
    setNativeValue(container.querySelector('[data-testid="terminal-agent-project"]'), projectId);
  }
  setNativeValue(container.querySelector('[data-testid="terminal-agent-provider"]'), provider);
  setNativeValue(container.querySelector('[data-testid="terminal-agent-command"]'), command);
  await act(async () => {
    container.querySelector('[data-testid="terminal-agent-launch"]').click();
  });
  await flush();
}

describe('TerminalManager generic agent launcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    h.paneProps.clear();
    h.collaboration.role = 'hosting';
    h.collaboration.session = { id: 'collab-1' };
    h.collaboration.permissions = { canTerminal: true };
    h.fetchCodeSiteProjects.mockResolvedValue([
      { id: 'project-1', title: 'Shared Project' },
      { id: 'project-2', title: 'Review Project' },
    ]);
    uuidSequence = 0;
    vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => `provider-session-${++uuidSequence}`);
  });

  afterEach(async () => {
    await unmount();
    vi.restoreAllMocks();
  });

  it('launches arbitrary providers with an explicit command and distinct session references', async () => {
    await mount();
    await launchAgent();

    const first = h.paneProps.get('agent-provider-session-1:main');
    expect(first.agentBinding).toEqual({
      projectId: 'project-1',
      provider: 'acme_agent.v2',
      providerSessionRef: 'provider-session-1',
    });
    expect(first.agentLaunchCommand).toBe('agent-host --profile local');

    await launchAgent({ provider: 'aider', command: 'run-local-agent --mode review' });
    const second = h.paneProps.get('agent-provider-session-2:main');
    expect(second.agentBinding.provider).toBe('aider');
    expect(second.agentBinding.providerSessionRef).not.toBe(first.agentBinding.providerSessionRef);
    expect(second.agentLaunchCommand).toBe('run-local-agent --mode review');
  });

  it('persists and restores the exact immutable binding and selected authorized project', async () => {
    await mount();
    await launchAgent({
      provider: 'custom.runtime-7',
      command: 'custom-runtime connect',
      projectId: 'project-2',
    });

    const stored = JSON.parse(localStorage.getItem('synthi-terminal-manager:team'));
    const storedAgent = stored.terminals.find((terminal) => terminal.agentBinding);
    expect(stored.selectedCodeSiteProjectId).toBe('project-2');
    expect(storedAgent.agentBinding.providerSessionRef).toBe('provider-session-1');

    await unmount();
    h.paneProps.clear();
    await mount();
    const restored = h.paneProps.get('agent-provider-session-1:main');
    expect(restored.agentBinding).toEqual(storedAgent.agentBinding);
    expect(restored.agentLaunchCommand).toBe('custom-runtime connect');
    expect(uuidSequence).toBe(1);
  });

  it('falls back from a revoked stored project and discards partial stored bindings', async () => {
    localStorage.setItem('synthi-terminal-manager:team', JSON.stringify({
      activeId: 'stored-terminal',
      selectedCodeSiteProjectId: 'revoked-project',
      terminals: [{
        id: 'stored-terminal',
        label: 'Stored',
        split: true,
        agentBinding: { projectId: 'project-1', provider: 'aider' },
        agentLaunchCommand: 'aider',
      }],
    }));
    await mount();

    await act(async () => {
      container.querySelector('[data-testid="terminal-agent-launcher-toggle"]').click();
    });
    const projectSelect = container.querySelector('[data-testid="terminal-agent-project"]');
    expect(projectSelect.value).toBe('project-1');
    expect(h.paneProps.get('stored-terminal:main').agentBinding).toBeNull();
    expect(h.paneProps.get('stored-terminal:main').agentLaunchCommand).toBeNull();
    expect(h.paneProps.has('stored-terminal:split')).toBe(true);
  });

  it('keeps ordinary, AI, and managed program terminals unbound', async () => {
    await mount();
    expect(h.paneProps.get('term-1:main').agentBinding).toBeNull();

    await act(async () => {
      window.dispatchEvent(new CustomEvent('ai-terminal-open', {
        detail: { sessionId: 'ai-session-1', command: 'existing chat task' },
      }));
      window.dispatchEvent(new CustomEvent('terminal-session-open', {
        detail: { sessionId: 'program-session-1', command: 'npm test', label: 'Tests' },
      }));
    });
    await flush();

    const routed = [...h.paneProps.values()].filter((props) => props.fixedSessionId);
    expect(routed).toHaveLength(2);
    for (const props of routed) {
      expect(props.agentBinding).toBeNull();
      expect(props.agentLaunchCommand).toBeNull();
    }
  });
});
