// Synthi Premium Dark Theme - Distinctive Brand with Teal Accent
export const SYNTHI_THEME = {
    base: 'vs-dark',
    inherit: true,
    rules: [
        // Base text
        { token: '', foreground: 'f0f2f5' },
        
        // Comments - Muted blue-gray
        { token: 'comment', foreground: '5a5f7a', fontStyle: 'italic' },
        
        // Strings - Soft Pastel Mint Green
        { token: 'string', foreground: 'a8e6cf' },
        { token: 'string.escape', foreground: '7dd3b4' },
        
        // Keywords - Synthi Teal (Primary accent)
        { token: 'keyword', foreground: '327464' },
        { token: 'keyword.control', foreground: '327464' },
        { token: 'keyword.operator', foreground: '3d8b78' },
        
        // Operators - Light gray
        { token: 'operator', foreground: 'a8adc0' },
        
        // Numbers - Warm Gold
        { token: 'number', foreground: 'ffd93d' },
        { token: 'number.float', foreground: 'ffd93d' },
        { token: 'number.hex', foreground: 'ffb347' },
        
        // Regex - Coral
        { token: 'regexp', foreground: 'ff6b6b' },
        
        // Namespace - Teal accent
        { token: 'namespace', foreground: '3d8b78' },

        // Types & Classes - Sky Blue
        { token: 'type', foreground: '7dd3fc' },
        { token: 'class', foreground: '7dd3fc' },
        { token: 'struct', foreground: '7dd3fc' },
        { token: 'interface', foreground: '7dd3fc' },
        { token: 'enum', foreground: '7dd3fc' },
        { token: 'type.identifier', foreground: '7dd3fc' },
        { token: 'delimiter', foreground: '6b7089' },

        // Functions - Soft Blue
        { token: 'function', foreground: '88c0fc' },
        { token: 'method', foreground: '88c0fc' },
        { token: 'identifier.function', foreground: '88c0fc' },

        // Variables & Parameters - Light text
        { token: 'variable', foreground: 'f0f2f5' },
        { token: 'parameter', foreground: 'a8adc0' },
        { token: 'identifier', foreground: 'f0f2f5' },
        { token: 'variable.parameter', foreground: 'a8adc0' },

        // Properties - Lavender
        { token: 'property', foreground: 'c4b5fd' },
        { token: 'field', foreground: 'c4b5fd' },

        // Constants - Gold
        { token: 'constant', foreground: 'ffd93d' },
        { token: 'constant.language', foreground: '4a9e8a' }, // true, false, null

        // Macros / Preprocessor - LAVENDER (Unique!)
        { token: 'macro', foreground: 'c4b5fd' },
        { token: 'annotation', foreground: 'c4b5fd' },
        { token: 'keyword.directive', foreground: 'c4b5fd' }, // #include, #define
        { token: 'meta.preprocessor', foreground: 'c4b5fd' },

        // Storage - Teal
        { token: 'storage', foreground: '3d8b78' },
        { token: 'storage.type', foreground: '3d8b78' }, // int, void, etc.
        { token: 'storage.modifier', foreground: '3d8b78' }, // const, static
        
        // HTML/XML tags
        { token: 'tag', foreground: '327464' },
        { token: 'tag.attribute.name', foreground: 'c4b5fd' },
        { token: 'tag.attribute.value', foreground: 'a8e6cf' },
    ],
    colors: {
        // Editor background - Dark blue-gray (Unique!)
        'editor.background': '#0d0e14',
        'editor.foreground': '#f0f2f5',
        
        // Cursor - Teal accent with glow effect
        'editorCursor.foreground': '#327464',
        
        // Line highlight - Subtle teal tint
        'editor.lineHighlightBackground': '#1a1b25',
        'editor.lineHighlightBorder': '#32746430',
        
        // Line numbers - Muted, active gets accent
        'editorLineNumber.foreground': '#5a5f7a',
        'editorLineNumber.activeForeground': '#327464',
        
        // Selection - Teal tinted
        'editor.selectionBackground': '#32746435',
        'editor.inactiveSelectionBackground': '#32746418',
        
        // Indent guides
        'editorIndentGuide.background': '#1c1d26',
        'editorIndentGuide.activeBackground': '#32334a',
        
        // Whitespace
        'editorWhitespace.foreground': '#1c1d26',
        
        // Gutter
        'editorGutter.background': '#0d0e14',
        
        // Minimap - Styled
        'minimap.background': '#0a0b10',
        'minimapSlider.background': '#32746420',
        'minimapSlider.hoverBackground': '#32746435',
        'minimapSlider.activeBackground': '#32746450',
        
        // Scrollbar - Teal accent
        'scrollbar.shadow': '#00000000',
        'scrollbarSlider.background': '#32746430',
        'scrollbarSlider.hoverBackground': '#32746450',
        'scrollbarSlider.activeBackground': '#32746470',
        
        // Widget
        'editorWidget.background': '#0d0e14',
        'editorWidget.border': '#1c1d26',
        
        // Bracket matching - Teal glow
        'editorBracketMatch.background': '#32746425',
        'editorBracketMatch.border': '#327464',
        
        // Find/Search - Distinct highlight
        'editor.findMatchBackground': '#ffd93d30',
        'editor.findMatchHighlightBackground': '#ffd93d20',
        'editor.findMatchBorder': '#ffd93d',
        
        // Word highlight
        'editor.wordHighlightBackground': '#32746420',
        'editor.wordHighlightStrongBackground': '#32746430',
    }
};
