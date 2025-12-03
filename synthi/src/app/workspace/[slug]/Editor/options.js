export const EDITOR_OPTIONS = {
    minimap: {
        enabled: true,
        scale: 0.75,
        renderCharacters: false // Cleaner look
    },
    fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, 'Courier New', monospace",
    fontLigatures: true, // Essential for "sleek" feel
    fontSize: 14,
    lineHeight: 24,
    letterSpacing: 0.5,
    wordWrap: 'off',
    scrollBeyondLastLine: true,
    automaticLayout: true,
    cursorBlinking: "smooth", // Smooth fading cursor
    cursorSmoothCaretAnimation: "off", // Cursor glides
    smoothScrolling: true,
    contextmenu: false, // We use our own custom context menu
    padding: { top: 0, bottom: 16 },
    bracketPairColorization: { enabled: true }, // VS Code style brackets
    guides: {
        indentation: true,
        bracketPairs: false,
    },
    scrollbar: {
        verticalScrollbarSize: 10,
        horizontalScrollbarSize: 10,
        verticalHasArrows: false,
        horizontalHasArrows: false,
    },
    renderLineHighlight: "all", // Highlight line number and gutter
    lineNumbersMinChars: 4,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    hover: {
        enabled: true,
        delay: 300,
    },
    glyphMargin: true,
    semanticHighlighting: { enabled: true },
};
