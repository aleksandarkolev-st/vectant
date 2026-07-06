#!/usr/bin/env node
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_COPY_EXCLUDES = new Set([
  '.git',
  '.next',
  'coverage',
  'dist',
  'node_modules',
  'tmp',
]);

const DEFAULT_ALLOWED_BINARIES = [
  'git',
  'node',
  'npm',
  'npx',
  'pnpm',
  'tsc',
  'vitest',
  'yarn',
  process.execPath,
];

const SAFE_ENV_KEYS = [
  'CI',
  'HOME',
  'LANG',
  'LC_ALL',
  'NODE_ENV',
  'NODE_PATH',
  'PATH',
  'PLAYWRIGHT_BROWSERS_PATH',
  'TEMP',
  'TMP',
  'TMPDIR',
  'TZ',
];

const SECRET_PATTERNS = [
  { name: 'github_token', pattern: /gh[pousr]_[A-Za-z0-9_]{20,}/g },
  { name: 'openai_key', pattern: /sk-[A-Za-z0-9_-]{20,}/g },
  { name: 'bearer_token', pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi },
  { name: 'private_key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
];

function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function tail(value, limit = 6000) {
  const text = String(value || '');
  return text.length > limit ? text.slice(-limit) : text;
}

function redact(value) {
  let text = String(value || '');
  const counts = {};
  for (const { name, pattern } of SECRET_PATTERNS) {
    text = text.replace(pattern, () => {
      counts[name] = (counts[name] || 0) + 1;
      return `[REDACTED:${name}]`;
    });
  }
  return { text, counts };
}

function mergeCounts(...items) {
  const merged = {};
  for (const item of items) {
    for (const [key, value] of Object.entries(item || {})) {
      merged[key] = (merged[key] || 0) + value;
    }
  }
  return merged;
}

async function readStdin() {
  if (process.stdin.isTTY) return {};
  const input = fsSync.readFileSync(0, 'utf8');
  return input ? JSON.parse(input) : {};
}

function normalizeStrategy(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
}

function workspaceRoot() {
  const cwd = process.cwd();
  return path.basename(cwd) === 'synthi' ? path.dirname(cwd) : cwd;
}

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function allowedRoot() {
  return path.resolve(process.env.SYNTHI_CODESITE_SHADOW_RUNNER_ALLOWED_ROOT || workspaceRoot());
}

function resolveInside(root, candidate, label) {
  const resolved = path.resolve(root, candidate || '.');
  const relative = path.relative(root, resolved);
  if (relative && (relative.startsWith('..') || path.isAbsolute(relative))) {
    throw new Error(`${label}_outside_allowed_root`);
  }
  return resolved;
}

function resolveInsideWorktree(root, candidate, label) {
  const resolved = path.resolve(root, candidate || '.');
  const relative = path.relative(root, resolved);
  if (relative && (relative.startsWith('..') || path.isAbsolute(relative))) {
    throw new Error(`${label}_outside_worktree`);
  }
  return resolved;
}

function normalizeExecutionPlan(input) {
  const plan = input.shadowExecutionPlan
    || input.shadow_execution_plan
    || input.executionPlan
    || input.execution_plan
    || null;
  if (!plan || typeof plan !== 'object') return null;
  const commands = asArray(plan.commands || plan.checks || plan.inspections).map(normalizeCommand).filter(Boolean);
  const repoRoot = plan.repoRoot || plan.repo_root || input.repoRoot || input.repo_root || null;
  if (!repoRoot || commands.length === 0) return null;
  if (!inlineRepoCommandsAllowed()) return null;
  return {
    ...plan,
    repoRoot,
    commands,
    timeoutMs: normalizeTimeout(plan.timeoutMs || plan.timeout_ms),
    keepWorktrees: Boolean(plan.keepWorktrees || plan.keep_worktrees || process.env.SYNTHI_CODESITE_SHADOW_RUNNER_KEEP_WORKTREES === '1'),
  };
}

function inlineRepoCommandsAllowed() {
  return ['1', 'true', 'yes'].includes(String(process.env.SYNTHI_CODESITE_SHADOW_RUNNER_ALLOW_INLINE_COMMANDS || '').trim().toLowerCase());
}

function normalizeCommand(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    const [command, ...args] = value.map(String);
    return command ? { label: command, command, args } : null;
  }
  if (typeof value === 'string') {
    return { label: value, command: value, args: [] };
  }
  const command = value.command || value.executable || value.bin;
  if (!command) return null;
  return {
    label: String(value.label || value.name || command),
    command: String(command),
    args: asArray(value.args || value.argv).map(String),
    cwd: value.cwd || value.workingDirectory || value.working_directory || null,
    timeoutMs: normalizeTimeout(value.timeoutMs || value.timeout_ms),
  };
}

