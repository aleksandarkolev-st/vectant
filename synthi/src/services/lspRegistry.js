/**
 * Synthi LSP Registry
 * 
 * Dynamic registry that maps language IDs → LSP server configurations.
 * Extensions can register new language→LSP mappings at install time so
 * the Editor component's LSP startup logic picks them up automatically.
 * 
 * The registry is stored on `window.__synthiLspRegistry` so it's accessible
 * from both React component tree and extension loader code.
 * 
 * Built-in languages (cpp, rust, python, typescript, etc.) are defined in
 * Editor.jsx's LSP_LANG_TABLE and take precedence over dynamic entries.
 */

/**
 * Known extension → language server mapping.
 * Maps extension publisher.name IDs to the language(s) they provide
 * LSP support for, along with the backend language key the Rust worker
 * recognises in its `match lang.as_str()` dispatch.
 * 
 * This table is the bridge between "user installs extension X" and
 * "Editor.jsx creates an lsp-{backend} WebRTC data channel".
 */
const EXTENSION_LSP_MAP = {
  // ─── Prisma ──────────────────────────────────────────────────
  'Prisma.prisma':         { languages: ['prisma'],       backend: 'prisma',       clientKey: 'prisma' },
  'Prisma.prisma-insider': { languages: ['prisma'],       backend: 'prisma',       clientKey: 'prisma' },

  // ─── Tailwind CSS ────────────────────────────────────────────
  'bradlc.vscode-tailwindcss':       { languages: ['tailwindcss'], backend: 'tailwindcss', clientKey: 'tailwindcss' },
  'tailwindlabs.tailwindcss':        { languages: ['tailwindcss'], backend: 'tailwindcss', clientKey: 'tailwindcss' },

  // ─── ESLint ──────────────────────────────────────────────────
  'dbaeumer.vscode-eslint':          { languages: ['javascript', 'typescript', 'javascriptreact', 'typescriptreact'], backend: 'eslint', clientKey: 'eslint' },

  // ─── YAML ────────────────────────────────────────────────────
  'redhat.vscode-yaml':              { languages: ['yaml'], backend: 'yaml', clientKey: 'yaml' },

  // ─── TOML ────────────────────────────────────────────────────
  'tamasfe.even-better-toml':        { languages: ['toml'], backend: 'toml', clientKey: 'toml' },

  // ─── GraphQL ─────────────────────────────────────────────────
  'GraphQL.vscode-graphql':          { languages: ['graphql'], backend: 'graphql', clientKey: 'graphql' },

  // ─── Docker ──────────────────────────────────────────────────
  'ms-azuretools.vscode-docker':     { languages: ['dockerfile'], backend: 'dockerfile', clientKey: 'dockerfile' },

  // ─── JSON schemas ────────────────────────────────────────────
  // (built-in Monaco already has JSON support, but this enables schema validation)

  // ─── XML ─────────────────────────────────────────────────────
  'redhat.vscode-xml':               { languages: ['xml'], backend: 'xml', clientKey: 'xml' },
};

/**
 * Initialise the global LSP registry (if not already set up).
 * Called once at application startup.
 */
export function initLspRegistry() {
  if (typeof window === 'undefined') return;
  if (!window.__synthiLspRegistry) {
    window.__synthiLspRegistry = {};
  }
}

/**
 * Register a single language → LSP mapping.
 * 
 * @param {string} languageId  Monaco language ID (e.g. 'prisma')
 * @param {{ backend: string, clientKey: string, selector: string[] }} entry
 */
export function registerLspMapping(languageId, entry) {
  if (typeof window === 'undefined') return;
  initLspRegistry();
  if (!window.__synthiLspRegistry[languageId]) {
    window.__synthiLspRegistry[languageId] = entry;
    console.log(`[LspRegistry] Registered LSP mapping: ${languageId} → backend=${entry.backend}`);
  }
}

/**
 * Get the current dynamic LSP registry.
 * @returns {Record<string, object>}
 */
export function getLspRegistry() {
  if (typeof window === 'undefined') return {};
  return window.__synthiLspRegistry || {};
}

/**
 * Given an installed extension's ID, check if it has a known LSP mapping
 * and register it automatically.
 * 
 * This is the main entry point called during extension installation.
 * 
 * @param {string} extensionId  e.g. 'Prisma.prisma-insider'
 * @param {object} manifest     Extension manifest (package.json)
 * @returns {boolean} true if any LSP mappings were registered
 */
export function registerLspForExtension(extensionId, manifest) {
  if (typeof window === 'undefined') return false;
  initLspRegistry();

  let registered = false;

  // ── 1. Check the known extension → LSP map ──────────────────
  const knownMapping = EXTENSION_LSP_MAP[extensionId];
  if (knownMapping) {
    for (const langId of knownMapping.languages) {
      registerLspMapping(langId, {
        backend: knownMapping.backend,
        clientKey: knownMapping.clientKey,
        selector: knownMapping.languages,
      });
      registered = true;
    }
  }

  // ── 2. Infer from manifest's contributes.languages ──────────
  // If the extension contributes languages and there's a matching
  // backend server name, register it.
  if (manifest?.contributes?.languages) {
    for (const lang of manifest.contributes.languages) {
      if (!lang.id) continue;
      // Check if this language ID matches a known backend
      const id = lang.id.toLowerCase();
      if (isKnownBackendLanguage(id) && !window.__synthiLspRegistry[id]) {
        registerLspMapping(id, {
          backend: id,
          clientKey: id,
          selector: [id],
        });
        registered = true;
      }
    }
  }

  if (registered) {
    console.log(`[LspRegistry] Extension ${extensionId} registered LSP mappings`);
  }

  return registered;
}

/**
 * Check if a language ID has a corresponding LSP server binary
 * configured in the Rust worker's dispatch table.
 * 
 * This list must stay in sync with main.rs's `match lang.as_str()`.
 */
function isKnownBackendLanguage(langId) {
  const KNOWN = new Set([
    'cpp', 'c', 'rust', 'python', 'py',
    'typescript', 'ts', 'javascript', 'js',
    'java', 'go', 'csharp', 'cs',
    'ruby', 'rb', 'php', 'kotlin', 'kt',
    'zig', 'dart', 'lua', 'elixir', 'ex',
    'svelte', 'css', 'scss', 'less', 'html',
    // New servers added in this session:
    'prisma', 'tailwindcss', 'eslint',
    'yaml', 'toml', 'json', 'jsonc',
    'graphql', 'dockerfile',
  ]);
  return KNOWN.has(langId);
}

/**
 * Unregister all LSP mappings for an extension.
 * Called when an extension is uninstalled.
 * 
 * @param {string} extensionId
 */
export function unregisterLspForExtension(extensionId) {
  if (typeof window === 'undefined') return;
  const mapping = EXTENSION_LSP_MAP[extensionId];
  if (mapping && window.__synthiLspRegistry) {
    for (const langId of mapping.languages) {
      delete window.__synthiLspRegistry[langId];
      console.log(`[LspRegistry] Unregistered LSP mapping: ${langId}`);
    }
  }
}
