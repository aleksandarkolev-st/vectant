// ============================================================
// TIER 0 UNIFIED PATCHER (Phase 11 — strings + integers)
// ============================================================
//
// Orchestrates both string literal and integer immediate patching
// using the tree-sitter AST classifier, DWARF line map, and
// iced-x86 disassembler.
//
// Flow:
//   1. classify_ast(old, new) → ValueOnly { changes }
//   2. For each LiteralChange:
//      - StringLiteral: same-length check → byte-scan in .rodata
//      - NumberLiteral: DWARF line→addr → iced-x86 find_immediates → patch
//   3. Returns Tier0V2Outcome with per-change results

use crate::hmr::ts_value_classifier::{classify_ast, AstClassification, LiteralChange, LiteralKind};
use crate::hmr::tier0_literal_patch::{
    LiteralSwap, LiteralKind as SwapKind, candidate_so_paths, patch_so_file, Tier0Outcome,
};
use crate::hmr::binary_patch::dwarf_line_map::line_to_addresses;
use crate::hmr::binary_patch::imm_patcher::{find_immediates, patch_immediate};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Tier0V2Result {
    pub string_patches: usize,
    pub integer_patches: usize,
    pub patched_paths: Vec<PathBuf>,
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone)]
pub enum Tier0V2Outcome {
    Patched(Tier0V2Result),
    Ineligible(String),
    Failed(String),
}

/// Run the unified Tier 0 pipeline: classify with tree-sitter,
/// then dispatch string and integer patches.
///
/// `build_dir`: workspace build directory (contains libcore.so/libgui.so symlinks)
/// `old_source`: the previous source content (from sidecar)
/// `new_source`: the current source content
/// `source_files`: list of (module_name, filename) pairs to try
///   for DWARF lookup, e.g. [("core", "core.cpp"), ("gui", "gui.cpp")]
pub fn try_tier0_v2(
    build_dir: &Path,
    old_source: &str,
    new_source: &str,
    source_files: &[(&str, &str)],
) -> Tier0V2Outcome {
    let classification = classify_ast(old_source, new_source);

    let changes = match classification {
        AstClassification::ValueOnly { changes } if changes.is_empty() => {
            return Tier0V2Outcome::Ineligible("no changes detected".to_string());
        }
        AstClassification::ValueOnly { changes } => changes,
        AstClassification::Structural => {
            return Tier0V2Outcome::Ineligible("structural change".to_string());
        }
        AstClassification::ParseError(e) => {
            return Tier0V2Outcome::Ineligible(format!("parse error: {}", e));
        }
    };

    let candidates = candidate_so_paths(build_dir);
    if candidates.is_empty() {
        return Tier0V2Outcome::Ineligible("no candidate .so files".to_string());
    }

    let mut string_changes: Vec<&LiteralChange> = Vec::new();
    let mut integer_changes: Vec<&LiteralChange> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();

    for change in &changes {
        match change.kind {
            LiteralKind::StringLiteral => {
                let old_inner = strip_quotes(&change.old_text);
                let new_inner = strip_quotes(&change.new_text);
                if old_inner.len() == new_inner.len() {
                    string_changes.push(change);
                } else {
                    skipped.push(format!(
                        "string length mismatch: {:?} ({}) → {:?} ({})",
                        old_inner, old_inner.len(), new_inner, new_inner.len()
                    ));
                }
            }
            LiteralKind::NumberLiteral => {
                integer_changes.push(change);
            }
            LiteralKind::CharLiteral | LiteralKind::True | LiteralKind::False => {
                skipped.push(format!("unsupported literal kind: {:?}", change.kind));
            }
        }
    }

    if string_changes.is_empty() && integer_changes.is_empty() {
        return Tier0V2Outcome::Ineligible(format!(
            "no patchable changes (skipped: {})",
            skipped.join("; ")
        ));
    }

    let mut patched_paths: Vec<PathBuf> = Vec::new();
    let mut string_patch_count = 0;
    let mut integer_patch_count = 0;

    // ── String patches (byte-scan in .rodata) ──
    if !string_changes.is_empty() {
        let swaps: Vec<LiteralSwap> = string_changes
            .iter()
            .map(|c| LiteralSwap {
                old: strip_quotes(&c.old_text).as_bytes().to_vec(),
                new: strip_quotes(&c.new_text).as_bytes().to_vec(),
                kind: SwapKind::String,
            })
            .collect();

        for so_path in &candidates {
            match patch_so_file(so_path, &swaps) {
                Tier0Outcome::Patched { offsets } => {
                    string_patch_count += offsets.len();
                    if !patched_paths.contains(so_path) {
                        patched_paths.push(so_path.clone());
                    }
                }
                Tier0Outcome::PatchFailed(ref reason) if reason.contains("not found") => {}
                Tier0Outcome::PatchFailed(reason) => {
                    return Tier0V2Outcome::Failed(format!("string patch: {}", reason));
                }
                Tier0Outcome::SkippedIneligible(_) => {}
            }
        }
    }

    // ── Integer patches (DWARF + iced-x86) ──
    for change in &integer_changes {
        let old_val: i64 = match parse_c_integer(&change.old_text) {
            Some(v) => v,
            None => {
                skipped.push(format!("unparseable old integer: {:?}", change.old_text));
                continue;
            }
        };
        let new_val: i64 = match parse_c_integer(&change.new_text) {
            Some(v) => v,
            None => {
                skipped.push(format!("unparseable new integer: {:?}", change.new_text));
                continue;
            }
        };

        let mut patched_this = false;
        for so_path in &candidates {
            for &(_module, filename) in source_files {
                let addrs = match line_to_addresses(so_path, filename, change.line as u32) {
                    Ok(a) => a,
                    Err(_) => continue,
                };
                if addrs.is_empty() {
                    continue;
                }

                let va_list: Vec<u64> = addrs.iter().map(|a| a.address).collect();
                let locs = match find_immediates(so_path, &va_list, Some(old_val)) {
                    Ok(l) => l,
                    Err(_) => continue,
                };

                if locs.len() == 1 {
                    if let Err(e) = patch_immediate(so_path, &locs[0], new_val) {
                        return Tier0V2Outcome::Failed(format!("integer patch: {}", e));
                    }
                    integer_patch_count += 1;
                    if !patched_paths.contains(so_path) {
                        patched_paths.push(so_path.clone());
                    }
                    patched_this = true;
                    break;
                } else if locs.len() > 1 {
                    skipped.push(format!(
                        "ambiguous: {} instructions with imm={} at line {}",
                        locs.len(), old_val, change.line
                    ));
                }
            }
            if patched_this {
                break;
            }
        }
        if !patched_this && !skipped.iter().any(|s| s.contains("ambiguous")) {
            skipped.push(format!(
                "integer {} not found in any .so at line {}",
                old_val, change.line
            ));
        }
    }

    if patched_paths.is_empty() {
        Tier0V2Outcome::Failed(format!(
            "no patches applied (skipped: {})",
            skipped.join("; ")
        ))
    } else {
        Tier0V2Outcome::Patched(Tier0V2Result {
            string_patches: string_patch_count,
            integer_patches: integer_patch_count,
            patched_paths,
            skipped,
        })
    }
}

