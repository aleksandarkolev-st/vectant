import DOMPurify from 'dompurify';

export const formatMessageContent = (content) => {
    if (!content) return '';

    const escapeHtml = (str = '') => str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const cleaned = content.replace(/^#{1,6}\s+/gm, '');
    const codeBlockRe = /```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/g;
    let lastIndex = 0;
    const segments = [];
    let match;

    while ((match = codeBlockRe.exec(cleaned)) !== null) {
        if (match.index > lastIndex) {
            segments.push({ type: 'text', value: cleaned.slice(lastIndex, match.index) });
        }
        segments.push({ type: 'block', value: match[1] || '' });
        lastIndex = codeBlockRe.lastIndex;
    }
    if (lastIndex < cleaned.length) {
        segments.push({ type: 'text', value: cleaned.slice(lastIndex) });
    }

    const html = segments.map((segment) => {
        if (segment.type === 'block') {
            const code = escapeHtml(segment.value.trim());
            return `<pre class="ai-code-block"><code class="ai-code-block">${code}</code></pre>`;
        }
        const escaped = escapeHtml(segment.value);
        return escaped
            .replace(/\*\*(.*?)\*\*/g, '<strong class="font-semibold">$1</strong>')
            .replace(/\*(.*?)\*/g, '<em class="italic">$1</em>')
            .replace(/`([^`]+)`/g, '<code class="bg-[#3a3a3d] px-1 rounded text-xs">$1</code>')
            .replace(/\n/g, '<br />');
    }).join('');

    try {
        return DOMPurify.sanitize(html, {
            ALLOWED_TAGS: ['strong', 'em', 'code', 'pre', 'br', 'div', 'span', 'p', 'ul', 'ol', 'li'],
            ALLOWED_ATTR: ['class']
        });
    } catch (e) {
        return html;
    }
};