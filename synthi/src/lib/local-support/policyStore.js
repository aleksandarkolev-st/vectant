import prisma from "@/lib/prisma";
import { compareSemverLike, readLocalSupportPolicy } from "@/lib/local-support/controlPlane";

const POLICY_ID = "global";
const UPDATE_FIELDS = new Set([
  "global_enabled", "org_id", "org_disabled", "pairing_disabled", "preview_disabled",
  "agent_access_disabled", "min_app_version", "vulnerable_versions", "retention_days",
]);

export async function readDurableLocalSupportPolicy(env = process.env, client = prisma, orgId = null) {
  const base = readLocalSupportPolicy(env);
  assertVersionPolicy(base.min_app_version, base.vulnerable_versions, "environment");
  const globalStored = await client.localSupportPolicyState.findUnique({ where: { id: POLICY_ID } });
  const normalizedOrgId = normalizeOrgId(orgId);
  const scopedStored = normalizedOrgId
    ? await client.localSupportPolicyState.findUnique({ where: { orgId: normalizedOrgId } })
    : null;
  const stored = scopedStored || globalStored;
  if (!stored) return base;
  const storedPolicies = [globalStored, scopedStored].filter(Boolean);
  for (const storedPolicy of storedPolicies) assertStoredPolicyVersionFields(storedPolicy);
  const storedVulnerableVersions = storedPolicies.flatMap((item) => parseVersions(item.vulnerableVersionsJson));
  const vulnerableVersions = uniqueStrings([
    ...base.vulnerable_versions,
    ...storedVulnerableVersions,
  ]);
  const globalStoredPolicy = globalStored || stored;
  const scopedEnabled = scopedStored ? scopedStored.globalEnabled : true;
  const globalEnabled = globalStoredPolicy.globalEnabled
    && scopedEnabled
    && env.VECTANT_LOCAL_SUPPORT_ENABLED !== "false";
  const orgDisabled = storedPolicies.some((item) => item.orgDisabled)
    || env.VECTANT_LOCAL_SUPPORT_ORG_DISABLED === "true";
  const pairingDisabled = storedPolicies.some((item) => item.pairingDisabled)
    || env.VECTANT_LOCAL_SUPPORT_PAIRING_DISABLED === "true";
  const previewDisabled = storedPolicies.some((item) => item.previewDisabled)
    || env.VECTANT_LOCAL_SUPPORT_PREVIEW_GATEWAY_DISABLED === "true";
  const agentAccessDisabled = storedPolicies.some((item) => item.agentAccessDisabled)
    || base.emergency_controls.agent_access_disabled;
  const minAppVersion = storedPolicies.reduce(
    (current, item) => stricterMinimumVersion(current, item.minAppVersion),
    env.VECTANT_LOCAL_SUPPORT_MIN_APP_VERSION,
  ) || base.min_app_version;
  const storedRetentionDays = storedPolicies.reduce(
    (current, item) => Math.min(current, item.retentionDays),
    90,
  );
  const retentionDays = stricterRetentionDays(storedRetentionDays, env);
  const enabled = globalEnabled && !orgDisabled && !pairingDisabled;
  return {
    ...base,
    enabled,
    global_enabled: globalEnabled,
    org_id: stored.orgId || normalizedOrgId || base.org_id || null,
    org_kill_switch: orgDisabled,
    pairing_disabled: pairingDisabled,
    min_app_version: minAppVersion,
    vulnerable_versions: vulnerableVersions,
    retention: {
      ...base.retention,
      local_activity_days: retentionDays,
      cloud_security_event_days: retentionDays,
    },
    emergency_controls: {
      ...base.emergency_controls,
      pairing_disabled: pairingDisabled,
      preview_gateway_disabled: previewDisabled,
      agent_access_disabled: agentAccessDisabled,
      vulnerable_version_blocklist: vulnerableVersions,
    },
    mvp: {
      ...base.mvp,
      browser_preview_enabled: base.mvp.browser_preview_enabled && !previewDisabled,
      agent_preview_read_enabled: false,
      fast_support_enabled: base.mvp.fast_support_enabled,
      fast_support_ttl_minutes: base.mvp.fast_support_ttl_minutes,
    },
    persistent_policy: true,
    policy_updated_at: stored.updatedAt.toISOString(),
  };
}

