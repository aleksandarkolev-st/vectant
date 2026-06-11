import { createHash } from "node:crypto";

export interface DojoSourceTokenSnapshot {
  token_id: string;
  route: string;
  component: string;
  action?: string;
  source_locator: string;
  risk?: "safe" | "mutation" | "dangerous";
}

export interface DojoSourceSnapshot {
  schema_version: "synthi.dojo.sourceSnapshot.v1";
  snapshot_id: string;
  tenant_id: string;
  workspace_id: string;
  app_origin: string;
  app_version: string;
  commit_sha: string;
  source_root: string;
  source_tokens: DojoSourceTokenSnapshot[];
  source_token_ids: string[];
  snapshot_hash: string;
  created_at: string;
}

export function buildDojoSourceSnapshot(input: {
  tenant_id: string;
  workspace_id: string;
  app_origin: string;
  app_version: string;
  commit_sha: string;
  source_root: string;
  source_tokens?: DojoSourceTokenSnapshot[];
  created_at: string;
}): DojoSourceSnapshot {
  requireNonEmpty(input.tenant_id, "tenant_id");
  requireNonEmpty(input.workspace_id, "workspace_id");
  requireNonEmpty(input.app_origin, "app_origin");
  requireNonEmpty(input.app_version, "app_version");
  requireNonEmpty(input.commit_sha, "commit_sha");
  requireNonEmpty(input.source_root, "source_root");
  if (!Number.isFinite(Date.parse(input.created_at))) throw new Error("dojo_source_snapshot_created_at_invalid");
  const sourceTokens = normalizeTokens(input.source_tokens ?? []);
  const material = {
    schema_version: "synthi.dojo.sourceSnapshot.v1" as const,
    tenant_id: input.tenant_id,
    workspace_id: input.workspace_id,
    app_origin: input.app_origin,
    app_version: input.app_version,
    commit_sha: input.commit_sha,
    source_root: normalizePath(input.source_root),
    source_tokens: sourceTokens,
    created_at: input.created_at,
  };
  const snapshotHash = sha256(canonicalJson(material));
  return {
    ...material,
    snapshot_id: `srcsnap_${snapshotHash.slice(0, 16)}`,
    source_token_ids: sourceTokens.map((token) => token.token_id),
    snapshot_hash: snapshotHash,
  };
}

export function sourceTokenReleaseKey(snapshot: DojoSourceSnapshot, tokenId: string): string {
  if (!snapshot.source_token_ids.includes(tokenId)) throw new Error("dojo_source_token_not_in_snapshot");
  return `${snapshot.app_origin}@${snapshot.app_version}:${snapshot.commit_sha}:${tokenId}`;
}

function normalizeTokens(tokens: DojoSourceTokenSnapshot[]): DojoSourceTokenSnapshot[] {
  const seen = new Set<string>();
  return tokens
    .map((token) => {
      requireNonEmpty(token.token_id, "source_token_id");
      requireNonEmpty(token.route, "source_token_route");
      requireNonEmpty(token.component, "source_token_component");
      requireNonEmpty(token.source_locator, "source_token_locator");
      if (seen.has(token.token_id)) throw new Error("dojo_source_token_duplicate");
      seen.add(token.token_id);
      return {
        token_id: token.token_id,
        route: token.route,
        component: token.component,
        ...(token.action ? { action: token.action } : {}),
        source_locator: normalizePath(token.source_locator),
        ...(token.risk ? { risk: token.risk } : {}),
      };
    })
    .sort((left, right) => left.token_id.localeCompare(right.token_id));
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function requireNonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new Error(`dojo_source_snapshot_${field}_required`);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortValue(nested)])
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
