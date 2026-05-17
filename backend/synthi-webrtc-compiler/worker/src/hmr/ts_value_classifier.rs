// ============================================================
// TREE-SITTER VALUE-ONLY CLASSIFIER (Phase 11b)
// ============================================================
//
// AST-based replacement for the regex value-only heuristic in
// edit_classifier.rs. Parses both old and new C++ source with
// tree-sitter-cpp, walks the ASTs, and determines whether the
// diff consists exclusively of literal value changes.
//
// Advantages over the regex approach:
//   - Correctly handles integer literals in complex expressions
//     (the regex can't distinguish `42` in `int x = 42` from
//     `42` in `ptr + 42`)
//   - Identifies string literals that span macro arguments
//   - Rejects edits that change AST structure (added/removed
//     nodes) even if the line diff looks "value-only"
//
// Limitation: tree-sitter-cpp can't parse incomplete fragments
// (e.g., the body of a single function without the surrounding
// file). We parse the full split module content.

use tree_sitter::{Node, Parser, Tree};

/// Result of the AST-based value classification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AstClassification {
    /// Only literal nodes changed value — eligible for Tier 0.
    ValueOnly { changes: Vec<LiteralChange> },
    /// AST structure changed (nodes added, removed, or retyped).
    Structural,
    /// Parse error on one or both inputs.
    ParseError(String),
}

/// A single literal value change detected by the AST diff.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiteralChange {
    pub kind: LiteralKind,
    pub old_text: String,
    pub new_text: String,
    pub line: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LiteralKind {
    StringLiteral,
    NumberLiteral,
    CharLiteral,
    True,
    False,
}

const LITERAL_KINDS: &[&str] = &[
    "string_literal",
    "number_literal",
    "char_literal",
    "true",
    "false",
    "concatenated_string",
];

fn is_literal_node(node: &Node) -> bool {
    LITERAL_KINDS.contains(&node.kind())
}

fn parse_cpp(source: &str) -> Result<Tree, String> {
    let mut parser = Parser::new();
    let language = tree_sitter_cpp::LANGUAGE;
    parser
        .set_language(&language.into())
        .map_err(|e| format!("set_language: {}", e))?;
    parser
        .parse(source, None)
        .ok_or_else(|| "parse returned None".to_string())
}

/// Classify whether the diff between old_source and new_source is
/// a pure literal-value change at the AST level.
pub fn classify_ast(old_source: &str, new_source: &str) -> AstClassification {
    let old_tree = match parse_cpp(old_source) {
        Ok(t) => t,
        Err(e) => return AstClassification::ParseError(format!("old: {}", e)),
    };
    let new_tree = match parse_cpp(new_source) {
        Ok(t) => t,
        Err(e) => return AstClassification::ParseError(format!("new: {}", e)),
    };

    let mut changes = Vec::new();
    let is_value_only = diff_trees(
        old_tree.root_node(),
        new_tree.root_node(),
        old_source.as_bytes(),
        new_source.as_bytes(),
        &mut changes,
    );

    if is_value_only {
        AstClassification::ValueOnly { changes }
    } else {
        AstClassification::Structural
    }
}

fn diff_trees(
    old: Node,
    new: Node,
    old_src: &[u8],
    new_src: &[u8],
    changes: &mut Vec<LiteralChange>,
) -> bool {
    if old.kind() != new.kind() {
        return false;
    }

    let old_text = &old_src[old.byte_range()];
    let new_text = &new_src[new.byte_range()];

    // Fast path: identical subtree text → no change
    if old_text == new_text {
        return true;
    }

    // If this is a literal node, the text change IS a value change
    // regardless of internal child structure (string_literal has
    // children for quotes + content in tree-sitter-cpp).
    if is_literal_node(&old) && is_literal_node(&new) {
        let kind = match old.kind() {
            "string_literal" | "concatenated_string" => LiteralKind::StringLiteral,
            "number_literal" => LiteralKind::NumberLiteral,
            "char_literal" => LiteralKind::CharLiteral,
            "true" => LiteralKind::True,
            "false" => LiteralKind::False,
            _ => return false,
        };
        changes.push(LiteralChange {
            kind,
            old_text: String::from_utf8_lossy(old_text).to_string(),
            new_text: String::from_utf8_lossy(new_text).to_string(),
            line: old.start_position().row + 1,
        });
        return true;
    }

    // Leaf node with different text that isn't a literal → structural
    if old.child_count() == 0 && new.child_count() == 0 {
        return false;
    }

    // Different child counts → structural
    if old.child_count() != new.child_count() {
        return false;
    }

    // Recurse into children
    let mut old_cursor = old.walk();
    let mut new_cursor = new.walk();
    let old_children: Vec<Node> = old.children(&mut old_cursor).collect();
    let new_children: Vec<Node> = new.children(&mut new_cursor).collect();

    for (oc, nc) in old_children.iter().zip(new_children.iter()) {
        if !diff_trees(*oc, *nc, old_src, new_src, changes) {
            return false;
        }
    }

    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_only_string_change() {
        let old = r#"void f() { const char* s = "hello"; }"#;
        let new = r#"void f() { const char* s = "world"; }"#;
        match classify_ast(old, new) {
            AstClassification::ValueOnly { changes } => {
                assert_eq!(changes.len(), 1);
                assert_eq!(changes[0].kind, LiteralKind::StringLiteral);
                assert!(changes[0].old_text.contains("hello"));
                assert!(changes[0].new_text.contains("world"));
            }
            other => panic!("expected ValueOnly, got {:?}", other),
        }
    }

    #[test]
    fn value_only_integer_change() {
        let old = "void f() { int x = 42; }";
        let new = "void f() { int x = 99; }";
        match classify_ast(old, new) {
            AstClassification::ValueOnly { changes } => {
                assert_eq!(changes.len(), 1);
                assert_eq!(changes[0].kind, LiteralKind::NumberLiteral);
                assert_eq!(changes[0].old_text, "42");
                assert_eq!(changes[0].new_text, "99");
            }
            other => panic!("expected ValueOnly, got {:?}", other),
        }
    }

    #[test]
    fn structural_added_statement() {
        let old = "void f() { int x = 1; }";
        let new = "void f() { int x = 1; int y = 2; }";
        assert_eq!(classify_ast(old, new), AstClassification::Structural);
    }

    #[test]
    fn structural_changed_identifier() {
        let old = "void f() { int x = 1; }";
        let new = "void f() { int y = 1; }";
        assert_eq!(classify_ast(old, new), AstClassification::Structural);
    }

    #[test]
    fn identical_source() {
        let src = "void f() { int x = 42; }";
        match classify_ast(src, src) {
            AstClassification::ValueOnly { changes } => {
                assert!(changes.is_empty());
            }
            other => panic!("expected ValueOnly(empty), got {:?}", other),
        }
    }

    #[test]
    fn multiple_value_changes() {
        let old = "void f() { int x = 10; int y = 20; }";
        let new = "void f() { int x = 30; int y = 40; }";
        match classify_ast(old, new) {
            AstClassification::ValueOnly { changes } => {
                assert_eq!(changes.len(), 2);
            }
            other => panic!("expected ValueOnly, got {:?}", other),
        }
    }
}
