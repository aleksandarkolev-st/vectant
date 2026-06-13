import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { browserBroker } from "../../src/browser/broker.js";
import { dojoSkillRegistry } from "../../src/browser/dojo.js";
import { InMemoryDojoSkillStore } from "../../src/browser/dojo_store.js";
import { InMemoryPrivateWorkflowToolStore, privateWorkflowToolRegistry } from "../../src/browser/private_tool_registry.js";
import { sourceIdentityRegistry } from "../../src/browser/source_identity.js";
import { PostgresDojoLicenseStore } from "../../src/dojo/store/postgres_license_store.js";
import { applyDojoPostgresMigrations } from "../../src/dojo/store/postgres_proof_store.js";
import { PostgresDojoSkillStore } from "../../src/dojo/store/postgres_skill_store.js";
import { dispatchDojoTool } from "../../src/tools/dojo.js";

const postgresUrl = process.env["SYNTHI_DOJO_POSTGRES_TEST_URL"];
const describeWithPostgres = postgresUrl ? describe : describe.skip;
const originalEnv = { ...process.env };

describeWithPostgres("Dojo tool Postgres control-plane wiring", () => {
  let pool: Pool;

  beforeAll(async () => {
    if (!postgresUrl) throw new Error("SYNTHI_DOJO_POSTGRES_TEST_URL required");
    pool = new Pool({ connectionString: postgresUrl });
    await applyDojoPostgresMigrations(pool);
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    browserBroker.resetForTests();
    sourceIdentityRegistry.resetForTests();
    privateWorkflowToolRegistry.useStoreForTests(new InMemoryPrivateWorkflowToolStore());
    privateWorkflowToolRegistry.resetForTests();
    dojoSkillRegistry.useStoreForTests(new InMemoryDojoSkillStore());
    dojoSkillRegistry.resetForTests();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("persists production durable skill publication and lists competencies from Postgres after local reset", async () => {
    const tenantId = `tenant_tool_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const workspaceId = `workspace_tool_${Math.random().toString(16).slice(2)}`;
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    process.env.SYNTHI_DOJO_REQUIRE_DURABLE_STORE = "1";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_STORE = "postgres";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL = postgresUrl;

    recordOpenDetailsWorkflowForToolTest(workspaceId);
    const tenant = productionTenantContextArgs({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      request_id: "req-postgres-publish",
      correlation_id: "corr-postgres-publish",
      actor_id: "postgres-publisher",
      actor_type: "human",
      roles: ["dojo:operator"],
    });
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", {
      workspace_id: workspaceId,
      reason: "integration_postgres_publish",
      evidence_refs: ["evidence:integration-postgres-publish"],
      ...tenant,
    });

    expect(publish?.isError).toBeUndefined();
    const publishContent = publish?.structuredContent as {
      skill: { skill_id: string; workflow_id: string };
      publication: { control_plane_persistence: Record<string, unknown> };
    };
    expect(publishContent.publication.control_plane_persistence).toEqual(expect.objectContaining({
      ok: true,
      store_kind: "postgres",
      skill_id: publishContent.skill.skill_id,
      workflow_id: publishContent.skill.workflow_id,
      workspace_id: workspaceId,
      status: "published",
    }));

    const skillStore = new PostgresDojoSkillStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    const licenseStore = new PostgresDojoLicenseStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    const savedSkill = await skillStore.getSkill(publishContent.skill.skill_id);
    expect(savedSkill).toEqual(expect.objectContaining({
      skill_id: publishContent.skill.skill_id,
      workflow_id: publishContent.skill.workflow_id,
      workspace_id: workspaceId,
    }));
    expect(await licenseStore.listLicenses({ skill_id: publishContent.skill.skill_id })).toEqual([
      expect.objectContaining({
        skill_id: publishContent.skill.skill_id,
        status: "active",
        readiness_level: savedSkill?.skill_readiness_level,
      }),
    ]);

    dojoSkillRegistry.useStoreForTests(new InMemoryDojoSkillStore());
    dojoSkillRegistry.resetForTests();
    const listed = await dispatchDojoTool("synthi_dojo_list_competencies", {
      ...tenant,
      actor_id: "postgres-reader",
      actor_type: "agent",
      roles: ["agent"],
      request_id: "req-postgres-list",
      correlation_id: "corr-postgres-list",
    });

    expect(listed?.isError).toBeUndefined();
    expect(listed?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      control_plane_source: "postgres",
      count: 1,
      competencies: [
        expect.objectContaining({
          skill_id: publishContent.skill.skill_id,
          workflow_id: publishContent.skill.workflow_id,
        }),
      ],
    }));
  });
});

function recordOpenDetailsWorkflowForToolTest(workspaceId: string): void {
  const url = "https://app.example.test/settings";
  browserBroker.requestConsent(url);
  browserBroker.registerTabs([{ tab_id: "tab-a", url, active: true }]);
  browserBroker.selectTab("tab-a");
  expect(browserBroker.startTeachMode("tab-a").ok).toBe(true);
  sourceIdentityRegistry.register({
    workspaceId,
    filePath: "src/SettingsPanel.jsx",
    tokens: [{
      token: "details.open",
      file: "src/SettingsPanel.jsx",
      line: 12,
      column: 6,
      tag: "button",
    }],
  });
  browserBroker.recordHumanAction({
    tab_id: "tab-a",
    url,
    origin: "https://app.example.test",
    action: "click",
    element: { role: "button", name: "Open details", source_id: "details.open" },
    locator_candidates: [
      { kind: "role", locator: "page.getByRole(\"button\", { name: \"Open details\" })", confidence: 0.98, reason: "role" },
    ],
  });
}

function productionTenantContextArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenant_id: "tenant-a",
    organization_id: "org-a",
    workspace_id: "workspace-a",
    actor_id: "production-agent-a",
    actor_type: "agent",
    roles: ["agent"],
    request_id: "req-production-a",
    correlation_id: "corr-production-a",
    ...overrides,
  };
}
