'use client';

/**
 * Synthi Extension System - useExtensions Hook
 * 
 * Initializes the extension host worker, connects it to the Redux store,
 * restores persisted extensions from IndexedDB, and exposes a clean API
 * for components to interact with the extension system.
 * 
 * Usage:
 *   const { ready, extensions, errors, install, activate, executeCommand, ... } = useExtensions({
 *     editor,           // Monaco editor instance (optional, can be set later)
 *     workspaceId: slug
 *   });
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/redux/hooks';
import {
  setHostStatus,
  setHostError,
  registerExtension as registerExtRedux,
  setExtensionState,
  removeExtension as removeExtRedux,
  addCommand,
  pushError,
  dismissError,
  parseContributions,
  addWebviewPanel,
  removeWebviewPanel,
  setStatusBarItem,
  removeContributions,
  selectHostStatus,
  selectExtensionList,
  selectExtensionErrors,
  selectCommands,
  selectContributedContainers,
  selectContributedViews,
  selectWebviewPanels,
  selectStatusBarItems,
} from '@/redux/extensionSlice';

// Loader pipeline
import { parseManifest } from '@/extensions/loader/ManifestParser';
import {
  saveExtension as dbSave,
  getAllExtensions as dbGetAll,
  removeExtension as dbRemove,
  setExtensionEnabled as dbSetEnabled,
} from '@/extensions/loader/ExtensionInstaller';

/**
 * Worker URL — served from public folder.
 * We use the hardened worker by default for security.
 */
const DEFAULT_WORKER_URL = '/extension-host-worker-hardened.js';

