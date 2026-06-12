import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DojoGeneratedSourcePatchBundle } from "./patch_bundle.js";

export type DojoSourcePatchWrittenFileKind = "source" | "contract_test";

export interface DojoSourcePatchWrittenFile {
  kind: DojoSourcePatchWrittenFileKind;
  path: string;
  absolute_path: string;
  sha256: string;
  bytes: number;
  written: boolean;
}

export interface DojoSourcePatchWriteIssue {
  issue_id: string;
  severity: "error" | "warning";
  path?: string;
  message: string;
}

export interface DojoSourcePatchWriteResult {
  schema_version: "synthi.dojo.sourcePatchWriteResult.v1";
  plan_id: string;
  workspace_root: string;
  written_files: DojoSourcePatchWrittenFile[];
  issues: DojoSourcePatchWriteIssue[];
  ok: boolean;
}

export async function writeDojoGeneratedSourcePatchBundle(input: {
  bundle: DojoGeneratedSourcePatchBundle;
  workspace_root: string;
  dry_run?: boolean;
}): Promise<DojoSourcePatchWriteResult> {
  const root = path.resolve(input.workspace_root);
  const issues: DojoSourcePatchWriteIssue[] = [];
  const writtenFiles: DojoSourcePatchWrittenFile[] = [];

  if (!input.bundle.ok) {
    issues.push(errorIssue("source_patch_bundle_invalid", "Generated source patch bundle is not valid; refusing to write files."));
    return result(input.bundle.plan_id, root, writtenFiles, issues);
  }

  const artifacts = [
    ...input.bundle.modified_files.map((file) => ({
      kind: "source" as const,
      path: file.path,
      source: file.source,
      expected_sha256: file.after_sha256,
    })),
    ...input.bundle.generated_tests.map((file) => ({
      kind: "contract_test" as const,
      path: file.path,
      source: file.source,
      expected_sha256: sha256(file.source),
    })),
  ];

  const seenPaths = new Set<string>();
  for (const artifact of artifacts) {
    const normalizedPath = normalizeBundlePath(artifact.path);
    if (seenPaths.has(normalizedPath)) {
      issues.push(errorIssue("source_patch_duplicate_output_path", `Patch bundle contains duplicate writes for ${normalizedPath}.`, normalizedPath));
      continue;
    }
    seenPaths.add(normalizedPath);
  }
  if (issues.some((issue) => issue.severity === "error")) {
    return result(input.bundle.plan_id, root, writtenFiles, issues);
  }

  for (const artifact of artifacts) {
    const safePath = resolveSafeBundlePath(root, artifact.path);
    if (!safePath.ok) {
      issues.push(errorIssue(safePath.issue_id, safePath.message, artifact.path));
      continue;
    }
    if (sha256(artifact.source) !== artifact.expected_sha256) {
      issues.push(errorIssue("source_patch_artifact_hash_mismatch", `Patch artifact hash does not match bundle metadata for ${artifact.path}.`, artifact.path));
      continue;
    }
    if (!input.dry_run) {
      await atomicWriteText(safePath.absolute_path, artifact.source);
      const onDisk = await readFile(safePath.absolute_path, "utf8");
      const onDiskHash = sha256(onDisk);
      if (onDiskHash !== artifact.expected_sha256) {
        issues.push(errorIssue("source_patch_write_verification_failed", `Written artifact hash does not match expected bundle hash for ${artifact.path}.`, artifact.path));
        continue;
      }
    }
    writtenFiles.push({
      kind: artifact.kind,
      path: safePath.bundle_path,
      absolute_path: safePath.absolute_path,
      sha256: artifact.expected_sha256,
      bytes: Buffer.byteLength(artifact.source, "utf8"),
      written: !input.dry_run,
    });
  }

  return result(input.bundle.plan_id, root, writtenFiles, issues);
}

function result(
  planId: string,
  workspaceRoot: string,
  writtenFiles: DojoSourcePatchWrittenFile[],
  issues: DojoSourcePatchWriteIssue[]
): DojoSourcePatchWriteResult {
  return {
    schema_version: "synthi.dojo.sourcePatchWriteResult.v1",
    plan_id: planId,
    workspace_root: workspaceRoot,
    written_files: writtenFiles,
    issues,
    ok: issues.every((issue) => issue.severity !== "error"),
  };
}

async function atomicWriteText(targetPath: string, source: string): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, source, "utf8");
  await rename(temporaryPath, targetPath);
}

function resolveSafeBundlePath(root: string, value: string): {
  ok: true;
  bundle_path: string;
  absolute_path: string;
} | {
  ok: false;
  issue_id: string;
  message: string;
} {
  const normalized = normalizeBundlePath(value);
  if (!normalized) {
    return {
      ok: false,
      issue_id: "source_patch_path_empty",
      message: "Patch artifact path is empty.",
    };
  }
  if (normalized.includes("\0") || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    return {
      ok: false,
      issue_id: "source_patch_path_absolute",
      message: `Patch artifact path must be relative to the workspace root: ${value}`,
    };
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || !segment.trim())) {
    return {
      ok: false,
      issue_id: "source_patch_path_unsafe",
      message: `Patch artifact path must not contain traversal or empty segments: ${value}`,
    };
  }
  const absolutePath = path.resolve(root, ...segments);
  const relative = path.relative(root, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return {
      ok: false,
      issue_id: "source_patch_path_outside_root",
      message: `Patch artifact path resolves outside the workspace root: ${value}`,
    };
  }
  return {
    ok: true,
    bundle_path: normalized,
    absolute_path: absolutePath,
  };
}

function normalizeBundlePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorIssue(issueId: string, message: string, artifactPath?: string): DojoSourcePatchWriteIssue {
  return {
    issue_id: issueId,
    severity: "error",
    ...(artifactPath ? { path: artifactPath } : {}),
    message,
  };
}
