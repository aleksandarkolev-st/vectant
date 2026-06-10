export function parseBooleanFlag(value) {
  if (value === undefined || value === null || value === false) return false;
  if (value === true) return true;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return false;
  return !["0", "false", "no", "off"].includes(normalized);
}

export function runtimeEndpointConformance({ cdpUrl, requireNonLoopbackRuntime = false }) {
  const requireNonLoopback = Boolean(requireNonLoopbackRuntime);
  const host = extractUrlHost(cdpUrl);
  const hostClass = classifyRuntimeHost(host);
  return {
    ok: !requireNonLoopback || (Boolean(host) && hostClass === "remote"),
    require_non_loopback_runtime: requireNonLoopback,
    non_loopback_runtime: Boolean(host) && hostClass === "remote",
    runtime_host_class: hostClass,
  };
}

export function assertRuntimeEndpointConformance({ cdpUrl, requireNonLoopbackRuntime }) {
  const conformance = runtimeEndpointConformance({ cdpUrl, requireNonLoopbackRuntime });
  if (!conformance.ok) {
    throw new Error("non_loopback_runtime_required: pass a non-loopback SYNTHI_HOSTED_BROWSER_CDP_URL before using this harness as a production hosted-runtime conformance gate");
  }
  return conformance;
}

function extractUrlHost(value) {
  try {
    return new URL(String(value)).hostname;
  } catch {
    return null;
  }
}

function classifyRuntimeHost(host) {
  if (!host) return "invalid";
  if (isLoopbackHost(host)) return "loopback";
  if (isLocalBindHost(host)) return "local-bind";
  return "remote";
}

function isLoopbackHost(host) {
  const normalized = String(host).toLowerCase();
  return normalized === "localhost"
    || normalized.startsWith("127.")
    || normalized === "::1"
    || normalized === "[::1]";
}

function isLocalBindHost(host) {
  const normalized = String(host).toLowerCase();
  return normalized === "0.0.0.0"
    || normalized === "::"
    || normalized === "[::]";
}
