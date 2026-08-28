# WI-ENGINES Implementation Spec — real web-canvas game engine behind the WS scene-graph protocol

Repo: this package (`mcp/synthi-mcp`) lives inside the IDE repo; git root is two levels up.
Branch: `feat/embodied-universal-teaching` (already checked out). Do NOT create branches.

## Mission

Close the plan's last engine gap (WI-ENGINES in
docs/NEXT_MILESTONE_UNIVERSAL_TEACHING_GOALS.md): a REAL headless web-canvas
game world — actual HTML canvas pixels rendered in headless Chromium — exposed
through the EXISTING scene-graph WS protocol
(`src/embodied/adapters/game/protocol.ts`: ops `observe` / `act` / `fork`,
messages `{op, action}` -> responses; entities carry `{id, position{x,y},
color:{h,s,v}, kind}`), registered as a dojo world_manifest scenario, and run
through the substrate-blind conformance harness across randomized seeds
including a tick-rate wobble variant. NO core changes required — that is the
acceptance point (the plugin boundary holds).

## Files you may change

1. NEW `tests/unit/embodied_worlds/web_engine_world.ts` — the plugin: a
   WebSocket server + headless-chromium canvas page pair implementing the
   protocol, plus a `makeWebEngineAdapter(): FuzzableAdapter`.
2. NEW `tests/unit/embodied_web_engine_conformance.test.ts` — conformance +
   discrimination + manifest tests using it.

Nothing else may change. ZERO changes under src/ — if you think src/ must
change, STOP and re-read the adapter interfaces instead.

## Verified reality (do not guess)

- Conformance harness: `src/embodied/conformance.ts` exports
  `runConformancePass(adapter, {realm_kind, realm_id, steps}, seed)` and
  `runDiscriminationPass(adapter, spec, seed, actionThatMattered)`. Adapter =
  `FuzzableAdapter = { bundle: SubstrateAdapterBundle; schema(): WorldStateSchema; hooks: FuzzHooks }`
  where FuzzHooks = randomAction(handle, rand), diffObservations(before, after)
  -> ChangedValue[], persistenceTraces(handle, before, after, settleTicks),
  baselineOf(observation) -> Map, mutateAmbient(handle, rand),
  makeTwin(handle, actionThatMattered). Study
  `tests/unit/embodied_worlds/grid_world.ts` and `canvas_world.ts` as the
  reference implementations of this surface.
- The game bundle `createGameBundle(transportFor)` speaks over a
  `GameTransport{send,receive}` with JSON messages:
  client->server `{op:"observe"}`, `{op:"act", action:{move:{dx,dy}} | {inspect:{entity_id}}}`,
  `{op:"fork"}`; server->client observe -> `{tick, entities:[...], hidden:[...]}`,
  act -> `{ok, tick?, reason?}`, fork -> `{fork_id}`. Reference live-WS usage:
  tests/unit/embodied_game_transport.test.ts (WebSocketServer + ws client).
  The harness requires a replay_provider + fork support on the bundle — the
  game bundle has both. NOTE the game bundle's fork_provider expects
  `{op:"fork"}` responses `{fork_id}` and builds a NEW transport per fork via
  transportFor(`<realm>-fork-<id>`).
- Harness result fields asserted in existing tests: steps_executed > 0,
  events_recorded > 0, replay_same_state_ok, replay_fresh_state_ok,
  double_replay_hash_equal === true for seeded worlds,
  deltas_actor_caused >= 1, predicates_compiled >= 1, twin_failed true /
  original_ok true on discrimination.
- ChangedValue shape: `{path, semantic_class, value_kind?, before?, after?,
  changed_at_tick}` — check `src/embodied/world_state.ts` for the exact fields
  grid_world uses and mirror it.
- playwright-core is available from repo-root node_modules
  (`C:/Users/dev/Downloads/synthi-test/synthi-ide/node_modules/playwright-core`).
  chromium binary already installed (used by other tests via
  `playwright-core` import). Windows host: forward-slash native paths,
  windowsHide, taskkill cleanup patterns from embodied_nn_transfer_live.test.ts.
- World manifest: `validateWorldManifest` /
  `resolveWorldManifest(manifest, getAdapter)` from `src/embodied/world_manifest.ts`;
  shape `{world_manifest_version:"synthi.dojo.worldManifest.v1", adapter_kind,
  realm:{realm_kind, realm_id}, required_capabilities:["observe","act"],
  description}`; see tests/unit/embodied_world_manifest.test.ts.

## The plugin design (tests/unit/embodied_worlds/web_engine_world.ts)

A REAL engine loop, not a stub:

1. **Canvas page**: an inline HTML string (data: URL or page.setContent) with
   `<canvas width=320 height=240>` and a small requestAnimationFrame engine:
   each frame it clears, draws every entity as a filled rect/circle at its
   position in `hsl(h s v)` color, draws ambient elements, and posts nothing —
   pure rendering plus per-frame tick increment. Expose ONE thing to the
   harness side: `window.__engineState()` returning the authoritative entity
   array + tick (the page is the simulation authority; pixel reads are used
   for verification, not state transfer).
