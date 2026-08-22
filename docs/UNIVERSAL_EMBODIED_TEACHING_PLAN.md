# Universal Embodied Teaching Plan

Status: draft design document v2, extends AGENT_BROWSER_MCP_COMPLETION_PLAN.md and agent_dojo_breakthrough_spec.md
Scope: generalize Teach Mode from a browser-only recorder into a substrate-neutral embodied teaching system covering browsers, runtimes, terminals, game worlds, kernels, desktops, and APIs.
Principle: teach everything a human can demonstrate through an interface, not just what a human can click in a tab.

---

## Problem

Teach Mode today is structurally browser-shaped:

- `BROWSER_ACTION_KINDS` hardcodes click/fill/select/navigate.
- `BrowserTraceEvent` assumes tabs, frames, origins, and URLs.
- `WorkflowSurfaceKindV7` enumerates DOM surfaces only.
- Consent, leases, screenshots, redaction, and replay are all keyed to browser origins.

That made sense for the wedge. It does not scale to the real product sentence:

> Teach Synthi anything you can do on this machine or inside any world it can reach.

A developer walks a character to a door, turns 120 degrees, and checks whether the door is purple. An SRE restarts a service and confirms it came back healthy. A data scientist runs a notebook cell and watches the plot render. None of these are browser workflows. All of them are demonstrations. Today, none of them can be taught.

## Thesis

Embodied software engineering means: a human acts through a body — a cursor, a keyboard, a controller, a shell, an avatar — inside some world, and the system converts that demonstrated activity into a durable, tested, proof-carrying agent competency.

The browser pipeline already discovered the right shape:

```text
capture -> canonical trace -> causal workflow contract -> counterfactual
hardening -> replay -> failure classification -> checkride -> license ->
proof-carrying execution
```

Nothing in that shape is actually about browsers. Every stage is a general concept wearing browser clothing. This plan strips the clothing out and keeps the pipeline.

One pipeline. Many substrates. Browser becomes adapter #1, not the framework.

---

## Definitions

The system distinguishes three orthogonal concepts. Confusing them is the classic failure mode: a terminal is an interface into a runtime; an API may control that same runtime; a browser can expose that API; a game may itself be browser-hosted. "Where the interaction happened" must never be conflated with "what authority applied" or "what system was changed."

- **Substrate** — the *interaction semantics*: the action vocabulary, observation channels, and time model through which an agent perceives and acts. Browser-DOM, terminal-PTY, scene-graph, and HTTP are substrates. A substrate says nothing about which machine or process is affected.
- **Realm** — the *authority boundary*: the consent and identity scope within which interaction is permitted. Browser realm = exact origin. Terminal realm = workspace root + host. Game realm = world/server id. Kernel realm = container/VM namespace. Consent never crosses realms, exactly like consent does not cross origins today. One environment can contain many realms (two containers on one host); one realm can span environments (a workspace mounted into a pod).
- **Environment** — the *underlying execution world*: the actual machine, process tree, container, browser instance, or simulation whose state is changed by actions. Environments carry blast radius, reset stories, snapshot/fork capability, and determinism properties.

Every trace event therefore carries three coordinates: `substrate` (how), `realm` (with what authority), `environment` (against what). A workflow step "restart nginx via terminal in container A" and a later step "restart nginx via HTTP API against container A" share an environment but differ in substrate; the compiler must treat them as different action semantics against the same target, and the license kernel must evaluate both authorities.

- **World state** — everything observable about the environment at a moment, expressed through a substrate's observation channels. A DOM tree is world state. So is a scene graph, a process table, a filesystem diff, a set of syscall counters.
- **Affordance** — a stable, nameable way to target part of the world. Locators are browser affordances. Entity IDs, file paths, systemd unit names, function names, and menu paths are affordances elsewhere.
- **Demonstration (teach session)** — a human performs work in a substrate while the adapter records events, observations, and state deltas.
- **Competency** — the compiled output: a workflow contract plus its guardrails, checkride results, and license. Same object regardless of substrate.

---

## What Generalizes and What Does Not

Universal (shared across all substrates):

| Concept | Browser today | Universal form |
|---|---|---|
| Trace event | `BrowserTraceEvent` | `EmbodiedEvent` (superset; browser events embed unchanged) |
| Observation | screenshot + DOM + AX + console/network | `ObservationBundle`: ordered channels by cost/fidelity |
| Targeting | `LocatorCandidate[]` | `AffordanceCandidate[]` ranked by stability tier |
| Preconditions | form visible, button enabled | predicates over typed world state |
| Effects | dirty flag clears, request completes | world-state delta assertions |
| Tolerance | toast wording may change | variant predicates per substrate |
| Hard failures | validation errors, route left | failure predicates per substrate |
| Data binding | parameter/environment/variant | identical |
| Consent | exact-origin | exact-realm |
| Control | input lease | input lease (already generic; reuse shared lease) |
| Redaction | password/token/query scrubbing | channel-typed redaction policies |
| Counterfactuals | viewport/dark-mode/hydration variants | substrate variant operators |
| Failure classification | `FailureClassV7` | namespaced classifier, shared trunk classes |
| Governance | entrustment levels, licenses, proof capsules | identical, adds substrate scope dimension |

