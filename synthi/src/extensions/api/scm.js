/**
 * Synthi Extension System - SCM API
 * vscode.scm namespace implementation
 *
 * Source Control Management API for Git and other providers.
 * Routes operations through the main thread to the remote server.
 */

import { WorkerToMainMethods } from '../bridge/MessageProtocol.js';

let scmIdCounter = 0;

/**
 * Create SCM API namespace
 * @param {string} extensionId
 * @param {import('../host/ExtensionHostMain.js').ExtensionHostMain} host
 * @returns {object}
 */
export function createSCMAPI(extensionId, host) {
  const sourceControls = new Map();

  return {
    get inputBox() {
      return {
        value: '',
        placeholder: '',
        visible: true,
        enabled: true
      };
    },

    createSourceControl(id, label, rootUri) {
      const scmId = `${extensionId}:scm:${++scmIdCounter}`;
      const resourceGroups = [];
      const onDidChangeSelectionListeners = [];

      const sourceControl = {
        id,
        label,
        rootUri,
        count: 0,
        quickDiffProvider: undefined,
        commitTemplate: '',
        acceptInputCommand: undefined,
        statusBarCommands: undefined,

        get inputBox() {
          return {
            value: '',
            placeholder: `Message (press Ctrl+Enter to commit)`,
            visible: true,
            enabled: true
          };
        },

        createResourceGroup(groupId, groupLabel) {
          const resources = [];
          const group = {
            id: groupId,
            label: groupLabel,
            hideWhenEmpty: false,

            get resourceStates() {
              return [...resources];
            },
            set resourceStates(states) {
              resources.length = 0;
              resources.push(...states);
              // Notify main thread of SCM update
              host.emit(WorkerToMainMethods.SCM_UPDATE, scmId, groupId, states.map(s => ({
                resourceUri: s.resourceUri?.toString(),
                command: s.command,
                decorations: s.decorations,
                contextValue: s.contextValue
              })));
            },

            dispose() {
              const idx = resourceGroups.indexOf(group);
              if (idx >= 0) resourceGroups.splice(idx, 1);
            }
          };
          resourceGroups.push(group);
          return group;
        },

        dispose() {
          sourceControls.delete(scmId);
          host.emit(WorkerToMainMethods.SCM_DISPOSE, scmId);
        }
      };

      sourceControls.set(scmId, sourceControl);
      host.emit(WorkerToMainMethods.SCM_CREATE_SOURCE_CONTROL, scmId, id, label, rootUri?.toString());
      console.log(`[scm] Created source control: ${label} (${id})`);

      return sourceControl;
    }
  };
}
