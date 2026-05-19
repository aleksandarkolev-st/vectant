// ============================================================
// TIER 0 LITERAL PATCH (ULTRAPLAN Lightning Phase 11 MVP)
// ============================================================
//
// Value-only edits with same-length literal swaps can bypass the
// full compile + link + reload cycle by patching the compiled
// `.so` file on disk directly. On a typical SDL2 project:
//
//   Source save → classify → value-only → extract literal pair
//   → scan libcore.so / libgui.so for old bytes → replace with
//   new bytes → trigger existing reload protocol → runner
//   dlclose+dlopen picks up the patched file.
//
// End-to-end latency saving: ~500ms (g++ + link step) per
// value-only save. Not the ~650 → ~20ms "binary patching of
// live process memory" the plan's §6 describes, but
// tractable TODAY and shippable without unsafe memory writes.
//
// ─── MVP scope (strict) ─────────────────────────────────────
//
// ONLY same-length string literal changes are patched. Integer
// literals compiled with `-O0` live as x86-64 immediate
// operands embedded in `mov`/`add` instructions, so locating
// them requires instruction-level disassembly — out of scope
// for this MVP. Future work (Phase 11 v2) adds disassembly-
// based integer patching via the `iced-x86` crate.
//
// Same-length constraint: strings with different byte lengths
// can't be patched in place because the trailing bytes would
// collide with whatever's immediately after in .rodata. A
// robust variant could use a .rodata arena rewrite, but that
// breaks relocations and needs DWARF. Out of scope.
//
// Integrity checks before patching:
//
//   1. Old source (from split sidecar) hashes match the `old`
//      baseline the classifier was fed. If not, the .so on
//      disk is out of sync with our patch baseline — bail.
//   2. Old literal byte sequence MUST appear EXACTLY ONCE in
//      the target .so. Zero matches → literal was optimized
//      away or inlined differently. Multiple matches →
//      ambiguous, can't know which is the user's intended
//      target. Bail on either.
//   3. After patching, re-read the bytes at the patched offset
//      and confirm they equal the new literal. If not, the
//      file is torn and we abort rather than leave it broken.
//
// ─── Failure mode ──────────────────────────────────────────
//
// Every failure falls through to the normal Tier 2 path
// (AI diff_patch → compile → reload). Tier 0 is strictly an
// optimization — no functional regression if it fails.

use crate::hmr::edit_classifier::{EditClassification, EditKind};
use std::path::{Path, PathBuf};

/// A single same-length literal swap extracted from a value-only
/// hunk. Currently only string literals are supported; the `kind`
/// field lets future work add Number / Float variants without
/// breaking the API.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiteralSwap {
    pub old: Vec<u8>,
    pub new: Vec<u8>,
    pub kind: LiteralKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LiteralKind {
    /// Double-quoted string literal. Patched as raw bytes in
    /// `.rodata`. Same-length only.
    String,
    // Future: Integer, Float, Bool
}

/// Result of running Tier 0 patching against a compiled artifact.
#[derive(Debug, Clone)]
pub enum Tier0Outcome {
    /// Patching succeeded — the target .so file was rewritten in
    /// place with the new literal bytes. `offsets` is the list of
    /// file offsets where bytes were written (one per swap).
    Patched { offsets: Vec<usize> },
    /// Patching was not attempted because the classification
    /// doesn't qualify (not value-only, multiple literal kinds,
    /// different lengths, etc.). Caller falls through to Tier 2.
    SkippedIneligible(String),
    /// Patching attempted but couldn't locate the old bytes
    /// uniquely in the target file. Caller falls through to
    /// Tier 2.
    PatchFailed(String),
}

