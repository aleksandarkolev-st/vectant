import { describe, expect, it, vi } from "vitest";

import { readDurableLocalSupportPolicy, updateDurableLocalSupportPolicy } from "./policyStore";

describe("durable local support policy", () => {
  it("overrides environment defaults with immediate persistent kill switches", async () => {
    const stored = {
      globalEnabled: true,
      orgDisabled: false,
      pairingDisabled: false,
      previewDisabled: true,
      agentAccessDisabled: true,
      minAppVersion: "0.2.0",
      vulnerableVersionsJson: "[\"0.1.0\"]",
      retentionDays: 14,
      updatedAt: new Date("2030-01-01T00:00:00.000Z"),
    };
    const policy = await readDurableLocalSupportPolicy({}, {
      localSupportPolicyState: { findUnique: vi.fn(async () => stored) },
    });

    expect(policy).toMatchObject({
      enabled: true,
      min_app_version: "0.2.0",
      vulnerable_versions: ["0.1.0"],
      emergency_controls: { preview_gateway_disabled: true, agent_access_disabled: true },
      mvp: { browser_preview_enabled: false, agent_preview_read_enabled: false },
      retention: { cloud_security_event_days: 14 },
      persistent_policy: true,
    });
  });

  it("validates and upserts an exact admin policy update", async () => {
    const upsert = vi.fn(async ({ create }) => ({ ...create, updatedAt: new Date() }));
    const client = {
      localSupportPolicyState: {
        findUnique: vi.fn(async () => null),
        upsert,
      },
    };
    const result = await updateDurableLocalSupportPolicy({
      action: "update_policy",
      global_enabled: true,
      pairing_disabled: true,
      min_app_version: "0.2.0",
      vulnerable_versions: ["0.1.0"],
      retention_days: 14,
    }, "admin_1", client);

    expect(result).toMatchObject({
      decision: "policy_updated",
      global_enabled: true,
      pairing_disabled: true,
      min_app_version: "0.2.0",
      bytes_sent: 0,
    });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ updatedBy: "admin_1", vulnerableVersionsJson: "[\"0.1.0\"]" }),
    }));
  });

  it("keeps explicit environment emergency controls stricter than durable state", async () => {
    const policy = await readDurableLocalSupportPolicy({
      VECTANT_LOCAL_SUPPORT_ENABLED: "false",
      VECTANT_LOCAL_SUPPORT_ORG_DISABLED: "true",
      VECTANT_LOCAL_SUPPORT_MIN_APP_VERSION: "0.4.0",
      VECTANT_LOCAL_SUPPORT_VULNERABLE_VERSIONS: "0.3.0",
      VECTANT_LOCAL_SUPPORT_NO_RETENTION: "true",
    }, {
      localSupportPolicyState: { findUnique: vi.fn(async () => ({
        globalEnabled: true,
        orgDisabled: false,
        pairingDisabled: false,
        previewDisabled: false,
        agentAccessDisabled: false,
        minAppVersion: "0.2.0",
        vulnerableVersionsJson: "[\"0.1.0\"]",
        retentionDays: 14,
        updatedAt: new Date("2030-01-01T00:00:00.000Z"),
      })) },
    });

    expect(policy).toMatchObject({
      enabled: false,
      global_enabled: false,
      org_kill_switch: true,
      min_app_version: "0.4.0",
      vulnerable_versions: ["0.3.0", "0.1.0"],
      retention: { local_activity_days: 0, cloud_security_event_days: 0 },
    });
  });

  it("preserves an explicit no-retention policy", async () => {
    const upsert = vi.fn(async ({ create }) => ({ ...create, updatedAt: new Date() }));
    const result = await updateDurableLocalSupportPolicy({
      action: "update_policy",
      retention_days: 0,
    }, "admin_1", {
      localSupportPolicyState: {
        findUnique: vi.fn(async () => null),
        upsert,
      },
    });

    expect(result).toMatchObject({ decision: "policy_updated", retention_days: 0 });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ retentionDays: 0 }),
    }));
  });
});
