/**
 * Synthi Extension System - Language Provider Bridge
 *
 * Receives REGISTER_PROVIDER events from the extension worker,
 * registers corresponding Monaco language providers, and when Monaco
 * invokes them (user triggers autocomplete, hover, etc.), sends a
 * request back to the worker to invoke the extension's provider,
 * serialises the result, and returns it to Monaco.
 *
 * This is the critical bridge that was missing — without it, extension
 * language providers registered silently but were never invoked.
 */

import { WorkerToMainMethods } from './MessageProtocol.js';

/**
 * @typedef {Object} ProviderRegistration
 * @property {string} providerId
 * @property {string} providerType
 * @property {any} selector
 * @property {object} extra
 * @property {import('monaco-editor').IDisposable} monacoDisposable
 */

export class LanguageProviderBridge {
  /**
   * @param {import('./MainThreadBridge.js').MainThreadBridge} mainBridge
   */
  constructor(mainBridge) {
    this.mainBridge = mainBridge;
    /** @type {any} Monaco namespace */
    this.monaco = null;
    /** @type {Map<string, ProviderRegistration>} */
    this.providers = new Map();
    /** @type {Array<Function>} */
    this.disposables = [];
  }

  /**
   * Initialize with Monaco instance.
   * Must be called after MonacoBridge.init().
   * @param {any} monaco
   */
  init(monaco) {
    this.monaco = monaco;
    this._wireWorkerEvents();
  }

  /**
   * Wire worker → main thread provider events.
   */
  _wireWorkerEvents() {
    const proxy = this.mainBridge.workerProxy;

    proxy.on(WorkerToMainMethods.REGISTER_PROVIDER, (providerId, providerType, selector, extra) => {
      this._registerMonacoProvider(providerId, providerType, selector, extra);
    });

    proxy.on(WorkerToMainMethods.UNREGISTER_PROVIDER, (providerId) => {
      this._unregisterProvider(providerId);
    });

    proxy.on(WorkerToMainMethods.SET_LANGUAGE_CONFIGURATION, (language, config) => {
      this._setLanguageConfiguration(language, config);
    });
  }

  /**
   * Convert a VS Code document selector to Monaco language filter.
   * @param {any} selector
   * @returns {string[]} Array of language IDs
   */
  _selectorToLanguages(selector) {
    if (typeof selector === 'string') return [selector];
    if (Array.isArray(selector)) {
      const langs = new Set();
      for (const s of selector) {
        if (typeof s === 'string') langs.add(s);
        else if (s?.language) langs.add(s.language);
      }
      return [...langs];
    }
    if (selector?.language) return [selector.language];
    return ['*']; // catch-all
  }

  /**
   * Build a Monaco document from a Monaco model.
   * Minimal shape matching what extensions expect.
   */
  _modelToDocument(model) {
    return {
      uri: model.uri,
      fileName: model.uri.fsPath || model.uri.path,
      languageId: model.getLanguageId(),
      version: model.getVersionId(),
      lineCount: model.getLineCount(),
      getText(range) {
        if (!range) return model.getValue();
        return model.getValueInRange(range);
      },
      lineAt(line) {
        const ln = typeof line === 'number' ? line + 1 : line.line + 1;
        const content = model.getLineContent(ln);
        return {
          lineNumber: ln - 1,
          text: content,
          range: { start: { line: ln - 1, character: 0 }, end: { line: ln - 1, character: content.length } },
          firstNonWhitespaceCharacterIndex: content.search(/\S/),
          isEmptyOrWhitespace: content.trim().length === 0
        };
      },
      offsetAt(pos) {
        return model.getOffsetAt({ lineNumber: pos.line + 1, column: pos.character + 1 });
      },
      positionAt(offset) {
        const p = model.getPositionAt(offset);
        return { line: p.lineNumber - 1, character: p.column - 1 };
      }
    };
  }

  /**
   * Convert Monaco position to VS Code position (0-based).
   */
  _toVSCodePosition(monacoPos) {
    return { line: monacoPos.lineNumber - 1, character: monacoPos.column - 1 };
  }

