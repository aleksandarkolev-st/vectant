import { createHash } from "node:crypto";
import type { DojoSourceSnapshot, DojoSourceTokenSnapshot } from "./source_snapshot.js";

export interface DojoGraphNodeSourceBinding {
  node_id: string;
  source_token_ids: string[];
  license_id?: string;
}

export interface DojoSourceDriftAffectedNode {
  node_id: string;
  source_token_id: string;
  drift_kind: "changed" | "removed";
  license_id?: string;
}

export interface DojoSourceLicenseExpiryTrigger {
  trigger_id: string;
  node_id: string;
  source_token_id: string;
  reason: string;
  license_id?: string;
}

export interface DojoSourceDriftReport {
  schema_version: "synthi.dojo.sourceDriftReport.v1";
  previous_snapshot_id: string;
  next_snapshot_id: string;
  app_origin: string;
  previous_app_version: string;
  next_app_version: string;
  drifted_token_ids: string[];
  affected_nodes: DojoSourceDriftAffectedNode[];
  license_expiry_triggers: DojoSourceLicenseExpiryTrigger[];
}

export function detectDojoSourceDrift(input: {
  previous_snapshot: DojoSourceSnapshot;
  next_snapshot: DojoSourceSnapshot;
  node_bindings: DojoGraphNodeSourceBinding[];
}): DojoSourceDriftReport {
  if (input.previous_snapshot.app_origin !== input.next_snapshot.app_origin) {
    throw new Error("dojo_source_drift_app_origin_mismatch");
  }
  const previousTokens = tokenMap(input.previous_snapshot.source_tokens);
  const nextTokens = tokenMap(input.next_snapshot.source_tokens);
  const drifted = new Map<string, "changed" | "removed">();
  for (const [tokenId, previousToken] of previousTokens.entries()) {
    const nextToken = nextTokens.get(tokenId);
    if (!nextToken) {
      drifted.set(tokenId, "removed");
      continue;
    }
    if (tokenHash(previousToken) !== tokenHash(nextToken)) {
      drifted.set(tokenId, "changed");
    }
  }

  const affectedNodes = input.node_bindings.flatMap((binding) =>
    binding.source_token_ids.flatMap((tokenId): DojoSourceDriftAffectedNode[] => {
      const driftKind = drifted.get(tokenId);
      if (!driftKind) return [];
      return [{
        node_id: binding.node_id,
        source_token_id: tokenId,
        drift_kind: driftKind,
        ...(binding.license_id ? { license_id: binding.license_id } : {}),
      }];
    })
  );

  return {
    schema_version: "synthi.dojo.sourceDriftReport.v1",
    previous_snapshot_id: input.previous_snapshot.snapshot_id,
    next_snapshot_id: input.next_snapshot.snapshot_id,
    app_origin: input.previous_snapshot.app_origin,
    previous_app_version: input.previous_snapshot.app_version,
    next_app_version: input.next_snapshot.app_version,
    drifted_token_ids: [...drifted.keys()].sort(),
    affected_nodes: affectedNodes.sort((left, right) => `${left.node_id}:${left.source_token_id}`.localeCompare(`${right.node_id}:${right.source_token_id}`)),
    license_expiry_triggers: affectedNodes.map((node) => ({
      trigger_id: `source_drift_${shortHash(`${node.node_id}:${node.source_token_id}:${input.next_snapshot.snapshot_hash}`)}`,
      node_id: node.node_id,
      source_token_id: node.source_token_id,
      reason: `Source token ${node.source_token_id} was ${node.drift_kind} in ${input.next_snapshot.app_version}.`,
      ...(node.license_id ? { license_id: node.license_id } : {}),
    })),
  };
}

function tokenMap(tokens: DojoSourceTokenSnapshot[]): Map<string, DojoSourceTokenSnapshot> {
  return new Map(tokens.map((token) => [token.token_id, token]));
}

function tokenHash(token: DojoSourceTokenSnapshot): string {
  return createHash("sha256").update(canonicalJson(token)).digest("hex");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
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
