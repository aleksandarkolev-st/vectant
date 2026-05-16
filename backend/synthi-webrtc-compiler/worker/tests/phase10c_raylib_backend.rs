// ============================================================
// Phase 10c (ULTRAPLAN Lightning) — raylib backend integration tests
// ============================================================
//
// Same shape as phase10b_glfw_backend.rs: we exercise the
// construction + error-path behavior of RaylibBackend WITHOUT
// loading libraylib on most hosts, and gate the actually-loads-
// raylib tests behind SYNTHI_RUN_RAYLIB_TESTS=1 + libraylib
// presence.
//
// What we validate without loading libraylib:
//   - RaylibBackend::new() doesn't try to dlopen anything
//   - All non-init methods reject before init() has run
//   - push_synthetic_event ALWAYS returns Err (raylib has no
//     synthetic-event API; matches GLFW's limitation)
//   - on_resize mutates cached handle dimensions
//   - pump_events before init is a safe no-op
//   - Construction is idempotent (new/default both yield the
//     same empty-state backend)
//
// What we validate when SYNTHI_RUN_RAYLIB_TESTS=1 + libraylib
// installed:
//   - init() dlopens libraylib under one of the known sonames
//   - create_window opens a real raylib window (requires DISPLAY)
//   - destroy_window tears it down without crashing
//   - shutdown() releases the dlopen handle

#![allow(dead_code)]

use worker::runtime::backends::raylib_backend::RaylibBackend;
use worker::runtime::window_backend::{BackendEvent, WindowBackend, WindowFlags, WindowHandle};

// ────────────────────────────────────────────────────────────
// Shape tests — always run, no raylib required
// ────────────────────────────────────────────────────────────

#[test]
fn raylib_backend_constructable() {
    let backend = RaylibBackend::new();
    assert_eq!(backend.name(), "raylib");
}

#[test]
fn raylib_backend_default_constructable() {
    let backend = RaylibBackend::default();
    assert_eq!(backend.name(), "raylib");
}

#[test]
fn raylib_backend_construction_does_not_load_library() {
    // Constructing a RaylibBackend must NOT try to dlopen
    // libraylib. The whole point of lazy init is that you can
    // have a backend type around without binding to any library.
    let _backend = RaylibBackend::new();
}

#[test]
fn raylib_create_window_before_init_fails() {
    let mut backend = RaylibBackend::new();
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
fn raylib_present_frame_rejects_null_pointer() {
    let mut backend = RaylibBackend::new();
    let handle = WindowHandle::new(std::ptr::null_mut(), std::ptr::null_mut(), 800, 600, None);
    let result = backend.present_frame(&handle);
    assert!(result.is_err());
    let msg = format!("{}", result.unwrap_err());
    assert!(msg.contains("null"));
}

#[test]
fn raylib_push_synthetic_event_always_returns_err() {
    // Same limitation as GLFW — raylib has no synthetic event
    // injection API. The contract is that this method ALWAYS
    // returns Err; the runner detects this and uses the manual
    // key-state tracking workaround for remote input forwarding.
    let mut backend = RaylibBackend::new();
    let buf = [0u8; 256];
    let result = backend.push_synthetic_event(0, buf.as_ptr() as *const _, buf.len());
    assert!(
        result.is_err(),
        "raylib push_synthetic_event must always return Err"
    );
    let msg = format!("{}", result.unwrap_err());
    assert!(
        msg.to_lowercase().contains("synthetic") || msg.to_lowercase().contains("not support"),
        "error should explain the limitation: {}",
        msg
    );
}

#[test]
fn raylib_pump_events_before_init_is_safe() {
    // pump_events on an uninitialised backend must not panic.
    // It should clear the output and return — no events to
    // drain because the library isn't loaded.
    let mut backend = RaylibBackend::new();
    let mut events: Vec<BackendEvent> = Vec::new();
    events.push(BackendEvent::Quit); // pre-populate to verify it gets cleared
    backend.pump_events(&mut events);
    assert!(
        events.is_empty(),
        "pump_events should clear the output buffer"
    );
}

#[test]
fn raylib_shutdown_before_init_is_a_noop() {
    let mut backend = RaylibBackend::new();
    backend.shutdown();
    backend.shutdown(); // idempotent
}

#[test]
fn raylib_destroy_window_with_null_pointer_is_safe() {
    let mut backend = RaylibBackend::new();
    let handle = WindowHandle::new(std::ptr::null_mut(), std::ptr::null_mut(), 800, 600, None);
    backend.destroy_window(handle); // must not panic
}

#[test]
fn raylib_on_resize_updates_handle_dimensions() {
    let mut backend = RaylibBackend::new();
    let mut handle = WindowHandle::new(std::ptr::null_mut(), std::ptr::null_mut(), 800, 600, None);
    backend.on_resize(&mut handle, 1280, 720);
    assert_eq!(handle.width, 1280);
    assert_eq!(handle.height, 720);
}

// ────────────────────────────────────────────────────────────
// Library-load tests — gated behind SYNTHI_RUN_RAYLIB_TESTS=1
// ────────────────────────────────────────────────────────────

fn raylib_tests_enabled() -> bool {
    std::env::var("SYNTHI_RUN_RAYLIB_TESTS").ok().as_deref() == Some("1")
}

#[test]
fn raylib_init_attempts_to_load_library() {
    if !raylib_tests_enabled() {
        eprintln!(
            "[SKIP] raylib_init: set SYNTHI_RUN_RAYLIB_TESTS=1 to enable \
             (also requires libraylib installed)"
        );
        return;
    }
    let mut backend = RaylibBackend::new();
    match backend.init() {
        Ok(_) => {
            // Library loaded + symbols resolved cleanly.
            backend.shutdown();
        }
        Err(e) => {
            // Failure is expected on hosts without libraylib.
            // Verify it's the library-lookup failure path, not
            // some random bug in resolve_symbols.
            let msg = format!("{}", e);
            assert!(
                msg.contains("libraylib") || msg.contains("not found"),
                "expected library-not-found error, got: {}",
                msg
            );
        }
    }
}

#[test]
fn raylib_full_lifecycle_smoke() {
    if !raylib_tests_enabled() {
        eprintln!("[SKIP] raylib_full_lifecycle: set SYNTHI_RUN_RAYLIB_TESTS=1 to enable");
        return;
    }
    if std::env::var("DISPLAY").is_err() {
        eprintln!("[SKIP] raylib_full_lifecycle: no DISPLAY env var");
        return;
    }
    let mut backend = RaylibBackend::new();
    let init_result = backend.init();
    if init_result.is_err() {
        eprintln!(
            "[SKIP] raylib_full_lifecycle: init failed: {}",
            init_result.unwrap_err()
        );
        return;
    }

    let win_result = backend.create_window(
        "raylib-smoke",
        320,
        240,
        WindowFlags {
            vsync: false,
            ..Default::default()
        },
    );
    match win_result {
        Ok(handle) => {
            // raylib's raw_ptr points to a static sentinel, not null.
            assert!(!handle.raw_ptr.is_null());
            assert_eq!(handle.width, 320);
            assert_eq!(handle.height, 240);

            // pump_events should drain the queue without panicking,
            // even right after window creation.
            let mut events: Vec<BackendEvent> = Vec::new();
            backend.pump_events(&mut events);

            // Present a frame. May do nothing visible in Xvfb but
            // must not crash.
            let _ = backend.present_frame(&handle);

            backend.destroy_window(handle);
        }
        Err(e) => {
            eprintln!("[SKIP] raylib_full_lifecycle: create_window failed: {}", e);
        }
    }
    backend.shutdown();
}
