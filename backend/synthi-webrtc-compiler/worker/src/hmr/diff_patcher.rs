// ============================================================
// DIFF PATCHER
// ============================================================
// Maps edits from the original source (main.cpp) to the AI-split
// module files (core.cpp, gui.cpp, shared.h) without re-running
// the AI.  Works by diffing old vs new source, then finding the
// changed lines in the split files via substring matching.
// ============================================================

/// Result of attempting to patch split files from a source diff.
#[derive(Debug)]
pub struct PatchResult {
    /// Updated core.cpp content (None = unchanged).
    pub core: Option<String>,
    /// Updated gui.cpp content (None = unchanged).
    pub gui: Option<String>,
    /// Updated shared.h content (None = unchanged).
    pub shared: Option<String>,
    /// Lines that couldn't be matched to any split file.
    pub unmatched_count: usize,
}

impl PatchResult {
    pub fn has_changes(&self) -> bool {
        self.core.is_some() || self.gui.is_some() || self.shared.is_some()
    }
}

/// Diff the old source against the new source, then transplant
/// each changed line into the appropriate split file.
///
/// The AI split preserves user code nearly verbatim — lines from
/// main.cpp appear in core.cpp/gui.cpp with minor adaptations
/// (e.g. `ren` → `app_state->renderer`).  We use normalized
/// substring matching to find the right location.
pub fn patch_split_files(
    old_source: &str,
    new_source: &str,
    core_content: &str,
    gui_content: &str,
    shared_content: &str,
) -> PatchResult {
    let old_lines: Vec<&str> = old_source.lines().collect();
    let new_lines: Vec<&str> = new_source.lines().collect();

    // Collect changed line pairs: (old_line, new_line)
    let changes = collect_line_changes(&old_lines, &new_lines);

    if changes.is_empty() {
        return PatchResult {
            core: None,
            gui: None,
            shared: None,
            unmatched_count: 0,
        };
    }

    let mut core_out = core_content.to_string();
    let mut gui_out = gui_content.to_string();
    let mut shared_out = shared_content.to_string();
    let mut core_changed = false;
    let mut gui_changed = false;
    let mut shared_changed = false;
    let mut unmatched = 0;

    for change in &changes {
        match change {
            LineChange::Modified { old, new } => {
                // Try to find the old line in each split file and replace it
                let old_tokens = extract_significant_tokens(old);
                if old_tokens.is_empty() {
                    continue;
                }

                if let Some(replaced) = try_replace_line(&core_out, old, new, &old_tokens) {
                    core_out = replaced;
                    core_changed = true;
                } else if let Some(replaced) = try_replace_line(&gui_out, old, new, &old_tokens) {
                    gui_out = replaced;
                    gui_changed = true;
                } else if let Some(replaced) = try_replace_line(&shared_out, old, new, &old_tokens) {
                    shared_out = replaced;
                    shared_changed = true;
                } else {
                    unmatched += 1;
                }
            }
            LineChange::Added { new } => {
                // For added lines, try to insert near context lines.
                // Simple heuristic: if the line contains rendering calls, add to gui.
                // Otherwise add to core.  This is best-effort.
                let trimmed = new.trim();
                if trimmed.is_empty() || trimmed.starts_with("//") {
                    continue; // skip blank/comment additions
                }
                // We can't reliably insert new lines without context, so count as unmatched
                // unless it's a trivial whitespace-only change
                unmatched += 1;
            }
            LineChange::Removed { old } => {
                let old_trimmed = old.trim();
                if old_trimmed.is_empty() || old_trimmed.starts_with("//") {
                    continue;
                }
                // Try to find and remove/comment the line in split files
                let old_tokens = extract_significant_tokens(old);
                if old_tokens.is_empty() {
                    continue;
                }
                if let Some(replaced) = try_remove_line(&core_out, old, &old_tokens) {
                    core_out = replaced;
                    core_changed = true;
                } else if let Some(replaced) = try_remove_line(&gui_out, old, &old_tokens) {
                    gui_out = replaced;
                    gui_changed = true;
                } else {
                    unmatched += 1;
                }
            }
        }
    }

    PatchResult {
        core: if core_changed { Some(core_out) } else { None },
        gui: if gui_changed { Some(gui_out) } else { None },
        shared: if shared_changed { Some(shared_out) } else { None },
        unmatched_count: unmatched,
    }
}

