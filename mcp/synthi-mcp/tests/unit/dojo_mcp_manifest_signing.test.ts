import { describe, expect, it } from "vitest";
import { buildDojoSkill } from "../../src/browser/dojo.js";
import { generatePrivateWorkflowToolManifest } from "../../src/browser/private_tool_manifest.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
import {
  buildDojoMcpSkillManifest,
  validateDojoMcpSkillManifest,
  type DojoMcpSkillManifestV1,
} from "../../src/dojo/mcp/manifest_signing.js";

describe("Dojo MCP skill manifest signing", () => {
  it("builds a stable signed competency manifest from a Dojo skill", () => {
    const skill = skillFixture();
    const env = manifestEnv();
    const first = buildDojoMcpSkillManifest(skill, { env });
    const second = buildDojoMcpSkillManifest(skill, { env });

    expect(first).toEqual(second);
    expect(first).toEqual(expect.objectContaining({
      kind: "dojoMcpSkillManifest",
      schema_version: "synthi.dojo.mcpSkillManifest.v1",
      manifest_id: expect.stringMatching(/^dojo_mcp_manifest_/),
      manifest_digest: expect.stringMatching(/^sha256:/),
      signature: expect.stringMatching(/^hmac-sha256:/),
    }));
    expect(first.skill).toEqual(expect.objectContaining({
      skill_id: skill.skill_id,
      skill_version: skill.skill_version,
      workflow_id: skill.workflow_id,
      workspace_id: "workspace-a",
    }));
    expect(first.tool).toEqual(expect.objectContaining({
      name: skill.published_tool_name,
      direct_call_policy: "blocked_outside_dojo_dispatcher",
      backing_private_tool_manifest_digest: expect.stringMatching(/^sha256:/),
    }));
    expect(first.license.allowed_actions).toContain("observe");
    expect(first.proof.required_context_claims).toContain("workspace_verified");
    expect(validateDojoMcpSkillManifest(first, {
      env,
      expected_skill_id: skill.skill_id,
      expected_tool_name: skill.published_tool_name,
    })).toEqual(expect.objectContaining({
      ok: true,
      blocked_by: [],
      manifest_digest: first.manifest_digest,
    }));
  });

  it("rejects tampered manifest fields and wrong signing keys", () => {
    const skill = skillFixture();
    const env = manifestEnv();
    const manifest = buildDojoMcpSkillManifest(skill, { env });
    const tampered: DojoMcpSkillManifestV1 = {
      ...manifest,
      license: {
        ...manifest.license,
        allowed_actions: [...manifest.license.allowed_actions, "delete"],
      },
    };

    expect(validateDojoMcpSkillManifest(tampered, { env })).toEqual(expect.objectContaining({
      ok: false,
      blocked_by: expect.arrayContaining([
        "dojo_mcp_manifest_digest_mismatch",
        "dojo_mcp_manifest_signature_invalid",
      ]),
    }));
    expect(validateDojoMcpSkillManifest(manifest, {
      env: { ...env, SYNTHI_DOJO_MCP_MANIFEST_SIGNING_KEY: "different-key" },
    })).toEqual(expect.objectContaining({
      ok: false,
      blocked_by: expect.arrayContaining(["dojo_mcp_manifest_signature_invalid"]),
    }));
  });
});

function skillFixture() {
  const workflow = compileWorkflowContract([
    event({
      event_id: "open",
      action: "click",
      element: { role: "button", name: "Open details", source_id: "details.open" },
      locator_candidates: [
        { kind: "role", locator: "page.getByRole(\"button\", { name: \"Open details\" })", confidence: 0.98, reason: "role" },
      ],
    }),
  ]).contract;
  const privateManifest = generatePrivateWorkflowToolManifest(workflow);
  return buildDojoSkill(workflow, {
    workspace_id: "workspace-a",
    now: "2026-06-11T00:00:00.000Z",
    private_tool_manifest: privateManifest,
    published_tool_name: privateManifest.tool_name,
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

function manifestEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SYNTHI_DOJO_MCP_MANIFEST_ISSUER: "unit-test-skill-bus",
    SYNTHI_DOJO_MCP_MANIFEST_KEY_ID: "unit-test-key",
    SYNTHI_DOJO_MCP_MANIFEST_SIGNING_KEY: "unit-test-secret",
  };
}
