'use client';
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useDispatch } from 'react-redux';
import { interactiveRebase } from '@/redux/gitSlice';
import { toast } from 'sonner';
import {
  GripVertical, Play, X, ChevronDown, Edit3,
  Layers, ArrowDownToLine, Trash2, AlertTriangle,
} from 'lucide-react';

/* ────────────────────────────────────────────────────────────
 * InteractiveRebasePanel
 *
 * Displays a reorderable list of commits, letting the user assign
 * an action (pick / reword / squash / fixup / drop) to each commit,
 * then execute the rebase.
 *
 * Props:
 *   commits  — array of { hash, message, author_name, date }
 *              ordered from oldest to newest (same order that goes
 *              into the rebase-todo file).
 *   slug     — the repo slug
 *   onClose  — called when the panel is dismissed
 * ──────────────────────────────────────────────────────────── */

const ACTIONS = [
  { value: 'pick',    label: 'Pick',    icon: Play,            color: 'text-emerald-400', desc: 'Use commit as-is' },
  { value: 'reword',  label: 'Reword',  icon: Edit3,           color: 'text-blue-400',    desc: 'Edit commit message' },
  { value: 'squash',  label: 'Squash',  icon: Layers,          color: 'text-amber-400',   desc: 'Merge into previous, keep message' },
  { value: 'fixup',   label: 'Fixup',   icon: ArrowDownToLine, color: 'text-purple-400',  desc: 'Merge into previous, discard message' },
  { value: 'drop',    label: 'Drop',    icon: Trash2,          color: 'text-red-400',     desc: 'Remove this commit' },
];

const actionMeta = Object.fromEntries(ACTIONS.map(a => [a.value, a]));

/* ─── Draggable commit row ──────────────────────────── */

