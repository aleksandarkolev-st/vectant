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
    // Render suggest/hover/parameter-hints widgets in a fixed overlay
    // so they are not clipped by overflow:hidden on the editor container.
    fixedOverflowWidgets: true,
    // Smooth cursor animation with stronger visual anchor
    cursorBlinking: "smooth", // Smooth fading cursor
    cursorSmoothCaretAnimation: "off", // Cursor glides smoothly
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
        other: 'on',
        comments: false,
        strings: false
    },
    quickSuggestionsDelay: 150, // Avoid firing on every keystroke
    wordBasedSuggestions: 'off', // LSP handles completions — no need for word-based
    suggestOnTriggerCharacters: true, // Ensure :: . ( etc. trigger completions
    acceptSuggestionOnCommitCharacter: true, // Accept suggestion on . ( etc.
    suggest: {
        snippetsPreventQuickSuggestions: false,
        showIcons: true,
        showStatusBar: true,
        preview: true,
        previewMode: 'subwordSmart',
        filterGraceful: true, // Fuzzy matching for better results after ::
    },
    semanticHighlighting: { enabled: true },
    // Focus ring color
    'editor.focusRing': '#3b82f6',
};
