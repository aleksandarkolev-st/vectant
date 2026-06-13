import { describe, expect, it } from "vitest";
import { buildDojoSkill } from "../../src/browser/dojo.js";
import { generatePrivateWorkflowToolManifest } from "../../src/browser/private_tool_manifest.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
import {
  buildDojoMcpSkillManifest,
  configuredDojoMcpManifestSigningEnv,
  DOJO_DEFAULT_MCP_MANIFEST_SIGNING_KEY,
  DOJO_MCP_MANIFEST_PRIVATE_KEY_PEM_ENV,
  DOJO_MCP_MANIFEST_PUBLIC_KEY_PEM_ENV,
  DOJO_MCP_MANIFEST_SIGNING_ALGORITHM_ENV,
  dojoMcpManifestSigningReadiness,
  dojoMcpManifestRequiresProof,
  isDojoDefaultMcpManifestSigningKey,
  isDojoMcpManifestSigningProductionReady,
  validateDojoMcpSkillManifest,
  type DojoMcpSkillManifestV1,
} from "../../src/dojo/mcp/manifest_signing.js";
import { generateEd25519DojoProofKeyPair as generateProofKeyPair } from "../../src/dojo/proof/signing.js";

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
    expect(first.proof.required).toBe(true);
    expect(first.proof.required_context_claims).toContain("workspace_verified");
    expect(dojoMcpManifestRequiresProof(first)).toBe(true);
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

  it("signs manifests with Ed25519 and verifies with public key material only", () => {
    const skill = skillFixture();
    const keyPair = generateProofKeyPair("manifest-ed-key-a");
    const signingEnv = ed25519ManifestEnv(keyPair);
    const verifierEnv = {
      SYNTHI_DOJO_MCP_MANIFEST_SIGNING_ALGORITHM: "ed25519",
      SYNTHI_DOJO_MCP_MANIFEST_ISSUER: "unit-test-skill-bus",
      SYNTHI_DOJO_MCP_MANIFEST_KEY_ID: keyPair.key_id,
      SYNTHI_DOJO_MCP_MANIFEST_PUBLIC_KEY_PEM: keyPair.public_key_pem,
    };
    const manifest = buildDojoMcpSkillManifest(skill, { env: signingEnv });

    expect(manifest.signature_algorithm).toBe("ed25519");
    expect(manifest.signature).toMatch(/^ed25519:manifest-ed-key-a:/);
    expect(validateDojoMcpSkillManifest(manifest, {
      env: verifierEnv,
      expected_skill_id: skill.skill_id,
      expected_tool_name: skill.published_tool_name,
    })).toEqual(expect.objectContaining({
      ok: true,
      blocked_by: [],
    }));

    const wrongKey = generateProofKeyPair("manifest-ed-key-b");
    expect(validateDojoMcpSkillManifest(manifest, {
      env: { ...verifierEnv, SYNTHI_DOJO_MCP_MANIFEST_PUBLIC_KEY_PEM: wrongKey.public_key_pem },
    })).toEqual(expect.objectContaining({
      ok: false,
      blocked_by: expect.arrayContaining(["dojo_mcp_manifest_signature_invalid"]),
    }));
  });

  it("derives proof-required from license constraints even if passport metadata is stale", () => {
    const skill = skillFixture();
    const stalePassportSkill = {
      ...skill,
      skill_passport: {
        ...skill.skill_passport,
        proof_required: false,
      },
    };
    const manifest = buildDojoMcpSkillManifest(stalePassportSkill, { env: manifestEnv() });

    expect(manifest.proof.required).toBe(true);
    expect(dojoMcpManifestRequiresProof(manifest)).toBe(true);
    expect(manifest.proof.required_evidence_claims).toEqual(skill.permission_license.proof_requirements.required_evidence_claims);
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

  it("reports configured manifest signing env and detects default local signing keys", () => {
    expect(isDojoDefaultMcpManifestSigningKey({})).toBe(true);
    expect(isDojoDefaultMcpManifestSigningKey({
      SYNTHI_DOJO_MCP_MANIFEST_SIGNING_KEY: DOJO_DEFAULT_MCP_MANIFEST_SIGNING_KEY,
    })).toBe(true);
    expect(isDojoDefaultMcpManifestSigningKey(manifestEnv())).toBe(false);
    expect(isDojoMcpManifestSigningProductionReady(manifestEnv())).toBe(false);
    expect(configuredDojoMcpManifestSigningEnv(manifestEnv())).toEqual([
      "SYNTHI_DOJO_MCP_MANIFEST_ISSUER",
      "SYNTHI_DOJO_MCP_MANIFEST_KEY_ID",
      "SYNTHI_DOJO_MCP_MANIFEST_SIGNING_KEY",
    ]);
    const keyPair = generateProofKeyPair("manifest-ed-key-ready");
    const edEnv = ed25519ManifestEnv(keyPair);
    expect(isDojoMcpManifestSigningProductionReady(edEnv)).toBe(true);
    expect(dojoMcpManifestSigningReadiness(edEnv)).toEqual(expect.objectContaining({
      algorithm: "ed25519",
      production_ready: true,
      blocked_by: [],
      configured_env: expect.arrayContaining([
        DOJO_MCP_MANIFEST_SIGNING_ALGORITHM_ENV,
        DOJO_MCP_MANIFEST_PRIVATE_KEY_PEM_ENV,
        DOJO_MCP_MANIFEST_PUBLIC_KEY_PEM_ENV,
      ]),
    }));
  });

  it("fails closed when Ed25519 manifest signing lacks private key material", () => {
    const skill = skillFixture();
    const keyPair = generateProofKeyPair("manifest-ed-key-missing-private");
    expect(() => buildDojoMcpSkillManifest(skill, {
      env: {
        ...ed25519ManifestEnv(keyPair),
        SYNTHI_DOJO_MCP_MANIFEST_PRIVATE_KEY_PEM: undefined,
      },
    })).toThrow("dojo_mcp_manifest_private_key_missing");
  });

  it("reports invalid manifest signing algorithm env without silent downgrade", () => {
    const skill = skillFixture();
    const env = {
      ...manifestEnv(),
      SYNTHI_DOJO_MCP_MANIFEST_SIGNING_ALGORITHM: "rsa-pss",
    };
    const manifest = buildDojoMcpSkillManifest(skill, { env });

    expect(manifest.signature_algorithm).toBe("hmac-sha256");
    expect(dojoMcpManifestSigningReadiness(env)).toEqual(expect.objectContaining({
      production_ready: false,
      blocked_by: expect.arrayContaining(["dojo_mcp_manifest_signature_algorithm_invalid"]),
    }));
    expect(validateDojoMcpSkillManifest(manifest, { env })).toEqual(expect.objectContaining({
      ok: false,
      blocked_by: expect.arrayContaining(["dojo_mcp_manifest_signature_algorithm_invalid"]),
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

function ed25519ManifestEnv(keyPair: {
  key_id: string;
  private_key_pem: string;
  public_key_pem: string;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SYNTHI_DOJO_MCP_MANIFEST_SIGNING_ALGORITHM: "ed25519",
    SYNTHI_DOJO_MCP_MANIFEST_ISSUER: "unit-test-skill-bus",
    SYNTHI_DOJO_MCP_MANIFEST_KEY_ID: keyPair.key_id,
    SYNTHI_DOJO_MCP_MANIFEST_PRIVATE_KEY_PEM: keyPair.private_key_pem,
    SYNTHI_DOJO_MCP_MANIFEST_PUBLIC_KEY_PEM: keyPair.public_key_pem,
  };
}
