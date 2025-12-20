/**
 * Synthi Extension System - Commands API
 * vscode.commands namespace implementation
 */

import { WorkerToMainMethods } from '../bridge/MessageProtocol.js';

/**
 * Create commands API
 * @param {string} extensionId
 * @param {import('../host/ExtensionHostMain.js').ExtensionHostMain} host
 * @returns {object}
 */
export function createCommandsAPI(extensionId, host) {
  return {
    /**
     * Register a command handler
     * @param {string} command
     * @param {Function} callback
     * @param {any} thisArg
     * @returns {{ dispose(): void }}
     */
    registerCommand(command, callback, thisArg) {
      const handler = thisArg ? callback.bind(thisArg) : callback;
      return host.registerCommand(extensionId, command, handler);
    },

    /**
     * Register a text editor command
     * @param {string} command
     * @param {Function} callback
     * @param {any} thisArg
     * @returns {{ dispose(): void }}
     */
    registerTextEditorCommand(command, callback, thisArg) {
      const handler = (textEditor, edit, ...args) => {
        const boundCallback = thisArg ? callback.bind(thisArg) : callback;
        return boundCallback(textEditor, edit, ...args);
      };
      return host.registerCommand(extensionId, command, handler);
    },

    /**
     * Execute a command
     * @param {string} command
     * @param {...any} args
     * @returns {Promise<any>}
     */
    async executeCommand(command, ...args) {
      // Check local commands first
      const localCmd = host.commands.get(command);
      if (localCmd) {
        return host._executeCommand(command, ...args);
      }

      // Otherwise, request from main thread (built-in commands)
      return new Promise((resolve, reject) => {
        // For now, throw - built-in commands not yet implemented
        reject(new Error(`Command not found: ${command}`));
      });
    },

    /**
     * Get all available commands
     * @param {boolean} [filterInternal]
     * @returns {Promise<string[]>}
     */
    async getCommands(filterInternal = false) {
      const commands = Array.from(host.commands.keys());
      if (filterInternal) {
        return commands.filter(c => !c.startsWith('_'));
      }
      return commands;
    }
  };
}
