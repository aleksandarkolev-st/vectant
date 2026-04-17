import sharp from "sharp";
import { eventLog } from "../events/index.js";
import { locateEngine } from "../locate/index.js";
import { session } from "../session.js";
import {
  VERIFY_MAX_CLAUSES_PER_LEVEL,
  VERIFY_MAX_DEPTH,
  type VerifyPredicate,
  type VerifyResult,
} from "./types.js";

export class VerifyPredicateError extends Error {
  constructor(public code: string, public detail?: Record<string, unknown>) {
    super(code);
  }
}

/** Top-level entrypoint. Validates depth/clause bounds, then recurses. */
export async function verify(predicate: VerifyPredicate): Promise<VerifyResult> {
  validateBounds(predicate, 0);
  return evaluate(predicate);
}

function validateBounds(p: VerifyPredicate, depth: number): void {
  if (depth > VERIFY_MAX_DEPTH) {
    throw new VerifyPredicateError("verify_predicate_too_deep", { max: VERIFY_MAX_DEPTH });
  }
  if (p.kind === "and" || p.kind === "or") {
    if (!Array.isArray(p.predicates) || p.predicates.length > VERIFY_MAX_CLAUSES_PER_LEVEL) {
      throw new VerifyPredicateError("verify_predicate_too_many_clauses", {
        max: VERIFY_MAX_CLAUSES_PER_LEVEL,
      });
    }
    for (const sub of p.predicates) validateBounds(sub, depth + 1);
  }
}

async function evaluate(p: VerifyPredicate): Promise<VerifyResult> {
  switch (p.kind) {
    case "pixel":
      return evalPixel(p);
    case "log":
      return evalLog(p);
    case "element_visible":
      return evalElementVisible(p);
    case "ocr":
      return {
        matched: null,
        kind: "ocr",
        evidence: { substring: p.substring },
        unsupported: {
          reason: "ocr_backend_not_implemented",
          required_tool_call: {
            tool: "synthi_wait",
            suggested_args: { condition: "log", pattern: p.substring },
            note: "Phase 1 has no OCR backend. For text-on-frame verification, fall back to event-log matches until phase 2 ships OCR.",
          },
        },
      };
    case "scene_matches":
      return {
        matched: null,
        kind: "scene_matches",
        evidence: { description: p.description },
        unsupported: {
          reason: "verify_scene_matches_unsupported",
          required_tool_call: {
            tool: "synthi_describe",
            suggested_args: { description: p.description },
            note: "scene_matches requires the VLM predicate engine; deferred to phase-2 ticket K1. Use synthi_describe as the stand-in.",
          },
        },
      };
    case "and":
      return evalAnd(p.predicates);
    case "or":
      return evalOr(p.predicates);
    default: {
      const unknown = p as { kind: string };
      throw new VerifyPredicateError("verify_unknown_kind", { kind: unknown.kind });
    }
  }
}

async function evalPixel(p: { x: number; y: number; expected_rgb?: [number, number, number]; not_rgb?: [number, number, number]; tolerance?: number }): Promise<VerifyResult> {
  const attached = session.get();
  if (!attached) {
    return {
      matched: false,
      kind: "pixel",
      evidence: { error: "not_attached" },
    };
  }
  const frame = await attached.frames.getFrame();
  if (p.x < 0 || p.y < 0 || p.x >= frame.width || p.y >= frame.height) {
    throw new VerifyPredicateError("click_out_of_bounds", {
      viewport: { w: frame.width, h: frame.height },
      requested: { x: p.x, y: p.y },
    });
  }
  const raw = await sharp(frame.data).removeAlpha().raw().toBuffer();
  const idx = (Math.floor(p.y) * frame.width + Math.floor(p.x)) * 3;
  const rgb: [number, number, number] = [raw[idx] ?? 0, raw[idx + 1] ?? 0, raw[idx + 2] ?? 0];
  const tol = p.tolerance ?? 0;
  let matched = false;
  if (p.expected_rgb) matched = colorClose(rgb, p.expected_rgb, tol);
  else if (p.not_rgb) matched = !colorClose(rgb, p.not_rgb, tol);
  else matched = true; // no predicate == vacuously true (documentation aid)
  return {
    matched,
    kind: "pixel",
    evidence: {
      rgb,
      x: p.x,
      y: p.y,
      ...(p.expected_rgb ? { expected_rgb: p.expected_rgb } : {}),
      ...(p.not_rgb ? { not_rgb: p.not_rgb } : {}),
      tolerance: tol,
      frame_seq: frame.seq,
    },
  };
}

function colorClose(a: [number, number, number], b: [number, number, number], tol: number): boolean {
  return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
}

async function evalLog(p: { pattern: string; since_seq?: number }): Promise<VerifyResult> {
  const re = new RegExp(p.pattern);
  const entries = eventLog.query(p.since_seq !== undefined ? { since_seq: p.since_seq } : {});
  let match: { seq: number; entry: unknown } | null = null;
  let checked = 0;
  for (const e of entries) {
    checked++;
    if (re.test(JSON.stringify(e))) {
      match = { seq: e.seq, entry: e };
      break;
    }
  }
  return {
    matched: match !== null,
    kind: "log",
    evidence: {
      pattern: p.pattern,
      entries_checked: checked,
      ...(match ? { match_seq: match.seq, entry: match.entry } : {}),
    },
  };
}

async function evalElementVisible(p: { handle_id: string }): Promise<VerifyResult> {
  const attached = session.get();
  if (!attached) return { matched: false, kind: "element_visible", evidence: { error: "not_attached" } };
  const frame = await attached.frames.getFrame();
  try {
    const res = await locateEngine.resolve(
      {
        description: `element ${p.handle_id}`,
        handle_id: p.handle_id,
        reuse_handle: true,
      },
      { frame: frame.data, frameDims: { w: frame.width, h: frame.height } }
    );
    return {
      matched: true,
      kind: "element_visible",
      evidence: {
        handle_id: p.handle_id,
        bbox: res.bbox,
        resolved_via: res.resolved_via,
        reason: res.reason,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      matched: false,
      kind: "element_visible",
      evidence: { handle_id: p.handle_id, error: message },
    };
  }
}

async function evalAnd(predicates: VerifyPredicate[]): Promise<VerifyResult> {
  const results: VerifyResult[] = [];
  for (const sub of predicates) {
    const r = await evaluate(sub);
    results.push(r);
    if (r.matched === false) {
      return {
        matched: false,
        kind: "and",
        evidence: { short_circuit_at: results.length - 1, results },
      };
    }
    if (r.matched === null) {
      return {
        matched: null,
        kind: "and",
        evidence: { unsupported_at: results.length - 1, results },
        ...(r.unsupported ? { unsupported: r.unsupported } : {}),
      };
    }
  }
  return {
    matched: true,
    kind: "and",
    evidence: { results },
  };
}

async function evalOr(predicates: VerifyPredicate[]): Promise<VerifyResult> {
  const results: VerifyResult[] = [];
  for (const sub of predicates) {
    const r = await evaluate(sub);
    results.push(r);
    if (r.matched === true) {
      return {
        matched: true,
        kind: "or",
        evidence: { matched_at: results.length - 1, results },
      };
    }
  }
  // If any sub was unsupported, surface it so callers can decide whether to retry.
  const firstUnsupported = results.find((r) => r.matched === null);
  if (firstUnsupported) {
    return {
      matched: null,
      kind: "or",
      evidence: { results },
      ...(firstUnsupported.unsupported ? { unsupported: firstUnsupported.unsupported } : {}),
    };
  }
  return {
    matched: false,
    kind: "or",
    evidence: { results },
  };
}
