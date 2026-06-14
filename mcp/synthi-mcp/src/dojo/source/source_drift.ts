import { createHash } from "node:crypto";
import {
  verifyDojoSourceSnapshot,
  type DojoSourceSnapshot,
  type DojoSourceTokenSnapshot,
} from "./source_snapshot.js";
import type {
  DojoAuditActor,
  DojoLicenseStore,
  DojoPermissionLicenseRecord,
  DojoStoredLicenseStatus,
} from "../store/interfaces.js";

export interface DojoGraphNodeSourceBinding {
  node_id: string;
  source_token_ids: string[];
  license_id?: string;
}

export interface DojoSourceDriftAffectedNode {
  node_id: string;
  source_token_id: string;
  drift_kind: "changed" | "removed" | "added";
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
  added_token_ids: string[];
  review_required_token_ids: string[];
  affected_nodes: DojoSourceDriftAffectedNode[];
  license_expiry_triggers: DojoSourceLicenseExpiryTrigger[];
}

export interface DojoSourceDriftExpiredLicense {
  license_id: string;
  trigger_ids: string[];
  node_ids: string[];
  source_token_ids: string[];
  reasons: string[];
  record: DojoPermissionLicenseRecord;
}

export interface DojoSourceDriftSkippedExpiryTrigger {
  trigger_id: string;
  node_id: string;
  source_token_id: string;
  license_id?: string;
  reason: string;
  status?: DojoStoredLicenseStatus;
}

export interface DojoSourceDriftFailedExpiry {
  license_id: string;
  trigger_ids: string[];
  reason: string;
  blocked_by: string[];
}

export interface DojoSourceDriftExpiryApplication {
  schema_version: "synthi.dojo.sourceDriftExpiryApplication.v1";
  previous_snapshot_id: string;
  next_snapshot_id: string;
  app_origin: string;
  applied_at: string;
  applied_by: DojoAuditActor;
  trigger_count: number;
  unique_license_count: number;
  expired_license_count: number;
  skipped_trigger_count: number;
  failed_expiration_count: number;
  expired_licenses: DojoSourceDriftExpiredLicense[];
  skipped_triggers: DojoSourceDriftSkippedExpiryTrigger[];
  failed_expirations: DojoSourceDriftFailedExpiry[];
  blocked_by: string[];
  ok: boolean;
}

