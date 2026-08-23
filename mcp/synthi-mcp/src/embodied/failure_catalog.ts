/**
 * Substrate failure-class catalogs (plan "Failure Classification Trunk").
 *
 * The plan names these subclasses per substrate; every replay failure must
 * classify into trunk + subclass with the >=90 percent classified-reason
 * bar. Registration goes through the shared classifier's namespaced
 * registry; adapters map their raw outcomes through `classifyFailure` so
 * trunk + subclass always travel together.
 */
import { registerSubstrateClasses } from "./classifier.js";

export interface SubstrateClassDef {
  id: string;
  trunk:
    | "perception_drift"
    | "identity_lost"
    | "consent_missing"
    | "auth"
    | "mutation_blocked"
    | "unsafe_environment"
    | "test_data_missing"
    | "world_changed"
    | "load_delay"
    | "network_failure"
    | "app_validation_error"
    | "substrate_limitation"
    | "unknown";
  description: string;
}

const GAME: SubstrateClassDef[] = [
  { id: "game.physics_blocked", trunk: "mutation_blocked", description: "the world's physics prevented the movement" },
  { id: "game.entity_not_found", trunk: "identity_lost", description: "the targeted entity no longer exists" },
  { id: "game.perception_low_confidence", trunk: "perception_drift", description: "appearance evidence was too weak to act on" },
  { id: "game.tick_rate_variance", trunk: "load_delay", description: "the world ran at an unexpected tick rate" },
  { id: "game.occlusion_unresolved", trunk: "perception_drift", description: "the target was hidden behind other geometry" },
  { id: "game.seed_drift", trunk: "world_changed", description: "the seeded world diverged from its recorded state" },
];

const KERNEL: SubstrateClassDef[] = [
  { id: "kernel.permission_denied", trunk: "consent_missing", description: "the namespace refused the operation" },
  { id: "kernel.unit_failed", trunk: "app_validation_error", description: "the unit exited or failed during the operation" },
  { id: "kernel.fs_readonly", trunk: "mutation_blocked", description: "the target filesystem is read-only" },
];

const TERMINAL: SubstrateClassDef[] = [
  { id: "terminal.nonzero_exit", trunk: "app_validation_error", description: "the command finished with a nonzero exit code" },
  { id: "terminal.prompt_desync", trunk: "load_delay", description: "the shell prompt was not ready when output was read" },
  { id: "terminal.secret_detected", trunk: "unsafe_environment", description: "a credential shape appeared where it must not" },
];

const API: SubstrateClassDef[] = [
  { id: "api.contract_mismatch", trunk: "world_changed", description: "the response did not match the captured contract" },
  { id: "api.rate_limited", trunk: "network_failure", description: "the endpoint throttled the request" },
  { id: "api.schema_drift", trunk: "world_changed", description: "the endpoint's schema changed since capture" },
];

const RUNTIME: SubstrateClassDef[] = [
  { id: "runtime.hmr_timeout", trunk: "load_delay", description: "the hot reload did not settle in time" },
  { id: "runtime.pod_evicted", trunk: "substrate_limitation", description: "the pod was evicted mid-flow" },
];

let registered = false;

/** Idempotent: register every plan-named catalog into the classifier. */
export function registerAllFailureCatalogs(): void {
  if (registered) return;
  registerSubstrateClasses("game", GAME);
  registerSubstrateClasses("kernel", KERNEL);
  registerSubstrateClasses("terminal", TERMINAL);
  registerSubstrateClasses("api", API);
  registerSubstrateClasses("runtime", RUNTIME);
  registered = true;
}

/**
 * Classify a raw failure signal into trunk + subclass. The subclass comes
 * from the substrate's catalog; the trunk rides along so downstream never
 * sees a bare string without both.
 */
export function classifyFailure(
  substrate: string,
  subclassId: string | undefined,
): { trunk: string; subclass?: string } {
  registerAllFailureCatalogs();
  if (subclassId) {
    const entry = lookup(substrate, subclassId);
    if (entry) return { trunk: entry.trunk, subclass: entry.id };
    return { trunk: fallbackTrunk(substrate), subclass: undefined };
  }
  return { trunk: fallbackTrunk(substrate) };
}

function lookup(substrate: string, id: string): SubstrateClassDef | undefined {
  const catalogs: Record<string, SubstrateClassDef[]> = {
    game: GAME,
    kernel: KERNEL,
    terminal: TERMINAL,
    api: API,
    runtime: RUNTIME,
  };
  const catalog = catalogs[substrate];
  return catalog?.find((def) => def.id === id);
}

function fallbackTrunk(substrate: string): string {
  switch (substrate) {
    case "terminal":
      return "app_validation_error";
    case "kernel":
      return "substrate_limitation";
    default:
      return "unknown";
  }
}
