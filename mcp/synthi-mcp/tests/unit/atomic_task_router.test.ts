import { describe, expect, it } from "vitest";
import {
  createAtomicTaskRouter,
  createVectantExecutionContext,
  routeAtomicVectantTask,
  serializeAtomicTaskRoute,
  toAtomicOrchestratorCompatibleRoute,
  type VectantAgentPolicy,
} from "../../src/atomic_task_router.js";
import { createToolMetadataCatalog } from "../../src/tool_metadata_catalog.js";

describe("atomic Vectant task router", () => {
  it("selects the minimal CodeSite transaction tool and plans independent validation", () => {
    const route = routeAtomicVectantTask({
      id: "codesite-open",
      description: "Open a CodeSite transaction.",
    });

    expect(route.execution.role).toBe("implementation");
    expect(route.skills.map((skill) => skill.id)).toEqual(["vectant-codesite"]);
    expect(route.tools.map((tool) => tool.name)).toEqual(["synthi_codesite_open_transaction"]);
    expect(route.tools[0]).toEqual(expect.objectContaining({
      description: expect.stringContaining("CodeSite"),
    }));
    expect(route.validation).toMatchObject({ required: true, role: "validation", mode: "independent" });
    expect(route.trace).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "atomic-task", taskId: "codesite-open" }),
      expect.objectContaining({ stage: "tool-selection", selectedToolNames: ["synthi_codesite_open_transaction"] }),
      expect.objectContaining({ stage: "skill-selection", selectedSkillIds: ["vectant-codesite"] }),
      expect.objectContaining({ stage: "role-selection", selectedRole: "implementation" }),
    ]));
  });

  it("selects the relevant Agent Dojo proof actions from metadata only", () => {
    const route = routeAtomicVectantTask({
      description: "Issue and validate an Agent Dojo proof capsule.",
    });

    expect(route.execution.role).toBe("validation");
    expect(route.skills.map((skill) => skill.id)).toEqual(["vectant-agent-dojo", "vectant-validation"]);
    expect(route.tools.map((tool) => tool.name)).toEqual([
      "synthi_dojo_issue_proof_capsule",
      "synthi_dojo_validate_proof_capsule",
    ]);
    expect(route.validation.required).toBe(true);
  });

  it("routes a runtime attach request to the least broad attachment action", () => {
    const route = routeAtomicVectantTask({ description: "Attach the runtime." });

    expect(route.execution.role).toBe("infrastructure");
    expect(route.skills.map((skill) => skill.id)).toEqual(["vectant-runtime"]);
    expect(route.tools.map((tool) => tool.name)).toEqual(["synthi_attach"]);
  });

  it("keeps one and multi-domain tool selection selective", () => {
    const oneDomain = routeAtomicVectantTask({ description: "Open a CodeSite transaction." });
    const multiDomain = routeAtomicVectantTask({
      description: "Open a CodeSite transaction and issue an Agent Dojo proof capsule.",
    });

    expect(oneDomain.tools).toHaveLength(1);
    expect(multiDomain.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "synthi_codesite_open_transaction",
      "synthi_dojo_issue_proof_capsule",
    ]));
    expect(multiDomain.tools.length).toBeLessThanOrEqual(3);
  });

  it("falls back deterministically without exposing tools when nothing matches", () => {
    const router = createAtomicTaskRouter();
    const first = router.route({ id: "unknown", description: "Frobnicate the quasar." });
    const second = router.route({ id: "unknown", description: "Frobnicate the quasar." });

    expect(first.execution.role).toBe("implementation");
    expect(first.skills).toEqual([]);
    expect(first.tools).toEqual([]);
    expect(first.validation.required).toBe(false);
    expect(serializeAtomicTaskRoute(first)).toBe(serializeAtomicTaskRoute(second));
  });

  it("uses the explicit mechanical fast path without catalog exposure", () => {
    const route = routeAtomicVectantTask({ description: "Format the local documentation." });

    expect(route).toMatchObject({ fastPath: true, execution: { role: "implementation" } });
    expect(route.skills).toEqual([]);
    expect(route.tools).toEqual([]);
    expect(route.validation.required).toBe(false);
    expect(route.trace).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "fast-path" }),
    ]));
  });

  it("chooses the cheapest capable injected role policy", () => {
    const policies: readonly VectantAgentPolicy[] = [
      { role: "implementation", cost: 100, fallback: true },
      { role: "infrastructure", cost: 8, groups: ["codesite"] },
      { role: "debugging", cost: 2, groups: ["codesite"] },
    ];
    const route = createAtomicTaskRouter({ agentPolicies: policies }).route({
      description: "Open a CodeSite transaction.",
    });

    expect(route.execution.role).toBe("debugging");
    expect(route.trace).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "role-selection", capableRoles: ["debugging", "infrastructure"] }),
    ]));
  });

  it("supports dynamic schema-free catalog metadata and exposes only the selected context", () => {
    const catalog = createToolMetadataCatalog({
      advertisedTools: ["synthi_attach", "synthi_browser_get_console"],
      dynamicEntries: [{
        name: "synthi_private_invoice_lookup",
        groups: ["billing"],
        keywords: ["invoice", "accounting"],
      }],
    });
    const route = createAtomicTaskRouter({ catalog }).route({
      description: "Look up a billing invoice.",
    });
    const context = createVectantExecutionContext(route);
    const serializedContext = JSON.stringify(context);

    expect(route.tools.map((tool) => tool.name)).toEqual(["synthi_private_invoice_lookup"]);
    expect(route.skills).toEqual([]);
    expect(serializedContext).toContain("synthi_private_invoice_lookup");
    expect(serializedContext).not.toContain("synthi_attach");
    expect(serializedContext).not.toContain("synthi_browser_get_console");
    expect((context as Record<string, unknown>).catalog).toBeUndefined();
  });

  it("adapts a plan to atomic-orchestrator without passing tool schemas", () => {
    const plan = routeAtomicVectantTask({ description: "Attach the runtime." });
    const compatible = toAtomicOrchestratorCompatibleRoute(plan);

    expect(compatible).toEqual(expect.objectContaining({
      role: "infrastructure",
      skills: ["vectant-runtime"],
      validation: "independent",
      suggested_tools: ["synthi_attach"],
    }));
    expect(compatible.skill_metadata).toEqual([
      expect.objectContaining({ id: "vectant-runtime", groups: expect.arrayContaining(["runtime", "attachment"]) }),
    ]);
    expect(JSON.stringify(compatible)).not.toContain("inputSchema");
    expect(compatible.tool_metadata).toEqual([
      expect.objectContaining({ name: "synthi_attach", description: expect.any(String) }),
    ]);
  });
});
