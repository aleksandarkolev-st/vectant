'use client';

/**
 * @fileoverview ThemeEditorPanel
 *
 * A docking-WM-compatible panel that allows users to edit theme
 * overrides for the current active theme. Uses a Monaco JSON editor
 * for the raw override, plus a visual colour-swatch grid for quick edits.
 *
 * The panel reads/writes to `themeSlice.userOverrides[activeThemeId]`.
 * Changes are applied live (instant preview) and saved on explicit action.
 *
 * Registered as the `theme-editor` panel in ide-panels.js.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAppDispatch, useAppSelector } from '@/redux/hooks';
import {
  selectActiveThemeId,
  selectAllThemes,
  selectUserOverrides,
  saveUserOverride,
  deleteUserOverride,
  openThemeEditor,
  closeThemeEditor,
  selectThemeEditorOpen,
  selectThemeEditorTarget,
} from '@/redux/themeSlice';
import { resolveTheme } from '@/lib/theme-engine';
import { UI_COLOR_KEYS, UI_CATEGORIES } from '@/themes/theme-schema';
import { cn } from '@/lib/utils';
import { Palette, RotateCcw, Save, Trash2, ChevronDown, ChevronRight } from 'lucide-react';

// ─── Colour swatch component ──────────────────────────────

function ColorSwatch({ label, value, onChange, cssVar }) {
  const inputRef = useRef(null);

  return (
    <div className="flex items-center gap-2 py-1 px-2 group rounded transition-colors"
      style={{ ':hover': { background: 'var(--bg-surface)' } }}
    >
      <button
        className="w-5 h-5 rounded border shrink-0 cursor-pointer"
        style={{
          background: value || 'transparent',
          borderColor: 'var(--border-medium)',
        }}
        title="Click to pick colour"
        onClick={() => inputRef.current?.click()}
      />
      <input
        ref={inputRef}
        type="color"
        value={value || '#000000'}
        onChange={(e) => onChange(e.target.value)}
        className="sr-only"
      />
      <div className="flex-1 min-w-0">
        <div className="text-xs truncate" style={{ color: 'var(--text-primary)' }}>
          {label}
        </div>
        <div className="text-[10px] font-mono truncate" style={{ color: 'var(--text-dim)' }}>
          {cssVar}
        </div>
      </div>
      <span className="text-[10px] font-mono tabular-nums" style={{ color: 'var(--text-muted)' }}>
        {value || '—'}
      </span>
    </div>
  );
}

// ─── Collapsible section ──────────────────────────────────

function Section({ title, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  const Icon = open ? ChevronDown : ChevronRight;

  return (
    <div>
      <button
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: 'var(--text-muted)' }}
        onClick={() => setOpen(!open)}
      >
        <Icon className="h-3 w-3" />
        {title}
      </button>
      {open && <div className="pb-2">{children}</div>}
    </div>
  );
}

// ─── Main Panel ───────────────────────────────────────────

export default function ThemeEditorPanel() {
  const dispatch = useAppDispatch();
  const activeThemeId = useAppSelector(selectActiveThemeId);
  const allThemes = useAppSelector(selectAllThemes);
  const userOverrides = useAppSelector(selectUserOverrides);

  const baseTheme = allThemes[activeThemeId];
  const currentOverride = userOverrides[activeThemeId] || {};
  const resolved = useMemo(
    () => resolveTheme(activeThemeId, allThemes, userOverrides),
    [activeThemeId, allThemes, userOverrides]
  );

  const [mode, setMode] = useState('visual'); // 'visual' | 'json'
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState(null);

  // Sync JSON text when override changes externally
  useEffect(() => {
    setJsonText(JSON.stringify(currentOverride, null, 2));
    setJsonError(null);
  }, [currentOverride]);

  // ── Visual mode: update a single UI colour ───────────────
  const setUIColor = useCallback((key, value) => {
    const newOverride = {
      ...currentOverride,
      ui: { ...currentOverride.ui, [key]: value },
    };
    dispatch(saveUserOverride({ baseThemeId: activeThemeId, override: newOverride }));
  }, [currentOverride, activeThemeId, dispatch]);

  // ── JSON mode: parse & save ──────────────────────────────
  const applyJSON = useCallback(() => {
    try {
      const parsed = JSON.parse(jsonText);
      setJsonError(null);
      dispatch(saveUserOverride({ baseThemeId: activeThemeId, override: parsed }));
    } catch (e) {
      setJsonError(e.message);
    }
  }, [jsonText, activeThemeId, dispatch]);

  // ── Reset overrides ──────────────────────────────────────
  const resetOverrides = useCallback(() => {
    dispatch(deleteUserOverride(activeThemeId));
  }, [activeThemeId, dispatch]);

  // ── Group UI keys by category ────────────────────────────
  const grouped = useMemo(() => {
    const groups = {};
    const catLabels = {};
    for (const cat of UI_CATEGORIES) {
      catLabels[cat.id] = cat.label;
    }
    for (const [key, meta] of Object.entries(UI_COLOR_KEYS)) {
      const cat = meta.category || 'other';
      if (!groups[cat]) groups[cat] = { label: catLabels[cat] || cat, keys: [] };
      groups[cat].keys.push({ key, ...meta });
    }
    return groups;
  }, []);

  if (!baseTheme) {
    return (
      <div className="h-full flex items-center justify-center text-xs" style={{ color: 'var(--text-muted)' }}>
        No active theme
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ background: 'var(--bg-sidebar)' }}>
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2 shrink-0"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <Palette className="h-4 w-4" style={{ color: 'var(--accent-primary)' }} />
        <span className="text-xs font-medium truncate flex-1" style={{ color: 'var(--text-primary)' }}>
          {baseTheme.name}
        </span>

        {/* Mode toggle */}
        <div
          className="flex text-[10px] rounded overflow-hidden"
          style={{ border: '1px solid var(--border-subtle)' }}
        >
          <button
            className={cn('px-2 py-0.5 transition-colors', mode === 'visual' && 'font-semibold')}
            style={{
              background: mode === 'visual' ? 'var(--accent-primary)' : 'transparent',
              color: mode === 'visual' ? 'white' : 'var(--text-muted)',
            }}
            onClick={() => setMode('visual')}
          >
            Visual
          </button>
          <button
            className={cn('px-2 py-0.5 transition-colors', mode === 'json' && 'font-semibold')}
            style={{
              background: mode === 'json' ? 'var(--accent-primary)' : 'transparent',
              color: mode === 'json' ? 'white' : 'var(--text-muted)',
            }}
            onClick={() => setMode('json')}
          >
            JSON
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {mode === 'visual' ? (
          /* ── Visual editor ── */
          <div className="py-1">
            {Object.entries(grouped).map(([category, { label: catLabel, keys }]) => (
              <Section
                key={category}
                title={catLabel}
                defaultOpen={category === 'background'}
              >
                {keys.map(({ key, css, label }) => (
                  <ColorSwatch
                    key={key}
                    label={label}
                    cssVar={css}
                    value={resolved?.ui?.[key] || ''}
                    onChange={(val) => setUIColor(key, val)}
                  />
                ))}
              </Section>
            ))}
          </div>
        ) : (
          /* ── JSON editor ── */
          <div className="h-full flex flex-col">
            <textarea
              className="flex-1 w-full p-3 font-mono text-xs resize-none outline-none"
              style={{
                background: 'var(--bg-editor)',
                color: 'var(--text-primary)',
                caretColor: 'var(--accent-primary)',
              }}
              value={jsonText}
              onChange={(e) => {
                setJsonText(e.target.value);
                setJsonError(null);
              }}
              spellCheck={false}
            />
            {jsonError && (
              <div className="px-3 py-1.5 text-[10px]" style={{ color: 'var(--accent-danger)' }}>
                {jsonError}
              </div>
            )}
            <div
              className="flex items-center gap-2 px-3 py-2 shrink-0"
              style={{ borderTop: '1px solid var(--border-subtle)' }}
            >
              <button
                className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors"
                style={{
                  background: 'var(--accent-primary)',
                  color: 'white',
                }}
                onClick={applyJSON}
              >
                <Save className="h-3 w-3" /> Apply
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div
        className="flex items-center gap-2 px-3 py-2 shrink-0"
        style={{ borderTop: '1px solid var(--border-subtle)' }}
      >
        <button
          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors"
          style={{ color: 'var(--accent-danger)' }}
          onClick={resetOverrides}
          title="Reset all overrides for this theme"
        >
          <RotateCcw className="h-3 w-3" /> Reset
        </button>
        <div className="flex-1" />
        <span className="text-[9px]" style={{ color: 'var(--text-dim)' }}>
          {Object.keys(currentOverride).length > 0 ? 'Has overrides' : 'No overrides'}
        </span>
      </div>
    </div>
  );
}
