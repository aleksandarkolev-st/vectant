import { describe, expect, it } from "vitest";
import { buildDojoProofVisualHtml } from "../../scripts/dojo-proof-self-check.mjs";

describe("Dojo proof self-check visual evidence", () => {
  it("renders proof visual HTML from supplied run data", () => {
    const html = buildDojoProofVisualHtml({
      skill: {
        skill_id: "dojo_dynamic_skill",
        workflow_id: "wf_dynamic",
        title: "Dynamic <Skill>",
        license: {
          license_id: "license_dynamic",
          entrustment_level: "E4",
          readiness_level: 8,
        },
        case_law: [
          { case_id: "case_dynamic_guardrail" },
        ],
      },
      publish: {
        private_tool: { tool_name: "synthi_app_dynamic_skill" },
      },
      proof_capsule: { capsule_id: "capsule_dynamic" },
      checkride: {
        checkride: {
          results: [
            {
              scenario_id: "scenario_dynamic",
              passed: true,
              risk: "duplicate_entity",
              evidence_ref: "evidence_dynamic",
            },
          ],
        },
      },
      vivarium_run: { vivarium_run: { run: { run_id: "vivarium_dynamic" } } },
      wind_tunnel: { wind_tunnel_execution: { run_count: 7 } },
      source_plan: {
        source_affordance_pr_plan: {
          typed_patch_plan: {
            operations: [{ operation_id: "patch_dynamic_affordance" }],
          },
          generated_pr_metadata: {
            review_requirements: [{ gate: "dynamic_review_gate" }],
          },
        },
      },
      license_health: { license_health: { status: "dynamic_active" } },
    });

    expect(html).toContain("dojo_dynamic_skill");
    expect(html).toContain("wf_dynamic");
    expect(html).toContain("synthi_app_dynamic_skill");
    expect(html).toContain("capsule_dynamic");
    expect(html).toContain("vivarium_dynamic");
    expect(html).toContain("scenario_dynamic");
    expect(html).toContain("patch_dynamic_affordance");
    expect(html).toContain("dynamic_review_gate");
    expect(html).toContain("dynamic_active");
    expect(html).toContain("Dynamic &lt;Skill&gt;");
    expect(html).toContain("data-testid=\"dojo-proof-visual\"");
  });
});