export function detectDojoSourceDrift(input: {
  previous_snapshot: DojoSourceSnapshot;
  next_snapshot: DojoSourceSnapshot;
  node_bindings: DojoGraphNodeSourceBinding[];
  source_snapshot_signing_keys_by_id: Record<string, string>;
}): DojoSourceDriftReport {
  assertVerifiedSnapshot("previous", input.previous_snapshot, input.source_snapshot_signing_keys_by_id);
  assertVerifiedSnapshot("next", input.next_snapshot, input.source_snapshot_signing_keys_by_id);
  if (input.previous_snapshot.app_origin !== input.next_snapshot.app_origin) {
    throw new Error("dojo_source_drift_app_origin_mismatch");
  }
  const previousTokens = tokenMap(input.previous_snapshot.source_tokens);
  const nextTokens = tokenMap(input.next_snapshot.source_tokens);
  const drifted = new Map<string, DojoSourceDriftAffectedNode["drift_kind"]>();
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
  const addedTokenIds: string[] = [];
  for (const tokenId of nextTokens.keys()) {
    if (!previousTokens.has(tokenId)) {
      addedTokenIds.push(tokenId);
      drifted.set(tokenId, "added");
    }
  }
  const reviewRequiredTokenIds = addedTokenIds
    .map((tokenId) => nextTokens.get(tokenId))
    .filter((token): token is DojoSourceTokenSnapshot => Boolean(token))
    .filter((token) => token.risk === "mutation" || token.risk === "dangerous")
    .map((token) => token.token_id)
    .sort();

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
    added_token_ids: addedTokenIds.sort(),
    review_required_token_ids: reviewRequiredTokenIds,
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

export async function applyDojoSourceDriftExpiry(input: {
  report: DojoSourceDriftReport;
  license_store: Pick<DojoLicenseStore, "getLicense" | "expireLicense">;
  expired_by: DojoAuditActor;
  now?: string;
}): Promise<DojoSourceDriftExpiryApplication> {
  assertSourceDriftReport(input.report);
  const appliedAt = input.now ?? new Date().toISOString();
  const triggerGroups = groupExpiryTriggersByLicense(input.report.license_expiry_triggers);
  const expiredLicenses: DojoSourceDriftExpiredLicense[] = [];
  const skippedTriggers: DojoSourceDriftSkippedExpiryTrigger[] = [...triggerGroups.skipped_triggers];
  const failedExpirations: DojoSourceDriftFailedExpiry[] = [];

  for (const [licenseId, triggers] of triggerGroups.by_license.entries()) {
    const existing = await input.license_store.getLicense(licenseId);
    if (!existing) {
      failedExpirations.push({
        license_id: licenseId,
        trigger_ids: triggers.map((trigger) => trigger.trigger_id),
        reason: "license_record_missing",
        blocked_by: ["source_drift_license_record_missing"],
      });
      continue;
    }
    if (existing.status === "expired") {
      skippedTriggers.push(...triggers.map((trigger) => skippedTrigger(trigger, "license_already_expired", existing.status)));
      continue;
    }
    if (existing.status !== "active") {
      skippedTriggers.push(...triggers.map((trigger) => skippedTrigger(trigger, "license_not_active", existing.status)));
      continue;
    }

    const reason = sourceDriftExpiryReason(input.report, triggers);
    try {
      const expired = await input.license_store.expireLicense(
        licenseId,
        reason,
        appliedAt,
        input.expired_by,
        { expires_at: appliedAt }
      );
      if (!expired) {
        failedExpirations.push({
          license_id: licenseId,
          trigger_ids: triggers.map((trigger) => trigger.trigger_id),
          reason: "license_expire_returned_null",
          blocked_by: ["source_drift_license_expire_failed"],
        });
        continue;
      }
      expiredLicenses.push({
        license_id: licenseId,
        trigger_ids: [...new Set(triggers.map((trigger) => trigger.trigger_id))].sort(),
        node_ids: [...new Set(triggers.map((trigger) => trigger.node_id))].sort(),
        source_token_ids: [...new Set(triggers.map((trigger) => trigger.source_token_id))].sort(),
        reasons: [...new Set(triggers.map((trigger) => trigger.reason))].sort(),
        record: expired,
      });
    } catch (error) {
      failedExpirations.push({
        license_id: licenseId,
        trigger_ids: triggers.map((trigger) => trigger.trigger_id),
        reason: error instanceof Error ? error.message : String(error),
        blocked_by: ["source_drift_license_expire_exception"],
      });
    }
  }

  const blockedBy = [...new Set(failedExpirations.flatMap((failure) => failure.blocked_by))].sort();
  return {
    schema_version: "synthi.dojo.sourceDriftExpiryApplication.v1",
    previous_snapshot_id: input.report.previous_snapshot_id,
    next_snapshot_id: input.report.next_snapshot_id,
    app_origin: input.report.app_origin,
    applied_at: appliedAt,
    applied_by: input.expired_by,
    trigger_count: input.report.license_expiry_triggers.length,
    unique_license_count: triggerGroups.by_license.size,
    expired_license_count: expiredLicenses.length,
    skipped_trigger_count: skippedTriggers.length,
    failed_expiration_count: failedExpirations.length,
    expired_licenses: expiredLicenses,
    skipped_triggers: skippedTriggers.sort((left, right) => left.trigger_id.localeCompare(right.trigger_id)),
    failed_expirations: failedExpirations,
    blocked_by: blockedBy,
    ok: failedExpirations.length === 0,
  };
}

function assertVerifiedSnapshot(
  label: "previous" | "next",
  snapshot: DojoSourceSnapshot,
  signingKeysById: Record<string, string>
): void {
  const verification = verifyDojoSourceSnapshot(snapshot, { signing_keys_by_id: signingKeysById });
  if (!verification.ok) {
    throw new Error(`dojo_source_drift_${label}_snapshot_unverified:${verification.blocked_by.join(",")}`);
  }
}

function assertSourceDriftReport(report: DojoSourceDriftReport): void {
  if (report.schema_version !== "synthi.dojo.sourceDriftReport.v1") {
    throw new Error("dojo_source_drift_report_schema_invalid");
  }
}

function groupExpiryTriggersByLicense(triggers: DojoSourceLicenseExpiryTrigger[]): {
  by_license: Map<string, DojoSourceLicenseExpiryTrigger[]>;
  skipped_triggers: DojoSourceDriftSkippedExpiryTrigger[];
} {
  const byLicense = new Map<string, DojoSourceLicenseExpiryTrigger[]>();
  const skippedTriggers: DojoSourceDriftSkippedExpiryTrigger[] = [];
  for (const trigger of triggers) {
    if (!trigger.license_id) {
      skippedTriggers.push(skippedTrigger(trigger, "license_id_missing"));
      continue;
    }
    byLicense.set(trigger.license_id, [...(byLicense.get(trigger.license_id) ?? []), trigger]);
  }
  return { by_license: byLicense, skipped_triggers: skippedTriggers };
}

function skippedTrigger(
  trigger: DojoSourceLicenseExpiryTrigger,
  reason: string,
  status?: DojoStoredLicenseStatus
): DojoSourceDriftSkippedExpiryTrigger {
  return {
    trigger_id: trigger.trigger_id,
    node_id: trigger.node_id,
    source_token_id: trigger.source_token_id,
    ...(trigger.license_id ? { license_id: trigger.license_id } : {}),
    reason,
    ...(status ? { status } : {}),
  };
}

function sourceDriftExpiryReason(
  report: DojoSourceDriftReport,
  triggers: DojoSourceLicenseExpiryTrigger[]
): string {
  const tokenIds = [...new Set(triggers.map((trigger) => trigger.source_token_id))].sort();
  const nodeIds = [...new Set(triggers.map((trigger) => trigger.node_id))].sort();
  return [
    `source_drift:${report.previous_snapshot_id}->${report.next_snapshot_id}`,
    `tokens=${tokenIds.join(",")}`,
    `nodes=${nodeIds.join(",")}`,
  ].join(" ");
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
