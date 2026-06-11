'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseListeningPorts, createContainerPortMonitor } = require('../containerPortMonitor');

const PROC_TCP = [
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid',
  '   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000',  // 0.0.0.0:3000 LISTEN
  '   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000',  // 127.0.0.1:8080 LISTEN (loopback)
  '   2: 00000000:1538 0A0B0C0D:D903 01 00000000:00000000 00:00000000 00000000  1000',  // ESTABLISHED (not LISTEN)
].join('\n');

const PROC_TCP6 = [
  '  sl  local_address                         remote_address                        st',
  '   0: 00000000000000000000000000000000:1389 00000000000000000000000000000000:0000 0A',  // [::]:5001 LISTEN
].join('\n');

test('parseListeningPorts extracts non-loopback LISTEN ports from tcp + tcp6', () => {
  const ports = parseListeningPorts(PROC_TCP + '\n' + PROC_TCP6);
  // 3000 (0.0.0.0) + 5001 (::) ; excludes 8080 (loopback) and the ESTABLISHED row.
  assert.deepEqual(ports, [3000, 5001]);
});

test('parseListeningPorts is empty/safe on garbage', () => {
  assert.deepEqual(parseListeningPorts(''), []);
  assert.deepEqual(parseListeningPorts('not a table\nfoo bar'), []);
});

test('monitor emits only on change (add then remove), per workspace', async () => {
  const events = [];
  let stdout = PROC_TCP; // round 1: port 3000 only
  const monitor = createContainerPortMonitor({
    listContainers: () => [{ slug: 'repo', userId: 'u1' }],
    runOnce: async () => stdout,
    onPortsChanged: (slug, userId, ports) => events.push([slug, userId, ports]),
    intervalMs: 0,
  });

  await monitor._scanOnce();                       // 3000 appears
  await monitor._scanOnce();                       // unchanged → no event
  stdout = PROC_TCP + '\n' + PROC_TCP6;            // add 5001
  await monitor._scanOnce();                       // change → event
  stdout = '';                                     // all gone
  await monitor._scanOnce();                       // change → event (empty)

  assert.deepEqual(events, [
    ['repo', 'u1', [3000]],
    ['repo', 'u1', [3000, 5001]],
    ['repo', 'u1', []],
  ]);
});

test('monitor clears ports for a container that disappeared', async () => {
  const events = [];
  let containers = [{ slug: 'repo', userId: 'u1' }];
  const monitor = createContainerPortMonitor({
    listContainers: () => containers,
    runOnce: async () => PROC_TCP,                 // 3000
    onPortsChanged: (slug, userId, ports) => events.push([slug, userId, ports]),
    intervalMs: 0,
  });
  await monitor._scanOnce();                       // [3000]
  containers = [];                                 // container culled
  await monitor._scanOnce();                       // emits [] once
  assert.deepEqual(events, [['repo', 'u1', [3000]], ['repo', 'u1', []]]);
});
