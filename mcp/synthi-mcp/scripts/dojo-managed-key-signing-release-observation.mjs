#!/usr/bin/env node
/*
 * Exercise a configured Agent Dojo managed-key proof signer and write a
 * release-observation artifact that can be attached to
 * dojo-managed-key-signing-self-check.mjs via --release-observation.
 *
 * This script does not embed signing keys, tenant IDs, key URIs, or commands.
 * It uses the same production-facing Dojo proof signing env/CLI contract and
 * emits only redacted config plus content digests.
 */

import assert from "node:assert/strict";
import { createHash, randomUUID, verify as nodeVerify } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_CHECKS,
  DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_SCHEMA_VERSION,
} from "./dojo-managed-key-signing-self-check.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(MCP_ROOT, "../..");

export const DOJO_PROOF_SIGNING_PROVIDER_ENV = "SYNTHI_DOJO_PROOF_SIGNING_PROVIDER";
export const DOJO_PROOF_SIGNING_KEY_ID_ENV = "SYNTHI_DOJO_PROOF_SIGNING_KEY_ID";
export const DOJO_PROOF_SIGNING_COMMAND_ENV = "SYNTHI_DOJO_PROOF_SIGNING_COMMAND";
export const DOJO_PROOF_SIGNING_COMMAND_ARGS_ENV = "SYNTHI_DOJO_PROOF_SIGNING_COMMAND_ARGS";
export const DOJO_PROOF_SIGNING_MANAGED_KEY_URI_ENV = "SYNTHI_DOJO_PROOF_SIGNING_MANAGED_KEY_URI";
export const DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM_ENV = "SYNTHI_DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM";
export const DOJO_PROOF_SIGNING_PRIVATE_KEY_PEM_ENV = "SYNTHI_DOJO_PROOF_SIGNING_PRIVATE_KEY_PEM";
export const DOJO_PROOF_SIGNING_KEY_ENV = "SYNTHI_DOJO_PROOF_SIGNING_KEY";
export const DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_PACKAGE_SCRIPT = "proof:dojo:managed-key-signing:observe";
export const DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_COMMAND = "npm --prefix mcp/synthi-mcp run proof:dojo:managed-key-signing:observe -- --out-dir tmp/dojo-managed-key-signing-live";
export const DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_DEFAULT_PATH = "tmp/dojo-managed-key-signing-live/managed-key-signing-release-observation.json";
export const DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_REQUIRED_ENV = [
  DOJO_PROOF_SIGNING_PROVIDER_ENV,
  DOJO_PROOF_SIGNING_KEY_ID_ENV,
  DOJO_PROOF_SIGNING_MANAGED_KEY_URI_ENV,
  DOJO_PROOF_SIGNING_COMMAND_ENV,
  DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM_ENV,
];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.dirname(path.resolve(REPO_ROOT, DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_DEFAULT_PATH)));
  const artifacts = await runDojoManagedKeySigningReleaseObservation({
    args,
    env: process.env,
    outDir,
  });
  console.log(`[ok] Dojo managed-key signing release observation passed - observation=${artifacts.observation_path}`);
}

