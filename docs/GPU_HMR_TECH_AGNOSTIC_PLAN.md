# GPU HMR Tech-Agnostic Plan

## Summary

Make GPU HMR backend-agnostic by treating the render/window backend as first-class data, not as an SDL2 fallback guess.

The target behavior:

- SDL2, GLFW/OpenGL, raylib, and SFML/CSFML can compile, run, render, screenshot, and device-HMR through the same GPU path.
- Unknown/custom render stacks fail explicitly or use BYOR/per-project runner mode.
- No non-SDL project silently falls back to SDL2.
- Generated GPU splits preserve the user's original render backend and never translate GLFW, raylib, SFML, Vulkan, or custom code into SDL2.

The current repo already has important pieces in place:

- `GPU_SPLIT_PROMPT` is mostly backend-preserving.
- `compile_manifest.gpu` exists.
- `compile_gui`, `compile_runner`, and `compile_device` already use manifest flags.
- `WindowBackend` implementations exist for SDL2, GLFW, raylib, and SFML.
- The runtime runner has partial `WindowBackend` wiring.
- Scale validation already supports `sdl2|glfw`.

The remaining work is to make backend identity explicit, remove unsafe SDL2 fallback paths for manifest-backed projects, harden verification, and expand live validation coverage.

## Implementation Plan

### 1. Add First-Class Backend Identity To Compile Manifests

Files to touch:

- `ai-backend/ai-engine/llm/prompts.py`
- `ai-backend/ai-engine/build_manifest.py`
- `ai-backend/ai-engine/agents/kernel_splitter.py`
- `backend/synthi-webrtc-compiler/worker/src/hmr/compile_manifest.rs`

Add an optional `window_backend` block to the compile manifest:

```json
"window_backend": {
  "kind": "sdl2|glfw|raylib|sfml|custom",
  "display": "C++ with GLFW + OpenGL",
  "surface": "renderer|window|implicit_global",
  "requires_opengl": true,
  "flags": {
    "width": 800,
    "height": 600,
    "resizable": false,
    "vsync": true,
    "opengl_version_major": 2,
    "opengl_version_minor": 1
  }
}
```

Implementation details:

- Extend the Python `BuildManifest` schema in `build_manifest.py` with `WindowBackendBlock` and `WindowBackendFlags`.
- Extend Rust `CompileManifest` with matching serde structs.
- Default `window_backend` to `None` for old sidecars and host-only manifests.
- In `build_manifest.py`, normalize backend identity from source markers and link hints:
  - SDL2: `SDL2/SDL.h`, `SDL_`, `-lSDL2`.
  - GLFW/OpenGL: `GLFW/glfw3.h`, `GLFWwindow`, `glfw`, `-lglfw`, `GL/gl.h`, `glClear`, `-lGL`.
  - raylib: `raylib.h`, `InitWindow`, `BeginDrawing`, `EndDrawing`, `-lraylib`.
  - SFML/CSFML: `SFML/Graphics.hpp`, `sf::RenderWindow`, `sfRenderWindow_`, `-lsfml-*`, `-lcsfml-*`.
- Preserve arch-cache YAML frontmatter and link-flag scan as compatibility fallbacks, but make `compile_manifest.window_backend.kind` the preferred signal.
- Update `GPU_SPLIT_PROMPT` so the manifest example includes `window_backend` and states that the generated backend must match the source backend.
- Update `kernel_splitter.py` parsing/tests so returned manifests can carry the new block unchanged.

Success criteria:

- New manifests from `/refactor/split/gpu` include `window_backend` for SDL2, GLFW, raylib, and SFML sources.
- Old manifests still deserialize and fall back to existing behavior.
- No compile command changes are needed for host modules beyond existing manifest link flags.

### 2. Make Runtime Selection Non-SDL By Default For Manifest Projects

Files to touch:

- `backend/synthi-webrtc-compiler/worker/src/runtime/backends/selector.rs`
- `backend/synthi-webrtc-compiler/worker/src/runtime/window_backend.rs`
- `backend/synthi-webrtc-compiler/worker/src/runtime/runner_bin.rs`
- `backend/synthi-webrtc-compiler/worker/src/runtime/backends/sdl2_backend.rs`
- `backend/synthi-webrtc-compiler/worker/src/runtime/backends/glfw_backend.rs`
- `backend/synthi-webrtc-compiler/worker/src/runtime/backends/raylib_backend.rs`
- `backend/synthi-webrtc-compiler/worker/src/runtime/backends/sfml_backend.rs`

