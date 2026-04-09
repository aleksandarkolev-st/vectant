
/**
 * Client-side HMR Runtime
 * 
 * Implements the logic to receive updates, validate them, check for acceptance,
 * and apply them to the running application.
 *
 * IMPORTANT: This runtime handles browser-module HMR only (JS/CSS hot-swap
 * in the browser). It does NOT own native compiled-preview lifecycle (Rust,
 * C++, Java, etc.). Native preview lifecycle is managed by the preview-store
 * and the Rust-side HMR orchestrator.
 *
 * Use `isNativePreviewActive()` to check whether the active preview is
 * native-compiled. If true, this runtime should defer to the preview-store
 * for state management and avoid issuing full-page reloads.
 */

import { getPreviewState, isPreviewAlive } from '@/lib/preview-store';

/**
 * Returns true when a native compiled preview is active and this
 * browser-module HMR runtime should NOT own lifecycle decisions.
 */
export function isNativePreviewActive() {
    try {
        const state = getPreviewState();
        return isPreviewAlive(state.state);
    } catch {
        return false;
    }
}

export class HMRRuntime {
    constructor(options = {}) {
        this.modules = new Map(); // moduleId -> { factory, exports, parents, children, hot }
        this.currentHash = options.initialHash || null;
        this.status = 'idle'; // idle, check, prepare, ready, dispose, apply, abort, fail
        this.onReload = options.onReload || (() => {
            // Guard: do not full-page reload if a native preview is active.
            // The native preview lifecycle (preview-store) owns the reload path.
            if (isNativePreviewActive()) {
                console.log('[HMRRuntime] Skipping full-page reload — native preview is active');
                return;
            }
            window.location.reload();
        });
        this.onStatusChange = options.onStatusChange || (() => {});
    }

    /**
     * Register a module in the runtime.
     * Called when the bundle is initially executed.
     */
    registerModule(moduleId, factory, parents = []) {
        const moduleObj = {
            id: moduleId,
            factory,
            exports: {},
            parents: new Set(parents),
            children: new Set(),
            hot: this._createHotContext(moduleId),
            loaded: false
        };

        this.modules.set(moduleId, moduleObj);

        // Update parent-child relationships
        parents.forEach(parentId => {
            const parent = this.modules.get(parentId);
            if (parent) {
                parent.children.add(moduleId);
            }
        });

        return moduleObj;
    }

    /**
     * Execute a module.
     */
    require(moduleId) {
        const moduleObj = this.modules.get(moduleId);
        if (!moduleObj) {
            throw new Error(`Module ${moduleId} not found.`);
        }

        if (moduleObj.loaded) {
            return moduleObj.exports;
        }

        // Execute factory
        moduleObj.factory.call(moduleObj.exports, moduleObj, moduleObj.exports, this.require.bind(this));
        moduleObj.loaded = true;

        return moduleObj.exports;
    }

    /**
     * Create the `module.hot` API for a module.
     */
    _createHotContext(moduleId) {
        const runtime = this;
        return {
            accept: (dep, callback) => {
                const mod = runtime.modules.get(moduleId);
                if (!mod) return;
                
                if (!mod.acceptedDeps) mod.acceptedDeps = {};
                
                if (typeof dep === 'undefined') {
                    // Self-accept
                    mod.selfAccepted = true;
                } else if (typeof dep === 'string') {
                    mod.acceptedDeps[dep] = callback || (() => {});
                } else if (Array.isArray(dep)) {
                    dep.forEach(d => {
                        mod.acceptedDeps[d] = callback || (() => {});
                    });
                }
            },
            dispose: (callback) => {
                const mod = runtime.modules.get(moduleId);
                if (mod) {
                    mod.disposeHandler = callback;
                }
            },
            data: null, // Can be used to pass data between versions
            status: () => runtime.status,
        };
    }

    /**
     * Handle incoming HMR message from the server.
     */
    handleMessage(message) {
        console.log('[HMRRuntime] Handling message:', message);
        switch (message.type) {
            case 'hash':
                this._handleHashMessage(message.data);
                break;
            case 'ok':
                this._handleOkMessage();
                break;
            case 'update':
                // Handle both data-wrapped and flat payloads
                this._handleUpdateMessage(message.data || message);
                break;
            case 'reload':
                this.onReload();
                break;
            default:
                console.warn(`[HMR] Unknown message type: ${message.type}`);
        }
    }