export function publicLocalSupportPolicy(policy) {
  const value = policy && typeof policy === "object" ? policy : {};
  const emergency = value.emergency_controls && typeof value.emergency_controls === "object"
    ? value.emergency_controls
    : {};
  const retention = value.retention && typeof value.retention === "object" ? value.retention : {};
  const mvp = value.mvp && typeof value.mvp === "object" ? value.mvp : {};
  return {
    enabled: value.enabled === true,
    global_enabled: value.global_enabled === true,
    org_id: typeof value.org_id === "string" ? value.org_id : null,
    org_kill_switch: value.org_kill_switch === true,
    pairing_disabled: value.pairing_disabled === true,
    disabled_reason: typeof value.disabled_reason === "string" ? value.disabled_reason : null,
    min_app_version: String(value.min_app_version || "0.1.0").slice(0, 128),
    policy_version: String(value.policy_version || "unknown").slice(0, 128),
    protocol_version: String(value.protocol_version || "unknown").slice(0, 128),
    vulnerable_versions: Array.isArray(value.vulnerable_versions)
      ? value.vulnerable_versions.filter((version) => typeof version === "string").slice(0, 100)
      : [],
    retention: {
      no_retention: retention.no_retention === true,
      local_activity_days: safePublicDays(retention.local_activity_days),
      cloud_security_event_days: safePublicDays(retention.cloud_security_event_days),
      raw_bodies_allowed: false,
      export_available: retention.export_available === true,
    },
    mvp: {
      balanced_mode_default: mvp.balanced_mode_default === true,
      manual_mode_available: mvp.manual_mode_available === true,
      fast_support_enabled: mvp.fast_support_enabled === true,
      fast_support_ttl_minutes: safePublicMinutes(mvp.fast_support_ttl_minutes),
      fast_support_scope: publicText(mvp.fast_support_scope),
      fast_support_source_review_required: mvp.fast_support_source_review_required === true,
      fast_support_logs_review_required: mvp.fast_support_logs_review_required === true,
      fast_support_ports_manual: mvp.fast_support_ports_manual === true,
      fast_support_response_bodies_review_required: mvp.fast_support_response_bodies_review_required === true,
      agent_read_enabled: false,
      agent_interaction_enabled: false,
      agent_preview_read_enabled: false,
      browser_preview_enabled: mvp.browser_preview_enabled === true,
      persistent_port_approvals: false,
      shell_commands: false,
      file_writes: false,
      repo_upload: false,
    },
    emergency_controls: {
      feature_disabled: emergency.feature_disabled === true,
      org_disabled: emergency.org_disabled === true,
      preview_gateway_disabled: emergency.preview_gateway_disabled === true,
      pairing_disabled: emergency.pairing_disabled === true,
      agent_access_disabled: emergency.agent_access_disabled !== false,
      vulnerable_version_blocklist: Array.isArray(emergency.vulnerable_version_blocklist)
        ? emergency.vulnerable_version_blocklist.filter((version) => typeof version === "string").slice(0, 100)
        : [],
      update_revocation_supported: emergency.update_revocation_supported === true,
    },
    persistent_policy: value.persistent_policy === true,
    policy_updated_at: typeof value.policy_updated_at === "string" ? value.policy_updated_at : null,
  };
}

function safePublicDays(value) {
  const days = Number(value);
  return Number.isSafeInteger(days) && days >= 0 && days <= 90 ? days : 0;
}

function safePublicMinutes(value) {
  const minutes = Number(value);
  return Number.isSafeInteger(minutes) && minutes >= 0 && minutes <= 30 ? minutes : 0;
}

function publicText(value) {
  return typeof value === "string" ? value.slice(0, 128) : null;
}

function stricterMinimumVersion(storedVersion, environmentVersion) {
  if (typeof environmentVersion !== "string" || !environmentVersion) return storedVersion;
  return compareSemverLike(environmentVersion, storedVersion) > 0
    ? environmentVersion
    : storedVersion;
}