Selector behavior:

1. Read `.synthi_split_meta.json`.
2. Prefer `compile_manifest.window_backend.kind`.
3. Fall back to arch-cache frontmatter `framework`.
4. Fall back to `## Language & Framework`.
5. Fall back to link-flag scan.
6. Use legacy SDL2 only when no sidecar/manifest exists.

Important runtime rule:

- If a sidecar exists and selects a non-SDL backend, backend init/create failure must be a clear runtime error. Do not call `init_sdl()`.
- If no sidecar exists, legacy SDL2 fallback remains for old manual/smoke paths.

Trait changes:

- Add `begin_frame(&mut self, handle: &WindowHandle) -> anyhow::Result<()>`.
- Add a helper on `WindowHandle`, for example `surface_ptr()`, to centralize the pointer passed into hot modules:
  - SDL2 returns `renderer_ptr`.
  - GLFW returns `raw_ptr` (`GLFWwindow*`).
  - SFML returns `raw_ptr` (`sfRenderWindow*`).
  - raylib returns null or a documented sentinel because rendering is global-state based.

Backend-specific implementation:

- SDL2:
  - `begin_frame`: no-op.
  - `present_frame`: `SDL_RenderPresent`.
- GLFW:
  - `begin_frame`: `glfwMakeContextCurrent`.
  - `present_frame`: `glfwSwapBuffers`.
- raylib:
  - `begin_frame`: `BeginDrawing`.
  - `present_frame`: `EndDrawing`.
  - Keep the backend as `surface = implicit_global`.
- SFML:
  - `begin_frame`: no-op.
  - `present_frame`: `sfRenderWindow_display`.

Runner changes:

- Replace runtime branches gated on `!window.is_null()` with `runtime_handle.is_some()` where the path is backend-neutral.
- Keep direct SDL pointers only for legacy SDL-specific compatibility.
- Route event pumping through `WindowBackend::pump_events` whenever `runtime_handle` exists.
- Route frame presentation through `begin_frame` before `gui_on_render` and `present_frame` after `gui_on_render`.
- Restrict direct `SDL_PollEvent`, `SDL_PushEvent`, and `SDL_RenderPresent` fallback to legacy SDL mode.
- For keyboard input:
  - SDL2 may keep `SDL_PushEvent`.
  - Non-SDL backends rely on existing XTest input injection and query-based input in user code.
  - Do not report failed `push_synthetic_event` for GLFW/raylib/SFML as a render backend failure.

Success criteria:

- Manifest-backed GLFW project never initializes SDL2.
- Manifest-backed raylib/SFML project never initializes SDL2.
- SDL2 legacy fallback only occurs when no sidecar/manifest exists.
- Runner logs include selected backend, selector layer, and whether fallback was legacy or hard failure.

### 3. Harden GPU Split Verification Against Backend Translation

Files to touch:

- `ai-backend/ai-engine/verifier_gpu.py`
- `ai-backend/ai-engine/tests/test_verifier_gpu.py`
- `ai-backend/ai-engine/tests/test_gpu_build_manifest.py`
- `ai-backend/ai-engine/tests/test_kernel_splitter.py`

Current verifier already rejects some SDL introduction into non-SDL sources. Make this general:

- Detect source render backend from every submitted file, not only the focused source.
- Detect generated render backend from generated `shared`, `core`, `gui`, `host_runner`, sidecar, and manifest.
- Reject any generated backend set that differs from the source backend set unless source backend is unknown/custom and manifest explicitly declares `custom`.
- Require `compile_manifest.window_backend.kind` to match the detected source backend.
- Reject SDL2 markers in non-SDL output.
- Reject GLFW markers in SDL/raylib/SFML output unless source also used GLFW/OpenGL.
- Reject raylib markers in non-raylib output.
- Reject SFML/CSFML markers in non-SFML output.

Keep existing GUI prohibitions, but make them backend-wide:

- `gui.cpp` must not create windows, renderers, contexts, or swapchains.
- `gui.cpp` must not present/swap/display/end drawing.
- `gui.cpp` must not recover surfaces through global/current lookup APIs.
- Exception: raylib is global-state based. The allowed pattern must be explicit: `window_backend.surface == "implicit_global"` and the generated GUI may use raylib draw calls inside the runner-owned frame, but still must not call `InitWindow`, `BeginDrawing`, or `EndDrawing`.

