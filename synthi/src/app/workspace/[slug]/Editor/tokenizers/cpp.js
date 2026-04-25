// Rich Monarch grammar for C / C++.
//
// Goes beyond Monaco's basic-languages/cpp by emitting distinct scopes for
// function calls, types, ALL_CAPS macros and #include header strings — so the
// theme can paint each in a different colour instead of one flat "identifier".

const KEYWORDS = [
    'alignas', 'alignof', 'and', 'and_eq', 'asm', 'auto', 'bitand', 'bitor',
    'bool', 'break', 'case', 'catch', 'char', 'char8_t', 'char16_t', 'char32_t',
    'class', 'compl', 'concept', 'const', 'consteval', 'constexpr', 'constinit',
    'const_cast', 'continue', 'co_await', 'co_return', 'co_yield', 'decltype',
    'default', 'delete', 'do', 'double', 'dynamic_cast', 'else', 'enum',
    'explicit', 'export', 'extern', 'false', 'float', 'for', 'friend', 'goto',
    'if', 'inline', 'int', 'long', 'mutable', 'namespace', 'new', 'noexcept',
    'not', 'not_eq', 'nullptr', 'operator', 'or', 'or_eq', 'private',
    'protected', 'public', 'register', 'reinterpret_cast', 'requires', 'return',
    'short', 'signed', 'sizeof', 'static', 'static_assert', 'static_cast',
    'struct', 'switch', 'template', 'this', 'thread_local', 'throw', 'true',
    'try', 'typedef', 'typeid', 'typename', 'union', 'unsigned', 'using',
    'virtual', 'void', 'volatile', 'wchar_t', 'while', 'xor', 'xor_eq',
];

const PRIMITIVE_TYPES = [
    'bool', 'char', 'char8_t', 'char16_t', 'char32_t', 'double', 'float',
    'int', 'long', 'short', 'signed', 'unsigned', 'void', 'wchar_t',
    'size_t', 'ssize_t', 'ptrdiff_t', 'intptr_t', 'uintptr_t',
    'int8_t', 'int16_t', 'int32_t', 'int64_t',
    'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
];

export const CPP_LANGUAGE = {
    defaultToken: '',
    tokenPostfix: '.cpp',
    keywords: KEYWORDS,
    primitiveTypes: PRIMITIVE_TYPES,
    operators: [
        '=', '>', '<', '!', '~', '?', ':', '==', '<=', '>=', '!=', '&&', '||',
        '++', '--', '+', '-', '*', '/', '&', '|', '^', '%', '<<', '>>',
        '+=', '-=', '*=', '/=', '&=', '|=', '^=', '%=', '<<=', '>>=',
        '->', '->*', '.*', '::', '...',
    ],
    symbols: /[=><!~?:&|+\-*/^%]+/,
    escapes: /\\(?:[abfnrtv\\"'?]|x[0-9A-Fa-f]+|[0-7]{1,3}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,

    tokenizer: {
        root: [
            // Preprocessor — whole-line capture so we can colour the directive
            // and the rest of the line independently.
            [/^\s*#\s*include\b/, { token: 'keyword.directive.include', next: '@includeLine' }],
            [/^\s*#\s*\w+/, 'keyword.directive'],

            // Doc comments / block / line comments.
            [/\/\*\*(?!\/)/, 'comment.doc', '@docComment'],
            [/\/\*/, 'comment', '@blockComment'],
            [/\/\/.*$/, 'comment'],

            // Strings & chars.
            [/L?"/, 'string', '@string'],
            [/'(?:[^\\']|@escapes)'/, 'string'],
            [/'/, 'string.invalid'],

            // Numbers — order matters (hex/bin/oct before decimal).
            [/0[xX][0-9a-fA-F']+(?:[uUlL]|ll|LL)*/, 'number.hex'],
            [/0[bB][01']+(?:[uUlL]|ll|LL)*/, 'number.binary'],
            [/0[0-7']+(?:[uUlL]|ll|LL)*/, 'number.octal'],
            [/\d[\d']*\.\d[\d']*(?:[eE][-+]?\d+)?[fFlL]?/, 'number.float'],
            [/\d[\d']*(?:[eE][-+]?\d+)[fFlL]?/, 'number.float'],
            [/\d[\d']*(?:[uUlL]|ll|LL)*/, 'number'],

            // Function calls — `ident(` where ident isn't a keyword.
            // The capture-group + cases trick lets us reject keywords cheanly.
            [/([a-zA-Z_]\w*)(\s*)(?=\()/, {
                cases: {
                    '$1@keywords': ['keyword', 'white'],
                    '$1@primitiveTypes': ['type', 'white'],
                    '@default': ['function.call', 'white'],
                },
            }],

            // ALL_CAPS_IDENTIFIERS → macro / constant.
            [/\b[A-Z][A-Z0-9_]{1,}\b/, 'constant.macro'],

            // PascalCase or _t-suffixed → user types.
            [/\b[A-Z][a-z]\w*\b/, 'type.identifier'],
            [/\b[a-zA-Z_]\w*_t\b/, 'type.identifier'],

            // Identifiers and keywords (catch-all).
            [/[a-zA-Z_]\w*/, {
                cases: {
                    '@keywords': 'keyword',
                    '@primitiveTypes': 'type',
                    '@default': 'identifier',
                },
            }],

            { include: '@whitespace' },

            // Delimiters — call out brackets vs operators distinctly.
            [/[{}()[\]]/, '@brackets'],
            [/[<>](?!@symbols)/, '@brackets'],
            [/@symbols/, {
                cases: {
                    '@operators': 'operator',
                    '@default': 'delimiter',
                },
            }],
            [/[;,.]/, 'delimiter'],
        ],

        whitespace: [
            [/[ \t\r\n]+/, ''],
        ],

        string: [
            [/[^\\"]+/, 'string'],
            [/@escapes/, 'string.escape'],
            [/\\./, 'string.escape.invalid'],
            [/"/, 'string', '@pop'],
        ],

        blockComment: [
            [/[^/*]+/, 'comment'],
            [/\*\//, 'comment', '@pop'],
            [/[/*]/, 'comment'],
        ],

        docComment: [
            [/[^/*@]+/, 'comment.doc'],
            [/@\w+/, 'keyword.doc'],
            [/\*\//, 'comment.doc', '@pop'],
            [/[/*@]/, 'comment.doc'],
        ],

        includeLine: [
            [/<[^>]*>/, 'string.include'],
            [/"[^"]*"/, 'string.include'],
            [/$/, '', '@pop'],
            [/./, ''],
        ],
    },
};

export const CPP_CONF = {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '(', close: ')' },
        { open: '"', close: '"', notIn: ['string'] },
        { open: "'", close: "'", notIn: ['string', 'comment'] },
    ],
    surroundingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '(', close: ')' },
        { open: '"', close: '"' },
        { open: "'", close: "'" },
        { open: '<', close: '>' },
    ],
};
