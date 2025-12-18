// Synthi Editor Options - Premium Configuration
export const EDITOR_OPTIONS = {
    minimap: {
        enabled: true,
        scale: 0.75,
        renderCharacters: false // Cleaner look
    },
    // Premium font stack with ligatures
    fontFamily: "'JetBrains Mono', 'Geist Mono', 'Fira Code', Consolas, 'Courier New', monospace",
    fontLigatures: true, // Essential for "sleek" feel
    fontSize: 14,
    // Line height 1.75 for improved readability
    lineHeight: 24.5, // 14 * 1.75 = 24.5
    letterSpacing: 0.5,
    wordWrap: 'off',
    scrollBeyondLastLine: true,
    automaticLayout: true,
    // Smooth cursor animation with stronger visual anchor
    cursorBlinking: "smooth", // Smooth fading cursor
    cursorSmoothCaretAnimation: "on", // Cursor glides smoothly
    cursorStyle: "line", // Thin line cursor
    cursorWidth: 2, // 2px width for the line cursor
    smoothScrolling: true,
    contextmenu: false, // We use our own custom context menu
    padding: { top: 16, bottom: 20 },
    bracketPairColorization: { enabled: true }, // VS Code style brackets
    guides: {
        indentation: true,
        bracketPairs: false,
    },
    // Scrollbar styling - 8px pill shape
    scrollbar: {
        verticalScrollbarSize: 8,
        horizontalScrollbarSize: 8,
        verticalHasArrows: false,
        horizontalHasArrows: false,
        useShadows: false,
        verticalSliderSize: 8,
        horizontalSliderSize: 8,
    },
    renderLineHighlight: "all", // Highlight line number and gutter
    // Gutter - massive breathing room
    lineNumbersMinChars: 5,
    glyphMargin: true,
    folding: true,
    // Remove border between gutter and code - use space as divider
    lineDecorationsWidth: 24, // 24px padding-right for gutter
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    hover: {
        enabled: true,
        delay: 300,
    },
    quickSuggestions: {
        other: true,
        comments: false,
        strings: false
    },
    suggest: {
        snippetsPreventQuickSuggestions: false,
        showIcons: true,
        showStatusBar: true,
        preview: true,
        previewMode: 'subwordSmart'
    },
    semanticHighlighting: { enabled: true },
    // Focus ring color
    'editor.focusRing': '#3b82f6',
};
