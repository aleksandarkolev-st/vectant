// ============================================================
// Phase 10f (ULTRAPLAN Lightning) — backend selector integration tests
// ============================================================
//
// Exercises the layered selector through its public path. The
// inline #[cfg(test)] mod tests inside selector.rs cover the
// individual layer functions; this file tests the end-to-end
// `select_backend` behavior across realistic input combinations.
//
// What this verifies:
//   - Layer 0 (frontmatter) wins when present
//   - Layer 1 (markdown header) catches pre-rev3 sidecars
//   - Layer 2 (link flags) catches pre-Phase-1 manifests
//   - Layer 3 (Path C fallback) handles unknown libraries
//   - Mixed inputs respect the layer priority order

#![allow(dead_code)]

use worker::runtime::backends::selector::{select_backend, SelectorInputs, SelectorLayer};

// ────────────────────────────────────────────────────────────
// Layer priority — when multiple layers could match
// ────────────────────────────────────────────────────────────

#[test]
fn frontmatter_wins_over_markdown_header() {
    // If both the YAML frontmatter AND a `## Language & Framework`
    // header are present, the frontmatter should win because it's
    // more reliable.
    let cache = "---\nframework: glfw\nframework_display: C++ with GLFW\n---\n\
                 # Architecture\n\n## Language & Framework\nC++ with SDL2\n";
    let inputs = SelectorInputs {
        arch_cache: cache,
        link_flags: &[],
    };
    let selected = select_backend(inputs);
    assert_eq!(selected.matched_layer, SelectorLayer::StructuredFrontmatter);
    assert_eq!(selected.backend.name(), "GLFW");
}

#[test]
fn frontmatter_wins_over_link_flags() {
    let cache = "---\nframework: glfw\n---\n";
    let flags = vec!["-lSDL2".to_string()];
    let inputs = SelectorInputs {
        arch_cache: cache,
        link_flags: &flags,
    };
    let selected = select_backend(inputs);
    assert_eq!(selected.matched_layer, SelectorLayer::StructuredFrontmatter);
    assert_eq!(selected.backend.name(), "GLFW");
}

#[test]
fn markdown_header_wins_over_link_flags() {
    let cache = "## Language & Framework\nC++ with GLFW\n";
    let flags = vec!["-lSDL2".to_string()];
    let inputs = SelectorInputs {
        arch_cache: cache,
        link_flags: &flags,
    };
    let selected = select_backend(inputs);
    assert_eq!(selected.matched_layer, SelectorLayer::MarkdownHeader);
    assert_eq!(selected.backend.name(), "GLFW");
}

// ────────────────────────────────────────────────────────────
// Layer 0 — structured frontmatter cases
// ────────────────────────────────────────────────────────────

#[test]
fn frontmatter_picks_sdl2() {
    let cache = "---\nframework: sdl2\nframework_display: C++ with SDL2\n---\n";
    let selected = select_backend(SelectorInputs {
        arch_cache: cache,
        link_flags: &[],
    });
    assert_eq!(selected.matched_layer, SelectorLayer::StructuredFrontmatter);
    assert_eq!(selected.backend.name(), "SDL2");
    assert_eq!(selected.framework_display, "C++ with SDL2");
}

#[test]
fn frontmatter_picks_glfw() {
    let cache = "---\nframework: glfw\nframework_display: C++ with GLFW + OpenGL 3.3\n---\n";
    let selected = select_backend(SelectorInputs {
        arch_cache: cache,
        link_flags: &[],
    });
    assert_eq!(selected.matched_layer, SelectorLayer::StructuredFrontmatter);
    assert_eq!(selected.backend.name(), "GLFW");
    assert_eq!(selected.framework_display, "C++ with GLFW + OpenGL 3.3");
}

#[test]
fn frontmatter_picks_raylib() {
    // Phase 10c — raylib is a real option.
    let cache = "---\nframework: raylib\nframework_display: C++ with raylib 5.0\n---\n";
    let selected = select_backend(SelectorInputs {
        arch_cache: cache,
        link_flags: &[],
    });
    assert_eq!(selected.matched_layer, SelectorLayer::StructuredFrontmatter);
    assert_eq!(selected.backend.name(), "raylib");
    assert_eq!(selected.framework_display, "C++ with raylib 5.0");
}

#[test]
fn markdown_header_picks_raylib() {
    let cache = "## Language & Framework\nC++ with raylib\n";
    let selected = select_backend(SelectorInputs {
        arch_cache: cache,
        link_flags: &[],
    });
    assert_eq!(selected.matched_layer, SelectorLayer::MarkdownHeader);
    assert_eq!(selected.backend.name(), "raylib");
}

