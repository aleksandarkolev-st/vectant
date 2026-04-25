/**
 * Monarch Tokenizer Registration
 *
 * @codingame/monaco-vscode-api overrides Monaco's built-in language
 * contribution loading, so the Monarch tokenizers that ship with
 * `monaco-editor` are NOT automatically registered.  This module
 * explicitly loads and registers them for ALL languages (including
 * JavaScript and TypeScript), providing full syntax highlighting
 * without requiring TextMate grammars or bundled vscode extensions.
 *
 * For our seven "first-class" languages (cpp/c, java, rust, js, ts, html, css)
 * we ship custom Monarch grammars under ./tokenizers/ that emit richer scopes
 * (function.call, type.identifier, constant.macro, attribute.name, …) than the
 * Monaco basic-languages defaults — the theme can then paint each one in a
 * distinct colour.  Other languages still fall back to Monaco's grammars.
 */

import * as monaco from 'monaco-editor';

import { CPP_LANGUAGE,  CPP_CONF }  from './tokenizers/cpp.js';
import { JAVA_LANGUAGE, JAVA_CONF } from './tokenizers/java.js';
import { RUST_LANGUAGE, RUST_CONF } from './tokenizers/rust.js';
import { JS_LANGUAGE,   JS_CONF }   from './tokenizers/javascript.js';
import { TS_LANGUAGE,   TS_CONF }   from './tokenizers/typescript.js';
import { HTML_LANGUAGE, HTML_CONF } from './tokenizers/html.js';
import { CSS_LANGUAGE,  CSS_CONF }  from './tokenizers/css.js';

/** Custom-grammar registrations — these win over Monaco's basic-languages. */
const CUSTOM_GRAMMARS = [
    { id: 'cpp',        language: CPP_LANGUAGE,  conf: CPP_CONF  },
    { id: 'c',          language: CPP_LANGUAGE,  conf: CPP_CONF  },
    { id: 'java',       language: JAVA_LANGUAGE, conf: JAVA_CONF },
    { id: 'rust',       language: RUST_LANGUAGE, conf: RUST_CONF },
    { id: 'javascript', language: JS_LANGUAGE,   conf: JS_CONF   },
    { id: 'typescript', language: TS_LANGUAGE,   conf: TS_CONF   },
    { id: 'html',       language: HTML_LANGUAGE, conf: HTML_CONF },
    { id: 'css',        language: CSS_LANGUAGE,  conf: CSS_CONF  },
];

/**
 * Language → dynamic import for the Monarch definition module.  Only languages
 * we DON'T ship a custom grammar for live here — they fall back to Monaco's
 * basic-languages tokenizers.
 */
const MONARCH_LOADERS = [
    { id: 'python',  load: () => import('monaco-editor/esm/vs/basic-languages/python/python.js') },
    { id: 'go',      load: () => import('monaco-editor/esm/vs/basic-languages/go/go.js') },
    { id: 'csharp',  load: () => import('monaco-editor/esm/vs/basic-languages/csharp/csharp.js') },
    { id: 'kotlin',  load: () => import('monaco-editor/esm/vs/basic-languages/kotlin/kotlin.js') },
    { id: 'dart',    load: () => import('monaco-editor/esm/vs/basic-languages/dart/dart.js') },
    { id: 'lua',     load: () => import('monaco-editor/esm/vs/basic-languages/lua/lua.js') },
    { id: 'swift',   load: () => import('monaco-editor/esm/vs/basic-languages/swift/swift.js') },
    { id: 'scala',   load: () => import('monaco-editor/esm/vs/basic-languages/scala/scala.js') },
    { id: 'ruby',    load: () => import('monaco-editor/esm/vs/basic-languages/ruby/ruby.js') },
    { id: 'php',     load: () => import('monaco-editor/esm/vs/basic-languages/php/php.js') },
    { id: 'elixir',  load: () => import('monaco-editor/esm/vs/basic-languages/elixir/elixir.js') },
];

// ── Custom Monarch tokenizers for languages Monaco doesn't include ──

