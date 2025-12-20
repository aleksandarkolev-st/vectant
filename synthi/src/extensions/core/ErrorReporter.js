/**
 * Synthi Extension System - User-Facing Error Reporter
 * PHASE F: Clear Error Reporting
 * 
 * When something fails, users need to know:
 * - WHAT failed
 * - WHY it failed
 * - WHAT was done (killed, restarted, disabled)
 * 
 * Silent failure = user rage
 */

import { ExtensionState, FailureType, getStateDescription } from './ExtensionState.js';

/**
 * @typedef {Object} UserFacingError
 * @property {string} title - Short title for toast/banner
 * @property {string} message - Human-readable explanation
 * @property {string} action - What the system did in response
 * @property {string} [suggestion] - What the user can do
 * @property {'info'|'warning'|'error'} severity
 * @property {string} extensionId
 * @property {string} extensionName
 * @property {number} timestamp
 * @property {string} [technicalDetails] - For advanced users
 */

/**
 * Error message templates
 */
const ERROR_TEMPLATES = {
  [FailureType.ACTIVATION_TIMEOUT]: {
    title: 'Extension Blocked',
    message: '{name} took too long to start and was blocked to protect your editor.',
    action: 'The extension has been quarantined and will not run again until you re-enable it.',
    suggestion: 'If this was a mistake, you can try re-enabling the extension from settings.',
    severity: 'error'
  },
  
  [FailureType.RUNTIME_EXCEPTION]: {
    title: 'Extension Error',
    message: '{name} encountered an error while running.',
    action: 'The extension was restarted to prevent further issues.',
    suggestion: 'If this keeps happening, try disabling the extension or checking for updates.',
    severity: 'warning'
  },
  
  [FailureType.WORKER_DEATH]: {
    title: 'Extension System Restarted',
    message: 'The extension system had to restart. {name} may have caused the issue.',
    action: 'All extensions were reloaded. Some may need to be reactivated.',
    suggestion: 'If the problem persists, try disabling recently installed extensions.',
    severity: 'warning'
  },
  
  [FailureType.PROTOCOL_VIOLATION]: {
    title: 'Security Issue Detected',
    message: '{name} violated security protocols and was blocked.',
    action: 'The extension has been quarantined for security.',
    suggestion: 'This extension may be malicious. Consider uninstalling it.',
    severity: 'error'
  },
  
  [FailureType.CPU_LIMIT_EXCEEDED]: {
    title: 'Performance Issue',
    message: '{name} is using too much CPU and has been temporarily paused.',
    action: 'The extension was suspended to keep your editor responsive.',
    suggestion: 'The extension will resume automatically. If this keeps happening, consider disabling it.',
    severity: 'warning'
  },
  
  [FailureType.MEMORY_LIMIT_EXCEEDED]: {
    title: 'Memory Issue',
    message: '{name} is using too much memory.',
    action: 'The extension was restarted to free up memory.',
    suggestion: 'If this keeps happening, the extension may have a memory leak.',
    severity: 'warning'
  },
  
  [FailureType.MESSAGE_FLOOD]: {
    title: 'Extension Throttled',
    message: '{name} is sending too many messages and has been slowed down.',
    action: 'Message rate limiting is active to protect performance.',
    suggestion: 'The extension should continue working, but may be slower.',
    severity: 'info'
  },
  
  [FailureType.LOAD_FAILURE]: {
    title: 'Extension Failed to Load',
    message: '{name} could not be loaded.',
    action: 'The extension was disabled because it failed to load.',
    suggestion: 'The extension may be corrupted or incompatible. Try reinstalling it.',
    severity: 'error'
  }
};

/**
 * State transition messages
 */
const STATE_MESSAGES = {
  [ExtensionState.QUARANTINED]: {
    title: 'Extension Quarantined',
    message: '{name} has been quarantined due to repeated issues.',
    action: 'The extension will not run until you manually re-enable it.',
    suggestion: 'You can re-enable it from the extension settings if you believe this was a mistake.',
    severity: 'error'
  },
  
  [ExtensionState.SUSPENDED]: {
    title: 'Extension Suspended',
    message: '{name} has been temporarily suspended.',
    action: 'The extension will resume when conditions improve.',
    suggestion: 'This is usually temporary and will resolve automatically.',
    severity: 'info'
  },
  
  [ExtensionState.CRASHED]: {
    title: 'Extension Crashed',
    message: '{name} crashed unexpectedly.',
    action: 'The system will attempt to recover the extension.',
    suggestion: 'If the extension keeps crashing, try disabling it.',
    severity: 'warning'
  },
  
  [ExtensionState.DISABLED]: {
    title: 'Extension Disabled',
    message: '{name} has been disabled.',
    action: 'The extension is no longer running.',
    suggestion: 'You can re-enable it from settings.',
    severity: 'info'
  }
};

/**
 * Extension Error Reporter
 */
export class ExtensionErrorReporter {
  constructor() {
    /** @type {UserFacingError[]} */
    this.errorHistory = [];
    
    /** @type {number} */
    this.maxHistorySize = 100;
    
    /** @type {((error: UserFacingError) => void)|null} */
    this.onError = null;
    
    /** @type {((error: UserFacingError) => void)|null} */
    this.onWarning = null;
    
    /** @type {((error: UserFacingError) => void)|null} */
    this.onInfo = null;
  }

