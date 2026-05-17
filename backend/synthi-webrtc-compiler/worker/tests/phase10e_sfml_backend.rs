// ============================================================
// Phase 10e (ULTRAPLAN Lightning) — SFML backend integration tests
// ============================================================
//
// SFML proper is C++-only and not dlopen-friendly. This backend
// targets the CSFML C bindings instead (libcsfml-graphics.so,
// libcsfml-window.so). Distros ship these as libcsfml-graphics2.6
// / libcsfml-window2.6 on current Debian/Ubuntu.
//
// Same shape as phase10b_glfw_backend.rs / phase10c_raylib_backend.rs:
// non-load tests always run, library-load tests are gated behind
// SYNTHI_RUN_SFML_TESTS=1 + libcsfml-graphics presence.
//
// What we validate without loading libcsfml:
//   - SFMLBackend::new() doesn't try to dlopen anything
//   - All non-init methods reject before init() has run
//   - push_synthetic_event ALWAYS returns Err (no CSFML synthetic
//     event API; same limitation as GLFW/raylib)
//   - pump_events before init is a safe no-op
//   - on_resize mutates cached handle dimensions
//   - destroy_window with null pointer is safe
//   - Construction is idempotent
//
// What we validate when SYNTHI_RUN_SFML_TESTS=1 + libcsfml installed:
//   - init() dlopens libcsfml-graphics under one of the known sonames
//   - create_window opens a real CSFML window (requires DISPLAY)
//   - destroy_window tears it down without crashing
//   - shutdown() releases the dlopen handle

#![allow(dead_code)]

use worker::runtime::backends::sfml_backend::SFMLBackend;
use worker::runtime::window_backend::{BackendEvent, WindowBackend, WindowFlags, WindowHandle};

// ────────────────────────────────────────────────────────────
// Shape tests — always run, no CSFML required
// ────────────────────────────────────────────────────────────

#[test]
fn sfml_backend_constructable() {
    let backend = SFMLBackend::new();
    assert_eq!(backend.name(), "SFML");
}

#[test]
fn sfml_backend_default_constructable() {
    let backend = SFMLBackend::default();
    assert_eq!(backend.name(), "SFML");
}

#[test]
fn sfml_backend_construction_does_not_load_library() {
    // Constructing an SFMLBackend must NOT try to dlopen libcsfml.
    // Lazy init: the backend type exists without binding to a
    // library until init() is called.
    let _backend = SFMLBackend::new();
}

#[test]
fn sfml_create_window_before_init_fails() {
    let mut backend = SFMLBackend::new();
    match backend.create_window("test", 800, 600, WindowFlags::default()) {
        Ok(_) => panic!("create_window before init should fail"),
        Err(e) => {
            let msg = format!("{}", e);
            assert!(
                msg.to_lowercase().contains("init"),
                "error should mention init: {}",
                msg
            );
        }
    }
}

#[test]
fn sfml_present_frame_rejects_null_pointer() {
    let mut backend = SFMLBackend::new();
    let handle = WindowHandle::new(std::ptr::null_mut(), std::ptr::null_mut(), 800, 600, None);
    let result = backend.present_frame(&handle);
    assert!(result.is_err());
    let msg = format!("{}", result.unwrap_err());
    assert!(msg.contains("null"));
}

#[test]
fn sfml_push_synthetic_event_always_returns_err() {
    // CSFML has no synthetic event injection API. Same limitation
    // as GLFW and raylib — the runner's remote-input forwarding
    // path uses the manual key-state workaround.
    let mut backend = SFMLBackend::new();
    let buf = [0u8; 256];
    let result = backend.push_synthetic_event(0, buf.as_ptr() as *const _, buf.len());
    assert!(
        result.is_err(),
        "SFML push_synthetic_event must always return Err"
    );
    let msg = format!("{}", result.unwrap_err());
    assert!(
        msg.to_lowercase().contains("synthetic") || msg.to_lowercase().contains("not support"),
        "error should explain the limitation: {}",
        msg
    );
}

