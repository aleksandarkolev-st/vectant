import { createHash } from "node:crypto";
import type { DojoGeneratedSourcePatchBundle } from "./patch_bundle.js";
import {
  validateDojoAffordancePrPlan,
  type DojoAffordancePatchOperation,
  type DojoAffordancePrPlan,
} from "./affordance_pr_plan.js";

export interface DojoGeneratedPrCodeOwnerRule {
  path_prefix?: string;
  glob?: string;
  owners: string[];
  review_gate?: string;
}

export interface DojoGeneratedPrArtifactRef {
  kind:
    | "patch_plan"
    | "contract_test"
    | "assurance_case"
    | "training_report"
    | "evidence_manifest"
    | "custom";
  path: string;
  sha256?: string;
}

export interface DojoGeneratedPrOperationSummary {
  operation_id: string;
  kind: DojoAffordancePatchOperation["kind"];
  file_path: string;
  target_component: string;
  affordance_id: string;
  validation_expectation: string;
}

export interface DojoGeneratedPrReviewRequirement {
  requirement_id: string;
  gate: string;
  status: "pending" | "satisfied";
  owners: string[];
  paths: string[];
  operation_ids: string[];
  reason: string;
}

export interface DojoGeneratedPrMetadata {
  schema_version: "synthi.dojo.generatedSourcePrMetadata.v1";
  plan_id: string;
  app_origin: string;
  app_version: string;
  branch_name: string;
  title: string;
  body: string;
  generated_by: string;
  skill_id?: string;
  license_id?: string;
  source_snapshot_id?: string;
  operations: DojoGeneratedPrOperationSummary[];
  required_tests: string[];
  review_requirements: DojoGeneratedPrReviewRequirement[];
  artifact_refs: DojoGeneratedPrArtifactRef[];
  proof_impact: string;
  license_impact: string;
  promotion_blockers: string[];
}

export interface DojoGeneratedPrMetadataIssue {
  issue_id: string;
  severity: "error" | "warning";
  message: string;
}

export interface DojoGeneratedPrMetadataValidation {
  ok: boolean;
  issues: DojoGeneratedPrMetadataIssue[];
}

export interface DojoGeneratedPrBranchFileWrite {
  kind: "source" | "contract_test";
  path: string;
  sha256: string;
  bytes: number;
  operation_ids: string[];
}

export interface DojoGeneratedPrBranchPlan {
  schema_version: "synthi.dojo.generatedSourcePrBranchPlan.v1";
  plan_id: string;
  branch_name: string;
  base_ref?: string;
  checkout_strategy: "create_branch_from_current_head" | "create_branch_from_base_ref";
  file_writes: DojoGeneratedPrBranchFileWrite[];
  required_tests: string[];
  review_requirements: DojoGeneratedPrReviewRequirement[];
  artifact_refs: DojoGeneratedPrArtifactRef[];
  promotion_blockers: string[];
  ready_to_apply: boolean;
}

export function buildDojoGeneratedPrMetadata(input: {
  plan: DojoAffordancePrPlan;
  skill_id?: string;
  license_id?: string;
  source_snapshot_id?: string;
  branch_name?: string;
  branch_prefix?: string;
  generated_by?: string;
  artifact_refs?: DojoGeneratedPrArtifactRef[];
  code_owner_rules?: DojoGeneratedPrCodeOwnerRule[];
}): DojoGeneratedPrMetadata {
  const planValidation = validateDojoAffordancePrPlan(input.plan);
  const operations = input.plan.operations.map((operation) => summarizeOperation(operation));
  const branchName = input.branch_name ?? generatedBranchName(input.plan, input.branch_prefix);
  const artifactRefs = input.artifact_refs ?? [];
  const reviewRequirements = buildReviewRequirements({
    operations: input.plan.operations,
    review_gates: input.plan.review_gates,
    code_owner_rules: input.code_owner_rules ?? [],
  });
  const promotionBlockers = [
    ...planValidation.issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => `affordance_pr_plan:${issue.issue_id}`),
    ...unresolvedCodeOwnerBlockers(reviewRequirements),
  ];
  const proofImpact = proofImpactFor(input.plan.operations);
  const licenseImpact = input.license_id
    ? `License ${input.license_id} requires recertification before source/API substrate promotion.`
    : "A Dojo license must be recertified before source/API substrate promotion.";
  const metadata: DojoGeneratedPrMetadata = {
    schema_version: "synthi.dojo.generatedSourcePrMetadata.v1",
    plan_id: input.plan.plan_id,
    app_origin: input.plan.app_origin,
    app_version: input.plan.app_version,
    branch_name: branchName,
    title: `Dojo source affordance patch: ${input.plan.plan_id}`,
    body: generatedPrBody({
      plan: input.plan,
      operations,
      review_requirements: reviewRequirements,
      proof_impact: proofImpact,
      license_impact: licenseImpact,
      promotion_blockers: promotionBlockers,
      artifact_refs: artifactRefs,
    }),
    generated_by: input.generated_by ?? "agent_dojo",
    ...(input.skill_id ? { skill_id: input.skill_id } : {}),
    ...(input.license_id ? { license_id: input.license_id } : {}),
    ...(input.source_snapshot_id ? { source_snapshot_id: input.source_snapshot_id } : {}),
    operations,
    required_tests: input.plan.required_tests.slice(),
    review_requirements: reviewRequirements,
    artifact_refs: artifactRefs,
    proof_impact: proofImpact,
    license_impact: licenseImpact,
    promotion_blockers: promotionBlockers,
  };
  return metadata;
}