function RebaseRow({ item, index, onActionChange, onMessageChange, onDragStart, onDragOver, onDrop }) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [editingMessage, setEditingMessage] = useState(false);
  const meta = actionMeta[item.action] || actionMeta.pick;
  const Icon = meta.icon;
  const dropdownRef = useRef(null);

  useEffect(() => {
    if (!showDropdown) return;
    const handleClick = e => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setShowDropdown(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showDropdown]);

  return (
    <div
      draggable
      onDragStart={e => onDragStart(e, index)}
      onDragOver={e => onDragOver(e, index)}
      onDrop={e => onDrop(e, index)}
      className={`flex items-center gap-2 px-2 py-1.5 border-b border-[#1e1e22] transition-colors
        ${item.action === 'drop' ? 'opacity-40' : 'hover:bg-[#1a1a1e]'}
      `}
    >
      {/* Drag handle */}
      <GripVertical className="w-3 h-3 text-[#3f3f46] cursor-grab flex-shrink-0" />

      {/* Action dropdown */}
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setShowDropdown(!showDropdown)}
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${meta.color} bg-[#18181b] border border-[#27272a] hover:border-[#3f3f46]`}
          title={meta.desc}
        >
          <Icon className="w-2.5 h-2.5" />
          <span className="w-10 text-left">{meta.label}</span>
          <ChevronDown className="w-2 h-2 opacity-60" />
        </button>
        {showDropdown && (
          <div className="absolute z-50 top-full mt-1 left-0 bg-[#1c1c1e] border border-[#3f3f46] rounded-lg shadow-xl py-1 min-w-[150px]">
            {ACTIONS.map(a => (
              <button
                key={a.value}
                onClick={() => { onActionChange(index, a.value); setShowDropdown(false); }}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-xs transition-colors hover:bg-[#27272a]
                  ${item.action === a.value ? 'bg-[#27272a]' : ''} ${a.color}`}
              >
                <a.icon className="w-3 h-3 flex-shrink-0" />
                <span className="font-medium">{a.label}</span>
                <span className="text-[#52525b] text-[10px] ml-auto">{a.desc}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Commit hash */}
      <code className="text-[10px] font-mono text-[#52525b] flex-shrink-0">{item.hash?.substring(0, 7)}</code>

      {/* Message (editable if reword) */}
      {editingMessage || item.action === 'reword' ? (
        <input
          type="text"
          value={item.message}
          onChange={e => onMessageChange(index, e.target.value)}
          onBlur={() => setEditingMessage(false)}
          className="flex-1 bg-[#18181b] border border-[#3f3f46] rounded px-1.5 py-0.5 text-[11px] text-[#e4e4e7] focus:outline-none focus:border-[#3b82f6]"
          autoFocus={editingMessage}
        />
      ) : (
        <span
          className="flex-1 text-[11px] text-[#a1a1aa] truncate cursor-text"
          onDoubleClick={() => setEditingMessage(true)}
          title="Double-click to edit"
        >
          {item.message}
        </span>
      )}
    </div>
  );
}

/* ─── Main Panel ────────────────────────────────────── */

export default function InteractiveRebasePanel({ commits, slug, onClose }) {
  const dispatch = useDispatch();
  const [items, setItems] = useState(() =>
    (commits || []).map(c => ({
      hash: c.hash,
      message: c.message || c.subject || '',
      action: 'pick',
    }))
  );
  const [executing, setExecuting] = useState(false);
  const dragIdx = useRef(null);

  const handleActionChange = useCallback((idx, action) => {
    setItems(prev => prev.map((it, i) => i === idx ? { ...it, action } : it));
  }, []);

  const handleMessageChange = useCallback((idx, message) => {
    setItems(prev => prev.map((it, i) => i === idx ? { ...it, message } : it));
  }, []);

  const handleDragStart = useCallback((e, idx) => {
    dragIdx.current = idx;
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((e, idx) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback((e, dropIdx) => {
    e.preventDefault();
    const srcIdx = dragIdx.current;
    if (srcIdx === null || srcIdx === dropIdx) return;
    setItems(prev => {
      const copy = [...prev];
      const [moved] = copy.splice(srcIdx, 1);
      copy.splice(dropIdx, 0, moved);
      return copy;
    });
    dragIdx.current = null;
  }, []);

  const handleExecute = useCallback(async () => {
    // Validate: first commit can't be squash or fixup
    if (items[0]?.action === 'squash' || items[0]?.action === 'fixup') {
      toast.error('First commit cannot be squash or fixup — it has no previous commit to merge into.');
      return;
    }
    // Check that at least one commit is not dropped
    if (items.every(it => it.action === 'drop')) {
      toast.error('Cannot drop all commits.');
      return;
    }

    setExecuting(true);
    try {
      // baseCommit = parent of oldest commit in the range
      const oldestHash = commits[0]?.hash;
      const baseCommit = `${oldestHash}~1`;

      const result = await dispatch(interactiveRebase({
        slug,
        baseCommit,
        operations: items.map(it => ({
          action: it.action,
          hash: it.hash,
          message: it.action === 'reword' ? it.message : undefined,
        })),
      }));

      if (interactiveRebase.fulfilled.match(result)) {
        toast.success('Interactive rebase completed');
        onClose?.();
      } else {
        toast.error(result.error?.message || 'Rebase failed');
      }
    } catch (err) {
      toast.error(err.message || 'Rebase failed');
    } finally {
      setExecuting(false);
    }
  }, [dispatch, slug, items, commits, onClose]);

  const pickCount = items.filter(it => it.action === 'pick').length;
  const rewordCount = items.filter(it => it.action === 'reword').length;
  const squashCount = items.filter(it => it.action === 'squash').length;
  const fixupCount = items.filter(it => it.action === 'fixup').length;
  const dropCount = items.filter(it => it.action === 'drop').length;

  return (
    <div className="flex flex-col h-full bg-[#0a0a0b] text-[#e4e4e7]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#27272a] bg-[#111113]">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-[#f59e0b]" />
          <span className="text-xs font-semibold">Interactive Rebase</span>
          <span className="text-[10px] text-[#52525b]">{items.length} commit{items.length !== 1 ? 's' : ''}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleExecute}
            disabled={executing}
            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium bg-[#f59e0b]/20 text-[#f59e0b] hover:bg-[#f59e0b]/30 disabled:opacity-50 transition-colors"
          >
            <Play className="w-3 h-3" />
            {executing ? 'Rebasing…' : 'Start Rebase'}
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[#27272a] text-[#71717a] hover:text-[#e4e4e7] transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Action summary bar */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-[#1e1e22] bg-[#0d0d0f] text-[10px] text-[#52525b]">
        {pickCount > 0 && <span className="text-emerald-400">{pickCount} pick</span>}
        {rewordCount > 0 && <span className="text-blue-400">{rewordCount} reword</span>}
        {squashCount > 0 && <span className="text-amber-400">{squashCount} squash</span>}
        {fixupCount > 0 && <span className="text-purple-400">{fixupCount} fixup</span>}
        {dropCount > 0 && <span className="text-red-400">{dropCount} drop</span>}
      </div>

      {/* Warning */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-[#f59e0b]/5 border-b border-[#27272a] text-[10px] text-[#f59e0b]/80">
        <AlertTriangle className="w-3 h-3 flex-shrink-0" />
        <span>Rebase rewrites history. Only rebase unpushed commits. Drag rows to reorder.</span>
      </div>

      {/* Commit list */}
      <div className="flex-1 overflow-auto">
        {items.map((item, idx) => (
          <RebaseRow
            key={item.hash}
            item={item}
            index={idx}
            onActionChange={handleActionChange}
            onMessageChange={handleMessageChange}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          />
        ))}
      </div>
    </div>
  );
}
