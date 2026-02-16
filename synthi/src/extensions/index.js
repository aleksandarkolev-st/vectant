/**
 * Synthi Extension System - Main Export
 * VS Code-compatible extension system for web IDE
 * 
 * Architecture:
 * - Single extension host worker (not per-extension)
 * - Zero extension JS on main thread
 * - All extensions run in isolated worker
 * - Monaco is single source of truth for text
 * - Webviews only via sandboxed iframes
 * 
 * Performance Targets:
 * - Typing latency: < 10ms
 * - Activation time: < 300ms median
 * - CPU budget: 50ms per 1s per extension
 * - Memory: 64MB per extension, 256MB total
 */

// Host components (worker-side — ExtensionHostWorker is a worker entry point, not importable)
// export { ExtensionHostWorker } from './host/ExtensionHostWorker.js';
export { ExtensionHostMain } from './host/ExtensionHostMain.js';
export { ExtensionRegistry } from './host/ExtensionRegistry.js';
export { ActivationManager } from './host/ActivationManager.js';
export { createExtensionContext } from './host/ExtensionContext.js';

// Bridge components (main thread)
export { createMessageId, createRequest, createResponse, createEvent, isValidMessage, MainToWorkerMethods, WorkerToMainMethods } from './bridge/MessageProtocol.js';
export { WorkerProxy, createWorkerProxy, getWorkerProxy } from './bridge/WorkerProxy.js';
export { MainThreadBridge, createMainThreadBridge, getMainThreadBridge } from './bridge/MainThreadBridge.js';
export { MonacoBridge } from './bridge/MonacoBridge.js';
export { LanguageProviderBridge } from './bridge/LanguageProviderBridge.js';
export { VSCodeServerProxy } from './bridge/VSCodeServerProxy.js';

// VS Code API
export * as vscode from './api/vscode.js';

// Webview support
export { WebviewManager, getWebviewManager } from './webview/WebviewManager.js';

// Storage
export { StorageService, getStorageService } from './services/StorageService.js';

// Loader pipeline
export {
  parseManifest,
  getContributedCommands,
  getActivationEvents,
  activatesOnLanguage,
  activatesOnCommand,
  saveExtension,
  getExtension as getInstalledExtension,
  getAllExtensions as getAllInstalledExtensions,
  removeExtension as removeInstalledExtension,
  setExtensionEnabled,
  clearAllExtensions,
  parseVSIX,
} from './loader/index.js';

// Scheduler
export {
  ExtensionScheduler,
  getExtensionScheduler,
  MemoryMonitor,
  getMemoryMonitor,
  TimerThrottler,
  getTimerThrottler,
  VisibilityManager,
  getVisibilityManager
} from './scheduler/index.js';

// Performance monitoring
export {
  TypingLatencyMonitor,
  getTypingLatencyMonitor,
  ActivationBenchmark,
  getActivationBenchmark,
  CPUProfiler,
  getCPUProfiler
} from './perf/index.js';

/**
 * Initialize the extension system
 * @param {object} options
 * @param {import('monaco-editor').editor.IStandaloneCodeEditor} options.editor - Monaco editor instance
 * @param {string} [options.workspaceId] - Workspace identifier
 * @param {string} options.workerUrl - URL to the extension host worker script
 * @returns {Promise<object>} Extension system API
 */