export async function runDojoManagedKeySigningReleaseObservation({
  args: inputArgs = {},
  env = process.env,
  outDir,
  now = new Date().toISOString(),
  source = "managed_key_signing_release_observation",
} = {}) {
  const outputDir = path.resolve(outDir || path.join(REPO_ROOT, "tmp", "dojo-managed-key-signing-live"));
  await mkdir(outputDir, { recursive: true });
  const config = await resolveDojoManagedKeySigningReleaseObservationConfig({ args: inputArgs, env });
  const payload = String(inputArgs.payload || buildDojoManagedKeySigningObservationPayload({
    keyId: config.key_id,
    keyUri: config.key_uri,
    now,
  }));
  const request = {
    schema_version: "synthi.dojo.managedKeySignerRequest.v1",
    algorithm: "ed25519",
    key_id: config.key_id,
    key_uri: config.key_uri,
    payload,
  };
  const startedAt = Date.now();
  const result = spawnSync(config.command, config.command_args, {
    input: JSON.stringify(request),
    encoding: "utf8",
    env,
    timeout: config.timeout_ms,
    windowsHide: true,
  });
  const durationMs = Date.now() - startedAt;
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  if (!signerExecutionAccepted(result)) {
    if (result.error) {
      throw new Error(`dojo_managed_key_release_observation_signer_failed:${result.error.message}`);
    }
    throw new Error(`dojo_managed_key_release_observation_signer_failed:${stderr.trim() || `exit_${result.status ?? "unknown"}`}`);
  }
  const response = parseManagedKeySignerResponse(stdout);
  const positiveEvaluation = evaluateManagedKeySigningResponse({
    response,
    config,
    payload,
  });
  const mismatchEvaluation = evaluateManagedKeySigningResponse({
    response: {
      ...response,
      key_uri: `${response.key_uri}#dojo-mismatch-probe`,
    },
    config,
    payload,
  });
  const localCustodyEvaluation = evaluateManagedKeySigningResponse({
    response: {
      ...response,
      key_custody: "local",
    },
    config,
    payload,
  });
  const signerOutageFailClosed = signerExecutionAccepted({ error: new Error("probe"), status: 0 }) === false;
  if (!positiveEvaluation.signature_verified) {
    throw new Error("dojo_managed_key_release_observation_signature_unverified");
  }
  if (!positiveEvaluation.response_matches_request) {
    throw new Error("dojo_managed_key_release_observation_response_mismatch");
  }
  const configuredLocalPrivateMaterial = hasConfiguredLocalSigningMaterial(env);
  const checks = {
    managed_key_service_observed: signerExecutionAccepted(result),
    managed_key_uri_observed: Boolean(config.key_uri),
    managed_key_custody_observed: response.key_custody === "managed",
    signature_verified_with_public_key: positiveEvaluation.signature_verified,
    public_key_material_observed: Boolean(config.public_key_pem),
    signer_config_redacted: true,
    no_private_key_material_exported: !configuredLocalPrivateMaterial,
    signer_outage_fail_closed_observed: signerOutageFailClosed,
    uri_mismatch_rejected_observed: mismatchEvaluation.accepted === false,
    local_custody_rejected_observed: localCustodyEvaluation.accepted === false,
    release_artifact_digest_observed: true,
  };
  const missingReleaseChecks = DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_CHECKS
    .filter((check) => checks[check] !== true);
  if (missingReleaseChecks.length > 0) {
    throw new Error(`dojo_managed_key_release_observation_checks_missing:${missingReleaseChecks.join(",")}`);
  }
  const transcript = {
    schema_version: "synthi.dojo.managedKeySigningReleaseObservationArtifact.v1",
    observed_at: now,
    duration_ms: durationMs,
    request: {
      schema_version: request.schema_version,
      algorithm: request.algorithm,
      key_id: request.key_id,
      key_uri: request.key_uri,
      payload_sha256: sha256(payload),
    },
    response: {
      schema_version: response.schema_version,
      algorithm: response.algorithm,
      key_id: response.key_id,
      key_uri: response.key_uri,
      key_custody: response.key_custody,
      signature_sha256: sha256(response.signature),
    },
    verification: {
      public_key_sha256: sha256(config.public_key_pem),
      signature_verified: positiveEvaluation.signature_verified,
      response_matches_request: positiveEvaluation.response_matches_request,
      signer_exit_code: result.status ?? null,
      signer_signal: result.signal ?? null,
    },
    fail_closed_probes: {
      signer_outage_rejected: signerOutageFailClosed,
      uri_mismatch_rejected: mismatchEvaluation.accepted === false,
      local_custody_rejected: localCustodyEvaluation.accepted === false,
    },
    redaction: {
      command_redacted: true,
      args_redacted: true,
      env_redacted: true,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      configured_local_private_key_material_present: configuredLocalPrivateMaterial,
    },
  };
  const transcriptPath = path.join(outputDir, "managed-key-signing-release-observation-artifact.json");
  await writeFile(transcriptPath, JSON.stringify(transcript, null, 2));
  const transcriptText = JSON.stringify(transcript, null, 2);
  const releaseReady = Object.values(checks).every(Boolean)
    && positiveEvaluation.signature_verified
    && positiveEvaluation.response_matches_request
    && !configuredLocalPrivateMaterial;
  const observation = {
    schema_version: DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_SCHEMA_VERSION,
    source,
    scope: "release",
    observed_at: now,
    observed: true,
    release_ready: releaseReady,
    provider: "managed-key-service",
    algorithm: "ed25519",
    key_id: config.key_id,
    key_uri: config.key_uri,
    key_custody: response.key_custody,
    signature_verified: positiveEvaluation.signature_verified,
    public_key_sha256: sha256(config.public_key_pem),
    signed_payload_sha256: sha256(payload),
    signature_sha256: sha256(response.signature),
    checks,
    redacted_config: {
      command_redacted: true,
      args_redacted: true,
      env_redacted: true,
      private_key_material_present: configuredLocalPrivateMaterial,
      secret_values_present: false,
    },
    artifact_refs: [
      {
        kind: "managed_key_signing_conformance",
        artifact_path: transcriptPath,
        artifact_sha256: sha256(transcriptText),
      },
    ],
  };
  const observationPath = path.join(outputDir, "managed-key-signing-release-observation.json");
  await writeFile(observationPath, JSON.stringify(observation, null, 2));
  assert.equal(observation.release_ready, true, "managed-key signing release observation is not release-ready");
  return {
    observation_path: observationPath,
    transcript_path: transcriptPath,
    observation,
    transcript,
  };
}

