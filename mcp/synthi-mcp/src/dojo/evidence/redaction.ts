import { createHash } from "node:crypto";

export type DojoRedactableArtifactKind =
  | "screenshot"
  | "html"
  | "trace"
  | "api_response"
  | "local_storage"
  | "document_text"
  | "file_name";

export interface DojoRedactionRuleApplication {
  rule_id: string;
  count: number;
}

export interface DojoRedactionManifest {
  schema_version: "synthi.dojo.redactionManifest.v1";
  redaction_id: string;
  artifact_kind: DojoRedactableArtifactKind;
  original_sha256: string;
  redacted_sha256: string;
  manifest_sha256: string;
  rules_applied: DojoRedactionRuleApplication[];
  redaction_count: number;
  created_at: string;
}

export interface DojoRedactionResult<T = unknown> {
  redacted_content: T;
  manifest: DojoRedactionManifest;
}

type RedactionCounts = Map<string, number>;

const SENSITIVE_KEY_PATTERN = /(^|[_-])(authorization|cookie|set-cookie|token|secret|password|passwd|api[_-]?key|localstorage|sessionstorage)([_-]|$)/i;

export function redactDojoEvidenceArtifact<T = unknown>(input: {
  artifact_kind: DojoRedactableArtifactKind;
  content: T;
  created_at?: string;
}): DojoRedactionResult<T> {
  const counts: RedactionCounts = new Map();
  const originalMaterial = canonicalJson(input.content);
  const redacted = redactValue(input.content, counts) as T;
  const redactedMaterial = canonicalJson(redacted);
  const baseManifest = {
    schema_version: "synthi.dojo.redactionManifest.v1" as const,
    redaction_id: `redaction_${shortHash(`${input.artifact_kind}:${originalMaterial}:${redactedMaterial}`)}`,
    artifact_kind: input.artifact_kind,
    original_sha256: sha256(originalMaterial),
    redacted_sha256: sha256(redactedMaterial),
    rules_applied: [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([rule_id, count]) => ({ rule_id, count })),
    redaction_count: [...counts.values()].reduce((sum, count) => sum + count, 0),
    created_at: input.created_at ?? new Date().toISOString(),
  };
  const manifest: DojoRedactionManifest = {
    ...baseManifest,
    manifest_sha256: sha256(canonicalJson(baseManifest)),
  };
  return {
    redacted_content: redacted,
    manifest,
  };
}

export function verifyDojoRedactionManifest(input: {
  redacted_content: unknown;
  manifest: DojoRedactionManifest;
}): { ok: boolean; blocked_by: string[] } {
  const blockedBy: string[] = [];
  if (input.manifest.schema_version !== "synthi.dojo.redactionManifest.v1") {
    blockedBy.push("redaction_manifest_schema_mismatch");
  }
  if (input.manifest.redacted_sha256 !== sha256(canonicalJson(input.redacted_content))) {
    blockedBy.push("redaction_manifest_redacted_digest_mismatch");
  }
  const { manifest_sha256: _manifestSha, ...baseManifest } = input.manifest;
  if (input.manifest.manifest_sha256 !== sha256(canonicalJson(baseManifest))) {
    blockedBy.push("redaction_manifest_digest_mismatch");
  }
  return {
    ok: blockedBy.length === 0,
    blocked_by: blockedBy,
  };
}

export function dojoRedactionDigestHex(digest: string): string {
  const normalized = digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
  if (!/^[a-f0-9]{64}$/i.test(normalized)) throw new Error("dojo_redaction_sha256_digest_invalid");
  return normalized.toLowerCase();
}

function redactValue(value: unknown, counts: RedactionCounts, keyHint = ""): unknown {
  if (SENSITIVE_KEY_PATTERN.test(keyHint)) {
    increment(counts, "sensitive_key");
    return "[REDACTED]";
  }
  if (typeof value === "string") return redactString(value, counts);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, counts, keyHint));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      redactValue(nested, counts, key),
    ])
  );
}

function redactString(value: string, counts: RedactionCounts): string {
  let next = replaceWithCount(value, /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/g, "Bearer [REDACTED_TOKEN]", counts, "bearer_token");
  next = replaceWithCount(next, /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_TOKEN]", counts, "jwt_token");
  next = replaceWithCount(
    next,
    /([?&](?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|token|secret|password|session|sid|code)=)[^&#\s"'<>)]*/gi,
    (_match, prefix: string) => `${prefix}[REDACTED]`,
    counts,
    "sensitive_url_param"
  );
  next = replaceWithCount(next, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]", counts, "email_address");
  next = replaceWithCount(next, /([A-Za-z]:\\Users\\)[^\\\s]+/g, (_match, prefix: string) => `${prefix}[REDACTED_USER]`, counts, "local_file_path");
  next = replaceWithCount(next, /(\/Users\/)[^/\s]+/g, (_match, prefix: string) => `${prefix}[REDACTED_USER]`, counts, "local_file_path");
  return next;
}

function replaceWithCount(
  value: string,
  pattern: RegExp,
  replacement: string | ((match: string, ...groups: string[]) => string),
  counts: RedactionCounts,
  ruleId: string
): string {
  let count = 0;
  const replaced = value.replace(pattern, (match, ...groups: string[]) => {
    count += 1;
    return typeof replacement === "function" ? replacement(match, ...groups) : replacement;
  });
  if (count > 0) increment(counts, ruleId, count);
  return replaced;
}

function increment(counts: RedactionCounts, ruleId: string, amount = 1): void {
  counts.set(ruleId, (counts.get(ruleId) ?? 0) + amount);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortValue(nested)])
  );
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
