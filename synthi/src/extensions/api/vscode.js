/**
 * Synthi Extension System - VS Code API
 * Main vscode namespace implementation
 */

import { createCommandsAPI } from './commands.js';
import { createWorkspaceAPI } from './workspace.js';
import { createWindowAPI } from './window.js';
import { createLanguagesAPI } from './languages.js';
import { createEnvAPI } from './env.js';
import { createExtensionsAPI } from './extensions.js';
import { createURI } from './uri.js';
import { createDebugAPI } from './debug.js';
import { createTasksAPI } from './tasks.js';
import { createSCMAPI } from './scm.js';
import { createAuthenticationAPI } from './authentication.js';
import { createTerminalSupport } from './terminal.js';

/**
 * Create the vscode API namespace for an extension
 * @param {string} extensionId
 * @param {import('../host/ExtensionHostMain.js').ExtensionHostMain} host
 * @returns {object}
 */
export function createVSCodeAPI(extensionId, host) {
  // Create terminal support (adds createTerminal to window + terminal events)
  const terminalSupport = createTerminalSupport(extensionId, host);
  const windowAPI = createWindowAPI(extensionId, host);

  // Merge terminal methods into window API
  windowAPI.createTerminal = terminalSupport.createTerminal;
  Object.defineProperty(windowAPI, 'terminals', { get: () => terminalSupport.terminals });
  Object.defineProperty(windowAPI, 'activeTerminal', { get: () => terminalSupport.activeTerminal });
  windowAPI.onDidOpenTerminal = terminalSupport.onDidOpenTerminal;
  windowAPI.onDidCloseTerminal = terminalSupport.onDidCloseTerminal;
  windowAPI.onDidChangeActiveTerminal = terminalSupport.onDidChangeActiveTerminal;

  const vscode = {
    // === Namespaces ===
    commands: createCommandsAPI(extensionId, host),
    workspace: createWorkspaceAPI(extensionId, host),
    window: windowAPI,
    languages: createLanguagesAPI(extensionId, host),
    env: createEnvAPI(extensionId, host),
    extensions: createExtensionsAPI(extensionId, host),
    debug: createDebugAPI(extensionId, host),
    tasks: createTasksAPI(extensionId, host),
    scm: createSCMAPI(extensionId, host),
    authentication: createAuthenticationAPI(extensionId, host),

    // === Classes ===
    Uri: createURI(),
    Position: createPositionClass(),
    Range: createRangeClass(),
    Selection: createSelectionClass(),
    Location: createLocationClass(),
    Diagnostic: createDiagnosticClass(),
    DiagnosticRelatedInformation: createDiagnosticRelatedInformationClass(),
    CodeAction: createCodeActionClass(),
    CodeLens: createCodeLensClass(),
    CompletionItem: createCompletionItemClass(),
    CompletionList: createCompletionListClass(),
    Hover: createHoverClass(),
    SignatureHelp: createSignatureHelpClass(),
    SignatureInformation: createSignatureInformationClass(),
    ParameterInformation: createParameterInformationClass(),
    DocumentHighlight: createDocumentHighlightClass(),
    SymbolInformation: createSymbolInformationClass(),
    DocumentSymbol: createDocumentSymbolClass(),
    WorkspaceEdit: createWorkspaceEditClass(),
    SnippetString: createSnippetStringClass(),
    MarkdownString: createMarkdownStringClass(),
    ThemeColor: createThemeColorClass(),
    ThemeIcon: createThemeIconClass(),
    TextEdit: createTextEditClass(),
    RelativePattern: createRelativePatternClass(),
    CancellationTokenSource: createCancellationTokenSourceClass(),
    EventEmitter: createEventEmitterClass(),
    Disposable: createDisposableClass(),
    TreeItem: createTreeItemClass(),

    // === Task / Debug Classes ===
    Task: createTaskClass(),
    Task2: createTaskClass(),
    ShellExecution: createShellExecutionClass(),
    ProcessExecution: createProcessExecutionClass(),
    CustomExecution: createCustomExecutionClass(),
    TaskGroup: createTaskGroupEnum(),
    TaskScope: { Global: 1, Workspace: 2 },
    TaskRevealKind: { Always: 1, Silent: 2, Never: 3 },
    TaskPanelKind: { Shared: 1, Dedicated: 2, New: 3 },
    DebugAdapterExecutable: createDebugAdapterExecutableClass(),
    DebugAdapterServer: createDebugAdapterServerClass(),
    DebugAdapterInlineImplementation: createDebugAdapterInlineImplClass(),
    Breakpoint: createBreakpointClass(),
    SourceBreakpoint: createSourceBreakpointClass(),
    FunctionBreakpoint: createFunctionBreakpointClass(),
    InlayHint: createInlayHintClass(),
    InlayHintLabelPart: createInlayHintLabelPartClass(),
    InlayHintKind: { Type: 1, Parameter: 2 },
    InlineCompletionItem: createInlineCompletionItemClass(),
    InlineCompletionList: createInlineCompletionListClass(),
    InlineCompletionTriggerKind: { Invoke: 0, Automatic: 1 },
    FoldingRange: createFoldingRangeClass(),
    SelectionRange: createSelectionRangeClass(),
    CallHierarchyItem: createCallHierarchyItemClass(),
    CallHierarchyIncomingCall: createCallHierarchyIncomingCallClass(),
    CallHierarchyOutgoingCall: createCallHierarchyOutgoingCallClass(),
    SemanticTokensLegend: createSemanticTokensLegendClass(),
    SemanticTokensBuilder: createSemanticTokensBuilderClass(),
    SemanticTokens: createSemanticTokensClass(),
    DocumentDropEdit: createSimpleClass('DocumentDropEdit', ['insertText']),
    ColorInformation: createSimpleClass('ColorInformation', ['range', 'color']),
    ColorPresentation: createSimpleClass('ColorPresentation', ['label']),
    DocumentLink: createSimpleClass('DocumentLink', ['range', 'target']),
    LinkedEditingRanges: createSimpleClass('LinkedEditingRanges', ['ranges', 'wordPattern']),
    TypeHierarchyItem: createSimpleClass('TypeHierarchyItem', ['kind', 'name', 'detail', 'uri', 'range', 'selectionRange']),
    TerminalLink: createSimpleClass('TerminalLink', ['startIndex', 'length', 'tooltip']),
    EvaluatableExpression: createSimpleClass('EvaluatableExpression', ['range', 'expression']),

    // === Enums ===
    DiagnosticSeverity: {
      Error: 0,
      Warning: 1,
      Information: 2,
      Hint: 3
    },
    DiagnosticTag: {
      Unnecessary: 1,
      Deprecated: 2
    },
    CompletionItemKind: {
      Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4,
      Variable: 5, Class: 6, Interface: 7, Module: 8, Property: 9,
      Unit: 10, Value: 11, Enum: 12, Keyword: 13, Snippet: 14,
      Color: 15, File: 16, Reference: 17, Folder: 18, EnumMember: 19,
      Constant: 20, Struct: 21, Event: 22, Operator: 23, TypeParameter: 24,
      User: 25, Issue: 26
    },
    CompletionTriggerKind: {
      Invoke: 0,
      TriggerCharacter: 1,
      TriggerForIncompleteCompletions: 2
    },
    CompletionItemTag: {
      Deprecated: 1
    },
    DocumentHighlightKind: {
      Text: 0,
      Read: 1,
      Write: 2
    },
    SymbolKind: {
      File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4,
      Method: 5, Property: 6, Field: 7, Constructor: 8, Enum: 9,
      Interface: 10, Function: 11, Variable: 12, Constant: 13, String: 14,
      Number: 15, Boolean: 16, Array: 17, Object: 18, Key: 19,
      Null: 20, EnumMember: 21, Struct: 22, Event: 23, Operator: 24,
      TypeParameter: 25
    },
    SymbolTag: {
      Deprecated: 1
    },
    IndentAction: {
      None: 0,
      Indent: 1,
      IndentOutdent: 2,
      Outdent: 3
    },
    TextEditorCursorStyle: {
      Line: 1, Block: 2, Underline: 3,
      LineThin: 4, BlockOutline: 5, UnderlineThin: 6
    },
    TextEditorLineNumbersStyle: {
      Off: 0, On: 1, Relative: 2
    },
    TextEditorRevealType: {
      Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3
    },
    TextDocumentSaveReason: {
      Manual: 1, AfterDelay: 2, FocusOut: 3
    },
    ViewColumn: {
      Active: -1, Beside: -2,
      One: 1, Two: 2, Three: 3, Four: 4, Five: 5,
      Six: 6, Seven: 7, Eight: 8, Nine: 9
    },
    StatusBarAlignment: {
      Left: 1,
      Right: 2
    },
    TreeItemCollapsibleState: {
      None: 0,
      Collapsed: 1,
      Expanded: 2
    },
    ConfigurationTarget: {
      Global: 1,
      Workspace: 2,
      WorkspaceFolder: 3
    },
    FileType: {
      Unknown: 0,
      File: 1,
      Directory: 2,
      SymbolicLink: 64
    },
    FileChangeType: {
      Changed: 1,
      Created: 2,
      Deleted: 3
    },
    EndOfLine: {
      LF: 1,
      CRLF: 2
    },
    CodeActionKind: createCodeActionKindEnum(),
    FoldingRangeKind: {
      Comment: 1,
      Imports: 2,
      Region: 3
    },
    ExtensionMode: {
      Production: 1,
      Development: 2,
      Test: 3
    },
    ExtensionKind: {
      UI: 1,
      Workspace: 2
    },
    OverviewRulerLane: {
      Left: 1,
      Center: 2,
      Right: 4,
      Full: 7
    },
    DecorationRangeBehavior: {
      OpenOpen: 0,
      ClosedClosed: 1,
      OpenClosed: 2,
      ClosedOpen: 3
    },
    ProgressLocation: {
      SourceControl: 1,
      Window: 10,
      Notification: 15
    },
    QuickPickItemKind: {
      Separator: -1,
      Default: 0
    },
    InputBoxValidationSeverity: {
      Info: 1,
      Warning: 2,
      Error: 3
    }
  };

  return vscode;
}