    _handleHashMessage(hash) {
        console.log('[HMRRuntime] Hash update:', hash);
        // If we don't have a hash yet, set it.
        if (!this.currentHash) {
            this.currentHash = hash;
        }
        // If hash matches, we are good. If not, we might expect an update.
    }

    _handleOkMessage() {
        console.log('[HMRRuntime] System OK');
        // System is up to date
        this._setStatus('idle');
    }

    async _handleUpdateMessage(update) {
        console.log('[HMRRuntime] Processing update:', update);
        // update: { hash, modules: { [id]: factorySource }, manifest: [...] }
        
        if (this.status !== 'idle') {
            console.warn('[HMRRuntime] Cannot update, status is:', this.status);
            // Already updating or in a weird state
            return;
        }

        this._setStatus('check');

        // SAFETY: Validate update structure before processing
        if (!update || typeof update !== 'object') {
            console.error('[HMRRuntime] Invalid update payload - not an object');
            this._setStatus('fail');
            return;
        }

        // 1. Validate session hash (if provided in update to ensure continuity)
        // In this simple model, we just check if the update hash is different from current.
        if (update.hash === this.currentHash) {
            console.log('[HMRRuntime] Hash matches current, no update needed.');
            this._setStatus('idle');
            return;
        }

        // 2. Identify changed modules
        const changedModuleIds = update.modules ? Object.keys(update.modules) : [];
        if (changedModuleIds.length === 0) {
            console.log('[HMRRuntime] No modules in update, treating as signal-only update.');
            this.currentHash = update.hash;
            this._setStatus('idle');
            return;
        }

        // 3. Run acceptability check
        const outdatedModules = new Set();
        
        try {
            for (const moduleId of changedModuleIds) {
                const outdated = this._checkAcceptance(moduleId);
                if (!outdated) {
                    const isUI = this._isUIModule(moduleId);
                    const msg = isUI 
                        ? `UI module ${moduleId} (or its parents) does not accept updates.` 
                        : `Module ${moduleId} is not accepted.`;
                    throw new Error(msg);
                }
                outdated.forEach(m => outdatedModules.add(m));
            }
        } catch (err) {
            console.warn(`[HMR] Update failed: ${err.message}. Reloading...`);
            this._setStatus('fail');
            this.onReload();
            return;
        }

        // 4. Prepare
        this._setStatus('prepare');
        
        // 5. Dispose
        this._setStatus('dispose');
        const disposeData = {};
        
        // Sort outdated modules to dispose children before parents? 
        // Usually reverse order of execution or dependency graph.
        // For simplicity, we just iterate.
        for (const moduleId of outdatedModules) {
            const mod = this.modules.get(moduleId);
            if (mod && mod.disposeHandler) {
                try {
                    const data = {};
                    mod.disposeHandler(data);
                    disposeData[moduleId] = data;
                } catch (e) {
                    console.error(`[HMR] Error in dispose handler for ${moduleId}:`, e);
                }
            }
            // Mark as unloaded
            if (mod) mod.loaded = false;
        }

        // 6. Apply updates (replace factories)
        this._setStatus('apply');
        for (const [moduleId, newFactorySource] of Object.entries(update.modules)) {
            // In a real implementation, we'd eval the source or use a function constructor.
            // Here we assume newFactorySource is the function itself or we eval it.
            // For security/complexity, let's assume the server sends executable code or we use eval.
            // CAUTION: eval is dangerous. In a controlled dev environment it's acceptable.
            
            let newFactory;
            try {
                // SAFETY: Validate factory source before eval
                if (newFactorySource === null || newFactorySource === undefined) {
                    console.error(`[HMR] Null/undefined factory source for ${moduleId}, skipping`);
                    continue;
                }
                
                // Assuming newFactorySource is a string like "(module, exports, require) => { ... }"
                // Or it could be the function itself if passed in-memory.
                if (typeof newFactorySource === 'string') {
                    // SAFETY: Limit factory source size to prevent DoS
                    const MAX_FACTORY_SIZE = 5 * 1024 * 1024; // 5MB max
                    if (newFactorySource.length > MAX_FACTORY_SIZE) {
                        console.error(`[HMR] Factory source for ${moduleId} exceeds max size (${newFactorySource.length} > ${MAX_FACTORY_SIZE})`);
                        this._setStatus('fail');
                        return;
                    }
                    
                    let sourceToEval = newFactorySource.trim();
                    // If it doesn't look like a function, wrap it in a standard CJS factory
                    if (!sourceToEval.startsWith('(') && !sourceToEval.startsWith('function')) {
                        sourceToEval = `(function(module, exports, require) {\n${newFactorySource}\n})`;
                    }
                    // Wrap in parentheses to ensure it's treated as an expression
                    newFactory = (0, eval)(sourceToEval);
                    
                    // SAFETY: Verify eval produced a function
                    if (typeof newFactory !== 'function') {
                        console.error(`[HMR] Eval did not produce a function for ${moduleId}, got ${typeof newFactory}`);
                        continue;
                    }
                } else if (typeof newFactorySource === 'function') {
                    newFactory = newFactorySource;
                } else {
                    console.error(`[HMR] Invalid factory source type for ${moduleId}: ${typeof newFactorySource}`);
                    continue;
                }
            } catch (e) {
                console.error(`[HMR] Failed to compile update for ${moduleId}`, e);
                // Dispatch error event for UI feedback
                if (typeof window !== 'undefined') {
                    window.dispatchEvent(new CustomEvent('synthi:hmr-status', {
                        detail: {
                            status: 'compile-error',
                            module: moduleId,
                            error: e.message
                        }
                    }));
                }
                this._setStatus('fail');
                this.onReload();
                return;
            }

            const mod = this.modules.get(moduleId);
            if (mod) {
                mod.factory = newFactory;
                mod.hot.data = disposeData[moduleId] || null;
                // Reset exports
                mod.exports = {};
            } else {
                // New module
                this.registerModule(moduleId, newFactory);
            }
        }

        // 7. Re-invoke factories
        // We need to re-require the modules that accepted the update, 
        // or the ones that were outdated and are still required by others.
        
        const callbacks = [];

        // Helper to find callbacks
        const findCallbacks = () => {
             // For every outdated module, check its parents.
             // If a parent is NOT outdated, it must have accepted the dependency.
             for (const outdatedId of outdatedModules) {
                 const mod = this.modules.get(outdatedId);
                 if (!mod) continue;
                 
                 if (mod.parents) {
                     for (const parentId of mod.parents) {
                         if (!outdatedModules.has(parentId)) {
                             const parent = this.modules.get(parentId);
                             if (parent && parent.acceptedDeps && parent.acceptedDeps[outdatedId]) {
                                 callbacks.push(() => parent.acceptedDeps[outdatedId]([outdatedId]));
                             }
                         }
                     }
                 }
             }
        };
        
        findCallbacks();

        // Re-require all outdated modules
        for (const moduleId of outdatedModules) {
            try {
                this.require(moduleId);
            } catch(e) {
                console.error(`[HMR] Error re-executing ${moduleId}`, e);
                this._setStatus('fail');
                this.onReload();
                return;
            }
        }

        // Run callbacks
        callbacks.forEach(cb => {
            try {
                cb();
            } catch (e) {
                console.error("[HMR] Error in accept callback", e);
                this._setStatus('fail');
                this.onReload();
            }
        });

        this.currentHash = update.hash;
        this._setStatus('idle');
    }