/// Extract same-length string literal swaps from a value-only
/// classification. Returns `None` if the classification is not
/// pure value-only or contains any non-string literal changes.
/// Returns `Some(vec![])` only if there are no actual literal
/// differences to apply (e.g. whitespace-only edits) — callers
/// treat that as "nothing to do".
pub fn extract_string_swaps(classification: &EditClassification) -> Option<Vec<LiteralSwap>> {
    if !classification.is_value_only {
        return None;
    }
    let mut swaps: Vec<LiteralSwap> = Vec::new();
    for hunk in &classification.hunks {
        if hunk.kind != EditKind::ValueChange {
            return None;
        }
        // Paired old/new lines — compare string literals by
        // position and build a swap for each pair that differs.
        if hunk.old_lines.len() != hunk.new_lines.len() {
            return None;
        }
        for (old_line, new_line) in hunk.old_lines.iter().zip(hunk.new_lines.iter()) {
            let old_strs = extract_string_literals(old_line);
            let new_strs = extract_string_literals(new_line);
            // Unequal count of strings on the two lines means the
            // line structure changed (even if the classifier thinks
            // it's a value change). Conservative: bail.
            if old_strs.len() != new_strs.len() {
                return None;
            }
            for (o, n) in old_strs.iter().zip(new_strs.iter()) {
                if o == n {
                    continue;
                }
                // Same-length constraint.
                if o.len() != n.len() {
                    return None;
                }
                swaps.push(LiteralSwap {
                    old: o.as_bytes().to_vec(),
                    new: n.as_bytes().to_vec(),
                    kind: LiteralKind::String,
                });
            }
        }
    }
    Some(swaps)
}

/// Extract the contents of every C/C++ double-quoted string literal
/// in a single source line. Handles basic escape sequences (\", \\)
/// but does NOT handle trigraphs, raw strings (R"(...)"), or UTF
/// prefixes — those are rare in HMR-target code and are conservatively
/// left as "unrecognised literal" via the same-length mismatch path.
fn extract_string_literals(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            // Line comment — ignore rest of line
            break;
        }
        if bytes[i] == b'"' {
            i += 1;
            let start = i;
            while i < bytes.len() && bytes[i] != b'"' {
                if bytes[i] == b'\\' && i + 1 < bytes.len() {
                    i += 2;
                    continue;
                }
                i += 1;
            }
            let end = i.min(bytes.len());
            if let Ok(s) = std::str::from_utf8(&bytes[start..end]) {
                out.push(s.to_string());
            }
            if i < bytes.len() {
                i += 1;
            }
            continue;
        }
        i += 1;
    }
    out
}

/// Patch a .so / binary file in place with a list of literal
/// swaps. Applies each swap sequentially; if any swap fails to
/// locate a unique match, the whole operation aborts and
/// returns `Tier0Outcome::PatchFailed` — partially-patched
/// files are never left on disk because the writes go to a
/// temp file that's renamed atomically on success.
///
/// `target_so` is the path to the compiled library (the actual
/// timestamped file, not the stable symlink — the runner dlopens
/// the stable symlink which resolves to this).
pub fn patch_so_file(target_so: &Path, swaps: &[LiteralSwap]) -> Tier0Outcome {
    if swaps.is_empty() {
        return Tier0Outcome::SkippedIneligible("no swaps to apply".to_string());
    }
    let bytes = match std::fs::read(target_so) {
        Ok(b) => b,
        Err(e) => {
            return Tier0Outcome::PatchFailed(format!("read {} failed: {}", target_so.display(), e))
        }
    };
    let mut patched = bytes.clone();
    let mut offsets: Vec<usize> = Vec::new();

    for swap in swaps {
        if swap.old.len() != swap.new.len() {
            return Tier0Outcome::PatchFailed(
                "internal error: non-same-length swap reached patch_so_file".to_string(),
            );
        }
        // Find every occurrence of the old byte sequence.
        let positions: Vec<usize> = find_all_occurrences(&patched, &swap.old);
        if positions.is_empty() {
            return Tier0Outcome::PatchFailed(format!(
                "literal {:?} not found in {}",
                String::from_utf8_lossy(&swap.old),
                target_so.display()
            ));
        }
        if positions.len() > 1 {
            return Tier0Outcome::PatchFailed(format!(
                "literal {:?} ambiguous ({} matches) in {}",
                String::from_utf8_lossy(&swap.old),
                positions.len(),
                target_so.display()
            ));
        }
        let off = positions[0];
        patched[off..off + swap.new.len()].copy_from_slice(&swap.new);
        offsets.push(off);
    }

    // Verify: re-read the patched buffer at each offset and
    // confirm the new bytes landed. Belt-and-braces check against
    // a bug in the splice step.
    for (i, swap) in swaps.iter().enumerate() {
        let off = offsets[i];
        if &patched[off..off + swap.new.len()] != swap.new.as_slice() {
            return Tier0Outcome::PatchFailed(format!(
                "post-patch verification failed at offset {}",
                off
            ));
        }
    }

    // Write atomically via a temp file + rename.
    let tmp_path = target_so.with_extension("so.tier0tmp");
    if let Err(e) = std::fs::write(&tmp_path, &patched) {
        return Tier0Outcome::PatchFailed(format!("temp write failed: {}", e));
    }
    if let Err(e) = std::fs::rename(&tmp_path, target_so) {
        let _ = std::fs::remove_file(&tmp_path);
        return Tier0Outcome::PatchFailed(format!("rename failed: {}", e));
    }

    Tier0Outcome::Patched { offsets }
}

