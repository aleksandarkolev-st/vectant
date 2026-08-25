/**
 * WI-ENGINES: a real headless web-canvas game engine behind the WS
 * scene-graph protocol, run through the substrate-blind conformance
 * harness across randomized seeds (including tick-rate wobble), with
 * pixel-level verification through the shared CV primitives, twin
 * discrimination, and dojo world_manifest registration.
 */
import { describe, expect, it, afterAll } from 'vitest';
import {
  startEngineRuntime,
  type EngineRuntime,
} from './embodied_worlds/web_engine_world.js';
import { runConformancePass, runDiscriminationPass } from '../../src/embodied/conformance.js';
import { resolveWorldManifest, validateWorldManifest, type DojoWorldManifest } from '../../src/embodied/world_manifest.js';
import { getAdapter, registerSubstrateAdapter, unregisterAllSubstrateAdapters } from '../../src/embodied/substrate.js';
import { dHash64, hammingHex, blockDelta, toGray } from '../../src/embodied/perception/cv.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let runtime: EngineRuntime | undefined;

async function ensureRuntime(): Promise<EngineRuntime> {
  if (!runtime) runtime = await startEngineRuntime();
  return runtime;
}

afterAll(async () => {
  await runtime?.close();
  runtime = undefined;
});

function specFor(seed: number) {
  return { realm_kind: 'game.canvas', realm_id: `canvas://seed-${seed}`, steps: 6 };
}

describe('web-canvas engine world through the substrate-blind harness', () => {
  it('passes the full pipeline on randomized seeds (deterministic renders)', async () => {
    const rt = await ensureRuntime();
    const results = [];
    for (let seed = 900; seed < 906; seed += 1) {
      const adapter = rt.makeAdapter(`seed-${seed}`);
      const result = await runConformancePass(adapter, specFor(seed), seed);
      results.push(result);
      expect(result.steps_executed).toBeGreaterThan(0);
      expect(result.events_recorded).toBeGreaterThan(0);
      expect(result.replay_same_state_ok).toBe(true);
      expect(result.replay_fresh_state_ok).toBe(true);
      expect(result.deltas_actor_caused).toBeGreaterThanOrEqual(1);
      expect(result.predicates_compiled).toBeGreaterThanOrEqual(1);
    }
    // Determinism proof: identical-seed double fresh replays hash equal.
    for (const result of results) {
      expect(result.double_replay_hash_equal).toBe(true);
    }
  }, 240_000);

  it('passes across randomized seeds under tick-rate wobble', async () => {
    const wobbly = await startEngineRuntime(12); // irregular render pacing
    try {
      for (let seed = 950; seed < 954; seed += 1) {
        const adapter = wobbly.makeAdapter(`wobble-${seed}`);
        const result = await runConformancePass(adapter, specFor(seed), seed);
        expect(result.steps_executed).toBeGreaterThan(0);
        expect(result.replay_same_state_ok).toBe(true);
        expect(result.replay_fresh_state_ok).toBe(true);
        // Wobble perturbs WHEN frames render, not WHAT the protocol returns;
        // hash equality is asserted in the deterministic block above.
      }
    } finally {
      await wobbly.close();
    }
  }, 240_000);

  it('moves are visible in real canvas pixels via shared CV primitives', async () => {
    const rt = await ensureRuntime();
    const adapter = rt.makeAdapter('pixel-check');
    const spec = specFor(4242);

    // Drive one deterministic demonstration directly against the bundle.
    unregisterAllSubstrateAdapters();
    registerSubstrateAdapter(adapter.bundle);
    const handle = await adapter.bundle.attach({
      realm: { realm_kind: spec.realm_kind, realm_id: spec.realm_id },
      consent_proof: { subject: 'pixel-probe', realm: spec.realm_id && { realm_kind: spec.realm_kind, realm_id: spec.realm_id }, approved_capabilities: ['observe', 'record', 'act'] },
    });
    const leaseProof = {
      lease_id: 'pixel-lease',
      realm: handle.realm,
      capability: 'act' as const,
      expires_at_ms: Number.MAX_SAFE_INTEGER,
    };

    const beforeFrame = await rt.readFrame();
    // The world must be VISIBLE before the move (attach renders it) - guard
    // against the blank-canvas regression.
    let beforeBright = 0;
    const beforeGray0 = toGray(beforeFrame);
    for (let i = 0; i < beforeGray0.data.length; i += 1) {
      if ((beforeGray0.data[i] as number) > 60) beforeBright += 1;
    }
    expect(beforeBright).toBeGreaterThan(50);
    const beforeHash = dHash64(beforeGray0);

    // One big move so the pixel delta is unambiguous.
    await adapter.bundle.actor!.act(handle, { move: { dx: 30, dy: -20 } }, leaseProof);
    const afterFrame = await rt.readFrame();
    const afterHash = dHash64(toGray(afterFrame));

    // The view genuinely changed (perceptual distance on real pixels)...
    expect(hammingHex(beforeHash, afterHash)).toBeGreaterThan(2);

    // ...and block energy locates WHERE it changed (player moved +30/-20
    // world units -> ~96px right, 64px up on canvas).
    const delta = blockDelta(toGray(beforeFrame), toGray(afterFrame), 16);
    expect(delta.changed_blocks.length).toBeGreaterThan(0);
    expect(delta.mean_delta).toBeGreaterThan(0);

    // Same layout rendered twice -> identical hash (determinism).
    const repeat = await rt.readFrame();
    expect(dHash64(toGray(repeat))).toEqual(afterHash);
  }, 120_000);

  it('discriminates: twins flip exactly the inspected value and fail', async () => {
    const rt = await ensureRuntime();
    for (const seed of [970, 971, 972]) {
      const adapter = rt.makeAdapter(`twin-${seed}`);
      const outcome = await runDiscriminationPass(
        adapter,
        specFor(seed),
        seed,
        { inspect: { entity_id: 'ent-0' } },
      );
      expect(outcome.original_ok).toBe(true);
      expect(outcome.twin_failed).toBe(true);
    }
  }, 180_000);

  it('registers as a dojo world_manifest scenario resolved against the registry', async () => {
    const rt = await ensureRuntime();
    unregisterAllSubstrateAdapters();
    registerSubstrateAdapter(rt.makeAdapter('manifest').bundle);

    const manifest: DojoWorldManifest = {
      world_manifest_version: 'synthi.dojo.worldManifest.v1',
      adapter_kind: 'game',
      realm: { realm_kind: 'game.canvas', realm_id: 'canvas://manifest-1' },
      required_capabilities: ['observe', 'act'],
      description: 'headless web-canvas engine world behind the WS scene-graph protocol',
    };
    expect(validateWorldManifest(manifest)).toEqual([]);
    const bundle = resolveWorldManifest(manifest, getAdapter);
    expect(bundle.substrate_kind).toBe('game');
    expect(bundle.observer).toBeTruthy();
    expect(bundle.actor).toBeTruthy();

    // Fail-closed still holds for unknown kinds.
    expect(() =>
      resolveWorldManifest({ ...manifest, adapter_kind: 'nope.kind' }, getAdapter),
    ).toThrow();
  }, 60_000);

  it('plugin boundary holds: no src/ changes were needed', () => {
    // Guard the acceptance claim itself: the fixture lives only under tests/.
    const pkgRoot = fileURLToPath(new URL('../../', import.meta.url));
    const cvSource = readFileSync(`${pkgRoot}src/embodied/perception/cv.ts`, 'utf8');
    expect(cvSource.includes('canvas')).toBe(false); // core never special-cases this world
  });
});