// ============================================================================
// Class Factories
// ============================================================================

function createPositionClass() {
  return class Position {
    constructor(line, character) {
      this.line = line;
      this.character = character;
    }

    isAfter(other) {
      return this.line > other.line || 
        (this.line === other.line && this.character > other.character);
    }

    isAfterOrEqual(other) {
      return this.line > other.line || 
        (this.line === other.line && this.character >= other.character);
    }

    isBefore(other) {
      return this.line < other.line || 
        (this.line === other.line && this.character < other.character);
    }

    isBeforeOrEqual(other) {
      return this.line < other.line || 
        (this.line === other.line && this.character <= other.character);
    }

    isEqual(other) {
      return this.line === other.line && this.character === other.character;
    }

    compareTo(other) {
      if (this.line < other.line) return -1;
      if (this.line > other.line) return 1;
      if (this.character < other.character) return -1;
      if (this.character > other.character) return 1;
      return 0;
    }

    translate(lineDelta = 0, characterDelta = 0) {
      if (typeof lineDelta === 'object') {
        characterDelta = lineDelta.characterDelta || 0;
        lineDelta = lineDelta.lineDelta || 0;
      }
      return new Position(this.line + lineDelta, this.character + characterDelta);
    }

    with(line, character) {
      if (typeof line === 'object') {
        character = line.character ?? this.character;
        line = line.line ?? this.line;
      }
      return new Position(line ?? this.line, character ?? this.character);
    }
  };
}

