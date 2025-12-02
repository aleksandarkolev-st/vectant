export const SYNTHI_THEME = {
    base: 'vs-dark',
    inherit: true,
    rules: [
        { token: '', foreground: 'D4D4D4' },
        { token: 'comment', foreground: '6A9955' },
        { token: 'string', foreground: 'CE9178' },
        { token: 'keyword', foreground: '569CD6' },
        { token: 'number', foreground: 'B5CEA8' },
        { token: 'regexp', foreground: 'D16969' },
        { token: 'operator', foreground: 'D4D4D4' },
        { token: 'namespace', foreground: '4EC9B0' },

        // Classes, Types, Structs - Teal/Cyan
        { token: 'type', foreground: '4EC9B0' },
        { token: 'class', foreground: '4EC9B0' },
        { token: 'struct', foreground: '4EC9B0' },
        { token: 'interface', foreground: '4EC9B0' },
        { token: 'enum', foreground: '4EC9B0' },
        { token: 'type.identifier', foreground: '4EC9B0' },

        // Functions - Yellow
        { token: 'function', foreground: 'DCDCAA' },
        { token: 'method', foreground: 'DCDCAA' },
        { token: 'identifier.function', foreground: 'DCDCAA' },

        // Variables, Parameters - Light Blue
        { token: 'variable', foreground: '9CDCFE' },
        { token: 'parameter', foreground: '9CDCFE' },
        { token: 'identifier', foreground: '9CDCFE' },

        // Constants - Blue
        { token: 'constant', foreground: '569CD6' },
        
        // Macros / Preprocessor - Purple
        { token: 'macro', foreground: 'C586C0' },
        { token: 'annotation', foreground: 'C586C0' },
    ],
    colors: {
        'editor.background': '#1E1E1E',
        'editor.foreground': '#D4D4D4',
        'editorCursor.foreground': '#FFFFFF',
        'editor.lineHighlightBackground': '#2D2D30',
        'editorLineNumber.foreground': '#858585',
        'editor.selectionBackground': '#264F78',
        'editor.inactiveSelectionBackground': '#3A3D41',
        'editorIndentGuide.background': '#404040',
        'editorIndentGuide.activeBackground': '#707070',
    }
};
