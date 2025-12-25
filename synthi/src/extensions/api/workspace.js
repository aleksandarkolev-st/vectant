/**
 * Synthi Extension System - Workspace API
 * vscode.workspace namespace implementation
 */

import { WorkerToMainMethods } from '../bridge/MessageProtocol.js';

/**
 * Create workspace API
 * @param {string} extensionId
 * @param {import('../host/ExtensionHostMain.js').ExtensionHostMain} host
 * @returns {object}
 */
export function createWorkspaceAPI(extensionId, host) {
  // Event emitters
  const onDidOpenTextDocumentListeners = [];
  const onDidCloseTextDocumentListeners = [];
  const onDidChangeTextDocumentListeners = [];
  const onDidSaveTextDocumentListeners = [];
  const onDidChangeConfigurationListeners = [];
  const onDidChangeWorkspaceFoldersListeners = [];

  return {
    /**
     * Workspace folders (read-only snapshot)
     */
    get workspaceFolders() {
      // Return workspace info from host
      return [{
        uri: { scheme: 'file', path: '/workspace', fsPath: '/workspace', toString: () => 'file:///workspace' },
        name: 'workspace',
        index: 0
      }];
    },

    /**
     * Workspace name
     */
    get name() {
      return 'workspace';
    },

    /**
     * Root path (deprecated)
     */
    get rootPath() {
      return '/workspace';
    },

    /**
     * Get workspace folder for URI
     * @param {any} uri
     * @returns {object|undefined}
     */
    getWorkspaceFolder(uri) {
      const folders = this.workspaceFolders;
      if (folders && folders.length > 0) {
        return folders[0];
      }
      return undefined;
    },

    /**
     * Asset relative path
     * @param {any} pathOrUri
     * @returns {string|undefined}
     */
    asRelativePath(pathOrUri, includeWorkspaceFolder = true) {
      const path = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath;
      if (path.startsWith('/workspace/')) {
        return path.slice('/workspace/'.length);
      }
      return path;
    },

    /**
     * Text documents (open documents only)
     */
    get textDocuments() {
      return Array.from(host.documents.values()).map(doc => createTextDocumentProxy(doc));
    },

    /**
     * Open a text document
     * @param {any} uri
     * @returns {Promise<object>}
     */
    async openTextDocument(uri) {
      if (typeof uri === 'string') {
        // Path string
        const doc = host.documents.get(uri);
        if (doc) return createTextDocumentProxy(doc);
        
        // Request from main thread
        throw new Error('Document not found: ' + uri);
      } else if (uri && uri.fsPath) {
        // URI
        const doc = host.documents.get(uri.toString());
        if (doc) return createTextDocumentProxy(doc);
        
        throw new Error('Document not found: ' + uri.toString());
      } else if (uri && uri.content !== undefined) {
        // Create untitled document
        const tempUri = `untitled:Untitled-${Date.now()}`;
        host.documents.set(tempUri, {
          uri: tempUri,
          fileName: 'Untitled',
          languageId: uri.language || 'plaintext',
          version: 1,
          lineCount: uri.content.split('\n').length,
          content: uri.content
        });
        return createTextDocumentProxy(host.documents.get(tempUri));
      }
      
      throw new Error('Invalid argument');
    },

    /**
     * Get configuration
     * @param {string} [section]
     * @param {any} [scope]
     * @returns {object}
     */
    getConfiguration(section, scope) {
      // Return read-only configuration proxy
      return createConfigurationProxy(section);
    },

    /**
     * Find files
     * @param {string} include
     * @param {string} [exclude]
     * @param {number} [maxResults]
     * @param {any} [token]
     * @returns {Promise<any[]>}
     */
    async findFiles(include, exclude, maxResults, token) {
      // Not implemented - would require file system access
      console.warn('[workspace.findFiles] Not implemented');
      return [];
    },

    /**
     * Create file system watcher
     * @param {string} globPattern
     * @param {boolean} [ignoreCreateEvents]
     * @param {boolean} [ignoreChangeEvents]
     * @param {boolean} [ignoreDeleteEvents]
     * @returns {object}
     */
    createFileSystemWatcher(globPattern, ignoreCreateEvents, ignoreChangeEvents, ignoreDeleteEvents) {
      // Return no-op watcher
      return {
        ignoreCreateEvents: !!ignoreCreateEvents,
        ignoreChangeEvents: !!ignoreChangeEvents,
        ignoreDeleteEvents: !!ignoreDeleteEvents,
        onDidCreate: createNoOpEvent(),
        onDidChange: createNoOpEvent(),
        onDidDelete: createNoOpEvent(),
        dispose() {}
      };
    },

    /**
     * Apply workspace edit
     * @param {object} edit
     * @returns {Promise<boolean>}
     */
    async applyEdit(edit) {
      // Send edits to main thread
      const entries = edit.entries();
      for (const [uri, textEdits] of entries) {
        host.emit(WorkerToMainMethods.APPLY_EDIT, uri, textEdits);
      }
      return true;
    },

    /**
     * Save all documents
     * @param {boolean} [includeUntitled]
     * @returns {Promise<boolean>}
     */
    async saveAll(includeUntitled) {
      // Would need main thread support
      return true;
    },

    // Events
    onDidOpenTextDocument: createEvent(onDidOpenTextDocumentListeners),
    onDidCloseTextDocument: createEvent(onDidCloseTextDocumentListeners),
    onDidChangeTextDocument: createEvent(onDidChangeTextDocumentListeners),
    onDidSaveTextDocument: createEvent(onDidSaveTextDocumentListeners),
    onDidChangeConfiguration: createEvent(onDidChangeConfigurationListeners),
    onDidChangeWorkspaceFolders: createEvent(onDidChangeWorkspaceFoldersListeners),

    // File system (read-only)
    fs: createFileSystemAPI(host)
  };
}

