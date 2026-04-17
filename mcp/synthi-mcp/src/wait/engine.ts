import sharp from "sharp";
import type wrtc from "@roamhq/wrtc";
import { eventLog } from "../events/index.js";
import { locateEngine } from "../locate/index.js";
import { session } from "../session.js";
import { hammingDistance, pHash, regionPHash } from "../util/phash.js";
import type {
  WaitArgs,
  WaitCondition,
  WaitOutcome,
  MotionSettledArgs,
  PixelArgs,
  SceneChangeArgs,
  LogArgs,
  ElementArgs,
  SourceStateArgs,
  TextArgs,
} from "./types.js";

const DEFAULT_SAMPLE_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Condition → resolver dispatch. Each resolver is responsible for its own
 * sampling cadence; they share the same outer timeout + cancellation.
 */
export async function runWait(args: WaitArgs, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<WaitOutcome> {
  const start = Date.now();
  const elapsed = (): number => Date.now() - start;

  switch (args.condition) {
    case "hmr": {
      const attached = session.get();
      if (!attached) return timeout("hmr", 0, { reason: "not_attached" });
      const res = await attached.channels.hmr.waitForTerminal({ timeoutMs });
      if (res.status === "timeout") {
        return { status: "timeout", elapsedMs: res.elapsedMs, condition: "hmr", last_evidence: { source: res.source } };
      }

      // Frame-seq gate: for positive outcomes (applied / state-migrated),
      // only resolve once a post-reload frame-advance has landed. The
      // caller can then safely `synthi_screenshot` and be sure it sees
      // the new frame. For rejected / compile-error / etc., nothing on
      // screen changed so the gate doesn't apply.
      let frameGate: Record<string, unknown> | undefined;
      const tHmr = Date.now();
      if (res.status === "applied") {
        const budget = session.pipelineBudgetMs();
        if (session.frameSeqGateEnabled()) {
          const remaining = Math.max(0, timeoutMs - (Date.now() - start));
          const satisfiedBy = await session.awaitFrameAdvanceAtOrAfter(tHmr + budget, remaining);
          frameGate = satisfiedBy
            ? {
                status: "satisfied",
                frame_seq: satisfiedBy.frame_seq,
                ts_ms: satisfiedBy.ts_ms,
                pipeline_budget_ms: budget,
              }
            : {
                status: "timeout",
                pipeline_budget_ms: budget,
                note: "no post-budget frame_advance observed; screenshot may reflect pre-reload frame",
              };
        } else {
          frameGate = {
            status: "disabled",
            reason: "no_frame_advance_observed",
            pipeline_budget_ms: budget,
          };
        }
      }

      return {
        status: "resolved",
        elapsedMs: Date.now() - start,
        condition: "hmr",
        evidence: {
          hmr_status: res.status,
          source: res.source,
          ...(res.detail !== undefined ? { detail: res.detail } : {}),
          ...(frameGate !== undefined ? { frame_gate: frameGate } : {}),
        },
      };
    }
    case "log":
      return waitLog(args, timeoutMs, start);
    case "source_state":
      return waitSourceState(args, timeoutMs, start);
    case "pixel":
      return waitPixel(args, timeoutMs, start);
    case "motion_settled":
      return waitMotionSettled(args, timeoutMs, start);
    case "scene_change":
      return waitSceneChange(args, timeoutMs, start);
    case "element":
      return waitElement(args, timeoutMs, start);
    case "text":
      return waitText(args as TextArgs, timeoutMs, elapsed());
    default: {
      const unknown = args as { condition: WaitCondition };
      return {
        status: "unsupported",
        condition: unknown.condition,
        reason: `unknown_condition`,
      };
    }
  }
}

function timeout(condition: WaitCondition, elapsedMs: number, extra?: Record<string, unknown>): WaitOutcome {
  return {
    status: "timeout",
    condition,
    elapsedMs,
    ...(extra ? { last_evidence: extra } : {}),
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function getLatestFrame(): Promise<{ data: Buffer; width: number; height: number; ts: number; seq: number } | null> {
  const attached = session.get();
  if (!attached) return null;
  try {
    return await attached.frames.getFrame();
  } catch {
    return null;
  }
}

async function waitLog(args: LogArgs, timeoutMs: number, start: number): Promise<WaitOutcome> {
  const re = new RegExp(args.pattern);
  const unsubRef: { fn: null | (() => void) } = { fn: null };
  return new Promise<WaitOutcome>((resolve) => {
    let resolved = false;
    const settle = (outcome: WaitOutcome): void => {
      if (resolved) return;
      resolved = true;
      if (unsubRef.fn) unsubRef.fn();
      clearTimeout(timer);
      resolve(outcome);
    };

    const existing = eventLog.query({
      ...(args.since_seq !== undefined ? { since_seq: args.since_seq } : {}),
    });
    for (const e of existing) {
      if (matchesPattern(e, re)) {
        settle({
          status: "resolved",
          elapsedMs: Date.now() - start,
          condition: "log",
          evidence: { match_seq: e.seq, entry: e },
        });
        return;
      }
    }

    unsubRef.fn = eventLog.onAppend((entry) => {
      if (matchesPattern(entry, re)) {
        settle({
          status: "resolved",
          elapsedMs: Date.now() - start,
          condition: "log",
          evidence: { match_seq: entry.seq, entry },
        });
      }
    });

    const timer = setTimeout(() => {
      settle(timeout("log", Date.now() - start, { pattern: args.pattern }));
    }, timeoutMs);
  });
}

function matchesPattern(entry: unknown, re: RegExp): boolean {
  try {
    return re.test(JSON.stringify(entry));
  } catch {
    return false;
  }
}

async function waitSourceState(args: SourceStateArgs, timeoutMs: number, start: number): Promise<WaitOutcome> {
  const sinceSeq = args.since_seq ?? eventLog.lastSeq();
  return new Promise<WaitOutcome>((resolve) => {
    let resolved = false;
    const settle = (outcome: WaitOutcome): void => {
      if (resolved) return;
      resolved = true;
      unsub();
      clearTimeout(timer);
      resolve(outcome);
    };
    const unsub = eventLog.onAppend((entry) => {
      if (entry.kind === "source_state" && entry.seq > sinceSeq) {
        settle({
          status: "resolved",
          elapsedMs: Date.now() - start,
          condition: "source_state",
          evidence: { match_seq: entry.seq, entry },
        });
      }
    });
    const timer = setTimeout(() => {
      settle(timeout("source_state", Date.now() - start, { since_seq: sinceSeq }));
    }, timeoutMs);
  });
}

async function waitPixel(args: PixelArgs, timeoutMs: number, start: number): Promise<WaitOutcome> {
  const interval = args.sample_interval_ms ?? DEFAULT_SAMPLE_INTERVAL_MS;
  const tolerance = args.tolerance ?? 0;
  while (Date.now() - start < timeoutMs) {
    const frame = await getLatestFrame();
    if (!frame) {
      await sleep(interval);
      continue;
    }
    try {
      const rgb = await samplePixelRgb(frame.data, frame.width, frame.height, args.x, args.y);
      if (rgb === null) {
        return timeout("pixel", Date.now() - start, { reason: "out_of_bounds", viewport: { w: frame.width, h: frame.height } });
      }
      if (args.expected_rgb && colorClose(rgb, args.expected_rgb, tolerance)) {
        return { status: "resolved", elapsedMs: Date.now() - start, condition: "pixel", evidence: { rgb, frame_seq: frame.seq } };
      }
      if (args.not_rgb && !colorClose(rgb, args.not_rgb, tolerance)) {
        return { status: "resolved", elapsedMs: Date.now() - start, condition: "pixel", evidence: { rgb, frame_seq: frame.seq } };
      }
    } catch {
      // ignore sample errors; try again
    }
    await sleep(interval);
  }
  return timeout("pixel", Date.now() - start);
}

async function samplePixelRgb(pngData: Buffer, w: number, h: number, x: number, y: number): Promise<[number, number, number] | null> {
  if (x < 0 || y < 0 || x >= w || y >= h) return null;
  const raw = await sharp(pngData).removeAlpha().raw().toBuffer();
  const idx = (Math.floor(y) * w + Math.floor(x)) * 3;
  if (idx + 2 >= raw.length) return null;
  return [raw[idx] ?? 0, raw[idx + 1] ?? 0, raw[idx + 2] ?? 0];
}

function colorClose(a: [number, number, number], b: [number, number, number], tol: number): boolean {
  return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
}

async function waitMotionSettled(args: MotionSettledArgs, timeoutMs: number, start: number): Promise<WaitOutcome> {
  const interval = args.sample_interval_ms ?? DEFAULT_SAMPLE_INTERVAL_MS;
  const stillFor = args.still_for_ms ?? 300;
  const threshold = args.threshold ?? 4;
  let lastHash: string | null = null;
  let stillSince: number | null = null;
  while (Date.now() - start < timeoutMs) {
    const frame = await getLatestFrame();
    if (!frame) { await sleep(interval); continue; }
    const hash = args.region ? await regionPHash(frame.data, args.region) : await pHash(frame.data);
    if (lastHash === null) {
      lastHash = hash;
      stillSince = Date.now();
    } else {
      const d = hammingDistance(hash, lastHash);
      if (d <= threshold) {
        if (stillSince !== null && Date.now() - stillSince >= stillFor) {
          return { status: "resolved", elapsedMs: Date.now() - start, condition: "motion_settled", evidence: { distance: d, still_ms: Date.now() - stillSince } };
        }
      } else {
        stillSince = Date.now();
      }
      lastHash = hash;
    }
    await sleep(interval);
  }
  return timeout("motion_settled", Date.now() - start);
}

async function waitSceneChange(args: SceneChangeArgs, timeoutMs: number, start: number): Promise<WaitOutcome> {
  const interval = args.sample_interval_ms ?? DEFAULT_SAMPLE_INTERVAL_MS;
  const minHamming = args.min_hamming ?? 8;
  let baseline: string | null = null;
  while (Date.now() - start < timeoutMs) {
    const frame = await getLatestFrame();
    if (!frame) { await sleep(interval); continue; }
    const hash = args.region ? await regionPHash(frame.data, args.region) : await pHash(frame.data);
    if (baseline === null) baseline = hash;
    else {
      const d = hammingDistance(hash, baseline);
      if (d >= minHamming) {
        return { status: "resolved", elapsedMs: Date.now() - start, condition: "scene_change", evidence: { distance: d, frame_seq: frame.seq } };
      }
    }
    await sleep(interval);
  }
  return timeout("scene_change", Date.now() - start);
}

async function waitElement(args: ElementArgs, _timeoutMs: number, start: number): Promise<WaitOutcome> {
  const frame = await getLatestFrame();
  if (!frame) return timeout("element", Date.now() - start);
  try {
    const res = await locateEngine.resolve(
      { description: `element ${args.handle_id}`, handle_id: args.handle_id, reuse_handle: true },
      { frame: frame.data, frameDims: { w: frame.width, h: frame.height } }
    );
    return {
      status: "resolved",
      elapsedMs: Date.now() - start,
      condition: "element",
      evidence: { bbox: res.bbox, resolved_via: res.resolved_via, reason: res.reason },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "unsupported",
      condition: "element",
      reason: message,
      required_tool_call: {
        tool: "synthi_locate",
        suggested_args: { description: `element ${args.handle_id}`, handle_id: args.handle_id, reuse_handle: true },
      },
    };
  }
}

async function waitText(args: TextArgs, _timeoutMs: number, elapsedMs: number): Promise<WaitOutcome> {
  return {
    status: "unsupported",
    condition: "text",
    reason: "text_wait_requires_ocr_backend",
    required_tool_call: {
      tool: "synthi_wait",
      suggested_args: { condition: "log", pattern: args.substring },
      note: "Phase 1 lacks an OCR backend for on-frame text; fall back to log-based waits until phase 2 ships OCR.",
    },
  };
}

export { DEFAULT_TIMEOUT_MS };
/** Typed export so tests can construct Peer/DC helpers without pulling wrtc. */
export type UnusedWrtc = typeof wrtc;
