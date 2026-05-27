'use client';
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useDispatch } from 'react-redux';
import { interactiveRebase, fetchCommitHistory, fetchGitStatus, fetchUnpushedCommits } from '@/redux/gitSlice';
import { toast } from 'sonner';
import {
  GripVertical, Play, X, ChevronDown, Edit3,
  Layers, ArrowDownToLine, Trash2, AlertTriangle,
} from 'lucide-react';
import './scm/scm-tokens.css';

/* ────────────────────────────────────────────────────────────
 * InteractiveRebasePanel
 *
 * Displays a reorderable list of commits, letting the user assign
 * an action (pick / reword / squash / fixup / drop) to each commit,
 * then execute the rebase.
 *
 * Visual grammar follows the Vectant redesign — calm slate-violet
 * baseline, accent-success for safe (pick), accent-secondary for
 * neutral (reword), accent-warning for destructive (squash/fixup),
 * accent-danger for drop, attention-purple for fixup.
 * ──────────────────────────────────────────────────────────── */

const ACTIONS = [
  { value: 'pick',    label: 'Pick',    icon: Play,            color: 'var(--accent-success)',   desc: 'Use commit as-is' },
  { value: 'reword',  label: 'Reword',  icon: Edit3,           color: 'var(--accent-secondary)', desc: 'Edit commit message' },
  { value: 'squash',  label: 'Squash',  icon: Layers,          color: 'var(--accent-warning)',   desc: 'Merge into previous, keep message' },
  { value: 'fixup',   label: 'Fixup',   icon: ArrowDownToLine, color: 'var(--attention-purple)', desc: 'Merge into previous, discard message' },
  { value: 'drop',    label: 'Drop',    icon: Trash2,          color: 'var(--accent-danger)',    desc: 'Remove this commit' },
];

const actionMeta = Object.fromEntries(ACTIONS.map((a) => [a.value, a]));

/* ─── Draggable commit row ──────────────────────────── */

