/**
 * Synthi Extension System - Window API
 * vscode.window namespace implementation
 */

import { WorkerToMainMethods } from '../bridge/MessageProtocol.js';

/**
 * Create window API
 * @param {string} extensionId
 * @param {import('../host/ExtensionHostMain.js').ExtensionHostMain} host
 * @returns {object}
 */
export function createWindowAPI(extensionId, host) {
  // Track created resources for disposal
  const outputChannels = new Map();
  const statusBarItems = [];
  const webviewPanels = [];
  
  // Event listeners
  const onDidChangeActiveTextEditorListeners = [];
  const onDidChangeVisibleTextEditorsListeners = [];
  const onDidChangeTextEditorSelectionListeners = [];
  const onDidChangeTextEditorVisibleRangesListeners = [];

  return {
    /**
     * Active text editor (read-only)
     */
    get activeTextEditor() {
      // Synced from main thread via ACTIVE_EDITOR_CHANGED events
      return host._activeTextEditor || undefined;
    },

    /**
     * Visible text editors (read-only)
     */
    get visibleTextEditors() {
      return [];
    },

    /**
     * Active terminal (not supported)
     */
    get activeTerminal() {
      return undefined;
    },

    /**
     * Terminals (not supported)
     */
    get terminals() {
      return [];
    },

    /**
     * Show information message
     * @param {string} message
     * @param {...any} items
     * @returns {Promise<string|undefined>}
     */
    showInformationMessage(message, ...items) {
      return showMessage('info', message, items, host);
    },

    /**
     * Show warning message
     * @param {string} message
     * @param {...any} items
     * @returns {Promise<string|undefined>}
     */
    showWarningMessage(message, ...items) {
      return showMessage('warning', message, items, host);
    },

    /**
     * Show error message
     * @param {string} message
     * @param {...any} items
     * @returns {Promise<string|undefined>}
     */
    showErrorMessage(message, ...items) {
      return showMessage('error', message, items, host);
    },

    /**
     * Show quick pick
     * @param {any[] | Promise<any[]>} items
     * @param {object} [options]
     * @param {any} [token]
     * @returns {Promise<any>}
     */
    async showQuickPick(items, options, token) {
      const resolvedItems = await Promise.resolve(items);
      try {
        const result = await host.request(WorkerToMainMethods.SHOW_QUICK_PICK, [resolvedItems, options]);
        return result;
      } catch {
        return undefined;
      }
    },

    /**
     * Show input box
     * @param {object} [options]
     * @param {any} [token]
     * @returns {Promise<string|undefined>}
     */
    async showInputBox(options, token) {
      try {
        const result = await host.request(WorkerToMainMethods.SHOW_INPUT_BOX, [options]);
        return result;
      } catch {
        return undefined;
      }
    },

    /**
     * Create output channel
     * @param {string} name
     * @param {object} [options]
     * @returns {object}
     */
    createOutputChannel(name, options) {
      if (outputChannels.has(name)) {
        return outputChannels.get(name);
      }

      const lines = [];
      const channel = {
        name,
        
        append(value) {
          lines.push(value);
          host.emit(WorkerToMainMethods.OUTPUT_APPEND, name, value, false);
        },
        
        appendLine(value) {
          lines.push(value + '\n');
          host.emit(WorkerToMainMethods.OUTPUT_APPEND, name, value, true);
        },
        
        replace(value) {
          lines.length = 0;
          lines.push(value);
          host.emit(WorkerToMainMethods.OUTPUT_CLEAR, name);
          host.emit(WorkerToMainMethods.OUTPUT_APPEND, name, value, false);
        },
        
        clear() {
          lines.length = 0;
          host.emit(WorkerToMainMethods.OUTPUT_CLEAR, name);
        },
        
        show(preserveFocusOrColumn, preserveFocus) {
          host.emit(WorkerToMainMethods.OUTPUT_SHOW, name, preserveFocus ?? preserveFocusOrColumn);
        },
        
        hide() {
          // No-op
        },
        
        dispose() {
          outputChannels.delete(name);
        }
      };

      outputChannels.set(name, channel);
      return channel;
    },

    /**
     * Create status bar item
     * @param {number} [alignment]
     * @param {number} [priority]
     * @returns {object}
     */
    createStatusBarItem(alignmentOrId, priorityOrAlignment, priority) {
      let id, alignment;
      
      if (typeof alignmentOrId === 'string') {
        id = alignmentOrId;
        alignment = priorityOrAlignment ?? 1;
        priority = priority ?? 0;
      } else {
        alignment = alignmentOrId ?? 1;
        priority = priorityOrAlignment ?? 0;
      }

      const item = {
        id: id || `${extensionId}.statusbar.${statusBarItems.length}`,
        alignment,
        priority,
        text: '',
        tooltip: undefined,
        color: undefined,
        backgroundColor: undefined,
        command: undefined,
        accessibilityInformation: undefined,
        name: undefined,
        _visible: false,
        
        show() {
          this._visible = true;
          host.emit(WorkerToMainMethods.SET_STATUS_BAR, this.id, {
            text: this.text,
            tooltip: this.tooltip,
            color: this.color,
            command: this.command,
            alignment: this.alignment,
            priority: this.priority,
            visible: true
          });
        },
        
        hide() {
          this._visible = false;
          host.emit(WorkerToMainMethods.SET_STATUS_BAR, this.id, { visible: false });
        },
        
        dispose() {
          const idx = statusBarItems.indexOf(item);
          if (idx !== -1) statusBarItems.splice(idx, 1);
          host.emit(WorkerToMainMethods.SET_STATUS_BAR, this.id, { dispose: true });
        }
      };

      statusBarItems.push(item);
      return item;
    },

    /**
     * Create webview panel
     * @param {string} viewType
     * @param {string} title
     * @param {number} showOptions
     * @param {object} [options]
     * @returns {object}
     */
    createWebviewPanel(viewType, title, showOptions, options) {
      const viewId = `${extensionId}.webview.${webviewPanels.length}`;
      
      const messageListeners = [];
      const disposeListeners = [];
      const viewStateListeners = [];
      
      let webviewHtml = '';
      
      const panel = {
        viewType,
        title,
        viewColumn: typeof showOptions === 'number' ? showOptions : showOptions.viewColumn,
        active: true,
        visible: true,
        options: options || {},
        
        webview: {
          options: options || {},
          
          get html() {
            return webviewHtml;
          },
          
          set html(value) {
            webviewHtml = value;
            // Notify main thread of HTML update
            host.emit(WorkerToMainMethods.UPDATE_WEBVIEW, viewId, { html: value });
          },
          
          onDidReceiveMessage: (listener, thisArgs, disposables) => {
            const bound = thisArgs ? listener.bind(thisArgs) : listener;
            messageListeners.push(bound);
            const disposable = {
              dispose() {
                const idx = messageListeners.indexOf(bound);
                if (idx !== -1) messageListeners.splice(idx, 1);
              }
            };
            if (disposables) disposables.push(disposable);
            return disposable;
          },
          
          postMessage(message) {
            host.emit(WorkerToMainMethods.POST_WEBVIEW_MESSAGE, viewId, message);
            return Promise.resolve(true);
          },
          
          asWebviewUri(localResource) {
            // Convert to webview-safe URI
            return {
              scheme: 'https',
              authority: 'file+.vscode-resource.vscode-cdn.net',
              path: localResource.path,
              fsPath: localResource.fsPath,
              toString() {
                return `https://file+.vscode-resource.vscode-cdn.net${localResource.path}`;
              }
            };
          },
          
          get cspSource() {
            return "'self' https:";
          }
        },
        
        onDidChangeViewState: (listener, thisArgs, disposables) => {
          const bound = thisArgs ? listener.bind(thisArgs) : listener;
          viewStateListeners.push(bound);
          const disposable = {
            dispose() {
              const idx = viewStateListeners.indexOf(bound);
              if (idx !== -1) viewStateListeners.splice(idx, 1);
            }
          };
          if (disposables) disposables.push(disposable);
          return disposable;
        },
        
        onDidDispose: (listener, thisArgs, disposables) => {
          const bound = thisArgs ? listener.bind(thisArgs) : listener;
          disposeListeners.push(bound);
          const disposable = {
            dispose() {
              const idx = disposeListeners.indexOf(bound);
              if (idx !== -1) disposeListeners.splice(idx, 1);
            }
          };
          if (disposables) disposables.push(disposable);
          return disposable;
        },
        
        reveal(viewColumn, preserveFocus) {
          host.emit(WorkerToMainMethods.UPDATE_WEBVIEW, viewId, { 
            reveal: true, 
            viewColumn, 
            preserveFocus 
          });
        },
        
        dispose() {
          const idx = webviewPanels.indexOf(panel);
          if (idx !== -1) webviewPanels.splice(idx, 1);
          disposeListeners.forEach(l => l());
          host.emit(WorkerToMainMethods.DISPOSE_WEBVIEW, viewId);
        },
        
        // Internal: receive message from main thread
        _receiveMessage(message) {
          messageListeners.forEach(l => l(message));
        }
      };

      webviewPanels.push(panel);
      
      // Create in main thread
      host.emit(WorkerToMainMethods.CREATE_WEBVIEW, viewId, viewType, title, options);

      return panel;
    },

    /**
     * Register webview view provider
     * @param {string} viewId
     * @param {object} provider
     * @param {object} [options]
     * @returns {{ dispose(): void }}
     */
    registerWebviewViewProvider(viewId, provider, options) {
      const wvViewId = `${extensionId}.webviewView.${viewId}`;
      let webviewHtml = '';
      const messageListeners = [];
      const disposeListeners = [];
      const visibilityListeners = [];

      const webviewView = {
        viewType: viewId,
        visible: true,
        onDidChangeVisibility: (listener, thisArgs, disposables) => {
          const bound = thisArgs ? listener.bind(thisArgs) : listener;
          visibilityListeners.push(bound);
          const d = { dispose() { const i = visibilityListeners.indexOf(bound); if (i !== -1) visibilityListeners.splice(i, 1); } };
          if (disposables) disposables.push(d);
          return d;
        },
        onDidDispose: (listener, thisArgs, disposables) => {
          const bound = thisArgs ? listener.bind(thisArgs) : listener;
          disposeListeners.push(bound);
          const d = { dispose() { const i = disposeListeners.indexOf(bound); if (i !== -1) disposeListeners.splice(i, 1); } };
          if (disposables) disposables.push(d);
          return d;
        },
        show(preserveFocus) { /* no-op */ },
        webview: {
          options: options || {},
          get html() { return webviewHtml; },
          set html(value) {
            webviewHtml = value;
            host.emit(WorkerToMainMethods.UPDATE_WEBVIEW, wvViewId, { html: value });
          },
          onDidReceiveMessage: (listener, thisArgs, disposables) => {
            const bound = thisArgs ? listener.bind(thisArgs) : listener;
            messageListeners.push(bound);
            const d = { dispose() { const i = messageListeners.indexOf(bound); if (i !== -1) messageListeners.splice(i, 1); } };
            if (disposables) disposables.push(d);
            return d;
          },
          postMessage(message) {
            host.emit(WorkerToMainMethods.POST_WEBVIEW_MESSAGE, wvViewId, message);
            return Promise.resolve(true);
          },
          asWebviewUri(localResource) {
            return {
              scheme: 'https',
              authority: 'file+.vscode-resource.vscode-cdn.net',
              path: localResource.path,
              fsPath: localResource.fsPath,
              toString() { return `https://file+.vscode-resource.vscode-cdn.net${localResource.path}`; }
            };
          },
          get cspSource() { return "'self' https:"; },
          // Internal: receive message from main thread
          _receiveMessage(message) { messageListeners.forEach(l => l(message)); },
        },
      };

      // Notify main thread to create the webview
      host.emit(WorkerToMainMethods.CREATE_WEBVIEW, wvViewId, viewId, viewId, options || {});

      // Resolve the view — the provider will set .webview.html
      try {
        const result = provider.resolveWebviewView(
          webviewView,
          { state: undefined },
          { isCancellationRequested: false, onCancellationRequested: { dispose() {} } }
        );
        if (result && typeof result.then === 'function') {
          result.catch(e => console.error(`[registerWebviewViewProvider] resolveWebviewView failed for ${viewId}:`, e));
        }
      } catch (e) {
        console.error(`[registerWebviewViewProvider] resolveWebviewView threw for ${viewId}:`, e);
      }

      return {
        dispose() {
          disposeListeners.forEach(l => l());
          host.emit(WorkerToMainMethods.DISPOSE_WEBVIEW, wvViewId);
        }
      };
    },

    /**
     * Create tree view
     * @param {string} viewId
     * @param {object} options
     * @returns {object}
     */
    createTreeView(viewId, options) {
      // Would need main thread support
      console.warn('[window.createTreeView] Not fully implemented');
      return {
        visible: false,
        selection: [],
        onDidExpandElement: createNoOpEvent(),
        onDidCollapseElement: createNoOpEvent(),
        onDidChangeSelection: createNoOpEvent(),
        onDidChangeVisibility: createNoOpEvent(),
        reveal() { return Promise.resolve(); },
        dispose() {}
      };
    },

    /**
     * Register tree data provider
     * @param {string} viewId
     * @param {object} treeDataProvider
     * @returns {{ dispose(): void }}
     */
    registerTreeDataProvider(viewId, treeDataProvider) {
      // Would need main thread support
      console.warn('[window.registerTreeDataProvider] Not fully implemented');
      return { dispose() {} };
    },

    /**
     * Set status bar message (deprecated)
     * @param {string} text
     * @param {number} [hideAfterTimeout]
     * @returns {{ dispose(): void }}
     */
    setStatusBarMessage(text, hideAfterTimeout) {
      const item = this.createStatusBarItem(1, 1000);
      item.text = text;
      item.show();
      
      if (typeof hideAfterTimeout === 'number') {
        setTimeout(() => item.dispose(), hideAfterTimeout);
      }
      
      return item;
    },

    /**
     * Show text document
     * @param {any} document
     * @param {object} [options]
     * @returns {Promise<object>}
     */
    async showTextDocument(document, options) {
      // Would need main thread support
      return createTextEditorProxy(document);
    },

    /**
     * With progress
     * @param {object} options
     * @param {Function} task
     * @returns {Promise<any>}
     */
    withProgress(options, task) {
      // Simple implementation without UI
      const progress = {
        report(value) {
          // No-op
        }
      };
      
      const token = {
        isCancellationRequested: false,
        onCancellationRequested: createNoOpEvent()
      };
      
      return Promise.resolve(task(progress, token));
    },

    // Events
    onDidChangeActiveTextEditor: createEvent(onDidChangeActiveTextEditorListeners),
    onDidChangeVisibleTextEditors: createEvent(onDidChangeVisibleTextEditorsListeners),
    onDidChangeTextEditorSelection: createEvent(onDidChangeTextEditorSelectionListeners),
    onDidChangeTextEditorVisibleRanges: createEvent(onDidChangeTextEditorVisibleRangesListeners),

    // Text editor decoration type
    createTextEditorDecorationType(options) {
      const key = `decoration-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return {
        key,
        dispose() {
          host.emit(WorkerToMainMethods.DISPOSE_DECORATION_TYPE, key);
        }
      };
    }
  };
}

/**
 * Show a message
 * @param {string} type
 * @param {string} message
 * @param {any[]} items
 * @param {object} host
 * @returns {Promise<any>}
 */
function showMessage(type, message, items, host) {
  // Extract options if first item is an object with modal property
  let options = {};
  let actions = items;
  
  if (items.length > 0 && items[0] && typeof items[0] === 'object' && 'modal' in items[0]) {
    options = items[0];
    actions = items.slice(1);
  }

  host.emit(WorkerToMainMethods.SHOW_MESSAGE, type, message, { 
    ...options, 
    items: actions.map(a => typeof a === 'string' ? a : a.title)
  });

  // For now, return undefined (would need main thread response)
  return Promise.resolve(undefined);
}

/**
 * Create a text editor proxy
 * @param {object} document
 * @returns {object}
 */
function createTextEditorProxy(document) {
  return {
    document,
    selection: { 
      start: { line: 0, character: 0 }, 
      end: { line: 0, character: 0 },
      anchor: { line: 0, character: 0 },
      active: { line: 0, character: 0 },
      isEmpty: true,
      isSingleLine: true,
      isReversed: false
    },
    selections: [],
    visibleRanges: [],
    options: {
      tabSize: 2,
      insertSpaces: true
    },
    viewColumn: 1,
    
    async edit(callback) {
      // Would need main thread support
      return false;
    },
    
    async insertSnippet(snippet) {
      return false;
    },
    
    setDecorations(decorationType, rangesOrOptions) {
      // Would need main thread support
    },
    
    revealRange(range, revealType) {
      // Would need main thread support
    }
  };
}

/**
 * Create an event subscription function
 * @param {Function[]} listeners
 * @returns {Function}
 */
function createEvent(listeners) {
  return (listener, thisArgs, disposables) => {
    const bound = thisArgs ? listener.bind(thisArgs) : listener;
    listeners.push(bound);
    
    const disposable = {
      dispose() {
        const idx = listeners.indexOf(bound);
        if (idx !== -1) listeners.splice(idx, 1);
      }
    };
    
    if (disposables) disposables.push(disposable);
    return disposable;
  };
}

/**
 * Create a no-op event
 * @returns {Function}
 */
function createNoOpEvent() {
  return (listener, thisArgs, disposables) => {
    const disposable = { dispose() {} };
    if (disposables) disposables.push(disposable);
    return disposable;
  };
}