export function buildDojoGeneratedPrBranchPlan(input: {
  metadata: DojoGeneratedPrMetadata;
  patch_bundle: DojoGeneratedSourcePatchBundle;
  base_ref?: string;
}): DojoGeneratedPrBranchPlan {
  const metadataValidation = validateDojoGeneratedPrMetadata(input.metadata);
  const branchBlockers = metadataValidation.issues
    .filter((issue) => issue.severity === "error")
    .map((issue) => `generated_pr_metadata:${issue.issue_id}`);
  const bundleBlockers = input.patch_bundle.issues
    .filter((issue) => issue.severity === "error")
    .map((issue) => `source_patch_bundle:${issue.issue_id}${issue.file_path ? `:${issue.file_path}` : ""}`);
  const fileWrites: DojoGeneratedPrBranchFileWrite[] = [
    ...input.patch_bundle.modified_files.map((file) => ({
      kind: "source" as const,
      path: file.path,
      sha256: file.after_sha256,
      bytes: Buffer.byteLength(file.source, "utf8"),
      operation_ids: file.applied_operations.slice(),
    })),
    ...input.patch_bundle.generated_tests.map((file) => ({
      kind: "contract_test" as const,
      path: file.path,
      sha256: hashFull(file.source),
      bytes: Buffer.byteLength(file.source, "utf8"),
      operation_ids: file.required_operations.slice(),
    })),
  ];
  const promotionBlockers = unique([
    ...input.metadata.promotion_blockers,
    ...branchBlockers,
    ...bundleBlockers,
    ...(fileWrites.length === 0 ? ["generated_pr_branch_plan_no_file_writes"] : []),
  ]);
  return {
    schema_version: "synthi.dojo.generatedSourcePrBranchPlan.v1",
    plan_id: input.metadata.plan_id,
    branch_name: input.metadata.branch_name,
    ...(input.base_ref ? { base_ref: input.base_ref } : {}),
    checkout_strategy: input.base_ref ? "create_branch_from_base_ref" : "create_branch_from_current_head",
    file_writes: fileWrites,
    required_tests: input.metadata.required_tests.slice(),
    review_requirements: input.metadata.review_requirements.map((requirement) => ({
      ...requirement,
      owners: requirement.owners.slice(),
      paths: requirement.paths.slice(),
      operation_ids: requirement.operation_ids.slice(),
    })),
    artifact_refs: input.metadata.artifact_refs.map((artifact) => ({ ...artifact })),
    promotion_blockers: promotionBlockers,
    ready_to_apply: input.patch_bundle.ok && metadataValidation.ok && promotionBlockers.length === 0,
  };
}

