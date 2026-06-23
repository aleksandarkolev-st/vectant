'use strict';
const http = require('http');
const net = require('net');

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** Parse `/wsport/<slug>/<port>/rest`. Returns null on any unsafe/non-match. */
function parseWsPortUrl(urlString) {
  const m = /^\/wsport\/([^/]+)\/(\d+)(\/.*)?$/.exec(urlString || '');
  if (!m) return null;
  const slug = decodeURIComponent(m[1]);
  if (slug.includes('..') || !SLUG_RE.test(slug)) return null;
  const port = parseInt(m[2], 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { slug, port, downstream: m[3] || '/' };
}

/**
 * Response headers for a proxied /wsport response. The IDE document is served
 * under COEP (credentialless), so a cross-origin iframe is only embeddable if its
 * response asserts an embedder policy and is resource-shareable. credentialless
 * keeps the embedded app's OWN subresources working without requiring CORP on each.
 * Strip X-Frame-Options so web UIs (Portainer, pgAdmin, …) can render in the App
 * tab — the /wsport proxy is already the workspace-access boundary.
 */
function buildProxyResponseHeaders(upstreamHeaders = {}) {
  const headers = { ...upstreamHeaders };
  delete headers['x-frame-options'];
  return {
    ...headers,
    'access-control-allow-origin': '*',
    'cross-origin-resource-policy': 'cross-origin',
    'cross-origin-embedder-policy': 'credentialless',
  };
}

/** Build an `Authorization: Basic …` value from a {user,password} cred, or null. */
function basicAuthHeaderValue(cred) {
  if (!cred || !cred.user || !cred.password) return null;
  return `Basic ${Buffer.from(`${cred.user}:${cred.password}`).toString('base64')}`;
}

/**
 * @param {object} opts
 * @param {(slug:string)=>string|null} opts.resolveHost - slug -> runtime container host (or null)
 * @param {(slug:string,port:number)=>({user:string,password:string}|null)} [opts.resolveStreamAuth]
 *   slug+port -> per-session KasmVNC credential (or null). Defaults to a null
 *   resolver so callers that don't opt in (and the dark-merge path) are unaffected.
 */
function createContainerPortProxy({ resolveHost, resolveStreamAuth = () => null } = {}) {
  if (typeof resolveHost !== 'function') throw new TypeError('resolveHost is required');

  function proxyHttp(req, res) {
    const parsed = parseWsPortUrl(req.url);
    if (!parsed) { res.writeHead(400); res.end('bad /wsport url'); return; }
    const host = resolveHost(parsed.slug);
    if (!host) { res.writeHead(502); res.end('runtime container not running'); return; }
    const headers = { ...req.headers, host: `localhost:${parsed.port}` };
    // Stream auto-login: inject the per-session KasmVNC Basic credential the
    // browser can't supply (cross-origin COEP iframe suppresses the dialog).
    // Only fill an ABSENT Authorization — never clobber a real incoming one.
    if (!req.headers.authorization) {
      const auth = basicAuthHeaderValue(resolveStreamAuth(parsed.slug, parsed.port));
      if (auth) headers.authorization = auth;
    }
    const proxyReq = http.request({
      hostname: host, port: parsed.port, path: parsed.downstream, method: req.method,
      headers, timeout: 30000,
    }, (up) => {
      res.writeHead(up.statusCode, buildProxyResponseHeaders(up.headers));
      up.pipe(res, { end: true });
    });
    proxyReq.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('upstream unreachable'); } });
    proxyReq.on('timeout', () => { proxyReq.destroy(); if (!res.headersSent) { res.writeHead(504); res.end('gateway timeout'); } });
    req.pipe(proxyReq, { end: true });
  }

  function proxyWsUpgrade(req, socket, head) {
    const parsed = parseWsPortUrl(req.url);
    if (!parsed) { socket.destroy(); return false; }
    const host = resolveHost(parsed.slug);
    if (!host) { socket.destroy(); return false; }
    const up = net.connect(parsed.port, host, () => {
      const reqLine = `${req.method} ${parsed.downstream} HTTP/1.1\r\n`;
      const headerLines = Object.entries(req.headers)
        .filter(([k]) => k.toLowerCase() !== 'host')
        .map(([k, v]) => `${k}: ${v}`)
        .concat([`Host: localhost:${parsed.port}`]);
      // Same auto-login injection as proxyHttp, for the noVNC /websockify upgrade.
      if (!req.headers.authorization) {
        const auth = basicAuthHeaderValue(resolveStreamAuth(parsed.slug, parsed.port));
        if (auth) headerLines.push(`Authorization: ${auth}`);
      }
      up.write(reqLine + headerLines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) up.write(head);
      up.pipe(socket); socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
    return true;
  }

  return { proxyHttp, proxyWsUpgrade };
}

module.exports = { parseWsPortUrl, createContainerPortProxy, buildProxyResponseHeaders, basicAuthHeaderValue };