    _checkAcceptance(startModuleId) {
        const outdated = new Set();
        const visited = new Set();

        const visit = (id) => {
            if (visited.has(id)) return false; // Cycle detected without acceptance
            visited.add(id);
            
            const mod = this.modules.get(id);
            if (!mod) return false;

            // If this is the start module and it accepts itself
            if (id === startModuleId && mod.selfAccepted) {
                outdated.add(id);
                return true;
            }

            // If we are bubbling up, this module is outdated unless a parent accepts it.
            outdated.add(id);

            if (mod.parents.size === 0) {
                return false; // Reached root
            }

            let allPathsCovered = true;
            for (const parentId of mod.parents) {
                const parent = this.modules.get(parentId);
                if (!parent) continue;

                // Does parent accept 'id'?
                if (parent.acceptedDeps && parent.acceptedDeps[id]) {
                    // Accepted by this parent. Path ends here.
                    continue;
                }

                // Parent does not accept. Parent becomes outdated.
                if (!visit(parentId)) {
                    allPathsCovered = false;
                    break;
                }
            }
            return allPathsCovered;
        };

        if (visit(startModuleId)) {
            return outdated;
        }
        return null;
    }

    _isUIModule(moduleId) {
        return /\.(jsx|tsx|css|scss)$/.test(moduleId) || moduleId.includes('/components/') || moduleId.includes('/ui/');
    }

    _setStatus(status) {
        this.status = status;
        this.onStatusChange(status);
    }
}
