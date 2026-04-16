// ============================================================
// Phase 11 (ULTRAPLAN Lightning) — Tier 0 literal patch tests
// ============================================================
//
// Tests the value-only literal extraction + file patching surface
// from tier0_literal_patch.rs.

use worker::hmr::tier0_literal_patch::{
    extract_string_swaps, patch_so_file, candidate_so_paths, try_tier0_bypass,
    LiteralKind, LiteralSwap, Tier0Outcome,
};
use worker::hmr::edit_classifier::classify_edit;

// ── extract_string_swaps ──

#[test]
fn same_length_string_extracted() {
    let old = "    SDL_CreateWindow(\"HMR Test\", 0, 0, 800, 600, 0);";
    let new = "    SDL_CreateWindow(\"HMR Prod\", 0, 0, 800, 600, 0);";
    let cls = classify_edit(old, new);
    let swaps = extract_string_swaps(&cls).expect("value-only");
    assert_eq!(swaps.len(), 1);
    assert_eq!(swaps[0].old, b"HMR Test");
    assert_eq!(swaps[0].new, b"HMR Prod");
    assert_eq!(swaps[0].kind, LiteralKind::String);
}

#[test]
fn different_length_string_ineligible() {
    let old = "    printf(\"Short\");";
    let new = "    printf(\"Much Longer\");";
    let cls = classify_edit(old, new);
    assert!(extract_string_swaps(&cls).is_none());
}

#[test]
fn no_string_change_yields_empty_swaps() {
    let old = "    int x = 42;";
    let new = "    int x = 99;";
    let cls = classify_edit(old, new);
    // Integer-only changes: no STRING swaps.
    let swaps = extract_string_swaps(&cls);
    // Eligible (is_value_only = true) but no string literals → empty vec.
    if let Some(v) = swaps {
        assert!(v.is_empty());
    }
}

#[test]
fn structural_change_ineligible() {
    let old = "int main() { return 0; }";
    let new = "int main() { printf(\"hi\"); return 0; }";
    let cls = classify_edit(old, new);
    assert!(extract_string_swaps(&cls).is_none());
}

// ── patch_so_file ──

#[test]
fn patch_unique_occurrence() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lib.so");
    std::fs::write(&path, b"...prelude...HMR Test...epilogue...").unwrap();
    let swaps = vec![LiteralSwap {
        old: b"HMR Test".to_vec(),
        new: b"HMR Lab!".to_vec(),
        kind: LiteralKind::String,
    }];
    match patch_so_file(&path, &swaps) {
        Tier0Outcome::Patched { offsets } => {
            assert_eq!(offsets.len(), 1);
            let data = std::fs::read(&path).unwrap();
            assert!(data.windows(8).any(|w| w == b"HMR Lab!"));
            assert!(!data.windows(8).any(|w| w == b"HMR Test"));
        }
        other => panic!("expected Patched, got {:?}", other),
    }
}

#[test]
fn patch_ambiguous_fails() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lib.so");
    std::fs::write(&path, b"XYZ padding XYZ").unwrap();
    let swaps = vec![LiteralSwap {
        old: b"XYZ".to_vec(),
        new: b"ABC".to_vec(),
        kind: LiteralKind::String,
    }];
    assert!(matches!(
        patch_so_file(&path, &swaps),
        Tier0Outcome::PatchFailed(_)
    ));
}

#[test]
fn patch_no_match_fails() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lib.so");
    std::fs::write(&path, b"nothing matching").unwrap();
    let swaps = vec![LiteralSwap {
        old: b"MISSING".to_vec(),
        new: b"PRESENT".to_vec(),
        kind: LiteralKind::String,
    }];
    assert!(matches!(
        patch_so_file(&path, &swaps),
        Tier0Outcome::PatchFailed(_)
    ));
}

#[test]
fn patch_empty_swaps_skipped() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lib.so");
    std::fs::write(&path, b"anything").unwrap();
    assert!(matches!(
        patch_so_file(&path, &[]),
        Tier0Outcome::SkippedIneligible(_)
    ));
}

// ── candidate_so_paths ──

#[test]
fn candidate_paths_finds_symlinks() {
    let dir = tempfile::tempdir().unwrap();
    let core = dir.path().join("libcore_123.so");
    let gui = dir.path().join("libgui_123.so");
    std::fs::write(&core, b"fake").unwrap();
    std::fs::write(&gui, b"fake").unwrap();
    std::os::unix::fs::symlink("libcore_123.so", dir.path().join("libcore.so")).unwrap();
    std::os::unix::fs::symlink("libgui_123.so", dir.path().join("libgui.so")).unwrap();
    let paths = candidate_so_paths(dir.path());
    assert_eq!(paths.len(), 2);
    // canonicalize resolved the symlinks to the actual files.
    assert!(paths[0].ends_with("libcore_123.so"));
    assert!(paths[1].ends_with("libgui_123.so"));
}

