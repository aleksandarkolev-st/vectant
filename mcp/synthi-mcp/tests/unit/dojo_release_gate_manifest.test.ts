// @ts-nocheck
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDojoReleaseGateEvidenceManifest,
  buildDojoReleaseGateManifest,
  DOJO_ENTERPRISE_RELEASE_GATE_IDS,
  DOJO_FULL_VISUAL_ROUTE_IDS,
  DOJO_FULL_VISUAL_VIEWPORTS,
  DOJO_GHOST_MODE_VISUAL_ROUTE_IDS,
  DOJO_GHOST_MODE_VISUAL_VIEWPORTS,
  DOJO_LIVE_CHAOS_COMMAND_ENVS,
  DOJO_LIVE_CHAOS_ENABLE_ENV,
  DOJO_LIVE_CHAOS_REQUIRED_ENV,
  DOJO_LIVE_CHAOS_SCENARIOS,
  DOJO_MCP_HOST_CONFORMANCE_REQUIREMENTS,
  DOJO_MILESTONE_GATE_IDS,
  DOJO_MINIMAL_PR_GATE_IDS,
  DOJO_RELEASE_OBSERVATION_FUTURE_TOLERANCE_MS,
  DOJO_RELEASE_OBSERVATION_MAX_AGE_MS,
  DOJO_RELEASE_GATE_IDS,
  DOJO_RELEASE_GATE_TIERS,
  validateDojoReleaseGateManifest,
  validateDojoVisualProofReport,
} from "../../scripts/dojo-release-gate-manifest.mjs";
import {
  DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES,
  DOJO_AGENT_READY_UI_CONTRACT_TEST_FILES,
} from "../../scripts/dojo-agent-ready-ui-contract-self-check.mjs";
import {
  DOJO_API_TOOL_COMPILER_CAPABILITIES,
  DOJO_API_TOOL_COMPILER_TEST_FILES,
} from "../../scripts/dojo-api-tool-compiler-self-check.mjs";
import {
  DOJO_CASE_LAW_RUNTIME_CAPABILITIES,
  DOJO_CASE_LAW_RUNTIME_TEST_FILES,
} from "../../scripts/dojo-case-law-runtime-self-check.mjs";
import {
  DOJO_CHECKRIDE_LICENSE_CAPABILITIES,
  DOJO_CHECKRIDE_LICENSE_TEST_FILES,
} from "../../scripts/dojo-checkride-license-self-check.mjs";
import {
  DOJO_CHAOS_PERFORMANCE_REQUIRED_METRICS,
  DOJO_CHAOS_PERFORMANCE_TEST_FILES,
  DOJO_CHAOS_SCENARIOS,
} from "../../scripts/dojo-chaos-performance-self-check.mjs";
import {
  DOJO_SOAK_PERFORMANCE_OPERATION_CLASSES,
  DOJO_SOAK_PERFORMANCE_REQUIRED_METRICS,
  DOJO_SOAK_PERFORMANCE_TEST_FILES,
} from "../../scripts/dojo-soak-performance-self-check.mjs";
import {
  DOJO_COMPLIANCE_EXPORT_CAPABILITIES,
  DOJO_COMPLIANCE_EXPORT_TEST_FILES,
} from "../../scripts/dojo-compliance-export-self-check.mjs";
import {
  DOJO_DOCKER_HEALTHY_SERVICES,
  DOJO_DOCKER_REQUIRED_ENDPOINTS,
  DOJO_DOCKER_REQUIRED_SERVICES,
} from "../../scripts/dojo-docker-integration-self-check.mjs";
import {
  DOJO_EVIDENCE_AUTHORITY_CAPABILITIES,
  DOJO_EVIDENCE_AUTHORITY_TEST_FILES,
} from "../../scripts/dojo-evidence-authority-self-check.mjs";
import {
  DOJO_GENERATED_PR_CAPABILITIES,
  DOJO_GENERATED_PR_TEST_FILES,
} from "../../scripts/dojo-generated-pr-self-check.mjs";
import {
  DOJO_MCP_SKILL_BUS_CAPABILITIES,
  DOJO_MCP_SKILL_BUS_TEST_FILES,
} from "../../scripts/dojo-mcp-skill-bus-self-check.mjs";
import {
  DOJO_PACKAGE_READINESS_REQUIRED_FILE_ENTRIES,
  DOJO_PACKAGE_READINESS_REQUIRED_METADATA_FIELDS,
  DOJO_PACKAGE_READINESS_REQUIRED_SCRIPT_SELECTORS,
  DOJO_PACKAGE_READINESS_REQUIRED_SCRIPT_NAMES,
} from "../../scripts/dojo-package-readiness-self-check.mjs";
import {
  DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES,
  DOJO_GOVERNANCE_LIFECYCLE_TEST_FILES,
} from "../../scripts/dojo-governance-lifecycle-self-check.mjs";
import {
  DOJO_GRAPH_RUNTIME_CAPABILITIES,
  DOJO_GRAPH_RUNTIME_TEST_FILES,
} from "../../scripts/dojo-graph-runtime-self-check.mjs";
import {
  DOJO_GHOST_MODE_EVIDENCE_CAPABILITIES,
  DOJO_GHOST_MODE_EVIDENCE_TEST_FILES,
} from "../../scripts/dojo-ghost-mode-evidence-self-check.mjs";
import {
  DOJO_SKILL_PASSPORT_CAPABILITIES,
  DOJO_SKILL_PASSPORT_TEST_FILES,
} from "../../scripts/dojo-skill-passport-self-check.mjs";
import {
  DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES,
  DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_ENV,
  DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_GATE_IDS,
  DOJO_HOSTED_RUNTIME_GATEWAY_TEST_FILES,
} from "../../scripts/dojo-hosted-runtime-gateway-self-check.mjs";
import {
  DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_COMMAND,
  DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_DEFAULT_PATH,
  DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_INPUTS,
  DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_PACKAGE_SCRIPT,
} from "../../scripts/dojo-hosted-runtime-gateway-release-observation.mjs";
import {
  DOJO_IMPLEMENTATION_STATUS_CAPABILITIES,
  DOJO_IMPLEMENTATION_STATUS_TEST_FILES,
} from "../../scripts/dojo-implementation-status-self-check.mjs";
import {
  DOJO_VIVARIUM_RUNTIME_CAPABILITIES,
  DOJO_VIVARIUM_RUNTIME_TEST_FILES,
} from "../../scripts/dojo-vivarium-runtime-self-check.mjs";
import {
  DOJO_MANAGED_KEY_SIGNING_CAPABILITIES,
  DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_CHECKS,
  DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_ENV,
  DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_SCHEMA_VERSION,
  DOJO_MANAGED_KEY_SIGNING_TEST_FILES,
} from "../../scripts/dojo-managed-key-signing-self-check.mjs";
import {
  DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_COMMAND,
  DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_DEFAULT_PATH,
  DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_PACKAGE_SCRIPT,
  DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_REQUIRED_ENV,
} from "../../scripts/dojo-managed-key-signing-release-observation.mjs";
import {
  DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES,
  DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES,
} from "../../scripts/dojo-postgres-control-plane-self-check.mjs";
import {
  DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES,
  DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES,
} from "../../scripts/dojo-public-proof-verification-self-check.mjs";
import {
  DOJO_PRIVACY_REDACTION_CAPABILITIES,
  DOJO_PRIVACY_REDACTION_TEST_FILES,
} from "../../scripts/dojo-privacy-redaction-self-check.mjs";
import {
  DOJO_SECURITY_ABUSE_CLASSES,
  DOJO_SECURITY_ABUSE_TEST_FILES,
} from "../../scripts/dojo-security-abuse-self-check.mjs";
import {
  DOJO_SOURCE_DRIFT_CAPABILITIES,
  DOJO_SOURCE_DRIFT_TEST_FILES,
} from "../../scripts/dojo-source-drift-self-check.mjs";
import {
  DOJO_TIME_MACHINE_DEBUGGER_CAPABILITIES,
  DOJO_TIME_MACHINE_DEBUGGER_TEST_FILES,
} from "../../scripts/dojo-time-machine-debugger-self-check.mjs";

const PACKAGE_SCRIPTS = {
  "mcp/synthi-mcp/package.json": {
    typecheck: "tsc --noEmit",
    build: "tsc",
    "test:unit": "vitest run tests/unit",
    "test:integration": "vitest run tests/integration",
    "test:dojo:postgres-control-plane": "vitest run tests/integration/dojo_postgres_schema.test.ts tests/integration/dojo_postgres_proof_store.test.ts tests/integration/dojo_postgres_proof_key_registry.test.ts tests/integration/dojo_evidence_ledger_store.test.ts tests/integration/dojo_audit_store.test.ts tests/integration/dojo_postgres_skill_store.test.ts tests/integration/dojo_postgres_license_store.test.ts tests/integration/dojo_postgres_tool_control_plane.test.ts tests/integration/dojo_postgres_ghost_shadow_evidence_store.test.ts tests/integration/dojo_postgres_governance_store.test.ts tests/integration/dojo_postgres_source_registry_store.test.ts tests/integration/dojo_postgres_mcp_skill_bus_store.test.ts tests/integration/dojo_postgres_graph_run_store.test.ts tests/integration/dojo_postgres_hosted_runtime_store.test.ts tests/integration/dojo_hosted_runtime_gateway_resolver.test.ts tests/integration/dojo_postgres_mcp_host_conformance_store.test.ts tests/integration/dojo_proof_ledger_tool.test.ts",
    "proof:dojo:self-check": "node scripts/dojo-proof-self-check.mjs",
    "proof:dojo:mcp-host-conformance:self-check": "node scripts/dojo-mcp-host-conformance.mjs --self-check",
    "proof:dojo:docker-integration:self-check": "node scripts/dojo-docker-integration-self-check.mjs",
    "proof:dojo:postgres-control-plane:self-check": "node scripts/dojo-postgres-control-plane-self-check.mjs",
    "proof:dojo:affordance-codemod:self-check": "node scripts/dojo-affordance-codemod-self-check.mjs",
    "proof:dojo:agent-ready-ui-contract:self-check": "node scripts/dojo-agent-ready-ui-contract-self-check.mjs",
    "proof:dojo:api-tool-compiler:self-check": "node scripts/dojo-api-tool-compiler-self-check.mjs",
    "proof:dojo:evidence-authority:self-check": "node scripts/dojo-evidence-authority-self-check.mjs",
    "proof:dojo:generated-pr:self-check": "node scripts/dojo-generated-pr-self-check.mjs",
    "proof:dojo:mcp-skill-bus:self-check": "node scripts/dojo-mcp-skill-bus-self-check.mjs",
    "proof:dojo:source-drift:self-check": "node scripts/dojo-source-drift-self-check.mjs",
    "proof:dojo:managed-key-signing:self-check": "node scripts/dojo-managed-key-signing-self-check.mjs",
    "proof:dojo:governance-lifecycle:self-check": "node scripts/dojo-governance-lifecycle-self-check.mjs",
    "proof:dojo:graph-runtime:self-check": "node scripts/dojo-graph-runtime-self-check.mjs",
    "proof:dojo:ghost-mode-evidence:self-check": "node scripts/dojo-ghost-mode-evidence-self-check.mjs",
    "proof:dojo:skill-passport:self-check": "node scripts/dojo-skill-passport-self-check.mjs",
    "proof:dojo:time-machine-debugger:self-check": "node scripts/dojo-time-machine-debugger-self-check.mjs",
    "proof:dojo:vivarium-runtime:self-check": "node scripts/dojo-vivarium-runtime-self-check.mjs",
    "proof:dojo:checkride-license:self-check": "node scripts/dojo-checkride-license-self-check.mjs",
    "proof:dojo:implementation-status:self-check": "node scripts/dojo-implementation-status-self-check.mjs",
    "proof:dojo:release-gates:runner:self-check": "node scripts/dojo-release-gate-runner.mjs --self-check",
    "proof:dojo:release-gates:verify:self-check": "node scripts/dojo-release-gate-verify.mjs --self-check",
    "proof:dojo:package-readiness:self-check": "node scripts/dojo-package-readiness-self-check.mjs",
    "proof:dojo:case-law-runtime:self-check": "node scripts/dojo-case-law-runtime-self-check.mjs",
    "proof:dojo:hosted-runtime-gateway:self-check": "node scripts/dojo-hosted-runtime-gateway-self-check.mjs",
    "proof:dojo:security-abuse:self-check": "node scripts/dojo-security-abuse-self-check.mjs",
    "proof:dojo:compliance-export:self-check": "node scripts/dojo-compliance-export-self-check.mjs",
    "proof:dojo:privacy-redaction:self-check": "node scripts/dojo-privacy-redaction-self-check.mjs",
    "proof:dojo:chaos-performance:self-check": "node scripts/dojo-chaos-performance-self-check.mjs",
    "proof:dojo:soak-performance:self-check": "node scripts/dojo-soak-performance-self-check.mjs",
    "proof:dojo:public-proof-verification:self-check": "node scripts/dojo-public-proof-verification-self-check.mjs",
    "chaos:dojo:live": "node tests/chaos/runner.mjs --kind live --require-scenarios --json ../../tmp/dojo-chaos-runner/live-chaos-runner.report.json",
    "live:browser:workflow-pipeline": "node scripts/workflow-pipeline-e2e.mjs",
    "live:browser:private-tool-stdio": "node scripts/private-tool-stdio-acceptance.mjs",
    "live:browser:private-tool-codex": "node scripts/private-tool-codex-acceptance.mjs",
    "live:dojo:mcp-host-conformance": "node scripts/dojo-mcp-host-conformance.mjs --out-dir tmp/dojo-mcp-host-conformance-live --require-non-loopback-mcp-host --execute-production --require-external-control-plane-store --require-external-proof-signing --require-bridge-token --require-no-local-cdp --require-licensed-skill-filtering",
    "live:browser:private-tool-host-conformance": "node scripts/private-tool-stdio-acceptance.mjs --require-custom-mcp-command --require-non-loopback-runtime --require-external-private-tool-store",
    "live:browser:private-tool-codex-host-conformance": "node scripts/private-tool-codex-acceptance.mjs --require-non-loopback-runtime --require-external-private-tool-store",
    soak: "node tests/soak/soak_loop.mjs",
  },
  "synthi/package.json": {
    lint: "next lint",
    build: "next build",
    "proof:dojo:visual": "node scripts/dojo-visual-proof.mjs",
    "proof:dojo:ghost-mode-visual": "node scripts/dojo-ghost-mode-visual-proof.mjs",
    test: "vitest run",
  },
};

