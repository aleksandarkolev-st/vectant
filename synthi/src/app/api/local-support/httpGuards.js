export const MAX_LOCAL_SUPPORT_CONTROL_BODY_BYTES = 64 * 1024;

export async function readBoundedJson(req, maxBytes = MAX_LOCAL_SUPPORT_CONTROL_BODY_BYTES) {
  const contentType = req.headers.get("content-type") || "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return { ok: false, status: 415, reason: "unsupported_content_type", message: "Request content type must be application/json." };
  }

  const contentLengthHeader = req.headers.get("content-length");
  if (contentLengthHeader) {
    if (contentLengthHeader.includes(",")) {
      return { ok: false, status: 400, reason: "ambiguous_content_length", message: "Request content length was ambiguous." };
    }
    if (!/^\d+$/.test(contentLengthHeader.trim())) {
      return { ok: false, status: 400, reason: "invalid_content_length", message: "Request content length was invalid." };
    }
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength)) {
      return { ok: false, status: 400, reason: "invalid_content_length", message: "Request content length was invalid." };
    }
    if (contentLength > maxBytes) {
      return { ok: false, status: 413, reason: "body_too_large", message: "Request body was too large." };
    }
  }

  const text = await req.text();
  if (new TextEncoder().encode(text).length > maxBytes) {
    return { ok: false, status: 413, reason: "body_too_large", message: "Request body was too large." };
  }

  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, status: 400, reason: "invalid_json_body", message: "Request body must be a JSON object." };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, status: 400, reason: "malformed_json", message: "Request body was not valid JSON." };
  }
}

export function isSameOriginRequest(req) {
  const fetchSite = req.headers.get("sec-fetch-site");
  if (!fetchSite || fetchSite === "cross-site" || fetchSite === "none") return false;
  if (!["same-origin", "same-site"].includes(fetchSite)) return false;

  const origin = normalizedHttpOrigin(req.headers.get("origin"));
  if (!origin) return false;

  let requestUrl;
  try {
    requestUrl = new URL(req.url);
  } catch {
    return false;
  }

  const forwardedProtocol = firstForwardedValue(req.headers.get("x-forwarded-proto"));
  const protocol = forwardedProtocol === "http" || forwardedProtocol === "https"
    ? `${forwardedProtocol}:`
    : requestUrl.protocol;
  const acceptedOrigins = new Set([requestUrl.origin]);

  for (const authorityHeader of ["host", "x-forwarded-host"]) {
    const authority = firstForwardedValue(req.headers.get(authorityHeader));
    const authorityOrigin = originFromAuthority(protocol, authority);
    if (authorityOrigin) acceptedOrigins.add(authorityOrigin);
  }

  return acceptedOrigins.has(origin);
}

function normalizedHttpOrigin(value) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function firstForwardedValue(value) {
  if (!value) return null;
  const first = value.split(",", 1)[0].trim();
  return first || null;
}

function originFromAuthority(protocol, authority) {
  if (!authority || !["http:", "https:"].includes(protocol)) return null;
  if (/[\\/@\s]/.test(authority)) return null;
  try {
    return new URL(`${protocol}//${authority}`).origin;
  } catch {
    return null;
  }
}

export function deniedJson(reason, userVisibleMessage, status = 403) {
  return {
    body: {
      decision: "denied",
      reason,
      bytes_sent: 0,
      user_visible_message: userVisibleMessage,
    },
    status,
  };
}
