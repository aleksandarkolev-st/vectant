import { describe, expect, it } from "vitest";
import { startDojoApiFaultServer } from "../../src/dojo/vivarium/api_fault_server.js";

describe("Dojo API fault server", () => {
  it("returns fake visual success while durable state remains uncommitted", async () => {
    const server = await startDojoApiFaultServer({ behavior: "fake_success" });
    try {
      const response = await fetch(`${server.url}/synthetic/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invoice_id: "synthetic-invoice" }),
      });
      const body = await response.json() as Record<string, unknown>;
      const state = await fetchState(server.url);

      expect(response.status).toBe(200);
      expect(body).toEqual(expect.objectContaining({
        ok: true,
        visual_success: true,
        durable_success: false,
      }));
      expect(state).toEqual(expect.objectContaining({
        committed: false,
        fake_success: true,
        records: [],
      }));
    } finally {
      await server.close();
    }
  });

  it("leaves an oracle-detectable partial write", async () => {
    const server = await startDojoApiFaultServer({ behavior: "partial_write" });
    try {
      const response = await fetch(`${server.url}/synthetic/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invoice_id: "synthetic-invoice", amount: 42 }),
      });
      const body = await response.json() as Record<string, unknown>;
      const state = await fetchState(server.url);

      expect(response.status).toBe(207);
      expect(body).toEqual(expect.objectContaining({ ok: false, partial: true, durable_success: false }));
      expect(state).toEqual(expect.objectContaining({
        committed: false,
        partial: true,
        records: expect.arrayContaining([
          expect.objectContaining({ write_state: "partial" }),
        ]),
      }));
    } finally {
      await server.close();
    }
  });

  it("supports success, validation error, timeout, and downstream failure behaviors", async () => {
    const expectations = [
      { behavior: "success" as const, status: 200, committed: true },
      { behavior: "validation_error" as const, status: 422, validation_error: true },
      { behavior: "timeout" as const, status: 504 },
      { behavior: "downstream_failure" as const, status: 503, downstream_failed: true },
    ];

    for (const expected of expectations) {
      const server = await startDojoApiFaultServer({ behavior: expected.behavior, timeout_ms: 1 });
      try {
        const response = await fetch(`${server.url}/synthetic/action`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ok: true }),
        });
        const state = await fetchState(server.url);

        expect(response.status).toBe(expected.status);
        if ("committed" in expected) expect(state.committed).toBe(expected.committed);
        if ("validation_error" in expected) expect(state.validation_error).toBe(expected.validation_error);
        if ("downstream_failed" in expected) expect(state.downstream_failed).toBe(expected.downstream_failed);
      } finally {
        await server.close();
      }
    }
  });
});

async function fetchState(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${url}/synthetic/state`);
  expect(response.status).toBe(200);
  return await response.json() as Record<string, unknown>;
}