function stricterRetentionDays(storedDays, env) {
  if (env.VECTANT_LOCAL_SUPPORT_NO_RETENTION === "true") return 0;
  const configured = Number(env.VECTANT_LOCAL_SUPPORT_RETENTION_DAYS);
  if (Number.isSafeInteger(configured) && configured >= 0 && configured <= 90) {
    return Math.min(storedDays, configured);
  }
  return storedDays;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string"))].slice(0, 100);
}

export async function updateDurableLocalSupportPolicy(input, updatedBy, client = prisma) {
  const body = input && typeof input === "object" ? input : {};
  if (!updatedBy || Object.keys(body).some((key) => key !== "action" && !UPDATE_FIELDS.has(key))) {
    return denied("invalid_policy_update");
  }
  const orgId = body.org_id === undefined ? null : normalizeOrgId(body.org_id);
  if (body.org_id !== undefined && !orgId) return denied("invalid_org_id");
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
    && (!Number.isSafeInteger(body.retention_days) || body.retention_days < 0 || body.retention_days > 90)) {
    return denied("invalid_retention_days");
  }
  for (const field of [
    "global_enabled", "org_disabled", "pairing_disabled", "preview_disabled", "agent_access_disabled",
  ]) {
    if (body[field] !== undefined && typeof body[field] !== "boolean") return denied("invalid_policy_update");
  }

  const policyId = orgId ? `org_${orgId}` : POLICY_ID;
  const existing = await client.localSupportPolicyState.findUnique({ where: { id: policyId } });
  const fallback = orgId && !existing
    ? await client.localSupportPolicyState.findUnique({ where: { id: POLICY_ID } })
    : null;
  const defaults = existing || fallback;
  if (defaults) assertStoredPolicyVersionFields(defaults);
  const data = {
    orgId,
    globalEnabled: body.global_enabled ?? defaults?.globalEnabled ?? false,
    orgDisabled: body.org_disabled ?? defaults?.orgDisabled ?? false,
    pairingDisabled: body.pairing_disabled ?? defaults?.pairingDisabled ?? false,
    previewDisabled: body.preview_disabled ?? defaults?.previewDisabled ?? false,
    agentAccessDisabled: body.agent_access_disabled ?? defaults?.agentAccessDisabled ?? true,
    minAppVersion: body.min_app_version ?? defaults?.minAppVersion ?? "0.1.0",
    vulnerableVersionsJson: JSON.stringify(body.vulnerable_versions ?? parseVersions(defaults?.vulnerableVersionsJson)),
    retentionDays: body.retention_days ?? defaults?.retentionDays ?? 30,
    updatedBy: String(updatedBy).slice(0, 256),
  };
  const stored = await client.localSupportPolicyState.upsert({
    where: { id: policyId },
    create: { id: policyId, ...data },
    update: data,
  });
  return {
    decision: "policy_updated",
    policy_id: stored.id,
    org_id: stored.orgId || null,
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

function normalizeOrgId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
    ? value
    : null;
}

function parseVersions(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string").slice(0, 100) : [];
  } catch {
    return [];
  }
}

function assertStoredPolicyVersionFields(stored) {
  let versions;
  try {
    versions = JSON.parse(stored.vulnerableVersionsJson || "[]");
  } catch {
    throw new Error("durable_policy_versions_invalid");
  }
  if (!Array.isArray(versions) || versions.length > 100
    || versions.some((version) => !isPolicyVersion(version))) {
    throw new Error("durable_policy_versions_invalid");
  }
  assertVersionPolicy(stored.minAppVersion, versions, "durable");
}

function assertVersionPolicy(minimum, vulnerableVersions, source) {
  if (!isPolicyVersion(minimum)
    || !Array.isArray(vulnerableVersions)
    || vulnerableVersions.some((version) => !isPolicyVersion(version))) {
    throw new Error(`${source}_policy_versions_invalid`);
  }
}

function isPolicyVersion(value) {
  return typeof value === "string"
    && /^\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/.test(value)
    && value.length <= 128;
}

function denied(reason) {
  return { decision: "denied", reason, raw_body_included: false, bytes_sent: 0 };
}
