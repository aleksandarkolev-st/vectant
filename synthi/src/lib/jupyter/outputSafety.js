export const MIME_PREFERENCE = ['application/json', 'image/png', 'image/jpeg', 'text/markdown', 'text/plain'];
export function chooseSafeOutput(data = {}) { for (const mime of MIME_PREFERENCE) if (Object.prototype.hasOwnProperty.call(data, mime)) return { mime, value: data[mime] }; return null; }
export function safeImageUrl(mime, value) { if (!['image/png', 'image/jpeg'].includes(mime) || typeof value !== 'string') return null; if (value.length > 8 * 1024 * 1024) return null; return `data:${mime};base64,${value}`; }
export function isExternalUrl(value) { try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:'; } catch { return false; } }