function normalizeTimeout(value) {
  const max = Number(process.env.SYNTHI_CODESITE_SHADOW_RUNNER_MAX_COMMAND_TIMEOUT_MS || 120000);
  const fallback = Number(process.env.SYNTHI_CODESITE_SHADOW_RUNNER_COMMAND_TIMEOUT_MS || 30000);
  const requested = Number(value || fallback);
  const safeMax = Number.isFinite(max) && max > 0 ? max : 120000;
  return Math.min(Number.isFinite(requested) && requested > 0 ? requested : fallback, safeMax);
}

function allowedBinaries() {
  return new Set(asArray(parseJsonEnv('SYNTHI_CODESITE_SHADOW_RUNNER_ALLOWED_BINARIES_JSON', DEFAULT_ALLOWED_BINARIES)).map(String));
}

function commandIsAllowed(command, allowed) {
  const value = String(command || '');
  if (!value) return false;
  if (path.isAbsolute(value) || value.includes('/') || value.includes('\\')) {
    return allowed.has(value) || allowed.has(path.resolve(value));
  }
  return allowed.has(value);
}

function commandEnvironment(worktreeRoot) {
  const env = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] != null) env[key] = process.env[key];
  }
  const extraKeys = asArray(parseJsonEnv('SYNTHI_CODESITE_SHADOW_RUNNER_ENV_ALLOWLIST_JSON', []))
    .map(String)
    .filter(Boolean);
  for (const key of extraKeys) {
    if (process.env[key] != null && !/SECRET|TOKEN|KEY|PASSWORD|COOKIE|AUTH/i.test(key)) {
      env[key] = process.env[key];
    }
  }
  env.CI = env.CI || '1';
  env.SYNTHI_CODESITE_SHADOW_WORKTREE = worktreeRoot;
  return env;
}

function copyExcludes(plan) {
  return new Set([
    ...DEFAULT_COPY_EXCLUDES,
    ...asArray(plan.copyExcludes || plan.copy_excludes).map(String),
  ]);
}

async function copyRepository(sourceRoot, targetRoot, excludes) {
  await fs.cp(sourceRoot, targetRoot, {
    recursive: true,
    dereference: false,
    filter: async (source) => {
      if (excludes.has(path.basename(source))) return false;
      const stat = await fs.lstat(source);
      return !stat.isSymbolicLink();
    },
  });
}

function patchesForStrategy(plan, strategy) {
  const normalized = normalizeStrategy(strategy);
  const universes = plan.universes || plan.universePatches || plan.universe_patches || {};
  const direct = universes[strategy] || universes[normalized] || null;
  const strategyPatches = Array.isArray(direct) ? direct : asArray(direct?.patches || direct?.changes);
  const sharedPatches = asArray(plan.patches || plan.changes).filter((patch) => {
    const target = patch?.universe || patch?.strategy || patch?.universes || patch?.strategies;
    if (!target) return true;
    return asArray(target).map(normalizeStrategy).includes(normalized);
  });
  return [...sharedPatches, ...strategyPatches].filter(Boolean);
}

