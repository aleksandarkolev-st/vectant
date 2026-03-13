// src/hooks/useAIAutoAnalysis.js
// Auto-triggers AI analysis using SYNTAX-AWARE boundary detection.
//
// This replaces the old "dumb debounce" approach with intelligent keystroke
// evaluation via useBoundaryTrigger:
//
//  • EAGER fire on semantic boundaries (\n, ;, }, ), etc.)
//  • AGGRESSIVE abort on continuous alphanumeric typing (mid-word)
//  • ABORT in-flight requests when user resumes typing
//  • FALLBACK timer for max idle silence
//
// This makes the AI agent feel proactive — it detects issues at exactly the
// right moments without spamming the backend during continuous typing.
//
// Usage:
//   useAIAutoAnalysis({
//     editorRef,
//     analyzeCallback: aiHealing.analyze,
//     enabled: true,
//     fallbackMs: 3000,  // Max silence before forced analysis
//     graceMs: 150,      // Delay after boundary char
//   });

import { useCallback, useEffect, useRef } from 'react';
import { useBoundaryTrigger } from './useBoundaryTrigger';

/**
 * @param {Object}  opts
 * @param {object}  opts.editorRef       – React ref to Monaco editor
 * @param {Function} opts.analyzeCallback – () => Promise — the analyze function to call
 * @param {boolean} [opts.enabled=true]  – master toggle
 * @param {number}  [opts.debounceMs=3000] – (legacy) maps to fallbackMs
 * @param {number}  [opts.graceMs=150]   – delay after boundary character
 * @param {number}  [opts.fallbackMs]    – max silence before forced fire (defaults to debounceMs)
 * @param {number}  [opts.minContentLength=20] – skip analysis for tiny files
 * @param {boolean} [opts.skipWhileTyping=true] – (legacy, always true with boundary trigger)
 */
export function useAIAutoAnalysis({
  editorRef,
  analyzeCallback,
  enabled = true,
  debounceMs = 3000,
  graceMs = 150,
  fallbackMs,
  minContentLength = 20,
  skipWhileTyping = true,
} = {}) {
  // Use boundary trigger: fires eagerly on semantic boundaries,
  // debounces aggressively during continuous typing
  const { cancel, isRunning, abortInFlight } = useBoundaryTrigger({
    editorRef,
    analyzeCallback,
    enabled,
    graceMs,
    fallbackMs: fallbackMs ?? debounceMs,
    minContentLength,
  });

  return { cancel, isAutoRunning: isRunning };
}

