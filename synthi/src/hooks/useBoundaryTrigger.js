// src/hooks/useBoundaryTrigger.js
// ─────────────────────────────────────────────────────────────────────
// Intelligent, Syntax-Aware AI Trigger
//
// Instead of firing AI analysis on a dumb setTimeout after every keystroke,
// this hook evaluates the KEYSTROKE ITSELF to decide when to fire:
//
//  • EAGER fire on semantic boundaries: newline (\n), semicolons (;),
//    closing braces/parens (}, )), colons after declarations (:),
//    commas in argument lists, pipe operators (|>).
//
//  • AGGRESSIVE abort/debounce on continuous alphanumeric typing.
//    The user is mid-word — sending partial code to AI is wasteful.
//
//  • SHORT grace period (150ms) after a boundary character, giving the
//    user a chance to chain boundaries (e.g., `};\n`) into one request.
//
//  • ABORT in-flight requests when the user resumes typing after a boundary
//    before the request completes. This protects the backend from useless
//    compute and the frontend from stale network callbacks.
//
// Usage:
//   useBoundaryTrigger({
//     editorRef,
//     analyzeCallback,
//     enabled: true,
//     graceMs: 150,
//     fallbackMs: 3000,  // Max silence before forcing analysis anyway
//   });
// ─────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef } from 'react';

/**
 * Characters that represent semantic statement/expression boundaries.
 * When the user types one of these, they've likely completed a thought
 * and the code is in a meaningful state for analysis.
 */
const BOUNDARY_CHARS = new Set([
  '\n',    // newline — line/statement complete
  ';',     // semicollon — statement terminator (C, JS, Java, Rust, etc.)
  '}',     // closing brace — block/scope end
  ')',     // closing paren — expression/call end
  ']',     // closing bracket — array/index end
  ',',     // comma — argument/element complete
  ':',     // colon — Python/TS/JSON declaration, ternary
  '>',     // closing angle bracket — C++ template, JSX tag
]);

/**
 * Characters that indicate the user is mid-identifier: letters, digits,
 * underscores. These should aggressively debounce (delay) AI triggers.
 */
const ALPHANUMERIC_PATTERN = /^[a-zA-Z0-9_$]$/;

/**
 * @param {Object}  opts
 * @param {object}  opts.editorRef           – React ref to Monaco editor
 * @param {Function} opts.analyzeCallback    – () => Promise — the analyze fn
 * @param {boolean}  [opts.enabled=true]     – master toggle
 * @param {number}   [opts.graceMs=150]      – delay after boundary before firing
 * @param {number}   [opts.fallbackMs=3000]  – max idle time before forced fire
 * @param {number}   [opts.minContentLength=20]
 * @param {Function} [opts.onAbort]          – called when in-flight analysis is aborted
 */
export function useBoundaryTrigger({
  editorRef,
  analyzeCallback,
  enabled = true,
  graceMs = 150,
  fallbackMs = 3000,
  minContentLength = 20,
  onAbort,
} = {}) {
  const graceTimerRef = useRef(null);
  const fallbackTimerRef = useRef(null);
  const runningRef = useRef(false);
  const abortControllerRef = useRef(null);
  const mountedRef = useRef(true);
  const lastBoundaryTimeRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
      if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
      abortControllerRef.current?.abort();
    };
  }, []);

  // Abort any in-flight analysis (called when user resumes typing)
  const abortInFlight = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      onAbort?.();
    }
  }, [onAbort]);

  // Execute analysis with abort support
  const fireAnalysis = useCallback(async () => {
    if (!mountedRef.current || !enabled || !analyzeCallback) return;
    if (runningRef.current) return;

    const editor = editorRef?.current;
    if (!editor) return;

    const model = editor.getModel();
    if (!model) return;

    const content = model.getValue();
    if (!content || content.length < minContentLength) return;

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      runningRef.current = true;
      await analyzeCallback({ signal: controller.signal });
    } catch (err) {
      if (err?.name !== 'AbortError') {
        // swallow — the analyze function handles its own errors
      }
    } finally {
      runningRef.current = false;
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  }, [enabled, analyzeCallback, editorRef, minContentLength]);

  // Schedule analysis after grace period
  const scheduleGrace = useCallback(() => {
    if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
    graceTimerRef.current = setTimeout(() => {
      graceTimerRef.current = null;
      fireAnalysis();
    }, graceMs);
  }, [fireAnalysis, graceMs]);

  // Reset the fallback timer (max idle before forced fire)
  const resetFallback = useCallback(() => {
    if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
    fallbackTimerRef.current = setTimeout(() => {
      fallbackTimerRef.current = null;
      // Only fire if a grace fire hasn't already handled it
      if (!graceTimerRef.current) {
        fireAnalysis();
      }
    }, fallbackMs);
  }, [fireAnalysis, fallbackMs]);

  // Listen for editor content changes and evaluate the keystroke
  useEffect(() => {
    if (!enabled) return;

    const editor = editorRef?.current;
    if (!editor) return;

    const model = editor.getModel();
    if (!model) return;

    const disposable = model.onDidChangeContent((e) => {
      if (!e.changes || e.changes.length === 0) return;

      // Evaluate the last character of the last change
      const lastChange = e.changes[e.changes.length - 1];
      const insertedText = lastChange.text;

      if (!insertedText) {
        // Deletion — reset fallback, abort and wait
        abortInFlight();
        resetFallback();
        return;
      }

      const lastChar = insertedText[insertedText.length - 1];

      if (BOUNDARY_CHARS.has(lastChar)) {
        // ── BOUNDARY CHARACTER ──
        // The user just completed a semantic boundary. Schedule eager fire
        // after a short grace period (allows chaining boundaries like `};\n`).
        lastBoundaryTimeRef.current = Date.now();
        // Clear any fallback — grace will handle it sooner
        if (fallbackTimerRef.current) {
          clearTimeout(fallbackTimerRef.current);
          fallbackTimerRef.current = null;
        }
        scheduleGrace();
      } else if (ALPHANUMERIC_PATTERN.test(lastChar)) {
        // ── ALPHANUMERIC (mid-identifier) ──
        // User is typing a word. Abort any in-flight analysis (stale),
        // cancel any pending grace fire, and reset just the fallback.
        abortInFlight();
        if (graceTimerRef.current) {
          clearTimeout(graceTimerRef.current);
          graceTimerRef.current = null;
        }
        resetFallback();
      } else {
        // ── OTHER (spaces, operators like =, +, etc.) ──
        // Could be between identifiers. Just reset fallback.
        resetFallback();
      }
    });

    return () => disposable?.dispose();
  }, [enabled, editorRef, scheduleGrace, resetFallback, abortInFlight]);

  // Cancel all pending triggers
  const cancel = useCallback(() => {
    if (graceTimerRef.current) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
    }
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    abortInFlight();
  }, [abortInFlight]);

  return {
    cancel,
    isRunning: runningRef.current,
    abortInFlight,
  };
}
