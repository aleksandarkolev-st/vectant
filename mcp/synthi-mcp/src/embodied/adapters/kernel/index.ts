/**
 * Kernel adapter (plan P3): namespace-scoped execution with mandatory
 * snapshot-before-mutation.
 *
 * Hard rules enforced in code:
 * - every MUTATING command must be preceded by a verified snapshot of the
 *   target namespace in the current session;
 * - commands targeting the HOST namespace are refused and audited
 *   (audit entries returned by takeAudit());
 * - read-only commands run without snapshots.
 *
 * Execution model: an injected Executor port runs the actual container/ns
 * operations. Tests inject an in-process fake; production wires a real
 * runtime (docker/podman/nspawn).
 */
import type {
  SessionHandle,
  SubstrateAdapterBundle,
  TraceFragmentLike,
} from "../../substrate.js";
import { scrubSecrets } from "../terminal/scrub.js";

/** Operations the executor must provide. All namespace-scoped already. */
export interface KernelExecutorPort {
  /** Snapshot the namespace; returns an opaque verified snapshot id. */
  snapshot(namespace: string): Promise<string>;
  /** Restore (only used for rollback paths; audited like mutations). */
  restore(namespace: string, snapshotId: string): Promise<void>;
  /** Execute one namespaced command; exit code + scrubbed output. */
  exec(namespace: string, command: string): Promise<{ exit: number; output: string }>;
}

export interface KernelCommandAction {
  exec: string;
  namespace: string;
}

export interface KernelAuditEntry {
  kind: "host_refusal";
  command: string;
  at_ms: number;
}

/**
 * Safety classification is POLICY, not adapter code: the adapter enforces
 * the invariants (snapshot-before-mutation, host refusal + audit) for
 * whatever the deployed policy declares. Defaults are the safest possible
 * without command knowledge:
 * - isMutating: true for EVERYTHING (so every command gets a snapshot)
 * - isHostTargeting: false (sandbox enforcement defers to the executor;
 *   deployments that need lexical host detection supply it here)
 */
export interface KernelSafetyPolicy {
  isMutating(command: string): boolean;
  isHostTargeting(command: string): boolean;
}

const CONSERVATIVE_POLICY: KernelSafetyPolicy = {
  isMutating: () => true,
  isHostTargeting: () => false,
};

interface KernelWorld {
  /** Namespaces with a VERIFIED snapshot in this session. */
  snapshotted: Set<string>;
  history: Array<{ command: string; namespace: string; exit: number }>;
  recording: KernelCommandAction[] | null;
  audit: KernelAuditEntry[];
}

type KernelHandle = SessionHandle<KernelWorld>;

export function createKernelBundle(
  executor: KernelExecutorPort,
  policy: KernelSafetyPolicy = CONSERVATIVE_POLICY,
): SubstrateAdapterBundle<
  unknown,
  KernelCommandAction,
  KernelHandle
> {
  const bundle: SubstrateAdapterBundle<unknown, KernelCommandAction, KernelHandle> = {
    substrate_kind: "kernel",
    adapter_version: "1.0.0",

    observer: {
      channels: ["units", "syscalls"],
      describeWorldSchema: () => ({
        schema_id: "kernel.namespace",
        schema_version: "1.0.0",
        value_types: [
          { path_pattern: "ns.*.last_exit", type: { kind: "number" }, semantic_class: "state_flag" },
        ],
        identity: {
          id_scheme: "stable",
          survives: ["reset"],
          reidentification_rule: "namespace names are identity",
        },
        observability: {
          fully_observable: false,
          hidden_state: ["syscall stream contents"],
          policy: "best_effort",
        },
      }),
      observe: async (handle) => {
        const world = handle.environment;
        const namespaces: Record<string, { last_exit: number | null }> = {};
        for (const entry of world.history) {
          namespaces[entry.namespace] = {
            last_exit: entry.exit,
          };
        }
        return { namespaces };
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
        const world = handle.environment;

        // Host-namespace attempts: refuse AND audit. Non-negotiable.
        if (policy.isHostTargeting(action.exec)) {
          world.audit.push({ kind: "host_refusal", command: scrubSecrets(action.exec).text, at_ms: Date.now() });
          return { ok: false, refusal_reason: "host namespace access is not permitted" };
        }

        // Mandatory snapshot-before-mutation.
        if (policy.isMutating(action.exec) && !world.snapshotted.has(action.namespace)) {
          await executor.snapshot(action.namespace);
          world.snapshotted.add(action.namespace);
        }

        const { exit } = await executor.exec(
          action.namespace,
          scrubSecrets(action.exec).text,
        );
        world.history.push({ command: action.exec, namespace: action.namespace, exit });
        if (world.recording) world.recording.push(action);
        return {
          ok: exit === 0,
          applied_tick: world.history.length,
          ...(exit !== 0 ? { refusal_reason: `exit code ${exit}` } : {}),
        };
      },
    },

    recorder: {
      beginRecord: (handle) => {
        handle.environment.recording = [];
      },
      endRecord: (handle) => {
        const steps = (handle.environment.recording ?? []).map((action) => ({ event: action }));
        handle.environment.recording = null;
        return { trace_id: `kernel-${handle.handle_id}`, steps } satisfies TraceFragmentLike;
      },
    },

    attach: async (request) => ({
      handle_id: `kernel-${request.realm.realm_id}`,
      environment: { snapshotted: new Set(), history: [], recording: null, audit: [] },
      realm: request.realm,
    }),

    replay_provider: {
      replay: async (fragment, options) => {
        const world = (options.handle as KernelHandle).environment;
        const stepResults: Array<{ step_index: number; ok: boolean; classifier_trunk?: string }> = [];
        for (const [index, step] of fragment.steps.entries()) {
          const action = step.event as KernelCommandAction;
          if (policy.isHostTargeting(action.exec)) {
            stepResults.push({ step_index: index, ok: false, classifier_trunk: "unsafe_environment" });
            break;
          }
          if (policy.isMutating(action.exec) && !world.snapshotted.has(action.namespace)) {
            await executor.snapshot(action.namespace);
            world.snapshotted.add(action.namespace);
          }
          const { exit } = await executor.exec(action.namespace, scrubSecrets(action.exec).text);
          world.history.push({ command: action.exec, namespace: action.namespace, exit });
          stepResults.push({
            step_index: index,
            ok: exit === 0,
            classifier_trunk: exit === 0 ? undefined : "app_validation_error",
          });
        }
        return { ok: stepResults.every((s) => s.ok), step_results: stepResults };
      },
    },
  };
  return bundle;
}

/** Refusals + host attempts recorded by this session's adapter. */
export function takeAudit(handle: KernelHandle): KernelAuditEntry[] {
  return handle.environment.audit.splice(0, handle.environment.audit.length);
}

