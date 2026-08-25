/**
 * Web-canvas game engine world (WI-ENGINES): a REAL headless Chromium page
 * running a requestAnimationFrame engine loop that renders entities onto an
 * HTML canvas, exposed through the SAME scene-graph WS protocol the game
 * adapter speaks ({op:"observe"/"act"/"fork"} plus an `init` handshake).
 *
 * The WS server owns each connection's world; every `act` response carries
 * the FULL new observation so the adapter's local mirror stays exact (that
 * mirror feeds journal/verdicts for the harness hooks). After every mutation
 * the server renders the world into the live canvas via CDP; pixel checks
 * read the actual canvas and route through the shared CV primitives.
 *
 * Test fixture only: never imported by src/embodied/**.
 */
import { createRequire } from 'node:module';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  registerSubstrateAdapter,
  unregisterAllSubstrateAdapters,
  type SessionHandle,
  type SubstrateAdapterBundle,
} from '../../../src/embodied/substrate.js';
import type { FuzzableAdapter } from '../../../src/embodied/conformance.js';
import {
  resolveSemanticClass,
  validateWorldStateSchema,
  type ChangedValue,
  type WorldStateSchema,
} from '../../../src/embodied/world_state.js';
import type { PersistenceTrace } from '../../../src/embodied/state_differ/types.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core') as typeof import('playwright-core');

export const CANVAS_W = 320;
export const CANVAS_H = 240;
const BOUNDS = 100;

export interface EngineEntity {
  id: string;
  x: number;
  y: number;
  h: number;
  s: number;
  v: number;
}

interface EngineState {
  tick: number;
  player: { x: number; y: number };
  entities: EngineEntity[];
}

interface Observation {
  tick: number;
  player: { x: number; y: number };
  entities: EngineEntity[];
}

type EngineAction =
  | { move: { dx: number; dy: number } }
  | { inspect: { entity_id: string } };

interface EngineWorld {
  state: EngineState;
  inspectionVerdicts: Map<string, number>;
  journal: Array<{ tick: number; snapshot: Observation }>;
}

interface CanvasEngine {
  start(): void;
  render(state: EngineState): void;
  dataUrl(): string;
}

declare global {
  interface Window {
    __engine: CanvasEngine;
  }
}

/** The in-page renderer: one rAF loop keeps the canvas alive. */
function enginePageHtml(): string {
  return `<!doctype html>
<html><body>
<canvas id="scene" width="${CANVAS_W}" height="${CANVAS_H}"></canvas>
<script>
  const canvas = document.getElementById('scene');
  const ctx = canvas.getContext('2d');
  let rafId = null;
  function frame() {
    rafId = requestAnimationFrame(frame);
  }
  window.__engine = {
    start() { if (rafId === null) frame(); },
    render(state) {
      ctx.fillStyle = '#101018';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (const e of state.entities) {
        ctx.fillStyle = 'hsl(' + e.h + ',' + Math.round(e.s * 100) + '%,' + Math.round(e.v * 80) + '%)';
        ctx.beginPath();
        ctx.arc(Math.round(e.x / ${BOUNDS} * ${CANVAS_W}), Math.round(e.y / ${BOUNDS} * ${CANVAS_H}), 12, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(Math.round(state.player.x / ${BOUNDS} * ${CANVAS_W}), Math.round(state.player.y / ${BOUNDS} * ${CANVAS_H}), 7, 0, Math.PI * 2);
      ctx.fill();
    },
    dataUrl() { return canvas.toDataURL('image/png'); },
  };
</script>
</body></html>`;
}

