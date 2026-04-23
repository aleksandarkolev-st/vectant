import type { BBox } from "../util/phash.js";

export type VerifyPredicateKind =
  | "ocr"
  | "pixel"
  | "element_visible"
  | "log"
  | "scene_matches"
  | "and"
  | "or";

export interface PixelPredicate {
  kind: "pixel";
  x: number;
  y: number;
  expected_rgb?: [number, number, number];
  not_rgb?: [number, number, number];
  tolerance?: number;
}

export interface OcrPredicate {
  kind: "ocr";
  substring: string;
  region?: BBox;
}

export interface ElementVisiblePredicate {
  kind: "element_visible";
  handle_id: string;
}

export interface LogPredicate {
  kind: "log";
  pattern: string;
  since_seq?: number;
}

export interface SceneMatchesPredicate {
  kind: "scene_matches";
  description: string;
}

export interface AndPredicate {
  kind: "and";
  predicates: VerifyPredicate[];
}

export interface OrPredicate {
  kind: "or";
  predicates: VerifyPredicate[];
}

export type VerifyPredicate =
  | PixelPredicate
  | OcrPredicate
  | ElementVisiblePredicate
  | LogPredicate
  | SceneMatchesPredicate
  | AndPredicate
  | OrPredicate;

export interface VerifyResult {
  matched: boolean | null;
  kind: VerifyPredicateKind;
  evidence: Record<string, unknown>;
  unsupported?: { reason: string; required_tool_call?: Record<string, unknown> };
}

export const VERIFY_MAX_DEPTH = 4;
export const VERIFY_MAX_CLAUSES_PER_LEVEL = 8;
