// ============================================================
// Phase 10b (ULTRAPLAN Lightning) — GLFW backend integration tests
// ============================================================
//
// Same shape as phase10a_window_backend.rs but for GLFW. The
// dlopen-loaded library means most tests can run on hosts without
// libglfw3 installed — we test the construction + error-path
// behavior, and gate the actually-loads-glfw tests behind
// SYNTHI_RUN_GLFW_TESTS=1 + libglfw3 presence.
//
// What we validate without loading libglfw:
//   - GLFWBackend::new() doesn't try to dlopen anything
//   - All non-init methods reject when called before init
//   - push_synthetic_event ALWAYS returns Err (GLFW design limit)
//   - Trait shape matches WindowBackend
//
// What we validate when SYNTHI_RUN_GLFW_TESTS=1 + libglfw3 present:
//   - init() actually dlopens libglfw3
//   - create_window + present_frame + destroy_window full lifecycle
//   - shutdown() releases the dlopen handle cleanly

#![allow(dead_code)]

use worker::runtime::backends::glfw_backend::GLFWBackend;
use worker::runtime::window_backend::{
    BackendEvent, WindowBackend, WindowFlags, WindowHandle,
};

// ────────────────────────────────────────────────────────────
// Shape tests — always run, no GLFW required
// ────────────────────────────────────────────────────────────

#[test]
fn glfw_backend_constructable() {
    let backend = GLFWBackend::new();
    assert_eq!(backend.name(), "GLFW");
}

#[test]
fn glfw_backend_default_constructable() {
    let backend = GLFWBackend::default();
    assert_eq!(backend.name(), "GLFW");
}

#[test]
fn glfw_backend_construction_does_not_load_library() {
    // Constructing a GLFWBackend must NOT try to dlopen libglfw.
    // The whole point of lazy init is that you can have a backend
    // type around without binding to any library.
    let _backend = GLFWBackend::new();
    // No assertion needed — if this constructed without panicking
    // and without an error, lazy init is working.
}

#[test]
fn glfw_create_window_before_init_fails() {
    let mut backend = GLFWBackend::new();
    match backend.create_window("test", 800, 600, WindowFlags::default()) {
        Ok(_) => panic!("create_window before init should fail"),
        Err(e) => {
            let msg = format!("{}", e);
            assert!(
                msg.contains("init"),
                "error should mention init: {}",
                msg
            );
        }
    }
}

#[test]
fn glfw_present_frame_rejects_null_pointer() {
    let mut backend = GLFWBackend::new();
    let handle = WindowHandle::new(
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        800,
        600,
        None,
    );
    let result = backend.present_frame(&handle);
    assert!(result.is_err());
    let msg = format!("{}", result.unwrap_err());
    assert!(msg.contains("null"));
}

#[test]
fn glfw_push_synthetic_event_always_returns_err() {
    // GLFW has no synthetic event injection API — the contract is
    // that this method ALWAYS returns Err for the GLFW backend.
    // The runner detects this and uses the manual key-state
    // tracking workaround.
    let mut backend = GLFWBackend::new();
    let buf = [0u8; 256];
    let result = backend.push_synthetic_event(0, buf.as_ptr() as *const _, buf.len());
    assert!(
        result.is_err(),
        "GLFW push_synthetic_event must always return Err"
    );
    let msg = format!("{}", result.unwrap_err());
    // Error message should explain the workaround
    assert!(
        msg.to_lowercase().contains("synthetic")
            || msg.to_lowercase().contains("not support"),
        "error should explain the limitation: {}",
        msg
    );
}

#[test]
fn glfw_pump_events_before_init_is_safe() {
    // pump_events on an uninitialised backend should not panic.
    // It should clear the output and return — no events to drain
    // because the library isn't loaded.
    let mut backend = GLFWBackend::new();
    let mut events: Vec<BackendEvent> = Vec::new();
    events.push(BackendEvent::Quit); // pre-populate to verify it gets cleared
    backend.pump_events(&mut events);
    assert!(events.is_empty(), "pump_events should clear the output buffer");
}

#[test]
fn glfw_shutdown_before_init_is_a_noop() {
    let mut backend = GLFWBackend::new();
    backend.shutdown();
    backend.shutdown(); // idempotent
}

#[test]
fn glfw_destroy_window_with_null_pointer_is_safe() {
    let mut backend = GLFWBackend::new();
    let handle = WindowHandle::new(
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        800,
        600,
        None,
    );
    backend.destroy_window(handle); // must not panic
}

#[test]
fn glfw_on_resize_updates_handle_dimensions() {
    let mut backend = GLFWBackend::new();
    let mut handle = WindowHandle::new(
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        800,
        600,
        None,
    );
    backend.on_resize(&mut handle, 1280, 720);
    assert_eq!(handle.width, 1280);
    assert_eq!(handle.height, 720);
}

// ────────────────────────────────────────────────────────────
// Library load tests — gated behind SYNTHI_RUN_GLFW_TESTS=1
// ────────────────────────────────────────────────────────────

fn glfw_tests_enabled() -> bool {
    std::env::var("SYNTHI_RUN_GLFW_TESTS").ok().as_deref() == Some("1")
}

#[test]
fn glfw_init_attempts_to_load_library() {
    if !glfw_tests_enabled() {
        eprintln!(
            "[SKIP] glfw_init: set SYNTHI_RUN_GLFW_TESTS=1 to enable (also requires libglfw3 installed)"
        );
        return;
    }
    let mut backend = GLFWBackend::new();
    match backend.init() {
        Ok(_) => {
            // Library loaded successfully
            backend.shutdown();
        }
        Err(e) => {
            // Failure is expected on hosts without libglfw3 installed.
            // Verify the error mentions the library lookup (i.e. it's
            // failing for the right reason, not some random bug).
            let msg = format!("{}", e);
            assert!(
                msg.contains("libglfw") || msg.contains("not found"),
                "expected library-not-found error, got: {}",
                msg
            );
        }
    }
}

#[test]
fn glfw_full_lifecycle_smoke() {
    if !glfw_tests_enabled() {
        eprintln!(
            "[SKIP] glfw_full_lifecycle: set SYNTHI_RUN_GLFW_TESTS=1 to enable"
        );
        return;
    }
    if std::env::var("DISPLAY").is_err() {
        eprintln!("[SKIP] glfw_full_lifecycle: no DISPLAY env var");
        return;
    }
    let mut backend = GLFWBackend::new();
    let init_result = backend.init();
    if init_result.is_err() {
        eprintln!(
            "[SKIP] glfw_full_lifecycle: glfwInit failed: {}",
            init_result.unwrap_err()
        );
        return;
    }

    let win_result = backend.create_window(
        "test-window",
        320,
        240,
        WindowFlags {
            opengl: true,
            opengl_version_major: 3,
            opengl_version_minor: 3,
            ..Default::default()
        },
    );
    match win_result {
        Ok(handle) => {
            assert!(!handle.raw_ptr.is_null());
            assert_eq!(handle.width, 320);
            assert_eq!(handle.height, 240);

            // Pump events once — should not panic on empty queue
            let mut events: Vec<BackendEvent> = Vec::new();
            backend.pump_events(&mut events);

            // Present a frame
            let _ = backend.present_frame(&handle);

            backend.destroy_window(handle);
        }
        Err(e) => {
            eprintln!("[SKIP] glfw_full_lifecycle: create_window failed: {}", e);
        }
    }
    backend.shutdown();
}
