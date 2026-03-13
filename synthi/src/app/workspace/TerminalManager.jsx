'use client';

import React, { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react';
import dynamic from 'next/dynamic';
import { SplitSquareHorizontal, Plus, X, TerminalSquare, Bot, Settings } from 'lucide-react';
import { useDispatch } from 'react-redux';
import { fetchFilesThunk } from '@/redux/workspaceSlice';
import ShellSelector, { getShellMeta } from './ShellSelector';

const TerminalPane = dynamic(() => import('./TerminalPane.jsx'), { ssr: false });

/** localStorage key for remembering the user's preferred default shell */
const DEFAULT_SHELL_KEY = 'synthi-default-shell';

function getStoredDefaultShell() {
  try { return localStorage.getItem(DEFAULT_SHELL_KEY) || null; } catch (_) { return null; }
}
function setStoredDefaultShell(shellKey) {
  try { if (shellKey) localStorage.setItem(DEFAULT_SHELL_KEY, shellKey); else localStorage.removeItem(DEFAULT_SHELL_KEY); } catch (_) {}
}

const TerminalManager = memo(function TerminalManager({ visible, onCloseAll, workspaceSlug = '' }) {
  const [defaultShellPref, setDefaultShellPref] = useState(() => getStoredDefaultShell());
  const [terminals, setTerminals] = useState([{ id: 'term-1', label: getShellMeta(getStoredDefaultShell())?.label || 'Terminal', split: false, shellType: getStoredDefaultShell() }]);
  const [activeId, setActiveId] = useState('term-1');
  const [editingTabId, setEditingTabId] = useState(null);
  const [editingName, setEditingName] = useState('');
  const dragRef = useRef(null);
  const dispatch = useDispatch();
  const fsRefreshTimer = useRef(null);

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
    const handleAiTerminal = (e) => {
      const { sessionId, command } = e.detail || {};
      if (!sessionId) return;
      const label = `AI: ${(command || 'command').slice(0, 20)}${(command || '').length > 20 ? '…' : ''}`;

      setTerminals(prev => {
        // Check if there's already an AI terminal tab
        const existingIdx = prev.findIndex(t => t.isAi);
        if (existingIdx !== -1) {
          // Update existing AI tab with the new session
          const updated = [...prev];
          updated[existingIdx] = { ...updated[existingIdx], fixedSessionId: sessionId, label };
          // Switch to the existing AI tab
          setActiveId(updated[existingIdx].id);
          return updated;
        }
        // No existing AI tab — create one
        const id = `ai-${Date.now()}`;
        setActiveId(id);
        return [...prev, { id, label, split: false, fixedSessionId: sessionId, isAi: true }];
      });
    };
    window.addEventListener('ai-terminal-open', handleAiTerminal);
    return () => window.removeEventListener('ai-terminal-open', handleAiTerminal);
  }, []);

  useEffect(() => {
    if (!visible) return;
    // Ensure at least one terminal exists
    if (terminals.length === 0) {
      const effectiveShell = defaultShellPref;
      setTerminals([{ id: 'term-1', label: getShellMeta(effectiveShell)?.label || 'Terminal', split: false, shellType: effectiveShell }]);
      setActiveId('term-1');
    }
  }, [visible, terminals.length]);

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
    setTerminals(prev => prev.map(t => t.id === activeId ? { ...t, split: !t.split } : t));
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

  const header = (
    <div className="h-10 flex items-center justify-between px-2 border-b select-none" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-sidebar)' }} ref={dragRef}>
      {/* Tabs */}
      <div className="flex items-center gap-1 overflow-x-auto">
        {terminals.map(t => {
          const shellMeta = t.shellType ? getShellMeta(t.shellType) : null;
          return (
          <div 
            key={t.id} 
            className={`group flex items-center gap-2 h-8 px-3 cursor-pointer transition-all duration-150 ${
              t.id === activeId 
                ? 'th-bg-panel' 
                : ''
            }`}
            style={t.id === activeId 
              ? { color: 'var(--text-primary)', borderTop: '2px solid var(--accent-primary)' }
              : { color: 'var(--text-secondary)' }} 
            onClick={() => setActiveId(t.id)}
            onDoubleClick={() => startRenaming(t.id, t.label)}
          >
            {t.isAi ? (
              <Bot className="w-3.5 h-3.5" style={{ color: 'var(--accent-primary)' }} strokeWidth={2} />
            ) : shellMeta ? (
              <span
                className="w-4 h-4 flex items-center justify-center rounded text-[9px] font-bold flex-shrink-0"
                style={{ background: `${shellMeta.color}20`, color: shellMeta.color }}
                title={shellMeta.label}
              >
                {shellMeta.icon}
              </span>
            ) : (
              <TerminalSquare className="w-3.5 h-3.5" strokeWidth={2} />
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
              <span className="text-xs font-medium">{t.label}</span>
            )}
            {/* Close button - appears on hover, safe position */}
            <button 
              className="w-5 h-5 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-[#ef4444]/20 hover:text-[#ef4444] transition-all ml-1"
              onClick={(e) => { e.stopPropagation(); closeById(t.id); }}
              title="Close Terminal"
            >
              <X className="w-3 h-3" strokeWidth={2} />
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
          className="w-8 h-8 flex items-center justify-center rounded th-btn-ghost transition-colors" 
          onClick={() => addTerminal()} 
          title="New Terminal (Ctrl+Shift+`)"
        >
          <Plus className="w-4 h-4" strokeWidth={2} />
        </button>
        <ShellSelector
          onSelect={(shellKey) => addTerminal(shellKey)}
          currentDefault={defaultShellPref}
          onSetDefault={(shellKey) => { setDefaultShellPref(shellKey); setStoredDefaultShell(shellKey); }}
        />
        <button 
          className="w-8 h-8 flex items-center justify-center rounded th-btn-ghost transition-colors" 
          onClick={toggleSplit} 
          title="Split Terminal"
        >
          <SplitSquareHorizontal className="w-4 h-4" strokeWidth={2} />
        </button>
        <div className="w-px h-5 mx-1" style={{ background: 'var(--border-subtle)' }}></div>
        <button 
          className="w-8 h-8 flex items-center justify-center rounded th-btn-ghost hover:bg-[#ef4444]/20 hover:text-[#ef4444] transition-colors" 
          onClick={handleCloseAll} 
          title="Close Terminal Panel"
        >
          <X className="w-4 h-4" strokeWidth={2} />
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
                <TerminalPane key={`${t.id}-main`} terminalId={t.id} paneSide="main" workspaceSlug={workspaceSlug} onFsChange={handleFsChange} fixedSessionId={t.fixedSessionId || null} shellType={t.shellType || null} />
                {t.split && (
                  <TerminalPane key={`${t.id}-split`} terminalId={t.id} paneSide="split" workspaceSlug={workspaceSlug} onFsChange={handleFsChange} shellType={t.shellType || null} />
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
    </div>
  );
});

export default TerminalManager;