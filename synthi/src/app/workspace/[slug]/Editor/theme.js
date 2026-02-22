// Synthi Premium Dark Theme - Distinctive Brand with Teal Accent
export const SYNTHI_THEME = {
    base: 'vs-dark',
    inherit: true,
    rules: [
        // Base text
        { token: '', foreground: 'f4f5f8' },
        
        // Comments - Lower saturation, more muted for less visual noise
        { token: 'comment', foreground: '454a5e', fontStyle: 'italic' },
        
        // Strings - Soft Pastel Mint Green
        { token: 'string', foreground: 'a8e6cf' },
        { token: 'string.escape', foreground: '7dd3b4' },
        
        // Keywords - Synthi Teal (Primary accent) - slightly brighter
        { token: 'keyword', foreground: '3a8574' },
        { token: 'keyword.control', foreground: '3a8574' },
        { token: 'keyword.operator', foreground: '4a9a88' },
        
        // Operators - Light gray
        { token: 'operator', foreground: 'a8adc0' },
        
        // Numbers - Warm Gold
        { token: 'number', foreground: 'f5d142' },
        { token: 'number.float', foreground: 'f5d142' },
        { token: 'number.hex', foreground: 'f5b847' },
        
        // Regex - Coral
        { token: 'regexp', foreground: 'ff6b6b' },
        
        // Namespace - Teal accent
        { token: 'namespace', foreground: '4a9a88' },

        // Types & Classes - Sky Blue - higher contrast
        { token: 'type', foreground: '8ad4ff' },
        { token: 'class', foreground: '8ad4ff' },
        { token: 'struct', foreground: '8ad4ff' },
        { token: 'interface', foreground: '8ad4ff' },
        { token: 'enum', foreground: '8ad4ff' },
        { token: 'type.identifier', foreground: '8ad4ff' },
        { token: 'delimiter', foreground: '5a6178' },

        // Functions - Brighter blue for better contrast vs types
        { token: 'function', foreground: '7cb8f8' },
        { token: 'method', foreground: '7cb8f8' },
        { token: 'identifier.function', foreground: '7cb8f8' },

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
        // Editor background - Darker for more contrast
        'editor.background': '#0c0d12',
        'editor.foreground': '#f4f5f8',
        
        // Cursor - Teal accent with glow effect
        'editorCursor.foreground': '#3a8574',
        
        // Line highlight - STRONGER active line background
        'editor.lineHighlightBackground': '#1e2030',
        'editor.lineHighlightBorder': '#3a857450',
        
        // Line numbers - More muted, active gets stronger accent
        'editorLineNumber.foreground': '#454a5e',
        'editorLineNumber.activeForeground': '#4aba9a',
        
        // Selection - Teal tinted, slightly more visible
        'editor.selectionBackground': '#3a857440',
        'editor.inactiveSelectionBackground': '#3a857420',
        
        // Indent guides - more subtle
        'editorIndentGuide.background': '#1a1b24',
        'editorIndentGuide.activeBackground': '#2a2b38',
        
        // Whitespace
        'editorWhitespace.foreground': '#1c1d26',
        
        // Gutter
        'editorGutter.background': '#0d0e14',
        'editorGutter.addedBackground': '#3def3a',
        'editorGutter.modifiedBackground': '#1871d0',
        'editorGutter.deletedBackground': '#ff6b6b',
        
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
