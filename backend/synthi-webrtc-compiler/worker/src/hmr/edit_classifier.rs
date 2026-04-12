// ============================================================
// EDIT CLASSIFIER
// ============================================================
// Classifies each changed hunk in a diff by kind (value change,
// addition, deletion, expression change, structural). The target
// module (core, gui, shared) is filled in by classify_edit_with_ai
// via an AI call to the /classify/edit endpoint.
//
// Kind classification is pure Rust, <1ms.
// Target classification (AI) runs on-demand from the compile handler,
// NOT on every keystroke — calling it per-edit saturated the single
// Python worker with concurrent Gemini calls.
// ============================================================

// ── Public types ────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditTarget {
    Core,
    Gui,
    Shared,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditKind {
    ValueChange,
    ExpressionChange,
    Addition,
    Deletion,
    Structural,
}

#[derive(Debug, Clone)]
pub struct ClassifiedHunk {
    pub kind: EditKind,
    pub target: EditTarget,
    pub old_lines: Vec<String>,
    pub new_lines: Vec<String>,
}

impl ClassifiedHunk {
    /// Build a minimal diff string for this hunk (for AI context).
    pub fn diff_text(&self) -> String {
        let mut out = String::new();
        for l in &self.old_lines {
            out.push_str(&format!("-{}\n", l));
        }
        for l in &self.new_lines {
            out.push_str(&format!("+{}\n", l));
        }
        out
    }
}

#[derive(Debug, Clone)]
pub struct EditClassification {
    pub hunks: Vec<ClassifiedHunk>,
    pub is_value_only: bool,
}

// ── Classifier ──────────────────────────────────────────────

/// Classify the diff between old and new source into labeled hunks.
pub fn classify_edit(old_source: &str, new_source: &str) -> EditClassification {
    let old_lines: Vec<&str> = old_source.lines().collect();
    let new_lines: Vec<&str> = new_source.lines().collect();

    let raw_hunks = extract_hunks(&old_lines, &new_lines);

    let mut hunks = Vec::new();
    let mut all_value = true;

    for raw in raw_hunks {
        let kind = classify_kind(&raw.old_lines, &raw.new_lines);
        // Target starts as Unknown; filled in by classify_edit_with_ai for non-value edits.
        let target = EditTarget::Unknown;

        if kind != EditKind::ValueChange {
            all_value = false;
        }

        hunks.push(ClassifiedHunk {
            kind,
            target,
            old_lines: raw.old_lines.iter().map(|s| s.to_string()).collect(),
            new_lines: raw.new_lines.iter().map(|s| s.to_string()).collect(),
        });
    }

    EditClassification {
        is_value_only: all_value && !hunks.is_empty(),
        hunks,
    }
}

/// Async variant: runs sync classification then asks the AI to classify the target module.
/// Skips the AI call for value-only edits (Tier 1 regex patcher handles them).
pub async fn classify_edit_with_ai(old_source: &str, new_source: &str, lang: &str) -> EditClassification {
    let mut classification = classify_edit(old_source, new_source);

    if classification.is_value_only || classification.hunks.is_empty() {
        return classification;
    }

    // Build a combined diff from all non-value hunks.
    let diff_text: String = classification.hunks.iter()
        .filter(|h| h.kind != EditKind::ValueChange)
        .map(|h| h.diff_text())
        .collect::<Vec<_>>()
        .join("\n");

    if diff_text.trim().is_empty() {
        return classification;
    }

    match crate::compiler::stages::ai_utils::perform_ai_classify_edit(&diff_text, lang).await {
        Ok(target_str) => {
            let target = match target_str.as_str() {
                "core" => EditTarget::Core,
                "gui" => EditTarget::Gui,
                "shared" => EditTarget::Shared,
                _ => EditTarget::Unknown,
            };
            eprintln!("[classify] AI classified as: {:?}", target);
            for hunk in classification.hunks.iter_mut() {
                if hunk.kind != EditKind::ValueChange {
                    hunk.target = target;
                }
            }
        }
        Err(e) => {
            eprintln!("[classify] AI classification failed: {}, hunks stay Unknown", e);
        }
    }

    classification
}

// ── Kind classification ─────────────────────────────────────

fn classify_kind(old: &[&str], new: &[&str]) -> EditKind {
    if old.is_empty() && !new.is_empty() {
        return EditKind::Addition;
    }
    if !old.is_empty() && new.is_empty() {
        return EditKind::Deletion;
    }

    // Check if only number/string literals changed
    if old.len() == new.len() {
        let mut all_value = true;
        for (o, n) in old.iter().zip(new.iter()) {
            if !is_value_only_change(o, n) {
                all_value = false;
                break;
            }
        }
        if all_value {
            return EditKind::ValueChange;
        }

        // Same number of lines but different structure → expression change
        return EditKind::ExpressionChange;
    }

    // Different line counts with both additions and removals → structural
    EditKind::Structural
}

/// Check if two lines differ only in number or string literals.
fn is_value_only_change(old: &str, new: &str) -> bool {
    let old_stripped = strip_literals(old);
    let new_stripped = strip_literals(new);
    old_stripped == new_stripped
}

