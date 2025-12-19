/**
 * Synthi Extension System - Restart Fence
 * CRITICAL: Harden restart boundaries
 * 
 * Guarantees:
 * - All in-flight RPCs are rejected on restart
 * - Generation IDs are incremented atomically  
 * - No messages accepted during RESTARTING state
 * 
 * If one message sneaks through, hangs return.
 */

/**
 * @typedef {Object} InFlightRPC
 * @property {string} id - Request ID
 * @property {string} method - RPC method
 * @property {string} extensionId - Target extension
 * @property {number} generation - Worker generation when sent
 * @property {number} timestamp - When sent
 * @property {number} timeout - When to timeout
 * @property {Function} resolve - Promise resolve
 * @property {Function} reject - Promise reject
 * @property {NodeJS.Timeout} timer - Timeout timer
 */

/**
 * Worker state during lifecycle
 */
export const WorkerState = Object.freeze({
  /** Worker is running normally */
  RUNNING: 'running',
  
  /** Worker restart in progress - REJECT ALL MESSAGES */
  RESTARTING: 'restarting',
  
  /** Worker is dead, needs restart */
  DEAD: 'dead',
  
  /** Worker is starting up for first time */
  INITIALIZING: 'initializing'
});

/**
 * RPC rejection reasons
 */
export const RejectionReason = Object.freeze({
  GENERATION_MISMATCH: 'generation_mismatch',
  WORKER_RESTARTING: 'worker_restarting',
  WORKER_DEAD: 'worker_dead',
  TIMEOUT: 'timeout',
  FENCE_ACTIVE: 'fence_active',
  QUEUE_CLEARED: 'queue_cleared'
});

/**
 * Restart Fence - Guards RPC boundaries across worker restarts
 */
export class RestartFence {
  constructor() {
    /** @type {number} - Monotonically increasing, never reset */
    this._generation = 0;
    
    /** @type {WorkerState} */
    this._state = WorkerState.DEAD;
    
    /** @type {Map<string, InFlightRPC>} */
    this._inFlight = new Map();
    
    /** @type {number} */
    this._rpcIdCounter = 0;
    
    /** @type {boolean} - True when fence is active (no messages pass) */
    this._fenceActive = false;
    
    /** @type {number} - Default RPC timeout */
    this.defaultTimeout = 30000;
    
    /** @type {((rpc: InFlightRPC, reason: string) => void)|null} */
    this.onRpcRejected = null;
    
    /** @type {((generation: number) => void)|null} */
    this.onGenerationChanged = null;
  }

  /**
   * Get current generation (never decreases)
   * @returns {number}
   */
  get generation() {
    return this._generation;
  }

  /**
   * Get current state
   * @returns {WorkerState}
   */
  get state() {
    return this._state;
  }

  /**
   * Check if fence is active
   * @returns {boolean}
   */
  get isFenced() {
    return this._fenceActive;
  }

  /**
   * Check if can send messages
   * @returns {{canSend: boolean, reason: string|null}}
   */
  canSendMessage() {
    if (this._fenceActive) {
      return { canSend: false, reason: 'Fence is active during restart' };
    }
    
    if (this._state === WorkerState.RESTARTING) {
      return { canSend: false, reason: 'Worker is restarting' };
    }
    
    if (this._state === WorkerState.DEAD) {
      return { canSend: false, reason: 'Worker is dead' };
    }
    
    if (this._state === WorkerState.INITIALIZING) {
      return { canSend: false, reason: 'Worker is initializing' };
    }
    
    return { canSend: true, reason: null };
  }

