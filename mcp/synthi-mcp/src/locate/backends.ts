import type { BBox } from "../util/phash.js";
import type { LocateHints, LocateBackendName } from "./types.js";

export interface BackendResolution {
  bbox: BBox;
  confidence: number;
  /** Free-form explanation for the event log (which primitive matched, etc.). */
  trace: string;
}

export interface VisionBackend {
  readonly name: LocateBackendName;
  resolve(args: {
    description: string;
    frame: Buffer;
    hints?: LocateHints;
    frameDims: { w: number; h: number };
  }): Promise<BackendResolution>;
}

/**
 * Mock backend. Returns `hints.prefer_region` verbatim, or throws
 * `locator_unresolved` if no hint was given. Intended for the spike
 * harness + unit tests — lets us exercise the cache/tool layer without
 * touching an LLM.
 *
 * Real callers (E2b `locate` dispatches on counter/) pass the known bbox
 * of the fixture element as `hints.prefer_region`.
 */
export class MockBackend implements VisionBackend {
  readonly name = "mock" as const;

  async resolve(args: {
    description: string;
    frame: Buffer;
    hints?: LocateHints;
    frameDims: { w: number; h: number };
  }): Promise<BackendResolution> {
    if (args.hints?.prefer_region) {
      return {
        bbox: args.hints.prefer_region,
        confidence: 1,
        trace: "mock_used_prefer_region",
      };
    }
    throw new Error(
      "locator_unresolved: mock backend requires hints.prefer_region (no vision; spike-only)"
    );
  }
}

/**
 * `agent_side` backend. The server does NOT resolve the description; instead
 * `synthi_locate` returns an unresolved handle-shell + the current screenshot,
 * so the agent can do vision grounding itself (e.g., a Claude Code loop that
 * runs a local model or uses a tool to grep the screenshot).
 *
 * Usage pattern: caller receives `unresolved` → agent runs its own grounding
 * → agent re-calls `synthi_locate` with `hints.prefer_region` populated
 * (which falls through to the MockBackend path server-side, so the handle
 * cache still works). For the spike we stub the behavior: if `hints.prefer_region`
 * is present the backend behaves identically to MockBackend; otherwise it
 * signals `requires_agent_vision` which the tool handler converts to an
 * `agent_side_vision_required` error payload.
 */
export class AgentSideBackend implements VisionBackend {
  readonly name = "agent_side" as const;

  async resolve(args: {
    description: string;
    frame: Buffer;
    hints?: LocateHints;
    frameDims: { w: number; h: number };
  }): Promise<BackendResolution> {
    if (args.hints?.prefer_region) {
      return {
        bbox: args.hints.prefer_region,
        confidence: 1,
        trace: "agent_side_used_prefer_region",
      };
    }
    throw new Error("agent_side_vision_required");
  }
}

/**
 * `claude_api` backend. Phase 0.5 stub — logs the intended call but does not
 * hit Anthropic's API. Phase 1 replaces this with a real multi-modal call;
 * gated on E3 (p99 measurement) and E4 (cost measurement).
 *
 * The stub returns an error unless `hints.prefer_region` is provided (in
 * which case it acts like MockBackend). This keeps the spike harness
 * deterministic until E3/E4 are wired.
 */
export class ClaudeApiBackend implements VisionBackend {
  readonly name = "claude_api" as const;

  async resolve(args: {
    description: string;
    frame: Buffer;
    hints?: LocateHints;
    frameDims: { w: number; h: number };
  }): Promise<BackendResolution> {
    if (args.hints?.prefer_region) {
      return {
        bbox: args.hints.prefer_region,
        confidence: 1,
        trace: "claude_api_stub_used_prefer_region",
      };
    }
    throw new Error(
      "claude_api_not_implemented: phase 0.5 stub — real vision call lands in phase 1 gated on E3/E4"
    );
  }
}

/**
 * Resolve a backend name to a concrete instance. Honors the per-call
 * override first, then the env default (`SYNTHI_VISION_BACKEND`), then
 * falls back to `mock` for the spike so nothing silently tries to call
 * an external API.
 */
export function selectBackend(override?: LocateBackendName): VisionBackend {
  const envName = process.env["SYNTHI_VISION_BACKEND"] as LocateBackendName | undefined;
  const chosen = override ?? envName ?? "mock";
  switch (chosen) {
    case "mock":
      return new MockBackend();
    case "agent_side":
      return new AgentSideBackend();
    case "claude_api":
      return new ClaudeApiBackend();
    default:
      return new MockBackend();
  }
}
