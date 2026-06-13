import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";
import type {
  DojoExecutableCheckrideReport,
  DojoExecutableCheckrideScenarioResult,
} from "../checkride/runner.js";
import type { DojoGraphRunResult } from "../graph/runtime.js";
import {
  validateDojoSkillGraph,
  type DojoSkillGraph,
} from "../graph/types.js";
import type { DojoPostgresQueryable } from "./postgres_proof_store.js";

export type DojoPersistedGraphStatus = "draft" | "checkride" | "licensed" | "expired" | "revoked";
export type DojoPersistedNodeMemoryStatus = "active" | "disabled" | "expired" | "needs_review";
export type DojoPersistedCheckrideRunStatus = "queued" | "running" | "passed" | "failed" | "blocked" | "canceled";
export type DojoPersistedScenarioRunStatus = "queued" | "running" | "passed" | "failed" | "blocked" | "needs_human" | "canceled";
export type DojoPersistedOracleStatus = "pass" | "fail" | "block" | "needs_human";

export interface PostgresDojoGraphRunStoreOptions {
  tenant_id: string;
  workspace_id: string;
  queryable: DojoPostgresQueryable;
}

export interface SaveDojoSkillGraphOptions {
  status?: DojoPersistedGraphStatus;
  created_by?: string;
}

export interface DojoSkillGraphRecord {
  tenant_id: string;
  workspace_id: string;
  graph_id: string;
  skill_id: string;
  skill_version: string;
  graph_version: string;
  status: DojoPersistedGraphStatus;
  graph_sha256: string;
  graph: DojoSkillGraph;
  validation: ReturnType<typeof validateDojoSkillGraph>;
  created_at: string;
  created_by?: string;
}

export interface DojoNodeMemoryRecord {
  tenant_id: string;
  workspace_id: string;
  graph_id: string;
  node_id: string;
  skill_id: string;
  node_kind: string;
  status: DojoPersistedNodeMemoryStatus;
  confidence?: number;
  evidence_refs: string[];
  memory_json: Record<string, unknown>;
  updated_at: string;
}

export interface DojoGraphExecutionRunRecord {
  tenant_id: string;
  workspace_id: string;
  graph_run_id: string;
  graph_id: string;
  skill_id: string;
  mode: DojoGraphRunResult["mode"];
  status: DojoGraphRunResult["status"];
  blocked_by: string[];
  evidence_refs: string[];
  result: DojoGraphRunResult;
  started_at: string;
  completed_at?: string;
  created_by: string;
}

export interface SaveDojoGraphRunOptions {
  graph_id: string;
  skill_id: string;
  started_at: string;
  completed_at?: string;
  created_by: string;
}

export interface DojoCheckrideRunRecord {
  tenant_id: string;
  workspace_id: string;
  checkride_run_id: string;
  skill_id: string;
  skill_version: string;
  graph_id?: string;
  status: DojoPersistedCheckrideRunStatus;
  entrustment_level?: string;
  readiness_level?: number;
  evidence_record_ids: string[];
  score_json: Record<string, unknown>;
  report: DojoExecutableCheckrideReport;
  started_at: string;
  completed_at?: string;
  created_by: string;
}

export interface SaveDojoCheckrideRunOptions {
  skill_version: string;
  created_by: string;
  status?: DojoPersistedCheckrideRunStatus;
  entrustment_level?: string;
  readiness_level?: number;
  evidence_record_ids?: string[];
}

export interface DojoScenarioRunRecord {
  tenant_id: string;
  workspace_id: string;
  scenario_run_id: string;
  scenario_id: string;
  skill_id: string;
  checkride_run_id?: string;
  mutation_kind: string;
  status: DojoPersistedScenarioRunStatus;
  fixture_sha256?: string;
  oracle_status: DojoPersistedOracleStatus;
  evidence_record_ids: string[];
  result: DojoStoredScenarioRunResult;
  started_at: string;
  completed_at?: string;
  created_by: string;
}

export interface DojoVivariumScenarioRunLike {
  skill_id: string;
  workflow_id: string;
  scenario: {
    scenario_id: string;
    mutation_kind: string;
  };
  result: {
    status: "passed" | "failed" | "blocked";
  };
  materialized_fixture: {
    simulator_tier: number;
    synthetic_data_only: true;
    tissues: Record<string, unknown>;
    input_overrides: Record<string, unknown>;
    expected_behavior: string;
  };
  run: {
    run_id: string;
    started_at: string;
    finished_at?: string;
    evidence_refs: string[];
  };
  evidence_refs: string[];
}

