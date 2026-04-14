// ============================================================
// EDIT APPLIER
// ============================================================
//
// Applies a list of structured edits produced by the AI diff-patch
// endpoint to the content of split modules. This is the Rust-side
// counterpart to the "diff-only output format" introduced in the
// /refactor/diff_patch prompt rewrite.
//
// The AI no longer returns full updated module files. Instead, it
// returns a list of edits of the form:
//
//   {
//     "module": "core" | "gui" | "shared",
//     "operation": "insert_after" | "insert_before" | "replace" | "delete",
//     "anchor":    "<exact unique substring from the current module>",
//     "content":   "<new code to insert or replacement>"
//   }
//
// Rust finds the anchor via `content.match_indices(&anchor)`, which
// works at the byte level and respects newlines. Both of the following
// must hold for an edit to apply:
//
//   1. The anchor occurs EXACTLY ONCE in the module (not zero, not
//      multiple). The AI is instructed in the prompt to pick a
//      substring with enough surrounding context to be unique.
//   2. The operation is one of the four supported kinds.
//
// Any failure (anchor not found, anchor ambiguous, unknown operation)
// short-circuits Tier 2 and handler.rs falls through to Tier 3 full
// re-split. No partial application.
//
// Why this exists: the previous diff_patch flow asked the AI to
// regenerate the entire updated `.cpp` or `.h` file (~2500-4000 output
// tokens per edit). At pro-model generation speed (~100 tok/s) that's
// 25-40s of generation alone, never mind network. By shipping back
// just the edit instructions (~100 output tokens), generation drops
// to ~1s and end-to-end edit latency goes from 6-12s down to 2-3s.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EditOperation {
    /// Insert `content` immediately after the anchor.
    InsertAfter,
    /// Insert `content` immediately before the anchor.
    InsertBefore,
    /// Replace the anchor with `content`.
    Replace,
    /// Delete the anchor (and only the anchor). `content` is ignored.
    Delete,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edit {
    /// Which split module this edit targets. One of "core", "gui", "shared".
    pub module: String,
    pub operation: EditOperation,
    /// A substring of the current module content that locates the edit.
    /// MUST be unique within the module. Non-unique → apply fails.
    pub anchor: String,
    /// The new text to insert or replace with. Applied verbatim.
    /// Ignored for `Delete`.
    #[serde(default)]
    pub content: String,
}

/// Response envelope from /refactor/diff_patch in the new diff-only format.
/// Extra fields (like `elapsed_seconds`) are ignored thanks to serde's
/// default forgiving behavior on structs.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EditList {
    #[serde(default)]
    pub edits: Vec<Edit>,
}

/// Apply a single edit to `content`. Returns the modified content or an
/// error if the anchor is missing or ambiguous. The caller is responsible
/// for dispatching the edit to the correct module (core/gui/shared).
pub fn apply_edit(content: &str, edit: &Edit) -> Result<String> {
    if edit.anchor.is_empty() {
        bail!("edit anchor is empty (module={:?}, op={:?})", edit.module, edit.operation);
    }

    // Count occurrences. Must be exactly 1 for a safe apply.
    let matches: Vec<usize> = content
        .match_indices(&edit.anchor)
        .map(|(idx, _)| idx)
        .collect();

    if matches.is_empty() {
        bail!(
            "edit anchor not found in module {:?} (op={:?}): {:?}",
            edit.module,
            edit.operation,
            truncate(&edit.anchor, 120)
        );
    }
    if matches.len() > 1 {
        bail!(
            "edit anchor is ambiguous (found {} times) in module {:?} (op={:?}): {:?}",
            matches.len(),
            edit.module,
            edit.operation,
            truncate(&edit.anchor, 120)
        );
    }

    let start = matches[0];
    let end = start + edit.anchor.len();

    let out = match edit.operation {
        EditOperation::InsertAfter => {
            let mut s = String::with_capacity(content.len() + edit.content.len());
            s.push_str(&content[..end]);
            s.push_str(&edit.content);
            s.push_str(&content[end..]);
            s
        }
        EditOperation::InsertBefore => {
            let mut s = String::with_capacity(content.len() + edit.content.len());
            s.push_str(&content[..start]);
            s.push_str(&edit.content);
            s.push_str(&content[start..]);
            s
        }
        EditOperation::Replace => {
            let mut s = String::with_capacity(content.len() - edit.anchor.len() + edit.content.len());
            s.push_str(&content[..start]);
            s.push_str(&edit.content);
            s.push_str(&content[end..]);
            s
        }
        EditOperation::Delete => {
            let mut s = String::with_capacity(content.len() - edit.anchor.len());
            s.push_str(&content[..start]);
            s.push_str(&content[end..]);
            s
        }
    };

    Ok(out)
}

