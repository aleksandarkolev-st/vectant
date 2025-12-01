import DOMPurify from 'dompurify';

export const formatMessageContent = (content) => {
    if (!content) return '';
    const cleaned = content.replace(/^#{1,6}\s+/gm, '');

    const html = cleaned
        .replace(/\*\*(.*?)\*\*/g, '<strong class="font-semibold">$1</strong>')
        .replace(/\*(.*?)\*/g, '<em class="italic">$1</em>')
        .replace(/`([^`]+)`/g, '<code class="bg-[#3a3a3d] px-1 rounded text-xs">$1</code>')
        .replace(/\n/g, '<br />');

    try {
        return DOMPurify.sanitize(html, {
            ALLOWED_TAGS: ['strong', 'em', 'code', 'pre', 'br', 'div', 'span', 'p', 'ul', 'ol', 'li'],
            ALLOWED_ATTR: ['class']
        });
    } catch (e) {
        return html;
    }
};