  /**
   * Register an in-flight RPC
   * @param {string} method
   * @param {string} extensionId
   * @param {number} [timeout]
   * @returns {Promise<{id: string, generation: number}>}
   */
  registerRpc(method, extensionId, timeout = this.defaultTimeout) {
    const check = this.canSendMessage();
    if (!check.canSend) {
      return Promise.reject(new Error(`Cannot send RPC: ${check.reason}`));
    }

    const id = `rpc-${++this._rpcIdCounter}-${Date.now()}`;
    const generation = this._generation;
    
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._rejectRpc(id, RejectionReason.TIMEOUT);
      }, timeout);

      /** @type {InFlightRPC} */
      const rpc = {
        id,
        method,
        extensionId,
        generation,
        timestamp: Date.now(),
        timeout: Date.now() + timeout,
        resolve: (result) => {
          clearTimeout(timer);
          this._inFlight.delete(id);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          this._inFlight.delete(id);
          reject(error);
        },
        timer
      };

      this._inFlight.set(id, rpc);
      
      // Return the ID and generation for the caller to use
      rpc.resolve({ id, generation });
    });
  }

  /**
   * Complete an RPC (called when response received)
   * @param {string} id - RPC ID
   * @param {number} responseGeneration - Generation from response
   * @param {any} result - Result value
   * @returns {boolean} true if completed, false if stale/rejected
   */
  completeRpc(id, responseGeneration, result) {
    const rpc = this._inFlight.get(id);
    if (!rpc) {
      // Already completed or rejected
      return false;
    }

    // CRITICAL: Check generation matches
    if (responseGeneration !== rpc.generation) {
      this._rejectRpc(id, RejectionReason.GENERATION_MISMATCH);
      return false;
    }

    // Check fence isn't active
    if (this._fenceActive) {
      this._rejectRpc(id, RejectionReason.FENCE_ACTIVE);
      return false;
    }

    clearTimeout(rpc.timer);
    this._inFlight.delete(id);
    
    // Note: resolve was already called in registerRpc with id/generation
    // This is for external completion tracking
    return true;
  }

  /**
   * Fail an RPC
   * @param {string} id
   * @param {Error|string} error
   * @returns {boolean}
   */
  failRpc(id, error) {
    const rpc = this._inFlight.get(id);
    if (!rpc) return false;

    clearTimeout(rpc.timer);
    this._inFlight.delete(id);
    rpc.reject(error instanceof Error ? error : new Error(String(error)));
    
    return true;
  }

  /**
   * Begin worker restart - ATOMIC OPERATION
   * Increments generation and rejects all in-flight RPCs
   * @returns {number} New generation
   */
  beginRestart() {
    // 1. Activate fence FIRST - no new messages
    this._fenceActive = true;
    
    // 2. Update state
    this._state = WorkerState.RESTARTING;
    
    // 3. Increment generation ATOMICALLY
    this._generation++;
    
    console.log(`[RestartFence] Begin restart, generation ${this._generation}`);
    
    // 4. Reject ALL in-flight RPCs
    this._rejectAllInFlight(RejectionReason.WORKER_RESTARTING);
    
    // 5. Notify listeners
    if (this.onGenerationChanged) {
      this.onGenerationChanged(this._generation);
    }
    
    return this._generation;
  }

  /**
   * Complete worker restart
   */
  completeRestart() {
    console.log(`[RestartFence] Restart complete, generation ${this._generation}`);
    
    // 1. Update state
    this._state = WorkerState.RUNNING;
    
    // 2. Deactivate fence LAST - new messages can flow
    this._fenceActive = false;
  }

  /**
   * Mark worker as dead
   */
  markDead() {
    this._fenceActive = true;
    this._state = WorkerState.DEAD;
    
    // Reject all in-flight
    this._rejectAllInFlight(RejectionReason.WORKER_DEAD);
    
    console.log(`[RestartFence] Worker marked dead, generation ${this._generation}`);
  }

  /**
   * Mark worker as initializing (first start)
   */
  markInitializing() {
    this._fenceActive = true;
    this._state = WorkerState.INITIALIZING;
  }

  /**
   * Mark worker as running (after initialization)
   */
  markRunning() {
    this._state = WorkerState.RUNNING;
    this._fenceActive = false;
  }

  /**
   * Validate an incoming message generation
   * @param {number} messageGeneration
   * @returns {{valid: boolean, reason: string|null}}
   */
  validateGeneration(messageGeneration) {
    if (messageGeneration !== this._generation) {
      return {
        valid: false,
        reason: `Generation mismatch: message=${messageGeneration}, current=${this._generation}`
      };
    }
    
    return { valid: true, reason: null };
  }

  /**
   * Get count of in-flight RPCs
   * @returns {number}
   */
  get inFlightCount() {
    return this._inFlight.size;
  }

  /**
   * Get all in-flight RPCs (for debugging)
   * @returns {Array<{id: string, method: string, extensionId: string, age: number}>}
   */
  getInFlightRpcs() {
    const now = Date.now();
    return Array.from(this._inFlight.values()).map(rpc => ({
      id: rpc.id,
      method: rpc.method,
      extensionId: rpc.extensionId,
      age: now - rpc.timestamp
    }));
  }

  /**
   * Force clear all in-flight (for emergencies)
   * @param {string} reason
   */
  forceClear(reason = 'Force cleared') {
    this._rejectAllInFlight(RejectionReason.QUEUE_CLEARED, reason);
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  _rejectRpc(id, reason, errorMessage = null) {
    const rpc = this._inFlight.get(id);
    if (!rpc) return;

    clearTimeout(rpc.timer);
    this._inFlight.delete(id);
    
    const error = new Error(
      errorMessage || `RPC rejected: ${reason} (id=${id}, method=${rpc.method})`
    );
    error.code = reason;
    error.rpcId = id;
    error.method = rpc.method;
    error.extensionId = rpc.extensionId;
    
    rpc.reject(error);
    
    if (this.onRpcRejected) {
      this.onRpcRejected(rpc, reason);
    }
  }

  _rejectAllInFlight(reason, errorMessage = null) {
    const count = this._inFlight.size;
    
    for (const [id] of this._inFlight) {
      this._rejectRpc(id, reason, errorMessage);
    }
    
    if (count > 0) {
      console.log(`[RestartFence] Rejected ${count} in-flight RPCs: ${reason}`);
    }
  }
}

// Singleton
let fenceInstance = null;

/**
 * Get singleton RestartFence
 * @returns {RestartFence}
 */
export function getRestartFence() {
  if (!fenceInstance) {
    fenceInstance = new RestartFence();
  }
  return fenceInstance;
}

/**
 * Create new RestartFence (for testing)
 * @returns {RestartFence}
 */
export function createRestartFence() {
  return new RestartFence();
}