fn truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max_chars).collect();
        format!("{}...", cut)
    }
}

/// ULTRAPLAN Phase 5: apply a list of AI-produced edits to the four
/// split modules. Returns the patched contents in source order
/// `(core, gui, shared, host_runner)` or propagates the first error.
///
/// Each `Edit` carries its own `module` field; this dispatcher routes
/// it to the matching string and calls `apply_edit`. Edits are applied
/// in order; if edit N fails, edits 0..N-1 are already applied in the
/// local copies but since we return `Err`, the caller MUST discard them
/// and fall through to a full re-split — no partial state to disk.
///
/// Module field accepts `"core"`, `"gui"`, `"shared"`, or `"host_runner"`.
/// Anything else returns an error mentioning the offending edit index
/// so the caller can report which AI edit was malformed.
///
/// host_runner is the 4th module added in Phase 5. Pre-Phase-5 callers
/// passed only 3 strings; Phase 5 callers pass 4. The Python diff_patch
/// prompt was updated in lockstep so the AI knows host_runner is a
/// valid target only when host_runner.cpp is present.
pub fn apply_edit_list(
    edits: &[Edit],
    core: &str,
    gui: &str,
    shared: &str,
    host_runner: &str,
) -> Result<(String, String, String, String)> {
    let mut c = core.to_string();
    let mut g = gui.to_string();
    let mut s = shared.to_string();
    let mut h = host_runner.to_string();

    for (i, edit) in edits.iter().enumerate() {
        let updated = match edit.module.as_str() {
            "core" => apply_edit(&c, edit)?,
            "gui" => apply_edit(&g, edit)?,
            "shared" => apply_edit(&s, edit)?,
            "host_runner" => apply_edit(&h, edit)?,
            other => {
                bail!("edit #{} targets unknown module {:?}", i, other);
            }
        };
        match edit.module.as_str() {
            "core" => c = updated,
            "gui" => g = updated,
            "shared" => s = updated,
            "host_runner" => h = updated,
            _ => unreachable!(),
        }
    }

    Ok((c, g, s, h))
}