  /**
   * Convert Monaco range to VS Code range (0-based).
   */
  _toVSCodeRange(monacoRange) {
    return {
      start: { line: monacoRange.startLineNumber - 1, character: monacoRange.startColumn - 1 },
      end: { line: monacoRange.endLineNumber - 1, character: monacoRange.endColumn - 1 }
    };
  }

  /**
   * Convert VS Code range to Monaco range (1-based).
   */
  _toMonacoRange(vscRange) {
    if (!vscRange) return null;
    return new this.monaco.Range(
      (vscRange.start?.line ?? vscRange.startLine ?? 0) + 1,
      (vscRange.start?.character ?? vscRange.startCharacter ?? 0) + 1,
      (vscRange.end?.line ?? vscRange.endLine ?? 0) + 1,
      (vscRange.end?.character ?? vscRange.endCharacter ?? 0) + 1
    );
  }

  /**
   * Invoke a provider in the worker via RPC.
   * @param {string} providerId
   * @param {string} method - PROVIDE_* method name
   * @param {any[]} args - serialized arguments
   * @returns {Promise<any>}
   */
  async _invokeProvider(providerId, method, args) {
    try {
      return await this.mainBridge.workerProxy.request(method, [providerId, ...args]);
    } catch (err) {
      console.warn(`[LanguageProviderBridge] Provider ${providerId} ${method} failed:`, err.message);
      return null;
    }
  }

  /**
   * Register a provider with Monaco.
   */
  _registerMonacoProvider(providerId, providerType, selector, extra) {
    if (!this.monaco) {
      console.warn(`[LanguageProviderBridge] Monaco not initialized, cannot register ${providerId}`);
      return;
    }

    const languages = this._selectorToLanguages(selector);
    let monacoDisposable = null;

    // For each language, we need a Monaco language selector string
    // Monaco uses single language ID strings for most providers
    const monacoSelector = languages.length === 1 && languages[0] !== '*'
      ? languages[0]
      : undefined;

    switch (providerType) {
      case 'completion':
        monacoDisposable = this._registerCompletionProvider(providerId, monacoSelector || '*', extra);
        break;
      case 'hover':
        monacoDisposable = this._registerHoverProvider(providerId, monacoSelector || '*');
        break;
      case 'definition':
        monacoDisposable = this._registerDefinitionProvider(providerId, monacoSelector || '*');
        break;
      case 'typeDefinition':
        monacoDisposable = this._registerTypeDefinitionProvider(providerId, monacoSelector || '*');
        break;
      case 'implementation':
        monacoDisposable = this._registerImplementationProvider(providerId, monacoSelector || '*');
        break;
      case 'reference':
        monacoDisposable = this._registerReferenceProvider(providerId, monacoSelector || '*');
        break;
      case 'documentHighlight':
        monacoDisposable = this._registerDocumentHighlightProvider(providerId, monacoSelector || '*');
        break;
      case 'documentSymbol':
        monacoDisposable = this._registerDocumentSymbolProvider(providerId, monacoSelector || '*');
        break;
      case 'codeAction':
        monacoDisposable = this._registerCodeActionProvider(providerId, monacoSelector || '*', extra);
        break;
      case 'codeLens':
        monacoDisposable = this._registerCodeLensProvider(providerId, monacoSelector || '*');
        break;
      case 'documentFormatting':
        monacoDisposable = this._registerDocumentFormattingProvider(providerId, monacoSelector || '*');
        break;
      case 'documentRangeFormatting':
        monacoDisposable = this._registerDocumentRangeFormattingProvider(providerId, monacoSelector || '*');
        break;
      case 'onTypeFormatting':
        monacoDisposable = this._registerOnTypeFormattingProvider(providerId, monacoSelector || '*', extra);
        break;
      case 'signatureHelp':
        monacoDisposable = this._registerSignatureHelpProvider(providerId, monacoSelector || '*', extra);
        break;
      case 'rename':
        monacoDisposable = this._registerRenameProvider(providerId, monacoSelector || '*');
        break;
      case 'documentLink':
        monacoDisposable = this._registerDocumentLinkProvider(providerId, monacoSelector || '*');
        break;
      case 'color':
        monacoDisposable = this._registerColorProvider(providerId, monacoSelector || '*');
        break;
      case 'foldingRange':
        monacoDisposable = this._registerFoldingRangeProvider(providerId, monacoSelector || '*');
        break;
      case 'selectionRange':
        monacoDisposable = this._registerSelectionRangeProvider(providerId, monacoSelector || '*');
        break;
      case 'inlayHints':
        monacoDisposable = this._registerInlayHintsProvider(providerId, monacoSelector || '*');
        break;
      case 'inlineCompletion':
        monacoDisposable = this._registerInlineCompletionProvider(providerId, monacoSelector || '*');
        break;
      case 'semanticTokens':
        monacoDisposable = this._registerSemanticTokensProvider(providerId, monacoSelector || '*', extra);
        break;
      default:
        console.warn(`[LanguageProviderBridge] Unknown provider type: ${providerType}`);
        return;
    }

    this.providers.set(providerId, {
      providerId,
      providerType,
      selector,
      extra,
      monacoDisposable
    });

    console.log(`[LanguageProviderBridge] Registered Monaco ${providerType} provider for ${JSON.stringify(languages)}`);
  }