export type DojoStoredScenarioRunResult = DojoExecutableCheckrideScenarioResult | DojoVivariumScenarioRunLike;

export interface SaveDojoScenarioRunOptions {
  checkride_run_id?: string;
  skill_id: string;
  started_at: string;
  completed_at?: string;
  created_by: string;
  evidence_record_ids?: string[];
}

interface SkillGraphRow extends QueryResultRow {
  tenant_id: string;
  workspace_id: string;
  graph_id: string;
  skill_id: string;
  skill_version: string;
  graph_version: string;
  status: DojoPersistedGraphStatus;
  graph_sha256: string;
  graph_json: unknown;
  validation_json: unknown;
  created_at: Date | string;
  created_by: string | null;
}

interface NodeMemoryRow extends QueryResultRow {
  tenant_id: string;
  workspace_id: string;
  graph_id: string;
  node_id: string;
  skill_id: string;
  node_kind: string;
  status: DojoPersistedNodeMemoryStatus;
  confidence: number | null;
  evidence_refs: string[];
  memory_json: unknown;
  updated_at: Date | string;
}

interface GraphRunRow extends QueryResultRow {
  tenant_id: string;
  workspace_id: string;
  graph_run_id: string;
  graph_id: string;
  skill_id: string;
  mode: DojoGraphRunResult["mode"];
  status: DojoGraphRunResult["status"];
  blocked_by: string[];
  evidence_refs: string[];
  result_json: unknown;
  started_at: Date | string;
  completed_at: Date | string | null;
  created_by: string;
}

interface CheckrideRunRow extends QueryResultRow {
  tenant_id: string;
  workspace_id: string;
  checkride_run_id: string;
  skill_id: string;
  skill_version: string;
  graph_id: string | null;
  status: DojoPersistedCheckrideRunStatus;
  entrustment_level: string | null;
  readiness_level: number | null;
  evidence_record_ids: string[];
  score_json: unknown;
  report_json: unknown;
  started_at: Date | string;
  completed_at: Date | string | null;
  created_by: string;
}

interface ScenarioRunRow extends QueryResultRow {
  tenant_id: string;
  workspace_id: string;
  scenario_run_id: string;
  scenario_id: string;
  skill_id: string;
  checkride_run_id: string | null;
  mutation_kind: string;
  status: DojoPersistedScenarioRunStatus;
  fixture_sha256: string | null;
  oracle_status: DojoPersistedOracleStatus;
  evidence_record_ids: string[];
  result_json: unknown;
  started_at: Date | string;
  completed_at: Date | string | null;
  created_by: string;
}

export class PostgresDojoGraphRunStore {
  private readonly tenantId: string;
  private readonly workspaceId: string;
  private readonly queryable: DojoPostgresQueryable;

  constructor(options: PostgresDojoGraphRunStoreOptions) {
    this.tenantId = requiredId(options.tenant_id, "tenant_id");
    this.workspaceId = requiredId(options.workspace_id, "workspace_id");
    this.queryable = options.queryable;
  }

