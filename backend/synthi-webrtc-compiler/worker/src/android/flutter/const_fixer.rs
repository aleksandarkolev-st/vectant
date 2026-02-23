// ============================================================
// FLUTTER CONST EXPRESSION AUTO-FIXER
// ============================================================
// Pre-build pass that detects and removes invalid `const` keywords
// from Dart source files. This fixes the most common AI-generated
// code error: `const` applied to widget trees that contain
// non-constant expressions (lambdas, function calls, etc.).
//
// The Dart compiler requires all children of a `const` constructor
// to be compile-time constants. Closures like `onPressed: () {}`
// are NOT constants, so `const Center(child: ElevatedButton(onPressed: () {}))` fails.
//
// Strategy:
//   1. Scan all `.dart` files under `lib/`.
//   2. Find `const` keywords preceding widget constructors.
//   3. Check if the const-scope contains non-constant expressions.
//   4. Remove the offending `const` keyword.
//   5. Report what was fixed.
// ============================================================

use anyhow::Result;
use std::path::Path;
use tokio::fs;

/// Result of running the const fixer on a project.
#[derive(Debug, Clone, Default)]
pub struct ConstFixResult {
    pub files_scanned: usize,
    pub files_fixed: usize,
    pub fixes_applied: usize,
    pub details: Vec<String>,
}

/// Non-constant expression patterns in Dart.
/// If any of these appear inside a `const` constructor scope,
/// the `const` keyword is invalid and must be removed.
const NON_CONST_PATTERNS: &[&str] = &[
    "onPressed:",
    "onTap:",
    "onChanged:",
    "onSubmitted:",
    "onLongPress:",
    "onDoubleTap:",
    "onHover:",
    "onFocusChange:",
    "onDismissed:",
    "onEnd:",
    "onStatusChanged:",
    "controller:",   // AnimationController etc. are runtime objects
    "onPressed: ()", // explicit lambda
    "=> ",           // arrow functions in const scope
    "setState(",     // definitely not const
    "Navigator.",    // navigation calls
    "ScaffoldMessenger.",
    "onSelected:",
    "onExpansionChanged:",
    "onReorder:",
    "onWillPop:",
    "onPopInvoked:",
    "itemBuilder:", // builder callbacks
    "builder:",
    "onGenerateRoute:",
];

/// Scans and fixes all `.dart` files in `lib/` under the given project root.
///
/// Returns a summary of changes made. Files are modified in-place.
pub async fn fix_const_errors(project_root: &Path) -> Result<ConstFixResult> {
    let lib_dir = project_root.join("lib");
    let mut result = ConstFixResult::default();

    if !lib_dir.exists() {
        return Ok(result);
    }

    let dart_files = collect_dart_files(&lib_dir).await?;

    for file_path in &dart_files {
        result.files_scanned += 1;

        let content = match fs::read_to_string(file_path).await {
            Ok(c) => c,
            Err(_) => continue,
        };

        let (fixed_content, fix_count) = fix_const_in_source(&content);

        if fix_count > 0 {
            fs::write(file_path, &fixed_content).await?;
            result.files_fixed += 1;
            result.fixes_applied += fix_count;
            result.details.push(format!(
                "Fixed {} const error(s) in {}",
                fix_count,
                file_path.display()
            ));
        }
    }

    Ok(result)
}

/// Recursively collects all `.dart` files under a directory.
async fn collect_dart_files(dir: &Path) -> Result<Vec<std::path::PathBuf>> {
    let mut files = Vec::new();
    let mut stack = vec![dir.to_path_buf()];

    while let Some(current) = stack.pop() {
        let mut entries = fs::read_dir(&current).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().and_then(|e| e.to_str()) == Some("dart") {
                files.push(path);
            }
        }
    }

    Ok(files)
}

/// Core fixer: processes a single Dart source string.
///
/// Returns `(fixed_source, number_of_fixes)`.
///
/// Algorithm:
///   - Find each occurrence of `const ` followed by an uppercase letter
///     (widget constructor pattern: `const MyWidget(`, `const Center(`).
///   - From that position, find the matching closing paren/bracket.
///   - Check if the scope contains any non-constant patterns.
///   - If yes, remove the `const ` prefix.
fn fix_const_in_source(source: &str) -> (String, usize) {
    let mut result = source.to_string();
    let mut total_fixes = 0;

    // We iterate multiple times because removing one const might expose another.
    // Limit iterations to avoid infinite loops.
    for _ in 0..20 {
        let (new_result, fixes) = fix_const_pass(&result);
        if fixes == 0 {
            break;
        }
        total_fixes += fixes;
        result = new_result;
    }

    (result, total_fixes)
}

