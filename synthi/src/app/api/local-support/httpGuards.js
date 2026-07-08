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

  const origin = req.headers.get("origin");
  if (!origin) return false;
  const url = new URL(req.url);
  return origin === `${url.protocol}//${url.host}`;
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
