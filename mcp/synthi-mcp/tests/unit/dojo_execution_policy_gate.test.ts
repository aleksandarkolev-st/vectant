import { describe, expect, it } from "vitest";
import {
  createDojoExecutionPolicyGate,
  type DojoExecutionPolicyInput,
  type DojoPublishedSkillBinding,
  type DojoTenantContext,
} from "../../src/dojo/mcp/execution_policy_gate.js";

describe("Dojo execution policy gate", () => {
  it("fails closed in production when published skill mapping cannot be resolved", async () => {
    const gate = createDojoExecutionPolicyGate({
      env: productionEnv(),
      resolvePublishedSkill: () => ({ status: "unknown" }),
    });

    await expect(gate.evaluate(input({
      entrypoint: "private_tool",
      tool_name: "synthi_app_save_invoice",
    }))).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      enforcement_mode: "production",
      blocked_by: ["published_skill_mapping_unknown"],
      required_path: "synthi_dojo_run_with_proof_capsule",
    }));
  });

  it("allows development compatibility behavior while declaring development mode", async () => {
    const gate = createDojoExecutionPolicyGate({
      env: {},
      resolvePublishedSkill: () => publishedBinding(),
    });

    await expect(gate.evaluate(input({
      entrypoint: "private_tool",
      tool_name: "synthi_app_save_invoice",
    }))).resolves.toEqual(expect.objectContaining({
      ok: true,
      status: "allowed",
      enforcement_mode: "development",
      skill_id: "dojo_save_invoice",
      blocked_by: [],
    }));
  });

  it("blocks production private tool entrypoint without validated Dojo dispatcher context", async () => {
    const gate = createDojoExecutionPolicyGate({
      env: productionEnv(),
      resolvePublishedSkill: () => publishedBinding(),
    });

    await expect(gate.evaluate(input({
      entrypoint: "private_tool",
      tool_name: "synthi_app_save_invoice",
    }))).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["direct_entrypoint_for_published_skill", "dojo_proof_capsule_required"],
      required_path: "synthi_dojo_run_with_proof_capsule",
    }));
  });

  it("allows production private tool entrypoint only with validated Dojo dispatcher context and proof", async () => {
    const gate = createDojoExecutionPolicyGate({
      env: productionEnv(),
      resolvePublishedSkill: () => publishedBinding(),
    });

    await expect(gate.evaluate(input({
      entrypoint: "private_tool",
      tool_name: "synthi_app_save_invoice",
      proof_capsule_id: "proof_123",
      validated_dojo_execution_context: true,
    }))).resolves.toEqual(expect.objectContaining({
      ok: true,
      status: "allowed",
      enforcement_mode: "production",
      skill_id: "dojo_save_invoice",
      blocked_by: [],
    }));
  });

  it("requires proof for production skill bus calls to published skills", async () => {
    const gate = createDojoExecutionPolicyGate({
      env: productionEnv(),
      resolvePublishedSkill: () => publishedBinding(),
    });

    await expect(gate.evaluate(input({
      entrypoint: "dojo_skill_bus",
      tool_name: "synthi_dojo_save_invoice",
    }))).resolves.toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      blocked_by: ["dojo_proof_capsule_required"],
    }));

    await expect(gate.evaluate(input({
      entrypoint: "dojo_skill_bus",
      tool_name: "synthi_dojo_save_invoice",
      proof_capsule_id: "proof_123",
    }))).resolves.toEqual(expect.objectContaining({
      ok: true,
      status: "allowed",
      blocked_by: [],
    }));
  });

  it("allows known unpublished entrypoints in production", async () => {
    const gate = createDojoExecutionPolicyGate({
      env: productionEnv(),
      resolvePublishedSkill: () => ({ status: "unpublished" }),
    });

    await expect(gate.evaluate(input({
      entrypoint: "private_tool",
      tool_name: "synthi_app_non_dojo_tool",
    }))).resolves.toEqual(expect.objectContaining({
      ok: true,
      status: "allowed",
      enforcement_mode: "production",
      blocked_by: [],
    }));
  });

  it("blocks production when enforcement config contains invalid flag values", async () => {
    const gate = createDojoExecutionPolicyGate({
      env: { ...productionEnv(), SYNTHI_DOJO_PRODUCTION_ENFORCEMENT: "maybe" },
      resolvePublishedSkill: () => publishedBinding(),
    });

    await expect(gate.evaluate(input({
      entrypoint: "dojo_skill_bus",
      tool_name: "synthi_dojo_save_invoice",
      proof_capsule_id: "proof_123",
    }))).resolves.toEqual(expect.objectContaining({
      ok: false,
      blocked_by: ["dojo_enforcement_config_invalid"],
    }));
  });
});

function input(overrides: Partial<DojoExecutionPolicyInput>): DojoExecutionPolicyInput {
  return {
    tenant: tenant(),
    entrypoint: "private_tool",
    requested_action: "run_workflow",
    ...overrides,
  };
}

function tenant(): DojoTenantContext {
  return {
    tenant_id: "tenant-a",
    organization_id: "org-a",
    workspace_id: "workspace-a",
    actor_id: "agent-a",
    actor_type: "agent",
    roles: ["agent"],
    request_id: "req-a",
    correlation_id: "corr-a",
  };
}

function publishedBinding(): DojoPublishedSkillBinding {
  return {
    status: "published",
    skill_id: "dojo_save_invoice",
    workflow_id: "wf_save_invoice",
    tool_name: "synthi_app_save_invoice",
  };
}

function productionEnv(): NodeJS.ProcessEnv {
  return {
    SYNTHI_DOJO_PRODUCTION_ENFORCEMENT: "1",
  };
}
