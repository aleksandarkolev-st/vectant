// Rich Monarch grammar for Rust — distinguishes macros (`println!`),
// lifetimes (`'a`), attributes (`#[derive(...)]`), function calls,
// PascalCase types and ALL_CAPS constants.

const KEYWORDS = [
    'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn',
    'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let',
    'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'Self',
    'self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'union',
    'unsafe', 'use', 'where', 'while', 'box', 'do', 'final', 'macro',
    'override', 'priv', 'try', 'typeof', 'unsized', 'virtual', 'yield',
];

const PRIMITIVES = [
    'bool', 'char', 'str', 'i8', 'i16', 'i32', 'i64', 'i128', 'isize',
    'u8', 'u16', 'u32', 'u64', 'u128', 'usize', 'f32', 'f64',
];

const LITERALS = ['true', 'false'];

export const RUST_LANGUAGE = {
    defaultToken: '',
    tokenPostfix: '.rs',
    keywords: KEYWORDS,
    primitives: PRIMITIVES,
    literals: LITERALS,
    operators: [
        '=', '>', '<', '!', '~', '?', ':', '==', '<=', '>=', '!=', '&&', '||',
        '+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>',
        '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=',
        '->', '=>', '::', '..', '..=',
    ],
    symbols: /[=><!~?:&|+\-*/^%]+/,
    escapes: /\\(?:[nrt\\"'0]|x[0-9A-Fa-f]{2}|u\{[0-9A-Fa-f]+\})/,

    tokenizer: {
        root: [
            // Attributes: #[derive(...)]  #![allow(...)]
            [/#!?\[/, { token: 'annotation', next: '@attribute' }],

            // Doc comments / line / block.
            [/\/\/[!/].*$/, 'comment.doc'],
            [/\/\/.*$/, 'comment'],
            [/\/\*\*/, 'comment.doc', '@docComment'],
            [/\/\*/, 'comment', '@blockComment'],

            // Strings — raw + regular.
            [/b?r#*"/, { token: 'string', next: '@rawString' }],
            [/b?"/, 'string', '@string'],
            [/b?'(?:[^\\']|@escapes)'/, 'string'],

            // Lifetimes: `'a`, `'static`.
            [/'[a-zA-Z_]\w*(?!')/, 'variable.lifetime'],

            // Numbers — Rust suffixes (_i32, _u64, _f64).
            [/0x[0-9a-fA-F_]+(?:_?(?:[ui](?:8|16|32|64|128|size)|f32|f64))?/, 'number.hex'],
            [/0b[01_]+(?:_?[ui](?:8|16|32|64|128|size))?/, 'number.binary'],
            [/0o[0-7_]+(?:_?[ui](?:8|16|32|64|128|size))?/, 'number.octal'],
            [/\d[\d_]*\.\d[\d_]*(?:[eE][-+]?\d+)?(?:_?f(?:32|64))?/, 'number.float'],
            [/\d[\d_]*(?:_?(?:[ui](?:8|16|32|64|128|size)|f(?:32|64)))?/, 'number'],

            // Macro invocation: `println!`, `vec!`.
            [/[a-zA-Z_]\w*!/, 'keyword.macro'],

            // Function calls.
            [/([a-zA-Z_]\w*)(\s*)(?=\()/, {
                cases: {
                    '$1@keywords': ['keyword', 'white'],
                    '$1@primitives': ['type', 'white'],
                    '@default': ['function.call', 'white'],
                },
            }],

            // ALL_CAPS_CONSTANTS.
            [/\b[A-Z][A-Z0-9_]{1,}\b/, 'constant'],

            // PascalCase → types.
            [/\b[A-Z][a-zA-Z0-9_]*\b/, 'type.identifier'],

            // Identifiers + keywords (catch-all).
            [/[a-zA-Z_]\w*/, {
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

        rawString: [
            [/[^"#]+/, 'string'],
            [/"#*/, 'string', '@pop'],
            [/[#"]/, 'string'],
        ],

        blockComment: [
            [/[^/*]+/, 'comment'],
            [/\*\//, 'comment', '@pop'],
            [/[/*]/, 'comment'],
        ],

        docComment: [
            [/[^/*]+/, 'comment.doc'],
            [/\*\//, 'comment.doc', '@pop'],
            [/[/*]/, 'comment.doc'],
        ],

        attribute: [
            [/[^\]"]+/, 'annotation'],
            [/"[^"]*"/, 'string'],
            [/]/, 'annotation', '@pop'],
        ],
    },
};

export const RUST_CONF = {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '(', close: ')' },
        { open: '"', close: '"', notIn: ['string'] },
    ],
};