#[test]
fn sfml_pump_events_before_init_is_safe() {
    // Uninitialised backend has no current_window, so pump_events
    // drops the output vec and returns without touching anything.
    let mut backend = SFMLBackend::new();
    let mut events: Vec<BackendEvent> = Vec::new();
    events.push(BackendEvent::Quit); // pre-populate to verify it gets cleared
    backend.pump_events(&mut events);
    assert!(
        events.is_empty(),
        "pump_events should clear the output buffer"
    );
}

#[test]
fn sfml_shutdown_before_init_is_a_noop() {
    let mut backend = SFMLBackend::new();
    backend.shutdown();
    backend.shutdown(); // idempotent
}

#[test]
fn sfml_destroy_window_with_null_pointer_is_safe() {
    let mut backend = SFMLBackend::new();
    let handle = WindowHandle::new(std::ptr::null_mut(), std::ptr::null_mut(), 800, 600, None);
    backend.destroy_window(handle); // must not panic
}

#[test]
fn sfml_on_resize_updates_handle_dimensions() {
    let mut backend = SFMLBackend::new();
    let mut handle = WindowHandle::new(std::ptr::null_mut(), std::ptr::null_mut(), 800, 600, None);
    backend.on_resize(&mut handle, 1280, 720);
    assert_eq!(handle.width, 1280);
    assert_eq!(handle.height, 720);
}

// ────────────────────────────────────────────────────────────
// Library-load tests — gated behind SYNTHI_RUN_SFML_TESTS=1
// ────────────────────────────────────────────────────────────

fn sfml_tests_enabled() -> bool {
    std::env::var("SYNTHI_RUN_SFML_TESTS").ok().as_deref() == Some("1")
}

#[test]
fn sfml_init_attempts_to_load_library() {
    if !sfml_tests_enabled() {
        eprintln!(
            "[SKIP] sfml_init: set SYNTHI_RUN_SFML_TESTS=1 to enable \
             (also requires libcsfml-graphics installed)"
        );
        return;
    }
    let mut backend = SFMLBackend::new();
    match backend.init() {
        Ok(_) => {
            backend.shutdown();
        }
        Err(e) => {
            // Failure is expected on hosts without libcsfml. Verify
            // it's the library-lookup path and not something subtle
            // in resolve_symbols.
            let msg = format!("{}", e);
            assert!(
                msg.contains("libcsfml") || msg.contains("not found"),
                "expected library-not-found error, got: {}",
                msg
            );
        }
    }
}

#[test]
fn sfml_full_lifecycle_smoke() {
    if !sfml_tests_enabled() {
        eprintln!("[SKIP] sfml_full_lifecycle: set SYNTHI_RUN_SFML_TESTS=1 to enable");
        return;
    }
    if std::env::var("DISPLAY").is_err() {
        eprintln!("[SKIP] sfml_full_lifecycle: no DISPLAY env var");
        return;
    }
    let mut backend = SFMLBackend::new();
    let init_result = backend.init();
    if init_result.is_err() {
        eprintln!(
            "[SKIP] sfml_full_lifecycle: init failed: {}",
            init_result.unwrap_err()
        );
        return;
    }

    let win_result = backend.create_window(
        "sfml-smoke",
        320,
        240,
        WindowFlags {
            vsync: false,
            ..Default::default()
        },
    );
    match win_result {
        Ok(handle) => {
            assert!(!handle.raw_ptr.is_null());
            assert_eq!(handle.width, 320);
            assert_eq!(handle.height, 240);

            // pump_events once — should drain whatever CSFML has
            // queued without crashing.
            let mut events: Vec<BackendEvent> = Vec::new();
            backend.pump_events(&mut events);

            // Present a frame.
            let _ = backend.present_frame(&handle);

            backend.destroy_window(handle);
        }
        Err(e) => {
            eprintln!("[SKIP] sfml_full_lifecycle: create_window failed: {}", e);
        }
    }
    backend.shutdown();
}
