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

  it("keeps global restrictions authoritative over an organization row", async () => {
    const updatedBy = `postgres-org-e2e-${Date.now()}`;
    const orgId = `org_postgres_${Date.now()}`;
    try {
      await prisma.localSupportPolicyState.deleteMany({
        where: { id: { in: ["global", `org_${orgId}`] } },
      });
      await updateDurableLocalSupportPolicy({
        action: "update_policy",
        global_enabled: false,
        pairing_disabled: true,
        preview_disabled: true,
        min_app_version: "0.4.0",
        vulnerable_versions: ["0.2.0"],
        retention_days: 7,
      }, updatedBy);
      await updateDurableLocalSupportPolicy({
        action: "update_policy",
        org_id: orgId,
        global_enabled: true,
        pairing_disabled: false,
        preview_disabled: false,
        min_app_version: "0.1.0",
        vulnerable_versions: ["0.3.0"],
        retention_days: 30,
      }, updatedBy);

      const policy = await readDurableLocalSupportPolicy({}, prisma, orgId);

      expect(policy).toMatchObject({
        enabled: false,
        global_enabled: false,
        pairing_disabled: true,
        min_app_version: "0.4.0",
        vulnerable_versions: expect.arrayContaining(["0.2.0", "0.3.0"]),
        retention: { local_activity_days: 7, cloud_security_event_days: 7 },
        emergency_controls: { preview_gateway_disabled: true },
      });
    } finally {
      await prisma.localSupportPolicyState.deleteMany({
        where: { id: { in: ["global", `org_${orgId}`] } },
      });
      await prisma.$disconnect();
    }
  });
});
