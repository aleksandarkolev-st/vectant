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
  hydrateTheme,
} from '@/redux/themeSlice';
import {
  resolveTheme,
  applyThemeToDOM,
  generateMonacoTheme,
  generateTerminalTheme,
  generateShikiTheme,
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

  // Ref for Monaco instance (set by Editor on mount)
  const monacoRef = useRef(null);

  // ── Bootstrap: register built-ins + hydrate ───────────
  useEffect(() => {
    // Hydrate persisted theme preferences (activeThemeId)
    const prefs = loadThemePrefs();
    if (prefs) {
      dispatch(hydrateTheme(prefs));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Resolve theme synchronously during render ─────────
  // This ensures consumers see the new values immediately (not after useEffect)
  const resolvedTheme = useMemo(() => {
    const theme = resolveTheme(effectiveThemeId, allThemes, userOverrides);
    return (theme && theme.id) ? theme : null;
  }, [effectiveThemeId, allThemes, userOverrides]);

  const monacoTheme = useMemo(() => {
    return resolvedTheme ? generateMonacoTheme(resolvedTheme) : null;
  }, [resolvedTheme]);

  const terminalTheme = useMemo(() => {
    return resolvedTheme ? generateTerminalTheme(resolvedTheme) : null;
  }, [resolvedTheme]);

  const shikiTheme = useMemo(() => {
    return resolvedTheme ? generateShikiTheme(resolvedTheme) : null;
  }, [resolvedTheme]);

  // ── Apply to DOM (CSS vars + Monaco) after render ─────
  const applyCurrentTheme = useCallback(() => {
    if (!resolvedTheme) return;
    applyThemeToDOM(resolvedTheme, monacoRef.current, 'synthi-theme');
  }, [resolvedTheme]);

  useEffect(() => {
    applyCurrentTheme();
  }, [applyCurrentTheme]);

  // ── Context value (stable via useMemo) ────────────────
  const contextValue = useMemo(() => ({
    /** Set this ref when Monaco initialises so themes can be applied */
    monacoRef,
    /** The fully resolved theme object */
    resolvedTheme,
    /** Monaco IStandaloneThemeData for the current theme */
    monacoTheme,
    /** xterm.js ITheme for the current terminal */
    terminalTheme,
    /** Shiki theme registration object — used by chat / diff code blocks */
    shikiTheme,
    /** Force re-apply (call after Monaco ref is set, or after hot-edit) */
    reapply: applyCurrentTheme,
  }), [resolvedTheme, monacoTheme, terminalTheme, shikiTheme, applyCurrentTheme]);

  return (
    <ThemeContext.Provider value={contextValue}>
      {children}
    </ThemeContext.Provider>
  );
}