Substrate-specific (adapter-owned):

| Concern | Browser | Game | Terminal/Runtime | Kernel | API |
|---|---|---|---|---|---|
| Action vocabulary | click, fill, press | move, turn, interact, emote | exec, send-keys, signal | syscall, ioctl, write | method+path+payload |
| Action space | discrete | mostly continuous | discrete streams | discrete + timing | discrete |
| Time model | wall clock + waits | simulation ticks, frame budget | wall clock | wall clock | request/response |
| Determinism | low (network, hydration) | high with fixed seed | medium | medium-high in frozen ns | high with stubs |
| Reset story | fresh context | save state / respawn zone | new pod / container | snapshot/restore (CRIU) | fixture DB / stub server |
| Primary observation | screenshot + DOM | scene graph > frame buffer | stdout/stderr + exit codes + fs deltas | syscall trace + procfs | status + body + latency |

Rule: if a concern appears in the left column of the universal table, it lives in the shared `embodied` core. If it appears in the second table, it lives in the adapter. No adapter logic leaks into the compiler; no compiler assumptions leak into adapters.

---

## Canonical Event Model

New shared type, designed so the existing browser trace embeds without lossy conversion:

```json
{
  "event_id": "...",
  "trace_id": "...",
  "trace_version": 3,
  "event_seq": 41,
  "ts": 1760000000000,
  "actor": { "kind": "human" },
  "substrate": {
    "kind": "game",
    "realm": "world://demo-island/session-17",
    "adapter_version": "game.godot.1"
  },
  "action": {
    "kind": "turn",
    "primitive_class": "continuous",
    "params": { "delta_degrees": 120, "axis": "yaw" },
    "quantization": { "step": 5, "tolerance_degrees": 2 }
  },
  "target_affordances": [
    { "tier": "scene_entity", "ref": "entity:door.north", "confidence": 0.98,
      "reason": "nearest interactable within 2.5m facing arc" }
  ],
  "observation_refs": ["obs_40_pre", "obs_41_post"],
  "state_delta": {
    "before": { "player.yaw_deg": 15, "door.north.visible_in_frustum": false },
    "after":  { "player.yaw_deg": 135, "door.north.visible_in_frustum": true }
  },
  "redacted": false,
  "security": { "realm_approved": true, "recording_approved": true }
}
```

Design decisions:

- `primitive_class` separates `discrete` from `continuous`. Continuous actions carry their quantization and tolerance at record time, because the tolerances are a property of how the human moved, not of replay.
- `target_affordances` reuses the candidate-list philosophy from `LocatorCandidate`: always record several, rank by stability tier, prefer the most stable that survives hardening.
- `state_delta` is *not* hand-authored by adapters and *not* a dump of everything that changed. It is produced by the State Differ pipeline defined in the next section; at capture time the event carries only raw observation refs. The `before`/`after` maps shown here are the pipeline's *output*, attached during reduction.
- `security.realm_approved` mirrors `exact_origin_approved`. One semantics: nothing outside the approved realm produces bytes, frames, or state detail.

---

## State Differ / Causal Delta Extraction

Generating meaningful causal deltas is one of the hardest components in this architecture — not an implementation detail. Real environments change thousands to millions of values between two observations: timers tick, NPCs idle-walk, log lines accumulate, network counters increment, garbage collectors run. The line "the compiler consumes deltas, not screenshots" only works if delta generation is itself a first-class, tested subsystem. Otherwise `state_delta` becomes either enormous (every changed value shipped into the compiler) or fake (adapter authors hand-picking deltas per scenario, which is exactly the hardcoding this plan forbids).

The pipeline is fixed for every substrate:

```text
raw observations
  -> [1] candidate changed set      (mechanical diffing, substrate-typed)
  -> [2] relevance filtering        (salience scoring, budgeted)
  -> [3] causal attribution         (actor-caused vs ambient)
  -> [4] persistence classification (transient vs durable vs oscillating)
  -> [5] contract predicates        (typed preconditions/effects with uncertainty)
```

Stage ownership matters. Stage 1 must be adapter-supplied because only the adapter knows how to diff its world cheaply (DOM tree diff, scene-graph component diff, filesystem watcher, procfs snapshot diff). Stages 2–5 are shared core code so every substrate gets identical semantics. An adapter never writes contract predicates directly.

### Stage 1: Candidate changed set

The adapter provides a typed observation model (see WorldStateSchema below) plus a `diff(prev, next) -> ChangedValue[]` implementation. Each `ChangedValue` is `(path, value_kind, before, after, changed_at_tick)`. Diffing is mechanical and complete at this stage — no filtering yet. Cost control lives here: adapters should diff structured representations (scene graph fields, DOM attributes, stat counters), not pixel buffers or full frame captures.

### Stage 2: Relevance filtering

The core scores each changed value and keeps only what fits a per-substrate budget:

