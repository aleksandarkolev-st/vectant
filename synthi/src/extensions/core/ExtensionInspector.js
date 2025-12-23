/**
 * Synthi Extension System - Extension Inspector
 * PHASE D: Observability
 * 
 * Internal debugging tool for extension system monitoring.
 * Shows:
 * - Extension ID + version
 * - Current state
 * - Last activation time
 * - CPU usage
 * - Memory usage (estimated)
 * - Last error stack
 * - Restart / disable / quarantine actions
 * 
 * Also persists crash history for analysis.
 */

import { ExtensionState, getStateDescription } from './ExtensionState.js';
import { getExtensionStateReducer } from './ExtensionStateReducer.js';

/**
 * @typedef {Object} ExtensionInspectorEntry
 * @property {string} extensionId
 * @property {string} displayName
 * @property {string} version
 * @property {string} state
 * @property {string} stateDescription
 * @property {number} activationTime
 * @property {number} cpuTime
 * @property {number} memoryEstimate
 * @property {string|null} lastError
 * @property {string|null} lastErrorStack
 * @property {number} failureCount
 * @property {Array} failureHistory
 * @property {number} activationAttempts
 * @property {string[]} commands
 */

/**
 * @typedef {Object} CrashRecord
 * @property {string} extensionId
 * @property {string} type
 * @property {string} reason
 * @property {number} timestamp
 * @property {string} [stack]
 */

/**
 * Crash history persistence key
 */
const CRASH_HISTORY_KEY = 'synthi.extension.crashHistory';
const MAX_CRASH_RECORDS = 500;

/**
 * Extension Inspector - Internal Debugging Tool
 */
export class ExtensionInspector {
  constructor() {
    /** @type {ExtensionStateReducer} */
    this.stateReducer = getExtensionStateReducer();
    
    /** @type {Map<string, {cpuTime: number, lastActivity: number, memoryEstimate: number}>} */
    this.metrics = new Map();
    
    /** @type {CrashRecord[]} */
    this.crashHistory = [];
    
    /** @type {number} */
    this.sessionStart = Date.now();
    
    // Load persisted crash history
    this._loadCrashHistory();
    
    // Subscribe to state changes
    this.stateReducer.subscribe((state, action) => {
      this._handleStateChange(state, action);
    });
  }

  /**
   * Get inspector data for all extensions
   * @returns {ExtensionInspectorEntry[]}
   */
  getAll() {
    const extensions = this.stateReducer.getAllExtensions();
    return extensions.map(ext => this._createEntry(ext));
  }

  /**
   * Get inspector data for one extension
   * @param {string} extensionId
   * @returns {ExtensionInspectorEntry|null}
   */
  get(extensionId) {
    const ext = this.stateReducer.getExtension(extensionId);
    if (!ext) return null;
    return this._createEntry(ext);
  }

  /**
   * Get extensions in a specific state
   * @param {ExtensionState} state
   * @returns {ExtensionInspectorEntry[]}
   */
  getByState(state) {
    const extensions = this.stateReducer.getExtensionsByState(state);
    return extensions.map(ext => this._createEntry(ext));
  }

  /**
   * Get all quarantined extensions
   * @returns {ExtensionInspectorEntry[]}
   */
  getQuarantined() {
    return this.getByState(ExtensionState.QUARANTINED);
  }

  /**
   * Get all crashed extensions
   * @returns {ExtensionInspectorEntry[]}
   */
  getCrashed() {
    return this.getByState(ExtensionState.CRASHED);
  }

  /**
   * Get crash history for an extension
   * @param {string} extensionId
   * @returns {CrashRecord[]}
   */
  getCrashHistory(extensionId) {
    return this.crashHistory.filter(r => r.extensionId === extensionId);
  }

  /**
   * Get full crash history
   * @returns {CrashRecord[]}
   */
  getFullCrashHistory() {
    return [...this.crashHistory];
  }

