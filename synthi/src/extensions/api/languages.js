/**
 * Synthi Extension System - Languages API
 * vscode.languages namespace implementation
 */

import { WorkerToMainMethods } from '../bridge/MessageProtocol.js';

/**
 * Create languages API
 * @param {string} extensionId
 * @param {import('../host/ExtensionHostMain.js').ExtensionHostMain} host
 * @returns {object}
 */
export function createLanguagesAPI(extensionId, host) {
  // Track registered providers for disposal
  const diagnosticCollections = new Map();
  
  return {
    /**
     * Get languages
     * @returns {Promise<string[]>}
     */
    async getLanguages() {
      return [
        'javascript', 'typescript', 'python', 'java', 'c', 'cpp', 
        'csharp', 'go', 'rust', 'html', 'css', 'json', 'markdown',
        'yaml', 'xml', 'sql', 'shell', 'powershell'
      ];
    },

    /**
     * Match selector against document
     * @param {any} selector
     * @param {object} document
     * @returns {number}
     */
    match(selector, document) {
      if (!selector || !document) return 0;
      
      const langId = document.languageId;
      
      if (typeof selector === 'string') {
        return selector === langId ? 10 : 0;
      }
      
      if (Array.isArray(selector)) {
        let max = 0;
        for (const s of selector) {
          max = Math.max(max, this.match(s, document));
        }
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

    /**
     * Create diagnostic collection
     * @param {string} [name]
     * @returns {object}
     */
    createDiagnosticCollection(name) {
      const collectionName = name || `${extensionId}.diagnostics.${diagnosticCollections.size}`;
      
      const diagnosticsMap = new Map();
      
      const collection = {
        name: collectionName,
        
        set(uriOrEntries, diagnostics) {
          if (Array.isArray(uriOrEntries)) {
            // Batch set
            for (const [uri, diags] of uriOrEntries) {
              const key = uri.toString();
              if (diags && diags.length > 0) {
                diagnosticsMap.set(key, diags);
              } else {
                diagnosticsMap.delete(key);
              }
            }
            
            // Emit batch update
            host.emit(WorkerToMainMethods.SET_DIAGNOSTICS, 
              Array.from(diagnosticsMap.entries()), 
              collectionName
            );
          } else {
            // Single URI
            const key = uriOrEntries.toString();
            if (diagnostics && diagnostics.length > 0) {
              diagnosticsMap.set(key, diagnostics);
            } else {
              diagnosticsMap.delete(key);
            }
            
            host.emit(WorkerToMainMethods.SET_DIAGNOSTICS, 
              key, 
              diagnostics || [],
              collectionName
            );
          }
        },
        
        delete(uri) {
          const key = uri.toString();
          diagnosticsMap.delete(key);
          host.emit(WorkerToMainMethods.CLEAR_DIAGNOSTICS, key, collectionName);
        },
        
        clear() {
          const uris = Array.from(diagnosticsMap.keys());
          diagnosticsMap.clear();
          for (const uri of uris) {
            host.emit(WorkerToMainMethods.CLEAR_DIAGNOSTICS, uri, collectionName);
          }
        },
        
        forEach(callback) {
          diagnosticsMap.forEach((diags, uri) => {
            callback({ toString: () => uri }, diags, collection);
          });
        },
        
        get(uri) {
          return diagnosticsMap.get(uri.toString());
        },
        
        has(uri) {
          return diagnosticsMap.has(uri.toString());
        },
        
        dispose() {
          this.clear();
          diagnosticCollections.delete(collectionName);
        }
      };
      
      diagnosticCollections.set(collectionName, collection);
      return collection;
    },

    /**
     * Register completion provider
     * @param {any} selector
     * @param {object} provider
     * @param {...string} triggerCharacters
     * @returns {{ dispose(): void }}
     */
    registerCompletionItemProvider(selector, provider, ...triggerCharacters) {
      // Would need main thread/Monaco integration
      console.log(`[languages] Registered completion provider for ${JSON.stringify(selector)}`);
      return { dispose() {} };
    },

    /**
     * Register hover provider
     * @param {any} selector
     * @param {object} provider
     * @returns {{ dispose(): void }}
     */
    registerHoverProvider(selector, provider) {
      console.log(`[languages] Registered hover provider for ${JSON.stringify(selector)}`);
      return { dispose() {} };
    },

    /**
     * Register definition provider
     * @param {any} selector
     * @param {object} provider
     * @returns {{ dispose(): void }}
     */
    registerDefinitionProvider(selector, provider) {
      console.log(`[languages] Registered definition provider for ${JSON.stringify(selector)}`);
      return { dispose() {} };
    },

    /**
     * Register type definition provider
     * @param {any} selector
     * @param {object} provider
     * @returns {{ dispose(): void }}
     */
    registerTypeDefinitionProvider(selector, provider) {
      console.log(`[languages] Registered type definition provider for ${JSON.stringify(selector)}`);
      return { dispose() {} };
    },

    /**
     * Register implementation provider
     * @param {any} selector
     * @param {object} provider
     * @returns {{ dispose(): void }}
     */
    registerImplementationProvider(selector, provider) {
      console.log(`[languages] Registered implementation provider for ${JSON.stringify(selector)}`);
      return { dispose() {} };
    },

    /**
     * Register references provider
     * @param {any} selector
     * @param {object} provider
     * @returns {{ dispose(): void }}
     */
    registerReferenceProvider(selector, provider) {
      console.log(`[languages] Registered references provider for ${JSON.stringify(selector)}`);
      return { dispose() {} };
    },

    /**
     * Register document highlight provider
     * @param {any} selector
     * @param {object} provider
     * @returns {{ dispose(): void }}
     */
    registerDocumentHighlightProvider(selector, provider) {
      console.log(`[languages] Registered document highlight provider for ${JSON.stringify(selector)}`);
      return { dispose() {} };
    },

    /**
     * Register document symbol provider
     * @param {any} selector
     * @param {object} provider
     * @returns {{ dispose(): void }}
     */
    registerDocumentSymbolProvider(selector, provider, metaData) {
      console.log(`[languages] Registered document symbol provider for ${JSON.stringify(selector)}`);
      return { dispose() {} };
    },

    /**
     * Register workspace symbol provider
     * @param {object} provider
     * @returns {{ dispose(): void }}
     */
    registerWorkspaceSymbolProvider(provider) {
      console.log(`[languages] Registered workspace symbol provider`);
      return { dispose() {} };
    },

    /**
     * Register code actions provider
     * @param {any} selector
     * @param {object} provider
     * @param {object} [metadata]
     * @returns {{ dispose(): void }}
     */
    registerCodeActionsProvider(selector, provider, metadata) {
      console.log(`[languages] Registered code actions provider for ${JSON.stringify(selector)}`);
      return { dispose() {} };
    },

    /**
     * Register code lens provider
     * @param {any} selector
     * @param {object} provider
     * @returns {{ dispose(): void }}
     */
    registerCodeLensProvider(selector, provider) {
      console.log(`[languages] Registered code lens provider for ${JSON.stringify(selector)}`);
      return { dispose() {} };
    },

    /**
     * Register document formatting provider
     * @param {any} selector
     * @param {object} provider
     * @returns {{ dispose(): void }}
     */
    registerDocumentFormattingEditProvider(selector, provider) {
      console.log(`[languages] Registered document formatting provider for ${JSON.stringify(selector)}`);
      return { dispose() {} };
    },

    /**
     * Register document range formatting provider
     * @param {any} selector
     * @param {object} provider
     * @returns {{ dispose(): void }}
     */
    registerDocumentRangeFormattingEditProvider(selector, provider) {
      console.log(`[languages] Registered document range formatting provider for ${JSON.stringify(selector)}`);
      return { dispose() {} };
    },

    /**
     * Register on type formatting provider
     * @param {any} selector
     * @param {object} provider
     * @param {string} firstTriggerCharacter
     * @param {...string} moreTriggerCharacter
     * @returns {{ dispose(): void }}
     */
    registerOnTypeFormattingEditProvider(selector, provider, firstTriggerCharacter, ...moreTriggerCharacter) {
      console.log(`[languages] Registered on type formatting provider for ${JSON.stringify(selector)}`);
      return { dispose() {} };
    },

    /**
     * Register signature help provider
     * @param {any} selector
     * @param {object} provider
     * @param {...string} triggerCharacters
     * @returns {{ dispose(): void }}
     */
    registerSignatureHelpProvider(selector, provider, ...triggerCharactersOrMetadata) {
      console.log(`[languages] Registered signature help provider for ${JSON.stringify(selector)}`);
      return { dispose() {} };
    },

    /**
     * Register rename provider
     * @param {any} selector
     * @param {object} provider
     * @returns {{ dispose(): void }}
     */
    registerRenameProvider(selector, provider) {
      console.log(`[languages] Registered rename provider for ${JSON.stringify(selector)}`);
      return { dispose() {} };
    },

    /**
     * Register document link provider
     * @param {any} selector
     * @param {object} provider
     * @returns {{ dispose(): void }}
     */
    registerDocumentLinkProvider(selector, provider) {
      console.log(`[languages] Registered document link provider for ${JSON.stringify(selector)}`);
      return { dispose() {} };
    },

    /**
     * Register color provider
     * @param {any} selector
     * @param {object} provider
     * @returns {{ dispose(): void }}
     */
    registerColorProvider(selector, provider) {
      console.log(`[languages] Registered color provider for ${JSON.stringify(selector)}`);
      return { dispose() {} };
    },

    /**
     * Register folding range provider
     * @param {any} selector
     * @param {object} provider
     * @returns {{ dispose(): void }}
     */
    registerFoldingRangeProvider(selector, provider) {
      console.log(`[languages] Registered folding range provider for ${JSON.stringify(selector)}`);
      return { dispose() {} };
    },

    /**
     * Register selection range provider
     * @param {any} selector
     * @param {object} provider
     * @returns {{ dispose(): void }}
     */
    registerSelectionRangeProvider(selector, provider) {
      console.log(`[languages] Registered selection range provider for ${JSON.stringify(selector)}`);
      return { dispose() {} };
    },

    /**
     * Register call hierarchy provider
     * @param {any} selector
     * @param {object} provider
     * @returns {{ dispose(): void }}
     */
    registerCallHierarchyProvider(selector, provider) {
      console.log(`[languages] Registered call hierarchy provider for ${JSON.stringify(selector)}`);
      return { dispose() {} };
    },

    /**
     * Register semantic tokens provider
     * @param {any} selector
     * @param {object} provider
     * @param {object} legend
     * @returns {{ dispose(): void }}
     */
    registerDocumentSemanticTokensProvider(selector, provider, legend) {
      console.log(`[languages] Registered semantic tokens provider for ${JSON.stringify(selector)}`);
      return { dispose() {} };
    },

    /**
     * Register document range semantic tokens provider
     * @param {any} selector
     * @param {object} provider
     * @param {object} legend
     * @returns {{ dispose(): void }}
     */
    registerDocumentRangeSemanticTokensProvider(selector, provider, legend) {
      console.log(`[languages] Registered document range semantic tokens provider for ${JSON.stringify(selector)}`);
      return { dispose() {} };
    },

    /**
     * Register inlay hints provider
     * @param {any} selector
     * @param {object} provider
     * @returns {{ dispose(): void }}
     */
    registerInlayHintsProvider(selector, provider) {
      console.log(`[languages] Registered inlay hints provider for ${JSON.stringify(selector)}`);
      return { dispose() {} };
    },

    /**
     * Register inline completion provider
     * @param {any} selector
     * @param {object} provider
     * @returns {{ dispose(): void }}
     */
    registerInlineCompletionItemProvider(selector, provider) {
      console.log(`[languages] Registered inline completion provider for ${JSON.stringify(selector)}`);
      return { dispose() {} };
    },

    /**
     * Set language configuration
     * @param {string} language
     * @param {object} configuration
     * @returns {{ dispose(): void }}
     */
    setLanguageConfiguration(language, configuration) {
      console.log(`[languages] Set language configuration for ${language}`);
      return { dispose() {} };
    },

    /**
     * Get diagnostics for a URI
     * @param {any} resource
     * @returns {Array}
     */
    getDiagnostics(resource) {
      if (resource) {
        const key = resource.toString();
        for (const collection of diagnosticCollections.values()) {
          const diags = collection.get({ toString: () => key });
          if (diags) return diags;
        }
        return [];
      }
      
      // Return all diagnostics
      const result = [];
      for (const collection of diagnosticCollections.values()) {
        collection.forEach((uri, diags) => {
          result.push([uri, diags]);
        });
      }
      return result;
    },

    /**
     * Event: diagnostics changed
     */
    onDidChangeDiagnostics: createNoOpEvent()
  };
}

/**
 * Create a no-op event
 * @returns {Function}
 */
function createNoOpEvent() {
  return (listener, thisArgs, disposables) => {
    const disposable = { dispose() {} };
    if (disposables) disposables.push(disposable);
    return disposable;
  };
}