  async saveSkillGraph(graph: DojoSkillGraph, options: SaveDojoSkillGraphOptions = {}): Promise<DojoSkillGraphRecord> {
    const validation = validateDojoSkillGraph(graph);
    if (!validation.ok) {
      throw new Error(`dojo_postgres_graph_invalid:${validation.issues.map((issue) => issue.issue_id).join(",")}`);
    }
    const status = options.status ?? graphStatusForMode(graph);
    await this.queryable.query(
      `INSERT INTO dojo_skill_graphs (
        tenant_id,
        workspace_id,
        graph_id,
        skill_id,
        skill_version,
        graph_version,
        status,
        graph_sha256,
        graph_json,
        validation_json,
        created_at,
        created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::timestamptz, $12)
      ON CONFLICT (tenant_id, workspace_id, graph_id) DO UPDATE SET
        skill_id = EXCLUDED.skill_id,
        skill_version = EXCLUDED.skill_version,
        graph_version = EXCLUDED.graph_version,
        status = EXCLUDED.status,
        graph_sha256 = EXCLUDED.graph_sha256,
        graph_json = EXCLUDED.graph_json,
        validation_json = EXCLUDED.validation_json,
        created_by = EXCLUDED.created_by`,
      [
        this.tenantId,
        this.workspaceId,
        graph.graph_id,
        graph.skill_id,
        graph.skill_version,
        graph.graph_version,
        status,
        sha256Hex(canonicalJson(graph)),
        JSON.stringify(graph),
        JSON.stringify(validation),
        graph.created_at,
        options.created_by ?? null,
      ]
    );
    await this.queryable.query(
      `DELETE FROM dojo_node_memories WHERE tenant_id = $1 AND workspace_id = $2 AND graph_id = $3`,
      [this.tenantId, this.workspaceId, graph.graph_id]
    );
    for (const node of graph.nodes) {
      const memory = {
        node,
        guardrails: node.guardrails,
        proof: node.proof ?? null,
        assertions: node.assertions,
        substrate_options: node.substrate_options,
        case_law_refs: node.case_law_refs,
        expiry_triggers: node.expiry_triggers,
      };
      await this.queryable.query(
        `INSERT INTO dojo_node_memories (
          tenant_id,
          workspace_id,
          graph_id,
          node_id,
          skill_id,
          node_kind,
          status,
          confidence,
          evidence_refs,
          memory_json,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8::text[], $9::jsonb, $10::timestamptz)`,
        [
          this.tenantId,
          this.workspaceId,
          graph.graph_id,
          node.node_id,
          graph.skill_id,
          node.kind,
          numericMetadata(node.metadata, "confidence"),
          stringArrayMetadata(node.metadata, "evidence_refs"),
          JSON.stringify(memory),
          graph.created_at,
        ]
      );
    }
    const saved = await this.getSkillGraph(graph.graph_id);
    if (!saved) throw new Error("dojo_postgres_graph_save_failed");
    return saved;
  }

  async getSkillGraph(graphId: string): Promise<DojoSkillGraphRecord | null> {
    const result = await this.queryable.query<SkillGraphRow>(
      `SELECT tenant_id, workspace_id, graph_id, skill_id, skill_version, graph_version,
        status, graph_sha256, graph_json, validation_json, created_at, created_by
      FROM dojo_skill_graphs
      WHERE tenant_id = $1 AND workspace_id = $2 AND graph_id = $3`,
      [this.tenantId, this.workspaceId, graphId]
    );
    return rowToSkillGraph(result.rows[0]);
  }

  async listSkillGraphs(filter: { skill_id?: string; status?: DojoPersistedGraphStatus; limit?: number } = {}): Promise<DojoSkillGraphRecord[]> {
    const values: unknown[] = [this.tenantId, this.workspaceId];
    const predicates = ["tenant_id = $1", "workspace_id = $2"];
    addOptionalPredicate(predicates, values, "skill_id", filter.skill_id);
    addOptionalPredicate(predicates, values, "status", filter.status);
    values.push(normalizedLimit(filter.limit));
    const result = await this.queryable.query<SkillGraphRow>(
      `SELECT tenant_id, workspace_id, graph_id, skill_id, skill_version, graph_version,
        status, graph_sha256, graph_json, validation_json, created_at, created_by
      FROM dojo_skill_graphs
      WHERE ${predicates.join(" AND ")}
      ORDER BY created_at DESC, graph_id ASC
      LIMIT $${values.length}`,
      values
    );
    return result.rows.map(rowToSkillGraph).filter((record): record is DojoSkillGraphRecord => record !== null);
  }

  async listNodeMemories(filter: { graph_id?: string; node_id?: string; status?: DojoPersistedNodeMemoryStatus; limit?: number } = {}): Promise<DojoNodeMemoryRecord[]> {
    const values: unknown[] = [this.tenantId, this.workspaceId];
    const predicates = ["tenant_id = $1", "workspace_id = $2"];
    addOptionalPredicate(predicates, values, "graph_id", filter.graph_id);
    addOptionalPredicate(predicates, values, "node_id", filter.node_id);
    addOptionalPredicate(predicates, values, "status", filter.status);
    values.push(normalizedLimit(filter.limit));
    const result = await this.queryable.query<NodeMemoryRow>(
      `SELECT tenant_id, workspace_id, graph_id, node_id, skill_id, node_kind,
        status, confidence, evidence_refs, memory_json, updated_at
      FROM dojo_node_memories
      WHERE ${predicates.join(" AND ")}
      ORDER BY graph_id ASC, node_id ASC
      LIMIT $${values.length}`,
      values
    );
    return result.rows.map(rowToNodeMemory).filter((record): record is DojoNodeMemoryRecord => record !== null);
  }

