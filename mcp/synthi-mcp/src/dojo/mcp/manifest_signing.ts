import { createHash, createHmac } from "node:crypto";
import type { DojoExecutionSubstrate, DojoSkill } from "../../browser/dojo.js";
import type { PrivateWorkflowToolManifestV7 } from "../../browser/private_tool_manifest.js";

export interface DojoMcpSkillManifestV1 {
  kind: "dojoMcpSkillManifest";
  schema_version: "synthi.dojo.mcpSkillManifest.v1";
  manifest_id: string;
  skill: {
    skill_id: string;
    skill_version: string;
    workflow_id: string;
    app_origin: string;
    workspace_id: string;
  };
  tool: {
    name: string | null;
    version: string;
    schema_digest: string | null;
    backing_private_tool_manifest_digest: string | null;
    direct_call_policy: "blocked_outside_dojo_dispatcher";
  };
  license: {
    license_id: string;
    license_version: string;
    entrustment_level: DojoSkill["entrustment_level"];
    allowed_actions: string[];
    gated_actions: string[];
    blocked_actions: string[];
  };
  proof: {
    required: boolean;
    required_context_claims: string[];
    required_evidence_claims: string[];
    required_guardrails: string[];
  };
  substrate_policy: {
    preferred_substrate: DojoExecutionSubstrate;
    allowed_substrates: DojoExecutionSubstrate[];
    per_action: Array<{ action: string; allowed_substrates: DojoExecutionSubstrate[] }>;
  };
  issuer: string;
  key_id: string;
  signature_algorithm: "hmac-sha256";
  issued_at: string;
  manifest_digest: string;
  signature: string;
}

export interface DojoMcpSkillManifestValidation {
  ok: boolean;
  blocked_by: string[];
  manifest_digest?: string;
  manifest_id?: string;
  tool_name?: string | null;
}

export interface DojoMcpSkillManifestOptions {
  env?: NodeJS.ProcessEnv;
  now?: string;
}

export const DOJO_MCP_MANIFEST_ISSUER_ENV = "SYNTHI_DOJO_MCP_MANIFEST_ISSUER";
export const DOJO_MCP_MANIFEST_KEY_ID_ENV = "SYNTHI_DOJO_MCP_MANIFEST_KEY_ID";
export const DOJO_MCP_MANIFEST_SIGNING_KEY_ENV = "SYNTHI_DOJO_MCP_MANIFEST_SIGNING_KEY";
export const DOJO_DEFAULT_MCP_MANIFEST_SIGNING_KEY = "synthi-dojo-mcp-manifest-development-key";

export function buildDojoMcpSkillManifest(
  skill: DojoSkill,
  options: DojoMcpSkillManifestOptions = {}
): DojoMcpSkillManifestV1 {
  const env = options.env ?? process.env;
  const issuedAt = options.now ?? skill.generated_at;
  const proofRequired = dojoSkillRequiresMcpProof(skill);
  const privateManifestDigest = skill.private_tool_manifest
    ? digestObject(skill.private_tool_manifest)
    : null;
  const schemaDigest = skill.private_tool_manifest
    ? digestObject(privateToolSchemaPayload(skill.private_tool_manifest))
    : null;
  const unsigned = {
    kind: "dojoMcpSkillManifest" as const,
    schema_version: "synthi.dojo.mcpSkillManifest.v1" as const,
    manifest_id: `dojo_mcp_manifest_${shortHash([
      skill.skill_id,
      skill.skill_version,
      skill.permission_license.license_id,
      skill.permission_license.license_version,
      skill.published_tool_name ?? "",
      privateManifestDigest ?? "",
    ].join(":"))}`,
    skill: {
      skill_id: skill.skill_id,
      skill_version: skill.skill_version,
      workflow_id: skill.workflow_id,
      app_origin: skill.app_origin,
      workspace_id: skill.workspace_id,
    },
    tool: {
      name: skill.published_tool_name ?? skill.private_tool_manifest?.tool_name ?? null,
      version: skill.skill_version,
      schema_digest: schemaDigest,
      backing_private_tool_manifest_digest: privateManifestDigest,
      direct_call_policy: "blocked_outside_dojo_dispatcher" as const,
    },
    license: {
      license_id: skill.permission_license.license_id,
      license_version: skill.permission_license.license_version,
      entrustment_level: skill.entrustment_level,
      allowed_actions: skill.permission_license.allowed_actions.map((action) => action.action),
      gated_actions: skill.permission_license.gated_actions.map((action) => action.action),
      blocked_actions: skill.permission_license.blocked_actions.map((action) => action.action),
    },
    proof: {
      required: proofRequired,
      required_context_claims: [...skill.permission_license.proof_requirements.required_context_claims],
      required_evidence_claims: [...skill.permission_license.proof_requirements.required_evidence_claims],
      required_guardrails: [...skill.permission_license.proof_requirements.required_guardrails],
    },
    substrate_policy: {
      preferred_substrate: skill.preferred_substrate,
      allowed_substrates: [...skill.execution_substrates],
      per_action: skill.permission_license.substrate_requirements.map((requirement) => ({
        action: requirement.action,
        allowed_substrates: [...requirement.allowed_substrates],
      })),
    },
    issuer: dojoMcpManifestIssuer(env),
    key_id: dojoMcpManifestKeyId(env),
    signature_algorithm: "hmac-sha256" as const,
    issued_at: issuedAt,
  };
  const manifestDigest = digestObject(unsigned);
  return {
    ...unsigned,
    manifest_digest: manifestDigest,
    signature: signManifestDigest(manifestDigest, env),
  };
}

