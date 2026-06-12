#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import http from "node:http";
import net from "node:net";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SYNTHI_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(SYNTHI_ROOT, "..");
const MCP_ROOT = path.join(REPO_ROOT, "mcp", "synthi-mcp");
const requireFromMcp = createRequire(path.join(MCP_ROOT, "package.json"));
const { chromium } = requireFromMcp("playwright");

const args = parseArgs(process.argv.slice(2));
const OUT_DIR = path.resolve(args["out-dir"] || path.join(SYNTHI_ROOT, "tmp", "dojo-visual-proof"));
const HOST = "127.0.0.1";
const BASE_PORT = Number(args.port || process.env.SYNTHI_DOJO_VISUAL_PORT || 3116);
const WORKSPACE_SLUG = "visual-dojo";
const SKILL_ID = "dojo_save_invoice";

const DEV_OVERLAY_CSS = `
nextjs-portal,
[data-nextjs-toast],
[data-nextjs-dialog-overlay],
[data-nextjs-dev-overlay],
.nextjs-toast,
.nextjs-static-indicator-toast-wrapper,
.nextjs-dev-tools-indicator {
  display: none !important;
  visibility: hidden !important;
  pointer-events: none !important;
}
`;

const ROUTES = [
  {
    id: "dojo-shell",
    path: `/workspace/${WORKSPACE_SLUG}/dojo`,
    selector: "[data-testid=\"dojo-shell\"]",
    requiredText: ["Agent Dojo", "Save invoice", "synthi_app_save_invoice"],
  },
  {
    id: "skill-cards",
    path: `/workspace/${WORKSPACE_SLUG}/dojo/skills`,
    selector: "[data-testid=\"skill-card-grid\"]",
    requiredText: ["Skill Cards", "Save invoice", "Passport", "Cortex"],
  },
  {
    id: "skill-passport",
    path: `/workspace/${WORKSPACE_SLUG}/dojo/skills/${SKILL_ID}/passport`,
    selector: "[data-testid=\"skill-passport\"]",
    requiredText: ["Skill Passport", "Allowed Alone", "capsule-visual-001", "CASE-DUPLICATE-CLIENT"],
  },
  {
    id: "skill-cortex",
    path: `/workspace/${WORKSPACE_SLUG}/dojo/skills/${SKILL_ID}/cortex`,
    selector: "[data-testid=\"skill-cortex-view\"]",
    requiredText: ["Skill Cortex", "E3 license", "Validate proof capsule", "Submit invoice"],
  },
  {
    id: "practice-world",
    path: `/workspace/${WORKSPACE_SLUG}/dojo/practice`,
    selector: "[data-testid=\"dojo-practice-world\"]",
    requiredText: ["Practice World", "Duplicate client names", "Fake success toast", "Stable ID guardrail"],
  },
  {
    id: "source-api",
    path: `/workspace/${WORKSPACE_SLUG}/dojo/source`,
    selector: "[data-testid=\"dojo-source-api\"]",
    requiredText: ["Source/API Graduation", "Agent-Ready UI Contract", "POST /api/invoices", "synthi_api_submit_invoice"],
  },
  {
    id: "evidence",
    path: `/workspace/${WORKSPACE_SLUG}/dojo/evidence`,
    selector: "[data-testid=\"dojo-evidence-dashboard\"]",
    requiredText: ["Evidence Custody", "ledger-visual-001", "claim-workspace-verified", "redacted-export-001"],
  },
  {
    id: "case-law",
    path: `/workspace/${WORKSPACE_SLUG}/dojo/case-law`,
    selector: "[data-testid=\"dojo-case-law-dashboard\"]",
    requiredText: ["Case Law", "Duplicate client names require stable ID", "Stable ID guardrail", "antibody-stable-id"],
  },
  {
    id: "governance",
    path: `/workspace/${WORKSPACE_SLUG}/dojo/governance`,
    selector: "[data-testid=\"governance-dashboard\"]",
    requiredText: ["Governance", "License and proof audit", "Issue verified proof capsule", "deployed_host_conformance", "Approve", "Deprecate", "Revoke license"],
  },
  {
    id: "time-machine",
    path: `/workspace/${WORKSPACE_SLUG}/dojo/debug/time-machine`,
    selector: "[data-testid=\"dojo-time-machine\"]",
    requiredText: ["Time Machine Debugger", "Shadow Evidence", "ghost-evidence-visual-001", "Would Execute"],
  },
];

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 1100 },
  { name: "mobile", width: 390, height: 1200 },
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const port = await findAvailablePort(BASE_PORT);
  const server = await startDevServer({ port });
  try {
    const browser = await chromium.launch({ headless: true });
    try {
      const results = [];
      for (const route of ROUTES) {
        for (const viewport of VIEWPORTS) {
          results.push(await captureRoute({ browser, port, route, viewport }));
        }
      }
      const report = {
        schema_version: "synthi.dojo.visualProof.v1",
        ok: results.every((result) => result.ok),
        generated_at: new Date().toISOString(),
        base_url: `http://${HOST}:${port}`,
        workspace_slug: WORKSPACE_SLUG,
        route_count: ROUTES.length,
        screenshot_count: results.length,
        screenshots: results.map((result) => result.screenshot_path),
        results,
      };
      const reportPath = path.join(OUT_DIR, "visual-proof.json");
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      console.log(JSON.stringify({ ok: report.ok, report_path: reportPath, screenshots: report.screenshots }, null, 2));
      if (!report.ok) process.exitCode = 1;
    } finally {
      await browser.close();
    }
  } finally {
    stopDevServer(server);
  }
}

