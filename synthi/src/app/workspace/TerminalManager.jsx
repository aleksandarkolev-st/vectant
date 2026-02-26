'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { SplitSquareHorizontal, Plus, X, TerminalSquare, Bot } from 'lucide-react';
import { useDispatch } from 'react-redux';
import { fetchFilesThunk } from '@/redux/workspaceSlice';
import ShellSelector, { getShellMeta } from './ShellSelector';

const TerminalPane = dynamic(() => import('./TerminalPane.jsx'), { ssr: false });

export default function TerminalManager({ visible, onCloseAll, workspaceSlug = '' }) {
  const [terminals, setTerminals] = useState([{ id: 'term-1', label: 'PowerShell', split: false, shellType: null }]);
  const [activeId, setActiveId] = useState('term-1');
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
      setTerminals([{ id: 'term-1', label: 'PowerShell', split: false, shellType: null }]);
      setActiveId('term-1');
    }
  }, [visible, terminals.length]);

  const addTerminal = (shellType = null) => {
    const meta = shellType ? getShellMeta(shellType) : { label: 'Terminal' };
    const id = `term-${Date.now()}`;
    const newTerm = { id, label: meta.label, split: false, shellType };
    setTerminals(prev => [...prev, newTerm]);
    setActiveId(id);
  };

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

  const header = (
    <div className="h-10 flex items-center justify-between px-2 border-b select-none" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-sidebar)' }} ref={dragRef}>
      {/* Tabs */}
      <div className="flex items-center gap-1 overflow-x-auto">
        {terminals.map(t => (
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
          >
            {t.isAi ? (
              <Bot className="w-3.5 h-3.5" style={{ color: 'var(--accent-primary)' }} strokeWidth={2} />
            ) : (
              <TerminalSquare className="w-3.5 h-3.5" strokeWidth={2} />
            )}
            <span className="text-xs font-medium">{t.label}</span>
            {/* Close button - appears on hover, safe position */}
            <button 
              className="w-5 h-5 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-[#ef4444]/20 hover:text-[#ef4444] transition-all ml-1"
              onClick={(e) => { e.stopPropagation(); closeById(t.id); }}
              title="Close Terminal"
            >
              <X className="w-3 h-3" strokeWidth={2} />
            </button>
          </div>
        ))}
      </div>
      
      {/* Actions - Larger click targets */}
      <div className="flex items-center gap-1">
        <button 
          className="w-8 h-8 flex items-center justify-center rounded th-btn-ghost transition-colors" 
          onClick={() => addTerminal()} 
          title="New Terminal (Default Shell)"
        >
          <Plus className="w-4 h-4" strokeWidth={2} />
        </button>
        <ShellSelector onSelect={(shellKey) => addTerminal(shellKey)} />
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
                <TerminalPane key={`${t.id}-main`} terminalId={t.id} paneSide="main" workspaceSlug={workspaceSlug} onFsChange={handleFsChange} fixedSessionId={t.fixedSessionId || null} />
                {t.split && (
                  <TerminalPane key={`${t.id}-split`} terminalId={t.id} paneSide="split" workspaceSlug={workspaceSlug} onFsChange={handleFsChange} />
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
}