  _unregisterProvider(providerId) {
    const reg = this.providers.get(providerId);
    if (reg) {
      reg.monacoDisposable?.dispose();
      this.providers.delete(providerId);
      console.log(`[LanguageProviderBridge] Unregistered provider ${providerId}`);
    }
  }

  // =====================================================================
  // Individual Monaco provider registrations
  // =====================================================================

  _registerCompletionProvider(providerId, langId, extra) {
    return this.monaco.languages.registerCompletionItemProvider(langId, {
      triggerCharacters: extra?.triggerCharacters?.flat() || [],
      provideCompletionItems: async (model, position, context) => {
        const result = await this._invokeProvider(providerId, 'lang/provideCompletion', [
          model.uri.toString(),
          this._toVSCodePosition(position),
          { triggerKind: context.triggerKind, triggerCharacter: context.triggerCharacter }
        ]);
        if (!result) return { suggestions: [] };
        return this._convertCompletionResult(result);
      },
      resolveCompletionItem: async (item) => {
        if (!item._originalIndex && item._originalIndex !== 0) return item;
        const result = await this._invokeProvider(providerId, 'lang/resolveCompletionItem', [
          item._providerId || providerId, item._originalIndex
        ]);
        if (result) {
          if (result.detail) item.detail = result.detail;
          if (result.documentation) item.documentation = this._convertDocumentation(result.documentation);
          if (result.additionalTextEdits) item.additionalTextEdits = result.additionalTextEdits.map(e => ({
            range: this._toMonacoRange(e.range),
            text: e.newText
          }));
        }
        return item;
      }
    });
  }

  _registerHoverProvider(providerId, langId) {
    return this.monaco.languages.registerHoverProvider(langId, {
      provideHover: async (model, position) => {
        const result = await this._invokeProvider(providerId, 'lang/provideHover', [
          model.uri.toString(),
          this._toVSCodePosition(position)
        ]);
        if (!result) return null;
        return {
          range: result.range ? this._toMonacoRange(result.range) : undefined,
          contents: (result.contents || []).map(c => {
            if (typeof c === 'string') return { value: c };
            if (c.value) return { value: c.value, isTrusted: c.isTrusted };
            return { value: String(c) };
          })
        };
      }
    });
  }

  _registerDefinitionProvider(providerId, langId) {
    return this.monaco.languages.registerDefinitionProvider(langId, {
      provideDefinition: async (model, position) => {
        const result = await this._invokeProvider(providerId, 'lang/provideDefinition', [
          model.uri.toString(),
          this._toVSCodePosition(position)
        ]);
        return this._convertLocationResult(result);
      }
    });
  }

  _registerTypeDefinitionProvider(providerId, langId) {
    return this.monaco.languages.registerTypeDefinitionProvider(langId, {
      provideTypeDefinition: async (model, position) => {
        const result = await this._invokeProvider(providerId, 'lang/provideTypeDefinition', [
          model.uri.toString(),
          this._toVSCodePosition(position)
        ]);
        return this._convertLocationResult(result);
      }
    });
  }

