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
  resolveNLS,
} from '@/extensions/loader/ExtensionInstaller';
import { registerExtensionGrammars } from '@/extensions/loader/GrammarRegistrar';
import { initLspRegistry, registerLspForExtension, unregisterLspForExtension } from '@/services/lspRegistry';
import { getCompilerClient } from '@/services/compilerClient';

/**
 * Best-effort NLS stripping for cached manifests that were persisted
 * before NLS resolution was implemented. Walks the object tree and replaces
 * any remaining %some.key.name% strings with a human-readable form derived
 * from the last segment of the key ("name" → "Name").
 */
function stripUnresolvedNLS(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === 'string') {
      const m = val.match(/^%([\w.]+)%$/);
      if (m) {
        // Take the last dot-segment and title-case it
        const segments = m[1].split('.');
        const last = segments[segments.length - 1] || m[1];
        obj[key] = last.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
      }
    } else if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        if (typeof val[i] === 'string') {
          const am = val[i].match(/^%([\w.]+)%$/);
          if (am) {
            const segs = am[1].split('.');
            const last = segs[segs.length - 1] || am[1];
            val[i] = last.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
          }
        } else if (typeof val[i] === 'object' && val[i]) {
          stripUnresolvedNLS(val[i]);
        }
      }
    } else {
      stripUnresolvedNLS(val);
    }
  }
}

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

  // Initialise the global LSP registry once
  useEffect(() => { initLspRegistry(); }, []);

  // Refs to hold the live extension system + MonacoBridge
  const systemRef = useRef(null);
  const monacoBridgeRef = useRef(null);
  const initPromiseRef = useRef(null);
  const disposedRef = useRef(false);

  // Track whether we've restored persisted extensions
  const restoredRef = useRef(false);

  // Track remote extension host connection
  const remoteHostConnectedRef = useRef(false);
  // Mutex: prevent overlapping connectRemoteHost attempts
  const connectingRemoteRef = useRef(false);

  // ─── Initialize the extension host worker ────────────────────
  const initSystem = useCallback(async () => {
    if (systemRef.current) return;
    // If a previous init is still in flight (e.g. React StrictMode re-mount),
    // wait for it instead of returning early. This prevents the .then() chain
    // from firing before the system is ready.
    if (initPromiseRef.current) {
      try { await initPromiseRef.current; } catch (_) {}
      return;
    }
    if (disposedRef.current) return;

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

        // Remote host → Redux state sync (for _rehydrateNodeOnlyExtensions)
        system.bridge.onExtensionStateChanged = (id, state, reason) => {
          dispatch(setExtensionState({ id, extensionState: state, reason }));
        };

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
            case 'updateWebview':
              // HTML content is set directly on the WebviewManager iframe (DOM).
              // No Redux dispatch needed — the WebviewPanelEmbed component
              // mounts the wrapper element and the iframe updates via srcdoc.
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

  // ─── Connect remote extension host via WebRTC ────────────────
  const connectRemoteHost = useCallback(async () => {
    console.log('[useExtensions] connectRemoteHost called', {
      alreadyConnected: remoteHostConnectedRef.current,
      connecting: connectingRemoteRef.current,
      hasBridge: !!systemRef.current?.bridge,
      hasSystem: !!systemRef.current,
      proxyState: systemRef.current?.bridge?.remoteProxy?.state,
      proxyReady: systemRef.current?.bridge?.remoteProxy?.ready,
    });

    // If we think we're connected but the proxy is actually dead, reset
    if (remoteHostConnectedRef.current) {
      const proxy = systemRef.current?.bridge?.remoteProxy;
      if (!proxy || proxy.state === 'terminated' || !proxy.ready) {
        console.warn('[useExtensions] connectRemoteHost: proxy is dead/missing, resetting for reconnect');
        remoteHostConnectedRef.current = false;
      } else {
        console.log('[useExtensions] connectRemoteHost: already connected and proxy alive, skipping');
        return;
      }
    }
    // Mutex — only one connection attempt at a time
    if (connectingRemoteRef.current) {
      console.log('[useExtensions] connectRemoteHost: another attempt in progress, skipping');
      return;
    }
    if (!systemRef.current?.bridge) {
      console.warn('[useExtensions] connectRemoteHost: no bridge yet, skipping');
      return;
    }

    connectingRemoteRef.current = true;
    try {
      const client = getCompilerClient();
      console.log('[useExtensions] connectRemoteHost: compilerClient', {
        hasClient: !!client,
        hasPc: !!client?.pc,
        connectionState: client?.pc?.connectionState,
      });
      if (!client?.pc || client.pc.connectionState !== 'connected') {
        // WebRTC not ready yet — will be called again when it connects
        console.warn('[useExtensions] connectRemoteHost: WebRTC not connected yet, will retry on event');
        return;
      }

      console.log('[useExtensions] connectRemoteHost: creating ext-host DataChannel...');
      const channel = client.createExtHostChannel();
      console.log('[useExtensions] connectRemoteHost: DataChannel created, label:', channel.label, 'readyState:', channel.readyState);

      // Wire a disconnect callback so we can reset the ref when the DC dies
      systemRef.current.bridge.onRemoteDisconnected = () => {
        console.warn('[useExtensions] Remote extension host disconnected (DC closed), resetting flag for reconnect');
        remoteHostConnectedRef.current = false;
        connectingRemoteRef.current = false;
        // Release the ext-host lock in case it's still held
        try { client.releaseExtHostLock(); } catch (_) {}
        // The next synthi:webrtc-connected event will trigger a new connectRemoteHost()
      };

      // Acquire ext-host lock: prevents reconnect() from tearing down the
      // SCTP transport while we're loading extensions over the DataChannel.
      client.acquireExtHostLock();
      try {
        await systemRef.current.bridge.connectRemoteHost(channel);

        // Verify the proxy is still alive after connectRemoteHost returns
        // (the DC may have died during _rehydrateNodeOnlyExtensions)
        const proxy = systemRef.current?.bridge?.remoteProxy;
        if (proxy && proxy.ready && proxy.state !== 'terminated') {
          remoteHostConnectedRef.current = true;
          console.log('[useExtensions] ✓ Remote extension host connected successfully');
        } else {
          console.warn('[useExtensions] Remote host connected but proxy is no longer alive, will retry');
          remoteHostConnectedRef.current = false;
        }
      } finally {
        client.releaseExtHostLock();
      }
    } catch (err) {
      console.warn('[useExtensions] Remote extension host connection failed:', err.message, err.stack);
      // Non-fatal — extensions will fall back to local worker stubs
    } finally {
      connectingRemoteRef.current = false;
    }
  }, []);

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

          // Best-effort NLS cleanup for cached manifests that were saved
          // before NLS resolution was implemented. Strips %key% wrappers and
          // humanises the last segment (e.g. %view.github.pr.name% → "Name").
          // Also detect if the manifest has unresolved placeholders and persist
          // the cleaned version so this doesn't repeat.
          const hadNlsPlaceholders = JSON.stringify(manifest).includes('"%');
          stripUnresolvedNLS(manifest);
          if (hadNlsPlaceholders) {
            try { await dbSave({ id: ext.id, manifest, code: ext.code, nodeCode: ext.nodeCode || null, enabled: true }); } catch (_) {}
          }

          // Register into Redux
          dispatch(registerExtRedux({ id: ext.id, manifest }));
          // Parse contribution points from manifest
          if (manifest.contributes) {
            dispatch(parseContributions({ extensionId: ext.id, contributes: manifest.contributes }));
          }
          // Register grammars/languages with Monaco
          try {
            await registerExtensionGrammars(manifest);
          } catch (_) {}
          // Register LSP mappings for extensions that have known language servers
          try {
            registerLspForExtension(ext.id, manifest);
          } catch (_) {}
          // Node-only extensions: skip the local worker entirely.
          // They'll be loaded on the remote Node.js host when WebRTC connects.
          // Also skip extensions whose browser bundle is too large for the web
          // worker — they'll hang during eval. Route to remote host instead.
          const isNodeOnly = manifest.main && !manifest.browser;
          const isTooLargeForWorker = ext.code && ext.code.length > 500_000 && (ext.nodeCode || manifest.main);

          if (isNodeOnly || isTooLargeForWorker) {
            if (isTooLargeForWorker && !isNodeOnly) {
              console.log(`[useExtensions] ${ext.id}: browser bundle too large (${ext.code.length} chars), routing to remote host`);
            }
            // Stash nodeCode so MainThreadBridge can send it to the remote host
            if (ext.nodeCode) manifest._nodeCode = ext.nodeCode;

            // Register in MainThreadBridge (stores info, but won't load into worker)
            systemRef.current.bridge.extensions.set(ext.id, {
              id: ext.id,
              name: manifest.name,
              displayName: manifest.displayName || manifest.name,
              version: manifest.version,
              isActive: false,
              failed: false,
              failedReason: null,
              activationEvents: manifest.activationEvents || [],
              violationCount: 0,
              manifest,
              code: ext.code,
              remote: false,
            });
            dispatch(setExtensionState({ id: ext.id, extensionState: 'pending-remote' }));
            console.log(`[useExtensions] ${ext.id}: Node-only, waiting for remote host`);

            // If the remote host is already connected, rehydrate immediately
            if (systemRef.current.bridge.remoteProxy?.isReady?.()) {
              console.log(`[useExtensions] ${ext.id}: remote host already connected, rehydrating now`);
              try {
                await systemRef.current.bridge._rehydrateNodeOnlyExtensions();
              } catch (rehydrateErr) {
                console.warn(`[useExtensions] ${ext.id}: rehydration failed:`, rehydrateErr.message);
              }
            }
            continue;
          }

          dispatch(setExtensionState({ id: ext.id, extensionState: 'loaded' }));

          // Load browser extension into worker
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

    // ── Post-restore rehydration ──────────────────────────────
    // If the remote host connected before or during restore, the initial
    // _rehydrateNodeOnlyExtensions call found zero extensions.  Now that
    // restore is done and pending-remote extensions are in bridge.extensions,
    // trigger rehydration again.
    try {
      if (systemRef.current?.bridge?.remoteProxy?.isReady?.()) {
        console.log('[useExtensions] Remote host is already connected, triggering post-restore rehydration');
        await systemRef.current.bridge._rehydrateNodeOnlyExtensions();
      }
    } catch (rehydrateErr) {
      console.warn('[useExtensions] Post-restore rehydration failed:', rehydrateErr.message);
    }
  }, [dispatch]);

  // ─── Auto-init on mount ──────────────────────────────────────
  useEffect(() => {
    // Reset disposed flag on (re-)mount so React StrictMode's
    // unmount→remount cycle doesn't permanently block init.
    disposedRef.current = false;

    initSystem().then(() => {
      console.log('[useExtensions] initSystem resolved');
      // Fire both in parallel — restorePersistedExtensions will trigger
      // rehydration itself if the remote host is already connected.
      connectRemoteHost().catch(() => {});
      restorePersistedExtensions();
    });

    // Listen for WebRTC connection to establish remote host
    const handleWebRTCConnect = () => {
      console.log('[useExtensions] synthi:webrtc-connected event received, connecting remote host');
      // The ext-host DC is pre-created as part of the SDP offer (no DCEP delay needed)
      connectRemoteHost().catch(() => {});
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('synthi:webrtc-connected', handleWebRTCConnect);
    }

    // ── Polling fallback: if both the event and the initSystem-based
    //    attempt missed each other (classic race), retry periodically
    //    until the remote host connects or we give up.
    let retryCount = 0;
    const MAX_RETRIES = 20; // ~20 × 3s = 60s
    const retryInterval = setInterval(() => {
      if (remoteHostConnectedRef.current || retryCount >= MAX_RETRIES) {
        clearInterval(retryInterval);
        if (!remoteHostConnectedRef.current && retryCount >= MAX_RETRIES) {
          console.warn('[useExtensions] Gave up trying to connect remote extension host after', MAX_RETRIES, 'retries');
        }
        return;
      }
      retryCount++;
      console.log(`[useExtensions] Polling retry #${retryCount} for remote extension host...`);
      connectRemoteHost().catch(() => {});
    }, 3000);

    return () => {
      disposedRef.current = true;
      remoteHostConnectedRef.current = false; // Reset so StrictMode re-mount reconnects
      connectingRemoteRef.current = false;
      clearInterval(retryInterval);
      if (typeof window !== 'undefined') {
        window.removeEventListener('synthi:webrtc-connected', handleWebRTCConnect);
      }
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

    // Extract nodeCode for the remote extension host (stashed on manifest by ExtensionSidebar)
    const nodeCode = parsed._nodeCode || null;

    // Persist to IndexedDB (include nodeCode for remote host)
    await dbSave({ id, manifest: parsed, code, nodeCode, enabled: true });

    // Register in Redux
    dispatch(registerExtRedux({ id, manifest: parsed }));
    // Parse contribution points from manifest
    if (parsed.contributes) {
      dispatch(parseContributions({ extensionId: id, contributes: parsed.contributes }));
    }
    // Register grammars/languages with Monaco (works even for Node-only extensions)
    try {
      await registerExtensionGrammars(parsed);
    } catch (grammarErr) {
      console.warn(`[useExtensions] Grammar registration failed for ${id}:`, grammarErr.message);
    }
    // Register LSP mappings for extensions with known language servers
    try {
      registerLspForExtension(id, parsed);
    } catch (_) {}
    // Node-only extensions: skip the worker, wait for remote host.
    // Also skip extensions whose browser bundle is too large for the web
    // worker (>500KB) — they hang during eval.
    const isNodeOnly = parsed.main && !parsed.browser;
    const isTooLargeForWorker = code && code.length > 500_000 && (nodeCode || parsed.main);
    if (isNodeOnly || isTooLargeForWorker) {
      if (isTooLargeForWorker && !isNodeOnly) {
        console.log(`[useExtensions] ${id}: browser bundle too large (${code.length} chars), routing to remote host`);
      }
      // Store in bridge so _rehydrateNodeOnlyExtensions can find it
      system.bridge.extensions.set(id, {
        id,
        name: parsed.name,
        displayName: parsed.displayName || parsed.name,
        version: parsed.version,
        isActive: false,
        failed: false,
        failedReason: null,
        activationEvents: parsed.activationEvents || [],
        violationCount: 0,
        manifest: parsed,
        code,
        remote: false,
      });
      dispatch(setExtensionState({ id, extensionState: 'pending-remote' }));
      console.log(`[useExtensions] ${id}: Node-only, waiting for remote host`);

      // If remote host is already connected, route immediately
      if (system.bridge.remoteProxy?.isReady?.()) {
        const client = getCompilerClient();
        try {
          client?.acquireExtHostLock?.();
          await system.bridge._rehydrateNodeOnlyExtensions();
        } catch (_) {
        } finally {
          client?.releaseExtHostLock?.();
        }
      }
      return { success: true, pendingRemote: true };
    }

    dispatch(setExtensionState({ id, extensionState: 'loaded' }));

    // Load browser extension into worker
    try {
      await system.registerExtension(id, parsed, code);
    } catch (loadErr) {
      // If this is a WebRTC transport error (DC closed during send), the
      // extension itself is fine — mark it pending-remote so it can retry
      // on the next remote host connection instead of showing as crashed.
      const msg = String(loadErr.message || '').toLowerCase();
      const isTransport = msg.includes('datachannel') || msg.includes('channel closed') ||
        msg.includes('disconnected') || msg.includes('failure to send') ||
        msg.includes('sctp') || msg.includes('transport');
      if (isTransport) {
        console.warn(`[useExtensions] registerExtension transport error for ${id}:`, loadErr.message);
        dispatch(setExtensionState({ id, extensionState: 'pending-remote' }));
        return { success: true, pendingRemote: true };
      }
      console.warn(`[useExtensions] registerExtension failed for ${id}:`, loadErr.message);
      dispatch(setExtensionState({ id, extensionState: 'crashed', reason: loadErr.message }));
      dispatch(pushError({
        extensionId: id,
        title: 'Load Failed',
        message: loadErr.message,
        severity: 'error',
      }));
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
        const msg = String(err.message || '').toLowerCase();
        const isTransport = msg.includes('datachannel') || msg.includes('channel closed') ||
          msg.includes('disconnected') || msg.includes('failure to send') ||
          msg.includes('sctp') || msg.includes('transport');
        dispatch(setExtensionState({
          id: extensionId,
          extensionState: isTransport ? 'pending-remote' : 'crashed',
          reason: isTransport ? undefined : err.message,
        }));
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
    // Unregister LSP mappings so the Editor stops trying to connect
    try { unregisterLspForExtension(extensionId); } catch (_) {}
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