```text
salience = w1*proximity_to_action_target
         + w2*coincidence_with_action_window   // changed within [t_action - eps, t_settle + eps]
         + w3*persistence                      // stays changed through settle window
         + w4*semantic_type_weight             // schema-declared: material > transform > particle_emitter
         + w5*novelty                          // first appearance beats recurring churn
```

Weights are configuration, not hardcoded constants, and are tuned per substrate class via profiles. The filter is allowed to be wrong in both directions; stages 3–5 and later counterfactual hardening correct it. What is forbidden is silent unbounded output: if the filtered set still exceeds budget, the event records `delta_truncated: true` plus the dropped-count, and confidence of downstream attribution drops accordingly. Silent truncation is treated like silent XPath fallback — a flagged degradation.

### Stage 3: Causal attribution

For each surviving candidate, classify how it was caused:

| Class | Test | Example |
|---|---|---|
| actor-caused | change co-occurs with an action window on/near the action target AND is absent in no-action control runs | door frustum flag flips right after `turn` |
| ambient | changes on the same schedule with or without actions (clocks, day cycle, NPC wander, log rotation) | sun angle, particle counts |
| induced | not on the action target but causally downstream of it (follows within propagation delay) | light through doorway after opening door |
| unknown | insufficient evidence | |

Attribution uses temporal correlation windows from stage 2 plus *control comparisons*: when fork support exists, the reducer replays the same action window on a forked world without the action (or with a different action) and removes candidates that change anyway. Where forks do not exist (terminal, kernel before Phase 3 snapshots), attribution falls back to multi-demonstration voting: record the flow 2+ times, keep only candidates that track the action consistently across demonstrations. The trace stores the attribution class and its evidence kind (`fork_control` | `multi_demo_vote` | `temporal_only`) so downstream consumers know how much to trust each effect predicate. `temporal_only` effects may not become hard assertions without human confirmation.

### Stage 4: Persistence classification

Each attributed change is classified by observing through the settle window and (when available) subsequent replay:

- `durable` — persists until some later step changes it back (door color, file contents, unit state). These become expected effects.
- `transient` — reverts on its own quickly (toast, spinner, focus ring). These become optional signals, never hard failures.
- `oscillating` — changes periodically regardless of action (animation frames, clock hands). These are excluded from contracts and recorded as known-noise fingerprints used to suppress future false positives.

### Stage 5: Contract predicates

Surviving durable actor-caused changes compile into typed predicates over the WorldStateSchema (e.g. `frustum_contains(player.view, door.north)`), with an uncertainty annotation derived from evidence kind, sample count across demonstrations, and truncation status. The compiler refuses to emit high-severity assertions (hard failures, license-gating effects) from low-uncertainty predicates — same refusal discipline as low-confidence locators.

### Perception binds to computer-vision building blocks, not bespoke pixel code

When a world offers no scene graph (browser canvases, native games, desktop apps), perception falls back to pixels — but through proven CV primitives, never hand-rolled per-scenario heuristics:

