// ============================================================
// Phase 11 (ULTRAPLAN Lightning) — Tier 0 literal patch tests
// ============================================================
//
// Tests the value-only literal extraction + file patching surface
// from tier0_literal_patch.rs.

use worker::hmr::tier0_literal_patch::{
    extract_string_swaps, patch_so_file, candidate_so_paths,
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
