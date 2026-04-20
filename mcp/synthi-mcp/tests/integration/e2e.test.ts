import { afterAll, describe, expect, it } from "vitest";

/**
 * End-to-end integration test against a running Synthi stack.
 *
 * PREREQUISITES:
 *   1. `docker-compose up -d` from the repo root (brings up redis, postgres,
 *      y-sweet, collab-server, signaling-server, ai-engine, ai-gateway,
 *      worker, frontend).
 *   2. SYNTHI_MCP_E2E=1 to opt-in; otherwise this suite is skipped.
 *   3. Optional: SYNTHI_MCP_E2E_SLUG=<slug> to reuse an existing workspace
 *      slug; otherwise one will be created.
 *   4. Optional: SYNTHI_MCP_E2E_BASELINE=<file> for the pHash comparison.
 *
 * Flow:
 *   1. POST http://localhost:1234/session/create  → capture {sessionId}
 *   2. session.attach({sessionId, signalingUrl:"ws://localhost:9000"})
 *   3. frames.getFrame() → assert PNG ≥ 1KB, dims match attach resolution
 *   4. [fixture-dependent] edit counter source via collab-server file-write
 *   5. hmr.waitForTerminal({timeoutMs:60000}) → expect status:"applied"
 *   6. frames.getFrame() → expect pHash distance > 4 from baseline
 *
 * Fixture (M0 decision, pending): SDL2/C++ counter preferred — exercises both
 * CandidateNotification and bare HmrStatus wire families via the runner
 * reload path. Swing/JVM counter covers adapter-handled path only.
 */

const E2E_ENABLED = process.env.SYNTHI_MCP_E2E === "1";
const COLLAB_URL = process.env.SYNTHI_MCP_COLLAB_URL ?? "http://localhost:1234";
const SIGNALING_URL = process.env.SYNTHI_MCP_SIGNALING_URL ?? "ws://localhost:9000";

const describeE2E = E2E_ENABLED ? describe : describe.skip;

describeE2E("MCP e2e (docker-compose)", () => {
  let sessionId: string | null = null;

  afterAll(async () => {
    if (!E2E_ENABLED) return;
    const { session } = await import("../../src/session.js");
    await session.close();
  });

  it("creates a session via collab-server REST", async () => {
    const res = await fetch(`${COLLAB_URL}/session/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hostId: "mcp-test-host",
        hostName: "MCP Test Host",
        hostAvatar: "",
        slug: process.env.SYNTHI_MCP_E2E_SLUG ?? "counter",
        defaultPerms: {},
      }),
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { sessionId: string };
    expect(typeof body.sessionId).toBe("string");
    expect(body.sessionId.length).toBeGreaterThan(0);
    sessionId = body.sessionId;
  });

  it("attaches over WebRTC without requiring a video frame", async () => {
    if (!sessionId) throw new Error("session not created in prior step");
    const { session } = await import("../../src/session.js");
    const attached = await session.attach({
      sessionId,
      signalingUrl: SIGNALING_URL,
      attachTimeoutMs: 30_000,
    });
    expect(attached.sessionId).toBe(sessionId);
  }, 60_000);

  it("synthi_screenshot returns a valid PNG", async () => {
    const { session } = await import("../../src/session.js");
    const s = session.require();
    const frame = await s.frames.getFrame();
    expect(frame.data.length).toBeGreaterThan(1024);
    // PNG magic bytes
    expect(frame.data.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(frame.width).toBe(s.resolution.width);
    expect(frame.height).toBe(s.resolution.height);
  });

  // Fixture-dependent steps (edit → wait_hmr → diff screenshot) live behind
  // SYNTHI_MCP_E2E_FIXTURE=1; skipped until M0 fixture decision + seed file
  // write path lands.
  const FIXTURE_ENABLED = process.env.SYNTHI_MCP_E2E_FIXTURE === "1";
  const fixtureDescribe = FIXTURE_ENABLED ? describe : describe.skip;

  fixtureDescribe("counter fixture edit → wait_hmr → screenshot diff", () => {
    it("edits the counter source and observes HMR applied", async () => {
      // TODO: wire a real collab-server file-write REST + pHash comparison
      // once the M0 fixture is picked (SDL2/C++ vs Swing).
      expect(true).toBe(true);
    });
  });
});
