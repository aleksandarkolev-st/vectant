'use client';

/**
 * ProactiveAnalysisProvider
 * 
 * Context provider that manages proactive code analysis state
 * and integrates with Monaco editor. Provides:
 * 
 * - Automatic analysis on file content changes
 * - Debounced real-time updates
 * - Monaco markers and decorations
 * - Problems panel integration
 * - Settings for enabling/disabling features
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useProactiveAnalysis } from '@/hooks/useProactiveAnalysis';
import {
  applyDiagnosticsToModel,
  clearDiagnosticsFromModel,
  createDiagnosticDecorations,
  createQuickFixProvider,
} from '@/services/monacoDiagnosticsAdapter';

/**
 * @typedef {Object} ProactiveAnalysisContext
 * @property {Array} diagnostics - Current diagnostics
 * @property {Object} summary - Diagnostic counts by severity
 * @property {boolean} isAnalyzing - Whether analysis is in progress
 * @property {Object} tierStatus - Status of each analysis tier
 * @property {boolean} enabled - Whether proactive analysis is enabled
 * @property {Function} setEnabled - Toggle proactive analysis
 * @property {Function} triggerAnalysis - Manually trigger analysis
 * @property {Function} analyzeFull - Run full analysis including AI
 * @property {Function} clearDiagnostics - Clear all diagnostics
 * @property {Function} registerEditor - Register Monaco editor instance
 * @property {Function} unregisterEditor - Unregister Monaco editor
 * @property {Object} settings - Analysis settings
 * @property {Function} updateSettings - Update settings
 */

const ProactiveAnalysisContext = createContext(null);

/**
 * Default settings for proactive analysis
 */
const DEFAULT_SETTINGS = {
  enabled: true,
  debounceMs: 500,
  includeAi: false,
  aiOnSave: true,
  showInlineHints: true,
  showGutterIcons: true,
  maxDiagnostics: 100,
  minSeverity: 'hint', // 'error', 'warning', 'info', 'hint'
};

/**
 * Hook to use proactive analysis context
 */
export function useProactiveAnalysisContext() {
  const context = useContext(ProactiveAnalysisContext);
  if (!context) {
    throw new Error('useProactiveAnalysisContext must be used within ProactiveAnalysisProvider');
  }
  return context;
}

/**
 * Provider component for proactive analysis
 */
