import net from 'node:net';

const ALLOWED_PATHS = [/^api\/contents(?:\/|$)/, /^api\/sessions(?:\/|$)/, /^api\/kernels(?:\/|$)/];
const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];

export function validateJupyterOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Jupyter server URL is invalid'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('Jupyter server URL must not contain credentials, a query, or fragment');
  const localhost = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localhost)) throw new Error('Jupyter server must use HTTPS, except loopback development servers');
  if (url.hostname.endsWith('.local') || net.isIP(url.hostname) === 4 && !PRIVATE_V4.some((pattern) => pattern.test(url.hostname)) && !url.hostname.startsWith('127.')) throw new Error('Unapproved network origin');
  return url.origin;
}

export function safeJupyterPath(path = '') {
  const decoded = decodeURIComponent(String(path));
  if (decoded.includes('..') || decoded.includes('\\') || decoded.startsWith('/')) throw new Error('Invalid notebook path');
  return decoded.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

export function allowedJupyterEndpoint(pathname) {
  const path = pathname.replace(/^\//, '');
  return ALLOWED_PATHS.some((pattern) => pattern.test(path));
}

