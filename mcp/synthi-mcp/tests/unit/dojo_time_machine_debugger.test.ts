import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserBroker } from "../../src/browser/broker.js";
import { dojoSkillRegistry } from "../../src/browser/dojo.js";
import { InMemoryDojoSkillStore } from "../../src/browser/dojo_store.js";
import { InMemoryPrivateWorkflowToolStore, privateWorkflowToolRegistry } from "../../src/browser/private_tool_registry.js";
import { sourceIdentityRegistry } from "../../src/browser/source_identity.js";
import { dispatchDojoTool } from "../../src/tools/dojo.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  browserBroker.resetForTests();
  sourceIdentityRegistry.resetForTests();
  privateWorkflowToolRegistry.useStoreForTests(new InMemoryPrivateWorkflowToolStore());
  privateWorkflowToolRegistry.resetForTests();
  dojoSkillRegistry.useStoreForTests(new InMemoryDojoSkillStore());
  dojoSkillRegistry.resetForTests();
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("Dojo Time Machine debugger", () => {
  it("returns deterministic counterfactual twin variants with promoted scenarios and honest projection status", async () => {
    const published = await publishInvoiceWorkflowSkill();

    const twin = await dispatchDojoTool("synthi_dojo_get_counterfactual_twin", {
      skill_id: published.skill.skill_id,
      mutation_kind: "duplicate_entity",
    });

    expect(twin?.isError).toBeUndefined();
    expect(twin?.structuredContent).toEqual(expect.objectContaining({
      implementation_status: "deterministic_projection",
      runtime_enforced: false,
      counterfactual_twin: expect.objectContaining({
        schema_version: "synthi.dojo.counterfactualTwinReport.v1",
        skill_id: published.skill.skill_id,
        workflow_id: published.skill.workflow_id,
        variants: expect.arrayContaining([
          expect.objectContaining({
            scenario_id: expect.stringMatching(/scenario_\d+_duplicate_entity$/),
            mutation_kind: "duplicate_entity",
            observed_behavior: expect.any(String),
            outcome: expect.any(String),
          }),
        ]),
        promoted_scenarios: expect.arrayContaining([expect.stringMatching(/scenario_\d+_duplicate_entity$/)]),
      }),
    }));
  });

  it("correlates counterfactual debug branches with scenarios, attacks, guardrails, remediation, and cost policy", async () => {
    const published = await publishInvoiceWorkflowSkill();

    const debug = await dispatchDojoTool("synthi_dojo_debug_counterfactual", {
      skill_id: published.skill.skill_id,
      mutation_kind: "duplicate_entity",
    });

    expect(debug?.isError).toBeUndefined();
    expect(debug?.structuredContent).toEqual(expect.objectContaining({
      implementation_status: "deterministic_projection",
      runtime_enforced: false,
      skill_id: published.skill.skill_id,
      variants: expect.arrayContaining([
        expect.objectContaining({
          scenario_id: expect.stringMatching(/scenario_\d+_duplicate_entity$/),
          mutation_kind: "duplicate_entity",
        }),
      ]),
      scenarios: expect.arrayContaining([
        expect.objectContaining({
          scenario_id: expect.stringMatching(/scenario_\d+_duplicate_entity$/),
          mutation_kind: "duplicate_entity",
          expected_behavior: expect.any(String),
        }),
      ]),
      results: expect.arrayContaining([
        expect.objectContaining({
          scenario_id: expect.stringMatching(/scenario_\d+_duplicate_entity$/),
          status: expect.any(String),
          finding: expect.any(String),
        }),
      ]),
      attacks: expect.arrayContaining([
        expect.objectContaining({
          scenario_id: expect.stringMatching(/scenario_\d+_duplicate_entity$/),
          mutation_kind: "duplicate_entity",
          strategy: expect.any(String),
          guardrail_refs: expect.any(Array),
        }),
      ]),
      guardrails: expect.arrayContaining([
        expect.objectContaining({
          guardrail_id: expect.stringMatching(/^guard_/),
          rule: expect.any(String),
          blocks_actions: expect.arrayContaining(["run_workflow"]),
        }),
      ]),
      promoted_scenarios: expect.arrayContaining([expect.stringMatching(/scenario_\d+_duplicate_entity$/)]),
      cost_policy: expect.objectContaining({
        stop_conditions: expect.any(Array),
      }),
    }));
  });

  it("explains deterministic Time Machine baseline, counterfactual license impact, replay plan, and guardrails", async () => {
    const published = await publishInvoiceWorkflowSkill();

    const timeMachine = await dispatchDojoTool("synthi_dojo_run_time_machine_debugger", {
      skill_id: published.skill.skill_id,
      mutation_kind: "duplicate_entity",
      question: "What if the selected customer were not unique?",
    });

    expect(timeMachine?.isError).toBeUndefined();
    expect(timeMachine?.structuredContent).toEqual(expect.objectContaining({
      implementation_status: "deterministic_projection",
      runtime_enforced: false,
      skill_id: published.skill.skill_id,
      time_machine_debugger: expect.objectContaining({
        schema_version: "synthi.dojo.timeMachineDebugger.v1",
        debug_id: expect.stringMatching(/^debug_/),
        skill_id: published.skill.skill_id,
        workflow_id: published.skill.workflow_id,
        question: "What if the selected customer were not unique?",
        baseline: expect.objectContaining({
          scenario_id: expect.stringMatching(/scenario_\d+_duplicate_entity$/),
          mutation_kind: "duplicate_entity",
          status: expect.any(String),
          finding: expect.any(String),
        }),
        counterfactual: expect.objectContaining({
          changed_variable: expect.stringContaining("entity"),
          expected_status_after_change: expect.stringMatching(/^(passed|blocked)$/),
          causal_finding: expect.any(String),
          license_impact: expect.any(String),
        }),
        guardrails: expect.arrayContaining([
          expect.objectContaining({
            guardrail_id: expect.stringMatching(/^guard_/),
            rule: expect.any(String),
            blocks_actions: expect.arrayContaining(["run_workflow"]),
          }),
        ]),
        replay_plan: [
          expect.objectContaining({
            step: "replay_static_trace",
            simulator_tier: 0,
            expected_evidence: expect.arrayContaining([`workflow:${published.skill.workflow_id}`]),
          }),
          expect.objectContaining({
            step: "mutate_counterfactual_variable",
            simulator_tier: expect.any(Number),
            expected_evidence: expect.arrayContaining([expect.stringMatching(/^scenario:.+scenario_\d+_duplicate_entity$/)]),
          }),
          expect.objectContaining({
            step: "rerun_checkride_branch",
            simulator_tier: expect.any(Number),
            expected_evidence: expect.arrayContaining([expect.stringMatching(/^checkride_/)]),
          }),
        ],
      }),
    }));
  });
});

