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
 * @param {object} opts
 * @param {(slug:string)=>string|null} opts.resolveHost - slug -> runtime container host (or null)
 */
function createContainerPortProxy({ resolveHost } = {}) {
  if (typeof resolveHost !== 'function') throw new TypeError('resolveHost is required');

  function proxyHttp(req, res) {
    const parsed = parseWsPortUrl(req.url);
    if (!parsed) { res.writeHead(400); res.end('bad /wsport url'); return; }
    const host = resolveHost(parsed.slug);
    if (!host) { res.writeHead(502); res.end('runtime container not running'); return; }
    const proxyReq = http.request({
      hostname: host, port: parsed.port, path: parsed.downstream, method: req.method,
      headers: { ...req.headers, host: `localhost:${parsed.port}` }, timeout: 30000,
    }, (up) => {
      // The IDE document is served under COEP (credentialless), so a cross-origin
      // iframe is only embeddable if its response asserts an embedder policy and is
      // resource-shareable. credentialless keeps the embedded app's OWN subresources
      // working without requiring CORP on each of them. Without these, the App tab
      // shows Chrome's blocked-frame error page even though the body loads fine.
      const headers = {
        ...up.headers,
        'access-control-allow-origin': '*',
        'cross-origin-resource-policy': 'cross-origin',
        'cross-origin-embedder-policy': 'credentialless',
      };
      res.writeHead(up.statusCode, headers);
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
      const headers = Object.entries(req.headers)
        .filter(([k]) => k.toLowerCase() !== 'host')
        .map(([k, v]) => `${k}: ${v}`)
        .concat([`Host: localhost:${parsed.port}`]).join('\r\n');
      up.write(reqLine + headers + '\r\n\r\n');
      if (head && head.length) up.write(head);
      up.pipe(socket); socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
    return true;
  }

  return { proxyHttp, proxyWsUpgrade };
}

module.exports = { parseWsPortUrl, createContainerPortProxy };
