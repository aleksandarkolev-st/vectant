'use client';

/**
 * @fileoverview ThemeProvider
 *
 * Top-level component that:
 *   1. Registers built-in themes on mount
 *   2. Hydrates persisted theme prefs from localStorage
 *   3. Subscribes to Redux (activeThemeId / previewThemeId) and
 *      applies the resolved theme to the DOM via the theme engine
 *   4. Exposes a context with the current Monaco theme ref so the
 *      Editor component can call defineTheme on mount
 *
 * Design decisions:
 *   - Renders no visible DOM (returns children only)
 *   - Uses requestAnimationFrame batching (inside theme-engine)
 *   - Stores a monacoRef that the Editor can set once Monaco loads
 */

import { createContext, useContext, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAppDispatch, useAppSelector } from '@/redux/hooks';
import {
  selectActiveThemeId,
  selectPreviewThemeId,
  selectAllThemes,
  selectUserOverrides,
  selectEffectiveThemeId,
  registerBuiltinThemes,
  hydrateTheme,
} from '@/redux/themeSlice';
import { BUILTIN_THEMES } from '@/themes/index';
import {
  resolveTheme,
  applyThemeToDOM,
  generateMonacoTheme,
  generateTerminalTheme,
} from '@/lib/theme-engine';
import { loadThemePrefs } from '@/redux/store';

// ─── Context ────────────────────────────────────────────────

const ThemeContext = createContext(null);

/**
 * Hook to access the theme context.
 *
 * Returns:
 *   - monacoRef: { current: monaco | null } — set by Editor on mount
 *   - resolvedTheme: the fully resolved current theme object
 *   - monacoTheme: the generated Monaco IStandaloneThemeData
 *   - terminalTheme: the generated xterm.js ITheme
 *   - reapply(): force re-apply the current theme (e.g. after Monaco loads)
 */
export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme() must be used inside <ThemeProvider>');
  }
  return ctx;
}

// ─── Provider ───────────────────────────────────────────────

export default function ThemeProvider({ children }) {
  const dispatch = useAppDispatch();

  // Selectors
  const effectiveThemeId = useAppSelector(selectEffectiveThemeId);
  const allThemes = useAppSelector(selectAllThemes);
  const userOverrides = useAppSelector(selectUserOverrides);

  // Refs that survive re-renders
  const monacoRef = useRef(null);
  const resolvedRef = useRef(null);
  const monacoThemeRef = useRef(null);
  const terminalThemeRef = useRef(null);

  // ── Bootstrap: register built-ins + hydrate ───────────
  useEffect(() => {
    // Register all bundled themes
    dispatch(registerBuiltinThemes(BUILTIN_THEMES));

    // Hydrate persisted theme preferences (activeThemeId)
    const prefs = loadThemePrefs();
    if (prefs) {
      dispatch(hydrateTheme(prefs));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Resolve & apply whenever effective theme changes ──
  const applyCurrentTheme = useCallback(() => {
    const theme = resolveTheme(effectiveThemeId, allThemes, userOverrides);
    if (!theme || !theme.id) return;

    resolvedRef.current = theme;
    monacoThemeRef.current = generateMonacoTheme(theme);
    terminalThemeRef.current = generateTerminalTheme(theme);

    // Apply to DOM (CSS vars + optionally Monaco)
    applyThemeToDOM(theme, monacoRef.current, 'synthi-theme');
  }, [effectiveThemeId, allThemes, userOverrides]);

  useEffect(() => {
    applyCurrentTheme();
  }, [applyCurrentTheme]);

  // ── Context value (stable via useMemo) ────────────────
  const contextValue = useMemo(() => ({
    /** Set this ref when Monaco initialises so themes can be applied */
    monacoRef,
    /** The fully resolved theme object */
    get resolvedTheme() { return resolvedRef.current; },
    /** Monaco IStandaloneThemeData for the current theme */
    get monacoTheme() { return monacoThemeRef.current; },
    /** xterm.js ITheme for the current terminal */
    get terminalTheme() { return terminalThemeRef.current; },
    /** Force re-apply (call after Monaco ref is set, or after hot-edit) */
    reapply: applyCurrentTheme,
  }), [applyCurrentTheme]);

  return (
    <ThemeContext.Provider value={contextValue}>
      {children}
    </ThemeContext.Provider>
  );
}