async function publishInvoiceWorkflowSkill(): Promise<{ skill: { skill_id: string; workflow_id: string } }> {
  recordInvoiceWorkflow();
  const publish = await dispatchDojoTool("synthi_dojo_publish_skill", {
    workspace_id: "workspace-a",
    reason: "time_machine_debugger_unit_publish",
    actor_id: "time-machine-publisher",
    actor_type: "human",
    evidence_refs: ["evidence:time-machine-publish"],
  });
  expect(publish?.isError).toBeUndefined();
  return publish?.structuredContent as { skill: { skill_id: string; workflow_id: string } };
}

function recordInvoiceWorkflow(): void {
  const url = "https://app.example.test/invoices";
  browserBroker.requestConsent(url);
  browserBroker.registerTabs([{ tab_id: "tab-invoice", url, active: true }]);
  browserBroker.selectTab("tab-invoice");
  expect(browserBroker.startTeachMode("tab-invoice").ok).toBe(true);
  registerSourceToken("invoice.customer.search");
  registerSourceToken("invoice.submit");
  browserBroker.recordHumanAction({
    tab_id: "tab-invoice",
    url,
    origin: "https://app.example.test",
    action: "click",
    element: { role: "combobox", name: "Customer", source_id: "invoice.customer.search" },
    locator_candidates: [
      { kind: "role", locator: "page.getByRole(\"combobox\", { name: \"Customer\" })", confidence: 0.98, reason: "role" },
    ],
  });
  browserBroker.recordHumanAction({
    tab_id: "tab-invoice",
    url,
    origin: "https://app.example.test",
    action: "click",
    element: { role: "button", name: "Submit invoice", source_id: "invoice.submit" },
    locator_candidates: [
      { kind: "role", locator: "page.getByRole(\"button\", { name: \"Submit invoice\" })", confidence: 0.98, reason: "role" },
    ],
  });
}

function registerSourceToken(token: string): void {
  const filePath = `src/${token}.tsx`;
  sourceIdentityRegistry.register({
    workspaceId: "workspace-a",
    filePath,
    adapter: "unit-test",
    transformVersion: "unit_source_identity_v1",
    tokens: [{ token, file: filePath, tag: "button", line: 1, column: 1 }],
  });
}