Add tests:

- GLFW source that generates `SDL2/SDL.h` or `SDL_` is rejected.
- SDL2 source that generates GLFW/raylib/SFML markers is rejected.
- raylib source preserves raylib and does not emit SDL/GLFW/SFML markers.
- SFML/CSFML source preserves SFML and emits matching link flags.
- Manifest `window_backend.kind` mismatch is rejected.
- GPU split with no `window_backend` still passes old-manifest compatibility tests only when source backend is not identifiable.

Success criteria:

- Bad backend translation fails before Rust compilation.
- Verifier rejection text tells the AI to preserve the original backend and surface contract.

### 4. Expand Worker Image Runtime Dependencies

Files to touch:

- `backend/synthi-webrtc-compiler/worker/Dockerfile`
- `backend/synthi-webrtc-compiler/worker/Dockerfile.gpu`
- `backend/synthi-webrtc-compiler/worker/Dockerfile.cuda`

Install backend packages in runtime images:

- SDL2: already present.
- GLFW/OpenGL:
  - `libglfw3`
  - `libglfw3-dev`
  - `libgl1-mesa-dev`
  - `libgl1-mesa-dri`
  - `libglx-mesa0`
  - `mesa-utils`
- SFML/CSFML:
  - `libcsfml-dev`
  - `libsfml-dev`
- raylib:
  - Install distro package if available.
  - If unavailable on a base image, add a pinned source-build stage or a small install block that builds raylib shared library and runs `ldconfig`.

Notes:

- `Dockerfile.gpu` already has GLFW/OpenGL in the runtime stage.
- `Dockerfile` and `Dockerfile.cuda` currently need GLFW/OpenGL added.
- All three images need SFML/CSFML and raylib coverage.
- Builder stage does not need these libraries unless tests are run there.

Success criteria:

- `g++` can link generated host GUI/runner code for SDL2, GLFW/OpenGL, raylib, and SFML inside the worker container.
- Runtime `libloading` can load GLFW/raylib/CSFML libraries in the shipped runner.

### 5. Expand GPU HMR Harnesses Into A Backend Matrix

Files to touch:

- `mcp/synthi-mcp/scripts/gpu-hmr-scale-validation.mjs`
- `mcp/synthi-mcp/scripts/gpu-hmr-agent-split-workspace-test.mjs`
- `mcp/synthi-mcp/scripts/gpu-hmr-dynamic-workspace-test.mjs`
- `mcp/synthi-mcp/scripts/gpu-hmr-test.mjs`

Use one common env var:

```bash
SYNTHI_GPU_RENDER_BACKEND=sdl2|glfw|raylib|sfml
```

Keep `SYNTHI_SCALE_RENDER_BACKEND` as a backward-compatible alias for scale validation.

Scale validation:

- Extend `buildScaleProject()` to generate `raylib` and `sfml` user projects in addition to `sdl2` and `glfw`.
- For raylib:
  - Include `raylib.h`.
  - Use `InitWindow`, `BeginDrawing`, `DrawRectangle`/`DrawCircle`, `EndDrawing`, and `CloseWindow` in the original monolithic source.
  - Generated split must move `InitWindow`/`EndDrawing` ownership to runner/backend and keep draw calls in GUI.
- For SFML:
  - Prefer CSFML C ABI in generated runtime path, but the monolithic source may use either C++ SFML or CSFML.
  - Use `sfRenderWindow_*` markers for mechanically testable output.
- Validation should assert:
  - Generated split preserves backend markers.
  - Non-SDL backends contain no SDL markers.
  - First screenshot is visibly non-black.
  - Device-only HMR changes screenshot pixels.
  - Runner stays alive after HMR.

Agent split validation:

- Add `SYNTHI_GPU_AGENT_RENDER_BACKEND` or reuse `SYNTHI_GPU_RENDER_BACKEND`.
- Generate monolithic user sources for SDL2, GLFW, raylib, and SFML.
- Keep the current no-Synthi-ABI guard.
- Add backend preservation checks after `readGeneratedSplit`.

Dynamic workspace validation:

- Parameterize the existing already-adapted fixture by backend.
- Generate manifest `window_backend` and backend-specific link flags.
- Use randomized paths as today to keep proving `module_files` drives the contract.

