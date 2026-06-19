#!/usr/bin/env node
/*
 * Build a hosted-runtime gateway release observation from live release-gate
 * artifacts. This script intentionally derives every check from artifact
 * content and digest-references the inputs; it does not accept caller-provided
 * booleans as proof.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_CHECKS,
  DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_GATE_IDS,
  DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_SCHEMA_VERSION,
} from "./dojo-hosted-runtime-gateway-self-check.mjs";
import {
  DOJO_MCP_HOST_DEPLOYMENT_CLAIM_REQUIREMENTS,
} from "./dojo-mcp-host-conformance.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(MCP_ROOT, "../..");

export const DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_PACKAGE_SCRIPT = "proof:dojo:hosted-runtime-gateway:observe";
export const DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_DEFAULT_PATH = "tmp/dojo-hosted-runtime-gateway-release-observation/hosted-runtime-gateway-release-observation.json";
export const DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_COMMAND =
  `npm --prefix mcp/synthi-mcp run ${DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_PACKAGE_SCRIPT} -- --out-dir tmp/dojo-hosted-runtime-gateway-release-observation`;

export const DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_INPUTS = {
  workflow_e2e_hosted: {
    arg: "workflow-e2e-summary",
    default_path: "tmp/workflow-pipeline-e2e/summary.json",
  },
  private_tool_stdio_acceptance: {
    arg: "private-tool-stdio-acceptance",
    default_path: "tmp/private-tool-stdio-acceptance/mcp-stdio-private-tool-acceptance.json",
  },
  private_tool_codex_acceptance: {
    arg: "private-tool-codex-acceptance",
    default_path: "tmp/private-tool-codex-acceptance/codex-private-tool-acceptance.json",
  },
  dojo_mcp_host_conformance: {
    arg: "mcp-host-conformance-report",
    default_path: "tmp/dojo-mcp-host-conformance-live/dojo-mcp-host-conformance.json",
    evidence_arg: "mcp-host-conformance-evidence",
    default_evidence_path: "tmp/dojo-mcp-host-conformance-live/dojo-mcp-host-conformance.evidence.json",
  },
  private_tool_stdio_host_conformance: {
    arg: "private-tool-stdio-host-conformance",
    default_path: "tmp/private-tool-stdio-host-conformance/mcp-stdio-private-tool-acceptance.json",
  },
  private_tool_codex_host_conformance: {
    arg: "private-tool-codex-host-conformance",
    default_path: "tmp/private-tool-codex-host-conformance/codex-private-tool-acceptance.json",
  },
};

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.dirname(resolveRepoPath(DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_DEFAULT_PATH)));
  const result = await buildDojoHostedRuntimeGatewayReleaseObservationFromArgs({ args });
  await mkdir(outDir, { recursive: true });
  const observationPath = path.join(outDir, "hosted-runtime-gateway-release-observation.json");
  const serializedObservation = `${JSON.stringify(result.observation, null, 2)}\n`;
  await writeFile(observationPath, serializedObservation, "utf8");
  const evidence = {
    schema_version: "synthi.dojo.hostedRuntimeGatewayReleaseObservationEvidence.v1",
    generated_at: result.observation.observed_at,
    ok: result.ok,
    observation_path: observationPath,
    observation_sha256: sha256(serializedObservation),
    observation_bytes: Buffer.byteLength(serializedObservation),
    input_gate_ids: result.artifact_refs.map((ref) => ref.gate_id),
    error_count: result.errors.length,
    errors: result.errors,
  };
  const evidencePath = path.join(outDir, "hosted-runtime-gateway-release-observation.evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  if (!result.ok) {
    throw new Error(`dojo_hosted_runtime_gateway_release_observation_failed:${result.errors.join(";")}`);
  }
  console.log(`[ok] Dojo hosted runtime gateway release observation written - observation=${observationPath} evidence=${evidencePath}`);
}

export async function buildDojoHostedRuntimeGatewayReleaseObservationFromArgs({ args = {}, now = new Date().toISOString() } = {}) {
  const paths = Object.fromEntries(Object.entries(DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_INPUTS)
    .map(([gateId, config]) => [gateId, {
      artifact_path: resolveRepoPath(args[config.arg] || config.default_path),
      evidence_path: config.evidence_arg
        ? resolveRepoPath(args[config.evidence_arg] || config.default_evidence_path)
        : undefined,
    }]));
  return buildDojoHostedRuntimeGatewayReleaseObservation({ paths, now });
}

export async function buildDojoHostedRuntimeGatewayReleaseObservation({ paths, now = new Date().toISOString() } = {}) {
  const artifacts = {};
  const errors = [];
  for (const gateId of DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_GATE_IDS) {
    const input = paths?.[gateId];
    if (!input?.artifact_path) {
      errors.push(`release_observation_input_missing:${gateId}`);
      continue;
    }
    artifacts[gateId] = await readArtifactRef({ gateId, artifactPath: input.artifact_path, evidencePath: input.evidence_path });
  }
  const artifactRefs = DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_GATE_IDS
    .map((gateId) => artifacts[gateId])
    .filter(Boolean)
    .map((artifact) => artifact.ref);
  errors.push(...validateRequiredInputsPresent(artifacts));
  if (errors.length === 0) {
    errors.push(...validateReleaseArtifactSchemas(artifacts));
  }
  const checks = errors.length === 0
    ? deriveHostedRuntimeReleaseChecks(artifacts)
    : Object.fromEntries(DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_CHECKS.map((check) => [check, false]));
  for (const check of DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_CHECKS) {
    if (checks[check] !== true) errors.push(`release_observation_check_failed:${check}`);
  }
  const ok = errors.length === 0;
  const observation = {
    schema_version: DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_SCHEMA_VERSION,
    source: "hosted_runtime_gateway_release_observation",
    scope: "release",
    observed_at: now,
    observed: ok,
    release_ready: ok,
    checks,
    artifact_refs: artifactRefs,
  };
  return {
    ok,
    errors,
    observation,
    artifact_refs: artifactRefs,
  };
}

function validateRequiredInputsPresent(artifacts) {
  return DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_GATE_IDS
    .filter((gateId) => !artifacts[gateId])
    .map((gateId) => `release_observation_artifact_missing:${gateId}`);
}

function validateReleaseArtifactSchemas(artifacts) {
  const errors = [];
  const workflow = artifacts.workflow_e2e_hosted?.json;
  if (workflow?.schema_version !== "synthi.dojo.workflowPipelineE2E.v1") {
    errors.push(`workflow_e2e_schema_mismatch:${workflow?.schema_version || "missing"}`);
  }
  if (workflow?.ok !== true) errors.push("workflow_e2e_not_ok");
  const stdio = artifacts.private_tool_stdio_acceptance?.json;
  if (stdio?.schema_version !== "synthi.dojo.privateToolStdioAcceptance.v1") {
    errors.push(`private_tool_stdio_schema_mismatch:${stdio?.schema_version || "missing"}`);
  }
  if (stdio?.ok !== true) errors.push("private_tool_stdio_not_ok");
  const codex = artifacts.private_tool_codex_acceptance?.json;
  if (codex?.schema_version !== "synthi.dojo.privateToolCodexAcceptance.v1") {
    errors.push(`private_tool_codex_schema_mismatch:${codex?.schema_version || "missing"}`);
  }
  if (codex?.ok !== true) errors.push("private_tool_codex_not_ok");
  const conformance = artifacts.dojo_mcp_host_conformance?.json;
  if (conformance?.schema_version !== "synthi.dojo.mcpHostConformance.v1") {
    errors.push(`mcp_host_conformance_schema_mismatch:${conformance?.schema_version || "missing"}`);
  }
  if (conformance?.conformance?.ok !== true) errors.push("mcp_host_conformance_not_ok");
  const conformanceEvidence = artifacts.dojo_mcp_host_conformance?.evidence_json;
  if (conformanceEvidence?.schema_version !== "synthi.dojo.mcpHostConformanceEvidence.v1") {
    errors.push(`mcp_host_conformance_evidence_schema_mismatch:${conformanceEvidence?.schema_version || "missing"}`);
  }
  if (conformanceEvidence?.gate_ok !== true) errors.push("mcp_host_conformance_evidence_not_ok");
  const stdioHost = artifacts.private_tool_stdio_host_conformance?.json;
  if (stdioHost?.schema_version !== "synthi.dojo.privateToolStdioAcceptance.v1") {
    errors.push(`private_tool_stdio_host_schema_mismatch:${stdioHost?.schema_version || "missing"}`);
  }
  if (stdioHost?.ok !== true) errors.push("private_tool_stdio_host_not_ok");
  const codexHost = artifacts.private_tool_codex_host_conformance?.json;
  if (codexHost?.schema_version !== "synthi.dojo.privateToolCodexAcceptance.v1") {
    errors.push(`private_tool_codex_host_schema_mismatch:${codexHost?.schema_version || "missing"}`);
  }
  if (codexHost?.ok !== true) errors.push("private_tool_codex_host_not_ok");
  return errors;
}

export function deriveHostedRuntimeReleaseChecks(artifacts) {
  const workflow = artifacts.workflow_e2e_hosted.json;
  const stdio = artifacts.private_tool_stdio_acceptance.json;
  const codex = artifacts.private_tool_codex_acceptance.json;
  const conformance = artifacts.dojo_mcp_host_conformance.json;
  const conformanceEvidence = artifacts.dojo_mcp_host_conformance.evidence_json;
  const stdioHost = artifacts.private_tool_stdio_host_conformance.json;
  const codexHost = artifacts.private_tool_codex_host_conformance.json;
  const allJson = [workflow, stdio, codex, conformance, conformanceEvidence, stdioHost, codexHost];
  const conformanceObservations = conformance?.deployment_observations || {};
  const conformanceEvidenceObservations = conformanceEvidence?.deployment_observations || {};
  const mcpHostDeploymentObserved = DOJO_MCP_HOST_DEPLOYMENT_CLAIM_REQUIREMENTS
    .every((requirement) => conformanceObservations[requirement.observedField] === true
      && conformanceEvidenceObservations[requirement.observedField] === true);

  return {
    non_loopback_runtime_observed: workflow?.hosted_runtime?.non_loopback_runtime === true
      && conformance?.conformance?.non_loopback_mcp_host === true
      && stdioHostedAttachObserved(stdio)
      && codexHostedAttachObserved(codex)
      && stdioHost?.conformance?.non_loopback_runtime === true
      && codexHost?.conformance?.non_loopback_runtime === true,
    hosted_runtime_gateway_observed: workflow?.hosted_runtime?.cdp_url_configured === true
      && workflow?.hosted_runtime?.non_loopback_runtime === true
      && stdioHostedAttachObserved(stdio)
      && codexHostedAttachObserved(codex)
      && hasPassingStep(conformance, "execute proof-gated Dojo skill"),
    external_session_store_observed: workflow?.fresh_mcp?.private_workflow_store_env_configured === true
      && stdioHost?.conformance?.external_private_tool_store === true
      && stdioHost?.private_tool_store?.external === true
      && codexHost?.conformance?.external_private_tool_store === true
      && codexHost?.private_tool_store?.external === true
      && mcpHostDeploymentObserved,
    tenant_session_isolation_observed: observedBoolean(allJson, [
      "tenant_session_isolation_observed",
      "tenant_session_isolation",
      "tenant_scoped_sessions",
      "tenant_scoped_session",
      "tenant_bound_session",
    ]),
    short_lived_credentials_observed: observedBoolean(allJson, [
      "short_lived_credentials_observed",
      "short_lived_credentials",
      "credentials_short_lived",
      "runtime_credentials_short_lived",
    ]),
    origin_policy_observed: hasPassingStep(stdio, "grant exact-origin consent")
      && observedBoolean(allJson, ["origin_policy_observed", "origin_policy_enforced", "origin_allowlist_enforced"]),
    local_network_policy_observed: observedBoolean(allJson, [
      "local_network_policy_observed",
      "local_network_policy_enforced",
      "local_network_blocked",
      "metadata_service_blocked",
    ]),
    screenshot_redaction_observed: observedBoolean(allJson, [
      "screenshot_redaction_observed",
      "screenshot_redaction_enabled",
      "screenshot_redaction",
    ]),
    audit_event_observed: observedBoolean(allJson, ["audit_event_observed", "audit_events_observed", "runtime_audit_event_written"]),
    evidence_write_observed: observedBoolean(allJson, ["evidence_write_observed", "runtime_evidence_written", "evidence_record_written"]),
    revocation_observed: hasPassingStep(conformance, "revoked proof validation blocked")
      && hasPassingStep(conformance, "revoked proof run blocked"),
    expiry_observed: observedBoolean(allJson, ["expiry_observed", "expired_session_blocked", "credentials_expiry_observed"]),
    no_static_cdp_endpoint_observed: workflow?.hosted_runtime?.non_loopback_runtime === true
      && !hasLoopbackOrLocalUrl(workflow?.hosted_runtime?.cdp_url)
      && conformanceObservations.no_local_cdp_leakage === true,
    no_long_lived_credentials_observed: observedBoolean(allJson, [
      "no_long_lived_credentials_observed",
      "long_lived_credentials_absent",
      "no_long_lived_credentials",
    ]),
  };
}

async function readArtifactRef({ gateId, artifactPath, evidencePath }) {
  const artifactText = await readFile(artifactPath, "utf8");
  const artifact = JSON.parse(artifactText);
  const ref = {
    gate_id: gateId,
    artifact_path: artifactPath,
    artifact_sha256: sha256(artifactText),
    artifact_bytes: Buffer.byteLength(artifactText),
    kind: gateId === "dojo_mcp_host_conformance" ? "conformance_report" : "release_report",
  };
  let evidenceJson;
  if (evidencePath) {
    const evidenceText = await readFile(evidencePath, "utf8");
    evidenceJson = JSON.parse(evidenceText);
    ref.evidence_path = evidencePath;
    ref.evidence_sha256 = sha256(evidenceText);
    ref.evidence_bytes = Buffer.byteLength(evidenceText);
  }
  return {
    json: artifact,
    evidence_json: evidenceJson,
    ref,
  };
}

function hasPassingStep(report, name) {
  return Array.isArray(report?.steps) && report.steps.some((step) => step?.name === name && step.ok === true && step.dry_run !== true);
}

function stdioHostedAttachObserved(transcript) {
  const step = Array.isArray(transcript?.steps)
    ? transcript.steps.find((item) => item?.name === "attach hosted workspace browser through MCP" && item.ok === true)
    : null;
  return step?.evidence?.hosted_attach === true && step?.evidence?.local_attach === false;
}

function codexHostedAttachObserved(transcript) {
  const evidence = transcript?.codex?.mcp_evidence || {};
  return evidence.hosted_attach_call === true && evidence.local_attach_call === false;
}

function observedBoolean(values, names) {
  const targets = new Set(names);
  return values.some((value) => findBooleanField(value, targets));
}

function findBooleanField(value, names, seen = new Set()) {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => findBooleanField(item, names, seen));
  for (const [key, nested] of Object.entries(value)) {
    if (names.has(key) && nested === true) return true;
    if (nested && typeof nested === "object" && findBooleanField(nested, names, seen)) return true;
  }
  return false;
}

function hasLoopbackOrLocalUrl(value) {
  const text = String(value || "").toLowerCase();
  return /(^|[/:.@-])(localhost|127\.|0\.0\.0\.0|\[::1\]|::1)([/:.@-]|$)/.test(text);
}

function resolveRepoPath(value) {
  const text = String(value || "").trim();
  if (!text) return text;
  return path.isAbsolute(text) ? text : path.resolve(REPO_ROOT, text);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [rawKey, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
    const key = rawKey;
    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "1";
      continue;
    }
    parsed[key] = next;
    i += 1;
  }
  return parsed;
}

function isDirectRun() {
  return process.argv[1] && path.resolve(process.argv[1]) === __filename;
}
