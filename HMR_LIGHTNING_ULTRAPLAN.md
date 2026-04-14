# HMR Lightning Ultraplan — Runtime HMR that feels instant

**Companion to**: `HMR_AGNOSTIC_ULTRAPLAN.md` (already shipped — made the BUILD pipeline library-agnostic).
**Scope**: make the RUNTIME HMR (a) work for any C++ library, not just SDL2, and (b) feel instant — sub-frame for value edits, sub-frame-plus-video-tax for structural edits, across every supported library.
**Status**: drafting, revision 2. Branch: TBD after approval.

## Revision history

- **rev1** (initial draft): four-phase structure, latency budgets, file lists, risks. Landed in commit `802170e5`.
- **rev2** (this): major revision pass after detailed technical review. Changes:
  - §1 Measurement point made explicit: we measure **runner-internal** (source-save → frame-rendered-inside-runner-process) and **user-visible** (runner-internal + video pipeline tax) as two separate metrics. Success criteria specify both.
  - §3 Latency budget rewritten to include: speculation-hit path AND speculation-miss path AND video pipeline tax AND filesystem jitter. Honest numbers replace the fiction.
  - §4 Phase 9: PCH macro extraction added (pre-include `#define` preservation), `.o` cache `headers_hash` spec pinned to `-M` output, ccache/ocache interaction documented, `num_cpus::get() >= 3` gate added, benchmark harness split into compile-only + end-to-end.
  - §5 Phase 10: `WindowBackend` made `!Send` (single-threaded runner main), video capture moved to X11-display-id path (never touches backend pointer), event normalization simplified to lifecycle-only (Quit/Resize/RawForward) — user code polls library state directly. Backend selection prefers arch cache language field over flag parsing. Sokol estimate bumped 1d→3-4d. Dependencies moved from cargo deps to runtime dlopen to bound container impact.
  - §6 Phase 11: three-layer integrity check (source content hash + literal byte match + DWARF decl_line stability). `-O0` enforcement at manifest validator. Constant-pooling mitigation via `-fno-merge-constants` OR detection-and-fallback. Explicit ASLR handling via `l_addr` + `dl_iterate_phdr`, with test case. AST-ish value-only classification via Tree-sitter instead of regex. "60% of edits" claim removed. Estimate raised 1-2w → 2-3w. Phase 11 dependency on Phase 10 for non-SDL2 libraries acknowledged and documented.
  - §7 Phase 12: IPC protocol gains `version: u8` + capability negotiation. Signal handler ownership matrix documented. Link-time `nm` check for `synthi_hmr_init` / `synthi_hmr_on_frame` symbols added as a post-compile gate. "State marshal across IPC" budget line fixed (state stays in-process in child). EGL/surfaceless libraries documented as explicit limitation. "Zero-day library" claim reframed to "AI-known-but-Path-A-absent libraries."
  - §8 Files: added guardrail module paths.
  - §9 Sequencing: critical-path analysis added, dependency graph, rollback strategy per phase, feature-flag state per user. Estimates bumped honestly: 5-7w aggressive → 8-12w aggressive, 8-10w conservative → 12-16w conservative.
  - §10 Tests: fuzz corpus pinned (literal kinds × source positions × compiler versions × optimization levels). End-to-end benchmark wired to simulated frontend client.
  - §NEW Cross-cutting correctness guardrails (§13): memory budget + eviction, per-session RSS cap, -O0 enforcement, ABI/struct layout detection, signal-handler ownership table, rollback.
- **rev3+**: reserved for post-implementation corrections.

---

## 0. TL;DR

Four phases. Numbers revised after the rev2 review pass:

| # | Phase | Effort (aggressive / realistic) | Runner-internal win | User-visible win (incl. video) | Coverage win |
|---|---|---|---|---|---|
| 9  | **g++ compile acceleration** (ccache + PCH + parallel compile + `.o` caching) | 4-6d / 6-8d | ~650ms → ~120ms on cold structural edit | ~700ms → ~170ms | none |
| 10 | **Path A — library-aware runner** (`WindowBackend` trait + GLFW, raylib, sokol, SFML backends) | 8-11d / 12-16d | parity with SDL2 | parity with SDL2 | runtime HMR for 5+ libraries |
| 11 | **Binary patching for value edits** (skip g++, patch `.so` literals in live runner) | 14-21d / 20-28d | ~650ms → ~20ms on value edits | ~700ms → ~70ms (video tax dominates) | none; only SDL2 until Phase 10 lands |
| 12 | **Path C — supervisor + child process** (BYOR + AI-known-but-Path-A-absent libs, via Xvfb capture of child) | 12-16d / 16-21d | +40-80ms IPC tax over Path A | +40-80ms | unlocks libraries the AI can compile AND can author a correct runner for |