export function validateDojoGeneratedPrMetadata(metadata: DojoGeneratedPrMetadata): DojoGeneratedPrMetadataValidation {
  const issues: DojoGeneratedPrMetadataIssue[] = [];
  if (metadata.schema_version !== "synthi.dojo.generatedSourcePrMetadata.v1") {
    issues.push(errorIssue("generated_pr_metadata_schema_invalid", "Unsupported generated PR metadata schema."));
  }
  if (!metadata.plan_id.trim()) issues.push(errorIssue("generated_pr_plan_id_required", "Plan ID is required."));
  if (!isSafeBranchName(metadata.branch_name)) {
    issues.push(errorIssue("generated_pr_branch_name_invalid", "Branch name must be a safe git branch ref segment."));
  }
  if (!metadata.title.trim()) issues.push(errorIssue("generated_pr_title_required", "PR title is required."));
  if (!metadata.body.trim()) issues.push(errorIssue("generated_pr_body_required", "PR body is required."));
  if (metadata.operations.length === 0) {
    issues.push(errorIssue("generated_pr_operation_required", "Generated PR metadata must include at least one operation."));
  }
  for (const requirement of metadata.review_requirements) {
    if (!requirement.requirement_id.trim()) {
      issues.push(errorIssue("generated_pr_review_requirement_id_required", "Review requirement ID is required."));
    }
    if (!requirement.gate.trim()) {
      issues.push(errorIssue("generated_pr_review_gate_required", "Review gate is required."));
    }
    if (requirement.paths.length === 0) {
      issues.push(errorIssue("generated_pr_review_paths_required", "Review requirement must name affected paths."));
    }
  }
  return {
    ok: issues.every((issue) => issue.severity !== "error"),
    issues,
  };
}

function summarizeOperation(operation: DojoAffordancePatchOperation): DojoGeneratedPrOperationSummary {
  return {
    operation_id: operation.operation_id,
    kind: operation.kind,
    file_path: operation.file_path,
    target_component: operation.target_component,
    affordance_id: operation.affordance_id,
    validation_expectation: operation.validation_expectation,
  };
}

function buildReviewRequirements(input: {
  operations: DojoAffordancePatchOperation[];
  review_gates: string[];
  code_owner_rules: DojoGeneratedPrCodeOwnerRule[];
}): DojoGeneratedPrReviewRequirement[] {
  const gates = unique(input.review_gates.filter((gate) => gate.trim()).map((gate) => gate.trim()));
  return gates.map((gate) => {
    const scopedOperations = operationsForGate(input.operations, gate);
    const paths = unique(scopedOperations.map((operation) => operation.file_path));
    return {
      requirement_id: `review_${slug(gate)}`,
      gate,
      status: "pending",
      owners: ownersForPaths(paths, gate, input.code_owner_rules),
      paths,
      operation_ids: scopedOperations.map((operation) => operation.operation_id),
      reason: reviewReason(gate),
    };
  });
}

function operationsForGate(
  operations: DojoAffordancePatchOperation[],
  gate: string
): DojoAffordancePatchOperation[] {
  const normalized = gate.toLowerCase();
  if (normalized.includes("security") || normalized.includes("policy")) {
    const risky = operations.filter((operation) => operation.kind === "proof_hook" || operation.kind === "risk_annotation");
    return risky.length > 0 ? risky : operations;
  }
  return operations;
}

function ownersForPaths(paths: string[], gate: string, rules: DojoGeneratedPrCodeOwnerRule[]): string[] {
  if (!gate.toLowerCase().includes("code_owner")) return [];
  return unique(paths.flatMap((filePath) => rules
    .filter((rule) => ruleMatchesPath(rule, filePath) && gateMatchesRule(rule, gate))
    .flatMap((rule) => rule.owners)));
}

function unresolvedCodeOwnerBlockers(requirements: DojoGeneratedPrReviewRequirement[]): string[] {
  return requirements
    .filter((requirement) => requirement.gate.toLowerCase().includes("code_owner") && requirement.owners.length === 0)
    .flatMap((requirement) => requirement.paths.map((filePath) => `generated_pr_code_owner_unresolved:${filePath}`));
}

function gateMatchesRule(rule: DojoGeneratedPrCodeOwnerRule, gate: string): boolean {
  return !rule.review_gate || rule.review_gate === gate;
}

function ruleMatchesPath(rule: DojoGeneratedPrCodeOwnerRule, filePath: string): boolean {
  const normalized = normalizePath(filePath);
  if (rule.path_prefix && normalized.startsWith(normalizePath(rule.path_prefix))) return true;
  if (rule.glob && globToRegExp(rule.glob).test(normalized)) return true;
  return false;
}