function createRangeClass() {
  const Position = createPositionClass();

  return class Range {
    constructor(startLine, startCharacter, endLine, endCharacter) {
      if (typeof startLine === 'object') {
        this.start = startLine;
        this.end = startCharacter;
      } else {
        this.start = new Position(startLine, startCharacter);
        this.end = new Position(endLine, endCharacter);
      }
    }

    get isEmpty() {
      return this.start.isEqual(this.end);
    }

    get isSingleLine() {
      return this.start.line === this.end.line;
    }

    contains(positionOrRange) {
      if (positionOrRange.start) {
        return this.contains(positionOrRange.start) && this.contains(positionOrRange.end);
      }
      return this.start.isBeforeOrEqual(positionOrRange) && 
             this.end.isAfterOrEqual(positionOrRange);
    }

    isEqual(other) {
      return this.start.isEqual(other.start) && this.end.isEqual(other.end);
    }

    intersection(other) {
      const start = this.start.isAfter(other.start) ? this.start : other.start;
      const end = this.end.isBefore(other.end) ? this.end : other.end;
      if (start.isAfter(end)) return undefined;
      return new Range(start, end);
    }

    union(other) {
      const start = this.start.isBefore(other.start) ? this.start : other.start;
      const end = this.end.isAfter(other.end) ? this.end : other.end;
      return new Range(start, end);
    }

    with(start, end) {
      return new Range(start ?? this.start, end ?? this.end);
    }
  };
}