async function applyPatch(worktreeRoot, patch) {
  const relativePath = patch.path || patch.filePath || patch.file_path || patch.target;
  if (!relativePath) throw new Error('shadow_patch_missing_path');
  const filePath = resolveInsideWorktree(worktreeRoot, relativePath, 'shadow_patch_path');
  const action = patch.action || (patch.delete || patch.remove ? 'delete' : patch.append != null ? 'append' : patch.replace ? 'replace' : 'write');
  await assertNoSymlinkEscape(worktreeRoot, filePath, { includeTarget: action === 'delete' || action === 'remove' || action === 'append' || action === 'replace' });
  if (action === 'delete' || action === 'remove') {
    await fs.rm(filePath, { recursive: true, force: true });
    return { path: relativePath, action: 'delete' };
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await assertNoSymlinkEscape(worktreeRoot, filePath, { includeTarget: true });
  if (action === 'append') {
    await fs.appendFile(filePath, String(patch.append ?? patch.content ?? ''), 'utf8');
    return { path: relativePath, action: 'append', contentDigest: digest(patch.append ?? patch.content ?? '') };
  }
  if (action === 'replace') {
    const before = String(patch.replace?.from ?? patch.from ?? '');
    const after = String(patch.replace?.to ?? patch.to ?? '');
    const current = await fs.readFile(filePath, 'utf8');
    if (!before) throw new Error('shadow_patch_replace_missing_from');
    const next = current.replace(before, after);
    if (next === current) throw new Error('shadow_patch_replace_no_match');
    await fs.writeFile(filePath, next, 'utf8');
    return { path: relativePath, action: 'replace', contentDigest: digest(next) };
  }
  const content = patch.content != null
    ? String(patch.content)
    : stableJson(patch.json ?? patch.value ?? '');
  await fs.writeFile(filePath, content, 'utf8');
  return { path: relativePath, action: 'write', contentDigest: digest(content) };
}

async function assertNoSymlinkEscape(worktreeRoot, targetPath, { includeTarget = true } = {}) {
  const relative = path.relative(worktreeRoot, targetPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('shadow_patch_path_outside_worktree');
  }
  const parts = relative.split(path.sep).filter(Boolean);
  let current = worktreeRoot;
  const limit = includeTarget ? parts.length : Math.max(0, parts.length - 1);
  for (let index = 0; index < limit; index += 1) {
    current = path.join(current, parts[index]);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('shadow_patch_symlink_escape');
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }
}

function riskBudgetEvaluation(universe, input) {
  const strategy = normalizeStrategy(universe.strategy || universe.universe);
  const unresolvedRisks = asArray(universe.unresolvedRisks || universe.unresolved_risks);
  const avoidedRisks = asArray(universe.avoidedRisks || universe.avoided_risks);
  const exitCode = unresolvedRisks.length > avoidedRisks.length ? 20 : 0;
  const payload = {
    schemaVersion: 'synthi.codesite.shadowUniverseRiskBudget.v1',
    workspaceSlug: input.workspaceSlug,
    projectId: input.projectId,
    shadowJobRef: input.shadowJobRef,
    strategy,
    baseSnapshot: input.baseSnapshot,
    unresolvedRisks,
    avoidedRisks,
    selected: strategy === normalizeStrategy(input.selected?.strategy || input.selected),
  };
  const outputDigest = digest(payload);
  return {
    strategy,
    status: exitCode === 0 ? 'passed' : 'near_miss',
    exitCode,
    command: 'codesite-shadow-runner:evaluate-risk-budget',
    outputDigest,
    executionMode: 'risk_budget_evaluation',
    reasonCodes: exitCode === 0
      ? ['shadow_universe_executed', 'shadow_universe_risk_budget_passed']
      : ['shadow_universe_executed', 'shadow_universe_near_miss_preserved'],
    evidenceRefs: [
      `codesite:shadow-universe:${strategy}:${outputDigest}`,
      `codesite:shadow-job:${input.shadowJobRef}`,
    ],
  };
}

async function runCommand(spec, worktreeRoot, allowed) {
  if (!commandIsAllowed(spec.command, allowed)) {
    return {
      label: spec.label,
      command: spec.command,
      args: spec.args,
      status: 'blocked',
      exitCode: 126,
      reasonCode: 'shadow_command_not_allowed',
      evidenceDigest: digest({ command: spec.command, args: spec.args, blocked: true }),
    };
  }
  const cwd = resolveInsideWorktree(worktreeRoot, spec.cwd || '.', 'shadow_command_cwd');
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args || [], {
      cwd,
      env: commandEnvironment(worktreeRoot),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, spec.timeoutMs || normalizeTimeout());

    child.stdout.on('data', (chunk) => {
      stdout = tail(`${stdout}${chunk.toString('utf8')}`);
    });
    child.stderr.on('data', (chunk) => {
      stderr = tail(`${stderr}${chunk.toString('utf8')}`);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      const redactedStdout = redact(stdout);
      const redactedStderr = redact(`${stderr}${error?.message || String(error)}`);
      const record = {
        label: spec.label,
        command: spec.command,
        args: spec.args || [],
        status: 'failed',
        exitCode: 127,
        signal: null,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdoutTail: redactedStdout.text,
        stderrTail: tail(redactedStderr.text),
        stdoutDigest: digest(redactedStdout.text),
        stderrDigest: digest(redactedStderr.text),
        redactionCounts: mergeCounts(redactedStdout.counts, redactedStderr.counts),
      };
      resolve({ ...record, evidenceDigest: digest(record) });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      const redactedStdout = redact(stdout);
      const redactedStderr = redact(stderr);
      const record = {
        label: spec.label,
        command: spec.command,
        args: spec.args || [],
        status: exitCode === 0 && !timedOut ? 'passed' : 'failed',
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdoutTail: redactedStdout.text,
        stderrTail: redactedStderr.text,
        stdoutDigest: digest(redactedStdout.text),
        stderrDigest: digest(redactedStderr.text),
        redactionCounts: mergeCounts(redactedStdout.counts, redactedStderr.counts),
      };
      resolve({ ...record, evidenceDigest: digest(record) });
    });
  });
}

