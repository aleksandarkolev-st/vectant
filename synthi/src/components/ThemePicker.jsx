'use client';

/**
 * @fileoverview ThemePicker
 *
 * Full-screen overlay resembling a command palette; lists all available
 * themes in two columns — dark on the left, light on the right.
 *
 * Activation:
 *   - Ctrl+K  Ctrl+T  (two-chord shortcut, like VS Code)
 *   - Exposed via `useThemePicker()` hook for programmatic open
 *
 * Behaviour:
 *   - Type to filter themes by name
 *   - Arrow Up/Down navigates within a column; Left/Right switches column
 *   - Selection only highlights — the live UI does not preview on hover
 *   - HOLD RIGHT-CLICK on a row to preview that theme; the picker hides
 *     while held and the preview is reverted on release
 *   - Enter / left-click confirms; Escape cancels
 *   - Grouped within each column by source: Built-in → Extensions → User
 */

import { useState, useEffect, useRef, useCallback, createContext, useContext, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { useAppDispatch, useAppSelector } from '@/redux/hooks';
import {
  selectThemeList,
  selectActiveThemeId,
  selectUserThemes,
  setActiveTheme,
  deleteUserTheme,
  previewTheme,
  clearPreview,
} from '@/redux/themeSlice';
import { Palette, Check, Sun, Moon, MonitorSmartphone, Plus, Pencil, Trash2 } from 'lucide-react';
import { useThemeCreator } from '@/components/ThemeCreator';

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
  const userThemes = useAppSelector(selectUserThemes);
  const { openCreator } = useThemeCreator();

  const [query, setQuery] = useState('');
  // Start in the column that matches the currently active theme
  const [column, setColumn] = useState(() => {
    const active = themeList.find(t => t.id === activeThemeId);
    return active?.type === 'light' ? 'light' : 'dark';
  });
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [previewingThemeId, setPreviewingThemeId] = useState(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  // ── Filter themes by search query ────────────────────────
  const filtered = useMemo(() => {
    if (!query.trim()) return themeList;
    const q = query.toLowerCase();
    return themeList.filter((t) =>
      t.name.toLowerCase().includes(q) ||
      t.id.toLowerCase().includes(q) ||
      (t._group && t._group.toLowerCase().includes(q))
    );
  }, [themeList, query]);

  const darkThemes  = useMemo(() => filtered.filter(t => t.type !== 'light'), [filtered]);
  const lightThemes = useMemo(() => filtered.filter(t => t.type === 'light'), [filtered]);

  const currentList = column === 'dark' ? darkThemes : lightThemes;

  // Reset selection when the search filter changes
  useEffect(() => {
    const list = column === 'dark' ? darkThemes : lightThemes;
    setSelectedIdx(list.length > 0 ? 0 : -1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered]);

  // Auto-switch column if the current one is empty but the other has results
  useEffect(() => {
    if (column === 'dark' && darkThemes.length === 0 && lightThemes.length > 0) {
      setColumn('light');
      setSelectedIdx(0);
    } else if (column === 'light' && lightThemes.length === 0 && darkThemes.length > 0) {
      setColumn('dark');
      setSelectedIdx(0);
    }
  }, [darkThemes.length, lightThemes.length, column]);

  // Auto-focus the search input
  useEffect(() => { inputRef.current?.focus(); }, []);

  // Scroll selected row into view within its column
  useEffect(() => {
    if (selectedIdx < 0 || !listRef.current) return;
    const items = listRef.current.querySelectorAll(
      `[data-theme-item][data-column="${column}"]`
    );
    items[selectedIdx]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx, column]);

  // ── Right-click preview lifecycle ────────────────────────
  // While a preview is active, listen globally for mouse-up / window blur
  // to revert. We also clear on unmount so closing the picker mid-preview
  // never leaves a stale preview applied.
  useEffect(() => {
    if (!previewingThemeId) return;
    const stop = () => {
      dispatch(clearPreview());
      setPreviewingThemeId(null);
    };
    // While previewing, the overlay sets pointerEvents:'none', so the row's
    // onContextMenu handler no longer catches the release-time contextmenu
    // event — block it at the window in the capture phase instead.
    const blockContextMenu = (e) => e.preventDefault();
    window.addEventListener('mouseup', stop);
    window.addEventListener('blur', stop);
    window.addEventListener('contextmenu', blockContextMenu, true);
    return () => {
      window.removeEventListener('mouseup', stop);
      window.removeEventListener('blur', stop);
      window.removeEventListener('contextmenu', blockContextMenu, true);
    };
  }, [previewingThemeId, dispatch]);

  useEffect(() => () => { dispatch(clearPreview()); }, [dispatch]);

  const startPreview = useCallback((themeId) => {
    dispatch(previewTheme(themeId));
    setPreviewingThemeId(themeId);
  }, [dispatch]);

  // ── Confirm / cancel ─────────────────────────────────────
  const confirm = useCallback((themeId) => {
    dispatch(setActiveTheme(themeId));
    onClose();
  }, [dispatch, onClose]);

  const cancel = useCallback(() => { onClose(); }, [onClose]);

  const switchColumn = useCallback((target) => {
    const targetList = target === 'dark' ? darkThemes : lightThemes;
    if (targetList.length === 0) return;
    setColumn(target);
    setSelectedIdx(0);
    // Keep keyboard navigation alive when this is invoked from a header click.
    inputRef.current?.focus();
  }, [darkThemes, lightThemes]);

  // ── Keyboard navigation ──────────────────────────────────
  const onKeyDown = useCallback((e) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, currentList.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (column === 'dark') switchColumn('light');
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (column === 'light') switchColumn('dark');
        break;
      case 'Tab':
        e.preventDefault();
        switchColumn(column === 'dark' ? 'light' : 'dark');
        break;
      case 'Enter':
        e.preventDefault();
        if (selectedIdx >= 0 && selectedIdx < currentList.length) {
          confirm(currentList[selectedIdx].id);
        }
        break;
      case 'Escape':
        e.preventDefault();
        cancel();
        break;
      default:
        break;
    }
  }, [currentList, column, selectedIdx, switchColumn, confirm, cancel]);

  const backdropClick = useCallback((e) => {
    if (e.target === e.currentTarget) cancel();
  }, [cancel]);

  // ── Group themes by source within each column ────────────
  const groupByList = (list) => {
    const result = [];
    let lastGroup = null;
    list.forEach((t, idx) => {
      if (t._group !== lastGroup) {
        result.push({ type: 'header', label: t._group });
        lastGroup = t._group;
      }
      result.push({ type: 'theme', theme: t, idx });
    });
    return result;
  };

  const darkGrouped  = useMemo(() => groupByList(darkThemes),  [darkThemes]);
  const lightGrouped = useMemo(() => groupByList(lightThemes), [lightThemes]);

  // ── Render a single theme row ────────────────────────────
  const renderRow = (theme, idx, colName) => {
    const isSelected = column === colName && idx === selectedIdx;
    const isActive   = theme.id === activeThemeId;

    return (
      <div
        key={theme.id}
        data-theme-item
        data-column={colName}
        title="Hold right-click to preview"
        className={cn(
          'group flex items-center gap-2 px-3 py-1.5 cursor-pointer text-sm transition-colors duration-75',
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
        onContextMenu={(e) => e.preventDefault()}
        onMouseDown={(e) => {
          if (e.button === 2) {
            e.preventDefault();
            startPreview(theme.id);
          }
        }}
        onMouseEnter={() => {
          setColumn(colName);
          setSelectedIdx(idx);
        }}
      >
        <ThemeTypeIcon type={theme.type} className="shrink-0 opacity-60" />
        <span className="flex-1 truncate">{theme.name}</span>

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

        {theme.source === 'user' && (
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              className="p-1 rounded transition-colors"
              style={{ color: 'var(--text-muted)' }}
              title="Edit theme"
              onMouseEnter={(e) => {
                e.currentTarget.style.color = 'var(--text-primary)';
                e.currentTarget.style.background = 'color-mix(in srgb, var(--accent-primary) 15%, transparent)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--text-muted)';
                e.currentTarget.style.background = 'transparent';
              }}
              onClick={(e) => {
                e.stopPropagation();
                onClose();
                const fullTheme = userThemes[theme.id];
                if (fullTheme) setTimeout(() => openCreator(fullTheme), 50);
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              className="p-1 rounded transition-colors"
              style={{ color: 'var(--text-muted)' }}
              title="Delete theme"
              onMouseEnter={(e) => {
                e.currentTarget.style.color = 'var(--accent-danger, #ff5757)';
                e.currentTarget.style.background = 'color-mix(in srgb, var(--accent-danger, #ff5757) 12%, transparent)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--text-muted)';
                e.currentTarget.style.background = 'transparent';
              }}
              onClick={(e) => {
                e.stopPropagation();
                dispatch(deleteUserTheme(theme.id));
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {isActive && (
          <Check className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--accent-primary)' }} />
        )}
      </div>
    );
  };

  // ── Render one column (dark or light) ────────────────────
  const renderColumn = (groupedItems, list, colName, Icon, label) => {
    const isActiveCol = column === colName;
    return (
      <div
        className="flex-1 flex flex-col min-w-0"
        style={{ borderRight: colName === 'dark' ? '1px solid var(--border-subtle)' : undefined }}
      >
        <button
          type="button"
          onClick={() => switchColumn(colName)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider transition-colors text-left"
          style={{
            color: isActiveCol ? 'var(--accent-primary)' : 'var(--text-muted)',
            background: isActiveCol
              ? 'color-mix(in srgb, var(--accent-primary) 6%, transparent)'
              : 'transparent',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <Icon className="h-3 w-3" />
          <span>{label}</span>
          <span className="ml-auto opacity-60">{list.length}</span>
        </button>
        <div className="overflow-y-auto flex-1 py-1">
          {list.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
              No {label.toLowerCase()} themes
            </div>
          ) : (
            groupedItems.map((item, i) => {
              if (item.type === 'header') {
                return (
                  <div
                    key={`h-${colName}-${item.label}-${i}`}
                    className="px-3 pt-2 pb-1 text-[9px] font-semibold uppercase tracking-wider"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {item.label}
                  </div>
                );
              }
              return renderRow(item.theme, item.idx, colName);
            })
          )}
        </div>
      </div>
    );
  };

  const isPreviewing = previewingThemeId !== null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-start justify-center pt-[15vh]"
      style={{
        background: 'rgba(0,0,0,0.45)',
        backdropFilter: 'blur(2px)',
        opacity: isPreviewing ? 0 : 1,
        pointerEvents: isPreviewing ? 'none' : 'auto',
        transition: 'opacity 80ms ease-out',
      }}
      onClick={backdropClick}
    >
      <div
        className="w-[720px] max-h-[60vh] flex flex-col rounded-lg overflow-hidden"
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
            placeholder="Select Color Theme"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            className="flex-1 bg-transparent text-sm outline-none"
            style={{ color: 'var(--text-primary)', caretColor: 'var(--accent-primary)' }}
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        {/* Two-column body */}
        <div ref={listRef} className="flex flex-1 min-h-0 overflow-hidden">
          {renderColumn(darkGrouped,  darkThemes,  'dark',  Moon, 'Dark')}
          {renderColumn(lightGrouped, lightThemes, 'light', Sun,  'Light')}
        </div>

        {/* Create Theme button */}
        <div
          className="flex items-center justify-center px-3 py-2"
          style={{ borderTop: '1px solid var(--border-medium)' }}
        >
          <button
            className="flex items-center gap-1.5 px-4 py-1.5 rounded font-medium text-[11px] transition-colors w-full justify-center"
            style={{ color: 'white', background: 'var(--accent-primary)' }}
            onClick={() => {
              onClose();
              setTimeout(() => openCreator(), 50);
            }}
            title="Create a brand-new custom theme"
          >
            <Plus className="h-3.5 w-3.5" />
            Create Your Own Theme
          </button>
        </div>

        {/* Footer hints */}
        <div
          className="flex items-center justify-between gap-3 px-3 py-1 text-[10px]"
          style={{
            borderTop: '1px solid var(--border-subtle)',
            color: 'var(--text-muted)',
          }}
        >
          <span className="flex items-center gap-1 flex-wrap">
            <span>↑↓ Navigate &middot; ←→ Switch column &middot;</span>
            <span
              className="font-semibold px-1.5 py-0.5 rounded"
              style={{
                color: 'var(--accent-primary)',
                background: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)',
                border: '1px solid color-mix(in srgb, var(--accent-primary) 35%, transparent)',
              }}
            >
              Hold right-click to preview
            </span>
            <span>&middot; Enter Confirm &middot; Esc Cancel</span>
          </span>
          <span>Ctrl+K Ctrl+T</span>
        </div>
      </div>
    </div>
  );
}
