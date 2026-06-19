import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDojoSkill,
  issueDojoProofCapsule,
  validateDojoProofCapsule,
  type DojoScenario,
} from "../../src/browser/dojo.js";
import { InMemoryDojoSkillStore } from "../../src/browser/dojo_store.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
import { runDojoExecutableCheckride, type DojoCheckrideEvidenceLedger } from "../../src/dojo/checkride/runner.js";
import { buildDojoEvidenceLedgerRecord } from "../../src/dojo/evidence/ledger_record.js";
import type { DojoEvidenceLedgerRecord, DojoEvidenceRecordInput } from "../../src/dojo/evidence/types.js";
import { DojoSkillGraphRuntime } from "../../src/dojo/graph/runtime.js";
import { createFakeDojoSubstrateExecutor } from "../../src/dojo/graph/substrate_executor.js";
import type { DojoSkillGraph } from "../../src/dojo/graph/types.js";
import { toDojoScenarioDefinition } from "../../src/dojo/vivarium/scenario_dsl.js";
import { DojoVivariumRunner } from "../../src/dojo/vivarium/runner.js";

const eventsPath = process.env.SYNTHI_DOJO_SOAK_EVENTS_PATH?.trim();
const iterations = positiveInteger(process.env.SYNTHI_DOJO_SOAK_ITERATIONS, 4);
let eventFilePrepared = false;

afterEach(async () => {
  if (eventsPath && !eventFilePrepared) {
    await rm(eventsPath, { force: true });
  }
});

