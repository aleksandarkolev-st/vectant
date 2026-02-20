'use client';

/**
 * @fileoverview ThemePicker
 *
 * Full-screen overlay resembling a command palette; lists all available
 * themes and allows instant live-preview on hover / arrow-key navigation.
 *
 * Activation:
 *   - Ctrl+K  Ctrl+T  (two-chord shortcut, like VS Code)
 *   - Exposed via `useThemePicker()` hook for programmatic open
 *
 * Behaviour:
 *   - Type to filter themes by name
 *   - Arrow Up/Down to navigate; preview updates instantly
 *   - Enter to confirm; Escape to cancel (reverts preview)
 *   - Grouped by source: Built-in → Extensions → User
 */

import { useState, useEffect, useRef, useCallback, createContext, useContext, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { useAppDispatch, useAppSelector } from '@/redux/hooks';
import {
  selectThemeList,
  selectActiveThemeId,
  setActiveTheme,
  previewTheme,
  clearPreview,
} from '@/redux/themeSlice';
import { Palette, Check, Sun, Moon, MonitorSmartphone } from 'lucide-react';

// ─── Context for open/close ──────────────────────────────────

const ThemePickerContext = createContext({ open: () => {}, isOpen: false });

export function useThemePicker() {
  return useContext(ThemePickerContext);
}

// ─── Provider (keyboard shortcut + state) ────────────────────

export function ThemePickerProvider({ children }) {
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  // ── Two-chord shortcut: Ctrl+K  Ctrl+T ────────────────────
  useEffect(() => {
    let waitingForT = false;
    let timer = null;

    const onKeyDown = (e) => {
      const ctrl = e.ctrlKey || e.metaKey;

      if (waitingForT && ctrl && e.key.toLowerCase() === 't') {
        e.preventDefault();
        e.stopPropagation();
        waitingForT = false;
        clearTimeout(timer);
        setIsOpen((prev) => !prev);
        return;
      }

      if (ctrl && e.key.toLowerCase() === 'k') {
        waitingForT = true;
        // Reset after 1.5 s if no second chord
        clearTimeout(timer);
        timer = setTimeout(() => { waitingForT = false; }, 1500);
        return;
      }

      // Any other key cancels the chord
      waitingForT = false;
      clearTimeout(timer);
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      clearTimeout(timer);
    };
  }, []);

  const ctx = useMemo(() => ({ open, isOpen }), [open, isOpen]);

  return (
    <ThemePickerContext.Provider value={ctx}>
      {children}
      {isOpen && <ThemePickerOverlay onClose={close} />}
    </ThemePickerContext.Provider>
  );
}

// ─── Type icon helper ───────────────────────────────────────

function ThemeTypeIcon({ type, className }) {
  switch (type) {
    case 'light': return <Sun className={cn('h-3.5 w-3.5', className)} />;
    case 'dark':  return <Moon className={cn('h-3.5 w-3.5', className)} />;
    default:      return <MonitorSmartphone className={cn('h-3.5 w-3.5', className)} />;
  }
}

// ─── Overlay ────────────────────────────────────────────────

function ThemePickerOverlay({ onClose }) {
  const dispatch = useAppDispatch();
  const themeList = useAppSelector(selectThemeList);
  const activeThemeId = useAppSelector(selectActiveThemeId);

  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const initialThemeRef = useRef(activeThemeId);

  // ── Filter themes ────────────────────────────────────────
  const filtered = useMemo(() => {
    if (!query.trim()) return themeList;
    const q = query.toLowerCase();
    return themeList.filter((t) =>
      t.name.toLowerCase().includes(q) ||
      t.id.toLowerCase().includes(q) ||
      (t._group && t._group.toLowerCase().includes(q))
    );
  }, [themeList, query]);

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIdx(filtered.length > 0 ? 0 : -1);
  }, [filtered]);

  // Auto-focus input
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // ── Preview on selection change ──────────────────────────
  useEffect(() => {
    if (selectedIdx >= 0 && selectedIdx < filtered.length) {
      dispatch(previewTheme(filtered[selectedIdx].id));
    }
  }, [selectedIdx, filtered, dispatch]);

  // ── Scroll selected item into view ───────────────────────
  useEffect(() => {
    if (selectedIdx < 0 || !listRef.current) return;
    const items = listRef.current.querySelectorAll('[data-theme-item]');
    items[selectedIdx]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  // ── Confirm selection ────────────────────────────────────
  const confirm = useCallback((themeId) => {
    dispatch(clearPreview());
    dispatch(setActiveTheme(themeId));
    onClose();
  }, [dispatch, onClose]);

  // ── Cancel (revert preview) ──────────────────────────────
  const cancel = useCallback(() => {
    dispatch(clearPreview());
    onClose();
  }, [dispatch, onClose]);

  // ── Keyboard navigation ──────────────────────────────────
  const onKeyDown = useCallback((e) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (selectedIdx >= 0 && selectedIdx < filtered.length) {
          confirm(filtered[selectedIdx].id);
        }
        break;
      case 'Escape':
        e.preventDefault();
        cancel();
        break;
      default:
        break;
    }
  }, [filtered, selectedIdx, confirm, cancel]);

  // ── Click outside to cancel ──────────────────────────────
  const backdropClick = useCallback((e) => {
    if (e.target === e.currentTarget) cancel();
  }, [cancel]);

  // ── Group headers ────────────────────────────────────────
  const grouped = useMemo(() => {
    const result = [];
    let lastGroup = null;
    for (let i = 0; i < filtered.length; i++) {
      const t = filtered[i];
      if (t._group !== lastGroup) {
        result.push({ type: 'header', label: t._group });
        lastGroup = t._group;
      }
      result.push({ type: 'theme', theme: t, filteredIdx: i });
    }
    return result;
  }, [filtered]);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-start justify-center pt-[15vh]"
      style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(2px)' }}
      onClick={backdropClick}
    >
      <div
        className="w-[420px] max-h-[60vh] flex flex-col rounded-lg overflow-hidden"
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-medium)',
          boxShadow: 'var(--shadow-dropdown)',
        }}
      >
        {/* Search input */}
        <div
          className="flex items-center gap-2 px-3 py-2"
          style={{ borderBottom: '1px solid var(--border-subtle)' }}
        >
          <Palette className="h-4 w-4 shrink-0" style={{ color: 'var(--accent-primary)' }} />
          <input
            ref={inputRef}
            type="text"
            placeholder="Select Color Theme (↑↓ to preview)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            className="flex-1 bg-transparent text-sm outline-none"
            style={{ color: 'var(--text-primary)', caretColor: 'var(--accent-primary)' }}
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        {/* Theme list */}
        <div ref={listRef} className="overflow-y-auto flex-1 py-1">
          {grouped.length === 0 && (
            <div className="px-4 py-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
              No themes match &ldquo;{query}&rdquo;
            </div>
          )}
          {grouped.map((item, i) => {
            if (item.type === 'header') {
              return (
                <div
                  key={`h-${item.label}`}
                  className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider"
                  style={{ color: 'var(--text-muted)' }}
                >
                  {item.label}
                </div>
              );
            }

            const { theme, filteredIdx } = item;
            const isSelected = filteredIdx === selectedIdx;
            const isActive = theme.id === activeThemeId;

            return (
              <div
                key={theme.id}
                data-theme-item
                className={cn(
                  'flex items-center gap-2 px-3 py-1.5 cursor-pointer text-sm transition-colors duration-75',
                  isSelected && 'ring-1 ring-inset'
                )}
                style={{
                  color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
                  background: isSelected
                    ? 'color-mix(in srgb, var(--accent-primary) 12%, transparent)'
                    : 'transparent',
                  ringColor: isSelected ? 'var(--accent-primary)' : undefined,
                }}
                onClick={() => confirm(theme.id)}
                onMouseEnter={() => {
                  setSelectedIdx(filteredIdx);
                }}
              >
                {/* Theme type icon */}
                <ThemeTypeIcon type={theme.type} className="shrink-0 opacity-60" />

                {/* Name */}
                <span className="flex-1 truncate">{theme.name}</span>

                {/* Source badge */}
                {theme.source === 'extension' && (
                  <span
                    className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded"
                    style={{
                      background: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)',
                      color: 'var(--text-muted)',
                    }}
                  >
                    ext
                  </span>
                )}
                {theme.source === 'user' && (
                  <span
                    className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded"
                    style={{
                      background: 'color-mix(in srgb, var(--accent-warning) 12%, transparent)',
                      color: 'var(--accent-warning)',
                    }}
                  >
                    user
                  </span>
                )}

                {/* Active checkmark */}
                {isActive && (
                  <Check className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--accent-primary)' }} />
                )}
              </div>
            );
          })}
        </div>

        {/* Footer hint */}
        <div
          className="flex items-center justify-between px-3 py-1.5 text-[10px]"
          style={{
            borderTop: '1px solid var(--border-subtle)',
            color: 'var(--text-dim)',
          }}
        >
          <span>↑↓ Navigate &middot; Enter Confirm &middot; Esc Cancel</span>
          <span>Ctrl+K Ctrl+T</span>
        </div>
      </div>
    </div>
  );
}