export function dojoMcpManifestRequiresProof(manifest: DojoMcpSkillManifestV1): boolean {
  return manifest.proof.required
    || manifest.proof.required_context_claims.length > 0
    || manifest.proof.required_evidence_claims.length > 0
    || manifest.proof.required_guardrails.length > 0
    || manifest.license.gated_actions.length > 0;
}

export function validateDojoMcpSkillManifest(
  manifest: DojoMcpSkillManifestV1,
  options: DojoMcpSkillManifestOptions & { expected_skill_id?: string; expected_tool_name?: string | null } = {}
): DojoMcpSkillManifestValidation {
  const env = options.env ?? process.env;
  const blockedBy: string[] = [];

  if (manifest.kind !== "dojoMcpSkillManifest") blockedBy.push("dojo_mcp_manifest_kind_mismatch");
  if (manifest.schema_version !== "synthi.dojo.mcpSkillManifest.v1") blockedBy.push("dojo_mcp_manifest_schema_mismatch");
  if (manifest.signature_algorithm !== "hmac-sha256") blockedBy.push("dojo_mcp_manifest_signature_algorithm_mismatch");
  if (manifest.issuer !== dojoMcpManifestIssuer(env)) blockedBy.push("dojo_mcp_manifest_issuer_mismatch");
  if (manifest.key_id !== dojoMcpManifestKeyId(env)) blockedBy.push("dojo_mcp_manifest_key_mismatch");
  if (options.expected_skill_id && manifest.skill.skill_id !== options.expected_skill_id) {
    blockedBy.push("dojo_mcp_manifest_skill_mismatch");
  }
  if (Object.prototype.hasOwnProperty.call(options, "expected_tool_name") && manifest.tool.name !== options.expected_tool_name) {
    blockedBy.push("dojo_mcp_manifest_tool_mismatch");
  }

  const expectedDigest = digestObject(unsignedManifest(manifest));
  if (manifest.manifest_digest !== expectedDigest) blockedBy.push("dojo_mcp_manifest_digest_mismatch");
  if (manifest.signature !== signManifestDigest(expectedDigest, env)) {
    blockedBy.push("dojo_mcp_manifest_signature_invalid");
  }

  return {
    ok: blockedBy.length === 0,
    blocked_by: blockedBy,
    manifest_digest: manifest.manifest_digest,
    manifest_id: manifest.manifest_id,
    tool_name: manifest.tool.name,
  };
}

export function dojoMcpManifestIssuer(env: NodeJS.ProcessEnv = process.env): string {
  return env[DOJO_MCP_MANIFEST_ISSUER_ENV]?.trim() || "synthi-dojo-skill-bus";
}

export function dojoMcpManifestKeyId(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[DOJO_MCP_MANIFEST_KEY_ID_ENV]?.trim();
  if (configured) return configured;
  return `dojo-mcp-manifest-dev-${shortHash(dojoMcpManifestSigningKey(env))}`;
}

export function configuredDojoMcpManifestSigningEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    DOJO_MCP_MANIFEST_ISSUER_ENV,
    DOJO_MCP_MANIFEST_KEY_ID_ENV,
    DOJO_MCP_MANIFEST_SIGNING_KEY_ENV,
  ].filter((name) => Boolean(env[name]?.trim()));
}

export function isDojoDefaultMcpManifestSigningKey(env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = env[DOJO_MCP_MANIFEST_SIGNING_KEY_ENV]?.trim();
  return !configured || configured === DOJO_DEFAULT_MCP_MANIFEST_SIGNING_KEY;
}

function dojoMcpManifestSigningKey(env: NodeJS.ProcessEnv): string {
  return env[DOJO_MCP_MANIFEST_SIGNING_KEY_ENV]?.trim()
    || DOJO_DEFAULT_MCP_MANIFEST_SIGNING_KEY;
}

function signManifestDigest(manifestDigest: string, env: NodeJS.ProcessEnv): string {
  return `hmac-sha256:${createHmac("sha256", dojoMcpManifestSigningKey(env))
    .update(`synthi.dojo.mcpSkillManifest.v1:${manifestDigest}`)
    .digest("hex")}`;
}

function unsignedManifest(manifest: DojoMcpSkillManifestV1): Omit<DojoMcpSkillManifestV1, "manifest_digest" | "signature"> {
  const { manifest_digest: _manifestDigest, signature: _signature, ...unsigned } = manifest;
  return unsigned;
}

function privateToolSchemaPayload(manifest: PrivateWorkflowToolManifestV7): Record<string, unknown> {
  return {
    tool_name: manifest.tool_name,
    parameters: manifest.parameters,
    run_modes: manifest.run_modes,
    default_run_mode: manifest.default_run_mode,
    mutation: manifest.mutation,
    auth: manifest.auth,
  };
}

function dojoSkillRequiresMcpProof(skill: DojoSkill): boolean {
  return skill.skill_passport.proof_required
    || skill.permission_license.proof_requirements.required_context_claims.length > 0
    || skill.permission_license.proof_requirements.required_evidence_claims.length > 0
    || skill.permission_license.proof_requirements.required_guardrails.length > 0
    || skill.permission_license.gated_actions.length > 0
    || skill.permission_license.approval_requirements.length > 0;
}

function digestObject(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value));
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, sortCanonical(nested)])
  );
}

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}
