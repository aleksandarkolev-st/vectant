// ============================================================
// Phase 5 (ULTRAPLAN) — Tier 2 4-module apply integration tests
// ============================================================
//
// Tests for `edit_applier::apply_edit_list` which gained a 4th edit
// target (host_runner) in Phase 5. The function is the dispatcher
// that handler.rs::Tier 2 uses to apply AI-produced edit lists to
// the four split files. Pulling it into edit_applier.rs (instead of
// hiding it as a private fn in handler.rs) made it independently
// testable from `tests/`.
//
// Coverage targets:
//
//   apply_edit_list — 4-target dispatch:
//     - all four modules accept edits independently
//     - host_runner edit applies without touching core/gui/shared
//     - core/gui/shared still work without host_runner edits
//     - mixed edit list across all 4 targets
//
//   apply_edit_list — error paths:
//     - unknown module → error mentions edit index
//     - first failing edit short-circuits, no partial state leaks
//       (caller discards local copies and falls through to Tier 3)
//     - empty anchor in middle of a list still propagates the index
//     - ambiguous anchor in host_runner module
//
//   apply_edit_list — ordering invariants:
//     - edits applied in source order (later edits see earlier results)
//     - InsertAfter on a host_runner anchor preserves trailing content
//
//   Edit serde:
//     - `module: "host_runner"` deserializes from JSON wire format
//     - parsing rejects unknown EditOperation values
//
// Why integration tests in `tests/` instead of inline `#[cfg(test)]`:
// the worker lib's test binary has pre-existing compile errors in
// unrelated wave* test modules. Same strategy as phase3 / phase4 tests.

use worker::hmr::edit_applier::{apply_edit_list, Edit, EditList, EditOperation};

// ============================================================
// Helpers
// ============================================================

fn edit(module: &str, op: EditOperation, anchor: &str, content: &str) -> Edit {
    Edit {
        module: module.to_string(),
        operation: op,
        anchor: anchor.to_string(),
        content: content.to_string(),
    }
}

const CORE: &str = "// CORE\nvoid core_on_update(State* s) { s->frame++; }\n";
const GUI: &str = "// GUI\nvoid gui_on_render(State* s) { draw(s); }\n";
const SHARED: &str = "// SHARED\nstruct State { int frame; };\n";
const HOST_RUNNER: &str = r#"// HOST_RUNNER
#include <SDL2/SDL.h>
int main() {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window* w = SDL_CreateWindow("App", 0, 0, 800, 600, 0);
    return 0;
}
"#;

// ============================================================
// 4-target dispatch
// ============================================================

#[test]
fn applies_to_core_only_other_modules_unchanged() {
    let edits = vec![edit(
        "core",
        EditOperation::Replace,
        "s->frame++",
        "s->frame += 2",
    )];
    let (c, g, s, h) = apply_edit_list(&edits, CORE, GUI, SHARED, HOST_RUNNER).unwrap();
    assert!(c.contains("s->frame += 2"));
    assert_eq!(g, GUI, "gui must be untouched");
    assert_eq!(s, SHARED, "shared must be untouched");
    assert_eq!(h, HOST_RUNNER, "host_runner must be untouched");
}

#[test]
fn applies_to_gui_only_other_modules_unchanged() {
    let edits = vec![edit(
        "gui",
        EditOperation::Replace,
        "draw(s)",
        "render_frame(s)",
    )];
    let (c, g, s, h) = apply_edit_list(&edits, CORE, GUI, SHARED, HOST_RUNNER).unwrap();
    assert_eq!(c, CORE);
    assert!(g.contains("render_frame(s)"));
    assert_eq!(s, SHARED);
    assert_eq!(h, HOST_RUNNER);
}

#[test]
fn applies_to_shared_only_other_modules_unchanged() {
    let edits = vec![edit(
        "shared",
        EditOperation::Replace,
        "int frame;",
        "int frame; int score;",
    )];
    let (c, g, s, h) = apply_edit_list(&edits, CORE, GUI, SHARED, HOST_RUNNER).unwrap();
    assert_eq!(c, CORE);
    assert_eq!(g, GUI);
    assert!(s.contains("int score"));
    assert_eq!(h, HOST_RUNNER);
}

