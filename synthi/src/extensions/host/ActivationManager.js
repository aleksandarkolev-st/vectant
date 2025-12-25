/**
 * Synthi Extension System - Activation Manager
 * Handles extension activation with strict discipline
 */

import { createExtensionContext } from './ExtensionContext.js';
import { WorkerToMainMethods } from '../bridge/MessageProtocol.js';

// Activation budgets
const ACTIVATION_SOFT_LIMIT = 200;  // ms - warning
const ACTIVATION_HARD_LIMIT = 1000; // ms - kill

export class ActivationManager {
  /**
   * @param {import('./ExtensionHostMain.js').ExtensionHostMain} host
   */
  constructor(host) {
    /** @type {import('./ExtensionHostMain.js').ExtensionHostMain} */
    this.host = host;
    
    /** @type {Set<string>} Currently activating extensions */
    this.activating = new Set();
    
    /** @type {Map<string, number>} Activation attempt counts */
    this.activationAttempts = new Map();
    
    /** @type {number} Max activation attempts before permanent block */
    this.maxAttempts = 3;
  }

  /**
   * Activate an extension
   * @param {string} extensionId
   * @returns {Promise<{ success: boolean, activationTime: number, error?: string }>}
   */
  async activate(extensionId) {
    // Check if already activating
    if (this.activating.has(extensionId)) {
      return { success: false, activationTime: 0, error: 'Already activating' };
    }

    // Check if context already exists (already active)
    if (this.host.getContext(extensionId)) {
      return { success: true, activationTime: 0 };
    }

    // Get extension
    const ext = this.host.getExtension(extensionId);
    if (!ext) {
      return { success: false, activationTime: 0, error: 'Extension not loaded' };
    }

    // Check activation attempts
    const attempts = this.activationAttempts.get(extensionId) || 0;
    if (attempts >= this.maxAttempts) {
      return { 
        success: false, 
        activationTime: 0, 
        error: `Extension blocked after ${this.maxAttempts} failed activations` 
      };
    }

    this.activating.add(extensionId);
    const startTime = performance.now();

    try {
      // Create activation timeout
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Activation timeout (${ACTIVATION_HARD_LIMIT}ms)`));
        }, ACTIVATION_HARD_LIMIT);
      });

      // Create extension context
      const context = createExtensionContext(extensionId, ext.manifest, this.host);
      
      // Call activate function
      const activatePromise = this._callActivate(extensionId, ext.module, context);
      
      // Race against timeout
      await Promise.race([activatePromise, timeoutPromise]);

      const activationTime = performance.now() - startTime;

      // Store context
      this.host.setContext(extensionId, context);

      // Check soft limit
      if (activationTime > ACTIVATION_SOFT_LIMIT) {
        console.warn(
          `[ActivationManager] Extension ${extensionId} activation took ${activationTime.toFixed(0)}ms ` +
          `(soft limit: ${ACTIVATION_SOFT_LIMIT}ms)`
        );
      }

      // Update metrics
      const metrics = this.host.metrics.get(extensionId);
      if (metrics) {
        metrics.activationTime = activationTime;
      }

      // Reset attempt counter on success
      this.activationAttempts.delete(extensionId);

      // Notify main thread
      this.host.emit(
        WorkerToMainMethods.ACTIVATION_COMPLETE,
        extensionId,
        true,
        activationTime,
        null
      );

      console.log(`[ActivationManager] ${extensionId} activated in ${activationTime.toFixed(0)}ms`);

      return { success: true, activationTime };

    } catch (err) {
      const activationTime = performance.now() - startTime;
      
      // Increment attempt counter
      this.activationAttempts.set(extensionId, attempts + 1);

      // Record violation
      const metrics = this.host.metrics.get(extensionId);
      if (metrics) {
        metrics.violations.push({
          type: 'activation',
          timestamp: Date.now(),
          value: activationTime,
          limit: ACTIVATION_HARD_LIMIT
        });
      }

      console.error(`[ActivationManager] ${extensionId} activation failed:`, err);

      // Notify main thread
      this.host.emit(
        WorkerToMainMethods.ACTIVATION_COMPLETE,
        extensionId,
        false,
        activationTime,
        err.message
      );

      return { 
        success: false, 
        activationTime, 
        error: err.message 
      };

    } finally {
      this.activating.delete(extensionId);
    }
  }

  /**
   * Call extension's activate function
   * @param {string} extensionId
   * @param {object} module
   * @param {object} context
   * @returns {Promise<any>}
   */
  async _callActivate(extensionId, module, context) {
    if (!module) {
      throw new Error('Extension module is undefined');
    }

    if (typeof module.activate !== 'function') {
      // Extension has no activate function - that's OK
      console.log(`[ActivationManager] ${extensionId} has no activate function`);
      return;
    }

    return module.activate(context);
  }

  /**
   * Check if extension is currently activating
   * @param {string} extensionId
   * @returns {boolean}
   */
  isActivating(extensionId) {
    return this.activating.has(extensionId);
  }

  /**
   * Get activation attempt count
   * @param {string} extensionId
   * @returns {number}
   */
  getAttemptCount(extensionId) {
    return this.activationAttempts.get(extensionId) || 0;
  }

  /**
   * Reset activation attempts for an extension
   * @param {string} extensionId
   */
  resetAttempts(extensionId) {
    this.activationAttempts.delete(extensionId);
  }

  /**
   * Deactivate an extension
   * @param {string} extensionId
   * @returns {Promise<void>}
   */
  async deactivate(extensionId) {
    const ext = this.host.getExtension(extensionId);
    const ctx = this.host.getContext(extensionId);

    if (!ext || !ctx) return;

    try {
      // Call deactivate if exists
      if (ext.module && typeof ext.module.deactivate === 'function') {
        const deactivateTimeout = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Deactivate timeout')), 5000);
        });

        await Promise.race([
          Promise.resolve(ext.module.deactivate()),
          deactivateTimeout
        ]);
      }
    } catch (err) {
      console.error(`[ActivationManager] ${extensionId} deactivate error:`, err);
    }

    // Dispose all subscriptions
    if (ctx.subscriptions) {
      for (const disposable of ctx.subscriptions) {
        try {
          if (disposable && typeof disposable.dispose === 'function') {
            disposable.dispose();
          }
        } catch (err) {
          // Ignore disposal errors
        }
      }
    }

    // Remove context
    this.host.activeContexts.delete(extensionId);
  }
}