function createSelectionClass() {
  const Range = createRangeClass();

  return class Selection extends Range {
    constructor(anchorLine, anchorCharacter, activeLine, activeCharacter) {
      if (typeof anchorLine === 'object') {
        super(anchorLine, anchorCharacter);
        this.anchor = anchorLine;
        this.active = anchorCharacter;
      } else {
        const anchor = { line: anchorLine, character: anchorCharacter };
        const active = { line: activeLine, character: activeCharacter };
        super(
          Math.min(anchorLine, activeLine),
          anchorLine === activeLine ? Math.min(anchorCharacter, activeCharacter) : (anchorLine < activeLine ? anchorCharacter : activeCharacter),
          Math.max(anchorLine, activeLine),
          anchorLine === activeLine ? Math.max(anchorCharacter, activeCharacter) : (anchorLine > activeLine ? anchorCharacter : activeCharacter)
        );
        this.anchor = anchor;
        this.active = active;
      }
    }

    get isReversed() {
      return this.anchor.line > this.active.line ||
        (this.anchor.line === this.active.line && this.anchor.character > this.active.character);
    }
  };
}

function createLocationClass() {
  return class Location {
    constructor(uri, rangeOrPosition) {
      this.uri = uri;
      this.range = rangeOrPosition;
    }
  };
}

function createDiagnosticClass() {
  return class Diagnostic {
    constructor(range, message, severity = 0) {
      this.range = range;
      this.message = message;
      this.severity = severity;
      this.source = '';
      this.code = undefined;
      this.relatedInformation = undefined;
      this.tags = undefined;
    }
  };
}

function createDiagnosticRelatedInformationClass() {
  return class DiagnosticRelatedInformation {
    constructor(location, message) {
      this.location = location;
      this.message = message;
    }
  };
}

function createCodeActionClass() {
  return class CodeAction {
    constructor(title, kind) {
      this.title = title;
      this.kind = kind;
      this.diagnostics = undefined;
      this.isPreferred = false;
      this.disabled = undefined;
      this.edit = undefined;
      this.command = undefined;
    }
  };
}

function createCodeLensClass() {
  return class CodeLens {
    constructor(range, command) {
      this.range = range;
      this.command = command;
    }

    get isResolved() {
      return !!this.command;
    }
  };
}

function createCompletionItemClass() {
  return class CompletionItem {
    constructor(label, kind) {
      this.label = label;
      this.kind = kind;
      this.detail = undefined;
      this.documentation = undefined;
      this.sortText = undefined;
      this.filterText = undefined;
      this.preselect = false;
      this.insertText = undefined;
      this.range = undefined;
      this.commitCharacters = undefined;
      this.additionalTextEdits = undefined;
      this.command = undefined;
    }
  };
}

function createCompletionListClass() {
  return class CompletionList {
    constructor(items = [], isIncomplete = false) {
      this.items = items;
      this.isIncomplete = isIncomplete;
    }
  };
}

