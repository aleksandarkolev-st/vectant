// Rich Monarch grammar for JavaScript — distinguishes function calls,
// template literals (with `${...}` interpolation), regex literals,
// JSDoc tags, PascalCase classes and ALL_CAPS constants.

const KEYWORDS = [
    'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const',
    'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export',
    'extends', 'finally', 'for', 'from', 'function', 'get', 'if', 'implements',
    'import', 'in', 'instanceof', 'interface', 'let', 'new', 'of', 'package',
    'private', 'protected', 'public', 'return', 'set', 'static', 'super',
    'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with',
    'yield',
];

const LITERALS = ['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'];

const BUILTINS = [
    'console', 'window', 'document', 'globalThis', 'process', 'require',
    'module', 'exports', 'Promise', 'Math', 'JSON', 'Object', 'Array',
    'String', 'Number', 'Boolean', 'Symbol', 'Map', 'Set', 'WeakMap',
    'WeakSet', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite',
];

export const JS_LANGUAGE = {
    defaultToken: '',
    tokenPostfix: '.js',
    keywords: KEYWORDS,
    literals: LITERALS,
    builtins: BUILTINS,
    operators: [
        '<=', '>=', '==', '!=', '===', '!==', '=>', '+', '-', '**', '*', '/',
        '%', '++', '--', '<<', '</', '>>', '>>>', '&', '|', '^', '!', '~',
        '&&', '||', '??', '?', ':', '=', '+=', '-=', '*=', '**=', '/=', '%=',
        '<<=', '>>=', '>>>=', '&=', '|=', '^=', '@', '...', '?.',
    ],
    symbols: /[=><!~?:&|+\-*/^%@]+/,
    escapes: /\\(?:[bfnrtv\\"'`$]|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|u\{[0-9A-Fa-f]+\})/,

    tokenizer: {
        root: [
            // Doc / block / line comments.
            [/\/\*\*(?!\/)/, 'comment.doc', '@docComment'],
            [/\/\*/, 'comment', '@blockComment'],
            [/\/\/.*$/, 'comment'],

            // Strings.
            [/"/, 'string', '@dString'],
            [/'/, 'string', '@sString'],
            [/`/, 'string', '@templateString'],

            // Regex — disambiguated from division by preceding context.
            [/(?<=[=(,!&|?:;+\-*/%^]|\breturn|^)\s*\/(?![/*])(?:[^/\\\n]|\\.)+\/[gimsuy]*/, 'regexp'],

            // Numbers.
            [/0[xX][0-9a-fA-F_]+n?/, 'number.hex'],
            [/0[bB][01_]+n?/, 'number.binary'],
            [/0[oO][0-7_]+n?/, 'number.octal'],
            [/\d[\d_]*\.\d[\d_]*(?:[eE][-+]?\d+)?/, 'number.float'],
            [/\d[\d_]*(?:[eE][-+]?\d+)/, 'number.float'],
            [/\d[\d_]*n?/, 'number'],

            // Function calls / declarations: `ident(`.
            [/([a-zA-Z_$][\w$]*)(\s*)(?=\()/, {
                cases: {
                    '$1@keywords': ['keyword', 'white'],
                    '$1@builtins': ['type', 'white'],
                    '@default': ['function.call', 'white'],
                },
            }],

            // ALL_CAPS_IDENTIFIERS → constants.
            [/\b[A-Z][A-Z0-9_]{1,}\b/, 'constant'],

            // PascalCase → classes.
            [/\b[A-Z][a-zA-Z0-9_$]*\b/, 'type.identifier'],

            // Object property access: `.method`.
            [/(\.)([a-zA-Z_$][\w$]*)(\s*)(?=\()/, ['delimiter', 'function.method', 'white']],
            [/(\.)([a-zA-Z_$][\w$]*)/, ['delimiter', 'property']],

            // Identifiers / keywords (catch-all).
            [/[a-zA-Z_$][\w$]*/, {
                cases: {
                    '@keywords': 'keyword',
                    '@literals': 'constant.language',
                    '@builtins': 'type',
                    '@default': 'identifier',
                },
            }],

            { include: '@whitespace' },

            [/[{}()[\]]/, '@brackets'],
            [/@symbols/, {
                cases: {
                    '@operators': 'operator',
                    '@default': 'delimiter',
                },
            }],
            [/[;,]/, 'delimiter'],
        ],

        whitespace: [[/[ \t\r\n]+/, '']],

        dString: [
            [/[^\\"$]+/, 'string'],
            [/@escapes/, 'string.escape'],
            [/\\./, 'string.escape.invalid'],
            [/"/, 'string', '@pop'],
        ],

        sString: [
            [/[^\\'$]+/, 'string'],
            [/@escapes/, 'string.escape'],
            [/\\./, 'string.escape.invalid'],
            [/'/, 'string', '@pop'],
        ],

        templateString: [
            [/[^\\`$]+/, 'string'],
            [/@escapes/, 'string.escape'],
            [/\\./, 'string.escape.invalid'],
            [/\$\{/, { token: 'delimiter.bracket.embed', next: '@templateExpr' }],
            [/\$/, 'string'],
            [/`/, 'string', '@pop'],
        ],

        templateExpr: [
            [/}/, { token: 'delimiter.bracket.embed', next: '@pop' }],
            { include: 'root' },
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
    },
};

export const JS_CONF = {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '(', close: ')' },
        { open: '"', close: '"', notIn: ['string'] },
        { open: "'", close: "'", notIn: ['string', 'comment'] },
        { open: '`', close: '`', notIn: ['string', 'comment'] },
    ],
};
