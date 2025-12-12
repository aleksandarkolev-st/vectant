export const SYNTHI_THEME = {
    base: 'vs-dark',
    inherit: true,
    rules: [
        { token: '', foreground: 'D4D4D4' },
        { token: 'comment', foreground: '6A9955' },
        { token: 'string', foreground: 'CE9178' },
        { token: 'keyword', foreground: '569CD6' },
        { token: 'keyword.control', foreground: 'C586C0' }, // if, else, return, etc.
        { token: 'operator', foreground: 'D4D4D4' },
        { token: 'number', foreground: 'B5CEA8' },
        { token: 'regexp', foreground: 'D16969' },
        { token: 'namespace', foreground: '4EC9B0' },

        // Types & Classes - Teal/Cyan
        { token: 'type', foreground: '4EC9B0' },
        { token: 'class', foreground: '4EC9B0' },
        { token: 'struct', foreground: '4EC9B0' },
        { token: 'interface', foreground: '4EC9B0' },
        { token: 'enum', foreground: '4EC9B0' },
        { token: 'type.identifier', foreground: '4EC9B0' },
        { token: 'delimiter', foreground: 'D4D4D4' },

        // Functions - Yellow
        { token: 'function', foreground: 'DCDCAA' },
        { token: 'method', foreground: 'DCDCAA' },
        { token: 'identifier.function', foreground: 'DCDCAA' },

        // Variables & Parameters - Light Blue
        { token: 'variable', foreground: '9CDCFE' },
        { token: 'parameter', foreground: '9CDCFE' },
        { token: 'identifier', foreground: '9CDCFE' },
        { token: 'variable.parameter', foreground: '9CDCFE' },

        // Properties - Light Blue (or sometimes lighter)
        { token: 'property', foreground: '9CDCFE' },
        { token: 'field', foreground: '9CDCFE' },

        // Constants - Blue or specific color
        { token: 'constant', foreground: '569CD6' },
        { token: 'constant.language', foreground: '569CD6' }, // true, false, null

        // Macros / Preprocessor - Purple
        { token: 'macro', foreground: 'C586C0' },
        { token: 'annotation', foreground: 'C586C0' },
        { token: 'keyword.directive', foreground: 'C586C0' }, // #include, #define

        // Storage - Blue
        { token: 'storage', foreground: '569CD6' },
        { token: 'storage.type', foreground: '569CD6' }, // int, void, etc.
        { token: 'storage.modifier', foreground: '569CD6' }, // const, static
    ],
    colors: {
        'editor.background': '#202020',
        'editor.foreground': '#D4D4D4',
        'editorCursor.foreground': '#FFFFFF',
        'editor.lineHighlightBackground': '#2D2D30',
        'editorLineNumber.foreground': '#858585',
        'editor.selectionBackground': '#264F78',
        'editor.inactiveSelectionBackground': '#3A3D41',
        'editorIndentGuide.background': '#404040',
        'editorIndentGuide.activeBackground': '#707070',
        'editorWhitespace.foreground': '#3B3A32',
    }
};