  _registerImplementationProvider(providerId, langId) {
    return this.monaco.languages.registerImplementationProvider(langId, {
      provideImplementation: async (model, position) => {
        const result = await this._invokeProvider(providerId, 'lang/provideImplementation', [
          model.uri.toString(),
          this._toVSCodePosition(position)
        ]);
        return this._convertLocationResult(result);
      }
    });
  }

  _registerReferenceProvider(providerId, langId) {
    return this.monaco.languages.registerReferenceProvider(langId, {
      provideReferences: async (model, position, context) => {
        const result = await this._invokeProvider(providerId, 'lang/provideReferences', [
          model.uri.toString(),
          this._toVSCodePosition(position),
          context
        ]);
        return this._convertLocationResult(result);
      }
    });
  }

  _registerDocumentHighlightProvider(providerId, langId) {
    return this.monaco.languages.registerDocumentHighlightProvider(langId, {
      provideDocumentHighlights: async (model, position) => {
        const result = await this._invokeProvider(providerId, 'lang/provideDocumentHighlights', [
          model.uri.toString(),
          this._toVSCodePosition(position)
        ]);
        if (!result) return null;
        return result.map(h => ({
          range: this._toMonacoRange(h.range),
          kind: h.kind
        }));
      }
    });
  }

  _registerDocumentSymbolProvider(providerId, langId) {
    return this.monaco.languages.registerDocumentSymbolProvider(langId, {
      provideDocumentSymbols: async (model) => {
        const result = await this._invokeProvider(providerId, 'lang/provideDocumentSymbols', [
          model.uri.toString()
        ]);
        if (!result) return [];
        return this._convertDocumentSymbols(result);
      }
    });
  }

  _registerCodeActionProvider(providerId, langId, extra) {
    return this.monaco.languages.registerCodeActionProvider(langId, {
      provideCodeActions: async (model, range, context) => {
        const result = await this._invokeProvider(providerId, 'lang/provideCodeActions', [
          model.uri.toString(),
          this._toVSCodeRange(range),
          {
            diagnostics: context.markers?.map(m => ({
              range: this._toVSCodeRange(m),
              message: m.message,
              severity: this._monacoSeverityToVSCode(m.severity),
              source: m.source,
              code: m.code
            })) || [],
            only: context.only,
            triggerKind: context.trigger
          }
        ]);
        if (!result) return { actions: [], dispose() {} };
        return {
          actions: result.map(action => ({
            title: action.title,
            kind: action.kind,
            diagnostics: action.diagnostics,
            isPreferred: action.isPreferred,
            edit: action.edit ? this._convertWorkspaceEdit(action.edit) : undefined,
            command: action.command ? {
              id: action.command.command,
              title: action.command.title,
              arguments: action.command.arguments
            } : undefined
          })),
          dispose() {}
        };
      }
    });
  }

  _registerCodeLensProvider(providerId, langId) {
    return this.monaco.languages.registerCodeLensProvider(langId, {
      provideCodeLenses: async (model) => {
        const result = await this._invokeProvider(providerId, 'lang/provideCodeLenses', [
          model.uri.toString()
        ]);
        if (!result) return { lenses: [], dispose() {} };
        return {
          lenses: result.map((lens, idx) => ({
            range: this._toMonacoRange(lens.range),
            command: lens.command ? {
              id: lens.command.command,
              title: lens.command.title,
              arguments: lens.command.arguments
            } : undefined,
            id: `${providerId}:${idx}`
          })),
          dispose() {}
        };
      },
      resolveCodeLens: async (model, codeLens) => {
        if (codeLens.command) return codeLens;
        const idx = parseInt(String(codeLens.id).split(':').pop()) || 0;
        const result = await this._invokeProvider(providerId, 'lang/resolveCodeLens', [
          model.uri.toString(), idx
        ]);
        if (result?.command) {
          codeLens.command = {
            id: result.command.command,
            title: result.command.title,
            arguments: result.command.arguments
          };
        }
        return codeLens;
      }
    });
  }