Canonical `gpu-hmr-test.mjs`:

- Keep SDL2 vector/flow fixtures for legacy coverage.
- Add a backend selector smoke phase that can run `SYNTHI_GPU_RENDER_BACKEND=glfw|raylib|sfml` and verify the runner selected the expected backend from sidecar/manifest.

Success criteria:

- The same command shape validates each supported backend.
- Backend-specific result files are written under `.gpu-hmr-test-logs`.
- GLFW, raylib, and SFML failures cannot be hidden by SDL2 fallback.

## Public Interfaces And Contracts

### Manifest Contract

`compile_manifest.window_backend` is new but optional for backward compatibility.

Required when emitted:

- `kind`: lowercase backend key.
- `display`: human-readable string.
- `surface`: how hot modules receive/use the render target.

Optional:

- `requires_opengl`
- `flags.width`
- `flags.height`
- `flags.resizable`
- `flags.vsync`
- `flags.opengl_version_major`
- `flags.opengl_version_minor`

### Runtime Contract

The runner owns:

- backend initialization,
- window/context creation,
- frame begin/end,
- event pumping,
- presentation/swap/display,
- shutdown.

Hot modules own:

- app state,
- simulation,
- GPU launch through `synthi_gpu_launch`,
- backend-specific drawing into the runner-supplied surface or current runner-owned frame.

`gui.cpp` must never own:

- window creation,
- renderer/context creation,
- swap/present/display/end drawing,
- implicit renderer/window lookup, except explicitly allowed raylib global draw state.

## Test Plan

Focused Python tests:

```bash
cd ai-backend/ai-engine
pytest tests/test_verifier_gpu.py tests/test_gpu_build_manifest.py tests/test_kernel_splitter.py
```

Focused worker tests:

```bash
cd backend/synthi-webrtc-compiler/worker
cargo test --release --features gpu-hmr phase10
cargo test --release --features gpu-hmr compile_manifest
```

Live backend matrix after rebuilding worker images:

```bash
cd mcp/synthi-mcp
for backend in sdl2 glfw raylib sfml; do
  SYNTHI_GPU_HMR=1 SYNTHI_GPU_RENDER_BACKEND=$backend node scripts/gpu-hmr-scale-validation.mjs
done
```

Agent split matrix:

```bash
cd mcp/synthi-mcp
for backend in sdl2 glfw raylib sfml; do
  SYNTHI_GPU_HMR=1 SYNTHI_GPU_RENDER_BACKEND=$backend node scripts/gpu-hmr-agent-split-workspace-test.mjs
done
```

Dynamic adapted-project matrix:

```bash
cd mcp/synthi-mcp
for backend in sdl2 glfw raylib sfml; do
  SYNTHI_GPU_HMR=1 SYNTHI_GPU_RENDER_BACKEND=$backend node scripts/gpu-hmr-dynamic-workspace-test.mjs
done
```

Acceptance gates:

- SDL2 still passes existing validation.
- GLFW/OpenGL passes with no SDL markers.
- raylib passes with runner-owned `BeginDrawing`/`EndDrawing`.
- SFML/CSFML passes with matching CSFML/SFML link/runtime libraries.
- Device-only HMR remains active for all backends.
- Unknown/custom backend does not silently fall back to SDL2.

## Rollout Sequence

1. Add manifest schema and prompt updates.
2. Add verifier hardening and unit tests.
3. Wire selector to prefer manifest `window_backend`.
4. Add `begin_frame`/surface contract to `WindowBackend`.
5. Remove SDL fallback for manifest-backed non-SDL projects.
6. Add Docker deps.
7. Expand scale validation to `raylib` and `sfml`.
8. Expand agent split and dynamic workspace tests.
9. Run matrix and record results.

This sequence keeps the riskiest runtime behavior behind schema/verifier checks first, then expands live execution coverage after bad backend translation is mechanically rejected.

## Assumptions

- "Tech agnostic" means preserving and running the user's render/window backend for the supported backend set, not supporting every possible graphics stack with the shipped runner on day one.
- Legacy SDL2 fallback remains only for old sidecars/no-manifest projects.
- Unknown/custom backends should fail clearly or use BYOR/per-project runner mode, never silently translate to SDL2.
- Existing local dirty changes should be left untouched unless they are directly part of this plan.