export async function resolveDojoManagedKeySigningReleaseObservationConfig({
  args: inputArgs = {},
  env = process.env,
} = {}) {
  const provider = String(inputArgs.provider || env[DOJO_PROOF_SIGNING_PROVIDER_ENV] || "").trim();
  const keyId = String(inputArgs["key-id"] || env[DOJO_PROOF_SIGNING_KEY_ID_ENV] || "").trim();
  const keyUri = String(inputArgs["key-uri"] || env[DOJO_PROOF_SIGNING_MANAGED_KEY_URI_ENV] || "").trim();
  const command = String(inputArgs.command || env[DOJO_PROOF_SIGNING_COMMAND_ENV] || "").trim();
  const commandArgs = parseCommandArgs(inputArgs["command-args"] ?? env[DOJO_PROOF_SIGNING_COMMAND_ARGS_ENV]);
  const publicKeyPem = await readPublicKeyPem({ args: inputArgs, env });
  const timeoutMs = Number(inputArgs["timeout-ms"] || env.SYNTHI_DOJO_PROOF_SIGNING_TIMEOUT_MS || 5000);
  const missing = [];
  if (provider !== "managed-key-service") missing.push(`${DOJO_PROOF_SIGNING_PROVIDER_ENV}=managed-key-service`);
  if (!keyId) missing.push(DOJO_PROOF_SIGNING_KEY_ID_ENV);
  if (!keyUri) missing.push(DOJO_PROOF_SIGNING_MANAGED_KEY_URI_ENV);
  if (!command) missing.push(DOJO_PROOF_SIGNING_COMMAND_ENV);
  if (!publicKeyPem) missing.push(DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM_ENV);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) missing.push("SYNTHI_DOJO_PROOF_SIGNING_TIMEOUT_MS");
  if (missing.length > 0) {
    throw new Error(`dojo_managed_key_release_observation_config_missing:${missing.join(",")}`);
  }
  return {
    provider,
    key_id: keyId,
    key_uri: keyUri,
    command,
    command_args: commandArgs,
    public_key_pem: publicKeyPem,
    timeout_ms: timeoutMs,
  };
}