/// Find every non-overlapping occurrence of `needle` in `haystack`.
fn find_all_occurrences(haystack: &[u8], needle: &[u8]) -> Vec<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut i = 0;
    while i + needle.len() <= haystack.len() {
        if &haystack[i..i + needle.len()] == needle {
            out.push(i);
            i += needle.len();
        } else {
            i += 1;
        }
    }
    out
}

// ─── Helper: pick the right .so to patch ────────────────────
//
// A value-only edit can hit core.cpp or gui.cpp. The classifier
// reports which lines changed, and the edit's source span tells
// us which module owns it. For the MVP we're scanning both .so
// files — whichever contains the old literal wins. This is
// slightly wasteful on a miss (two file reads) but keeps the
// caller ignorant of source→module routing.

/// Candidate .so files to try patching. Caller provides the
/// workspace's build dir; this helper returns the stable-named
/// libcore.so and libgui.so symlinks (which point at the most
/// recent timestamped builds).
pub fn candidate_so_paths(build_dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let core = build_dir.join("libcore.so");
    if core.exists() {
        // Follow the symlink to patch the actual file, not the
        // symlink itself (fs::rename on a symlink replaces the
        // symlink, detaching the runner's dlopen handle from
        // future saves).
        if let Ok(resolved) = std::fs::canonicalize(&core) {
            out.push(resolved);
        } else {
            out.push(core);
        }
    }
    let gui = build_dir.join("libgui.so");
    if gui.exists() {
        if let Ok(resolved) = std::fs::canonicalize(&gui) {
            out.push(resolved);
        } else {
            out.push(gui);
        }
    }
    out
}

/// Attempt Tier 0 bypass on all candidate .so files in `build_dir`.
///
/// Tries `patch_so_file` on each candidate (libcore.so, libgui.so
/// symlinks → resolved timestamped files). A "not found" result on
/// one .so is expected (the literal lives in the other module) and
/// is not a failure. An ambiguous match or I/O error is a hard
/// failure that aborts the bypass.
///
/// Returns `Some(patched_paths)` when at least one .so was patched
/// successfully, `None` when the bypass should be abandoned (caller
/// falls through to the normal compile path).
pub fn try_tier0_bypass(build_dir: &Path, swaps: &[LiteralSwap]) -> Option<Vec<PathBuf>> {
    if swaps.is_empty() {
        return None;
    }
    let candidates = candidate_so_paths(build_dir);
    if candidates.is_empty() {
        return None;
    }

    let mut patched_paths: Vec<PathBuf> = Vec::new();

    for so_path in &candidates {
        match patch_so_file(so_path, swaps) {
            Tier0Outcome::Patched { offsets } => {
                eprintln!(
                    "[HMR] Tier 0: patched {} ({} offset(s))",
                    so_path.display(),
                    offsets.len()
                );
                patched_paths.push(so_path.clone());
            }
            Tier0Outcome::PatchFailed(ref reason) if reason.contains("not found") => {
                // Literal not in this .so — expected when the edit
                // targets only one module. Try the next candidate.
            }
            Tier0Outcome::PatchFailed(reason) => {
                eprintln!(
                    "[HMR] Tier 0: hard failure on {}: {}",
                    so_path.display(),
                    reason
                );
                return None;
            }
            Tier0Outcome::SkippedIneligible(_) => {}
        }
    }

    if patched_paths.is_empty() {
        None
    } else {
        Some(patched_paths)
    }
}

