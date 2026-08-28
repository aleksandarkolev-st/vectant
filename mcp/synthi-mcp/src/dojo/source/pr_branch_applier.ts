import { createHash } from "node:crypto";
import path from "node:path";
import type { DojoGeneratedSourcePatchBundle } from "./patch_bundle.js";
import type { DojoGeneratedPrBranchFileWrite, DojoGeneratedPrBranchPlan } from "./pr_generator.js";
import {
  writeDojoGeneratedSourcePatchBundle,
  type DojoSourcePatchWriteResult,
} from "./patch_writer.js";

export interface DojoGeneratedPrBranchApplyIssue {
  issue_id: string;
  severity: "error" | "warning";
  path?: string;
  message: string;
}

export interface DojoGeneratedPrBranchAppliedFile {
  kind: "source" | "contract_test";
  path: string;
  sha256: string;
  bytes: number;
  written: boolean;
}

export interface DojoGeneratedPrBranchApplyResult {
  schema_version: "synthi.dojo.generatedPrBranchApplyResult.v1";
  plan_id: string;
  branch_name: string;
  base_ref?: string;
  checkout_strategy: DojoGeneratedPrBranchPlan["checkout_strategy"];
  workspace_root: string;
  dry_run: boolean;
  applied_files: DojoGeneratedPrBranchAppliedFile[];
  required_tests: string[];
  issues: DojoGeneratedPrBranchApplyIssue[];
  write_result?: DojoSourcePatchWriteResult;
  ok: boolean;
}

export async function applyDojoGeneratedPrBranchPlan(input: {
  branch_plan: DojoGeneratedPrBranchPlan;
  patch_bundle: DojoGeneratedSourcePatchBundle;
  workspace_root: string;
  dry_run?: boolean;
}): Promise<DojoGeneratedPrBranchApplyResult> {
  const workspaceRoot = path.resolve(input.workspace_root);
  const dryRun = input.dry_run === true;
  const issues: DojoGeneratedPrBranchApplyIssue[] = validateBranchPlanAgainstBundle(input.branch_plan, input.patch_bundle);

  if (issues.some((issue) => issue.severity === "error")) {
    return result({
      branchPlan: input.branch_plan,
      workspaceRoot,
      dryRun,
      appliedFiles: [],
      issues,
    });
  }

  const writeResult = await writeDojoGeneratedSourcePatchBundle({
    bundle: input.patch_bundle,
    workspace_root: workspaceRoot,
    dry_run: dryRun,
  });
  issues.push(...writeResult.issues.map((issue) => ({
    issue_id: `source_patch_writer:${issue.issue_id}`,
    severity: issue.severity,
    ...(issue.path ? { path: issue.path } : {}),
    message: issue.message,
  })));

  const appliedFiles = writeResult.written_files.map((file) => ({
    kind: file.kind,
    path: file.path,
    sha256: file.sha256,
    bytes: file.bytes,
    written: file.written,
  }));

  return result({
    branchPlan: input.branch_plan,
    workspaceRoot,
    dryRun,
    appliedFiles,
    issues,
    writeResult,
  });
}

function validateBranchPlanAgainstBundle(
  branchPlan: DojoGeneratedPrBranchPlan,
  bundle: DojoGeneratedSourcePatchBundle
): DojoGeneratedPrBranchApplyIssue[] {
  const issues: DojoGeneratedPrBranchApplyIssue[] = [];
  if (branchPlan.schema_version !== "synthi.dojo.generatedSourcePrBranchPlan.v1") {
    issues.push(errorIssue("generated_pr_branch_plan_schema_invalid", "Unsupported generated PR branch plan schema."));
  }
  if (!isSafeBranchName(branchPlan.branch_name)) {
    issues.push(errorIssue("generated_pr_branch_name_invalid", "Generated PR branch name is not a safe git ref."));
  }
  if (branchPlan.plan_id !== bundle.plan_id) {
    issues.push(errorIssue(
      "generated_pr_branch_plan_bundle_plan_mismatch",
      `Branch plan ${branchPlan.plan_id} does not match patch bundle ${bundle.plan_id}.`
    ));
  }
  if (!branchPlan.ready_to_apply) {
    issues.push(errorIssue(
      "generated_pr_branch_plan_not_ready",
      "Generated PR branch plan is not ready to apply; review promotion blockers before writing files."
    ));
  }
  for (const blocker of branchPlan.promotion_blockers) {
    issues.push(errorIssue(
      "generated_pr_branch_plan_promotion_blocker",
      `Generated PR branch plan has promotion blocker: ${blocker}.`
    ));
  }
  if (!bundle.ok) {
    issues.push(errorIssue("generated_pr_branch_patch_bundle_invalid", "Patch bundle is not valid."));
  }

  const expectedWrites = expectedWritesForBundle(bundle);
  const expectedByPath = new Map(expectedWrites.map((file) => [file.path, file]));
  const plannedByPath = new Map(branchPlan.file_writes.map((file) => [file.path, file]));

  for (const expected of expectedWrites) {
    const planned = plannedByPath.get(expected.path);
    if (!planned) {
      issues.push(errorIssue("generated_pr_branch_file_write_missing", `Branch plan is missing ${expected.path}.`, expected.path));
      continue;
    }
    issues.push(...comparePlannedWrite(planned, expected));
  }
  for (const planned of branchPlan.file_writes) {
    if (!expectedByPath.has(planned.path)) {
      issues.push(errorIssue("generated_pr_branch_file_write_extra", `Branch plan includes undeclared file ${planned.path}.`, planned.path));
    }
  }

  return issues;
}

