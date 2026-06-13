import {
  createHash,
  createHmac,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";
import type { DojoExecutionSubstrate, DojoSkill } from "../../browser/dojo.js";
import type { PrivateWorkflowToolManifestV7 } from "../../browser/private_tool_manifest.js";

export type DojoMcpSkillManifestSigningAlgorithm = "hmac-sha256" | "ed25519";

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
  signature_algorithm: DojoMcpSkillManifestSigningAlgorithm;
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
export const DOJO_MCP_MANIFEST_SIGNING_ALGORITHM_ENV = "SYNTHI_DOJO_MCP_MANIFEST_SIGNING_ALGORITHM";
export const DOJO_MCP_MANIFEST_PRIVATE_KEY_PEM_ENV = "SYNTHI_DOJO_MCP_MANIFEST_PRIVATE_KEY_PEM";
export const DOJO_MCP_MANIFEST_PUBLIC_KEY_PEM_ENV = "SYNTHI_DOJO_MCP_MANIFEST_PUBLIC_KEY_PEM";
export const DOJO_DEFAULT_MCP_MANIFEST_SIGNING_KEY = "synthi-dojo-mcp-manifest-development-key";
const DOJO_MCP_MANIFEST_SIGNING_ALGORITHMS: DojoMcpSkillManifestSigningAlgorithm[] = ["hmac-sha256", "ed25519"];

export function buildDojoMcpSkillManifest(
  skill: DojoSkill,
  options: DojoMcpSkillManifestOptions = {}
): DojoMcpSkillManifestV1 {
  const env = options.env ?? process.env;
  const issuedAt = options.now ?? skill.generated_at;
  const signatureAlgorithm = dojoMcpManifestSigningAlgorithm(env);
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
    signature_algorithm: signatureAlgorithm,
    issued_at: issuedAt,
  };
  const manifestDigest = digestObject(unsigned);
  return {
    ...unsigned,
    manifest_digest: manifestDigest,
    signature: signManifestDigest(manifestDigest, env, signatureAlgorithm, unsigned.key_id),
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
  const expectedAlgorithm = dojoMcpManifestSigningAlgorithm(env);
  if (isDojoMcpManifestSigningAlgorithmEnvInvalid(env)) {
    blockedBy.push("dojo_mcp_manifest_signature_algorithm_invalid");
  }

  if (manifest.kind !== "dojoMcpSkillManifest") blockedBy.push("dojo_mcp_manifest_kind_mismatch");
  if (manifest.schema_version !== "synthi.dojo.mcpSkillManifest.v1") blockedBy.push("dojo_mcp_manifest_schema_mismatch");
  if (manifest.signature_algorithm !== "hmac-sha256" && manifest.signature_algorithm !== "ed25519") {
    blockedBy.push("dojo_mcp_manifest_signature_algorithm_unsupported");
  }
  if (manifest.signature_algorithm !== expectedAlgorithm) blockedBy.push("dojo_mcp_manifest_signature_algorithm_mismatch");
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
  if (!verifyManifestDigestSignature(manifest, expectedDigest, env)) {
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
  if (dojoMcpManifestSigningAlgorithm(env) === "ed25519") {
    const publicKey = env[DOJO_MCP_MANIFEST_PUBLIC_KEY_PEM_ENV]?.trim();
    if (publicKey) return `dojo-mcp-manifest-ed25519-${shortHash(publicKey)}`;
  }
  return `dojo-mcp-manifest-dev-${shortHash(dojoMcpManifestHmacSigningKey(env))}`;
}

export function dojoMcpManifestSigningAlgorithm(
  env: NodeJS.ProcessEnv = process.env
): DojoMcpSkillManifestSigningAlgorithm {
  const configured = env[DOJO_MCP_MANIFEST_SIGNING_ALGORITHM_ENV]?.trim().toLowerCase();
  if (configured === "ed25519") return "ed25519";
  return "hmac-sha256";
}

export function isDojoMcpManifestSigningAlgorithmEnvInvalid(env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = env[DOJO_MCP_MANIFEST_SIGNING_ALGORITHM_ENV]?.trim().toLowerCase();
  return Boolean(configured) && !DOJO_MCP_MANIFEST_SIGNING_ALGORITHMS.includes(configured as DojoMcpSkillManifestSigningAlgorithm);
}

export function configuredDojoMcpManifestSigningEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    DOJO_MCP_MANIFEST_SIGNING_ALGORITHM_ENV,
    DOJO_MCP_MANIFEST_ISSUER_ENV,
    DOJO_MCP_MANIFEST_KEY_ID_ENV,
    DOJO_MCP_MANIFEST_SIGNING_KEY_ENV,
    DOJO_MCP_MANIFEST_PRIVATE_KEY_PEM_ENV,
    DOJO_MCP_MANIFEST_PUBLIC_KEY_PEM_ENV,
  ].filter((name) => Boolean(env[name]?.trim()));
}

