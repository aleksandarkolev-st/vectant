/**
 * Synthi Extension System - Terminal API
 * vscode.window.createTerminal + vscode.window.terminals support
 *
 * Routes terminal creation/send through the main thread
 * which manages the actual terminal via WebRTC DataChannel.
 */

import { WorkerToMainMethods } from '../bridge/MessageProtocol.js';

let terminalIdCounter = 0;

/**
 * Create a terminal factory for the window API
 * @param {string} extensionId
 * @param {import('../host/ExtensionHostMain.js').ExtensionHostMain} host
 * @returns {object}
 */
export function createTerminalSupport(extensionId, host) {
  if (!host._terminals) {
    host._terminals = new Map();
  }

  const onDidOpenTerminalListeners = [];
  const onDidCloseTerminalListeners = [];
  const onDidChangeActiveTerminalListeners = [];
  const onDidWriteTerminalDataListeners = [];

  return {
    createTerminal(nameOrOptions, shellPath, shellArgs) {
      const termId = `${extensionId}:term:${++terminalIdCounter}`;
      let opts;
      if (typeof nameOrOptions === 'object') {
        opts = nameOrOptions;
      } else {
        opts = { name: nameOrOptions, shellPath, shellArgs };
      }

      const terminal = {
        name: opts.name || 'Extension Terminal',
        processId: Promise.resolve(undefined),
        creationOptions: opts,
        exitStatus: undefined,
        state: { isInteractedWith: false },

        sendText(text, addNewLine = true) {
          host.emit(WorkerToMainMethods.TERMINAL_SEND_TEXT, termId, text, addNewLine);
        },

        show(preserveFocus) {
          // Notify main thread to show terminal
        },

        hide() {
          // Notify main thread to hide terminal
        },

        dispose() {
          host._terminals.delete(termId);
          host.emit(WorkerToMainMethods.TERMINAL_DISPOSE, termId);
          _fireEvent(onDidCloseTerminalListeners, terminal);
        }
      };

      host._terminals.set(termId, terminal);
      host.emit(WorkerToMainMethods.TERMINAL_CREATE, termId, {
        name: opts.name,
        shellPath: opts.shellPath,
        shellArgs: opts.shellArgs,
        cwd: opts.cwd?.toString?.() || opts.cwd,
        env: opts.env,
        extensionId
      });

      _fireEvent(onDidOpenTerminalListeners, terminal);
      return terminal;
    },

    get terminals() {
      return Array.from(host._terminals?.values() || []);
    },

    get activeTerminal() {
      return host._activeTerminal || undefined;
    },

    onDidOpenTerminal: _createEvent(onDidOpenTerminalListeners),
    onDidCloseTerminal: _createEvent(onDidCloseTerminalListeners),
    onDidChangeActiveTerminal: _createEvent(onDidChangeActiveTerminalListeners),
    onDidWriteTerminalData: _createEvent(onDidWriteTerminalDataListeners),

    _listeners: {
      onDidOpenTerminal: onDidOpenTerminalListeners,
      onDidCloseTerminal: onDidCloseTerminalListeners,
      onDidChangeActiveTerminal: onDidChangeActiveTerminalListeners,
    }
  };
}

function _createEvent(listeners) {
  return (listener, thisArgs, disposables) => {
    const bound = thisArgs ? listener.bind(thisArgs) : listener;
    listeners.push(bound);
    const disposable = {
      dispose() {
        const idx = listeners.indexOf(bound);
        if (idx >= 0) listeners.splice(idx, 1);
      }
    };
    if (disposables) disposables.push(disposable);
    return disposable;
  };
}

function _fireEvent(listeners, data) {
  for (const l of listeners) {
    try { l(data); } catch (e) { console.error('[terminal] Event handler error:', e); }
  }
}
