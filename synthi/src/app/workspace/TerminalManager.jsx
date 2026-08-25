'use client';

import React, { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react';
import dynamic from 'next/dynamic';
import { SplitSquareHorizontal, Plus, X, TerminalSquare, Bot } from 'lucide-react';
import { useDispatch } from 'react-redux';
import { fetchFilesThunk } from '@/redux/workspaceSlice';
import { useCollabSession } from '@/hooks/useCollabSession';
import { fetchCodeSiteProjects } from '@/components/codesite/codesiteClient';
import ShellSelector, { getShellMeta } from './ShellSelector';
import { createTerminalAgentLaunch, normalizeTerminalAgentLaunch } from './terminalAgentBinding';
import { ContextMenu, useContextMenu } from '@/components/docking-wm/components/ContextMenu';

const TerminalPane = dynamic(() => import('./TerminalPane.jsx'), { ssr: false });

/** localStorage key for remembering the user's preferred default shell */
const DEFAULT_SHELL_KEY = 'synthi-default-shell';
const TERMINAL_MANAGER_STATE_PREFIX = 'synthi-terminal-manager';

function getStoredDefaultShell() {
  try { return localStorage.getItem(DEFAULT_SHELL_KEY) || null; } catch (_) { return null; }
}
function setStoredDefaultShell(shellKey) {
  try { if (shellKey) localStorage.setItem(DEFAULT_SHELL_KEY, shellKey); else localStorage.removeItem(DEFAULT_SHELL_KEY); } catch (_) {}
}

function defaultTerminalEntry(shellType = null) {
  return {
    id: 'term-1',
    label: getShellMeta(shellType)?.label || 'Terminal',
    split: false,
    shellType,
  };
}

function terminalManagerStorageKey(workspaceSlug) {
  return `${TERMINAL_MANAGER_STATE_PREFIX}:${workspaceSlug || 'workspace'}`;
}

function normalizeStoredTerminal(entry, index, defaultShellPref) {
  if (!entry || typeof entry !== 'object') return null;
  const shellType = typeof entry.shellType === 'string' && entry.shellType ? entry.shellType : null;
  const meta = shellType ? getShellMeta(shellType) : null;
  let agentLaunch = null;
  try {
    agentLaunch = normalizeTerminalAgentLaunch({
      binding: entry.agentBinding,
      command: entry.agentLaunchCommand,
    });
  } catch (_) {
    agentLaunch = null;
  }
  return {
    id: typeof entry.id === 'string' && entry.id ? entry.id : `term-${index + 1}`,
    label: typeof entry.label === 'string' && entry.label ? entry.label : meta?.label || getShellMeta(defaultShellPref)?.label || 'Terminal',
    split: agentLaunch ? false : Boolean(entry.split),
    shellType,
    fixedSessionId: typeof entry.fixedSessionId === 'string' && entry.fixedSessionId ? entry.fixedSessionId : undefined,
    isAi: Boolean(entry.isAi),
    agentBinding: agentLaunch?.binding || undefined,
    agentLaunchCommand: agentLaunch?.command || undefined,
  };
}

function readStoredTerminalManagerState(workspaceSlug, defaultShellPref) {
  const fallback = { terminals: [defaultTerminalEntry(defaultShellPref)], activeId: 'term-1' };
  try {
    const raw = localStorage.getItem(terminalManagerStorageKey(workspaceSlug));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    const terminals = Array.isArray(parsed?.terminals)
      ? parsed.terminals
          .map((entry, index) => normalizeStoredTerminal(entry, index, defaultShellPref))
          .filter(Boolean)
      : [];
    if (!terminals.length) return fallback;
    const activeId = terminals.some((terminal) => terminal.id === parsed?.activeId)
      ? parsed.activeId
      : terminals[0].id;
    const selectedCodeSiteProjectId = typeof parsed?.selectedCodeSiteProjectId === 'string'
      ? parsed.selectedCodeSiteProjectId
      : '';
    return { terminals, activeId, selectedCodeSiteProjectId };
  } catch (_) {
    return fallback;
  }
}

function writeStoredTerminalManagerState(workspaceSlug, state) {
  try {
    localStorage.setItem(terminalManagerStorageKey(workspaceSlug), JSON.stringify({
      activeId: state.activeId,
      selectedCodeSiteProjectId: state.selectedCodeSiteProjectId || '',
      terminals: state.terminals.map((terminal) => ({
        id: terminal.id,
        label: terminal.label,
        split: Boolean(terminal.split),
        shellType: terminal.shellType || null,
        fixedSessionId: terminal.fixedSessionId || undefined,
        isAi: Boolean(terminal.isAi),
        agentBinding: terminal.agentBinding || undefined,
        agentLaunchCommand: terminal.agentLaunchCommand || undefined,
      })),
    }));
  } catch (_) {}
}

const TerminalManager = memo(function TerminalManager({ visible, onCloseAll, workspaceSlug = '', workspaceName = '' }) {
  const [defaultShellPref, setDefaultShellPref] = useState(() => getStoredDefaultShell());
  const [terminals, setTerminals] = useState(() => readStoredTerminalManagerState(workspaceSlug, getStoredDefaultShell()).terminals);
  const [activeId, setActiveId] = useState(() => readStoredTerminalManagerState(workspaceSlug, getStoredDefaultShell()).activeId);
  const [selectedCodeSiteProjectId, setSelectedCodeSiteProjectId] = useState(
    () => readStoredTerminalManagerState(workspaceSlug, getStoredDefaultShell()).selectedCodeSiteProjectId || '',
  );
  const [codeSiteProjects, setCodeSiteProjects] = useState([]);
  const [agentLauncherOpen, setAgentLauncherOpen] = useState(false);
  const [agentProvider, setAgentProvider] = useState('');
  const [agentLaunchCommand, setAgentLaunchCommand] = useState('');
  const [agentLauncherStatus, setAgentLauncherStatus] = useState('idle');
  const [agentLauncherError, setAgentLauncherError] = useState('');
  const [editingTabId, setEditingTabId] = useState(null);
  const [editingName, setEditingName] = useState('');
  const dragRef = useRef(null);
  const dispatch = useDispatch();
  const fsRefreshTimer = useRef(null);
  const codeSiteProjectsRequestId = useRef(0);
  const defaultShellPrefRef = useRef(defaultShellPref);
  const { role: collaborationRole, permissions: collaborationPermissions } = useCollabSession();
  const collaborationActive = collaborationRole === 'hosting' || collaborationRole === 'guest';
  const canLaunchAgent = collaborationActive && collaborationPermissions?.canTerminal !== false;

  useEffect(() => {
    defaultShellPrefRef.current = defaultShellPref;
  }, [defaultShellPref]);

  useEffect(() => {
    const restored = readStoredTerminalManagerState(workspaceSlug, defaultShellPrefRef.current);
    setTerminals(restored.terminals);
    setActiveId(restored.activeId);
    setSelectedCodeSiteProjectId(restored.selectedCodeSiteProjectId || '');
    setAgentLauncherOpen(false);
  }, [workspaceSlug]);

  useEffect(() => {
    writeStoredTerminalManagerState(workspaceSlug, {
      terminals,
      activeId,
      selectedCodeSiteProjectId,
    });
  }, [workspaceSlug, terminals, activeId, selectedCodeSiteProjectId]);

  const refreshCodeSiteProjects = useCallback(async () => {
    const requestId = ++codeSiteProjectsRequestId.current;
    setCodeSiteProjects([]);
    setAgentLauncherError('');
    if (!workspaceSlug) {
      setAgentLauncherStatus('idle');
      return;
    }
    setAgentLauncherStatus('loading');
    try {
      const projects = await fetchCodeSiteProjects(workspaceSlug);
      if (requestId !== codeSiteProjectsRequestId.current) return;
      const authorizedProjects = Array.isArray(projects) ? projects : [];
      setCodeSiteProjects(authorizedProjects);
      setSelectedCodeSiteProjectId((current) => (
        authorizedProjects.some((project) => project.id === current)
          ? current
          : authorizedProjects[0]?.id || ''
      ));
      setAgentLauncherStatus('ready');
    } catch (_) {
      if (requestId !== codeSiteProjectsRequestId.current) return;
      setCodeSiteProjects([]);
      setSelectedCodeSiteProjectId('');
      setAgentLauncherStatus('error');
      setAgentLauncherError('Authorized CodeSite projects could not be loaded.');
    }
  }, [workspaceSlug]);

  useEffect(() => {
    void refreshCodeSiteProjects();
  }, [refreshCodeSiteProjects]);

  useEffect(() => {
    const onCodeSiteProjectsChanged = (event) => {
      if (event?.detail?.workspaceSlug === workspaceSlug) {
        void refreshCodeSiteProjects();
      }
    };
    window.addEventListener('codesite-projects-changed', onCodeSiteProjectsChanged);
    return () => window.removeEventListener('codesite-projects-changed', onCodeSiteProjectsChanged);
  }, [refreshCodeSiteProjects, workspaceSlug]);

  // ── Debounced file tree refresh on filesystem changes ────────────────
  const handleFsChange = useCallback(() => {
    if (!workspaceSlug) return;
    // Debounce: wait 300ms after last fs-change before dispatching
    if (fsRefreshTimer.current) clearTimeout(fsRefreshTimer.current);
    fsRefreshTimer.current = setTimeout(() => {
      dispatch(fetchFilesThunk(workspaceSlug));
    }, 300);
  }, [workspaceSlug, dispatch]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (fsRefreshTimer.current) clearTimeout(fsRefreshTimer.current);
    };
  }, []);

  // ── Listen for AI terminal open events ────────────────────────────────
  // Consolidate: reuse ONE AI tab per chat prompt instead of creating a new tab per command.
  // If an AI tab already exists, update it to show the latest session. Only create a new
  // tab when there is no existing AI terminal.
  useEffect(() => {
    const openSessionTab = ({ sessionId, command, label: explicitLabel, isAi = false, shellType = null } = {}) => {
      if (!sessionId) return;
      const label = explicitLabel || (isAi
        ? `AI: ${(command || 'command').slice(0, 20)}${(command || '').length > 20 ? '…' : ''}`
        : `Task: ${(command || 'command').slice(0, 20)}${(command || '').length > 20 ? '…' : ''}`);

      setTerminals(prev => {
        const existingIdx = isAi
          ? prev.findIndex(t => t.isAi)
          : prev.findIndex(t => t.fixedSessionId === sessionId);
        if (existingIdx !== -1) {
          const updated = [...prev];
          updated[existingIdx] = {
            ...updated[existingIdx],
            fixedSessionId: sessionId,
            label,
            shellType: shellType || updated[existingIdx].shellType,
          };
          setActiveId(updated[existingIdx].id);
          return updated;
        }
        const id = `${isAi ? 'ai' : 'term'}-${Date.now()}`;
        setActiveId(id);
        return [...prev, { id, label, split: false, fixedSessionId: sessionId, isAi, shellType }];
      });
    };

    const handleAiTerminal = (e) => {
      openSessionTab({ ...(e.detail || {}), isAi: true });
    };
    const handleTerminalSession = (e) => {
      openSessionTab(e.detail || {});
    };

    window.addEventListener('ai-terminal-open', handleAiTerminal);
    window.addEventListener('terminal-session-open', handleTerminalSession);
    return () => {
      window.removeEventListener('ai-terminal-open', handleAiTerminal);
      window.removeEventListener('terminal-session-open', handleTerminalSession);
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    // Ensure at least one terminal exists
    if (terminals.length === 0) {
      const effectiveShell = defaultShellPref;
      setTerminals([defaultTerminalEntry(effectiveShell)]);
      setActiveId('term-1');
    }
  }, [visible, terminals.length, defaultShellPref]);

  const addTerminal = (shellType = null) => {
    const effectiveShell = shellType || defaultShellPref;
    const meta = effectiveShell ? getShellMeta(effectiveShell) : { label: 'Terminal' };
    const id = `term-${Date.now()}`;
    // Count existing terminals with same shell type for unique numbering
    const sameShellCount = terminals.filter(t => 
      (t.shellType || null) === (effectiveShell || null) && !t.isAi
    ).length;
    const label = sameShellCount > 0 ? `${meta.label} ${sameShellCount + 1}` : meta.label;
    const newTerm = { id, label, split: false, shellType: effectiveShell };
    setTerminals(prev => [...prev, newTerm]);
    setActiveId(id);
  };

  const launchAgentTerminal = (event) => {
    event.preventDefault();
    setAgentLauncherError('');
    const project = codeSiteProjects.find((entry) => entry.id === selectedCodeSiteProjectId);
    if (!canLaunchAgent) {
      setAgentLauncherError('Join an active shared session with terminal access first.');
      return;
    }
    if (!project) {
      setAgentLauncherError('Select an authorized CodeSite project.');
      return;
    }
    try {
      const launch = createTerminalAgentLaunch({
        projectId: project.id,
        provider: agentProvider,
        command: agentLaunchCommand,
      });
      const id = `agent-${launch.binding.providerSessionRef}`;
      const newTerminal = {
        id,
        label: `${launch.binding.provider} · ${project.title || project.id}`,
        split: false,
        shellType: defaultShellPref,
        agentBinding: launch.binding,
        agentLaunchCommand: launch.command,
      };
      setTerminals((current) => [...current, newTerminal]);
      setActiveId(id);
      setAgentLauncherOpen(false);
    } catch (error) {
      setAgentLauncherError(
        error?.code === 'invalid_terminal_agent_binding'
          ? 'Use a provider identifier containing letters, numbers, dots, dashes, or underscores.'
          : 'Enter one explicit agent launch command without line breaks.',
      );
    }
  };

  // ── Keyboard shortcut: Ctrl+Shift+` to create new terminal ──────────
  useEffect(() => {
    if (!visible) return;
    const handleKeyDown = (e) => {
      if (e.ctrlKey && e.shiftKey && e.key === '`') {
        e.preventDefault();
        addTerminal();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [visible, defaultShellPref, terminals.length]);

  const toggleSplit = () => {
    setTerminals(prev => prev.map(t => (
      t.id === activeId && !t.agentBinding ? { ...t, split: !t.split } : t
    )));
  };

  const closeActive = () => {
    setTerminals(prev => {
      const idx = prev.findIndex(t => t.id === activeId);
      if (idx === -1) return prev;
      const next = prev.filter(t => t.id !== activeId);
      if (next.length > 0) {
        const newIdx = Math.max(0, idx - 1);
        setActiveId(next[newIdx].id);
      }
      return next;
    });
  };

  const closeById = (id) => {
    setTerminals(prev => {
      const idx = prev.findIndex(t => t.id === id);
      const next = prev.filter(t => t.id !== id);
      if (id === activeId && next.length > 0) {
        const newIdx = Math.max(0, idx - 1);
        setActiveId(next[newIdx].id);
      }
      return next;
    });
  };

  const handleCloseAll = () => {
    setTerminals([]);
    setActiveId(undefined);
    if (onCloseAll) onCloseAll();
  };

  const startRenaming = (id, currentLabel) => {
    setEditingTabId(id);
    setEditingName(currentLabel);
  };

  const commitRename = () => {
    if (editingTabId && editingName.trim()) {
      setTerminals(prev => prev.map(t => t.id === editingTabId ? { ...t, label: editingName.trim() } : t));
    }
    setEditingTabId(null);
    setEditingName('');
  };

  const cancelRename = () => {
    setEditingTabId(null);
    setEditingName('');
  };

  const closeOthers = useCallback((id) => {
    setTerminals(prev => prev.filter(t => t.id === id));
    setActiveId(id);
  }, []);

  const { menuState, openMenu, closeMenu } = useContextMenu();

  const onTabContextMenu = useCallback((e, t) => {
    const others = terminals.length - 1;
    openMenu(e, [
      {
        id: 'rename',
        label: 'Rename Terminal',
        action: () => startRenaming(t.id, t.label),
      },
      {
        id: 'split',
        label: t.split ? 'Unsplit' : 'Split Terminal',
        disabled: Boolean(t.agentBinding),
        dividerAfter: true,
        action: () => {
          setTerminals(prev => prev.map(x => (
            x.id === t.id && !x.agentBinding ? { ...x, split: !x.split } : x
          )));
        },
      },
      {
        id: 'close',
        label: 'Close Terminal',
        action: () => closeById(t.id),
      },
      {
        id: 'close-others',
        label: 'Close Others',
        disabled: others <= 0,
        action: () => closeOthers(t.id),
      },
      {
        id: 'close-all',
        label: 'Close All',
        action: handleCloseAll,
      },
    ]);
  }, [openMenu, terminals.length, closeOthers]);

  const onStripContextMenu = useCallback((e) => {
    // Only fire when right-click misses a tab (delegated to empty strip area)
    if (e.target.closest('[data-terminal-tab]')) return;
    openMenu(e, [
      {
        id: 'new',
        label: 'New Terminal',
        shortcut: 'Ctrl+Shift+`',
        action: () => addTerminal(),
      },
      {
        id: 'close-all',
        label: 'Close All',
        disabled: terminals.length === 0,
        action: handleCloseAll,
      },
    ]);
  }, [openMenu, terminals.length, defaultShellPref]);

  const header = (
    <div
      className="relative h-9 flex items-center justify-between px-2 border-b select-none"
      style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-sidebar)' }}
      ref={dragRef}
      onContextMenu={onStripContextMenu}
    >
      {/* Tabs */}
      <div className="flex items-center gap-0.5 overflow-x-auto">
        {terminals.map(t => {
          const shellMeta = t.shellType ? getShellMeta(t.shellType) : null;
          return (
          <div
            key={t.id}
            data-terminal-tab={t.id}
            className="group relative flex items-center gap-1.5 h-7 px-2.5 cursor-pointer border-r transition-[background-color,color,opacity] duration-200"
            style={t.id === activeId
              ? {
                  color: 'var(--text-primary)',
                  background: 'color-mix(in srgb, var(--bg-elevated) 84%, transparent)',
                  borderRightColor: 'var(--border-subtle)',
                }
              : {
                  color: 'var(--text-secondary)',
                  background: 'transparent',
                  borderRightColor: 'var(--border-subtle)',
                  opacity: 0.82,
                }}
            onClick={() => setActiveId(t.id)}
            onDoubleClick={() => startRenaming(t.id, t.label)}
            onContextMenu={(e) => onTabContextMenu(e, t)}
          >
            <span
              aria-hidden="true"
              className="pointer-events-none absolute bottom-0 left-2.5 right-2.5 h-px origin-left transition-transform duration-200 ease-out scale-x-0 opacity-0 group-hover:scale-x-100 group-hover:opacity-100"
              style={{ background: 'var(--brand-gradient-horizontal)' }}
            />
            {t.isAi ? (
              <Bot className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--accent-primary)' }} strokeWidth={2} />
            ) : shellMeta ? (
              <span
                className="w-3.5 h-3.5 flex items-center justify-center rounded text-[8px] font-bold flex-shrink-0"
                style={{ background: `${shellMeta.color}20`, color: shellMeta.color }}
                title={shellMeta.label}
              >
                {shellMeta.icon}
              </span>
            ) : (
              <TerminalSquare className="w-3 h-3 flex-shrink-0" strokeWidth={2} />
            )}
            {editingTabId === t.id ? (
              <input
                className="text-xs font-medium bg-transparent border-b outline-none w-20"
                style={{ borderColor: 'var(--accent-primary)', color: 'var(--text-primary)' }}
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') cancelRename();
                }}
                autoFocus
                onClick={(e) => e.stopPropagation()}
                maxLength={30}
              />
            ) : (
              <span className="text-[11px] font-medium leading-none">{t.label}</span>
            )}
            {/* Close button - appears on hover, safe position */}
            <button 
              className="vt-danger-icon-hover ml-0.5 w-4 h-4 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 transition-all"
              style={{ color: 'var(--text-muted)' }}
              onClick={(e) => { e.stopPropagation(); closeById(t.id); }}
              title="Close Terminal"
            >
              <X className="w-2.5 h-2.5" strokeWidth={2} />
            </button>
          </div>
          );
        })}
      </div>
      
      {/* Actions - Larger click targets */}
      <div className="flex items-center gap-1">
        {/* Terminal count badge */}
        {terminals.length > 1 && (
          <span
            className="text-[9px] px-1.5 py-0.5 rounded font-medium mr-1"
            style={{ color: 'var(--text-muted)', background: 'var(--bg-elevated)' }}
          >
            {terminals.length}
          </span>
        )}
        <button 
          className="w-7 h-7 flex items-center justify-center rounded th-btn-ghost transition-colors" 
          onClick={() => addTerminal()} 
          title="New Terminal (Ctrl+Shift+`)"
        >
          <Plus className="w-3.5 h-3.5" strokeWidth={2} />
        </button>
        <ShellSelector
          onSelect={(shellKey) => addTerminal(shellKey)}
          currentDefault={defaultShellPref}
          onSetDefault={(shellKey) => { setDefaultShellPref(shellKey); setStoredDefaultShell(shellKey); }}
        />
        <div className="relative">
          <button
            type="button"
            data-testid="terminal-agent-launcher-toggle"
            className="w-7 h-7 flex items-center justify-center rounded th-btn-ghost transition-colors"
            onClick={() => {
              setAgentLauncherOpen((open) => !open);
              setAgentLauncherError('');
              void refreshCodeSiteProjects();
            }}
            title="Launch a project agent"
            aria-expanded={agentLauncherOpen}
          >
            <Bot className="w-3.5 h-3.5" strokeWidth={2} />
          </button>
          {agentLauncherOpen ? (
            <form
              data-testid="terminal-agent-launcher"
              onSubmit={launchAgentTerminal}
              className="absolute right-0 top-8 z-50 grid w-72 gap-3 rounded-lg border p-3 text-xs shadow-xl"
              style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-elevated)', color: 'var(--text-primary)' }}
            >
              <div>
                <div className="font-semibold">Attach a project agent</div>
                <div className="mt-0.5 text-[10px] leading-4" style={{ color: 'var(--text-muted)' }}>
                  Start any installed agent CLI in its own attributed session.
                </div>
              </div>
              <label className="grid gap-1">
                <span className="text-[10px] font-medium" style={{ color: 'var(--text-secondary)' }}>CodeSite project</span>
                <select
                  data-testid="terminal-agent-project"
                  value={selectedCodeSiteProjectId}
                  onChange={(event) => setSelectedCodeSiteProjectId(event.target.value)}
                  disabled={agentLauncherStatus !== 'ready' || codeSiteProjects.length === 0}
                  className="h-8 rounded-md border bg-transparent px-2 outline-none"
                  style={{ borderColor: 'var(--border-subtle)' }}
                >
                  {codeSiteProjects.length === 0 ? <option value="">No authorized projects</option> : null}
                  {codeSiteProjects.map((project) => (
                    <option key={project.id} value={project.id}>{project.title || project.id}</option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1">
                <span className="text-[10px] font-medium" style={{ color: 'var(--text-secondary)' }}>Provider identifier</span>
                <input
                  data-testid="terminal-agent-provider"
                  value={agentProvider}
                  onChange={(event) => setAgentProvider(event.target.value)}
                  placeholder="my_agent.v2"
                  autoComplete="off"
                  className="h-8 rounded-md border bg-transparent px-2 outline-none"
                  style={{ borderColor: 'var(--border-subtle)' }}
                />
              </label>
              <label className="grid gap-1">
                <span className="text-[10px] font-medium" style={{ color: 'var(--text-secondary)' }}>Launch command</span>
                <input
                  data-testid="terminal-agent-command"
                  value={agentLaunchCommand}
                  onChange={(event) => setAgentLaunchCommand(event.target.value)}
                  placeholder="agent-host --project current"
                  autoComplete="off"
                  className="h-8 rounded-md border bg-transparent px-2 font-mono outline-none"
                  style={{ borderColor: 'var(--border-subtle)' }}
                />
              </label>
              {!collaborationActive ? (
                <div className="text-[10px] leading-4" style={{ color: 'var(--status-warning)' }}>
                  Start or join a shared session before attaching an agent.
                </div>
              ) : null}
              {agentLauncherError ? (
                <div data-testid="terminal-agent-launcher-error" className="text-[10px] leading-4" style={{ color: 'var(--status-error)' }}>
                  {agentLauncherError}
                </div>
              ) : null}
              <button
                type="submit"
                data-testid="terminal-agent-launch"
                disabled={!canLaunchAgent || agentLauncherStatus !== 'ready' || !selectedCodeSiteProjectId}
                className="h-8 rounded-md px-3 font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                style={{ background: 'var(--text-primary)', color: 'var(--bg-app)' }}
              >
                Launch attributed agent
              </button>
            </form>
          ) : null}
        </div>
        <button 
          className="w-7 h-7 flex items-center justify-center rounded th-btn-ghost transition-colors" 
          onClick={toggleSplit}
          disabled={Boolean(terminals.find((terminal) => terminal.id === activeId)?.agentBinding)}
          title={terminals.find((terminal) => terminal.id === activeId)?.agentBinding ? 'Agent terminals cannot be split' : 'Split Terminal'}
        >
          <SplitSquareHorizontal className="w-3.5 h-3.5" strokeWidth={2} />
        </button>
        <div className="w-px h-5 mx-1" style={{ background: 'var(--border-subtle)' }}></div>
        <button
          className="vt-danger-icon-hover w-7 h-7 flex items-center justify-center rounded th-btn-ghost transition-colors"
          style={{ color: 'var(--text-secondary)' }}
          onClick={handleCloseAll} 
          title="Close Terminal Panel"
        >
          <X className="w-3.5 h-3.5" strokeWidth={2} />
        </button>
      </div>
    </div>
  );
  
  if (!visible) return null;
  const body = (
    <div className="flex-1 overflow-hidden p-2" style={{ background: 'var(--bg-sidebar)' }}>
      {terminals.length === 0 ? (
        <div className="h-full flex items-center justify-center text-xs" style={{ color: 'var(--text-muted)' }}>No terminals</div>
      ) : (
        <div className="h-full w-full relative">
          {terminals.map(t => (
            <div
              key={t.id}
              className={`absolute inset-0 ${t.id === activeId ? 'z-10' : 'z-0'}`}
              style={{ 
                visibility: t.id === activeId ? 'visible' : 'hidden',
                pointerEvents: t.id === activeId ? 'auto' : 'none'
              }}
            >
              <div className={`h-full w-full ${t.split ? 'grid grid-cols-2 gap-0' : ''}`}>
                {/* TerminalPane is memo-frozen + its WS init effect runs once.
                    Wait for a real workspaceName before mounting so the PTY
                    prompt is correct on first frame and never shows the slug. */}
                {workspaceSlug ? (
                  <TerminalPane key={`${t.id}-main`} terminalId={t.id} paneSide="main" workspaceSlug={workspaceSlug} workspaceName={workspaceName || workspaceSlug} onFsChange={handleFsChange} fixedSessionId={t.fixedSessionId || null} shellType={t.shellType || null} agentBinding={t.agentBinding || null} agentLaunchCommand={t.agentLaunchCommand || null} />
                ) : (
                  <div className="h-full w-full" style={{ background: 'var(--bg-app)' }} />
                )}
                {t.split && workspaceSlug && (
                  <TerminalPane key={`${t.id}-split`} terminalId={t.id} paneSide="split" workspaceSlug={workspaceSlug} workspaceName={workspaceName || workspaceSlug} onFsChange={handleFsChange} shellType={t.shellType || null} />
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="border-t h-full flex flex-col" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-sidebar)' }}>
      {header}
      {body}
      {menuState && <ContextMenu {...menuState} onClose={closeMenu} />}
    </div>
  );
});

export default TerminalManager;