function createHoverClass() {
  return class Hover {
    constructor(contents, range) {
      this.contents = Array.isArray(contents) ? contents : [contents];
      this.range = range;
    }
  };
}

function createSignatureHelpClass() {
  return class SignatureHelp {
    constructor() {
      this.signatures = [];
      this.activeSignature = 0;
      this.activeParameter = 0;
    }
  };
}

function createSignatureInformationClass() {
  return class SignatureInformation {
    constructor(label, documentation) {
      this.label = label;
      this.documentation = documentation;
      this.parameters = [];
      this.activeParameter = undefined;
    }
  };
}

function createParameterInformationClass() {
  return class ParameterInformation {
    constructor(label, documentation) {
      this.label = label;
      this.documentation = documentation;
    }
  };
}

function createDocumentHighlightClass() {
  return class DocumentHighlight {
    constructor(range, kind = 0) {
      this.range = range;
      this.kind = kind;
    }
  };
}

function createSymbolInformationClass() {
  return class SymbolInformation {
    constructor(name, kind, containerName, location) {
      this.name = name;
      this.kind = kind;
      this.containerName = containerName || '';
      this.location = location;
      this.tags = undefined;
    }
  };
}

function createDocumentSymbolClass() {
  return class DocumentSymbol {
    constructor(name, detail, kind, range, selectionRange) {
      this.name = name;
      this.detail = detail;
      this.kind = kind;
      this.range = range;
      this.selectionRange = selectionRange;
      this.children = [];
      this.tags = undefined;
    }
  };
}

function createWorkspaceEditClass() {
  return class WorkspaceEdit {
    constructor() {
      this._edits = new Map();
    }

    replace(uri, range, newText) {
      const key = uri.toString();
      if (!this._edits.has(key)) this._edits.set(key, []);
      this._edits.get(key).push({ range, newText });
    }

    insert(uri, position, newText) {
      const Range = createRangeClass();
      this.replace(uri, new Range(position, position), newText);
    }

    delete(uri, range) {
      this.replace(uri, range, '');
    }

    has(uri) {
      return this._edits.has(uri.toString());
    }

    set(uri, edits) {
      this._edits.set(uri.toString(), edits);
    }

    get(uri) {
      return this._edits.get(uri.toString()) || [];
    }

    entries() {
      return Array.from(this._edits.entries()).map(([key, edits]) => [key, edits]);
    }

    get size() {
      return this._edits.size;
    }
  };
}

function createSnippetStringClass() {
  return class SnippetString {
    constructor(value = '') {
      this.value = value;
    }

    appendText(string) {
      this.value += string.replace(/\$|\}|\\/g, '\\$&');
      return this;
    }

    appendTabstop(number = 0) {
      this.value += `$${number}`;
      return this;
    }

    appendPlaceholder(value, number = 0) {
      if (typeof value === 'function') {
        const snippet = new SnippetString();
        value(snippet);
        this.value += `\${${number}:${snippet.value}}`;
      } else {
        this.value += `\${${number}:${value}}`;
      }
      return this;
    }

    appendChoice(values, number = 0) {
      this.value += `\${${number}|${values.join(',')}|}`;
      return this;
    }

    appendVariable(name, defaultValue) {
      if (typeof defaultValue === 'function') {
        const snippet = new SnippetString();
        defaultValue(snippet);
        this.value += `\${${name}:${snippet.value}}`;
      } else if (defaultValue !== undefined) {
        this.value += `\${${name}:${defaultValue}}`;
      } else {
        this.value += `$${name}`;
      }
      return this;
    }
  };
}

function createMarkdownStringClass() {
  return class MarkdownString {
    constructor(value = '', supportThemeIcons = false) {
      this.value = value;
      this.isTrusted = false;
      this.supportThemeIcons = supportThemeIcons;
      this.supportHtml = false;
      this.baseUri = undefined;
    }

    appendText(value) {
      this.value += value.replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&');
      return this;
    }

    appendMarkdown(value) {
      this.value += value;
      return this;
    }

    appendCodeblock(value, language = '') {
      this.value += '\n```' + language + '\n' + value + '\n```\n';
      return this;
    }
  };
}

