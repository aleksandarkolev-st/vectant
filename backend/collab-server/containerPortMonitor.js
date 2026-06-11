'use strict';

/**
 * Detects TCP ports that servers open INSIDE per-workspace runtime containers
 * (e.g. `npm run dev` launched from the in-container terminal) and reports the
 * forwardable set so the frontend can surface them at /wsport/<slug>/<port>/.
 *
 * Detection reads /proc/net/tcp + /proc/net/tcp6 (always present in Linux; the
 * Alpine runtime image has no iproute2/ss). Only LISTEN sockets (st=0A) bound to
 * a non-loopback address (0.0.0.0 / ::) are forwardable — a 127.0.0.1-only bind
 * is unreachable from collab-server across the container network, so we exclude it.
 */

const LISTEN_STATE = '0A';
// Loopback local-address hex: 127.0.0.1 (v4) and ::1 (v6).
const LOOPBACK_V4 = '0100007F';
const LOOPBACK_V6 = '00000000000000000000000001000000';

/** Parse concatenated /proc/net/tcp[6] text → sorted array of forwardable LISTEN ports. */
function parseListeningPorts(text) {
  const ports = new Set();
  for (const rawLine of String(text || '').split('\n')) {
    const cols = rawLine.trim().split(/\s+/);
    // Need at least: sl local_address rem_address st
    if (cols.length < 4) continue;
    const local = cols[1];
    const state = cols[3];
    if (state !== LISTEN_STATE) continue;
    const sep = local.lastIndexOf(':');
    if (sep < 1) continue;
    const ipHex = local.slice(0, sep).toUpperCase();
    const portHex = local.slice(sep + 1);
    if (!/^[0-9A-Fa-f]+$/.test(portHex)) continue;
    // Exclude loopback-only binds (not reachable across the container network).
    if (ipHex === LOOPBACK_V4 || ipHex === LOOPBACK_V6) continue;
    const port = parseInt(portHex, 16);
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

function sameSet(a = [], b = []) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * @param {object} opts
 * @param {() => Array<{slug:string,userId:string}>} opts.listContainers - active runtime containers
 * @param {(slug:string,userId:string,argv:string[]) => Promise<string>} opts.runOnce - one-shot exec
 * @param {(slug:string,userId:string,ports:number[]) => void} opts.onPortsChanged
 * @param {number} [opts.intervalMs]
 * @param {object} [opts.logger]
 */
function createContainerPortMonitor({
  listContainers,
  runOnce,
  onPortsChanged,
  intervalMs = 3000,
  logger = console,
} = {}) {
  if (typeof listContainers !== 'function') throw new TypeError('listContainers is required');
  if (typeof runOnce !== 'function') throw new TypeError('runOnce is required');
  if (typeof onPortsChanged !== 'function') throw new TypeError('onPortsChanged is required');

  const keyOf = (slug, userId) => `${slug} ${userId}`;
  /** key -> last reported (baseline-subtracted) sorted port array */
  const lastPorts = new Map();
  /** key -> Set of infra ports present when the container was first seen */
  const baseline = new Map();
  let timer = null;

  async function _scanOnce() {
    const active = listContainers() || [];
    const activeKeys = new Set(active.map((c) => keyOf(c.slug, c.userId)));

    // Containers that went away → emit [] once (if we'd reported any), then forget
    // both the reported set and the baseline so a re-created container re-baselines.
    for (const key of [...baseline.keys()]) {
      if (!activeKeys.has(key)) {
        const [slug, userId] = key.split(' ');
        if ((lastPorts.get(key) || []).length) {
          try { onPortsChanged(slug, userId, []); } catch (_) {}
        }
        lastPorts.delete(key);
        baseline.delete(key);
      }
    }

    for (const { slug, userId } of active) {
      let raw = [];
      try {
        const out = await runOnce(slug, userId, ['/bin/sh', '-lc', 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null']);
        raw = parseListeningPorts(out);
      } catch (err) {
        // Container vanished mid-scan etc. — skip this round for this workspace.
        continue;
      }
      const key = keyOf(slug, userId);
      // First time we see this container, snapshot everything currently listening
      // as the infra baseline (rootless dockerd ~2376, ephemeral containerd port,
      // etc.) so the Ports panel only shows ports the user opens AFTER startup.
      if (!baseline.has(key)) baseline.set(key, new Set(raw));
      const base = baseline.get(key);
      const ports = raw.filter((p) => !base.has(p));
      const prev = lastPorts.get(key) || [];
      if (!sameSet(prev, ports)) {
        lastPorts.set(key, ports);
        try { onPortsChanged(slug, userId, ports); } catch (_) {}
      }
    }
  }

  function start() {
    if (timer || intervalMs <= 0) return;
    _scanOnce().catch(() => {});
    timer = setInterval(() => _scanOnce().catch((e) => logger.warn && logger.warn('container_port_scan_failed', { err: e && e.message })), intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { start, stop, _scanOnce, _lastPorts: lastPorts };
}

module.exports = { parseListeningPorts, createContainerPortMonitor };
