#!/usr/bin/env node
/*
 * Emit a machine-readable Dojo release gate manifest.
 *
 * The implementation plan defines test tiers T0-T8. This script turns those
 * tiers into a stable artifact that CI, milestone branches, and release
 * candidates can inspect without parsing prose.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(MCP_ROOT, "../..");

export const DOJO_RELEASE_GATE_TIERS = [
  {
    id: "T0",
    name: "Static / Typecheck",
    runs_on: "every PR",
    required_for: "every merge",
    purpose: "TypeScript, lint, schema compile, and import boundary checks.",
  },
  {
    id: "T1",
    name: "Unit",
    runs_on: "every PR",
    required_for: "every merge",
    purpose: "Pure functions, policy decisions, stores with fakes, and schema validators.",
  },
  {
    id: "T2",
    name: "Focused Integration",
    runs_on: "every PR touching runtime or store code",
    required_for: "milestone merge",
    purpose: "Real module interaction with local test stores and deterministic fixtures.",
  },
  {
    id: "T3",
    name: "Docker Integration",
    runs_on: "milestone branch",
    required_for: "milestone exit",
    purpose: "Full local stack service wiring and bridge behavior.",
  },
  {
    id: "T4",
    name: "Playwright Visual / E2E",
    runs_on: "UI/runtime milestones",
    required_for: "milestone exit",
    purpose: "User-visible behavior, generated artifacts, and visual regressions.",
  },
  {
    id: "T5",
    name: "Live Hosted Runtime",
    runs_on: "release branch",
    required_for: "release candidate",
    purpose: "Hosted runtime, private tool acceptance, and non-local workflow path proof.",
  },
  {
    id: "T6",
    name: "Deployed MCP Host Conformance",
    runs_on: "release branch",
    required_for: "production release",
    purpose: "Non-loopback MCP host, external stores, strict clients, and revocation propagation.",
  },
  {
    id: "T7",
    name: "Security / Abuse",
    runs_on: "release branch and nightly",
    required_for: "production release",
    purpose: "Tamper, replay, bypass, cross-tenant, injection, stale evidence, and revocation checks.",
  },
  {
    id: "T8",
    name: "Chaos / Soak / Performance",
    runs_on: "nightly and pre-release",
    required_for: "mature enterprise release",
    purpose: "Failure injection, long-running stability, budgets, and leak detection.",
  },
];

export const DOJO_VISUAL_REPORT_REQUIREMENTS = Object.freeze({
  requires_report_ok: true,
  requires_result_ok: true,
  requires_empty_failed_visual_gates: true,
  requires_pixel_metrics: true,
  requires_layout_metrics: true,
  max_horizontal_overflow_px: 4,
  required_result_fields: [
    "screenshot_path",
    "bytes",
    "image_metrics.pixel_metrics_verified",
    "image_metrics.unique_color_sample_count",
    "image_metrics.background_diff_pixel_ratio",
    "image_metrics.luma_stddev",
    "layout_metrics.horizontal_overflow_px",
    "layout_metrics.selector_visible_area_px",
  ],
});

export const DOJO_RELEASE_GATE_COMMANDS = [
  {
    id: "mcp_typecheck",
    tier: "T0",
    working_directory: "mcp/synthi-mcp",
    package_script: "typecheck",
    command: "npm --prefix mcp/synthi-mcp run typecheck",
    required_for: ["pr", "milestone", "release"],
    evidence_kind: "log",
  },
  {
    id: "mcp_build",
    tier: "T0",
    working_directory: "mcp/synthi-mcp",
    package_script: "build",
    command: "npm --prefix mcp/synthi-mcp run build",
    required_for: ["pr", "milestone", "release"],
    evidence_kind: "log",
  },
  {
    id: "mcp_unit_tests",
    tier: "T1",
    working_directory: "mcp/synthi-mcp",
    package_script: "test:unit",
    command: "npm --prefix mcp/synthi-mcp run test:unit",
    required_for: ["pr", "milestone", "release"],
    evidence_kind: "test_report",
  },
  {
    id: "mcp_integration_tests",
    tier: "T2",
    working_directory: "mcp/synthi-mcp",
    package_script: "test:integration",
    command: "npm --prefix mcp/synthi-mcp run test:integration",
    required_for: ["milestone", "release"],
    evidence_kind: "test_report",
  },
  {
    id: "dojo_self_check",
    tier: "T2",
    working_directory: "mcp/synthi-mcp",
    package_script: "proof:dojo:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:self-check",
    required_for: ["milestone", "release"],
    evidence_kind: "proof_artifact",
  },
  {
    id: "dojo_mcp_host_conformance_self_check",
    tier: "T2",
    working_directory: "mcp/synthi-mcp",
    package_script: "proof:dojo:mcp-host-conformance:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:mcp-host-conformance:self-check",
    required_for: ["milestone", "release"],
    evidence_kind: "proof_artifact",
  },
  {
    id: "frontend_lint",
    tier: "T0",
    working_directory: "synthi",
    package_script: "lint",
    command: "cd synthi && npm run lint",
    required_for: ["pr", "milestone", "release"],
    evidence_kind: "log",
    package_json: "synthi/package.json",
  },
  {
    id: "frontend_build",
    tier: "T0",
    working_directory: "synthi",
    package_script: "build",
    command: "cd synthi && npm run build",
    required_for: ["pr", "milestone", "release"],
    evidence_kind: "log",
    package_json: "synthi/package.json",
  },
  {
    id: "frontend_dojo_unit_tests",
    tier: "T1",
    working_directory: "synthi",
    package_script: "test",
    command: "cd synthi && npm test -- src/components/agent-workflows src/components/dojo src/services",
    required_for: ["pr", "milestone", "release"],
    evidence_kind: "test_report",
    package_json: "synthi/package.json",
  },
  {
    id: "docker_integration",
    tier: "T3",
    working_directory: ".",
    command: "docker compose up -d --build --force-recreate && docker compose ps",
    required_for: ["milestone", "release"],
    evidence_kind: "service_health",
    requires_env: [
      "NEXT_PUBLIC_SYNTHI_WORKSPACE_AUTH_BYPASS",
      "AI_ENGINE_HOST_PORT",
      "POSTGRES_HOST_PORT",
    ],
  },
  {
    id: "dojo_full_visual_proof",
    tier: "T4",
    working_directory: "synthi",
    package_json: "synthi/package.json",
    package_script: "proof:dojo:visual",
    command: "npm --prefix synthi run proof:dojo:visual",
    required_for: ["milestone", "release"],
    evidence_kind: "visual_report",
    report_schema_version: "synthi.dojo.visualProof.v1",
    default_report_path: "synthi/tmp/dojo-visual-proof/visual-proof.json",
    visual_report_requirements: DOJO_VISUAL_REPORT_REQUIREMENTS,
  },
  {
    id: "dojo_ghost_mode_visual_proof",
    tier: "T4",
    working_directory: "synthi",
    package_json: "synthi/package.json",
    package_script: "proof:dojo:ghost-mode-visual",
    command: "npm --prefix synthi run proof:dojo:ghost-mode-visual",
    required_for: ["milestone", "release"],
    evidence_kind: "visual_report",
    report_schema_version: "synthi.dojo.ghostModeVisualProof.v1",
    default_report_path: "synthi/tmp/dojo-ghost-mode-visual/ghost-mode-shadow-visual-report.json",
    visual_report_requirements: DOJO_VISUAL_REPORT_REQUIREMENTS,
  },
  {
    id: "workflow_e2e_hosted",
    tier: "T5",
    working_directory: "mcp/synthi-mcp",
    package_script: "live:browser:workflow-pipeline",
    command: "npm --prefix mcp/synthi-mcp run live:browser:workflow-pipeline",
    required_for: ["release"],
    evidence_kind: "proof_artifact",
    requires_env: [
      "SYNTHI_HOSTED_BROWSER_CDP_URL",
      "SYNTHI_WORKFLOW_PIPELINE_VERIFY_FRESH_MCP",
    ],
  },
  {
    id: "private_tool_stdio_acceptance",
    tier: "T5",
    working_directory: "mcp/synthi-mcp",
    package_script: "live:browser:private-tool-stdio",
    command: "npm --prefix mcp/synthi-mcp run live:browser:private-tool-stdio",
    required_for: ["release"],
    evidence_kind: "proof_artifact",
  },
  {
    id: "private_tool_codex_acceptance",
    tier: "T5",
    working_directory: "mcp/synthi-mcp",
    package_script: "live:browser:private-tool-codex",
    command: "npm --prefix mcp/synthi-mcp run live:browser:private-tool-codex",
    required_for: ["release"],
    evidence_kind: "proof_artifact",
  },
  {
    id: "dojo_mcp_host_conformance",
    tier: "T6",
    working_directory: "mcp/synthi-mcp",
    package_script: "live:dojo:mcp-host-conformance",
    command: "npm --prefix mcp/synthi-mcp run live:dojo:mcp-host-conformance",
    required_for: ["release"],
    evidence_kind: "proof_artifact",
    requires_env: ["SYNTHI_DOJO_MCP_HOST_URL"],
  },
  {
    id: "private_tool_stdio_host_conformance",
    tier: "T6",
    working_directory: "mcp/synthi-mcp",
    package_script: "live:browser:private-tool-host-conformance",
    command: "npm --prefix mcp/synthi-mcp run live:browser:private-tool-host-conformance",
    required_for: ["release"],
    evidence_kind: "proof_artifact",
    requires_env: ["SYNTHI_HOSTED_BROWSER_CDP_URL"],
  },
  {
    id: "private_tool_codex_host_conformance",
    tier: "T6",
    working_directory: "mcp/synthi-mcp",
    package_script: "live:browser:private-tool-codex-host-conformance",
    command: "npm --prefix mcp/synthi-mcp run live:browser:private-tool-codex-host-conformance",
    required_for: ["release"],
    evidence_kind: "proof_artifact",
    requires_env: ["SYNTHI_HOSTED_BROWSER_CDP_URL"],
  },
  {
    id: "security_abuse_suite",
    tier: "T7",
    working_directory: "mcp/synthi-mcp",
    package_script: "proof:dojo:security-abuse:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:security-abuse:self-check",
    required_for: ["release"],
    evidence_kind: "test_report",
  },
  {
    id: "dojo_chaos_performance_self_check",
    tier: "T8",
    working_directory: "mcp/synthi-mcp",
    package_script: "proof:dojo:chaos-performance:self-check",
    command: "npm --prefix mcp/synthi-mcp run proof:dojo:chaos-performance:self-check",
    required_for: ["nightly", "enterprise_release"],
    evidence_kind: "metrics",
  },
  {
    id: "soak_performance",
    tier: "T8",
    working_directory: "mcp/synthi-mcp",
    package_script: "soak",
    command: "npm --prefix mcp/synthi-mcp run soak",
    required_for: ["nightly", "enterprise_release"],
    evidence_kind: "metrics",
  },
];

export const DOJO_MINIMAL_PR_GATE_IDS = [
  "mcp_typecheck",
  "mcp_build",
  "mcp_unit_tests",
  "frontend_lint",
  "frontend_build",
  "frontend_dojo_unit_tests",
];

export const DOJO_MILESTONE_GATE_IDS = [
  ...DOJO_MINIMAL_PR_GATE_IDS,
  "mcp_integration_tests",
  "dojo_self_check",
  "dojo_mcp_host_conformance_self_check",
  "docker_integration",
  "dojo_full_visual_proof",
  "dojo_ghost_mode_visual_proof",
];

export const DOJO_RELEASE_GATE_IDS = [
  ...DOJO_MILESTONE_GATE_IDS,
  "workflow_e2e_hosted",
  "private_tool_stdio_acceptance",
  "private_tool_codex_acceptance",
  "dojo_mcp_host_conformance",
  "private_tool_stdio_host_conformance",
  "private_tool_codex_host_conformance",
  "security_abuse_suite",
];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outDir = path.resolve(args["out-dir"] || path.join(REPO_ROOT, "tmp", "dojo-release-gates"));
  if (truthy(args["self-check"])) {
    const artifacts = await runSelfCheck({ outDir });
    console.log(`[ok] Dojo release gate manifest self-check passed - manifest=${artifacts.manifest_path} evidence=${artifacts.evidence_path}`);
    return;
  }

  const packageScripts = await readPackageScripts();
  const manifest = buildDojoReleaseGateManifest({ packageScripts });
  const validation = validateDojoReleaseGateManifest(manifest, { packageScripts });
  if (!validation.ok) {
    throw new Error(`dojo_release_gate_manifest_invalid:${validation.errors.join(";")}`);
  }
  const artifacts = await writeDojoReleaseGateArtifacts({ outDir, manifest });
  console.log(`[ok] Dojo release gate manifest written - manifest=${artifacts.manifest_path} evidence=${artifacts.evidence_path}`);
}

export function buildDojoReleaseGateManifest({
  generatedAt = new Date().toISOString(),
  packageScripts = {},
} = {}) {
  const commands = DOJO_RELEASE_GATE_COMMANDS.map((gate) => ({
    ...gate,
    runnable: Boolean(gate.package_script || gate.command),
    script_exists: gate.package_script ? packageScriptExists(packageScripts, gate) : null,
  }));
  const tiers = DOJO_RELEASE_GATE_TIERS.map((tier) => ({
    ...tier,
    gate_count: commands.filter((gate) => gate.tier === tier.id).length,
  }));
  return {
    schema_version: "synthi.dojo.releaseGateManifest.v1",
    generated_at: generatedAt,
    tiers,
    minimal_pr_gate_ids: [...DOJO_MINIMAL_PR_GATE_IDS],
    milestone_gate_ids: [...DOJO_MILESTONE_GATE_IDS],
    release_gate_ids: [...DOJO_RELEASE_GATE_IDS],
    gates: commands,
    policy: {
      every_pr_requires: ["T0", "T1"],
      milestone_exit_requires: ["T0", "T1", "T2", "T3", "T4"],
      release_candidate_requires: ["T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7"],
      nightly_enterprise_requires: ["T8"],
      first_merge_standard:
        "First foundation PRs require T0, T1, and focused touched-surface tests; live, deployed, chaos, and soak gates wait for release scope.",
    },
  };
}

export function validateDojoReleaseGateManifest(manifest, { packageScripts = {} } = {}) {
  const errors = [];
  const tierIds = new Set((manifest?.tiers || []).map((tier) => tier.id));
  for (const required of ["T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"]) {
    if (!tierIds.has(required)) errors.push(`missing_tier:${required}`);
  }
  const gates = Array.isArray(manifest?.gates) ? manifest.gates : [];
  const gateIds = new Set(gates.map((gate) => gate.id));
  for (const groupName of ["minimal_pr_gate_ids", "milestone_gate_ids", "release_gate_ids"]) {
    for (const id of manifest?.[groupName] || []) {
      if (!gateIds.has(id)) errors.push(`unknown_${groupName}:${id}`);
    }
  }
  for (const gate of gates) {
    if (!tierIds.has(gate.tier)) errors.push(`gate_unknown_tier:${gate.id}:${gate.tier}`);
    if (!Array.isArray(gate.required_for) || gate.required_for.length === 0) errors.push(`gate_missing_required_for:${gate.id}`);
    if (!gate.evidence_kind) errors.push(`gate_missing_evidence_kind:${gate.id}`);
    if (gate.package_script && !gatePackageScriptIsPresent(packageScripts, gate)) {
      errors.push(`missing_package_script:${gate.package_json || "mcp/synthi-mcp/package.json"}:${gate.package_script}`);
    }
  }
  const minimalTiers = new Set((manifest?.minimal_pr_gate_ids || []).map((id) => gates.find((gate) => gate.id === id)?.tier));
  if (!minimalTiers.has("T0")) errors.push("minimal_pr_missing_T0");
  if (!minimalTiers.has("T1")) errors.push("minimal_pr_missing_T1");
  const releaseTiers = new Set((manifest?.release_gate_ids || []).map((id) => gates.find((gate) => gate.id === id)?.tier));
  for (const required of ["T5", "T6", "T7"]) {
    if (!releaseTiers.has(required)) errors.push(`release_missing_${required}`);
  }
  for (const gate of gates.filter((item) => item.tier === "T4")) {
    if (gate.evidence_kind !== "visual_report") errors.push(`visual_gate_missing_report_contract:${gate.id}`);
    if (!gate.report_schema_version) errors.push(`visual_gate_missing_schema:${gate.id}`);
    if (!gate.default_report_path) errors.push(`visual_gate_missing_report_path:${gate.id}`);
    if (!gate.visual_report_requirements?.requires_pixel_metrics) errors.push(`visual_gate_missing_pixel_metrics:${gate.id}`);
    if (!gate.visual_report_requirements?.requires_layout_metrics) errors.push(`visual_gate_missing_layout_metrics:${gate.id}`);
  }
  return {
    ok: errors.length === 0,
    errors,
    tier_count: tierIds.size,
    gate_count: gates.length,
  };
}

export function validateDojoVisualProofReport(report, {
  gate = {},
  requirements = gate.visual_report_requirements || DOJO_VISUAL_REPORT_REQUIREMENTS,
} = {}) {
  const errors = [];
  if (gate.report_schema_version && report?.schema_version !== gate.report_schema_version) {
    errors.push(`schema_mismatch:${report?.schema_version || "missing"}:${gate.report_schema_version}`);
  }
  if (requirements.requires_report_ok && report?.ok !== true) {
    errors.push("visual_report_not_ok");
  }
  const results = Array.isArray(report?.results) ? report.results : [];
  if (results.length === 0) {
    errors.push("visual_report_missing_results");
  }
  for (const [index, result] of results.entries()) {
    const label = result.route_id || result.name || String(index);
    if (requirements.requires_result_ok && result.ok !== true) {
      errors.push(`visual_result_not_ok:${label}`);
    }
    if (
      requirements.requires_empty_failed_visual_gates
      && Array.isArray(result.failed_visual_gates)
      && result.failed_visual_gates.length > 0
    ) {
      errors.push(`visual_result_failed_gates:${label}:${result.failed_visual_gates.join(",")}`);
    }
    for (const fieldPath of requirements.required_result_fields || []) {
      if (valueAtPath(result, fieldPath) === undefined) {
        errors.push(`visual_result_missing_field:${label}:${fieldPath}`);
      }
    }
    if (requirements.requires_pixel_metrics && result.image_metrics?.pixel_metrics_verified !== true) {
      errors.push(`visual_result_pixel_metrics_unverified:${label}`);
    }
    const overflow = Number(result.layout_metrics?.horizontal_overflow_px);
    if (!Number.isFinite(overflow)) {
      errors.push(`visual_result_layout_overflow_unmeasured:${label}`);
    } else if (overflow > requirements.max_horizontal_overflow_px) {
      errors.push(`visual_result_horizontal_overflow:${label}:${overflow}`);
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    result_count: results.length,
  };
}

export function buildDojoReleaseGateEvidenceManifest({ manifest, manifestPath, serialized }) {
  const body = typeof serialized === "string" ? serialized : JSON.stringify(manifest);
  const validation = validateDojoReleaseGateManifest(manifest);
  const visualGates = Array.isArray(manifest?.gates)
    ? manifest.gates.filter((gate) => gate.evidence_kind === "visual_report")
    : [];
  return {
    schema_version: "synthi.dojo.releaseGateEvidence.v1",
    generated_at: new Date().toISOString(),
    manifest_path: manifestPath,
    manifest_sha256: sha256(body),
    manifest_bytes: Buffer.byteLength(body),
    validation_ok: validation.ok,
    validation_errors: validation.errors,
    tier_count: Array.isArray(manifest?.tiers) ? manifest.tiers.length : 0,
    gate_count: Array.isArray(manifest?.gates) ? manifest.gates.length : 0,
    minimal_pr_gate_count: Array.isArray(manifest?.minimal_pr_gate_ids) ? manifest.minimal_pr_gate_ids.length : 0,
    milestone_gate_count: Array.isArray(manifest?.milestone_gate_ids) ? manifest.milestone_gate_ids.length : 0,
    release_gate_count: Array.isArray(manifest?.release_gate_ids) ? manifest.release_gate_ids.length : 0,
    visual_report_gate_count: visualGates.length,
    visual_report_gate_ids: visualGates.map((gate) => gate.id),
  };
}

export async function writeDojoReleaseGateArtifacts({ outDir, manifest }) {
  await mkdir(outDir, { recursive: true });
  const manifestPath = path.join(outDir, "dojo-release-gate-manifest.json");
  const evidencePath = path.join(outDir, "dojo-release-gate-manifest.evidence.json");
  const serialized = JSON.stringify(manifest, null, 2);
  const evidence = buildDojoReleaseGateEvidenceManifest({
    manifest,
    manifestPath,
    serialized,
  });
  await writeFile(manifestPath, serialized);
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  return {
    manifest_path: manifestPath,
    evidence_path: evidencePath,
    manifest,
    evidence,
  };
}

export async function runSelfCheck({ outDir }) {
  const packageScripts = await readPackageScripts();
  const manifest = buildDojoReleaseGateManifest({
    generatedAt: "2026-06-11T00:00:00.000Z",
    packageScripts,
  });
  const validation = validateDojoReleaseGateManifest(manifest, { packageScripts });
  assert.equal(validation.ok, true, validation.errors.join(";"));
  assert.equal(manifest.tiers.length, 9);
  assert(manifest.minimal_pr_gate_ids.length > 0);
  assert(manifest.milestone_gate_ids.includes("dojo_self_check"));
  assert(manifest.milestone_gate_ids.includes("dojo_full_visual_proof"));
  assert(manifest.release_gate_ids.includes("dojo_mcp_host_conformance"));
  assert(manifest.release_gate_ids.includes("security_abuse_suite"));
  assert(manifest.gates.some((gate) => gate.id === "dojo_chaos_performance_self_check" && gate.tier === "T8"));
  assert(manifest.gates.some((gate) => gate.tier === "T8"));
  return writeDojoReleaseGateArtifacts({ outDir, manifest });
}

async function readPackageScripts() {
  const mcpPackage = JSON.parse(await readFile(path.join(MCP_ROOT, "package.json"), "utf8"));
  const frontendPackage = JSON.parse(await readFile(path.join(REPO_ROOT, "synthi", "package.json"), "utf8"));
  return {
    "mcp/synthi-mcp/package.json": mcpPackage.scripts || {},
    "synthi/package.json": frontendPackage.scripts || {},
  };
}

function packageScriptExists(packageScripts, gate) {
  const packageJson = gate.package_json || "mcp/synthi-mcp/package.json";
  return Boolean(packageScripts?.[packageJson]?.[gate.package_script]);
}

function gatePackageScriptIsPresent(packageScripts, gate) {
  const packageJson = gate.package_json || "mcp/synthi-mcp/package.json";
  if (packageScripts?.[packageJson]) return packageScriptExists(packageScripts, gate);
  return gate.script_exists !== false;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function valueAtPath(source, fieldPath) {
  return String(fieldPath).split(".").reduce((current, key) => {
    if (current === undefined || current === null) return undefined;
    return current[key];
  }, source);
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
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

function truthy(value) {
  if (value === undefined || value === null || value === false) return false;
  if (value === true) return true;
  const normalized = String(value).trim().toLowerCase();
  return Boolean(normalized) && !["0", "false", "no", "off"].includes(normalized);
}

function isDirectRun() {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}