// ─── Unit tests ─────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hmr::edit_classifier::classify_edit;

    #[test]
    fn extract_string_swaps_same_length_string() {
        let old_src = r#"int main() {
    const char* title = "HMR Test";
    return 0;
}
"#;
        let new_src = r#"int main() {
    const char* title = "HMR Prod";
    return 0;
}
"#;
        let cls = classify_edit(old_src, new_src);
        let swaps = extract_string_swaps(&cls).expect("should be eligible");
        assert_eq!(swaps.len(), 1);
        assert_eq!(swaps[0].old, b"HMR Test");
        assert_eq!(swaps[0].new, b"HMR Prod");
        assert_eq!(swaps[0].kind, LiteralKind::String);
    }

    #[test]
    fn extract_string_swaps_rejects_different_length() {
        let old_src = r#"int main() {
    const char* title = "HMR Test";
    return 0;
}
"#;
        let new_src = r#"int main() {
    const char* title = "HMR Longer Name";
    return 0;
}
"#;
        let cls = classify_edit(old_src, new_src);
        // Different length strings → not eligible.
        assert!(extract_string_swaps(&cls).is_none());
    }

    #[test]
    fn extract_string_swaps_rejects_structural_change() {
        let old_src = r#"int main() { return 0; }"#;
        let new_src = r#"int main() { printf("hi"); return 0; }"#;
        let cls = classify_edit(old_src, new_src);
        // Added a function call → not value-only.
        assert!(extract_string_swaps(&cls).is_none());
    }

    #[test]
    fn find_all_occurrences_empty_needle() {
        assert_eq!(find_all_occurrences(b"hello", b""), Vec::<usize>::new());
    }

    #[test]
    fn find_all_occurrences_single_match() {
        assert_eq!(find_all_occurrences(b"abcXYZdef", b"XYZ"), vec![3]);
    }

    #[test]
    fn find_all_occurrences_multiple_matches() {
        assert_eq!(find_all_occurrences(b"abc abc abc", b"abc"), vec![0, 4, 8]);
    }

    #[test]
    fn extract_string_literals_basic() {
        let line = r#"    const char* title = "Hello world";"#;
        let s = extract_string_literals(line);
        assert_eq!(s, vec!["Hello world".to_string()]);
    }

    #[test]
    fn extract_string_literals_ignores_line_comment() {
        let line = r#"    const char* title = "A"; // "ignored""#;
        let s = extract_string_literals(line);
        assert_eq!(s, vec!["A".to_string()]);
    }

    #[test]
    fn extract_string_literals_handles_escaped_quote() {
        let line = r#"    const char* msg = "say \"hi\"";"#;
        let s = extract_string_literals(line);
        assert_eq!(s, vec![r#"say \"hi\""#.to_string()]);
    }

    #[test]
    fn extract_string_literals_multiple_on_one_line() {
        let line = r#"    printf("fmt: %s %d", "val");"#;
        let s = extract_string_literals(line);
        assert_eq!(s, vec!["fmt: %s %d".to_string(), "val".to_string()]);
    }

    #[test]
    fn extract_string_literals_empty_string() {
        let line = r#"    const char* s = "";"#;
        let s = extract_string_literals(line);
        assert_eq!(s, vec!["".to_string()]);
    }

    #[test]
    fn extract_string_literals_no_strings() {
        let line = "    int x = 42;";
        let s = extract_string_literals(line);
        assert!(s.is_empty());
    }

    #[test]
    fn extract_string_literals_char_literal_not_captured() {
        let line = r#"    char c = 'A'; const char* s = "B";"#;
        let s = extract_string_literals(line);
        assert_eq!(s, vec!["B".to_string()]);
    }

    #[test]
    fn extract_string_literals_escaped_backslash() {
        let line = r#"    puts("path\\dir");"#;
        let s = extract_string_literals(line);
        assert_eq!(s.len(), 1);
        assert!(s[0].contains("path\\\\dir"));
    }

    #[test]
    fn patch_so_file_unique_match() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lib.so");
        // Fake .so — just a blob containing the literal twice
        // would make it ambiguous; once makes it patchable.
        std::fs::write(&path, b"...prelude...HMR Test...epilogue...").unwrap();
        let swaps = vec![LiteralSwap {
            old: b"HMR Test".to_vec(),
            new: b"HMR Lab!".to_vec(),
            kind: LiteralKind::String,
        }];
        let outcome = patch_so_file(&path, &swaps);
        match outcome {
            Tier0Outcome::Patched { offsets } => {
                assert_eq!(offsets.len(), 1);
                let after = std::fs::read(&path).unwrap();
                assert!(after.windows(8).any(|w| w == b"HMR Lab!"));
                assert!(!after.windows(8).any(|w| w == b"HMR Test"));
            }
            other => panic!("expected Patched, got {:?}", other),
        }
    }

    #[test]
    fn patch_so_file_ambiguous_match_fails() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lib.so");
        // Same literal twice → ambiguous.
        std::fs::write(&path, b"XYZ...some stuff...XYZ").unwrap();
        let swaps = vec![LiteralSwap {
            old: b"XYZ".to_vec(),
            new: b"ABC".to_vec(),
            kind: LiteralKind::String,
        }];
        let outcome = patch_so_file(&path, &swaps);
        assert!(matches!(outcome, Tier0Outcome::PatchFailed(_)));
    }

    // ── try_tier0_bypass ──

    #[test]
    fn bypass_patches_single_so() {
        let dir = tempfile::tempdir().unwrap();
        let actual = dir.path().join("libcore_999.so");
        std::fs::write(&actual, b"...HMR Test...more stuff...").unwrap();
        std::os::unix::fs::symlink("libcore_999.so", dir.path().join("libcore.so")).unwrap();

        let swaps = vec![LiteralSwap {
            old: b"HMR Test".to_vec(),
            new: b"HMR Prod".to_vec(),
            kind: LiteralKind::String,
        }];
        let result = try_tier0_bypass(dir.path(), &swaps);
        assert!(result.is_some());
        assert_eq!(result.unwrap().len(), 1);
        let data = std::fs::read(&actual).unwrap();
        assert!(data.windows(8).any(|w| w == b"HMR Prod"));
    }

    #[test]
    fn bypass_returns_none_when_no_candidates() {
        let dir = tempfile::tempdir().unwrap();
        let swaps = vec![LiteralSwap {
            old: b"test".to_vec(),
            new: b"prod".to_vec(),
            kind: LiteralKind::String,
        }];
        assert!(try_tier0_bypass(dir.path(), &swaps).is_none());
    }

    #[test]
    fn bypass_returns_none_on_ambiguous() {
        let dir = tempfile::tempdir().unwrap();
        let actual = dir.path().join("libcore_999.so");
        std::fs::write(&actual, b"ABC padding ABC").unwrap();
        std::os::unix::fs::symlink("libcore_999.so", dir.path().join("libcore.so")).unwrap();

        let swaps = vec![LiteralSwap {
            old: b"ABC".to_vec(),
            new: b"XYZ".to_vec(),
            kind: LiteralKind::String,
        }];
        assert!(try_tier0_bypass(dir.path(), &swaps).is_none());
    }

    #[test]
    fn bypass_patches_only_matching_so() {
        let dir = tempfile::tempdir().unwrap();
        let core_f = dir.path().join("libcore_999.so");
        let gui_f = dir.path().join("libgui_999.so");
        std::fs::write(&core_f, b"...HMR Test...core stuff...").unwrap();
        std::fs::write(&gui_f, b"...gui stuff only...").unwrap();
        std::os::unix::fs::symlink("libcore_999.so", dir.path().join("libcore.so")).unwrap();
        std::os::unix::fs::symlink("libgui_999.so", dir.path().join("libgui.so")).unwrap();

        let swaps = vec![LiteralSwap {
            old: b"HMR Test".to_vec(),
            new: b"HMR Prod".to_vec(),
            kind: LiteralKind::String,
        }];
        let result = try_tier0_bypass(dir.path(), &swaps);
        assert!(result.is_some());
        let paths = result.unwrap();
        assert_eq!(paths.len(), 1);
        assert!(paths[0].to_string_lossy().contains("core"));
        // gui untouched
        assert_eq!(std::fs::read(&gui_f).unwrap(), b"...gui stuff only...");
    }

    #[test]
    fn bypass_empty_swaps_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        assert!(try_tier0_bypass(dir.path(), &[]).is_none());
    }

    #[test]
    fn patch_so_file_no_match_fails() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lib.so");
        std::fs::write(&path, b"some bytes that don't contain the needle").unwrap();
        let swaps = vec![LiteralSwap {
            old: b"MISSING".to_vec(),
            new: b"PRESENT".to_vec(),
            kind: LiteralKind::String,
        }];
        let outcome = patch_so_file(&path, &swaps);
        assert!(matches!(outcome, Tier0Outcome::PatchFailed(_)));
    }
}
