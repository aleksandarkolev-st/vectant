/**
 * Synthi Extension System - Manifest Parser
 * Validates and normalizes extension manifests (package.json format).
 * Follows VS Code extension manifest spec.
 */

const REQUIRED_FIELDS = ['name', 'version', 'engines'];
const ACTIVATION_EVENT_PATTERNS = [
  'onCommand:',
  'onLanguage:',
  'onView:',
  'workspaceContains:',
  'onFileSystem:',
  'onUri',
  'onWebviewPanel:',
  'onCustomEditor:',
  'onAuthenticationRequest:',
  'onStartupFinished',
  'onNotebook:',
  'onRenderer:',
  'onTerminalProfile:',
  'onWalkthrough:',
  'onEditSession:',
  'onSearch:',
  'onChatContextProvider:',
  'onChatParticipant:',
  'onIssueReporterOpened',
  'onDebug',
  'onDebugAdapterProtocolTracker:',
  'onDebugDynamicConfigurations:',
  'onDebugInitialConfigurations',
  'onDebugResolve:',
  'onTaskType:',
  'onOpenExternalUri:',
  '*',
];

/**
 * Parse and validate an extension manifest.
 * @param {object|string} raw - Raw manifest object or JSON string
 * @param {string} [extensionId] - Optional override for the extension ID
 * @returns {{ valid: boolean, manifest?: object, errors: string[] }}
 */
export function parseManifest(raw, extensionId) {
  const errors = [];
  const warnings = [];
  let manifest;

  // Parse JSON string if needed
  if (typeof raw === 'string') {
    try {
      manifest = JSON.parse(raw);
    } catch (e) {
      return { valid: false, manifest: null, errors: [`Invalid JSON: ${e.message}`] };
    }
  } else if (raw && typeof raw === 'object') {
    manifest = { ...raw };
  } else {
    return { valid: false, manifest: null, errors: ['Manifest must be an object or JSON string'] };
  }

  // Check required fields
  for (const field of REQUIRED_FIELDS) {
    if (!manifest[field]) {
      errors.push(`Missing required field: "${field}"`);
    }
  }

  // Validate name
  if (manifest.name && typeof manifest.name !== 'string') {
    errors.push('"name" must be a string');
  }

  // Validate version (semver-ish)
  if (manifest.version && !/^\d+\.\d+\.\d+/.test(manifest.version)) {
    errors.push(`Invalid version format: "${manifest.version}" (expected semver)`);
  }

  // Validate engines
  if (manifest.engines && typeof manifest.engines !== 'object') {
    errors.push('"engines" must be an object');
  }

  // Validate activationEvents if present — unknown events are warnings, not
  // errors.  VS Code adds new event types regularly and we activate eagerly
  // anyway, so blocking install over an unrecognised event is unnecessary.
  if (manifest.activationEvents) {
    if (!Array.isArray(manifest.activationEvents)) {
      errors.push('"activationEvents" must be an array');
    } else {
      for (const event of manifest.activationEvents) {
        if (typeof event !== 'string') {
          warnings.push(`Non-string activation event ignored: ${JSON.stringify(event)}`);
          continue;
        }
        const validPattern = ACTIVATION_EVENT_PATTERNS.some(p => event === p || event.startsWith(p));
        if (!validPattern) {
          // Warn but don't block — the extension can still load with eager activation.
          warnings.push(`Unknown activation event pattern: "${event}" (will use eager activation)`);
        }
      }
    }
  }

  // Validate contributes.commands if present
  if (manifest.contributes?.commands) {
    if (!Array.isArray(manifest.contributes.commands)) {
      errors.push('"contributes.commands" must be an array');
    } else {
      for (const cmd of manifest.contributes.commands) {
        if (!cmd.command || typeof cmd.command !== 'string') {
          errors.push(`Invalid command entry: missing "command" field`);
        }
        if (!cmd.title || typeof cmd.title !== 'string') {
          errors.push(`Invalid command entry: missing "title" field for "${cmd.command || '?'}"`);
        }
      }
    }
  }

  if (warnings.length > 0) {
    console.warn('[ManifestParser] Warnings:', warnings.join('; '));
  }

  if (errors.length > 0) {
    return { valid: false, manifest, errors, warnings };
  }

  // Normalize the manifest
  const normalized = {
    name: manifest.name,
    displayName: manifest.displayName || manifest.name,
    description: manifest.description || '',
    version: manifest.version,
    publisher: manifest.publisher || 'unknown',
    engines: manifest.engines,
    activationEvents: manifest.activationEvents || ['*'],
    main: manifest.main || './extension.js',
    contributes: manifest.contributes || {},
    icon: manifest.icon || null,
    // Preserve extra fields extensions might rely on
    ...manifest,
  };

  // Compute extension ID
  normalized.__extensionId = extensionId || `${normalized.publisher}.${normalized.name}`;

  return { valid: true, manifest: normalized, errors: [], warnings };
}

/**
 * Extract contributed commands from a manifest
 * @param {object} manifest
 * @returns {Array<{ command: string, title: string, category?: string }>}
 */
export function getContributedCommands(manifest) {
  if (!manifest?.contributes?.commands) return [];
  return manifest.contributes.commands.filter(
    cmd => cmd && typeof cmd.command === 'string'
  );
}

/**
 * Extract activation events from a manifest
 * @param {object} manifest
 * @returns {string[]}
 */
export function getActivationEvents(manifest) {
  return manifest?.activationEvents || ['*'];
}

/**
 * Check if manifest requests activation on a specific language
 * @param {object} manifest
 * @param {string} languageId
 * @returns {boolean}
 */
export function activatesOnLanguage(manifest, languageId) {
  const events = getActivationEvents(manifest);
  return events.includes('*') || events.includes(`onLanguage:${languageId}`);
}

/**
 * Check if manifest requests activation on a specific command
 * @param {object} manifest
 * @param {string} commandId
 * @returns {boolean}
 */
export function activatesOnCommand(manifest, commandId) {
  const events = getActivationEvents(manifest);
  return events.includes('*') || events.includes(`onCommand:${commandId}`);
}