  /**
   * Get crash statistics
   * @returns {object}
   */
  getCrashStats() {
    const byExtension = new Map();
    const byType = new Map();
    
    for (const record of this.crashHistory) {
      // By extension
      const extCount = byExtension.get(record.extensionId) || 0;
      byExtension.set(record.extensionId, extCount + 1);
      
      // By type
      const typeCount = byType.get(record.type) || 0;
      byType.set(record.type, typeCount + 1);
    }

    // Sort by count
    const topCrashing = [...byExtension.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, count]) => ({ extensionId: id, count }));

    return {
      totalCrashes: this.crashHistory.length,
      topCrashingExtensions: topCrashing,
      crashesByType: Object.fromEntries(byType),
      sessionCrashes: this.crashHistory.filter(r => r.timestamp > this.sessionStart).length,
      crashHistorySize: this.crashHistory.length
    };
  }

  /**
   * Update metrics for an extension
   * @param {string} extensionId
   * @param {{cpuTime?: number, memoryEstimate?: number}} metrics
   */
  updateMetrics(extensionId, metrics) {
    let entry = this.metrics.get(extensionId);
    if (!entry) {
      entry = { cpuTime: 0, lastActivity: Date.now(), memoryEstimate: 0 };
      this.metrics.set(extensionId, entry);
    }

    if (typeof metrics.cpuTime === 'number') {
      entry.cpuTime = metrics.cpuTime;
    }
    if (typeof metrics.memoryEstimate === 'number') {
      entry.memoryEstimate = metrics.memoryEstimate;
    }
    entry.lastActivity = Date.now();
  }

  /**
   * Record a crash
   * @param {string} extensionId
   * @param {string} type
   * @param {string} reason
   * @param {string} [stack]
   */
  recordCrash(extensionId, type, reason, stack = null) {
    const record = {
      extensionId,
      type,
      reason,
      timestamp: Date.now(),
      stack: stack ? stack.slice(0, 5000) : null // Limit stack size
    };

    this.crashHistory.push(record);
    
    // Trim if too large
    if (this.crashHistory.length > MAX_CRASH_RECORDS) {
      this.crashHistory = this.crashHistory.slice(-MAX_CRASH_RECORDS / 2);
    }

    // Persist
    this._saveCrashHistory();
  }

  /**
   * Clear crash history for an extension
   * @param {string} extensionId
   */
  clearCrashHistory(extensionId) {
    this.crashHistory = this.crashHistory.filter(r => r.extensionId !== extensionId);
    this._saveCrashHistory();
  }

  /**
   * Clear all crash history
   */
  clearAllCrashHistory() {
    this.crashHistory = [];
    this._saveCrashHistory();
  }

  /**
   * Get system overview
   * @returns {object}
   */
  getSystemOverview() {
    const extensions = this.stateReducer.getAllExtensions();
    const state = this.stateReducer.getState();
    
    const byState = {
      [ExtensionState.INSTALLED]: 0,
      [ExtensionState.LOADED]: 0,
      [ExtensionState.ACTIVATING]: 0,
      [ExtensionState.ACTIVE]: 0,
      [ExtensionState.SUSPENDED]: 0,
      [ExtensionState.CRASHED]: 0,
      [ExtensionState.QUARANTINED]: 0,
      [ExtensionState.DISABLED]: 0
    };

    let totalCpuTime = 0;
    let totalMemory = 0;

    for (const ext of extensions) {
      byState[ext.state] = (byState[ext.state] || 0) + 1;
      
      const metrics = this.metrics.get(ext.extensionId);
      if (metrics) {
        totalCpuTime += metrics.cpuTime;
        totalMemory += metrics.memoryEstimate;
      }
    }

    return {
      totalExtensions: extensions.length,
      byState,
      workerGeneration: state.workerGeneration,
      workerStatus: state.workerStatus,
      totalCpuTime,
      totalMemoryEstimate: totalMemory,
      quarantinedCount: state.quarantinedIds.size,
      sessionUptime: Date.now() - this.sessionStart,
      actionLogSize: state.actionLog.length
    };
  }

  /**
   * Generate diagnostic report
   * @returns {string}
   */
  generateReport() {
    const overview = this.getSystemOverview();
    const crashStats = this.getCrashStats();
    const quarantined = this.getQuarantined();
    const crashed = this.getCrashed();

    let report = '=== SYNTHI EXTENSION SYSTEM DIAGNOSTIC REPORT ===\n\n';
    report += `Generated: ${new Date().toISOString()}\n`;
    report += `Session Uptime: ${Math.round(overview.sessionUptime / 1000)}s\n\n`;

    report += '--- System Overview ---\n';
    report += `Total Extensions: ${overview.totalExtensions}\n`;
    report += `Worker Generation: ${overview.workerGeneration}\n`;
    report += `Worker Status: ${overview.workerStatus}\n`;
    report += `Total CPU Time: ${overview.totalCpuTime.toFixed(2)}ms\n`;
    report += `Memory Estimate: ${(overview.totalMemoryEstimate / 1024 / 1024).toFixed(2)}MB\n\n`;

    report += '--- Extensions by State ---\n';
    for (const [state, count] of Object.entries(overview.byState)) {
      if (count > 0) {
        report += `  ${state}: ${count}\n`;
      }
    }
    report += '\n';

    report += '--- Crash Statistics ---\n';
    report += `Total Crashes: ${crashStats.totalCrashes}\n`;
    report += `Session Crashes: ${crashStats.sessionCrashes}\n`;
    if (crashStats.topCrashingExtensions.length > 0) {
      report += 'Top Crashing:\n';
      for (const { extensionId, count } of crashStats.topCrashingExtensions.slice(0, 5)) {
        report += `  ${extensionId}: ${count}\n`;
      }
    }
    report += '\n';

    if (quarantined.length > 0) {
      report += '--- Quarantined Extensions ---\n';
      for (const ext of quarantined) {
        report += `  ${ext.extensionId}: ${ext.lastError || 'Unknown reason'}\n`;
      }
      report += '\n';
    }

    if (crashed.length > 0) {
      report += '--- Crashed Extensions ---\n';
      for (const ext of crashed) {
        report += `  ${ext.extensionId}: ${ext.lastError || 'Unknown reason'}\n`;
      }
      report += '\n';
    }

    report += '=== END OF REPORT ===\n';
    return report;
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  _createEntry(ext) {
    const metrics = this.metrics.get(ext.extensionId) || {
      cpuTime: 0,
      lastActivity: 0,
      memoryEstimate: 0
    };

    const commands = [];
    if (ext.manifest?.contributes?.commands) {
      for (const cmd of ext.manifest.contributes.commands) {
        if (cmd?.command) commands.push(cmd.command);
      }
    }

    return {
      extensionId: ext.extensionId,
      displayName: ext.manifest?.displayName || ext.manifest?.name || ext.extensionId,
      version: ext.manifest?.version || 'unknown',
      state: ext.state,
      stateDescription: getStateDescription(ext.state),
      activationTime: ext.lastActivationTime || 0,
      cpuTime: metrics.cpuTime,
      memoryEstimate: metrics.memoryEstimate,
      lastError: ext.failureReason,
      lastErrorStack: ext.failureHistory.length > 0 
        ? ext.failureHistory[ext.failureHistory.length - 1].stack 
        : null,
      failureCount: ext.failureHistory.length,
      failureHistory: ext.failureHistory.slice(-10), // Last 10 failures
      activationAttempts: ext.activationAttempts,
      commands
    };
  }

  _handleStateChange(state, action) {
    // Record crashes when state transitions to CRASHED or QUARANTINED
    if (action.type === 'ACTIVATE_FAILURE' || 
        action.type === 'REPORT_FAILURE' ||
        action.type === 'QUARANTINE') {
      const ext = state.extensions.get(action.extensionId);
      if (ext && (ext.state === ExtensionState.CRASHED || 
                  ext.state === ExtensionState.QUARANTINED)) {
        this.recordCrash(
          action.extensionId,
          action.payload?.failureType || 'unknown',
          ext.failureReason || 'Unknown',
          action.payload?.stack
        );
      }
    }
  }

  _loadCrashHistory() {
    try {
      if (typeof localStorage !== 'undefined') {
        const stored = localStorage.getItem(CRASH_HISTORY_KEY);
        if (stored) {
          this.crashHistory = JSON.parse(stored);
        }
      }
    } catch (err) {
      console.warn('[ExtensionInspector] Failed to load crash history:', err);
    }
  }

  _saveCrashHistory() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(CRASH_HISTORY_KEY, JSON.stringify(this.crashHistory));
      }
    } catch (err) {
      console.warn('[ExtensionInspector] Failed to save crash history:', err);
    }
  }
}

// Singleton
let inspectorInstance = null;

/**
 * Get the singleton ExtensionInspector
 * @returns {ExtensionInspector}
 */
export function getExtensionInspector() {
  if (!inspectorInstance) {
    inspectorInstance = new ExtensionInspector();
  }
  return inspectorInstance;
}

/**
 * Create a new ExtensionInspector (for testing)
 * @returns {ExtensionInspector}
 */
export function createExtensionInspector() {
  return new ExtensionInspector();
}
