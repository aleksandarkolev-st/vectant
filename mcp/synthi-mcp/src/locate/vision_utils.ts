/**
 * Shared utilities for server-side vision backends (`claude_api`,
 * `gemini_api`, future `local`). Lifted here so adding a new backend
 * doesn't mean duplicating prompts, hashing, or parsing.
 *
 * This module deliberately has NO dependency on a specific vendor SDK.
 * Backends import the helpers + supply their own client shape + pricing.
 */

import { createHash } from "node:crypto";
import type { BBox } from "../util/phash.js";

/**
 * 16-hex-char SHA-256 prefix of a buffer. Used as the frame-content key
 * for `(content_hash, description_hash)` cache lookups. Short prefix keeps
 * event-log entries grep-friendly without risking collisions at the
 * per-session scale we care about.
 */
export function contentHash(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

/** 16-hex-char SHA-256 prefix of a description string. */
export function descriptionHash(description: string): string {
  return createHash("sha256").update(description).digest("hex").slice(0, 16);
}

/**
 * System prompt shared by every vendor. Different models will interpret
 * it with slightly different formatting; the parser below tolerates
 * prose + code fences so the prompt doesn't need per-vendor variants.
 */
export function buildSystemPrompt(): string {
  return [
    "You are a bounding-box extractor. You take an image and an element description and return the pixel bbox.",
    "Respond with STRICT JSON only. No prose, no code fences, no markdown.",
    "Coordinates are top-left origin, pixels, relative to the full image dimensions.",
  ].join(" ");
}

/**
 * User text. Identical across vendors. Adding vendor-specific hints
 * (e.g., "Gemini: return only a raw JSON object") belongs here if we
 * observe empirically that a vendor mis-formats more than the others.
 */
export function buildUserText(description: string, dims: { w: number; h: number }): string {
  return [
    `Element to locate: ${description}`,
    `Frame dimensions: ${dims.w}x${dims.h} pixels.`,
    "",
    "Return exactly this JSON shape on a single line:",
    '{"bbox":{"x":N,"y":N,"w":N,"h":N},"confidence":FLOAT_0_TO_1,"trace":"short why"}',
    "",
    "If the element is not visible or you cannot find it with confidence >= 0.3, return:",
    '{"bbox":null,"confidence":0,"trace":"not_visible"}',
  ].join("\n");
}

export interface ParsedVisionResult {
  bbox: BBox | null;
  confidence: number;
  trace: string;
}

/**
 * Peel the first top-level `{...}` block from a model response and parse
 * it. Tolerates leading prose, code fences, or trailing commentary. Any
 * format deviation we can't recover from throws a sentinel-prefixed
 * error so tool handlers can branch on it without regex-matching the
 * full message.
 */
export function parseBboxResponse(text: string, prefix = "vision_parse_error"): ParsedVisionResult {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`${prefix}: no JSON object found in response`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch (err) {
    throw new Error(`${prefix}: ${(err as Error).message}`);
  }
  const obj = parsed as {
    bbox?: { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | null;
    confidence?: unknown;
    trace?: unknown;
  };
  const confidence = typeof obj.confidence === "number" ? obj.confidence : 0;
  const trace = typeof obj.trace === "string" ? obj.trace : "";
  if (obj.bbox === null || obj.bbox === undefined) {
    return { bbox: null, confidence, trace };
  }
  const { x, y, w, h } = obj.bbox;
  if (typeof x !== "number" || typeof y !== "number" || typeof w !== "number" || typeof h !== "number") {
    throw new Error(`${prefix}: bbox missing numeric x/y/w/h`);
  }
  return {
    bbox: { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) },
    confidence,
    trace,
  };
}

/**
 * Clamp a bbox to the frame so we never hand back out-of-bounds coords
 * to the rest of the pipeline. Any dimension rounded to zero gets bumped
 * to 1 so downstream pHash has something to bite on.
 */
export function clampBboxToFrame(bbox: BBox, dims: { w: number; h: number }): BBox {
  const x = Math.max(0, Math.min(bbox.x, dims.w - 1));
  const y = Math.max(0, Math.min(bbox.y, dims.h - 1));
  const w = Math.max(1, Math.min(bbox.w, dims.w - x));
  const h = Math.max(1, Math.min(bbox.h, dims.h - y));
  return { x, y, w, h };
}

export interface CachedVisionEntry {
  bbox: BBox;
  confidence: number;
  trace: string;
  model: string;
  ts: number;
}