**Recommended sequence**: 9 → 10 → 11 → 12 (revised from rev1's 9 → 11 → 10 → 12 — Phase 11 depends on Phase 10 for any non-SDL2 benefit, so Phase 10 must land first). Reasoning under §9.

**Revised timelines** (honest): aggressive single-track 8-12 weeks, realistic with testing 12-16 weeks. See §9 for critical-path analysis.

**End state**: after all four phases, a user editing any C++ project covered by Phase 10 or AI-compilable via Phase 12 experiences:
- **Value tweaks** (color, number, string literal that fits in place): **~20ms runner-internal**, **~70ms user-visible** (video pipeline tax is a hard floor we can't shave)
- **Structural edits** (new function, changed logic): **~180ms runner-internal**, **~230ms user-visible**
- **First compile per session**: 1-3s, unavoidable cold cost

Reference latency target: **Figma-feel for value edits, post-save acceptable for structural edits** — the user should never perceive "I hit save and now I'm waiting."

**Honest caveat**: the ~20ms / ~70ms value-edit numbers apply on the speculation-hit path (user pause triggered pre-compile). On the speculation-miss path (user typed, paused <300ms, saved immediately), add 200ms of debounce wait to everything.

---

## 1. Goal & Success Criteria

### 1.1 Goal

When a user saves a change in the Synthi IDE, the visible result in the runner-streamed video should feel like a live preview — sub-frame for value tweaks, post-save-acceptable for structural edits — regardless of what framework/library the project uses.

### 1.2 Measurement points (two, not one)

This is a correctness-of-spec fix from rev1. We measure **two distinct latencies** for every scenario because they have very different lower bounds:

**Runner-internal latency** = from the Rust worker receiving the compile request to the runner process rendering a frame containing the new value. This is what the plan's optimizations directly attack — compile time, dlopen time, binary patch time.

**User-visible latency** = runner-internal + filesystem jitter + WebRTC video pipeline tax. This is what the user actually experiences. We cannot shave below the video-pipeline floor without changing the transport, which is out of scope.

#### Fixed latency components (baseline, cannot be optimized in this plan)

| Component | p50 | p99 | Notes |
|---|---|---|---|
| Frontend save → worker POST (local) | 5ms | 20ms | WebSocket round-trip, same machine |
| Filesystem write of `.so` artifacts | 5ms | 25ms | higher on overlay FS / container |
| `dlopen` from disk (cold) | 20ms | 60ms | includes DT_NEEDED symbol resolve |
| GStreamer encode frame → webRTC packet | 15ms | 35ms | h264 hardware encode if available, else software |
| WebRTC transport to browser | 10ms | 50ms | same-machine loopback vs real network |
| Browser video decode + paint | 10ms | 30ms | depends on hardware decode path |
| **Video pipeline tax (total)** | **35ms** | **115ms** | **the hard floor on user-visible latency** |

The video tax is ~35-115ms and we can't change it inside this plan. Every `user-visible` success criterion has to carry this budget. Every `runner-internal` criterion is free of it.

### 1.3 Success criteria (revised — both measurement points)

Runner-internal:
- **Value-edit p50**: ≤25ms (from worker receiving compile → frame rendered)
- **Value-edit p99**: ≤60ms
- **Structural-edit p50**: ≤200ms
- **Structural-edit p99**: ≤500ms

User-visible (runner-internal + video tax):
- **Value-edit p50**: ≤70ms (25ms internal + 35ms video tax + 10ms jitter budget)
- **Value-edit p99**: ≤180ms
- **Structural-edit p50**: ≤250ms
- **Structural-edit p99**: ≤620ms

Measurement preconditions:
- All numbers apply to the **speculation-hit path** (user paused ≥300ms before save; Phase 5 speculation already ran). On the **speculation-miss path**, add ~200ms debounce wait and add 1 AI call (~1-2s) to all structural-edit numbers.
- All numbers apply to **Phase 10 backends** after Phase 10 ships. Pre-Phase-10, only SDL2 projects hit these targets.

Coverage criteria:
- **Phase 10 runtime coverage**: SDL2, GLFW, raylib, sokol, SFML, ImGui+SDL pass the Phase 7 corpus in **end-to-end mode** (build → spawn → edit → observe frame change), not just build-time
- **Phase 12 coverage**: libraries that (a) the AI can compile per Phase 4.5 validator AND (b) the AI writes an acceptable `host_runner.cpp` per Phase 4 confidence gate (`runner_synthesis >= medium`), work via Path C. We do NOT promise "any library" — see §7.1 for the honest reframing.
- **No regressions**: existing SDL2 happy path stays under today's measured runner-internal p50

Qualitative bar:
- "I can't tell which library my project uses from the HMR speed."
- "Tweaking a color feels like dragging a slider, not saving a file."
- "I didn't have to pick a library when I started the project — it just worked."
- "The one time HMR failed, the error told me exactly what to do."

### 1.4 Out of scope

- Languages other than C/C++ (language-parameterisation is post-V2)
- Runtime HMR for compiled languages without dynamic linking (Rust, Go, Zig without `-dynamic`)
- True multi-step build systems (CMake, Meson, Qt MOC) — still rejected cleanly per Phase 3 mitigation
- Remote runners (HMR across network boundary) — post-V3
- **Shaving below the video pipeline floor** — changing from WebRTC video to a canvas/WebGL bitmap stream, using SharedArrayBuffer, or any other "cut the pipeline" approach. That's a separate plan.
- **EGL / surfaceless rendering** — Phase 12's ximagesrc capture requires an X11 window. Libraries that render to EGL surfaces without an X11 window (some sokol configs, some raylib configs, some offscreen pipelines) are not covered. Documented as an explicit limitation in §7.4.

---

## 2. Where we are vs where we're going

### 2.1 What shipped in `HMR_AGNOSTIC_ULTRAPLAN.md`

Build-time is library-agnostic. Concretely:

- **Phase 1-3**: AI produces a 4-file split (`shared.h`, `core.cpp`, `gui.cpp`, `host_runner.cpp`) + a build manifest describing compiler / flags / link flags / hot_reload_mode. Worker uses the manifest instead of hardcoded SDL2 values. Any C++ library, any compiler, any flags.
- **Phase 4**: `host_runner.cpp` is compiled into a per-project executable as a build artifact. Not spawned at runtime yet (see §2.2).
- **Phase 4.5**: pre-flight include→link validator ensures every `#include <X.h>` has a matching `-lX` flag or an explicit notes excuse. Rejects impossible manifests before compile.
- **Phase 5**: Tier 2 diff-patch accepts `host_runner` as a 4th edit target, so hot edits to window code get routed correctly.
- **Phase 6**: if the linker reports undefined references at compile time, the manifest heal loop asks the AI to add the missing flag and retries once. No library catalog — the AI infers from symbol names + source.
- **Phase 7**: 11-project corpus + pytest suite + CI workflow gate on prompt/manifest changes.
- **Phase 8**: frontend displays the AI-detected framework name in the status bar, BYOR toggle, confidence warning, manifest rejection error card.

159 offline tests + 11 live-integration tests, all green. Build pipeline: done.

### 2.2 The runtime gap

Runtime is SDL2-centric. Concretely:

- `worker/src/runtime/runner_bin.rs` — the shipped binary that spawns at runtime — creates an SDL2 window itself via X11/Xvfb, runs its own event loop, dlopens `libcore.so` + `libgui.so`, and streams video via GStreamer captured from the SDL2 window handle.
- If the user's project is GLFW-based: the `.so` files get produced correctly (Phase 3 works), but at runtime the shipped `runner_bin` opens an SDL2 window. Inside `libgui.so`, the `gui_on_render` function tries to call `glfwSwapBuffers` against a window that doesn't exist → crash or hang.
- The per-project `host_runner_<timestamp>` binary compiled in Phase 4 sits unused on disk.

The four phases in this plan close that gap — and, as a bonus, shave 90%+ off the latency floor for the common case.

### 2.3 What "runtime" actually encompasses

Three sub-systems have to work together:

1. **Window + event loop host**: creates a window the user's code can draw to, pumps events into it. Today: SDL2 hardcoded in `runner_bin`.
2. **Module reload mechanism**: dlclose/dlopen the `.so` files when they change, remap function pointers, migrate state across the reload. Today: works for any library as long as the library itself is swap-safe (Phase 4 `hot_reload_mode` covers process-restart libraries).
3. **Video streaming pipeline**: capture the rendered frames and send them to the browser via WebRTC. Today: Xvfb + GStreamer, captures from the shipped runner's SDL2 window.

Phase 10 (Path A) extends sub-system 1 to N libraries via a trait. Phase 11 sidesteps all three by patching the `.so` in place — no reload needed. Phase 12 decouples sub-system 1 from the supervisor so sub-system 3 captures generically (any X11 window).

---

## 3. The latency budget

Revised rev2 to be honest about: (a) speculation hit vs miss paths, (b) the video pipeline tax, (c) filesystem jitter in containerized deployments, (d) user-visible vs runner-internal split.

### 3.1 Budget anatomy

Every budget below is broken into three panels:

1. **Runner-internal** — what the plan's optimizations directly attack
2. **User-visible (hit path)** — runner-internal + filesystem jitter + video pipeline tax, on the Phase 5 speculation-hit path (user paused ≥300ms before save)
3. **User-visible (miss path)** — the same as hit path, plus the 200ms debounce wait that speculation didn't have time to mask

The miss-path column is what a user experiences when they type, pause briefly, and save immediately. Speculation-miss rate isn't measured in production today — we instrument it in Phase 9f. Rough estimate: 30-40% of saves on active typing sessions, 5-10% on deliberate editing sessions.

### 3.2 Current floor (SDL2 happy path, post-`HMR_AGNOSTIC_ULTRAPLAN.md`)

**Value edit** (Phase 5 speculation hit, Tier 1 regex patcher still compiles):

```
RUNNER-INTERNAL
  classify edit + apply cached patch      ~5ms
  g++ on patched core.cpp                ~300ms
  g++ on patched gui.cpp                 ~300ms
  filesystem flush of .so files           ~5-25ms
  dlclose + dlopen                        ~50ms
  next frame render                       ~16ms
  ────────────────────────────────────────
  subtotal                              ~676-696ms

USER-VISIBLE (HIT PATH)
  = runner-internal + video pipeline tax
  encode + transport + decode            ~35-115ms
  ────────────────────────────────────────
  user-visible p50                      ~710ms (internal p50 675 + video p50 35)
  user-visible p99                      ~810ms (internal p99 695 + video p99 115)

USER-VISIBLE (MISS PATH)
  + debounce wait (frontend)             ~200ms
  + AI diff-patch call (not cached)     ~800ms   ← plus this for Tier 2
  ────────────────────────────────────────
  user-visible p50                      ~1710ms
```

**Structural edit** (Phase 5 Tier 2 diff-patch on hit path):

```
RUNNER-INTERNAL
  apply edit list                         ~5ms
  g++ full recompile (both modules)     ~600ms
  filesystem flush                        ~10-30ms
  dlclose + dlopen                        ~50ms
  next frame                              ~16ms
  ────────────────────────────────────────
  subtotal                              ~681-701ms

USER-VISIBLE (HIT PATH)
  + video pipeline tax                   ~35-115ms
  ────────────────────────────────────────
  user-visible p50                      ~720ms
  user-visible p99                      ~820ms

USER-VISIBLE (MISS PATH)
  + debounce 200ms + AI diff 800ms     ~1000ms
  ────────────────────────────────────────
  user-visible p50                     ~1720ms
```

Dominant cost on both paths is g++. The video tax is real but small relative to compile cost. Filesystem jitter is noticeable on overlay filesystems (Docker + ext4 overlay) — 10-30ms added on every save.

### 3.3 Target floor — Phase 9 only (compile acceleration)

**Value edit** (Phase 9 sub-phases all landed, still via compile path):

```
RUNNER-INTERNAL
  classify edit + apply cached patch      ~5ms
  ccache hit on core.o                    ~3ms   ← 9a
  g++ -c gui.cpp with PCH                 ~60ms  ← 9c (measured, not speculative)
  link libgui.so from cached+fresh .o     ~30ms  ← 9b
  parallel dispatch (core skipped)         ~0ms  ← 9d
  filesystem flush                        ~5-15ms (keeping for honesty)
  dlclose + dlopen                        ~50ms
  next frame                              ~16ms
  ────────────────────────────────────────
  subtotal                              ~169-179ms

USER-VISIBLE (HIT)     ~205ms p50, ~295ms p99
USER-VISIBLE (MISS)    ~1205ms p50 (debounce + AI call dominate)
```

4x faster runner-internal for value edits, ~3.5x user-visible. The miss path still costs a second because speculation + AI is where the big savings come from.

**Structural edit** (both modules touched):

```
RUNNER-INTERNAL
  apply edit list                         ~5ms
  ccache miss, compile core with PCH     ~80ms   ← 9c
  ccache miss, compile gui with PCH      ~80ms   ← 9c
  parallel                                overlap ~70ms   ← 9d (capped by slowest)
  link both                               ~40ms
  filesystem flush                        ~5-20ms
  dlclose + dlopen                        ~50ms
  next frame                              ~16ms
  ────────────────────────────────────────
  subtotal                              ~186-201ms

USER-VISIBLE (HIT)     ~220ms p50, ~320ms p99
```

### 3.4 Target floor — Phase 11 binary patching (SDL2 first, Phase 10 backends second)

**Value edit** (Tier 0 binary patch, Phase 11 target):

```
RUNNER-INTERNAL
  classify edit (Tree-sitter diff)        ~3ms
  DWARF literal lookup (cached index)     ~2ms
  three-layer integrity check             ~3ms   ← revised from ~1ms (11b)
  compute runtime address from l_addr     ~1ms
  IPC patch command to runner             ~2ms
  runner: mprotect+memcpy+icache+restore  ~3ms
  frame-sync hold                         ~1-16ms (up to next frame boundary)
  next frame                              ~16ms
  ────────────────────────────────────────
  subtotal                              ~31-46ms

USER-VISIBLE (HIT)     ~70ms p50, ~160ms p99
```

**The video tax dominates user-visible now** — the frame is ready in ~31ms, the remaining ~40ms is pipeline. You can't shave it without replacing WebRTC video.

**Honest note**: this budget assumes the literal is findable in DWARF and layout-stable. Tier 0 hit rate on value-only edits is estimated at 50-70% based on edit-pattern analysis of the corpus — the rest fall through to Tier 1 (compile path). We instrument hit rate in Phase 11g.

**Structural edit** (unchanged from Phase 9): Tier 0 doesn't apply, Phase 9 numbers stand.

### 3.5 Target floor — Phase 12 Path C (AI-known libraries not in Path A)

**Value edit** via Path C (Tier 0 binary patch + Path C IPC):

```
RUNNER-INTERNAL
  (Phase 11 Tier 0 hit)                   ~31-46ms
  + IPC socket round-trip to child         ~3-8ms  ← revised from 20ms state marshal
  ────────────────────────────────────────
  subtotal                              ~34-54ms
```

**State marshal budget fix**: rev1 listed `~20ms state marshal across IPC` which was wrong. State stays in-process in the child; only the patch command crosses the socket. The IPC overhead is ~3-8ms per round-trip, no marshaling.

**Structural edit** via Path C:

```
RUNNER-INTERNAL
  Phase 9 compile path                  ~186-201ms
  + IPC reload command                    ~3-8ms
  + child dlclose + dlopen                ~50ms   (inside child, same as in-process)
  ────────────────────────────────────────
  subtotal                              ~239-259ms

USER-VISIBLE (HIT)     ~275ms p50, ~375ms p99
```

Path C's latency tax is real but bounded: ~40-80ms over Path A across the scenarios. Acceptable because Path C is the fallback for libraries we don't have a native backend for.

### 3.6 What the numbers DON'T say

- **Speculation miss rate**: if 35% of saves miss speculation, the aggregate user experience is 65% × hit-path + 35% × miss-path. For value edits after Phase 11, that's 65% × 70ms + 35% × (70 + 1000)ms = 420ms weighted average. Better than today's ~1200ms weighted average but not 70ms.
- **First compile per session**: cold cache, no speculation, ~1-3s. Unavoidable. Users experience this once per session.
- **Xvfb startup on Path C**: ~200-400ms added once per session when Path C is activated. Amortized to zero on repeated edits.
- **RSS cost**: each session holds ccache + .o cache + PCH + DWARF index in memory. Per-session ~50-150MB. See §13 for the cap and eviction policy.

---

## 4. Phase 9 — g++ Compile Acceleration

### 4.1 Intent

Attack the compile step. No architectural risk — every sub-phase is mechanical and independently testable. Benefits every HMR edit (both tiers), every library (future Phase 10 backends included), every project.

### 4.2 Design

Five orthogonal optimizations that stack:

#### 9a. ccache wrapping (~0.5 day)

Wrap every `system_command("g++")` and `system_command("clang++")` call in `ccache <compiler>` when available.

- Detection: check `which ccache` at worker startup, set a global `USE_CCACHE: bool`
- Cache dir: `$CCACHE_DIR` if set, else `~/.ccache`
- Fallback: ccache missing → silent skip

**Interaction with 9b** (answer to the rev2 review "which cache is checked first" question):

The two caches are **complementary, not redundant**. They have different keys, different hit semantics, and different failure modes:

| | ccache (9a) | `.o` cache (9b) |
|---|---|---|
| Key | `hash(preprocessed_output) + flags` | `hash(source_text) + flags + transitive_headers_digest` |
| Hit semantics | "semantically identical after preprocessing" | "same literal bytes" |
| Catches | Comment changes, `#if 0` blocks, whitespace | Comment changes, whitespace (if content_hash normalizes them) |
| Cost to check | ~5-10ms (spawns preprocessor) | ~1ms (hash lookup, no preprocessor) |
| Hit payload | `.o` file | `.o` file |

**Rule**: check the `.o` cache FIRST. If hit, skip the compile entirely (fast path, ~1ms lookup). If miss, invoke `ccache g++` — which does its own preprocessed-source check internally, and stores its result in ccache's directory. Phase 9b then reads that `.o` out of the filesystem and writes to its own cache by `(source_hash, flags_hash, headers_hash)` for next time.

This gives us: fast-path `.o` cache hit for the common case (unchanged sources), ccache's broader equivalence check for edge cases (comment-only changes, whitespace), and no redundant preprocessor runs on the fast path.

- **Files**: `compile_core.rs`, `compile_gui.rs`, `compile_runner.rs`, `worker/src/hmr/incremental_cache.rs` (cache check order)
- **Test**: integration test with three scenarios — identical re-compile (should hit `.o` cache, ~1ms), comment-only change (should miss `.o` cache but hit ccache, ~10ms), real change (should miss both, full compile)

#### 9b. Incremental `.o` caching with link-only reuse (~2 days — revised up from 1-2d)

Today's compile: `g++ source.cpp -shared -o lib.so` — one step.

Split into two:
```
g++ -c source.cpp -o source.o     # compile (~250ms cold)
g++ -shared source.o -o lib.so    # link (~30ms)
```

Cache the `.o` file by `(content_hash, flags_hash, headers_hash)` — same key structure as today's `.so` cache.

**`headers_hash` spec** (answering the rev2 review's "which headers" question):

`headers_hash` is the digest of the **transitive include tree** discovered via `g++ -M -MF /dev/stdout source.cpp`. Specifically:

```rust
// Phase 9b cache key derivation
fn compute_headers_hash(
    source: &Path,
    flags: &[String],
) -> io::Result<u64> {
    // Run g++ -M once to enumerate transitive headers
    let output = Command::new("g++")
        .args(&["-M", "-MF", "-"])  // dependency output to stdout
        .args(flags)
        .arg(source)
        .output()?;
    let deps = parse_make_deps(&output.stdout);  // returns Vec<PathBuf>
    // Hash each header's content + path + mtime (mtime as tie-breaker)
    let mut hasher = DefaultHasher::new();
    for dep in &deps {
        hasher.write(dep.to_string_lossy().as_bytes());
        if let Ok(bytes) = fs::read(dep) {
            hasher.write(&bytes);
        }
    }
    Ok(hasher.finish())
}
```

**Cost**: ~30-60ms per compile to run `-M` (one preprocessor pass with no codegen). Not free, but cheaper than a full compile.

**Optimization**: cache the dependency list itself keyed on `source_hash + flags_hash`. If the source hasn't changed, we know the dep list hasn't either — skip the `-M` run, reuse the cached dep list, only re-hash the dep contents. That drops the `headers_hash` compute to ~5-10ms on the hot path.

**Why bother with transitive hashing instead of just `shared.h`**: system-header upgrades in the deployment container (new libc, new libstdc++) change the ABI of the `.o` file without the source changing. If `headers_hash` only covered `shared.h`, stale objects would link against new libraries and cause runtime crashes. Transitive coverage catches this at the cost of ~30-60ms one-time per session (most of which we amortize away).

**Staleness**: mtime in the dep hash is the tie-breaker for `ccache`'s "same content different path" case — rare but real.

- **Files**: `worker/src/hmr/incremental_cache.rs` (headers_hash helper), `compile_*.rs` (use it)
- **Test**: unit test headers_hash changes when a transitive header on disk changes; integration test measures wall-clock on cached module

#### 9c. Precompiled headers (PCH) — with macro preservation (~3 days — revised up from 2d)

Library headers are massive. `<SDL2/SDL.h>` expands to ~20k lines, `<GLFW/glfw3.h>` is ~8k. Parsing them every compile is a significant fraction of the compile step.

**Macro extraction (the rev2 review's "pre-include defines" hole)**:

PCH correctness requires that the PCH header is included **in the same macro environment as the consuming source file**. If the user's source has:

```cpp
#define GLFW_INCLUDE_VULKAN
#define _GNU_SOURCE
#include <GLFW/glfw3.h>
```

The PCH compiled without those defines will have baked in the DIFFERENT codepaths of `glfw3.h`, producing silent ODR violations. This is the worst kind of bug — compiles fine, runs wrong.

**Fix**: extract pre-include defines from the user source (and from `core.cpp`/`gui.cpp`/`host_runner.cpp` after split) and inject them into the PCH generation:

```rust
// worker/src/compiler/stages/pch.rs

pub struct PchPlan {
    pub pch_header_content: String,   // what we feed to -x c++-header
    pub defines: Vec<String>,          // -D flags to apply to both PCH and consumers
    pub candidate_header: String,      // the big header to pre-compile
}

pub fn derive_pch_plan(source: &str) -> Option<PchPlan> {
    // 1. Scan source for `#define` directives BEFORE the first `#include`
    let pre_include_defines = extract_pre_include_defines(source);
    // 2. Find the largest non-stdlib include (from Phase 4.5's validator)
    let candidate = pick_pch_candidate_header(source)?;
    // 3. Synthesize a PCH header that:
    //    - applies the user's pre-include defines
    //    - then #includes the candidate header
    let pch_content = format!(
        "// AUTO-GENERATED PCH HEADER\n{}\n#include <{}>\n",
        pre_include_defines.iter().map(|d| format!("#define {}", d)).collect::<Vec<_>>().join("\n"),
        candidate,
    );
    Some(PchPlan {
        pch_header_content: pch_content,
        defines: pre_include_defines.iter().map(|d| format!("-D{}", d)).collect(),
        candidate_header: candidate,
    })
}
```

**Consistency check**: when compiling `core.cpp`/`gui.cpp`/`host_runner.cpp` against the PCH, verify that each file's pre-include defines are a **subset** of the PCH's. If any file has a `#define` the PCH doesn't, fall back to compiling that file without PCH. Log a warning so we can track how often this happens in production.

**Macro extraction is conservative**: we extract `#define SOMETHING` (object-like macros) and `#define SOMETHING value` (simple value macros). We do NOT handle function-like macros, conditional macros via `#if`, or `#undef`. On any of those → skip PCH for the file.

**Revised savings estimate** (rev2 review point): the PCH's benefit at `-O0 -g -fPIC` is NOT as dominant as I originally claimed. At `-O0`, parsing is ~40-50% of compile time, codegen + DWARF emission is ~50-60%. So PCH saves ~40-50% on header-heavy modules, not the 60%+ I asserted. We measure in 9f and adjust the expected numbers based on actual results. **Do not rely on PCH as the primary cost saver**; it's a multiplier on top of `.o` caching.

- **Files**: `worker/src/compiler/stages/pch.rs` (new), `ai_utils.rs` (PCH plan generation during split), `compile_*.rs` (consume the plan)
- **Test**: integration test with a project that has `#define GLFW_INCLUDE_VULKAN` in its source — verify the PCH build carries the define forward; test that a file without the define falls back to non-PCH compile

#### 9d. Parallel compile of core + gui + runner — with core-count gate (~1 day)

```rust
let use_parallel = num_cpus::get() >= 3;
if use_parallel {
    let (core_result, gui_result, runner_result) = tokio::join!(
        compile_core(...),
        compile_gui(...),
        compile_runner(...),
    );
    // ...
} else {
    // Serial fallback — e.g. 1-core container deployments
    let core_result = compile_core(...).await;
    let gui_result = compile_gui(...).await;
    let runner_result = compile_runner(...).await;
}
```

**Container CPU limits (rev2 review point)**: in a worker deployed with `--cpus=1.5`, tokio::join! on three compiles is no faster than serial and adds overhead. Gate on `num_cpus::get() >= 3` so the parallel path is only taken when it helps.

**Error reporting ordering**: when parallel, errors arrive interleaved. Collect per-module stderr into per-module buffers, then print them in a canonical order (core, gui, runner) after all three complete, so the user sees clean diagnostics.

- **Files**: `worker/src/compiler/handler.rs` (call site), `Cargo.toml` (`num_cpus` dep)
- **Test**: benchmark harness measures wall-clock on 3-core and 1-core configurations

#### 9e. `.so` cache hit rate instrumentation (~0.5 day)

Phase 3's `.so`-level cache exists but hit rate isn't measured. Add atomic counters + log on every compile. Track:
- hit rate per module (core / gui / host_runner)
- miss reasons (first compile, source change, flag change, headers change)

If hit rate is <50% for incremental edits, there's a bug in the cache key derivation — almost always flag ordering or unstable headers_hash.

- **Files**: `worker/src/hmr/incremental_cache.rs`
- **Action item**: fix any hit-rate bugs uncovered; they bleed performance at every layer above

#### 9f. Benchmark harness — TWO harnesses, not one (~2 days — revised up from 1d)

Rev2 review caught that a single "wall-clock compile time" benchmark doesn't prove the user-visible success criteria. Split into two:

**Harness A: compile-only wall clock** (`benchmarks/compile_latency.rs`)

Measures the compile step in isolation:
```
bench_cold_compile_sdl2()
bench_incremental_compile_sdl2()
bench_comment_only_change_sdl2()   // should hit ccache
bench_parallel_vs_serial()
bench_pch_hit_vs_miss()
```

Reports runner-internal compile latency. Used to validate 9a-9d.

**Harness B: end-to-end save-to-frame** (`benchmarks/e2e_hmr_latency.rs`)

Simulates a frontend client, sends an edit, waits for the rendered frame. Measures BOTH runner-internal AND user-visible:

```
bench_e2e_value_edit_sdl2(measurement: RunnerInternal | UserVisible)
bench_e2e_structural_edit_sdl2(measurement: ...)
```

Runner-internal: timestamp at compile-request arrival + timestamp at runner's on_frame callback.
User-visible: timestamp at compile-request arrival + timestamp at a WebRTC video frame received on the test client.

Runs against a real compile chain + real runner + a headless WebRTC test client (simplest path: use a libwebrtc test harness or spawn a mock browser via `cdp`).

**CSV schema** (checked into repo, tracked per-commit):
```
phase,scenario,measurement,library,p50_ms,p95_ms,p99_ms,sample_n,commit
9b,value_edit,runner_internal,SDL2,165,185,205,100,abc123
9b,value_edit,user_visible,SDL2,205,245,290,100,abc123
```

- **Files**: `benchmarks/compile_latency.rs`, `benchmarks/e2e_hmr_latency.rs` (new)
- **Regression gate in CI**: any PR that raises p50 on Harness B by >15% vs main fails. 15% is a wider margin than rev1's 10% because end-to-end numbers have more variance.
- **Acceptance**: runner-internal value-edit p50 drops from baseline ~675ms to ≤200ms after 9a-9d land

### 4.3 Files touched

**New**: `worker/src/compiler/stages/pch.rs`, `benchmarks/hmr_latency.rs`.
**Modified**: `compile_core.rs`, `compile_gui.rs`, `compile_runner.rs`, `handler.rs`, `hmr/incremental_cache.rs`, `ai_utils.rs` (PCH generation in split stage).

### 4.4 Risks

- **ccache not installed in deployment env**: handled by fallback.
- **PCH flag drift bugs**: if PCH keyed incorrectly, compile errors look spooky. Add aggressive logging so the user sees "PCH skipped: flag mismatch".
- **Parallel compile race on shared.h**: `shared.h` is written ONCE before the parallel block. Parallel compiles only read.
- **ccache cross-project pollution**: each project has its own tempdir, and source paths are absolute — ccache key is unique per project.

### 4.5 Success criteria

- Cold structural-edit compile: ~600ms → ≤150ms (measured by benchmark)
- Warm incremental (1 module changed, others cached): ≤100ms (measured by benchmark)
- No regression on SDL2 build correctness (Phase 7 corpus still green in CI)
- ccache hit rate >70% after warmup

---

## 5. Phase 10 — Path A: Library-Aware Runner

### 5.1 Intent

Extract the current SDL2-specific window/event/frame code in `runner_bin.rs` into a `WindowBackend` trait. Implement the trait for GLFW, raylib, sokol, and SFML. Runtime picks the backend based on the manifest's detected framework.

Preserves all the existing infrastructure:
- Xvfb + GStreamer video capture (still captures the runner's X11 window)
- In-process dlopen HMR (no IPC overhead)
- State bridge, crash isolation, hot-swap coordinator, managed adapter protocol

Only the "create window, pump events, present frames" slice changes.

### 5.2 Design

#### 10a. Trait extraction — `!Send`, single-threaded, minimal (~2 days — revised from 1-2)

Rev2 review caught two errors in the rev1 design: the `Send` bound was incorrect (raw pointers aren't `Send` and OpenGL contexts are thread-bound), and the `BackendEvent` enum was solving a problem that doesn't actually exist (user code polls library state directly, not via normalized events).

**Revised trait (minimal, single-threaded, not `Send`)**:

```rust
// worker/src/runtime/window_backend.rs (new)

use std::marker::PhantomData;

/// Opaque handle to the backend's window. Intentionally private fields —
/// the runner never needs to inspect the pointer directly. The backend
/// implementation owns it and uses it in its own method bodies.
pub struct WindowHandle {
    raw_ptr: *mut core::ffi::c_void,
    pub width: u32,
    pub height: u32,
    /// X11 window ID — populated by backends that own an X11-backed
    /// window. GStreamer capture uses THIS, not raw_ptr, so the capture
    /// pipeline never holds a reference to the backend's pointer.
    /// Backends rendering via EGL surfaceless or non-X11 set this to
    /// None; those projects then fall through to Path C.
    pub x11_window_id: Option<u64>,
    /// Marker: this handle is NOT Send. It's tied to the thread that
    /// created the window's GL context.
    _not_send: PhantomData<*const ()>,
}

/// Backend trait. !Send by construction — the runner's main loop is
/// single-threaded by design. Any parallelism happens at the worker
/// level, not inside the runner.
pub trait WindowBackend {
    /// Human-readable backend name ("SDL2", "GLFW", ...).
    fn name(&self) -> &'static str;

    /// Library init. Called once before create_window. Fails loudly
    /// if the library is missing or the init failed. Caller falls to
    /// Path C on any error.
    fn init(&mut self) -> anyhow::Result<()>;

    /// Create the main window. Called ONCE per session. Returns a
    /// handle that's bound to the current thread — do not move it.
    fn create_window(
        &mut self,
        title: &str,
        width: u32,
        height: u32,
        flags: WindowFlags,
    ) -> anyhow::Result<WindowHandle>;

    /// Pump library events. Backends keep their own internal event
    /// state. The runner calls this at the top of every frame so the
    /// library can process its event queue, respond to resize, etc.
    /// We deliberately do NOT return events to the caller — user code
    /// queries the library directly (glfwGetKey, SDL_GetKeyboardState,
    /// IsKeyPressed, etc.). See §5.2 rationale.
    fn pump_events(&mut self);

    /// Request quit — backends check `should_quit()` from the caller's
    /// main loop; set true when Quit arrives.
    fn should_quit(&self) -> bool;

    /// Begin frame. GL backends bind context, raylib calls BeginDrawing,
    /// etc. Called right before the user's gui_on_render.
    fn begin_frame(&mut self, handle: &WindowHandle);

    /// End frame. Swap buffers / present. Called right after user's
    /// gui_on_render returns.
    fn end_frame(&mut self, handle: &WindowHandle);

    /// Resize notification from the worker. Backends update their
    /// internal state (GL viewport, framebuffer resize, etc.).
    fn on_resize(&mut self, width: u32, height: u32);

    /// Cleanup. Called on runner exit.
    fn shutdown(&mut self);
}

/// Window creation flags — passthrough from the manifest.
#[derive(Debug, Clone, Copy, Default)]
pub struct WindowFlags {
    pub resizable: bool,
    pub fullscreen: bool,
    pub vsync: bool,
    pub opengl: bool,
    pub opengl_version_major: u8,
    pub opengl_version_minor: u8,
    pub opengl_es: bool,
}
```

**Why the event normalization got removed**: in real C++ game/gui code, input handling is done by polling the library's state directly:

```cpp
// GLFW user code
void gui_on_render(State* s) {
    if (glfwGetKey(s->window, GLFW_KEY_SPACE) == GLFW_PRESS) { ... }
}

// raylib user code
void gui_on_render(State* s) {
    if (IsKeyPressed(KEY_SPACE)) { ... }
}

// SDL2 user code
void gui_on_render(State* s) {
    const Uint8* keys = SDL_GetKeyboardState(NULL);
    if (keys[SDL_SCANCODE_SPACE]) { ... }
}
```

The user's compiled `.so` is linked against the library's functions. The trait's job is to make sure the library is INITIALIZED and its internal state (event queue, input snapshot, window resize) is KEPT CURRENT so those polls return sensible values. `pump_events()` is where that happens — the backend drains its library's event queue and updates the library's internal state. The runner never touches the events.

This removes:
- The `BackendEvent` enum and its maintenance burden
- The question of how to forward events to `core_on_event` — user code doesn't need them
- The thread-safety concerns around shared events (events stay inside the library)

It keeps:
- Lifecycle surface (init/create/begin/end/shutdown)
- Pump (so libraries can advance their own state)
- Quit detection (one boolean, not an event)
- Resize broadcast (for state sizing the backend needs to know about)

**GStreamer capture decoupling**: the capture pipeline needs an X11 window to read pixels from. `WindowHandle.x11_window_id` is populated by Path A backends that produce X11-backed windows. GStreamer's `ximagesrc` connects to the display + window ID — never touches the backend's internal pointers, never runs on the same thread as the backend. Backends rendering surfaceless EGL (some sokol configs, some raylib configs) set `x11_window_id = None`, and the runner_bin falls through to Path C for those projects.

- **Files**: `worker/src/runtime/window_backend.rs` (new — trait), `worker/src/runtime/backends/sdl2_backend.rs` (new — extracted SDL2 code wrapping existing runner_bin internals), `worker/src/runtime/runner_bin.rs` (refactor to `Box<dyn WindowBackend>`)
- **Risk mitigation**: the current SDL2 code in runner_bin is intertwined with GStreamer capture via the SDL window handle. The refactor has to cleanly separate the X11 window ID (exposed via WindowHandle) from everything else (kept private in the backend). Extract in two commits: first pull all SDL2 code into the backend without moving capture, then move capture to consume `x11_window_id`.

#### 10b-e. Backend implementations via runtime `dlopen` (~2 days each for GLFW/raylib/SFML, ~3-4 days for sokol)

**Dependency strategy — `dlopen` at runtime, not cargo deps**:

Rev2 review caught a significant issue: adding `glfw-sys`, `raylib-sys`, `sfml-sys`, and `sokol-app` as cargo dependencies bloats the worker build (raylib-sys compiles raylib from source — ~5-10 minutes) and adds hundreds of MB to the container image. For a deployment environment with many worker instances, that's unacceptable.

**Fix**: don't link any of these libraries into the worker binary. Use `libloading` to `dlopen` the library at runtime when a backend is actually requested. The runner-side deployment environment must have the library installed (`libglfw3-dev`, `libraylib-dev`, `libsfml-dev`, `libsokol-app-dev` or equivalent); worker startup code checks for availability and logs which backends are usable.

```rust
// worker/src/runtime/backends/glfw_backend.rs
use libloading::{Library, Symbol};

pub struct GLFWBackend {
    lib: Library,                  // keeps .so resident for lifetime of backend
    glfwInit: fn() -> i32,
    glfwCreateWindow: unsafe fn(i32, i32, *const i8, *mut (), *mut ()) -> *mut (),
    glfwMakeContextCurrent: unsafe fn(*mut ()),
    glfwSwapBuffers: unsafe fn(*mut ()),
    glfwPollEvents: unsafe fn(),
    glfwWindowShouldClose: unsafe fn(*mut ()) -> i32,
    glfwGetX11Window: unsafe fn(*mut ()) -> u64,  // from glfw3native.h via dlsym
    // ... etc
    window: *mut (),
}

impl GLFWBackend {
    pub fn try_new() -> anyhow::Result<Self> {
        // Library detection: try standard names in order
        let lib = unsafe {
            Library::new("libglfw.so.3")
                .or_else(|_| Library::new("libglfw.so"))
                .or_else(|_| Library::new("libglfw3.so"))?
        };
        // Resolve symbols
        let glfwInit = unsafe {
            *lib.get::<fn() -> i32>(b"glfwInit\0")?
        };
        // ... etc
        Ok(Self { lib, glfwInit, /* ... */ window: std::ptr::null_mut() })
    }
}
```

**Benefits**:
- Worker binary is small (no statically linked library code)
- Container image size is user's choice — install only the backends the deployment actually serves
- New backends can be added without rebuilding the worker (drop in a new backend .so and a manifest pointing at it — future work)
- Backend library version differences don't break ABI — each deployment picks its own

**Per-backend implementation** (details abbreviated, the shape is the same for all):

- **10b. GLFW** (~2 days): `glfwInit`, `glfwCreateWindow`, `glfwMakeContextCurrent`, `glfwPollEvents`, `glfwSwapBuffers`, `glfwWindowShouldClose`, `glfwGetX11Window`. Clean mapping to the trait. X11 window ID via `glfwGetX11Window`.

- **10c. raylib** (~2 days): `InitWindow`, `CloseWindow`, `BeginDrawing`, `EndDrawing`, `WindowShouldClose`, `PollInputEvents`, `GetWindowHandle` → cast to `GLFWwindow*` → `glfwGetX11Window`. raylib uses GLFW internally on Linux so we can reuse the GLFW X11-window extraction.

- **10d. sokol** (~3-4 days — revised up from 1d per rev2): header-only, no `.so` to dlopen. Instead, we compile a small shim `libsynthi_sokol_shim.so` at worker build time that wraps sokol_app in a thread-based driver and exposes a stable ABI for the backend to call. sokol's `sapp_run` still takes over its thread, but the shim owns that thread and the backend communicates via a command channel. Error budget: 3-4 days because the thread/channel design has timing edge cases around frame boundaries that are easy to get wrong.

- **10e. SFML** (~2 days): C++ ABI instead of C ABI (need `extern "C"` wrapper in a small `libsynthi_sfml_shim.so`). `sf::RenderWindow::pollEvent`, `clear`, `draw`, `display`, `close`. The shim provides `synthi_sfml_create_window`, etc.

**Per-backend test**: `worker/tests/phase10_backend_<name>_smoke.rs` — spawn the backend in-process (skipped if the library isn't installed on the test host), create a window, pump one frame, shut down. Skip with a clear message when `libloading::Library::new` fails.

#### 10f. Manifest-driven backend selection (~1 day — revised from 0.5)

Rev2 review flagged that substring-scanning linker flags is fragile (`-lglfw3` vs `-lglfw` vs `/usr/local/lib/libglfw.so.3`, sokol has no flag). Use a layered approach:

```rust
fn select_backend(manifest: &CompileManifest, arch_cache: &str) -> Box<dyn WindowBackend> {
    // Layer 1 (PREFERRED): parse the arch cache's `## Language & Framework`
    // line. The AI writes this as free-form text at split time, e.g.
    // "C++ with GLFW + OpenGL". Pattern-match against a small, curated
    // set of known library names.
    if let Some(framework) = extract_framework_name(arch_cache) {
        match framework.to_lowercase().as_str() {
            s if s.contains("sdl") => return try_backend(SDL2Backend::try_new()),
            s if s.contains("glfw") => return try_backend(GLFWBackend::try_new()),
            s if s.contains("raylib") => return try_backend(RaylibBackend::try_new()),
            s if s.contains("sokol") => return try_backend(SokolBackend::try_new()),
            s if s.contains("sfml") => return try_backend(SFMLBackend::try_new()),
            _ => {}
        }
    }

    // Layer 2 (FALLBACK): scan link flags for library substrings. Less
    // reliable but catches projects without a Language & Framework header.
    for flag in &manifest.runner_link_flags {
        let f = flag.to_lowercase();
        if f.contains("sdl") { return try_backend(SDL2Backend::try_new()); }
        if f.contains("glfw") { return try_backend(GLFWBackend::try_new()); }
        if f.contains("raylib") { return try_backend(RaylibBackend::try_new()); }
        if f.contains("sfml") { return try_backend(SFMLBackend::try_new()); }
    }

    // Layer 3 (FINAL FALLBACK): Path C. For unknown libraries, defer
    // the runtime to the AI-synthesized host_runner via Phase 12's
    // supervisor model.
    Box::new(PathCBackend::new_from_manifest(manifest))
}

fn try_backend<B: WindowBackend + 'static>(result: anyhow::Result<B>) -> Box<dyn WindowBackend> {
    match result {
        Ok(b) => Box::new(b),
        Err(e) => {
            eprintln!("[Runner] backend load failed: {e} — falling through to Path C");
            Box::new(PathCBackend::new_fallback())
        }
    }
}

fn extract_framework_name(arch_cache: &str) -> Option<String> {
    let re = regex::Regex::new(r"(?m)^##\s*Language\s*&\s*Framework\s*\n([\s\S]*?)(?=\n##|\z)").ok()?;
    let cap = re.captures(arch_cache)?;
    Some(cap.get(1)?.as_str().trim().to_string())
}
```

**Rationale for layering**: the arch cache's framework string is AI-authored at split time and is more reliable than linker flags (which are manifest-authored and subject to drift). Linker flags are the backup when the arch cache doesn't have a framework header. Path C is the ultimate fallback.

- **Files**: `worker/src/runtime/backends/selector.rs` (new), `worker/src/runtime/runner_bin.rs` (call site)
- **Test**: table-driven test with sample arch cache markdowns for each library + fallback cases

### 5.3 Files touched

**New**:
- `worker/src/runtime/window_backend.rs`
- `worker/src/runtime/backends/mod.rs`
- `worker/src/runtime/backends/sdl2_backend.rs`
- `worker/src/runtime/backends/glfw_backend.rs`
- `worker/src/runtime/backends/raylib_backend.rs`
- `worker/src/runtime/backends/sokol_backend.rs`
- `worker/src/runtime/backends/sfml_backend.rs`
- `worker/src/runtime/backends/fallback_backend.rs` (stub that errors out — Path C replaces it in Phase 12)

**Modified**:
- `worker/src/runtime/runner_bin.rs` — replace hardcoded SDL2 with trait dispatch
- `worker/Cargo.toml` — new FFI dependencies (glfw-sys, raylib-sys, sfml-sys, sokol)
- `.github/workflows/universal-split-test.yml` — extend corpus CI to exercise each backend at runtime

### 5.4 Risks

- **Backend-specific quirks**: each library has its own init order assumptions (e.g. SDL2 needs SDL_INIT_VIDEO BEFORE window creation; GLFW wants version hints BEFORE create; raylib couples init and create). Documented per-backend.
- **Event normalization loss**: some events don't map cleanly across libraries (e.g. SDL2's SDL_TEXTEDITING vs GLFW's char callback). Use `BackendEvent::Raw` for lossless forwarding.
- **GStreamer capture**: needs a window handle exposed in a known format. All backends must expose the X11 window via `handle.raw_ptr`. Verify per-backend.
- **Dlopen conflicts**: if two backends are linked statically, their symbol tables can conflict. Use `dlopen` with `RTLD_LOCAL` to isolate.
- **Binary size bloat**: linking 5 libraries statically bloats `runner_bin`. Mitigation: dlopen each backend library on demand. Only the selected backend gets loaded at runtime.

### 5.5 Success criteria

- Phase 7 corpus runs end-to-end (not just build-time) for SDL2, GLFW, raylib, sokol, SFML
- HMR latency for each backend within 10% of SDL2 baseline (same fast path, same floor)
- No regression on existing SDL2 projects
- Dynamic dlopen load: only the selected backend library gets loaded per runner process

---

## 6. Phase 11 — Binary Patching for Value Edits

### 6.1 Intent

Skip g++ entirely for value-only edits that are layout-stable. Patch the compiled `.so` bytes in place, signal the runner to read the new value on the next frame. Target: ~25ms runner-internal, ~70ms user-visible (video tax dominates).

Rev2 honesty reframe: this phase has the most correctness hazards of any in the plan. The rev1 design had several latent bugs (circular integrity check, unacknowledged ASLR, hand-waved value-only classification, no `-O0` enforcement). Rev2 fixes each of these with explicit mitigations.

**Phase 11 depends on Phase 10 for any non-SDL2 benefit.** Pre-Phase 10, Tier 0 only helps SDL2 users at runtime. Rev1 recommended 9→11→10→12; rev2 recommends 9→10→11→12 specifically because of this dependency.

**"~60% of real-world edits are value tweaks"** was an unsupported claim in rev1. Removed. The rev2 justification is softer: value tweaks are A material fraction of edits (likely 30-50% based on anecdotal observation; we don't have production metrics yet). Phase 11 has high ROI on value tweaks and zero regression on other edits. Post-11g instrumentation will tell us whether to push further into this space.

### 6.2 Design

#### 11a. DWARF-driven literal location with ASLR handling (~4-5 days — revised up from 3-4)

The `.so` files are compiled with `-gdwarf-4 -O0`. DWARF debug info maps source lines to binary offsets. Use `gimli` (the standard Rust DWARF parser).

```rust
// worker/src/hmr/binary_patch/dwarf_lookup.rs

pub struct LiteralLocation {
    pub so_path: PathBuf,
    /// Offset within the .so file (file offset, not memory offset).
    /// Must be translated to a runtime memory address at patch time
    /// via the runner's base load address (l_addr from dl_iterate_phdr).
    pub file_offset: u64,
    /// Which ELF section contains this literal (.rodata, .data.rel.ro, etc.)
    pub section_name: &'static str,
    /// Size of the literal in bytes at the file offset.
    pub size: usize,
    /// The bytes currently at file_offset (captured at lookup time,
    /// used for the integrity check's original-bytes match).
    pub original_bytes: Vec<u8>,
    /// Human-readable symbol for logging.
    pub symbol_name: Option<String>,
    /// DWARF source-location fingerprint: the (file, line, column)
    /// the DWARF entry claimed this literal lives at. Captured for
    /// the "decl_line stability" check in 11b.
    pub dwarf_decl_line: u32,
    pub dwarf_decl_file: String,
}
```

**ASLR / PIE handling (rev2 review point #6)**:

`.so` files are position-independent (`-fPIC`), so the runner loads them at a randomized base address. DWARF offsets are file offsets relative to the ELF base, not runtime virtual addresses. At patch time, we must translate:

```
runtime_addr = base_load_addr + file_offset - section_file_offset + section_virtual_addr
             = l_addr + file_offset - p_offset + p_vaddr
```

where `l_addr` comes from `dl_iterate_phdr` inside the runner process.

**Explicit test case**: spawn the runner with `setarch -R` to disable ASLR, patch a literal, verify correctness; spawn again WITHOUT `setarch` so the runner gets a randomized load address, patch the SAME literal, verify correctness. The test catches any off-by-`l_addr` bugs.

**Constant pooling / string interning mitigation (rev2 review point #7)**:

GCC and clang deduplicate identical literals at the `.rodata` level. Two separate source lines with `int target_fps = 60;` may share one 4-byte entry in `.rodata`. Patching that entry patches both variables, which is almost never what the user intended.

Two mitigations, in order of preference:

1. **Compile with `-fno-merge-constants`** (added to manifest's `common_flags` for Tier-0-eligible projects). Costs a few KB of extra `.rodata` per project — negligible. Catches the pooling problem at the source.

2. **If `-fno-merge-constants` isn't set** (backward compat with older sidecars): during DWARF indexing, build a reverse map `file_offset → Vec<decl_site>`. If the offset we're about to patch is referenced by more than one decl site, FALL BACK (Tier 0 miss, compile path takes over). Never patch a shared literal.

The reverse map is cheap (~1 pass over `.debug_info` during index build) and absolutely has to be there — the alternative is silent corruption where tweaking one FPS counter also tweaks the frame budget.

**Optimizer enforcement (rev2 review point #9)**:

The manifest validator (Phase 4.5 `validate_manifest_v1`) gains a new check: if the manifest is being used for Tier 0 eligibility, `common_flags` must contain `-O0` and must NOT contain `-O1`, `-O2`, `-O3`, `-Os`, `-Ofast`. Projects with higher optimization levels are still compilable (Tier 0 is opt-in per project), but Tier 0 is refused for them — fall through to compile path. A log line explains why.

```python
# ai-backend/ai-engine/build_manifest.py

TIER_0_REQUIRED_FLAGS = ["-O0"]
TIER_0_FORBIDDEN_FLAGS = ["-O1", "-O2", "-O3", "-Os", "-Ofast"]
TIER_0_RECOMMENDED_FLAGS = ["-fno-merge-constants", "-gdwarf-4", "-g"]

def is_tier_0_eligible(manifest: BuildManifest) -> Tuple[bool, str]:
    flags = manifest.common_flags
    for req in TIER_0_REQUIRED_FLAGS:
        if req not in flags:
            return False, f"Tier 0 requires {req}"
    for forbidden in TIER_0_FORBIDDEN_FLAGS:
        if forbidden in flags:
            return False, f"Tier 0 incompatible with {forbidden}"
    return True, ""
```

The AI is taught (universal split prompt update) to emit the recommended flags for Tier 0 projects. Phase 4.5 validator checks and falls back gracefully.

**Edge cases**:
- **Constant folded into an `imm32` instruction**: at `-O0 -fno-merge-constants`, the compiler still emits immediate operands for simple constants. The DWARF entry points at the instruction, not at `.rodata`. Handle via an `InstructionImmediate` variant of `LiteralLocation` — patching modifies the instruction bytes, which requires the same mprotect dance but with stricter alignment rules (can't straddle instruction boundaries). This is tractable but adds ~1 day of design work to 11a. Budget adjusted accordingly.
- **Float literals**: at `-O0`, floats usually go to `.rodata` via `movss`/`movsd`. Same treatment as integers.
- **String literals**: fit-in-place only. New string strictly shorter AND old null terminator still at position `new_len`. Longer → fall back.
- **Enum values**: if the user changes `enum Color { RED = 0xFF0000 };` to `RED = 0xFF00FF`, the literal is in `.rodata` as a constant initializer. Same path as integer literal.
- **`constexpr`**: forced into `.rodata`. Handle same as regular const.

- **Files**: `worker/src/hmr/binary_patch/dwarf_lookup.rs`, `worker/src/hmr/binary_patch/aslr.rs`, `worker/src/hmr/binary_patch/constant_pool_map.rs`
- **Dependencies**: `gimli = "0.28"`, `object = "0.32"` (for ELF parsing — we need section tables)
- **Test**: five fixtures (int, float, string, enum, constexpr) with known file offsets. For each: DWARF lookup correctness, ASLR-enabled patch correctness, pooled-literal fallback correctness

#### 11b. Three-layer integrity check (~2 days — revised from 1-2)

The rev1 design's integrity check was circular: it used DWARF to find the bytes it was about to patch and compared them against the "expected old value" that also came from DWARF. If DWARF pointed at the wrong offset, the check would pass whenever the wrong offset happened to contain a plausible integer.

**Rev2 three-layer check**:

```rust
pub enum IntegrityResult {
    Pass,
    FailSourceDrift,           // original_source in sidecar doesn't match old source
    FailLiteralBytesMismatch,  // bytes at file_offset don't match what we think they should
    FailDwarfDeclDrift,        // DWARF decl_line no longer matches the current source
    FailPoolConflict,          // more than one decl site references this offset
}

pub fn verify_patch_target(
    so_path: &Path,
    dwarf_loc: &LiteralLocation,
    old_source: &str,   // from sidecar's original_source field
    new_source: &str,   // from the edit
    edit_line: u32,
) -> IntegrityResult {
    // LAYER 1: source content hash — did the file on disk match the
    // `original_source` the sidecar captured at split time? If not,
    // another process modified the source between split and patch.
    let disk_source_hash = hash(read_source_from_disk(so_path_source)?);
    let sidecar_source_hash = hash(old_source);
    if disk_source_hash != sidecar_source_hash {
        return IntegrityResult::FailSourceDrift;
    }

    // LAYER 2: literal bytes match — read the bytes AT FILE OFFSET
    // from the .so and compare against the "original_bytes" captured
    // during DWARF indexing. If they don't match, the .so was
    // recompiled without us knowing, or DWARF lied about the offset.
    let current_bytes = read_bytes_at_offset(so_path, dwarf_loc.file_offset, dwarf_loc.size)?;
    if current_bytes != dwarf_loc.original_bytes {
        return IntegrityResult::FailLiteralBytesMismatch;
    }

    // LAYER 3: DWARF decl_line stability — re-parse the current source
    // with Tree-sitter, find the AST node at (edit_file, edit_line),
    // confirm that its declaration line still matches the DWARF entry's
    // decl_line. If not, the user added/removed lines above the patch
    // target and the DWARF offset may have moved.
    let ast_node = tree_sitter_find_literal_at(new_source, edit_line)?;
    if ast_node.decl_line != dwarf_loc.dwarf_decl_line {
        return IntegrityResult::FailDwarfDeclDrift;
    }

    // LAYER 4: constant pool conflict check — is this offset referenced
    // by any other decl site? (From 11a's constant_pool_map.rs)
    if constant_pool_map.get(dwarf_loc.file_offset).map(|v| v.len()).unwrap_or(0) > 1 {
        return IntegrityResult::FailPoolConflict;
    }

    IntegrityResult::Pass
}
```

Each layer catches a different failure mode. All four must pass. Any fails → Tier 0 rejects the edit, falls through to Tier 1.

**Layer 1** (source drift) is the most important: it catches the "another process modified the file" race. Tier 0 cannot safely operate on a `.so` whose source has drifted from what the sidecar recorded.

**Layer 3** (decl_line stability) is the rev2 fix for the circular-check problem. It does NOT use DWARF to verify DWARF — it uses Tree-sitter parsing of the current source to independently confirm that the DWARF decl_line is still where the literal lives. If the user added 5 lines above the literal, DWARF still points at the old line, but Tree-sitter will find the literal at new_line = dwarf_decl_line + 5, catch the mismatch, and reject.

- **Files**: `worker/src/hmr/binary_patch/integrity.rs`
- **Dependencies**: `tree-sitter = "0.20"`, `tree-sitter-cpp = "0.20"`
- **Test**: eight scenarios — (pass), (source drift), (bytes mismatch), (decl_line drift), (pool conflict), (combined failures)

#### 11c. AST-ish value-only classification via Tree-sitter (~2 days — NEW, not in rev1)

Rev1 hand-waved "classify_edit → is_value_only? (~1ms)". Rev2 review caught this. The rev1 classifier is the existing `classify_edit` in `hmr/edit_classifier.rs`, which does regex matching on lines — it can't tell `const int WIDTH = 800` (value) from `const int WIDTH = getWidth()` (structural).

Tree-sitter-based classifier:

```rust
// worker/src/hmr/binary_patch/value_only_classifier.rs

pub enum EditClassification {
    ValueOnly {
        edit_kind: ValueEditKind,
        decl_site: SourceLocation,
        old_literal_token: Token,
        new_literal_token: Token,
    },
    Structural,
    Ambiguous,  // could be value-only but we can't prove it — fall back
}

pub enum ValueEditKind {
    IntLiteral,
    FloatLiteral,
    BoolLiteral,
    StringLiteral,
    EnumValue,
    CharLiteral,
}

pub fn classify_for_tier_zero(
    old_source: &str,
    new_source: &str,
) -> EditClassification {
    // 1. Parse old and new source with tree-sitter-cpp
    let old_tree = parse_cpp(old_source);
    let new_tree = parse_cpp(new_source);

    // 2. Diff the AST node-by-node via tree-sitter's edit-aware parsing
    let diff = ast_diff(&old_tree, &new_tree);

    // 3. Accept if and only if:
    //    - Exactly ONE AST node changed
    //    - The changed node is a literal (IntLiteral, FloatLiteral, ...)
    //    - The new node has the same TYPE as the old (int stays int, etc.)
    //    - Parent context is unchanged (same declaration, same scope)
    match diff.as_slice() {
        [DiffNode::Replaced { old, new }] if is_literal_of_same_kind(old, new) => {
            EditClassification::ValueOnly { /* ... */ }
        }
        _ => EditClassification::Structural,
    }
}
```

This is what lets Tier 0 safely distinguish:
- `const int WIDTH = 800;` → `const int WIDTH = 1024;` — value-only ✓
- `const int WIDTH = 800;` → `const int WIDTH = 1024 * 2;` — structural ✗ (RHS is now an expression, not a literal)
- `int x = 5;` → `long x = 5;` — structural ✗ (type changed)
- `int x = 5;` → `int x = 50000;` — value-only ✓ (both fit in int)
- `int x = 5;` → `int x = 5000000000;` — structural ✗ (overflows int, layout changes)

**Cost**: ~2-5ms to parse a small source file, cached between edits via tree-sitter's incremental parsing. Not in the critical path after the first edit per session.

- **Files**: `worker/src/hmr/binary_patch/value_only_classifier.rs`, `Cargo.toml` (tree-sitter deps)
- **Test**: scenario corpus covering all ValueEditKind variants + structural negatives

#### 11d. Runtime memory patching (~3 days — revised from 2-3)

Architecture: a small helper library `libsynthi_patcher.so` that the runner dlopens at startup. Exposes:

```c
// libsynthi_patcher.h
int synthi_patch_bytes(void* addr, const void* new_bytes, size_t size);
int synthi_invalidate_icache(void* addr, size_t size);
int synthi_read_bytes(void* addr, void* out, size_t size);
```

Implementation uses `mprotect(PROT_WRITE)` → `memcpy` → `mprotect(PROT_READ|PROT_EXEC)` → `__builtin___clear_cache`.

**ASLR math** (rev2 review point #6, now explicit): the runner translates file offsets to runtime addresses via `dl_iterate_phdr`:

```c
// Inside libsynthi_patcher.c
typedef struct {
    const char* so_name;
    void* found_base;
} find_base_ctx;

static int find_base_cb(struct dl_phdr_info* info, size_t size, void* data) {
    find_base_ctx* ctx = (find_base_ctx*)data;
    if (strstr(info->dlpi_name, ctx->so_name) != NULL) {
        ctx->found_base = (void*)info->dlpi_addr;  // l_addr
        return 1;  // stop iteration
    }
    return 0;
}

void* synthi_resolve_file_offset(const char* so_name, size_t file_offset) {
    find_base_ctx ctx = { so_name, NULL };
    dl_iterate_phdr(find_base_cb, &ctx);
    if (!ctx.found_base) return NULL;
    return (void*)((char*)ctx.found_base + file_offset);
}
```

**Page alignment**: `mprotect` requires addresses rounded down to `PAGE_SIZE` (via `sysconf(_SC_PAGESIZE)`). The patch span may cross a page boundary — handle by protecting a range that covers both pages.

**Panic safety**: if the patch interrupts before `mprotect(PROT_READ|PROT_EXEC)` restores, the page stays writable — a security regression (though the process is already trusted). Wrap the write in a scope that restores on any path:

```c
int synthi_patch_bytes(void* addr, const void* new_bytes, size_t size) {
    void* page = (void*)((uintptr_t)addr & ~(PAGE_SIZE - 1));
    size_t protect_len = page_span(addr, size);
    if (mprotect(page, protect_len, PROT_READ | PROT_WRITE) != 0) return -errno;

    int result = 0;
    memcpy(addr, new_bytes, size);
    __builtin___clear_cache(addr, (char*)addr + size);

    // ALWAYS restore — no early returns between mprotect and this line
    if (mprotect(page, protect_len, PROT_READ | PROT_EXEC) != 0) {
        // Failing to restore is catastrophic; log and abort the runner
        // so a watchdog can respawn it in a clean state.
        fprintf(stderr, "FATAL: synthi_patch_bytes restore mprotect failed: %s\n", strerror(errno));
        abort();
    }
    return result;
}
```

The Rust worker sends a patch command over the existing stdin HMR protocol. Runner dispatches to the helper library.

- **Files**: `worker/src/runtime/patcher/libsynthi_patcher.c`, `worker/src/runtime/patcher/build.rs` (compile during cargo build), runner_bin.rs (handle `patch` command)
- **Test**: integration test spawns a runner with a small .so, patches a known literal, verifies the bytes via `synthi_read_bytes`; negative test with invalid offset must return error, not crash

#### 11e. Frame-sync coherency (~1 day)

Unchanged from rev1. Runner picks up the patched value on the next frame boundary. Patch command acks when the write is visible.

- **Files**: runner_bin.rs protocol handler, ai_utils.rs worker dispatch

#### 11f. Tier 0 integration in handler.rs (~2 days — revised from 1)

New tier above the existing Tier 1/2/3:

```
Tier 0 (Phase 11, NEW):
  check tier_0_eligible (manifest flags) → false → Tier 1
  classify_for_tier_zero (Tree-sitter)   → !ValueOnly → Tier 1
  verify_patch_target (4-layer integrity) → !Pass → Tier 1
  patch_runtime_memory                   → err → Tier 1
  done (~25-46ms runner-internal)
Tier 1: text patch + compile
Tier 2: AI diff_patch + compile
Tier 3: full AI re-split + compile
```

All failure paths silently fall through to Tier 1. User never sees a Tier 0 error — just gets slower HMR on fallback.

**Observability**: metrics counter per-tier (attempted, succeeded, fell-through-with-reason). Hit rate per reason is checked-in and tracked per release.

- **Files**: `worker/src/compiler/handler.rs` (Tier 0 block)
- **Rollout**: feature flag `SYNTHI_TIER_ZERO_ENABLED` per session. Default off until 11g shows green metrics over 1+ week.

#### 11g. Tests + benchmarks (~2-3 days — revised up from 1-2)

Unit:
- DWARF literal lookup on test `.so` files (the fixtures from 11a)
- ASLR math (PIE load → patch → verify)
- Four-layer integrity checks (Pass + 4 failure modes + combinations)
- Tree-sitter value-only classifier (ValueEditKind × ambiguous × structural)
- Layout stability (int within range, out of range, string fit, string overflow, type size change)
- Constant pool conflict detection

Integration:
- Force-Tier-0 value edit on a minimal SDL2 project. Assert the patch hits the right bytes by diffing old vs new `.so` AFTER the runner reads the patched value (which validates the runtime address math).
- Force-fallback integration: edit that triggers each failure mode, verify Tier 1 takes over and the end result is correct.

Fuzz (rev2 review point #31 — defined corpus, not "random"):
- **Literal kinds** × **source positions** × **compiler versions** × **optimization levels** = a matrix. For each combination: generate a program with a known literal in known position, compile, parse DWARF, patch, verify.
- **Literal kinds**: int8, int16, int32, int64, float, double, C string, bool, enum, constexpr
- **Source positions**: top-of-file const, function-local const, struct-initializer, template instantiation, lambda capture
- **Compiler versions**: g++-11, g++-12, g++-13, clang-14, clang-15, clang-16 (test against the compilers the deployment env targets; more if the support matrix grows)
- **Optimization levels**: `-O0 -fno-merge-constants` (supported), `-O0` (supported with pool fallback), `-O1`/`-O2`/`-O3` (rejected)
- **Total corpus size**: ~200 scenarios. Run on every PR touching 11a-11e.

Benchmark (in 9f's Harness B):
- `bench_e2e_tier0_value_edit_sdl2` — runner-internal p50 must be ≤30ms; user-visible p50 must be ≤80ms
- `bench_tier0_fallback_path` — intentional fallback (e.g. pool conflict), verify end-to-end Tier 1 latency is unchanged from baseline

- **Files**: `worker/tests/phase11_binary_patch.rs`, `worker/tests/phase11_fuzz.rs` (new), `benchmarks/e2e_hmr_latency.rs` (extended)

### 6.3 Files touched

**New**:
- `worker/src/hmr/binary_patch/mod.rs`
- `worker/src/hmr/binary_patch/dwarf_lookup.rs`
- `worker/src/hmr/binary_patch/layout.rs`
- `worker/src/hmr/binary_patch/patch_dispatch.rs`
- `worker/src/runtime/patcher/libsynthi_patcher.c`
- `worker/tests/phase11_binary_patch.rs`

**Modified**:
- `worker/src/compiler/handler.rs` (new Tier 0)
- `worker/src/runtime/runner_bin.rs` (patch command handler)
- `worker/Cargo.toml` (gimli dependency)

### 6.4 Risks (revised)

| Risk | Mitigation |
|---|---|
| DWARF variance across gcc/clang versions | Test matrix in 11g fuzz corpus covers both; gimli high-level API handles both |
| Compiler optimizations break literal locatability | `-O0` enforcement in manifest validator; projects opt out with higher `-O` and get Tier 1 transparently |
| Constant pooling aliases two source lines to one `.rodata` entry | `-fno-merge-constants` in `common_flags` preferred; constant pool map fallback for legacy sidecars |
| ASLR / PIE load addresses mismatch file offsets | `dl_iterate_phdr` + `l_addr` math, explicit test case with and without `setarch -R` |
| Circular integrity check (check derived from same source as patch) | Four-layer integrity check: source content hash + literal bytes + Tree-sitter decl_line + pool conflict |
| Value-only classification wrong (regex too lax or too strict) | Tree-sitter-cpp diff; only accepts single literal replacement with same type |
| Architecture portability (ARM64 icache coherency) | x86_64 first; ARM64 requires `dsb ish; isb` in helper, which `__builtin___clear_cache` provides via compiler intrinsic |
| mprotect restore fails, leaving writable pages | Abort-on-fail in helper; watchdog respawns runner |
| Concurrent read of `.rodata` by user code during patch | Frame-sync coherency holds the next frame ~1ms until patch completes |
| Tier 0 hit rate lower than expected | Metrics instrumentation in 11f; if <40% after rollout, reconsider Phase 11's ROI |
| Phase 11 only benefits SDL2 pre-Phase-10 | Documented sequencing dependency; rev2 recommends 9→10→11→12 |

### 6.5 Success criteria (revised)

- **Tier 0 eligible rate** (value edits on Tier-0-opted-in projects at `-O0 -fno-merge-constants`) ≥60% of value-only edits. If lower, constant pooling is winning more than expected; add fallback diagnostics.
- **Tier 0 latency on success**: runner-internal p50 ≤30ms, user-visible p50 ≤80ms (measured by Harness B, not asserted out of thin air)
- **Fallback correctness**: fuzz corpus passes end-to-end (edit applies, final `.so` state is identical to what a full compile would have produced, NO discrepancy)
- **Zero silent corruption**: 1000-edit fuzz run, byte-for-byte compare of post-patch `.so` against ground-truth-compiled `.so` for each edit. Any mismatch fails the fuzz test and blocks the release.
- **Phase 11 only applies where Phase 10 backends exist**: Tier 0 is disabled for Path C backends in v1 (can be enabled later)

---

## 7. Phase 12 — Path C: Supervisor + Child Process

### 7.1 Intent (revised — honest about scope)

Rev2 reframes the rev1 "zero-day libraries" claim. Phase 12 does NOT handle "any library the AI can compile" — that was overstated. It handles:

1. **Libraries the AI has training-set knowledge of but we don't have a Path A backend for** — e.g. Qt (minus MOC which Phase 3 rejects), JUCE (minus the macro entry-point cases Phase 4 rejects), possibly bgfx, Dear ImGui with a custom backend, nanogui, etc. The AI knows these well enough to write a plausible `host_runner.cpp` that passes the Phase 4 runner_synthesis confidence gate (`>= medium`).
2. **BYOR projects** — user authored `host_runner.cpp` starts with `// SYNTHI_USER_RUNNER`. The user's runner is trusted to do the right thing; Phase 12 spawns it, captures its window via Xvfb, and drives HMR via the IPC protocol.

Phase 12 does NOT handle:
- Libraries the AI has never seen (pure zero-day). Phase 4's `runner_synthesis == "low"` gate still rejects these.
- Libraries that don't render to an X11-backed window (EGL surfaceless, direct Wayland, DRI3 without X11, etc.). See §7.4.
- Libraries with macro-hidden entry points that Phase 3/4 can't untangle.

**Reframe**: Phase 12 extends the library coverage from Phase 10's N backends to N + (what the AI can confidently host in a synthesized runner). It's still bounded by the AI's ability + the X11 window assumption. "Zero-day" was aspirational marketing and has been removed.

### 7.2 Design

#### 12a. Process architecture (~2 days)

```
┌─────────────────────────────────────┐
│ runner_bin (supervisor)             │
│  ├─ spawns Xvfb on :100             │
│  ├─ spawns host_runner_<ts>         │◄─────┐
│  │    (child, DISPLAY=:100)         │      │ IPC: Unix socket
│  ├─ GStreamer captures :100         │      │      /tmp/synthi_hmr.sock
│  └─ HMR protocol ───────────────────┘      │
└─────────────────────────────────────┘      │
                ▲                            │
                │ stdin "reload X Y"         │
                │                            ▼
         Rust worker                  child process
                                      (user's code)
```

- Supervisor allocates a fresh X display (via `Xvfb-run` or direct `Xvfb :NNN -screen 0 1280x720x24`).
- Spawns `host_runner_<timestamp>` with `DISPLAY=:NNN` and `SYNTHI_HMR_SOCKET=/tmp/synthi_hmr_<session>.sock`.
- GStreamer capture uses `ximagesrc display-name=:NNN` — works for any X11 client, doesn't care whether it's SDL/GLFW/Qt.
- Child process discovers the HMR socket via env var, connects, waits for commands.

- **Files**: `worker/src/runtime/path_c/supervisor.rs`, `worker/src/runtime/path_c/xvfb.rs`.

#### 12b. HMR protocol over IPC — with versioning and signal ownership (~3-4 days — revised from 2-3)

**Protocol versioning (rev2 review point #10)**: `libsynthi_hmr_runtime.a` is linked into user binaries that may outlive the protocol definition. If the protocol evolves (new commands, changed field names), a new supervisor speaking v2 must not crash a child process linked against v1.

```rust
// worker/src/runtime/path_c/hmr_protocol.rs

pub const PROTOCOL_VERSION_CURRENT: u8 = 1;
pub const PROTOCOL_VERSION_MIN_SUPPORTED: u8 = 1;

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HmrCommand {
    /// Handshake — sent FIRST, always. Contains the supervisor's
    /// current version and its list of supported commands. Child
    /// replies with its own version and capabilities; supervisor
    /// downgrades to the intersection.
    Handshake {
        supervisor_version: u8,
        supervisor_min_supported: u8,
        supervisor_capabilities: Vec<String>,
    },
    Load { command_id: u64, module_name: String, so_path: String },
    Unload { command_id: u64, module_name: String },
    Reload { command_id: u64, module_name: String, so_path: String },
    /// Phase 11 integration — only valid if both sides advertise
    /// "binary_patch" in capabilities.
    PatchBytes {
        command_id: u64,
        module_name: String,
        file_offset: u64,
        bytes_hex: String,
    },
    Shutdown { command_id: u64 },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HmrResponse {
    HandshakeAck {
        child_version: u8,
        child_min_supported: u8,
        child_capabilities: Vec<String>,
    },
    Ack { command_id: u64 },
    Error { command_id: u64, code: i32, message: String },
}
```

**Version negotiation**: on connect, supervisor sends `Handshake{1, 1, ["load", "unload", "reload", "binary_patch"]}`. Child responds with its own version and capabilities. If the child's version is below `supervisor_min_supported`, supervisor emits a warning and falls back to a command set the child understands (by intersecting capabilities). If even the minimum isn't possible, supervisor kills the child and reports a compatibility error to the frontend.

**Forward compat rules**:
- Adding a new command variant: old children reply with `Error{code=ENOTSUP}`; supervisor can detect and not send.
- Renaming a field: never. Only add fields.
- Removing a field: never before `MIN_SUPPORTED` is bumped.
- `serde_json` ignores unknown fields by default — newer fields landing at an older child are silently dropped, which is the right behavior.

**Signal handler ownership (rev2 review point #27)**:

In Path C, three parties want signal handlers:
- The supervisor (`runner_bin`): wants `SIGCHLD` (child exit), `SIGTERM` (clean shutdown), `SIGINT` (dev convenience)
- The child process (user code + `libsynthi_hmr_runtime`): wants `SIGSEGV` (crash → heal → respawn), `SIGUSR1` (HMR-triggered state snapshot)
- The library the child uses (SDL2/GLFW/raylib/etc.): often installs its own `SIGINT` handler for Ctrl-C; some install `SIGSEGV` handlers for crash reports

**Ownership matrix**:
| Signal | Owner | Notes |
|---|---|---|
| `SIGCHLD` | Supervisor ONLY | Child must not install a handler; libraries rarely do |
| `SIGTERM` | Supervisor, forwarded to child | Graceful shutdown — supervisor kills child, waits, exits |
| `SIGINT` | Supervisor ONLY (ignored in child) | `libsynthi_hmr_runtime` calls `signal(SIGINT, SIG_IGN)` during init to block library override |
| `SIGSEGV` | Child ONLY | `libsynthi_hmr_runtime` sets up a handler that writes a crash dump and exits; supervisor sees SIGCHLD and respawns |
| `SIGUSR1` | Child ONLY | Used for on-demand state snapshots (future HMR feature) |
| `SIGPIPE` | Child ONLY | `libsynthi_hmr_runtime` ignores it so socket disconnects don't kill the process |

`libsynthi_hmr_runtime::synthi_hmr_init()` enforces this matrix by installing all child-side handlers and blocking conflicts via `sigaction` flags. If a user's library has already installed a conflicting handler before `synthi_hmr_init()` runs, the library wins — the docs for BYOR users explicitly say "call `synthi_hmr_init()` BEFORE any library init that might install signal handlers."

- **Files**: `worker/src/runtime/path_c/hmr_protocol.rs`, `worker/src/runtime/patcher/libsynthi_hmr_runtime.c`, `ai-backend/ai-engine/llm/prompts.py` (UNIVERSAL_SPLIT_PROMPT — emit `synthi_hmr_init()` at the VERY TOP of `main()`)

#### 12c. BYOR compatibility + link-time check (~2 days — revised from 1-2)

BYOR projects (detected via `// SYNTHI_USER_RUNNER` sentinel from Phase 4) must link `libsynthi_hmr_runtime.a`. Rev2 review flagged that the rev1 approach relied on a 2-second handshake timeout as the ONLY diagnostic — reactive, not preventive.

**Rev2 addition**: post-compile link-time check. After `compile_runner` produces the runner binary, Phase 12 code runs `nm` on the output to verify the binary references `synthi_hmr_init` and `synthi_hmr_on_frame`:

```rust
// worker/src/compiler/stages/compile_runner.rs (modified for Path C)

fn verify_hmr_runtime_linkage(runner_bin: &Path) -> anyhow::Result<()> {
    let output = Command::new("nm")
        .arg("--dynamic")
        .arg(runner_bin)
        .output()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !stdout.contains("synthi_hmr_init") {
        anyhow::bail!(
            "BYOR runner at {:?} does not reference `synthi_hmr_init`. \
             Your host_runner.cpp must call synthi_hmr_init() — see \
             docs.synthi.dev/byor for details.",
            runner_bin
        );
    }
    if !stdout.contains("synthi_hmr_on_frame") {
        anyhow::bail!(
            "BYOR runner at {:?} does not reference `synthi_hmr_on_frame`. \
             Your host_runner.cpp must call synthi_hmr_on_frame() at the \
             top of each event-loop iteration — see docs.synthi.dev/byor.",
            runner_bin
        );
    }
    Ok(())
}
```

**Better than a runtime timeout**: the check fires immediately after compile, surfaces through the standard compile diagnostics, and tells the user exactly what symbol is missing. No 2-second wait, no mysterious "HMR is disabled" toast.

The handshake timeout stays as a backup for the edge case where the symbol exists but init was never called at runtime (e.g. if the user put `synthi_hmr_init()` inside a `#ifdef` that didn't fire). Error reported to the frontend via the manifest rejection path: `BYOR_NO_HMR_INIT`.

**Non-BYOR projects**: the AI-generated `host_runner.cpp` is updated via the UNIVERSAL_SPLIT_PROMPT to always include the init/on_frame calls at the right points. Phase 1 of this plan adds prompt instructions:

```
When you synthesise host_runner.cpp in Path C mode, you MUST:
  - #include <synthi_hmr_runtime.h>
  - Call synthi_hmr_init() at the very top of main() BEFORE any other init
  - Call synthi_hmr_on_frame() at the top of each event-loop iteration
  - Call synthi_hmr_shutdown() before return from main()
```

Link-time check still runs on AI-generated runners as belt-and-suspenders.

- **Files**: `worker/src/compiler/stages/compile_runner.rs` (link-time check), `ai-backend/ai-engine/llm/prompts.py` (prompt instructions), `synthi/src/components/compile/CompileErrorCard.jsx` (new error kind `BYOR_NO_HMR_INIT`)

#### 12c.1. State marshaling budget fix (rev2 review point #25)

The rev1 plan listed "state marshal across IPC ~20ms" as if user state crossed the Unix socket boundary on every reload. That was wrong. State stays **in-process in the child** — the state bridge, state checkpoint, and state migration infrastructure all live inside the child process and operate on in-process memory just like in Path A.

What actually crosses the socket is: `Reload { command_id, module_name, so_path }` — about 200 bytes. Round-trip: ~3-8ms of IPC overhead, not 20ms of state marshaling.

The §3.5 latency budget has been corrected to reflect this.

#### 12d. Fallback from Path A (~1 day)

At backend selection time (Phase 10 §10f), if no Path A backend matches:

```rust
fn select_backend(manifest: Option<&CompileManifest>) -> Box<dyn WindowBackend> {
    // Try Path A backends first
    if let Some(path_a) = try_path_a_match(manifest) {
        return path_a;
    }
    // Fall through to Path C
    eprintln!("[Runner] No Path A backend matched — using Path C supervisor mode");
    Box::new(PathCBackend::new(manifest))
}
```

`PathCBackend` is a special WindowBackend implementation whose methods are stubs — it delegates window handling to the child process entirely. The supervisor forwards events back to the child via IPC.

- **Files**: `worker/src/runtime/backends/path_c_backend.rs` (new).

#### 12e. Video stream latency audit (~1 day)

Xvfb `ximagesrc` capture has slightly higher latency than direct window-handle capture (~20-40ms added vs Path A). Measure and characterize:

- **Target**: ≤50ms added p50 over Path A
- **Tuning**: pixel format (BGRx), use-damage for incremental capture, buffer pool sizing
- **Fallback**: if latency exceeds 100ms, investigate DRI3/hardware acceleration

- **Files**: `worker/src/runtime/path_c/video_pipeline.rs`, benchmark harness in Phase 9f extended.

### 7.3 Files touched

**New**:
- `worker/src/runtime/path_c/mod.rs`
- `worker/src/runtime/path_c/supervisor.rs`
- `worker/src/runtime/path_c/xvfb.rs`
- `worker/src/runtime/path_c/hmr_protocol.rs`
- `worker/src/runtime/path_c/video_pipeline.rs`
- `worker/src/runtime/backends/path_c_backend.rs`
- `worker/src/runtime/patcher/libsynthi_hmr_runtime.c`
- `worker/tests/phase12_path_c.rs`

**Modified**:
- `worker/src/runtime/runner_bin.rs` (fallback to PathCBackend)
- `ai-backend/ai-engine/llm/prompts.py` (host_runner init/on_frame generation)

### 7.4 Risks and explicit limitations (revised)

**Hard limitations — NOT handled by Path C**:

- **EGL surfaceless rendering**: libraries that render directly to EGL surfaces without X11 windows (some sokol configs, offscreen raylib, DRM/KMS direct rendering). ximagesrc can't see them. Documented as explicit out-of-scope. User-facing error: "This project renders without an X11 window (EGL surfaceless). Synthi's video pipeline requires an X11-backed window. Consider changing the library's backend to X11 or GLX."
- **Wayland-native clients**: same as EGL surfaceless — no X11 window for ximagesrc to capture. Post-V2.
- **AI runner_synthesis confidence = low**: Phase 4's `runner_synthesis_low` gate still rejects these. Path C can't rescue them — if the AI isn't confident in the runner, spawning a potentially-broken runner is worse than surfacing the error.

**Risk table**:
| Risk | Mitigation |
|---|---|
| Xvfb startup overhead (~200-400ms) | Amortized to zero on edits after the first; benchmark measures |
| ximagesrc latency (~20-40ms) | Measured in Phase 9f harness B; tune via use-damage + BGRx pixel format |
| Socket cleanup on crash | `Drop` impl on supervisor removes socket; abstract namespace sockets don't need cleanup at all |
| Child process crash mid-patch | `SIGCHLD` + pidfd detects; supervisor respawns; state is lost per Phase 4 process_restart semantics |
| Protocol version mismatch | Handshake downgrade + capability intersection; clean error if incompatible |
| Signal handler conflicts | Ownership matrix (12b) enforced by `libsynthi_hmr_runtime::init` |
| BYOR user forgets `synthi_hmr_init` | Link-time `nm` check fires immediately after compile with a clear error |
| `libsynthi_hmr_runtime` static lib breaks ABI between supervisor versions | Protocol versioning + handshake negotiation handles this |
| Xvfb display number collision on concurrent sessions | Dynamically allocate display numbers starting at `:100 + session_index` |
| Concurrent Path C sessions exhaust display numbers | Cap at 200 concurrent sessions per worker, LRU-evict oldest on overflow |

### 7.5 Success criteria (revised)

- **Library coverage**: the Phase 7 corpus extended with 3 additional entries — Qt (without MOC, simple Q_OBJECT-free use), bgfx, nanogui — all pass end-to-end via Path C in CI
- **BYOR flow**: a documented BYOR example project with user-authored `host_runner.cpp` + `synthi_hmr_init()` calls completes an edit round-trip in the corpus
- **Path C latency tax**: runner-internal p50 ≤280ms (Path A target + 80ms IPC+capture tax)
- **Path C fallback transparency**: when Path A isn't available, the switch to Path C happens invisibly — user just sees it work, no banner, no confirmation, no delay beyond the first-compile cost
- **Honest "zero-day" scope**: the Phase 12 test suite does NOT include libraries the AI has never seen. If the AI's training data doesn't know a library, we still reject cleanly at Phase 4 runner_synthesis gate.

---

## 8. Files Touched — Full List

### New files (~30)

**Worker (Rust)**:
```
worker/src/compiler/stages/pch.rs
worker/src/runtime/window_backend.rs
worker/src/runtime/backends/mod.rs
worker/src/runtime/backends/sdl2_backend.rs
worker/src/runtime/backends/glfw_backend.rs
worker/src/runtime/backends/raylib_backend.rs
worker/src/runtime/backends/sokol_backend.rs
worker/src/runtime/backends/sfml_backend.rs
worker/src/runtime/backends/fallback_backend.rs
worker/src/runtime/backends/path_c_backend.rs
worker/src/runtime/path_c/mod.rs
worker/src/runtime/path_c/supervisor.rs
worker/src/runtime/path_c/xvfb.rs
worker/src/runtime/path_c/hmr_protocol.rs
worker/src/runtime/path_c/video_pipeline.rs
worker/src/hmr/binary_patch/mod.rs
worker/src/hmr/binary_patch/dwarf_lookup.rs
worker/src/hmr/binary_patch/layout.rs
worker/src/hmr/binary_patch/patch_dispatch.rs
worker/src/runtime/patcher/libsynthi_patcher.c
worker/src/runtime/patcher/libsynthi_hmr_runtime.c
worker/tests/phase9_compile_optimization.rs
worker/tests/phase10_window_backends.rs
worker/tests/phase11_binary_patch.rs
worker/tests/phase12_path_c.rs
benchmarks/hmr_latency.rs
```

**Python (ai-engine)**: no new files — only `llm/prompts.py` modification for Phase 12c.

**Frontend**: no new files in this plan — frontend scaffolding from `HMR_AGNOSTIC_ULTRAPLAN.md` Phase 8 already covers manifest + error card + confidence warning. Phase 12 adds one new `REJECTION_KINDS` value (`BYOR_NO_HMR_INIT`).

### Modified files

- `worker/Cargo.toml` — 6-8 new dependencies (glfw-sys, raylib-sys, sfml-sys, sokol-app, gimli, libc, ...)
- `worker/src/runtime/runner_bin.rs` — trait dispatch refactor
- `worker/src/compiler/handler.rs` — Tier 0 block, parallel compile join
- `worker/src/compiler/stages/compile_core.rs`, `compile_gui.rs`, `compile_runner.rs` — ccache wrap, .o caching, PCH include
- `worker/src/compiler/stages/ai_utils.rs` — PCH generation hook
- `worker/src/hmr/incremental_cache.rs` — .o slot addition
- `ai-backend/ai-engine/llm/prompts.py` — host_runner init/on_frame calls
- `synthi/src/components/compile/CompileErrorCard.jsx` — new rejection kind
- `.github/workflows/universal-split-test.yml` — corpus runtime coverage

---

## 9. Sequencing, critical path, rollout

### 9.1 Recommended order (revised rev2)

Rev2 recommendation: **9 → 10 → 11 → 12**. Rev1 recommended 9 → 11 → 10 → 12.

**Why rev2 reorders 10 before 11**: Phase 11's Tier 0 only benefits libraries with a Path A runtime. Pre-Phase 10, only SDL2 has a Path A runtime. Shipping Phase 11 before Phase 10 means Tier 0 value edits feel magical for SDL2 users but do nothing for GLFW/raylib/sokol/SFML users. That's a bad rollout sequence — we'd brag about magic that most users can't access.

Revised order:

1. **Phase 9** (compile acceleration) — always-on, every edit, every library, every path
2. **Phase 10** (Path A backends) — runtime HMR parity across 5 libraries
3. **Phase 11** (binary patching) — magical UX for value edits, now across 5 libraries at once
4. **Phase 12** (Path C supervisor) — long-tail libraries + BYOR

### 9.2 Dependency graph (rev2 new)

```
┌─────────┐
│ Phase 9 │  compile opt — blocks benchmark harness in 9f
└────┬────┘
     │
     ├─────────────────────┐
     ▼                     ▼
┌──────────┐         ┌──────────┐
│ Phase 10 │◄────────│ Phase 11 │
│ backends │ depends │ binpatch │  Phase 11 needs Phase 10's WindowBackend
└────┬─────┘ on      └────┬─────┘  trait + at least one non-SDL2 backend
     │ trait            │ for non-SDL2 benefit
     │ for 12's         │
     │ PathC backend    │
     ▼                  ▼
┌──────────┐       (continues to next frame)
│ Phase 12 │
│ Path C   │
└──────────┘
```

**Critical path**: 9a (0.5d) → 9b (2d) → 9c (3d) → 9f Harness B (2d — needed for 10 benchmarks) → 10a (2d) → 10b (2d) → 10f (1d) → 11a (5d, includes ASLR + constant pool) → 11b (2d) → 11c (2d) → 11d (3d) → 11e (1d) → 11f (2d) → 11g (3d) → 12a (2d) → 12b (4d) → 12c (2d) → 12d (1d)

**Total critical path length**: ~39 days (≈ 8 weeks) aggressive, with zero parallelism.

**Parallelization opportunities**:
- 9a-9e are independent of Phase 10's trait work. A second engineer could work on 10a-10f while the first drives 9a-9e. Saves ~5 days.
- 10b, 10c, 10d, 10e (the four non-SDL2 backends) are independent of each other once 10a's trait is frozen. Three engineers could take three backends in parallel, saving another ~4 days.
- 12's supervisor + IPC work (12a, 12b) starts after 10a freezes the trait. Can overlap with 10's backend implementations. Saves ~3 days.

**Realistic parallel estimate** (2 engineers): ~6 weeks.
**Realistic parallel estimate** (3 engineers): ~5 weeks.
**Single-engineer realistic**: 10-14 weeks including testing, fuzz corpus, benchmarking, rollout.

Rev1's "5-7 weeks" number was over-optimistic. Rev2 is 8-16 weeks depending on team size.

### 9.3 Alternative order (coverage-first)

If "run any library" matters more than "feel instant":

**9 → 10 → 12 → 11**

Phase 11 slips to last. Libraries covered first (10 + 12), then the binary-patching UX magic. More conservative because Phase 11 has the highest correctness risk and the highest implementation variance. Slipping it doesn't block library coverage.

This is what I'd pick if the team has <3 engineers and Phase 11's 4-5 week implementation is a scheduling risk.

### 9.4 Feature-flag rollout + rollback

**Per-phase rollout**:

| Phase | Rollout stages | Default-on trigger |
|---|---|---|
| 9a (ccache) | Dark → opt-in → default-on | 1 week of green metrics on opt-in population |
| 9b (.o cache) | Same | Same |
| 9c (PCH) | Dark → opt-in via env var → default-on | 2 weeks (PCH has more ways to go wrong) |
| 9d (parallel) | Always-on on multicore, ignored on single-core | No flag — auto-detected via num_cpus |
| 10 backends | Per-backend env var (`SYNTHI_BACKEND_GLFW=1` etc.) | Phase 7 corpus green for that backend + 1 week of live use without crashes |
| 11 Tier 0 | Per-session env var, then per-project toggle in UI, then default-on | 2 weeks of fuzz corpus green + zero silent-corruption reports |
| 12 Path C | Default-on as fallback for projects without Path A backend | No flag — it's the safety net, not a feature |
| 12 BYOR | Existing Phase 8 UI toggle (`bringYourOwnRunnerEnabled`) | Per-user, never auto-enabled |

**Rollback strategy (rev2 review point #30)**:

Feature flags alone aren't enough — a user hitting silent corruption from Tier 0 won't know to flip the flag. Rev2 adds per-user rollback:

1. **Corruption detection**: runner emits a diagnostic on crashes that Tier 0 could have caused (Phase 11 literal-bytes mismatch between expected and actual at patch time, unexpected SIGSEGV in the runner within N frames of a Tier 0 patch, etc.)
2. **Auto-rollback**: on corruption detection, the worker writes `SYNTHI_TIER_ZERO_BLOCKED=1` to the user's config directory AND the project's `.synthi_split_meta.json`. Subsequent compiles honor it.
3. **User notification**: a toast explains "Tier 0 (instant updates) disabled for this session after a crash. Please report at [link]." User can manually re-enable via Settings.
4. **Reset on update**: if the worker version bumps after the rollback, the block auto-clears — the assumption is that the new version fixed the crash.

Same pattern for Phase 10 backends: a crash in a specific backend blocks that backend for the session and falls through to Path C.

### 9.5 Estimated timeline (revised honest)

```
Phase 9  (compile acceleration)    : 4-6 days   (was 3-5)
Phase 10 (Path A, 5 backends)      : 8-11 days  (was 5-7 + 1-2/extra)
Phase 11 (binary patching)         : 14-21 days (was 10-14)
Phase 12 (Path C supervisor)       : 12-16 days (was 14)
                                   ─────────────
Sum                                : 38-54 days
```

- **Single-engineer aggressive** (no parallelism, full focus, no interruptions): 8-11 weeks
- **Single-engineer realistic** (normal interruptions + testing + code review + rollout monitoring): 12-16 weeks
- **2-engineer parallel** (9 alongside 10a, 11 alongside 12 after trait freeze): 7-10 weeks
- **3-engineer parallel** (split 10 backends + parallel 11/12): 5-8 weeks

Rev1 quoted 5-7 weeks aggressive, 8-10 weeks conservative. Rev2 is 8-16 weeks depending on team size — more honest about the Phase 11 scope growth after the rev2 review caught the correctness holes.

---

## 10. Test Strategy (revised rev2)

### 10.1 Unit tests

- **Phase 9**: PCH cache key correctness under flag drift + macro-environment mismatch; `.o` cache header-hash staleness detection; parallel-vs-serial dispatch table
- **Phase 10**: per-backend window create/destroy smoke (skipped if library not installed); manifest-based selector table-driven test; X11 window ID exposure check
- **Phase 11**: DWARF lookup on fixtures across gcc/clang × {12,13,14,15,16}; ASLR math with and without `setarch`; constant pool map correctness; Tree-sitter value-only classifier; four-layer integrity check covering all 5 failure modes
- **Phase 12**: IPC protocol handshake + downgrade negotiation; signal handler ownership enforcement; link-time `nm` verifier; Unix socket lifecycle on crash

### 10.2 Integration tests

- **Phase 9**: end-to-end compile chain with all optimizations enabled; measure against the 4-run baseline (cold, warm, comment-only, flag-drift)
- **Phase 10**: Phase 7 corpus runtime test — each corpus entry spawns a real runner and verifies an edit round-trips to a rendered frame (requires the test host to have the backend library installed)
- **Phase 11**: force-Tier-0 value edit on SDL2/GLFW/raylib projects, verify patched bytes AND rendered frame content
- **Phase 12**: force-Path-C on 3 corpus entries (Qt, bgfx, BYOR), verify HMR edit round-trips via supervisor

### 10.3 Benchmark harness (from Phase 9f, extended through 11g)

Two harnesses (see §4's 9f for details):

**Harness A (compile-only)**: CSV per compile-latency scenario.
**Harness B (end-to-end, simulated frontend + WebRTC test client)**: CSV per save-to-frame scenario.

```csv
phase,scenario,measurement,library,p50_ms,p95_ms,p99_ms,sample_n,commit
9b,value_edit,runner_internal,SDL2,165,185,205,100,abc123
9b,value_edit,user_visible,SDL2,205,245,290,100,abc123
10,value_edit,user_visible,GLFW,208,250,295,100,abc124
11,value_edit,runner_internal,SDL2,28,40,55,100,def456
11,value_edit,user_visible,SDL2,68,105,160,100,def456
12,value_edit,user_visible,Qt,185,230,285,100,ghi789
```

**Regression gates** (CI):
- Harness A p50 increase >10% → fail PR
- Harness B p50 increase >15% → fail PR (wider window for end-to-end variance)
- Any commit that drops Tier 0 hit rate >10% absolute vs baseline → warn (not fail)

### 10.4 Fuzz / chaos (rev2 corpus definition — not "random")

**Phase 11 fuzz corpus** (rev2 review point #31):

| Axis | Values |
|---|---|
| Literal kinds | `int8`, `int16`, `int32`, `int64`, `uint8`, `uint16`, `uint32`, `uint64`, `float`, `double`, `bool`, `char`, `c_string`, `enum`, `constexpr` |
| Source positions | top-of-file `const`, function-local `const`, struct initializer (direct + designated), template param, lambda capture, inline member initializer, `#define` (not patchable — negative case) |
| Compilers | `g++-11`, `g++-12`, `g++-13`, `clang++-14`, `clang++-15`, `clang++-16` |
| Optimization flags | `-O0 -fno-merge-constants` (positive), `-O0` (positive with pool fallback), `-O1`/`-O2`/`-O3` (negative — must reject) |

Cartesian product: 15 × 7 × 6 × 4 = 2520 scenarios. Full run on CI nightly. A sampled run (50 scenarios randomly picked) on every PR.

For each scenario:
1. Generate a minimal program with a known literal in known position
2. Compile with the target compiler + flags
3. Parse DWARF, locate the literal
4. Patch with a new value of the same kind
5. Verify: (a) the bytes at the offset now match the new value, (b) a full recompile from the new source produces a `.so` whose patched region is byte-identical to the patched one, (c) no segfault running the resulting binary

Any scenario failing any check blocks the release.

**Phase 12 chaos tests**:
- Rapid child-crash-restart cycle (kill child every N frames via SIGSEGV injection), verify supervisor respawns correctly and drops stale IPC state
- Socket disconnect mid-command, verify both sides recover cleanly
- Display collision: spawn 3 Path C sessions simultaneously, verify different Xvfb display numbers

---

## 11. Cross-cutting Risk Table (revised rev2)

| Risk | Phase | Mitigation |
|---|---|---|
| Backend library not installed in deployment env | 10 | Runtime `dlopen` — missing library logs a clear error and falls through to Path C |
| Binary patch silently corrupts runner | 11 | Four-layer integrity check; fuzz corpus coverage; abort-on-mprotect-restore-failure |
| PCH flag mismatch produces silent ODR bugs | 9 | Pre-include macro extraction; consistency check per consumer file; fall back on any mismatch |
| PCH overestimated savings | 9 | Measure in 9f, don't rely on PCH as the primary saver |
| IPC latency tax pushes Path C over budget | 12 | Early measurement via 9f Harness B; ximagesrc tuning; documented as acceptable |
| Compiler DWARF variance breaks literal lookup | 11 | 2520-scenario fuzz corpus covers gcc + clang × versions |
| ASLR / PIE load address miscalculation | 11 | Explicit test with `setarch -R` and without; dl_iterate_phdr + l_addr in helper |
| Constant pooling aliases two literals | 11 | `-fno-merge-constants` primary; constant pool reverse map as fallback detection |
| `-O0` not enforced, breaks Tier 0 | 11 | Phase 4.5 manifest validator gates Tier-0 eligibility on `-O0` presence |
| Value-only classifier too loose (regex) | 11 | Tree-sitter-cpp AST diff; rejects anything that isn't a single literal-for-literal swap |
| Xvfb display leak / collision | 12 | Dynamic display number allocation; `Drop` cleanup on supervisor |
| Tier 0 false positives crash runner | 11 | Fuzz corpus + integrity check + rollback auto-disable on detected crash |
| Runtime backend selection picks wrong library | 10 | Arch-cache-preferred + flag-fallback + Path C ultimate fallback |
| g++ parallel compile contention on low-core containers | 9 | `num_cpus::get() >= 3` gate, serial fallback otherwise |
| BYOR user forgets `synthi_hmr_init` | 12 | Post-compile `nm` check fires immediately, clear error message |
| IPC protocol evolution breaks old cached child binaries | 12 | Handshake version negotiation + capability intersection |
| Signal handler ownership conflicts (SIGSEGV, SIGINT) | 12 | Documented ownership matrix; `libsynthi_hmr_runtime::init` enforces |
| Per-session RSS blows up from DWARF/cache | 13 | RSS cap + LRU eviction; documented per-session budget |
| Zero-day library claim overstated | 12 | Reframed — Phase 12 handles AI-known-but-Path-A-absent, not truly novel libraries |
| Feature flag can't revert silent corruption | 9 | Auto-rollback on detected crash writes per-user block; reset on worker upgrade |

---

## 12. Out of Scope

Explicitly NOT in this plan:

- **Non-C/C++ languages** — Rust, Go, Zig HMR is post-V2. Different binary patching, different DWARF shape, different runner model.
- **Multi-step build systems** — Qt MOC, CMake, Meson rejected per `HMR_AGNOSTIC_ULTRAPLAN.md` Mitigation 3. Post-V2.
- **Remote runners** — HMR across network boundary is post-V3.
- **Multi-window projects** — single window per runner. Post-V2.
- **GPU compute / CUDA** — kernels in `.so` files need their own patch path. Post-V2.
- **Windows / macOS runners** — Phase 12 assumes X11. Wayland, Windows GDI, macOS AppKit need different capture pipelines. Post-V3.
- **EGL surfaceless / Wayland-native / DRM direct rendering** — no X11 window for `ximagesrc` to capture. Documented as explicit limitation in §7.4.
- **Full code generation via Tier 0** — we only patch existing literals, never rewrite functions. Anything else falls through to compile.
- **Real-time collaborative HMR** — multiple users hot-editing the same running project. Post-V2.
- **Shaving below the WebRTC video floor** — changing transport (canvas/bitmap stream, SharedArrayBuffer) is a separate plan.
- **Truly zero-day libraries** — libraries the AI has no training knowledge of. Phase 4's `runner_synthesis = low` gate still rejects these.

---

## 13. Cross-cutting Correctness Guardrails (NEW in rev2)

This section collects invariants the plan relies on but that don't fit cleanly under any single phase.

### 13.1 Memory budget + eviction

Each active session holds in-process:
- ccache state (~few MB, bounded by ccache's own config)
- `.o` cache entries per module (~100-500KB each, ~3 modules)
- PCH `.gch` files (~5-20 MB each, 1 per project)
- DWARF index per compiled `.so` (~10-50 MB for medium projects with debug info)
- Tree-sitter parsed AST caches (~1-5 MB per cached source)

Total per session: **~50-100 MB runtime overhead**, potentially up to ~200 MB for projects with large `.so` debug info.

**Cap and eviction policy**:
- Global per-worker cap: `SYNTHI_HMR_CACHE_MAX_MB` (default 2048, configurable via env)
- When total exceeds cap, LRU-evict oldest session's DWARF index + PCH first (they're the largest and can be rebuilt on next compile)
- If eviction can't free enough, refuse new sessions with a clear error — better than OOM-killing the worker

**Instrumentation**: log cache hit rates + RSS per session at startup, every 5 minutes, and on eviction.

**Files**: `worker/src/hmr/session_cache_budget.rs` (new)

### 13.2 `-O0` enforcement

Projects using Tier 0 (Phase 11) must compile with `-O0`. This is enforced at the manifest level, not at compile time:

- Phase 4.5 `validate_manifest_v1` checks for `-O0` in `common_flags`
- If `-O0` missing OR any `-O1`/`-O2`/`-O3`/`-Os`/`-Ofast` present, the project is marked Tier-0-ineligible and all Tier 0 paths fall through to Tier 1 transparently
- Log a diagnostic so the user can enable Tier 0 if they want by updating the manifest

Not a block — projects with higher optimization just get the Phase 9 compile path (still fast, just not magical).

### 13.3 ABI / struct layout change detection

The Phase 6 manifest heal loop (from `HMR_AGNOSTIC_ULTRAPLAN.md`) already handles link-time symbol mismatches. Rev2 adds an additional check for Tier 0: if the user's edit changes a struct field's type or adds/removes a field, the `.so` layout changes and binary patching WILL corrupt state.

**Detection**: at Tier 0 eligibility time, compare the AST of the old source vs new source. If any struct definition changed (field added/removed/reordered/retyped), reject Tier 0 — falls through to full recompile. This is a subset of the Tree-sitter value-only classifier (11c) — just explicitly called out here.

### 13.4 Signal handler ownership (referenced from 12b)

The matrix from 12b, duplicated here for quick reference:

| Signal | Owner | Notes |
|---|---|---|
| `SIGCHLD` | Supervisor | Child must not install |
| `SIGTERM` | Supervisor → forwards to child |
| `SIGINT` | Supervisor (child ignores) |
| `SIGSEGV` | Child (libsynthi_hmr_runtime) | Write crash dump + exit |
| `SIGUSR1` | Child (future state snapshot) |
| `SIGPIPE` | Child (ignore) |

### 13.5 Rollback strategy (referenced from 9.4)

Per-user auto-rollback on detected corruption:
1. Crash detected with Tier 0 attribution (patch-then-segv within N frames) OR Path A attribution (backend-specific crash)
2. Worker writes block file to `~/.synthi/hmr_rollback_<feature>_<project_slug>` containing rollback timestamp + worker version
3. Subsequent compiles read the block, fall back to the older code path, log to diagnostics
4. Frontend toast explains the rollback
5. On worker version bump, all block files older than 30 days clear automatically (assumption: fix landed)

---

## 14. Success = User Quotes

The plan is successful when users say, unprompted:

- "I can't believe how fast HMR is now."
- "I tweaked that color and it just… changed."
- "Wait, this IDE handles GLFW projects too?"
- "Why is Synthi faster than vite?"
- "I didn't realize I was using raylib until I looked at the status bar."

Any one of those quotes justifies the full 8-16 week investment.

---

*rev1 authored after `HMR_AGNOSTIC_ULTRAPLAN.md` shipped (Phases 1-8) on branch `claude/hmr-agnostic-ultraplan`, commit `802170e5`. rev2 authored after detailed technical review identified ~20 correctness gaps, latency honesty issues, and cross-cutting design holes. This plan continues on a new branch (TBD) once approved.*
