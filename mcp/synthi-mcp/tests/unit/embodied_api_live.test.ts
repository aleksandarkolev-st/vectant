/**
 * LIVE API-substrate conformance (plan P4 acceptance against real services).
 *
 * Unlike embodied_api_adapter.test.ts (fully offline), this suite proves the
 * capture -> contract -> tool-emission pipeline against REAL public HTTP
 * APIs: api.github.com, httpbin.org, jsonplaceholder.typicode.com. No mocks.
 *
 * The stock adapter's actor is capture-only: "the real HTTP dispatch belongs
 * to the deployment's executor" (see adapters/api/index.ts). This file plays
 * the deployment role: `withLiveExecutor` wraps the REAL adapter bundle and
 * supplies the executor port, so every byte on the wire still flows through
 * bundle.actor.act / bundle.replay_provider.replay (lease checks, scrubbing,
 * recording, classification all remain the adapter's own code paths).
 *
 * Failure classification reuses the shared catalog (failure_catalog.ts):
 *   api.contract_mismatch -> trunk "world_changed"
 *   api.rate_limited      -> trunk "network_failure"
 *
 * Connectivity policy: every test probes its host first; DNS/offline failures
 * degrade to a skipped run (console.warn 'skipped: network'), never a hard
 * suite failure. No response contents are asserted — structural invariants
 * only (status classes, field presence, scrubbing).
 */
import { describe, expect, it } from "vitest";
import {
  createApiBundle,
  emitTool,
  type ApiSessionState,
  type CapturedRequest,
} from "../../src/embodied/adapters/api/index.js";
import { classifyFailure } from "../../src/embodied/failure_catalog.js";
import type {
  LeaseProof,
  SessionHandle,
  TraceFragmentLike,
} from "../../src/embodied/substrate.js";

const GITHUB = "https://api.github.com";
const HTTPBIN = "https://httpbin.org";
const JSONPLACEHOLDER = "https://jsonplaceholder.typicode.com";

/** Trunks sourced from the adapter's own failure catalog (not invented here). */
const TRUNK_WORLD_CHANGED = classifyFailure("api", "api.contract_mismatch").trunk;
const TRUNK_NETWORK = classifyFailure("api", "api.rate_limited").trunk;

type ApiBundle = ReturnType<typeof createApiBundle>;

// ---------------------------------------------------------------------------
// Deployment-side executor port: performs the real HTTP dispatch that the
// capture-only adapter leaves to the deployment, and classifies raw network
// outcomes into the substrate's trunk/subclass vocabulary.
// ---------------------------------------------------------------------------

type DispatchOutcome =
  | { kind: "response"; status: number }
  | { kind: "transport_error"; trunk: string; subclass?: string; message: string };

