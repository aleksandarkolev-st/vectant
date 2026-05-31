import dns from 'node:dns/promises';

/** Error with a stable `code` so callers can map to a normalized envelope. */
function ssrfError(message) {
  const e = new Error(message);
  e.code = 'ssrf_blocked';
  return e;
}

/** Parse an IPv4 dotted string to a 32-bit int, or null if not IPv4. */
function ipv4ToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function inV4Cidr(ipInt, base, maskBits) {
  const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
  return (ipInt & mask) === (ipv4ToInt(base) & mask);
}

/** True if a 32-bit IPv4 int falls in any blocked range. */
function isBlockedV4(ipInt) {
  return (
    inV4Cidr(ipInt, '0.0.0.0', 8) ||
    inV4Cidr(ipInt, '10.0.0.0', 8) ||
    inV4Cidr(ipInt, '100.64.0.0', 10) ||
    inV4Cidr(ipInt, '127.0.0.0', 8) ||
    inV4Cidr(ipInt, '169.254.0.0', 16) ||
    inV4Cidr(ipInt, '172.16.0.0', 12) ||
    inV4Cidr(ipInt, '192.168.0.0', 16)
  );
}

/** True if an IP literal (v4 or v6) is in a blocked range. Tolerates [bracketed] IPv6. */
export function isBlockedIp(ip) {
  let lower = String(ip).toLowerCase();
  // A URL's .hostname keeps the brackets on IPv6 literals ("[::1]"); strip them.
  if (lower.startsWith('[') && lower.endsWith(']')) lower = lower.slice(1, -1);

  const v4 = ipv4ToInt(lower);
  if (v4 !== null) return isBlockedV4(v4);

  if (lower === '::1' || lower === '::') return true;
  // IPv4-mapped IPv6, dotted form (::ffff:a.b.c.d).
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isBlockedIp(mapped[1]);
  // IPv4-mapped IPv6, hex-group form (::ffff:HHHH:HHHH) — the WHATWG URL parser
  // normalizes "::ffff:127.0.0.1" to this form, so it must be decoded too.
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hexMapped) {
    const v4int = ((parseInt(hexMapped[1], 16) << 16) >>> 0) + parseInt(hexMapped[2], 16);
    return isBlockedV4(v4int);
  }
  // Unique-local fc00::/7 and link-local fe80::/10.
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
  return false;
}

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal']);

/**
 * Throw an `ssrf_blocked` error if `urlString` is unsafe to fetch server-side.
 * - Requires https unless the hostname is on `allowlist`.
 * - Blocks loopback/private/link-local/metadata, by literal IP or DNS resolution.
 * @param {string} urlString
 * @param {{ allowlist?: string[], lookup?: (host:string)=>Promise<string[]> }} [opts]
 *        `lookup` is injectable for tests; defaults to DNS A/AAAA resolution.
 */
export async function assertSafeUrl(urlString, opts = {}) {
  const { allowlist = [], lookup } = opts;
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw ssrfError('invalid URL');
  }
  // Normalize a trailing dot (FQDN form) so "localhost." can't dodge the blocklist.
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const onAllowlist = allowlist.some((h) => h.toLowerCase() === host);

  if (url.protocol !== 'https:' && !onAllowlist) {
    throw ssrfError('non-https URL not on allowlist');
  }
  if (onAllowlist) return;

  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost')) {
    throw ssrfError(`blocked hostname: ${host}`);
  }
  // If the host is an IP literal, check it directly.
  if (ipv4ToInt(host) !== null || host.includes(':')) {
    if (isBlockedIp(host)) throw ssrfError(`blocked IP: ${host}`);
    return;
  }
  // Otherwise resolve and check every returned address.
  const resolver =
    lookup ||
    (async (h) => {
      const recs = await dns.lookup(h, { all: true });
      return recs.map((r) => r.address);
    });
  let addrs;
  try {
    addrs = await resolver(host);
  } catch {
    throw ssrfError(`DNS resolution failed for ${host}`);
  }
  if (!addrs || addrs.length === 0) throw ssrfError(`no addresses for ${host}`);
  for (const addr of addrs) {
    if (isBlockedIp(addr)) throw ssrfError(`${host} resolves to blocked IP ${addr}`);
  }
}
