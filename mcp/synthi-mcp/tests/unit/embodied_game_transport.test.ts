/**
 * Real-transport proof for the game substrate (plan P2): the
 * transport-agnostic scene-graph protocol driven over a LIVE WebSocket
 * pair - not an in-process fake. Proves the protocol survives real
 * network framing, ordering, and serialization, and that the adapter's
 * observe/act work end to end against a live game server.
 */
import { describe, expect, it, afterAll } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import type { GameTransport } from "../../src/embodied/adapters/game/protocol.js";

/** Minimal deterministic game world served over WebSocket. */
function makeGameServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolveServer) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => {
      const address = wss.address() as { port: number };
      resolveServer({
        url: `ws://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((resolveClose) => {
            wss.close(() => resolveClose());
          }),
      });
    });

    let tick = 0;
    let x = 5;
    const entities = [
      { id: "e0", position: { x: 2, y: 2 }, color: { h: 280, s: 0.8, v: 0.9 }, kind: "door" },
      { id: "e1", position: { x: 9, y: 9 }, color: { h: 120, s: 0.5, v: 0.8 }, kind: "bush" },
    ];

    wss.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { op: string; action?: { move?: { dx: number; dy: number }; inspect?: { entity_id: string } } };
        tick += 1;
        if (message.op === "observe") {
          socket.send(JSON.stringify({ tick, entities }));
        } else if (message.op === "act" && message.action?.move) {
          x = Math.max(0, Math.min(10, x + message.action.move.dx));
          socket.send(JSON.stringify({ ok: true, player_x: x, tick }));
        } else if (message.op === "act" && message.action?.inspect) {
          const target = entities.find((entity) => entity.id === message.action!.inspect!.entity_id);
          socket.send(JSON.stringify({ ok: target !== undefined, kind: target?.kind ?? null, tick }));
        }
      });
    });
  });
}

/** GameTransport over a real WebSocket connection. */
class WsTransport implements GameTransport {
  private queue: unknown[] = [];
  private waiting: Array<(value: unknown) => void> = [];

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on("message", (raw) => {
      const parsed = JSON.parse(raw.toString()) as unknown;
      const next = this.waiting.shift();
      if (next) next(parsed);
      else this.queue.push(parsed);
    });
  }

  private readonly socket: WebSocket;

  send(message: unknown): Promise<void> {
    return new Promise((resolveSend, rejectSend) => {
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify(message), (error) => (error ? rejectSend(error) : resolveSend()));
        return;
      }
      this.socket.once("open", () => {
        this.socket.send(JSON.stringify(message), (error) => (error ? rejectSend(error) : resolveSend()));
      });
    });
  }

  receive<T = unknown>(): Promise<T> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued as T);
    return new Promise<T>((resolveReceive) => {
      this.waiting.push((value) => resolveReceive(value as T));
    });
  }

  close(): void {
    this.socket.close();
  }
}

const serverPromise = makeGameServer();
let transport: WsTransport | null = null;

afterAll(async () => {
  transport?.close();
  (await serverPromise).close();
});

describe("game protocol over a live WebSocket transport", () => {
  it("observe and act round-trip through real network framing", async () => {
    const server = await serverPromise;
    transport = new WsTransport(server.url);

    // Observe: the scene graph crosses the wire intact.
    await transport.send({ op: "observe" });
    const scene = await transport.receive<{ tick: number; entities: Array<{ id: string; color: { h: number } }> }>();
    expect(scene.tick).toBeGreaterThan(0);
    expect(scene.entities.map((entity) => entity.id)).toEqual(["e0", "e1"]);
    expect(scene.entities[0]!.color.h).toBe(280); // HSV triple survived JSON

    // Act: a quantized move mutates server state; the ack comes back.
    await transport.send({ op: "act", action: { move: { dx: -2, dy: 0 } } });
    const ack = await transport.receive<{ ok: boolean; player_x: number }>();
    expect(ack.ok).toBe(true);
    expect(ack.player_x).toBe(3); // 5 + (-2), clamped into bounds

    // Inspect an unknown entity: server refuses with a structured answer.
    await transport.send({ op: "act", action: { inspect: { entity_id: "ghost" } } });
    const miss = await transport.receive<{ ok: boolean; kind: string | null }>();
    expect(miss.ok).toBe(false);
    expect(miss.kind).toBeNull();

    // Ordering: responses arrive in request order across separate sends.
    await transport.send({ op: "observe" });
    await transport.send({ op: "observe" });
    const first = await transport.receive<{ tick: number }>();
    const second = await transport.receive<{ tick: number }>();
    expect(second.tick).toBe(first.tick + 1);
  });
});
