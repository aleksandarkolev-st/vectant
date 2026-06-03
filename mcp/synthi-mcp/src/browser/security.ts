import type { BrowserOrigin } from "./types.js";

const TOKEN_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|passwd|secret)=([^&\s]+)/gi,
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
];

const SECRET_FIELD_NAMES = new Set([
  "password",
  "passwd",
  "passcode",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "api_key",
  "apikey",
  "secret",
  "authorization",
]);

export function normalizeOrigin(rawUrl: string): BrowserOrigin {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("invalid_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("unsupported_origin_scheme");
  }
  return {
    scheme: parsed.protocol.slice(0, -1),
    host: parsed.hostname.toLowerCase(),
    port: parsed.port || defaultPort(parsed.protocol),
    origin: parsed.origin,
  };
}

export function sameExactOrigin(a: string, b: string): boolean {
  const left = normalizeOrigin(a);
  const right = normalizeOrigin(b);
  return left.scheme === right.scheme && left.host === right.host && left.port === right.port;
}

function defaultPort(protocol: string): string {
  if (protocol === "http:") return "80";
  if (protocol === "https:") return "443";
  return "";
}

export function redactText(input: string): { text: string; redacted: boolean } {
  let text = input;
  let redacted = false;
  for (const pattern of TOKEN_PATTERNS) {
    text = text.replace(pattern, (...args: unknown[]) => {
      const match = String(args[0]);
      const group = args.length > 3 && typeof args[1] === "string" ? args[1] : undefined;
      redacted = true;
      if (group !== undefined) return match.replace(group, "[REDACTED]");
      return "[REDACTED]";
    });
  }
  return { text, redacted };
}

export function redactValue(fieldName: string | undefined, value: string): { value: string; redacted: boolean } {
  const normalized = (fieldName ?? "").trim().toLowerCase();
  if (SECRET_FIELD_NAMES.has(normalized)) {
    return { value: "[REDACTED]", redacted: true };
  }
  const byPattern = redactText(value);
  return { value: byPattern.text, redacted: byPattern.redacted };
}

export function redactUrl(rawUrl: string): { url: string; redacted: boolean } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    const redacted = redactText(rawUrl);
    return { url: redacted.text, redacted: redacted.redacted };
  }
  let redacted = false;
  for (const [key, value] of parsed.searchParams.entries()) {
    const keyLower = key.toLowerCase();
    const valueRedaction = redactValue(keyLower, value);
    if (valueRedaction.redacted) {
      parsed.searchParams.set(key, "[REDACTED]");
      redacted = true;
    }
  }
  const textRedaction = redactText(parsed.toString());
  return { url: textRedaction.text, redacted: redacted || textRedaction.redacted };
}

export function bridgeTokenMatches(expected: string | undefined, supplied: unknown): boolean {
  if (!expected) return false;
  return typeof supplied === "string" && supplied.length > 0 && supplied === expected;
}
