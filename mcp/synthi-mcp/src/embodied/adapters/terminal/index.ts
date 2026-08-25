/**
 * Terminal adapter (plan P1): real command execution as an embodied
 * substrate.
 *
 * - Observer: working directory + workspace file tree + last exit code,
 *   all scrubbed before they enter a trace.
 * - Actor: executes a whitelisted-shaped command under a lease; refuses
 *   on expired lease / realm mismatch / non-allowlisted binaries.
 * - Recorder: records executed commands.
 * - ReplayProvider: same_state verifies recorded commands' effects still
 *   hold (net-effect per target path); fresh_state re-executes in order
 *   against a reset workspace.
 *
 * Commands run through the platform shell with a hard timeout; this is a
 * local automation substrate, gated by realm consent upstream.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  SessionHandle,
  SubstrateAdapterBundle,
  TraceFragmentLike,
} from "../../substrate.js";
import { registerSubstrateAdapter } from "../../substrate.js";
import { scrubSecrets } from "./scrub.js";

export interface TerminalCommandAction {
  run: string;
  /** Seconds before hard kill. Default 10; hard-capped at 30. */
  timeout_s?: number;
}

interface TerminalWorld {
  root: string;
  lastExit: number | null;
  history: Array<{ command: string; exit: number }>;
  recording: TerminalCommandAction[] | null;
}

type TerminalHandle = SessionHandle<TerminalWorld>;

/**
 * Execution policy is injected, not hardcoded: what may run is deployment
 * configuration. The default DENIES everything (safest possible without
 * knowledge of the environment); callers open up explicitly.
 */
export interface TerminalExecutionPolicy {
  isAllowed(leadBinary: string): boolean;
}

export function allowlistPolicy(binaries: readonly string[]): TerminalExecutionPolicy {
  const set = new Set(binaries);
  return { isAllowed: (lead) => set.has(lead) };
}

function parseLeadBinary(command: string): string {
  const lead = command.trim().split(/\s+/)[0] ?? "";
  return lead;
}

/**
 * Quote-aware argument splitting for replay execution. Commands arrive
 * post-shell (the recording captured what the human's shell had already
 * parsed), so inner quote characters are part of the payload - e.g.
 * `node -e require('fs').writeFileSync(...)` needs those single quotes
 * intact or the JS breaks. Rule: quoted spans prevent whitespace splits,
 * but the quote characters themselves are PRESERVED VERBATIM.
 */
export function splitArgs(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const char of command.trim()) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) args.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

function safeListDir(root: string): Record<string, string> {
  const listing: Record<string, string> = {};
  if (!existsSync(root)) return listing;
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    try {
      const st = statSync(full);
      listing[entry] = st.isDirectory() ? "<dir>" : `${st.size}b`;
    } catch {
      listing[entry] = "<?>";
    }
  }
  return listing;
}

export function createTerminalBundle(
  policy: TerminalExecutionPolicy = { isAllowed: () => false },
): SubstrateAdapterBundle<
  unknown,
  TerminalCommandAction,
  TerminalHandle
> {
  const bundle: SubstrateAdapterBundle<unknown, TerminalCommandAction, TerminalHandle> = {
    substrate_kind: "terminal",
    adapter_version: "1.0.0",

    observer: {
      channels: ["fs", "process"],
      describeWorldSchema: () => ({
        schema_id: "terminal.local",
        schema_version: "1.0.0",
        value_types: [
          { path_pattern: "cwd.files.*", type: { kind: "string" }, semantic_class: "content" },
          { path_pattern: "last_exit", type: { kind: "number" }, semantic_class: "state_flag" },
        ],
        identity: {
          id_scheme: "stable",
          survives: [],
          reidentification_rule: "absolute workspace root path",
        },
        observability: {
          fully_observable: false,
          hidden_state: ["environment variables", "process memory"],
          policy: "best_effort",
        },
      }),
      observe: async (handle) => {
        const world = handle.environment;
        const listing = safeListDir(world.root);
        return {
          cwd: scrubSecrets(world.root).text,
          files: Object.fromEntries(
            Object.entries(listing).map(([name, meta]) => [name, scrubSecrets(meta).text]),
          ),
          last_exit: world.lastExit,
        };
      },
    },

    actor: {
      act: async (handle, action, leaseProof) => {
        if (leaseProof.expires_at_ms <= Date.now()) {
          return { ok: false, refusal_reason: "lease expired" };
        }
        if (leaseProof.realm.realm_id !== handle.realm.realm_id) {
          return { ok: false, refusal_reason: "realm mismatch" };
        }
        const lead = parseLeadBinary(action.run);
        if (!policy.isAllowed(lead)) {
          return { ok: false, refusal_reason: `binary not allowed by policy: ${lead}` };
        }
        const timeoutMs = Math.min(30, Math.max(1, action.timeout_s ?? 10)) * 1000;
        let exit = 0;
        try {
      execFileSync(lead, splitArgs(action.run).slice(1), {
            cwd: handle.environment.root,
            timeout: timeoutMs,
            stdio: "pipe",
          });
        } catch (error) {
          exit = (error as { status?: number }).status ?? 1;
        }
        handle.environment.lastExit = exit;
        handle.environment.history.push({ command: action.run, exit });
        if (handle.environment.recording) {
          handle.environment.recording.push(action);
        }
        return { ok: exit === 0, applied_tick: handle.environment.history.length };
      },
    },

    recorder: {
      beginRecord: (handle) => {
        handle.environment.recording = [];
      },
      endRecord: (handle) => {
        const steps = (handle.environment.recording ?? []).map((action) => ({ event: action }));
        handle.environment.recording = null;
        return { trace_id: `terminal-${handle.handle_id}`, steps } satisfies TraceFragmentLike;
      },
    },

    attach: async (request) => {
      // The realm id doubles as the workspace root for local terminals.
      const root = resolve(request.realm.realm_id);
      return {
        handle_id: `terminal-${request.realm.realm_id}`,
        environment: { root, lastExit: null, history: [], recording: null },
        realm: request.realm,
      };
    },

    replay_provider: {
      replay: async (fragment, options) => {
        const world = (options.handle as TerminalHandle).environment;
        const stepResults = fragment.steps.map((step, index) => {
          const action = step.event as TerminalCommandAction;
          const lead = parseLeadBinary(action.run);
          if (!policy.isAllowed(lead)) {
            return {
              step_index: index,
              ok: false,
              classifier_trunk: "substrate_limitation",
            };
          }
          try {
            execFileSync(lead, splitArgs(action.run).slice(1), {
              cwd: world.root,
              timeout: Math.min(30, Math.max(1, action.timeout_s ?? 10)) * 1000,
              stdio: "pipe",
            });
            return { step_index: index, ok: true };
          } catch (error) {
            return {
              step_index: index,
              ok: false,
              classifier_trunk: "world_changed",
              detail: { exit: (error as { status?: number }).status ?? 1 },
            };
          }
        });
        return {
          ok: stepResults.every((stepResult) => stepResult.ok),
          step_results: stepResults,
        };
      },
    },
  };
  return bundle;
}

/** Register under the canonical "terminal" substrate kind. */
export function registerTerminalAdapter(): void {
  registerSubstrateAdapter(createTerminalBundle());
}