describe("Dojo soak performance loop", () => {
  it("repeatedly exercises proof, graph, Vivarium, checkride, evidence, and budget paths", async () => {
    if (eventsPath) {
      await mkdir(path.dirname(eventsPath), { recursive: true });
      await writeFile(eventsPath, "", "utf8");
      eventFilePrepared = true;
    }
    const runtime = new DojoSkillGraphRuntime();
    const vivarium = new DojoVivariumRunner();
    const ledger = new InMemoryCheckrideLedger("tenant-a", "workspace-a");
    let previousEvidenceHash = "0".repeat(64);
    let proofReplayFalseAllowCount = 0;
    let falseBlockCount = 0;

    for (let iteration = 1; iteration <= iterations; iteration += 1) {
      const skill = skillFixture(iteration);
      const requiredClaims = proofEvidenceClaimIds(skill);
      const evidence = await timedOperation("evidence_append", iteration, async () => {
        const record = buildDojoEvidenceLedgerRecord({
          record_id: `soak-evidence-${iteration}`,
          tenant_id: "tenant-a",
          workspace_id: "workspace-a",
          skill_id: skill.skill_id,
          run_id: `soak-evidence-run-${iteration}`,
          kind: "checkride",
          artifact_uri: `memory://dojo/soak/${iteration}/checkride`,
          artifact_sha256: sha256Hex(JSON.stringify({ iteration, skill_id: skill.skill_id, requiredClaims })),
          redaction_manifest_sha256: sha256Hex(`redaction:${iteration}`),
          claim_ids: requiredClaims,
          previous_hash: previousEvidenceHash,
          created_at: isoAt(iteration, 0),
          created_by: "dojo-soak-performance-loop",
          retention_class: "ephemeral",
        });
        previousEvidenceHash = record.ledger_head_hash;
        expect(record.record_hash).toMatch(/^[a-f0-9]{64}$/);
        return { evidence_record_id: record.record_id, ledger_head_hash: record.ledger_head_hash };
      });

      const proofEvidenceRecord = evidenceRecordForSkill(skill, requiredClaims, iteration, evidence.ledger_head_hash);
      const capsule = issueDojoProofCapsule(skill, "run_workflow", {
        tenant_id: "tenant-a",
        context_claims: { workspace_verified: true },
        evidence_ledger_records: [proofEvidenceRecord],
        ledger_checkpoint_hash: proofEvidenceRecord.ledger_head_hash,
        require_verified_evidence: true,
        now: isoAt(iteration, 1),
        expires_at: isoAt(iteration, 15),
      });

      await timedOperation("proof_validation", iteration, async () => {
        const validation = validateDojoProofCapsule(skill, capsule, "run_workflow", isoAt(iteration, 2));
        expect(validation).toEqual(expect.objectContaining({ ok: true, status: "allowed" }));
        return { capsule_id: capsule.capsule_id, validation_status: validation.status };
      });

      await timedOperation("proof_replay_rejection", iteration, async () => {
        const store = new InMemoryDojoSkillStore();
        store.saveSkill(skill);
        store.saveProofRecord({
          capsule_id: capsule.capsule_id,
          skill_id: capsule.skill_id,
          requested_action: capsule.requested_action,
          nonce: capsule.nonce,
          issued_at: capsule.issued_at,
          expires_at: capsule.expires_at,
          status: "issued",
        });
        const firstConsume = store.markProofCapsuleUsed(capsule.capsule_id, `soak-production-run-${iteration}`, isoAt(iteration, 3));
        const secondConsume = store.markProofCapsuleUsed(capsule.capsule_id, `soak-replay-run-${iteration}`, isoAt(iteration, 4));
        if (secondConsume.ok) proofReplayFalseAllowCount += 1;
        expect(firstConsume.ok).toBe(true);
        expect(secondConsume).toEqual(expect.objectContaining({
          ok: false,
          status: "already_used",
          blocked_by: ["proof_capsule_replay_detected"],
        }));
        return {
          capsule_id: capsule.capsule_id,
          first_consume_ok: firstConsume.ok,
          second_consume_ok: secondConsume.ok,
          proof_replay_false_allow_count: secondConsume.ok ? 1 : 0,
        };
      });

      await timedOperation("graph_node_execution", iteration, async () => {
        const result = await runtime.execute({
          graph: productionGraphFixture(iteration),
          run_id: `soak-graph-run-${iteration}`,
          tenant: tenantContext(iteration),
          inputs: {
            workspace_verified: true,
            client_id_verified: true,
            license_allowed_substrates: ["dom"],
            assertion_results: { assert_submission_state: true },
          },
          proof_capsule: { capsule_id: capsule.capsule_id },
          proof_validator: async () => ({ ok: true, blocked_by: [] }),
          substrate_executor: createFakeDojoSubstrateExecutor(),
          evidence_writer: (event) => `ledger://dojo-soak/${event.run_id}/${event.node_id}`,
          now: isoAt(iteration, 5),
        });
        if (!result.ok) falseBlockCount += 1;
        expect(result).toEqual(expect.objectContaining({ ok: true, status: "completed" }));
        return {
          run_id: result.run_id,
          node_count: result.node_results.length,
          false_block_count: result.ok ? 0 : 1,
        };
      });

      const baselineScenario = toDojoScenarioDefinition(scenarioFixture("baseline", {
        layer: "skill",
        risk_tags: ["baseline"],
      }));
      const materialized = vivarium.materialize({
        skill_id: "skill-a",
        scenario: baselineScenario,
        tenant: tenantContext(iteration),
        seed: `soak-baseline-${iteration}`,
        now: isoAt(iteration, 6),
      });
      let scenarioRunResult: Awaited<ReturnType<DojoVivariumRunner["run"]>> | undefined;
      await timedOperation("vivarium_scenario_runtime", iteration, async () => {
        const result = await vivarium.run({
          materialized,
          graph: checkrideGraphFixture(),
          tenant: tenantContext(iteration),
          run_id: `soak-scenario-run-${iteration}`,
          inputs: {
            workspace_verified: true,
            client_id_verified: true,
            assertion_results: { assert_submission_state: true },
          },
          now: isoAt(iteration, 7),
        });
        scenarioRunResult = result;
        if (result.status !== "passed") falseBlockCount += 1;
        expect(result).toEqual(expect.objectContaining({
          status: "passed",
          expectation_met: true,
        }));
        return {
          run_id: result.run_id,
          status: result.status,
          false_block_count: result.status === "passed" ? 0 : 1,
        };
      });

      await timedOperation("wind_tunnel_budget", iteration, async () => {
        if (!scenarioRunResult) throw new Error("dojo_soak_scenario_result_missing");
        expect(scenarioRunResult.budget_usage.max_runs).toBeGreaterThanOrEqual(1);
        expect(scenarioRunResult.budget_usage.elapsed_ms).toBeLessThanOrEqual(scenarioRunResult.budget_usage.max_estimated_ms);
        return {
          run_id: scenarioRunResult.run_id,
          max_runs: scenarioRunResult.budget_usage.max_runs,
          elapsed_ms: scenarioRunResult.budget_usage.elapsed_ms,
          max_estimated_ms: scenarioRunResult.budget_usage.max_estimated_ms,
        };
      });

      await timedOperation("checkride_runtime", iteration, async () => {
        const report = await runDojoExecutableCheckride({
          graph: checkrideGraphFixture(),
          scenarios: [baselineScenario],
          base_inputs: {
            workspace_verified: true,
            client_id_verified: true,
            assertion_results: { assert_submission_state: true },
          },
          observed_evidence_by_scenario: {
            [baselineScenario.scenario_id]: ["graph_run_result", "oracle_result"],
          },
          evidence_context: {
            tenant_id: "tenant-a",
            workspace_id: "workspace-a",
            skill_id: "skill-a",
            created_at: isoAt(iteration, 8),
            created_by: "dojo-soak-performance-loop",
            run_id_prefix: `soak-checkride-${iteration}`,
          },
          evidence_ledger: ledger,
          require_evidence_ledger: true,
          now: isoAt(iteration, 8),
        });
        if (report.production_recommendation !== "allowed") falseBlockCount += 1;
        expect(report).toEqual(expect.objectContaining({
          scenario_count: 1,
          passed_scenarios: 1,
          failed_scenarios: 0,
          ledger_record_count: 1,
          production_recommendation: "allowed",
        }));
        return {
          checkride_id: report.checkride_id,
          ledger_record_count: report.ledger_record_count,
          false_block_count: report.production_recommendation === "allowed" ? 0 : 1,
        };
      });
    }

    expect(proofReplayFalseAllowCount).toBe(0);
    expect(falseBlockCount).toBe(0);
  }, 60000);
});

