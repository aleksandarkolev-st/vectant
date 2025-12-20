/**
 * Synthi Extension System - Extension Registry
 * Manages extension metadata and activation events
 */

// Allowed activation events (all others blocked)
const ALLOWED_ACTIVATION_PATTERNS = [
  /^onLanguage:.+$/,
  /^onCommand:.+$/,
  /^onView:.+$/
];

// Explicitly blocked activation events
const BLOCKED_ACTIVATION_EVENTS = new Set([
  '*',
  'onStartupFinished',
  'onUri'
]);

const BLOCKED_ACTIVATION_PATTERNS = [
  /^onFileSystem:.+$/,
  /^workspaceContains:.+$/,
  /^onDebug.*$/,
  /^onCustomEditor:.+$/,
  /^onNotebook:.+$/,
  /^onAuthenticationRequest:.+$/,
  /^onTaskType:.+$/
];

export class ExtensionRegistry {
  constructor() {
    /** @type {Map<string, object>} Extension manifests by ID */
    this.manifests = new Map();
    
    /** @type {Map<string, string[]>} Filtered activation events by extension ID */
    this.activationEvents = new Map();
    
    /** @type {Map<string, Set<string>>} Extensions by activation event */
    this.byActivationEvent = new Map();
    
    /** @type {Map<string, object>} Contributed commands by extension */
    this.contributedCommands = new Map();
    
    /** @type {Map<string, object>} Contributed languages by extension */
    this.contributedLanguages = new Map();
  }

  /**
   * Register an extension
   * @param {string} extensionId
   * @param {object} manifest
   */
  register(extensionId, manifest) {
    // Validate manifest
    this._validateManifest(extensionId, manifest);
    
    // Store manifest
    this.manifests.set(extensionId, manifest);
    
    // Filter and store activation events
    const allowedEvents = this._filterActivationEvents(
      manifest.activationEvents || []
    );
    this.activationEvents.set(extensionId, allowedEvents);
    
    // Index by activation event
    for (const event of allowedEvents) {
      if (!this.byActivationEvent.has(event)) {
        this.byActivationEvent.set(event, new Set());
      }
      this.byActivationEvent.get(event).add(extensionId);
    }
    
    // Index contributions
    this._indexContributions(extensionId, manifest);
  }

  /**
   * Unregister an extension
   * @param {string} extensionId
   */
  unregister(extensionId) {
    const events = this.activationEvents.get(extensionId) || [];
    
    // Remove from activation event index
    for (const event of events) {
      const set = this.byActivationEvent.get(event);
      if (set) {
        set.delete(extensionId);
        if (set.size === 0) {
          this.byActivationEvent.delete(event);
        }
      }
    }
    
    this.manifests.delete(extensionId);
    this.activationEvents.delete(extensionId);
    this.contributedCommands.delete(extensionId);
    this.contributedLanguages.delete(extensionId);
  }

  /**
   * Validate extension manifest
   * @param {string} extensionId
   * @param {object} manifest
   */
  _validateManifest(extensionId, manifest) {
    if (!manifest.name) {
      throw new Error(`Extension ${extensionId}: missing name`);
    }
    
    if (!manifest.version) {
      throw new Error(`Extension ${extensionId}: missing version`);
    }
    
    // Check for native extension markers
    if (manifest.main && !manifest.browser) {
      // Extension has main but no browser - likely Node.js extension
      console.warn(
        `Extension ${extensionId}: has 'main' but no 'browser' field. ` +
        `May not be web-compatible.`
      );
    }
    
    // Reject extensions with blocked capabilities
    if (manifest.contributes) {
      const blocked = ['debuggers', 'taskDefinitions', 'terminal'];
      for (const contrib of blocked) {
        if (manifest.contributes[contrib]) {
          throw new Error(
            `Extension ${extensionId}: contributes '${contrib}' which is not supported`
          );
        }
      }
    }
  }