  /**
   * Report a failure
   * @param {string} extensionId
   * @param {string} extensionName
   * @param {FailureType} failureType
   * @param {string} [technicalReason]
   * @returns {UserFacingError}
   */
  reportFailure(extensionId, extensionName, failureType, technicalReason = null) {
    const template = ERROR_TEMPLATES[failureType] || {
      title: 'Extension Issue',
      message: '{name} encountered an issue.',
      action: 'The system responded to protect your editor.',
      suggestion: 'Try restarting the extension or the editor.',
      severity: 'warning'
    };

    const error = this._createError(extensionId, extensionName, template, technicalReason);
    this._record(error);
    this._notify(error);
    
    return error;
  }

  /**
   * Report a state transition
   * @param {string} extensionId
   * @param {string} extensionName
   * @param {ExtensionState} newState
   * @param {string} [reason]
   * @returns {UserFacingError|null}
   */
  reportStateChange(extensionId, extensionName, newState, reason = null) {
    // Only report significant state changes
    const template = STATE_MESSAGES[newState];
    if (!template) {
      return null;
    }

    const error = this._createError(extensionId, extensionName, template, reason);
    this._record(error);
    this._notify(error);
    
    return error;
  }

  /**
   * Report a worker restart
   * @param {string} [triggeringExtensionId]
   * @param {string} [triggeringExtensionName]
   * @param {string} reason
   * @returns {UserFacingError}
   */
  reportWorkerRestart(triggeringExtensionId, triggeringExtensionName, reason) {
    const error = {
      title: 'Extension System Restarted',
      message: triggeringExtensionName 
        ? `The extension system was restarted due to issues with ${triggeringExtensionName}.`
        : 'The extension system was restarted to recover from an error.',
      action: 'All healthy extensions have been reloaded.',
      suggestion: 'Your extensions should continue working normally.',
      severity: 'warning',
      extensionId: triggeringExtensionId || 'system',
      extensionName: triggeringExtensionName || 'System',
      timestamp: Date.now(),
      technicalDetails: reason
    };

    this._record(error);
    this._notify(error);
    
    return error;
  }

  /**
   * Report successful recovery
   * @param {string} extensionId
   * @param {string} extensionName
   * @returns {UserFacingError}
   */
  reportRecovery(extensionId, extensionName) {
    const error = {
      title: 'Extension Recovered',
      message: `${extensionName} has been successfully recovered.`,
      action: 'The extension is now running normally.',
      suggestion: null,
      severity: 'info',
      extensionId,
      extensionName,
      timestamp: Date.now()
    };

    this._record(error);
    this._notify(error);
    
    return error;
  }

  /**
   * Get recent errors
   * @param {number} [count=10]
   * @returns {UserFacingError[]}
   */
  getRecentErrors(count = 10) {
    return this.errorHistory.slice(-count);
  }

  /**
   * Get errors for a specific extension
   * @param {string} extensionId
   * @returns {UserFacingError[]}
   */
  getErrorsForExtension(extensionId) {
    return this.errorHistory.filter(e => e.extensionId === extensionId);
  }

  /**
   * Clear error history
   */
  clearHistory() {
    this.errorHistory = [];
  }

  /**
   * Format error for display (e.g., in a toast notification)
   * @param {UserFacingError} error
   * @returns {{title: string, body: string, type: string}}
   */
  formatForToast(error) {
    return {
      title: error.title,
      body: error.message,
      type: error.severity
    };
  }

  /**
   * Format error for detailed view (e.g., in a panel)
   * @param {UserFacingError} error
   * @returns {string}
   */
  formatDetailed(error) {
    let text = `## ${error.title}\n\n`;
    text += `**Extension:** ${error.extensionName}\n\n`;
    text += `${error.message}\n\n`;
    text += `**What happened:** ${error.action}\n\n`;
    
    if (error.suggestion) {
      text += `**What you can do:** ${error.suggestion}\n\n`;
    }
    
    text += `*${new Date(error.timestamp).toLocaleString()}*\n`;
    
    if (error.technicalDetails) {
      text += `\n---\n\n**Technical details:**\n\`\`\`\n${error.technicalDetails}\n\`\`\`\n`;
    }
    
    return text;
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  _createError(extensionId, extensionName, template, technicalReason) {
    return {
      title: template.title,
      message: template.message.replace('{name}', extensionName),
      action: template.action,
      suggestion: template.suggestion,
      severity: template.severity,
      extensionId,
      extensionName,
      timestamp: Date.now(),
      technicalDetails: technicalReason
    };
  }

  _record(error) {
    this.errorHistory.push(error);
    
    // Trim if too large
    if (this.errorHistory.length > this.maxHistorySize) {
      this.errorHistory = this.errorHistory.slice(-this.maxHistorySize / 2);
    }
  }

  _notify(error) {
    switch (error.severity) {
      case 'error':
        if (this.onError) this.onError(error);
        console.error(`[Extension] ${error.title}: ${error.message}`);
        break;
      case 'warning':
        if (this.onWarning) this.onWarning(error);
        console.warn(`[Extension] ${error.title}: ${error.message}`);
        break;
      case 'info':
        if (this.onInfo) this.onInfo(error);
        console.log(`[Extension] ${error.title}: ${error.message}`);
        break;
    }
  }
}

// Singleton
let reporterInstance = null;

/**
 * Get the singleton ExtensionErrorReporter
 * @returns {ExtensionErrorReporter}
 */
export function getErrorReporter() {
  if (!reporterInstance) {
    reporterInstance = new ExtensionErrorReporter();
  }
  return reporterInstance;
}

/**
 * Create a new ExtensionErrorReporter (for testing)
 * @returns {ExtensionErrorReporter}
 */
export function createErrorReporter() {
  return new ExtensionErrorReporter();
}
