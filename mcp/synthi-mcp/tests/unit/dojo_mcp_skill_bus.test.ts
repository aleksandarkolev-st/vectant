import { describe, expect, it } from "vitest";
import { buildDojoSkill, issueDojoProofCapsule, type DojoSkill } from "../../src/browser/dojo.js";
import { generatePrivateWorkflowToolManifest } from "../../src/browser/private_tool_manifest.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
import { validateDojoMcpSkillManifest } from "../../src/dojo/mcp/manifest_signing.js";
import {
  blockDojoMcpSkillBusExecution,
  createInProcessDojoMcpSkillBus,
  createLegacyDojoTenantContext,
  type DojoSkillBusProofValidation,
} from "../../src/dojo/mcp/skill_bus.js";
import type { DojoTenantContext } from "../../src/dojo/mcp/execution_policy_gate.js";
import { verifiedProofEvidenceInput } from "./dojo_test_fixtures.js";

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

  it("blocks ambiguous tool names instead of resolving by list order", async () => {
    const first = skillFixture("workspace-a", "Open details");
    const second = skillFixture("workspace-a", "Save invoice");
    const bus = createInProcessDojoMcpSkillBus({ listSkills: () => [first, second], env: manifestEnv() });

    await expect(bus.resolveTool({
      tenant: tenant("workspace-a"),
      tool_name: first.published_tool_name!,
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["dojo_mcp_tool_ambiguous"],
    }));
  });

  it("dispatches only after proof validation and keeps dry runs side-effect free", async () => {
    const skill = skillFixture("workspace-a", "Open details");
    const proof = issueDojoProofCapsule(skill, "run_workflow", {
      context_claims: { workspace_verified: true },
      ...verifiedProofEvidenceInput(skill),
      substrate_claim: "mcp",
      now: "2026-06-11T00:00:00.000Z",
    });
    const validations: Array<{ capsule_id: string; requested_action: string }> = [];
    const executions: string[] = [];
    const bus = createInProcessDojoMcpSkillBus({
      listSkills: () => [skill],
      env: manifestEnv(),
      validateProof: ({ proof_capsule, requested_action }): DojoSkillBusProofValidation => {
        validations.push({ capsule_id: proof_capsule.capsule_id, requested_action });
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
      requested_action: "run_workflow",
      args: { client_id: "client-a" },
      proof_capsule: proof,
      dry_run: true,
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      status: "allowed",
      dry_run: true,
      validation: expect.objectContaining({ ok: true }),
    }));
    expect(validations).toEqual([{ capsule_id: proof.capsule_id, requested_action: "run_workflow" }]);
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

  it("requires proof from full manifest constraints even when passport metadata is stale", async () => {
    const baseSkill = skillFixture("workspace-a", "Open details");
    const skill = {
      ...baseSkill,
      skill_passport: {
        ...baseSkill.skill_passport,
        proof_required: false,
      },
    };
    const bus = createInProcessDojoMcpSkillBus({ listSkills: () => [skill], env: manifestEnv() });

    await expect(bus.listCompetencies({ tenant: tenant("workspace-a") })).resolves.toEqual([
      expect.objectContaining({
        skill_id: skill.skill_id,
        proof_required: true,
        mcp_skill_manifest: expect.objectContaining({
          proof: expect.objectContaining({ required: true }),
        }),
      }),
    ]);
    await expect(bus.dispatch({
      tenant: tenant("workspace-a"),
      tool_name: skill.published_tool_name!,
      args: {},
      dry_run: true,
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      blocked_by: ["dojo_proof_capsule_required"],
    }));
  });

  it("blocks proofs that are not bound to the resolved skill manifest before execution", async () => {
    const skillA = skillFixture("workspace-a", "Open details");
    const skillB = reidentifiedSkill(skillFixture("workspace-a", "Save invoice"), "save_invoice");
    const proofForA = issueDojoProofCapsule(skillA, "run_workflow", {
      context_claims: { workspace_verified: true },
      ...verifiedProofEvidenceInput(skillA),
      substrate_claim: "mcp",
      now: "2026-06-11T00:00:00.000Z",
    });
    const validations: string[] = [];
    const executions: string[] = [];
    const bus = createInProcessDojoMcpSkillBus({
      listSkills: () => [skillA, skillB],
      env: manifestEnv(),
      validateProof: ({ proof_capsule }): DojoSkillBusProofValidation => {
        validations.push(proof_capsule.capsule_id);
        return { ok: true, status: "allowed", blocked_by: [] };
      },
      executeTool: ({ tool_name }) => {
        executions.push(tool_name);
        return { ok: true };
      },
    });

    await expect(bus.dispatch({
      tenant: tenant("workspace-a"),
      tool_name: skillB.published_tool_name!,
      args: {},
      proof_capsule: proofForA,
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      blocked_by: expect.arrayContaining(["dojo_mcp_proof_skill_mismatch"]),
    }));
    expect(validations).toEqual([]);
    expect(executions).toEqual([]);
  });

  it("propagates executor-level blocks without treating them as successful tool results", async () => {
    const skill = skillFixture("workspace-a", "Open details");
    const proof = issueDojoProofCapsule(skill, "run_workflow", {
      context_claims: { workspace_verified: true },
      ...verifiedProofEvidenceInput(skill),
      substrate_claim: "mcp",
      now: "2026-06-11T00:00:00.000Z",
    });
    const bus = createInProcessDojoMcpSkillBus({
      listSkills: () => [skill],
      env: manifestEnv(),
      validateProof: (): DojoSkillBusProofValidation => ({ ok: true, status: "allowed", blocked_by: [] }),
      executeTool: () => blockDojoMcpSkillBusExecution(["proof_capsule_replay_detected"], {
        ok: false,
        status: "blocked",
        blocked_by: ["proof_capsule_replay_detected"],
        error_codes: ["proof_capsule_replay_detected"],
      }),
    });

    await expect(bus.dispatch({
      tenant: tenant("workspace-a"),
      tool_name: skill.published_tool_name!,
      requested_action: "run_workflow",
      args: {},
      proof_capsule: proof,
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["proof_capsule_replay_detected"],
      validation: expect.objectContaining({
        ok: false,
        error_codes: ["proof_capsule_replay_detected"],
      }),
    }));
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

function reidentifiedSkill(skill: DojoSkill, suffix: string): DojoSkill {
  const skillId = `${skill.skill_id}_${suffix}`;
  const workflowId = `${skill.workflow_id}_${suffix}`;
  const licenseId = `${skill.permission_license.license_id}_${suffix}`;
  const toolName = `${skill.published_tool_name ?? skill.private_tool_manifest?.tool_name ?? "synthi_app_skill"}_${suffix}`;
  return {
    ...skill,
    skill_id: skillId,
    workflow_id: workflowId,
    workflow_graph_id: `${skill.workflow_graph_id}_${suffix}`,
    vivarium_id: `${skill.vivarium_id}_${suffix}`,
    skill_cortex: {
      ...skill.skill_cortex,
      skill_id: skillId,
      workflow_id: workflowId,
      workflow_graph_id: `${skill.skill_cortex.workflow_graph_id}_${suffix}`,
    },
    checkride: {
      ...skill.checkride,
      skill_id: skillId,
      workflow_id: workflowId,
    },
    permission_license: {
      ...skill.permission_license,
      skill_id: skillId,
      license_id: licenseId,
    },
    assurance_case: {
      ...skill.assurance_case,
      skill_id: skillId,
    },
    skill_passport: {
      ...skill.skill_passport,
      skill_id: skillId,
      license_id: licenseId,
      passport_id: `${skill.skill_passport.passport_id}_${suffix}`,
    },
    training_report: {
      ...skill.training_report,
      skill_id: skillId,
      workflow_id: workflowId,
    },
    published_tools: [toolName],
    published_tool_name: toolName,
    ...(skill.private_tool_manifest
      ? {
        private_tool_manifest: {
          ...skill.private_tool_manifest,
          tool_name: toolName,
        },
      }
      : {}),
  };
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
