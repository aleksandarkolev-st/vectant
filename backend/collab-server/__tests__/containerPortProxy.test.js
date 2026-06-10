'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { parseWsPortUrl, createContainerPortProxy } = require('../containerPortProxy');

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

test('proxyHttp forwards to the resolved runtime host', async () => {
  const upstream = http.createServer((req, res) => { res.writeHead(200); res.end('OK:' + req.url); });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const { port } = upstream.address();
  const proxy = createContainerPortProxy({ resolveHost: () => '127.0.0.1' });

  const front = http.createServer((req, res) => proxy.proxyHttp(req, res));
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const fp = front.address().port;

  const body = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${fp}/wsport/repo/${port}/hello`, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(d));
    }).on('error', reject);
  });
  assert.equal(body, 'OK:/hello');
  upstream.close(); front.close();
});
