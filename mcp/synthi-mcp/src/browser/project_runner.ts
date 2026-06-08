import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { eventLog } from "../events/index.js";

export interface ProjectCommandCandidate {
  command: string;
  script: string;
  package_manager: "npm" | "pnpm" | "yarn" | "bun";
  confidence: number;
  reason: string;
}

export interface ProjectDetection {
  root: string;
  package_json?: string;
  package_manager: "npm" | "pnpm" | "yarn" | "bun";
  candidates: ProjectCommandCandidate[];
  source_identity: {
    status: "supported" | "disabled" | "unknown";
    adapter?: "vite-react";
    ssr_safe: boolean;
    transform: "compileTimeJsx" | "none";
    notes: string[];
  };
  notes: string[];
}

export interface ProjectRun {
  run_id: string;
  root: string;
  command: string;
  pid: number | null;
  started_at: number;
  exited_at?: number;
  exit_code?: number | null;
  signal?: string | null;
  logs: string[];
}

interface ActiveRun {
  record: ProjectRun;
  child: ChildProcess;
}

const runs = new Map<string, ActiveRun>();

export async function detectBrowserProject(rootInput: string | undefined): Promise<ProjectDetection> {
  const root = resolve(rootInput || process.cwd());
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) throw new Error("project_root_not_found");
  const packagePath = join(root, "package.json");
  const notes: string[] = [];
  if (!existsSync(packagePath)) {
    return {
      root,
      package_manager: "npm",
      candidates: [],
      source_identity: {
        status: "unknown",
        ssr_safe: false,
        transform: "none",
        notes: ["package_json_not_found"],
      },
      notes: ["package_json_not_found"],
    };
  }
  const pkg = JSON.parse(await readFile(packagePath, "utf8")) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const packageManager = detectPackageManager(root);
  const scripts = pkg.scripts ?? {};
  const candidates = Object.entries(scripts)
    .map(([script, body]) => candidateForScript(packageManager, script, body, pkg))
    .filter((candidate): candidate is ProjectCommandCandidate => candidate !== null)
    .sort((a, b) => b.confidence - a.confidence);
  if (candidates.length === 0) notes.push("no_web_dev_script_detected");
  return {
    root,
    package_json: packagePath,
    package_manager: packageManager,
    candidates,
    source_identity: sourceIdentitySupport(pkg),
    notes,
  };
}

export async function runBrowserProject(rootInput: string | undefined, commandInput: string | undefined): Promise<ProjectRun> {
  const detection = await detectBrowserProject(rootInput);
  const command = commandInput || detection.candidates[0]?.command;
  if (!command) throw new Error("project_command_required");
  const run_id = `browser_run_${randomUUID()}`;
  const child = spawn(command, {
    cwd: detection.root,
    shell: true,
    detached: process.platform !== "win32",
    env: { ...process.env, BROWSER: "none" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record: ProjectRun = {
    run_id,
    root: detection.root,
    command,
    pid: child.pid ?? null,
    started_at: Date.now(),
    logs: [],
  };
  const active: ActiveRun = { record, child };
  runs.set(run_id, active);
  child.stdout.on("data", (chunk) => pushLog(active, String(chunk)));
  child.stderr.on("data", (chunk) => pushLog(active, String(chunk)));
  child.on("exit", (code, signal) => {
    record.exited_at = Date.now();
    record.exit_code = code;
    record.signal = signal;
    runs.delete(run_id);
    eventLog.push({ kind: "browser", action: "project_exited", payload: { run_id, code, signal } });
  });
  eventLog.push({ kind: "browser", action: "project_started", payload: { run_id, root: detection.root, command, pid: record.pid } });
  return snapshotRun(record);
}

export function projectRunStatus(run_id?: string): ProjectRun[] {
  if (run_id) {
    const run = runs.get(run_id)?.record;
    return run ? [snapshotRun(run)] : [];
  }
  return [...runs.values()].map((active) => snapshotRun(active.record));
}

export async function stopBrowserProject(run_id: string): Promise<{ stopped: boolean; run_id: string }> {
  const active = runs.get(run_id);
  if (!active) return { stopped: false, run_id };
  killRun(active, "SIGTERM");
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 1_000);
    active.child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  if (runs.has(run_id)) {
    killRun(active, "SIGKILL");
    runs.delete(run_id);
  }
  eventLog.push({ kind: "browser", action: "project_stopped", payload: { run_id } });
  return { stopped: true, run_id };
}

function killRun(active: ActiveRun, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && active.child.pid) {
      process.kill(-active.child.pid, signal);
    } else {
      active.child.kill(signal);
    }
  } catch {
    // Process may already have exited.
  }
}

export async function tempProjectRootForTests(): Promise<string> {
  return mkdtemp(join(tmpdir(), "synthi-browser-project-"));
}

function candidateForScript(
  packageManager: ProjectCommandCandidate["package_manager"],
  script: string,
  body: string,
  pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
): ProjectCommandCandidate | null {
  const lowerScript = script.toLowerCase();
  const lowerBody = body.toLowerCase();
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  let confidence = 0;
  const reasons: string[] = [];
  if (["dev", "start", "serve", "preview"].includes(lowerScript)) {
    confidence += lowerScript === "dev" ? 0.55 : 0.35;
    reasons.push(`script_${lowerScript}`);
  }
  for (const framework of ["vite", "next", "astro", "svelte", "nuxt", "webpack", "parcel"]) {
    if (lowerBody.includes(framework) || deps[framework] !== undefined) {
      confidence += 0.25;
      reasons.push(`framework_${framework}`);
      break;
    }
  }
  if (lowerBody.includes("--host") || lowerBody.includes("localhost") || lowerBody.includes("0.0.0.0")) {
    confidence += 0.1;
    reasons.push("web_host_signal");
  }
  if (confidence <= 0) return null;
  return {
    command: commandFor(packageManager, script),
    script,
    package_manager: packageManager,
    confidence: Math.min(confidence, 0.99),
    reason: reasons.join("+"),
  };
}

function sourceIdentitySupport(pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }): ProjectDetection["source_identity"] {
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  if (deps["vite"] && deps["react"] && deps["react-dom"]) {
    return {
      status: "supported",
      adapter: "vite-react",
      ssr_safe: true,
      transform: "compileTimeJsx",
      notes: ["vite_react_compile_time_transform_available", "no_browser_dom_mutation"],
    };
  }
  if (deps["next"] || deps["@remix-run/react"] || deps["@remix-run/node"]) {
    return {
      status: "disabled",
      ssr_safe: false,
      transform: "none",
      notes: ["ssr_adapter_requires_server_client_parity_tests"],
    };
  }
  return {
    status: "unknown",
    ssr_safe: false,
    transform: "none",
    notes: ["no_supported_source_identity_adapter_detected"],
  };
}

function detectPackageManager(root: string): ProjectCommandCandidate["package_manager"] {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) return "bun";
  return "npm";
}

function commandFor(packageManager: ProjectCommandCandidate["package_manager"], script: string): string {
  if (packageManager === "npm") return `npm run ${script}`;
  if (packageManager === "yarn") return `yarn ${script}`;
  if (packageManager === "bun") return `bun run ${script}`;
  return `pnpm ${script}`;
}

function pushLog(active: ActiveRun, text: string): void {
  const lines = text.split(/\r?\n/).filter(Boolean);
  active.record.logs.push(...lines.slice(0, 20));
  while (active.record.logs.length > 200) active.record.logs.shift();
}

function snapshotRun(record: ProjectRun): ProjectRun {
  return {
    ...record,
    logs: [...record.logs],
  };
}