  async saveGraphRun(run: DojoGraphRunResult, options: SaveDojoGraphRunOptions): Promise<DojoGraphExecutionRunRecord> {
    await this.queryable.query(
      `INSERT INTO dojo_graph_execution_runs (
        tenant_id,
        workspace_id,
        graph_run_id,
        graph_id,
        skill_id,
        mode,
        status,
        blocked_by,
        evidence_refs,
        result_json,
        started_at,
        completed_at,
        created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9::text[], $10::jsonb, $11::timestamptz, $12::timestamptz, $13)
      ON CONFLICT (tenant_id, workspace_id, graph_run_id) DO UPDATE SET
        graph_id = EXCLUDED.graph_id,
        skill_id = EXCLUDED.skill_id,
        mode = EXCLUDED.mode,
        status = EXCLUDED.status,
        blocked_by = EXCLUDED.blocked_by,
        evidence_refs = EXCLUDED.evidence_refs,
        result_json = EXCLUDED.result_json,
        completed_at = EXCLUDED.completed_at,
        created_by = EXCLUDED.created_by`,
      [
        this.tenantId,
        this.workspaceId,
        run.run_id,
        options.graph_id,
        options.skill_id,
        run.mode,
        run.status,
        run.blocked_by,
        run.evidence_refs,
        JSON.stringify(run),
        options.started_at,
        options.completed_at ?? null,
        options.created_by,
      ]
    );
    const saved = await this.getGraphRun(run.run_id);
    if (!saved) throw new Error("dojo_postgres_graph_run_save_failed");
    return saved;
  }

  async getGraphRun(graphRunId: string): Promise<DojoGraphExecutionRunRecord | null> {
    const result = await this.queryable.query<GraphRunRow>(
      `SELECT tenant_id, workspace_id, graph_run_id, graph_id, skill_id, mode, status,
        blocked_by, evidence_refs, result_json, started_at, completed_at, created_by
      FROM dojo_graph_execution_runs
      WHERE tenant_id = $1 AND workspace_id = $2 AND graph_run_id = $3`,
      [this.tenantId, this.workspaceId, graphRunId]
    );
    return rowToGraphRun(result.rows[0]);
  }

  async saveCheckrideRun(
    report: DojoExecutableCheckrideReport,
    options: SaveDojoCheckrideRunOptions
  ): Promise<DojoCheckrideRunRecord> {
    const evidenceRecordIds = uniqueStrings([
      ...(options.evidence_record_ids ?? []),
      ...report.evidence_refs.map((ref) => ref.replace(/^evidence:/, "")),
    ]);
    const status = options.status ?? checkrideStatusForReport(report);
    await this.queryable.query(
      `INSERT INTO dojo_checkride_runs (
        tenant_id,
        workspace_id,
        checkride_run_id,
        skill_id,
        skill_version,
        graph_id,
        status,
        entrustment_level,
        readiness_level,
        evidence_record_ids,
        score_json,
        report_json,
        started_at,
        completed_at,
        created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11::jsonb, $12::jsonb, $13::timestamptz, $14::timestamptz, $15)
      ON CONFLICT (tenant_id, workspace_id, checkride_run_id) DO UPDATE SET
        status = EXCLUDED.status,
        entrustment_level = EXCLUDED.entrustment_level,
        readiness_level = EXCLUDED.readiness_level,
        evidence_record_ids = EXCLUDED.evidence_record_ids,
        score_json = EXCLUDED.score_json,
        report_json = EXCLUDED.report_json,
        completed_at = EXCLUDED.completed_at,
        created_by = EXCLUDED.created_by`,
      [
        this.tenantId,
        this.workspaceId,
        report.checkride_id,
        report.skill_id,
        options.skill_version,
        report.graph_id,
        status,
        options.entrustment_level ?? null,
        options.readiness_level ?? null,
        evidenceRecordIds,
        JSON.stringify(checkrideScoreJson(report)),
        JSON.stringify(report),
        report.started_at,
        report.finished_at,
        options.created_by,
      ]
    );
    const saved = await this.getCheckrideRun(report.checkride_id);
    if (!saved) throw new Error("dojo_postgres_checkride_run_save_failed");
    return saved;
  }

