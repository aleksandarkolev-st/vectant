/**
 * @fileoverview Pure, fail-closed hard gates for a community-app submission.
 * Reuses `parseProgramManifest` (schema + scope allow-list) and the shared
 * host-escape ruleset. Returns reasons rather than throwing so the orchestrator
 * can record them and route the version to `rejected`. This is defense-in-depth,
 * NOT a containment guarantee — see hostEscape.js / the design doc.
 */

import { parseProgramManifest, ProgramManifestError } from './manifest';
import { findCommandHostEscape } from './hostEscape';

/** Runtime types that ship a container image and therefore require re-hosting. */
const IMAGE_RUNTIME_TYPES = new Set(['container', 'gui']);

/**
 * @param {{ config: object, sourceImageRef?: string|null }} input
 * @returns {{ ok: boolean, reasons: Array<{code:string,message:string,field?:string}> }}
 */
export function runHardGates({ config, sourceImageRef = null }) {
  const reasons = [];

  // Gate 1: schema (re-parse so a tampered/raw config is fully re-validated +
  // scope allow-list enforced). parseProgramManifest throws ProgramManifestError.
  let normalized = null;
  try {
    normalized = parseProgramManifest(config);
  } catch (err) {
    if (err instanceof ProgramManifestError) {
      reasons.push({ code: err.code, message: err.message, field: err.field });
      return { ok: false, reasons }; // can't reason about the rest without a valid manifest
    }
    reasons.push({ code: 'invalid_manifest', message: String(err?.message || err) });
    return { ok: false, reasons };
  }

  // Gate 2: host-escape across every command string (install[] + launch).
  for (const cmd of [...(normalized.install || []), normalized.launch]) {
    const hit = findCommandHostEscape(cmd);
    if (hit) reasons.push({ code: 'host_escape', message: `host escape in command: ${hit}`, field: 'launch' });
  }

  // Gate 3: metadata sanity.
  if (!normalized.launch || !normalized.launch.trim()) {
    reasons.push({ code: 'missing_entrypoint', message: 'launch command is required', field: 'launch' });
  }
  const ref = typeof sourceImageRef === 'string' ? sourceImageRef.trim() : '';
  if (IMAGE_RUNTIME_TYPES.has(normalized.runtimeType)) {
    if (!ref) {
      reasons.push({ code: 'image_required', message: `${normalized.runtimeType} programs must declare a sourceImageRef`, field: 'sourceImageRef' });
    } else if (!normalized.launch.includes(ref)) {
      // The image we re-host must be the one the program actually runs, or the
      // pinned manifest would point at an image we never reviewed.
      reasons.push({ code: 'image_mismatch', message: 'sourceImageRef is not referenced by the launch command', field: 'sourceImageRef' });
    }
  }

  return { ok: reasons.length === 0, reasons };
}