describe("Dojo release gate manifest", () => {
  it("keeps the package Postgres control-plane script aligned with the authoritative self-check suite", () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    const script = packageJson.scripts["test:dojo:postgres-control-plane"];
    const scriptFiles = script.split(/\s+/).filter((part) => part.endsWith(".test.ts"));

    expect(scriptFiles).toEqual(DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES);
  });

  it("publishes script harnesses used by release-gate package scripts", () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    expect(packageJson.scripts["chaos:dojo:preflight"]).toContain("tests/chaos/runner.mjs");
    expect(packageJson.scripts["chaos:dojo:live"]).toContain("tests/chaos/runner.mjs");
    expect(packageJson.scripts.soak).toContain("tests/soak/soak_loop.mjs");
    expect(packageJson.scripts["proof:dojo:package-readiness:self-check"]).toContain("scripts/dojo-package-readiness-self-check.mjs");
    expect(packageJson.files).toContain("scripts/dojo-package-readiness-self-check.mjs");
    expect(packageJson.files).toContain("tests/chaos");
    expect(packageJson.files).toContain("tests/soak");
  });

  it("defines the complete T0 through T8 tier matrix", () => {
    expect(DOJO_RELEASE_GATE_TIERS.map((tier) => tier.id)).toEqual([
      "T0",
      "T1",
      "T2",
      "T3",
      "T4",
      "T5",
      "T6",
      "T7",
      "T8",
    ]);
    expect(DOJO_RELEASE_GATE_TIERS.every((tier) => tier.name && tier.required_for && tier.purpose)).toBe(true);
  });

  it("builds a manifest with minimal, milestone, and release gate slices", () => {
    const manifest = buildDojoReleaseGateManifest({
      generatedAt: "2026-06-11T00:00:00.000Z",
      packageScripts: PACKAGE_SCRIPTS,
    });

    expect(manifest.schema_version).toBe("synthi.dojo.releaseGateManifest.v1");
    expect(manifest.minimal_pr_gate_ids).toEqual(DOJO_MINIMAL_PR_GATE_IDS);
    expect(manifest.milestone_gate_ids).toEqual(DOJO_MILESTONE_GATE_IDS);
    expect(manifest.release_gate_ids).toEqual(DOJO_RELEASE_GATE_IDS);
    expect(manifest.enterprise_release_gate_ids).toEqual(DOJO_ENTERPRISE_RELEASE_GATE_IDS);
    expect(manifest.enterprise_release_gate_ids).toEqual(expect.arrayContaining([
      ...DOJO_RELEASE_GATE_IDS,
      "dojo_chaos_performance_self_check",
      "dojo_soak_performance_self_check",
      "dojo_package_readiness_self_check",
      "soak_performance",
    ]));
    expect(manifest.policy.every_pr_requires).toEqual(["T0", "T1"]);
    expect(manifest.policy.enterprise_release_requires).toEqual(["T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"]);
    expect(manifest.policy.nightly_requires).toEqual(["T8"]);
    expect(manifest.gates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "dojo_implementation_status_self_check",
        tier: "T1",
        package_script: "proof:dojo:implementation-status:self-check",
        evidence_kind: "proof_artifact",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.implementationStatusEvidence.v1",
        default_evidence_path: "tmp/dojo-implementation-status/dojo-implementation-status.evidence.json",
        artifact_requirements: expect.objectContaining({
          require_all_implementation_status_capabilities_covered: true,
          required_implementation_status_capabilities: DOJO_IMPLEMENTATION_STATUS_CAPABILITIES,
          required_test_files: DOJO_IMPLEMENTATION_STATUS_TEST_FILES,
          require_stable_vocabulary: true,
          require_every_tool_classified: true,
          require_machine_manifest_sync: true,
          require_human_status_doc_sync: true,
          require_unknown_tool_fails_planned: true,
          require_production_runtime_claim_boundary: true,
          require_runtime_scope_for_executable: true,
          require_report_surface_no_overclaim: true,
          require_proof_dispatch_hosted_runtime_boundary: true,
          require_ghost_mode_non_mutating_boundary: true,
          require_control_plane_write_boundary: true,
          require_immutable_metadata: true,
          require_self_check_executes_tests: true,
          require_no_failed_tests: true,
          require_no_skipped_tests: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_package_readiness_self_check",
        tier: "T2",
        package_script: "proof:dojo:package-readiness:self-check",
        evidence_kind: "proof_artifact",
        evidence_schema_version: "synthi.dojo.packageReadinessEvidence.v1",
        default_evidence_path: "tmp/dojo-package-readiness/dojo-package-readiness.evidence.json",
        artifact_requirements: expect.objectContaining({
          require_npm_pack_dry_run: true,
          require_package_metadata_fields: DOJO_PACKAGE_READINESS_REQUIRED_METADATA_FIELDS,
          required_package_script_selectors: DOJO_PACKAGE_READINESS_REQUIRED_SCRIPT_SELECTORS,
          required_package_scripts: DOJO_PACKAGE_READINESS_REQUIRED_SCRIPT_NAMES,
          required_package_files_entries: DOJO_PACKAGE_READINESS_REQUIRED_FILE_ENTRIES,
          require_public_package: true,
          require_exports_present_in_pack: true,
          require_release_harness_scripts_present_in_pack: true,
          require_package_files_cover_script_paths: true,
          require_pack_integrity: true,
          require_stdout_stderr_digest_match: true,
          require_pack_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_release_gate_runner_self_check",
        tier: "T2",
        package_script: "proof:dojo:release-gates:runner:self-check",
        command: "npm --prefix mcp/synthi-mcp run proof:dojo:release-gates:runner:self-check -- --out-dir ../../tmp/dojo-release-gate-runner-self-check",
        evidence_kind: "proof_artifact",
        script_exists: true,
        report_schema_version: "synthi.dojo.releaseGateRun.v1",
        evidence_schema_version: "synthi.dojo.releaseGateRunEvidence.v1",
        default_report_path: "tmp/dojo-release-gate-runner-self-check/dojo-release-gate-runner-report.json",
        default_evidence_path: "tmp/dojo-release-gate-runner-self-check/dojo-release-gate-runner.evidence.json",
        artifact_requirements: expect.objectContaining({
          require_manifest_validation: true,
          require_scope_plans: ["minimal-pr", "milestone", "enterprise-release"],
          require_no_live_or_nightly_in_minimal_plan: true,
          require_enterprise_release_scope_includes_release_and_t8: true,
          require_skips_missing_env_gates: true,
          require_fake_execution_promotion_ready: true,
          require_report_evidence_pair: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_release_gate_verifier_self_check",
        tier: "T2",
        package_script: "proof:dojo:release-gates:verify:self-check",
        evidence_kind: "proof_artifact",
        script_exists: true,
        report_schema_version: "synthi.dojo.releaseGateVerifierSelfCheck.v1",
        evidence_schema_version: "synthi.dojo.releaseGateVerifierSelfCheckEvidence.v1",
        default_report_path: "tmp/dojo-release-gate-verify/dojo-release-gate-verifier-self-check.json",
        default_evidence_path: "tmp/dojo-release-gate-verify/dojo-release-gate-verifier-self-check.evidence.json",
        artifact_requirements: expect.objectContaining({
          require_manifest_verification: true,
          require_release_gate_runner_self_check_verification: true,
          require_negative_controls: true,
          require_report_evidence_pair: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_self_check",
        tier: "T2",
        script_exists: true,
        command: "npm --prefix mcp/synthi-mcp run proof:dojo:self-check -- --run-id release-gate",
        report_schema_version: "synthi.dojo.proofSelfCheckSummary.v1",
        evidence_schema_version: "synthi.dojo.proofSelfCheck.productionRuntimeEvidence.v1",
        default_report_path: "mcp/synthi-mcp/tmp/dojo-proof-self-check/release-gate/summary.json",
        default_evidence_path: "mcp/synthi-mcp/tmp/dojo-proof-self-check/release-gate/production-runtime-evidence.json",
        artifact_requirements: expect.objectContaining({
          require_production_proof_consumed: true,
          require_proof_replay_blocked: true,
          require_runtime_custody_evidence: true,
          require_visual_pixel_metrics: true,
          require_no_runtime_credential_secret: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_mcp_host_conformance_self_check",
        tier: "T2",
        package_script: "proof:dojo:mcp-host-conformance:self-check",
        evidence_kind: "proof_artifact",
        script_exists: true,
        report_schema_version: "synthi.dojo.mcpHostConformance.selfCheck.v1",
        evidence_schema_version: "synthi.dojo.mcpHostConformanceEvidence.v1",
        default_report_path: "tmp/dojo-mcp-host-conformance/dojo-mcp-host-conformance.json",
        default_evidence_path: "tmp/dojo-mcp-host-conformance/dojo-mcp-host-conformance.evidence.json",
        artifact_requirements: expect.objectContaining({
          require_loopback_rejection: true,
          require_private_network_rejection: true,
          require_link_local_rejection: true,
          require_unique_local_ipv6_rejection: true,
          require_report_redaction: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_postgres_control_plane_self_check",
        tier: "T2",
        package_script: "proof:dojo:postgres-control-plane:self-check",
        evidence_kind: "proof_artifact",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.postgresControlPlaneEvidence.v1",
        default_evidence_path: "tmp/dojo-postgres-control-plane/dojo-postgres-control-plane.evidence.json",
        artifact_requirements: expect.objectContaining({
          require_postgres_url: true,
          require_all_control_plane_capabilities_covered: true,
          required_control_plane_capabilities: DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES,
          required_test_files: DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES,
          require_no_failed_tests: true,
          require_no_skipped_tests: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
        release_artifact_requirements: expect.objectContaining({
          require_external_postgres_control_plane: true,
          accepted_postgres_host_classes: ["remote_or_named"],
        }),
        requires_env: ["SYNTHI_DOJO_POSTGRES_TEST_URL"],
      }),
      expect.objectContaining({
        id: "dojo_evidence_authority_self_check",
        tier: "T2",
        package_script: "proof:dojo:evidence-authority:self-check",
        evidence_kind: "proof_artifact",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.evidenceAuthorityEvidence.v1",
        default_evidence_path: "tmp/dojo-evidence-authority/dojo-evidence-authority.evidence.json",
        artifact_requirements: expect.objectContaining({
          require_all_evidence_authority_capabilities_covered: true,
          required_evidence_authority_capabilities: DOJO_EVIDENCE_AUTHORITY_CAPABILITIES,
          required_test_files: DOJO_EVIDENCE_AUTHORITY_TEST_FILES,
          require_canonical_record_hash: true,
          require_record_signature_verification: true,
          require_tamper_detection: true,
          require_claim_freshness: true,
          require_claim_scope: true,
          require_claim_kind: true,
          require_ledger_resolver_fail_closed: true,
          require_redaction_manifest: true,
          require_redacted_export: true,
          require_evidence_retention_policy: true,
          require_legal_hold_blocks_disposal: true,
          require_external_storage_custody_receipts: true,
          require_proof_issue_claim_verification: true,
          require_production_proof_issue_rejects_unverified_claims: true,
          require_self_attested_claim_rejection: true,
          require_durable_postgres_ledger_gate: true,
          durable_postgres_ledger_gate_id: "dojo_postgres_control_plane_self_check",
          require_self_check_executes_tests: true,
          require_no_failed_tests: true,
          require_no_skipped_tests: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_affordance_codemod_self_check",
        tier: "T2",
        package_script: "proof:dojo:affordance-codemod:self-check",
        evidence_kind: "proof_artifact",
        script_exists: true,
        report_schema_version: "synthi.dojo.affordanceCodemodSelfCheck.v1",
        evidence_schema_version: "synthi.dojo.affordanceCodemodEvidence.v1",
      }),
      expect.objectContaining({
        id: "dojo_source_drift_self_check",
        tier: "T2",
        package_script: "proof:dojo:source-drift:self-check",
        evidence_kind: "proof_artifact",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.sourceDriftEvidence.v1",
        default_evidence_path: "tmp/dojo-source-drift/dojo-source-drift.evidence.json",
        artifact_requirements: expect.objectContaining({
          require_all_source_drift_capabilities_covered: true,
          required_source_drift_capabilities: DOJO_SOURCE_DRIFT_CAPABILITIES,
          required_test_files: DOJO_SOURCE_DRIFT_TEST_FILES,
          require_release_scoped_snapshot: true,
          require_signed_snapshot_verification: true,
          require_source_content_hash: true,
          require_changed_token_expiry: true,
          require_removed_token_expiry: true,
          require_added_risky_affordance_review: true,
          require_unrelated_token_no_expiry: true,
          require_tamper_rejection: true,
          require_license_store_expiry_application: true,
          require_recertification_handoff: true,
          require_self_check_executes_tests: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_agent_ready_ui_contract_self_check",
        tier: "T2",
        package_script: "proof:dojo:agent-ready-ui-contract:self-check",
        evidence_kind: "proof_artifact",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.agentReadyUiContractEvidence.v1",
        default_evidence_path: "tmp/dojo-agent-ready-ui-contract/dojo-agent-ready-ui-contract.evidence.json",
        artifact_requirements: expect.objectContaining({
          require_all_agent_ready_ui_contract_capabilities_covered: true,
          required_agent_ready_ui_contract_capabilities: DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES,
          required_test_files: DOJO_AGENT_READY_UI_CONTRACT_TEST_FILES,
          require_schema_linter: true,
          require_stable_locator: true,
          require_success_hook: true,
          require_proof_hook: true,
          require_proof_required_for_risky_action: true,
          require_accessibility_label: true,
          require_blocked_contexts: true,
          require_runtime_enum_validation: true,
          require_malformed_array_safety: true,
          require_proof_risk_mismatch_warning: true,
          require_self_check_executes_tests: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_api_tool_compiler_self_check",
        tier: "T2",
        package_script: "proof:dojo:api-tool-compiler:self-check",
        evidence_kind: "proof_artifact",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.apiToolCompilerEvidence.v1",
        default_evidence_path: "tmp/dojo-api-tool-compiler/dojo-api-tool-compiler.evidence.json",
        artifact_requirements: expect.objectContaining({
          require_all_api_tool_compiler_capabilities_covered: true,
          required_api_tool_compiler_capabilities: DOJO_API_TOOL_COMPILER_CAPABILITIES,
          required_test_files: DOJO_API_TOOL_COMPILER_TEST_FILES,
          require_reviewed_candidate: true,
          require_proof_capsule: true,
          require_license_kernel: true,
          require_idempotency: true,
          require_auth_scope: true,
          require_strict_input_schema: true,
          require_postcondition: true,
          require_evidence_write: true,
          require_graph_proof_match: true,
          require_self_check_executes_tests: true,
        }),
      }),
      expect.objectContaining({
        id: "docker_integration",
        tier: "T3",
        package_script: "proof:dojo:docker-integration:self-check",
        evidence_kind: "proof_artifact",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.dockerIntegrationEvidence.v1",
        default_evidence_path: "tmp/dojo-docker-integration/dojo-docker-integration.evidence.json",
        artifact_requirements: expect.objectContaining({
          require_compose_up_ran: true,
          require_all_required_services_running: true,
          required_services: DOJO_DOCKER_REQUIRED_SERVICES,
          require_required_healthchecks_healthy: true,
          required_healthy_services: DOJO_DOCKER_HEALTHY_SERVICES,
          require_required_endpoints_ok: true,
          required_endpoint_contracts: DOJO_DOCKER_REQUIRED_ENDPOINTS.map((endpoint) => ({
            id: endpoint.id,
            expected_status: endpoint.expected_status,
          })),
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
        requires_env: expect.arrayContaining([
          "NEXT_PUBLIC_SYNTHI_WORKSPACE_AUTH_BYPASS",
          "AI_ENGINE_HOST_PORT",
          "POSTGRES_HOST_PORT",
        ]),
      }),
      expect.objectContaining({
        id: "dojo_full_visual_proof",
        tier: "T4",
        evidence_kind: "visual_report",
        package_json: "synthi/package.json",
        package_script: "proof:dojo:visual",
        script_exists: true,
        report_schema_version: "synthi.dojo.visualProof.v1",
        visual_report_requirements: expect.objectContaining({
          requires_pixel_metrics: true,
          requires_layout_metrics: true,
          required_route_ids: DOJO_FULL_VISUAL_ROUTE_IDS,
          required_viewports: DOJO_FULL_VISUAL_VIEWPORTS,
          min_result_count: DOJO_FULL_VISUAL_ROUTE_IDS.length * DOJO_FULL_VISUAL_VIEWPORTS.length,
          requires_all_required_route_viewports: true,
          requires_unique_screenshot_paths: true,
          required_result_fields: expect.arrayContaining(["screenshot_sha256"]),
        }),
      }),
      expect.objectContaining({
        id: "dojo_ghost_mode_visual_proof",
        tier: "T4",
        evidence_kind: "visual_report",
        package_json: "synthi/package.json",
        package_script: "proof:dojo:ghost-mode-visual",
        script_exists: true,
        report_schema_version: "synthi.dojo.ghostModeVisualProof.v1",
        visual_report_requirements: expect.objectContaining({
          requires_pixel_metrics: true,
          requires_layout_metrics: true,
          required_route_ids: DOJO_GHOST_MODE_VISUAL_ROUTE_IDS,
          required_viewports: DOJO_GHOST_MODE_VISUAL_VIEWPORTS,
          min_result_count: DOJO_GHOST_MODE_VISUAL_ROUTE_IDS.length * DOJO_GHOST_MODE_VISUAL_VIEWPORTS.length,
          requires_all_required_route_viewports: true,
          requires_unique_screenshot_paths: true,
          required_result_fields: expect.arrayContaining(["screenshot_sha256"]),
        }),
      }),
      expect.objectContaining({ id: "dojo_mcp_host_conformance", tier: "T6", script_exists: true }),
      expect.objectContaining({
        id: "dojo_mcp_host_conformance",
        tier: "T6",
        package_script: "live:dojo:mcp-host-conformance",
        command: "npm --prefix mcp/synthi-mcp run live:dojo:mcp-host-conformance",
        report_schema_version: "synthi.dojo.mcpHostConformance.v1",
        evidence_schema_version: "synthi.dojo.mcpHostConformanceEvidence.v1",
        default_report_path: "tmp/dojo-mcp-host-conformance-live/dojo-mcp-host-conformance.json",
        default_evidence_path: "tmp/dojo-mcp-host-conformance-live/dojo-mcp-host-conformance.evidence.json",
        release_artifact_requirements: DOJO_MCP_HOST_CONFORMANCE_REQUIREMENTS,
        requires_env: expect.arrayContaining([
          "SYNTHI_DOJO_MCP_HOST_URL",
          "SYNTHI_DOJO_MCP_CONFORMANCE_EXTERNAL_CONTROL_PLANE_STORE",
          "SYNTHI_DOJO_MCP_CONFORMANCE_EXTERNAL_PROOF_SIGNING",
          "SYNTHI_DOJO_MCP_CONFORMANCE_BRIDGE_TOKEN_REQUIRED",
          "SYNTHI_DOJO_MCP_CONFORMANCE_NO_LOCAL_CDP_LEAKAGE",
          "SYNTHI_DOJO_MCP_CONFORMANCE_LICENSED_SKILL_FILTERING",
        ]),
      }),
      expect.objectContaining({
        id: "private_tool_stdio_host_conformance",
        tier: "T6",
        report_schema_version: "synthi.dojo.privateToolStdioAcceptance.v1",
        default_report_path: "tmp/private-tool-stdio-host-conformance/mcp-stdio-private-tool-acceptance.json",
        command: "npm --prefix mcp/synthi-mcp run live:browser:private-tool-host-conformance -- --out-dir tmp/private-tool-stdio-host-conformance",
        release_artifact_requirements: expect.objectContaining({
          require_non_loopback_runtime: true,
          require_external_private_tool_store: true,
          require_external_private_tool_store_location_policy: true,
          require_no_local_attach: true,
          require_private_tool_call: true,
          require_custom_mcp_command: true,
          require_strict_schema: true,
          require_visual_proof: true,
        }),
        requires_env: expect.arrayContaining([
          "SYNTHI_HOSTED_BROWSER_CDP_URL",
          "SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE",
          "SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY",
          "SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE",
          "SYNTHI_PRIVATE_TOOL_ACCEPTANCE_TARGET_URL",
        ]),
      }),
      expect.objectContaining({
        id: "private_tool_codex_host_conformance",
        tier: "T6",
        report_schema_version: "synthi.dojo.privateToolCodexAcceptance.v1",
        default_report_path: "tmp/private-tool-codex-host-conformance/codex-private-tool-acceptance.json",
        command: "npm --prefix mcp/synthi-mcp run live:browser:private-tool-codex-host-conformance -- --out-dir tmp/private-tool-codex-host-conformance",
        release_artifact_requirements: expect.objectContaining({
          require_non_loopback_runtime: true,
          require_external_private_tool_store: true,
          require_external_private_tool_store_location_policy: true,
          require_no_local_attach: true,
          require_private_tool_call: true,
          require_agent_mcp_only: true,
          require_no_shell_commands: true,
          require_visual_proof: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_generated_pr_self_check",
        tier: "T7",
        package_script: "proof:dojo:generated-pr:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.generatedPrEvidence.v1",
        default_evidence_path: "tmp/dojo-generated-pr/dojo-generated-pr.evidence.json",
        release_artifact_requirements: expect.objectContaining({
          require_all_generated_pr_capabilities_covered: true,
          required_generated_pr_capabilities: DOJO_GENERATED_PR_CAPABILITIES,
          required_test_files: DOJO_GENERATED_PR_TEST_FILES,
          require_reviewable_metadata: true,
          require_caller_supplied_code_owner_rules: true,
          require_proof_impact: true,
          require_code_owner_glob_matching: true,
          require_unsafe_branch_rejection: true,
          require_branch_plan: true,
          require_promotion_blocker: true,
          require_source_patch_bundle: true,
          require_missing_source_rejection: true,
          require_generated_contract_tests: true,
          require_patch_writer: true,
          require_path_traversal_rejection: true,
          require_duplicate_output_rejection: true,
          require_dry_run: true,
          require_stale_source_rejection: true,
          require_idempotent_write: true,
          require_branch_applier: true,
          require_file_hash_verification: true,
          require_unresolved_blocker_rejection: true,
          require_git_branch_creation: true,
          require_dirty_worktree_rejection: true,
          require_existing_branch_rejection: true,
          require_self_check_executes_tests: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_mcp_skill_bus_self_check",
        tier: "T7",
        package_script: "proof:dojo:mcp-skill-bus:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.mcpSkillBusEvidence.v1",
        default_evidence_path: "tmp/dojo-mcp-skill-bus/dojo-mcp-skill-bus.evidence.json",
        release_artifact_requirements: expect.objectContaining({
          require_all_mcp_skill_bus_capabilities_covered: true,
          required_mcp_skill_bus_capabilities: DOJO_MCP_SKILL_BUS_CAPABILITIES,
          required_test_files: DOJO_MCP_SKILL_BUS_TEST_FILES,
          require_certified_competency_listing: true,
          require_tenant_authorization: true,
          require_signed_manifest: true,
          require_manifest_signature_verification: true,
          require_manifest_tamper_rejection: true,
          require_manifest_production_readiness: true,
          require_version_pinning: true,
          require_ambiguous_tool_block: true,
          require_proof_validation: true,
          require_proof_consume: true,
          require_proof_binding: true,
          require_dry_run_side_effect_free: true,
          require_fail_closed: true,
          require_executor_block_propagation: true,
          require_rate_limit: true,
          require_audit_events: true,
          require_durable_registration: true,
          require_revocation: true,
          require_durable_invocation_custody: true,
          require_tenant_boundary: true,
          require_direct_call_policy: true,
          require_postgres_registry: true,
          require_self_check_executes_tests: true,
          require_no_failed_tests: true,
          require_no_skipped_tests: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
        requires_env: ["SYNTHI_DOJO_POSTGRES_TEST_URL"],
      }),
      expect.objectContaining({
        id: "dojo_managed_key_signing_self_check",
        tier: "T7",
        package_script: "proof:dojo:managed-key-signing:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.managedKeySigningEvidence.v1",
        default_evidence_path: "tmp/dojo-managed-key-signing/dojo-managed-key-signing.evidence.json",
        release_artifact_requirements: expect.objectContaining({
          require_all_managed_key_signing_capabilities_covered: true,
          required_managed_key_signing_capabilities: DOJO_MANAGED_KEY_SIGNING_CAPABILITIES,
          required_test_files: DOJO_MANAGED_KEY_SIGNING_TEST_FILES,
          require_no_failed_tests: true,
          require_no_skipped_tests: true,
          require_managed_key_service_provider: true,
          require_managed_key_custody: true,
          require_public_verifier_material: true,
          require_release_managed_key_observation: true,
          require_release_observation_artifact_digest_match: true,
          release_observation_max_age_ms: DOJO_RELEASE_OBSERVATION_MAX_AGE_MS,
          release_observation_future_tolerance_ms: DOJO_RELEASE_OBSERVATION_FUTURE_TOLERANCE_MS,
          release_observation_schema_version: DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_SCHEMA_VERSION,
          required_release_observation_checks: DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_CHECKS,
          release_observation_producer: {
            package_script: DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_PACKAGE_SCRIPT,
            command: DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_COMMAND,
            default_observation_path: DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_DEFAULT_PATH,
            required_env: DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_REQUIRED_ENV,
          },
          section_release_verifier: {
            flag: "--managed-key-signing-release-candidate",
            evidence_arg: "--managed-key-signing-evidence",
            default_evidence_path: "tmp/dojo-managed-key-signing/dojo-managed-key-signing.evidence.json",
            default_out_dir: "tmp/dojo-release-gate-verify-managed-key-release-section",
            command: "node mcp/synthi-mcp/scripts/dojo-release-gate-verify.mjs --managed-key-signing-release-candidate --managed-key-signing-evidence tmp/dojo-managed-key-signing/dojo-managed-key-signing.evidence.json --out-dir tmp/dojo-release-gate-verify-managed-key-release-section",
          },
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
        requires_env: [DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_ENV],
      }),
      expect.objectContaining({
        id: "dojo_public_proof_verification_self_check",
        tier: "T7",
        package_script: "proof:dojo:public-proof-verification:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.publicProofVerificationEvidence.v1",
        default_evidence_path: "tmp/dojo-public-proof-verification/dojo-public-proof-verification.evidence.json",
        release_artifact_requirements: expect.objectContaining({
          require_all_public_proof_verification_capabilities_covered: true,
          required_public_proof_verification_capabilities: DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES,
          required_test_files: DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES,
          require_external_verifier: true,
          require_ed25519_public_key: true,
          require_evidence_claim_ledger_binding: true,
          require_tamper_and_context_blocks: true,
          require_timestamp_window: true,
          require_proof_key_custody_policy: true,
          require_public_export: true,
          require_key_custody_metadata_export: true,
          require_private_secret_exclusion: true,
          require_tenant_scoped_key_export: true,
          require_unavailable_key_marking: true,
          require_no_failed_tests: true,
          require_no_skipped_tests: true,
          require_self_check_executes_tests: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_governance_lifecycle_self_check",
        tier: "T7",
        package_script: "proof:dojo:governance-lifecycle:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.governanceLifecycleEvidence.v1",
        default_evidence_path: "tmp/dojo-governance-lifecycle/dojo-governance-lifecycle.evidence.json",
        release_artifact_requirements: expect.objectContaining({
          require_all_governance_lifecycle_capabilities_covered: true,
          required_governance_lifecycle_capabilities: DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES,
          required_test_files: DOJO_GOVERNANCE_LIFECYCLE_TEST_FILES,
          require_license_health: true,
          require_approval_queue: true,
          require_approval_decision_audit: true,
          require_rbac: true,
          require_store_rbac: true,
          require_case_law_review: true,
          require_license_revocation: true,
          require_recertification_queue: true,
          require_policy_gates: true,
          require_audit_export: true,
          require_compliance_pack: true,
          require_scheduled_jobs: true,
          require_proof_public_verification_custody: true,
          require_malformed_expiry_fails_closed: true,
          require_self_check_executes_tests: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_graph_runtime_self_check",
        tier: "T7",
        package_script: "proof:dojo:graph-runtime:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.graphRuntimeEvidence.v1",
        default_evidence_path: "tmp/dojo-graph-runtime/dojo-graph-runtime.evidence.json",
        release_artifact_requirements: expect.objectContaining({
          require_all_graph_runtime_capabilities_covered: true,
          required_graph_runtime_capabilities: DOJO_GRAPH_RUNTIME_CAPABILITIES,
          required_test_files: DOJO_GRAPH_RUNTIME_TEST_FILES,
          require_graph_ir_validation: true,
          require_graph_compiler: true,
          require_workflow_step_nodes: true,
          require_source_api_binding: true,
          require_production_execution: true,
          require_preflight_only: true,
          require_edge_order: true,
          require_evidence_events: true,
          require_ledger_backed_evidence: true,
          require_preconditions: true,
          require_proof_gate: true,
          require_substrate_executor: true,
          require_expiry: true,
          require_branch_runtime: true,
          require_retry_runtime: true,
          require_case_law_runtime: true,
          require_rollback_runtime: true,
          require_human_resume: true,
          require_validation_fail_closed: true,
          require_predicate_dsl: true,
          require_self_check_executes_tests: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_ghost_mode_evidence_self_check",
        tier: "T7",
        package_script: "proof:dojo:ghost-mode-evidence:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.ghostModeEvidence.v1",
        default_evidence_path: "tmp/dojo-ghost-mode-evidence/dojo-ghost-mode-evidence.evidence.json",
        release_artifact_requirements: expect.objectContaining({
          require_all_ghost_mode_capabilities_covered: true,
          required_ghost_mode_capabilities: DOJO_GHOST_MODE_EVIDENCE_CAPABILITIES,
          required_test_files: DOJO_GHOST_MODE_EVIDENCE_TEST_FILES,
          require_non_mutating_shadow_run: true,
          require_shadow_evidence_record: true,
          require_audit_custody: true,
          require_mismatch_entrustment_block: true,
          require_compliance_pack_visibility: true,
          require_durable_shadow_evidence_store: true,
          require_tenant_boundary: true,
          require_production_mutation_rejection: true,
          require_operational_filtering: true,
          require_no_failed_tests: true,
          require_no_skipped_tests: true,
          require_self_check_executes_tests: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
        requires_env: ["SYNTHI_DOJO_POSTGRES_TEST_URL"],
      }),
      expect.objectContaining({
        id: "dojo_skill_passport_self_check",
        tier: "T7",
        package_script: "proof:dojo:skill-passport:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.skillPassportEvidence.v1",
        default_evidence_path: "tmp/dojo-skill-passport/dojo-skill-passport.evidence.json",
        release_artifact_requirements: expect.objectContaining({
          require_all_skill_passport_capabilities_covered: true,
          required_skill_passport_capabilities: DOJO_SKILL_PASSPORT_CAPABILITIES,
          required_test_files: DOJO_SKILL_PASSPORT_TEST_FILES,
          require_report_only_status: true,
          require_license_scope: true,
          require_readiness_scope: true,
          require_proof_scope: true,
          require_coverage_and_attack_metrics: true,
          require_executable_entrustment_provenance: true,
          require_published_tool_scope: true,
          require_skill_card_action_grouping: true,
          require_proof_badge: true,
          require_practice_guardrail_counts: true,
          require_passport_export: true,
          require_raw_payload_redaction: true,
          require_self_check_executes_tests: true,
          require_no_failed_tests: true,
          require_no_skipped_tests: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_time_machine_debugger_self_check",
        tier: "T7",
        package_script: "proof:dojo:time-machine-debugger:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.timeMachineDebuggerEvidence.v1",
        default_evidence_path: "tmp/dojo-time-machine-debugger/dojo-time-machine-debugger.evidence.json",
        release_artifact_requirements: expect.objectContaining({
          require_all_time_machine_capabilities_covered: true,
          required_time_machine_capabilities: DOJO_TIME_MACHINE_DEBUGGER_CAPABILITIES,
          required_test_files: DOJO_TIME_MACHINE_DEBUGGER_TEST_FILES,
          require_deterministic_debug_report: true,
          require_counterfactual_twin: true,
          require_promoted_scenario_selection: true,
          require_scenario_correlation: true,
          require_attack_guardrail_correlation: true,
          require_remediation_cost_policy: true,
          require_baseline_explanation: true,
          require_counterfactual_license_impact: true,
          require_replay_plan: true,
          require_honest_projection_status: true,
          require_no_failed_tests: true,
          require_no_skipped_tests: true,
          require_self_check_executes_tests: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_vivarium_runtime_self_check",
        tier: "T7",
        package_script: "proof:dojo:vivarium-runtime:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.vivariumRuntimeEvidence.v1",
        default_evidence_path: "tmp/dojo-vivarium-runtime/dojo-vivarium-runtime.evidence.json",
        release_artifact_requirements: expect.objectContaining({
          require_all_vivarium_runtime_capabilities_covered: true,
          required_vivarium_runtime_capabilities: DOJO_VIVARIUM_RUNTIME_CAPABILITIES,
          required_test_files: DOJO_VIVARIUM_RUNTIME_TEST_FILES,
          require_scenario_dsl: true,
          require_synthetic_fixture_materialization: true,
          require_synthetic_only_policy: true,
          require_oracle: true,
          require_ledger_ready_oracle_evidence: true,
          require_api_fault_server: true,
          require_fake_success_state_detection: true,
          require_partial_write_detection: true,
          require_api_downstream_failure_tissue: true,
          require_api_entity_conflict_faults: true,
          require_api_entity_conflict_runner_tissue: true,
          require_prompt_injection_quarantine: true,
          require_ambiguous_document_names: true,
          require_document_tissue_specific_evidence: true,
          require_ui_tissue_mutations: true,
          require_ui_tissue_specific_evidence: true,
          require_misleading_toast_tissue: true,
          require_route_tissue: true,
          require_policy_tissue: true,
          require_expanded_identity_tissue: true,
          require_invalid_value_data_tissue: true,
          require_stale_missing_data_tissue: true,
          require_api_validation_latency_tissue: true,
          require_deterministic_reset: true,
          require_budget_enforcement: true,
          require_targeted_graph_execution: true,
          require_executable_checkride: true,
          require_license_constraints_from_blocked_risk: true,
          require_critical_guardrail_failure: true,
          require_substrate_hook_passthrough: true,
          require_evil_twin_attack_measurement: true,
          require_evil_twin_expanded_assumption_extraction: true,
          require_evil_twin_hardening_loop: true,
          require_evil_twin_expanded_hardening_guardrails: true,
          require_self_check_executes_tests: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_checkride_license_self_check",
        tier: "T7",
        package_script: "proof:dojo:checkride-license:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.checkrideLicenseEvidence.v1",
        default_evidence_path: "tmp/dojo-checkride-license/dojo-checkride-license.evidence.json",
        release_artifact_requirements: expect.objectContaining({
          require_all_checkride_license_capabilities_covered: true,
          required_checkride_license_capabilities: DOJO_CHECKRIDE_LICENSE_CAPABILITIES,
          required_test_files: DOJO_CHECKRIDE_LICENSE_TEST_FILES,
          require_executable_checkride: true,
          require_graph_runtime: true,
          require_vivarium_oracle: true,
          require_observed_evidence: true,
          require_evidence_record: true,
          require_ledger_append: true,
          require_license_constraints: true,
          require_critical_failure_block: true,
          require_substrate_assertion: true,
          require_entrustment_policy: true,
          require_guardrail_evidence_e3: true,
          require_stale_evidence_downgrade: true,
          require_shadow_mismatch_limit: true,
          require_srl_policy: true,
          require_limited_license_srl7: true,
          require_operational_feedback_srl9: true,
          require_self_check_executes_tests: true,
          require_no_failed_tests: true,
          require_no_skipped_tests: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_case_law_runtime_self_check",
        tier: "T7",
        package_script: "proof:dojo:case-law-runtime:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.caseLawRuntimeEvidence.v1",
        default_evidence_path: "tmp/dojo-case-law-runtime/dojo-case-law-runtime.evidence.json",
        release_artifact_requirements: expect.objectContaining({
          require_all_case_law_runtime_capabilities_covered: true,
          required_case_law_runtime_capabilities: DOJO_CASE_LAW_RUNTIME_CAPABILITIES,
          required_test_files: DOJO_CASE_LAW_RUNTIME_TEST_FILES,
          require_case_law_registry: true,
          require_reviewed_evidence: true,
          require_proposed_cases_nonbinding: true,
          require_approved_binding_scope: true,
          require_deprecated_cases_excluded: true,
          require_guardrail_synthesis: true,
          require_explicit_predicate_preservation: true,
          require_graph_binding: true,
          require_runtime_guardrail_block: true,
          require_refusal_case_citation: true,
          require_inactive_case_suppression: true,
          require_antibody_matching: true,
          require_antibody_proposed_only: true,
          require_antibody_private_data_redaction: true,
          require_local_practice: true,
          require_local_checkride: true,
          require_deterministic_antibody_ids: true,
          require_self_check_executes_tests: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "dojo_hosted_runtime_gateway_self_check",
        tier: "T7",
        package_script: "proof:dojo:hosted-runtime-gateway:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.hostedRuntimeGatewayEvidence.v1",
        default_evidence_path: "tmp/dojo-hosted-runtime-gateway/dojo-hosted-runtime-gateway.evidence.json",
        requires_env: [DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_ENV],
        release_artifact_requirements: expect.objectContaining({
          require_all_hosted_runtime_gateway_capabilities_covered: true,
          required_hosted_runtime_gateway_capabilities: DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES,
          required_test_files: DOJO_HOSTED_RUNTIME_GATEWAY_TEST_FILES,
          require_tenant_scoped_sessions: true,
          require_short_lived_credentials: true,
          require_stored_secret_redaction: true,
          require_origin_allowlist: true,
          require_local_network_policy: true,
          require_screenshot_redaction: true,
          require_skill_run_binding: true,
          require_audit_events: true,
          require_evidence_write: true,
          require_fail_closed_on_missing_evidence_writer: true,
          require_revocation_and_expiry: true,
          require_durable_store_production_requirement: true,
          require_postgres_session_store: true,
          require_durable_postgres_session_gate: true,
          durable_postgres_session_gate_id: "dojo_postgres_control_plane_self_check",
          require_malformed_record_rejection: true,
          require_release_runtime_observation: true,
          require_release_observation_artifact_digest_match: true,
          release_observation_max_age_ms: DOJO_RELEASE_OBSERVATION_MAX_AGE_MS,
          release_observation_future_tolerance_ms: DOJO_RELEASE_OBSERVATION_FUTURE_TOLERANCE_MS,
          required_release_observation_gate_ids: DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_GATE_IDS,
          release_observation_producer: {
            package_script: DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_PACKAGE_SCRIPT,
            command: DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_COMMAND,
            default_observation_path: DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_DEFAULT_PATH,
            required_inputs: DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_INPUTS,
          },
          section_release_verifier: {
            flag: "--hosted-runtime-gateway-release-candidate",
            evidence_arg: "--hosted-runtime-gateway-evidence",
            default_evidence_path: "tmp/dojo-hosted-runtime-gateway/dojo-hosted-runtime-gateway.evidence.json",
            default_out_dir: "tmp/dojo-release-gate-verify-hosted-runtime-release-section",
            command: "node mcp/synthi-mcp/scripts/dojo-release-gate-verify.mjs --hosted-runtime-gateway-release-candidate --hosted-runtime-gateway-evidence tmp/dojo-hosted-runtime-gateway/dojo-hosted-runtime-gateway.evidence.json --out-dir tmp/dojo-release-gate-verify-hosted-runtime-release-section",
          },
          require_self_check_executes_tests: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
        }),
      }),
      expect.objectContaining({
        id: "security_abuse_suite",
        tier: "T7",
        package_script: "proof:dojo:security-abuse:self-check",
        script_exists: true,
        release_artifact_requirements: expect.objectContaining({
          require_all_abuse_classes_covered: true,
          required_abuse_classes: DOJO_SECURITY_ABUSE_CLASSES,
          required_test_files: DOJO_SECURITY_ABUSE_TEST_FILES,
          require_no_failed_tests: true,
          require_no_skipped_tests: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
          section_release_verifier: {
            flag: "--security-abuse-release-candidate",
            evidence_arg: "--security-abuse-evidence",
            default_evidence_path: "tmp/dojo-security-abuse/dojo-security-abuse.evidence.json",
            default_out_dir: "tmp/dojo-release-gate-verify-security-abuse-release-section",
            command: "node mcp/synthi-mcp/scripts/dojo-release-gate-verify.mjs --security-abuse-release-candidate --security-abuse-evidence tmp/dojo-security-abuse/dojo-security-abuse.evidence.json --out-dir tmp/dojo-release-gate-verify-security-abuse-release-section",
          },
        }),
      }),
      expect.objectContaining({
        id: "compliance_export_suite",
        tier: "T7",
        package_script: "proof:dojo:compliance-export:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.complianceExportEvidence.v1",
        default_evidence_path: "tmp/dojo-compliance-export/dojo-compliance-export.evidence.json",
        release_artifact_requirements: expect.objectContaining({
          require_all_compliance_capabilities_covered: true,
          required_compliance_capabilities: DOJO_COMPLIANCE_EXPORT_CAPABILITIES,
          required_test_files: DOJO_COMPLIANCE_EXPORT_TEST_FILES,
          require_no_failed_tests: true,
          require_no_skipped_tests: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
          section_release_verifier: {
            flag: "--compliance-export-release-candidate",
            evidence_arg: "--compliance-export-evidence",
            default_evidence_path: "tmp/dojo-compliance-export/dojo-compliance-export.evidence.json",
            default_out_dir: "tmp/dojo-release-gate-verify-compliance-export-release-section",
            command: "node mcp/synthi-mcp/scripts/dojo-release-gate-verify.mjs --compliance-export-release-candidate --compliance-export-evidence tmp/dojo-compliance-export/dojo-compliance-export.evidence.json --out-dir tmp/dojo-release-gate-verify-compliance-export-release-section",
          },
        }),
      }),
      expect.objectContaining({
        id: "privacy_redaction_suite",
        tier: "T7",
        package_script: "proof:dojo:privacy-redaction:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.privacyRedactionEvidence.v1",
        default_evidence_path: "tmp/dojo-privacy-redaction/dojo-privacy-redaction.evidence.json",
        release_artifact_requirements: expect.objectContaining({
          require_all_privacy_capabilities_covered: true,
          required_privacy_capabilities: DOJO_PRIVACY_REDACTION_CAPABILITIES,
          required_test_files: DOJO_PRIVACY_REDACTION_TEST_FILES,
          require_no_failed_tests: true,
          require_no_skipped_tests: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
          section_release_verifier: {
            flag: "--privacy-redaction-release-candidate",
            evidence_arg: "--privacy-redaction-evidence",
            default_evidence_path: "tmp/dojo-privacy-redaction/dojo-privacy-redaction.evidence.json",
            default_out_dir: "tmp/dojo-release-gate-verify-privacy-redaction-release-section",
            command: "node mcp/synthi-mcp/scripts/dojo-release-gate-verify.mjs --privacy-redaction-release-candidate --privacy-redaction-evidence tmp/dojo-privacy-redaction/dojo-privacy-redaction.evidence.json --out-dir tmp/dojo-release-gate-verify-privacy-redaction-release-section",
          },
        }),
      }),
      expect.objectContaining({
        id: "dojo_chaos_performance_self_check",
        tier: "T8",
        package_script: "proof:dojo:chaos-performance:self-check",
        script_exists: true,
        enterprise_artifact_requirements: expect.objectContaining({
          require_all_scenarios_covered: true,
          required_chaos_scenarios: DOJO_CHAOS_SCENARIOS,
          required_test_files: DOJO_CHAOS_PERFORMANCE_TEST_FILES,
          require_no_failed_tests: true,
          require_no_skipped_tests: true,
          require_budget_ok: true,
          require_performance_metrics: true,
          require_dojo_release_metrics: true,
          required_dojo_release_metrics: DOJO_CHAOS_PERFORMANCE_REQUIRED_METRICS,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
          section_enterprise_verifier: {
            flag: "--chaos-performance-enterprise-release",
            evidence_arg: "--chaos-performance-evidence",
            default_evidence_path: "tmp/dojo-chaos-performance/dojo-chaos-performance.evidence.json",
            default_out_dir: "tmp/dojo-release-gate-verify-chaos-performance-enterprise-section",
            command: "node mcp/synthi-mcp/scripts/dojo-release-gate-verify.mjs --chaos-performance-enterprise-release --chaos-performance-evidence tmp/dojo-chaos-performance/dojo-chaos-performance.evidence.json --out-dir tmp/dojo-release-gate-verify-chaos-performance-enterprise-section",
          },
        }),
      }),
      expect.objectContaining({
        id: "dojo_live_chaos",
        tier: "T8",
        package_script: "chaos:dojo:live",
        script_exists: true,
        required_for: ["enterprise_release"],
        requires_env: DOJO_LIVE_CHAOS_REQUIRED_ENV,
        default_report_path: "tmp/dojo-chaos-runner/live-chaos-runner.report.json",
        enterprise_artifact_requirements: expect.objectContaining({
          require_explicit_live_enable_env: DOJO_LIVE_CHAOS_ENABLE_ENV,
          required_live_scenarios: DOJO_LIVE_CHAOS_SCENARIOS,
          require_live_scenarios_included: true,
          require_all_live_scenarios_passed: true,
          require_command_digest_evidence: true,
          section_enterprise_verifier: {
            flag: "--live-chaos-enterprise-release",
            report_arg: "--live-chaos-report",
            default_report_path: "tmp/dojo-chaos-runner/live-chaos-runner.report.json",
            default_out_dir: "tmp/dojo-release-gate-verify-live-chaos-enterprise-section",
            command: "node mcp/synthi-mcp/scripts/dojo-release-gate-verify.mjs --live-chaos-enterprise-release --live-chaos-report tmp/dojo-chaos-runner/live-chaos-runner.report.json --out-dir tmp/dojo-release-gate-verify-live-chaos-enterprise-section",
          },
        }),
      }),
      expect.objectContaining({
        id: "dojo_soak_performance_self_check",
        tier: "T8",
        package_script: "proof:dojo:soak-performance:self-check",
        script_exists: true,
        evidence_schema_version: "synthi.dojo.soakPerformanceEvidence.v1",
        default_evidence_path: "tmp/dojo-soak-performance/dojo-soak-performance.evidence.json",
        enterprise_artifact_requirements: expect.objectContaining({
          require_all_operation_classes_covered: true,
          required_operation_classes: DOJO_SOAK_PERFORMANCE_OPERATION_CLASSES,
          required_test_files: DOJO_SOAK_PERFORMANCE_TEST_FILES,
          require_no_failed_tests: true,
          require_no_failed_operation_events: true,
          require_dojo_soak_metrics: true,
          required_dojo_soak_metrics: DOJO_SOAK_PERFORMANCE_REQUIRED_METRICS,
          require_zero_proof_replay_false_allow_count: true,
          require_zero_false_block_rate: true,
          require_zero_browser_session_leak_count: true,
          require_event_digest_match: true,
          require_stdout_stderr_digest_match: true,
          require_json_report_digest_match: true,
          section_enterprise_verifier: {
            flag: "--dojo-soak-performance-enterprise-release",
            evidence_arg: "--dojo-soak-performance-evidence",
            default_evidence_path: "tmp/dojo-soak-performance/dojo-soak-performance.evidence.json",
            default_out_dir: "tmp/dojo-release-gate-verify-dojo-soak-performance-enterprise-section",
            command: "node mcp/synthi-mcp/scripts/dojo-release-gate-verify.mjs --dojo-soak-performance-enterprise-release --dojo-soak-performance-evidence tmp/dojo-soak-performance/dojo-soak-performance.evidence.json --out-dir tmp/dojo-release-gate-verify-dojo-soak-performance-enterprise-section",
          },
        }),
      }),
      expect.objectContaining({
        id: "soak_performance",
        tier: "T8",
        package_script: "soak",
        script_exists: true,
        requires_env: ["SYNTHI_SESSION_ID", "SOAK_DURATION_MIN"],
        env_value_requirements: [
          expect.objectContaining({
            env: "SOAK_DURATION_MIN",
            type: "number",
            min: 60,
          }),
        ],
        default_summary_path: "mcp/synthi-mcp/.soak/soak-summary.json",
        default_events_path: "mcp/synthi-mcp/.soak/soak-events.ndjson",
        enterprise_artifact_requirements: expect.objectContaining({
          require_min_duration_seconds: 3600,
          require_live_session_env: "SYNTHI_SESSION_ID",
          require_duration_env: "SOAK_DURATION_MIN",
          require_duration_env_min_minutes: 60,
          require_zero_errors: true,
          require_iteration_events: true,
          require_tool_latency_metrics: true,
          require_memory_growth_metrics: true,
          require_post_detach_leak_counters: true,
          section_enterprise_verifier: {
            flag: "--soak-performance-enterprise-release",
            summary_arg: "--soak-summary",
            events_arg: "--soak-events",
            default_summary_path: "mcp/synthi-mcp/.soak/soak-summary.json",
            default_events_path: "mcp/synthi-mcp/.soak/soak-events.ndjson",
            default_out_dir: "tmp/dojo-release-gate-verify-soak-performance-enterprise-section",
            command: "node mcp/synthi-mcp/scripts/dojo-release-gate-verify.mjs --soak-performance-enterprise-release --soak-summary mcp/synthi-mcp/.soak/soak-summary.json --soak-events mcp/synthi-mcp/.soak/soak-events.ndjson --out-dir tmp/dojo-release-gate-verify-soak-performance-enterprise-section",
          },
        }),
      }),
    ]));
  });

  it("does not share nested gate artifact requirement objects between manifests", () => {
    const first = buildDojoReleaseGateManifest({
      generatedAt: "2026-06-11T00:00:00.000Z",
      packageScripts: PACKAGE_SCRIPTS,
    });
    const firstManagedKeyGate = first.gates.find((gate) => gate.id === "dojo_managed_key_signing_self_check");
    firstManagedKeyGate.release_artifact_requirements.section_release_verifier.default_evidence_path =
      "tmp/test-specific-managed-key.evidence.json";

    const second = buildDojoReleaseGateManifest({
      generatedAt: "2026-06-11T00:00:00.000Z",
      packageScripts: PACKAGE_SCRIPTS,
    });
    const secondManagedKeyGate = second.gates.find((gate) => gate.id === "dojo_managed_key_signing_self_check");

    expect(secondManagedKeyGate.release_artifact_requirements.section_release_verifier.default_evidence_path)
      .toBe("tmp/dojo-managed-key-signing/dojo-managed-key-signing.evidence.json");
  });

  it("validates referenced package scripts and required release tiers", () => {
    const manifest = buildDojoReleaseGateManifest({
      generatedAt: "2026-06-11T00:00:00.000Z",
      packageScripts: PACKAGE_SCRIPTS,
    });

    expect(validateDojoReleaseGateManifest(manifest, { packageScripts: PACKAGE_SCRIPTS })).toEqual(expect.objectContaining({
      ok: true,
      errors: [],
      tier_count: 9,
    }));

    const brokenEnterpriseRelease = JSON.parse(JSON.stringify(manifest));
    brokenEnterpriseRelease.enterprise_release_gate_ids = brokenEnterpriseRelease.enterprise_release_gate_ids
      .filter((id) => !["workflow_e2e_hosted", "dojo_chaos_performance_self_check", "dojo_live_chaos", "dojo_soak_performance_self_check", "soak_performance"].includes(id));
    expect(validateDojoReleaseGateManifest(brokenEnterpriseRelease, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "enterprise_release_missing_release_gate_ids:workflow_e2e_hosted",
      "enterprise_release_missing_required_gate_ids:dojo_chaos_performance_self_check,dojo_live_chaos,dojo_soak_performance_self_check,soak_performance",
      "enterprise_release_missing_T8",
    ]));

    const broken = buildDojoReleaseGateManifest({
      packageScripts: {
        ...PACKAGE_SCRIPTS,
        "mcp/synthi-mcp/package.json": {},
      },
    });
    expect(validateDojoReleaseGateManifest(broken, {
      packageScripts: {
        ...PACKAGE_SCRIPTS,
        "mcp/synthi-mcp/package.json": {},
      },
    }).errors).toEqual(expect.arrayContaining([
      "missing_package_script:mcp/synthi-mcp/package.json:typecheck",
      "missing_package_script:mcp/synthi-mcp/package.json:proof:dojo:self-check",
    ]));

    const brokenLiveScripts = {
      ...PACKAGE_SCRIPTS,
      "mcp/synthi-mcp/package.json": {
        ...PACKAGE_SCRIPTS["mcp/synthi-mcp/package.json"],
        "live:dojo:mcp-host-conformance": "node scripts/dojo-mcp-host-conformance.mjs --require-non-loopback-mcp-host",
        "live:browser:private-tool-host-conformance": "node scripts/private-tool-stdio-acceptance.mjs --require-custom-mcp-command",
        "live:browser:private-tool-codex-host-conformance": "node scripts/private-tool-codex-acceptance.mjs --require-non-loopback-runtime",
      },
    };
    const brokenLiveManifest = buildDojoReleaseGateManifest({ packageScripts: brokenLiveScripts });
    expect(validateDojoReleaseGateManifest(brokenLiveManifest, { packageScripts: brokenLiveScripts }).errors).toEqual(expect.arrayContaining([
      "mcp_host_conformance_package_script_missing_flags:--out-dir,tmp/dojo-mcp-host-conformance-live,--execute-production,--require-external-control-plane-store,--require-external-proof-signing,--require-bridge-token,--require-no-local-cdp,--require-licensed-skill-filtering",
      "private_tool_host_conformance_package_script_missing_flags:private_tool_stdio_host_conformance:--require-non-loopback-runtime,--require-external-private-tool-store",
      "private_tool_host_conformance_package_script_missing_flags:private_tool_codex_host_conformance:--require-external-private-tool-store",
    ]));

    const brokenFullVisual = JSON.parse(JSON.stringify(manifest));
    const fullVisualGate = brokenFullVisual.gates.find((gate) => gate.id === "dojo_full_visual_proof");
    fullVisualGate.visual_report_requirements.required_route_ids = fullVisualGate.visual_report_requirements.required_route_ids
      .filter((routeId) => routeId !== "evidence");
    fullVisualGate.visual_report_requirements.required_viewports = ["desktop"];
    fullVisualGate.visual_report_requirements.requires_all_required_route_viewports = false;
    fullVisualGate.visual_report_requirements.requires_unique_screenshot_paths = false;
    fullVisualGate.visual_report_requirements.requires_top_level_screenshots_match_results = false;
    fullVisualGate.visual_report_requirements.requires_screenshot_count_matches_results = false;
    fullVisualGate.visual_report_requirements.requires_route_count_matches_required_routes = false;
    fullVisualGate.visual_report_requirements.min_result_count = 1;
    expect(validateDojoReleaseGateManifest(brokenFullVisual, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "full_visual_gate_missing_required_route:evidence",
      "full_visual_gate_missing_required_viewport:mobile",
      "full_visual_gate_missing_route_viewport_matrix_requirement",
      "full_visual_gate_missing_unique_screenshot_requirement",
      "full_visual_gate_missing_top_level_screenshot_count_requirement",
      "full_visual_gate_missing_screenshot_count_requirement",
      "full_visual_gate_missing_route_count_requirement",
      "full_visual_gate_min_result_count_too_low:1",
    ]));

    const brokenGhostVisual = JSON.parse(JSON.stringify(manifest));
    const ghostVisualGate = brokenGhostVisual.gates.find((gate) => gate.id === "dojo_ghost_mode_visual_proof");
    ghostVisualGate.visual_report_requirements.required_route_ids = [];
    ghostVisualGate.visual_report_requirements.required_viewports = ["desktop"];
    ghostVisualGate.visual_report_requirements.requires_all_required_route_viewports = false;
    ghostVisualGate.visual_report_requirements.requires_unique_screenshot_paths = false;
    ghostVisualGate.visual_report_requirements.requires_top_level_screenshots_match_results = false;
    ghostVisualGate.visual_report_requirements.requires_screenshot_count_matches_results = false;
    ghostVisualGate.visual_report_requirements.requires_route_count_matches_required_routes = false;
    ghostVisualGate.visual_report_requirements.min_result_count = 1;
    expect(validateDojoReleaseGateManifest(brokenGhostVisual, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "ghost_mode_visual_gate_missing_required_route:time-machine",
      "ghost_mode_visual_gate_missing_required_viewport:mobile",
      "ghost_mode_visual_gate_missing_route_viewport_matrix_requirement",
      "ghost_mode_visual_gate_missing_unique_screenshot_requirement",
      "ghost_mode_visual_gate_missing_top_level_screenshot_count_requirement",
      "ghost_mode_visual_gate_missing_screenshot_count_requirement",
      "ghost_mode_visual_gate_missing_route_count_requirement",
      "ghost_mode_visual_gate_min_result_count_too_low:1",
    ]));

    const brokenPostgres = JSON.parse(JSON.stringify(manifest));
    const postgresGate = brokenPostgres.gates.find((gate) => gate.id === "dojo_postgres_control_plane_self_check");
    const missingPostgresTestFile = DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES[0];
    postgresGate.artifact_requirements.required_control_plane_capabilities = DOJO_POSTGRES_CONTROL_PLANE_CAPABILITIES
      .filter((capability) => capability !== "atomic_proof_consume");
    postgresGate.artifact_requirements.required_test_files = DOJO_POSTGRES_CONTROL_PLANE_TEST_FILES
      .filter((file) => file !== missingPostgresTestFile);
    postgresGate.release_artifact_requirements.require_external_postgres_control_plane = false;
    postgresGate.release_artifact_requirements.accepted_postgres_host_classes = ["loopback"];
    expect(validateDojoReleaseGateManifest(brokenPostgres, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "postgres_control_plane_missing_required_capabilities:atomic_proof_consume",
      `postgres_control_plane_missing_required_test_files:${missingPostgresTestFile}`,
      "postgres_control_plane_missing_external_release_requirement",
      "postgres_control_plane_missing_remote_release_host_class",
    ]));

    const brokenImplementationStatus = JSON.parse(JSON.stringify(manifest));
    const implementationStatusGate = brokenImplementationStatus.gates.find((gate) => gate.id === "dojo_implementation_status_self_check");
    const missingImplementationStatusTestFile = DOJO_IMPLEMENTATION_STATUS_TEST_FILES[0];
    implementationStatusGate.artifact_requirements.required_implementation_status_capabilities = DOJO_IMPLEMENTATION_STATUS_CAPABILITIES
      .filter((capability) => capability !== "no_mature_production_runtime_claims");
    implementationStatusGate.artifact_requirements.required_test_files = DOJO_IMPLEMENTATION_STATUS_TEST_FILES
      .filter((file) => file !== missingImplementationStatusTestFile);
    implementationStatusGate.artifact_requirements.require_production_runtime_claim_boundary = false;
    implementationStatusGate.artifact_requirements.require_runtime_scope_for_executable = false;
    implementationStatusGate.artifact_requirements.require_human_status_doc_sync = false;
    implementationStatusGate.artifact_requirements.require_self_check_executes_tests = false;
    expect(validateDojoReleaseGateManifest(brokenImplementationStatus, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "implementation_status_missing_production_boundary_requirement",
      "implementation_status_missing_runtime_scope_requirement",
      "implementation_status_missing_human_doc_sync_requirement",
      "implementation_status_missing_self_check_execution_requirement",
      "implementation_status_missing_required_capabilities:no_mature_production_runtime_claims",
      `implementation_status_missing_required_test_files:${missingImplementationStatusTestFile}`,
    ]));

    const brokenReleaseGateRunner = JSON.parse(JSON.stringify(manifest));
    const releaseGateRunnerGate = brokenReleaseGateRunner.gates.find((gate) => gate.id === "dojo_release_gate_runner_self_check");
    releaseGateRunnerGate.report_schema_version = "wrong";
    releaseGateRunnerGate.evidence_schema_version = "wrong";
    releaseGateRunnerGate.default_report_path = "";
    releaseGateRunnerGate.default_evidence_path = "";
    releaseGateRunnerGate.artifact_requirements.require_scope_plans = ["minimal-pr"];
    releaseGateRunnerGate.artifact_requirements.require_manifest_validation = false;
    releaseGateRunnerGate.artifact_requirements.require_no_live_or_nightly_in_minimal_plan = false;
    releaseGateRunnerGate.artifact_requirements.require_enterprise_release_scope_includes_release_and_t8 = false;
    releaseGateRunnerGate.artifact_requirements.require_skips_missing_env_gates = false;
    releaseGateRunnerGate.artifact_requirements.require_fake_execution_promotion_ready = false;
    releaseGateRunnerGate.artifact_requirements.require_report_evidence_pair = false;
    releaseGateRunnerGate.artifact_requirements.require_stdout_stderr_digest_match = false;
    releaseGateRunnerGate.artifact_requirements.require_json_report_digest_match = false;
    expect(validateDojoReleaseGateManifest(brokenReleaseGateRunner, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "release_gate_runner_missing_report_schema",
      "release_gate_runner_missing_evidence_schema",
      "release_gate_runner_missing_default_report_path",
      "release_gate_runner_missing_default_evidence_path",
      "release_gate_runner_missing_manifest_validation_requirement",
      "release_gate_runner_missing_minimal_scope_boundary_requirement",
      "release_gate_runner_missing_enterprise_scope_requirement",
      "release_gate_runner_missing_missing_env_skip_requirement",
      "release_gate_runner_missing_fake_execution_requirement",
      "release_gate_runner_missing_report_evidence_pair_requirement",
      "release_gate_runner_missing_log_digest_requirement",
      "release_gate_runner_missing_json_report_digest_requirement",
      "release_gate_runner_missing_scope_plans:milestone,enterprise-release",
    ]));

    const brokenReleaseGateVerifier = JSON.parse(JSON.stringify(manifest));
    const releaseGateVerifierGate = brokenReleaseGateVerifier.gates.find((gate) => gate.id === "dojo_release_gate_verifier_self_check");
    releaseGateVerifierGate.report_schema_version = "wrong";
    releaseGateVerifierGate.evidence_schema_version = "wrong";
    releaseGateVerifierGate.default_report_path = "";
    releaseGateVerifierGate.default_evidence_path = "";
    releaseGateVerifierGate.artifact_requirements.require_manifest_verification = false;
    releaseGateVerifierGate.artifact_requirements.require_release_gate_runner_self_check_verification = false;
    releaseGateVerifierGate.artifact_requirements.require_negative_controls = false;
    releaseGateVerifierGate.artifact_requirements.require_report_evidence_pair = false;
    releaseGateVerifierGate.artifact_requirements.require_json_report_digest_match = false;
    expect(validateDojoReleaseGateManifest(brokenReleaseGateVerifier, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "release_gate_verifier_missing_report_schema",
      "release_gate_verifier_missing_evidence_schema",
      "release_gate_verifier_missing_default_report_path",
      "release_gate_verifier_missing_default_evidence_path",
      "release_gate_verifier_missing_manifest_verification_requirement",
      "release_gate_verifier_missing_runner_self_check_requirement",
      "release_gate_verifier_missing_negative_controls_requirement",
      "release_gate_verifier_missing_report_evidence_pair_requirement",
      "release_gate_verifier_missing_json_report_digest_requirement",
    ]));

    const brokenEvidenceAuthority = JSON.parse(JSON.stringify(manifest));
    const evidenceAuthorityGate = brokenEvidenceAuthority.gates.find((gate) => gate.id === "dojo_evidence_authority_self_check");
    const missingEvidenceAuthorityTestFile = DOJO_EVIDENCE_AUTHORITY_TEST_FILES[0];
    evidenceAuthorityGate.artifact_requirements.required_evidence_authority_capabilities = DOJO_EVIDENCE_AUTHORITY_CAPABILITIES
      .filter((capability) => capability !== "proof_issuance_requires_verified_evidence_records");
    evidenceAuthorityGate.artifact_requirements.required_test_files = DOJO_EVIDENCE_AUTHORITY_TEST_FILES
      .filter((file) => file !== missingEvidenceAuthorityTestFile);
    evidenceAuthorityGate.artifact_requirements.require_proof_issue_claim_verification = false;
    evidenceAuthorityGate.artifact_requirements.require_production_proof_issue_rejects_unverified_claims = false;
    evidenceAuthorityGate.artifact_requirements.require_self_attested_claim_rejection = false;
    evidenceAuthorityGate.artifact_requirements.require_evidence_retention_policy = false;
    evidenceAuthorityGate.artifact_requirements.require_legal_hold_blocks_disposal = false;
    evidenceAuthorityGate.artifact_requirements.require_external_storage_custody_receipts = false;
    evidenceAuthorityGate.artifact_requirements.durable_postgres_ledger_gate_id = "wrong_gate";
    evidenceAuthorityGate.artifact_requirements.require_self_check_executes_tests = false;
    expect(validateDojoReleaseGateManifest(brokenEvidenceAuthority, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "evidence_authority_missing_retention_policy_requirement",
      "evidence_authority_missing_legal_hold_requirement",
      "evidence_authority_missing_external_storage_custody_requirement",
      "evidence_authority_missing_proof_issue_requirement",
      "evidence_authority_missing_production_proof_issue_requirement",
      "evidence_authority_missing_self_attested_rejection_requirement",
      "evidence_authority_missing_durable_postgres_gate_id",
      "evidence_authority_missing_self_check_execution_requirement",
      "evidence_authority_missing_required_capabilities:proof_issuance_requires_verified_evidence_records",
      `evidence_authority_missing_required_test_files:${missingEvidenceAuthorityTestFile}`,
    ]));

    const brokenSourceDrift = JSON.parse(JSON.stringify(manifest));
    const sourceDriftGate = brokenSourceDrift.gates.find((gate) => gate.id === "dojo_source_drift_self_check");
    const missingSourceDriftTestFile = DOJO_SOURCE_DRIFT_TEST_FILES[0];
    sourceDriftGate.artifact_requirements.required_source_drift_capabilities = DOJO_SOURCE_DRIFT_CAPABILITIES
      .filter((capability) => capability !== "source_drift_rejects_unverified_snapshots");
    sourceDriftGate.artifact_requirements.required_test_files = DOJO_SOURCE_DRIFT_TEST_FILES
      .filter((file) => file !== missingSourceDriftTestFile);
    sourceDriftGate.artifact_requirements.require_changed_token_expiry = false;
    sourceDriftGate.artifact_requirements.require_tamper_rejection = false;
    sourceDriftGate.artifact_requirements.require_license_store_expiry_application = false;
    sourceDriftGate.artifact_requirements.require_recertification_handoff = false;
    sourceDriftGate.artifact_requirements.require_self_check_executes_tests = false;
    expect(validateDojoReleaseGateManifest(brokenSourceDrift, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "source_drift_missing_changed_token_expiry_requirement",
      "source_drift_missing_tamper_rejection_requirement",
      "source_drift_missing_license_store_expiry_requirement",
      "source_drift_missing_recertification_handoff_requirement",
      "source_drift_missing_self_check_execution_requirement",
      "source_drift_missing_required_capabilities:source_drift_rejects_unverified_snapshots",
      `source_drift_missing_required_test_files:${missingSourceDriftTestFile}`,
    ]));

    const brokenAgentReadyUiContract = JSON.parse(JSON.stringify(manifest));
    const agentReadyUiContractGate = brokenAgentReadyUiContract.gates.find((gate) => gate.id === "dojo_agent_ready_ui_contract_self_check");
    const missingAgentReadyUiContractTestFile = DOJO_AGENT_READY_UI_CONTRACT_TEST_FILES[0];
    agentReadyUiContractGate.artifact_requirements.required_agent_ready_ui_contract_capabilities = DOJO_AGENT_READY_UI_CONTRACT_CAPABILITIES
      .filter((capability) => capability !== "agent_ready_ui_contract_requires_proof_hook");
    agentReadyUiContractGate.artifact_requirements.required_test_files = DOJO_AGENT_READY_UI_CONTRACT_TEST_FILES
      .filter((file) => file !== missingAgentReadyUiContractTestFile);
    agentReadyUiContractGate.artifact_requirements.require_proof_hook = false;
    agentReadyUiContractGate.artifact_requirements.require_stable_locator = false;
    agentReadyUiContractGate.artifact_requirements.require_self_check_executes_tests = false;
    expect(validateDojoReleaseGateManifest(brokenAgentReadyUiContract, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "agent_ready_ui_contract_missing_proof_hook_requirement",
      "agent_ready_ui_contract_missing_stable_locator_requirement",
      "agent_ready_ui_contract_missing_self_check_execution_requirement",
      "agent_ready_ui_contract_missing_required_capabilities:agent_ready_ui_contract_requires_proof_hook",
      `agent_ready_ui_contract_missing_required_test_files:${missingAgentReadyUiContractTestFile}`,
    ]));

    const brokenApiToolCompiler = JSON.parse(JSON.stringify(manifest));
    const apiToolCompilerGate = brokenApiToolCompiler.gates.find((gate) => gate.id === "dojo_api_tool_compiler_self_check");
    const missingApiToolCompilerTestFile = DOJO_API_TOOL_COMPILER_TEST_FILES[0];
    apiToolCompilerGate.artifact_requirements.required_api_tool_compiler_capabilities = DOJO_API_TOOL_COMPILER_CAPABILITIES
      .filter((capability) => capability !== "api_tool_executes_with_idempotency_postcondition_and_evidence");
    apiToolCompilerGate.artifact_requirements.required_test_files = DOJO_API_TOOL_COMPILER_TEST_FILES
      .filter((file) => file !== missingApiToolCompilerTestFile);
    apiToolCompilerGate.artifact_requirements.require_proof_capsule = false;
    apiToolCompilerGate.artifact_requirements.require_evidence_write = false;
    apiToolCompilerGate.artifact_requirements.require_self_check_executes_tests = false;
    expect(validateDojoReleaseGateManifest(brokenApiToolCompiler, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "api_tool_compiler_missing_proof_requirement",
      "api_tool_compiler_missing_evidence_requirement",
      "api_tool_compiler_missing_self_check_execution_requirement",
      "api_tool_compiler_missing_required_capabilities:api_tool_executes_with_idempotency_postcondition_and_evidence",
      `api_tool_compiler_missing_required_test_files:${missingApiToolCompilerTestFile}`,
    ]));

    const brokenDocker = JSON.parse(JSON.stringify(manifest));
    const dockerGate = brokenDocker.gates.find((gate) => gate.id === "docker_integration");
    dockerGate.artifact_requirements.required_services = DOJO_DOCKER_REQUIRED_SERVICES
      .filter((service) => service !== "mcp");
    dockerGate.artifact_requirements.required_healthy_services = DOJO_DOCKER_HEALTHY_SERVICES
      .filter((service) => service !== "postgres");
    dockerGate.artifact_requirements.required_endpoint_contracts = DOJO_DOCKER_REQUIRED_ENDPOINTS
      .filter((endpoint) => endpoint.id !== "collab_ports")
      .map((endpoint) => ({ id: endpoint.id, expected_status: endpoint.expected_status }));
    expect(validateDojoReleaseGateManifest(brokenDocker, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "docker_integration_missing_required_services:mcp",
      "docker_integration_missing_required_healthy_services:postgres",
      "docker_integration_missing_required_endpoints:collab_ports",
    ]));

    const brokenMcpHostConformance = JSON.parse(JSON.stringify(manifest));
    const mcpHostSelfCheckGate = brokenMcpHostConformance.gates.find((gate) => gate.id === "dojo_mcp_host_conformance_self_check");
    mcpHostSelfCheckGate.artifact_requirements.require_private_network_rejection = false;
    mcpHostSelfCheckGate.artifact_requirements.require_link_local_rejection = false;
    const mcpHostGate = brokenMcpHostConformance.gates.find((gate) => gate.id === "dojo_mcp_host_conformance");
    mcpHostGate.default_report_path = mcpHostSelfCheckGate.default_report_path;
    mcpHostGate.default_evidence_path = mcpHostSelfCheckGate.default_evidence_path;
    mcpHostGate.release_artifact_requirements.require_public_non_local_mcp_host = false;
    mcpHostGate.release_artifact_requirements.require_revocation_propagation = false;
    mcpHostGate.release_artifact_requirements.require_external_proof_signing = false;
    mcpHostGate.release_artifact_requirements.require_no_local_cdp = false;
    mcpHostGate.requires_env = mcpHostGate.requires_env
      .filter((envName) => envName !== "SYNTHI_DOJO_MCP_CONFORMANCE_EXTERNAL_PROOF_SIGNING");
    expect(validateDojoReleaseGateManifest(brokenMcpHostConformance, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "mcp_host_conformance_self_check_missing_private_network_rejection",
      "mcp_host_conformance_self_check_missing_link_local_rejection",
      "mcp_host_conformance_missing_public_non_local_requirement",
      "mcp_host_conformance_missing_revocation_requirement",
      "mcp_host_conformance_missing_external_signing_requirement",
      "mcp_host_conformance_missing_no_local_cdp_requirement",
      "mcp_host_conformance_missing_env:SYNTHI_DOJO_MCP_CONFORMANCE_EXTERNAL_PROOF_SIGNING",
      "mcp_host_conformance_default_report_path_conflicts_self_check",
      "mcp_host_conformance_default_evidence_path_conflicts_self_check",
    ]));

    const brokenPrivateToolHostConformance = JSON.parse(JSON.stringify(manifest));
    const privateHostGate = brokenPrivateToolHostConformance.gates
      .find((gate) => gate.id === "private_tool_stdio_host_conformance");
    privateHostGate.release_artifact_requirements.require_no_local_attach = false;
    privateHostGate.release_artifact_requirements.require_private_tool_call = false;
    expect(validateDojoReleaseGateManifest(brokenPrivateToolHostConformance, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "private_tool_host_conformance_missing_no_local_attach:private_tool_stdio_host_conformance",
      "private_tool_host_conformance_missing_private_tool_call:private_tool_stdio_host_conformance",
    ]));

    const brokenGeneratedPr = JSON.parse(JSON.stringify(manifest));
    const generatedPrGate = brokenGeneratedPr.gates.find((gate) => gate.id === "dojo_generated_pr_self_check");
    const missingGeneratedPrTestFile = DOJO_GENERATED_PR_TEST_FILES[0];
    generatedPrGate.release_artifact_requirements.required_generated_pr_capabilities = DOJO_GENERATED_PR_CAPABILITIES
      .filter((capability) => capability !== "generated_pr_git_branch_creates_branch_and_tests");
    generatedPrGate.release_artifact_requirements.required_test_files = DOJO_GENERATED_PR_TEST_FILES
      .filter((file) => file !== missingGeneratedPrTestFile);
    generatedPrGate.release_artifact_requirements.require_git_branch_creation = false;
    generatedPrGate.release_artifact_requirements.require_generated_contract_tests = false;
    generatedPrGate.release_artifact_requirements.require_self_check_executes_tests = false;
    expect(validateDojoReleaseGateManifest(brokenGeneratedPr, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "generated_pr_missing_git_branch_requirement",
      "generated_pr_missing_contract_tests_requirement",
      "generated_pr_missing_self_check_execution_requirement",
      "generated_pr_missing_required_capabilities:generated_pr_git_branch_creates_branch_and_tests",
      `generated_pr_missing_required_test_files:${missingGeneratedPrTestFile}`,
    ]));

    const brokenMcpSkillBus = JSON.parse(JSON.stringify(manifest));
    const mcpSkillBusGate = brokenMcpSkillBus.gates.find((gate) => gate.id === "dojo_mcp_skill_bus_self_check");
    const missingMcpSkillBusTestFile = DOJO_MCP_SKILL_BUS_TEST_FILES[0];
    mcpSkillBusGate.release_artifact_requirements.required_mcp_skill_bus_capabilities = DOJO_MCP_SKILL_BUS_CAPABILITIES
      .filter((capability) => capability !== "mcp_skill_bus_consumes_proof_before_non_dry_dispatch");
    mcpSkillBusGate.release_artifact_requirements.required_test_files = DOJO_MCP_SKILL_BUS_TEST_FILES
      .filter((file) => file !== missingMcpSkillBusTestFile);
    mcpSkillBusGate.release_artifact_requirements.require_proof_consume = false;
    mcpSkillBusGate.release_artifact_requirements.require_tenant_boundary = false;
    mcpSkillBusGate.release_artifact_requirements.require_self_check_executes_tests = false;
    mcpSkillBusGate.requires_env = [];
    expect(validateDojoReleaseGateManifest(brokenMcpSkillBus, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "mcp_skill_bus_missing_proof_consume_requirement",
      "mcp_skill_bus_missing_tenant_boundary_requirement",
      "mcp_skill_bus_missing_self_check_execution_requirement",
      "mcp_skill_bus_missing_postgres_env",
      "mcp_skill_bus_missing_required_capabilities:mcp_skill_bus_consumes_proof_before_non_dry_dispatch",
      `mcp_skill_bus_missing_required_test_files:${missingMcpSkillBusTestFile}`,
    ]));

    const brokenManagedKeySigning = JSON.parse(JSON.stringify(manifest));
    const managedKeySigningGate = brokenManagedKeySigning.gates.find((gate) => gate.id === "dojo_managed_key_signing_self_check");
    const missingManagedKeySigningTestFile = DOJO_MANAGED_KEY_SIGNING_TEST_FILES[0];
    managedKeySigningGate.release_artifact_requirements.required_managed_key_signing_capabilities = DOJO_MANAGED_KEY_SIGNING_CAPABILITIES
      .filter((capability) => capability !== "managed_key_service_rejects_local_custody_metadata");
    managedKeySigningGate.release_artifact_requirements.required_test_files = DOJO_MANAGED_KEY_SIGNING_TEST_FILES
      .filter((file) => file !== missingManagedKeySigningTestFile);
    managedKeySigningGate.release_artifact_requirements.require_managed_key_custody = false;
    managedKeySigningGate.release_artifact_requirements.require_release_managed_key_observation = false;
    managedKeySigningGate.release_artifact_requirements.require_release_observation_artifact_digest_match = false;
    managedKeySigningGate.release_artifact_requirements.release_observation_max_age_ms = 0;
    managedKeySigningGate.release_artifact_requirements.release_observation_future_tolerance_ms = -1;
    managedKeySigningGate.release_artifact_requirements.release_observation_schema_version = "broken";
    managedKeySigningGate.release_artifact_requirements.required_release_observation_checks = DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_CHECKS.slice(1);
    managedKeySigningGate.release_artifact_requirements.release_observation_producer = {
      package_script: "proof:dojo:managed-key-signing:broken",
      command: "node broken.js",
      default_observation_path: "",
      required_env: DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_REQUIRED_ENV.slice(1),
    };
    managedKeySigningGate.release_artifact_requirements.section_release_verifier = {
      flag: "--wrong-managed-key-flag",
      evidence_arg: "--wrong-managed-key-evidence",
      default_evidence_path: "tmp/wrong-managed-key-evidence.json",
      command: "node mcp/synthi-mcp/scripts/dojo-release-gate-verify.mjs",
    };
    managedKeySigningGate.requires_env = [];
    expect(validateDojoReleaseGateManifest(brokenManagedKeySigning, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "managed_key_signing_missing_custody_requirement",
      "managed_key_signing_missing_release_observation_requirement",
      "managed_key_signing_missing_release_observation_artifact_digest_requirement",
      "managed_key_signing_missing_release_observation_freshness_requirement",
      "managed_key_signing_missing_release_observation_future_tolerance_requirement",
      "managed_key_signing_missing_release_observation_schema",
      `managed_key_signing_missing_release_observation_checks:${DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_CHECKS[0]}`,
      "managed_key_signing_missing_release_observation_env",
      "managed_key_signing_missing_release_observation_producer_script",
      "managed_key_signing_missing_release_observation_producer_command",
      "managed_key_signing_missing_release_observation_producer_path",
      `managed_key_signing_missing_release_observation_producer_env:${DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_REQUIRED_ENV[0]}`,
      "managed_key_signing_missing_section_release_verifier_flag",
      "managed_key_signing_missing_section_release_verifier_evidence_arg",
      "managed_key_signing_section_release_verifier_evidence_path_mismatch",
      "managed_key_signing_missing_section_release_verifier_out_dir",
      "managed_key_signing_missing_section_release_verifier_command",
      "managed_key_signing_missing_required_capabilities:managed_key_service_rejects_local_custody_metadata",
      `managed_key_signing_missing_required_test_files:${missingManagedKeySigningTestFile}`,
    ]));

    const brokenPublicProof = JSON.parse(JSON.stringify(manifest));
    const publicProofGate = brokenPublicProof.gates.find((gate) => gate.id === "dojo_public_proof_verification_self_check");
    const missingPublicProofTestFile = DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES[0];
    publicProofGate.release_artifact_requirements.required_public_proof_verification_capabilities = DOJO_PUBLIC_PROOF_VERIFICATION_CAPABILITIES
      .filter((capability) => capability !== "public_proof_verifies_ed25519_public_key");
    publicProofGate.release_artifact_requirements.required_test_files = DOJO_PUBLIC_PROOF_VERIFICATION_TEST_FILES
      .filter((file) => file !== missingPublicProofTestFile);
    publicProofGate.release_artifact_requirements.require_ed25519_public_key = false;
    publicProofGate.release_artifact_requirements.require_key_custody_metadata_export = false;
    publicProofGate.release_artifact_requirements.require_private_secret_exclusion = false;
    publicProofGate.release_artifact_requirements.require_self_check_executes_tests = false;
    expect(validateDojoReleaseGateManifest(brokenPublicProof, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "public_proof_missing_ed25519_requirement",
      "public_proof_missing_key_custody_metadata_export_requirement",
      "public_proof_missing_secret_exclusion_requirement",
      "public_proof_missing_self_check_execution_requirement",
      "public_proof_missing_required_capabilities:public_proof_verifies_ed25519_public_key",
      `public_proof_missing_required_test_files:${missingPublicProofTestFile}`,
    ]));

    const brokenGovernanceLifecycle = JSON.parse(JSON.stringify(manifest));
    const governanceLifecycleGate = brokenGovernanceLifecycle.gates.find((gate) => gate.id === "dojo_governance_lifecycle_self_check");
    const missingGovernanceTestFile = DOJO_GOVERNANCE_LIFECYCLE_TEST_FILES[0];
    governanceLifecycleGate.release_artifact_requirements.required_governance_lifecycle_capabilities = DOJO_GOVERNANCE_LIFECYCLE_CAPABILITIES
      .filter((capability) => capability !== "governance_revokes_license_to_blocked_scope_with_audit");
    governanceLifecycleGate.release_artifact_requirements.required_test_files = DOJO_GOVERNANCE_LIFECYCLE_TEST_FILES
      .filter((file) => file !== missingGovernanceTestFile);
    governanceLifecycleGate.release_artifact_requirements.require_license_revocation = false;
    governanceLifecycleGate.release_artifact_requirements.require_rbac = false;
    governanceLifecycleGate.release_artifact_requirements.require_store_rbac = false;
    governanceLifecycleGate.release_artifact_requirements.require_compliance_pack = false;
    governanceLifecycleGate.release_artifact_requirements.require_compliance_archive_manifest = false;
    governanceLifecycleGate.release_artifact_requirements.require_scheduled_jobs = false;
    governanceLifecycleGate.release_artifact_requirements.require_self_check_executes_tests = false;
    expect(validateDojoReleaseGateManifest(brokenGovernanceLifecycle, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "governance_lifecycle_missing_license_revocation_requirement",
      "governance_lifecycle_missing_rbac_requirement",
      "governance_lifecycle_missing_store_rbac_requirement",
      "governance_lifecycle_missing_compliance_pack_requirement",
      "governance_lifecycle_missing_compliance_archive_manifest_requirement",
      "governance_lifecycle_missing_scheduled_jobs_requirement",
      "governance_lifecycle_missing_self_check_execution_requirement",
      "governance_lifecycle_missing_required_capabilities:governance_revokes_license_to_blocked_scope_with_audit",
      `governance_lifecycle_missing_required_test_files:${missingGovernanceTestFile}`,
    ]));

    const brokenGraphRuntime = JSON.parse(JSON.stringify(manifest));
    const graphRuntimeGate = brokenGraphRuntime.gates.find((gate) => gate.id === "dojo_graph_runtime_self_check");
    const missingGraphRuntimeTestFile = DOJO_GRAPH_RUNTIME_TEST_FILES[0];
    graphRuntimeGate.release_artifact_requirements.required_graph_runtime_capabilities = DOJO_GRAPH_RUNTIME_CAPABILITIES
      .filter((capability) => capability !== "graph_runtime_executes_available_rollback");
    graphRuntimeGate.release_artifact_requirements.required_test_files = DOJO_GRAPH_RUNTIME_TEST_FILES
      .filter((file) => file !== missingGraphRuntimeTestFile);
    graphRuntimeGate.release_artifact_requirements.require_rollback_runtime = false;
    graphRuntimeGate.release_artifact_requirements.require_proof_gate = false;
    graphRuntimeGate.release_artifact_requirements.require_self_check_executes_tests = false;
    expect(validateDojoReleaseGateManifest(brokenGraphRuntime, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "graph_runtime_missing_rollback_requirement",
      "graph_runtime_missing_proof_gate_requirement",
      "graph_runtime_missing_self_check_execution_requirement",
      "graph_runtime_missing_required_capabilities:graph_runtime_executes_available_rollback",
      `graph_runtime_missing_required_test_files:${missingGraphRuntimeTestFile}`,
    ]));

    const brokenGhostMode = JSON.parse(JSON.stringify(manifest));
    const ghostModeGate = brokenGhostMode.gates.find((gate) => gate.id === "dojo_ghost_mode_evidence_self_check");
    const missingGhostModeTestFile = DOJO_GHOST_MODE_EVIDENCE_TEST_FILES[0];
    ghostModeGate.release_artifact_requirements.required_ghost_mode_capabilities = DOJO_GHOST_MODE_EVIDENCE_CAPABILITIES
      .filter((capability) => capability !== "ghost_mode_runs_without_production_mutation");
    ghostModeGate.release_artifact_requirements.required_test_files = DOJO_GHOST_MODE_EVIDENCE_TEST_FILES
      .filter((file) => file !== missingGhostModeTestFile);
    ghostModeGate.release_artifact_requirements.require_non_mutating_shadow_run = false;
    ghostModeGate.release_artifact_requirements.require_tenant_boundary = false;
    ghostModeGate.release_artifact_requirements.require_self_check_executes_tests = false;
    ghostModeGate.requires_env = [];
    expect(validateDojoReleaseGateManifest(brokenGhostMode, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "ghost_mode_missing_non_mutating_requirement",
      "ghost_mode_missing_tenant_boundary_requirement",
      "ghost_mode_missing_self_check_execution_requirement",
      "ghost_mode_missing_postgres_env",
      "ghost_mode_missing_required_capabilities:ghost_mode_runs_without_production_mutation",
      `ghost_mode_missing_required_test_files:${missingGhostModeTestFile}`,
    ]));

    const brokenSkillPassport = JSON.parse(JSON.stringify(manifest));
    const skillPassportGate = brokenSkillPassport.gates.find((gate) => gate.id === "dojo_skill_passport_self_check");
    const missingSkillPassportTestFile = DOJO_SKILL_PASSPORT_TEST_FILES[0];
    skillPassportGate.release_artifact_requirements.required_skill_passport_capabilities = DOJO_SKILL_PASSPORT_CAPABILITIES
      .filter((capability) => capability !== "skill_passport_report_only_status");
    skillPassportGate.release_artifact_requirements.required_test_files = DOJO_SKILL_PASSPORT_TEST_FILES
      .filter((file) => file !== missingSkillPassportTestFile);
    skillPassportGate.release_artifact_requirements.require_report_only_status = false;
    skillPassportGate.release_artifact_requirements.require_executable_entrustment_provenance = false;
    skillPassportGate.release_artifact_requirements.require_raw_payload_redaction = false;
    skillPassportGate.release_artifact_requirements.require_self_check_executes_tests = false;
    expect(validateDojoReleaseGateManifest(brokenSkillPassport, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "skill_passport_missing_report_only_requirement",
      "skill_passport_missing_executable_entrustment_requirement",
      "skill_passport_missing_redaction_requirement",
      "skill_passport_missing_self_check_execution_requirement",
      "skill_passport_missing_required_capabilities:skill_passport_report_only_status",
      `skill_passport_missing_required_test_files:${missingSkillPassportTestFile}`,
    ]));

    const brokenTimeMachine = JSON.parse(JSON.stringify(manifest));
    const timeMachineGate = brokenTimeMachine.gates.find((gate) => gate.id === "dojo_time_machine_debugger_self_check");
    const missingTimeMachineTestFile = DOJO_TIME_MACHINE_DEBUGGER_TEST_FILES[0];
    timeMachineGate.release_artifact_requirements.required_time_machine_capabilities = DOJO_TIME_MACHINE_DEBUGGER_CAPABILITIES
      .filter((capability) => capability !== "time_machine_replay_plan");
    timeMachineGate.release_artifact_requirements.required_test_files = DOJO_TIME_MACHINE_DEBUGGER_TEST_FILES
      .filter((file) => file !== missingTimeMachineTestFile);
    timeMachineGate.release_artifact_requirements.require_replay_plan = false;
    timeMachineGate.release_artifact_requirements.require_honest_projection_status = false;
    timeMachineGate.release_artifact_requirements.require_self_check_executes_tests = false;
    expect(validateDojoReleaseGateManifest(brokenTimeMachine, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "time_machine_missing_replay_plan_requirement",
      "time_machine_missing_honest_status_requirement",
      "time_machine_missing_self_check_execution_requirement",
      "time_machine_missing_required_capabilities:time_machine_replay_plan",
      `time_machine_missing_required_test_files:${missingTimeMachineTestFile}`,
    ]));

    const brokenVivariumRuntime = JSON.parse(JSON.stringify(manifest));
    const vivariumRuntimeGate = brokenVivariumRuntime.gates.find((gate) => gate.id === "dojo_vivarium_runtime_self_check");
    const missingVivariumRuntimeTestFile = DOJO_VIVARIUM_RUNTIME_TEST_FILES[0];
    vivariumRuntimeGate.release_artifact_requirements.required_vivarium_runtime_capabilities = DOJO_VIVARIUM_RUNTIME_CAPABILITIES
      .filter((capability) => ![
        "evil_twin_hardening_reduces_attack_success_rate",
        "evil_twin_hardens_expanded_attack_classes",
      ].includes(capability));
    vivariumRuntimeGate.release_artifact_requirements.required_test_files = DOJO_VIVARIUM_RUNTIME_TEST_FILES
      .filter((file) => file !== missingVivariumRuntimeTestFile);
    vivariumRuntimeGate.release_artifact_requirements.require_evil_twin_hardening_loop = false;
    vivariumRuntimeGate.release_artifact_requirements.require_evil_twin_expanded_assumption_extraction = false;
    vivariumRuntimeGate.release_artifact_requirements.require_evil_twin_expanded_hardening_guardrails = false;
    vivariumRuntimeGate.release_artifact_requirements.require_executable_checkride = false;
    vivariumRuntimeGate.release_artifact_requirements.require_ambiguous_document_names = false;
    vivariumRuntimeGate.release_artifact_requirements.require_document_tissue_specific_evidence = false;
    vivariumRuntimeGate.release_artifact_requirements.require_ui_tissue_mutations = false;
    vivariumRuntimeGate.release_artifact_requirements.require_ui_tissue_specific_evidence = false;
    vivariumRuntimeGate.release_artifact_requirements.require_misleading_toast_tissue = false;
    vivariumRuntimeGate.release_artifact_requirements.require_route_tissue = false;
    vivariumRuntimeGate.release_artifact_requirements.require_policy_tissue = false;
    vivariumRuntimeGate.release_artifact_requirements.require_expanded_identity_tissue = false;
    vivariumRuntimeGate.release_artifact_requirements.require_invalid_value_data_tissue = false;
    vivariumRuntimeGate.release_artifact_requirements.require_stale_missing_data_tissue = false;
    vivariumRuntimeGate.release_artifact_requirements.require_api_validation_latency_tissue = false;
    vivariumRuntimeGate.release_artifact_requirements.require_api_downstream_failure_tissue = false;
    vivariumRuntimeGate.release_artifact_requirements.require_api_entity_conflict_faults = false;
    vivariumRuntimeGate.release_artifact_requirements.require_api_entity_conflict_runner_tissue = false;
    vivariumRuntimeGate.release_artifact_requirements.require_self_check_executes_tests = false;
    expect(validateDojoReleaseGateManifest(brokenVivariumRuntime, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "vivarium_runtime_missing_evil_twin_hardening_requirement",
      "vivarium_runtime_missing_evil_twin_expanded_assumption_requirement",
      "vivarium_runtime_missing_evil_twin_expanded_hardening_requirement",
      "vivarium_runtime_missing_checkride_requirement",
      "vivarium_runtime_missing_ambiguous_document_requirement",
      "vivarium_runtime_missing_document_tissue_specific_evidence_requirement",
      "vivarium_runtime_missing_ui_tissue_requirement",
      "vivarium_runtime_missing_ui_tissue_specific_evidence_requirement",
      "vivarium_runtime_missing_misleading_toast_tissue_requirement",
      "vivarium_runtime_missing_route_tissue_requirement",
      "vivarium_runtime_missing_policy_tissue_requirement",
      "vivarium_runtime_missing_expanded_identity_tissue_requirement",
      "vivarium_runtime_missing_invalid_value_data_tissue_requirement",
      "vivarium_runtime_missing_stale_missing_data_tissue_requirement",
      "vivarium_runtime_missing_api_validation_latency_tissue_requirement",
      "vivarium_runtime_missing_api_downstream_failure_tissue_requirement",
      "vivarium_runtime_missing_api_entity_conflict_fault_requirement",
      "vivarium_runtime_missing_api_entity_conflict_runner_tissue_requirement",
      "vivarium_runtime_missing_self_check_execution_requirement",
      "vivarium_runtime_missing_required_capabilities:evil_twin_hardening_reduces_attack_success_rate,evil_twin_hardens_expanded_attack_classes",
      `vivarium_runtime_missing_required_test_files:${missingVivariumRuntimeTestFile}`,
    ]));

    const brokenCheckrideLicense = JSON.parse(JSON.stringify(manifest));
    const checkrideLicenseGate = brokenCheckrideLicense.gates.find((gate) => gate.id === "dojo_checkride_license_self_check");
    const missingCheckrideLicenseTestFile = DOJO_CHECKRIDE_LICENSE_TEST_FILES[0];
    checkrideLicenseGate.release_artifact_requirements.required_checkride_license_capabilities = DOJO_CHECKRIDE_LICENSE_CAPABILITIES
      .filter((capability) => capability !== "checkride_runtime_oracle_blocks_happy_path_only");
    checkrideLicenseGate.release_artifact_requirements.required_test_files = DOJO_CHECKRIDE_LICENSE_TEST_FILES
      .filter((file) => file !== missingCheckrideLicenseTestFile);
    checkrideLicenseGate.release_artifact_requirements.require_executable_checkride = false;
    checkrideLicenseGate.release_artifact_requirements.require_ledger_append = false;
    checkrideLicenseGate.release_artifact_requirements.require_license_constraints = false;
    checkrideLicenseGate.release_artifact_requirements.require_stale_evidence_downgrade = false;
    checkrideLicenseGate.release_artifact_requirements.require_self_check_executes_tests = false;
    expect(validateDojoReleaseGateManifest(brokenCheckrideLicense, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "checkride_license_missing_executable_requirement",
      "checkride_license_missing_ledger_append_requirement",
      "checkride_license_missing_license_constraint_requirement",
      "checkride_license_missing_stale_evidence_requirement",
      "checkride_license_missing_self_check_execution_requirement",
      "checkride_license_missing_required_capabilities:checkride_runtime_oracle_blocks_happy_path_only",
      `checkride_license_missing_required_test_files:${missingCheckrideLicenseTestFile}`,
    ]));

    const brokenCaseLawRuntime = JSON.parse(JSON.stringify(manifest));
    const caseLawRuntimeGate = brokenCaseLawRuntime.gates.find((gate) => gate.id === "dojo_case_law_runtime_self_check");
    const missingCaseLawRuntimeTestFile = DOJO_CASE_LAW_RUNTIME_TEST_FILES[0];
    caseLawRuntimeGate.release_artifact_requirements.required_case_law_runtime_capabilities = DOJO_CASE_LAW_RUNTIME_CAPABILITIES
      .filter((capability) => capability !== "antibody_matcher_proposes_without_binding");
    caseLawRuntimeGate.release_artifact_requirements.required_test_files = DOJO_CASE_LAW_RUNTIME_TEST_FILES
      .filter((file) => file !== missingCaseLawRuntimeTestFile);
    caseLawRuntimeGate.release_artifact_requirements.require_antibody_matching = false;
    caseLawRuntimeGate.release_artifact_requirements.require_antibody_private_data_redaction = false;
    caseLawRuntimeGate.release_artifact_requirements.require_self_check_executes_tests = false;
    expect(validateDojoReleaseGateManifest(brokenCaseLawRuntime, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "case_law_runtime_missing_antibody_matching_requirement",
      "case_law_runtime_missing_antibody_private_data_requirement",
      "case_law_runtime_missing_self_check_execution_requirement",
      "case_law_runtime_missing_required_capabilities:antibody_matcher_proposes_without_binding",
      `case_law_runtime_missing_required_test_files:${missingCaseLawRuntimeTestFile}`,
    ]));

    const brokenHostedRuntimeGateway = JSON.parse(JSON.stringify(manifest));
    const hostedRuntimeGatewayGate = brokenHostedRuntimeGateway.gates.find((gate) => gate.id === "dojo_hosted_runtime_gateway_self_check");
    const missingHostedRuntimeTestFile = DOJO_HOSTED_RUNTIME_GATEWAY_TEST_FILES[0];
    hostedRuntimeGatewayGate.release_artifact_requirements.required_hosted_runtime_gateway_capabilities = DOJO_HOSTED_RUNTIME_GATEWAY_CAPABILITIES
      .filter((capability) => capability !== "hosted_runtime_blocks_expired_and_revoked_sessions");
    hostedRuntimeGatewayGate.release_artifact_requirements.required_test_files = DOJO_HOSTED_RUNTIME_GATEWAY_TEST_FILES
      .filter((file) => file !== missingHostedRuntimeTestFile);
    hostedRuntimeGatewayGate.release_artifact_requirements.require_revocation_and_expiry = false;
    hostedRuntimeGatewayGate.release_artifact_requirements.require_evidence_write = false;
    hostedRuntimeGatewayGate.release_artifact_requirements.require_durable_postgres_session_gate = false;
    hostedRuntimeGatewayGate.release_artifact_requirements.durable_postgres_session_gate_id = "wrong_gate";
    hostedRuntimeGatewayGate.release_artifact_requirements.require_release_runtime_observation = false;
    hostedRuntimeGatewayGate.release_artifact_requirements.require_release_observation_artifact_digest_match = false;
    hostedRuntimeGatewayGate.release_artifact_requirements.release_observation_max_age_ms = 0;
    hostedRuntimeGatewayGate.release_artifact_requirements.release_observation_future_tolerance_ms = -1;
    hostedRuntimeGatewayGate.release_artifact_requirements.required_release_observation_gate_ids = DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_GATE_IDS
      .filter((gateId) => gateId !== "workflow_e2e_hosted");
    hostedRuntimeGatewayGate.release_artifact_requirements.release_observation_producer = {
      package_script: "wrong:hosted-runtime:observe",
      command: "node wrong-hosted-runtime-producer.mjs",
      default_observation_path: "tmp/wrong-hosted-runtime-observation.json",
      required_inputs: {
        workflow_e2e_hosted: {
          arg: "wrong-workflow-summary",
          default_path: "tmp/wrong-workflow.json",
        },
      },
    };
    hostedRuntimeGatewayGate.release_artifact_requirements.section_release_verifier = {
      flag: "--wrong-hosted-runtime-flag",
      evidence_arg: "--wrong-hosted-runtime-evidence",
      default_evidence_path: "tmp/wrong-evidence.json",
      command: "node mcp/synthi-mcp/scripts/dojo-release-gate-verify.mjs",
    };
    hostedRuntimeGatewayGate.release_artifact_requirements.require_self_check_executes_tests = false;
    hostedRuntimeGatewayGate.requires_env = [];
    expect(validateDojoReleaseGateManifest(brokenHostedRuntimeGateway, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "hosted_runtime_gateway_missing_revocation_expiry_requirement",
      "hosted_runtime_gateway_missing_evidence_requirement",
      "hosted_runtime_gateway_missing_durable_postgres_gate_requirement",
      "hosted_runtime_gateway_missing_durable_postgres_gate_id",
      `hosted_runtime_gateway_missing_release_observation_env:${DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_ENV}`,
      "hosted_runtime_gateway_missing_release_observation_requirement",
      "hosted_runtime_gateway_missing_release_observation_artifact_digest_requirement",
      "hosted_runtime_gateway_missing_release_observation_freshness_requirement",
      "hosted_runtime_gateway_missing_release_observation_future_tolerance_requirement",
      "hosted_runtime_gateway_missing_release_observation_gate_ids:workflow_e2e_hosted",
      "hosted_runtime_gateway_missing_release_observation_producer_script",
      "hosted_runtime_gateway_missing_release_observation_producer_command",
      "hosted_runtime_gateway_missing_release_observation_producer_path",
      "hosted_runtime_gateway_missing_release_observation_producer_inputs:workflow_e2e_hosted,private_tool_stdio_acceptance,private_tool_codex_acceptance,dojo_mcp_host_conformance,private_tool_stdio_host_conformance,private_tool_codex_host_conformance",
      "hosted_runtime_gateway_missing_section_release_verifier_flag",
      "hosted_runtime_gateway_missing_section_release_verifier_evidence_arg",
      "hosted_runtime_gateway_section_release_verifier_evidence_path_mismatch",
      "hosted_runtime_gateway_missing_section_release_verifier_out_dir",
      "hosted_runtime_gateway_missing_section_release_verifier_command",
      "hosted_runtime_gateway_missing_self_check_execution_requirement",
      "hosted_runtime_gateway_missing_required_capabilities:hosted_runtime_blocks_expired_and_revoked_sessions",
      `hosted_runtime_gateway_missing_required_test_files:${missingHostedRuntimeTestFile}`,
    ]));

    const brokenPackageReadiness = JSON.parse(JSON.stringify(manifest));
    const packageReadinessGate = brokenPackageReadiness.gates.find((gate) => gate.id === "dojo_package_readiness_self_check");
    packageReadinessGate.artifact_requirements.required_package_script_selectors = DOJO_PACKAGE_READINESS_REQUIRED_SCRIPT_SELECTORS
      .filter((selector) => selector !== "proof:dojo*");
    expect(validateDojoReleaseGateManifest(brokenPackageReadiness, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "package_readiness_missing_required_script_selectors:proof:dojo*",
    ]));

    const brokenSecurity = JSON.parse(JSON.stringify(manifest));
    const securityGate = brokenSecurity.gates.find((gate) => gate.id === "security_abuse_suite");
    const missingSecurityTestFile = DOJO_SECURITY_ABUSE_TEST_FILES[0];
    securityGate.release_artifact_requirements.required_abuse_classes = DOJO_SECURITY_ABUSE_CLASSES.filter((abuseClass) => abuseClass !== "fake_success_oracle");
    securityGate.release_artifact_requirements.required_test_files = DOJO_SECURITY_ABUSE_TEST_FILES
      .filter((file) => file !== missingSecurityTestFile);
    securityGate.release_artifact_requirements.require_no_skipped_tests = false;
    securityGate.release_artifact_requirements.section_release_verifier = {
      flag: "--wrong-security-flag",
      evidence_arg: "--wrong-security-evidence",
      default_evidence_path: "tmp/wrong-security-evidence.json",
      command: "node mcp/synthi-mcp/scripts/dojo-release-gate-verify.mjs",
    };
    expect(validateDojoReleaseGateManifest(brokenSecurity, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "security_abuse_missing_required_classes:fake_success_oracle",
      `security_abuse_missing_required_test_files:${missingSecurityTestFile}`,
      "security_abuse_missing_no_skipped_requirement",
      "security_abuse_missing_section_release_verifier_flag",
      "security_abuse_missing_section_release_verifier_evidence_arg",
      "security_abuse_section_release_verifier_evidence_path_mismatch",
      "security_abuse_missing_section_release_verifier_out_dir",
      "security_abuse_missing_section_release_verifier_command",
    ]));

    const brokenCompliance = JSON.parse(JSON.stringify(manifest));
    const complianceGate = brokenCompliance.gates.find((gate) => gate.id === "compliance_export_suite");
    const missingComplianceTestFile = DOJO_COMPLIANCE_EXPORT_TEST_FILES[0];
    complianceGate.release_artifact_requirements.required_compliance_capabilities = DOJO_COMPLIANCE_EXPORT_CAPABILITIES
      .filter((capability) => capability !== "redacted_evidence_export");
    complianceGate.release_artifact_requirements.required_test_files = DOJO_COMPLIANCE_EXPORT_TEST_FILES
      .filter((file) => file !== missingComplianceTestFile);
    complianceGate.release_artifact_requirements.section_release_verifier = {
      flag: "--wrong-compliance-flag",
      evidence_arg: "--wrong-compliance-evidence",
      default_evidence_path: "tmp/wrong-compliance-evidence.json",
      command: "node mcp/synthi-mcp/scripts/dojo-release-gate-verify.mjs",
    };
    expect(validateDojoReleaseGateManifest(brokenCompliance, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "compliance_export_missing_required_capabilities:redacted_evidence_export",
      `compliance_export_missing_required_test_files:${missingComplianceTestFile}`,
      "compliance_export_missing_section_release_verifier_flag",
      "compliance_export_missing_section_release_verifier_evidence_arg",
      "compliance_export_section_release_verifier_evidence_path_mismatch",
      "compliance_export_missing_section_release_verifier_out_dir",
      "compliance_export_missing_section_release_verifier_command",
    ]));

    const brokenPrivacy = JSON.parse(JSON.stringify(manifest));
    const privacyGate = brokenPrivacy.gates.find((gate) => gate.id === "privacy_redaction_suite");
    const missingPrivacyTestFile = DOJO_PRIVACY_REDACTION_TEST_FILES[0];
    privacyGate.release_artifact_requirements.required_privacy_capabilities = DOJO_PRIVACY_REDACTION_CAPABILITIES
      .filter((capability) => capability !== "browser_origin_privacy_boundary");
    privacyGate.release_artifact_requirements.required_test_files = DOJO_PRIVACY_REDACTION_TEST_FILES
      .filter((file) => file !== missingPrivacyTestFile);
    privacyGate.release_artifact_requirements.section_release_verifier = {
      flag: "--wrong-privacy-flag",
      evidence_arg: "--wrong-privacy-evidence",
      default_evidence_path: "tmp/wrong-privacy-evidence.json",
      command: "node mcp/synthi-mcp/scripts/dojo-release-gate-verify.mjs",
    };
    expect(validateDojoReleaseGateManifest(brokenPrivacy, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "privacy_redaction_missing_required_capabilities:browser_origin_privacy_boundary",
      `privacy_redaction_missing_required_test_files:${missingPrivacyTestFile}`,
      "privacy_redaction_missing_section_release_verifier_flag",
      "privacy_redaction_missing_section_release_verifier_evidence_arg",
      "privacy_redaction_section_release_verifier_evidence_path_mismatch",
      "privacy_redaction_missing_section_release_verifier_out_dir",
      "privacy_redaction_missing_section_release_verifier_command",
    ]));

    const brokenChaos = JSON.parse(JSON.stringify(manifest));
    const chaosGate = brokenChaos.gates.find((gate) => gate.id === "dojo_chaos_performance_self_check");
    const missingChaosTestFile = DOJO_CHAOS_PERFORMANCE_TEST_FILES[0];
    chaosGate.enterprise_artifact_requirements.required_chaos_scenarios = DOJO_CHAOS_SCENARIOS
      .filter((scenario) => scenario !== "api_timeout");
    chaosGate.enterprise_artifact_requirements.required_test_files = DOJO_CHAOS_PERFORMANCE_TEST_FILES
      .filter((file) => file !== missingChaosTestFile);
    chaosGate.enterprise_artifact_requirements.required_dojo_release_metrics = DOJO_CHAOS_PERFORMANCE_REQUIRED_METRICS
      .filter((metric) => metric !== "proof_validation_p95_ms");
    chaosGate.enterprise_artifact_requirements.require_no_skipped_tests = false;
    chaosGate.enterprise_artifact_requirements.require_dojo_release_metrics = false;
    chaosGate.enterprise_artifact_requirements.section_enterprise_verifier = {
      flag: "--wrong-chaos-enterprise-flag",
      evidence_arg: "--wrong-chaos-evidence",
      default_evidence_path: "tmp/wrong-chaos-evidence.json",
      command: "node mcp/synthi-mcp/scripts/dojo-release-gate-verify.mjs",
    };
    expect(validateDojoReleaseGateManifest(brokenChaos, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "chaos_performance_missing_required_scenarios:api_timeout",
      `chaos_performance_missing_required_test_files:${missingChaosTestFile}`,
      "chaos_performance_missing_no_skipped_requirement",
      "chaos_performance_missing_dojo_release_metrics_requirement",
      "chaos_performance_missing_required_dojo_release_metrics:proof_validation_p95_ms",
      "chaos_performance_missing_section_enterprise_verifier_flag",
      "chaos_performance_missing_section_enterprise_verifier_evidence_arg",
      "chaos_performance_section_enterprise_verifier_evidence_path_mismatch",
      "chaos_performance_missing_section_enterprise_verifier_out_dir",
      "chaos_performance_missing_section_enterprise_verifier_command",
    ]));

    const brokenLiveChaos = JSON.parse(JSON.stringify(manifest));
    const liveChaosGate = brokenLiveChaos.gates.find((gate) => gate.id === "dojo_live_chaos");
    liveChaosGate.required_for = ["nightly"];
    liveChaosGate.default_report_path = "";
    liveChaosGate.requires_env = DOJO_LIVE_CHAOS_REQUIRED_ENV
      .filter((envName) => envName !== DOJO_LIVE_CHAOS_COMMAND_ENVS[0]);
    liveChaosGate.enterprise_artifact_requirements.require_explicit_live_enable_env = "";
    liveChaosGate.enterprise_artifact_requirements.required_live_scenarios = DOJO_LIVE_CHAOS_SCENARIOS
      .filter((scenario) => scenario !== DOJO_LIVE_CHAOS_SCENARIOS[0]);
    liveChaosGate.enterprise_artifact_requirements.require_live_scenarios_included = false;
    liveChaosGate.enterprise_artifact_requirements.require_all_live_scenarios_passed = false;
    liveChaosGate.enterprise_artifact_requirements.require_command_digest_evidence = false;
    liveChaosGate.enterprise_artifact_requirements.section_enterprise_verifier = {
      flag: "--wrong-live-chaos-enterprise-flag",
      report_arg: "--wrong-live-chaos-report",
      default_report_path: "tmp/wrong-live-chaos-report.json",
      command: "node mcp/synthi-mcp/scripts/dojo-release-gate-verify.mjs",
    };
    expect(validateDojoReleaseGateManifest(brokenLiveChaos, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "live_chaos_missing_enterprise_release_requirement",
      "live_chaos_missing_default_report_path",
      `live_chaos_missing_required_env:${DOJO_LIVE_CHAOS_COMMAND_ENVS[0]}`,
      "live_chaos_missing_explicit_enable_env_requirement",
      `live_chaos_missing_required_scenarios:${DOJO_LIVE_CHAOS_SCENARIOS[0]}`,
      "live_chaos_missing_included_requirement",
      "live_chaos_missing_all_passed_requirement",
      "live_chaos_missing_command_digest_requirement",
      "live_chaos_missing_section_enterprise_verifier_flag",
      "live_chaos_missing_section_enterprise_verifier_report_arg",
      "live_chaos_section_enterprise_verifier_report_path_mismatch",
      "live_chaos_missing_section_enterprise_verifier_out_dir",
      "live_chaos_missing_section_enterprise_verifier_command",
    ]));

    const brokenDojoSoak = JSON.parse(JSON.stringify(manifest));
    const dojoSoakGate = brokenDojoSoak.gates.find((gate) => gate.id === "dojo_soak_performance_self_check");
    const missingDojoSoakTestFile = DOJO_SOAK_PERFORMANCE_TEST_FILES[0];
    dojoSoakGate.enterprise_artifact_requirements.required_operation_classes = DOJO_SOAK_PERFORMANCE_OPERATION_CLASSES
      .filter((operation) => operation !== "proof_validation");
    dojoSoakGate.enterprise_artifact_requirements.required_test_files = DOJO_SOAK_PERFORMANCE_TEST_FILES
      .filter((file) => file !== missingDojoSoakTestFile);
    dojoSoakGate.enterprise_artifact_requirements.required_dojo_soak_metrics = DOJO_SOAK_PERFORMANCE_REQUIRED_METRICS
      .filter((metric) => metric !== "proof_validation_p95_ms");
    dojoSoakGate.enterprise_artifact_requirements.require_no_failed_operation_events = false;
    dojoSoakGate.enterprise_artifact_requirements.require_dojo_soak_metrics = false;
    dojoSoakGate.enterprise_artifact_requirements.require_event_digest_match = false;
    dojoSoakGate.enterprise_artifact_requirements.section_enterprise_verifier = {
      flag: "--wrong-dojo-soak-enterprise-flag",
      evidence_arg: "--wrong-dojo-soak-evidence",
      default_evidence_path: "tmp/wrong-dojo-soak-evidence.json",
      command: "node mcp/synthi-mcp/scripts/dojo-release-gate-verify.mjs",
    };
    expect(validateDojoReleaseGateManifest(brokenDojoSoak, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "dojo_soak_performance_missing_required_operation_classes:proof_validation",
      `dojo_soak_performance_missing_required_test_files:${missingDojoSoakTestFile}`,
      "dojo_soak_performance_missing_no_failed_operation_events_requirement",
      "dojo_soak_performance_missing_dojo_soak_metrics_requirement",
      "dojo_soak_performance_missing_required_dojo_soak_metrics:proof_validation_p95_ms",
      "dojo_soak_performance_missing_event_digest_requirement",
      "dojo_soak_performance_missing_section_enterprise_verifier_flag",
      "dojo_soak_performance_missing_section_enterprise_verifier_evidence_arg",
      "dojo_soak_performance_section_enterprise_verifier_evidence_path_mismatch",
      "dojo_soak_performance_missing_section_enterprise_verifier_out_dir",
      "dojo_soak_performance_missing_section_enterprise_verifier_command",
    ]));

    const brokenSoak = JSON.parse(JSON.stringify(manifest));
    const soakGate = brokenSoak.gates.find((gate) => gate.id === "soak_performance");
    soakGate.requires_env = ["SYNTHI_SESSION_ID"];
    soakGate.env_value_requirements = [{
      env: "SOAK_DURATION_MIN",
      type: "string",
      min: 10,
    }];
    soakGate.enterprise_artifact_requirements.require_live_session_env = "";
    soakGate.enterprise_artifact_requirements.require_duration_env = "";
    soakGate.enterprise_artifact_requirements.require_duration_env_min_minutes = 10;
    soakGate.enterprise_artifact_requirements.require_zero_errors = false;
    soakGate.enterprise_artifact_requirements.require_tool_latency_metrics = false;
    soakGate.enterprise_artifact_requirements.section_enterprise_verifier = {
      flag: "--wrong-soak-enterprise-flag",
      summary_arg: "--wrong-soak-summary",
      events_arg: "--wrong-soak-events",
      default_summary_path: "tmp/wrong-soak-summary.json",
      default_events_path: "tmp/wrong-soak-events.ndjson",
      command: "node mcp/synthi-mcp/scripts/dojo-release-gate-verify.mjs",
    };
    expect(validateDojoReleaseGateManifest(brokenSoak, { packageScripts: PACKAGE_SCRIPTS }).errors).toEqual(expect.arrayContaining([
      "soak_performance_missing_required_env:SOAK_DURATION_MIN",
      "soak_performance_duration_env_value_requirement_not_numeric",
      "soak_performance_duration_env_value_min_too_low",
      "soak_performance_missing_live_session_env_requirement",
      "soak_performance_missing_duration_env_requirement",
      "soak_performance_duration_env_min_too_low",
      "soak_performance_missing_zero_error_requirement",
      "soak_performance_missing_tool_latency_requirement",
      "soak_performance_missing_section_enterprise_verifier_flag",
      "soak_performance_missing_section_enterprise_verifier_summary_arg",
      "soak_performance_missing_section_enterprise_verifier_events_arg",
      "soak_performance_section_enterprise_verifier_summary_path_mismatch",
      "soak_performance_section_enterprise_verifier_events_path_mismatch",
      "soak_performance_missing_section_enterprise_verifier_out_dir",
      "soak_performance_missing_section_enterprise_verifier_command",
    ]));
  });

  it("keeps live, deployed, security, and soak gates out of the minimal PR gate", () => {
    const manifest = buildDojoReleaseGateManifest({
      generatedAt: "2026-06-11T00:00:00.000Z",
      packageScripts: PACKAGE_SCRIPTS,
    });
    const gatesById = new Map(manifest.gates.map((gate) => [gate.id, gate]));

    expect(new Set(manifest.minimal_pr_gate_ids.map((id) => gatesById.get(id)?.tier))).toEqual(new Set(["T0", "T1"]));
    expect(manifest.minimal_pr_gate_ids).not.toContain("dojo_mcp_host_conformance");
    expect(manifest.minimal_pr_gate_ids).not.toContain("dojo_live_chaos");
    expect(manifest.minimal_pr_gate_ids).not.toContain("dojo_soak_performance_self_check");
    expect(manifest.minimal_pr_gate_ids).not.toContain("soak_performance");
    expect(manifest.release_gate_ids).toEqual(expect.arrayContaining([
      "dojo_implementation_status_self_check",
      "dojo_release_gate_runner_self_check",
      "dojo_release_gate_verifier_self_check",
      "workflow_e2e_hosted",
      "dojo_mcp_host_conformance",
      "dojo_generated_pr_self_check",
      "dojo_mcp_skill_bus_self_check",
      "dojo_managed_key_signing_self_check",
      "dojo_public_proof_verification_self_check",
      "dojo_governance_lifecycle_self_check",
      "dojo_graph_runtime_self_check",
      "dojo_ghost_mode_evidence_self_check",
      "dojo_skill_passport_self_check",
      "dojo_time_machine_debugger_self_check",
      "dojo_vivarium_runtime_self_check",
      "dojo_checkride_license_self_check",
      "dojo_case_law_runtime_self_check",
      "dojo_hosted_runtime_gateway_self_check",
      "security_abuse_suite",
      "compliance_export_suite",
      "privacy_redaction_suite",
    ]));
    expect(manifest.release_gate_ids).not.toContain("dojo_live_chaos");
    expect(manifest.release_gate_ids).not.toContain("dojo_soak_performance_self_check");
    expect(manifest.release_gate_ids).not.toContain("soak_performance");
    expect(manifest.enterprise_release_gate_ids).toEqual(expect.arrayContaining([
      ...manifest.release_gate_ids,
      "dojo_chaos_performance_self_check",
      "dojo_live_chaos",
      "dojo_soak_performance_self_check",
      "soak_performance",
    ]));
  });

  it("builds digest evidence for the emitted manifest", () => {
    const manifest = buildDojoReleaseGateManifest({
      generatedAt: "2026-06-11T00:00:00.000Z",
      packageScripts: PACKAGE_SCRIPTS,
    });
    const serialized = JSON.stringify(manifest, null, 2);
    const evidence = buildDojoReleaseGateEvidenceManifest({
      manifest,
      manifestPath: "/tmp/dojo-release-gate-manifest.json",
      serialized,
    });

    expect(evidence).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.releaseGateEvidence.v1",
      manifest_path: "/tmp/dojo-release-gate-manifest.json",
      manifest_bytes: Buffer.byteLength(serialized),
      validation_ok: true,
      tier_count: 9,
      gate_count: manifest.gates.length,
      minimal_pr_gate_count: manifest.minimal_pr_gate_ids.length,
      milestone_gate_count: manifest.milestone_gate_ids.length,
      release_gate_count: manifest.release_gate_ids.length,
      enterprise_release_gate_count: manifest.enterprise_release_gate_ids.length,
      visual_report_gate_count: 2,
      visual_report_gate_ids: ["dojo_full_visual_proof", "dojo_ghost_mode_visual_proof"],
      proof_artifact_gate_count: 34,
      proof_artifact_gate_ids: expect.arrayContaining([
        "dojo_implementation_status_self_check",
        "dojo_release_gate_runner_self_check",
        "dojo_release_gate_verifier_self_check",
        "dojo_package_readiness_self_check",
        "dojo_self_check",
        "dojo_postgres_control_plane_self_check",
        "dojo_evidence_authority_self_check",
        "dojo_mcp_host_conformance_self_check",
        "dojo_source_drift_self_check",
        "dojo_agent_ready_ui_contract_self_check",
        "dojo_api_tool_compiler_self_check",
        "docker_integration",
        "workflow_e2e_hosted",
        "dojo_mcp_host_conformance",
        "dojo_generated_pr_self_check",
        "dojo_mcp_skill_bus_self_check",
        "dojo_managed_key_signing_self_check",
        "dojo_public_proof_verification_self_check",
        "dojo_governance_lifecycle_self_check",
        "dojo_graph_runtime_self_check",
        "dojo_ghost_mode_evidence_self_check",
        "dojo_skill_passport_self_check",
        "dojo_time_machine_debugger_self_check",
        "dojo_vivarium_runtime_self_check",
        "dojo_checkride_license_self_check",
        "dojo_case_law_runtime_self_check",
        "dojo_hosted_runtime_gateway_self_check",
        "compliance_export_suite",
        "privacy_redaction_suite",
      ]),
    }));
    expect(evidence.manifest_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("validates visual proof reports against pixel and layout evidence requirements", () => {
    const manifest = buildDojoReleaseGateManifest({
      generatedAt: "2026-06-11T00:00:00.000Z",
      packageScripts: PACKAGE_SCRIPTS,
    });
    const gate = manifest.gates.find((item) => item.id === "dojo_full_visual_proof");
    const validReport = buildFullVisualReportFixture();

    expect(validateDojoVisualProofReport(validReport, { gate })).toEqual(expect.objectContaining({
      ok: true,
      errors: [],
      result_count: DOJO_FULL_VISUAL_ROUTE_IDS.length * DOJO_FULL_VISUAL_VIEWPORTS.length,
    }));

    const rejectedReport = {
      ...validReport,
      ok: false,
      results: [
        {
          ...validReport.results[0],
          ok: false,
          failed_visual_gates: ["horizontal_overflow"],
          image_metrics: { pixel_metrics_verified: false },
          layout_metrics: { horizontal_overflow_px: 125 },
        },
        ...validReport.results.slice(2),
      ],
      screenshots: validReport.screenshots.slice(0, -1),
      screenshot_count: validReport.results.length - 1,
    };

    expect(validateDojoVisualProofReport(rejectedReport, { gate }).errors).toEqual(expect.arrayContaining([
      "visual_report_not_ok",
      "visual_report_result_count_below_minimum:19:20",
      "visual_report_missing_required_route_viewport:dojo-shell:mobile",
      "visual_result_not_ok:dojo-shell:desktop",
      "visual_result_failed_gates:dojo-shell:desktop:horizontal_overflow",
      "visual_result_pixel_metrics_unverified:dojo-shell:desktop",
      "visual_result_horizontal_overflow:dojo-shell:desktop:125",
    ]));

    const missingRouteReport = buildFullVisualReportFixture({
      omit: ({ routeId, viewport }) => routeId === "evidence" && viewport === "mobile",
    });
    expect(validateDojoVisualProofReport(missingRouteReport, { gate }).errors).toEqual(expect.arrayContaining([
      "visual_report_result_count_below_minimum:19:20",
      "visual_report_missing_required_route_viewport:evidence:mobile",
    ]));

    const ghostGate = manifest.gates.find((item) => item.id === "dojo_ghost_mode_visual_proof");
    const ghostReport = buildGhostModeVisualReportFixture();
    expect(validateDojoVisualProofReport(ghostReport, { gate: ghostGate })).toEqual(expect.objectContaining({
      ok: true,
      errors: [],
      result_count: DOJO_GHOST_MODE_VISUAL_ROUTE_IDS.length * DOJO_GHOST_MODE_VISUAL_VIEWPORTS.length,
    }));

    const missingGhostMobile = buildGhostModeVisualReportFixture({
      omit: ({ viewport }) => viewport === "mobile",
    });
    expect(validateDojoVisualProofReport(missingGhostMobile, { gate: ghostGate }).errors).toEqual(expect.arrayContaining([
      "visual_report_result_count_below_minimum:1:2",
      "visual_report_missing_required_viewport:mobile",
      "visual_report_missing_required_route_viewport:time-machine:mobile",
    ]));
  });
});

function buildFullVisualReportFixture({ omit = () => false } = {}) {
  const results = [];
  for (const routeId of DOJO_FULL_VISUAL_ROUTE_IDS) {
    for (const viewport of DOJO_FULL_VISUAL_VIEWPORTS) {
      if (omit({ routeId, viewport })) continue;
      results.push({
        route_id: routeId,
        viewport,
        ok: true,
        failed_visual_gates: [],
        screenshot_path: `/tmp/${routeId}-${viewport}.png`,
        bytes: 120_000,
        image_metrics: {
          pixel_metrics_verified: true,
          unique_color_sample_count: 96,
          background_diff_pixel_ratio: 0.41,
          luma_stddev: 22,
        },
        layout_metrics: {
          horizontal_overflow_px: 0,
          selector_visible_area_px: 468_000,
        },
        screenshot_sha256: "0".repeat(64),
      });
    }
  }
  return {
    schema_version: "synthi.dojo.visualProof.v1",
    ok: true,
    route_count: DOJO_FULL_VISUAL_ROUTE_IDS.length,
    screenshot_count: results.length,
    screenshots: results.map((result) => result.screenshot_path),
    results,
  };
}

function buildGhostModeVisualReportFixture({ omit = () => false } = {}) {
  const results = [];
  for (const routeId of DOJO_GHOST_MODE_VISUAL_ROUTE_IDS) {
    for (const viewport of DOJO_GHOST_MODE_VISUAL_VIEWPORTS) {
      if (omit({ routeId, viewport })) continue;
      results.push({
        route_id: routeId,
        viewport_name: viewport,
        viewport: viewport === "desktop"
          ? { width: 1440, height: 1100 }
          : { width: 390, height: 1200 },
        ok: true,
        failed_visual_gates: [],
        screenshot_path: `/tmp/${routeId}-${viewport}.png`,
        bytes: 120_000,
        image_metrics: {
          pixel_metrics_verified: true,
          unique_color_sample_count: 96,
          background_diff_pixel_ratio: 0.41,
          luma_stddev: 22,
        },
        layout_metrics: {
          horizontal_overflow_px: 0,
          selector_visible_area_px: 468_000,
        },
        screenshot_sha256: "1".repeat(64),
      });
    }
  }
  return {
    schema_version: "synthi.dojo.ghostModeVisualProof.v1",
    ok: true,
    route_id: DOJO_GHOST_MODE_VISUAL_ROUTE_IDS[0],
    route_count: DOJO_GHOST_MODE_VISUAL_ROUTE_IDS.length,
    screenshot_count: results.length,
    screenshots: results.map((result) => result.screenshot_path),
    results,
  };
}