/// Single pass of const fixing.
fn fix_const_pass(source: &str) -> (String, usize) {
    let chars: Vec<char> = source.chars().collect();
    let len = chars.len();
    let mut result = String::with_capacity(source.len());
    let mut fixes = 0;
    let mut i = 0;

    while i < len {
        // Look for "const " followed by an uppercase letter (widget constructor)
        if i + 6 < len && matches_const_widget(&chars, i) {
            // Find the opening paren/bracket after the constructor name
            let constructor_start = i + 6; // skip "const "
            if let Some(open_pos) = find_opening_bracket(&chars, constructor_start) {
                let open_char = chars[open_pos];
                let close_char = match open_char {
                    '(' => ')',
                    '[' => ']',
                    '{' => '}',
                    _ => {
                        result.push(chars[i]);
                        i += 1;
                        continue;
                    }
                };

                if let Some(close_pos) =
                    find_matching_close(&chars, open_pos, open_char, close_char)
                {
                    // Extract the scope content
                    let scope: String = chars[open_pos..=close_pos].iter().collect();

                    if contains_non_const_expression(&scope) {
                        // Skip the "const " (6 chars) — remove it
                        // Write everything from constructor_start onward
                        // (the widget name and its parens will be preserved)
                        fixes += 1;
                        i += 6; // skip "const "
                        continue;
                    }
                }
            }
        }

        result.push(chars[i]);
        i += 1;
    }

    (result, fixes)
}

/// Checks if position `i` in `chars` starts with "const " followed by
/// an uppercase ASCII letter (indicating a widget/class constructor).
fn matches_const_widget(chars: &[char], i: usize) -> bool {
    let keyword = ['c', 'o', 'n', 's', 't', ' '];
    if i + keyword.len() >= chars.len() {
        return false;
    }

    for (j, &expected) in keyword.iter().enumerate() {
        if chars[i + j] != expected {
            return false;
        }
    }

    // Next char after "const " should be uppercase (widget constructor)
    let next = chars[i + keyword.len()];
    if !next.is_ascii_uppercase() {
        return false;
    }

    // Make sure "const" is at word boundary (preceded by whitespace, '(', '[', ',' or start)
    if i > 0 {
        let prev = chars[i - 1];
        if prev.is_alphanumeric() || prev == '_' {
            return false;
        }
    }

    true
}

/// Finds the first '(' or '[' after position `start`, skipping over
/// the constructor name (letters, digits, underscores, dots, generics).
fn find_opening_bracket(chars: &[char], start: usize) -> Option<usize> {
    let mut i = start;
    let len = chars.len();

    // Skip constructor name (may include generics like <Widget>)
    let mut angle_depth = 0;
    while i < len {
        match chars[i] {
            '<' => {
                angle_depth += 1;
                i += 1;
            }
            '>' => {
                if angle_depth > 0 {
                    angle_depth -= 1;
                }
                i += 1;
            }
            '(' | '[' if angle_depth == 0 => return Some(i),
            c if c.is_alphanumeric() || c == '_' || c == '.' || c == ' ' => {
                // For space: only allow if we haven't left the name yet
                // Actually, stop at space unless inside angle brackets
                if c == ' ' && angle_depth == 0 {
                    // Could be `const Text ('hello')` — unlikely but handle
                    // Skip single space and check next char
                    if i + 1 < len && (chars[i + 1] == '(' || chars[i + 1] == '[') {
                        i += 1;
                        continue;
                    }
                    return None;
                }
                i += 1;
            }
            _ if angle_depth > 0 => {
                i += 1; // inside generics, anything goes
            }
            _ => return None,
        }
    }

    None
}

/// Finds the matching close bracket, respecting nesting and string literals.
fn find_matching_close(
    chars: &[char],
    open: usize,
    open_char: char,
    close_char: char,
) -> Option<usize> {
    let mut depth = 0;
    let mut i = open;
    let len = chars.len();

    while i < len {
        let c = chars[i];

        // Skip string literals
        if c == '\'' || c == '"' {
            i = skip_string(chars, i)?;
            continue;
        }

        // Skip line comments
        if c == '/' && i + 1 < len && chars[i + 1] == '/' {
            while i < len && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }

        // Skip block comments
        if c == '/' && i + 1 < len && chars[i + 1] == '*' {
            i += 2;
            while i + 1 < len && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            i += 2;
            continue;
        }

        if c == open_char {
            depth += 1;
        } else if c == close_char {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }

        i += 1;
    }

    None
}

