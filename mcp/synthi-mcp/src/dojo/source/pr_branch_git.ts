import { spawn } from "node:child_process";
import path from "node:path";
import type { DojoGeneratedSourcePatchBundle } from "./patch_bundle.js";
import type { DojoGeneratedPrBranchPlan } from "./pr_generator.js";
import {
  applyDojoGeneratedPrBranchPlan,
  type DojoGeneratedPrBranchApplyResult,
} from "./pr_branch_applier.js";

export interface DojoGeneratedPrGitCommandResult {
  args: string[];
  exit_code: number;
  stdout_tail: string;
  stderr_tail: string;
}

export interface DojoGeneratedPrGitBranchIssue {
  issue_id: string;
  severity: "error" | "warning";
  message: string;
}

export interface DojoGeneratedPrGitBranchResult {
  schema_version: "synthi.dojo.generatedPrGitBranchResult.v1";
  repository_root: string;
  branch_name: string;
  previous_ref?: string;
  dry_run: boolean;
  commands: DojoGeneratedPrGitCommandResult[];
  apply_result?: DojoGeneratedPrBranchApplyResult;
  issues: DojoGeneratedPrGitBranchIssue[];
  ok: boolean;
}

export async function createDojoGeneratedPrGitBranch(input: {
  branch_plan: DojoGeneratedPrBranchPlan;
  patch_bundle: DojoGeneratedSourcePatchBundle;
  repository_root: string;
  dry_run?: boolean;
  allow_dirty_worktree?: boolean;
  git_bin?: string;
}): Promise<DojoGeneratedPrGitBranchResult> {
  const repositoryRoot = path.resolve(input.repository_root);
  const dryRun = input.dry_run === true;
  const gitBin = input.git_bin || "git";
  const commands: DojoGeneratedPrGitCommandResult[] = [];
  const issues: DojoGeneratedPrGitBranchIssue[] = [];

  const preflightApply = await applyDojoGeneratedPrBranchPlan({
    branch_plan: input.branch_plan,
    patch_bundle: input.patch_bundle,
    workspace_root: repositoryRoot,
    dry_run: true,
  });
  if (!preflightApply.ok) {
    issues.push(...preflightApply.issues.map((issue) => ({
      issue_id: `generated_pr_branch_apply_preflight:${issue.issue_id}`,
      severity: issue.severity,
      message: issue.path ? `${issue.path}: ${issue.message}` : issue.message,
    })));
    return result({ repositoryRoot, branchPlan: input.branch_plan, dryRun, commands, issues, applyResult: preflightApply });
  }

  const repoCheck = await runGit(gitBin, ["rev-parse", "--show-toplevel"], repositoryRoot);
  commands.push(repoCheck);
  if (repoCheck.exit_code !== 0) {
    issues.push(errorIssue("generated_pr_git_repository_invalid", "Repository root is not inside a git worktree."));
    return result({ repositoryRoot, branchPlan: input.branch_plan, dryRun, commands, issues, applyResult: preflightApply });
  }
  const actualRoot = path.resolve(repoCheck.stdout_tail.trim());
  if (!samePath(actualRoot, repositoryRoot)) {
    issues.push(errorIssue(
      "generated_pr_git_repository_root_mismatch",
      `Repository root resolved to ${actualRoot}, not ${repositoryRoot}.`
    ));
    return result({ repositoryRoot, branchPlan: input.branch_plan, dryRun, commands, issues, applyResult: preflightApply });
  }

  const previousRefResult = await runGit(gitBin, ["rev-parse", "--abbrev-ref", "HEAD"], repositoryRoot);
  commands.push(previousRefResult);
  const previousRef = previousRefResult.exit_code === 0 ? previousRefResult.stdout_tail.trim() : undefined;

  const dirtyResult = await runGit(gitBin, ["status", "--porcelain"], repositoryRoot);
  commands.push(dirtyResult);
  if (dirtyResult.exit_code !== 0) {
    issues.push(errorIssue("generated_pr_git_status_failed", "Could not inspect git worktree status."));
    return result({ repositoryRoot, branchPlan: input.branch_plan, dryRun, commands, issues, previousRef, applyResult: preflightApply });
  }
  if (dirtyResult.stdout_tail.trim() && input.allow_dirty_worktree !== true) {
    issues.push(errorIssue("generated_pr_git_worktree_dirty", "Generated PR branch creation requires a clean worktree unless explicitly allowed."));
    return result({ repositoryRoot, branchPlan: input.branch_plan, dryRun, commands, issues, previousRef, applyResult: preflightApply });
  }

  const branchExistsResult = await runGit(gitBin, ["rev-parse", "--verify", "--quiet", `refs/heads/${input.branch_plan.branch_name}`], repositoryRoot);
  commands.push(branchExistsResult);
  if (branchExistsResult.exit_code === 0) {
    issues.push(errorIssue("generated_pr_git_branch_exists", `Branch already exists: ${input.branch_plan.branch_name}.`));
    return result({ repositoryRoot, branchPlan: input.branch_plan, dryRun, commands, issues, previousRef, applyResult: preflightApply });
  }

  if (dryRun) {
    return result({ repositoryRoot, branchPlan: input.branch_plan, dryRun, commands, issues, previousRef, applyResult: preflightApply });
  }

  const switchArgs = input.branch_plan.base_ref
    ? ["switch", "--create", input.branch_plan.branch_name, input.branch_plan.base_ref]
    : ["switch", "--create", input.branch_plan.branch_name];
  const switchResult = await runGit(gitBin, switchArgs, repositoryRoot);
  commands.push(switchResult);
  if (switchResult.exit_code !== 0) {
    issues.push(errorIssue("generated_pr_git_branch_switch_failed", `Could not create generated PR branch ${input.branch_plan.branch_name}.`));
    return result({ repositoryRoot, branchPlan: input.branch_plan, dryRun, commands, issues, previousRef, applyResult: preflightApply });
  }

  const applyResult = await applyDojoGeneratedPrBranchPlan({
    branch_plan: input.branch_plan,
    patch_bundle: input.patch_bundle,
    workspace_root: repositoryRoot,
  });
  if (!applyResult.ok) {
    issues.push(...applyResult.issues.map((issue) => ({
      issue_id: `generated_pr_branch_apply:${issue.issue_id}`,
      severity: issue.severity,
      message: issue.path ? `${issue.path}: ${issue.message}` : issue.message,
    })));
  }

  return result({ repositoryRoot, branchPlan: input.branch_plan, dryRun, commands, issues, previousRef, applyResult });
}

