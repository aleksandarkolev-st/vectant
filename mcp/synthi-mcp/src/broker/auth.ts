import { createHmac, timingSafeEqual } from "node:crypto";
import { brokerError, type BrokerErrorPayload } from "./errors.js";

export type BrokerRole = "read_only" | "input_control" | "admin";

export interface BrokerPrincipal {
  subject: string;
  role: BrokerRole;
  tenant_id: string;
  session_ids: string[];
  token_id?: string;
}

export type BrokerCapability =
  | "subscribe_frames"
  | "subscribe_logs"
  | "acquire_lease"
  | "renew_own_lease"
  | "force_release_lease"
  | "dispatch_input"
  | "replay_logs"
  | "toggle_fallback";

export interface BrokerAuthConfig {
  secret?: string;
  issuer?: string;
  audience?: string;
  revokedTokenIds?: Set<string>;
}

export interface BrokerAuthOk {
  ok: true;
  principal: BrokerPrincipal;
}

export interface BrokerAuthError {
  ok: false;
  error: BrokerErrorPayload;
}

const CAPABILITY_ROLES: Record<BrokerCapability, BrokerRole[]> = {
  subscribe_frames: ["read_only", "input_control", "admin"],
  subscribe_logs: ["read_only", "input_control", "admin"],
  acquire_lease: ["input_control", "admin"],
  renew_own_lease: ["input_control", "admin"],
  force_release_lease: ["admin"],
  dispatch_input: ["input_control", "admin"],
  replay_logs: ["input_control", "admin"],
  toggle_fallback: ["admin"],
};

export function authenticateBrokerBearer(
  token: string | undefined,
  config: BrokerAuthConfig = {}
): BrokerAuthOk | BrokerAuthError {
  if (!token) return { ok: false, error: brokerError("UNAUTHORIZED", { reason: "missing_token" }) };
  if (!config.secret) {
    return { ok: false, error: brokerError("UNAUTHORIZED", { reason: "auth_secret_not_configured" }) };
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, error: brokerError("UNAUTHORIZED", { reason: "malformed_token" }) };
  }

  try {
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    const header = parseJwtSegment(headerPart) as Record<string, unknown>;
    if (header["alg"] !== "HS256") {
      return { ok: false, error: brokerError("UNAUTHORIZED", { reason: "unsupported_alg" }) };
    }

    const expected = createHmac("sha256", config.secret)
      .update(`${headerPart}.${payloadPart}`)
      .digest();
    const actual = Buffer.from(signaturePart, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return { ok: false, error: brokerError("UNAUTHORIZED", { reason: "bad_signature" }) };
    }

    const payload = parseJwtSegment(payloadPart) as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload["exp"] !== "number" || now >= payload["exp"]) {
      return { ok: false, error: brokerError("UNAUTHORIZED", { reason: "expired" }) };
    }
    if (typeof payload["nbf"] === "number" && now < payload["nbf"]) {
      return { ok: false, error: brokerError("UNAUTHORIZED", { reason: "not_before" }) };
    }
    if (config.issuer && payload["iss"] !== config.issuer) {
      return { ok: false, error: brokerError("UNAUTHORIZED", { reason: "issuer_mismatch" }) };
    }
    if (config.audience && !audienceContains(payload["aud"], config.audience)) {
      return { ok: false, error: brokerError("UNAUTHORIZED", { reason: "audience_mismatch" }) };
    }
    const role = payload["role"];
    if (role !== "read_only" && role !== "input_control" && role !== "admin") {
      return { ok: false, error: brokerError("FORBIDDEN", { reason: "invalid_role" }) };
    }
    const tokenId = typeof payload["jti"] === "string" ? payload["jti"] : undefined;
    if (tokenId && config.revokedTokenIds?.has(tokenId)) {
      return { ok: false, error: brokerError("UNAUTHORIZED", { reason: "revoked" }) };
    }
    const subject = typeof payload["sub"] === "string" && payload["sub"].length > 0
      ? payload["sub"]
      : "unknown";
    const tenantId = typeof payload["tenant_id"] === "string" && payload["tenant_id"].length > 0
      ? payload["tenant_id"]
      : "default";
    const sessionIds = normalizeSessionIds(payload["session_id"], payload["session_ids"]);
    return {
      ok: true,
      principal: {
        subject,
        role,
        tenant_id: tenantId,
        session_ids: sessionIds,
        ...(tokenId !== undefined ? { token_id: tokenId } : {}),
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: brokerError("UNAUTHORIZED", {
        reason: "token_parse_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    };
  }
}

export function authorizeBrokerCapability(
  principal: BrokerPrincipal,
  capability: BrokerCapability,
  sessionId?: string
): BrokerAuthError | null {
  if (!CAPABILITY_ROLES[capability].includes(principal.role)) {
    return { ok: false, error: brokerError("FORBIDDEN", { capability, role: principal.role }) };
  }
  if (sessionId && principal.role !== "admin" && !principal.session_ids.includes(sessionId)) {
    return {
      ok: false,
      error: brokerError("FORBIDDEN", {
        reason: "session_scope_mismatch",
        session_id: sessionId,
      }),
    };
  }
  return null;
}

export function principalKey(principal: BrokerPrincipal): string {
  return `${principal.tenant_id}:${principal.subject}:${principal.role}`;
}

function parseJwtSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

function audienceContains(value: unknown, expected: string): boolean {
  if (Array.isArray(value)) return value.includes(expected);
  return value === expected;
}

function normalizeSessionIds(sessionId: unknown, sessionIds: unknown): string[] {
  const out = new Set<string>();
  if (typeof sessionId === "string" && sessionId.length > 0) out.add(sessionId);
  if (Array.isArray(sessionIds)) {
    for (const s of sessionIds) {
      if (typeof s === "string" && s.length > 0) out.add(s);
    }
  }
  return [...out];
}