#[test]
fn link_flags_only_picks_raylib() {
    let flags = vec!["-lraylib".to_string(), "-ldl".to_string()];
    let selected = select_backend(SelectorInputs {
        arch_cache: "",
        link_flags: &flags,
    });
    assert_eq!(selected.matched_layer, SelectorLayer::LinkFlagScan);
    assert_eq!(selected.backend.name(), "raylib");
}

#[test]
fn frontmatter_with_unknown_framework_falls_through_to_layer_1() {
    // Layer 0 doesn't match (sokol not yet implemented), so we
    // try Layer 1 → also doesn't match → Layer 2 → no link flags
    // → Layer 3 fallback. Updated from `raylib` to `sokol` after
    // Phase 10c wired raylib as a real backend.
    let cache = "---\nframework: sokol\n---\n";
    let selected = select_backend(SelectorInputs {
        arch_cache: cache,
        link_flags: &[],
    });
    assert_eq!(selected.matched_layer, SelectorLayer::FallbackPathC);
}

#[test]
fn frontmatter_with_unknown_framework_falls_through_then_link_flag_match() {
    // Layer 0 fails (sokol not in our enum yet), Layer 1 fails
    // (no markdown header), Layer 2 succeeds (`-lglfw` in link flags).
    // Updated from `raylib` to `sokol` after Phase 10c wired raylib.
    let cache = "---\nframework: sokol\n---\n";
    let flags = vec!["-lglfw".to_string()];
    let selected = select_backend(SelectorInputs {
        arch_cache: cache,
        link_flags: &flags,
    });
    assert_eq!(selected.matched_layer, SelectorLayer::LinkFlagScan);
    assert_eq!(selected.backend.name(), "GLFW");
}

#[test]
fn frontmatter_framework_display_defaults_to_framework_when_missing() {
    let cache = "---\nframework: glfw\n---\n";
    let selected = select_backend(SelectorInputs {
        arch_cache: cache,
        link_flags: &[],
    });
    // Should default to the framework key
    assert_eq!(selected.framework_display, "glfw");
}

// ────────────────────────────────────────────────────────────
// Layer 1 — markdown header cases (pre-rev3 sidecars)
// ────────────────────────────────────────────────────────────

#[test]
fn markdown_header_picks_sdl2() {
    let cache = "# Architecture\n\n## Language & Framework\nC++ with SDL2\n";
    let selected = select_backend(SelectorInputs {
        arch_cache: cache,
        link_flags: &[],
    });
    assert_eq!(selected.matched_layer, SelectorLayer::MarkdownHeader);
    assert_eq!(selected.backend.name(), "SDL2");
}

#[test]
fn markdown_header_picks_glfw() {
    let cache = "## Language & Framework\nC++ with GLFW\n";
    let selected = select_backend(SelectorInputs {
        arch_cache: cache,
        link_flags: &[],
    });
    assert_eq!(selected.matched_layer, SelectorLayer::MarkdownHeader);
    assert_eq!(selected.backend.name(), "GLFW");
}

#[test]
fn markdown_header_handles_module_contract_section_after() {
    // The `## Module Contract` header should terminate the
    // `## Language & Framework` section's body extraction.
    let cache = "## Language & Framework\nC++ with SDL2\n## Module Contract\n- core.cpp: ...\n";
    let selected = select_backend(SelectorInputs {
        arch_cache: cache,
        link_flags: &[],
    });
    assert_eq!(selected.matched_layer, SelectorLayer::MarkdownHeader);
    assert_eq!(selected.backend.name(), "SDL2");
}

// ────────────────────────────────────────────────────────────
// Layer 2 — link flag fallback (pre-Phase-1 manifests)
// ────────────────────────────────────────────────────────────

#[test]
fn link_flags_only_picks_sdl2() {
    let flags = vec!["-lSDL2".to_string(), "-ldl".to_string()];
    let selected = select_backend(SelectorInputs {
        arch_cache: "",
        link_flags: &flags,
    });
    assert_eq!(selected.matched_layer, SelectorLayer::LinkFlagScan);
    assert_eq!(selected.backend.name(), "SDL2");
}

#[test]
fn link_flags_only_picks_glfw() {
    let flags = vec!["-lglfw".to_string(), "-lGL".to_string()];
    let selected = select_backend(SelectorInputs {
        arch_cache: "",
        link_flags: &flags,
    });
    assert_eq!(selected.matched_layer, SelectorLayer::LinkFlagScan);
    assert_eq!(selected.backend.name(), "GLFW");
}

