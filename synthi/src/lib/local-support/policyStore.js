import prisma from "@/lib/prisma";
import { readLocalSupportPolicy } from "@/lib/local-support/controlPlane";

const POLICY_ID = "global";
const UPDATE_FIELDS = new Set([
  "global_enabled", "org_disabled", "pairing_disabled", "preview_disabled",
  "agent_access_disabled", "min_app_version", "vulnerable_versions", "retention_days",
]);

export async function readDurableLocalSupportPolicy(env = process.env, client = prisma) {
  const base = readLocalSupportPolicy(env);
  const stored = await client.localSupportPolicyState.findUnique({ where: { id: POLICY_ID } });
  if (!stored) return base;
  const vulnerableVersions = parseVersions(stored.vulnerableVersionsJson);
  const enabled = stored.globalEnabled && !stored.orgDisabled && !stored.pairingDisabled;
  return {
    ...base,
    enabled,
    global_enabled: stored.globalEnabled,
    org_kill_switch: stored.orgDisabled,
    pairing_disabled: stored.pairingDisabled,
    min_app_version: stored.minAppVersion,
    vulnerable_versions: vulnerableVersions,
    retention: {
      ...base.retention,
      local_activity_days: stored.retentionDays,
      cloud_security_event_days: stored.retentionDays,
    },
    emergency_controls: {
      ...base.emergency_controls,
      pairing_disabled: stored.pairingDisabled,
      preview_gateway_disabled: stored.previewDisabled,
      agent_access_disabled: stored.agentAccessDisabled,
    },
    mvp: {
      ...base.mvp,
      browser_preview_enabled: base.mvp.browser_preview_enabled && !stored.previewDisabled,
      agent_preview_read_enabled: false,
      fast_support_enabled: base.mvp.fast_support_enabled,
      fast_support_ttl_minutes: base.mvp.fast_support_ttl_minutes,
    },
    persistent_policy: true,
    policy_updated_at: stored.updatedAt.toISOString(),
  };
}

export async function updateDurableLocalSupportPolicy(input, updatedBy, client = prisma) {
  const body = input && typeof input === "object" ? input : {};
  if (!updatedBy || Object.keys(body).some((key) => key !== "action" && !UPDATE_FIELDS.has(key))) {
    return denied("invalid_policy_update");
  }
  if (body.action !== "update_policy") return denied("invalid_policy_update");
  if (body.min_app_version !== undefined
    && !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(body.min_app_version)) {
    return denied("invalid_min_app_version");
  }
  if (body.vulnerable_versions !== undefined
    && (!Array.isArray(body.vulnerable_versions)
      || body.vulnerable_versions.length > 100
      || body.vulnerable_versions.some((version) => !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)))) {
    return denied("invalid_vulnerable_versions");
  }
  if (body.retention_days !== undefined
    && (!Number.isSafeInteger(body.retention_days) || body.retention_days < 1 || body.retention_days > 90)) {
    return denied("invalid_retention_days");
  }
  for (const field of [
    "global_enabled", "org_disabled", "pairing_disabled", "preview_disabled", "agent_access_disabled",
  ]) {
    if (body[field] !== undefined && typeof body[field] !== "boolean") return denied("invalid_policy_update");
  }

  const existing = await client.localSupportPolicyState.findUnique({ where: { id: POLICY_ID } });
  const data = {
    globalEnabled: body.global_enabled ?? existing?.globalEnabled ?? false,
    orgDisabled: body.org_disabled ?? existing?.orgDisabled ?? false,
    pairingDisabled: body.pairing_disabled ?? existing?.pairingDisabled ?? false,
    previewDisabled: body.preview_disabled ?? existing?.previewDisabled ?? false,
    agentAccessDisabled: body.agent_access_disabled ?? existing?.agentAccessDisabled ?? true,
    minAppVersion: body.min_app_version ?? existing?.minAppVersion ?? "0.1.0",
    vulnerableVersionsJson: JSON.stringify(body.vulnerable_versions ?? parseVersions(existing?.vulnerableVersionsJson)),
    retentionDays: body.retention_days ?? existing?.retentionDays ?? 30,
    updatedBy: String(updatedBy).slice(0, 256),
  };
  const stored = await client.localSupportPolicyState.upsert({
    where: { id: POLICY_ID },
    create: { id: POLICY_ID, ...data },
    update: data,
  });
  return {
    decision: "policy_updated",
    policy_id: stored.id,
    global_enabled: stored.globalEnabled,
    org_disabled: stored.orgDisabled,
    pairing_disabled: stored.pairingDisabled,
    preview_disabled: stored.previewDisabled,
    agent_access_disabled: stored.agentAccessDisabled,
    min_app_version: stored.minAppVersion,
    vulnerable_versions: parseVersions(stored.vulnerableVersionsJson),
    retention_days: stored.retentionDays,
    raw_body_included: false,
    bytes_sent: 0,
  };
}

function parseVersions(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string").slice(0, 100) : [];
  } catch {
    return [];
  }
}

function denied(reason) {
  return { decision: "denied", reason, raw_body_included: false, bytes_sent: 0 };
}