#[test]
fn applies_to_host_runner_only_other_modules_unchanged() {
    let edits = vec![edit(
        "host_runner",
        EditOperation::Replace,
        "800, 600",
        "1280, 720",
    )];
    let (c, g, s, h) = apply_edit_list(&edits, CORE, GUI, SHARED, HOST_RUNNER).unwrap();
    assert_eq!(c, CORE);
    assert_eq!(g, GUI);
    assert_eq!(s, SHARED);
    assert!(h.contains("1280, 720"));
    assert!(!h.contains("800, 600"));
}

#[test]
fn applies_mixed_edit_list_across_all_four_modules() {
    let edits = vec![
        edit(
            "core",
            EditOperation::Replace,
            "s->frame++",
            "s->frame += 1",
        ),
        edit("gui", EditOperation::Replace, "draw(s)", "render(s)"),
        edit(
            "shared",
            EditOperation::Replace,
            "int frame;",
            "long frame;",
        ),
        edit(
            "host_runner",
            EditOperation::Replace,
            "\"App\"",
            "\"My App\"",
        ),
    ];
    let (c, g, s, h) = apply_edit_list(&edits, CORE, GUI, SHARED, HOST_RUNNER).unwrap();
    assert!(c.contains("s->frame += 1"));
    assert!(g.contains("render(s)"));
    assert!(s.contains("long frame"));
    assert!(h.contains("\"My App\""));
}

#[test]
fn empty_edit_list_returns_originals_unchanged() {
    let edits: Vec<Edit> = vec![];
    let (c, g, s, h) = apply_edit_list(&edits, CORE, GUI, SHARED, HOST_RUNNER).unwrap();
    assert_eq!(c, CORE);
    assert_eq!(g, GUI);
    assert_eq!(s, SHARED);
    assert_eq!(h, HOST_RUNNER);
}

// ============================================================
// Backward compat: 3-file projects (empty host_runner)
// ============================================================

#[test]
fn three_module_project_with_empty_host_runner_works() {
    // Pre-Phase-4 projects have no host_runner.cpp on disk → empty
    // string passed in. Edits targeting core/gui/shared should still
    // work; host_runner stays empty.
    let edits = vec![edit(
        "core",
        EditOperation::Replace,
        "s->frame++",
        "s->frame += 10",
    )];
    let (c, _, _, h) = apply_edit_list(&edits, CORE, GUI, SHARED, "").unwrap();
    assert!(c.contains("s->frame += 10"));
    assert_eq!(h, "");
}

#[test]
fn host_runner_edit_against_empty_host_runner_fails_loudly() {
    // If the AI produces a host_runner edit but the project has no
    // host_runner.cpp, the apply MUST fail (not silently swallow). The
    // failure message points at the missing anchor so the caller knows
    // to fall through to Tier 3.
    let edits = vec![edit(
        "host_runner",
        EditOperation::Replace,
        "SDL_CreateWindow",
        "SDL_CreateWindow_v2",
    )];
    let result = apply_edit_list(&edits, CORE, GUI, SHARED, "");
    assert!(
        result.is_err(),
        "host_runner edit against empty host_runner must fail"
    );
}

// ============================================================
// Error paths
// ============================================================

#[test]
fn unknown_module_returns_error_with_edit_index() {
    let edits = vec![
        edit(
            "core",
            EditOperation::Replace,
            "s->frame++",
            "s->frame += 1",
        ),
        edit(
            "nonsense_module",
            EditOperation::Replace,
            "anchor",
            "content",
        ),
    ];
    let err = apply_edit_list(&edits, CORE, GUI, SHARED, HOST_RUNNER)
        .expect_err("unknown module must return error");
    let msg = format!("{}", err);
    assert!(
        msg.contains("#1"),
        "error must mention edit index 1: {}",
        msg
    );
    assert!(
        msg.contains("nonsense_module"),
        "error must name the offending module: {}",
        msg
    );
}

#[test]
fn missing_anchor_in_host_runner_returns_error() {
    let edits = vec![edit(
        "host_runner",
        EditOperation::Replace,
        "this_anchor_does_not_exist_anywhere",
        "replacement",
    )];
    let err = apply_edit_list(&edits, CORE, GUI, SHARED, HOST_RUNNER)
        .expect_err("missing anchor must return error");
    let msg = format!("{}", err);
    assert!(
        msg.to_lowercase().contains("not found") || msg.to_lowercase().contains("anchor"),
        "error should mention anchor not found: {}",
        msg
    );
}