/// Replace all number and string literals with placeholders.
fn strip_literals(line: &str) -> String {
    let mut result = String::with_capacity(line.len());
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        // String literal
        if chars[i] == '"' {
            result.push_str("\"STR\"");
            i += 1;
            while i < chars.len() && chars[i] != '"' {
                if chars[i] == '\\' { i += 1; }
                i += 1;
            }
            if i < chars.len() { i += 1; } // skip closing "
            continue;
        }

        // Number literal (int or float)
        if chars[i].is_ascii_digit()
            || (chars[i] == '-'
                && i + 1 < chars.len()
                && chars[i + 1].is_ascii_digit()
                && (i == 0 || !chars[i.wrapping_sub(1)].is_ascii_alphanumeric()))
        {
            result.push_str("NUM");
            if chars[i] == '-' { i += 1; }
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                i += 1;
            }
            if i < chars.len() && (chars[i] == 'f' || chars[i] == 'F') {
                i += 1;
            }
            continue;
        }

        result.push(chars[i]);
        i += 1;
    }
    result
}

// ── Hunk extraction ─────────────────────────────────────────

struct RawHunk<'a> {
    old_lines: Vec<&'a str>,
    new_lines: Vec<&'a str>,
}

/// Extract contiguous hunks of changed lines.
fn extract_hunks<'a>(old: &[&'a str], new: &[&'a str]) -> Vec<RawHunk<'a>> {
    let mut hunks = Vec::new();
    let mut oi = 0;
    let mut ni = 0;

    while oi < old.len() || ni < new.len() {
        // Skip matching lines
        if oi < old.len() && ni < new.len() && old[oi].trim() == new[ni].trim() {
            oi += 1;
            ni += 1;
            continue;
        }

        // Collect a hunk of differing lines
        let mut hunk_old = Vec::new();
        let mut hunk_new = Vec::new();

        // Look ahead to find where they sync up again
        while oi < old.len() || ni < new.len() {
            if oi < old.len() && ni < new.len() && old[oi].trim() == new[ni].trim() {
                break;
            }

            let old_ahead = (1..=5).find(|&skip| {
                oi + skip < old.len()
                    && ni < new.len()
                    && old[oi + skip].trim() == new[ni].trim()
            });
            let new_ahead = (1..=5).find(|&skip| {
                ni + skip < new.len()
                    && oi < old.len()
                    && old[oi].trim() == new[ni + skip].trim()
            });

            match (old_ahead, new_ahead) {
                (Some(skip), None) | (Some(skip), Some(_)) if old_ahead <= new_ahead => {
                    for _ in 0..skip {
                        if oi < old.len() {
                            hunk_old.push(old[oi]);
                            oi += 1;
                        }
                    }
                }
                (None, Some(skip)) | (_, Some(skip)) => {
                    for _ in 0..skip {
                        if ni < new.len() {
                            hunk_new.push(new[ni]);
                            ni += 1;
                        }
                    }
                }
                _ => {
                    if oi < old.len() {
                        hunk_old.push(old[oi]);
                        oi += 1;
                    }
                    if ni < new.len() {
                        hunk_new.push(new[ni]);
                        ni += 1;
                    }
                }
            }
        }

        if !hunk_old.is_empty() || !hunk_new.is_empty() {
            hunks.push(RawHunk {
                old_lines: hunk_old,
                new_lines: hunk_new,
            });
        }
    }

    hunks
}

// ── Tests ───────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_change_detected() {
        let old = "    SDL_SetRenderDrawColor(ren, 0, 120, 255, 255);";
        let new = "    SDL_SetRenderDrawColor(ren, 255, 0, 0, 255);";
        let c = classify_edit(old, new);
        assert!(c.is_value_only);
        assert_eq!(c.hunks.len(), 1);
        assert_eq!(c.hunks[0].kind, EditKind::ValueChange);
        assert_eq!(c.hunks[0].target, EditTarget::Gui);
    }

    #[test]
    fn speed_change_is_value() {
        let old = "    float vx = 3;";
        let new = "    float vx = 8;";
        let c = classify_edit(old, new);
        assert!(c.is_value_only);
        assert_eq!(c.hunks[0].kind, EditKind::ValueChange);
    }

    #[test]
    fn expression_change_detected() {
        let old = "    x += vx;";
        let new = "    x += vx * 2;";
        let c = classify_edit(old, new);
        assert!(!c.is_value_only);
        assert_eq!(c.hunks[0].kind, EditKind::ExpressionChange);
        assert_eq!(c.hunks[0].target, EditTarget::Core);
    }

    #[test]
    fn addition_detected() {
        let old = "    line1;\n    line2;";
        let new = "    line1;\n    SDL_RenderDrawRect(ren, &r);\n    line2;";
        let c = classify_edit(old, new);
        assert!(!c.is_value_only);
        assert!(c.hunks.iter().any(|h| h.kind == EditKind::Addition));
        assert!(c.hunks.iter().any(|h| h.target == EditTarget::Gui));
    }

    #[test]
    fn deletion_detected() {
        let old = "    line1;\n    SDL_RenderFillRect(ren, &r);\n    line2;";
        let new = "    line1;\n    line2;";
        let c = classify_edit(old, new);
        assert!(c.hunks.iter().any(|h| h.kind == EditKind::Deletion));
    }

    #[test]
    fn strip_literals_normalizes() {
        assert_eq!(
            strip_literals("SDL_SetRenderDrawColor(r, 0, 120, 255, 255);"),
            strip_literals("SDL_SetRenderDrawColor(r, 255, 0, 0, 255);")
        );
        assert_ne!(
            strip_literals("x += vx;"),
            strip_literals("x += vx * 2;")
        );
    }

    #[test]
    fn no_changes_empty() {
        let c = classify_edit("same line", "same line");
        assert!(c.hunks.is_empty());
        assert!(!c.is_value_only); // no hunks = not value-only
    }
}