function createThemeColorClass() {
  return class ThemeColor {
    constructor(id) {
      this.id = id;
    }
  };
}

function createThemeIconClass() {
  const cls = class ThemeIcon {
    constructor(id, color) {
      this.id = id;
      this.color = color;
    }
  };

  // Static instances
  cls.File = new cls('file');
  cls.Folder = new cls('folder');

  return cls;
}

function createTextEditClass() {
  return class TextEdit {
    constructor(range, newText) {
      this.range = range;
      this.newText = newText;
    }

    static replace(range, newText) {
      return new this(range, newText);
    }

    static insert(position, newText) {
      const Range = createRangeClass();
      return new this(new Range(position, position), newText);
    }

    static delete(range) {
      return new this(range, '');
    }

    static setEndOfLine(eol) {
      const edit = new this(null, null);
      edit.newEol = eol;
      return edit;
    }
  };
}

function createRelativePatternClass() {
  return class RelativePattern {
    constructor(base, pattern) {
      if (typeof base === 'string') {
        this.baseUri = { fsPath: base, toString: () => base };
        this.base = base;
      } else {
        this.baseUri = base.uri || base;
        this.base = this.baseUri.fsPath || this.baseUri.toString();
      }
      this.pattern = pattern;
    }
  };
}

function createCancellationTokenSourceClass() {
  return class CancellationTokenSource {
    constructor() {
      this._cancelled = false;
      this._listeners = [];
      
      this.token = {
        isCancellationRequested: false,
        onCancellationRequested: (listener) => {
          this._listeners.push(listener);
          return {
            dispose: () => {
              const idx = this._listeners.indexOf(listener);
              if (idx !== -1) this._listeners.splice(idx, 1);
            }
          };
        }
      };
    }

    cancel() {
      if (!this._cancelled) {
        this._cancelled = true;
        this.token.isCancellationRequested = true;
        this._listeners.forEach(l => l());
      }
    }

    dispose() {
      this._listeners = [];
    }
  };
}

function createEventEmitterClass() {
  return class EventEmitter {
    constructor() {
      this._listeners = [];
    }

    get event() {
      return (listener, thisArgs, disposables) => {
        const bound = thisArgs ? listener.bind(thisArgs) : listener;
        this._listeners.push(bound);
        
        const disposable = {
          dispose: () => {
            const idx = this._listeners.indexOf(bound);
            if (idx !== -1) this._listeners.splice(idx, 1);
          }
        };
        
        if (disposables) disposables.push(disposable);
        return disposable;
      };
    }

    fire(data) {
      this._listeners.forEach(l => l(data));
    }

    dispose() {
      this._listeners = [];
    }
  };
}

function createDisposableClass() {
  const cls = class Disposable {
    constructor(callOnDispose) {
      this._callOnDispose = callOnDispose;
    }

    dispose() {
      if (this._callOnDispose) {
        this._callOnDispose();
        this._callOnDispose = undefined;
      }
    }
  };

  cls.from = function (...disposables) {
    return new cls(() => {
      disposables.forEach(d => d && d.dispose());
    });
  };

  return cls;
}

function createTreeItemClass() {
  return class TreeItem {
    constructor(label, collapsibleState = 0) {
      if (typeof label === 'object' && label.fsPath) {
        this.resourceUri = label;
        this.label = undefined;
      } else {
        this.label = label;
        this.resourceUri = undefined;
      }
      this.collapsibleState = collapsibleState;
      this.command = undefined;
      this.contextValue = undefined;
      this.description = undefined;
      this.iconPath = undefined;
      this.id = undefined;
      this.tooltip = undefined;
    }
  };
}

