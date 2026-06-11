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

// A baseline /proc/net/tcp with ONLY infra ports present at container startup —
// rootless dockerd (2376 = 0x0948) + an ephemeral containerd port (36395 = 0x8E2B),
// both on 0.0.0.0. The monitor must treat these as baseline and never report them.
const PROC_BASELINE = [
  '  sl  local_address rem_address   st',
  '   0: 00000000:0948 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000',  // 0.0.0.0:2376
  '   1: 00000000:8E2B 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000',  // 0.0.0.0:36395
].join('\n');

test('monitor subtracts the startup baseline (infra ports) and emits only user ports', async () => {
  const events = [];
  let stdout = PROC_BASELINE; // round 1: only infra ports
  const monitor = createContainerPortMonitor({
    listContainers: () => [{ slug: 'repo', userId: 'u1' }],
    runOnce: async () => stdout,
    onPortsChanged: (slug, userId, ports) => events.push([slug, userId, ports]),
    intervalMs: 0,
  });

  await monitor._scanOnce();                          // baseline established → no event
  await monitor._scanOnce();                          // unchanged → no event
  stdout = PROC_BASELINE + '\n' + PROC_TCP;           // user opens 3000 (PROC_TCP also has loopback 8080, excluded)
  await monitor._scanOnce();                          // change → [3000]
  stdout = PROC_BASELINE + '\n' + PROC_TCP + '\n' + PROC_TCP6; // add 5001
  await monitor._scanOnce();                          // change → [3000, 5001]
  stdout = PROC_BASELINE;                             // user servers gone (back to baseline)
  await monitor._scanOnce();                          // change → []

  assert.deepEqual(events, [
    ['repo', 'u1', [3000]],
    ['repo', 'u1', [3000, 5001]],
    ['repo', 'u1', []],
  ]);
});

test('monitor clears ports for a container that disappeared', async () => {
  const events = [];
  let containers = [{ slug: 'repo', userId: 'u1' }];
  let stdout = PROC_BASELINE;                          // round 1: baseline only
  const monitor = createContainerPortMonitor({
    listContainers: () => containers,
    runOnce: async () => stdout,
    onPortsChanged: (slug, userId, ports) => events.push([slug, userId, ports]),
    intervalMs: 0,
  });
  await monitor._scanOnce();                           // baseline → no event
  stdout = PROC_BASELINE + '\n' + PROC_TCP;            // user opens 3000
  await monitor._scanOnce();                           // → [3000]
  containers = [];                                     // container culled
  await monitor._scanOnce();                           // emits [] once
  assert.deepEqual(events, [['repo', 'u1', [3000]], ['repo', 'u1', []]]);
});