#[test]
fn candidate_paths_empty_when_no_files() {
    let dir = tempfile::tempdir().unwrap();
    let paths = candidate_so_paths(dir.path());
    assert!(paths.is_empty());
}

// ── try_tier0_bypass ──

#[test]
fn bypass_patches_core_and_skips_gui() {
    let dir = tempfile::tempdir().unwrap();
    let core = dir.path().join("libcore_777.so");
    let gui = dir.path().join("libgui_777.so");
    std::fs::write(&core, b"...HMR Test...core logic...").unwrap();
    std::fs::write(&gui, b"...gui rendering only...").unwrap();
    std::os::unix::fs::symlink("libcore_777.so", dir.path().join("libcore.so")).unwrap();
    std::os::unix::fs::symlink("libgui_777.so", dir.path().join("libgui.so")).unwrap();

    let swaps = vec![LiteralSwap {
        old: b"HMR Test".to_vec(),
        new: b"HMR Live".to_vec(),
        kind: LiteralKind::String,
    }];
    let result = try_tier0_bypass(dir.path(), &swaps);
    assert!(result.is_some());
    let paths = result.unwrap();
    assert_eq!(paths.len(), 1);
    // Core was patched, gui untouched.
    let core_data = std::fs::read(&core).unwrap();
    assert!(core_data.windows(8).any(|w| w == b"HMR Live"));
    let gui_data = std::fs::read(&gui).unwrap();
    assert_eq!(gui_data, b"...gui rendering only...");
}

#[test]
fn bypass_returns_none_on_empty_dir() {
    let dir = tempfile::tempdir().unwrap();
    let swaps = vec![LiteralSwap {
        old: b"X".to_vec(),
        new: b"Y".to_vec(),
        kind: LiteralKind::String,
    }];
    assert!(try_tier0_bypass(dir.path(), &swaps).is_none());
}

#[test]
fn bypass_returns_none_on_ambiguous_literal() {
    let dir = tempfile::tempdir().unwrap();
    let core = dir.path().join("libcore_777.so");
    std::fs::write(&core, b"dup dup").unwrap();
    std::os::unix::fs::symlink("libcore_777.so", dir.path().join("libcore.so")).unwrap();

    let swaps = vec![LiteralSwap {
        old: b"dup".to_vec(),
        new: b"uni".to_vec(),
        kind: LiteralKind::String,
    }];
    assert!(try_tier0_bypass(dir.path(), &swaps).is_none());
}

#[test]
fn bypass_patches_both_sos_when_literal_in_both() {
    let dir = tempfile::tempdir().unwrap();
    let core = dir.path().join("libcore_777.so");
    let gui = dir.path().join("libgui_777.so");
    std::fs::write(&core, b"SHARED_LIT...core").unwrap();
    std::fs::write(&gui, b"SHARED_LIT...gui_").unwrap();
    std::os::unix::fs::symlink("libcore_777.so", dir.path().join("libcore.so")).unwrap();
    std::os::unix::fs::symlink("libgui_777.so", dir.path().join("libgui.so")).unwrap();

    let swaps = vec![LiteralSwap {
        old: b"SHARED_LIT".to_vec(),
        new: b"PATCHED_OK".to_vec(),
        kind: LiteralKind::String,
    }];
    let result = try_tier0_bypass(dir.path(), &swaps);
    assert!(result.is_some());
    assert_eq!(result.unwrap().len(), 2);
    assert!(std::fs::read(&core).unwrap().windows(10).any(|w| w == b"PATCHED_OK"));
    assert!(std::fs::read(&gui).unwrap().windows(10).any(|w| w == b"PATCHED_OK"));
}

// ── End-to-end pipeline tests ──
//
// Realistic C++ source edits → classify_edit → extract_string_swaps
// → try_tier0_bypass. Validates the entire Tier 0 pipeline from
// source-level diff to binary patch.