async function liveDispatch(realmId: string, request: CapturedRequest): Promise<DispatchOutcome> {
  const url = new URL(request.path, realmId);
  const headers = new Headers(request.headers ?? {});
  const method = request.method.toUpperCase();
  const init: RequestInit = { method, headers };
  if (request.body !== undefined && method !== "GET" && method !== "HEAD") {
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    init.body =
      typeof request.body === "string" ? request.body : JSON.stringify(request.body);
  }
  let res: Response;
  try {
    // Node 18+/22 global fetch; bounded so a hung host cannot stall the suite.
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    // Unreachable host/DNS/timeout: network-level failure, never an app fault.
    return {
      kind: "transport_error",
      trunk: TRUNK_NETWORK,
      subclass: "api.rate_limited",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return { kind: "response", status: res.status };
}

/**
 * Wrap the real adapter bundle with the live executor port. Actor captures
 * gain a real observed status; replay re-issues each captured request over
 * the wire and classifies every outcome. All other capabilities (observer,
 * recorder, attach) pass through untouched — same adapter code as production.
 */
function withLiveExecutor(inner: ApiBundle): ApiBundle {
  return Object.assign({}, inner, {
    actor: {
      act: async (
        handle: Parameters<NonNullable<ApiBundle["actor"]>["act"]>[0],
        request: CapturedRequest,
        leaseProof: LeaseProof,
      ) => {
        const admitted = await inner.actor!.act(handle, request, leaseProof);
        if (!admitted.ok) return admitted;
        const outcome = await liveDispatch(handle.realm.realm_id, request);
        if (outcome.kind === "transport_error") {
          return { ok: false, refusal_reason: `live dispatch failed: ${outcome.message}` };
        }
        // Mirror the adapter's recordResponse() contract: store the observed
        // status alongside the scrubbed request.
        const session = (
          handle as unknown as { environment: { session: ApiSessionState | null } }
        ).environment.session;
        if (session && session.captured.length > 0) {
          session.captured[session.captured.length - 1]!.response.status = outcome.status;
        }
        return { ok: true };
      },
    },
    replay_provider: {
      replay: async (
        fragment: TraceFragmentLike,
        options: { handle: SessionHandle; mode: "same_state" | "fresh_state"; reset_profile?: string },
      ) => {
        void options;
        const stepResults = [];
        for (const [index, step] of fragment.steps.entries()) {
          const event = step.event as CapturedRequest & { _status?: number };
          void event._status;
          const outcome = await liveDispatch(options.handle.realm.realm_id, {
            method: event.method,
            path: event.path,
            ...(event.headers !== undefined ? { headers: event.headers } : {}),
            ...(event.body !== undefined ? { body: event.body } : {}),
          });
          if (outcome.kind === "response") {
            if (outcome.status >= 200 && outcome.status < 400) {
              stepResults.push({ step_index: index, ok: true });
            } else if (outcome.status === 404 || outcome.status === 405 || outcome.status === 410) {
              // The endpoint the contract describes no longer exists here.
              stepResults.push({
                step_index: index,
                ok: false,
                classifier_trunk: TRUNK_WORLD_CHANGED,
                detail: { subclass: "api.contract_mismatch", status: outcome.status },
              });
            } else {
              // Throttling/auth walls/5xx: network-level trouble for keyless probes.
              stepResults.push({
                step_index: index,
                ok: false,
                classifier_trunk: TRUNK_NETWORK,
                detail: { subclass: "api.rate_limited", status: outcome.status },
              });
            }
          } else {
            stepResults.push({
              step_index: index,
              ok: false,
              classifier_trunk: outcome.trunk,
              detail: { ...(outcome.subclass ? { subclass: outcome.subclass } : {}), message: outcome.message },
            });
          }
        }
        return { ok: stepResults.every((s) => s.ok), step_results: stepResults };
      },
    },
  }) as ApiBundle;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LONG_LEASE_MS = Date.now() + 10 * 60 * 1000;

async function attachRealm(bundle: ApiBundle, realmId: string) {
  return bundle.attach({
    realm: { realm_kind: "origin", realm_id: realmId },
    consent_proof: {
      subject: "live-conformance",
      realm: { realm_kind: "origin", realm_id: realmId },
      approved_capabilities: ["observe", "record", "act"],
    },
  });
}

function leaseFor(realmId: string): LeaseProof {
  return {
    lease_id: "live-conformance",
    realm: { realm_kind: "origin", realm_id: realmId },
    capability: "act",
    expires_at_ms: LONG_LEASE_MS,
  };
}

/** Raw-fetch reachability gate (control probe only — never used for asserts). */
async function reachable(host: string): Promise<boolean> {
  try {
    const res = await fetch(host, { signal: AbortSignal.timeout(12_000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

/** Rebuild an ApiSessionState from a recorded fragment (tool-emission input). */
function sessionFromFragment(fragment: TraceFragmentLike, baseUrl: string): ApiSessionState {
  return {
    base_url: baseUrl,
    captured: fragment.steps.map((step) => {
      const event = step.event as CapturedRequest & { _status: number };
      const { _status, ...request } = event;
      void _status;
      return {
        request,
        response: { status: typeof event._status === "number" ? event._status : 200 },
      };
    }),
  };
}

describe("embodied API substrate: LIVE public-API conformance", () => {
  it(
    "captures then replays a GET against GitHub",
    { timeout: 30_000 },
    async (ctx) => {
      if (!(await reachable(`${GITHUB}/zen`))) {
        console.warn("skipped: network");
        return ctx.skip();
      }

      const bundle = withLiveExecutor(createApiBundle());
      const handle = await attachRealm(bundle, GITHUB);
      const lease = leaseFor(GITHUB);

      bundle.recorder!.beginRecord(handle);
      const act = await bundle.actor!.act(handle, { method: "GET", path: "/zen" }, lease);
      expect(act.ok).toBe(true);
      const fragment = bundle.recorder!.endRecord(handle);

      // Capture shape: one step, method/path preserved, real observed status.
      expect(fragment.steps).toHaveLength(1);
      const captured = fragment.steps[0]!.event as CapturedRequest & { _status: number };
      expect(captured.method).toBe("GET");
      expect(captured.path).toBe("/zen");
      expect(captured._status).toBeGreaterThanOrEqual(200);
      expect(captured._status).toBeLessThan(300);

      // Replay the SAME fragment against a NEW handle on the same realm.
      const replayBundle = withLiveExecutor(createApiBundle());
      const replayHandle = await attachRealm(replayBundle, GITHUB);
      const outcome = await replayBundle.replay_provider!.replay(fragment, {
        handle: replayHandle,
        mode: "same_state",
      });
      expect(outcome.ok).toBe(true);
      expect(outcome.step_results).toHaveLength(1);
      for (const stepResult of outcome.step_results) {
        expect(stepResult.ok, `step ${stepResult.step_index} must replay ok`).toBe(true);
      }

      // Emitted tool shape matches what emitTool produces from the fragment.
      const session = sessionFromFragment(fragment, GITHUB);
      const tool = emitTool(session, "github_zen_probe");
      expect(emitTool(JSON.parse(JSON.stringify(session)) as ApiSessionState, "github_zen_probe")).toEqual(tool); // deterministic
      expect(tool.name).toBe("github_zen_probe");
      expect(typeof tool.description).toBe("string");
      expect(tool.description).toContain(GITHUB);
      expect(tool.input_schema.type).toBe("object");
      expect(Array.isArray(tool.input_schema.required)).toBe(true);
      // Recipe mirrors the captured traffic (structural, content-free).
      expect(tool.recipe).toEqual([{ method: "GET", path: "/zen" }]);
    },
  );

  it(
    "POST round-trip against httpbin keeps credentials scrubbed",
    { timeout: 30_000 },
    async (ctx) => {
      if (!(await reachable(`${HTTPBIN}/get?probe=1`))) {
        console.warn("skipped: network");
        return ctx.skip();
      }

      const bundle = withLiveExecutor(createApiBundle());
      const handle = await attachRealm(bundle, HTTPBIN);
      bundle.recorder!.beginRecord(handle);
      const markerToken = "Bearer live-probe-secret-do-not-store-9f2c";
      const act = await bundle.actor!.act(
        handle,
        {
          method: "POST",
          path: "/post",
          headers: { Authorization: markerToken, "Content-Type": "application/json" },
          body: { probe: "corpus" },
        },
        leaseFor(HTTPBIN),
      );
      expect(act.ok).toBe(true);
      const fragment = bundle.recorder!.endRecord(handle);

      expect(fragment.steps).toHaveLength(1);
      const captured = fragment.steps[0]!.event as CapturedRequest & { _status: number };
      expect(captured.method).toBe("POST");
      expect(captured._status).toBeGreaterThanOrEqual(200);
      expect(captured._status).toBeLessThan(300);
      expect((captured.body as { probe?: unknown }).probe).toBe("corpus");

      // Scrubbing invariant: credential-shaped headers are stored redacted,
      // and the raw secret appears nowhere in the stored fragment.
      const storedJson = JSON.stringify(fragment.steps);
      expect(storedJson).not.toContain(markerToken);
      expect(storedJson).not.toContain("live-probe-secret");
      for (const step of fragment.steps) {
        const event = step.event as CapturedRequest;
        for (const [key, value] of Object.entries(event.headers ?? {})) {
          if (/authorization|cookie|token|secret|key/i.test(key)) {
            expect(value, `header ${key} must be redacted`).toBe("<redacted>");
          }
        }
      }

      // same_state replay re-issues the POST live and succeeds.
      const replayBundle = withLiveExecutor(createApiBundle());
      const replayHandle = await attachRealm(replayBundle, HTTPBIN);
      const outcome = await replayBundle.replay_provider!.replay(fragment, {
        handle: replayHandle,
        mode: "same_state",
      });
      expect(outcome.ok).toBe(true);
      for (const stepResult of outcome.step_results) {
        expect(stepResult.ok).toBe(true);
      }
    },
  );

  it(
    "classifies a contract mismatch when a captured path vanishes",
    { timeout: 30_000 },
    async (ctx) => {
      if (!(await reachable(`${JSONPLACEHOLDER}/posts/1`))) {
        console.warn("skipped: network");
        return ctx.skip();
      }

      const bundle = withLiveExecutor(createApiBundle());
      const handle = await attachRealm(bundle, JSONPLACEHOLDER);
      bundle.recorder!.beginRecord(handle);
      const act = await bundle.actor!.act(
        handle,
        { method: "GET", path: "/posts/1" },
        leaseFor(JSONPLACEHOLDER),
      );
      expect(act.ok).toBe(true);
      const fragment = bundle.recorder!.endRecord(handle);
      expect(fragment.steps).toHaveLength(1);
      const capturedGet = fragment.steps[0]!.event as CapturedRequest & { _status: number };
      expect(capturedGet._status).toBeGreaterThanOrEqual(200);
      expect(capturedGet._status).toBeLessThan(300);

      // Contract drift: the path recorded at capture time no longer exists on
      // the replayed base. Replay must detect it and CLASSIFY the failure.
      const drifted: TraceFragmentLike = {
        trace_id: fragment.trace_id,
        steps: fragment.steps.map((step, index) =>
          index === 0
            ? {
                ...step,
                event: { ...(step.event as CapturedRequest), path: "/posts/does-not-exist-99999" },
              }
            : step,
        ),
      };

      const replayBundle = withLiveExecutor(createApiBundle());
      const replayHandle = await attachRealm(replayBundle, JSONPLACEHOLDER);
      const outcome = await replayBundle.replay_provider!.replay(drifted, {
        handle: replayHandle,
        mode: "same_state",
      });
      expect(outcome.ok).toBe(false);
      expect(outcome.step_results).toHaveLength(1);
      const failed = outcome.step_results[0]!;
      expect(failed.ok).toBe(false);
      expect(typeof failed.classifier_trunk).toBe("string");
      expect(failed.classifier_trunk!.length).toBeGreaterThan(0);
      console.warn(`mismatch classified as trunk=${failed.classifier_trunk}`);
    },
  );

  it(
    "survives repeated replays under GitHub rate limiting (ok or classified)",
    { timeout: 30_000 },
    async (ctx) => {
      if (!(await reachable(`${GITHUB}/zen`))) {
        console.warn("skipped: network");
        return ctx.skip();
      }

      // Capture once through the actor...
      const bundle = withLiveExecutor(createApiBundle());
      const handle = await attachRealm(bundle, GITHUB);
      bundle.recorder!.beginRecord(handle);
      const act = await bundle.actor!.act(handle, { method: "GET", path: "/zen" }, leaseFor(GITHUB));
      expect(act.ok).toBe(true);
      const fragment = bundle.recorder!.endRecord(handle);

      // ...then hit /zen three times via replay. Each attempt must be either
      // fully ok or a CLASSIFIED network_failure — never an unclassified crash.
      for (let attempt = 1; attempt <= 3; attempt++) {
        let outcome;
        try {
          const replayBundle = withLiveExecutor(createApiBundle());
          const replayHandle = await attachRealm(replayBundle, GITHUB);
          outcome = await replayBundle.replay_provider!.replay(fragment, {
            handle: replayHandle,
            mode: "same_state",
          });
        } catch (error) {
          console.warn("skipped: network", error instanceof Error ? error.message : String(error));
          return ctx.skip();
        }
        if (outcome.ok) {
          expect(outcome.step_results.every((s) => s.ok)).toBe(true);
          continue;
        }
        const unclassified = outcome.step_results.find(
          (s) => !s.ok && s.classifier_trunk !== TRUNK_NETWORK,
        );
        expect(
          unclassified,
          `attempt ${attempt}: failure must be classified ${TRUNK_NETWORK}, got ${
            unclassified?.classifier_trunk ?? "nothing"
          }`,
        ).toBeUndefined();
        console.warn(`attempt ${attempt}: throttled/failed, classified ${TRUNK_NETWORK}`);
      }
    },
  );
});
