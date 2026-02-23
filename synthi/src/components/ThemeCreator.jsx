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

  const openCreator = useCallback(() => setIsCreatorOpen(true), []);
  const closeCreator = useCallback(() => setIsCreatorOpen(false), []);

  const ctx = useMemo(
    () => ({ openCreator, isCreatorOpen }),
    [openCreator, isCreatorOpen],
  );

  return (
    <ThemeCreatorContext.Provider value={ctx}>
      {children}
      {isCreatorOpen && <ThemeCreatorOverlay onClose={closeCreator} />}
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

function ThemeCreatorOverlay({ onClose }) {
  const dispatch = useAppDispatch();
  const activeThemeId = useAppSelector(selectActiveThemeId);
  const allThemes = useAppSelector(selectAllThemes);
  const userOverrides = useAppSelector(selectUserOverrides);
  const { monacoRef, reapply } = useTheme();

  // ── State ─────────────────────────────────────────────
  const [themeType, setThemeType] = useState('dark');
  const [activeSection, setActiveSection] = useState('general');
  const [uiColors, setUiColors] = useState({});
  const [themeName, setThemeName] = useState('');
  const [nameError, setNameError] = useState(null);
  const [saveAttempted, setSaveAttempted] = useState(false);
  const [showUnfilled, setShowUnfilled] = useState(false);

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
    const themeId = `user-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const parentId = themeType === 'light' ? 'synthi-light' : 'synthi-dark';
    const newTheme = {
      id: themeId,
      name: themeName.trim(),
      type: themeType,
      source: 'user',
      parentThemeId: parentId,
      ui: { ...uiColors },
      editor: {},
      terminal: {},
      tokenColors: [],
      semanticTokenColors: {},
    };

    dispatch(saveUserTheme(newTheme));
    dispatch(setActiveTheme(themeId));
    onClose();
  }, [themeName, themeType, uiColors, dispatch, onClose]);

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
      <div
        className="w-[720px] max-h-[80vh] flex flex-col rounded-lg overflow-hidden"
        style={{
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
            Create Your Own Theme
          </span>

          {/* Theme type toggle */}
          <div
            className="flex text-[10px] rounded overflow-hidden ml-auto"
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
                  <SectionBadge filled={sc.filled} total={sc.total} />
                </button>
              );
            })}
          </div>

          {/* Right panel — colour inputs */}
          <div className="flex-1 overflow-y-auto">
            {currentSection && (
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
            )}
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
            <input
              type="text"
              value={themeName}
              onChange={(e) => {
                setThemeName(e.target.value);
                if (nameError) {
                  const result = validateThemeName(e.target.value);
                  setNameError(result.valid ? null : result.reason);
                }
              }}
              placeholder="My Awesome Theme"
              className="flex-1 px-2 py-1 text-xs rounded border outline-none transition-colors"
              style={{
                background: 'var(--bg-editor)',
                borderColor: nameError ? 'var(--accent-danger)' : 'var(--border-subtle)',
                color: 'var(--text-primary)',
                caretColor: 'var(--accent-primary)',
              }}
              spellCheck={false}
              maxLength={48}
            />
          </div>
          {nameError && (
            <p className="text-[10px] mt-1 ml-[84px]" style={{ color: 'var(--accent-danger)' }}>
              {nameError}
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
              Save Theme
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
