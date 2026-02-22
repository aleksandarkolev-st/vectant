/**
 * Synthi Extension System - Loader Index
 * Re-exports loader pipeline utilities.
 */

export {
  parseManifest,
  getContributedCommands,
  getActivationEvents,
  activatesOnLanguage,
  activatesOnCommand,
} from './ManifestParser.js';

export {
  saveExtension,
  getExtension,
  getAllExtensions,
  removeExtension,
  setExtensionEnabled,
  clearAllExtensions,
  parseVSIX,
} from './ExtensionInstaller.js';
