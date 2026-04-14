'use client';

/**
 * @fileoverview useCompileManifestListener — ULTRAPLAN Phase 8.
 *
 * Listens for `synthi:compile-manifest` CustomEvents on the window and
 * dispatches them into the Redux `compileManifestSlice`. The event is
 * emitted by the compile client (compilerClient.js) when the Rust worker
 * surfaces the AI-synthesised build manifest + architecture cache over
 * the WebRTC data channel.
 *
 * Event payload shape (all fields optional — the hook no-ops on missing):
 *   {
 *     manifest:     { compiler, std, ..., confidence: {...} },
 *     architecture: "# Architecture\n## Language & Framework\n..." ,
 *     rejection:    { kind, message, detail }  // when compile was refused
 *   }
 *
 * Usage: mount this hook once at the top level of the workspace page so
 * it captures every compile-manifest update for the lifetime of the
 * session. It de-registers the listener on unmount.
 *
 * THE WORKER-SIDE EMITTER IS NOT YET WIRED. This hook is dormant until
 * the Rust worker is updated to forward the manifest + arch cache over
 * the WebRTC data channel — currently only compile-diagnostics and
 * hmr-status / hmr-update events flow through. When the worker starts
 * emitting `{type: "compile-manifest", manifest, architecture}` payloads,
 * add a case in `compilerClient.js` to dispatch the CustomEvent and this
 * hook lights up the whole UI with zero additional changes.
 *
 * Until then: the StatusBar framework pill, the CompileErrorCard, and
 * the ConfidenceWarning components are all in place but inert. They
 * read from the Redux slice which stays at its initial null state.
 * That's the intended Phase 8 shape — the frontend scaffolding is
 * complete and ready; the one-line bridge in compilerClient is pending.
 */

import { useEffect } from 'react';
import { useAppDispatch } from '@/redux/hooks';
import {
    setCompileManifest,
    setRejection,
    clearRejection,
} from '@/redux/compileManifestSlice';

export function useCompileManifestListener() {
    const dispatch = useAppDispatch();

    useEffect(() => {
        if (typeof window === 'undefined') return;

        const handler = (event) => {
            const detail = event?.detail;
            if (!detail || typeof detail !== 'object') return;

            // Rejection payloads (multi-step build, runner synthesis low,
            // manifest heal exhausted). These short-circuit the compile
            // and surface the 3-option error card.
            if (detail.rejection) {
                dispatch(setRejection(detail.rejection));
                return;
            }

            // Normal split response — clear any stale rejection and
            // stash the new manifest + arch cache.
            if (detail.manifest || detail.architecture) {
                dispatch(setCompileManifest({
                    manifest: detail.manifest || null,
                    architecture: detail.architecture || '',
                }));
                dispatch(clearRejection());
            }
        };

        window.addEventListener('synthi:compile-manifest', handler);
        return () => window.removeEventListener('synthi:compile-manifest', handler);
    }, [dispatch]);
}

export default useCompileManifestListener;
