#!/usr/bin/env node
/*
 * Seed one production-visible Dojo competency through the same supported
 * workflow-artifact -> synthi_dojo_publish_skill path used by the product.
 *
 * This script does not write skill rows directly. In production it should run
 * inside the dojo-mcp-host pod so it inherits the deployed control-plane,
 * evidence-ledger, proof-signing, and private-tool-store configuration.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(MCP_ROOT, "../..");

export const DOJO_RELEASE_COMPETENCY_SEED_SCHEMA_VERSION = "synthi.dojo.releaseCompetencySeed.v1";
export const DOJO_RELEASE_COMPETENCY_SEED_DEFAULT_OUT_DIR = "tmp/dojo-release-competency-seed";
export const DOJO_RELEASE_COMPETENCY_SEED_DEFAULT_ROLES = ["dojo:operator"];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const artifacts = await runDojoReleaseCompetencySeed({
    args,
    env: process.env,
    outDir: args["out-dir"],
  });
  console.log(
    `[ok] Dojo release competency seeded - skill=${artifacts.report.skill.skill_id} tool=${artifacts.report.private_tool.tool_name} report=${artifacts.report_path}`
  );
}

export async function runDojoReleaseCompetencySeed({
  args: inputArgs = {},
  env = process.env,
  outDir,
  now = new Date().toISOString(),
  modules,
} = {}) {
  const outputDir = path.resolve(outDir || env.SYNTHI_DOJO_RELEASE_COMPETENCY_SEED_OUT_DIR || path.join(REPO_ROOT, DOJO_RELEASE_COMPETENCY_SEED_DEFAULT_OUT_DIR));
  await mkdir(outputDir, { recursive: true });
  const runtime = modules ?? await loadRuntimeModules();
  const config = buildDojoReleaseCompetencySeedConfig({ args: inputArgs, env, now });
  const artifact = recordReleaseSeedWorkflowArtifact({ browserBroker: runtime.browserBroker, config });
  const manifest = runtime.generatePrivateWorkflowToolManifest(artifact.workflow.contract);
  const candidateSkill = runtime.buildDojoSkill(artifact.workflow.contract, {
    workspace_id: config.tenant.workspace_id,
    tenant_id: config.tenant.tenant_id,
    now: config.now,
    private_tool_manifest: manifest,
    ...(manifest.status !== "blocked" ? { published_tool_name: manifest.tool_name } : {}),
  });
  const evidenceRefs = config.evidence_refs.length > 0
    ? config.evidence_refs
    : [await appendReleasePublicationEvidence({
        runtime,
        config,
        artifact,
        candidateSkill,
      })];
  const publishArgs = {
    workflow_id: artifact.workflow_id,
    ...config.tenant,
    reason: config.reason,
    evidence_refs: evidenceRefs,
    now: config.now,
  };
  const publish = await runtime.dispatchDojoTool("synthi_dojo_publish_skill", publishArgs);
  const content = objectOrNull(publish?.structuredContent);
  if (!publish || publish.isError || content?.ok === false) {
    throw new Error(`dojo_release_competency_seed_publish_failed:${stringOpt(content?.error) ?? "unknown"}`);
  }
  const skill = objectOrNull(content?.skill);
  const privateTool = objectOrNull(content?.private_tool);
  const publication = objectOrNull(content?.publication);
  const report = buildDojoReleaseCompetencySeedReport({
    config,
    artifact,
    manifest,
    candidateSkill,
    evidenceRefs,
    publishContent: content,
    skill,
    privateTool,
    publication,
  });
  const reportPath = path.join(outputDir, "dojo-release-competency-seed.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report_path: reportPath, report };
}

export function buildDojoReleaseCompetencySeedConfig({ args = {}, env = process.env, now = new Date().toISOString() } = {}) {
  const tenantId = requiredString(
    args["tenant-id"]
      ?? env.SYNTHI_DOJO_RELEASE_SEED_TENANT_ID
      ?? env.SYNTHI_DOJO_MCP_CONFORMANCE_TENANT_ID
      ?? env.SYNTHI_TENANT_ID,
    "tenant_id"
  );
  const workspaceId = requiredString(
    args["workspace-id"]
      ?? env.SYNTHI_DOJO_RELEASE_SEED_WORKSPACE_ID
      ?? env.SYNTHI_DOJO_MCP_CONFORMANCE_WORKSPACE_ID
      ?? env.SYNTHI_WORKSPACE_ID,
    "workspace_id"
  );
  const actorId = requiredString(
    args["actor-id"]
      ?? env.SYNTHI_DOJO_RELEASE_SEED_ACTOR_ID
      ?? env.SYNTHI_DOJO_MCP_CONFORMANCE_ACTOR_ID
      ?? env.SYNTHI_AGENT_ID
      ?? env.SYNTHI_ACTOR_ID,
    "actor_id"
  );
  const actorType = normalizeActorType(
    args["actor-type"]
      ?? env.SYNTHI_DOJO_RELEASE_SEED_ACTOR_TYPE
      ?? env.SYNTHI_DOJO_MCP_CONFORMANCE_ACTOR_TYPE
      ?? env.SYNTHI_ACTOR_TYPE
      ?? "service"
  );
  const organizationId = requiredString(
    args["organization-id"]
      ?? env.SYNTHI_DOJO_RELEASE_SEED_ORGANIZATION_ID
      ?? env.SYNTHI_DOJO_MCP_CONFORMANCE_ORGANIZATION_ID
      ?? env.SYNTHI_ORGANIZATION_ID
      ?? tenantId,
    "organization_id"
  );
  const roles = parseRoles({
    rolesJson: args["roles-json"] ?? env.SYNTHI_DOJO_RELEASE_SEED_ROLES_JSON ?? env.SYNTHI_DOJO_MCP_CONFORMANCE_ROLES_JSON,
    roles: args.roles ?? env.SYNTHI_DOJO_RELEASE_SEED_ROLES ?? env.SYNTHI_DOJO_MCP_CONFORMANCE_ROLES,
  });
  const requestId = stringOpt(args["request-id"] ?? env.SYNTHI_DOJO_RELEASE_SEED_REQUEST_ID)
    ?? `dojo-release-seed-${hashId(`${workspaceId}:${actorId}:${now}`).slice(0, 12)}`;
  const correlationId = stringOpt(args["correlation-id"] ?? env.SYNTHI_DOJO_RELEASE_SEED_CORRELATION_ID) ?? requestId;
  const appOrigin = resolveAppOrigin({ args, env });
  const url = stringOpt(args.url ?? env.SYNTHI_DOJO_RELEASE_SEED_URL) ?? `${appOrigin}/dojo-release-seed`;
  const evidenceRefs = parseStringList(args["evidence-refs"] ?? env.SYNTHI_DOJO_RELEASE_SEED_EVIDENCE_REFS);
  return {
    now,
    reason: stringOpt(args.reason ?? env.SYNTHI_DOJO_RELEASE_SEED_REASON) ?? "seed release Dojo competency for deployed MCP conformance",
    tenant: {
      tenant_id: tenantId,
      organization_id: organizationId,
      workspace_id: workspaceId,
      actor_id: actorId,
      actor_type: actorType,
      roles,
      request_id: requestId,
      correlation_id: correlationId,
    },
    workflow: {
      tab_id: stringOpt(args["tab-id"] ?? env.SYNTHI_DOJO_RELEASE_SEED_TAB_ID) ?? "dojo-release-seed-tab",
      origin: appOrigin,
      url,
      action: stringOpt(args.action ?? env.SYNTHI_DOJO_RELEASE_SEED_ACTION) ?? "click",
      role: stringOpt(args.role ?? env.SYNTHI_DOJO_RELEASE_SEED_ROLE) ?? "button",
      name: stringOpt(args.name ?? env.SYNTHI_DOJO_RELEASE_SEED_NAME) ?? "Open release details",
      source_id: stringOpt(args["source-id"] ?? env.SYNTHI_DOJO_RELEASE_SEED_SOURCE_ID) ?? "dojo.release.seed.action",
    },
    evidence_refs: evidenceRefs,
  };
}

export function recordReleaseSeedWorkflowArtifact({ browserBroker, config }) {
  browserBroker.resetForTests?.();
  browserBroker.requestConsent(config.workflow.url);
  browserBroker.registerTabs([{ tab_id: config.workflow.tab_id, url: config.workflow.url, active: true }]);
  browserBroker.selectTab(config.workflow.tab_id);
  const teach = browserBroker.startTeachMode(config.workflow.tab_id);
  if (!teach?.ok) throw new Error(`dojo_release_competency_seed_teach_start_failed:${teach?.error ?? "unknown"}`);
  browserBroker.recordHumanAction({
    tab_id: config.workflow.tab_id,
    url: config.workflow.url,
    origin: config.workflow.origin,
    action: config.workflow.action,
    element: {
      role: config.workflow.role,
      name: config.workflow.name,
      source_id: config.workflow.source_id,
    },
    locator_candidates: [
      {
        kind: "role",
        locator: `page.getByRole(${JSON.stringify(config.workflow.role)}, { name: ${JSON.stringify(config.workflow.name)} })`,
        confidence: 0.98,
        reason: "release-seed-role",
      },
    ],
  });
  const artifact = browserBroker.workflowArtifact();
  if (!artifact?.ok) throw new Error(`dojo_release_competency_seed_workflow_missing:${artifact?.error ?? "unknown"}`);
  return artifact.artifact;
}

export async function appendReleasePublicationEvidence({ runtime, config, artifact, candidateSkill }) {
  const record = buildReleasePublicationEvidenceInput({ config, artifact, candidateSkill });
  const resolution = await runtime.resolveDojoEvidenceLedgerAppendStore({
    tenant_id: config.tenant.tenant_id,
    workspace_id: config.tenant.workspace_id,
    tenant_context: config.tenant,
    app_origin: config.workflow.origin,
  });
  if (!resolution.ok || !resolution.evidence_ledger) {
    await resolution.close?.().catch(() => undefined);
    throw new Error(`dojo_release_competency_seed_evidence_ledger_required:${(resolution.blocked_by ?? []).join(",")}`);
  }
  try {
    const appended = await resolution.evidence_ledger.append(record);
    return appended.record_id;
  } finally {
    await resolution.close?.().catch(() => undefined);
  }
}

export function buildReleasePublicationEvidenceInput({ config, artifact, candidateSkill }) {
  const artifactPayload = {
    schema_version: "synthi.dojo.releaseCompetencyPublicationEvidenceArtifact.v1",
    workflow_id: artifact.workflow_id,
    skill_id: candidateSkill.skill_id,
    reason: config.reason,
    generated_at: config.now,
  };
  const artifactSha = sha256(JSON.stringify(artifactPayload));
  const recordId = `dojo_release_publication_${hashId([
    config.tenant.tenant_id,
    config.tenant.workspace_id,
    candidateSkill.skill_id,
    artifact.workflow_id,
    config.now,
  ].join(":")).slice(0, 24)}`;
  return {
    record_id: recordId,
    skill_id: candidateSkill.skill_id,
    run_id: `release_seed_${hashId(`${artifact.workflow_id}:${config.now}`).slice(0, 16)}`,
    kind: "audit",
    artifact_uri: `dojo://release-competency-seed/${encodeURIComponent(artifact.workflow_id)}/${encodeURIComponent(recordId)}`,
    artifact_sha256: artifactSha,
    redaction_manifest_sha256: sha256(JSON.stringify({
      artifact_sha256: artifactSha,
      raw_payload_stored: false,
      redaction_policy: "digest_only",
    })),
    claim_ids: ["publication_reviewed"],
    created_at: config.now,
    created_by: config.tenant.actor_id,
    retention_class: "standard",
    source_refs: [
      "dojo-release-competency-seed",
      `workflow:${artifact.workflow_id}`,
      `skill:${candidateSkill.skill_id}`,
    ],
  };
}

export function buildDojoReleaseCompetencySeedReport({
  config,
  artifact,
  manifest,
  candidateSkill,
  evidenceRefs,
  publishContent,
  skill,
  privateTool,
  publication,
}) {
  return {
    schema_version: DOJO_RELEASE_COMPETENCY_SEED_SCHEMA_VERSION,
    generated_at: config.now,
    ok: true,
    tenant_context_fields: Object.keys(config.tenant).sort(),
    workflow: {
      workflow_id: artifact.workflow_id,
      step_count: artifact.workflow?.card?.stepCount ?? artifact.events?.length ?? null,
      app_origin: config.workflow.origin,
    },
    candidate: {
      skill_id: candidateSkill.skill_id,
      workflow_id: candidateSkill.workflow_id,
      manifest_status: manifest.status,
      tool_name: manifest.tool_name,
    },
    skill: {
      skill_id: stringOpt(skill?.skill_id) ?? candidateSkill.skill_id,
      workflow_id: stringOpt(skill?.workflow_id) ?? candidateSkill.workflow_id,
      readiness_level: stringOpt(skill?.readiness_level ?? skill?.skill_readiness_level) ?? null,
      entrustment_level: stringOpt(skill?.entrustment_level) ?? null,
    },
    private_tool: {
      tool_name: stringOpt(privateTool?.tool_name ?? publishContent?.published_tool_name ?? publishContent?.tool_name) ?? manifest.tool_name,
      ok: privateTool?.ok !== false,
      manifest_status: stringOpt(privateTool?.manifest_status) ?? manifest.status,
    },
    publication: {
      ok: publication?.ok !== false,
      evidence_ref_count: evidenceRefs.length,
      evidence_refs: evidenceRefs,
      control_plane_persistence: summarizeControlPlanePersistence(publication?.control_plane_persistence),
      evidence_ledger_validation: summarizeEvidenceLedgerValidation(publication?.evidence_ledger_validation),
      executable_checkride: summarizeExecutableCheckride(publication?.executable_checkride),
    },
  };
}

async function loadRuntimeModules() {
  const [
    brokerModule,
    dojoModule,
    manifestModule,
    ledgerResolverModule,
    dojoToolsModule,
  ] = await Promise.all([
    import(pathToFileURL(path.join(MCP_ROOT, "dist", "browser", "broker.js")).href),
    import(pathToFileURL(path.join(MCP_ROOT, "dist", "browser", "dojo.js")).href),
    import(pathToFileURL(path.join(MCP_ROOT, "dist", "browser", "private_tool_manifest.js")).href),
    import(pathToFileURL(path.join(MCP_ROOT, "dist", "dojo", "evidence", "ledger_resolver.js")).href),
    import(pathToFileURL(path.join(MCP_ROOT, "dist", "tools", "dojo.js")).href),
  ]);
  return {
    browserBroker: brokerModule.browserBroker,
    buildDojoSkill: dojoModule.buildDojoSkill,
    generatePrivateWorkflowToolManifest: manifestModule.generatePrivateWorkflowToolManifest,
    resolveDojoEvidenceLedgerAppendStore: ledgerResolverModule.resolveDojoEvidenceLedgerAppendStore,
    dispatchDojoTool: dojoToolsModule.dispatchDojoTool,
  };
}

function resolveAppOrigin({ args, env }) {
  const explicit = stringOpt(
    args["app-origin"]
      ?? env.SYNTHI_DOJO_RELEASE_SEED_APP_ORIGIN
      ?? env.SYNTHI_DOJO_MCP_CONFORMANCE_APP_ORIGIN
  );
  if (explicit) return originFromUrl(explicit);
  const fromWorkspace = originFromOptionalUrl(env.SYNTHI_HOSTED_BROWSER_WORKSPACE_URL);
  if (fromWorkspace) return fromWorkspace;
  const fromFrontend = originFromOptionalUrl(env.FRONTEND_URL ?? env.NEXTAUTH_URL ?? env.APP_URL);
  if (fromFrontend) return fromFrontend;
  throw new Error("dojo_release_competency_seed_app_origin_required");
}

function parseRoles({ rolesJson, roles }) {
  const fromJson = stringOpt(rolesJson);
  if (fromJson) {
    const parsed = JSON.parse(fromJson);
    if (!Array.isArray(parsed)) throw new Error("dojo_release_competency_seed_roles_json_invalid");
    const values = parsed.map((role) => stringOpt(role)).filter(Boolean);
    if (values.length > 0) return [...new Set(values)];
  }
  const values = parseStringList(roles);
  return values.length > 0 ? values : [...DOJO_RELEASE_COMPETENCY_SEED_DEFAULT_ROLES];
}

function parseStringList(value) {
  if (Array.isArray(value)) return [...new Set(value.map((item) => stringOpt(item)).filter(Boolean))];
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index);
}

function summarizeControlPlanePersistence(value) {
  const record = objectOrNull(value);
  if (!record) return null;
  return {
    ok: record.ok === true,
    store_kind: stringOpt(record.store_kind) ?? null,
    status: stringOpt(record.status) ?? null,
    skill_id: stringOpt(record.skill_id) ?? null,
    workflow_id: stringOpt(record.workflow_id) ?? null,
  };
}

function summarizeEvidenceLedgerValidation(value) {
  const record = objectOrNull(value);
  if (!record) return null;
  return {
    ok: record.ok !== false,
    store_kind: stringOpt(record.store_kind) ?? null,
    record_count: Number.isFinite(Number(record.record_count)) ? Number(record.record_count) : null,
    evidence_record_ids: Array.isArray(record.evidence_record_ids)
      ? record.evidence_record_ids.filter((item) => typeof item === "string")
      : [],
  };
}

function summarizeExecutableCheckride(value) {
  const record = objectOrNull(value);
  if (!record) return null;
  return {
    checkride_id: stringOpt(record.checkride_id) ?? null,
    scenario_count: numberOrNull(record.scenario_count),
    passed_scenarios: numberOrNull(record.passed_scenarios),
    failed_scenarios: numberOrNull(record.failed_scenarios),
    blocked_scenarios: numberOrNull(record.blocked_scenarios),
    production_recommendation: stringOpt(record.production_recommendation) ?? null,
  };
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }
    const raw = arg.slice(2);
    const eq = raw.indexOf("=");
    if (eq >= 0) {
      parsed[raw.slice(0, eq)] = raw.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      parsed[raw] = next;
      i += 1;
    } else {
      parsed[raw] = "1";
    }
  }
  return parsed;
}

function originFromOptionalUrl(value) {
  const text = stringOpt(value);
  return text ? originFromUrl(text) : null;
}

function originFromUrl(value) {
  try {
    return new URL(String(value)).origin;
  } catch {
    throw new Error(`dojo_release_competency_seed_origin_invalid:${String(value)}`);
  }
}

function normalizeActorType(value) {
  const text = String(value ?? "").trim();
  if (text === "human" || text === "agent" || text === "service") return text;
  throw new Error("dojo_release_competency_seed_actor_type_invalid");
}

function requiredString(value, name) {
  const text = stringOpt(value);
  if (!text) throw new Error(`dojo_release_competency_seed_${name}_required`);
  return text;
}

function stringOpt(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function objectOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function hashId(value) {
  return sha256(value);
}

function isDirectRun() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}
