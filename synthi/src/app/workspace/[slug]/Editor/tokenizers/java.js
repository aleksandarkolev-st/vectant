// Rich Monarch grammar for Java — emits annotations, generics, function calls,
// PascalCase types and ALL_CAPS constants as distinct scopes.

const KEYWORDS = [
    'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char',
    'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum',
    'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements',
    'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new',
    'non-sealed', 'package', 'permits', 'private', 'protected', 'public',
    'record', 'return', 'sealed', 'short', 'static', 'strictfp', 'super',
    'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try',
    'var', 'void', 'volatile', 'while', 'yield',
];

const PRIMITIVES = ['boolean', 'byte', 'char', 'double', 'float', 'int', 'long', 'short', 'void'];

const LITERALS = ['true', 'false', 'null'];

export const JAVA_LANGUAGE = {
    defaultToken: '',
    tokenPostfix: '.java',
    keywords: KEYWORDS,
    primitives: PRIMITIVES,
    literals: LITERALS,
    operators: [
        '=', '>', '<', '!', '~', '?', ':', '==', '<=', '>=', '!=', '&&', '||',
        '++', '--', '+', '-', '*', '/', '&', '|', '^', '%', '<<', '>>', '>>>',
        '+=', '-=', '*=', '/=', '&=', '|=', '^=', '%=', '<<=', '>>=', '>>>=',
        '->', '::',
    ],
    symbols: /[=><!~?:&|+\-*/^%]+/,
    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]+|[0-7]{1,3}|u[0-9A-Fa-f]{4})/,

    tokenizer: {
        root: [
            // Annotations.
            [/@[a-zA-Z_$][\w$]*/, 'annotation'],

            // Doc / block / line comments.
            [/\/\*\*(?!\/)/, 'comment.doc', '@docComment'],
            [/\/\*/, 'comment', '@blockComment'],
            [/\/\/.*$/, 'comment'],

            // Strings — including text blocks (""").
            [/"""/, 'string', '@textBlock'],
            [/"/, 'string', '@string'],
            [/'(?:[^\\']|@escapes)'/, 'string'],
            [/'/, 'string.invalid'],

            // Numbers.
            [/0[xX][0-9a-fA-F_]+[lL]?/, 'number.hex'],
            [/0[bB][01_]+[lL]?/, 'number.binary'],
            [/\d[\d_]*\.\d[\d_]*(?:[eE][-+]?\d+)?[fFdD]?/, 'number.float'],
            [/\d[\d_]*(?:[eE][-+]?\d+)[fFdD]?/, 'number.float'],
            [/\d[\d_]*[lL]?/, 'number'],

            // Function / method calls.
            [/([a-zA-Z_$][\w$]*)(\s*)(?=\()/, {
                cases: {
                    '$1@keywords': ['keyword', 'white'],
                    '$1@primitives': ['type', 'white'],
                    '@default': ['function.call', 'white'],
                },
            }],

            // ALL_CAPS_IDENTIFIERS → constants.
            [/\b[A-Z][A-Z0-9_]{1,}\b/, 'constant'],

            // PascalCase → types / classes.
            [/\b[A-Z][a-zA-Z0-9_$]*\b/, 'type.identifier'],

            // Identifiers + keywords (catch-all).
            [/[a-zA-Z_$][\w$]*/, {
                cases: {
                    '@keywords': 'keyword',
                    '@primitives': 'type',
                    '@literals': 'constant.language',
                    '@default': 'identifier',
                },
            }],

            { include: '@whitespace' },

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

        whitespace: [[/[ \t\r\n]+/, '']],

        string: [
            [/[^\\"]+/, 'string'],
            [/@escapes/, 'string.escape'],
            [/\\./, 'string.escape.invalid'],
            [/"/, 'string', '@pop'],
        ],

        textBlock: [
            [/[^"\\]+/, 'string'],
            [/@escapes/, 'string.escape'],
            [/"""/, 'string', '@pop'],
            [/"/, 'string'],
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

export const JAVA_CONF = {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '(', close: ')' },
        { open: '"', close: '"', notIn: ['string'] },
        { open: "'", close: "'", notIn: ['string', 'comment'] },
    ],
};