  _registerDocumentFormattingProvider(providerId, langId) {
    return this.monaco.languages.registerDocumentFormattingEditProvider(langId, {
      provideDocumentFormattingEdits: async (model, options) => {
        const result = await this._invokeProvider(providerId, 'lang/provideFormatting', [
          model.uri.toString(),
          { tabSize: options.tabSize, insertSpaces: options.insertSpaces }
        ]);
        if (!result) return [];
        return result.map(edit => ({
          range: this._toMonacoRange(edit.range),
          text: edit.newText
        }));
      }
    });
  }

  _registerDocumentRangeFormattingProvider(providerId, langId) {
    return this.monaco.languages.registerDocumentRangeFormattingEditProvider(langId, {
      provideDocumentRangeFormattingEdits: async (model, range, options) => {
        const result = await this._invokeProvider(providerId, 'lang/provideRangeFormatting', [
          model.uri.toString(),
          this._toVSCodeRange(range),
          { tabSize: options.tabSize, insertSpaces: options.insertSpaces }
        ]);
        if (!result) return [];
        return result.map(edit => ({
          range: this._toMonacoRange(edit.range),
          text: edit.newText
        }));
      }
    });
  }

  _registerOnTypeFormattingProvider(providerId, langId, extra) {
    const chars = extra?.triggerCharacters || ['}', ';', '\n'];
    return this.monaco.languages.registerOnTypeFormattingEditProvider(langId, {
      autoFormatTriggerCharacters: chars,
      provideOnTypeFormattingEdits: async (model, position, ch, options) => {
        const result = await this._invokeProvider(providerId, 'lang/provideOnTypeFormatting', [
          model.uri.toString(),
          this._toVSCodePosition(position),
          ch,
          { tabSize: options.tabSize, insertSpaces: options.insertSpaces }
        ]);
        if (!result) return [];
        return result.map(edit => ({
          range: this._toMonacoRange(edit.range),
          text: edit.newText
        }));
      }
    });
  }

  _registerSignatureHelpProvider(providerId, langId, extra) {
    return this.monaco.languages.registerSignatureHelpProvider(langId, {
      signatureHelpTriggerCharacters: extra?.triggerCharacters?.flat() || ['(', ','],
      signatureHelpRetriggerCharacters: extra?.retriggerCharacters || [],
      provideSignatureHelp: async (model, position, token, context) => {
        const result = await this._invokeProvider(providerId, 'lang/provideSignatureHelp', [
          model.uri.toString(),
          this._toVSCodePosition(position),
          { triggerKind: context.triggerKind, triggerCharacter: context.triggerCharacter, isRetrigger: context.isRetrigger }
        ]);
        if (!result) return null;
        return {
          value: {
            signatures: (result.signatures || []).map(sig => ({
              label: sig.label,
              documentation: this._convertDocumentation(sig.documentation),
              parameters: (sig.parameters || []).map(p => ({
                label: p.label,
                documentation: this._convertDocumentation(p.documentation)
              })),
              activeParameter: sig.activeParameter
            })),
            activeSignature: result.activeSignature || 0,
            activeParameter: result.activeParameter || 0
          },
          dispose() {}
        };
      }
    });
  }