function createCodeActionKindEnum() {
  const CodeActionKind = class {
    constructor(value) {
      this.value = value;
    }

    append(parts) {
      return new CodeActionKind(this.value + '.' + parts);
    }

    contains(other) {
      return other.value === this.value || other.value.startsWith(this.value + '.');
    }

    intersects(other) {
      return this.contains(other) || other.contains(this);
    }
  };

  CodeActionKind.Empty = new CodeActionKind('');
  CodeActionKind.QuickFix = new CodeActionKind('quickfix');
  CodeActionKind.Refactor = new CodeActionKind('refactor');
  CodeActionKind.RefactorExtract = new CodeActionKind('refactor.extract');
  CodeActionKind.RefactorInline = new CodeActionKind('refactor.inline');
  CodeActionKind.RefactorRewrite = new CodeActionKind('refactor.rewrite');
  CodeActionKind.Source = new CodeActionKind('source');
  CodeActionKind.SourceOrganizeImports = new CodeActionKind('source.organizeImports');
  CodeActionKind.SourceFixAll = new CodeActionKind('source.fixAll');

  return CodeActionKind;
}

// ============================================================================
// Task / Debug / Language Feature classes
// ============================================================================

function createTaskClass() {
  return class Task {
    constructor(definition, scope, name, source, execution, problemMatchers) {
      // Handle both old (4-arg) and new (6-arg) signatures
      if (typeof scope === 'string') {
        // Old signature: Task(definition, name, source, execution, problemMatchers)
        this.definition = definition;
        this.name = scope;
        this.source = name;
        this.execution = source;
        this.problemMatchers = execution;
        this.scope = 2; // TaskScope.Workspace
      } else {
        this.definition = definition;
        this.scope = scope;
        this.name = name;
        this.source = source;
        this.execution = execution;
        this.problemMatchers = problemMatchers;
      }
      this.group = undefined;
      this.presentationOptions = {};
      this.isBackground = false;
      this.detail = undefined;
      this.runOptions = {};
    }
  };
}

function createShellExecutionClass() {
  return class ShellExecution {
    constructor(commandLineOrCommand, argsOrOptions, options) {
      if (typeof commandLineOrCommand === 'string' && !Array.isArray(argsOrOptions)) {
        this.commandLine = commandLineOrCommand;
        this.options = argsOrOptions;
      } else {
        this.command = commandLineOrCommand;
        this.args = argsOrOptions || [];
        this.options = options;
      }
    }
  };
}

function createProcessExecutionClass() {
  return class ProcessExecution {
    constructor(process, argsOrOptions, options) {
      this.process = process;
      if (Array.isArray(argsOrOptions)) {
        this.args = argsOrOptions;
        this.options = options;
      } else {
        this.args = [];
        this.options = argsOrOptions;
      }
    }
  };
}

function createCustomExecutionClass() {
  return class CustomExecution {
    constructor(callback) {
      this.callback = callback;
    }
  };
}

function createTaskGroupEnum() {
  const TaskGroup = class {
    constructor(id, label) {
      this.id = id;
      this._label = label;
    }
  };
  TaskGroup.Clean = new TaskGroup('clean', 'Clean');
  TaskGroup.Build = new TaskGroup('build', 'Build');
  TaskGroup.Rebuild = new TaskGroup('rebuild', 'Rebuild');
  TaskGroup.Test = new TaskGroup('test', 'Test');
  return TaskGroup;
}

function createDebugAdapterExecutableClass() {
  return class DebugAdapterExecutable {
    constructor(command, args, options) {
      this.command = command;
      this.args = args || [];
      this.options = options;
    }
  };
}

function createDebugAdapterServerClass() {
  return class DebugAdapterServer {
    constructor(port, host) {
      this.port = port;
      this.host = host;
    }
  };
}

function createDebugAdapterInlineImplClass() {
  return class DebugAdapterInlineImplementation {
    constructor(implementation) {
      this.implementation = implementation;
    }
  };
}

