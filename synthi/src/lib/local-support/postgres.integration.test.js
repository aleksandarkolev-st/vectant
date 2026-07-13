import { describe, expect, it } from "vitest";

import prisma from "@/lib/prisma";
import {
  readDurableLocalSupportPolicy,
  updateDurableLocalSupportPolicy,
} from "./policyStore";

const run = process.env.LOCAL_SUPPORT_POSTGRES_E2E === "1";

describe.skipIf(!run)("Local Support durable policy on PostgreSQL", () => {
  it("persists and reads back every emergency control", async () => {
    const updatedBy = `postgres-e2e-${Date.now()}`;
    try {
      const updated = await updateDurableLocalSupportPolicy({
        action: "update_policy",
        global_enabled: true,
        org_disabled: true,
        pairing_disabled: true,
        preview_disabled: true,
        agent_access_disabled: true,
        min_app_version: "9.8.7",
        vulnerable_versions: ["9.8.6"],
        retention_days: 7,
      }, updatedBy);

      expect(updated).toMatchObject({
        decision: "policy_updated",
        global_enabled: true,
        org_disabled: true,
        pairing_disabled: true,
        preview_disabled: true,
        agent_access_disabled: true,
        min_app_version: "9.8.7",
        vulnerable_versions: ["9.8.6"],
        retention_days: 7,
        bytes_sent: 0,
        raw_body_included: false,
      });

      const policy = await readDurableLocalSupportPolicy();
      expect(policy).toMatchObject({
        enabled: false,
        global_enabled: true,
        org_kill_switch: true,
        pairing_disabled: true,
        min_app_version: "9.8.7",
        vulnerable_versions: ["9.8.6"],
        persistent_policy: true,
        emergency_controls: {
          pairing_disabled: true,
          preview_gateway_disabled: true,
          agent_access_disabled: true,
        },
        mvp: {
          browser_preview_enabled: false,
          agent_preview_read_enabled: false,
        },
      });
    } finally {
      await prisma.localSupportPolicyState.deleteMany({ where: { id: "global" } });
      await prisma.$disconnect();
    }
  });
});
