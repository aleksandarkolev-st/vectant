/**
 * Synthi Extension System - Languages API
 * vscode.languages namespace implementation
 *
 * ALL register*Provider calls now emit REGISTER_PROVIDER to the main thread
 * with a serialized registration.  When Monaco needs results (e.g. user
 * triggers autocomplete), the main thread sends a PROVIDE_* request back
 * to the worker, which invokes the provider and returns the result.
 */

import { WorkerToMainMethods } from '../bridge/MessageProtocol.js';

// Provider ID counter (unique within this worker)
let providerIdCounter = 0;

/**
 * Create languages API
 * @param {string} extensionId
 * @param {import('../host/ExtensionHostMain.js').ExtensionHostMain} host
 * @returns {object}
 */
export function createLanguagesAPI(extensionId, host) {
  const diagnosticCollections = new Map();

  // Shared provider registry on the host (all extensions share one)
  if (!host._languageProviders) {
    host._languageProviders = new Map();
  }

  /**
   * Register a provider and notify the main thread.
   */
  function registerProvider(providerType, selector, provider, extra = {}) {
    const providerId = `${extensionId}:${providerType}:${++providerIdCounter}`;
    host._languageProviders.set(providerId, { type: providerType, selector, provider, extensionId });

    host.emit(WorkerToMainMethods.REGISTER_PROVIDER, providerId, providerType, selector, extra);
    console.log(`[languages] Registered ${providerType} provider (${providerId}) for ${JSON.stringify(selector)}`);

    return {
      dispose() {
        host._languageProviders.delete(providerId);
        host.emit(WorkerToMainMethods.UNREGISTER_PROVIDER, providerId, providerType);
      }
    };
  }

  return {
    async getLanguages() {
      return [
        'javascript', 'typescript', 'python', 'java', 'c', 'cpp',
        'csharp', 'go', 'rust', 'html', 'css', 'json', 'markdown',
        'yaml', 'xml', 'sql', 'shell', 'powershell'
      ];
    },

    match(selector, document) {
      if (!selector || !document) return 0;
      const langId = document.languageId;
      if (typeof selector === 'string') return selector === langId ? 10 : 0;
      if (Array.isArray(selector)) {
        let max = 0;
        for (const s of selector) max = Math.max(max, this.match(s, document));
        return max;
      }
      if (typeof selector === 'object') {
        let score = 0;
        if (selector.language === langId) score += 10;
        if (selector.language === '*') score += 5;
        if (selector.scheme && document.uri?.scheme === selector.scheme) score += 1;
        return score;
      }
      return 0;
    },

    createDiagnosticCollection(name) {
      const collectionName = name || `${extensionId}.diagnostics.${diagnosticCollections.size}`;
      const diagnosticsMap = new Map();
      const collection = {
        name: collectionName,
        set(uriOrEntries, diagnostics) {
          if (Array.isArray(uriOrEntries)) {
            for (const [uri, diags] of uriOrEntries) {
              const key = uri.toString();
              if (diags && diags.length > 0) diagnosticsMap.set(key, diags);
              else diagnosticsMap.delete(key);
            }
            host.emit(WorkerToMainMethods.SET_DIAGNOSTICS, Array.from(diagnosticsMap.entries()), collectionName);
          } else {
            const key = uriOrEntries.toString();
            if (diagnostics && diagnostics.length > 0) diagnosticsMap.set(key, diagnostics);
            else diagnosticsMap.delete(key);
            host.emit(WorkerToMainMethods.SET_DIAGNOSTICS, key, diagnostics || [], collectionName);
          }
        },
        delete(uri) {
          diagnosticsMap.delete(uri.toString());
          host.emit(WorkerToMainMethods.CLEAR_DIAGNOSTICS, uri.toString(), collectionName);
        },
        clear() {
          const uris = Array.from(diagnosticsMap.keys());
          diagnosticsMap.clear();
          for (const uri of uris) host.emit(WorkerToMainMethods.CLEAR_DIAGNOSTICS, uri, collectionName);
        },
        forEach(callback) {
          diagnosticsMap.forEach((diags, uri) => callback({ toString: () => uri }, diags, collection));
        },
        get(uri) { return diagnosticsMap.get(uri.toString()); },
        has(uri) { return diagnosticsMap.has(uri.toString()); },
        dispose() { this.clear(); diagnosticCollections.delete(collectionName); }
      };
      diagnosticCollections.set(collectionName, collection);
      return collection;
    },

    // ── Language Providers — all wired through registerProvider() ──

    registerCompletionItemProvider(selector, provider, ...triggerCharacters) {
      return registerProvider('completion', selector, provider, { triggerCharacters });
    },
    registerHoverProvider(selector, provider) {
      return registerProvider('hover', selector, provider);
    },
    registerDefinitionProvider(selector, provider) {
      return registerProvider('definition', selector, provider);
    },
    registerTypeDefinitionProvider(selector, provider) {
      return registerProvider('typeDefinition', selector, provider);
    },
    registerImplementationProvider(selector, provider) {
      return registerProvider('implementation', selector, provider);
    },
    registerReferenceProvider(selector, provider) {
      return registerProvider('reference', selector, provider);
    },
    registerDocumentHighlightProvider(selector, provider) {
      return registerProvider('documentHighlight', selector, provider);
    },
    registerDocumentSymbolProvider(selector, provider, metaData) {
      return registerProvider('documentSymbol', selector, provider, { metaData });
    },
    registerWorkspaceSymbolProvider(provider) {
      return registerProvider('workspaceSymbol', '*', provider);
    },
    registerCodeActionsProvider(selector, provider, metadata) {
      return registerProvider('codeAction', selector, provider, {
        providedCodeActionKinds: metadata?.providedCodeActionKinds?.map(k => k.value || k)
      });
    },
    registerCodeLensProvider(selector, provider) {
      return registerProvider('codeLens', selector, provider);
    },
    registerDocumentFormattingEditProvider(selector, provider) {
      return registerProvider('documentFormatting', selector, provider);
    },
    registerDocumentRangeFormattingEditProvider(selector, provider) {
      return registerProvider('documentRangeFormatting', selector, provider);
    },
    registerOnTypeFormattingEditProvider(selector, provider, firstTriggerCharacter, ...moreTriggerCharacter) {
      return registerProvider('onTypeFormatting', selector, provider, {
        triggerCharacters: [firstTriggerCharacter, ...moreTriggerCharacter]
      });
    },
    registerSignatureHelpProvider(selector, provider, ...triggerCharactersOrMetadata) {
      let extra = {};
      if (triggerCharactersOrMetadata.length === 1 && typeof triggerCharactersOrMetadata[0] === 'object' && !Array.isArray(triggerCharactersOrMetadata[0])) {
        extra = triggerCharactersOrMetadata[0];
      } else {
        extra = { triggerCharacters: triggerCharactersOrMetadata };
      }
      return registerProvider('signatureHelp', selector, provider, extra);
    },
    registerRenameProvider(selector, provider) {
      return registerProvider('rename', selector, provider);
    },
    registerDocumentLinkProvider(selector, provider) {
      return registerProvider('documentLink', selector, provider);
    },
    registerColorProvider(selector, provider) {
      return registerProvider('color', selector, provider);
    },
    registerFoldingRangeProvider(selector, provider) {
      return registerProvider('foldingRange', selector, provider);
    },
    registerSelectionRangeProvider(selector, provider) {
      return registerProvider('selectionRange', selector, provider);
    },
    registerCallHierarchyProvider(selector, provider) {
      return registerProvider('callHierarchy', selector, provider);
    },
    registerDocumentSemanticTokensProvider(selector, provider, legend) {
      return registerProvider('semanticTokens', selector, provider, { legend });
    },
    registerDocumentRangeSemanticTokensProvider(selector, provider, legend) {
      return registerProvider('rangeSemanticTokens', selector, provider, { legend });
    },
    registerInlayHintsProvider(selector, provider) {
      return registerProvider('inlayHints', selector, provider);
    },
    registerInlineCompletionItemProvider(selector, provider) {
      return registerProvider('inlineCompletion', selector, provider);
    },

    setLanguageConfiguration(language, configuration) {
      const serialized = {};
      if (configuration.comments) serialized.comments = configuration.comments;
      if (configuration.brackets) serialized.brackets = configuration.brackets;
      if (configuration.wordPattern) serialized.wordPattern = configuration.wordPattern?.source || String(configuration.wordPattern);
      if (configuration.indentationRules) {
        serialized.indentationRules = {};
        for (const [k, v] of Object.entries(configuration.indentationRules)) {
          serialized.indentationRules[k] = v instanceof RegExp ? v.source : v;
        }
      }
      if (configuration.onEnterRules) {
        serialized.onEnterRules = configuration.onEnterRules.map(rule => ({
          beforeText: rule.beforeText instanceof RegExp ? rule.beforeText.source : rule.beforeText,
          afterText: rule.afterText instanceof RegExp ? rule.afterText?.source : rule.afterText,
          action: rule.action
        }));
      }
      if (configuration.autoClosingPairs) serialized.autoClosingPairs = configuration.autoClosingPairs;
      if (configuration.surroundingPairs) serialized.surroundingPairs = configuration.surroundingPairs;
      if (configuration.folding) serialized.folding = configuration.folding;

      host.emit(WorkerToMainMethods.SET_LANGUAGE_CONFIGURATION, language, serialized);
      return { dispose() {} };
    },

    getDiagnostics(resource) {
      if (resource) {
        const key = resource.toString();
        for (const collection of diagnosticCollections.values()) {
          const diags = collection.get({ toString: () => key });
          if (diags) return diags;
        }
        return [];
      }
      const result = [];
      for (const collection of diagnosticCollections.values()) {
        collection.forEach((uri, diags) => result.push([uri, diags]));
      }
      return result;
    },

    onDidChangeDiagnostics: createNoOpEvent()
  };
}

function createNoOpEvent() {
  return (listener, thisArgs, disposables) => {
    const disposable = { dispose() {} };
    if (disposables) disposables.push(disposable);
    return disposable;
  };
}