// ────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make(module: &str, op: EditOperation, anchor: &str, content: &str) -> Edit {
        Edit {
            module: module.to_string(),
            operation: op,
            anchor: anchor.to_string(),
            content: content.to_string(),
        }
    }

    #[test]
    fn insert_after_at_end_of_line() {
        let content = "line a\nline b\nline c\n";
        let e = make("gui", EditOperation::InsertAfter, "line b", "\nline b2");
        assert_eq!(
            apply_edit(content, &e).unwrap(),
            "line a\nline b\nline b2\nline c\n"
        );
    }

    #[test]
    fn insert_before_preserves_trailing() {
        let content = "line a\nline b\nline c\n";
        let e = make("gui", EditOperation::InsertBefore, "line b", "line b0\n");
        assert_eq!(
            apply_edit(content, &e).unwrap(),
            "line a\nline b0\nline b\nline c\n"
        );
    }

    #[test]
    fn replace_value_literal() {
        let content = "int x = 5;\n";
        let e = make("core", EditOperation::Replace, "5", "42");
        assert_eq!(apply_edit(content, &e).unwrap(), "int x = 42;\n");
    }

    #[test]
    fn replace_multiline_block() {
        let content = "begin\nold1\nold2\nend\n";
        let e = make(
            "core",
            EditOperation::Replace,
            "old1\nold2",
            "new1\nnew2\nnew3",
        );
        assert_eq!(apply_edit(content, &e).unwrap(), "begin\nnew1\nnew2\nnew3\nend\n");
    }

    #[test]
    fn delete_removes_anchor_only() {
        let content = "keep\nremove this\nkeep2\n";
        let e = make("gui", EditOperation::Delete, "remove this\n", "");
        assert_eq!(apply_edit(content, &e).unwrap(), "keep\nkeep2\n");
    }

    #[test]
    fn ambiguous_anchor_fails() {
        let content = "foo\nbar\nfoo\n";
        let e = make("core", EditOperation::Replace, "foo", "FOO");
        let err = apply_edit(content, &e).unwrap_err().to_string();
        assert!(err.contains("ambiguous"), "got: {}", err);
        assert!(err.contains("2 times"), "got: {}", err);
    }

    #[test]
    fn missing_anchor_fails() {
        let content = "foo\nbar\nbaz\n";
        let e = make("core", EditOperation::Replace, "qux", "QUX");
        let err = apply_edit(content, &e).unwrap_err().to_string();
        assert!(err.contains("not found"), "got: {}", err);
    }

    #[test]
    fn empty_anchor_fails() {
        let content = "foo\n";
        let e = make("core", EditOperation::Replace, "", "bar");
        let err = apply_edit(content, &e).unwrap_err().to_string();
        assert!(err.contains("empty"), "got: {}", err);
    }

    #[test]
    fn realistic_sdl_button_add() {
        // Simulates the user's red-button edit: adding a second SDL_Rect
        // draw call after the existing one.
        let content = r#"void gui_on_render(void* state_ptr) {
    AppState* state = (AppState*)state_ptr;
    SDL_SetRenderDrawColor(state->renderer, 60, 120, 220, 255);
    SDL_RenderFillRect(state->renderer, &btn1);
}
"#;
        let e = make(
            "gui",
            EditOperation::InsertAfter,
            "SDL_RenderFillRect(state->renderer, &btn1);",
            "\n\n    SDL_Rect btn2 = {50, 130, 200, 60};\n    SDL_SetRenderDrawColor(state->renderer, 220, 60, 60, 255);\n    SDL_RenderFillRect(state->renderer, &btn2);",
        );
        let result = apply_edit(content, &e).unwrap();
        assert!(result.contains("&btn1"));
        assert!(result.contains("&btn2"));
        assert!(result.contains("220, 60, 60"));
        // Order matters — btn1 must come before btn2
        let pos1 = result.find("&btn1").unwrap();
        let pos2 = result.find("&btn2").unwrap();
        assert!(pos1 < pos2);
    }

    #[test]
    fn json_deserializes_edit_list() {
        let json = r#"{
            "edits": [
                {
                    "module": "gui",
                    "operation": "insert_after",
                    "anchor": "old_code",
                    "content": "new_code"
                },
                {
                    "module": "core",
                    "operation": "replace",
                    "anchor": "x = 5",
                    "content": "x = 42"
                }
            ]
        }"#;
        let list: EditList = serde_json::from_str(json).unwrap();
        assert_eq!(list.edits.len(), 2);
        assert_eq!(list.edits[0].module, "gui");
        assert_eq!(list.edits[0].operation, EditOperation::InsertAfter);
        assert_eq!(list.edits[1].operation, EditOperation::Replace);
    }

    #[test]
    fn json_deserializes_empty_edit_list() {
        let json = r#"{"edits": []}"#;
        let list: EditList = serde_json::from_str(json).unwrap();
        assert!(list.edits.is_empty());
    }

    #[test]
    fn json_deserializes_with_extra_fields() {
        // elapsed_seconds and other response envelope fields must not
        // break parsing.
        let json = r#"{
            "edits": [],
            "elapsed_seconds": 1.23,
            "unexpected_field": "whatever"
        }"#;
        let list: EditList = serde_json::from_str(json).unwrap();
        assert!(list.edits.is_empty());
    }
}