/**
 * Create a text document proxy
 * @param {object} doc
 * @returns {object}
 */
function createTextDocumentProxy(doc) {
  const lines = (doc.content || '').split('\n');
  
  return {
    uri: typeof doc.uri === 'string' 
      ? { scheme: 'file', path: doc.uri, fsPath: doc.uri, toString: () => doc.uri }
      : doc.uri,
    fileName: doc.fileName,
    languageId: doc.languageId,
    version: doc.version,
    isDirty: false,
    isUntitled: doc.uri?.startsWith?.('untitled:') || false,
    isClosed: false,
    lineCount: lines.length,

    getText(range) {
      if (!range) return doc.content || '';
      
      const startLine = Math.min(range.start.line, lines.length - 1);
      const endLine = Math.min(range.end.line, lines.length - 1);
      
      if (startLine === endLine) {
        return lines[startLine].slice(range.start.character, range.end.character);
      }
      
      const result = [];
      result.push(lines[startLine].slice(range.start.character));
      for (let i = startLine + 1; i < endLine; i++) {
        result.push(lines[i]);
      }
      result.push(lines[endLine].slice(0, range.end.character));
      return result.join('\n');
    },

    lineAt(lineOrPosition) {
      const lineNumber = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line;
      const text = lines[lineNumber] || '';
      
      return {
        lineNumber,
        text,
        range: {
          start: { line: lineNumber, character: 0 },
          end: { line: lineNumber, character: text.length }
        },
        rangeIncludingLineBreak: {
          start: { line: lineNumber, character: 0 },
          end: { line: lineNumber + 1, character: 0 }
        },
        firstNonWhitespaceCharacterIndex: text.search(/\S/),
        isEmptyOrWhitespace: text.trim().length === 0
      };
    },

    offsetAt(position) {
      let offset = 0;
      for (let i = 0; i < position.line && i < lines.length; i++) {
        offset += lines[i].length + 1; // +1 for newline
      }
      offset += Math.min(position.character, (lines[position.line] || '').length);
      return offset;
    },

    positionAt(offset) {
      let remaining = offset;
      for (let line = 0; line < lines.length; line++) {
        const lineLength = lines[line].length + 1;
        if (remaining < lineLength) {
          return { line, character: remaining };
        }
        remaining -= lineLength;
      }
      return { line: lines.length - 1, character: (lines[lines.length - 1] || '').length };
    },

    getWordRangeAtPosition(position, regex) {
      const line = lines[position.line] || '';
      const defaultRegex = regex || /\w+/g;
      
      let match;
      while ((match = defaultRegex.exec(line)) !== null) {
        const start = match.index;
        const end = match.index + match[0].length;
        if (start <= position.character && position.character <= end) {
          return {
            start: { line: position.line, character: start },
            end: { line: position.line, character: end }
          };
        }
      }
      return undefined;
    },

    validateRange(range) {
      return {
        start: this.validatePosition(range.start),
        end: this.validatePosition(range.end)
      };
    },

    validatePosition(position) {
      const line = Math.max(0, Math.min(position.line, lines.length - 1));
      const maxChar = (lines[line] || '').length;
      const character = Math.max(0, Math.min(position.character, maxChar));
      return { line, character };
    }
  };
}

/**
 * Create configuration proxy
 * @param {string} section
 * @returns {object}
 */
function createConfigurationProxy(section) {
  // Static configuration - read-only
  const config = {};
  
  return {
    get(key, defaultValue) {
      const fullKey = section ? `${section}.${key}` : key;
      return config[fullKey] ?? defaultValue;
    },

    has(key) {
      const fullKey = section ? `${section}.${key}` : key;
      return fullKey in config;
    },

    inspect(key) {
      return {
        key,
        defaultValue: undefined,
        globalValue: undefined,
        workspaceValue: undefined,
        workspaceFolderValue: undefined
      };
    },

    async update(key, value, configurationTarget, overrideInLanguage) {
      // No-op - configuration is read-only
      console.warn('[workspace.getConfiguration] update() not supported');
    }
  };
}

/**
 * Create file system API (read-only)
 * @param {object} host
 * @returns {object}
 */
function createFileSystemAPI(host) {
  return {
    async stat(uri) {
      // Would need main thread support
      throw new Error('Not implemented');
    },

    async readDirectory(uri) {
      throw new Error('Not implemented');
    },

    async readFile(uri) {
      throw new Error('Not implemented');
    },

    async writeFile(uri, content) {
      // Disabled
      throw new Error('File write not supported');
    },

    async delete(uri) {
      throw new Error('File delete not supported');
    },

    async rename(oldUri, newUri) {
      throw new Error('File rename not supported');
    },

    async copy(source, destination) {
      throw new Error('File copy not supported');
    },

    async createDirectory(uri) {
      throw new Error('Directory creation not supported');
    }
  };
}

/**
 * Create an event subscription function
 * @param {Function[]} listeners
 * @returns {Function}
 */
function createEvent(listeners) {
  return (listener, thisArgs, disposables) => {
    const bound = thisArgs ? listener.bind(thisArgs) : listener;
    listeners.push(bound);
    
    const disposable = {
      dispose() {
        const idx = listeners.indexOf(bound);
        if (idx !== -1) listeners.splice(idx, 1);
      }
    };
    
    if (disposables) disposables.push(disposable);
    return disposable;
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