  async getCheckrideRun(checkrideRunId: string): Promise<DojoCheckrideRunRecord | null> {
    const result = await this.queryable.query<CheckrideRunRow>(
      `SELECT tenant_id, workspace_id, checkride_run_id, skill_id, skill_version, graph_id,
        status, entrustment_level, readiness_level, evidence_record_ids, score_json,
        report_json, started_at, completed_at, created_by
      FROM dojo_checkride_runs
      WHERE tenant_id = $1 AND workspace_id = $2 AND checkride_run_id = $3`,
      [this.tenantId, this.workspaceId, checkrideRunId]
    );
    return rowToCheckrideRun(result.rows[0]);
  }

  async saveScenarioRun(
    result: DojoExecutableCheckrideScenarioResult,
    options: SaveDojoScenarioRunOptions
  ): Promise<DojoScenarioRunRecord> {
    const scenarioRunId = result.scenario_run.run_id;
    const evidenceRecordIds = uniqueStrings([
      ...(options.evidence_record_ids ?? []),
      ...(result.evidence_record ? [result.evidence_record.record_id] : []),
    ]);
    await this.queryable.query(
      `INSERT INTO dojo_scenario_runs (
        tenant_id,
        workspace_id,
        scenario_run_id,
        scenario_id,
        skill_id,
        checkride_run_id,
        mutation_kind,
        status,
        fixture_sha256,
        oracle_status,
        evidence_record_ids,
        result_json,
        started_at,
        completed_at,
        created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[], $12::jsonb, $13::timestamptz, $14::timestamptz, $15)
      ON CONFLICT (tenant_id, workspace_id, scenario_run_id) DO UPDATE SET
        checkride_run_id = EXCLUDED.checkride_run_id,
        status = EXCLUDED.status,
        fixture_sha256 = EXCLUDED.fixture_sha256,
        oracle_status = EXCLUDED.oracle_status,
        evidence_record_ids = EXCLUDED.evidence_record_ids,
        result_json = EXCLUDED.result_json,
        completed_at = EXCLUDED.completed_at,
        created_by = EXCLUDED.created_by`,
      [
        this.tenantId,
        this.workspaceId,
        scenarioRunId,
        result.scenario_id,
        options.skill_id,
        options.checkride_run_id ?? null,
        result.mutation_kind,
        scenarioRunStatusForOracleStatus(result.status),
        result.fixture.materialization_hash,
        oracleStatusForScenarioStatus(result.status),
        evidenceRecordIds,
        JSON.stringify(result),
        options.started_at,
        options.completed_at ?? null,
        options.created_by,
      ]
    );
    const saved = await this.getScenarioRun(scenarioRunId);
    if (!saved) throw new Error("dojo_postgres_scenario_run_save_failed");
    return saved;
  }

  async saveVivariumScenarioRun(
    result: DojoVivariumScenarioRunLike,
    options: SaveDojoScenarioRunOptions
  ): Promise<DojoScenarioRunRecord> {
    const scenarioRunId = result.run.run_id;
    const evidenceRecordIds = uniqueStrings([
      ...(options.evidence_record_ids ?? []),
      ...result.evidence_refs
        .filter((ref) => ref.startsWith("evidence:"))
        .map((ref) => ref.replace(/^evidence:/, "")),
    ]);
    await this.queryable.query(
      `INSERT INTO dojo_scenario_runs (
        tenant_id,
        workspace_id,
        scenario_run_id,
        scenario_id,
        skill_id,
        checkride_run_id,
        mutation_kind,
        status,
        fixture_sha256,
        oracle_status,
        evidence_record_ids,
        result_json,
        started_at,
        completed_at,
        created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[], $12::jsonb, $13::timestamptz, $14::timestamptz, $15)
      ON CONFLICT (tenant_id, workspace_id, scenario_run_id) DO UPDATE SET
        checkride_run_id = EXCLUDED.checkride_run_id,
        status = EXCLUDED.status,
        fixture_sha256 = EXCLUDED.fixture_sha256,
        oracle_status = EXCLUDED.oracle_status,
        evidence_record_ids = EXCLUDED.evidence_record_ids,
        result_json = EXCLUDED.result_json,
        completed_at = EXCLUDED.completed_at,
        created_by = EXCLUDED.created_by`,
      [
        this.tenantId,
        this.workspaceId,
        scenarioRunId,
        result.scenario.scenario_id,
        options.skill_id,
        options.checkride_run_id ?? null,
        result.scenario.mutation_kind,
        scenarioRunStatusForVivariumStatus(result.result.status),
        vivariumFixtureHash(result),
        oracleStatusForVivariumStatus(result.result.status),
        evidenceRecordIds,
        JSON.stringify(result),
        options.started_at,
        options.completed_at ?? null,
        options.created_by,
      ]
    );
    const saved = await this.getScenarioRun(scenarioRunId);
    if (!saved) throw new Error("dojo_postgres_vivarium_scenario_run_save_failed");
    return saved;
  }