#[test]
fn ambiguous_anchor_in_host_runner_returns_error() {
    // Construct a host_runner where the anchor "frame_count++" appears
    // twice — the Edit::apply contract requires a unique anchor and
    // must reject ambiguous ones with a clear error so the caller can
    // fall back to Tier 3 with a meaningful diagnostic.
    let host_runner =
        "void on_frame() {\n    frame_count++;\n}\nvoid on_extra() {\n    frame_count++;\n}\n";
    let edits = vec![edit(
        "host_runner",
        EditOperation::Replace,
        "frame_count++",
        "frame_count += 2",
    )];
    let err = apply_edit_list(&edits, CORE, GUI, SHARED, host_runner)
        .expect_err("ambiguous anchor must return error");
    let msg = format!("{}", err);
    assert!(
        msg.to_lowercase().contains("ambiguous")
            || msg.to_lowercase().contains("found")
            || msg.to_lowercase().contains("multiple"),
        "error should mention ambiguity: {}",
        msg
    );
}

#[test]
fn first_failing_edit_short_circuits_no_disk_write() {
    // The contract: if any edit fails, the caller discards the entire
    // list (we test that locally by confirming Err propagates without
    // returning a partial result).
    let edits = vec![
        edit(
            "core",
            EditOperation::Replace,
            "s->frame++",
            "s->frame += 1",
        ),
        edit("gui", EditOperation::Replace, "missing_anchor", "anything"),
        // Third edit would succeed if reached, but should NOT be reached
        edit(
            "shared",
            EditOperation::Replace,
            "int frame;",
            "int frame; int score;",
        ),
    ];
    let result = apply_edit_list(&edits, CORE, GUI, SHARED, HOST_RUNNER);
    assert!(result.is_err(), "second edit failure must propagate");
    // No way to inspect partial state because the function only returns
    // Result<(...)> — the local copies are dropped on error. That IS
    // the contract: caller never sees half-applied state.
}

// ============================================================
// Ordering: later edits see earlier edit results
// ============================================================

#[test]
fn sequential_edits_to_same_module_chain_correctly() {
    // First edit replaces "5" with "10"; second edit then replaces
    // the new "10" with "20". If the second edit ran against the
    // original content it would fail (no "10" anywhere).
    let core = "int x = 5;\n";
    let edits = vec![
        edit("core", EditOperation::Replace, "5", "10"),
        edit("core", EditOperation::Replace, "10", "20"),
    ];
    let (c, _, _, _) = apply_edit_list(&edits, core, GUI, SHARED, HOST_RUNNER).unwrap();
    assert_eq!(c, "int x = 20;\n");
}

#[test]
fn sequential_edits_across_modules_are_independent() {
    let edits = vec![
        edit(
            "core",
            EditOperation::Replace,
            "s->frame++",
            "s->frame += 2",
        ),
        edit(
            "host_runner",
            EditOperation::Replace,
            "800, 600",
            "1280, 720",
        ),
        edit("gui", EditOperation::Replace, "draw(s)", "draw_v2(s)"),
    ];
    let (c, g, _, h) = apply_edit_list(&edits, CORE, GUI, SHARED, HOST_RUNNER).unwrap();
    assert!(c.contains("s->frame += 2"));
    assert!(g.contains("draw_v2(s)"));
    assert!(h.contains("1280, 720"));
}

#[test]
fn insert_after_anchor_in_host_runner_preserves_trailing() {
    let edits = vec![edit(
        "host_runner",
        EditOperation::InsertAfter,
        "SDL_Init(SDL_INIT_VIDEO);",
        "\n    SDL_Init(SDL_INIT_AUDIO);",
    )];
    let (_, _, _, h) = apply_edit_list(&edits, CORE, GUI, SHARED, HOST_RUNNER).unwrap();
    assert!(h.contains("SDL_Init(SDL_INIT_VIDEO);\n    SDL_Init(SDL_INIT_AUDIO);"));
    // Trailing content must still be there
    assert!(h.contains("SDL_CreateWindow"));
    assert!(h.contains("return 0;"));
}

#[test]
fn delete_anchor_in_host_runner_removes_only_anchor() {
    let host_runner = "before\nDELETE_ME\nafter\n";
    let edits = vec![edit(
        "host_runner",
        EditOperation::Delete,
        "DELETE_ME\n",
        "",
    )];
    let (_, _, _, h) = apply_edit_list(&edits, CORE, GUI, SHARED, host_runner).unwrap();
    assert_eq!(h, "before\nafter\n");
}

