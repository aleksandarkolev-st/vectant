import { describe, expect, it } from "vitest";
import { buildDojoSkill, issueDojoProofCapsule, type DojoSkill } from "../../src/browser/dojo.js";
import { generatePrivateWorkflowToolManifest } from "../../src/browser/private_tool_manifest.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
import { validateDojoMcpSkillManifest } from "../../src/dojo/mcp/manifest_signing.js";
import type { DojoApiBackedMcpTool } from "../../src/dojo/api/api_tool_compiler.js";
import { createDojoProofCapsuleService } from "../../src/dojo/proof/capsule_service.js";
import {
  blockDojoMcpSkillBusExecution,
  createInMemoryDojoMcpSkillBusRateLimiter,
  createInProcessDojoMcpSkillBus,
  createLegacyDojoTenantContext,
  validateDojoMcpTenantContext,
  type DojoSkillBusProofValidation,
} from "../../src/dojo/mcp/skill_bus.js";
import { InMemoryDojoSkillStore } from "../../src/browser/dojo_store.js";
import type { DojoTenantContext } from "../../src/dojo/mcp/execution_policy_gate.js";
import type {
  DojoAuditEventInput,
  DojoAuditEventRecord,
  DojoAuditStore,
} from "../../src/dojo/store/interfaces.js";
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

  it("fails closed before skill lookup or dispatch side effects when tenant context is incomplete", async () => {
    const invalidCaller = invalidTenant("workspace-a");
    const auditEvents: DojoAuditEventRecord[] = [];
    const sideEffects: string[] = [];
    const bus = createInProcessDojoMcpSkillBus({
      listSkills: () => {
        sideEffects.push("listSkills");
        throw new Error("skill lookup must not run");
      },
      env: manifestEnv(),
      rateLimiter: {
        evaluate: () => {
          sideEffects.push("rateLimiter");
          return { ok: true, blocked_by: [] };
        },
      },
      validateProof: () => {
        sideEffects.push("validateProof");
        return { ok: true, status: "allowed", blocked_by: [] };
      },
      executeTool: () => {
        sideEffects.push("executeTool");
        return { ok: true };
      },
      auditStore: memoryAuditStore(auditEvents),
    });
    const expectedBlockedBy = [
      "dojo_mcp_tenant_required",
      "dojo_mcp_organization_required",
      "dojo_mcp_actor_required",
      "dojo_mcp_actor_type_invalid",
      "dojo_mcp_roles_invalid",
      "dojo_mcp_request_required",
      "dojo_mcp_correlation_required",
    ];

    expect(validateDojoMcpTenantContext(invalidCaller)).toEqual(expectedBlockedBy);
    await expect(bus.listCompetencies({ tenant: invalidCaller })).resolves.toEqual([]);
    await expect(bus.resolveTool({
      tenant: invalidCaller,
      tool_name: "synthi_app_open_details",
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: expectedBlockedBy,
      tool_name: "synthi_app_open_details",
    }));
    await expect(bus.dispatch({
      tenant: invalidCaller,
      tool_name: "synthi_app_open_details",
      args: {},
      dry_run: false,
    })).resolves.toEqual({
      ok: false,
      status: "blocked",
      dry_run: false,
      blocked_by: expectedBlockedBy,
      tool_name: "synthi_app_open_details",
    });
    expect(sideEffects).toEqual([]);
    expect(auditEvents).toEqual([]);
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

  it("resolves published API-backed tool manifests by API tool name", async () => {
    const baseSkill = skillFixture("workspace-a", "Save invoice");
    const apiTool = apiBackedToolFixture(baseSkill, { tool_version: "2.3.4" });
    const skill = withPublishedApiBackedTool(baseSkill, apiTool);
    const bus = createInProcessDojoMcpSkillBus({ listSkills: () => [skill], env: manifestEnv() });

    const competencies = await bus.listCompetencies({ tenant: tenant("workspace-a") });
    expect(competencies).toEqual([
      expect.objectContaining({
        skill_id: skill.skill_id,
        execution_substrates: expect.arrayContaining(["api"]),
        api_backed_mcp_tools: [
          expect.objectContaining({
            tool_name: apiTool.tool_name,
            schema_digest: apiTool.schema_digest,
          }),
        ],
      }),
    ]);

    const resolved = await bus.resolveTool({
      tenant: tenant("workspace-a"),
      tool_name: apiTool.tool_name,
      tool_version: apiTool.tool_version,
    });
    expect(resolved).toEqual(expect.objectContaining({
      ok: true,
      status: "resolved",
      skill_id: skill.skill_id,
      tool_name: apiTool.tool_name,
      tool_version: apiTool.tool_version,
      mcp_skill_manifest: expect.objectContaining({
        tool: expect.objectContaining({
          name: apiTool.tool_name,
          version: apiTool.tool_version,
          kind: "api_backed",
          api_backed_mcp_tool_digest: expect.stringMatching(/^sha256:/),
          backing_private_tool_manifest_digest: null,
          schema_digest: apiTool.schema_digest,
        }),
      }),
    }));
    expect(validateDojoMcpSkillManifest(resolved.mcp_skill_manifest!, {
      env: manifestEnv(),
      expected_skill_id: skill.skill_id,
      expected_tool_name: apiTool.tool_name,
    })).toEqual(expect.objectContaining({
      ok: true,
      blocked_by: [],
      tool_name: apiTool.tool_name,
    }));
  });

  it("dispatches published API-backed tools with canonical resolved tool context", async () => {
    const baseSkill = skillFixture("workspace-a", "Submit invoice");
    const apiTool = apiBackedToolFixture(baseSkill, { tool_name: "synthi_api_submit_invoice", tool_version: "2.0.1" });
    const skill = withPublishedApiBackedTool(baseSkill, apiTool);
    const proof = issueDojoProofCapsule(skill, "run_workflow", {
      context_claims: { workspace_verified: true },
      ...verifiedProofEvidenceInput(skill),
      substrate_claim: "api",
      now: "2026-06-11T00:00:00.000Z",
    });
    const executions: Array<{
      tool_name: string;
      resolved_kind: string;
      resolved_version: string;
      api_tool_name?: string;
      api_tool_digest?: string;
    }> = [];
    const bus = createInProcessDojoMcpSkillBus({
      listSkills: () => [skill],
      env: manifestEnv(),
      proofConsumptionMode: "external_executor",
      validateProof: (): DojoSkillBusProofValidation => ({ ok: true, status: "allowed", blocked_by: [] }),
      executeTool: ({ tool_name, resolved_tool, api_backed_mcp_tool }) => {
        executions.push({
          tool_name,
          resolved_kind: resolved_tool.kind,
          resolved_version: resolved_tool.tool_version,
          api_tool_name: api_backed_mcp_tool?.tool_name,
          api_tool_digest: api_backed_mcp_tool?.schema_digest,
        });
        return {
          ok: true,
          tool_name,
          resolved_tool_kind: resolved_tool.kind,
          api_backed_tool_name: api_backed_mcp_tool?.tool_name,
        };
      },
    });

    await expect(bus.dispatch({
      tenant: tenant("workspace-a"),
      tool_name: apiTool.tool_name,
      tool_version: apiTool.tool_version,
      requested_action: "run_workflow",
      args: { request: { invoice_id: "invoice-123" }, idempotency_key: "idem-123" },
      proof_capsule: proof,
      dry_run: false,
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      dry_run: false,
      tool_name: apiTool.tool_name,
      resolution: expect.objectContaining({
        tool_name: apiTool.tool_name,
        tool_version: apiTool.tool_version,
        resolved_tool: expect.objectContaining({
          kind: "api_backed",
          tool_name: apiTool.tool_name,
          tool_version: apiTool.tool_version,
        }),
        api_backed_mcp_tool: expect.objectContaining({
          tool_name: apiTool.tool_name,
          schema_digest: apiTool.schema_digest,
        }),
      }),
      result: expect.objectContaining({
        ok: true,
        tool_name: apiTool.tool_name,
        resolved_tool_kind: "api_backed",
        api_backed_tool_name: apiTool.tool_name,
      }),
    }));
    expect(executions).toEqual([
      {
        tool_name: apiTool.tool_name,
        resolved_kind: "api_backed",
        resolved_version: apiTool.tool_version,
        api_tool_name: apiTool.tool_name,
        api_tool_digest: apiTool.schema_digest,
      },
    ]);
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

  it("resolves tenant-visible tools without cross-workspace duplicate interference", async () => {
    const workspaceA = skillFixture("workspace-a", "Open details");
    const workspaceB = skillFixture("workspace-b", "Open details");
    const bus = createInProcessDojoMcpSkillBus({ listSkills: () => [workspaceB, workspaceA], env: manifestEnv() });

    expect(workspaceB.published_tool_name).toBe(workspaceA.published_tool_name);
    await expect(bus.resolveTool({
      tenant: tenant("workspace-a"),
      tool_name: workspaceA.published_tool_name!,
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      status: "resolved",
      skill_id: workspaceA.skill_id,
      workflow_id: workspaceA.workflow_id,
      tool_name: workspaceA.published_tool_name,
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
      proofConsumptionMode: "external_executor",
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

  it("fails closed when live proof dispatch has validation but no proof consumer", async () => {
    const skill = skillFixture("workspace-a", "Open details");
    const proof = issueDojoProofCapsule(skill, "run_workflow", {
      context_claims: { workspace_verified: true },
      ...verifiedProofEvidenceInput(skill),
      substrate_claim: "mcp",
      now: "2026-06-11T00:00:00.000Z",
    });
    const executions: string[] = [];
    const bus = createInProcessDojoMcpSkillBus({
      listSkills: () => [skill],
      env: manifestEnv(),
      validateProof: (): DojoSkillBusProofValidation => ({ ok: true, status: "allowed", blocked_by: [] }),
      executeTool: ({ tool_name }) => {
        executions.push(tool_name);
        return { ok: true, tool_name };
      },
    });

    await expect(bus.dispatch({
      tenant: tenant("workspace-a"),
      tool_name: skill.published_tool_name!,
      requested_action: "run_workflow",
      args: {},
      proof_capsule: proof,
      dry_run: true,
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      dry_run: true,
      validation: expect.objectContaining({ ok: true }),
    }));

    await expect(bus.dispatch({
      tenant: tenant("workspace-a"),
      tool_name: skill.published_tool_name!,
      requested_action: "run_workflow",
      args: {},
      proof_capsule: proof,
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["dojo_mcp_skill_bus_proof_consumer_unconfigured"],
      validation: expect.objectContaining({ ok: true }),
    }));
    expect(executions).toEqual([]);
  });

  it("can validate dispatch proofs through the reusable proof capsule service", async () => {
    const skill = skillFixture("workspace-a", "Open details");
    const caller = tenant("workspace-a");
    const proofStore = new InMemoryDojoSkillStore();
    const proofService = createDojoProofCapsuleService({ proof_store: proofStore });
    const issued = await proofService.issue({
      tenant: caller,
      skill,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      ...verifiedProofEvidenceInput(skill, { tenant_id: caller.tenant_id }),
      substrate_claim: "mcp",
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    expect(issued.ok).toBe(true);
    const executions: string[] = [];
    const bus = createInProcessDojoMcpSkillBus({
      listSkills: () => [skill],
      env: manifestEnv(),
      proofService,
      now: () => new Date("2026-06-11T00:01:00.000Z"),
      executeTool: ({ tool_name }) => {
        executions.push(tool_name);
        return { ok: true, tool_name };
      },
    });

    await expect(bus.dispatch({
      tenant: caller,
      tool_name: skill.published_tool_name!,
      requested_action: "run_workflow",
      args: {},
      proof_capsule: issued.proof_capsule,
      dry_run: true,
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      dry_run: true,
      validation: expect.objectContaining({
        ok: true,
        status: "allowed",
      }),
    }));
    expect(proofStore.getProofRecord(issued.proof_capsule!.capsule_id)?.status).toBe("issued");

    await expect(proofService.consume({
      tenant: caller,
      capsule_id: issued.proof_capsule!.capsule_id,
      run_id: "run-a",
      now: "2026-06-11T00:02:00.000Z",
    })).resolves.toEqual(expect.objectContaining({ ok: true, status: "used" }));

    await expect(bus.dispatch({
      tenant: caller,
      tool_name: skill.published_tool_name!,
      requested_action: "run_workflow",
      args: {},
      proof_capsule: issued.proof_capsule,
      dry_run: true,
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      blocked_by: ["proof_capsule_replay_detected"],
      validation: expect.objectContaining({
        ok: false,
        error_codes: ["proof_capsule_replay_detected"],
      }),
    }));
    expect(executions).toEqual([]);
  });

  it("consumes proof before non-dry dispatch through the reusable proof capsule service", async () => {
    const skill = skillFixture("workspace-a", "Open details");
    const caller = tenant("workspace-a");
    const proofStore = new InMemoryDojoSkillStore();
    const proofService = createDojoProofCapsuleService({ proof_store: proofStore });
    const issued = await proofService.issue({
      tenant: caller,
      skill,
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      ...verifiedProofEvidenceInput(skill, { tenant_id: caller.tenant_id }),
      substrate_claim: "mcp",
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    expect(issued.ok).toBe(true);
    const executions: string[] = [];
    const auditEvents: DojoAuditEventRecord[] = [];
    const bus = createInProcessDojoMcpSkillBus({
      listSkills: () => [skill],
      env: manifestEnv(),
      proofService,
      auditStore: memoryAuditStore(auditEvents),
      now: () => new Date("2026-06-11T00:02:00.000Z"),
      executeTool: ({ tool_name }) => {
        executions.push(tool_name);
        return { ok: true, tool_name };
      },
    });

    const dryRun = await bus.dispatch({
      tenant: caller,
      tool_name: skill.published_tool_name!,
      requested_action: "run_workflow",
      args: {},
      proof_capsule: issued.proof_capsule,
      dry_run: true,
    });
    expect(dryRun).toEqual(expect.objectContaining({
      ok: true,
      dry_run: true,
    }));
    expect("proof_consume" in dryRun).toBe(false);
    expect(proofStore.getProofRecord(issued.proof_capsule!.capsule_id)?.status).toBe("issued");

    await expect(bus.dispatch({
      tenant: caller,
      tool_name: skill.published_tool_name!,
      requested_action: "run_workflow",
      args: {},
      proof_capsule: issued.proof_capsule,
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      dry_run: false,
      proof_consume: expect.objectContaining({ ok: true, status: "used" }),
      result: expect.objectContaining({ ok: true, tool_name: skill.published_tool_name }),
    }));
    expect(proofStore.getProofRecord(issued.proof_capsule!.capsule_id)?.status).toBe("used");

    const replay = await bus.dispatch({
      tenant: caller,
      tool_name: skill.published_tool_name!,
      requested_action: "run_workflow",
      args: {},
      proof_capsule: issued.proof_capsule,
    });
    expect(replay).toEqual(expect.objectContaining({
      ok: false,
      blocked_by: ["proof_capsule_replay_detected"],
      validation: expect.objectContaining({
        ok: false,
        error_codes: ["proof_capsule_replay_detected"],
      }),
    }));
    expect(executions).toEqual([skill.published_tool_name]);
    expect(auditEvents).toEqual([
      expect.objectContaining({
        audit_event_id: "audit-1",
        event_type: "mcp_tool_invocation_allowed",
        details: expect.objectContaining({
          proof_validation: expect.objectContaining({ ok: true, status: "allowed" }),
        }),
      }),
      expect.objectContaining({
        audit_event_id: "audit-2",
        event_type: "mcp_tool_invocation_allowed",
        details: expect.objectContaining({
          proof_capsule_id: issued.proof_capsule!.capsule_id,
          proof_validation: expect.objectContaining({ ok: true, status: "allowed" }),
          proof_consume: expect.objectContaining({
            ok: true,
            status: "used",
            blocked_by: [],
            capsule_id: issued.proof_capsule!.capsule_id,
            first_used_at: "2026-06-11T00:02:00.000Z",
          }),
        }),
      }),
      expect.objectContaining({
        audit_event_id: "audit-3",
        event_type: "mcp_tool_invocation_blocked",
        details: expect.objectContaining({
          blocked_by: ["proof_capsule_replay_detected"],
          proof_validation: expect.objectContaining({
            ok: false,
            status: "blocked",
            blocked_by: ["proof_capsule_replay_detected"],
            error_codes: ["proof_capsule_replay_detected"],
          }),
        }),
      }),
    ]);
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
      proofConsumptionMode: "external_executor",
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

  it("fails closed when dispatch extension points throw", async () => {
    const skill = skillFixture("workspace-a", "Open details");
    const proof = issueDojoProofCapsule(skill, "run_workflow", {
      context_claims: { workspace_verified: true },
      ...verifiedProofEvidenceInput(skill),
      substrate_claim: "mcp",
      now: "2026-06-11T00:00:00.000Z",
    });
    const rateLimitBus = createInProcessDojoMcpSkillBus({
      listSkills: () => [skill],
      env: manifestEnv(),
      rateLimiter: {
        evaluate: () => {
          throw new Error("rate limiter unavailable");
        },
      },
      validateProof: (): DojoSkillBusProofValidation => ({ ok: true, status: "allowed", blocked_by: [] }),
      executeTool: () => ({ ok: true }),
    });
    await expect(rateLimitBus.dispatch({
      tenant: tenant("workspace-a"),
      tool_name: skill.published_tool_name!,
      requested_action: "run_workflow",
      args: {},
      proof_capsule: proof,
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["dojo_mcp_rate_limiter_failed"],
    }));

    const proofValidatorBus = createInProcessDojoMcpSkillBus({
      listSkills: () => [skill],
      env: manifestEnv(),
      validateProof: () => {
        throw new Error("proof validator unavailable");
      },
      executeTool: () => ({ ok: true }),
    });
    await expect(proofValidatorBus.dispatch({
      tenant: tenant("workspace-a"),
      tool_name: skill.published_tool_name!,
      requested_action: "run_workflow",
      args: {},
      proof_capsule: proof,
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["dojo_mcp_skill_bus_proof_validator_failed"],
      validation: expect.objectContaining({
        ok: false,
        error_codes: ["dojo_mcp_skill_bus_proof_validator_failed"],
      }),
    }));

    const auditEvents: DojoAuditEventRecord[] = [];
    const executorBus = createInProcessDojoMcpSkillBus({
      listSkills: () => [skill],
      env: manifestEnv(),
      auditStore: memoryAuditStore(auditEvents),
      proofConsumptionMode: "external_executor",
      validateProof: (): DojoSkillBusProofValidation => ({ ok: true, status: "allowed", blocked_by: [] }),
      executeTool: () => {
        throw new Error("executor unavailable");
      },
    });
    await expect(executorBus.dispatch({
      tenant: tenant("workspace-a"),
      tool_name: skill.published_tool_name!,
      requested_action: "run_workflow",
      args: {},
      proof_capsule: proof,
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["dojo_mcp_skill_executor_failed"],
      validation: expect.objectContaining({
        ok: false,
        error_codes: ["dojo_mcp_skill_executor_failed"],
      }),
      audit_event_id: "audit-1",
    }));
    expect(auditEvents).toEqual([
      expect.objectContaining({
        event_type: "mcp_tool_invocation_blocked",
        details: expect.objectContaining({
          blocked_by: ["dojo_mcp_skill_executor_failed"],
          proof_capsule_id: proof.capsule_id,
          proof_validation: expect.objectContaining({
            ok: false,
            error_codes: ["dojo_mcp_skill_executor_failed"],
          }),
        }),
      }),
    ]);
  });

  it("rate-limits dispatch by configured scope before proof validation or execution", async () => {
    const skill = skillFixture("workspace-a", "Open details");
    const proof = issueDojoProofCapsule(skill, "run_workflow", {
      context_claims: { workspace_verified: true },
      ...verifiedProofEvidenceInput(skill),
      substrate_claim: "mcp",
      now: "2026-06-11T00:00:00.000Z",
    });
    const now = new Date("2026-06-11T00:00:00.000Z");
    const validations: string[] = [];
    const executions: string[] = [];
    const bus = createInProcessDojoMcpSkillBus({
      listSkills: () => [skill],
      env: manifestEnv(),
      proofConsumptionMode: "external_executor",
      rateLimiter: createInMemoryDojoMcpSkillBusRateLimiter({
        now: () => now,
        rules: [{
          rule_id: "one-call-per-skill-action",
          scope: ["tenant", "workspace", "skill", "action"],
          max_calls: 1,
          window_ms: 60_000,
        }],
      }),
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
      requested_action: "run_workflow",
      args: {},
      proof_capsule: proof,
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
    }));

    await expect(bus.dispatch({
      tenant: tenant("workspace-a"),
      tool_name: skill.published_tool_name!,
      requested_action: "run_workflow",
      args: {},
      proof_capsule: proof,
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      blocked_by: ["dojo_mcp_rate_limit_exceeded"],
      rate_limit: expect.objectContaining({
        rule_id: "one-call-per-skill-action",
        scope_key: expect.stringContaining(`skill:${skill.skill_id}`),
        retry_after_ms: 60_000,
      }),
    }));
    expect(validations).toEqual([proof.capsule_id]);
    expect(executions).toEqual([skill.published_tool_name]);
  });

  it("keeps rate-limit scopes independent and does not count dry runs unless configured", async () => {
    const skill = skillFixture("workspace-a", "Open details");
    const proof = issueDojoProofCapsule(skill, "run_workflow", {
      context_claims: { workspace_verified: true },
      ...verifiedProofEvidenceInput(skill),
      substrate_claim: "mcp",
      now: "2026-06-11T00:00:00.000Z",
    });
    const now = new Date("2026-06-11T00:00:00.000Z");
    const bus = createInProcessDojoMcpSkillBus({
      listSkills: () => [skill],
      env: manifestEnv(),
      proofConsumptionMode: "external_executor",
      rateLimiter: createInMemoryDojoMcpSkillBusRateLimiter({
        now: () => now,
        rules: [{
          rule_id: "one-call-per-actor",
          scope: ["tenant", "workspace", "actor"],
          max_calls: 1,
          window_ms: 60_000,
        }],
      }),
      validateProof: (): DojoSkillBusProofValidation => ({ ok: true, status: "allowed", blocked_by: [] }),
      executeTool: ({ tenant: caller }) => ({ ok: true, actor_id: caller.actor_id }),
    });

    await expect(bus.dispatch({
      tenant: tenant("workspace-a"),
      tool_name: skill.published_tool_name!,
      args: {},
      proof_capsule: proof,
      dry_run: true,
    })).resolves.toEqual(expect.objectContaining({ ok: true, dry_run: true }));
    await expect(bus.dispatch({
      tenant: tenant("workspace-a"),
      tool_name: skill.published_tool_name!,
      args: {},
      proof_capsule: proof,
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      result: expect.objectContaining({ actor_id: "agent-a" }),
    }));
    await expect(bus.dispatch({
      tenant: tenant("workspace-a"),
      tool_name: skill.published_tool_name!,
      args: {},
      proof_capsule: proof,
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      blocked_by: ["dojo_mcp_rate_limit_exceeded"],
    }));
    await expect(bus.dispatch({
      tenant: tenant("workspace-a", ["agent"], "agent-b"),
      tool_name: skill.published_tool_name!,
      args: {},
      proof_capsule: proof,
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      result: expect.objectContaining({ actor_id: "agent-b" }),
    }));
  });

  it("emits structured audit events for blocked and allowed MCP tool dispatches", async () => {
    const skill = skillFixture("workspace-a", "Open details");
    const proof = issueDojoProofCapsule(skill, "run_workflow", {
      context_claims: { workspace_verified: true },
      ...verifiedProofEvidenceInput(skill),
      substrate_claim: "mcp",
      now: "2026-06-11T00:00:00.000Z",
    });
    const auditEvents: DojoAuditEventRecord[] = [];
    const bus = createInProcessDojoMcpSkillBus({
      listSkills: () => [skill],
      env: manifestEnv(),
      auditStore: memoryAuditStore(auditEvents),
      now: () => new Date("2026-06-11T00:03:00.000Z"),
      proofConsumptionMode: "external_executor",
      validateProof: (): DojoSkillBusProofValidation => ({ ok: true, status: "allowed", blocked_by: [] }),
      executeTool: ({ tool_name }) => ({ ok: true, tool_name }),
    });

    await expect(bus.dispatch({
      tenant: tenant("workspace-a"),
      tool_name: skill.published_tool_name!,
      requested_action: "run_workflow",
      args: {},
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      blocked_by: ["dojo_proof_capsule_required"],
      audit_event_id: "audit-1",
    }));
    await expect(bus.dispatch({
      tenant: tenant("workspace-a"),
      tool_name: skill.published_tool_name!,
      requested_action: "run_workflow",
      args: {},
      proof_capsule: proof,
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      audit_event_id: "audit-2",
    }));

    expect(auditEvents).toEqual([
      expect.objectContaining({
        audit_event_id: "audit-1",
        tenant_id: "tenant-a",
        workspace_id: "workspace-a",
        actor: { actor_id: "agent-a", actor_type: "agent" },
        event_type: "mcp_tool_invocation_blocked",
        entity_kind: "mcp_tool_invocation",
        entity_id: skill.published_tool_name,
        details: expect.objectContaining({
          skill_id: skill.skill_id,
          workflow_id: skill.workflow_id,
          tool_name: skill.published_tool_name,
          requested_action: "run_workflow",
          dry_run: false,
          blocked_by: ["dojo_proof_capsule_required"],
        }),
      }),
      expect.objectContaining({
        audit_event_id: "audit-2",
        event_type: "mcp_tool_invocation_allowed",
        details: expect.objectContaining({
          skill_id: skill.skill_id,
          tool_name: skill.published_tool_name,
          proof_capsule_id: proof.capsule_id,
          manifest_id: expect.stringMatching(/^dojo_mcp_manifest_/),
          blocked_by: [],
        }),
      }),
    ]);
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

function apiBackedToolFixture(skill: DojoSkill, overrides: Partial<DojoApiBackedMcpTool> = {}): DojoApiBackedMcpTool {
  const base: DojoApiBackedMcpTool = {
    schema_version: "synthi.dojo.apiBackedMcpTool.v1",
    tool_name: "synthi_api_save_invoice",
    tool_version: "1.0.0",
    candidate_id: "api_candidate_save_invoice",
    method: "POST",
    path: "/api/invoices",
    skill_id: skill.skill_id,
    license_id: skill.permission_license.license_id,
    license_version: skill.permission_license.license_version,
    action: "run_workflow",
    auth_scope: "invoice:write",
    proof_required: true,
    proof_claim_mapping: { workspace_verified: "tenant.workspace_id" },
    query_schema: null,
    idempotency_key_location: "header",
    rollback_strategy: "compensating_call",
    postcondition: "invoice.status == 'saved'",
    input_schema: { type: "object", additionalProperties: false },
    schema_digest: "sha256:api-tool-schema",
    enforcement: {
      proof_capsule_required: true,
      license_kernel_required: true,
      evidence_write_required: true,
      postcondition_assertion_required: true,
      idempotency_required: true,
    },
  };
  return {
    ...base,
    ...overrides,
    enforcement: {
      ...base.enforcement,
      ...(overrides.enforcement ?? {}),
    },
    proof_claim_mapping: {
      ...base.proof_claim_mapping,
      ...(overrides.proof_claim_mapping ?? {}),
    },
  };
}

function withPublishedApiBackedTool(skill: DojoSkill, apiTool: DojoApiBackedMcpTool): DojoSkill {
  return {
    ...skill,
    published_tools: [...new Set([...skill.published_tools, apiTool.tool_name])],
    api_backed_mcp_tools: [apiTool],
    execution_substrates: [...new Set([...skill.execution_substrates, "api" as const])],
    preferred_substrate: "api",
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

function tenant(workspaceId: string, roles = ["agent"], actorId = "agent-a"): DojoTenantContext {
  return {
    tenant_id: "tenant-a",
    organization_id: "org-a",
    workspace_id: workspaceId,
    actor_id: actorId,
    actor_type: "agent",
    roles,
    request_id: `req-${workspaceId}`,
    correlation_id: `corr-${workspaceId}`,
  };
}

function invalidTenant(workspaceId: string): DojoTenantContext {
  return {
    ...tenant(workspaceId),
    tenant_id: "",
    organization_id: "",
    actor_id: "",
    actor_type: "robot" as never,
    roles: ["agent", ""],
    request_id: "",
    correlation_id: "",
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

function memoryAuditStore(events: DojoAuditEventRecord[]): DojoAuditStore {
  return {
    appendAuditEvent(event: DojoAuditEventInput): DojoAuditEventRecord {
      const record: DojoAuditEventRecord = {
        tenant_id: event.tenant_id,
        workspace_id: event.workspace_id,
        audit_event_id: event.audit_event_id ?? `audit-${events.length + 1}`,
        actor: { ...event.actor },
        event_type: event.event_type,
        request_id: event.request_id,
        correlation_id: event.correlation_id,
        entity_kind: event.entity_kind,
        entity_id: event.entity_id,
        details: { ...(event.details ?? {}) },
        created_at: event.created_at ?? "2026-06-11T00:00:00.000Z",
      };
      events.push(record);
      return record;
    },
    listAuditEvents(): DojoAuditEventRecord[] {
      return [...events];
    },
  };
}