fn strip_quotes(s: &str) -> &str {
    s.strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap_or(s)
}

fn parse_c_integer(text: &str) -> Option<i64> {
    let s = text.trim();
    if s.starts_with("0x") || s.starts_with("0X") {
        i64::from_str_radix(&s[2..], 16).ok()
    } else if s.starts_with("0b") || s.starts_with("0B") {
        i64::from_str_radix(&s[2..], 2).ok()
    } else if s.starts_with('0') && s.len() > 1 && !s.contains('.') {
        i64::from_str_radix(s, 8).ok()
    } else {
        // Strip common suffixes (u, l, ul, ll, ull, f)
        let cleaned = s.trim_end_matches(|c: char| c == 'u' || c == 'U' || c == 'l' || c == 'L' || c == 'f' || c == 'F');
        cleaned.parse::<i64>().ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_quotes_basic() {
        assert_eq!(strip_quotes(r#""hello""#), "hello");
        assert_eq!(strip_quotes("noquotes"), "noquotes");
    }

    #[test]
    fn parse_c_integer_decimal() {
        assert_eq!(parse_c_integer("42"), Some(42));
        assert_eq!(parse_c_integer("-1"), Some(-1));
        assert_eq!(parse_c_integer("800"), Some(800));
    }

    #[test]
    fn parse_c_integer_hex() {
        assert_eq!(parse_c_integer("0xFF"), Some(255));
        assert_eq!(parse_c_integer("0x1A"), Some(26));
    }

    #[test]
    fn parse_c_integer_suffixed() {
        assert_eq!(parse_c_integer("42u"), Some(42));
        assert_eq!(parse_c_integer("100UL"), Some(100));
        assert_eq!(parse_c_integer("0xFFull"), Some(255));
    }
}