  _registerRenameProvider(providerId, langId) {
    return this.monaco.languages.registerRenameProvider(langId, {
      provideRenameEdits: async (model, position, newName) => {
        const result = await this._invokeProvider(providerId, 'lang/provideRename', [
          model.uri.toString(),
          this._toVSCodePosition(position),
          newName
        ]);
        if (!result) return null;
        return this._convertWorkspaceEdit(result);
      },
      resolveRenameLocation: async (model, position) => {
        const result = await this._invokeProvider(providerId, 'lang/prepareRename', [
          model.uri.toString(),
          this._toVSCodePosition(position)
        ]);
        if (!result) return null;
        if (result.range) {
          return {
            range: this._toMonacoRange(result.range),
            text: result.placeholder || model.getWordAtPosition({
              lineNumber: position.lineNumber,
              column: position.column
            })?.word || ''
          };
        }
        return { range: model.getWordAtPosition(position) ? new this.monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) : null, text: result.placeholder || '' };
      }
    });
  }

  _registerDocumentLinkProvider(providerId, langId) {
    return this.monaco.languages.registerLinkProvider(langId, {
      provideLinks: async (model) => {
        const result = await this._invokeProvider(providerId, 'lang/provideDocumentLinks', [
          model.uri.toString()
        ]);
        if (!result) return { links: [] };
        return {
          links: result.map(link => ({
            range: this._toMonacoRange(link.range),
            url: link.target?.toString(),
            tooltip: link.tooltip
          }))
        };
      }
    });
  }

  _registerColorProvider(providerId, langId) {
    return this.monaco.languages.registerColorProvider(langId, {
      provideDocumentColors: async (model) => {
        const result = await this._invokeProvider(providerId, 'lang/provideColors', [
          model.uri.toString()
        ]);
        if (!result) return [];
        return result.map(info => ({
          range: this._toMonacoRange(info.range),
          color: info.color
        }));
      },
      provideColorPresentations: async (model, colorInfo) => {
        const result = await this._invokeProvider(providerId, 'lang/provideColorPresentations', [
          model.uri.toString(),
          colorInfo.color,
          this._toVSCodeRange(colorInfo.range)
        ]);
        if (!result) return [];
        return result.map(p => ({
          label: p.label,
          textEdit: p.textEdit ? { range: this._toMonacoRange(p.textEdit.range), text: p.textEdit.newText } : undefined,
          additionalTextEdits: p.additionalTextEdits?.map(e => ({ range: this._toMonacoRange(e.range), text: e.newText }))
        }));
      }
    });
  }

  _registerFoldingRangeProvider(providerId, langId) {
    return this.monaco.languages.registerFoldingRangeProvider(langId, {
      provideFoldingRanges: async (model) => {
        const result = await this._invokeProvider(providerId, 'lang/provideFoldingRanges', [
          model.uri.toString()
        ]);
        if (!result) return [];
        return result.map(r => ({
          start: r.start + 1,
          end: r.end + 1,
          kind: r.kind ? { value: r.kind } : undefined
        }));
      }
    });
  }

  _registerSelectionRangeProvider(providerId, langId) {
    return this.monaco.languages.registerSelectionRangeProvider(langId, {
      provideSelectionRanges: async (model, positions) => {
        const result = await this._invokeProvider(providerId, 'lang/provideSelectionRanges', [
          model.uri.toString(),
          positions.map(p => this._toVSCodePosition(p))
        ]);
        if (!result) return [];
        return result.map(ranges => {
          let current = null;
          // Build linked list from array (innermost first)
          for (let i = ranges.length - 1; i >= 0; i--) {
            current = { range: this._toMonacoRange(ranges[i].range), parent: current };
          }
          return current || [];
        });
      }
    });
  }

  _registerInlayHintsProvider(providerId, langId) {
    return this.monaco.languages.registerInlayHintsProvider(langId, {
      provideInlayHints: async (model, range) => {
        const result = await this._invokeProvider(providerId, 'lang/provideInlayHints', [
          model.uri.toString(),
          this._toVSCodeRange(range)
        ]);
        if (!result) return { hints: [], dispose() {} };
        return {
          hints: (result.hints || result || []).map(hint => ({
            position: { lineNumber: (hint.position?.line ?? 0) + 1, column: (hint.position?.character ?? 0) + 1 },
            label: typeof hint.label === 'string' ? hint.label : (hint.label || []).map(p => ({ label: p.value || p.label || String(p) })),
            kind: hint.kind,
            paddingLeft: hint.paddingLeft,
            paddingRight: hint.paddingRight,
            tooltip: hint.tooltip
          })),
          dispose() {}
        };
      }
    });
  }

  _registerInlineCompletionProvider(providerId, langId) {
    return this.monaco.languages.registerInlineCompletionsProvider(langId, {
      provideInlineCompletions: async (model, position, context) => {
        const result = await this._invokeProvider(providerId, 'lang/provideInlineCompletions', [
          model.uri.toString(),
          this._toVSCodePosition(position),
          { triggerKind: context.triggerKind, selectedSuggestionInfo: context.selectedSuggestionInfo }
        ]);
        if (!result) return { items: [] };
        return {
          items: (result.items || result || []).map(item => ({
            insertText: item.insertText,
            range: item.range ? this._toMonacoRange(item.range) : undefined,
            filterText: item.filterText,
            command: item.command
          }))
        };
      },
      freeInlineCompletions() {}
    });
  }

  _registerSemanticTokensProvider(providerId, langId, extra) {
    const legend = extra?.legend;
    if (!legend) {
      console.warn(`[LanguageProviderBridge] Cannot register semantic tokens without legend`);
      return { dispose() {} };
    }

    return this.monaco.languages.registerDocumentSemanticTokensProvider(langId, {
      getLegend() {
        return {
          tokenTypes: legend.tokenTypes || [],
          tokenModifiers: legend.tokenModifiers || []
        };
      },
      provideDocumentSemanticTokens: async (model) => {
        const result = await this._invokeProvider(providerId, 'lang/provideSemanticTokens', [
          model.uri.toString()
        ]);
        if (!result?.data) return null;
        return { data: new Uint32Array(result.data) };
      },
      releaseDocumentSemanticTokens() {}
    });
  }

  // =====================================================================
  // Conversion helpers
  // =====================================================================

  _convertCompletionResult(result) {
    const items = result.items || result;
    if (!Array.isArray(items)) return { suggestions: [] };

    const isIncomplete = result.isIncomplete || false;

    return {
      suggestions: items.map((item, idx) => {
        const suggestion = {
          label: typeof item.label === 'string' ? item.label : (item.label?.label || String(item.label)),
          kind: this._convertCompletionItemKind(item.kind),
          detail: item.detail,
          documentation: this._convertDocumentation(item.documentation),
          sortText: item.sortText,
          filterText: item.filterText,
          preselect: item.preselect,
          insertText: typeof item.insertText === 'object' ? item.insertText.value : (item.insertText || (typeof item.label === 'string' ? item.label : item.label?.label)),
          insertTextRules: typeof item.insertText === 'object' ? 4 : undefined, // InsertAsSnippet = 4
          range: item.range ? (item.range.inserting
            ? { insert: this._toMonacoRange(item.range.inserting), replace: this._toMonacoRange(item.range.replacing) }
            : this._toMonacoRange(item.range)) : undefined,
          commitCharacters: item.commitCharacters,
          additionalTextEdits: item.additionalTextEdits?.map(e => ({
            range: this._toMonacoRange(e.range),
            text: e.newText
          })),
          command: item.command ? {
            id: item.command.command,
            title: item.command.title,
            arguments: item.command.arguments
          } : undefined,
          tags: item.tags,
          _originalIndex: idx,
          _providerId: result._providerId
        };
        return suggestion;
      }),
      incomplete: isIncomplete
    };
  }

  _convertCompletionItemKind(kind) {
    // VS Code CompletionItemKind → Monaco CompletionItemKind
    // They're mostly aligned but Monaco uses monaco.languages.CompletionItemKind
    const map = {
      0: 18, // Text → Text
      1: 0,  // Method → Method
      2: 1,  // Function → Function
      3: 2,  // Constructor → Constructor
      4: 3,  // Field → Field
      5: 4,  // Variable → Variable
      6: 5,  // Class → Class
      7: 7,  // Interface → Interface
      8: 8,  // Module → Module
      9: 9,  // Property → Property
      10: 10, // Unit → Unit
      11: 11, // Value → Value
      12: 12, // Enum → Enum
      13: 13, // Keyword → Keyword
      14: 27, // Snippet → Snippet
      15: 19, // Color → Color
      16: 20, // File → File
      17: 21, // Reference → Reference
      18: 23, // Folder → Folder
      19: 16, // EnumMember → EnumMember
      20: 14, // Constant → Constant
      21: 6,  // Struct → Struct
      22: 22, // Event → Event
      23: 24, // Operator → Operator
      24: 25, // TypeParameter → TypeParameter
    };
    return map[kind] ?? 18; // default to Text
  }

  _convertDocumentation(doc) {
    if (!doc) return undefined;
    if (typeof doc === 'string') return doc;
    if (doc.value) return { value: doc.value, isTrusted: doc.isTrusted };
    return String(doc);
  }

  _convertLocationResult(result) {
    if (!result) return null;
    if (Array.isArray(result)) {
      return result.map(loc => this._convertSingleLocation(loc)).filter(Boolean);
    }
    return this._convertSingleLocation(result);
  }

  _convertSingleLocation(loc) {
    if (!loc) return null;
    const uri = loc.uri || loc.targetUri;
    const range = loc.range || loc.targetRange || loc.targetSelectionRange;
    if (!uri || !range) return null;
    return {
      uri: typeof uri === 'string' ? this.monaco.Uri.parse(uri) : uri,
      range: this._toMonacoRange(range)
    };
  }

  _convertDocumentSymbols(symbols) {
    if (!symbols) return [];
    return symbols.map(sym => {
      const result = {
        name: sym.name,
        detail: sym.detail || '',
        kind: sym.kind,
        range: this._toMonacoRange(sym.range || sym.location?.range),
        selectionRange: this._toMonacoRange(sym.selectionRange || sym.location?.range),
        tags: sym.tags
      };
      if (sym.children) {
        result.children = this._convertDocumentSymbols(sym.children);
      }
      return result;
    });
  }

  _convertWorkspaceEdit(edit) {
    if (!edit) return null;
    const edits = [];
    const entries = edit.entries ? edit.entries() : (edit._edits ? Array.from(edit._edits.entries()) : []);
    for (const [uri, textEdits] of entries) {
      const resource = typeof uri === 'string' ? this.monaco.Uri.parse(uri) : uri;
      for (const te of textEdits) {
        edits.push({
          resource,
          textEdit: {
            range: this._toMonacoRange(te.range),
            text: te.newText
          },
          versionId: undefined
        });
      }
    }
    return { edits };
  }

  _monacoSeverityToVSCode(severity) {
    switch (severity) {
      case 8: return 0; // Error
      case 4: return 1; // Warning
      case 2: return 2; // Info
      case 1: return 3; // Hint
      default: return 2;
    }
  }

  // =====================================================================
  // Language Configuration
  // =====================================================================

  _setLanguageConfiguration(language, config) {
    if (!this.monaco) return;
    try {
      const monacoConfig = {};

      if (config.comments) {
        monacoConfig.comments = {
          lineComment: config.comments.lineComment,
          blockComment: config.comments.blockComment
        };
      }

      if (config.brackets) {
        monacoConfig.brackets = config.brackets;
      }

      if (config.wordPattern) {
        try {
          monacoConfig.wordPattern = new RegExp(config.wordPattern);
        } catch { /* invalid regex */ }
      }

      if (config.autoClosingPairs) {
        monacoConfig.autoClosingPairs = config.autoClosingPairs.map(p =>
          typeof p === 'object' ? p : { open: p[0], close: p[1] }
        );
      }

      if (config.surroundingPairs) {
        monacoConfig.surroundingPairs = config.surroundingPairs.map(p =>
          typeof p === 'object' ? p : { open: p[0], close: p[1] }
        );
      }

      if (config.indentationRules) {
        monacoConfig.indentationRules = {};
        for (const [k, v] of Object.entries(config.indentationRules)) {
          try { monacoConfig.indentationRules[k] = new RegExp(v); } catch { /* skip */ }
        }
      }

      if (config.onEnterRules) {
        monacoConfig.onEnterRules = config.onEnterRules.map(rule => {
          const r = {};
          try { if (rule.beforeText) r.beforeText = new RegExp(rule.beforeText); } catch { /* skip */ }
          try { if (rule.afterText) r.afterText = new RegExp(rule.afterText); } catch { /* skip */ }
          if (rule.action) r.action = rule.action;
          return r;
        }).filter(r => r.beforeText);
      }

      if (config.folding) {
        monacoConfig.folding = config.folding;
      }

      this.monaco.languages.setLanguageConfiguration(language, monacoConfig);
      console.log(`[LanguageProviderBridge] Set language configuration for: ${language}`);
    } catch (e) {
      console.warn(`[LanguageProviderBridge] Failed to set language config for ${language}:`, e);
    }
  }

  // =====================================================================
  // Lifecycle
  // =====================================================================

  dispose() {
    for (const reg of this.providers.values()) {
      reg.monacoDisposable?.dispose();
    }
    this.providers.clear();
    for (const d of this.disposables) {
      if (d.dispose) d.dispose();
    }
    this.disposables = [];
  }
}