// ── Internal helpers ────────────────────────────────────────

#[derive(Debug)]
enum LineChange<'a> {
    Modified { old: &'a str, new: &'a str },
    Added { new: &'a str },
    Removed { old: &'a str },
}

/// Simple LCS-based diff that produces line-level changes.
fn collect_line_changes<'a>(old: &[&'a str], new: &[&'a str]) -> Vec<LineChange<'a>> {
    let mut changes = Vec::new();
    let mut oi = 0;
    let mut ni = 0;

    while oi < old.len() && ni < new.len() {
        if normalize(old[oi]) == normalize(new[ni]) {
            // Lines match — no change
            oi += 1;
            ni += 1;
        } else {
            // Lines differ.  Look ahead to find the best alignment.
            let old_ahead = find_ahead(old, oi, new[ni], 5);
            let new_ahead = find_ahead(new, ni, old[oi], 5);

            match (old_ahead, new_ahead) {
                (Some(skip), _) if skip <= new_ahead.unwrap_or(usize::MAX) => {
                    // Old has extra lines (removed)
                    for i in oi..oi + skip {
                        changes.push(LineChange::Removed { old: old[i] });
                    }
                    oi += skip;
                }
                (_, Some(skip)) => {
                    // New has extra lines (added)
                    for i in ni..ni + skip {
                        changes.push(LineChange::Added { new: new[i] });
                    }
                    ni += skip;
                }
                _ => {
                    // No good alignment — treat as modification
                    changes.push(LineChange::Modified {
                        old: old[oi],
                        new: new[ni],
                    });
                    oi += 1;
                    ni += 1;
                }
            }
        }
    }

    // Remaining old lines are removals
    while oi < old.len() {
        changes.push(LineChange::Removed { old: old[oi] });
        oi += 1;
    }
    // Remaining new lines are additions
    while ni < new.len() {
        changes.push(LineChange::Added { new: new[ni] });
        ni += 1;
    }

    changes
}

/// Look ahead up to `max` lines for a normalized match.
fn find_ahead(lines: &[&str], start: usize, target: &str, max: usize) -> Option<usize> {
    let norm_target = normalize(target);
    for i in 1..=max {
        if start + i < lines.len() && normalize(lines[start + i]) == norm_target {
            return Some(i);
        }
    }
    None
}

/// Normalize a line for comparison: trim whitespace, collapse spaces.
fn normalize(line: &str) -> String {
    line.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Extract significant tokens from a line (identifiers, numbers, operators).
/// Used for fuzzy matching — the AI might rename `ren` to `app_state->renderer`
/// but numbers and most identifiers are preserved.
fn extract_significant_tokens(line: &str) -> Vec<String> {
    let trimmed = line.trim();
    // Extract number literals — these are the most stable across AI rewriting
    let mut tokens = Vec::new();
    let mut i = 0;
    let chars: Vec<char> = trimmed.chars().collect();

    while i < chars.len() {
        // Capture number literals (int and float)
        if chars[i].is_ascii_digit()
            || (chars[i] == '-'
                && i + 1 < chars.len()
                && chars[i + 1].is_ascii_digit()
                && (i == 0 || !chars[i - 1].is_ascii_alphanumeric()))
        {
            let start = i;
            if chars[i] == '-' {
                i += 1;
            }
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                i += 1;
            }
            // Skip 'f' suffix on floats
            if i < chars.len() && chars[i] == 'f' {
                i += 1;
            }
            tokens.push(trimmed[start..i].to_string());
            continue;
        }

        // Capture identifiers (variable/function names)
        if chars[i].is_ascii_alphabetic() || chars[i] == '_' {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            let word = &trimmed[start..i];
            // Skip common keywords and types — focus on user-defined names
            if !matches!(
                word,
                "int" | "float" | "double" | "bool" | "char" | "void"
                    | "if" | "else" | "while" | "for" | "return" | "true" | "false"
                    | "const" | "static" | "struct" | "auto" | "unsigned"
            ) {
                tokens.push(word.to_string());
            }
            continue;
        }

        i += 1;
    }

    tokens
}

/// Try to find a line in `content` that matches `old_line` via token matching,
/// and replace it with `new_line` (preserving the indentation of the found line).
fn try_replace_line(
    content: &str,
    old_line: &str,
    new_line: &str,
    old_tokens: &[String],
) -> Option<String> {
    let content_lines: Vec<&str> = content.lines().collect();
    let mut best_idx = None;
    let mut best_score = 0;

    for (idx, line) in content_lines.iter().enumerate() {
        let score = token_match_score(line, old_tokens);
        if score > best_score && score >= old_tokens.len() / 2 + 1 {
            best_score = score;
            best_idx = Some(idx);
        }
    }

    let idx = best_idx?;
    let found_line = content_lines[idx];

    // Preserve the indentation of the split file's line
    let indent = &found_line[..found_line.len() - found_line.trim_start().len()];
    let new_trimmed = new_line.trim();

    // Build the replacement: transplant the user's new code with the split file's indent.
    // If the AI rewrote the line significantly, try to apply just the value changes.
    let replacement = if let Some(patched) = apply_value_changes(found_line, old_line, new_line) {
        patched
    } else {
        format!("{}{}", indent, new_trimmed)
    };

    let mut result_lines: Vec<String> = content_lines.iter().map(|l| l.to_string()).collect();
    result_lines[idx] = replacement;
    Some(result_lines.join("\n"))
}

/// Try to find and remove a line from content.
fn try_remove_line(
    content: &str,
    old_line: &str,
    old_tokens: &[String],
) -> Option<String> {
    let content_lines: Vec<&str> = content.lines().collect();
    let mut best_idx = None;
    let mut best_score = 0;

    for (idx, line) in content_lines.iter().enumerate() {
        let score = token_match_score(line, old_tokens);
        if score > best_score && score >= old_tokens.len() / 2 + 1 {
            best_score = score;
            best_idx = Some(idx);
        }
    }

    let idx = best_idx?;
    let _ = old_line; // used for debug context only

    let mut result_lines: Vec<String> = content_lines.iter().map(|l| l.to_string()).collect();
    result_lines.remove(idx);
    Some(result_lines.join("\n"))
}

/// Score how many of `tokens` appear in `line`.
fn token_match_score(line: &str, tokens: &[String]) -> usize {
    tokens.iter().filter(|t| line.contains(t.as_str())).count()
}

/// Try to apply just the VALUE changes from old→new to the split file's line.
/// This handles cases where the AI rewrote variable names but preserved the structure.
///
/// Example:
///   old_line:   "    int r = 0, g = 120, b = 255;"    (main.cpp)
///   new_line:   "    int r = 255, g = 0, b = 0;"      (main.cpp edited)
///   found_line: "    app_state->r = 0;"                (core.cpp)
///   result:     "    app_state->r = 255;"
fn apply_value_changes(
    found_line: &str,
    old_source_line: &str,
    new_source_line: &str,
) -> Option<String> {
    // Extract number literals from old and new source lines
    let old_numbers = extract_numbers(old_source_line);
    let new_numbers = extract_numbers(new_source_line);

    if old_numbers.len() != new_numbers.len() || old_numbers.is_empty() {
        return None;
    }

    // Check that the found line contains at least one of the old numbers
    if !old_numbers.iter().any(|n| found_line.contains(n)) {
        return None;
    }

    // Replace old numbers with new numbers in the found line
    let mut result = found_line.to_string();
    for (old_num, new_num) in old_numbers.iter().zip(new_numbers.iter()) {
        if old_num != new_num {
            // Replace first occurrence only
            if let Some(pos) = result.find(old_num.as_str()) {
                result = format!("{}{}{}", &result[..pos], new_num, &result[pos + old_num.len()..]);
            }
        }
    }

    if result != found_line {
        Some(result)
    } else {
        None
    }
}

/// Extract number literals from a line.
fn extract_numbers(line: &str) -> Vec<String> {
    let mut numbers = Vec::new();
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        if chars[i].is_ascii_digit()
            || (chars[i] == '-'
                && i + 1 < chars.len()
                && chars[i + 1].is_ascii_digit()
                && (i == 0 || matches!(chars.get(i.wrapping_sub(1)), Some(c) if !c.is_ascii_alphanumeric() && *c != '_')))
        {
            let start = i;
            if chars[i] == '-' {
                i += 1;
            }
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                i += 1;
            }
            if i < chars.len() && chars[i] == 'f' {
                i += 1;
            }
            numbers.push(line[start..i].to_string());
            continue;
        }
        i += 1;
    }

    numbers
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_changes() {
        let result = patch_split_files("int x = 1;", "int x = 1;", "// core", "// gui", "// shared");
        assert!(!result.has_changes());
        assert_eq!(result.unmatched_count, 0);
    }

    #[test]
    fn color_change_patches_gui() {
        let old = "    SDL_SetRenderDrawColor(ren, 0, 120, 255, 255);";
        let new = "    SDL_SetRenderDrawColor(ren, 255, 0, 0, 255);";

        let gui = "void gui_on_render(void* state) {\n    SDL_SetRenderDrawColor(app_state->renderer, 0, 120, 255, 255);\n}";
        let core = "void core_on_update(void* state, float dt) {\n    // logic\n}";

        let result = patch_split_files(old, new, core, gui, "");
        assert!(result.gui.is_some());
        assert!(result.core.is_none());

        let patched_gui = result.gui.unwrap();
        assert!(patched_gui.contains("255"), "Should contain 255");
        assert!(!patched_gui.contains("120"), "Should not contain old value 120");
    }

    #[test]
    fn speed_change_patches_core() {
        let old = "    float vx = 3;";
        let new = "    float vx = 8;";

        let core = "extern \"C\" void core_on_load(void* prev, void* renderer) {\n    app_state->vx = 3;\n}";
        let gui = "void gui_on_render(void* state) {\n    // draw\n}";

        let result = patch_split_files(old, new, core, gui, "");
        assert!(result.core.is_some());
        assert!(result.gui.is_none());

        let patched_core = result.core.unwrap();
        assert!(patched_core.contains("8"), "Should contain new value 8");
        assert!(!patched_core.contains("= 3"), "Should not contain old value 3");
    }

    #[test]
    fn value_change_applies_to_rewritten_line() {
        let found = "    app_state->r = 0;";
        let old = "    int r = 0, g = 120, b = 255;";
        let new = "    int r = 255, g = 0, b = 0;";

        let result = apply_value_changes(found, old, new);
        assert!(result.is_some());
        assert_eq!(result.unwrap(), "    app_state->r = 255;");
    }

    #[test]
    fn extract_numbers_works() {
        assert_eq!(extract_numbers("int x = 42;"), vec!["42"]);
        assert_eq!(extract_numbers("float v = 3.5f;"), vec!["3.5f"]);
        assert_eq!(
            extract_numbers("SDL_SetRenderDrawColor(r, 0, 120, 255, 255);"),
            vec!["0", "120", "255", "255"]
        );
    }

    #[test]
    fn token_matching() {
        let tokens = extract_significant_tokens("SDL_SetRenderDrawColor(ren, 0, 120, 255, 255);");
        assert!(tokens.contains(&"SDL_SetRenderDrawColor".to_string()));
        assert!(tokens.contains(&"0".to_string()));
        assert!(tokens.contains(&"120".to_string()));
        assert!(tokens.contains(&"ren".to_string()));
    }
}