function comparePlannedWrite(
  planned: DojoGeneratedPrBranchFileWrite,
  expected: DojoGeneratedPrBranchFileWrite
): DojoGeneratedPrBranchApplyIssue[] {
  const issues: DojoGeneratedPrBranchApplyIssue[] = [];
  if (planned.kind !== expected.kind) {
    issues.push(errorIssue("generated_pr_branch_file_kind_mismatch", `File kind mismatch for ${planned.path}.`, planned.path));
  }
  if (planned.sha256 !== expected.sha256) {
    issues.push(errorIssue("generated_pr_branch_file_hash_mismatch", `File hash mismatch for ${planned.path}.`, planned.path));
  }
  if (planned.bytes !== expected.bytes) {
    issues.push(errorIssue("generated_pr_branch_file_size_mismatch", `File byte count mismatch for ${planned.path}.`, planned.path));
  }
  if (planned.operation_ids.join("\0") !== expected.operation_ids.join("\0")) {
    issues.push(errorIssue("generated_pr_branch_file_operation_mismatch", `Operation IDs mismatch for ${planned.path}.`, planned.path));
  }
  return issues;
}

function expectedWritesForBundle(bundle: DojoGeneratedSourcePatchBundle): DojoGeneratedPrBranchFileWrite[] {
  return [
    ...bundle.modified_files.map((file) => ({
      kind: "source" as const,
      path: file.path,
      sha256: file.after_sha256,
      bytes: Buffer.byteLength(file.source, "utf8"),
      operation_ids: file.applied_operations.slice(),
    })),
    ...bundle.generated_tests.map((file) => ({
      kind: "contract_test" as const,
      path: file.path,
      sha256: sha256(file.source),
      bytes: Buffer.byteLength(file.source, "utf8"),
      operation_ids: file.required_operations.slice(),
    })),
  ];
}

function result(input: {
  branchPlan: DojoGeneratedPrBranchPlan;
  workspaceRoot: string;
  dryRun: boolean;
  appliedFiles: DojoGeneratedPrBranchAppliedFile[];
  issues: DojoGeneratedPrBranchApplyIssue[];
  writeResult?: DojoSourcePatchWriteResult;
}): DojoGeneratedPrBranchApplyResult {
  return {
    schema_version: "synthi.dojo.generatedPrBranchApplyResult.v1",
    plan_id: input.branchPlan.plan_id,
    branch_name: input.branchPlan.branch_name,
    ...(input.branchPlan.base_ref ? { base_ref: input.branchPlan.base_ref } : {}),
    checkout_strategy: input.branchPlan.checkout_strategy,
    workspace_root: input.workspaceRoot,
    dry_run: input.dryRun,
    applied_files: input.appliedFiles,
    required_tests: input.branchPlan.required_tests.slice(),
    issues: input.issues,
    ...(input.writeResult ? { write_result: input.writeResult } : {}),
    ok: input.issues.every((issue) => issue.severity !== "error"),
  };
}

function isSafeBranchName(value: string): boolean {
  if (!value.trim()) return false;
  if (value.startsWith("/") || value.endsWith("/") || value.includes("..") || value.includes("//")) return false;
  return /^[A-Za-z0-9._/-]+$/.test(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorIssue(issueId: string, message: string, filePath?: string): DojoGeneratedPrBranchApplyIssue {
  return {
    issue_id: issueId,
    severity: "error",
    ...(filePath ? { path: filePath } : {}),
    message,
  };
}