async function executeRepoUniverse(universe, input, plan) {
  const strategy = normalizeStrategy(universe.strategy || universe.universe);
  const root = allowedRoot();
  const sourceRoot = resolveInside(root, plan.repoRoot, 'repo_root');
  const tmpParent = await fs.mkdtemp(path.join(os.tmpdir(), `codesite-shadow-${strategy || 'universe'}-`));
  const worktreeRoot = path.join(tmpParent, 'worktree');
  try {
    await copyRepository(sourceRoot, worktreeRoot, copyExcludes(plan));
    const patchResults = [];
    for (const patch of patchesForStrategy(plan, strategy)) {
      patchResults.push(await applyPatch(worktreeRoot, patch));
    }
    const allowed = allowedBinaries();
    const commands = [];
    for (const command of plan.commands) {
      const result = await runCommand(command, worktreeRoot, allowed);
      commands.push(result);
      if (result.status !== 'passed' && plan.stopOnFailure !== false && plan.stop_on_failure !== false) break;
    }
    const passed = commands.length > 0 && commands.every((command) => command.status === 'passed');
    const outputDigest = digest({ strategy, patchResults, commands });
    const commandRefs = commands.map((command) => `codesite:shadow-command:${strategy}:${command.label}:${command.evidenceDigest}`);
    return {
      strategy,
      status: passed ? 'passed' : 'near_miss',
      exitCode: passed ? 0 : commands.find((command) => command.status !== 'passed')?.exitCode ?? 20,
      command: 'codesite-shadow-runner:repo-command-execution',
      outputDigest,
      executionMode: 'repo_command_execution',
      reasonCodes: [
        'shadow_universe_executed',
        passed ? 'shadow_universe_repo_commands_passed' : 'shadow_universe_repo_commands_failed',
      ],
      patches: patchResults,
      commands,
      worktreeRetained: plan.keepWorktrees,
      worktreePath: plan.keepWorktrees ? worktreeRoot : null,
      evidenceRefs: [
        `codesite:shadow-universe:${strategy}:${outputDigest}`,
        `codesite:shadow-job:${input.shadowJobRef}`,
        ...commandRefs,
      ],
    };
  } catch (error) {
    const outputDigest = digest({ strategy, error: error?.message || String(error) });
    return {
      strategy,
      status: 'failed',
      exitCode: 1,
      command: 'codesite-shadow-runner:repo-command-execution',
      outputDigest,
      executionMode: 'repo_command_execution',
      reasonCodes: ['shadow_universe_executed', 'shadow_universe_execution_failed'],
      error: error?.message || String(error),
      evidenceRefs: [
        `codesite:shadow-universe:${strategy}:${outputDigest}`,
        `codesite:shadow-job:${input.shadowJobRef}`,
      ],
    };
  } finally {
    if (!plan.keepWorktrees) {
      await fs.rm(tmpParent, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function executeUniverse(universe, input, plan) {
  if (plan) return executeRepoUniverse(universe, input, plan);
  return riskBudgetEvaluation(universe, input);
}

async function emitResult(input, payload) {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  const outputPath = input.outputPath || input.output_path || input.shadowRunnerOutputPath || input.shadow_runner_output_path || null;
  if (outputPath) {
    const outputRoot = path.resolve(process.env.SYNTHI_CODESITE_SHADOW_RUNNER_OUTPUT_ROOT || os.tmpdir());
    const resolved = path.resolve(outputPath);
    const relative = path.relative(outputRoot, resolved);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, text, 'utf8');
    }
  }
  process.stdout.write(text);
}

async function main() {
  const input = await readStdin();
  const plan = normalizeExecutionPlan(input);
  const universes = [];
  for (const universe of asArray(input.universes)) {
    universes.push(await executeUniverse(universe, input, plan));
  }
  const selected = normalizeStrategy(input.selected?.strategy || input.selected || universes.find((universe) => universe.exitCode === 0)?.strategy);
  const evidenceRefs = [
    `codesite:shadow-runner:${digest({ selected, universes, executionMode: plan ? 'repo_command_execution' : 'risk_budget_evaluation' })}`,
    ...universes.flatMap((universe) => universe.evidenceRefs),
  ];

  await emitResult(input, {
    schemaVersion: 'synthi.codesite.shadowRunnerResult.v1',
    runner: 'codesite-shadow-runner',
    status: 'completed',
    executionMode: plan ? 'repo_command_execution' : 'risk_budget_evaluation',
    selected,
    universes,
    evidenceRefs,
  });
}

try {
  await main();
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 'synthi.codesite.shadowRunnerResult.v1',
    runner: 'codesite-shadow-runner',
    status: 'failed',
    error: error?.message || String(error),
    evidenceRefs: [`codesite:shadow-runner-failed:${digest(error?.message || String(error))}`],
  }, null, 2)}\n`);
}
