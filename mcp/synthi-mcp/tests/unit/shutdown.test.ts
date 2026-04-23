/**
 * Unit tests for the graceful-shutdown orchestration.
 *
 * What we test:
 *   - Teardown order: cancel_in_flight -> close_session -> close_server
 *     -> unbind_metrics -> close_metrics_server.
 *   - Each step is try-isolated; an error in one does not prevent later
 *     steps from running.
 *   - Optional targets can be omitted.
 *   - requestRegistry.cancelAll() actually aborts in-flight signals
 *     registered before shutdown was invoked.
 *
 * What we do NOT test (out of scope):
 *   - process.exit() exit-code behavior — that's the thin wrapper in
 *     index.ts, not the shutdown function itself.
 *   - stdio framing guarantees — handled by the MCP SDK + transport.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { performShutdown, type ShutdownStep } from "../../src/shutdown.js";
import { RequestRegistry } from "../../src/util/request_registry.js";

function makeStub(name: string, order: string[], throwInstead?: boolean): { close: () => Promise<void> } {
  return {
    async close(): Promise<void> {
      order.push(name);
      if (throwInstead) throw new Error(`${name} boom`);
    },
  };
}

describe("performShutdown — happy path", () => {
  it("runs steps in the canonical order", async () => {
    const order: string[] = [];
    const reg = new RequestRegistry();
    const session = makeStub("session", order);
    const server = makeStub("server", order);
    const unbindMetrics = (): void => {
      order.push("unbind");
    };
    const metricsServer = { close: (): void => void order.push("metrics") };

    const ran = await performShutdown({
      requestRegistry: reg,
      session,
      server,
      unbindMetrics,
      metricsServer,
    });

    expect(ran).toEqual<ShutdownStep[]>([
      "cancel_in_flight",
      "close_session",
      "close_server",
      "unbind_metrics",
      "close_metrics_server",
    ]);
    expect(order).toEqual(["session", "server", "unbind", "metrics"]);
  });

  it("requestRegistry.cancelAll aborts in-flight signals", async () => {
    const reg = new RequestRegistry();
    const h1 = reg.register("t1");
    const h2 = reg.register("t2");
    await performShutdown({ requestRegistry: reg });
    expect(h1.signal.aborted).toBe(true);
    expect(h2.signal.aborted).toBe(true);
    expect(reg.size()).toBe(0);
  });
});

describe("performShutdown — partial targets", () => {
  it("runs only the steps that have targets defined", async () => {
    const session = makeStub("session", []);
    const ran = await performShutdown({ session });
    expect(ran).toEqual(["close_session"]);
  });

  it("empty target runs nothing", async () => {
    const ran = await performShutdown({});
    expect(ran).toEqual([]);
  });
});

describe("performShutdown — error isolation", () => {
  let calls: string[];
  beforeEach(() => {
    calls = [];
  });

  it("a throwing session.close does not skip subsequent steps", async () => {
    const errs: Array<{ step: ShutdownStep; msg: string }> = [];
    const reg = new RequestRegistry();
    const session = makeStub("session", calls, true);
    const server = makeStub("server", calls);
    const unbindMetrics = (): void => void calls.push("unbind");

    const ran = await performShutdown({
      requestRegistry: reg,
      session,
      server,
      unbindMetrics,
      logError: (step, err) => {
        errs.push({ step, msg: (err as Error).message });
      },
    });

    expect(ran).toEqual<ShutdownStep[]>([
      "cancel_in_flight",
      "close_session",
      "close_server",
      "unbind_metrics",
    ]);
    expect(calls).toEqual(["session", "server", "unbind"]);
    expect(errs).toEqual([{ step: "close_session", msg: "session boom" }]);
  });

  it("a throwing registry does not prevent session / server teardown", async () => {
    const errs: Array<{ step: ShutdownStep }> = [];
    const registry = {
      cancelAll(): number {
        throw new Error("registry oh no");
      },
    };
    const session = makeStub("session", calls);
    const server = makeStub("server", calls);

    await performShutdown({
      requestRegistry: registry,
      session,
      server,
      logError: (step) => {
        errs.push({ step });
      },
    });

    expect(calls).toEqual(["session", "server"]);
    expect(errs).toEqual([{ step: "cancel_in_flight" }]);
  });

  it("a throwing metricsServer.close still counts as ran", async () => {
    const errs: Array<{ step: ShutdownStep }> = [];
    const metricsServer = {
      close(): void {
        throw new Error("metrics boom");
      },
    };

    const ran = await performShutdown({
      metricsServer,
      logError: (step) => void errs.push({ step }),
    });

    expect(ran).toEqual<ShutdownStep[]>(["close_metrics_server"]);
    expect(errs).toEqual([{ step: "close_metrics_server" }]);
  });
});
