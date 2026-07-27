import net from 'node:net';
import { lookup } from 'node:dns/promises';

const ALLOWED_PATHS = [/^api\/status$/, /^api\/contents(?:\/|$)/, /^api\/sessions(?:\/|$)/, /^api\/kernels(?:\/|$)/];
const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];

export function validateJupyterOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Jupyter server URL is invalid'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('Jupyter server URL must not contain credentials, a query, or fragment');
  const localhost = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  const dockerHost = url.hostname === 'host.docker.internal' && process.env.JUPYTER_ALLOW_DOCKER_HOST === '1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (localhost || dockerHost))) throw new Error('Jupyter server must use HTTPS, except approved local development servers');
  if (url.hostname.endsWith('.local') || net.isIP(url.hostname) === 4 && !PRIVATE_V4.some((pattern) => pattern.test(url.hostname)) && !url.hostname.startsWith('127.')) throw new Error('Unapproved network origin');
  return url.origin;
}

function isPrivateAddress(address) {
  if (address === '::1' || address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80:')) return true;
  return PRIVATE_V4.some((pattern) => pattern.test(address));
}

/** Resolve at registration time. Every DNS answer must remain private to avoid rebinding. */
export async function resolveApprovedJupyterOrigin(value) {
  const origin = validateJupyterOrigin(value); const hostname = new URL(origin).hostname;
  const explicitlyApproved = new Set(String(process.env.JUPYTER_ALLOWED_ORIGINS || '').split(',').map((entry) => entry.trim()).filter(Boolean));
  if (explicitlyApproved.has(origin)) return origin;
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || (hostname === 'host.docker.internal' && process.env.JUPYTER_ALLOW_DOCKER_HOST === '1')) return origin;
  const addresses = await lookup(hostname, { all: true, verbatim: true }).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => !isPrivateAddress(address))) throw new Error('Jupyter hostname must resolve only to approved private addresses');
  return origin;
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
