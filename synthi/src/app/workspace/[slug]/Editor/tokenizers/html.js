// Rich Monarch grammar for HTML — emits tag, attribute name, attribute
// value (quoted strings) and entity scopes so the theme can paint each in a
// distinct colour. Supports embedded <script>/<style> via state transitions.

export const HTML_LANGUAGE = {
    defaultToken: '',
    tokenPostfix: '.html',
    ignoreCase: true,

    tokenizer: {
        root: [
            // Comments.
            [/<!--/, 'comment.html', '@comment'],

            // DOCTYPE and processing instructions.
            [/<!DOCTYPE/, { token: 'metatag.html', next: '@doctype' }],
            [/<\?/, { token: 'metatag.html', next: '@processingInstruction' }],

            // CDATA.
            [/<!\[CDATA\[/, { token: 'delimiter.cdata.html', next: '@cdata' }],

            // Embedded script / style — handed off to dedicated states.
            [/(<)(script)\b/, ['delimiter.html', { token: 'tag.html', next: '@scriptTag' }]],
            [/(<)(style)\b/, ['delimiter.html', { token: 'tag.html', next: '@styleTag' }]],

            // Closing tags.
            [/(<\/)([a-zA-Z][\w-]*)(\s*)(>)/, [
                'delimiter.html', 'tag.html', '', 'delimiter.html',
            ]],

            // Opening / self-closing tags.
            [/(<)([a-zA-Z][\w-]*)/, ['delimiter.html', { token: 'tag.html', next: '@tagAttrs' }]],

            // Entities like &amp; &#x27;
            [/&[a-zA-Z]+;/, 'string.escape.html'],
            [/&#\d+;/, 'string.escape.html'],
            [/&#x[0-9a-fA-F]+;/, 'string.escape.html'],

            // Stray text content.
            [/[^<&]+/, ''],
        ],

        comment: [
            [/-->/, 'comment.html', '@pop'],
            [/[^-]+/, 'comment.html'],
            [/./, 'comment.html'],
        ],

        doctype: [
            [/[^>]+/, 'metatag.content.html'],
            [/>/, 'metatag.html', '@pop'],
        ],

        processingInstruction: [
            [/\?>/, 'metatag.html', '@pop'],
            [/./, 'metatag.content.html'],
        ],

        cdata: [
            [/]]>/, 'delimiter.cdata.html', '@pop'],
            [/[^\]]+/, ''],
            [/]/, ''],
        ],

        tagAttrs: [
            [/\s+/, ''],
            // Self-closing or closing >.
            [/\/?>/, 'delimiter.html', '@pop'],
            // Attribute with quoted value.
            [/([a-zA-Z_:][\w:.-]*)(\s*=\s*)("[^"]*")/, [
                'attribute.name.html', 'delimiter.html', 'attribute.value.html',
            ]],
            [/([a-zA-Z_:][\w:.-]*)(\s*=\s*)('[^']*')/, [
                'attribute.name.html', 'delimiter.html', 'attribute.value.html',
            ]],
            // Attribute with unquoted value.
            [/([a-zA-Z_:][\w:.-]*)(\s*=\s*)([^\s"'>]+)/, [
                'attribute.name.html', 'delimiter.html', 'attribute.value.html',
            ]],
            // Boolean / valueless attribute.
            [/[a-zA-Z_:][\w:.-]*/, 'attribute.name.html'],
        ],

        scriptTag: [
            // Continue parsing attributes inside <script ...>.
            [/\s+/, ''],
            [/([a-zA-Z_:][\w:.-]*)(\s*=\s*)("[^"]*")/, [
                'attribute.name.html', 'delimiter.html', 'attribute.value.html',
            ]],
            [/[a-zA-Z_:][\w:.-]*/, 'attribute.name.html'],
            [/>/, { token: 'delimiter.html', switchTo: '@scriptBody' }],
            [/\/>/, 'delimiter.html', '@pop'],
        ],

        scriptBody: [
            [/<\/script\s*>/, { token: 'delimiter.html', next: '@pop' }],
            [/[^<]+/, 'source.js'],
            [/</, 'source.js'],
        ],

        styleTag: [
            [/\s+/, ''],
            [/([a-zA-Z_:][\w:.-]*)(\s*=\s*)("[^"]*")/, [
                'attribute.name.html', 'delimiter.html', 'attribute.value.html',
            ]],
            [/[a-zA-Z_:][\w:.-]*/, 'attribute.name.html'],
            [/>/, { token: 'delimiter.html', switchTo: '@styleBody' }],
            [/\/>/, 'delimiter.html', '@pop'],
        ],

        styleBody: [
            [/<\/style\s*>/, { token: 'delimiter.html', next: '@pop' }],
            [/[^<]+/, 'source.css'],
            [/</, 'source.css'],
        ],
    },
};

export const HTML_CONF = {
    comments: { blockComment: ['<!--', '-->'] },
    brackets: [['<', '>'], ['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [
        { open: '<', close: '>' },
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '(', close: ')' },
        { open: '"', close: '"' },
        { open: "'", close: "'" },
    ],
    onEnterRules: [],
};
