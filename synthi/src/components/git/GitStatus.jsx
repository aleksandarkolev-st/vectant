'use client';

/**
 * GitStatus — preserved import surface.
 *
 * Until Phase 5 of the Source Control redesign (see
 * docs/superpowers/specs/2026-05-21-source-control-vectant-redesign-design.md)
 * this file held a ~1620-line monolithic implementation of the
 * sidebar source-control panel.  The redesign decomposes it into
 * focused components under `./scm/`, with `SourceControlPanel` as
 * the entry point.
 *
 * This shim preserves the legacy import path so the workspace shell
 * (synthi/src/app/workspace/[slug]/page.jsx) doesn't have to change.
 * The previous implementation lives in git history if a future
 * caller needs to consult it.
 */

import { SourceControlPanel } from './scm/SourceControlPanel';

export const GitStatus = SourceControlPanel;
export default SourceControlPanel;