#[test]
fn link_flags_handle_distro_variation() {
    // Distro variation — `-lglfw` vs `-lglfw3`. Substring match
    // catches both.
    let flags1 = vec!["-lglfw".to_string()];
    let flags2 = vec!["-lglfw3".to_string()];
    assert_eq!(
        select_backend(SelectorInputs {
            arch_cache: "",
            link_flags: &flags1,
        })
        .backend
        .name(),
        "GLFW"
    );
    assert_eq!(
        select_backend(SelectorInputs {
            arch_cache: "",
            link_flags: &flags2,
        })
        .backend
        .name(),
        "GLFW"
    );
}

// ────────────────────────────────────────────────────────────
// Layer 3 — Path C fallback
// ────────────────────────────────────────────────────────────

#[test]
fn empty_inputs_fall_to_path_c() {
    let selected = select_backend(SelectorInputs {
        arch_cache: "",
        link_flags: &[],
    });
    assert_eq!(selected.matched_layer, SelectorLayer::FallbackPathC);
}

#[test]
fn unknown_library_falls_to_path_c() {
    let cache = "## Language & Framework\nC++ with mystery_engine_v9\n";
    let flags = vec!["-lmystery".to_string()];
    let selected = select_backend(SelectorInputs {
        arch_cache: cache,
        link_flags: &flags,
    });
    assert_eq!(selected.matched_layer, SelectorLayer::FallbackPathC);
}

// ────────────────────────────────────────────────────────────
// Realistic project shapes — full arch cache examples
// ────────────────────────────────────────────────────────────

#[test]
fn realistic_sdl2_project_with_full_arch_cache() {
    let cache = r#"---
framework: sdl2
framework_display: C++ with SDL2
hmr_mode_hint: swap
window_initial_width: 800
window_initial_height: 600
---
# Architecture

## Language & Framework
C++ with SDL2

## Module Contract
- core.cpp: state + lifecycle
- gui.cpp: rendering
- shared.h: AppState struct

## Where User Code Goes
- Window setup → host_runner.cpp
- Rendering → gui_on_render
- State updates → core_on_update
"#;
    let selected = select_backend(SelectorInputs {
        arch_cache: cache,
        link_flags: &["-lSDL2".to_string(), "-ldl".to_string()],
    });
    assert_eq!(selected.matched_layer, SelectorLayer::StructuredFrontmatter);
    assert_eq!(selected.backend.name(), "SDL2");
    assert_eq!(selected.framework_display, "C++ with SDL2");
}

#[test]
fn realistic_glfw_project_with_full_arch_cache() {
    let cache = r#"---
framework: glfw
framework_display: C++ with GLFW + OpenGL
---
# Architecture

## Language & Framework
C++ with GLFW + OpenGL 3.3 core

## Module Contract
...
"#;
    let selected = select_backend(SelectorInputs {
        arch_cache: cache,
        link_flags: &["-lglfw".to_string(), "-lGL".to_string()],
    });
    assert_eq!(selected.matched_layer, SelectorLayer::StructuredFrontmatter);
    assert_eq!(selected.backend.name(), "GLFW");
}

#[test]
fn pre_rev3_sidecar_falls_to_markdown_layer() {
    // Pre-rev3 sidecars have NO YAML frontmatter — only markdown.
    // Layer 1 catches them and the selection still works.
    let cache = r#"# Architecture

## Language & Framework
C++ with GLFW

## Module Contract
- core.cpp: ...
- gui.cpp: ...
"#;
    let selected = select_backend(SelectorInputs {
        arch_cache: cache,
        link_flags: &["-lglfw".to_string()],
    });
    // Layer 1 should win because frontmatter is missing
    assert_eq!(selected.matched_layer, SelectorLayer::MarkdownHeader);
    assert_eq!(selected.backend.name(), "GLFW");
}

#[test]
fn pre_phase1_manifest_falls_to_link_flag_layer() {
    // Pre-Phase-1 (HMR_AGNOSTIC_ULTRAPLAN) projects have no arch
    // cache at all — only the manifest's link flags. Layer 2
    // catches them.
    let selected = select_backend(SelectorInputs {
        arch_cache: "",
        link_flags: &["-lSDL2".to_string()],
    });
    assert_eq!(selected.matched_layer, SelectorLayer::LinkFlagScan);
    assert_eq!(selected.backend.name(), "SDL2");
}
