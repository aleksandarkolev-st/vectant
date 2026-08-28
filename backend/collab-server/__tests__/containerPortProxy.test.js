'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const { parseWsPortUrl, createContainerPortProxy, buildProxyResponseHeaders } = require('../containerPortProxy');

test('parseWsPortUrl extracts slug, port, downstream', () => {
  assert.deepEqual(parseWsPortUrl('/wsport/my-repo/3000/foo/bar'),
    { slug: 'my-repo', port: 3000, downstream: '/foo/bar' });
  assert.deepEqual(parseWsPortUrl('/wsport/my-repo/3000'),
    { slug: 'my-repo', port: 3000, downstream: '/' });
});

test('parseWsPortUrl rejects non-matching / unsafe paths', () => {
  assert.equal(parseWsPortUrl('/port/3000/'), null);
  assert.equal(parseWsPortUrl('/wsport/../3000/'), null);
  assert.equal(parseWsPortUrl('/wsport/repo/notaport/'), null);
});

test('buildProxyResponseHeaders strips X-Frame-Options and sets embed headers', () => {
  const out = buildProxyResponseHeaders({ 'x-frame-options': 'DENY', 'content-type': 'text/html' });
  assert.equal(out['x-frame-options'], undefined);          // stripped so the App tab can iframe it
  assert.equal(out['content-type'], 'text/html');           // unrelated headers preserved
  assert.equal(out['cross-origin-embedder-policy'], 'credentialless');
  assert.equal(out['cross-origin-resource-policy'], 'cross-origin');
  assert.equal(out['access-control-allow-origin'], '*');
});

test('proxyHttp forwards to the resolved runtime host', async () => {
  const upstream = http.createServer((req, res) => { res.writeHead(200); res.end('OK:' + req.url); });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const { port } = upstream.address();
  const proxy = createContainerPortProxy({ resolveHost: () => '127.0.0.1' });

  const front = http.createServer((req, res) => proxy.proxyHttp(req, res));
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const fp = front.address().port;

  const res = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${fp}/wsport/repo/${port}/hello`, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => resolve({ body: d, headers: r.headers }));
    }).on('error', reject);
  });
  assert.equal(res.body, 'OK:/hello');
  // App-tab iframe embeds this under the IDE's COEP — must assert an embedder
  // policy + be resource-shareable or Chrome blocks the frame.
  assert.equal(res.headers['cross-origin-embedder-policy'], 'credentialless');
  assert.equal(res.headers['cross-origin-resource-policy'], 'cross-origin');
  upstream.close(); front.close();
});

// ── Stream auto-login: proxy injects Authorization: Basic (Task 1) ──

function httpGetBody(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

test('proxyHttp injects Basic auth when a credential is resolved and absent', async () => {
  const upstream = http.createServer((req, res) => { res.writeHead(200); res.end('AUTH:' + (req.headers.authorization || 'none')); });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const { port } = upstream.address();
  const proxy = createContainerPortProxy({
    resolveHost: () => '127.0.0.1',
    resolveStreamAuth: () => ({ user: 'vectant', password: 'secret123' }),
  });
  const front = http.createServer((req, res) => proxy.proxyHttp(req, res));
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const fp = front.address().port;

  const body = await httpGetBody(`http://127.0.0.1:${fp}/wsport/repo/${port}/x`);
  const expected = 'Basic ' + Buffer.from('vectant:secret123').toString('base64');
  assert.equal(body, 'AUTH:' + expected);
  upstream.close(); front.close();
});

test('proxyHttp injects nothing when the resolver returns null', async () => {
  const upstream = http.createServer((req, res) => { res.writeHead(200); res.end('AUTH:' + (req.headers.authorization || 'none')); });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const { port } = upstream.address();
  const proxy = createContainerPortProxy({ resolveHost: () => '127.0.0.1', resolveStreamAuth: () => null });
  const front = http.createServer((req, res) => proxy.proxyHttp(req, res));
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const fp = front.address().port;

  const body = await httpGetBody(`http://127.0.0.1:${fp}/wsport/repo/${port}/x`);
  assert.equal(body, 'AUTH:none');
  upstream.close(); front.close();
});

test('proxyHttp does not override an Authorization header already on the request', async () => {
  const upstream = http.createServer((req, res) => { res.writeHead(200); res.end('AUTH:' + (req.headers.authorization || 'none')); });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const { port } = upstream.address();
  const proxy = createContainerPortProxy({
    resolveHost: () => '127.0.0.1',
    resolveStreamAuth: () => ({ user: 'vectant', password: 'secret123' }),
  });
  const front = http.createServer((req, res) => proxy.proxyHttp(req, res));
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const fp = front.address().port;

  const body = await httpGetBody(`http://127.0.0.1:${fp}/wsport/repo/${port}/x`, { Authorization: 'Basic preset' });
  assert.equal(body, 'AUTH:Basic preset');
  upstream.close(); front.close();
});

test('proxyWsUpgrade injects an Authorization header line when a credential is resolved and absent', async () => {
  let received = '';
  const upstream = net.createServer((sock) => { sock.on('data', (d) => { received += d.toString('utf8'); }); });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const { port } = upstream.address();
  const proxy = createContainerPortProxy({
    resolveHost: () => '127.0.0.1',
    resolveStreamAuth: () => ({ user: 'vectant', password: 'pw' }),
  });
  const front = http.createServer();
  front.on('upgrade', (req, socket, head) => proxy.proxyWsUpgrade(req, socket, head));
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const fp = front.address().port;

  const client = net.connect(fp, '127.0.0.1', () => {
    client.write(`GET /wsport/repo/${port}/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
  });
  await waitUntil(() => received.includes('\r\n\r\n'));
  const expected = 'Authorization: Basic ' + Buffer.from('vectant:pw').toString('base64');
  assert.ok(received.includes(expected), `expected injected header, got:\n${received}`);
  client.destroy(); upstream.close(); front.close();
});

test('proxyWsUpgrade does not override an Authorization header already on the upgrade request', async () => {
  let received = '';
  const upstream = net.createServer((sock) => { sock.on('data', (d) => { received += d.toString('utf8'); }); });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const { port } = upstream.address();
  const proxy = createContainerPortProxy({
    resolveHost: () => '127.0.0.1',
    resolveStreamAuth: () => ({ user: 'vectant', password: 'pw' }),
  });
  const front = http.createServer();
  front.on('upgrade', (req, socket, head) => proxy.proxyWsUpgrade(req, socket, head));
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const fp = front.address().port;

  const client = net.connect(fp, '127.0.0.1', () => {
    client.write(`GET /wsport/repo/${port}/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nAuthorization: Basic preset\r\n\r\n`);
  });
  await waitUntil(() => received.includes('\r\n\r\n'));
  const injected = 'Basic ' + Buffer.from('vectant:pw').toString('base64');
  assert.ok(received.includes('Basic preset'), `expected preset header forwarded, got:\n${received}`);
  assert.ok(!received.includes(injected), `must not inject over an existing header, got:\n${received}`);
  client.destroy(); upstream.close(); front.close();
});