function RebaseRow({ item, index, onActionChange, onMessageChange, onDragStart, onDragOver, onDrop }) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [editingMessage, setEditingMessage] = useState(false);
  const meta = actionMeta[item.action] || actionMeta.pick;
  const Icon = meta.icon;
  const dropdownRef = useRef(null);

  useEffect(() => {
    if (!showDropdown) return;
    const handleClick = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setShowDropdown(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showDropdown]);

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, index)}
      onDragOver={(e) => onDragOver(e, index)}
      onDrop={(e) => onDrop(e, index)}
      className="flex items-center gap-2 px-2 py-1.5 transition-colors"
      style={{
        borderBottom: '1px solid var(--border-subtle)',
        opacity: item.action === 'drop' ? 0.45 : 1,
        background: 'transparent',
      }}
      onMouseEnter={(e) => {
        if (item.action !== 'drop') {
          e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 4%, transparent)';
        }
      }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      <GripVertical
        className="w-3 h-3 cursor-grab flex-shrink-0"
        style={{ color: 'var(--text-dim)' }}
        strokeWidth={2}
      />

      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setShowDropdown(!showDropdown)}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium th-focus-ring"
          style={{
            color: meta.color,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
          }}
          title={meta.desc}
          aria-label={`Rebase action: ${meta.label}`}
        >
          <Icon className="w-2.5 h-2.5" strokeWidth={2} />
          <span className="w-10 text-left">{meta.label}</span>
          <ChevronDown className="w-2 h-2 opacity-60" strokeWidth={2} />
        </button>
        {showDropdown && (
          <div
            className="absolute z-50 top-full mt-1 left-0 rounded-lg shadow-xl py-1 min-w-[180px]"
            style={{
              background: 'var(--bg-panel)',
              border: '1px solid var(--border-medium)',
            }}
          >
            {ACTIONS.map((a) => (
              <button
                key={a.value}
                onClick={() => { onActionChange(index, a.value); setShowDropdown(false); }}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs transition-colors th-focus-ring"
                style={{
                  color: a.color,
                  background: item.action === a.value
                    ? 'color-mix(in srgb, var(--text-primary) 6%, transparent)'
                    : 'transparent',
                }}
                onMouseEnter={(e) => {
                  if (item.action !== a.value) {
                    e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 4%, transparent)';
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = item.action === a.value
                    ? 'color-mix(in srgb, var(--text-primary) 6%, transparent)'
                    : 'transparent';
                }}
              >
                <a.icon className="w-3 h-3 flex-shrink-0" strokeWidth={2} />
                <span className="font-medium">{a.label}</span>
                <span className="text-[10px] ml-auto" style={{ color: 'var(--text-dim)' }}>{a.desc}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <code
        className="text-[10px] font-mono flex-shrink-0"
        style={{ color: 'var(--text-dim)' }}
      >
        {item.hash?.substring(0, 7)}
      </code>

      {editingMessage || item.action === 'reword' ? (
        <input
          type="text"
          value={item.message}
          onChange={(e) => onMessageChange(index, e.target.value)}
          onBlur={() => setEditingMessage(false)}
          className="flex-1 rounded px-1.5 py-0.5 text-[11px] focus:outline-none th-focus-ring"
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-medium)',
            color: 'var(--text-primary)',
          }}
          autoFocus={editingMessage}
        />
      ) : (
        <span
          className="flex-1 text-[11px] truncate cursor-text"
          style={{ color: 'var(--text-secondary)' }}
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
    (commits || []).map((c) => ({
      hash: c.hash,
      message: c.message || c.subject || '',
      action: 'pick',
    })),
  );
  const [executing, setExecuting] = useState(false);
  const dragIdx = useRef(null);

  const handleActionChange = useCallback((idx, action) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, action } : it)));
  }, []);

  const handleMessageChange = useCallback((idx, message) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, message } : it)));
  }, []);

  const handleDragStart = useCallback((e, idx) => {
    dragIdx.current = idx;
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback((e, dropIdx) => {
    e.preventDefault();
    const srcIdx = dragIdx.current;
    if (srcIdx === null || srcIdx === dropIdx) return;
    setItems((prev) => {
      const copy = [...prev];
      const [moved] = copy.splice(srcIdx, 1);
      copy.splice(dropIdx, 0, moved);
      return copy;
    });
    dragIdx.current = null;
  }, []);

  const handleExecute = useCallback(async () => {
    if (items[0]?.action === 'squash' || items[0]?.action === 'fixup') {
      toast.error('First commit cannot be squash or fixup — it has no previous commit to merge into.');
      return;
    }
    if (items.every((it) => it.action === 'drop')) {
      toast.error('Cannot drop all commits.');
      return;
    }

    setExecuting(true);
    try {
      const oldestHash = commits[0]?.hash;
      const baseCommit = `${oldestHash}~1`;

      const result = await dispatch(interactiveRebase({
        slug,
        baseCommit,
        operations: items.map((it) => ({
          action: it.action,
          hash: it.hash,
          message: it.action === 'reword' ? it.message : undefined,
        })),
      }));

      if (interactiveRebase.fulfilled.match(result)) {
        toast.success('Interactive rebase completed');
        dispatch(fetchCommitHistory({ slug }));
        dispatch(fetchGitStatus(slug));
        dispatch(fetchUnpushedCommits({ slug, max: 50 }));
        onClose?.();
      } else {
        const errMsg = result.error?.message || 'Rebase failed';
        if (/conflict/i.test(errMsg)) {
          toast.error('Rebase stopped due to conflicts. Resolve them and use rebase continue.', { duration: 6000 });
        } else {
          toast.error(errMsg);
        }
      }
    } catch (err) {
      toast.error(err.message || 'Rebase failed');
    } finally {
      setExecuting(false);
    }
  }, [dispatch, slug, items, commits, onClose]);

  const counts = {
    pick:   items.filter((it) => it.action === 'pick').length,
    reword: items.filter((it) => it.action === 'reword').length,
    squash: items.filter((it) => it.action === 'squash').length,
    fixup:  items.filter((it) => it.action === 'fixup').length,
    drop:   items.filter((it) => it.action === 'drop').length,
  };

  return (
    <div className="flex flex-col h-full" style={{ background: 'var(--bg-app)', color: 'var(--text-primary)' }}>
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{
          background: 'var(--bg-panel)',
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4" style={{ color: 'var(--attention-purple)' }} strokeWidth={2} />
          <span className="text-xs font-semibold">Interactive Rebase</span>
          <span
            className="text-[10px]"
            style={{ color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}
          >
            {items.length} commit{items.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleExecute}
            disabled={executing}
            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors th-focus-ring"
            style={{
              background: 'var(--brand-gradient)',
              color: '#ffffff',
              border: 'none',
              opacity: executing ? 0.6 : 1,
              boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
            }}
            aria-label={executing ? 'Rebasing' : 'Start rebase'}
          >
            <Play className="w-3 h-3" strokeWidth={2} />
            {executing ? 'Rebasing…' : 'Start Rebase'}
          </button>
          <button
            onClick={onClose}
            className="scm-row-action th-focus-ring"
            style={{ width: 24, height: 24, color: 'var(--text-muted)' }}
            aria-label="Close rebase panel"
            title="Close"
          >
            <X className="w-3.5 h-3.5" strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* Action summary bar */}
      <div
        className="flex items-center gap-3 px-3 py-1.5 text-[10px]"
        style={{
          background: 'var(--bg-app)',
          borderBottom: '1px solid var(--border-subtle)',
          color: 'var(--text-muted)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {counts.pick > 0
          && <span style={{ color: 'var(--accent-success)' }}>{counts.pick} pick</span>}
        {counts.reword > 0
          && <span style={{ color: 'var(--accent-secondary)' }}>{counts.reword} reword</span>}
        {counts.squash > 0
          && <span style={{ color: 'var(--accent-warning)' }}>{counts.squash} squash</span>}
        {counts.fixup > 0
          && <span style={{ color: 'var(--attention-purple)' }}>{counts.fixup} fixup</span>}
        {counts.drop > 0
          && <span style={{ color: 'var(--accent-danger)' }}>{counts.drop} drop</span>}
      </div>

      {/* Warning banner — rebase rewrites history */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 text-[10px]"
        style={{
          background: 'color-mix(in srgb, var(--accent-warning) 6%, transparent)',
          borderBottom: '1px solid var(--border-subtle)',
          color: 'color-mix(in srgb, var(--accent-warning) 80%, var(--text-primary))',
        }}
      >
        <AlertTriangle className="w-3 h-3 flex-shrink-0" strokeWidth={2} />
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
