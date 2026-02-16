/**
 * Synthi Extension System - Grammar Registrar
 * 
 * Registers TextMate grammars and language configurations extracted from
 * VSIX archives with Monaco editor. This enables syntax highlighting for
 * extension-contributed languages (e.g., Prisma, TOML, Svelte) without
 * requiring the extension's JS code to execute.
 */

let monaco = null;

/**
 * Lazily import Monaco.  The module may be loaded before the editor is ready,
 * so we defer the import and cache it.
 */
async function getMonaco() {
  if (monaco) return monaco;
  try {
    monaco = await import('monaco-editor');
    return monaco;
  } catch {
    return null;
  }
}

/**
 * Register languages from an extension's contributes.languages into Monaco.
 * This makes Monaco aware of file extensions, aliases, and bracket pairs.
 * 
 * @param {Array} languages - contributes.languages from extension manifest
 * @param {Record<string, object>} langConfigs - language-configuration.json files keyed by language id
 */
export async function registerExtensionLanguages(languages, langConfigs = {}) {
  const m = await getMonaco();
  if (!m || !Array.isArray(languages)) return;

  for (const lang of languages) {
    if (!lang.id) continue;

    // Check if already registered
    const existing = m.languages.getLanguages().find(l => l.id === lang.id);
    if (existing) continue;

    // Register the language with Monaco
    const registration = { id: lang.id };
    if (lang.extensions) registration.extensions = lang.extensions;
    if (lang.aliases) registration.aliases = lang.aliases;
    if (lang.mimetypes) registration.mimetypes = lang.mimetypes;
    if (lang.filenames) registration.filenames = lang.filenames;
    if (lang.filenamePatterns) registration.filenamePatterns = lang.filenamePatterns;
    if (lang.firstLine) registration.firstLine = lang.firstLine;

    try {
      m.languages.register(registration);
      console.log(`[GrammarRegistrar] Registered language: ${lang.id}`);
    } catch (e) {
      console.warn(`[GrammarRegistrar] Failed to register language ${lang.id}:`, e.message);
    }

    // Apply language configuration (brackets, comments, auto-closing pairs, etc.)
    const config = langConfigs[lang.id];
    if (config) {
      try {
        const monacoConfig = {};
        if (config.comments) {
          monacoConfig.comments = {};
          if (config.comments.lineComment) monacoConfig.comments.lineComment = config.comments.lineComment;
          if (config.comments.blockComment) monacoConfig.comments.blockComment = config.comments.blockComment;
        }
        if (config.brackets) monacoConfig.brackets = config.brackets;
        if (config.autoClosingPairs) monacoConfig.autoClosingPairs = config.autoClosingPairs;
        if (config.surroundingPairs) monacoConfig.surroundingPairs = config.surroundingPairs;
        if (config.indentationRules) monacoConfig.indentationRules = config.indentationRules;
        if (config.wordPattern) {
          try {
            monacoConfig.wordPattern = new RegExp(config.wordPattern);
          } catch (_) {}
        }
        if (config.onEnterRules) {
          monacoConfig.onEnterRules = config.onEnterRules.map(rule => {
            const mapped = { action: rule.action };
            try {
              if (rule.beforeText) mapped.beforeText = new RegExp(rule.beforeText);
              if (rule.afterText) mapped.afterText = new RegExp(rule.afterText);
            } catch (_) {
              return null;
            }
            return mapped;
          }).filter(Boolean);
        }

        m.languages.setLanguageConfiguration(lang.id, monacoConfig);
        console.log(`[GrammarRegistrar] Applied language config for: ${lang.id}`);
      } catch (e) {
        console.warn(`[GrammarRegistrar] Failed to set language config for ${lang.id}:`, e.message);
      }
    }
  }
}

/**
 * Register a simple Monarch tokenizer derived from a TextMate grammar.
 * This is a best-effort conversion — TextMate grammars are more powerful
 * than Monarch, so we extract the most impactful patterns (keywords,
 * strings, comments, numbers) and create a basic tokenizer.
 * 
 * @param {string} languageId - The Monaco language ID
 * @param {object} tmGrammar - The parsed TextMate grammar JSON
 */