function generatedBranchName(plan: DojoAffordancePrPlan, branchPrefix?: string): string {
  const prefix = normalizeBranchPrefix(branchPrefix ?? "dojo/source-affordance");
  const suffix = `${slug(plan.plan_id)}-${hash(`${plan.app_origin}:${plan.app_version}:${plan.operations.map((operation) => operation.operation_id).join(":")}`)}`;
  return `${prefix}/${suffix}`;
}

function normalizeBranchPrefix(prefix: string): string {
  return prefix
    .split("/")
    .map((part) => slug(part))
    .filter(Boolean)
    .join("/") || "dojo/source-affordance";
}

function generatedPrBody(input: {
  plan: DojoAffordancePrPlan;
  operations: DojoGeneratedPrOperationSummary[];
  review_requirements: DojoGeneratedPrReviewRequirement[];
  proof_impact: string;
  license_impact: string;
  promotion_blockers: string[];
  artifact_refs: DojoGeneratedPrArtifactRef[];
}): string {
  const operationLines = input.operations.map((operation) =>
    `- ${operation.operation_id}: ${operation.kind} in ${operation.file_path} for ${operation.target_component}.`
  );
  const testLines = input.plan.required_tests.map((test) => `- ${test}`);
  const reviewLines = input.review_requirements.map((requirement) => {
    const owners = requirement.owners.length ? requirement.owners.join(", ") : "unresolved";
    return `- ${requirement.gate}: ${requirement.status}; owners=${owners}; paths=${requirement.paths.join(", ")}.`;
  });
  const blockerLines = input.promotion_blockers.length
    ? input.promotion_blockers.map((blocker) => `- ${blocker}`)
    : ["- none"];
  const artifactLines = input.artifact_refs.length
    ? input.artifact_refs.map((artifact) => `- ${artifact.kind}: ${artifact.path}`)
    : ["- none"];
  return [
    "## Dojo Generated Source Patch",
    "",
    `Plan: ${input.plan.plan_id}`,
    `App: ${input.plan.app_origin} @ ${input.plan.app_version}`,
    "",
    "## Operations",
    ...operationLines,
    "",
    "## Required Tests",
    ...testLines,
    "",
    "## Review Gates",
    ...reviewLines,
    "",
    "## Proof Impact",
    input.proof_impact,
    "",
    "## License Impact",
    input.license_impact,
    "",
    "## Promotion Blockers",
    ...blockerLines,
    "",
    "## Artifacts",
    ...artifactLines,
  ].join("\n");
}

function proofImpactFor(operations: DojoAffordancePatchOperation[]): string {
  const proofHookCount = operations.filter((operation) => operation.kind === "proof_hook").length;
  if (proofHookCount === 0) return "No proof hook operation is included in this generated source patch.";
  return `${proofHookCount} proof hook operation${proofHookCount === 1 ? "" : "s"} must remain bound to the reviewed target affordance.`;
}

function isSafeBranchName(value: string): boolean {
  if (!value.trim()) return false;
  if (value.startsWith("/") || value.endsWith("/") || value.includes("..") || value.includes("//")) return false;
  return /^[A-Za-z0-9._/-]+$/.test(value);
}

function globToRegExp(glob: string): RegExp {
  const normalized = normalizePath(glob);
  let body = "";
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    const next = normalized[i + 1];
    if (char === "*" && next === "*") {
      body += ".*";
      i += 1;
    } else if (char === "*") {
      body += "[^/]*";
    } else {
      body += escapeRegExp(char ?? "");
    }
  }
  return new RegExp(`^${body}$`);
}

function reviewReason(gate: string): string {
  const normalized = gate.toLowerCase();
  if (normalized.includes("code_owner")) return "Code owner review is required for generated source changes.";
  if (normalized.includes("security") || normalized.includes("policy")) return "Security or policy review is required for risky generated affordance changes.";
  if (normalized.includes("checkride")) return "Dojo checkride evidence must be refreshed after source changes.";
  return "Review gate declared by the source affordance plan.";
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "generated-pr";
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function hashFull(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function errorIssue(issueId: string, message: string): DojoGeneratedPrMetadataIssue {
  return {
    issue_id: issueId,
    severity: "error",
    message,
  };
}