export function useExtensions({ editor = null, workspaceId = 'default' } = {}) {
  const dispatch = useAppDispatch();
  const hostStatus = useAppSelector(selectHostStatus);
  const extensions = useAppSelector(selectExtensionList);
  const errors = useAppSelector(selectExtensionErrors);
  const commands = useAppSelector(selectCommands);
  const contributedContainers = useAppSelector(selectContributedContainers);
  const contributedViews = useAppSelector(selectContributedViews);
  const webviewPanels = useAppSelector(selectWebviewPanels);
  const statusBarItems = useAppSelector(selectStatusBarItems);

  // Tree data from extensions (viewId → items[])
  const [treeDataMap, setTreeDataMap] = useState({});

  // Refs to hold the live extension system + MonacoBridge
  const systemRef = useRef(null);
  const monacoBridgeRef = useRef(null);
  const initPromiseRef = useRef(null);
  const disposedRef = useRef(false);

  // Track whether we've restored persisted extensions
  const restoredRef = useRef(false);

  // ─── Initialize the extension host worker ────────────────────
  const initSystem = useCallback(async () => {
    if (systemRef.current || initPromiseRef.current || disposedRef.current) return;

    dispatch(setHostStatus('initializing'));

    try {
      const { initializeExtensionSystem } = await import('@/extensions');
      
      const promise = initializeExtensionSystem({
        workerUrl: DEFAULT_WORKER_URL,
        workspaceId,
        editor: editor || undefined,
      });
      initPromiseRef.current = promise;

      const system = await promise;
      if (disposedRef.current) {
        system.dispose();
        return;
      }

      systemRef.current = system;
      initPromiseRef.current = null;
      dispatch(setHostStatus('ready'));

      // Listen for events from the bridge
      if (system.bridge) {
        // Command registration events
        system.bridge.workerProxy?.on('registerCommand', (data) => {
          if (data?.commandId) dispatch(addCommand(data.commandId));
        });

        // Show message events → push as info/warning/error
        const origShowMessage = system.bridge.onShowMessage;
        system.bridge.onShowMessage = (type, message, options) => {
          origShowMessage?.(type, message, options);
          if (type === 'error') {
            dispatch(pushError({
              extensionId: 'system',
              title: 'Extension Error',
              message,
              severity: 'error',
            }));
          }
        };
      }

      // Wire contribution events (tree views, webviews, status bar)
      if (system.onContribution !== undefined) {
        system.onContribution = (type, payload) => {
          switch (type) {
            case 'treeData':
              setTreeDataMap(prev => ({ ...prev, [payload.viewId]: payload.data }));
              break;
            case 'createWebview':
              dispatch(addWebviewPanel({
                viewId: payload.viewId,
                viewType: payload.viewType,
                title: payload.title,
                extensionId: payload.extensionId,
              }));
              break;
            case 'disposeWebview':
              dispatch(removeWebviewPanel(payload.viewId));
              break;
            case 'setStatusBar':
              dispatch(setStatusBarItem({
                extensionId: 'system',
                text: payload.text,
                priority: 0,
              }));
              break;
          }
        };
      }

      return system;
    } catch (err) {
      initPromiseRef.current = null;
      console.error('[useExtensions] Init failed:', err);
      dispatch(setHostError(err.message));
      dispatch(pushError({
        extensionId: 'system',
        title: 'Extension Host Init Failed',
        message: err.message,
        severity: 'error',
        suggestion: 'Check that extension-host-worker-hardened.js exists in the public folder.',
      }));
    }
  }, [workspaceId, editor, dispatch]);

  // ─── Restore persisted extensions from IndexedDB ─────────────
  const restorePersistedExtensions = useCallback(async () => {
    if (restoredRef.current || !systemRef.current) return;
    restoredRef.current = true;

    try {
      const saved = await dbGetAll();
      for (const ext of saved) {
        if (!ext.enabled) continue;
        try {
          const { valid, manifest, errors: parseErrors } = parseManifest(ext.manifest);
          if (!valid) {
            console.warn(`[useExtensions] Skipping invalid persisted extension ${ext.id}:`, parseErrors);
            continue;
          }

          // Register into Redux
          dispatch(registerExtRedux({ id: ext.id, manifest }));
          // Parse contribution points from manifest
          if (manifest.contributes) {
            dispatch(parseContributions({ extensionId: ext.id, contributes: manifest.contributes }));
          }
          dispatch(setExtensionState({ id: ext.id, extensionState: 'loaded' }));

          // Load into worker
          await systemRef.current.registerExtension(ext.id, manifest, ext.code);
          dispatch(setExtensionState({ id: ext.id, extensionState: 'activating' }));

          // Activate
          const result = await systemRef.current.activateExtension(ext.id);
          dispatch(setExtensionState({
            id: ext.id,
            extensionState: result.success ? 'active' : 'crashed',
            reason: result.success ? undefined : 'Activation failed',
          }));
        } catch (err) {
          console.warn(`[useExtensions] Failed to restore extension ${ext.id}:`, err);
          dispatch(setExtensionState({
            id: ext.id,
            extensionState: 'crashed',
            reason: err.message,
          }));
        }
      }
    } catch (err) {
      console.warn('[useExtensions] Failed to load persisted extensions:', err);
    }
  }, [dispatch]);

  // ─── Auto-init on mount ──────────────────────────────────────
  useEffect(() => {
    initSystem().then(() => {
      restorePersistedExtensions();
    });

    return () => {
      disposedRef.current = true;
      if (systemRef.current) {
        systemRef.current.dispose();
        systemRef.current = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Reconnect Monaco when editor becomes available ──────────
  useEffect(() => {
    if (!editor || !systemRef.current) return;
    // The initializeExtensionSystem in index.js creates MonacoBridge
    // if editor was passed at init time. If it wasn't available then,
    // we need to connect it now.
    try {
      const { MonacoBridge } = require('@/extensions/bridge/MonacoBridge');
      if (!monacoBridgeRef.current && systemRef.current.bridge) {
        const mb = new MonacoBridge(systemRef.current.bridge);
        const monaco = editor._domElement?.ownerDocument?.defaultView?.monaco 
          || (typeof window !== 'undefined' ? window.monaco : null);
        if (monaco) {
          mb.init(monaco, editor);
          monacoBridgeRef.current = mb;
        }
      }
    } catch (e) {
      // MonacoBridge connection is optional — extensions still work for commands
      console.warn('[useExtensions] Could not attach MonacoBridge:', e.message);
    }
  }, [editor]);

  // ─── Public API ──────────────────────────────────────────────

  /**
   * Install an extension from code + manifest.
   * Persists to IndexedDB and activates immediately.
   */
  const install = useCallback(async (extensionId, manifest, code) => {
    const system = systemRef.current;
    if (!system) throw new Error('Extension host not ready');

    // Validate manifest
    const { valid, manifest: parsed, errors: parseErrors } = parseManifest(manifest, extensionId);
    if (!valid) {
      const msg = `Invalid manifest: ${parseErrors.join('; ')}`;
      dispatch(pushError({ extensionId, title: 'Install Failed', message: msg, severity: 'error' }));
      throw new Error(msg);
    }

    const id = parsed.__extensionId || extensionId;

    // Persist to IndexedDB
    await dbSave({ id, manifest: parsed, code, enabled: true });

    // Register in Redux
    dispatch(registerExtRedux({ id, manifest: parsed }));
    // Parse contribution points from manifest
    if (parsed.contributes) {
      dispatch(parseContributions({ extensionId: id, contributes: parsed.contributes }));
    }
    dispatch(setExtensionState({ id, extensionState: 'loaded' }));

    // Load into worker
    try {
      await system.registerExtension(id, parsed, code);
    } catch (loadErr) {
      console.warn(`[useExtensions] registerExtension failed for ${id}:`, loadErr.message);
      dispatch(setExtensionState({ id, extensionState: 'crashed', reason: loadErr.message }));
      dispatch(pushError({
        extensionId: id,
        title: 'Load Failed',
        message: loadErr.message,
        severity: 'error',
      }));
      // Still return a result so the UI knows what happened
      return { success: false, error: loadErr.message };
    }

    dispatch(setExtensionState({ id, extensionState: 'activating' }));

    // Activate
    try {
      const result = await system.activateExtension(id);
      dispatch(setExtensionState({
        id,
        extensionState: result.success ? 'active' : 'crashed',
        reason: result.success ? undefined : (result.error || 'Activation failed'),
      }));
      return result;
    } catch (err) {
      dispatch(setExtensionState({ id, extensionState: 'crashed', reason: err.message }));
      dispatch(pushError({
        extensionId: id,
        title: 'Activation Failed',
        message: err.message,
        severity: 'error',
      }));
      throw err;
    }
  }, [dispatch]);

  /**
   * Activate a registered (but not yet active) extension.
   */
  const activate = useCallback(async (extensionId) => {
    const system = systemRef.current;
    if (!system) throw new Error('Extension host not ready');

    dispatch(setExtensionState({ id: extensionId, extensionState: 'activating' }));

    try {
      const result = await system.activateExtension(extensionId);
      dispatch(setExtensionState({
        id: extensionId,
        extensionState: result.success ? 'active' : 'crashed',
        reason: result.success ? undefined : 'Activation failed',
      }));
      return result;
    } catch (err) {
      dispatch(setExtensionState({ id: extensionId, extensionState: 'crashed', reason: err.message }));
      throw err;
    }
  }, [dispatch]);

  /**
   * Execute a command registered by an extension.
   */
  const executeCommand = useCallback(async (commandId, ...args) => {
    const system = systemRef.current;
    if (!system) throw new Error('Extension host not ready');
    return system.executeCommand(commandId, ...args);
  }, []);

  /**
   * Enable a previously disabled extension.
   */
  const enable = useCallback(async (extensionId) => {
    await dbSetEnabled(extensionId, true);
    dispatch(setExtensionState({ id: extensionId, extensionState: 'installed' }));
    // Re-activate
    const saved = await (await import('@/extensions/loader/ExtensionInstaller')).getExtension(extensionId);
    if (saved && systemRef.current) {
      try {
        await systemRef.current.registerExtension(extensionId, saved.manifest, saved.code);
        const result = await systemRef.current.activateExtension(extensionId);
        dispatch(setExtensionState({
          id: extensionId,
          extensionState: result.success ? 'active' : 'crashed',
        }));
      } catch (err) {
        dispatch(setExtensionState({ id: extensionId, extensionState: 'crashed', reason: err.message }));
      }
    }
  }, [dispatch]);

  /**
   * Disable an extension (keeps it installed but deactivated).
   */
  const disable = useCallback(async (extensionId) => {
    const system = systemRef.current;
    if (system) {
      try { await system.bridge?.deactivateExtension(extensionId); } catch (_) {}
    }
    await dbSetEnabled(extensionId, false);
    dispatch(setExtensionState({ id: extensionId, extensionState: 'disabled' }));
  }, [dispatch]);

  /**
   * Uninstall an extension completely.
   */
  const uninstall = useCallback(async (extensionId) => {
    const system = systemRef.current;
    if (system) {
      try { await system.bridge?.deactivateExtension(extensionId); } catch (_) {}
    }
    await dbRemove(extensionId);
    dispatch(removeExtRedux(extensionId));
  }, [dispatch]);

  /**
   * Restart a single extension.
   */
  const restart = useCallback(async (extensionId) => {
    const system = systemRef.current;
    if (!system) return;
    try {
      await system.bridge?.deactivateExtension(extensionId);
    } catch (_) {}

    dispatch(setExtensionState({ id: extensionId, extensionState: 'activating' }));

    try {
      const result = await system.activateExtension(extensionId);
      dispatch(setExtensionState({
        id: extensionId,
        extensionState: result.success ? 'active' : 'crashed',
      }));
    } catch (err) {
      dispatch(setExtensionState({ id: extensionId, extensionState: 'crashed', reason: err.message }));
    }
  }, [dispatch]);

  /**
   * Get system metrics (scheduler, memory, typing latency, etc.)
   */
  const getMetrics = useCallback(() => {
    return systemRef.current?.getMetrics() ?? null;
  }, []);

  /**
   * Dismiss an error by index.
   */
  const handleDismissError = useCallback((index) => {
    dispatch(dismissError(index));
  }, [dispatch]);

  return {
    // Status
    ready: hostStatus === 'ready',
    hostStatus,
    
    // Data (from Redux, always fresh)
    extensions,
    errors,
    commands,

    // Contribution points from extensions
    contributedContainers,
    contributedViews,
    webviewPanels,
    statusBarItems,
    treeDataMap,

    // WebviewManager instance (for rendering webview iframes)
    webviewManager: systemRef.current?.webviews || null,

    // Actions
    install,
    activate,
    executeCommand,
    enable,
    disable,
    uninstall,
    restart,
    getMetrics,
    dismissError: handleDismissError,

    // Raw system ref (for advanced use / debug panel)
    _systemRef: systemRef,
  };
}

export default useExtensions;
