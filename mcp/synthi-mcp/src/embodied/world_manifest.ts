/**
 * Dojo world manifests (plan Architecture Changes): "scenarios gain a
 * `world_manifest` that names an adapter instead of assuming a hosted
 * browser."
 *
 * A manifest binds a dojo scenario to the embodied substrate registry:
 * - adapter_kind must name a REGISTERED substrate (fail-closed lookup);
 * - realm coordinates the scenario's target world;
 * - consent is expressed exactly like any other embodied attach.
 *
 * Pure validation + resolution; execution stays with the conformance
 * harness. Nothing here assumes "browser".
 */
import type { SubstrateAdapterBundle } from "./substrate.js";

export interface DojoWorldManifest {
  world_manifest_version: "synthi.dojo.worldManifest.v1";
  /** The registered substrate kind this scenario runs against. */
  adapter_kind: string;
  realm: { realm_kind: string; realm_id: string };
  required_capabilities: Array<"observe" | "record" | "act">;
  /** Human-readable summary surfaced in checkride reports. */
  description: string;
}

export class UnknownSubstrateError extends Error {
  constructor(kind: string) {
    super(`world_manifest names unknown substrate "${kind}"`);
    this.name = "UnknownSubstrateError";
  }
}

export function validateWorldManifest(manifest: DojoWorldManifest): string[] {
  const problems: string[] = [];
  if (manifest.world_manifest_version !== "synthi.dojo.worldManifest.v1") {
    problems.push("world_manifest_version must be synthi.dojo.worldManifest.v1");
  }
  if (!manifest.adapter_kind || typeof manifest.adapter_kind !== "string") {
    problems.push("adapter_kind is required");
  }
  if (!manifest.realm?.realm_kind || !manifest.realm?.realm_id) {
    problems.push("realm coordinates are required");
  }
  const caps = manifest.required_capabilities ?? [];
  if (!Array.isArray(caps) || caps.length === 0) {
    problems.push("at least one capability is required");
  } else {
    for (const cap of caps) {
      if (!["observe", "record", "act"].includes(cap)) {
        problems.push(`unknown capability "${String(cap)}"`);
      }
    }
    // act without observe is incoherent: you cannot verify effects you
    // cannot see. record implies observe by the same argument.
    if (caps.includes("act") && !caps.includes("observe")) {
      problems.push("act requires observe (effects must be verifiable)");
    }
    if (caps.includes("record") && !caps.includes("observe")) {
      problems.push("record requires observe");
    }
  }
  return problems;
}

/** Resolve a manifest to its registered bundle; fail-closed on unknown kinds. */
export function resolveWorldManifest(
  manifest: DojoWorldManifest,
  getAdapter: (kind: string) => SubstrateAdapterBundle,
): SubstrateAdapterBundle {
  const problems = validateWorldManifest(manifest);
  if (problems.length > 0) {
    throw new Error(`invalid world_manifest: ${problems.join("; ")}`);
  }
  let bundle: SubstrateAdapterBundle;
  try {
    bundle = getAdapter(manifest.adapter_kind);
  } catch {
    // Translate ANY lookup failure into the manifest-level error so callers
    // get one consistent fail-closed shape naming the adapter kind.
    throw new UnknownSubstrateError(manifest.adapter_kind);
  }
  for (const cap of manifest.required_capabilities) {
    const capability =
      cap === "observe" ? "observer" : cap === "record" ? "recorder" : "actor";
    if (!bundle[capability]) {
      throw new UnknownSubstrateError(`${manifest.adapter_kind} lacks ${cap}`);
    }
  }
  return bundle;
}
