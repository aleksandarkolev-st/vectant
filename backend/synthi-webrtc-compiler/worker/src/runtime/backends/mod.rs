// ============================================================
// WINDOW BACKENDS (ULTRAPLAN Lightning Phase 10a)
// ============================================================
//
// Per-library implementations of the `WindowBackend` trait. Each
// backend wraps a host library (SDL2 / GLFW / raylib / sokol /
// SFML) and exposes the uniform trait surface that the runner's
// main loop drives.
//
// Phase 10a ships with the SDL2 backend only — it wraps the
// existing `init_sdl()` and SDL_* calls so the runner's behavior
// is preserved exactly. Phase 10b adds GLFW. 10c-e add the rest.

#![allow(dead_code)]
// ^^ Phase 10a backends are dead code until runner_bin.rs is
// migrated to use the trait. Suppressed here; integration tests
// in `tests/phase10a_*` exercise the public surface.

pub mod glfw_backend;
pub mod sdl2_backend;
pub mod selector;

#[cfg(test)]
mod tests {
    // Inline tests live in each backend's own file; this mod
    // exists for namespace organisation.
}