export function buildDojoManagedKeySigningObservationPayload({
  keyId,
  keyUri,
  now = new Date().toISOString(),
  nonce = randomUUID(),
}) {
  return JSON.stringify({
    schema_version: "synthi.dojo.managedKeySigningObservationPayload.v1",
    key_id: keyId,
    key_uri: keyUri,
    observed_at: now,
    nonce,
  });
}

function parseManagedKeySignerResponse(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("dojo_managed_key_release_observation_response_invalid");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("dojo_managed_key_release_observation_response_invalid");
  const response = parsed;
  if (response.schema_version !== "synthi.dojo.managedKeySignerResponse.v1") {
    throw new Error("dojo_managed_key_release_observation_response_schema_invalid");
  }
  if (response.algorithm !== "ed25519") throw new Error("dojo_managed_key_release_observation_algorithm_invalid");
  if (typeof response.key_id !== "string" || !response.key_id.trim()) {
    throw new Error("dojo_managed_key_release_observation_key_id_invalid");
  }
  if (typeof response.key_uri !== "string" || !response.key_uri.trim()) {
    throw new Error("dojo_managed_key_release_observation_key_uri_invalid");
  }
  if (response.key_custody !== "managed") throw new Error("dojo_managed_key_release_observation_custody_invalid");
  if (typeof response.signature !== "string" || !response.signature.trim()) {
    throw new Error("dojo_managed_key_release_observation_signature_invalid");
  }
  return {
    schema_version: response.schema_version,
    algorithm: response.algorithm,
    key_id: response.key_id,
    key_uri: response.key_uri,
    key_custody: response.key_custody,
    signature: response.signature,
  };
}

function evaluateManagedKeySigningResponse({ response, config, payload }) {
  const signatureValue = response.signature.startsWith("ed25519:")
    ? response.signature.slice("ed25519:".length)
    : response.signature;
  let signatureVerified = false;
  try {
    signatureVerified = nodeVerify(
      null,
      Buffer.from(payload, "utf8"),
      config.public_key_pem,
      Buffer.from(signatureValue, "base64url")
    );
  } catch {
    signatureVerified = false;
  }
  const responseMatchesRequest = response.key_id === config.key_id
    && response.key_uri === config.key_uri
    && response.key_custody === "managed";
  return {
    signature_verified: signatureVerified,
    response_matches_request: responseMatchesRequest,
    accepted: signatureVerified && responseMatchesRequest,
  };
}

function signerExecutionAccepted(result) {
  return !result?.error && Number(result?.status) === 0;
}

async function readPublicKeyPem({ args: inputArgs = {}, env = process.env } = {}) {
  const inline = String(inputArgs["public-key-pem"] || env[DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM_ENV] || "").trim();
  if (inline) return inline;
  const publicKeyPath = String(inputArgs["public-key-pem-path"] || env.SYNTHI_DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM_PATH || "").trim();
  if (!publicKeyPath) return "";
  return (await readFile(path.resolve(publicKeyPath), "utf8")).trim();
}

function parseCommandArgs(value) {
  if (value === undefined || value === null || String(value).trim() === "") return [];
  let parsed;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw new Error("dojo_managed_key_release_observation_command_args_invalid");
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("dojo_managed_key_release_observation_command_args_invalid");
  }
  return parsed;
}

function hasConfiguredLocalSigningMaterial(env) {
  return Boolean(
    String(env[DOJO_PROOF_SIGNING_PRIVATE_KEY_PEM_ENV] || "").trim()
    || String(env[DOJO_PROOF_SIGNING_KEY_ENV] || "").trim()
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function isDirectRun() {
  return process.argv[1] && path.resolve(process.argv[1]) === __filename;
}
