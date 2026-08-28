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
import { useAppDispatch, useAppSelector, useAppStore } from '@/redux/hooks';
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
  selectViewsWelcome,
  setContextValue,
  selectContextValues,
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
import vscodeTunnelService from '@/services/vscodeTunnelService';
import { toast } from 'sonner';

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
  const store = useAppStore();
  const hostStatus = useAppSelector(selectHostStatus);
  const extensions = useAppSelector(selectExtensionList);
  const errors = useAppSelector(selectExtensionErrors);
  const commands = useAppSelector(selectCommands);
  const contributedContainers = useAppSelector(selectContributedContainers);
  const contributedViews = useAppSelector(selectContributedViews);
  const webviewPanels = useAppSelector(selectWebviewPanels);
  const statusBarItems = useAppSelector(selectStatusBarItems);
  const viewsWelcome = useAppSelector(selectViewsWelcome);
  const contextValues = useAppSelector(selectContextValues);

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

  // Track VS Code Server connection (Path A: real Extension Host)
  const vscodeServerConnectedRef = useRef(false);
  const connectingVSCodeServerRef = useRef(false);
  const vscodeServerSlugRef = useRef(null);
  // Auto-reconnect backoff budget for the VS Code Server. Declared here (with
  // the other VS Code Server refs) rather than next to its effect so the mount
  // effect's WebRTC-reconnect / tab-visible handlers can reset it — otherwise a
  // transient network suspension (ERR_NETWORK_IO_SUSPENDED) burns all 5 attempts
  // and the server stays dead until a full page reload.
  const reconnectAttemptRef = useRef(0);
  const lastWorkspaceIdRef = useRef(workspaceId);
  const contextValuesRef = useRef({});
  const lastAuthDeviceCodeRef = useRef(null);
  const lastAuthPromptAtRef = useRef(0);
  const lastAuthProviderRef = useRef(null);
  const lastAuthOpenUrlRef = useRef(null);
  const lastAuthCodePromptRef = useRef({ code: null, ts: 0 });
  const pendingAuthCallbackUrlRef = useRef(null);
  const authCallbackDeliveredRef = useRef(false);
  const [vscodeServerState, setVscodeServerState] = useState('disconnected');
  const [vscodeServerWorkspaceDir, setVscodeServerWorkspaceDir] = useState(null);

  const reconcileExplicitServerExtensions = useCallback(async (source = 'server-reconcile') => {
    const bridge = systemRef.current?.bridge;
    const proxy = bridge?.vscodeServerProxy;
    if (!bridge || !proxy?.isReady?.()) return 0;

    const [detailed, explicitInstalled] = await Promise.all([
      proxy.listExtensionsDetailed().catch((err) => {
        console.warn(`[useExtensions] ${source}: failed to list server extensions:`, err?.message || err);
        return [];
      }),
      dbGetAll().catch((err) => {
        console.warn(`[useExtensions] ${source}: failed to read persisted extensions:`, err?.message || err);
        return [];
      }),
    ]);

    const explicitInstallIds = new Set(
      explicitInstalled
        .filter((ext) => ext?.enabled !== false && typeof ext?.id === 'string')
        .map((ext) => ext.id)
    );
    if (explicitInstallIds.size === 0) return 0;

    const currentExtensions = store.getState()?.extensions?.extensions || {};
    let reconciled = 0;
    for (const { id: extId, manifest } of (detailed || [])) {
      if (!manifest || !explicitInstallIds.has(extId)) continue;

      stripUnresolvedNLS(manifest);

      if (!currentExtensions[extId]) {
        dispatch(registerExtRedux({ id: extId, manifest }));
      }
      if (manifest.contributes) {
        dispatch(parseContributions({ extensionId: extId, contributes: manifest.contributes }));
      }

      bridge.vscodeServerExtensions.add(extId);
      const info = bridge.extensions.get(extId);
      if (info) {
        info.isActive = true;
        info.remote = true;
        info.manifest = manifest;
        info.failed = false;
        info.failedReason = null;
      }
      dispatch(setExtensionState({ id: extId, extensionState: 'active', remote: true }));
      reconciled++;
    }

    if (reconciled > 0) {
      console.log(`[useExtensions] ${source}: reconciled ${reconciled} explicit server extension(s)`);
    }
    return reconciled;
  }, [dispatch, store]);

  const reportDeviceCode = useCallback((deviceCode, source = 'unknown') => {
    if (!deviceCode) return;

    const now = Date.now();
    const last = lastAuthCodePromptRef.current || { code: null, ts: 0 };
    if (last.code === deviceCode && (now - last.ts) < 15000) {
      return;
    }
    lastAuthCodePromptRef.current = { code: deviceCode, ts: now };

    console.log(`[useExtensions] GitHub device code (${source}): ${deviceCode}`);
  }, []);

  const extractDeviceCode = useCallback((value) => {
    const text = String(value || '');
    if (!text) return null;

    const directMatch = text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/);
    if (directMatch && directMatch[0]) return directMatch[0];

    try {
      const parsed = new URL(text);
      const candidate = parsed.searchParams.get('user_code')
        || parsed.searchParams.get('code')
        || parsed.searchParams.get('device_code');
      if (!candidate) return null;
      const normalized = String(candidate).trim().toUpperCase();
      const queryMatch = normalized.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/);
      return queryMatch ? queryMatch[0] : null;
    } catch (_) {
      return null;
    }
  }, []);

  const runAuthAction = useCallback((title) => {
    const lower = String(title || '').toLowerCase();
    const code = lastAuthDeviceCodeRef.current;
    const openUrl = lastAuthOpenUrlRef.current || 'https://github.com/login';

    if (lower.includes('copy')) {
      try {
        if (code && navigator?.clipboard?.writeText) {
          navigator.clipboard.writeText(code).catch(() => {});
        }
      } catch (_) {}
      return;
    }

    if (lower.includes('open') || lower.includes('browser') || lower.includes('sign in') || lower.includes('signin') || lower.includes('login')) {
      try { window.open(openUrl, '_blank', 'noopener,noreferrer'); } catch (_) {}
      return;
    }

    if (lower.includes('retry')) {
      try { window.open(openUrl, '_blank', 'noopener,noreferrer'); } catch (_) {}
    }
  }, []);

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

        // VS Code Server disconnect callback
        system.bridge.onVSCodeServerDisconnected = () => {
          console.warn('[useExtensions] VS Code Server disconnected, resetting flag');
          vscodeServerConnectedRef.current = false;
          connectingVSCodeServerRef.current = false;
          vscodeServerSlugRef.current = null;
          setVscodeServerState('disconnected');
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
            case 'registerTreeView':
              // Tree view registered by preload bridge or worker extension.
              // The view definition is already in Redux from parseContributions;
              // request a tree data refresh to populate it.
              console.log(`[useExtensions] registerTreeView: ${payload.viewId}`);
              if (systemRef.current?.bridge?.vscodeServerProxy?.isReady()) {
                systemRef.current.bridge.vscodeServerProxy.request('refreshTreeData', payload.viewId)
                  .catch(() => {});
              }
              break;
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
            case 'extensionMessage': {
              // Show extension notification messages as toasts.
              // Include action buttons if the extension provided them.
              const msg = payload.message || payload;
              const sev = payload.severity || 'info';
              const commands = payload.commands || [];

              // Capture GitHub device code if present in extension messages
              // so users can always paste it even if clipboard API is blocked.
              const deviceCode = extractDeviceCode(msg);
              if (deviceCode) {
                lastAuthDeviceCodeRef.current = deviceCode;
                reportDeviceCode(deviceCode, 'extension message');
                toast.info(`Device code: ${deviceCode}`, {
                  duration: 15000,
                  action: {
                    label: 'Copy Code',
                    onClick: () => {
                      try {
                        if (navigator?.clipboard?.writeText) {
                          navigator.clipboard.writeText(deviceCode).catch(() => {});
                        }
                      } catch (_) {}
                    },
                  },
                });
              }

              const toastOpts = {
                duration: sev === 'error' ? 8000 : sev === 'warning' ? 6000 : 4000,
              };
              // If there are action buttons, show the first one as a toast action
              if (commands.length > 0) {
                const actionBtn = commands.find(c => !c.isCloseAffordance);
                if (actionBtn) {
                  toastOpts.action = {
                    label: actionBtn.title || 'Action',
                    onClick: () => {
                      console.log(`[useExtensions] Extension message action: ${actionBtn.title}`);
                      runAuthAction(actionBtn.title || '');
                    },
                  };
                  toastOpts.duration = 10000; // longer for actionable messages
                }
              }
              if (sev === 'error') {
                toast.error(msg, toastOpts);
              } else if (sev === 'warning') {
                toast.warning(msg, toastOpts);
              } else {
                toast.info(msg, toastOpts);
              }
              break;
            }
            case 'authSessionRequest': {
              // Extension requested authentication — show a toast
              // directing the user to the auth flow.
              const provider = payload.providerId || 'unknown';
              const now = Date.now();
              const code = lastAuthDeviceCodeRef.current;
              const shouldAutoOpen = provider === 'github' && (
                (now - lastAuthPromptAtRef.current > 15000)
                || lastAuthProviderRef.current !== provider
              );
              if (shouldAutoOpen) {
                lastAuthPromptAtRef.current = now;
                lastAuthProviderRef.current = provider;
                if (code) {
                  reportDeviceCode(code, 'auth request');
                }
                console.log(`[useExtensions] authSessionRequest: provider=${provider} code=${code || 'none'}`);
              }

              toast.info(
                code
                  ? `Sign in to ${provider}. Enter code ${code} on GitHub device page.`
                  : `Sign in to ${provider} requested by extension.`,
                {
                duration: 10000,
                action: provider === 'github' ? {
                  label: 'Open GitHub',
                  onClick: () => window.open('https://github.com/login/device', '_blank'),
                } : undefined,
                }
              );
              break;
            }
            case 'openExternal': {
              const url = payload?.url || payload;
              if (url) {
                lastAuthOpenUrlRef.current = String(url);
              }
              const codeFromUrl = extractDeviceCode(url);
              if (codeFromUrl) {
                lastAuthDeviceCodeRef.current = codeFromUrl;
                reportDeviceCode(codeFromUrl, 'openExternal url');
                toast.info(`Device code: ${codeFromUrl}`, {
                  duration: 15000,
                  action: {
                    label: 'Copy Code',
                    onClick: () => {
                      try {
                        if (navigator?.clipboard?.writeText) {
                          navigator.clipboard.writeText(codeFromUrl).catch(() => {});
                        }
                      } catch (_) {}
                    },
                  },
                });
              } else if (url) {
                console.log(`[useExtensions] openExternal: ${url}`);
              }
              break;
            }
            case 'authDeviceCode': {
              const code = payload?.code;
              if (code) {
                lastAuthDeviceCodeRef.current = code;
                reportDeviceCode(code, payload?.source || 'authDeviceCode');
                toast.info(`Device code: ${code}`, {
                  duration: 15000,
                  action: {
                    label: 'Copy Code',
                    onClick: () => {
                      try {
                        if (navigator?.clipboard?.writeText) {
                          navigator.clipboard.writeText(code).catch(() => {});
                        }
                      } catch (_) {}
                    },
                  },
                });
              }
              break;
            }
            case 'authDeviceCodeMissing': {
              const provider = payload?.providerId || 'unknown';
              const waitedMs = payload?.waitedMs || 0;
              console.warn(`[useExtensions] authDeviceCodeMissing: provider=${provider} waitedMs=${waitedMs}`);
              toast.warning(`No device code received from ${provider}`, {
                description: 'Auth was requested, but provider did not emit a device code. Use Open GitHub or provider sign-in UI.',
                duration: 10000,
                action: provider === 'github' ? {
                  label: 'Open GitHub',
                  onClick: () => window.open('https://github.com/login', '_blank'),
                } : undefined,
              });
              break;
            }
            case 'authPrompt': {
              const actions = Array.isArray(payload?.actions) ? payload.actions : [];
              const first = actions.find(a => !a?.isCloseAffordance);
              const message = payload?.message || 'Authentication action required';
              toast.info(message, {
                duration: 12000,
                action: first ? {
                  label: first.title || 'Open',
                  onClick: () => runAuthAction(first.title || ''),
                } : undefined,
              });
              break;
            }
            case 'uriHandlerRegistered': {
              console.log(`[useExtensions] uriHandlerRegistered: ${payload?.extensionId || 'unknown'}`);
              break;
            }
            case 'uriCallbackResult': {
              const ok = !!payload?.ok;
              const delivered = payload?.delivered || 0;
              console.log(`[useExtensions] uriCallbackResult: ok=${ok} delivered=${delivered}`);
              if (!ok) {
                toast.warning('Auth callback was not delivered to extension host', {
                  description: payload?.reason || 'No URI handler registered in extension host.',
                  duration: 7000,
                });
              }
              break;
            }
            case 'showQuickPick': {
              // Log quick pick for now — full UI would require a modal
              const placeholder = payload.options?.placeHolder || 'Select an option';
              const items = payload.items || [];
              console.log(`[useExtensions] QuickPick: ${placeholder}`, items);
              toast.info(placeholder, { duration: 4000 });
              break;
            }
            case 'showInputBox': {
              const prompt = payload.options?.prompt || payload.options?.placeHolder || 'Input requested';
              console.log(`[useExtensions] InputBox: ${prompt}`);
              toast.info(prompt, { duration: 4000 });
              break;
            }
            case 'setContext': {
              // Extension set a context value (when-clause key).
              // Track it for future when-clause evaluation and view updates.
              const { key, value } = payload;
              if (key) {
                console.log(`[useExtensions] setContext: ${key} = ${JSON.stringify(value)}`);
                // Store in Redux so view components re-render on context changes
                dispatch(setContextValue({ key, value }));
                // Also keep a local ref for synchronous access
                if (!contextValuesRef.current) contextValuesRef.current = {};
                contextValuesRef.current[key] = value;
              }
              break;
            }
            case 'clipboardWrite': {
              // Extension wants to write text to the clipboard (e.g. device code).
              // Use the browser Clipboard API to actually write it.
              const text = payload.text || payload;
              const code = extractDeviceCode(text);
              if (code) {
                reportDeviceCode(code, 'clipboard write');
              }
              const writeWithFallback = async (value) => {
                if (!value) return false;
                try {
                  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(String(value));
                    return true;
                  }
                } catch (_) {}
                try {
                  const textarea = document.createElement('textarea');
                  textarea.value = String(value);
                  textarea.style.position = 'fixed';
                  textarea.style.opacity = '0';
                  document.body.appendChild(textarea);
                  textarea.focus();
                  textarea.select();
                  const ok = document.execCommand('copy');
                  document.body.removeChild(textarea);
                  return !!ok;
                } catch (_) {
                  return false;
                }
              };

              if (text && typeof navigator !== 'undefined' && navigator.clipboard) {
                writeWithFallback(text).then((ok) => {
                  if (ok) {
                    lastAuthDeviceCodeRef.current = String(text);
                    toast.success(`Copied to clipboard: ${String(text).slice(0, 60)}`, { duration: 5000 });
                  } else {
                    lastAuthDeviceCodeRef.current = String(text);
                    toast.info(`Copy this code: ${text}`, { duration: 15000 });
                  }
                });
              } else if (text) {
                lastAuthDeviceCodeRef.current = String(text);
                toast.info(`Copy this code: ${text}`, { duration: 10000 });
              }
              break;
            }
            case 'extensionProgress': {
              // Extension is reporting progress (loading/working indicator).
              const { action, title, message, handle } = payload;
              if (action === 'start' && title) {
                toast.loading(title, { id: `progress-${handle}`, duration: 30000 });
              } else if (action === 'report' && message) {
                toast.loading(message, { id: `progress-${handle}`, duration: 30000 });
              } else if (action === 'stop') {
                toast.dismiss(`progress-${handle}`);
              }
              break;
            }
            case 'authProviderRegistered': {
              console.log(`[useExtensions] Auth provider registered: ${payload.providerId} (${payload.label})`);
              break;
            }
            case 'authSessionChanged': {
              // Auth session changed — an extension auth state was updated.
              // This could mean a sign-in completed or a sign-out happened.
              const { providerId } = payload;
              console.log(`[useExtensions] Auth session changed: ${providerId}`);
              toast.info(`Authentication updated for ${providerId}`, { duration: 3000 });
              // Refresh tree views since auth state often affects view content
              if (systemRef.current?.bridge?.vscodeServerProxy?.isReady()) {
                systemRef.current.bridge.vscodeServerProxy.request('refreshAllTrees')
                  .catch(() => {});
              }
              break;
            }
            case 'showFileDialog': {
              console.log(`[useExtensions] File dialog: ${payload.type}`, payload.options);
              break;
            }
            case 'commandExecutionFailed': {
              const commandId = payload?.commandId || 'unknown';
              const reason = payload?.reason || 'unknown';
              const tracked = payload?.trackedHandlers;
              const firstCandidate = Array.isArray(payload?.candidates) && payload.candidates.length > 0
                ? payload.candidates[0]?.commandId
                : null;
              console.warn(`[useExtensions] commandExecutionFailed: ${commandId} (${reason})`);
              toast.error(`Command failed: ${commandId}`, {
                description: tracked !== undefined
                  ? `${reason} (tracked handlers: ${tracked}${firstCandidate ? `, top candidate: ${firstCandidate}` : ''})`
                  : reason,
                duration: 7000,
              });
              break;
            }
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

  // ─── Connect VS Code Server (Path A: real Extension Host) ────
  const connectVSCodeServer = useCallback(async () => {
    if (connectingVSCodeServerRef.current) return;
    if (!systemRef.current?.bridge) return;

    const client = getCompilerClient();
    const desiredSlug = client?.slug || workspaceId || 'default';
    const withTimeout = (promise, timeoutMs, label) => {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      });
      return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    };

    const VSCODE_MANAGER_CONNECT_TIMEOUT_MS = 30000;
    const VSCODE_SERVER_START_TIMEOUT_MS = 120000;

    if (vscodeServerConnectedRef.current && vscodeServerSlugRef.current === desiredSlug) {
      return;
    }

    connectingVSCodeServerRef.current = true;
    setVscodeServerState('connecting');

    try {
      if (!client?.pc || client.pc.connectionState !== 'connected') {
        console.warn('[useExtensions] connectVSCodeServer: WebRTC not connected yet');
        setVscodeServerState('disconnected');
        return;
      }

      if (!vscodeServerConnectedRef.current) {
        // Use the pre-created DataChannel for the VS Code Server Manager
        // (created in SDP alongside ext-host to avoid DCEP issues)
        const channel = client.createVSCodeServerChannel();

        console.log('[useExtensions] connectVSCodeServer: DataChannel obtained, label:', channel.label);

        await withTimeout(
          systemRef.current.bridge.connectVSCodeServer(channel),
          VSCODE_MANAGER_CONNECT_TIMEOUT_MS,
          'VS Code Server manager connection'
        );
      } else {
        console.log('[useExtensions] connectVSCodeServer: switching server workspace to slug:', desiredSlug);
      }

      // Start the VS Code Server for this workspace
      console.log('[useExtensions] connectVSCodeServer: starting server for slug:', desiredSlug);
      const serverInfo = await withTimeout(
        systemRef.current.bridge.startVSCodeServer(desiredSlug),
        VSCODE_SERVER_START_TIMEOUT_MS,
        'VS Code Server startup'
      );
      console.log('[useExtensions] ✓ VS Code Server started:', serverInfo);
      // Track the workspace directory from the server response
      if (serverInfo?.workspaceDir) {
        setVscodeServerWorkspaceDir(serverInfo.workspaceDir);
      }
      vscodeServerConnectedRef.current = true;
      vscodeServerSlugRef.current = desiredSlug;
      setVscodeServerState('running');

      // ── Hydrate Redux with server-side extensions ──────────────
      // Extensions pre-installed on the VS Code Server (e.g. via CLI) never
      // went through the frontend install flow, so they have no Redux entry.
      // Without a Redux entry, ExtensionViewContainer's `isActive` guard
      // blocks rendering. Fetch all manifests from the server and register
      // any missing extensions so their containers/views appear in the sidebar.
      try {
        const proxy = systemRef.current?.bridge?.vscodeServerProxy;
        if (proxy) {
          const detailed = await proxy.listExtensionsDetailed();
          const explicitInstalled = await dbGetAll().catch(() => []);
          const explicitInstallIds = new Set(
            explicitInstalled
              .filter((ext) => ext?.enabled !== false && typeof ext?.id === 'string')
              .map((ext) => ext.id)
          );
          const currentExtensions = store.getState()?.extensions?.extensions || {};
          let hydrated = 0;
          for (const { id: extId, manifest } of (detailed || [])) {
            if (!manifest) continue;
            if (!explicitInstallIds.has(extId)) {
              // Marketplace installs can pull dependency extensions onto the
              // server. Keep those available to the remote host, but do not
              // promote them into Synthi's user-facing Installed list.
              continue;
            }

            // Best-effort NLS cleanup for any remaining %key% placeholders
            // (server-side resolution handles most, this catches stragglers)
            stripUnresolvedNLS(manifest);

            // If already registered in Redux (e.g. from IndexedDB restore),
            // we still need to re-parse contributions since the prior
            // registration may not have had the full manifest (views, etc.).
            if (!currentExtensions[extId]) {
              // Register into Redux with full manifest
              dispatch(registerExtRedux({ id: extId, manifest }));
              hydrated++;
            }
            // Parse contribution points (containers, views, etc.) — always,
            // so server-installed extensions have their views in the sidebar.
            if (manifest.contributes) {
              dispatch(parseContributions({ extensionId: extId, contributes: manifest.contributes }));
            }
            // Mark as active + remote since it's running on the server
            dispatch(setExtensionState({ id: extId, extensionState: 'active', remote: true }));
            hydrated++;
          }
          if (hydrated > 0) {
            console.log(`[useExtensions] Hydrated ${hydrated} server-side extensions into Redux`);

            // After hydrating extensions, request tree data for ALL contributed
            // tree views. Use getCachedTreeData for immediate data (bypasses
            // the event pipeline which may have timing issues), plus
            // refreshTreeData for the latest live data.
            setTimeout(() => {
              const proxy = systemRef.current?.bridge?.vscodeServerProxy;
              if (!proxy?.isReady()) return;

              // Immediate: pull cached data directly from server
              proxy.request('getCachedTreeData', []).then((allCached) => {
                if (allCached && typeof allCached === 'object') {
                  const updates = {};
                  for (const [viewId, data] of Object.entries(allCached)) {
                    if (data && Array.isArray(data) && data.length > 0) {
                      updates[viewId] = data;
                    }
                  }
                  if (Object.keys(updates).length > 0) {
                    console.log(`[useExtensions] Post-hydration cached data: ${Object.keys(updates).length} views`);
                    setTreeDataMap(prev => ({ ...prev, ...updates }));
                  }
                }
              }).catch(() => {});

              // Also trigger live refresh for latest data
              const currentState = store.getState()?.extensions?.contributions?.views || {};
              for (const [, viewList] of Object.entries(currentState)) {
                for (const view of viewList) {
                  if (view.type !== 'webview') {
                    proxy.request('refreshTreeData', view.id).catch(() => {});
                  }
                }
              }
              console.log('[useExtensions] Post-hydration: requested tree data refresh for all views');
            }, 1000);
          }
        }
      } catch (hydrateErr) {
        console.warn('[useExtensions] Server extension hydration failed (non-fatal):', hydrateErr.message);
      }

      // Attach the HTTP tunnel service so code-server UI can be embedded
      if (systemRef.current?.bridge?.vscodeServerProxy) {
        vscodeTunnelService.attach(systemRef.current.bridge.vscodeServerProxy);
        vscodeTunnelService.register().then(ok => {
          if (ok) console.log('[useExtensions] VS Code tunnel Service Worker ready');
          else console.warn('[useExtensions] VS Code tunnel Service Worker registration failed');
        });
      }

      // Once server is running, re-route pending Node-only extensions
      await _installPendingExtensionsOnServer();

    } catch (err) {
      console.warn('[useExtensions] VS Code Server connection failed:', err.message);
      // Set 'disconnected' (not 'error') so the auto-reconnect effect retries
      setVscodeServerState('disconnected');
      // Non-fatal — extensions remain pending until VS Code Server connects
    } finally {
      connectingVSCodeServerRef.current = false;
    }
  }, [workspaceId, dispatch, store]);

  /**
   * Install any pending-remote Node-only extensions into the VS Code Server.
   * Called when the server first becomes available.
   */
  const _installPendingExtensionsOnServer = useCallback(async () => {
    if (!systemRef.current?.bridge?.vscodeServerProxy?.isReady()) {
      console.log('[useExtensions] _installPendingExtensionsOnServer: proxy not ready, skipping');
      return;
    }
    if (!systemRef.current.bridge.vscodeServerConnected) {
      console.log('[useExtensions] _installPendingExtensionsOnServer: server not connected, skipping');
      return;
    }

    const bridge = systemRef.current.bridge;
    let found = 0;
    for (const [id, info] of bridge.extensions) {
      const reduxExt = store.getState()?.extensions?.extensions?.[id];
      if (info.isActive) {
        if (reduxExt && reduxExt.state !== 'active') {
          dispatch(setExtensionState({ id, extensionState: 'active', remote: !!info.remote }));
        }
        continue;
      }

      const isNodeOnly = info.manifest?.main && !info.manifest?.browser;
      const isHybridNode = info.manifest?.main && !!info.manifest?._nodeCode;
      const isTooLarge = info.code?.length > 500_000 && info.manifest?.main;
      if (!isNodeOnly && !isHybridNode && !isTooLarge) continue;

      // Already installed on server. This can happen when the server event
      // arrives before IndexedDB restore registers the Redux row; reconcile
      // instead of leaving the UI in pending-remote forever.
      if (bridge.vscodeServerExtensions.has(id)) {
        info.isActive = true;
        info.remote = true;
        dispatch(setExtensionState({ id, extensionState: 'active', remote: true }));
        if (info.manifest) {
          bridge._emitSyntheticWebviewEvents(id, info.manifest);
        }
        continue;
      }

      found++;
      console.log(`[useExtensions] _installPendingExtensions: installing ${id} on VS Code Server`);
      try {
        dispatch(setExtensionState({ id, extensionState: 'activating' }));

        const result = await bridge._installOnVSCodeServerFromInfo(info);
        if (result.success) {
          dispatch(setExtensionState({ id, extensionState: 'active', remote: true }));
          info.isActive = true;
          info.remote = true;
          console.log(`[useExtensions] ✓ ${id} installed on VS Code Server`);
          // Emit synthetic webview events from the manifest so that
          // WebviewPanelEmbed mounts immediately with a placeholder.
          // When the preload bridge sends real HTML, it updates in-place.
          const extInfo = bridge.extensions.get(id);
          if (extInfo?.manifest) {
            bridge._emitSyntheticWebviewEvents(id, extInfo.manifest);
          }
        } else {
          const reason = result.error || 'VS Code Server install failed';
          if (isRemoteHostNotReadyError(reason)) {
            queueRemoteExtensionInstall(id, reason);
          } else {
            dispatch(setExtensionState({ id, extensionState: 'crashed', reason }));
          }
        }
      } catch (err) {
        console.warn(`[useExtensions] Failed to install ${id} on VS Code Server:`, err.message);
        if (isRemoteHostNotReadyError(err)) {
          queueRemoteExtensionInstall(id, err.message);
        } else {
          dispatch(setExtensionState({ id, extensionState: 'crashed', reason: err.message }));
        }
      }
    }
    if (found === 0) {
      console.log('[useExtensions] _installPendingExtensionsOnServer: no pending extensions found');
    }
  }, [dispatch, store]);

  const isRemoteHostNotReadyError = useCallback((errOrMessage) => {
    const msg = String(errOrMessage?.message || errOrMessage || '').toLowerCase();
    return msg.includes('vs code server not connected')
      || msg.includes('vs code server manager not connected')
      || msg.includes('vs code server datachannel not open')
      || msg.includes('webrtc not connected')
      || msg.includes('datachannel')
      || msg.includes('channel closed')
      || msg.includes('disconnected')
      || msg.includes('transport')
      || msg.includes('timed out');
  }, []);

  const queueRemoteExtensionInstall = useCallback((id, reason = 'Waiting for VS Code Server') => {
    console.log(`[useExtensions] ${id}: queued for VS Code Server (${reason})`);
    dispatch(setExtensionState({ id, extensionState: 'activating', remote: true }));
    connectVSCodeServer().catch((err) => {
      console.warn(`[useExtensions] ${id}: queued remote connect failed:`, err?.message || err);
    });
  }, [connectVSCodeServer, dispatch]);

  useEffect(() => {
    if (vscodeServerState !== 'running') return;
    let cancelled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 10;

    const retryPendingRemote = async () => {
      if (cancelled) return;
      attempts += 1;
      try {
        await _installPendingExtensionsOnServer();
        await reconcileExplicitServerExtensions('pending-retry');
      } catch (err) {
        console.warn('[useExtensions] pending remote install retry failed:', err?.message || err);
      }

      const pending = Object.entries(store.getState()?.extensions?.extensions || {})
        .filter(([, ext]) => ext?.state === 'pending-remote')
        .map(([id]) => id);

      if (cancelled || pending.length === 0) return;
      if (attempts >= MAX_ATTEMPTS) {
        for (const id of pending) {
          dispatch(setExtensionState({
            id,
            extensionState: 'crashed',
            reason: 'VS Code Server is running but did not activate this extension after retrying.',
            remote: true,
          }));
        }
        return;
      }

      setTimeout(retryPendingRemote, 3000);
    };

    const timer = setTimeout(retryPendingRemote, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [vscodeServerState, _installPendingExtensionsOnServer, reconcileExplicitServerExtensions, dispatch, store]);

  // Keep remote installs moving while the VS Code Server reconnects.
  useEffect(() => {
    const hasRemoteWork = extensions.some((ext) =>
      ext?.remote && (ext.state === 'pending-remote' || ext.state === 'activating')
    );
    if (!hasRemoteWork) return;

    let cancelled = false;
    let timer = null;
    let attempts = 0;
    const MAX_ATTEMPTS = 24;

    const reconcileRemoteWork = async () => {
      if (cancelled) return;
      attempts += 1;
      try {
        await reconcileExplicitServerExtensions('remote-state-retry');
        await _installPendingExtensionsOnServer();
      } catch (err) {
        console.warn('[useExtensions] remote state retry failed:', err?.message || err);
      }

      const stillPending = Object.values(store.getState()?.extensions?.extensions || {}).some((ext) =>
        ext?.remote && (ext.state === 'pending-remote' || ext.state === 'activating')
      );
      if (!cancelled && stillPending && attempts < MAX_ATTEMPTS) {
        timer = setTimeout(reconcileRemoteWork, 3000);
      }
    };

    timer = setTimeout(reconcileRemoteWork, 750);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [extensions, _installPendingExtensionsOnServer, reconcileExplicitServerExtensions, store]);

  // ─── Workspace switch handling for VS Code Server ─────────────
  // This hook can stay mounted while slug changes. Ensure the remote
  // VS Code server follows the new slug so indexing/providers map to
  // the active workspace.
  useEffect(() => {
    if (lastWorkspaceIdRef.current === workspaceId) return;

    console.log(`[useExtensions] Workspace changed: ${lastWorkspaceIdRef.current} -> ${workspaceId}`);
    lastWorkspaceIdRef.current = workspaceId;

    const client = getCompilerClient();
    if (client) {
      client.setSlug(workspaceId);
    }

    vscodeServerConnectedRef.current = false;
    connectingVSCodeServerRef.current = false;
    vscodeServerSlugRef.current = null;
    setVscodeServerWorkspaceDir(null);
    setTreeDataMap({});
    setVscodeServerState('disconnected');

    if (systemRef.current?.bridge) {
      connectVSCodeServer().catch((err) => {
        console.warn('[useExtensions] Workspace switch VS Code Server reconnect failed:', err?.message || err);
      });
    }
  }, [workspaceId, connectVSCodeServer]);

  // ─── Restore persisted extensions from IndexedDB ─────────────
  const restorePersistedExtensions = useCallback(async () => {
    if (restoredRef.current || !systemRef.current) return;
    restoredRef.current = true;

    try {
      const saved = await dbGetAll();
      for (const ext of saved) {
        if (!ext.enabled) continue;
        try {
          const { valid, manifest: parsedManifest, errors: parseErrors } = parseManifest(ext.manifest);
          if (!valid) {
            console.warn(`[useExtensions] Skipping invalid persisted extension ${ext.id}:`, parseErrors);
            continue;
          }
          const manifest = typeof structuredClone === 'function'
            ? structuredClone(parsedManifest)
            : JSON.parse(JSON.stringify(parsedManifest));

          // Best-effort NLS cleanup for cached manifests that were saved
          // before NLS resolution was implemented. Strips %key% wrappers and
          // humanises the last segment (e.g. %view.github.pr.name% → "Name").
          // Also detect if the manifest has unresolved placeholders and persist
          // the cleaned version so this doesn't repeat.
          const hadNlsPlaceholders = JSON.stringify(manifest).includes('"%');
          stripUnresolvedNLS(manifest);
          if (hadNlsPlaceholders) {
            try {
              await dbSave({
                id: ext.id,
                manifest,
                code: ext.code,
                nodeCode: ext.nodeCode || null,
                installSource: ext.installSource,
                vsixBase64: ext.vsixBase64,
                enabled: true,
              });
            } catch (_) {}
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
          // They'll be installed on the VS Code Server when it connects.
          // Also skip extensions whose browser bundle is too large for the web
          // worker — they'll hang during eval. Route to VS Code Server instead.
          const isNodeOnly = manifest.main && !manifest.browser;
          const isHybridNode = manifest.main && !!ext.nodeCode;
          const isTooLargeForWorker = ext.code && ext.code.length > 500_000 && (ext.nodeCode || manifest.main);

          if (isNodeOnly || isHybridNode || isTooLargeForWorker) {
            if (isTooLargeForWorker && !isNodeOnly) {
              console.log(`[useExtensions] ${ext.id}: browser bundle too large (${ext.code.length} chars), routing to VS Code Server`);
            } else if (isHybridNode && !isNodeOnly) {
              console.log(`[useExtensions] ${ext.id}: hybrid Node bundle, routing to VS Code Server`);
            }
            // Stash nodeCode on a fresh object so parsed/frozen manifests are
            // never mutated during IndexedDB restore.
            const remoteManifest = ext.nodeCode
              ? { ...manifest, _nodeCode: ext.nodeCode }
              : manifest;

            // Register in MainThreadBridge (stores info, but won't load into worker)
            systemRef.current.bridge.extensions.set(ext.id, {
              id: ext.id,
              name: remoteManifest.name,
              displayName: remoteManifest.displayName || remoteManifest.name,
              version: remoteManifest.version,
              isActive: false,
              failed: false,
              failedReason: null,
              activationEvents: remoteManifest.activationEvents || [],
              violationCount: 0,
              manifest: remoteManifest,
              code: ext.code,
              installSource: ext.installSource || (ext.vsixBase64 ? 'vsix' : 'marketplace'),
              vsixBase64: ext.vsixBase64 || null,
              remote: false,
            });
            dispatch(setExtensionState({ id: ext.id, extensionState: 'pending-remote', remote: true }));
            console.log(`[useExtensions] ${ext.id}: Node-only, waiting for VS Code Server`);

            // If the VS Code Server is already connected AND started, rehydrate immediately
            const proxyReady = systemRef.current.bridge.vscodeServerProxy?.isReady?.();
            const serverConnected = systemRef.current.bridge.vscodeServerConnected;
            console.log(`[useExtensions] ${ext.id}: proxyReady=${proxyReady}, serverConnected=${serverConnected}`);
            if (proxyReady && serverConnected) {
              console.log(`[useExtensions] ${ext.id}: VS Code Server already connected, rehydrating now`);
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
    // If the VS Code Server connected before or during restore, the initial
    // _rehydrateNodeOnlyExtensions call found zero extensions.  Now that
    // restore is done and pending extensions are in bridge.extensions,
    // trigger rehydration again.
    const tryPostRestoreRehydration = async (attempt = 0) => {
      if (!systemRef.current?.bridge) return;
      const proxyReady = systemRef.current.bridge.vscodeServerProxy?.isReady?.();
      const serverConnected = systemRef.current.bridge.vscodeServerConnected;

      if (attempt === 0) {
        console.log(`[useExtensions] Post-restore check: proxyReady=${proxyReady}, serverConnected=${serverConnected}`);
      }

      if (proxyReady && serverConnected) {
        console.log('[useExtensions] VS Code Server ready, triggering post-restore rehydration');
        try {
          await systemRef.current.bridge._rehydrateNodeOnlyExtensions();
          await reconcileExplicitServerExtensions('post-restore');
          await _installPendingExtensionsOnServer();
        } catch (err) {
          console.warn('[useExtensions] Post-restore rehydration failed:', err.message);
        }
      } else if (attempt < 10) {
        // Server may still be starting — retry after a short delay
        setTimeout(() => tryPostRestoreRehydration(attempt + 1), 2000);
      } else {
        console.warn('[useExtensions] Post-restore: VS Code Server never became ready, marking pending remote extensions as failed');
        const pending = Object.entries(store.getState()?.extensions?.extensions || {})
          .filter(([, ext]) => ext?.state === 'pending-remote')
          .map(([id]) => id);
        for (const id of pending) {
          dispatch(setExtensionState({
            id,
            extensionState: 'crashed',
            reason: 'VS Code Server did not become ready. Check the compiler/WebRTC connection and retry enabling the extension.',
            remote: true,
          }));
        }
      }
    };
    tryPostRestoreRehydration();
  }, [
    dispatch,
    _installPendingExtensionsOnServer,
    isRemoteHostNotReadyError,
    queueRemoteExtensionInstall,
    reconcileExplicitServerExtensions,
  ]);

  // ─── Auto-init on mount ──────────────────────────────────────
  useEffect(() => {
    // Reset disposed flag on (re-)mount so React StrictMode's
    // unmount→remount cycle doesn't permanently block init.
    disposedRef.current = false;

    initSystem().then(() => {
      console.log('[useExtensions] initSystem resolved');
      connectVSCodeServer().catch(() => {});
      restorePersistedExtensions();
    });

    // Listen for WebRTC connection to establish VS Code Server.
    // A fresh transport means a fresh reconnect budget: reset the backoff
    // counter so a prior "gave up after 5 attempts" (e.g. caused by a network
    // suspension while the worker-side manager was still booting) doesn't
    // permanently block reconnection once the datachannel is healthy again.
    const handleWebRTCConnect = () => {
      console.log('[useExtensions] synthi:webrtc-connected event received, connecting VS Code Server');
      reconnectAttemptRef.current = 0;
      connectVSCodeServer().catch(() => {});
    };

    // When the user returns to a backgrounded/suspended tab, the datachannel
    // may already be healthy but the auto-reconnect budget exhausted. Give it a
    // fresh attempt instead of leaving the server permanently disconnected.
    const handleVisible = () => {
      if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
      if (vscodeServerConnectedRef.current) return;
      reconnectAttemptRef.current = 0;
      connectVSCodeServer().catch(() => {});
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('synthi:webrtc-connected', handleWebRTCConnect);
      document.addEventListener('visibilitychange', handleVisible);
    }

    // ── Polling fallback: retry VS Code Server connection until it succeeds
    let retryCount = 0;
    const MAX_RETRIES = 20; // ~20 × 3s = 60s
    const retryInterval = setInterval(() => {
      const serverOk = vscodeServerConnectedRef.current;
      if (serverOk || retryCount >= MAX_RETRIES) {
        clearInterval(retryInterval);
        if (!serverOk && retryCount >= MAX_RETRIES) {
          console.warn('[useExtensions] Gave up trying to connect VS Code Server after', MAX_RETRIES, 'retries');
        }
        return;
      }
      retryCount++;
      console.log(`[useExtensions] Polling retry #${retryCount} for VS Code Server...`);
      connectVSCodeServer().catch(() => {});
    }, 3000);

    return () => {
      disposedRef.current = true;
      vscodeServerConnectedRef.current = false;
      connectingVSCodeServerRef.current = false;
      vscodeServerSlugRef.current = null;
      clearInterval(retryInterval);
      if (typeof window !== 'undefined') {
        window.removeEventListener('synthi:webrtc-connected', handleWebRTCConnect);
        document.removeEventListener('visibilitychange', handleVisible);
      }
      if (systemRef.current) {
        systemRef.current.dispose();
        systemRef.current = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Auto-reconnect VS Code Server after disconnect ──────────
  // When the DataChannel crashes (e.g. buffer overflow), the disconnect
  // handler resets flags and sets state to 'disconnected'.  This effect
  // detects that state and retries with exponential backoff.
  useEffect(() => {
    if (vscodeServerState !== 'disconnected') {
      // Reset attempt counter when we're not in disconnected state
      if (vscodeServerState === 'running') reconnectAttemptRef.current = 0;
      return;
    }

    const attempt = reconnectAttemptRef.current;
    if (attempt >= 5) {
      console.warn('[useExtensions] VS Code Server reconnect: giving up after 5 attempts');
      return;
    }

    // Exponential backoff: 2s, 4s, 8s, 16s, 32s
    const delay = Math.min(2000 * Math.pow(2, attempt), 32000);
    console.log(`[useExtensions] VS Code Server disconnected, retrying in ${delay}ms (attempt ${attempt + 1}/5)`);

    const timer = setTimeout(() => {
      reconnectAttemptRef.current = attempt + 1;
      connectVSCodeServer().catch((err) => {
        console.warn('[useExtensions] VS Code Server reconnect failed:', err.message);
      });
    }, delay);

    return () => clearTimeout(timer);
  }, [vscodeServerState, connectVSCodeServer]);

  // ─── OAuth URI callback intake (provider-agnostic) ────────────
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const captureFromLocation = () => {
      try {
        const href = window.location.href;
        const url = new URL(href);
        const fromQuery = url.searchParams.get('vscodeUri')
          || url.searchParams.get('auth_callback')
          || url.searchParams.get('callbackUrl');
        const fromHash = url.hash && url.hash.startsWith('#vscodeUri=')
          ? decodeURIComponent(url.hash.slice('#vscodeUri='.length))
          : null;
        const candidate = fromQuery || fromHash;
        if (candidate && typeof candidate === 'string') {
          pendingAuthCallbackUrlRef.current = candidate;
          authCallbackDeliveredRef.current = false;
          console.log(`[useExtensions] Captured auth callback URL: ${candidate}`);
        }
      } catch (_) {}
    };

    const onCallbackEvent = (event) => {
      const value = event?.detail?.url;
      if (value && typeof value === 'string') {
        pendingAuthCallbackUrlRef.current = value;
        authCallbackDeliveredRef.current = false;
        console.log(`[useExtensions] Received auth callback URL event: ${value}`);
      }
    };

    captureFromLocation();
    window.addEventListener('synthi:auth-callback-url', onCallbackEvent);
    return () => window.removeEventListener('synthi:auth-callback-url', onCallbackEvent);
  }, []);

  useEffect(() => {
    const url = pendingAuthCallbackUrlRef.current;
    if (!url || authCallbackDeliveredRef.current) return;

    const proxy = systemRef.current?.bridge?.vscodeServerProxy;
    if (!proxy?.isReady()) return;

    authCallbackDeliveredRef.current = true;
    proxy.request('deliverUriCallback', [url])
      .then(() => {
        console.log(`[useExtensions] Delivered auth callback URL to extension host`);
      })
      .catch((err) => {
        authCallbackDeliveredRef.current = false;
        console.warn(`[useExtensions] Failed to deliver auth callback URL: ${err.message}`);
      });
  }, [vscodeServerState]);

  // ─── Debug helpers for auth integration validation ───────────
  useEffect(() => {
    if (typeof window === 'undefined') return;

    window.__synthiAuth = {
      submitCallbackUrl: async (url) => {
        const proxy = systemRef.current?.bridge?.vscodeServerProxy;
        if (!proxy?.isReady()) throw new Error('VS Code Server not connected');
        return proxy.request('deliverUriCallback', [url]);
      },
      getLastDeviceCode: () => lastAuthDeviceCodeRef.current,
      getLastOpenUrl: () => lastAuthOpenUrlRef.current,
    };

    return () => {
      try { delete window.__synthiAuth; } catch (_) {}
    };
  }, [vscodeServerState]);

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
  const install = useCallback(async (extensionId, manifest, code, options = {}) => {
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
    const installSource = options.source || parsed._installSource || 'manual';
    const vsixBase64 = options.vsixBase64 || parsed._vsixBase64 || null;

    // Persist to IndexedDB (include nodeCode for remote host)
    await dbSave({ id, manifest: parsed, code, nodeCode, installSource, vsixBase64, enabled: true });

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
    const isHybridNode = parsed.main && !!nodeCode;
    const isTooLargeForWorker = code && code.length > 500_000 && (nodeCode || parsed.main);
    if (isNodeOnly || isHybridNode || isTooLargeForWorker) {
      if (isTooLargeForWorker && !isNodeOnly) {
        console.log(`[useExtensions] ${id}: browser bundle too large (${code.length} chars), routing to VS Code Server`);
      } else if (isHybridNode && !isNodeOnly) {
        console.log(`[useExtensions] ${id}: hybrid Node bundle, routing to VS Code Server`);
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
        installSource,
        vsixBase64,
        remote: false,
      });

      // ── Path A: Prefer VS Code Server (real Extension Host) ──
      const hostTarget = system.bridge.getExtensionHostTarget(parsed);

      if (hostTarget === 'vscode-server') {
        dispatch(setExtensionState({ id, extensionState: 'activating', remote: true }));
        try {
          const info = system.bridge.extensions.get(id);
          const result = await system.bridge._installOnVSCodeServerFromInfo(info);
          if (result.success) {
            if (info) {
              info.isActive = true;
              info.remote = true;
            }
            dispatch(setExtensionState({ id, extensionState: 'active', remote: true }));
            console.log(`[useExtensions] ✓ ${id} installed on VS Code Server`);
            // Emit synthetic webview events from the manifest so that
            // WebviewPanelEmbed mounts immediately with a placeholder.
            // When the preload bridge sends real HTML, it updates in-place.
            system.bridge._emitSyntheticWebviewEvents(id, parsed);
            return { success: true, vscodeServer: true };
          }
          const reason = result.error || 'VS Code Server install failed';
          if (isRemoteHostNotReadyError(reason)) {
            queueRemoteExtensionInstall(id, reason);
            return { success: true, pendingRemote: true, vscodeServer: true };
          }
          dispatch(setExtensionState({ id, extensionState: 'crashed', reason }));
          return { success: false, error: reason, vscodeServer: true };
        } catch (serverErr) {
          console.warn(`[useExtensions] VS Code Server install failed for ${id}:`, serverErr.message);
          if (isRemoteHostNotReadyError(serverErr)) {
            queueRemoteExtensionInstall(id, serverErr.message);
            return { success: true, pendingRemote: true, vscodeServer: true };
          }
          dispatch(setExtensionState({ id, extensionState: 'crashed', reason: serverErr.message }));
          return { success: false, error: serverErr.message, vscodeServer: true };
        }
      }

      // ── Fallback: pending for VS Code Server ──
      queueRemoteExtensionInstall(id, 'remote host not ready');

      // If VS Code Server is already available, install now
      if (system.bridge.vscodeServerProxy?.isReady?.()) {
        try {
          await _installPendingExtensionsOnServer();
        } catch (_) {}
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
        queueRemoteExtensionInstall(id, loadErr.message);
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
  }, [
    dispatch,
    _installPendingExtensionsOnServer,
    isRemoteHostNotReadyError,
    queueRemoteExtensionInstall,
  ]);

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
   * Tries the local worker first; if the command isn't found locally,
   * routes to the VS Code Server via the preload bridge.
   */
  const executeCommand = useCallback(async (commandId, ...args) => {
    const system = systemRef.current;
    if (!system) throw new Error('Extension host not ready');

    // Try local execution first (commands registered in the web worker)
    try {
      return await system.executeCommand(commandId, ...args);
    } catch (localErr) {
      // If the command isn't registered locally, try the VS Code Server
      if (system.bridge?.vscodeServerProxy?.isReady()) {
        console.log(`[useExtensions] Command ${commandId} not local, routing to VS Code Server`);
        return system.bridge.vscodeServerProxy.request('executeExtensionCommand', [commandId, ...args]);
      }
      throw localErr;
    }
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
        if (isTransport) {
          queueRemoteExtensionInstall(extensionId, err.message);
        } else {
          dispatch(setExtensionState({
            id: extensionId,
            extensionState: 'crashed',
            reason: err.message,
          }));
        }
      }
    }
  }, [dispatch, queueRemoteExtensionInstall]);

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
   * Removes from: browser worker, server disk, IndexedDB, LSP registry, Redux.
   */
  const uninstall = useCallback(async (extensionId) => {
    const system = systemRef.current;

    // 1. Deactivate in the browser extension host worker
    if (system) {
      try { await system.bridge?.deactivateExtension(extensionId); } catch (_) {}
    }

    // 2. Remove from VS Code Server disk (if connected)
    if (system?.bridge?.vscodeServerProxy?.isReady()) {
      try {
        const result = await system.bridge.vscodeServerProxy.uninstallExtension(extensionId);
        if (result?.success) {
          console.log(`[useExtensions] ✓ Uninstalled ${extensionId} from server (dirs: ${result.removedDirs?.join(', ') || 'none'})`);
        } else {
          console.warn(`[useExtensions] Server uninstall returned failure for ${extensionId}:`, result?.error);
        }
      } catch (err) {
        console.warn(`[useExtensions] Server uninstall RPC failed for ${extensionId}:`, err.message);
      }
    }

    // 3. Remove from IndexedDB persistence
    try {
      await dbRemove(extensionId);
    } catch (err) {
      console.warn(`[useExtensions] IndexedDB removal failed for ${extensionId}:`, err.message);
    }

    // 4. Unregister LSP mappings so the Editor stops trying to connect
    try { unregisterLspForExtension(extensionId); } catch (_) {}

    // 5. Remove from Redux store (cleans up UI contributions)
    dispatch(removeExtRedux(extensionId));

    // 6. Clean up tree data cache for any views this extension owned
    setTreeDataMap(prev => {
      const next = { ...prev };
      for (const viewId of Object.keys(next)) {
        // Views are typically namespaced by extension id
        if (viewId.toLowerCase().includes(extensionId.toLowerCase().split('.')[1] || '')) {
          delete next[viewId];
        }
      }
      return next;
    });
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

  /**
   * Request tree data refresh for a specific view or all views in a container.
   * Uses getCachedTreeData for immediate data and refreshTreeData for fresh data.
   */
  const requestTreeRefresh = useCallback((viewIdOrContainerId) => {
    const proxy = systemRef.current?.bridge?.vscodeServerProxy;
    if (!proxy?.isReady()) return;

    // First, try to get cached data immediately (bypasses event pipeline)
    proxy.request('getCachedTreeData', []).then((allCached) => {
      if (allCached && typeof allCached === 'object') {
        const updates = {};
        for (const [viewId, data] of Object.entries(allCached)) {
          if (data && Array.isArray(data) && data.length > 0) {
            updates[viewId] = data;
          }
        }
        if (Object.keys(updates).length > 0) {
          console.log(`[useExtensions] getCachedTreeData: ${Object.keys(updates).length} views with data`);
          setTreeDataMap(prev => ({ ...prev, ...updates }));
        }
      }
    }).catch(() => {});

    // Also trigger a live refresh via the event pipeline
    const currentState = store.getState()?.extensions?.contributions?.views || {};
    const containerViews = currentState[viewIdOrContainerId];
    if (containerViews) {
      for (const view of containerViews) {
        if (view.type !== 'webview') {
          proxy.request('refreshTreeData', view.id).catch(() => {});
        }
      }
    } else {
      proxy.request('refreshTreeData', viewIdOrContainerId).catch(() => {});
    }
  }, [store]);

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
    viewsWelcome,
    contextValues,

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
    requestTreeRefresh,

    // VS Code Server (Path A: real Extension Host)
    vscodeServerState,
    vscodeServerWorkspaceDir,
    vscodeTunnelService,
    installOnVSCodeServer: async (extensionId) => {
      const system = systemRef.current;
      if (!system?.bridge?.vscodeServerProxy?.isReady()) {
        throw new Error('VS Code Server not connected');
      }
      return system.bridge.installMarketplaceExtensionOnServer(extensionId);
    },
    getVSCodeServerInfo: async () => {
      const system = systemRef.current;
      if (!system?.bridge?.vscodeServerProxy?.isReady()) return null;
      return system.bridge.getVSCodeServerConnectionInfo();
    },
    submitAuthCallbackUrl: async (url) => {
      const system = systemRef.current;
      if (!system?.bridge?.vscodeServerProxy?.isReady()) {
        throw new Error('VS Code Server not connected');
      }
      if (!url || typeof url !== 'string') {
        throw new Error('url is required');
      }
      return system.bridge.vscodeServerProxy.request('deliverUriCallback', [url]);
    },
    getAuthDiagnostics: async () => {
      const system = systemRef.current;
      if (!system?.bridge?.vscodeServerProxy?.isReady()) {
        throw new Error('VS Code Server not connected');
      }
      return system.bridge.vscodeServerProxy.request('getAuthDiagnostics', []);
    },

    // Raw system ref (for advanced use / debug panel)
    _systemRef: systemRef,
  };
}

export default useExtensions;