/** Minimal Zig tokenizer */
const ZIG_LANGUAGE = {
    defaultToken: '',
    keywords: [
        'addrspace', 'align', 'allowzero', 'and', 'anyframe', 'anytype',
        'asm', 'async', 'await', 'break', 'callconv', 'catch', 'comptime',
        'const', 'continue', 'defer', 'else', 'enum', 'errdefer', 'error',
        'export', 'extern', 'fn', 'for', 'if', 'inline', 'linksection',
        'noalias', 'nosuspend', 'orelse', 'or', 'packed', 'pub', 'resume',
        'return', 'struct', 'suspend', 'switch', 'test', 'threadlocal',
        'try', 'union', 'unreachable', 'usingnamespace', 'var', 'volatile',
        'while',
    ],
    builtinTypes: [
        'bool', 'f16', 'f32', 'f64', 'f80', 'f128', 'c_short', 'c_int',
        'c_long', 'c_longlong', 'c_longdouble', 'c_char', 'anyerror',
        'anyopaque', 'comptime_int', 'comptime_float', 'noreturn', 'type',
        'undefined', 'null', 'void', 'usize', 'isize',
        'u8', 'u16', 'u32', 'u64', 'u128', 'i8', 'i16', 'i32', 'i64', 'i128',
    ],
    constants: ['true', 'false', 'null', 'undefined'],
    operators: [
        '=', '>', '<', '!', '~', '?', ':', '==', '<=', '>=', '!=',
        '+', '-', '*', '/', '%', '|', '^', '&', '<<', '>>', '++',
        '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=',
        '||', '&&',
    ],
    tokenizer: {
        root: [
            [/[a-zA-Z_]\w*/, {
                cases: {
                    '@keywords': 'keyword',
                    '@builtinTypes': 'type',
                    '@constants': 'constant.language',
                    '@default': 'identifier',
                }
            }],
            [/@"[^"]*"/, 'variable'],
            { include: '@whitespace' },
            [/[{}()\[\]]/, 'delimiter'],
            [/[<>](?!@)/, 'delimiter'],
            [/0x[0-9a-fA-F_]+/, 'number.hex'],
            [/0b[01_]+/, 'number.binary'],
            [/0o[0-7_]+/, 'number.octal'],
            [/\d[\d_]*(\.\d[\d_]*)?([eE][-+]?\d+)?/, 'number'],
            [/"([^"\\]|\\.)*$/, 'string.invalid'],
            [/"/, 'string', '@string'],
            [/'[^\\']'/, 'string'],
            [/(')(@)/, ['string', 'keyword']],
            [/'/, 'string.invalid'],
        ],
        whitespace: [
            [/[ \t\r\n]+/, ''],
            [/\/\/.*$/, 'comment'],
        ],
        string: [
            [/[^\\"]+/, 'string'],
            [/\\./, 'string.escape'],
            [/"/, 'string', '@pop'],
        ],
    },
};

const ZIG_CONF = {
    comments: { lineComment: '//' },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '(', close: ')' },
        { open: '"', close: '"', notIn: ['string'] },
        { open: "'", close: "'", notIn: ['string', 'comment'] },
    ],
};

/** Minimal Haskell tokenizer */
const HASKELL_LANGUAGE = {
    defaultToken: '',
    keywords: [
        'as', 'case', 'class', 'data', 'default', 'deriving', 'do', 'else',
        'family', 'forall', 'foreign', 'hiding', 'if', 'import', 'in',
        'infix', 'infixl', 'infixr', 'instance', 'let', 'module', 'newtype',
        'of', 'qualified', 'then', 'type', 'where',
    ],
    constants: ['True', 'False', 'Nothing', 'Just', 'Left', 'Right'],
    tokenizer: {
        root: [
            [/[a-z_]\w*'*/, {
                cases: {
                    '@keywords': 'keyword',
                    '@default': 'identifier',
                }
            }],
            [/[A-Z]\w*'*/, {
                cases: {
                    '@constants': 'constant.language',
                    '@default': 'type',
                }
            }],
            { include: '@whitespace' },
            [/[{}()\[\]]/, 'delimiter'],
            [/0[xX][0-9a-fA-F]+/, 'number.hex'],
            [/\d+(\.\d+)?([eE][-+]?\d+)?/, 'number'],
            [/"([^"\\]|\\.)*$/, 'string.invalid'],
            [/"/, 'string', '@string'],
            [/'[^\\']'/, 'string'],
            [/'\\.'/, 'string.escape'],
            [/[=<>!~?:&|+\-*\/^%]+/, 'operator'],
        ],
        whitespace: [
            [/[ \t\r\n]+/, ''],
            [/--.*$/, 'comment'],
            [/\{-/, 'comment', '@blockComment'],
        ],
        blockComment: [
            [/[^{-]+/, 'comment'],
            [/\{-/, 'comment', '@push'],
            [/-\}/, 'comment', '@pop'],
            [/[{-]/, 'comment'],
        ],
        string: [
            [/[^\\"]+/, 'string'],
            [/\\./, 'string.escape'],
            [/"/, 'string', '@pop'],
        ],
    },
};

const HASKELL_CONF = {
    comments: { lineComment: '--', blockComment: ['{-', '-}'] },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '(', close: ')' },
        { open: '"', close: '"', notIn: ['string'] },
        { open: "'", close: "'", notIn: ['string', 'comment'] },
    ],
};

/**
 * Register Monarch tokenizers for all supported languages.
 * Called once during Monaco service initialization, after wrapper.start().
 */
export async function registerMonarchTokenizers() {
    const registered = [];

    // ── Custom rich grammars (cpp/c, java, rust, js, ts, html, css) ──
    for (const { id, language, conf } of CUSTOM_GRAMMARS) {
        try {
            monaco.languages.setMonarchTokensProvider(id, language);
            if (conf) monaco.languages.setLanguageConfiguration(id, conf);
            registered.push(id);
        } catch (e) {
            console.warn(`[Tokenizer] Failed to register custom grammar for "${id}":`, e.message);
        }
    }

    // ── Monaco built-in languages (everything else) ──────────────
    await Promise.allSettled(
        MONARCH_LOADERS.map(async ({ id, load }) => {
            try {
                const mod = await load();
                if (mod.language) {
                    monaco.languages.setMonarchTokensProvider(id, mod.language);
                }
                if (mod.conf) {
                    monaco.languages.setLanguageConfiguration(id, mod.conf);
                }
                registered.push(id);
            } catch (e) {
                console.warn(`[Tokenizer] Failed to load Monarch grammar for "${id}":`, e.message);
            }
        })
    );

    // ── Custom tokenizers for languages Monaco doesn't ship ──────
    try {
        monaco.languages.setMonarchTokensProvider('zig', ZIG_LANGUAGE);
        monaco.languages.setLanguageConfiguration('zig', ZIG_CONF);
        registered.push('zig');
    } catch (e) {
        console.warn('[Tokenizer] Failed to register Zig tokenizer:', e.message);
    }

    try {
        monaco.languages.setMonarchTokensProvider('haskell', HASKELL_LANGUAGE);
        monaco.languages.setLanguageConfiguration('haskell', HASKELL_CONF);
        registered.push('haskell');
    } catch (e) {
        console.warn('[Tokenizer] Failed to register Haskell tokenizer:', e.message);
    }

    console.log(`[LSP] Registered Monarch tokenizers for: ${registered.join(', ')}`);
}
