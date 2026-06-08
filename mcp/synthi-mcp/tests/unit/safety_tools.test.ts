import { beforeEach, describe, expect, it } from "vitest";
import { browserBroker } from "../../src/browser/broker.js";
import { replayIsolationProfiles } from "../../src/browser/safety.js";
import { eventLog } from "../../src/events/index.js";
import { ADVERTISED_TOOLS } from "../../src/tool_registry.js";
import { SAFETY_TOOL_NAMES, SAFETY_TOOLS, dispatchSafetyTool } from "../../src/tools/safety.js";

beforeEach(() => {
  browserBroker.resetForTests();
  replayIsolationProfiles.resetForTests();
  eventLog._resetForTests();
});

describe("safety MCP tool surface", () => {
  it("advertises every safety tool in the capability registry", () => {
    for (const name of SAFETY_TOOL_NAMES) {
      expect(ADVERTISED_TOOLS).toContain(name);
      expect(SAFETY_TOOLS.some((tool) => tool.name === name)).toBe(true);
    }
  });

  it("returns null for non-safety tool dispatch", async () => {
    expect(await dispatchSafetyTool("synthi_health", {})).toBeNull();
  });

  it("exposes mutation boundaries and read-only prefix validation", async () => {
    teachSaveWorkflow();

    const mutationPlan = await dispatchSafetyTool("synthi_safety_get_mutation_plan", { workspace_id: "workspace-a" });
    expect(mutationPlan?.isError).toBeUndefined();
    expect((mutationPlan?.structuredContent as {
      mutation_plan: {
        has_mutation: boolean;
        first_mutation_step_id: string;
        background_hardening: { allowed: boolean; mode: string };
        ci_full_replay: { configured: boolean; blockers: string[] };
      };
    }).mutation_plan).toEqual(expect.objectContaining({
      has_mutation: true,
      first_mutation_step_id: "browser_evt_2",
      background_hardening: expect.objectContaining({ allowed: false, mode: "blocked" }),
      ci_full_replay: expect.objectContaining({
        configured: false,
        blockers: expect.arrayContaining(["ci_isolation_profile_not_ready", "mutation_replay_not_explicitly_allowed"]),
      }),
    }));

    const prefix = await dispatchSafetyTool("synthi_safety_run_prefix_validation", {});
    expect(prefix?.isError).toBeUndefined();
    expect(prefix?.structuredContent).toEqual(expect.objectContaining({ ok: true }));
    expect((prefix?.structuredContent as {
      validation: {
        validation_type: string;
        read_only: boolean;
        mutation_executed: boolean;
        status: string;
        planned_step_count: number;
        stopped_before_step_id: string;
      };
    }).validation).toEqual(expect.objectContaining({
      validation_type: "dryRunPlan",
      read_only: true,
      mutation_executed: false,
      status: "stoppedAtMutationBoundary",
      planned_step_count: 1,
      stopped_before_step_id: "browser_evt_2",
    }));
  });

  it("gates CI full mutation replay on complete isolation metadata", async () => {
    teachSaveWorkflow();

    const incomplete = await dispatchSafetyTool("synthi_safety_set_replay_isolation_profile", {
      workspace_id: "workspace-a",
      kind: "ciIsolated",
      base_url: "https://ci.example.test",
      ci_command: "npm run test:e2e",
    });
    expect((incomplete?.structuredContent as { isolation_profile: { readiness: string; missing: string[] } }).isolation_profile).toEqual(
      expect.objectContaining({
        readiness: "ciIsolatedIncomplete",
        missing: expect.arrayContaining(["data_reset_command", "allow_mutation_replay"]),
      })
    );

    const blocked = await dispatchSafetyTool("synthi_safety_explain_blocked_hardening", { workspace_id: "workspace-a" });
    expect((blocked?.structuredContent as { explanation: { blocked: boolean; failure_class: string } }).explanation).toEqual(
      expect.objectContaining({ blocked: true, failure_class: "mutationBlocked" })
    );

    const ready = await dispatchSafetyTool("synthi_safety_set_replay_isolation_profile", {
      workspace_id: "workspace-a",
      kind: "ciIsolated",
      base_url: "https://ci.example.test",
      ci_command: "npm run test:e2e",
      data_reset_command: "npm run db:reset:test",
      allow_mutation_replay: true,
    });
    expect((ready?.structuredContent as { isolation_profile: { readiness: string; can_run_full_mutation_replay: boolean } }).isolation_profile).toEqual(
      expect.objectContaining({
        readiness: "ciIsolatedReady",
        can_run_full_mutation_replay: true,
      })
    );

    const mutationPlan = await dispatchSafetyTool("synthi_safety_get_mutation_plan", { workspace_id: "workspace-a" });
    expect((mutationPlan?.structuredContent as {
      mutation_plan: { background_hardening: { allowed: boolean; mode: string }; ci_full_replay: { allowed: boolean; blockers: string[] } };
    }).mutation_plan).toEqual(expect.objectContaining({
      background_hardening: expect.objectContaining({ allowed: true, mode: "ciOnly" }),
      ci_full_replay: expect.objectContaining({ allowed: true, blockers: [] }),
    }));
  });
});

function teachSaveWorkflow(): void {
  const url = "https://app.example.test/settings";
  browserBroker.requestConsent(url, "granted", "unit", { screenshot: true, diagnostics: true });
  browserBroker.registerTabs([{ tab_id: "tab-a", url, active: true }]);
  expect(browserBroker.startTeachMode("tab-a").ok).toBe(true);
  browserBroker.recordHumanAction({
    tab_id: "tab-a",
    url,
    origin: "https://app.example.test",
    action: "fill",
    value: "hello@example.test",
    field_name: "email",
    element: { tag: "input", label: "Email", source_id: "s_email" },
  });
  browserBroker.recordHumanAction({
    tab_id: "tab-a",
    url,
    origin: "https://app.example.test",
    action: "click",
    element: { tag: "button", role: "button", name: "Save settings", source_id: "s_save" },
  });
}
