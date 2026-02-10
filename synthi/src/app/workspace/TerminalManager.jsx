'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { SplitSquareHorizontal, Plus, X, TerminalSquare } from 'lucide-react';
import { useDispatch } from 'react-redux';
import { fetchFilesThunk } from '@/redux/workspaceSlice';

const TerminalPane = dynamic(() => import('./TerminalPane.jsx'), { ssr: false });

export default function TerminalManager({ visible, onCloseAll, workspaceSlug = '' }) {
  const [terminals, setTerminals] = useState([{ id: 'term-1', label: 'Terminal 1', split: false }]);
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

  useEffect(() => {
    if (!visible) return;
    // Ensure at least one terminal exists
    if (terminals.length === 0) {
      setTerminals([{ id: 'term-1', label: 'Terminal 1', split: false }]);
      setActiveId('term-1');
    }
  }, [visible, terminals.length]);

  const addTerminal = () => {
    const nextIndex = terminals.length + 1;
    const id = `term-${Date.now()}`;
    const newTerm = { id, label: `Terminal ${nextIndex}`, split: false };
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
    <div className="h-10 flex items-center justify-between px-2 border-b border-[#1a1a1e] bg-[#09090b] select-none" ref={dragRef}>
      {/* Tabs */}
      <div className="flex items-center gap-1 overflow-x-auto">
        {terminals.map(t => (
          <div 
            key={t.id} 
            className={`group flex items-center gap-2 h-8 px-3 cursor-pointer transition-all duration-150 ${
              t.id === activeId 
                ? 'bg-[#0c0c0e] text-[#D7DAE0] border-t-2 border-t-[#327464]' 
                : 'text-[#a1a1aa] hover:bg-[#111113] hover:text-[#D7DAE0]'
            }`} 
            onClick={() => setActiveId(t.id)}
          >
            <TerminalSquare className="w-3.5 h-3.5" strokeWidth={2} />
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
          className="w-8 h-8 flex items-center justify-center rounded text-[#a1a1aa] hover:bg-[#1a1a1e] hover:text-[#D7DAE0] transition-colors" 
          onClick={addTerminal} 
          title="New Terminal"
        >
          <Plus className="w-4 h-4" strokeWidth={2} />
        </button>
        <button 
          className="w-8 h-8 flex items-center justify-center rounded text-[#a1a1aa] hover:bg-[#1a1a1e] hover:text-[#D7DAE0] transition-colors" 
          onClick={toggleSplit} 
          title="Split Terminal"
        >
          <SplitSquareHorizontal className="w-4 h-4" strokeWidth={2} />
        </button>
        <div className="w-px h-5 bg-[#1a1a1e] mx-1"></div>
        <button 
          className="w-8 h-8 flex items-center justify-center rounded text-[#a1a1aa] hover:bg-[#ef4444]/20 hover:text-[#ef4444] transition-colors" 
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
    <div className="bg-[#09090b] flex-1 overflow-hidden p-2">
      {terminals.length === 0 ? (
        <div className="h-full flex items-center justify-center text-xs text-[#71717a]">No terminals</div>
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
                <TerminalPane key={`${t.id}-main`} terminalId={t.id} paneSide="main" workspaceSlug={workspaceSlug} onFsChange={handleFsChange} />
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
    <div className="border-t border-[#1a1a1e] bg-[#09090b] h-full flex flex-col">
      {header}
      {body}
    </div>
  );
}