  async getScenarioRun(scenarioRunId: string): Promise<DojoScenarioRunRecord | null> {
    const result = await this.queryable.query<ScenarioRunRow>(
      `SELECT tenant_id, workspace_id, scenario_run_id, scenario_id, skill_id,
        checkride_run_id, mutation_kind, status, fixture_sha256, oracle_status,
        evidence_record_ids, result_json, started_at, completed_at, created_by
      FROM dojo_scenario_runs
      WHERE tenant_id = $1 AND workspace_id = $2 AND scenario_run_id = $3`,
      [this.tenantId, this.workspaceId, scenarioRunId]
    );
    return rowToScenarioRun(result.rows[0]);
  }
}

function rowToSkillGraph(row: SkillGraphRow | undefined): DojoSkillGraphRecord | null {
  if (!row) return null;
  return {
    tenant_id: row.tenant_id,
    workspace_id: row.workspace_id,
    graph_id: row.graph_id,
    skill_id: row.skill_id,
    skill_version: row.skill_version,
    graph_version: row.graph_version,
    status: row.status,
    graph_sha256: row.graph_sha256,
    graph: normalizeJsonObject<DojoSkillGraph>(row.graph_json),
    validation: normalizeJsonObject<ReturnType<typeof validateDojoSkillGraph>>(row.validation_json),
    created_at: iso(row.created_at),
    ...(row.created_by ? { created_by: row.created_by } : {}),
  };
}

function rowToNodeMemory(row: NodeMemoryRow | undefined): DojoNodeMemoryRecord | null {
  if (!row) return null;
  return {
    tenant_id: row.tenant_id,
    workspace_id: row.workspace_id,
    graph_id: row.graph_id,
    node_id: row.node_id,
    skill_id: row.skill_id,
    node_kind: row.node_kind,
    status: row.status,
    ...(typeof row.confidence === "number" ? { confidence: row.confidence } : {}),
    evidence_refs: [...row.evidence_refs],
    memory_json: normalizeJsonObject<Record<string, unknown>>(row.memory_json),
    updated_at: iso(row.updated_at),
  };
}

function rowToGraphRun(row: GraphRunRow | undefined): DojoGraphExecutionRunRecord | null {
  if (!row) return null;
  return {
    tenant_id: row.tenant_id,
    workspace_id: row.workspace_id,
    graph_run_id: row.graph_run_id,
    graph_id: row.graph_id,
    skill_id: row.skill_id,
    mode: row.mode,
    status: row.status,
    blocked_by: [...row.blocked_by],
    evidence_refs: [...row.evidence_refs],
    result: normalizeJsonObject<DojoGraphRunResult>(row.result_json),
    started_at: iso(row.started_at),
    completed_at: isoOpt(row.completed_at),
    created_by: row.created_by,
  };
}

function rowToCheckrideRun(row: CheckrideRunRow | undefined): DojoCheckrideRunRecord | null {
  if (!row) return null;
  return {
    tenant_id: row.tenant_id,
    workspace_id: row.workspace_id,
    checkride_run_id: row.checkride_run_id,
    skill_id: row.skill_id,
    skill_version: row.skill_version,
    ...(row.graph_id ? { graph_id: row.graph_id } : {}),
    status: row.status,
    ...(row.entrustment_level ? { entrustment_level: row.entrustment_level } : {}),
    ...(typeof row.readiness_level === "number" ? { readiness_level: row.readiness_level } : {}),
    evidence_record_ids: [...row.evidence_record_ids],
    score_json: normalizeJsonObject<Record<string, unknown>>(row.score_json),
    report: normalizeJsonObject<DojoExecutableCheckrideReport>(row.report_json),
    started_at: iso(row.started_at),
    completed_at: isoOpt(row.completed_at),
    created_by: row.created_by,
  };
}