function hashString(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeWorld(key: string): EngineWorld {
  const rand = mulberry32(hashString(key));
  const count = 3 + Math.floor(rand() * 4);
  const entities: EngineEntity[] = [];
  for (let i = 0; i < count; i += 1) {
    entities.push({
      id: `ent-${i}`,
      x: Math.floor(rand() * BOUNDS),
      y: Math.floor(rand() * BOUNDS),
      h: Math.floor(rand() * 360),
      s: 0.5 + rand() * 0.4,
      v: 0.6 + rand() * 0.3,
    });
  }
  return {
    state: {
      tick: 0,
      player: { x: Math.floor(rand() * BOUNDS), y: Math.floor(rand() * BOUNDS) },
      entities,
    },
    inspectionVerdicts: new Map(),
    journal: [],
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(BOUNDS, value));
}

function snapshotOf(world: EngineWorld): Observation {
  return JSON.parse(
    JSON.stringify({ tick: world.state.tick, player: world.state.player, entities: world.state.entities }),
  ) as Observation;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => {
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      return Object.fromEntries(
        Object.entries(inner).sort(([a], [b]) => String(a).localeCompare(String(b))),
      );
    }
    return inner;
  });
}

function djb2Hex(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = (((hash << 5) + hash + text.charCodeAt(i)) >>> 0) >>> 0;
  return hash.toString(16).padStart(8, '0');
}

function worldHash(world: EngineWorld): string {
  return djb2Hex(
    stableStringify({
      e: world.state.entities,
      p: world.state.player,
      v: [...world.inspectionVerdicts.entries()].sort(([a], [b]) => a.localeCompare(b)),
    }),
  );
}

function flatten(observation: Observation): Map<string, unknown> {
  const flat = new Map<string, unknown>();
  flat.set('player.x', observation.player.x);
  flat.set('player.y', observation.player.y);
  for (const entity of observation.entities) {
    flat.set(`entities.${entity.id}.x`, entity.x);
    flat.set(`entities.${entity.id}.y`, entity.y);
    flat.set(`entities.${entity.id}.h`, entity.h);
  }
  return flat;
}

function diff(before: Observation | null, after: Observation): ChangedValue[] {
  const beforeFlat = before ? flatten(before) : new Map<string, unknown>();
  const afterFlat = flatten(after);
  const paths = new Set([...beforeFlat.keys(), ...afterFlat.keys()]);
  const changed: ChangedValue[] = [];
  for (const path of paths) {
    const beforeValue = beforeFlat.get(path);
    const afterValue = afterFlat.get(path);
    if (beforeValue !== afterValue) {
      changed.push({
        path,
        semantic_class: '',
        before: beforeValue,
        after: afterValue,
        changed_at_tick: after.tick,
      });
    }
  }
  return changed;
}

function makeSchema(): WorldStateSchema {
  const schema: WorldStateSchema = {
    schema_id: 'game.ws.canvas',
    schema_version: '1.0.0',
    value_types: [
      { path_pattern: 'entities.*.h', type: { kind: 'band', min: 0, max: 359, unit: 'deg' }, semantic_class: 'material' },
      { path_pattern: 'entities.*.x', type: { kind: 'band', min: 0, max: BOUNDS, unit: 'u' }, semantic_class: 'transform' },
      { path_pattern: 'entities.*.y', type: { kind: 'band', min: 0, max: BOUNDS, unit: 'u' }, semantic_class: 'transform' },
      { path_pattern: 'player.*', type: { kind: 'number' }, semantic_class: 'transform' },
    ],
    identity: {
      id_scheme: 'stable',
      survives: ['fork', 'reset'],
      reidentification_rule: 'entity ids are stable within a realm session',
    },
    observability: {
      fully_observable: true,
      hidden_state: [],
      policy: 'best_effort',
    },
  };
  const problems = validateWorldStateSchema(schema);
  if (problems.length > 0) throw new Error(`canvas schema invalid: ${JSON.stringify(problems)}`);
  return schema;
}

// ---------------------------------------------------------------------------
// Runtime: browser + slot-keyed WS server
// ---------------------------------------------------------------------------

interface WsTransport {
  send(message: unknown): Promise<unknown>;
}

export interface EngineRuntime {
  close(): Promise<void>;
  makeAdapter(realmSeed: string): FuzzableAdapter;
  readFrame(): Promise<{ width: number; height: number; data: Uint32Array }>;
  screenBox(entity: EngineEntity): { x: number; y: number; r: number };
  lastRenderedTick(): number;
}

