/**
 * Build the app Content-Security-Policy. `frame-src` must include the
 * collab-server origin so the program App tab can embed the proxied port
 * (`<collab>/port/<N>/`); without it the cross-origin iframe is blocked.
 * @param {string} collabUrl - e.g. NEXT_PUBLIC_COLLAB_SERVER_URL
 * @returns {string} CSP header value
 */
export function buildContentSecurityPolicy(collabUrl) {
  let collabOrigin = null;
  try {
    if (collabUrl) collabOrigin = new URL(collabUrl).origin;
  } catch {
    /* invalid url → no collab origin */
  }
  const frameSrc = ["'self'", 'blob:', collabOrigin].filter(Boolean).join(' ');
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' http: https: ws: wss: blob:",
    "worker-src 'self' blob:",
    `frame-src ${frameSrc}`,
    "media-src 'self' blob: data:",
  ].join('; ');
}
