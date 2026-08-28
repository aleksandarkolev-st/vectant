import { describe, expect, it } from "vitest";
import {
  createApiBundle,
  emitTool,
  type CapturedRequest,
} from "../../src/embodied/adapters/api/index.js";

const REALM = "https://api.example.test";
const LEASE = {
  lease_id: "l",
  realm: { realm_kind: "origin", realm_id: REALM },
  capability: "act" as const,
  expires_at_ms: Number.MAX_SAFE_INTEGER,
};

async function makeHandle() {
  const bundle = createApiBundle();
  return bundle.attach({
    realm: { realm_kind: "origin", realm_id: REALM },
    consent_proof: {
      subject: "t",
      realm: { realm_kind: "origin", realm_id: REALM },
      approved_capabilities: ["observe", "record", "act"],
    },
  });
}

describe("API substrate: capture -> contract -> tool emission (P4)", () => {
  it("captures a flow with secrets scrubbed and emits a deterministic tool", async () => {
    const bundle = createApiBundle();
    const handle = await makeHandle();
    bundle.recorder!.beginRecord(handle);

    await bundle.actor!.act(
      handle,
      {
        method: "POST",
        path: "/v1/projects",
        headers: { Authorization: "Bearer super-secret-token", "Content-Type": "application/json" },
        body: { name: "alpha", visibility: "private" },
      },
      LEASE,
    );
    await bundle.actor!.act(
      handle,
      {
        method: "POST",
        path: "/v1/projects/alpha/deploy",
        body: { branch: "main" },
      },
      LEASE,
    );

    const fragment = bundle.recorder!.endRecord(handle);
    expect(fragment.steps).toHaveLength(2);
    // The credential header value was scrubbed before storage.
    const first = fragment.steps[0]!.event as CapturedRequest & { _status: number };
    expect(first.headers?.Authorization).toBe("<redacted>");
    expect(JSON.stringify(first)).not.toContain("super-secret-token");

    // Rebuild a session state from the captured steps and emit a tool.
    const session = {
      base_url: REALM,
      captured: fragment.steps.map((step) => {
        const event = step.event as CapturedRequest & { _status: number };
        const { _status, ...request } = event;
        void _status;
        return { request, response: { status: 200 } };
      }),
    };
    const toolA = emitTool(session, "deploy_project");
    const toolB = emitTool(session, "deploy_project");
    expect(toolA).toEqual(toolB); // deterministic emission
    expect(toolA.name).toBe("deploy_project");
    expect(Object.keys(toolA.input_schema.properties).sort()).toEqual(["branch", "name", "visibility"]);
    expect(toolA.input_schema.required).toContain("name");
    expect(toolA.recipe).toHaveLength(2);
    expect(toolA.recipe[0]).toEqual({
      method: "POST",
      path: "/v1/projects",
      body: { name: "alpha", visibility: "private" },
    });

    // Recipe shape validates through the adapter's replay (T0 contract).
    const replayHandle = await makeHandle();
    const outcome = await bundle.replay_provider!.replay(fragment, {
      handle: replayHandle,
      mode: "same_state",
    });
    expect(outcome.ok).toBe(true);
  });

  it("refuses capture without an active session or valid lease", async () => {
    const bundle = createApiBundle();
    const handle = await makeHandle();
    const noSession = await bundle.actor!.act(
      handle,
      { method: "GET", path: "/" },
      LEASE,
    );
    expect(noSession.ok).toBe(false);
    expect(noSession.refusal_reason).toContain("no active capture");

    bundle.recorder!.beginRecord(handle);
    const expired = await bundle.actor!.act(
      handle,
      { method: "GET", path: "/" },
      { ...LEASE, expires_at_ms: Date.now() - 1 },
    );
    expect(expired.ok).toBe(false);
  });
});
