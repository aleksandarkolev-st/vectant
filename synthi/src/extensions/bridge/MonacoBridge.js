/**
 * Synthi Extension System - Monaco Bridge
 * Bridges Monaco editor with extension APIs
 * 
 * CRITICAL: Monaco text model is authoritative. No string copying.
 */

import { WorkerToMainMethods } from './MessageProtocol.js';

/**
 * Bridge between Monaco editor and extension system
 */
export class MonacoBridge {
  /**
   * @param {import('./MainThreadBridge.js').MainThreadBridge} mainBridge
   */
  constructor(mainBridge) {
    /** @type {import('./MainThreadBridge.js').MainThreadBridge} */
    this.mainBridge = mainBridge;
    
    /** @type {any} Monaco instance */
    this.monaco = null;
    
    /** @type {any} Current editor instance */
    this.editor = null;
    
    /** @type {Map<string, any>} URI to model mapping */
    this.models = new Map();
    
    /** @type {Map<string, object>} Document state by URI */
    this.documentState = new Map();
    
    /** @type {Array<Function>} Disposables */
    this.disposables = [];
    
    /** @type {number} Batch update timer */
    this.batchTimer = null;
    
    /** @type {Array<object>} Pending changes to batch */
    this.pendingChanges = [];
    
    /** @type {number} Batch delay in ms */
    this.batchDelay = 50;
    
    /** @type {Map<string, object[]>} Decorations by type key */
    this.decorationsByType = new Map();
    
    /** @type {Map<string, string[]>} Decoration IDs by type key */
    this.decorationIds = new Map();
  }

  /**
   * Initialize with Monaco instance
   * @param {any} monaco - Monaco namespace
   * @param {any} editor - Monaco editor instance
   */
  init(monaco, editor) {
    this.monaco = monaco;
    this.editor = editor;

    // Listen for model changes
    this.disposables.push(
      monaco.editor.onDidCreateModel((model) => {
        this._onModelCreated(model);
      })
    );

    this.disposables.push(
      monaco.editor.onWillDisposeModel((model) => {
        this._onModelWillDispose(model);
      })
    );

    // Register existing models
    for (const model of monaco.editor.getModels()) {
      this._onModelCreated(model);
    }

    // Listen for editor changes
    if (editor) {
      this._attachToEditor(editor);
    }

    // Set up handlers for extension events
    this._setupExtensionHandlers();
  }

  /**
   * Attach to an editor instance
   * @param {any} editor
   */
  _attachToEditor(editor) {
    this.editor = editor;

    // Model change
    this.disposables.push(
      editor.onDidChangeModel((e) => {
        if (e.newModelUrl) {
          this._notifyDocumentOpen(e.newModelUrl.toString());
        }
        if (e.oldModelUrl) {
          // Document is still open, just not active
        }
      })
    );

    // Selection change
    this.disposables.push(
      editor.onDidChangeCursorSelection((e) => {
        this._onSelectionChange(e);
      })
    );
  }

  /**
   * Handle model creation
   * @param {any} model
   */
  _onModelCreated(model) {
    const uri = model.uri.toString();
    this.models.set(uri, model);

    // Track document state
    this.documentState.set(uri, {
      version: model.getVersionId(),
      languageId: model.getLanguageId(),
      lineCount: model.getLineCount()
    });

    // Listen for content changes
    const disposable = model.onDidChangeContent((e) => {
      this._onModelContentChange(model, e);
    });
    this.disposables.push(disposable);

    // Notify extension host
    this._notifyDocumentOpen(uri);
  }

  /**
   * Handle model disposal
   * @param {any} model
   */
  _onModelWillDispose(model) {
    const uri = model.uri.toString();
    this.models.delete(uri);
    this.documentState.delete(uri);

    // Notify extension host
    this.mainBridge.notifyDocumentClose(uri);
  }