async function captureRoute({ browser, port, route, viewport }) {
  const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
  try {
    await page.route("**/browser-workflows/state", (requestRoute) => requestRoute.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(buildBridgeState()),
    }));
    await page.goto(`http://${HOST}:${port}${route.path}`, { waitUntil: "networkidle" });
    await page.addStyleTag({ content: DEV_OVERLAY_CSS });
    await page.waitForSelector(route.selector, { timeout: 20_000 });
    const text = await page.locator(route.selector).innerText({ timeout: 10_000 });
    const checks = Object.fromEntries(
      route.requiredText.map((required) => [`text:${required}`, text.includes(required)])
    );
    const screenshotPath = path.join(OUT_DIR, `${route.id}-${viewport.name}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const stats = await stat(screenshotPath);
    return {
      route_id: route.id,
      viewport: viewport.name,
      ok: Object.values(checks).every(Boolean) && stats.size > 10_000,
      url: `http://${HOST}:${port}${route.path}`,
      selector: route.selector,
      checks,
      screenshot_path: screenshotPath,
      bytes: stats.size,
    };
  } finally {
    await page.close();
  }
}

function buildBridgeState() {
  const now = "2026-06-12T04:00:00.000Z";
  return {
    state: {
      workspaceSlug: WORKSPACE_SLUG,
      status: "ready",
      runtime: { status: "ready" },
      dojo: {
        skill_id: SKILL_ID,
        label: "Save invoice",
        status: "licensed",
        entrustment_level: "E3",
        readiness_level: 7,
        scenario_count: 3,
        artifact_count: 47,
        published: true,
        published_tool_name: "synthi_app_save_invoice",
        proof_required: true,
        skillCard: {
          title: "Save invoice",
          canDoAlone: ["Open invoice draft", "Validate totals", "Attach receipt"],
          willAskBefore: ["Submit invoice", "Change payment terms"],
          willNotDo: ["Delete invoice", "Submit duplicate client without stable ID"],
        },
        license_id: "license-save-invoice",
        license: {
          license_id: "license-save-invoice",
          allowed_actions: ["open_invoice", "validate_totals", "attach_receipt"],
          gated_actions: ["submit_invoice"],
          blocked_actions: ["delete_invoice", "submit_duplicate_client"],
          blocked_contexts: ["duplicate_client_without_stable_id"],
          required_proof_claims: ["workspace_verified", "guardrails_active", "evidence_fresh"],
          expires_at: "2026-07-12T04:00:00.000Z",
          days_until_expiry: 30,
          expiry_policy: "recertify_on_source_drift_or_case_law_change",
        },
        lifecycle: {
          status: "licensed",
          expires_at: "2026-07-12T04:00:00.000Z",
          days_until_expiry: 30,
          expiry_policy: "recertify_on_source_drift_or_case_law_change",
          entrustment_history: [
            { label: "Seed extracted", level: "E1", at: "2026-06-10T10:00:00.000Z" },
            { label: "Evidence-backed checkride passed", level: "E3", at: now },
          ],
        },
        checkride: {
          coverage_score: 0.86,
          critical_failures: 0,
          blocked_scenarios: 1,
        },
        proof: {
          capsule_id: "capsule-visual-001",
          status: "issued",
          requested_action: "submit_invoice",
          issuer: "dojo-proof-service",
          key_id: "dojo-ed25519-visual",
          nonce: "nonce-visual-001",
          issued_at: now,
          expires_at: "2026-06-12T05:00:00.000Z",
          signature_algorithm: "ed25519",
          substrate_claim: "mcp",
          evidence_record_ids: ["ev-checkride-001", "ev-guardrail-001"],
          guardrails_active: ["guard-stable-id"],
          evidence_claims: [
            { claim_id: "workspace_verified", status: "verified", evidence_record_id: "ev-workspace-001" },
            { claim_id: "guardrails_active", status: "verified", evidence_record_id: "ev-guardrail-001" },
            { claim_id: "evidence_fresh", status: "verified", evidence_record_id: "ev-checkride-001" },
          ],
          validation: {
            status: "valid",
            blocked_by: [],
            error_codes: [],
            timeline: [
              { label: "Signature verified", status: "passed", at: now },
              { label: "Nonce unused", status: "passed", at: now },
            ],
          },
        },
        blockExplanation: {
          status: "blocked",
          refusal: "A proof capsule is required before submitting this invoice.",
          blocked_by: ["proof_capsule_missing", "client_id_verified == true"],
          error_codes: ["proof_capsule_missing"],
          refusal_explanation: {
            blocked_action: "submit_invoice",
            rule: "Provide a valid proof capsule.",
            smallest_allowed_next_step: "Issue proof before submit_invoice.",
            evidence_refs: ["ev-proof-001"],
            case_law_citations: [
              { case_id: "CASE-DUPLICATE-CLIENT", title: "Duplicate client names require stable ID" },
            ],
          },
        },
        permissionUpgrade: {
          required_steps: ["Issue a fresh proof capsule", "Ask a reviewer to resolve duplicate client identity"],
        },
        skill_cortex: {
          schema_version: "synthi.dojo.skillCortex.v1",
          nodes: [
            { node_id: "trigger", kind: "Trigger", label: "MCP skill call", outputs: ["permission"], risk: "safe" },
            { node_id: "permission", kind: "Permission", label: "E3 license", inputs: ["trigger"], outputs: ["proof"], risk: "safe", guardrail_refs: ["guard-stable-id"] },
            { node_id: "proof", kind: "Proof", label: "Validate proof capsule", inputs: ["permission"], outputs: ["action-submit"], metadata: { evidence_claims: ["workspace_verified", "guardrails_active"] } },
            { node_id: "action-submit", kind: "Action", label: "Submit invoice", risk: "dangerous", substrate: "mcp", inputs: ["proof"], outputs: ["assert-submit"], guardrail_refs: ["guard-stable-id"], case_refs: ["CASE-DUPLICATE-CLIENT"], memory: { confidence: 0.91 } },
            { node_id: "assert-submit", kind: "Assertion", label: "Verify invoice submitted", inputs: ["action-submit"], outputs: ["rollback"], assertions: ["API state confirms submitted invoice"] },
            { node_id: "rollback", kind: "Rollback", label: "Draft restore or human review", inputs: ["assert-submit"], outputs: [], risk: "safe" },
          ],
          edges: [
            { edge_id: "edge-1", from_node_id: "trigger", to_node_id: "permission", condition: "skill_selected", confidence: 1 },
            { edge_id: "edge-2", from_node_id: "permission", to_node_id: "proof", condition: "license_allowed", confidence: 1 },
            { edge_id: "edge-3", from_node_id: "proof", to_node_id: "action-submit", condition: "proof_valid", confidence: 1 },
            { edge_id: "edge-4", from_node_id: "action-submit", to_node_id: "assert-submit", condition: "mutation_observed", confidence: 0.94 },
            { edge_id: "edge-5", from_node_id: "assert-submit", to_node_id: "rollback", condition: "assertion_failed", confidence: 0.82 },
          ],
        },
        scenarios: [
          { scenario_id: "scenario-duplicate-client", title: "Duplicate client names", mutation_kind: "duplicate_entity", expected_behavior: "Block and ask for stable ID", risk_tags: ["identity", "duplicate"], status: "blocked" },
          { scenario_id: "scenario-fake-success", title: "Fake success toast", mutation_kind: "fake_success", expected_behavior: "Verify API state", risk_tags: ["assertion"], status: "failed" },
          { scenario_id: "scenario-auth-expiry", title: "Auth expires mid-run", mutation_kind: "auth_expiry", expected_behavior: "Stop safely", risk_tags: ["auth"], status: "passed" },
        ],
        workspaceOrganoid: {
          synthetic_data_only: true,
          fixture_seed: "dojo-visual-seed-001",
          tissues: {
            data: { duplicate_entities: true },
            ui: { moved_button: true },
            api: { fake_success: true },
            identity: { auth_expiry: true },
          },
          data_policy: { synthetic_data_only: true, production_data_refs_allowed: false },
        },
        vivariumRun: {
          run_id: "scenario-run-001",
          scenario_id: "scenario-duplicate-client",
          mutation_kind: "duplicate_entity",
          status: "blocked",
          finding: "Stable ID guardrail blocked duplicate display-name submission.",
          guardrails_triggered: ["guard-stable-id"],
          evidence_refs: ["dojo-graph://scenario-run-001/action", "dojo-oracle://scenario-run-001/oracle"],
          fixture_materialization_hash: "sha256:visualfixture",
        },
        windTunnel: {
          run_count: 3,
          pass_count: 1,
          fail_count: 1,
          blocked_count: 1,
          stop_reason: "budget_exhausted",
          budget: { max_runs: 3, max_cost_usd: 1 },
          runs: [
            { run_id: "wind-run-001", scenario_id: "scenario-duplicate-client", mutation_kind: "duplicate_entity", status: "blocked", finding: "Stable ID guardrail blocked unsafe submission.", evidence_refs: ["dojo-graph://wind-run-001/action"] },
            { run_id: "wind-run-002", scenario_id: "scenario-fake-success", mutation_kind: "fake_success", status: "failed", finding: "API state assertion detected fake success toast.", evidence_refs: ["dojo-oracle://wind-run-002/oracle"] },
            { run_id: "wind-run-003", scenario_id: "scenario-auth-expiry", mutation_kind: "auth_expiry", status: "passed", finding: "Expired session stopped before mutation.", evidence_refs: ["dojo-auth://wind-run-003"] },
          ],
        },
        sourcePrPlan: {
          plan_id: "source-pr-visual-001",
          readiness: "review_required",
          patch_count: 2,
          files: [
            { path: "src/components/InvoiceSubmit.jsx", purpose: "Add stable affordance and proof hook.", patch_type: "agent_ready_ui_contract", proof_hook: "data-synthi-proof-required=\"true\"" },
          ],
          generated_tests: [
            { path: ".synthi/dojo/playwright/save-invoice.spec.ts", purpose: "Verify affordance reachability." },
          ],
          review_checklist: ["Confirm every risky action has a proof hook."],
        },
        agentReadyUiContract: {
          contract_id: "ui-contract-save-invoice",
          target_origin: "https://billing.example.test",
          actions: [
            {
              action_id: "submit-invoice",
              label: "Submit invoice",
              stable_locator: "[data-synthi-action=\"submit-invoice\"]",
              source_anchor_id: "source-token-submit-invoice",
              success_condition: "invoice.status == submitted",
              allowed_substrate: ["source", "api", "mcp"],
              proof_claims: ["workspace_verified"],
              risk_tags: ["mutation", "payment"],
            },
          ],
        },
        apiCandidates: [
          {
            candidate_id: "api-submit-invoice",
            method: "POST",
            path: "/api/invoices",
            status: "review_required",
            auth_scope: "invoice.write",
            mutation_class: "submit",
            idempotency: "idempotency_key",
            rollback_strategy: "restore_draft",
            postcondition: "invoice.status == submitted",
            proof_claim_mapping: { workspace_verified: "workspace_id" },
          },
        ],
        generatedTools: [
          {
            tool_name: "synthi_api_submit_invoice",
            status: "draft",
            proof_required: true,
            license_id: "license-save-invoice",
            schema_digest: "sha256:visual-tool",
            evidence_policy: ["append_evidence_record"],
          },
        ],
        substrateNodes: [
          { node_id: "action-submit", label: "Submit invoice", current_substrate: "dom", preferred_substrate: "api", status: "review_required", proof_required: true },
          { node_id: "assert-submit", label: "Verify submitted state", current_substrate: "api", preferred_substrate: "api", status: "approved", proof_required: false },
        ],
        evidenceLedger: {
          ledger_id: "ledger-visual-001",
          head_hash: "sha256:visual-ledger-head",
          records: [
            { record_id: "ev-checkride-001", kind: "checkride", artifact_uri: "dojo-artifact://save-invoice/checkride.report.md", artifact_sha256: "sha256:checkride", redaction_manifest_sha256: "sha256:redaction", claim_ids: ["claim-workspace-verified"], created_at: now },
            { record_id: "ev-guardrail-001", kind: "guardrail", artifact_uri: "dojo-artifact://save-invoice/guardrails.json", artifact_sha256: "sha256:guardrail", redaction_manifest_sha256: "sha256:redaction", claim_ids: ["claim-guardrails-active"], created_at: now },
          ],
          storage_model: { append_only: true, tamper_evident: true, screenshots_redacted_by_default: true },
          retention_policy: { retention_class: "standard", legal_hold: false },
        },
        redactedEvidenceExportManifest: {
          manifest_id: "redacted-export-001",
          artifacts: [
            {
              artifact_id: "artifact-checkride",
              artifact_kind: "checkride",
              artifact_uri: "dojo-artifact://save-invoice/checkride.report.md",
              redaction_count: 3,
              redaction_manifest_sha256: "sha256:checkride-redaction",
              rules_applied: ["auth_tokens", "email_addresses", "screenshot_regions"],
              source_refs: ["ev-checkride-001"],
            },
            {
              artifact_id: "artifact-ledger",
              artifact_kind: "ledger_manifest",
              artifact_uri: "dojo-artifact://save-invoice/evidence-ledger.json",
              redaction_count: 2,
              redaction_manifest_sha256: "sha256:ledger-redaction",
              rules_applied: ["artifact_uri", "trace_payload"],
              source_refs: ["ev-guardrail-001"],
            },
          ],
          excluded: ["raw_screenshots", "secrets"],
          redaction_count: 5,
        },
        evidenceClaims: [
          { claim_id: "claim-workspace-verified", status: "verified", evidence_record_id: "ev-checkride-001", checked_at: now },
          { claim_id: "claim-guardrails-active", status: "verified", evidence_record_id: "ev-guardrail-001", checked_at: now },
        ],
        caseLawRecords: [
          {
            case_id: "CASE-DUPLICATE-CLIENT",
            title: "Duplicate client names require stable ID",
            finding: "Display names are not unique identifiers.",
            impact: "Blocks invoice submission until stable ID evidence exists.",
            rule_created: "client_id_verified == true",
            status: "approved",
            binding_scope: "workspace",
            evidence_refs: ["ev-checkride-001"],
            created_at: now,
          },
        ],
        guardrails: [
          { guardrail_id: "guard-stable-id", title: "Stable ID guardrail", rule: "client_id_verified == true", blocks_actions: ["submit_invoice"], source_case_id: "CASE-DUPLICATE-CLIENT", severity: "critical", evidence_refs: ["ev-guardrail-001"] },
        ],
        antibodies: [
          { antibody_id: "antibody-stable-id", case_id: "CASE-DUPLICATE-CLIENT", guardrail_id: "guard-stable-id", trigger: "duplicate_display_name", response: "require_stable_id", applies_to: ["invoice", "client"], binding_scope: "organization", evidence_refs: ["ev-guardrail-001"], created_at: now },
        ],
        time_machine_debugger: {
          debug_id: "time-machine-visual-001",
          question: "What if stable entity identity changes?",
          baseline: {
            scenario_id: "scenario-duplicate-client",
            mutation_kind: "duplicate_entity",
            status: "failed",
            finding: "Duplicate display name was selected.",
          },
          counterfactual: {
            changed_variable: "stable_entity_identity",
            expected_status_after_change: "blocked",
            causal_finding: "Changing stable identity invalidates the current license branch.",
            license_impact: "Keep the skill at E2 until recertification passes.",
          },
          guardrails: [
            { guardrail_id: "guard-stable-id", title: "Stable ID required", rule: "client_id_verified == true", severity: "critical" },
          ],
          replay_plan: [
            { step: "replay_static_trace", simulator_tier: 0, expected_evidence: ["workflow:save-invoice"] },
            { step: "rerun_checkride_branch", simulator_tier: 2, expected_evidence: ["checkride:save-invoice"] },
          ],
        },
        ghost_run: {
          run_id: "ghost-visual-001",
          status: "mismatch",
          would_execute: false,
          production_mutations_executed: false,
          license_status: "blocked",
          shadow_evidence_id: "ghost-evidence-visual-001",
          evidence_refs: ["skill:dojo_save_invoice", "ghost:ghost-visual-001", "guardrail:guard-stable-id"],
          entrustment_impact: {
            upgrade_allowed: false,
            recommended_entrustment: "EX",
            reason: "Ghost Mode mismatch prevents entrustment upgrade until the planned action is recertified.",
          },
          observed_human_action: { action: "click", label: "Save invoice", selector: "button[name=Save]" },
          agent_planned_action: { action: "click", label: "Submit invoice", selector: "button[name=Submit]" },
          guardrails_triggered: ["guard-stable-id"],
          explanation: "Ghost mode found a mismatch and did not execute production mutations.",
        },
      },
      governanceService: {
        metrics: {
          skill_count: 1,
          active_license_count: 1,
          expired_license_count: 0,
          pending_approval_count: 1,
          case_law_review_count: 1,
          policy_gate_count: 1,
          recertification_count: 1,
          compliance_artifact_count: 2,
        },
        license_health: [
          { skill_id: SKILL_ID, skill_name: "Save invoice", workspace_id: WORKSPACE_SLUG, license_id: "license-save-invoice", status: "active", entrustment_level: "E3", readiness_level: 7, proof_required: true, allowed_action_count: 3, gated_action_count: 1, blocked_action_count: 2 },
        ],
        approval_queue: [
          { queue_id: "approval-submit-invoice", skill_id: SKILL_ID, workspace_id: WORKSPACE_SLUG, license_id: "license-save-invoice", action: "submit_invoice", constraints: ["amount <= 500"], reason: "Submit requires proof and reviewer approval.", status: "pending" },
        ],
        case_law_review_queue: [
          { case_id: "CASE-DUPLICATE-CLIENT", title: "Duplicate client names require stable ID", skill_id: SKILL_ID, workspace_id: WORKSPACE_SLUG, finding: "Display names are not unique identifiers.", rule_created: "client_id_verified == true", status: "proposed", evidence_refs: ["ev-checkride-001"], binding_scope: "workspace" },
        ],
        skill_registry: [
          { skill_id: SKILL_ID, title: "Save invoice", workspace_id: WORKSPACE_SLUG, status: "licensed", license_status: "active", entrustment_level: "E3", readiness_level: 7, owner: "billing-ops", published_tool_name: "synthi_app_save_invoice", updated_at: now },
        ],
        policy_gates: [
          { gate_id: "gate-proof-required", name: "Proof required for submit", status: "active", severity: "critical", owner: "security", scope: "workspace", blocks: ["submit_invoice"], evidence_refs: ["evidence-proof-001"], next_step: "Issue verified proof capsule" },
        ],
        recertification_queue: [
          { queue_id: "recertify-source-drift", skill_id: SKILL_ID, skill_name: "Save invoice", reason: "source_drift", due_at: "2026-06-20T00:00:00.000Z", status: "queued", priority: "medium", evidence_refs: ["source-drift-001"] },
        ],
        audit_exports: [
          { export_id: "audit-license-proof", title: "License and proof audit", status: "available", generated_at: now, format: "json", record_count: 12, digest: "sha256:audit" },
        ],
        compliance_evidence_pack: {
          pack_id: "compliance-pack-visual-001",
          generated_at: now,
          artifacts: [
            { artifact_id: "skill_assurance_case", title: "Skill Assurance Case", status: "available", digest: "sha256:assurance", evidence_refs: ["ev-checkride-001"] },
            { artifact_id: "evidence_ledger_manifest", title: "Evidence Ledger Manifest", status: "available", digest: "sha256:ledger", evidence_refs: ["ev-checkride-001"] },
          ],
          missing_artifacts: ["deployed_host_conformance"],
          retention_class: "standard",
        },
      },
    },
  };
}

