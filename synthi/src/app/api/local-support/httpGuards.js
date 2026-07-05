export const MAX_LOCAL_SUPPORT_CONTROL_BODY_BYTES = 64 * 1024;

export async function readBoundedJson(req, maxBytes = MAX_LOCAL_SUPPORT_CONTROL_BODY_BYTES) {
  const contentLength = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { ok: false, status: 413, reason: "body_too_large" };
  }

  const text = await req.text();
  if (new TextEncoder().encode(text).length > maxBytes) {
    return { ok: false, status: 413, reason: "body_too_large" };
  }

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: true, value: null };
  }
}

export function isSameOriginRequest(req) {
  const origin = req.headers.get("origin");
  if (!origin) return true;
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
