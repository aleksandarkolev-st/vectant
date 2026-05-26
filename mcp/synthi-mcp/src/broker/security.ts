import { createHash } from "node:crypto";
import type { EventLogEntry } from "../events/types.js";
import { brokerError, type BrokerErrorPayload } from "./errors.js";
import type { BrokerPrincipal, BrokerRole } from "./auth.js";

export interface BrokerRedactionOptions {
  role?: BrokerRole;
  maxDepth?: number;
}

export interface BrokerAuditEntry {
  seq: number;
  ts: number;
  action: string;
  principal?: string;
  payload: Record<string, unknown>;
  previous_hash: string;
  entry_hash: string;
}

export interface BrokerProviderPolicy {
  allow_third_party_inference: boolean;
  denied_providers: string[];
}

const REDACTED = "[REDACTED]";
const KEY_PATTERN = /(authorization|cookie|set-cookie|api[_-]?key|token|secret|password|credential|bearer)/i;
const VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\bsk-[A-Za-z0-9]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];
const THIRD_PARTY_VISION_PROVIDERS = new Set(["claude_api", "gemini_api"]);

export function redactBrokerPayload<T>(value: T, options: BrokerRedactionOptions = {}): T {
  const seen = new WeakSet<object>();
  return redactValue(value, options.maxDepth ?? 16, seen) as T;
}

export function redactBrokerEvent(event: EventLogEntry, role: BrokerRole = "read_only"): EventLogEntry {
  const redacted = redactBrokerPayload(event);
  if (role === "admin") return redacted;
  if (redacted.kind === "console") {
    return {
      ...redacted,
      message: redactString(redacted.message),
    };
  }
  if (redacted.kind === "usage" && redacted.detail) {
    return {
      ...redacted,
      detail: redactBrokerPayload(redacted.detail),
    };
  }
  return redacted;
}

export class ImmutableAuditLog {
  private readonly entries: BrokerAuditEntry[] = [];

  append(input: {
    action: string;
    principal?: string;
    payload?: Record<string, unknown>;
    ts?: number;
  }): BrokerAuditEntry {
    const previousHash = this.entries[this.entries.length - 1]?.entry_hash ?? "genesis";
    const entryWithoutHash = {
      seq: this.entries.length + 1,
      ts: input.ts ?? Date.now(),
      action: input.action,
      ...(input.principal !== undefined ? { principal: input.principal } : {}),
      payload: redactBrokerPayload(input.payload ?? {}),
      previous_hash: previousHash,
    };
    const entryHash = stableHash(entryWithoutHash);
    const entry: BrokerAuditEntry = {
      ...entryWithoutHash,
      entry_hash: entryHash,
    };
    this.entries.push(entry);
    return { ...entry, payload: { ...entry.payload } };
  }

  snapshot(): BrokerAuditEntry[] {
    return this.entries.map((entry) => ({
      ...entry,
      payload: { ...entry.payload },
    }));
  }

  verifyIntegrity(): boolean {
    let previous = "genesis";
    for (const entry of this.entries) {
      if (entry.previous_hash !== previous) return false;
      const { entry_hash: _entryHash, ...withoutHash } = entry;
      const expected = stableHash(withoutHash);
      if (expected !== entry.entry_hash) return false;
      previous = entry.entry_hash;
    }
    return true;
  }

  _resetForTests(): void {
    this.entries.length = 0;
  }
}

export const brokerAuditLog = new ImmutableAuditLog();

export function auditBrokerEvent(input: {
  action: string;
  principal?: BrokerPrincipal | string;
  payload?: Record<string, unknown>;
  ts?: number;
}): BrokerAuditEntry {
  const principal = typeof input.principal === "string"
    ? input.principal
    : input.principal
      ? `${input.principal.tenant_id}:${input.principal.subject}:${input.principal.role}`
      : undefined;
  return brokerAuditLog.append({
    action: input.action,
    ...(principal !== undefined ? { principal } : {}),
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
    ...(input.ts !== undefined ? { ts: input.ts } : {}),
  });
}

export function resolveBrokerProviderPolicy(env: NodeJS.ProcessEnv = process.env): BrokerProviderPolicy {
  return {
    allow_third_party_inference: env["SYNTHI_ALLOW_THIRD_PARTY_INFERENCE"] === "true",
    denied_providers: [...THIRD_PARTY_VISION_PROVIDERS],
  };
}

export function assertBrokerProviderAllowed(input: {
  provider: string;
  sends_screenshot: boolean;
  principal?: BrokerPrincipal | string;
  session_id?: string;
}): { ok: true } | { ok: false; error: BrokerErrorPayload } {
  const policy = resolveBrokerProviderPolicy();
  const thirdParty = THIRD_PARTY_VISION_PROVIDERS.has(input.provider);
  const allowed = !input.sends_screenshot || !thirdParty || policy.allow_third_party_inference;
  auditBrokerEvent({
    action: allowed ? "provider_route_allowed" : "provider_route_denied",
    principal: input.principal,
    payload: {
      provider: input.provider,
      sends_screenshot: input.sends_screenshot,
      session_id: input.session_id,
      third_party: thirdParty,
      allow_third_party_inference: policy.allow_third_party_inference,
    },
  });
  if (allowed) return { ok: true };
  return {
    ok: false,
    error: brokerError("FORBIDDEN", {
      reason: "third_party_inference_disabled",
      provider: input.provider,
    }),
  };
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth < 0) throw new Error("BROKER_REDACTION_DEPTH_EXCEEDED");
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) throw new Error("BROKER_REDACTION_CYCLE");
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth - 1, seen));
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = KEY_PATTERN.test(key) ? REDACTED : redactValue(child, depth - 1, seen);
  }
  seen.delete(value);
  return out;
}

function redactString(value: string): string {
  let out = value;
  for (const pattern of VALUE_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`);
  return `{${entries.join(",")}}`;
}