2. **WS server**: node `ws` WebSocketServer on 127.0.0.1:0 implementing the
   protocol against the page's authoritative state (evaluate through CDP):
   - observe -> reads `__engineState()`, returns `{tick, entities, hidden:[]}`;
   - act move/inspect -> applies movement clamped to bounds / inspects by id,
     replies `{ok, tick}`;
   - fork -> deep-copies state into a fresh slot keyed by generated fork_id,
     replies `{fork_id}`; subsequent connections... IMPORTANT: forks happen
     over the SAME socket in practice (transportFor maps realm ids); keep a
     Map<realmKey, worldState> on the SERVER so each connection gets its own
     world instance — realm key arrives via transportFor argument; simplest
     correct approach: the WS server namespaces state per CONNECTION, and the
     fork op registers the copy under the returned fork_id so a second
     connectWithKey(fork_id) can attach to it. Look at how
     embodied_game_transport.test.ts wires one socket; you may give the
     adapter factory a `connect(realmId)` that opens a new WebSocket per
     realm id and have the server route `?realm=<id>` query strings to
     per-realm state slots. Keep it simple but REAL.
3. **Tick-rate wobble**: the page runs rAF at display rate; add a test knob
   `wobble: true` that randomly throttles frame production (setTimeout jitter
   between frames) so observe responses arrive at irregular tick spacing.
   The protocol carries ticks with every response; conformance must still pass
   — that is the point of the variant.
4. **FuzzableAdapter wiring**: `makeWebEngineAdapter(opts)` returns
   `{ bundle: createGameBundle((realmId) => wsTransportTo(realmId)), schema:
   () => <the game bundle's own schema shape — reuse the declared
   game.scenegraph schema fields>, hooks }`. Hooks:
   - randomAction: pick a random alive entity; ~50% move toward/away from it
     (small dx/dy within clamp), else inspect it. Use ONLY the rand param.
   - diffObservations: compare entity arrays by id: position/color changes ->
     ChangedValue path `entities.<id>.position|color`; appeared/disappeared ->
     path `entities.<id>` with after/null. Mirror grid_world.ts exactly.
   - persistenceTraces: sample observations at settle ticks (evaluate state at
     each tick via extra observes), emit PersistenceTrace-shaped entries like
     grid_world does (copy its approach).
   - baselineOf: map path->value for all entity fields.
   - mutateAmbient: nudge an AMBIENT-only element (add an ambient drift entity
     owned by the engine that actions never target; moving it is the ambient
     probe) and return its id.
   - makeTwin: fork the world then flip the TARGETED value (e.g. set the
     inspected/moved entity's color hue to a far value) so the same replay
     must fail discrimination. Return the twin handle (attach a bundle handle
     bound to the fork realm id — follow canvas_world's makeTwin pattern).

5. **Pixel verification hook** (the "real engine" proof): expose
   `readFrame(handle)` from the module: grabs the canvas via
   `page.screenshot()` / canvas.toDataURL through CDP evaluate, downsamples,
   and the TEST asserts that after moving an entity, blockDelta-style change
   energy concentrates around the moved entity's screen region (use the shared
   CV primitives `blockDelta`, `toGray`, `dHash64`,
   `hsvBandPredicate` from `src/embodied/perception/cv.js` — the canvas test
   shows usage). Also assert two different entity layouts produce different
   dHash values and the same layout twice produces identical hashes
   (determinism despite wobble OFF; wobble ON only affects timing, not
   content, for identical seeds/actions — if wobble makes pixels nondeterministic
   between replays, scope hash-equality assertions to wobble:false runs and
   SAY SO in a comment).

## The test file

describe blocks:
1. "web-canvas engine world passes the substrate-blind conformance harness":
   seeds e.g. 900..911 (12 seeds), wobble:false; standard assertions incl.
   double_replay_hash_equal === true.
2. "...across randomized seeds with tick-rate wobble": seeds e.g. 950..955
   (6 seeds, wobble:true), assert the same pipeline pass minus strict
   double-hash equality (assert it undefined-or-true; document why).
3. "moves are visible in real pixels": drive one world: record dHash of frame,
   perform a large move action through the bundle actor, read frame again,
   expect hammingHex distance above a threshold AND blockDelta energy
   concentrated near the target region (bounds-check the changed block
   coordinates against the entity's expected screen box).
4. "discrimination": runDiscriminationPass across 3 seeds — original_ok true,
   twin_failed true.
5. "registers as a dojo world_manifest scenario": build the manifest for
   adapter_kind "game.ws" (whatever kind createGameBundle registers under —
   check: substrate_kind "game"), required_capabilities ["observe","act"],
   resolveWorldManifest(manifest, getAdapter) after registering the bundle,
   expect resolution succeeds and capability check passes; unknown-kind
   fail-closed case still works.

Lifecycle: start browser once per describe (or per file) with
chromium.launch({headless:true}); close pages/context/browser and WS servers
in afterAll with timeouts; kill nothing OS-level except if you spawn (you
should NOT need to spawn anything — launch() manages the browser process).
Every wait bounded. The file must leave no processes behind.

## Acceptance gates

1. `npx vitest run tests/unit/embodied_web_engine_conformance.test.ts` GREEN twice consecutively.
2. `npx vitest run tests/unit/embodied_game_transport.test.ts tests/unit/embodied_canvas_conformance.test.ts` still GREEN (no interference).
3. `git diff --stat HEAD` shows ONLY your two new files (after any WI-WEB/WI-PROD commits already landed by others — coordinate: your commit stages ONLY these two files).
4. Zero src/ changes (verify with `git status --short src/`).

## Commit

Single commit from repo root:
`feat(embodied): real web-canvas game engine behind WS protocol - conformance across seeds (WI-ENGINES)`
staging exactly the two new files.

## Report back

Vitest tail lines green twice, files created, commit hash, deviations.