- **Perceptual hashing (pHash/dHash)** for "same view / same landmark" identity: robust to compression, scaling, minor lighting shifts. The repo already carries an E2b region-phash spike; productionize it as the shared region-identity primitive.
- **Color-space band predicates (HSV/Lab distance)** for appearance classes like the purple check: declared as schema value types (`hue_band`, `lab_distance`), evaluated by one shared predicate evaluator — never inline RGB comparisons in adapters.
- **Template/feature matching** (normalized cross-correlation or ORB-class features via `sharp`'s raw buffers) for locating known UI/game elements when structural affordances are gone.
- **Change detection on downsampled frames** (block-wise delta energy) as a cheap pre-filter so expensive CV runs only where state actually moved.

Rules:

1. All CV primitives live in ONE shared module (`embodied/perception/cv.ts`); adapters declare *which* primitive + parameters in their schema's perception bindings (`preferred: scene_graph | phash_region | hsv_band | template_match`), they never implement pixel math themselves.
2. Every pixel-derived predicate carries its confidence and is treated like T3/T4 affordances: valid, but flagged below-structural, subject to degradation-rate metrics.
3. Determinism requirement: identical frames must produce identical verdicts (no time/random-dependent thresholds); seeded-substrate double-replay hash equality extends to perceptual verdicts.
4. The conformance fuzz must include at least one pixel-only world variant (schema declares no scene graph) to prove the CV path compiles equivalent contracts with correctly-flagged confidence.

### Anti-hardcoding rule

No adapter may ship per-scenario delta tables, and the core may not special-case known environments ("if door then check color"). Domain nouns enter only through schemas, profiles, and human confirmation. The conformance suite enforces this structurally at three levels:

1. **Randomized worlds:** all three conformance fixtures randomize entity counts, positions, families, weights, keyspaces, ambient periods per seed — any memorized scenario fails some seed.
2. **Import boundary:** `src/embodied/**` may import nothing outside the core directory (grep-tested per commit).
3. **Noun gate:** core sources are grepped for domain vocabulary every run; fixtures are grepped to ensure even THEY only import the core.

The three shipped ontologies (spatial grid, activation network, key-value store) share zero semantics by construction — anything hardcoded to one fails the other two.

---

## Affordance stability tiers

Same idea as the browser locator order and the Substrate Ladder, unified:

| Tier | Meaning | Browser example | Game example | Terminal example |
|---|---|---|---|---|
| T0 | semantic/tool | MCP tool call | quest-system verb | `systemctl restart nginx` |
| T1 | source-linked | component anchor | scene node path + script | unit file path |
| T2 | structural | role + label test id | stable entity id + component query | stable path + command args |
| T3 | perceptual | visible text | rendered pixel region | prompt regex |
| T4 | positional | css/xpath | screen-space coordinates | caret position |

Replay prefers the highest tier that survived counterfactuals. Dropping below T2 requires the same refusal behavior the browser compiler already has: ask the human or propose a source patch (for games: propose adding a stable entity tag or interaction verb to the world source).

---

## Substrate Adapter Interface

One interface. Every substrate implements it. The broker, compiler, dojo, and license kernel see only this.

```text
SubstrateAdapter
  capabilities():
    observe_channels[]        // ordered by cost/fidelity
    action_primitives[]       // with schemas, incl. continuous + quantization rules
    record_support            // live human-action capture
    replay_support            // deterministic re-execution
    fork_support              // save/restore or branch world state
    reset_profiles[]          // cold, warm, seeded
    determinism_class         // none | seeded | strict
    blast_radius_class        // contained | scoped-write | external | irreversible
    max_step_rate             // capture throttling guidance
  attach(realm_consent) -> SessionHandle
  observe(handle, channels[]) -> ObservationBundle
  act(handle, action, lease_id) -> ActionResult      // requires active lease
  begin_record(handle) / end_record(handle) -> TraceFragment
  replay(fragment, env_bindings, mode) -> ReplayResult
  fork(handle) -> ForkHandle                         // counterfactual twin
  restore(fork_handle | reset_profile)
```

### WorldStateSchema

`describe_world()` looks like a small method but is the semantic backbone of the whole architecture: the State Differ's stage-2 salience weights, stage-5 predicate generation, and the compiler's refusal rules all consume it. If every adapter invents its own ontology, substrate semantics leak straight back into the compiler and universality dies quietly. The schema contract is therefore fixed:

```text
WorldStateSchema
  schema_id + schema_version          // semver; breaking changes bump major
  value_types: map path-pattern -> ValueType   // typed leaves, not "any"
  identity:
    id_scheme                         // stable | session | derived
    id_stability_guarantee            // what an id survives (restart? fork? reset?)
    reidentification_rule             // how to find the same entity next observation
  observability:
    fully_observable                  // bool
    hidden_state_declaration[]        // which state exists but is NOT observable,
                                      // e.g. server authority in multiplayer, kernel
                                      // internals, closed shadow DOM equivalent
    partial_observability_policy      // best_effort | sampled | event_driven
  semantic_type_weights               // declared per type for salience scoring;
                                      // core supplies defaults, adapters may extend
                                      // with new types but not reorder core weights
  noise_fingerprints[]                // declared oscillators (clocks, animations)
```

Rules:

1. **Static or discovered, declared explicitly.** A schema may be static (shipped with the adapter) or discovered at runtime (introspection endpoints, scene-graph manifest). Either way it must be materialized as a versioned document at attach time; the core never queries adapter code paths for semantics mid-run. Discovered schemas carry a `discovery_confidence` per entry.
2. **Adapter supplies types, compiler supplies predicates.** Adapters declare value types and identity semantics; they never ship predicates ("is_purple", "is_healthy"). Predicates are generated by the shared compiler from schema-typed deltas, or declared by humans during confirmation.
3. **Identity is a first-class answer, not an assumption.** Every affordance tier above T4 depends on being able to say "this is the same entity as before." The schema must state its id scheme and exactly what that id survives (fork, reset, restart, realm change). Browser test ids are `stable`; game entity instance ids are typically `session` plus a `reidentification_rule` (spatial+visual match); procfs pids are `session`. When an id scheme cannot survive a counterfactual variant, hardening downgrades affected affordances automatically.
4. **Partial observability is declared, never silent.** Multiplayer games hide server authority; terminals hide application memory; browsers hide cross-origin frames. The schema says *what* is hidden and the policy used to observe the rest. Contracts compiled against partially observable worlds carry a `blind_spots[]` list, and checkrides must include variants probing those blind spots rather than pretending full knowledge.
5. **Versioning and drift.** Schema major-version changes invalidate cached contracts' predicate bindings; the source-drift machinery already built for browser components extends to schema drift generally.

### Capability-split adapter interface

One monolithic interface would make every adapter an execution environment. Instead the adapter surface is split into narrow capabilities, negotiated structurally — the registry exposes only the capability interfaces an adapter actually implements, and downstream components depend on the narrowest interface they need:

```text
Observer            observe(handle, channels[]) -> ObservationBundle
                    describe_world(handle) -> WorldStateSchema
Actor               act(handle, action, lease_id) -> ActionResult
Recorder            begin_record(handle) / end_record(handle) -> TraceFragment
ResetProvider       reset_profiles[], restore(profile | handle)
ForkProvider        fork(handle) -> ForkHandle     // required by wind tunnel
ReplayProvider      replay(fragment, env_bindings, mode) -> ReplayResult
```

- The broker grants control only against `Actor`, records only via `Recorder`, runs the wind tunnel only on `ForkProvider`s, CI replay only on `ReplayProvider`s.
- `attach(realm_consent) -> SessionHandle` remains on every capability provider; consent is checked per capability (observe-consent does not imply act-consent).
- A terminal adapter ships Observer/Actor/Recorder/ResetProvider/ReplayProvider but no ForkProvider until snapshot support lands; attribution then automatically uses multi-demo voting instead of fork controls, because the core negotiates capabilities rather than reading booleans.

Existing browser infrastructure maps onto this cleanly: broker = realm authority, hosted runtime = session handle source, trace.ts capture = Recorder, ci_replay.ts = ReplayProvider, lane0 reducer stays as the semantic windowing pass over `EmbodiedEvent`s.

Consent model generalizes verbatim: approval is exact-realm, never prefix-matched; a realm change mid-recording pauses or stops teach mode; denied realms produce zero observation bytes — no frames, no state text, no titles, no URLs, no world names.

---

## Worked Example 1: The Purple Door (Game Substrate)

This is the reference demonstration for continuous, spatial, perceptual workflows. If this compiles, the architecture is genuinely general.

Scope warning: the game adapter is an *experimental milestone*, not the next production adapter. Scene-graph protocols, engine plugins, action normalization, save-state/fork behavior, perception bindings, procedural worlds, and deterministic checkrides together constitute a platform project in their own right. The example below defines what that milestone must prove; it does not commit to a ship date or claim production readiness for games. Phases 1 (terminal/runtime) and 3 (kernel) are the production adapters; the game work runs on an experimental branch behind the same core interfaces so it can inform the core without destabilizing it.

The human teaches:

```text
walk forward to the north door
turn right 120 degrees
look at the door and note whether it is purple
```

### Raw capture

The adapter records at tick resolution, then reduces:

```text
t0    hold W            velocity (0,  0, -1) local-forward
t1..t40 hold W          position delta -6.2m, collision guard engaged near t38
t40   release W         stopped 1.8m from door.north
t41   mouse-dx stream   yaw integrates +120 deg over 14 ticks (peak rate 90 deg/s)
t55   settle            view settled, door centered, foveation lock on door.north
t56   pause 400ms       observation window; scene-graph query + frame grab
```

Note what the reducer did, mirroring lane0's windowing philosophy:

- merged 40 tick-level move events into one `walk_to` continuous action with measured displacement;
- integrated the mouse-delta stream into one `turn` action of 120 degrees with measured tolerance (±2 degrees);
- recognized the dwell as an explicit `observe` action — humans pause to look, and the pause is meaningful.

### Compiled contract step

```json
{
  "stepId": "inspect-north-door",
  "intent": "visually verify the north door's color",
  "substrate": "game",
  "preconditions": [
    "player.position within 2.5m of door.north",
    "player upright and unobstructed",
    "world lighting >= gameplay-visible threshold"
  ],
  "action": {
    "sequence": [
      { "kind": "walk_to", "affordance": "entity:door.north",
        "stop_distance_m": 1.8, "tolerance_m": 0.4 },
      { "kind": "turn", "delta_degrees": 120, "tolerance_degrees": 2,
        "frame_normalized": true },
      { "kind": "observe", "channels": ["scene_graph", "frame"], "dwell_ms": 400 }
    ]
  },
  "expectedEffects": [
    "door.north within center 20% of frustum after turn",
    "colorPredicate(door.north.material, 'purple') evaluated"
  ],
  "toleratedVariants": [
    "walk path differs (obstacle detour)",
    "turn split into two sub-turns totaling 120 degrees",
    "hue drift within purple band under lighting change"
  ],
  "hardFailures": [
    "collision blocked approach and stop_distance > 3.5m",
    "door.north absent from scene graph",
    "frustum check fails after turn"
  ],
  "perceptionBinding": {
    "preferred": "material_albedo_id",
    "fallback": "pixel_hsv_band",
    "purple_band": { "h": [265, 300], "s_min": 0.25, "v_min": 0.10 },
    "reason": "rendered RGB shifts with lighting; albedo id does not"
  },
  "resultBinding": "door_is_purple"
}
```

Two details carry the whole design:

1. **Perception binds to the scene graph, falls back to pixels.** When the world exposes material IDs, "is it purple" is a stable predicate. When only pixels exist, the contract pins an HSV band plus lighting preconditions and drops to lower confidence. Never silently bind to rendered RGB — that is the game equivalent of XPath.
2. **Continuous actions are normalized, not replayed blind.** `turn` is expressed as a delta with tolerance and frame normalization so replay works at a different tick rate. `walk_to` targets an entity with a stop distance, not a recorded key-hold duration — key-hold duration is the game equivalent of coordinate clicks.

### Counterfactual wind tunnel (fork-based)

Because the substrate supports `fork_support`, each variant runs on a branched world state:

| Variant | Mutates | Contract must survive by |
|---|---|---|
| dusk lighting | light rig | albedo binding; HSV fallback widens band |
| door reskin | texture swap (still purple family) | hue band edges |
| green door twin | material swap | predicate flips result — proves discrimination, not just lookup |
| door moved 30cm | transform | stop-distance tolerance |
| 50% tick-rate | simulation speed | frame normalization |
| crowd NPC occlusion | scene contents | obstacle-detour tolerated variant; occluded-at-stop is a hard failure |
| fog | render distance | precondition `visibility >= threshold` triggers reposition rule |

Acceptance: the compiled step passes all variants using the preferred binding; if only the pixel fallback survives, the compiler flags `lowConfidencePerception` and proposes a world-source patch (add a `material_tag` to the door entity) exactly like the browser compiler proposes `data-synthi-affordance`.

### Checkride in the vivarium

Grow a synthetic proving ground instead of replaying the recorded corridor:

```text
scenario: door-inspection-checkride-v1
world: procedurally generated corridor, 8 doors
doors: randomized hue/saturation/value; 2-4 within purple band, rest in
       confuser bands (blue-violet 255-264, magenta 301-315, dark gray)
adversarials: moving lights, one occluding NPC, mid-run tick-rate wobble
pass: classify every door correctly AND physically approach only purple doors
      AND produce a result artifact binding each verdict to evidence
      (material id or annotated frame crop)
```

Passing issues a license such as: `E2 observe-only in live worlds; E3 act in sandboxed worlds; E4 act in live worlds with per-run realm consent and a 60-second lease` — the entrustment dial the dojo spec already defines, now with a substrate scope axis.

### Why this example matters

It exercises every generality the browser pipeline never needed: continuous action spaces, spatial preconditions, physics tolerances, perception predicates, tick-rate independence, and fork-based counterfactuals. Any substrate simpler than a game (terminal, API, runtime) reuses the same machinery minus the parts it lacks.

---

## Worked Example 2: Kernel / Sysadmin Substrate

Teach: "the web service is leaking file descriptors; rotate logs and restart it."

Capture is not keystroke logging. The terminal adapter records sessions at the semantic boundary — commands, exit codes, signals, filesystem deltas (overlay/inotify), unit state transitions — with secret scrubbing applied before storage, same discipline as browser input redaction.

Contract highlights:

```text
precondition:   nginx.service active; open-fd count for master pid > threshold
action:         logrotate -f /etc/logrotate.d/nginx ; systemctl restart nginx
expectedEffect: unit returns to active within timeout; fd count released;
                health endpoint responds 200
hardFailures:   unit enters failed state; config test fails; fs still growing
recoveryRule:   restore-from-snapshot-before-mutation was mandatory at record
                time; on failure, restore and classify before any retry
realm:          container namespace only; host namespace permanently out of
                scope for this competency
counterfactuals: systemd vs non-systemd image, read-only /var, missing
                logrotate config, slow disk (restart exceeds default timeout)
```

Safety differences from browser, handled by capability flags rather than new mechanisms: `blast_radius_class: scoped-write` forces fork/snapshot before replay; `determinism_class: medium` raises required checkride repetitions; the kernel adapter itself runs inside the sandbox stack the repo already ships (see SECURITY_SANDBOXING.md), never on the host.

## Worked Example 3: Cross-Substrate Workflow

Real work crosses substrates, and the contract graph should say so:

```text
node1 (terminal): touch src/components/Badge.tsx        -> exit 0
node2 (browser):  observe preview until HMR event lands  -> hmr_applied
node3 (browser):  assert Badge renders with new prop     -> visual delta matches
```

The orchestrator treats these as ordinary workflow nodes carrying a `substrate` field; the executor dispatches each node to its adapter; leases are taken per substrate and released between nodes. Nothing new is invented here — this is the workflow graph the dojo spec already describes, with substrate dispatch added.

---

## Architecture Changes

New shared core, extracted without breaking the browser path:

```text
mcp/synthi-mcp/src/embodied/
  event.ts           // EmbodiedEvent; BrowserTraceEvent embeds as substrate:"browser"
  observation.ts     // ObservationBundle, channel registry, redaction policies
  affordance.ts      // AffordanceCandidate, stability tiers
  world_state.ts     // typed predicate schema + evaluation
  contract.ts        // substrate-neutral compiler core (extracted from workflow.ts)
  hardening.ts       // counterfactual runner driving adapter.fork/variant ops
  classifier.ts      // FailureClass trunk + namespaced subclasses
  substrate.ts       // SubstrateAdapter interface + registry + capability negotiation
  consent.ts         // realm consent records (browser origin becomes one realm kind)
  replay.ts          // orchestration over adapter.replay + classifier
mcp/synthi-mcp/src/embodied/adapters/
  browser/           // wraps existing src/browser/* — thin, no logic moves twice
  terminal/          // PTY sessions, exit-code/fs/unit observers
  runtime/           // pods, notebooks, program lifecycle (programs.ts already exists)
  game/              // WebSocket scene-graph protocol; engine plugins (Godot/Unity/web)
  kernel/            // namespace-scoped exec, syscall observer, snapshot hooks
  api/               // HTTP session capture -> contract -> tool emission
```

Extraction rules:

- `workflow.ts` keeps browser surface detection but its causal-contract spine (preconditions, effects, variants, bindings, limitations) moves to `embodied/contract.ts`; the browser file re-exports so no caller breaks.
- lane0 reduction generalizes to `embodied` event windows with per-substrate merge profiles (tick merging for games, line/command merging for terminals); browser profile remains byte-compatible.
- The dojo stack (vivarium, checkride, license kernel, case law) takes a `substrate_scope` dimension on seeds, scenarios, and licenses. Its abstractions were already substrate-agnostic in intent; scenarios gain a `world_manifest` that names an adapter instead of assuming a hosted browser.

Tool surface:

```text
new high-level (substrate-neutral):
  synthi_attach_substrate        // list realms, attach with consent
  synthi_observe                 // channel-aware observation
  synthi_begin_teach / synthi_end_teach
  synthi_compile_workflow
  synthi_run_workflow
  synthi_explain_failure
existing synthi_browser_* tools: unchanged; internally become the browser adapter.
```

UI: the Agent panel's Connect/Observe/Teach/Run/History views stay; the Observe view gains a substrate picker fed by `synthi_attach_substrate`. Users still never see the words adapter, realm, or lease.

---

## Safety and Governance Matrix

Risk lives in the substrate, so trust boundaries must be per-substrate and explicit:

| Substrate | Blast radius | Reset story | Default license ceiling | Extra gate |
|---|---|---|---|---|
| Browser (workspace preview) | contained | fresh context | E4 with origin consent | existing consent stack |
| Terminal (workspace root) | scoped-write | git clean / restore | E3 | secret scrubbing audit |
| Runtime pod | scoped-write | pod recycle | E4 | quota + eviction policy |
| Notebook | scoped-write | kernel restart | E4 | cell-output redaction |
| Game single-player/sandboxed | contained-seeded | save state / fork | E4 in sandbox | seeded-determinism proof |
| Game live/multiplayer | external / irreversible | none | E2 observe-only | per-action human approval |
| Kernel namespace | scoped-write | snapshot restore | E3 | snapshot-before-mutation mandatory; host forever forbidden |
| API (internal) | external | fixtures | E3 | mutation kinds reused (create/update/delete/payment/deploy) |
| Third-party SaaS / anti-cheat clients | external + ToS exposure | none | E2 | legal review required before any adapter ships |

Irreversibility is a first-class contract field: steps whose substrate reports `irreversible` for their action kind require either a compensating-action declaration or permanent human-approval gating. This extends the existing mutation-kind logic (`payment`, `deploy`) rather than replacing it.

## Failure Classification Trunk

Shared trunk classes survive from `FailureClassV7`: locator/perception drift, auth/consent missing or expired, mutation blocked, unsafe environment, test data missing, route/world changed, hydration/load delay, network failure, app validation error, unknown.

Namespaced additions per substrate:

```text
game.physics_blocked      game.entity_not_found      game.perception_low_confidence
game.tick_rate_variance   game.occlusion_unresolved  game.seed_drift
kernel.permission_denied  kernel.unit_failed         kernel.fs_readonly
terminal.nonzero_exit     terminal.prompt_desync     terminal.secret_detected
api.contract_mismatch     api.rate_limited           api.schema_drift
runtime.hmr_timeout       runtime.pod_evicted
```

Every replay failure must classify into trunk + subclass with the same ≥90 percent classified-reason bar the browser MVP set.

---

## Implementation Phases

Phase 0 — Neutral core extraction (no behavior change)

- Extract `embodied/event.ts`, `contract.ts` spine, `consent.ts`, `classifier.ts` trunk; browser adapter wraps current code; all existing tests green byte-for-byte.
- Acceptance: zero browser regressions; `EmbodiedEvent` round-trips `BrowserTraceEvent` losslessly.

Phase 0b — Conformance harness on a toy substrate (anti-hardcoding gate)

Before any real adapter is written, the core must prove it works against worlds it has never seen. A minimal in-process "toy" substrate (a small deterministic grid/scene simulation with randomized entity layouts, colors, ambient oscillators, and hidden state) exercises the full pipeline: record, State Differ stages 1–5, compile, harden, replay. The harness randomizes everything semantically interesting at runtime — which values matter, which entities are targets, which oscillators exist — so the pipeline cannot pass by memorizing a scenario.

Acceptance:

- the toy substrate passes record→compile→replay with zero core changes across N randomized seeds;
- injecting a deliberate scenario-specific shortcut into the core makes the fuzz fail (the test suite must detect the failure class, verified once by mutation);
- the same conformance suite later gates the terminal and game adapters: an adapter ships only when its implementation of stages 1 (diff) and its schema satisfy the harness.

Phase 1 — Terminal + runtime adapter

- PTY session capture, exit-code/fs/unit observers, replay in a fresh pod, secret scrubbing.
- Golden fixtures: rotate-logs-and-restart (above), run-tests-and-triage-failure.
- Acceptance: taught terminal flow replays ≥95% same-pod, ≥85% fresh-pod; zero secrets in stored traces (asserted by tests, like denied-origin screenshot tests); passes the Phase 0b conformance suite.

Phase 2 — Game adapter (experimental milestone)

- Scene-graph observation protocol (Godot/Web first via WebSocket; Unity follow), continuous-action quantization, fork-based counterfactuals, procedural checkride scenario. Runs behind the shared core interfaces on an experimental track; production adapters take priority.
- The purple door becomes the repo's cross-substrate golden fixture, held to the same standard as the browser MVP fixtures (hydration delay, duplicate labels, text change) plus the randomized-world conformance suite: door hue, count, layout, lighting, occluders, and tick rate are all harness-randomized per run.
- Acceptance: randomized door-inspection flows compile, survive the wind-tunnel variant classes on the preferred binding, pass checkrides, and issue sandboxed E3 licenses across seeds; pixel-only fallback correctly flagged low-confidence; no core code may reference doors or color predicates to achieve this.

Phase 3 — Kernel adapter

- Namespace-scoped exec, syscall observation, mandatory snapshot-before-mutation, host hard-blocked.
- Acceptance: every mutating replay preceded by verified snapshot; host-namespace attempt refused and audited.

Phase 4 — Cross-substrate composition + API adapter

- Multi-substrate workflow graphs, per-node lease dispatch, HTTP session capture emitting both contracts and MCP tools (completing the Substrate Ladder to T0).
- Acceptance: edit-HMR-verify fixture passes end to end; taught API flow emits a working private tool discoverable through the existing private-tool registry.

Phase 5 — Governance unification

- `substrate_scope` on licenses, case law, and the entrustment dial; unified proof capsule covering mixed-substrate evidence.
- Acceptance: one competency can carry evidence from two substrates and still validate against a single license.

## Metrics (extending the browser MVP gates)

Execution metrics:

- teach event delivery p95 < 250 ms per substrate
- replay pass: ≥95% same-environment, ≥85% cold-environment per substrate fixture suite
- classified failures ≥90%
- seeded substrates: double-replay world-state hash equality ≥99%
- perception contracts: ≥80% resolved on preferred (non-pixel) binding across fixtures
- zero cross-realm observation leaks (tested per substrate, mirroring denied-origin tests)

Semantic-quality metrics (replay pass rate alone proves too little — a contract can replay reliably while asserting the wrong things):

- **contract precision** — fraction of generated preconditions/effects judged actually necessary (survive pruning without changing replay outcomes); target ≥80%; near-100% suggests under-generation, so report alongside recall from injected-fault runs
- **counterfactual discrimination** — compiled contracts succeed on equivalent-world variants AND fail on intentionally non-equivalent variants (e.g. green-door twin); a contract that passes both is vacuous; require 100% discrimination on adversarial twin fixtures
- **causal false-positive rate** — ambient/induced changes that leaked into expected effects despite stage-3 attribution; measured by control-run audits; target <5%, and every occurrence downgrades evidence kind
- **affordance degradation rate** — share of hardened contracts whose execution fell from T0/T1/T2 to T3/T4 between compilation and later replays; target <10%/month tracked per competency; spikes indicate world drift and should trigger re-hardening, not silent coordinate-clicking
- **human correction rate** — share of compiled contracts edited by humans after compilation (intent rewording counts; pure parameterization does not); target downward trend per substrate as inference improves
- **license false-positive rate** — competencies granted a license whose later behavior contradicted its tested scope, divided by licenses granted; this is the most important metric in the system because incorrectly granting competence is worse than failing to replay; target <1% with every occurrence producing a case-law entry and license-scheme review

## Non-Goals

- No full digital twin of any world; organoids and forks stay task-sized.
- No claim of universal game support: ship engine-by-engine behind the adapter protocol; online multiplayer stays observe-only pending the governance row above.
- No host-kernel access, ever, from the kernel adapter.
- No silent generalization: a competency licensed on one substrate never executes on another without its own checkride.
- No scenario-specific code paths in the core: no named environments, entity kinds, colors, or domain nouns anywhere in `embodied/` core modules. Semantics enter through schemas, profiles, and human confirmation — enforced by the Phase 0b conformance fuzz and reviewed on every core PR.
- No expert-only product: universality must arrive as simplicity. The user-facing surface stays five verbs (attach, observe, teach, run, explain) across every substrate, with zero jargon and working defaults for every knob. "It works on everything" is delivered as "you don't have to think about which thing it is." A phase gate fails if teaching a flow requires reading documentation or understanding internals (see the plan's North Star section).

## Open Questions

1. Continuous-action storage size: downsample policy for tick-resolution traces (keep full fidelity for N hours, reduced windows after)?
2. Should terminal capture sit at PTY level (portable, semantic-light) or shell-integration level (richer, per-shell work)? Recommend PTY first, shell integration as enhancement.
3. Does the vivarium need a physics-tolerance fuzzer for game checkrides beyond the listed adversarial set?
4. Ownership of the substrate picker UX in the Agent panel without recreating the questionnaire problem the browser plan warns about.
5. Salience weight defaults: learn them per substrate from multi-demonstration corpora over time, or keep them static profile configuration initially? Recommend static first, learning later behind evaluation.