export async function registerSimpleTokenizer(languageId, tmGrammar) {
  const m = await getMonaco();
  if (!m || !tmGrammar) return;

  // Check if a tokenizer is already registered
  // (Monarch or TextMate — we don't want to overwrite)
  try {
    const langs = m.languages.getLanguages();
    if (!langs.find(l => l.id === languageId)) return; // language not registered
  } catch (_) {}

  // Extract keyword-like patterns from the grammar
  const keywords = new Set();
  const typeKeywords = new Set();
  const operators = [];

  function extractFromPatterns(patterns) {
    if (!Array.isArray(patterns)) return;
    for (const p of patterns) {
      if (p.patterns) extractFromPatterns(p.patterns);
      if (!p.match && !p.begin) continue;
      const pattern = p.match || p.begin;
      const name = p.name || '';

      // Extract keyword lists from patterns like \\b(keyword1|keyword2)\\b
      const kwMatch = pattern.match(/\\\\b\(([^)]+)\)\\\\b/);
      if (kwMatch) {
        const words = kwMatch[1].split('|').filter(w => /^\w+$/.test(w));
        if (name.includes('keyword') || name.includes('storage')) {
          words.forEach(w => keywords.add(w));
        } else if (name.includes('type') || name.includes('support')) {
          words.forEach(w => typeKeywords.add(w));
        } else {
          words.forEach(w => keywords.add(w));
        }
      }
    }
  }

  if (tmGrammar.patterns) extractFromPatterns(tmGrammar.patterns);
  if (tmGrammar.repository) {
    for (const rule of Object.values(tmGrammar.repository)) {
      if (rule.patterns) extractFromPatterns(rule.patterns);
    }
  }

  // Only register if we extracted something useful
  if (keywords.size === 0 && typeKeywords.size === 0) return;

  const tokenizer = {
    defaultToken: '',
    keywords: Array.from(keywords),
    typeKeywords: Array.from(typeKeywords),
    tokenizer: {
      root: [
        // Comments
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
        [/#.*$/, 'comment'],
        // Strings
        [/"/, 'string', '@string_double'],
        [/'/, 'string', '@string_single'],
        // Numbers
        [/\d*\.\d+([eE][-+]?\d+)?/, 'number.float'],
        [/0[xX][0-9a-fA-F]+/, 'number.hex'],
        [/\d+/, 'number'],
        // Keywords
        [/[a-zA-Z_]\w*/, {
          cases: {
            '@keywords': 'keyword',
            '@typeKeywords': 'type',
            '@default': 'identifier'
          }
        }],
        // Brackets
        [/[{}()[\]]/, '@brackets'],
        // Operators
        [/[=><!~?:&|+\-*/^%]+/, 'operator'],
      ],
      comment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment'],
      ],
      string_double: [
        [/[^\\"]+/, 'string'],
        [/\\./, 'string.escape'],
        [/"/, 'string', '@pop'],
      ],
      string_single: [
        [/[^\\']+/, 'string'],
        [/\\./, 'string.escape'],
        [/'/, 'string', '@pop'],
      ],
    },
  };

  try {
    m.languages.setMonarchTokensProvider(languageId, tokenizer);
    console.log(`[GrammarRegistrar] Registered Monarch tokenizer for: ${languageId} (${keywords.size} keywords)`);
  } catch (e) {
    console.warn(`[GrammarRegistrar] Failed to register tokenizer for ${languageId}:`, e.message);
  }
}

/**
 * Register all grammars and languages from an extension manifest.
 * Call this after installing an extension.
 * 
 * @param {object} manifest - Extension manifest (with _grammars, _langConfigs)
 */
export async function registerExtensionGrammars(manifest) {
  if (!manifest) return;

  // Register languages first
  if (manifest.contributes?.languages) {
    await registerExtensionLanguages(
      manifest.contributes.languages,
      manifest._langConfigs || {}
    );
  }

  // Then register tokenizers from extracted grammars
  if (manifest._grammars) {
    for (const [key, grammar] of Object.entries(manifest._grammars)) {
      if (grammar.language && grammar.content) {
        await registerSimpleTokenizer(grammar.language, grammar.content);
      }
    }
  }
}
