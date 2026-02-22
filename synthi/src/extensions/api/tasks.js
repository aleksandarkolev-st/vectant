/**
 * Synthi Extension System - Tasks API
 * vscode.tasks namespace implementation
 *
 * Provides task execution support routed through the main thread
 * to the remote VS Code Server or terminal service.
 */

import { WorkerToMainMethods } from '../bridge/MessageProtocol.js';

/**
 * Create tasks API namespace
 * @param {string} extensionId
 * @param {import('../host/ExtensionHostMain.js').ExtensionHostMain} host
 * @returns {object}
 */
export function createTasksAPI(extensionId, host) {
  const taskProviders = new Map();
  let taskProviderIdCounter = 0;

  const onDidStartTaskListeners = [];
  const onDidEndTaskListeners = [];
  const onDidStartTaskProcessListeners = [];
  const onDidEndTaskProcessListeners = [];

  return {
    registerTaskProvider(type, provider) {
      const id = `${extensionId}:task:${++taskProviderIdCounter}`;
      taskProviders.set(id, { type, provider });
      host.emit(WorkerToMainMethods.TASK_REGISTER_PROVIDER, id, type, extensionId);
      console.log(`[tasks] Registered task provider for type: ${type}`);
      return {
        dispose() {
          taskProviders.delete(id);
        }
      };
    },

    async fetchTasks(filter) {
      // Aggregate tasks from all registered providers
      const allTasks = [];
      for (const [, entry] of taskProviders) {
        if (filter?.type && entry.type !== filter.type) continue;
        try {
          const tasks = await entry.provider.provideTasks();
          if (tasks) allTasks.push(...tasks);
        } catch (e) {
          console.warn(`[tasks] Provider error:`, e);
        }
      }
      return allTasks;
    },

    async executeTask(task) {
      try {
        const result = await host.request(WorkerToMainMethods.TASK_EXECUTE, [{
          name: task.name,
          source: task.source || extensionId,
          definition: task.definition,
          execution: task.execution ? {
            commandLine: task.execution.commandLine,
            process: task.execution.process,
            args: task.execution.args,
            options: task.execution.options
          } : undefined,
          group: task.group,
          presentationOptions: task.presentationOptions,
          problemMatchers: task.problemMatchers,
          isBackground: task.isBackground,
          scope: task.scope
        }]);

        return {
          terminate() {
            // Fire-and-forget kill
          }
        };
      } catch (e) {
        console.error('[tasks] Execute failed:', e);
        return { terminate() {} };
      }
    },

    get taskExecutions() {
      return [];
    },

    onDidStartTask: _createEvent(onDidStartTaskListeners),
    onDidEndTask: _createEvent(onDidEndTaskListeners),
    onDidStartTaskProcess: _createEvent(onDidStartTaskProcessListeners),
    onDidEndTaskProcess: _createEvent(onDidEndTaskProcessListeners),

    _listeners: {
      onDidStartTask: onDidStartTaskListeners,
      onDidEndTask: onDidEndTaskListeners,
      onDidStartTaskProcess: onDidStartTaskProcessListeners,
      onDidEndTaskProcess: onDidEndTaskProcessListeners,
    },
    _taskProviders: taskProviders,
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
