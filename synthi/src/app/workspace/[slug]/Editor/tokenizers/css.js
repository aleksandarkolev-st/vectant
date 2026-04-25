// Rich Monarch grammar for CSS — emits selector, property, value, unit, hex,
// at-rule, function and pseudo-class scopes so each gets a distinct colour.

const AT_RULES = [
    'media', 'keyframes', 'supports', 'import', 'charset', 'namespace',
    'font-face', 'page', 'document', 'container', 'layer', 'property',
    'scope', 'starting-style',
];

const VALUE_KEYWORDS = [
    'auto', 'none', 'inherit', 'initial', 'unset', 'revert', 'currentColor',
    'transparent', 'normal', 'bold', 'italic', 'underline', 'block', 'inline',
    'flex', 'grid', 'absolute', 'relative', 'fixed', 'sticky', 'static',
    'hidden', 'visible', 'scroll', 'pointer', 'default', 'center', 'left',
    'right', 'top', 'bottom', 'middle', 'baseline', 'stretch', 'space-between',
    'space-around', 'space-evenly', 'flex-start', 'flex-end', 'wrap', 'nowrap',
    'row', 'column', 'true', 'false',
];

export const CSS_LANGUAGE = {
    defaultToken: '',
    tokenPostfix: '.css',
    atRules: AT_RULES,
    valueKeywords: VALUE_KEYWORDS,

    tokenizer: {
        root: [
            { include: '@whitespace' },
            [/\/\*/, 'comment', '@blockComment'],

            // @media, @keyframes, @import …
            [/(@)([a-zA-Z-]+)/, ['keyword.directive', {
                cases: {
                    '$2@atRules': 'keyword.directive',
                    '@default': 'keyword.directive',
                },
            }]],

            // Hex colours.
            [/#[0-9a-fA-F]{3,8}\b/, 'constant.color'],

            // Pseudo-classes / pseudo-elements.
            [/::[a-zA-Z-]+/, 'constant.language.pseudo'],
            [/:(?:hover|focus|active|visited|link|first-child|last-child|nth-child|nth-of-type|not|is|where|has|root|empty|target|disabled|enabled|checked|placeholder-shown|focus-within|focus-visible)\b/, 'constant.language.pseudo'],

            // Selectors: id, class, attribute.
            [/#[a-zA-Z_][\w-]*/, 'tag.id'],
            [/\.[a-zA-Z_][\w-]*/, 'tag.class'],
            [/\[[^\]]+\]/, 'attribute.name'],

            // Property: `name:` (lookahead).
            [/[a-zA-Z-][\w-]*(?=\s*:)/, 'attribute.name'],

            // Url(...) and var(--name).
            [/\b(url|var|calc|attr|env|min|max|clamp|linear-gradient|radial-gradient|conic-gradient|rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\b(?=\s*\()/, 'function.call'],

            // Custom properties.
            [/--[a-zA-Z_][\w-]*/, 'variable'],

            // Numbers + units.
            [/-?\d*\.\d+(?:[eE][-+]?\d+)?(?:px|em|rem|vh|vw|vmin|vmax|%|deg|rad|turn|s|ms|fr|ch|ex|pt|pc|cm|mm|in)?/, 'number'],
            [/-?\d+(?:px|em|rem|vh|vw|vmin|vmax|%|deg|rad|turn|s|ms|fr|ch|ex|pt|pc|cm|mm|in)?/, 'number'],

            // Strings.
            [/"/, 'string', '@dString'],
            [/'/, 'string', '@sString'],

            // Important.
            [/!important\b/, 'keyword.flow'],

            // Tag selectors / value keywords.
            [/[a-zA-Z_][\w-]*/, {
                cases: {
                    '@valueKeywords': 'constant.language',
                    '@default': 'tag',
                },
            }],

            [/[{}()[\]]/, '@brackets'],
            [/[;,>+~]/, 'delimiter'],
            [/[*]/, 'tag'],
            [/[:]/, 'delimiter'],
        ],

        whitespace: [[/[ \t\r\n]+/, '']],

        blockComment: [
            [/[^/*]+/, 'comment'],
            [/\*\//, 'comment', '@pop'],
            [/[/*]/, 'comment'],
        ],

        dString: [
            [/[^\\"]+/, 'string'],
            [/\\./, 'string.escape'],
            [/"/, 'string', '@pop'],
        ],

        sString: [
            [/[^\\']+/, 'string'],
            [/\\./, 'string.escape'],
            [/'/, 'string', '@pop'],
        ],
    },
};

export const CSS_CONF = {
    comments: { blockComment: ['/*', '*/'] },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '(', close: ')' },
        { open: '"', close: '"', notIn: ['string'] },
        { open: "'", close: "'", notIn: ['string', 'comment'] },
    ],
};
