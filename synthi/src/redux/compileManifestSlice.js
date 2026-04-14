// src/redux/compileManifestSlice.js
//
// ULTRAPLAN Phase 8 — Redux state for the latest AI-synthesised build
// manifest + architecture cache for the current compile session.
//
// Populated by the compile client whenever a /refactor/split/verified
// response arrives. Consumed by:
//   - StatusBar.jsx — displays the project's detected "Language & Framework"
//   - ConfidenceWarning.jsx — shows a pre-compile nudge on medium confidence
//   - CompileErrorCard.jsx — surfaces the 3-option error card on rejection
//
// The slice is INTENTIONALLY loose about shape: it holds the raw JSON
// the worker/ai-engine produced, plus a couple of derived pre-parsed
// fields for convenience (language/framework name, confidence levels).
// Parsing lives in `parseLanguageAndFramework` below — a simple regex
// over the arch cache markdown.

import { createSlice } from '@reduxjs/toolkit';

const initialState = {
    /// Full manifest JSON as it came back from the AI-engine. Shape
    /// matches `ai-backend/ai-engine/build_manifest.py::BuildManifest`.
    /// May be null if the project predates the universal split prompt
    /// or the response didn't contain a manifest.
    manifest: null,
    /// Raw architecture-cache markdown string. Empty string if absent.
    architectureCache: '',
    /// Pre-parsed "Language & Framework" header content (one line).
    /// Extracted from the arch cache at dispatch time for O(1) access
    /// in StatusBar. Null when no arch cache or no header match.
    languageAndFramework: null,
    /// Active rejection, when the manifest was refused (multi-step
    /// build, low runner_synthesis confidence, heal exhausted, etc.).
    /// Shape: `{kind, message, detail}`. Null on happy path.
    rejection: null,
};

const compileManifestSlice = createSlice({
    name: 'compileManifest',
    initialState,
    reducers: {
        /// Called by the compile client when a fresh split response
        /// arrives. `payload` shape: `{manifest, architecture}`.
        /// Both fields optional — missing means "clear to null/empty".
        setCompileManifest: (state, action) => {
            const { manifest, architecture } = action.payload || {};
            state.manifest = manifest || null;
            state.architectureCache = architecture || '';
            state.languageAndFramework = parseLanguageAndFramework(architecture);
            // A successful split clears any stale rejection
            state.rejection = null;
        },
        /// Called when a manifest is rejected (multi-step, low confidence,
        /// heal exhausted). `payload` shape: `{kind, message, detail}`.
        setRejection: (state, action) => {
            state.rejection = action.payload;
        },
        /// Clear rejection (e.g. after the user dismisses the error card
        /// or retries a compile). Leaves manifest/arch alone.
        clearRejection: (state) => {
            state.rejection = null;
        },
        /// Nuclear reset — used when switching workspaces.
        resetCompileManifest: () => initialState,
    },
});

/// Parse the "## Language & Framework" section out of the arch cache
/// markdown. The universal split prompt instructs the AI to emit this
/// as one line like "C++ with SDL2" or "C++ with GLFW + OpenGL".
/// Returns null when the header is missing or the body is blank.
///
/// Generic — no library name lookup table. We take whatever the AI
/// wrote and display it verbatim.
export function parseLanguageAndFramework(architectureMd) {
    if (!architectureMd || typeof architectureMd !== 'string') return null;
    // Match `## Language & Framework\n<one or more non-blank lines>`.
    // Stop at the next `##` or end-of-string.
    const match = architectureMd.match(
        /##\s*Language\s*&\s*Framework\s*\n([\s\S]*?)(?=\n##|\n$|$)/i,
    );
    if (!match) return null;
    const body = match[1]
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('<!--'))
        .join(' ');
    return body || null;
}

export const {
    setCompileManifest,
    setRejection,
    clearRejection,
    resetCompileManifest,
} = compileManifestSlice.actions;

// Selectors
export const selectManifest = (state) => state.compileManifest?.manifest || null;
export const selectArchitectureCache = (state) =>
    state.compileManifest?.architectureCache || '';
export const selectLanguageAndFramework = (state) =>
    state.compileManifest?.languageAndFramework || null;
export const selectRejection = (state) => state.compileManifest?.rejection || null;
export const selectConfidence = (state) =>
    state.compileManifest?.manifest?.confidence || null;

export default compileManifestSlice.reducer;