async function startDevServer({ port }) {
  const logPath = path.join(OUT_DIR, "dev-server.log");
  const nextCli = path.join(SYNTHI_ROOT, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [nextCli, "dev", "--turbopack", "--hostname", HOST, "--port", String(port)], {
    cwd: SYNTHI_ROOT,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  try {
    await waitForHttp({ port, pathName: ROUTES[0].path, timeoutMs: 45_000 });
  } catch (err) {
    stopDevServer(child);
    await writeFile(logPath, logs.join(""), "utf8");
    throw err;
  }
  await writeFile(logPath, logs.join(""), "utf8");
  return child;
}

function stopDevServer(child) {
  if (!child || child.killed) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

async function waitForHttp({ port, pathName, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const statusCode = await httpStatus(`http://${HOST}:${port}${pathName}`);
      if (statusCode && statusCode < 500) return;
    } catch (err) {
      lastError = err;
    }
    await delay(500);
  }
  throw new Error(`dojo_visual_dev_server_not_ready:${lastError?.message || "timeout"}`);
}

function httpStatus(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode));
    });
    req.once("error", reject);
    req.setTimeout(2_000, () => {
      req.destroy(new Error("http_timeout"));
    });
  });
}

async function findAvailablePort(start) {
  for (let port = start; port < start + 50; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`no_available_port_from_${start}`);
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, HOST);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "1";
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