function result(input: {
  repositoryRoot: string;
  branchPlan: DojoGeneratedPrBranchPlan;
  dryRun: boolean;
  commands: DojoGeneratedPrGitCommandResult[];
  issues: DojoGeneratedPrGitBranchIssue[];
  previousRef?: string;
  applyResult?: DojoGeneratedPrBranchApplyResult;
}): DojoGeneratedPrGitBranchResult {
  return {
    schema_version: "synthi.dojo.generatedPrGitBranchResult.v1",
    repository_root: input.repositoryRoot,
    branch_name: input.branchPlan.branch_name,
    ...(input.previousRef ? { previous_ref: input.previousRef } : {}),
    dry_run: input.dryRun,
    commands: input.commands,
    ...(input.applyResult ? { apply_result: input.applyResult } : {}),
    issues: input.issues,
    ok: input.issues.every((issue) => issue.severity !== "error"),
  };
}

async function runGit(gitBin: string, args: string[], cwd: string): Promise<DojoGeneratedPrGitCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(gitBin, args, {
      cwd,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({
        args,
        exit_code: 1,
        stdout_tail: tail(stdout),
        stderr_tail: tail(stderr || error.message),
      });
    });
    child.on("close", (code) => {
      resolve({
        args,
        exit_code: code ?? 1,
        stdout_tail: tail(stdout),
        stderr_tail: tail(stderr),
      });
    });
  });
}

function samePath(left: string, right: string): boolean {
  return path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase();
}

function tail(value: string): string {
  const text = value.trim();
  return text.length > 1200 ? text.slice(-1200) : text;
}

function errorIssue(issueId: string, message: string): DojoGeneratedPrGitBranchIssue {
  return {
    issue_id: issueId,
    severity: "error",
    message,
  };
}
