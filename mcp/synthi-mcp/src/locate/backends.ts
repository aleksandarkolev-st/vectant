import type { BBox } from "../util/phash.js";
import type { LocateHints, LocateBackendName } from "./types.js";
import { ClaudeApiBackendReal, type ClaudeApiBackendOptions } from "./claude_api.js";

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
    /**
     * Optional cancellation. When fired mid-call, backends must unwind
     * without incurring billable side effects (no usage event, no cache
     * write) and throw a distinct error (e.g. `claude_api_aborted`).
     */
    signal?: AbortSignal;
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
    signal?: AbortSignal;
  }): Promise<BackendResolution> {
    if (args.signal?.aborted) throw new Error("mock_backend_aborted");
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
    signal?: AbortSignal;
  }): Promise<BackendResolution> {
    if (args.signal?.aborted) throw new Error("agent_side_backend_aborted");
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
 * `claude_api` backend. Thin wrapper around {@link ClaudeApiBackendReal}:
 * honors `hints.prefer_region` without spending a vision call when given,
 * otherwise delegates to the real Anthropic client (lazy-loaded on first
 * use). Tests inject a mock client via the `options` ctor arg.
 *
 * `prefer_region` short-circuit is intentional: a planner that already
 * knows the exact bbox (e.g., from a previous handle) shouldn't pay a
 * vision call. This preserves spike-harness determinism and the MockBackend
 * equivalence when the caller supplies a hint.
 */
export class ClaudeApiBackend implements VisionBackend {
  readonly name = "claude_api" as const;
  private readonly real: ClaudeApiBackendReal;

  constructor(options?: ClaudeApiBackendOptions) {
    this.real = new ClaudeApiBackendReal(options ?? {});
  }

  async resolve(args: {
    description: string;
    frame: Buffer;
    hints?: LocateHints;
    frameDims: { w: number; h: number };
    signal?: AbortSignal;
  }): Promise<BackendResolution> {
    if (args.signal?.aborted) {
      throw new Error(
        `claude_api_aborted: ${((args.signal.reason as Error | undefined)?.message) ?? "pre_call"}`
      );
    }
    if (args.hints?.prefer_region) {
      return {
        bbox: args.hints.prefer_region,
        confidence: 1,
        trace: "claude_api_used_prefer_region",
      };
    }
    return this.real.resolve(args);
  }
}

/**
 * Per-process singleton shared by `selectBackend` so the content-hash cache
 * is meaningful across tool calls. Tests that want a fresh backend can
 * instantiate {@link ClaudeApiBackend} directly with an injected client.
 */
let defaultClaudeApiBackend: ClaudeApiBackend | undefined;

function getDefaultClaudeApiBackend(): ClaudeApiBackend {
  if (!defaultClaudeApiBackend) {
    defaultClaudeApiBackend = new ClaudeApiBackend();
  }
  return defaultClaudeApiBackend;
}

/** Test-only: reset the shared backend so one test's cache doesn't leak to another. */
export function _resetDefaultClaudeApiBackendForTests(): void {
  defaultClaudeApiBackend = undefined;
}

/**
 * Resolve a backend name to a concrete instance. Precedence:
 *   1. `override` (per-call, from `synthi_locate({preferred_vision_backend})`).
 *   2. `SYNTHI_VISION_BACKEND` env.
 *   3. **`agent_side` default.** The agent (Claude Code / Codex / etc.)
 *      already has vision via its outer model + the user's subscription;
 *      `agent_side` hands back the screenshot for the agent to ground and
 *      then re-call with `hints.prefer_region`. Zero API key on the MCP
 *      side. This mirrors how Figma/GitHub MCP servers work — the MCP
 *      returns data, the host's LLM reasons.
 *
 * `claude_api` / `gemini_api` remain explicit opt-ins for users who want
 * server-side caching or whose host is not vision-capable. `mock` stays
 * available for the phase-0.5 spike harness (no external calls).
 */
export function selectBackend(override?: LocateBackendName): VisionBackend {
  const envName = process.env["SYNTHI_VISION_BACKEND"] as LocateBackendName | undefined;
  const chosen = override ?? envName ?? "agent_side";
  switch (chosen) {
    case "mock":
      return new MockBackend();
    case "agent_side":
      return new AgentSideBackend();
    case "claude_api":
      return getDefaultClaudeApiBackend();
    default:
      return new AgentSideBackend();
  }
}