  /**
   * Filter activation events to only allowed ones
   * @param {string[]} events
   * @returns {string[]}
   */
  _filterActivationEvents(events) {
    const allowed = [];
    const blocked = [];
    
    for (const event of events) {
      if (this._isActivationEventAllowed(event)) {
        allowed.push(event);
      } else {
        blocked.push(event);
      }
    }
    
    if (blocked.length > 0) {
      console.warn(
        `[ExtensionRegistry] Blocked activation events: ${blocked.join(', ')}`
      );
    }
    
    return allowed;
  }

  /**
   * Check if an activation event is allowed
   * @param {string} event
   * @returns {boolean}
   */
  _isActivationEventAllowed(event) {
    // Check explicit blocklist
    if (BLOCKED_ACTIVATION_EVENTS.has(event)) {
      return false;
    }
    
    // Check blocked patterns
    for (const pattern of BLOCKED_ACTIVATION_PATTERNS) {
      if (pattern.test(event)) {
        return false;
      }
    }
    
    // Check allowed patterns
    for (const pattern of ALLOWED_ACTIVATION_PATTERNS) {
      if (pattern.test(event)) {
        return true;
      }
    }
    
    // Default: block
    return false;
  }

  /**
   * Index extension contributions
   * @param {string} extensionId
   * @param {object} manifest
   */
  _indexContributions(extensionId, manifest) {
    const contributes = manifest.contributes || {};
    
    // Commands
    if (contributes.commands) {
      this.contributedCommands.set(extensionId, contributes.commands);
    }
    
    // Languages
    if (contributes.languages) {
      this.contributedLanguages.set(extensionId, contributes.languages);
    }
  }

  /**
   * Get extensions that should activate for an event
   * @param {string} event
   * @returns {string[]}
   */
  getExtensionsForEvent(event) {
    const exact = this.byActivationEvent.get(event);
    if (exact) {
      return Array.from(exact);
    }
    
    // Check pattern matches
    const [eventType] = event.split(':');
    const results = [];
    
    for (const [registeredEvent, extensionIds] of this.byActivationEvent) {
      const [regType, regValue] = registeredEvent.split(':');
      
      if (regType === eventType) {
        // For onLanguage, onCommand, onView - check if event matches
        const [, eventValue] = event.split(':');
        if (!regValue || regValue === eventValue) {
          for (const id of extensionIds) {
            if (!results.includes(id)) {
              results.push(id);
            }
          }
        }
      }
    }
    
    return results;
  }

  /**
   * Get manifest for an extension
   * @param {string} extensionId
   * @returns {object|undefined}
   */
  getManifest(extensionId) {
    return this.manifests.get(extensionId);
  }

  /**
   * Get activation events for an extension
   * @param {string} extensionId
   * @returns {string[]}
   */
  getActivationEvents(extensionId) {
    return this.activationEvents.get(extensionId) || [];
  }

  /**
   * Get all registered extension IDs
   * @returns {string[]}
   */
  getAllExtensionIds() {
    return Array.from(this.manifests.keys());
  }

  /**
   * Check if extension has a specific contribution
   * @param {string} extensionId
   * @param {string} contributionType
   * @returns {boolean}
   */
  hasContribution(extensionId, contributionType) {
    const manifest = this.manifests.get(extensionId);
    return manifest?.contributes?.[contributionType] != null;
  }

  /**
   * Get all contributed commands
   * @returns {Array<{ extensionId: string, command: object }>}
   */
  getAllCommands() {
    const result = [];
    for (const [extensionId, commands] of this.contributedCommands) {
      for (const command of commands) {
        result.push({ extensionId, command });
      }
    }
    return result;
  }

  /**
   * Get all contributed languages
   * @returns {Array<{ extensionId: string, language: object }>}
   */
  getAllLanguages() {
    const result = [];
    for (const [extensionId, languages] of this.contributedLanguages) {
      for (const language of languages) {
        result.push({ extensionId, language });
      }
    }
    return result;
  }
}