export async function initializeExtensionSystem(options) {
  const { editor, workspaceId = 'default', workerUrl } = options;

  if (!workerUrl) {
    throw new Error('workerUrl is required');
  }

  // Import dynamically to support tree-shaking
  const { MainThreadBridge } = await import('./bridge/MainThreadBridge.js');
  const { MonacoBridge } = await import('./bridge/MonacoBridge.js');
  const { LanguageProviderBridge } = await import('./bridge/LanguageProviderBridge.js');
  const { getStorageService } = await import('./services/StorageService.js');
  const { getWebviewManager } = await import('./webview/WebviewManager.js');
  const { getExtensionScheduler } = await import('./scheduler/ExtensionScheduler.js');
  const { getMemoryMonitor } = await import('./scheduler/MemoryMonitor.js');
  const { getVisibilityManager } = await import('./scheduler/VisibilityManager.js');
  const { getTypingLatencyMonitor } = await import('./perf/TypingLatencyMonitor.js');
  const { getActivationBenchmark } = await import('./perf/ActivationBenchmark.js');

  // Initialize services
  const storage = getStorageService();
  await storage.open(workspaceId);

  const webviews = getWebviewManager();
  const scheduler = getExtensionScheduler();
  const memory = getMemoryMonitor();
  const visibility = getVisibilityManager();
  const latencyMonitor = getTypingLatencyMonitor();
  const activationBenchmark = getActivationBenchmark();

  // Start scheduler and monitoring
  scheduler.start();
  memory.start();
  latencyMonitor.start();

  // Create and initialize main thread bridge
  const bridge = new MainThreadBridge();
  await bridge.init(workerUrl);

  // Connect Monaco bridge (only if editor provided)
  let monacoBridge = null;
  let languageProviderBridge = null;
  if (editor) {
    monacoBridge = new MonacoBridge(bridge);
    // MonacoBridge.init() needs the monaco namespace and the editor instance.
    // The caller may provide a bare editor; grab the global monaco if available.
    const monacoNs = (typeof window !== 'undefined' && window.monaco) ? window.monaco : null;
    if (monacoNs) {
      monacoBridge.init(monacoNs, editor);

      // Initialize the Language Provider Bridge — this is the critical bridge
      // that connects extension-registered language providers (in the worker)
      // with Monaco editor language features (on the main thread).
      languageProviderBridge = new LanguageProviderBridge(bridge);
      languageProviderBridge.init(monacoNs);
      bridge.languageProviderBridge = languageProviderBridge;
    }
  }

  // Set up message handler
  bridge.onShowMessage = (type, message, options) => {
    if (type === 'error') console.error(`[Extension] ${message}`);
    else if (type === 'warning') console.warn(`[Extension] ${message}`);
    else console.log(`[Extension] ${message}`);
  };

  // Wire webview creation to the webview manager
  bridge.onCreateWebview = (viewId, viewType, title, opts) => {
    console.log(`[Extension] Creating webview: ${viewId} (${viewType})`);
    try {
      webviews.create(viewId, viewType, title, opts || {});
    } catch (err) {
      console.error(`[Extension] Failed to create webview ${viewId}:`, err);
    }
  };

  // Contribution event callbacks — set later by the hook/consumer
  // These are exposed on the returned system object for wiring.
  let onContribution = null;

  // Listen for tree view registrations and data updates
  const proxy = bridge.workerProxy;
  if (proxy) {
    proxy.on('registerTreeView', (viewId, extensionId) => {
      console.log(`[Extension] Tree view registered: ${viewId} by ${extensionId}`);
      onContribution?.('registerTreeView', { viewId, extensionId });
    });
    proxy.on('treeData', (viewId, data) => {
      console.log(`[Extension] Tree data received for: ${viewId} (${data?.length || 0} items)`);
      onContribution?.('treeData', { viewId, data });
    });
    proxy.on('createWebview', (viewId, viewType, title, opts) => {
      // Extract extensionId from the viewId format: "extensionId.webview[View].xxx"
      const extIdMatch = viewId.match(/^(.+?)\.(webview|webviewView)\./);      
      const extensionId = extIdMatch ? extIdMatch[1] : opts?.extensionId || undefined;
      onContribution?.('createWebview', { viewId, viewType, title, opts, extensionId });
    });
    proxy.on('disposeWebview', (viewId) => {
      webviews.dispose(viewId);
      onContribution?.('disposeWebview', { viewId });
    });
    proxy.on('updateWebview', (viewId, update) => {
      const instance = webviews.webviews.get(viewId);
      if (instance && update?.html) {
        instance.html = update.html;
      }
      onContribution?.('updateWebview', { viewId, html: update?.html });
    });
    proxy.on('setStatusBar', (text, timeout) => {
      onContribution?.('setStatusBar', { text, timeout });
    });
  }

  // Wire the remote extension host contribution events through the same callback
  bridge._emitRemoteContribution = (type, payload) => {
    switch (type) {
      case 'treeData':
        onContribution?.('treeData', payload);
        break;
      case 'registerTreeView':
        onContribution?.('registerTreeView', payload);
        break;
      case 'createWebview':
        // Create the actual webview DOM element (iframe) in the WebviewManager.
        // If a synthetic placeholder already created one with this viewId,
        // webviews.create() returns the existing instance (no-op).
        try {
          webviews.create(payload.viewId, payload.viewType, payload.title, payload.opts || {});
        } catch (err) {
          console.warn(`[Extension] Failed to create remote webview ${payload.viewId}:`, err.message);
        }
        onContribution?.('createWebview', payload);
        break;
      case 'disposeWebview':
        webviews.dispose(payload.viewId);
        onContribution?.('disposeWebview', payload);
        break;
      case 'updateWebview': {
        let instance = webviews.webviews.get(payload.viewId);

        // Auto-create the WebviewManager instance if it doesn't exist yet.
        // This handles the race where updateWebview arrives from the preload
        // before the frontend's synthetic createWebview has been processed.
        if (!instance && payload.html) {
          console.log(`[Extension] updateWebview: auto-creating webview for ${payload.viewId}`);
          try {
            instance = webviews.create(payload.viewId, payload.viewId, payload.viewId, {});
          } catch (err) {
            console.warn(`[Extension] auto-create failed for ${payload.viewId}:`, err.message);
          }
        }

        if (instance && payload.html) {
          const isSyntheticPlaceholder = payload.html.length < 1200 && payload.html.includes('Connecting to remote');
          if (isSyntheticPlaceholder) {
            console.log(`[Extension] updateWebview ${payload.viewId}: placeholder (${payload.html.length} chars)`);
          } else {
            console.log(`[Extension] updateWebview ${payload.viewId}: real content (${payload.html.length} chars)`);
          }
          instance.html = payload.html;
        } else if (!instance) {
          console.warn(`[Extension] updateWebview: no WebviewManager instance for ${payload.viewId}`);
          // Fuzzy match fallback — viewType may differ from viewId
          for (const [id, inst] of webviews.webviews) {
            if (id.includes(payload.viewId) || payload.viewId.includes(id)) {
              console.log(`[Extension] updateWebview: fuzzy match ${id} for ${payload.viewId}`);
              inst.html = payload.html;
              break;
            }
          }
        }
        onContribution?.('updateWebview', payload);
        break;
      }
      case 'setStatusBar':
        onContribution?.('setStatusBar', payload);
        break;
      case 'providerList': {
        // The preload bridge reports registered providers — log for diagnostics
        const trees = payload.treeViews || payload[0] || [];
        const wvs = payload.webviews || payload[1] || [];
        console.log(`[Extension] providerList: ${trees.length} trees, ${wvs.length} webviews`);
        onContribution?.('providerList', payload);
        break;
      }
      case 'authSessionRequest':
        onContribution?.('authSessionRequest', payload);
        break;
      case 'authDeviceCode':
        onContribution?.('authDeviceCode', payload);
        break;
      case 'authDeviceCodeMissing':
        onContribution?.('authDeviceCodeMissing', payload);
        break;
      case 'uriHandlerRegistered':
        onContribution?.('uriHandlerRegistered', payload);
        break;
      case 'uriCallbackResult':
        onContribution?.('uriCallbackResult', payload);
        break;
      case 'extensionMessage':
        onContribution?.('extensionMessage', payload);
        break;
      case 'showQuickPick':
        onContribution?.('showQuickPick', payload);
        break;
      case 'showInputBox':
        onContribution?.('showInputBox', payload);
        break;
      case 'setContext':
        onContribution?.('setContext', payload);
        break;
      case 'clipboardWrite':
        onContribution?.('clipboardWrite', payload);
        break;
      case 'extensionProgress':
        onContribution?.('extensionProgress', payload);
        break;
      case 'authProviderRegistered':
        onContribution?.('authProviderRegistered', payload);
        break;
      case 'authSessionChanged':
        onContribution?.('authSessionChanged', payload);
        break;
      case 'showFileDialog':
        onContribution?.('showFileDialog', payload);
        break;
      case 'commandExecutionFailed':
        onContribution?.('commandExecutionFailed', payload);
        break;
      default:
        onContribution?.(type, payload);
    }
  };

  // Wire up visibility manager to scheduler
  visibility.onPause = (extensionId) => {
    scheduler._throttle(extensionId);
  };
  
  visibility.onSuspend = (extensionId) => {
    scheduler._suspend(extensionId);
  };

  visibility.onResume = (extensionId) => {
    scheduler.resume(extensionId);
  };

  // Return public API
  return {
    bridge,
    webviews,

    /** Set a callback to receive contribution events from extensions.
     *  callback(type, payload) where type is 'registerTreeView', 'treeData',
     *  'createWebview', 'disposeWebview', 'setStatusBar' */
    set onContribution(cb) { onContribution = cb; },
    get onContribution() { return onContribution; },
    
    // Register and load an extension
    registerExtension: async (extensionId, manifest, code) => {
      scheduler.register(extensionId);
      memory.register(extensionId);
      visibility.register(extensionId);
      
      await bridge.registerExtension(extensionId, manifest, code);
    },
    
    // Activate an extension
    activateExtension: async (extensionId) => {
      activationBenchmark.startActivation(extensionId);
      
      try {
        const result = await bridge.activateExtension(extensionId);
        activationBenchmark.endActivation(extensionId, result.success);
        return result;
      } catch (err) {
        activationBenchmark.endActivation(extensionId, false);
        throw err;
      }
    },

    // Execute a command
    executeCommand: (command, ...args) => {
      return bridge.executeCommand(command, ...args);
    },

    // Get extension info
    getExtensions: () => {
      return bridge.getExtensions();
    },

    // Get extension states (main-thread authoritative)
    getExtensionStates: () => {
      return bridge.getExtensionStates();
    },
    
    getExtension: (extensionId) => {
      return bridge.getExtension(extensionId);
    },

    // Get metrics
    getMetrics: () => {
      return {
        scheduler: scheduler.getAllMetrics(),
        memory: memory.getReport(),
        typing: latencyMonitor.getStats(),
        activation: activationBenchmark.getOverallStats(),
        visibility: visibility.getState()
      };
    },

    // Dispose
    dispose: () => {
      bridge.shutdown();
      if (monacoBridge) monacoBridge.dispose();
      if (languageProviderBridge) languageProviderBridge.dispose();
      scheduler.stop();
      memory.stop();
      latencyMonitor.stop();
      webviews.disposeAll();
    }
  };
}
