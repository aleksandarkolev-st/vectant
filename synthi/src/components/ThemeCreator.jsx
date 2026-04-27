'use client';

/**
 * @fileoverview ThemeCreator
 *
 * Full-screen overlay for creating a brand-new user theme.
 * Opened from the ThemePicker via the "Create Your Own Theme" button.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────────┐
 *   │  Header (title · type selector · progress)          │
 *   ├────────────┬────────────────────────────────────────┤
 *   │  Category  │  Colour inputs for the active section  │
 *   │  sidebar   │  (colour picker + hex input per key)   │
 *   │            │                                        │
 *   ├────────────┴────────────────────────────────────────┤
 *   │  Footer (Cancel · Save)                             │
 *   └─────────────────────────────────────────────────────┘
 *
 * Real-time preview: Every colour change is instantly applied
 * to the DOM via `applyThemeToDOM()`, so the IDE behind the
 * overlay reflects the work-in-progress theme.
 *
 * Cancel reverts to the previously active theme.
 */

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  createContext,
  useContext,
} from 'react';
import { cn } from '@/lib/utils';
import { useAppDispatch, useAppSelector } from '@/redux/hooks';
import {
  selectActiveThemeId,
  selectAllThemes,
  selectUserOverrides,
  saveUserTheme,
  setActiveTheme,
} from '@/redux/themeSlice';
import { useTheme } from '@/components/ThemeProvider';
import { BUILTIN_THEMES } from '@/themes/index';
import { applyThemeToDOM } from '@/lib/theme-engine';
import { UI_COLOR_KEYS } from '@/themes/theme-schema';
import {
  CREATOR_SECTIONS,
  CONTRAST_PAIRS,
  SHADOW_KEYS,
  getKeyMeta,
  countFilledKeys,
  getUnfilledKeys,
} from '@/lib/theme-creator-schema';
import { contrastRatio, getWcagLevel, formatRatio } from '@/lib/contrast-utils';
import { validateThemeName } from '@/lib/name-validator';
import {
  Palette,
  Sun,
  Moon,
  AlertTriangle,
  Check,
  X,
  Layout,
  PanelLeft,
  Code,
  PanelBottom,
  Type,
  Square,
  Sparkles,
  Braces,
  Component,
  BarChart3,
  Layers,
  Save,
  ChevronRight,
  Info,
  Wand2,
  Send,
  Loader2,
} from 'lucide-react';

// ─── Icon map for section icons ─────────────────────────────

const ICON_MAP = {
  Layout,
  PanelLeft,
  Code,
  PanelBottom,
  Type,
  Square,
  Sparkles,
  Braces,
  Component,
  BarChart3,
  Layers,
};

// ─── Context ────────────────────────────────────────────────

const ThemeCreatorContext = createContext({
  openCreator: () => {},
  isCreatorOpen: false,
});

export function useThemeCreator() {
  return useContext(ThemeCreatorContext);
}

// ─── Provider ───────────────────────────────────────────────

export function ThemeCreatorProvider({ children }) {
  const [isCreatorOpen, setIsCreatorOpen] = useState(false);
  const [editingTheme, setEditingTheme] = useState(null);

  const openCreator = useCallback((themeToEdit = null) => {
    setEditingTheme(themeToEdit);
    setIsCreatorOpen(true);
  }, []);
  const closeCreator = useCallback(() => {
    setIsCreatorOpen(false);
    setEditingTheme(null);
  }, []);

  const ctx = useMemo(
    () => ({ openCreator, isCreatorOpen }),
    [openCreator, isCreatorOpen],
  );

  return (
    <ThemeCreatorContext.Provider value={ctx}>
      {children}
      {isCreatorOpen && (
        <ThemeCreatorOverlay onClose={closeCreator} editingTheme={editingTheme} />
      )}
    </ThemeCreatorContext.Provider>
  );
}

// ─── Colour Input ───────────────────────────────────────────

