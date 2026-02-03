'use client';

import { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { parseMessageSegments } from './formatMessage';
import CodeBlock from './CodeBlock';

/**
 * MessageContent - Renders AI message content with syntax-highlighted code blocks.
 * Uses Shiki for code highlighting through the CodeBlock component.
 */
const MessageContent = ({ content, enableNavigation = true, onClick }) => {
    const segments = useMemo(() => {
        return parseMessageSegments(content, { enableNavigation });
    }, [content, enableNavigation]);

    if (!segments.length) return null;

    return (
        <div className="message-content" onClick={onClick}>
            {segments.map((segment) => {
                if (segment.type === 'code') {
                    return (
                        <CodeBlock 
                            key={segment.key} 
                            code={segment.code} 
                            language={segment.lang} 
                        />
                    );
                }
                
                // Text segment - render sanitized HTML
                const sanitizedHtml = DOMPurify.sanitize(segment.html, {
                    ALLOWED_TAGS: ['strong', 'em', 'code', 'br', 'span'],
                    ALLOWED_ATTR: ['class', 'data-nav-type', 'data-nav-target']
                });
                
                return (
                    <span 
                        key={segment.key}
                        dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
                    />
                );
            })}
        </div>
    );
};

export default MessageContent;