export function isDojoDefaultMcpManifestSigningKey(env: NodeJS.ProcessEnv = process.env): boolean {
  if (dojoMcpManifestSigningAlgorithm(env) === "ed25519") return false;
  const configured = env[DOJO_MCP_MANIFEST_SIGNING_KEY_ENV]?.trim();
  return !configured || configured === DOJO_DEFAULT_MCP_MANIFEST_SIGNING_KEY;
}

export function isDojoMcpManifestSigningProductionReady(env: NodeJS.ProcessEnv = process.env): boolean {
  return dojoMcpManifestSigningReadiness(env).production_ready;
}

export function dojoMcpManifestSigningReadiness(env: NodeJS.ProcessEnv = process.env): {
  algorithm: DojoMcpSkillManifestSigningAlgorithm;
  production_ready: boolean;
  configured_env: string[];
  blocked_by: string[];
} {
  const algorithm = dojoMcpManifestSigningAlgorithm(env);
  const issuer = env[DOJO_MCP_MANIFEST_ISSUER_ENV]?.trim();
  const keyId = env[DOJO_MCP_MANIFEST_KEY_ID_ENV]?.trim();
  const blockedBy = [
    ...(isDojoMcpManifestSigningAlgorithmEnvInvalid(env) ? ["dojo_mcp_manifest_signature_algorithm_invalid"] : []),
    ...(!issuer ? ["dojo_mcp_manifest_issuer_missing"] : []),
    ...(!keyId ? ["dojo_mcp_manifest_key_id_missing"] : []),
  ];
  if (algorithm === "ed25519") {
    const privateKey = env[DOJO_MCP_MANIFEST_PRIVATE_KEY_PEM_ENV]?.trim();
    const publicKey = env[DOJO_MCP_MANIFEST_PUBLIC_KEY_PEM_ENV]?.trim();
    if (!privateKey) blockedBy.push("dojo_mcp_manifest_private_key_missing");
    if (!publicKey) blockedBy.push("dojo_mcp_manifest_public_key_missing");
  } else {
    blockedBy.push("dojo_mcp_manifest_hmac_not_independently_verifiable");
    if (isDojoDefaultMcpManifestSigningKey(env)) {
      blockedBy.push("dojo_mcp_manifest_default_signing_key");
    }
  }
  return {
    algorithm,
    production_ready: blockedBy.length === 0,
    configured_env: configuredDojoMcpManifestSigningEnv(env),
    blocked_by: blockedBy,
  };
}

function dojoMcpManifestHmacSigningKey(env: NodeJS.ProcessEnv): string {
  return env[DOJO_MCP_MANIFEST_SIGNING_KEY_ENV]?.trim()
    || DOJO_DEFAULT_MCP_MANIFEST_SIGNING_KEY;
}

function signManifestDigest(
  manifestDigest: string,
  env: NodeJS.ProcessEnv,
  algorithm: DojoMcpSkillManifestSigningAlgorithm,
  keyId: string
): string {
  const payload = manifestSignaturePayload(manifestDigest);
  if (algorithm === "hmac-sha256") {
    return `hmac-sha256:${createHmac("sha256", dojoMcpManifestHmacSigningKey(env))
      .update(payload)
      .digest("hex")}`;
  }
  const privateKey = env[DOJO_MCP_MANIFEST_PRIVATE_KEY_PEM_ENV]?.trim();
  if (!privateKey) throw new Error("dojo_mcp_manifest_private_key_missing");
  return `ed25519:${keyId}:${nodeSign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url")}`;
}

function verifyManifestDigestSignature(
  manifest: DojoMcpSkillManifestV1,
  expectedDigest: string,
  env: NodeJS.ProcessEnv
): boolean {
  const payload = manifestSignaturePayload(expectedDigest);
  if (manifest.signature_algorithm === "hmac-sha256") {
    return manifest.signature === signManifestDigest(expectedDigest, env, "hmac-sha256", manifest.key_id);
  }
  if (manifest.signature_algorithm === "ed25519") {
    const publicKey = env[DOJO_MCP_MANIFEST_PUBLIC_KEY_PEM_ENV]?.trim();
    if (!publicKey) return false;
    const parsed = parseEd25519ManifestSignature(manifest.signature);
    if (!parsed || parsed.key_id !== manifest.key_id) return false;
    try {
      return nodeVerify(null, Buffer.from(payload, "utf8"), publicKey, Buffer.from(parsed.signature, "base64url"));
    } catch {
      return false;
    }
  }
  return false;
}

function manifestSignaturePayload(manifestDigest: string): string {
  return `synthi.dojo.mcpSkillManifest.v1:${manifestDigest}`;
}

function parseEd25519ManifestSignature(value: string): { key_id: string; signature: string } | null {
  if (!value.startsWith("ed25519:")) return null;
  const rest = value.slice("ed25519:".length);
  const separatorIndex = rest.indexOf(":");
  if (separatorIndex < 1) return null;
  const keyId = rest.slice(0, separatorIndex);
  const signature = rest.slice(separatorIndex + 1);
  if (!keyId || !signature) return null;
  return { key_id: keyId, signature };
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
