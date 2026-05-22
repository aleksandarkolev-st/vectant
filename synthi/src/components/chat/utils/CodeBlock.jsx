'use client';

import { useEffect, useState, memo } from 'react';
import DOMPurify from 'dompurify';
import { codeToHtml } from 'shiki';
import { useTheme } from '@/components/ThemeProvider';

// Map common language aliases to Shiki language IDs
const LANGUAGE_MAP = {
    'js': 'javascript',
    'ts': 'typescript',
    'jsx': 'jsx',
    'tsx': 'tsx',
    'py': 'python',
    'rb': 'ruby',
    'rs': 'rust',
    'go': 'go',
    'cpp': 'cpp',
    'c++': 'cpp',
    'c': 'c',
    'h': 'c',
    'hpp': 'cpp',
    'cs': 'csharp',
    'java': 'java',
    'kt': 'kotlin',
    'swift': 'swift',
    'php': 'php',
    'html': 'html',
    'css': 'css',
    'scss': 'scss',
    'sass': 'sass',
    'less': 'less',
    'json': 'json',
    'yaml': 'yaml',
    'yml': 'yaml',
    'toml': 'toml',
    'xml': 'xml',
    'md': 'markdown',
    'markdown': 'markdown',
    'sql': 'sql',
    'sh': 'bash',
    'bash': 'bash',
    'zsh': 'bash',
    'shell': 'bash',
    'ps1': 'powershell',
    'powershell': 'powershell',
    'dockerfile': 'dockerfile',
    'docker': 'dockerfile',
    'prisma': 'prisma',
    'graphql': 'graphql',
    'gql': 'graphql',
    'vue': 'vue',
    'svelte': 'svelte',
};

// Fallback escaping for when Shiki can't highlight
const escapeHtml = (str) => str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const sanitizeHighlightedHtml = (html) => DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['pre', 'code', 'span'],
    ALLOWED_ATTR: ['class', 'style', 'tabindex'],
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed'],
});

const CodeBlock = memo(({ code, language = '' }) => {
    const [highlightedHtml, setHighlightedHtml] = useState(null);
    const [error, setError] = useState(false);
    const { shikiTheme } = useTheme();
    const activeTheme = shikiTheme || 'github-dark-default';

    const normalizedLang = LANGUAGE_MAP[language.toLowerCase()] || language.toLowerCase() || 'text';

    useEffect(() => {
        let cancelled = false;

        const highlight = async () => {
            try {
                const html = await codeToHtml(code, {
                    lang: normalizedLang,
                    theme: activeTheme,
                });
                if (!cancelled) {
                    setHighlightedHtml(sanitizeHighlightedHtml(html));
                    setError(false);
                }
            } catch (err) {
                // Language not supported or other error - fall back to plain text
                if (!cancelled) {
                    try {
                        const html = await codeToHtml(code, {
                            lang: 'text',
                            theme: activeTheme,
                        });
                        if (!cancelled) {
                            setHighlightedHtml(sanitizeHighlightedHtml(html));
                            setError(false);
                        }
                    } catch {
                        if (!cancelled) {
                            setError(true);
                        }
                    }
                }
            }
        };

        highlight();

        return () => {
            cancelled = true;
        };
    }, [code, normalizedLang, activeTheme]);

    // Show language label
    const langLabel = language ? (
        <span className="code-lang-label">{language}</span>
    ) : null;

    // Fallback while loading or on error
    if (error || highlightedHtml === null) {
        return (
            <div className="ai-code-wrapper">
                {langLabel}
                <pre className="ai-code-block shiki-fallback">
                    <code>{error ? escapeHtml(code) : code}</code>
                </pre>
            </div>
        );
    }

    return (
        <div className="ai-code-wrapper">
            {langLabel}
            <div 
                className="shiki-container"
                dangerouslySetInnerHTML={{ __html: highlightedHtml }} 
            />
        </div>
    );
});

CodeBlock.displayName = 'CodeBlock';

export default CodeBlock;