  /**
   * Handle model content change
   * @param {any} model
   * @param {any} event
   */
  _onModelContentChange(model, event) {
    const uri = model.uri.toString();
    const state = this.documentState.get(uri);
    
    if (state) {
      state.version = model.getVersionId();
      state.lineCount = model.getLineCount();
    }

    // Convert changes to VS Code format
    const changes = event.changes.map(change => ({
      range: {
        start: {
          line: change.range.startLineNumber - 1,
          character: change.range.startColumn - 1
        },
        end: {
          line: change.range.endLineNumber - 1,
          character: change.range.endColumn - 1
        }
      },
      rangeOffset: change.rangeOffset,
      rangeLength: change.rangeLength,
      text: change.text
    }));

    // Batch changes to avoid overwhelming extensions
    this._queueChange(uri, changes, model.getVersionId());
  }

  /**
   * Queue a change for batched notification
   * @param {string} uri
   * @param {object[]} changes
   * @param {number} version
   */
  _queueChange(uri, changes, version) {
    this.pendingChanges.push({ uri, changes, version });

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }

    this.batchTimer = setTimeout(() => {
      this._flushChanges();
    }, this.batchDelay);
  }

  /**
   * Flush pending changes to extensions
   */
  _flushChanges() {
    if (this.pendingChanges.length === 0) return;

    // Group by URI and take latest version
    const byUri = new Map();
    for (const change of this.pendingChanges) {
      const existing = byUri.get(change.uri);
      if (!existing || change.version > existing.version) {
        byUri.set(change.uri, change);
      }
    }

    // Notify for each document
    for (const [uri, change] of byUri) {
      this.mainBridge.notifyDocumentChange(uri, change.changes, change.version);
    }

    this.pendingChanges = [];
    this.batchTimer = null;
  }

  /**
   * Handle selection change
   * @param {any} event
   */
  _onSelectionChange(event) {
    if (!this.editor) return;

    const model = this.editor.getModel();
    if (!model) return;

    const uri = model.uri.toString();
    
    // Convert selections to VS Code format
    const selections = event.selections.map(sel => ({
      anchor: {
        line: sel.selectionStartLineNumber - 1,
        character: sel.selectionStartColumn - 1
      },
      active: {
        line: sel.positionLineNumber - 1,
        character: sel.positionColumn - 1
      },
      start: {
        line: sel.startLineNumber - 1,
        character: sel.startColumn - 1
      },
      end: {
        line: sel.endLineNumber - 1,
        character: sel.endColumn - 1
      }
    }));

    this.mainBridge.notifySelectionChange(uri, selections);
  }

  /**
   * Notify extensions of document open
   * @param {string} uri
   */
  _notifyDocumentOpen(uri) {
    const model = this.models.get(uri);
    if (!model) return;

    const state = this.documentState.get(uri);
    
    this.mainBridge.notifyDocumentOpen({
      uri,
      fileName: model.uri.fsPath || model.uri.path,
      languageId: model.getLanguageId(),
      version: model.getVersionId(),
      lineCount: model.getLineCount(),
      content: model.getValue()
    });
  }

  /**
   * Set up handlers for extension-initiated events
   */
  _setupExtensionHandlers() {
    const proxy = this.mainBridge.workerProxy;

    // Apply edits from extensions
    this.mainBridge.onApplyEdit = (uri, edits) => {
      this._applyEdits(uri, edits);
    };

    // Set diagnostics
    this.mainBridge.onSetDiagnostics = (uri, diagnostics, source) => {
      this._setDiagnostics(uri, diagnostics, source);
    };

    // Handle decoration updates
    proxy.on(WorkerToMainMethods.SET_DECORATIONS, (uri, typeKey, ranges) => {
      this._setDecorations(uri, typeKey, ranges);
    });

    proxy.on(WorkerToMainMethods.DISPOSE_DECORATION_TYPE, (typeKey) => {
      this._disposeDecorationType(typeKey);
    });
  }

  /**
   * Apply edits to a model
   * @param {string} uri
   * @param {object[]} edits
   * @returns {boolean}
   */
  _applyEdits(uri, edits) {
    const model = this.models.get(uri);
    if (!model) {
      console.warn(`[MonacoBridge] Cannot apply edits - model not found: ${uri}`);
      return false;
    }

    try {
      // Convert VS Code edits to Monaco edits
      const monacoEdits = edits.map(edit => ({
        range: new this.monaco.Range(
          edit.range.start.line + 1,
          edit.range.start.character + 1,
          edit.range.end.line + 1,
          edit.range.end.character + 1
        ),
        text: edit.newText
      }));

      // Apply as single operation
      model.pushEditOperations([], monacoEdits, () => null);
      
      return true;
    } catch (err) {
      console.error('[MonacoBridge] Failed to apply edits:', err);
      return false;
    }
  }

  /**
   * Set diagnostics (markers) for a document
   * @param {string} uri
   * @param {object[]} diagnostics
   * @param {string} source
   */
  _setDiagnostics(uri, diagnostics, source) {
    if (!this.monaco) return;

    const model = this.models.get(uri);
    if (!model) return;

    // Convert VS Code diagnostics to Monaco markers
    const markers = diagnostics.map(diag => ({
      severity: this._convertSeverity(diag.severity),
      message: diag.message,
      startLineNumber: diag.range.start.line + 1,
      startColumn: diag.range.start.character + 1,
      endLineNumber: diag.range.end.line + 1,
      endColumn: diag.range.end.character + 1,
      source: diag.source || source,
      code: typeof diag.code === 'object' ? diag.code.value : diag.code,
      tags: diag.tags?.map(t => t === 1 ? 1 : 2) // Unnecessary = 1, Deprecated = 2
    }));

    this.monaco.editor.setModelMarkers(model, source || 'extension', markers);
  }

  /**
   * Convert VS Code severity to Monaco severity
   * @param {number} severity
   * @returns {number}
   */
  _convertSeverity(severity) {
    // VS Code: Error=0, Warning=1, Info=2, Hint=3
    // Monaco: Hint=1, Info=2, Warning=4, Error=8
    switch (severity) {
      case 0: return 8; // Error
      case 1: return 4; // Warning
      case 2: return 2; // Info
      case 3: return 1; // Hint
      default: return 2;
    }
  }

  /**
   * Set decorations
   * @param {string} uri
   * @param {string} typeKey
   * @param {object[]} ranges
   */
  _setDecorations(uri, typeKey, ranges) {
    if (!this.editor) return;

    const model = this.editor.getModel();
    if (!model || model.uri.toString() !== uri) return;

    // Get existing decoration IDs for this type
    const existingIds = this.decorationIds.get(typeKey) || [];

    // Convert ranges to Monaco decorations
    const decorations = ranges.map(r => ({
      range: new this.monaco.Range(
        r.range.start.line + 1,
        r.range.start.character + 1,
        r.range.end.line + 1,
        r.range.end.character + 1
      ),
      options: r.options || {}
    }));

    // Apply decorations
    const newIds = this.editor.deltaDecorations(existingIds, decorations);
    this.decorationIds.set(typeKey, newIds);
  }

  /**
   * Dispose a decoration type
   * @param {string} typeKey
   */
  _disposeDecorationType(typeKey) {
    const ids = this.decorationIds.get(typeKey);
    if (ids && this.editor) {
      this.editor.deltaDecorations(ids, []);
    }
    this.decorationIds.delete(typeKey);
  }

  /**
   * Get document from model
   * @param {string} uri
   * @returns {object|null}
   */
  getDocument(uri) {
    const model = this.models.get(uri);
    if (!model) return null;

    return {
      uri,
      fileName: model.uri.fsPath || model.uri.path,
      languageId: model.getLanguageId(),
      version: model.getVersionId(),
      lineCount: model.getLineCount(),
      getText: (range) => {
        if (!range) return model.getValue();
        return model.getValueInRange(new this.monaco.Range(
          range.start.line + 1,
          range.start.character + 1,
          range.end.line + 1,
          range.end.character + 1
        ));
      }
    };
  }

  /**
   * Dispose the bridge
   */
  dispose() {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }

    for (const disposable of this.disposables) {
      if (disposable.dispose) {
        disposable.dispose();
      }
    }

    this.disposables = [];
    this.models.clear();
    this.documentState.clear();
    this.decorationIds.clear();
    this.decorationsByType.clear();
  }
}