function ColorInput({ colorKey, value, onChange, warning }) {
  const meta = getKeyMeta(colorKey);
  const isShadow = SHADOW_KEYS.has(colorKey);
  const pickerRef = useRef(null);

  if (!meta) return null;

  return (
    <div className="flex items-start gap-2 py-1.5 px-2 rounded transition-colors group">
      {/* Colour swatch / picker */}
      {!isShadow && (
        <>
          <button
            className="w-7 h-7 rounded border shrink-0 cursor-pointer transition-shadow hover:ring-2"
            style={{
              background: value || 'transparent',
              borderColor: value ? 'var(--border-medium)' : 'var(--border-focus)',
              ringColor: 'var(--accent-primary)',
            }}
            title="Click to pick colour"
            onClick={() => pickerRef.current?.click()}
          />
          <input
            ref={pickerRef}
            type="color"
            value={value || '#000000'}
            onChange={(e) => onChange(colorKey, e.target.value)}
            className="sr-only"
          />
        </>
      )}

      {/* Label + hex input */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
            {meta.label}
          </span>
          {warning && (
            <span title={warning.message} className="shrink-0">
              <AlertTriangle
                className="h-3 w-3"
                style={{ color: warning.level === 'fail' ? 'var(--accent-danger)' : 'var(--accent-warning)' }}
              />
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={value || ''}
            onChange={(e) => onChange(colorKey, e.target.value)}
            placeholder={isShadow ? '0 2px 8px rgba(0,0,0,0.6)' : '#000000'}
            className="flex-1 px-1.5 py-0.5 text-[11px] font-mono rounded border outline-none transition-colors"
            style={{
              background: 'var(--bg-editor)',
              borderColor: value ? 'var(--border-subtle)' : 'var(--border-focus)',
              color: 'var(--text-primary)',
              caretColor: 'var(--accent-primary)',
            }}
            spellCheck={false}
          />
          <span
            className="text-[9px] font-mono shrink-0 opacity-60"
            style={{ color: 'var(--text-dim)' }}
          >
            {meta.css}
          </span>
        </div>
        {/* Contrast info */}
        {warning && (
          <div
            className="text-[9px] mt-0.5"
            style={{ color: warning.level === 'fail' ? 'var(--accent-danger)' : 'var(--accent-warning)' }}
          >
            {warning.message}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Section Progress Badge ─────────────────────────────────

function SectionBadge({ filled, total }) {
  const complete = filled === total;
  return (
    <span
      className="text-[9px] tabular-nums px-1 py-0.5 rounded"
      style={{
        background: complete
          ? 'color-mix(in srgb, var(--accent-success) 15%, transparent)'
          : 'color-mix(in srgb, var(--accent-warning) 12%, transparent)',
        color: complete ? 'var(--accent-success)' : 'var(--accent-warning)',
      }}
    >
      {filled}/{total}
    </span>
  );
}

// ─── Main Overlay ───────────────────────────────────────────

function ThemeCreatorOverlay({ onClose, editingTheme = null }) {
  const dispatch = useAppDispatch();
  const activeThemeId = useAppSelector(selectActiveThemeId);
  const allThemes = useAppSelector(selectAllThemes);
  const userOverrides = useAppSelector(selectUserOverrides);
  const { monacoRef, reapply } = useTheme();

  const isEditing = !!editingTheme;

  // ── State ─────────────────────────────────────────────
  const [themeType, setThemeType] = useState(editingTheme?.type || 'dark');
  const [activeSection, setActiveSection] = useState('general');
  const [uiColors, setUiColors] = useState(editingTheme?.ui || {});
  const [themeName, setThemeName] = useState(editingTheme?.name || '');
  const [nameError, setNameError] = useState(null);
  const [saveAttempted, setSaveAttempted] = useState(false);
  const [showUnfilled, setShowUnfilled] = useState(false);
  const [aiChatOpen, setAiChatOpen] = useState(false);
  const [aiMessages, setAiMessages] = useState([]);
  const [aiInput, setAiInput] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const aiMessagesEndRef = useRef(null);

  // Store the theme that was active before the creator opened
  const initialThemeIdRef = useRef(activeThemeId);

  // ── Build the preview theme ───────────────────────────
  const previewTheme = useMemo(() => {
    const baseId = themeType === 'light' ? 'synthi-light' : 'synthi-dark';
    const base = BUILTIN_THEMES[baseId];
    if (!base) return null;
    return {
      ...base,
      id: '__theme-creator-preview__',
      name: themeName || 'New Theme',
      type: themeType,
      source: 'user',
      ui: { ...base.ui, ...uiColors },
    };
  }, [themeType, uiColors, themeName]);

  // ── Apply preview to DOM on every colour change ───────
  useEffect(() => {
    if (previewTheme) {
      applyThemeToDOM(previewTheme, monacoRef?.current, 'synthi-theme');
    }
  }, [previewTheme, monacoRef]);

  // ── Colour change handler ─────────────────────────────
  const handleColorChange = useCallback((key, value) => {
    setUiColors((prev) => ({ ...prev, [key]: value }));
  }, []);

  // ── Contrast warnings ─────────────────────────────────
  const contrastWarnings = useMemo(() => {
    const warnings = {};
    for (const pair of CONTRAST_PAIRS) {
      const bgVal = uiColors[pair.bg];
      const fgVal = uiColors[pair.fg];
      if (!bgVal || !fgVal) continue;
      // Skip shadow keys
      if (SHADOW_KEYS.has(pair.bg) || SHADOW_KEYS.has(pair.fg)) continue;

      const ratio = contrastRatio(bgVal, fgVal);
      if (ratio === null) continue;

      const level = getWcagLevel(ratio);
      if (ratio < pair.min) {
        const bgMeta = getKeyMeta(pair.bg);
        const fgMeta = getKeyMeta(pair.fg);
        const msg = `Low contrast (${formatRatio(ratio)}) with ${
          warnings[pair.fg] ? bgMeta?.label : bgMeta?.label
        } — minimum ${pair.min}:1 required`;

        // Attach warning to the foreground key (more actionable)
        if (!warnings[pair.fg] || ratio < (warnings[pair.fg]._ratio || Infinity)) {
          warnings[pair.fg] = {
            level: level === 'fail' ? 'fail' : 'warn',
            message: `Low contrast (${formatRatio(ratio)}) against "${bgMeta?.label || pair.bg}" — needs ${pair.min}:1`,
            _ratio: ratio,
          };
        }
        // Also flag the background key
        if (!warnings[pair.bg] || ratio < (warnings[pair.bg]._ratio || Infinity)) {
          warnings[pair.bg] = {
            level: level === 'fail' ? 'fail' : 'warn',
            message: `Low contrast (${formatRatio(ratio)}) against "${fgMeta?.label || pair.fg}" — needs ${pair.min}:1`,
            _ratio: ratio,
          };
        }
      }
    }
    return warnings;
  }, [uiColors]);

  // ── Completion stats ──────────────────────────────────
  const completion = useMemo(() => countFilledKeys(uiColors), [uiColors]);
  const unfilled = useMemo(
    () => (saveAttempted ? getUnfilledKeys(uiColors) : []),
    [uiColors, saveAttempted],
  );

  // Per-section completion
  const sectionCompletion = useMemo(() => {
    const map = {};
    for (const section of CREATOR_SECTIONS) {
      let filled = 0;
      for (const key of section.keys) {
        if (uiColors[key] && uiColors[key].trim()) filled++;
      }
      map[section.id] = { filled, total: section.keys.length };
    }
    return map;
  }, [uiColors]);

  // Per-section warning counts
  const sectionWarnings = useMemo(() => {
    const map = {};
    for (const section of CREATOR_SECTIONS) {
      let count = 0;
      for (const key of section.keys) {
        if (contrastWarnings[key]) count++;
      }
      if (count > 0) map[section.id] = count;
    }
    return map;
  }, [contrastWarnings]);

  // Full contrast report for the Contrast panel
  const contrastReport = useMemo(() => {
    const items = [];
    for (const pair of CONTRAST_PAIRS) {
      const bgVal = uiColors[pair.bg];
      const fgVal = uiColors[pair.fg];
      if (!bgVal || !fgVal) continue;
      if (SHADOW_KEYS.has(pair.bg) || SHADOW_KEYS.has(pair.fg)) continue;

      const ratio = contrastRatio(bgVal, fgVal);
      if (ratio === null) continue;

      const level = getWcagLevel(ratio);
      const bgMeta = getKeyMeta(pair.bg);
      const fgMeta = getKeyMeta(pair.fg);
      items.push({
        bg: pair.bg,
        fg: pair.fg,
        bgLabel: bgMeta?.label || pair.bg,
        fgLabel: fgMeta?.label || pair.fg,
        bgColor: bgVal,
        fgColor: fgVal,
        ratio,
        level,
        min: pair.min,
        pass: ratio >= pair.min,
      });
    }
    // Sort: failures first, then by ratio ascending
    items.sort((a, b) => {
      if (a.pass !== b.pass) return a.pass ? 1 : -1;
      return a.ratio - b.ratio;
    });
    return items;
  }, [uiColors]);

  // ── Cancel ────────────────────────────────────────────
  const handleCancel = useCallback(() => {
    // Revert the DOM to the previously active theme
    reapply();
    onClose();
  }, [reapply, onClose]);

  // ── Save ──────────────────────────────────────────────
  const handleSave = useCallback(() => {
    setSaveAttempted(true);

    // Validate name
    const nameResult = validateThemeName(themeName);
    if (!nameResult.valid) {
      setNameError(nameResult.reason);
      return;
    }
    setNameError(null);

    // Check all colours are filled
    const { complete } = countFilledKeys(uiColors);
    if (!complete) {
      setShowUnfilled(true);
      return;
    }

    // Build the final theme object
    const themeId = isEditing
      ? editingTheme.id
      : `user-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const parentId = themeType === 'light' ? 'synthi-light' : 'synthi-dark';
    // For new themes (incl. AI-generated ones), inherit the parent's
    // editor/terminal/tokenColors so the saved theme matches what the
    // live preview shows.  Empty blocks would let Monaco fall back to
    // its built-in defaults (e.g. blue selection on a green theme).
    const parent = isEditing ? null : (BUILTIN_THEMES[parentId] || null);
    const updatedTheme = {
      ...(isEditing ? editingTheme : {}),
      id: themeId,
      name: themeName.trim(),
      type: themeType,
      source: 'user',
      parentThemeId: parentId,
      ui: { ...uiColors },
      editor: isEditing
        ? (editingTheme.editor || {})
        : { ...(parent?.editor || {}) },
      terminal: isEditing
        ? (editingTheme.terminal || {})
        : { ...(parent?.terminal || {}) },
      tokenColors: isEditing
        ? (editingTheme.tokenColors || [])
        : [...(parent?.tokenColors || [])],
      semanticTokenColors: isEditing
        ? (editingTheme.semanticTokenColors || {})
        : { ...(parent?.semanticTokenColors || {}) },
    };

    dispatch(saveUserTheme(updatedTheme));
    dispatch(setActiveTheme(themeId));
    onClose();
  }, [themeName, themeType, uiColors, dispatch, onClose]);

  // ── AI theme generation ───────────────────────────────
  const handleAiGenerate = useCallback(async () => {
    const prompt = aiInput.trim();
    if (!prompt || aiLoading) return;

    setAiMessages((prev) => [...prev, { role: 'user', text: prompt }]);
    setAiInput('');
    setAiLoading(true);

    try {
      const res = await fetch('/api/theme-generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, themeType }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Request failed (${res.status})`);
      }

      const data = await res.json();
      const { colors, themeName: suggestedName } = data;

      // Apply all generated colors
      if (colors && typeof colors === 'object') {
        setUiColors((prev) => ({ ...prev, ...colors }));
      }
      // Apply suggested name if user hasn't set one
      if (suggestedName && !themeName.trim()) {
        setThemeName(suggestedName);
      }

      const filledCount = colors ? Object.keys(colors).length : 0;
      setAiMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: `Done! Applied ${filledCount} colours${suggestedName ? ` — named "${suggestedName}"` : ''}. You can refine any colour manually, or describe more changes.`,
        },
      ]);
    } catch (err) {
      setAiMessages((prev) => [
        ...prev,
        { role: 'assistant', text: `Error: ${err.message}` },
      ]);
    } finally {
      setAiLoading(false);
    }
  }, [aiInput, aiLoading, themeType, themeName, setUiColors, setThemeName]);

  // Scroll AI messages to bottom
  useEffect(() => {
    aiMessagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [aiMessages]);

  // ── Keyboard: Escape to cancel ────────────────────────
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [handleCancel]);

  // ── Active section data ───────────────────────────────
  const currentSection = CREATOR_SECTIONS.find((s) => s.id === activeSection);

  // ── Warning count ─────────────────────────────────────
  const warningCount = Object.keys(contrastWarnings).length;

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(3px)' }}
    >
      {/* Flex wrapper so the AI chat panel can sit beside the main overlay */}
      <div className="flex items-start gap-3">
      {/*
       * Scoped CSS variable overrides — pin the overlay to a known dark
       * palette so it stays readable regardless of the live theme preview
       * being applied to :root behind it.
       */}
      <div
        className="w-[720px] max-h-[80vh] flex flex-col rounded-lg overflow-hidden"
        style={{
          /* ── Pinned overlay palette ─────────────────── */
          '--bg-app':          '#08090d',
          '--bg-editor':       '#0c0d12',
          '--bg-sidebar':      '#070810',
          '--bg-panel':        '#101118',
          '--bg-surface':      '#14151d',
          '--bg-elevated':     '#1a1b24',
          '--border-subtle':   '#1a1b24',
          '--border-medium':   '#2a2b38',
          '--border-focus':    '#3a3b52',
          '--border-strong':   '#42445a',
          '--text-primary':    '#f4f5f8',
          '--text-secondary':  '#9ba2b8',
          '--text-muted':      '#5a6178',
          '--text-dim':        '#3d4256',
          '--accent-primary':  '#327464',
          '--accent-secondary':'#3d8b78',
          '--accent-tertiary': '#4a9e8a',
          '--accent-danger':   '#ff5757',
          '--accent-success':  '#4ade80',
          '--accent-warning':  '#fbbf24',
          '--shadow-dropdown': '0 4px 16px rgba(0, 0, 0, 0.7)',
          /* ── Standard styling ──────────────────────── */
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-medium)',
          boxShadow: 'var(--shadow-dropdown)',
        }}
      >
        {/* ─── Header ────────────────────────────────────── */}
        <div
          className="flex items-center gap-3 px-4 py-3 shrink-0"
          style={{ borderBottom: '1px solid var(--border-subtle)' }}
        >
          <Palette className="h-5 w-5" style={{ color: 'var(--accent-primary)' }} />
          <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            {isEditing ? 'Edit Theme' : 'Create Your Own Theme'}
          </span>

          {/* AI Generate button */}
          <button
            className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium transition-all ml-auto"
            style={{
              background: aiChatOpen
                ? 'var(--accent-primary)'
                : 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))',
              color: 'white',
              boxShadow: aiChatOpen ? 'none' : '0 0 8px rgba(50,116,100,0.3)',
            }}
            onClick={() => setAiChatOpen((v) => !v)}
          >
            <Wand2 className="h-3.5 w-3.5" />
            AI Generate
          </button>

          {/* Theme type toggle */}
          <div
            className="flex text-[10px] rounded overflow-hidden"
            style={{ border: '1px solid var(--border-subtle)' }}
          >
            <button
              className={cn('flex items-center gap-1 px-2.5 py-1 transition-colors')}
              style={{
                background: themeType === 'dark' ? 'var(--accent-primary)' : 'transparent',
                color: themeType === 'dark' ? 'white' : 'var(--text-muted)',
              }}
              onClick={() => setThemeType('dark')}
            >
              <Moon className="h-3 w-3" /> Dark
            </button>
            <button
              className={cn('flex items-center gap-1 px-2.5 py-1 transition-colors')}
              style={{
                background: themeType === 'light' ? 'var(--accent-primary)' : 'transparent',
                color: themeType === 'light' ? 'white' : 'var(--text-muted)',
              }}
              onClick={() => setThemeType('light')}
            >
              <Sun className="h-3 w-3" /> Light
            </button>
          </div>

          {/* Progress */}
          <div className="flex items-center gap-2 ml-2">
            <div
              className="w-24 h-1.5 rounded-full overflow-hidden"
              style={{ background: 'var(--bg-surface)' }}
            >
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${completion.total ? (completion.filled / completion.total) * 100 : 0}%`,
                  background: completion.complete ? 'var(--accent-success)' : 'var(--accent-primary)',
                }}
              />
            </div>
            <span className="text-[10px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
              {completion.filled}/{completion.total}
            </span>
          </div>

          {/* Warning badge */}
          {warningCount > 0 && (
            <div className="flex items-center gap-1">
              <AlertTriangle className="h-3.5 w-3.5" style={{ color: 'var(--accent-warning)' }} />
              <span className="text-[10px]" style={{ color: 'var(--accent-warning)' }}>
                {warningCount}
              </span>
            </div>
          )}
        </div>

        {/* ─── Body ──────────────────────────────────────── */}
        <div className="flex flex-1 overflow-hidden min-h-0">
          {/* Left sidebar — category list */}
          <div
            className="w-[180px] shrink-0 overflow-y-auto py-1"
            style={{ borderRight: '1px solid var(--border-subtle)' }}
          >
            {CREATOR_SECTIONS.map((section) => {
              const IconComponent = ICON_MAP[section.icon];
              const isActive = section.id === activeSection;
              const sc = sectionCompletion[section.id] || { filled: 0, total: 0 };
              const sectionWarnCount = sectionWarnings[section.id] || 0;

              return (
                <button
                  key={section.id}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition-colors',
                    isActive && 'font-medium',
                  )}
                  style={{
                    color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                    background: isActive
                      ? 'color-mix(in srgb, var(--accent-primary) 10%, transparent)'
                      : 'transparent',
                    borderLeft: isActive ? '2px solid var(--accent-primary)' : '2px solid transparent',
                  }}
                  onClick={() => setActiveSection(section.id)}
                >
                  {IconComponent && (
                    <IconComponent
                      className="h-3.5 w-3.5 shrink-0"
                      style={{ color: isActive ? 'var(--accent-primary)' : 'var(--text-muted)' }}
                    />
                  )}
                  <span className="flex-1 truncate">{section.label}</span>
                  {sectionWarnCount > 0 && (
                    <AlertTriangle
                      className="h-3 w-3 shrink-0"
                      style={{ color: 'var(--accent-warning)' }}
                      title={`${sectionWarnCount} contrast warning(s)`}
                    />
                  )}
                  <SectionBadge filled={sc.filled} total={sc.total} />
                </button>
              );
            })}

            {/* Contrast summary section */}
            <div
              className="mt-1 pt-1"
              style={{ borderTop: '1px solid var(--border-subtle)' }}
            >
              <button
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition-colors',
                  activeSection === '__contrast__' && 'font-medium',
                )}
                style={{
                  color: activeSection === '__contrast__' ? 'var(--text-primary)' : 'var(--text-secondary)',
                  background: activeSection === '__contrast__'
                    ? 'color-mix(in srgb, var(--accent-primary) 10%, transparent)'
                    : 'transparent',
                  borderLeft: activeSection === '__contrast__'
                    ? '2px solid var(--accent-primary)'
                    : '2px solid transparent',
                }}
                onClick={() => setActiveSection('__contrast__')}
              >
                <AlertTriangle
                  className="h-3.5 w-3.5 shrink-0"
                  style={{
                    color: activeSection === '__contrast__'
                      ? 'var(--accent-primary)'
                      : warningCount > 0
                        ? 'var(--accent-warning)'
                        : 'var(--text-muted)',
                  }}
                />
                <span className="flex-1 truncate">Contrast</span>
                {warningCount > 0 && (
                  <span
                    className="text-[9px] tabular-nums px-1 py-0.5 rounded"
                    style={{
                      background: 'color-mix(in srgb, var(--accent-danger) 15%, transparent)',
                      color: 'var(--accent-danger)',
                    }}
                  >
                    {warningCount}
                  </span>
                )}
                {warningCount === 0 && contrastReport.length > 0 && (
                  <Check
                    className="h-3 w-3 shrink-0"
                    style={{ color: 'var(--accent-success)' }}
                  />
                )}
              </button>
            </div>
          </div>

          {/* Right panel — colour inputs or contrast report */}
          <div className="flex-1 overflow-y-auto">
            {activeSection === '__contrast__' ? (
              /* ─── Contrast Summary Panel ─────────────── */
              <div className="p-3">
                <div className="mb-3">
                  <h3 className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                    Contrast Warnings
                  </h3>
                  <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    WCAG 2.1 contrast checks between background and text colour pairs.
                    Set both colours in a pair to see the evaluation.
                  </p>
                </div>

                {contrastReport.length === 0 && (
                  <div className="text-xs py-6 text-center" style={{ color: 'var(--text-muted)' }}>
                    Fill in colour pairs to see contrast evaluations.
                  </div>
                )}

                <div className="space-y-1">
                  {contrastReport.map((item, i) => (
                    <div
                      key={`${item.bg}-${item.fg}-${i}`}
                      className="flex items-center gap-2 px-2 py-1.5 rounded text-[11px]"
                      style={{
                        background: item.pass
                          ? 'transparent'
                          : 'color-mix(in srgb, var(--accent-danger) 5%, transparent)',
                      }}
                    >
                      {/* Colour swatches */}
                      <div className="flex shrink-0 -space-x-1">
                        <span
                          className="w-4 h-4 rounded border"
                          style={{ background: item.bgColor, borderColor: 'var(--border-medium)' }}
                        />
                        <span
                          className="w-4 h-4 rounded border"
                          style={{ background: item.fgColor, borderColor: 'var(--border-medium)' }}
                        />
                      </div>

                      {/* Labels */}
                      <span className="flex-1 truncate" style={{ color: 'var(--text-secondary)' }}>
                        {item.bgLabel} / {item.fgLabel}
                      </span>

                      {/* Ratio */}
                      <span
                        className="tabular-nums font-mono shrink-0"
                        style={{
                          color: item.pass ? 'var(--accent-success)' : 'var(--accent-danger)',
                        }}
                      >
                        {formatRatio(item.ratio)}
                      </span>

                      {/* Level badge */}
                      <span
                        className="text-[9px] uppercase px-1 py-0.5 rounded font-medium shrink-0"
                        style={{
                          background: item.pass
                            ? 'color-mix(in srgb, var(--accent-success) 15%, transparent)'
                            : 'color-mix(in srgb, var(--accent-danger) 15%, transparent)',
                          color: item.pass ? 'var(--accent-success)' : 'var(--accent-danger)',
                        }}
                      >
                        {item.level}
                      </span>

                      {/* Min required */}
                      <span
                        className="text-[9px] shrink-0"
                        style={{ color: 'var(--text-dim)' }}
                      >
                        min {item.min}:1
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : currentSection ? (
              /* ─── Normal colour inputs ──────────────── */
              <div className="p-3">
                {/* Section header */}
                <div className="mb-3">
                  <h3 className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {currentSection.label}
                  </h3>
                  <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    {currentSection.description}
                  </p>
                </div>

                {/* Colour inputs */}
                <div className="space-y-0.5">
                  {currentSection.keys.map((key) => (
                    <ColorInput
                      key={key}
                      colorKey={key}
                      value={uiColors[key] || ''}
                      onChange={handleColorChange}
                      warning={contrastWarnings[key]}
                    />
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {/* ─── Name Input ────────────────────────────────── */}
        <div
          className="px-4 py-2.5 shrink-0"
          style={{ borderTop: '1px solid var(--border-subtle)' }}
        >
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium shrink-0" style={{ color: 'var(--text-primary)' }}>
              Theme Name
            </label>
            <div className="flex-1 relative">
              <input
                type="text"
                value={themeName}
                onChange={(e) => {
                  const val = e.target.value;
                  setThemeName(val);
                  // Real-time AI name validation
                  if (val.trim().length > 0) {
                    const result = validateThemeName(val);
                    setNameError(result.valid ? null : result.reason);
                  } else {
                    setNameError(null);
                  }
                }}
                placeholder="My Awesome Theme"
                className="w-full px-2 py-1 text-xs rounded border outline-none transition-colors pr-7"
                style={{
                  background: 'var(--bg-editor)',
                  borderColor: nameError
                    ? 'var(--accent-danger)'
                    : themeName.trim() && !nameError
                      ? 'var(--accent-success)'
                      : 'var(--border-subtle)',
                  color: 'var(--text-primary)',
                  caretColor: 'var(--accent-primary)',
                }}
                spellCheck={false}
                maxLength={48}
              />
              {/* Validation indicator */}
              {themeName.trim().length > 0 && (
                <span className="absolute right-2 top-1/2 -translate-y-1/2">
                  {nameError ? (
                    <X className="h-3 w-3" style={{ color: 'var(--accent-danger)' }} />
                  ) : (
                    <Check className="h-3 w-3" style={{ color: 'var(--accent-success)' }} />
                  )}
                </span>
              )}
            </div>
          </div>
          {nameError && (
            <div className="flex items-center gap-1.5 mt-1 ml-[84px]">
              <AlertTriangle className="h-3 w-3 shrink-0" style={{ color: 'var(--accent-danger)' }} />
              <p className="text-[10px]" style={{ color: 'var(--accent-danger)' }}>
                {nameError}
              </p>
            </div>
          )}
          {themeName.trim().length > 0 && !nameError && (
            <p className="text-[10px] mt-1 ml-[84px]" style={{ color: 'var(--accent-success)' }}>
              Name approved by content filter
            </p>
          )}
        </div>

        {/* ─── Unfilled warning ──────────────────────────── */}
        {saveAttempted && !completion.complete && showUnfilled && (
          <div
            className="px-4 py-2 shrink-0 max-h-24 overflow-y-auto"
            style={{
              borderTop: '1px solid var(--border-subtle)',
              background: 'color-mix(in srgb, var(--accent-danger) 5%, transparent)',
            }}
          >
            <div className="flex items-center gap-1.5 mb-1">
              <AlertTriangle className="h-3 w-3" style={{ color: 'var(--accent-danger)' }} />
              <span className="text-[10px] font-medium" style={{ color: 'var(--accent-danger)' }}>
                All colours must be set before saving ({completion.total - completion.filled} remaining)
              </span>
              <button
                className="ml-auto text-[9px] underline"
                style={{ color: 'var(--text-muted)' }}
                onClick={() => setShowUnfilled(false)}
              >
                Dismiss
              </button>
            </div>
            <div className="flex flex-wrap gap-1">
              {unfilled.slice(0, 12).map((item) => (
                <button
                  key={item.key}
                  className="text-[9px] px-1.5 py-0.5 rounded"
                  style={{
                    background: 'color-mix(in srgb, var(--accent-danger) 10%, transparent)',
                    color: 'var(--accent-danger)',
                  }}
                  onClick={() => {
                    // Navigate to the section containing this key
                    const sec = CREATOR_SECTIONS.find((s) => s.keys.includes(item.key));
                    if (sec) setActiveSection(sec.id);
                  }}
                >
                  {item.label}
                </button>
              ))}
              {unfilled.length > 12 && (
                <span className="text-[9px] px-1" style={{ color: 'var(--text-muted)' }}>
                  +{unfilled.length - 12} more
                </span>
              )}
            </div>
          </div>
        )}

        {/* ─── Footer ────────────────────────────────────── */}
        <div
          className="flex items-center justify-between px-4 py-2.5 shrink-0"
          style={{ borderTop: '1px solid var(--border-subtle)' }}
        >
          <div className="flex items-center gap-1.5">
            <Info className="h-3 w-3" style={{ color: 'var(--text-dim)' }} />
            <span className="text-[10px]" style={{ color: 'var(--text-dim)' }}>
              Changes preview in real-time behind this window
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs transition-colors"
              style={{
                color: 'var(--text-secondary)',
                background: 'transparent',
              }}
              onClick={handleCancel}
            >
              <X className="h-3.5 w-3.5" />
              Cancel
            </button>
            <button
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors"
              style={{
                background: completion.complete && themeName.trim()
                  ? 'var(--accent-primary)'
                  : 'var(--bg-surface)',
                color: completion.complete && themeName.trim()
                  ? 'white'
                  : 'var(--text-muted)',
              }}
              onClick={handleSave}
            >
              <Save className="h-3.5 w-3.5" />
              {isEditing ? 'Update Theme' : 'Save Theme'}
            </button>
          </div>
        </div>
      </div>

      {/* ─── AI Chat Panel (slides in beside the overlay) ── */}
      {aiChatOpen && (
        <div
          className="w-[320px] max-h-[80vh] flex flex-col rounded-lg overflow-hidden shrink-0"
          style={{
            '--bg-app':          '#08090d',
            '--bg-editor':       '#0c0d12',
            '--bg-sidebar':      '#070810',
            '--bg-panel':        '#101118',
            '--bg-surface':      '#14151d',
            '--bg-elevated':     '#1a1b24',
            '--border-subtle':   '#1a1b24',
            '--border-medium':   '#2a2b38',
            '--border-focus':    '#3a3b52',
            '--border-strong':   '#42445a',
            '--text-primary':    '#f4f5f8',
            '--text-secondary':  '#9ba2b8',
            '--text-muted':      '#5a6178',
            '--text-dim':        '#3d4256',
            '--accent-primary':  '#327464',
            '--accent-secondary':'#3d8b78',
            '--accent-tertiary': '#4a9e8a',
            '--accent-danger':   '#ff5757',
            '--accent-success':  '#4ade80',
            '--accent-warning':  '#fbbf24',
            '--shadow-dropdown': '0 4px 16px rgba(0, 0, 0, 0.7)',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-medium)',
            boxShadow: 'var(--shadow-dropdown)',
          }}
        >
          {/* Panel header */}
          <div
            className="flex items-center gap-2 px-3 py-2.5 shrink-0"
            style={{ borderBottom: '1px solid var(--border-subtle)' }}
          >
            <Wand2 className="h-4 w-4" style={{ color: 'var(--accent-primary)' }} />
            <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
              AI Theme Generator
            </span>
            <button
              className="ml-auto p-0.5 rounded transition-colors"
              style={{ color: 'var(--text-muted)' }}
              onClick={() => setAiChatOpen(false)}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Messages area */}
          <div
            className="flex-1 overflow-y-auto px-3 py-2 space-y-2 min-h-0"
            style={{ background: 'var(--bg-app)' }}
          >
            {aiMessages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full gap-2 py-8">
                <Sparkles className="h-8 w-8" style={{ color: 'var(--border-focus)' }} />
                <p className="text-[11px] text-center leading-relaxed px-4" style={{ color: 'var(--text-muted)' }}>
                  Describe your ideal theme and the AI will generate all the colours for you.
                </p>
                <div className="flex flex-wrap gap-1 mt-1 justify-center">
                  {['Monokai inspired', 'Ocean breeze', 'Warm sunset', 'Minimal grayscale'].map((suggestion) => (
                    <button
                      key={suggestion}
                      className="text-[9px] px-2 py-0.5 rounded-full transition-colors"
                      style={{
                        border: '1px solid var(--border-subtle)',
                        color: 'var(--text-secondary)',
                        background: 'transparent',
                      }}
                      onClick={() => setAiInput(suggestion)}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {aiMessages.map((msg, i) => (
              <div
                key={i}
                className={cn(
                  'text-[11px] px-2.5 py-1.5 rounded-lg max-w-[90%] leading-relaxed',
                  msg.role === 'user' ? 'ml-auto' : 'mr-auto',
                )}
                style={{
                  background: msg.role === 'user' ? 'var(--accent-primary)' : 'var(--bg-surface)',
                  color: msg.role === 'user' ? 'white' : 'var(--text-secondary)',
                }}
              >
                {msg.text}
              </div>
            ))}
            {aiLoading && (
              <div className="flex items-center gap-2 px-2.5 py-1.5 mr-auto">
                <Loader2 className="h-3 w-3 animate-spin" style={{ color: 'var(--accent-primary)' }} />
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Generating theme…</span>
              </div>
            )}
            <div ref={aiMessagesEndRef} />
          </div>

          {/* Input area */}
          <div
            className="shrink-0 px-3 py-2.5"
            style={{ borderTop: '1px solid var(--border-subtle)' }}
          >
            <div
              className="flex items-center gap-2 rounded-md px-2.5 py-1.5"
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              <input
                className="flex-1 bg-transparent text-[11px] outline-none placeholder:opacity-40"
                style={{ color: 'var(--text-primary)' }}
                placeholder="Describe your theme…"
                value={aiInput}
                onChange={(e) => setAiInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    e.stopPropagation();
                    handleAiGenerate();
                  }
                }}
                disabled={aiLoading}
              />
              <button
                className="p-1 rounded transition-colors"
                style={{
                  color: aiInput.trim() && !aiLoading ? 'var(--accent-primary)' : 'var(--text-dim)',
                }}
                onClick={handleAiGenerate}
                disabled={!aiInput.trim() || aiLoading}
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}
      </div>{/* end flex wrapper */}
    </div>
  );
}