async function timedOperation<T>(
  operation: string,
  iteration: number,
  work: () => Promise<T> | T
): Promise<T> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  try {
    const details = await work();
    const durationMs = performance.now() - started;
    await writeEvent({
      schema_version: "synthi.dojo.soakPerformanceEvent.v1",
      iteration,
      operation,
      ok: true,
      duration_ms: Number(durationMs.toFixed(3)),
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      memory_rss_bytes: process.memoryUsage().rss,
      details,
    });
    return details;
  } catch (error) {
    const durationMs = performance.now() - started;
    await writeEvent({
      schema_version: "synthi.dojo.soakPerformanceEvent.v1",
      iteration,
      operation,
      ok: false,
      duration_ms: Number(durationMs.toFixed(3)),
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      memory_rss_bytes: process.memoryUsage().rss,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function writeEvent(event: Record<string, unknown>): Promise<void> {
  if (!eventsPath) return;
  await appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
}

class InMemoryCheckrideLedger implements DojoCheckrideEvidenceLedger {
  readonly records: DojoEvidenceLedgerRecord[] = [];

  constructor(
    private readonly tenantId: string,
    private readonly workspaceId: string
  ) {}

  async append(
    input: Omit<DojoEvidenceRecordInput, "tenant_id" | "workspace_id" | "previous_hash">
  ): Promise<DojoEvidenceLedgerRecord> {
    const record = buildDojoEvidenceLedgerRecord({
      ...input,
      tenant_id: this.tenantId,
      workspace_id: this.workspaceId,
      previous_hash: this.records.at(-1)?.ledger_head_hash ?? "0".repeat(64),
    });
    this.records.push(record);
    return record;
  }
}

function skillFixture(iteration: number) {
  return buildDojoSkill(compileWorkflowContract([
    browserEvent({
      event_id: `open-${iteration}`,
      action: "click",
      detail: { element: { role: "button", name: `Open invoice ${iteration}`, source_id: `invoice.${iteration}.open` } },
      locator_candidates: [
        {
          kind: "role",
          locator: `page.getByRole("button", { name: "Open invoice ${iteration}" })`,
          confidence: 0.98,
          reason: "role",
        },
      ],
    }),
  ]).contract, {
    tenant_id: "tenant-a",
    workspace_id: "workspace-a",
    now: isoAt(iteration, 0),
  });
}

function proofEvidenceClaimIds(skill: ReturnType<typeof skillFixture>): string[] {
  return [...new Set([
    ...skill.permission_license.proof_requirements.required_evidence_claims,
    ...skill.permission_license.proof_requirements.required_context_claims,
  ])];
}

function evidenceRecordForSkill(
  skill: ReturnType<typeof skillFixture>,
  claimIds: string[],
  iteration: number,
  ledgerHeadHash: string
): DojoEvidenceLedgerRecord {
  return buildDojoEvidenceLedgerRecord({
    record_id: `soak-proof-evidence-${iteration}`,
    tenant_id: "tenant-a",
    workspace_id: "workspace-a",
    skill_id: skill.skill_id,
    run_id: `soak-proof-run-${iteration}`,
    kind: "checkride",
    artifact_uri: `memory://dojo/soak/${iteration}/proof`,
    artifact_sha256: sha256Hex(JSON.stringify({ iteration, claimIds, skill_id: skill.skill_id })),
    redaction_manifest_sha256: sha256Hex(`proof-redaction:${iteration}`),
    claim_ids: claimIds,
    previous_hash: ledgerHeadHash,
    created_at: isoAt(iteration, 0),
    created_by: "dojo-soak-performance-loop",
    retention_class: "ephemeral",
  });
}

function productionGraphFixture(iteration: number): DojoSkillGraph {
  return {
    schema_version: "synthi.dojo.skillGraph.v1",
    graph_id: `graph-soak-production-${iteration}`,
    skill_id: `skill-soak-production-${iteration}`,
    skill_version: "skill-v1",
    graph_version: "graph-v1",
    mode: "production",
    created_at: isoAt(iteration, 0),
    nodes: [
      safeNode("trigger", "Trigger", "Skill invocation"),
      {
        ...safeNode("action_submit", "Action", "Submit synthetic invoice"),
        risk: "dangerous",
        preconditions: ["workspace_verified == true"],
        guardrails: [
          {
            guardrail_id: "guard_client_stable_id",
            predicate: "client_id_verified == true",
            severity: "block",
          },
        ],
        proof: {
          required: true,
          required_claims: ["checkride_passed", "workspace_verified"],
          required_guardrails: ["guard_client_stable_id"],
        },
        assertions: [
          {
            assertion_id: "assert_submission_state",
            description: "Submission state is confirmed by evidence.",
            required: true,
          },
        ],
        substrate_options: ["dom"],
        evidence_policy: ["append_action_trace"],
      },
    ],
    edges: [
      {
        edge_id: "edge_trigger_action",
        from_node_id: "trigger",
        to_node_id: "action_submit",
        confidence: 1,
        observed_variants: [],
      },
    ],
  };
}

function checkrideGraphFixture(): DojoSkillGraph {
  return {
    schema_version: "synthi.dojo.skillGraph.v1",
    graph_id: "graph-soak-checkride",
    skill_id: "skill-a",
    skill_version: "skill-v1",
    graph_version: "graph-v1",
    mode: "checkride",
    created_at: "2026-06-11T00:00:00.000Z",
    nodes: [
      safeNode("trigger", "Trigger", "Skill invocation"),
      safeNode("action", "Action", "Synthetic action"),
    ],
    edges: [
      {
        edge_id: "edge_trigger_action",
        from_node_id: "trigger",
        to_node_id: "action",
        confidence: 1,
        observed_variants: [],
      },
    ],
  };
}

function safeNode(
  nodeId: string,
  kind: DojoSkillGraph["nodes"][number]["kind"],
  label: string
): DojoSkillGraph["nodes"][number] {
  return {
    node_id: nodeId,
    kind,
    label,
    risk: "safe",
    preconditions: [],
    postconditions: [],
    guardrails: [],
    assertions: [],
    substrate_options: kind === "Action" ? ["dom"] : [],
    evidence_policy: kind === "Action" ? ["append_action_trace"] : [],
    case_law_refs: [],
    expiry_triggers: [],
  };
}

function scenarioFixture(
  mutationKind: string,
  overrides: Partial<DojoScenario> = {}
): DojoScenario {
  return {
    scenario_id: `soak_scenario_${mutationKind}`,
    title: "Synthetic soak scenario",
    layer: overrides.layer ?? "risk",
    simulator_tier: overrides.simulator_tier ?? 2,
    mutation_kind: mutationKind,
    expected_behavior: "Exercise the skill against a synthetic fixture.",
    risk_tags: overrides.risk_tags ?? [],
    generated_from: overrides.generated_from ?? "dojo_soak_performance_loop",
  };
}

function tenantContext(iteration: number) {
  return {
    tenant_id: "tenant-a",
    organization_id: "org-a",
    workspace_id: "workspace-a",
    actor_id: "dojo-soak-loop",
    actor_type: "agent" as const,
    roles: ["dojo:soak"],
    request_id: `dojo-soak-${iteration}`,
    correlation_id: `dojo-soak-${iteration}-correlation`,
  };
}

function browserEvent(overrides: Partial<BrowserTraceEvent>): BrowserTraceEvent {
  return {
    event_id: "evt",
    trace_id: "trace",
    trace_version: 1,
    event_seq: 1,
    ts: 1,
    tab_id: "tab",
    origin: "https://app.example.test",
    url: "https://app.example.test/invoices",
    kind: "human_action",
    action: "click",
    target: "button",
    selectors: [],
    locator_candidates: [],
    confidence: 0.99,
    ...overrides,
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isoAt(iteration: number, minute: number): string {
  return `2026-06-11T00:${String((iteration + minute) % 60).padStart(2, "0")}:00.000Z`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