function rowToScenarioRun(row: ScenarioRunRow | undefined): DojoScenarioRunRecord | null {
  if (!row) return null;
  return {
    tenant_id: row.tenant_id,
    workspace_id: row.workspace_id,
    scenario_run_id: row.scenario_run_id,
    scenario_id: row.scenario_id,
    skill_id: row.skill_id,
    ...(row.checkride_run_id ? { checkride_run_id: row.checkride_run_id } : {}),
    mutation_kind: row.mutation_kind,
    status: row.status,
    ...(row.fixture_sha256 ? { fixture_sha256: row.fixture_sha256 } : {}),
    oracle_status: row.oracle_status,
    evidence_record_ids: [...row.evidence_record_ids],
    result: normalizeJsonObject<DojoStoredScenarioRunResult>(row.result_json),
    started_at: iso(row.started_at),
    completed_at: isoOpt(row.completed_at),
    created_by: row.created_by,
  };
}

function graphStatusForMode(graph: DojoSkillGraph): DojoPersistedGraphStatus {
  if (graph.mode === "checkride") return "checkride";
  if (graph.mode === "production") return "licensed";
  return "draft";
}

function checkrideStatusForReport(report: DojoExecutableCheckrideReport): DojoPersistedCheckrideRunStatus {
  if (report.critical_failures > 0 || report.failed_scenarios > 0) return "failed";
  if (report.blocked_scenarios > 0) return "blocked";
  return "passed";
}

function scenarioRunStatusForOracleStatus(status: DojoExecutableCheckrideScenarioResult["status"]): DojoPersistedScenarioRunStatus {
  if (status === "passed") return "passed";
  if (status === "failed") return "failed";
  if (status === "needs_human") return "needs_human";
  return "blocked";
}

function oracleStatusForScenarioStatus(status: DojoExecutableCheckrideScenarioResult["status"]): DojoPersistedOracleStatus {
  if (status === "passed") return "pass";
  if (status === "failed") return "fail";
  if (status === "needs_human") return "needs_human";
  return "block";
}

function scenarioRunStatusForVivariumStatus(status: DojoVivariumScenarioRunLike["result"]["status"]): DojoPersistedScenarioRunStatus {
  if (status === "passed") return "passed";
  if (status === "failed") return "failed";
  return "blocked";
}

function oracleStatusForVivariumStatus(status: DojoVivariumScenarioRunLike["result"]["status"]): DojoPersistedOracleStatus {
  if (status === "passed") return "pass";
  if (status === "failed") return "fail";
  return "block";
}

function vivariumFixtureHash(result: DojoVivariumScenarioRunLike): string {
  const fixture = result.materialized_fixture.tissues["fixture"];
  if (fixture && typeof fixture === "object" && !Array.isArray(fixture)) {
    const declared = (fixture as Record<string, unknown>)["materialization_hash"];
    if (typeof declared === "string" && /^[a-f0-9]{64}$/i.test(declared)) return declared;
  }
  return sha256Hex(canonicalJson(result.materialized_fixture));
}

function checkrideScoreJson(report: DojoExecutableCheckrideReport): Record<string, unknown> {
  return {
    scenario_count: report.scenario_count,
    passed_scenarios: report.passed_scenarios,
    failed_scenarios: report.failed_scenarios,
    blocked_scenarios: report.blocked_scenarios,
    critical_failures: report.critical_failures,
    coverage_score: report.coverage_score,
    production_recommendation: report.production_recommendation,
  };
}

function addOptionalPredicate(
  predicates: string[],
  values: unknown[],
  column: string,
  value: string | undefined
): void {
  if (!value) return;
  values.push(value);
  predicates.push(`${column} = $${values.length}`);
}

function numericMetadata(metadata: Record<string, unknown> | undefined, key: string): number | null {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArrayMetadata(metadata: Record<string, unknown> | undefined, key: string): string[] {
  const value = metadata?.[key];
  return Array.isArray(value) ? uniqueStrings(value.filter((item): item is string => typeof item === "string")) : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function normalizeJsonObject<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortValue(nested)])
  );
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedLimit(value: number | undefined): number {
  return Number.isFinite(value) && typeof value === "number" && value > 0
    ? Math.max(1, Math.min(Math.floor(value), 500))
    : 100;
}

function requiredId(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`dojo_postgres_graph_run_${field}_required`);
  return trimmed;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isoOpt(value: Date | string | null): string | undefined {
  return value == null ? undefined : iso(value);
}