function createBreakpointClass() {
  return class Breakpoint {
    constructor(enabled = true, condition, hitCondition, logMessage) {
      this.enabled = enabled;
      this.condition = condition;
      this.hitCondition = hitCondition;
      this.logMessage = logMessage;
      this.id = `bp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }
  };
}

function createSourceBreakpointClass() {
  const Breakpoint = createBreakpointClass();
  return class SourceBreakpoint extends Breakpoint {
    constructor(location, enabled, condition, hitCondition, logMessage) {
      super(enabled, condition, hitCondition, logMessage);
      this.location = location;
    }
  };
}

function createFunctionBreakpointClass() {
  const Breakpoint = createBreakpointClass();
  return class FunctionBreakpoint extends Breakpoint {
    constructor(functionName, enabled, condition, hitCondition, logMessage) {
      super(enabled, condition, hitCondition, logMessage);
      this.functionName = functionName;
    }
  };
}

function createInlayHintClass() {
  return class InlayHint {
    constructor(position, label, kind) {
      this.position = position;
      this.label = label;
      this.kind = kind;
      this.paddingLeft = false;
      this.paddingRight = false;
      this.tooltip = undefined;
      this.textEdits = undefined;
    }
  };
}

function createInlayHintLabelPartClass() {
  return class InlayHintLabelPart {
    constructor(value) {
      this.value = value;
      this.tooltip = undefined;
      this.location = undefined;
      this.command = undefined;
    }
  };
}

function createInlineCompletionItemClass() {
  return class InlineCompletionItem {
    constructor(insertText, range, command) {
      this.insertText = insertText;
      this.range = range;
      this.command = command;
      this.filterText = undefined;
    }
  };
}

function createInlineCompletionListClass() {
  return class InlineCompletionList {
    constructor(items) {
      this.items = items;
    }
  };
}

function createFoldingRangeClass() {
  return class FoldingRange {
    constructor(start, end, kind) {
      this.start = start;
      this.end = end;
      this.kind = kind;
    }
  };
}

function createSelectionRangeClass() {
  return class SelectionRange {
    constructor(range, parent) {
      this.range = range;
      this.parent = parent;
    }
  };
}

function createCallHierarchyItemClass() {
  return class CallHierarchyItem {
    constructor(kind, name, detail, uri, range, selectionRange) {
      this.kind = kind;
      this.name = name;
      this.detail = detail;
      this.uri = uri;
      this.range = range;
      this.selectionRange = selectionRange;
      this.tags = undefined;
    }
  };
}

function createCallHierarchyIncomingCallClass() {
  return class CallHierarchyIncomingCall {
    constructor(item, fromRanges) {
      this.from = item;
      this.fromRanges = fromRanges;
    }
  };
}

function createCallHierarchyOutgoingCallClass() {
  return class CallHierarchyOutgoingCall {
    constructor(item, fromRanges) {
      this.to = item;
      this.fromRanges = fromRanges;
    }
  };
}

function createSemanticTokensLegendClass() {
  return class SemanticTokensLegend {
    constructor(tokenTypes, tokenModifiers = []) {
      this.tokenTypes = tokenTypes;
      this.tokenModifiers = tokenModifiers;
    }
  };
}

function createSemanticTokensBuilderClass() {
  return class SemanticTokensBuilder {
    constructor(legend) {
      this._legend = legend;
      this._data = [];
      this._prevLine = 0;
      this._prevChar = 0;
    }

    push(lineOrRange, charOrTokenType, lengthOrTokenModifiers, tokenType, tokenModifiers) {
      if (typeof lineOrRange === 'number') {
        // push(line, char, length, tokenType, tokenModifiers)
        const deltaLine = lineOrRange - this._prevLine;
        const deltaChar = deltaLine === 0 ? charOrTokenType - this._prevChar : charOrTokenType;
        this._data.push(deltaLine, deltaChar, lengthOrTokenModifiers, tokenType, tokenModifiers || 0);
        this._prevLine = lineOrRange;
        this._prevChar = charOrTokenType;
      }
    }

    build(resultId) {
      return { resultId, data: new Uint32Array(this._data) };
    }
  };
}

function createSemanticTokensClass() {
  return class SemanticTokens {
    constructor(data, resultId) {
      this.data = data;
      this.resultId = resultId;
    }
  };
}

/**
 * Generic class factory for simple data classes
 */
function createSimpleClass(name, fields) {
  return class {
    constructor(...args) {
      for (let i = 0; i < fields.length && i < args.length; i++) {
        this[fields[i]] = args[i];
      }
    }
  };
}