/// Skips over a Dart string literal (single or double quoted, including triple-quoted).
/// Returns the position after the closing quote.
fn skip_string(chars: &[char], start: usize) -> Option<usize> {
    let quote = chars[start];
    let len = chars.len();

    // Check for triple-quoted string
    if start + 2 < len && chars[start + 1] == quote && chars[start + 2] == quote {
        let mut i = start + 3;
        while i + 2 < len {
            if chars[i] == '\\' {
                i += 2;
                continue;
            }
            if chars[i] == quote && chars[i + 1] == quote && chars[i + 2] == quote {
                return Some(i + 3);
            }
            i += 1;
        }
        return None;
    }

    // Single-quoted string
    let mut i = start + 1;
    while i < len {
        if chars[i] == '\\' {
            i += 2;
            continue;
        }
        if chars[i] == quote {
            return Some(i + 1);
        }
        if chars[i] == '\n' {
            // Unterminated string, bail
            return Some(i);
        }
        i += 1;
    }

    None
}

/// Checks if a scope string contains patterns that make it non-constant.
fn contains_non_const_expression(scope: &str) -> bool {
    for pattern in NON_CONST_PATTERNS {
        if scope.contains(pattern) {
            return true;
        }
    }

    // Also check for lambda/closure patterns: `() {` or `() =>`
    // These are definitive markers of non-const expressions.
    let has_lambda = scope.contains("() {")
        || scope.contains("() =>")
        || scope.contains("(e) {")
        || scope.contains("(e) =>")
        || scope.contains("(value) {")
        || scope.contains("(value) =>")
        || scope.contains("(context) {")
        || scope.contains("(context) =>")
        || scope.contains("(ctx) {")
        || scope.contains("(ctx) =>");

    if has_lambda {
        return true;
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fix_const_with_lambda() {
        let source = r#"
Widget build(BuildContext context) {
  return Scaffold(
    body: const Center(
      child: Column(
        children: <Widget>[
          Text('Hello'),
          ElevatedButton(
            onPressed: () {
              print('tapped');
            },
            child: Text('Tap me'),
          ),
        ],
      ),
    ),
  );
}
"#;
        let (fixed, count) = fix_const_in_source(source);
        assert_eq!(count, 1);
        assert!(fixed.contains("body: Center("));
        assert!(!fixed.contains("body: const Center("));
    }

    #[test]
    fn test_preserve_valid_const() {
        let source = r#"
Widget build(BuildContext context) {
  return const Center(
    child: Text('Hello World'),
  );
}
"#;
        let (fixed, count) = fix_const_in_source(source);
        assert_eq!(count, 0);
        assert!(fixed.contains("const Center("));
    }

    #[test]
    fn test_fix_multiple_const_errors() {
        let source = r#"
body: const Center(
  child: Column(
    children: <Widget>[
      ElevatedButton(
        onPressed: () {},
        child: Text('A'),
      ),
      ElevatedButton(
        onPressed: () {},
        child: Text('B'),
      ),
    ],
  ),
),
"#;
        let (fixed, count) = fix_const_in_source(source);
        assert!(count >= 1);
        assert!(!fixed.contains("const Center("));
    }

    #[test]
    fn test_no_false_positive_on_const_string() {
        let source = r#"
const String title = 'Hello';
const int count = 42;
"#;
        let (fixed, count) = fix_const_in_source(source);
        assert_eq!(count, 0);
        assert_eq!(fixed.trim(), source.trim());
    }

    #[test]
    fn test_handles_nested_const() {
        let source = r#"
return const Scaffold(
  body: Center(
    child: Column(
      children: [
        const Text('OK'),
        ElevatedButton(onPressed: () {}, child: Text('Go')),
      ],
    ),
  ),
);
"#;
        let (fixed, count) = fix_const_in_source(source);
        assert!(count >= 1);
        // The outer const Scaffold should be removed (it contains a lambda)
        assert!(!fixed.contains("const Scaffold("));
        // The inner const Text should be preserved (no lambda in its scope)
        assert!(fixed.contains("const Text('OK')"));
    }
}
