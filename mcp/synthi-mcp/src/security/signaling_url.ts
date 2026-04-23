/**
 * Classify a signaling URL as "local-only" or not. Local-only URLs are
 * safe to attach without the `i-understand-no-auth` flag because the
 * MCP's current security posture assumes no auth between peers; leaking
 * an attach onto a shared network is the failure mode the flag exists
 * to prevent.
 *
 * Local means one of:
 *   - hostname `localhost` (case-insensitive)
 *   - IPv4 loopback `127.0.0.0/8`
 *   - IPv6 loopback `::1` or `[::1]`
 *   - IPv4 private RFC1918: 10/8, 172.16/12, 192.168/16
 *   - IPv4 link-local: 169.254/16
 *   - Known container bridge: 172.17/16 (docker default)
 *   - Hostnames that resolve to the above (NOT validated here — callers
 *     see the literal string; network resolution is out of scope for the
 *     MCP. The flag exists to catch clear mistakes, not to be a perimeter).
 *
 * Matches `AGENT_MCP_ULTRAPLAN.md:4.11 / non-local signaling flag`.
 */

export interface SignalingUrlClassification {
  local: boolean;
  host: string;
  reason?: string;
}

export function classifySignalingUrl(rawUrl: string): SignalingUrlClassification {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { local: false, host: rawUrl, reason: "malformed_url" };
  }
  const host = parsed.hostname;
  if (!host) {
    return { local: false, host: "", reason: "missing_host" };
  }

  // Node's URL preserves the IPv6 literal's square brackets in `hostname`;
  // strip them before classification.
  const stripped = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
  const lowered = stripped.toLowerCase();
  if (lowered === "localhost") return { local: true, host };

  // IPv6 literal.
  if (lowered === "::1") return { local: true, host };

  // IPv4 dotted-quad.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(lowered);
  if (m) {
    const oct = m.slice(1, 5).map(Number) as [number, number, number, number];
    if (oct.every((o) => o >= 0 && o <= 255)) {
      if (oct[0] === 127) return { local: true, host };
      if (oct[0] === 10) return { local: true, host };
      if (oct[0] === 172 && oct[1] >= 16 && oct[1] <= 31) return { local: true, host };
      if (oct[0] === 192 && oct[1] === 168) return { local: true, host };
      if (oct[0] === 169 && oct[1] === 254) return { local: true, host };
    }
  }

  // Conservative: anything else → non-local.
  return { local: false, host, reason: "non_local_hostname" };
}