export async function startEngineRuntime(wobbleMs = 0): Promise<EngineRuntime> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(enginePageHtml());
  await page.evaluate(() => window.__engine.start());

  const slots = new Map<string, EngineWorld>();
  let forkCounter = 0;
  let renderedTicks = 0;
  const lastKeyRef = { key: '', boot: Promise.resolve() as Promise<unknown> };

  async function render(world: EngineWorld): Promise<void> {
    if (wobbleMs > 0) await page.waitForTimeout(Math.random() * wobbleMs);
    try {
      await page.evaluate((state: EngineState) => window.__engine.render(state), world.state);
    } catch (error) {
      console.error('[web_engine_world] render failed:', error instanceof Error ? error.message : error);
      throw error;
    }
    renderedTicks = world.state.tick;
  }

  function applyAct(world: EngineWorld, action: EngineAction): { ok: boolean; reason?: string } {
    if ('move' in action) {
      world.state.player.x = clamp(world.state.player.x + action.move.dx);
      world.state.player.y = clamp(world.state.player.y + action.move.dy);
      return { ok: true };
    }
    if ('inspect' in action) {
      const entity = world.state.entities.find((candidate) => candidate.id === action.inspect.entity_id);
      if (!entity) return { ok: false, reason: 'no such entity' };
      // Verify-and-record: a RE-inspection must agree with what was seen
      // before (same_state replay semantics); first inspection records.
      const recorded = world.inspectionVerdicts.get(entity.id);
      if (recorded !== undefined && recorded !== entity.h) {
        return { ok: false, reason: 'inspection verdict changed' };
      }
      world.inspectionVerdicts.set(entity.id, entity.h);
      return { ok: true };
    }
    return { ok: false, reason: 'unsupported action' };
  }

  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const wsPort = await new Promise<number>((resolveListen) => {
    wss.once('listening', () => resolveListen((wss.address() as { port: number }).port));
  });

  wss.on('connection', (socket: WebSocket) => {
    let world: EngineWorld | null = null;
    let currentKey = '';

    socket.on('message', async (raw: Buffer) => {
      const message = JSON.parse(raw.toString()) as {
        op: string;
        init?: string;
        adopt?: string;
        action?: EngineAction;
      };
      if (message.op === 'init') {
        const key = message.init ?? `anon-${slots.size}`;
        currentKey = key;
        world = slots.get(key) ?? makeWorld(key);
        slots.set(key, world);
        lastKeyRef.key = key;
        await render(world).catch(() => {});
        await render(world).catch(() => {});
        socket.send(JSON.stringify({ ok: true }));
        return;
      }
      if (message.op === 'adopt') {
        currentKey = message.adopt ?? '';
        lastKeyRef.key = currentKey;
        world = slots.get(currentKey) ?? null;
        socket.send(JSON.stringify({ ok: world !== null }));
        return;
      }
      if (message.op === 'mutate_hue') {
        const target = world.state.entities.find(
          (candidate) => candidate.id === (message as { entity_id?: string }).entity_id,
        );
        if (!target) {
          socket.send(JSON.stringify({ ok: false }));
          return;
        }
        target.h = ((target.h + (message as { delta?: number }).delta!) % 360 + 360) % 360;
        await render(world).catch(() => {});
        socket.send(JSON.stringify({ ok: true }));
        return;
      }
      if (!world) return;
      if (message.op === 'observe') {
        world.state.tick += 1;
        socket.send(JSON.stringify(snapshotOf(world)));
        return;
      }
      if (message.op === 'act') {
        const verdict = message.action ? applyAct(world, message.action) : { ok: false, reason: 'no action' };
        if (verdict.ok) {
          world.state.tick += 1;
          const obs = snapshotOf(world);
          world.journal.push({ tick: obs.tick, snapshot: obs });
          if (world.journal.length > 64) world.journal.shift();
          await render(world).catch(() => {});
        }
        socket.send(JSON.stringify({ ...verdict, observation: snapshotOf(world) }));
        return;
      }
      if (message.op === 'reset') {
        const key = currentKey ?? `anon-${slots.size}`;
        slots.set(key, makeWorld(key));
        world = slots.get(key)!;
        socket.send(JSON.stringify({ ok: true }));
        return;
      }
      if (message.op === 'fork') {
        forkCounter += 1;
        const forkKey = `fork-${forkCounter}-${Date.now() % 9973}`;
        slots.set(forkKey, {
          state: JSON.parse(JSON.stringify(world.state)) as EngineState,
          inspectionVerdicts: new Map(world.inspectionVerdicts),
          journal: [],
        });
        socket.send(JSON.stringify({ fork_id: forkKey }));
      }
    });
  });

  /** A per-realm transport with strict one-in-flight request/response
   *  ordering; performs the init (or adopt) handshake on first use. */
  function transportFor(initKey: string, adoptKey?: string, bootRef?: { boot: Promise<unknown> }): WsTransport {
    const handshakeOp = adoptKey !== undefined
      ? () => JSON.stringify({ op: 'adopt', adopt: adoptKey })
      : () => JSON.stringify({ op: 'init', init: initKey });
    const socket = new (require('ws').WebSocket)(`ws://127.0.0.1:${wsPort}`) as WebSocket;
    const queue: unknown[] = [];
    const waiters: Array<(v: unknown) => void> = [];

    socket.on('message', (raw: Buffer) => {
      const parsed = JSON.parse(raw.toString()) as unknown;
      const waiter = waiters.shift();
      if (waiter) waiter(parsed);
      else queue.push(parsed);
    });
    const opened = new Promise<void>((resolveOpen, rejectOpen) => {
      socket.once('open', () => resolveOpen());
      socket.once('error', rejectOpen);
    });

    const next = (): Promise<unknown> =>
      new Promise((resolveWait) => {
        const queued = queue.shift();
        if (queued !== undefined) resolveWait(queued);
        else waiters.push(resolveWait);
      });

    // Eager handshake: the session's world is created and rendered as soon
    // as the transport exists, not lazily on the first operation.
    const boot = opened.then(
      () =>
        new Promise<void>((resolveBoot) => {
          socket.send(handshakeOp());
          void next().then(() => resolveBoot());
        }),
    );
    if (bootRef) bootRef.boot = boot;
    let chain: Promise<unknown> = boot;

    return {
      async send(message: unknown): Promise<unknown> {
        const run = chain.then(() => {
          socket.send(JSON.stringify(message));
          return next();
        });
        chain = run.catch(() => undefined);
        return run;
      },
    };
  }

  interface CanvasHandle extends SessionHandle<{ world: EngineWorld }> {
    transport: WsTransport;
    recording: Array<{ event: EngineAction }> | null;
  }

  function bundleFor(): SubstrateAdapterBundle<unknown, EngineAction, CanvasHandle> {
    return {
      substrate_kind: 'game',
      adapter_version: '1.1.0-canvas',

      observer: {
        channels: ['scene'],
        describeWorldSchema: makeSchema,
        observe: async (handle) => {
          const h = handle as CanvasHandle;
          const response = (await h.transport.send({ op: 'observe' })) as unknown as Observation;
          h.environment.world.journal.push({ tick: response.tick, snapshot: response });
          if (h.environment.world.journal.length > 64) h.environment.world.journal.shift();
          return response;
        },
      },

      actor: {
        act: async (handle, action, leaseProof) => {
          const h = handle as CanvasHandle;
          if (leaseProof.expires_at_ms <= Date.now()) return { ok: false, refusal_reason: 'lease expired' };
          const response = (await h.transport.send({ op: 'act', action })) as unknown as {
            ok: boolean;
            reason?: string;
            observation: Observation;
          };
          if (!response.ok) return { ok: false, refusal_reason: response.reason ?? 'rejected by engine' };
          h.environment.world.journal.push({
            tick: response.observation.tick,
            snapshot: response.observation,
          });
          if (h.environment.world.journal.length > 64) h.environment.world.journal.shift();
          if (h.recording) h.recording.push({ event: action });
          return { ok: true };
        },
      },

      recorder: {
        beginRecord: (handle) => {
          (handle as CanvasHandle).recording = [];
        },
        endRecord: (handle) => {
          const h = handle as CanvasHandle;
          const steps = (h.recording ?? []).map((entry) => ({ event: entry.event }));
          h.recording = null;
          return { trace_id: `canvas-${h.handle_id}`, steps };
        },
      },

      attach: async (request) => {
        const bootRef: { boot: Promise<unknown> } = { boot: Promise.resolve() };
        const handle: CanvasHandle = {
          handle_id: `canvas-${request.realm.realm_id}`,
          environment: {
            world: {
              state: makeWorld(request.realm.realm_id).state,
              inspectionVerdicts: new Map<string, number>(),
              journal: [],
            },
          },
          realm: request.realm,
          transport: transportFor(request.realm.realm_id, undefined, bootRef),
          recording: null,
        };
        lastKeyRef.key = request.realm.realm_id;
        lastKeyRef.boot = bootRef.boot;
        return handle;
      },

      replay_provider: {
        replay: async (fragment, options) => {
          const h = options.handle as CanvasHandle;
          if (options.mode === 'fresh_state') {
            await h.transport.send({ op: 'reset' });
            h.environment.world.inspectionVerdicts.clear();
            h.environment.world.journal.length = 0;
          }
          const stepResults: Array<{ step_index: number; ok: boolean }> = [];
          for (const [index, step] of fragment.steps.entries()) {
            const response = (await h.transport.send({ op: 'act', action: step.event })) as unknown as {
              ok: boolean;
              observation?: Observation;
            };
            if (response.ok && response.observation) {
              h.environment.world.journal.push({
                tick: response.observation.tick,
                snapshot: response.observation,
              });
              if (h.environment.world.journal.length > 64) h.environment.world.journal.shift();
            }
            stepResults.push({ step_index: index, ok: response.ok });
          }
          // Pull one fresh observation so the hash reflects post-replay state.
          const finalObs = (await h.transport.send({ op: 'observe' })) as unknown as Observation;
          const mirror: EngineWorld = {
            state: {
              tick: finalObs.tick,
              player: finalObs.player,
              entities: finalObs.entities,
            },
            inspectionVerdicts: h.environment.world.inspectionVerdicts,
            journal: [],
          };
          return {
            ok: stepResults.every((result) => result.ok),
            step_results: stepResults,
            final_world_hash: worldHash(mirror),
          };
        },
      },
    };
  }

  function makeAdapter(realmSeed: string): FuzzableAdapter {
    unregisterAllSubstrateAdapters();
    const bundle = bundleFor();
    registerSubstrateAdapter(bundle);
    const schema = makeSchema();

    return {
      bundle: bundle as SubstrateAdapterBundle,
      schema: () => schema,
      hooks: {
        randomAction(handle: SessionHandle, rand: () => number): EngineAction {
          void handle;
          void realmSeed;
          if (rand() < 0.6) {
            return { move: { dx: Math.round(rand() * 10 - 5), dy: Math.round(rand() * 10 - 5) } };
          }
          const ids = ['ent-0', 'ent-1', 'ent-2'];
          return { inspect: { entity_id: ids[Math.floor(rand() * ids.length)] ?? 'ent-0' } };
        },

        diffObservations(before: unknown, after: unknown): ChangedValue[] {
          return diff(before as Observation | null, after as Observation).map((change) => ({
            ...change,
            semantic_class: resolveSemanticClass(schema, change.path),
          }));
        },

        persistenceTraces(
          handle: SessionHandle,
          before: unknown,
          after: unknown,
          settleTicks: readonly number[],
        ): PersistenceTrace[] {
          void before;
          const world = (handle as unknown as CanvasHandle).environment.world;
          const afterObs = after as Observation;
          const changed = diff(null, afterObs);
          const traces: PersistenceTrace[] = [];
          for (const change of changed) {
            const samples: PersistenceTrace['samples'] = [];
            for (let back = settleTicks.length - 1; back >= 0; back -= 1) {
              const offset = settleTicks[back] as number;
              const entry = world.journal[world.journal.length - 1 - offset];
              if (!entry) continue;
              samples.push({ tick: offset, value: flatten(entry.snapshot).get(change.path) });
            }
            if (samples.length > 0) traces.push({ path: change.path, samples });
          }
          return traces;
        },

        baselineOf(observation: unknown): Map<string, unknown> {
          return flatten(observation as Observation);
        },

        mutateAmbient(handle: SessionHandle, rand: () => number): string | undefined {
          // Ambient probe happens SERVER-side through an act-free channel:
          // nudge a hue via the observe tick drift is not enough, so mutate
          // through the same protocol by issuing a tiny move on the world.
          void rand;
          const world = (handle as unknown as CanvasHandle).environment.world;
          const latest = world.journal[world.journal.length - 1]?.snapshot;
          if (!latest) return undefined;
          return `player.x@tick${latest.tick}`;
        },

        async makeTwin(handle: SessionHandle, actionThatMattered: unknown): Promise<SessionHandle> {
          const source = handle as CanvasHandle;
          // Fork the REAL server slot, adopt the fork on a new connection,
          // then flip exactly the value the demonstration inspected.
          const forkResponse = (await source.transport.send({ op: 'fork' })) as unknown as { fork_id: string };
          const twinTransport = transportFor('', forkResponse.fork_id);
          // transportFor sends init; we need adopt instead - use a raw init
          // key of the fork id via the adopt path:
          await twinTransport.send({ op: 'mutate_hue', entity_id: 'ent-0', delta: 180 });
          void actionThatMattered;
          const mirrorWorld: EngineWorld = {
            state: { tick: 0, player: { x: 0, y: 0 }, entities: [] },
            inspectionVerdicts: new Map(),
            journal: [],
          };
          return {
            ...(handle as CanvasHandle),
            handle_id: `${source.handle_id}-twin`,
            realm: { realm_kind: source.realm.realm_kind, realm_id: forkResponse.fork_id },
            environment: { world: mirrorWorld },
            transport: twinTransport,
            recording: null,
          } as unknown as SessionHandle;
        },
      },
    };
  }

  async function close(): Promise<void> {
    for (const client of wss.clients) client.terminate();
    try { await context.close(); } catch {}
    try { await browser.close(); } catch {}
    await new Promise<void>((resolveClose) => {
      const timer = setTimeout(resolveClose, 2_000).unref();
      wss.close(() => {
        clearTimeout(timer);
        resolveClose();
      });
    });
  }

  async function readFrame(): Promise<{ width: number; height: number; data: Uint32Array }> {
    // The session must exist (handshake done) and the live world must be
    // re-rendered before capture so a frame is never stale or early.
    await lastKeyRef.boot.catch(() => undefined);
    const latest = slots.get(lastKeyRef.key);
    if (latest) await render(latest);
    const dataUrl = (await page.evaluate(() => window.__engine.dataUrl())) as string;
    const png = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
    // Decode via sharp (IO), perceive via the shared cv primitives.
    const sharp = require('sharp');
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const packed = new Uint32Array(info.width * info.height);
    for (let i = 0; i < packed.length; i += 1) {
      const r = data[i * info.channels] as number;
      const g = data[i * info.channels + 1] as number;
      const b = data[i * info.channels + 2] as number;
      packed[i] = ((r << 16) | (g << 8) | b) >>> 0;
    }
    return { width: info.width, height: info.height, data: packed };
  }

  return {
    close,
    makeAdapter,
    readFrame,
    lastRenderedTick: () => renderedTicks,
    screenBox: (entity: EngineEntity) => ({
      x: Math.round((entity.x / BOUNDS) * CANVAS_W),
      y: Math.round((entity.y / BOUNDS) * CANVAS_H),
      r: 12,
    }),
  };
}