// ============================================================
// Edit serde — wire format compatibility
// ============================================================

#[test]
fn edit_with_module_host_runner_deserializes_from_json() {
    let json = r#"{
        "module": "host_runner",
        "operation": "insert_after",
        "anchor": "SDL_Init(SDL_INIT_VIDEO);",
        "content": "\n    SDL_Init(SDL_INIT_AUDIO);"
    }"#;
    let parsed: Edit = serde_json::from_str(json).expect("parses Edit");
    assert_eq!(parsed.module, "host_runner");
    assert_eq!(parsed.operation, EditOperation::InsertAfter);
    assert!(parsed.anchor.contains("SDL_Init"));
}

#[test]
fn edit_list_with_mixed_modules_deserializes_from_json() {
    let json = r#"{
        "edits": [
            {"module": "core", "operation": "replace", "anchor": "a", "content": "b"},
            {"module": "gui", "operation": "delete", "anchor": "x", "content": ""},
            {"module": "shared", "operation": "insert_before", "anchor": "y", "content": "z"},
            {"module": "host_runner", "operation": "insert_after", "anchor": "p", "content": "q"}
        ]
    }"#;
    let parsed: EditList = serde_json::from_str(json).expect("parses EditList");
    assert_eq!(parsed.edits.len(), 4);
    assert_eq!(parsed.edits[0].module, "core");
    assert_eq!(parsed.edits[1].module, "gui");
    assert_eq!(parsed.edits[2].module, "shared");
    assert_eq!(parsed.edits[3].module, "host_runner");
}

#[test]
fn edit_with_unknown_module_string_still_deserializes() {
    // Edit::module is a String, not an enum — apply_edit_list catches
    // unknown values at apply time. This is intentional: the wire
    // format stays loose so the AI can be wrong about the module name
    // without crashing the JSON parse.
    let json = r#"{
        "module": "wat",
        "operation": "replace",
        "anchor": "a",
        "content": "b"
    }"#;
    let parsed: Edit = serde_json::from_str(json).expect("parses Edit");
    assert_eq!(parsed.module, "wat");
    // But applying must reject:
    let err = apply_edit_list(&[parsed], "a", "g", "s", "h")
        .expect_err("unknown module must reject at apply");
    assert!(format!("{}", err).contains("wat"));
}

#[test]
fn edit_with_unknown_operation_fails_to_deserialize() {
    let json = r#"{
        "module": "core",
        "operation": "obliterate",
        "anchor": "a",
        "content": "b"
    }"#;
    let result: Result<Edit, _> = serde_json::from_str(json);
    assert!(
        result.is_err(),
        "unknown EditOperation must fail JSON parse, not silently default"
    );
}

// ============================================================
// Realistic Phase 5 scenario: change window size in host_runner
// ============================================================

#[test]
fn realistic_resize_window_only_touches_host_runner() {
    // The user changes window size from 800x600 to 1280x720 in their
    // source. The AI routes the change to host_runner (per the prompt's
    // "host_runner ownership" rule) instead of leaking it into core/gui.
    let edits = vec![edit(
        "host_runner",
        EditOperation::Replace,
        "800, 600, 0",
        "1280, 720, 0",
    )];
    let (c, g, s, h) = apply_edit_list(&edits, CORE, GUI, SHARED, HOST_RUNNER).unwrap();
    // Only host_runner changed
    assert_eq!(c, CORE);
    assert_eq!(g, GUI);
    assert_eq!(s, SHARED);
    assert!(h.contains("1280, 720"));
    assert!(!h.contains("800, 600"));
}

#[test]
fn realistic_add_audio_init_lands_in_host_runner() {
    // User adds SDL audio init alongside video init in their source.
    // The AI routes the new SDL_Init call into host_runner (library
    // init belongs to the runner per the prompt rules).
    let edits = vec![edit(
        "host_runner",
        EditOperation::Replace,
        "SDL_Init(SDL_INIT_VIDEO);",
        "SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO);",
    )];
    let (_, _, _, h) = apply_edit_list(&edits, CORE, GUI, SHARED, HOST_RUNNER).unwrap();
    assert!(h.contains("SDL_INIT_AUDIO"));
}
