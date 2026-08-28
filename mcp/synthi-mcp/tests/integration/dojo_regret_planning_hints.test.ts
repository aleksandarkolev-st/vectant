import { describe, expect, it } from "vitest";
import { buildDojoSkill } from "../../src/browser/dojo.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
import { compileDojoSkillGraphForSkill } from "../../src/dojo/graph/compiler.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";
import type { RegretPlanningHint } from "../../src/dojo/regret/types.js";

describe("Dojo regret planning hints", () => {
  it("changes future graph planning after promoted policy deltas become hints", () => {
    const skill = skillFixture();
    const hint: RegretPlanningHint = {
      skillId: skill.skill_id,
      taskClass: "invoice_submit",
      hintKind: "add_guardrail",
      confidence: "high",
      evidenceIds: ["ledger://policy-delta/promoted"],
    };

    const baseline = compileDojoSkillGraphForSkill(skill, {
      created_at: "2026-06-24T00:00:00.000Z",
    }).graph;
    const planned = compileDojoSkillGraphForSkill(skill, {
      created_at: "2026-06-24T00:00:00.000Z",
      regret_planning_hints: [hint],
    }).graph;
    const baselineAction = baseline.nodes.find((node) => node.kind === "Action");
    const plannedAction = planned.nodes.find((node) => node.kind === "Action");

    expect(plannedAction?.guardrails.length).toBe((baselineAction?.guardrails.length ?? 0) + 1);
    expect(plannedAction?.guardrails).toEqual(expect.arrayContaining([
      expect.objectContaining({
        guardrail_id: expect.stringMatching(/^regret_hint_[a-f0-9]{8}$/),
        predicate: expect.stringMatching(/^regret_hint_[a-f0-9]{8}_satisfied == true$/),
      }),
    ]));
    expect(plannedAction?.metadata).toEqual(expect.objectContaining({
      regret_planning_hints: [expect.objectContaining({
        hint_kind: "add_guardrail",
        evidence_ids: ["ledger://policy-delta/promoted"],
      })],
    }));
  });

  it("ignores expired and evidence-free hints", () => {
    const skill = skillFixture();
    const planned = compileDojoSkillGraphForSkill(skill, {
      created_at: "2026-06-24T00:00:00.000Z",
      now: "2026-06-24T00:00:00.000Z",
      regret_planning_hints: [
        {
          skillId: skill.skill_id,
          taskClass: "invoice_submit",
          hintKind: "add_assertion",
          confidence: "high",
          evidenceIds: ["ledger://policy-delta/expired"],
          expiresAt: "2026-06-23T00:00:00.000Z",
        },
        {
          skillId: skill.skill_id,
          taskClass: "invoice_submit",
          hintKind: "add_guardrail",
          confidence: "high",
          evidenceIds: [],
        },
      ],
    }).graph;

    const action = planned.nodes.find((node) => node.kind === "Action");
    expect(action?.metadata).not.toHaveProperty("regret_planning_hints");
    expect(action?.assertions.some((assertion) => assertion.assertion_id.startsWith("regret_hint_"))).toBe(false);
    expect(action?.guardrails.some((guardrail) => guardrail.guardrail_id.startsWith("regret_hint_"))).toBe(false);
  });
});

function skillFixture() {
  const contract = compileWorkflowContract([
    event({
      event_id: "save",
      event_seq: 1,
      action: "click",
      detail: { element: { role: "button", name: "Save invoice" } },
      locator_candidates: [
        { kind: "role", locator: "page.getByRole(\"button\", { name: \"Save invoice\" })", confidence: 0.96, reason: "role" },
      ],
    }),
  ]).contract;
  return buildDojoSkill(contract, {
    workspace_id: "workspace-a",
    now: "2026-06-24T00:00:00.000Z",
  });
}

function event(overrides: Partial<BrowserTraceEvent>): BrowserTraceEvent {
  return {
    event_id: "evt",
    trace_id: "trace",
    trace_version: 1,
    event_seq: 1,
    ts: 1,
    tab_id: "tab",
    origin: "https://app.example.test",
    url: "https://app.example.test/invoices",
    kind: "human_action",
    action: "click",
    target: "button",
    selectors: [],
    locator_candidates: [],
    confidence: 0.99,
    ...overrides,
  };
}