export function ProactiveAnalysisProvider({
  children,
  initialSettings = {},
}) {
  // Merge initial settings with defaults
  const [settings, setSettings] = useState(() => ({
    ...DEFAULT_SETTINGS,
    ...initialSettings,
  }));
  
  // Use the proactive analysis hook
  const {
    diagnostics,
    diagnosticsBySeverity,
    summary,
    isAnalyzing,
    tierStatus,
    triggerAnalysis,
    analyzeQuick,
    analyzeFull,
    clearDiagnostics,
    connectionStatus,
    clientReady,
  } = useProactiveAnalysis({
    debounceMs: settings.debounceMs,
    autoAnalyze: settings.enabled,
    includeAi: settings.includeAi,
    maxDiagnostics: settings.maxDiagnostics,
  });
  
  // Registered Monaco editor instances
  const editorsRef = useRef(new Map()); // modelUri -> { editor, monaco, decorations }
  
  // Current file context
  const [currentFile, setCurrentFile] = useState({
    path: '',
    language: '',
    content: '',
  });
  
  /**
   * Register a Monaco editor for diagnostics
   */
  const registerEditor = useCallback((editor, monaco, modelUri) => {
    if (!editor || !monaco || !modelUri) return;
    
    const model = editor.getModel();
    if (!model) return;
    
    // Store editor reference
    editorsRef.current.set(modelUri, {
      editor,
      monaco,
      model,
      decorations: [],
    });
    
    // Register code action provider for quick fixes
    const codeActionDisposable = monaco.languages.registerCodeActionProvider(
      { scheme: 'file' },
      createQuickFixProvider(monaco, (startLine, startCol, endLine, endCol) => {
        return diagnostics.filter(d => {
          const loc = d.location;
          return loc.line >= startLine && loc.line <= endLine;
        });
      })
    );
    
    // Listen for content changes to trigger analysis
    const contentChangeDisposable = model.onDidChangeContent(() => {
      if (!settings.enabled) return;
      
      const content = model.getValue();
      const language = model.getLanguageId();
      const path = modelUri;
      
      setCurrentFile({ path, language, content });
      triggerAnalysis({ code: content, lang: language, filePath: path });
    });
    
    // Store disposables for cleanup
    const entry = editorsRef.current.get(modelUri);
    if (entry) {
      entry.disposables = [codeActionDisposable, contentChangeDisposable];
    }
    
    // Initial analysis
    if (settings.enabled) {
      const content = model.getValue();
      const language = model.getLanguageId();
      triggerAnalysis({ code: content, lang: language, filePath: modelUri });
    }
    
    return () => unregisterEditor(modelUri);
  }, [diagnostics, settings.enabled, triggerAnalysis]);
  
  /**
   * Unregister a Monaco editor
   */
  const unregisterEditor = useCallback((modelUri) => {
    const entry = editorsRef.current.get(modelUri);
    if (!entry) return;
    
    // Clear markers
    clearDiagnosticsFromModel(entry.monaco, entry.model);
    
    // Clear decorations
    if (entry.decorations?.length) {
      entry.editor.deltaDecorations(entry.decorations, []);
    }
    
    // Dispose listeners
    if (entry.disposables) {
      entry.disposables.forEach(d => d?.dispose?.());
    }
    
    editorsRef.current.delete(modelUri);
  }, []);
  
  /**
   * Update diagnostics markers in all registered editors
   */
  useEffect(() => {
    for (const [uri, entry] of editorsRef.current.entries()) {
      const { editor, monaco, model } = entry;
      if (!monaco || !model) continue;
      
      // Filter diagnostics for this file
      const fileDiagnostics = diagnostics.filter(d => 
        !d.filePath || d.filePath === uri || d.filePath === currentFile.path
      );
      
      // Apply Monaco markers
      applyDiagnosticsToModel(monaco, model, fileDiagnostics);
      
      // Apply decorations if enabled
      if (settings.showInlineHints || settings.showGutterIcons) {
        const decorationOptions = createDiagnosticDecorations(fileDiagnostics);
        const newDecorations = editor.deltaDecorations(
          entry.decorations || [],
          decorationOptions
        );
        entry.decorations = newDecorations;
      }
    }
  }, [diagnostics, currentFile.path, settings.showInlineHints, settings.showGutterIcons]);
  
  /**
   * Toggle enabled state
   */
  const setEnabled = useCallback((enabled) => {
    setSettings(prev => ({ ...prev, enabled }));
    
    if (!enabled) {
      // Clear all diagnostics when disabled
      clearDiagnostics();
      for (const entry of editorsRef.current.values()) {
        clearDiagnosticsFromModel(entry.monaco, entry.model);
        if (entry.decorations?.length) {
          entry.editor.deltaDecorations(entry.decorations, []);
          entry.decorations = [];
        }
      }
    }
  }, [clearDiagnostics]);
  
  /**
   * Update settings
   */
  const updateSettings = useCallback((newSettings) => {
    setSettings(prev => ({ ...prev, ...newSettings }));
  }, []);
  
  /**
   * Navigate to a diagnostic location in the editor
   */
  const navigateToDiagnostic = useCallback((location) => {
    // Find the first registered editor
    const firstEntry = editorsRef.current.values().next().value;
    if (!firstEntry?.editor) return;
    
    const { editor } = firstEntry;
    
    // Set cursor position (convert from 0-indexed to 1-indexed)
    const position = {
      lineNumber: (location.line ?? 0) + 1,
      column: (location.column ?? 0) + 1,
    };
    
    editor.setPosition(position);
    editor.revealPositionInCenter(position);
    editor.focus();
    
    // Optionally highlight the range
    if (location.endLine !== undefined) {
      editor.setSelection({
        startLineNumber: position.lineNumber,
        startColumn: position.column,
        endLineNumber: (location.endLine ?? location.line ?? 0) + 1,
        endColumn: (location.endColumn ?? location.column ?? 0) + 1,
      });
    }
  }, []);
  
  /**
   * Run full analysis (including AI if configured)
   */
  const runFullAnalysis = useCallback(async (options = {}) => {
    const content = currentFile.content || options.code;
    const language = currentFile.language || options.lang;
    const filePath = currentFile.path || options.filePath;
    
    if (!content || !language) {
      console.warn('[ProactiveAnalysis] No content or language to analyze');
      return;
    }
    
    return analyzeFull({
      code: content,
      lang: language,
      filePath,
      ...options,
    });
  }, [analyzeFull, currentFile]);
  
  // Context value
  const contextValue = useMemo(() => ({
    // State
    diagnostics,
    diagnosticsBySeverity,
    summary,
    isAnalyzing,
    tierStatus,
    enabled: settings.enabled,
    connectionStatus,
    clientReady,
    currentFile,
    
    // Actions
    setEnabled,
    triggerAnalysis,
    analyzeQuick,
    analyzeFull: runFullAnalysis,
    clearDiagnostics,
    navigateToDiagnostic,
    
    // Editor integration
    registerEditor,
    unregisterEditor,
    
    // Settings
    settings,
    updateSettings,
  }), [
    diagnostics,
    diagnosticsBySeverity,
    summary,
    isAnalyzing,
    tierStatus,
    settings,
    connectionStatus,
    clientReady,
    currentFile,
    setEnabled,
    triggerAnalysis,
    analyzeQuick,
    runFullAnalysis,
    clearDiagnostics,
    navigateToDiagnostic,
    registerEditor,
    unregisterEditor,
    updateSettings,
  ]);
  
  return (
    <ProactiveAnalysisContext.Provider value={contextValue}>
      {children}
    </ProactiveAnalysisContext.Provider>
  );
}

export default ProactiveAnalysisProvider;