#[test]
fn e2e_sdl_window_title_change() {
    let old = r#"#include "shared.h"
void core_on_load(void* state) {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_CreateWindow("My Game", 0, 0, 800, 600, 0);
}
"#;
    let new = r#"#include "shared.h"
void core_on_load(void* state) {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_CreateWindow("My App!", 0, 0, 800, 600, 0);
}
"#;
    let cls = classify_edit(old, new);
    assert!(cls.is_value_only);
    let swaps = extract_string_swaps(&cls).expect("eligible");
    assert_eq!(swaps.len(), 1);
    assert_eq!(swaps[0].old, b"My Game");
    assert_eq!(swaps[0].new, b"My App!");

    let dir = tempfile::tempdir().unwrap();
    let so = dir.path().join("libcore_100.so");
    std::fs::write(&so, b"\0\0My Game\0\0rest of binary").unwrap();
    std::os::unix::fs::symlink("libcore_100.so", dir.path().join("libcore.so")).unwrap();

    let result = try_tier0_bypass(dir.path(), &swaps).expect("should patch");
    assert_eq!(result.len(), 1);
    let data = std::fs::read(&so).unwrap();
    assert!(data.windows(7).any(|w| w == b"My App!"));
    assert!(!data.windows(7).any(|w| w == b"My Game"));
}

#[test]
fn e2e_multiple_literals_same_line() {
    let old = r#"    printf("Hello %s", "World");"#;
    let new = r#"    printf("Hallo %s", "Welt!");"#;
    let cls = classify_edit(old, new);
    let swaps = extract_string_swaps(&cls);
    // "Hello %s"→"Hallo %s" is same length (8 chars each)
    // "World"→"Welt!" is same length (5 chars each)
    assert!(swaps.is_some());
    let swaps = swaps.unwrap();
    assert_eq!(swaps.len(), 2);
}

#[test]
fn e2e_structural_edit_rejects() {
    let old = r#"void core_on_load(void* state) {
    int x = 42;
}
"#;
    let new = r#"void core_on_load(void* state) {
    int x = 42;
    printf("added line");
}
"#;
    let cls = classify_edit(old, new);
    assert!(!cls.is_value_only);
    assert!(extract_string_swaps(&cls).is_none());
}

#[test]
fn e2e_different_length_literal_rejects() {
    let old = r#"    const char* msg = "Short";"#;
    let new = r#"    const char* msg = "Loong";"#;
    let cls = classify_edit(old, new);
    let swaps = extract_string_swaps(&cls);
    // Same length (5 chars each) — should be eligible
    assert!(swaps.is_some());
    assert_eq!(swaps.unwrap().len(), 1);

    // Now test actually different lengths
    let old2 = r#"    const char* msg = "Short";"#;
    let new2 = r#"    const char* msg = "Much Longer";"#;
    let cls2 = classify_edit(old2, new2);
    assert!(extract_string_swaps(&cls2).is_none());
}

#[test]
fn e2e_escaped_quotes_in_literal() {
    let old = r#"    puts("say \"hi\"");"#;
    let new = r#"    puts("say \"yo\"");"#;
    let cls = classify_edit(old, new);
    let swaps = extract_string_swaps(&cls);
    assert!(swaps.is_some());
    let s = swaps.unwrap();
    assert_eq!(s.len(), 1);
    // The escaped content "say \"hi\"" vs "say \"yo\""
    assert_eq!(s[0].old.len(), s[0].new.len());
}

#[test]
fn e2e_integer_only_change_no_string_swaps() {
    let old = r#"    int width = 800;
    int height = 600;"#;
    let new = r#"    int width = 900;
    int height = 700;"#;
    let cls = classify_edit(old, new);
    assert!(cls.is_value_only);
    let swaps = extract_string_swaps(&cls);
    // Value-only but no string literals → Some(empty)
    match swaps {
        Some(v) => assert!(v.is_empty()),
        None => {} // also acceptable
    }
}

#[test]
fn e2e_multiline_value_edit() {
    let old = r#"#include "shared.h"
void setup() {
    set_title("Title A");
    set_bg_color("red__");
}
"#;
    let new = r#"#include "shared.h"
void setup() {
    set_title("Title B");
    set_bg_color("blue_");
}
"#;
    let cls = classify_edit(old, new);
    assert!(cls.is_value_only);
    let swaps = extract_string_swaps(&cls).expect("eligible");
    assert_eq!(swaps.len(), 2);

    let dir = tempfile::tempdir().unwrap();
    let so = dir.path().join("libcore_200.so");
    std::fs::write(&so, b"\0Title A\0\0red__\0rest").unwrap();
    std::os::unix::fs::symlink("libcore_200.so", dir.path().join("libcore.so")).unwrap();

    let result = try_tier0_bypass(dir.path(), &swaps).expect("should patch");
    assert_eq!(result.len(), 1);
    let data = std::fs::read(&so).unwrap();
    assert!(data.windows(7).any(|w| w == b"Title B"));
    assert!(data.windows(5).any(|w| w == b"blue_"));
}
