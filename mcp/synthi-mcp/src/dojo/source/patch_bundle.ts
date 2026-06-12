import { createHash } from "node:crypto";
import path from "node:path";
import type { DojoAffordancePatchOperation, DojoAffordancePrPlan } from "./affordance_pr_plan.js";
import {
  applyReactAffordanceCodemodPlan,
  evaluateReactAffordanceContract,
  generateReactAffordanceVitestContractTest,
  type DojoGeneratedReactAffordanceTest,
} from "./codemod.js";

export interface DojoSourcePatchInputFile {
  path: string;
  source: string;
}

export interface DojoSourcePatchModifiedFile {
  path: string;
  source: string;
  before_sha256: string;
  after_sha256: string;
  changed: boolean;
  applied_operations: string[];
  skipped_operations: string[];
}

export interface DojoSourcePatchBundleIssue {
  issue_id: string;
  severity: "error" | "warning";
  file_path?: string;
  operation_id?: string;
  message: string;
}

export interface DojoGeneratedSourcePatchBundle {
  schema_version: "synthi.dojo.generatedSourcePatchBundle.v1";
  plan_id: string;
  app_origin: string;
  app_version: string;
  modified_files: DojoSourcePatchModifiedFile[];
  generated_tests: DojoGeneratedReactAffordanceTest[];
  issues: DojoSourcePatchBundleIssue[];
  ok: boolean;
}

export function buildDojoGeneratedSourcePatchBundle(input: {
  plan: DojoAffordancePrPlan;
  files: DojoSourcePatchInputFile[];
  test_path_for_source?: (sourceFilePath: string, componentName: string) => string;
}): DojoGeneratedSourcePatchBundle {
  const fileMap = new Map(input.files.map((file) => [normalizePath(file.path), file.source]));
  const operationsByFile = groupOperationsByFile(input.plan.operations);
  const modifiedFiles: DojoSourcePatchModifiedFile[] = [];
  const generatedTests: DojoGeneratedReactAffordanceTest[] = [];
  const issues: DojoSourcePatchBundleIssue[] = [];

  for (const [filePath, operations] of operationsByFile) {
    const before = fileMap.get(filePath);
    if (before === undefined) {
      issues.push(errorIssue("source_patch_file_missing", `Source file is missing for generated patch: ${filePath}`, filePath));
      continue;
    }
    let patched;
    try {
      patched = applyReactAffordanceCodemodPlan(before, operations);
    } catch (err) {
      issues.push(errorIssue(
        "source_patch_apply_failed",
        err instanceof Error ? err.message : String(err),
        filePath
      ));
      continue;
    }
    const contract = evaluateReactAffordanceContract(patched.source, operations);
    if (!contract.ok) {
      for (const missing of contract.missing_operations) {
        issues.push(errorIssue(
          "source_patch_contract_missing",
          `Generated patch did not satisfy ${missing.expected}.`,
          filePath,
          missing.operation_id
        ));
      }
    }
    modifiedFiles.push({
      path: filePath,
      source: patched.source,
      before_sha256: sha256(before),
      after_sha256: sha256(patched.source),
      changed: patched.changed,
      applied_operations: patched.applied_operations,
      skipped_operations: patched.skipped_operations,
    });
    for (const [componentName, componentOperations] of groupOperationsByComponent(operations)) {
      const testPath = input.test_path_for_source?.(filePath, componentName) ?? defaultContractTestPath(filePath, componentName);
      generatedTests.push(generateReactAffordanceVitestContractTest({
        source_file_path: filePath,
        test_file_path: testPath,
        component_name: componentName,
        operations: componentOperations,
      }));
    }
  }

  return {
    schema_version: "synthi.dojo.generatedSourcePatchBundle.v1",
    plan_id: input.plan.plan_id,
    app_origin: input.plan.app_origin,
    app_version: input.plan.app_version,
    modified_files: modifiedFiles,
    generated_tests: generatedTests,
    issues,
    ok: issues.every((issue) => issue.severity !== "error"),
  };
}

function groupOperationsByFile(operations: DojoAffordancePatchOperation[]): Map<string, DojoAffordancePatchOperation[]> {
  const grouped = new Map<string, DojoAffordancePatchOperation[]>();
  for (const operation of operations) {
    const filePath = normalizePath(operation.file_path);
    const list = grouped.get(filePath) ?? [];
    list.push({ ...operation, file_path: filePath });
    grouped.set(filePath, list);
  }
  return grouped;
}

function groupOperationsByComponent(operations: DojoAffordancePatchOperation[]): Map<string, DojoAffordancePatchOperation[]> {
  const grouped = new Map<string, DojoAffordancePatchOperation[]>();
  for (const operation of operations) {
    const list = grouped.get(operation.target_component) ?? [];
    list.push(operation);
    grouped.set(operation.target_component, list);
  }
  return grouped;
}

function defaultContractTestPath(sourceFilePath: string, componentName: string): string {
  const parsed = path.posix.parse(normalizePath(sourceFilePath));
  const componentToken = slug(componentName || parsed.name);
  return path.posix.join(parsed.dir, "__tests__", `${componentToken}.dojo-affordance.test.ts`);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "affordance";
}

function errorIssue(
  issueId: string,
  message: string,
  filePath?: string,
  operationId?: string
): DojoSourcePatchBundleIssue {
  return {
    issue_id: issueId,
    severity: "error",
    ...(filePath ? { file_path: filePath } : {}),
    ...(operationId ? { operation_id: operationId } : {}),
    message,
  };
}
