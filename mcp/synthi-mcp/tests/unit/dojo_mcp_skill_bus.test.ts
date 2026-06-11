import { describe, expect, it } from "vitest";
import { buildDojoSkill, issueDojoProofCapsule, type DojoSkill } from "../../src/browser/dojo.js";
import { generatePrivateWorkflowToolManifest } from "../../src/browser/private_tool_manifest.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
import { validateDojoMcpSkillManifest } from "../../src/dojo/mcp/manifest_signing.js";
import {
  createInProcessDojoMcpSkillBus,
  createLegacyDojoTenantContext,
  type DojoSkillBusProofValidation,
} from "../../src/dojo/mcp/skill_bus.js";
import type { DojoTenantContext } from "../../src/dojo/mcp/execution_policy_gate.js";

describe("Dojo MCP skill bus", () => {
  it("lists only tenant-visible licensed competencies while legacy context preserves local compatibility", async () => {
    const workspaceA = skillFixture("workspace-a", "Open details");
    const workspaceB = skillFixture("workspace-b", "Save invoice");
    const bus = createInProcessDojoMcpSkillBus({ listSkills: () => [workspaceA, workspaceB], env: manifestEnv() });

    await expect(bus.listCompetencies({ tenant: tenant("workspace-a") })).resolves.toEqual([
      expect.objectContaining({
        skill_id: workspaceA.skill_id,
        workspace_id: "workspace-a",
        mcp_skill_manifest: expect.objectContaining({ manifest_digest: expect.stringMatching(/^sha256:/) }),
      }),
    ]);
    const adminCompetencies = await bus.listCompetencies({ tenant: tenant("workspace-a", ["dojo:admin"]) });
    expect(adminCompetencies.map((item) => item.workspace_id).sort()).toEqual(["workspace-a", "workspace-b"]);
    const legacyCompetencies = await bus.listCompetencies({ tenant: createLegacyDojoTenantContext() });
    expect(legacyCompetencies).toHaveLength(2);
  });

  it("resolves signed tool manifests with authorization and version checks", async () => {
    const skill = skillFixture("workspace-a", "Open details");
    const bus = createInProcessDojoMcpSkillBus({ listSkills: () => [skill], env: manifestEnv() });
    const resolved = await bus.resolveTool({
      tenant: tenant("workspace-a"),
      tool_name: skill.published_tool_name!,
      tool_version: skill.skill_version,
    });

    expect(resolved).toEqual(expect.objectContaining({
      ok: true,
      status: "resolved",
      skill_id: skill.skill_id,
      tool_version: skill.skill_version,
      mcp_skill_manifest: expect.objectContaining({ kind: "dojoMcpSkillManifest" }),
    }));
    expect(validateDojoMcpSkillManifest(resolved.mcp_skill_manifest!, {
      env: manifestEnv(),
      expected_skill_id: skill.skill_id,
      expected_tool_name: skill.published_tool_name,
    })).toEqual(expect.objectContaining({ ok: true, blocked_by: [] }));
    await expect(bus.resolveTool({
      tenant: tenant("workspace-b"),
      tool_name: skill.published_tool_name!,
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["dojo_mcp_tool_not_authorized"],
    }));
    await expect(bus.resolveTool({
      tenant: tenant("workspace-a"),
      tool_name: skill.published_tool_name!,
      tool_version: "9.9.9",
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      blocked_by: ["dojo_mcp_tool_version_mismatch"],
    }));
  });

  it("dispatches only after proof validation and keeps dry runs side-effect free", async () => {
    const skill = skillFixture("workspace-a", "Open details");
    const proof = issueDojoProofCapsule(skill, "run_workflow", {
      context_claims: { workspace_verified: true },
      evidence_claims: [
        { claim: "checkride_passed", satisfied: true },
        { claim: "success_assertions_defined", satisfied: true },
        { claim: "guardrails_active", satisfied: true },
      ],
      substrate_claim: "mcp",
      now: "2026-06-11T00:00:00.000Z",
    });
    const validations: string[] = [];
    const executions: string[] = [];
    const bus = createInProcessDojoMcpSkillBus({
      listSkills: () => [skill],
      env: manifestEnv(),
      validateProof: ({ proof_capsule }): DojoSkillBusProofValidation => {
        validations.push(proof_capsule.capsule_id);
        return { ok: true, status: "allowed", blocked_by: [] };
      },
      executeTool: ({ tool_name }) => {
        executions.push(tool_name);
        return { ok: true, tool_name };
      },
    });

    await expect(bus.dispatch({
      tenant: tenant("workspace-a"),
      tool_name: skill.published_tool_name!,
      args: {},
      dry_run: true,
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      blocked_by: ["dojo_proof_capsule_required"],
    }));
    await expect(bus.dispatch({
      tenant: tenant("workspace-a"),
      tool_name: skill.published_tool_name!,
      args: { client_id: "client-a" },
      proof_capsule: proof,
      dry_run: true,
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      status: "allowed",
      dry_run: true,
      validation: expect.objectContaining({ ok: true }),
    }));
    expect(validations).toEqual([proof.capsule_id]);
    expect(executions).toEqual([]);
    await expect(bus.dispatch({
      tenant: tenant("workspace-a"),
      tool_name: skill.published_tool_name!,
      args: { client_id: "client-a" },
      proof_capsule: proof,
      dry_run: false,
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      dry_run: false,
      result: expect.objectContaining({ ok: true, tool_name: skill.published_tool_name }),
    }));
    expect(executions).toEqual([skill.published_tool_name]);
  });
});

function skillFixture(workspaceId: string, label: string): DojoSkill {
  const workflow = compileWorkflowContract([
    event({
      event_id: label.toLowerCase().replace(/\s+/g, "_"),
      action: "click",
      element: { role: "button", name: label, source_id: `source.${label.toLowerCase().replace(/\s+/g, ".")}` },
      locator_candidates: [
        { kind: "role", locator: `page.getByRole("button", { name: "${label}" })`, confidence: 0.98, reason: "role" },
      ],
    }),
  ]).contract;
  const manifest = generatePrivateWorkflowToolManifest(workflow);
  return buildDojoSkill(workflow, {
    workspace_id: workspaceId,
    now: "2026-06-11T00:00:00.000Z",
    private_tool_manifest: manifest,
    published_tool_name: manifest.tool_name,
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
    url: "https://app.example.test/settings",
    kind: "human_action",
    action: "click",
    target: "button",
    selectors: [],
    locator_candidates: [],
    confidence: 0.99,
    ...overrides,
  };
}

function tenant(workspaceId: string, roles = ["agent"]): DojoTenantContext {
  return {
    tenant_id: "tenant-a",
    organization_id: "org-a",
    workspace_id: workspaceId,
    actor_id: "agent-a",
    actor_type: "agent",
    roles,
    request_id: `req-${workspaceId}`,
    correlation_id: `corr-${workspaceId}`,
  };
}

function manifestEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SYNTHI_DOJO_MCP_MANIFEST_ISSUER: "unit-test-skill-bus",
    SYNTHI_DOJO_MCP_MANIFEST_KEY_ID: "unit-test-key",
    SYNTHI_DOJO_MCP_MANIFEST_SIGNING_KEY: "unit-test-secret",
  };
}
