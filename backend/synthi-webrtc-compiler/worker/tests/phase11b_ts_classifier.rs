// ============================================================
// Phase 11b — Tree-sitter AST value-only classifier tests
// ============================================================

use worker::hmr::ts_value_classifier::{classify_ast, AstClassification, LiteralKind};

#[test]
fn string_literal_value_only() {
    let old = r#"
void core_on_load(void* state) {
    SDL_CreateWindow("My Game", 0, 0, 800, 600, 0);
}
"#;
    let new = r#"
void core_on_load(void* state) {
    SDL_CreateWindow("My App!", 0, 0, 800, 600, 0);
}
"#;
    match classify_ast(old, new) {
        AstClassification::ValueOnly { changes } => {
            assert_eq!(changes.len(), 1);
            assert_eq!(changes[0].kind, LiteralKind::StringLiteral);
        }
        other => panic!("expected ValueOnly, got {:?}", other),
    }
}

#[test]
fn integer_value_only() {
    let old = "void f() { int w = 800; int h = 600; }";
    let new = "void f() { int w = 900; int h = 700; }";
    match classify_ast(old, new) {
        AstClassification::ValueOnly { changes } => {
            assert_eq!(changes.len(), 2);
            assert!(changes.iter().all(|c| c.kind == LiteralKind::NumberLiteral));
        }
        other => panic!("expected ValueOnly, got {:?}", other),
    }
}

#[test]
fn structural_new_function() {
    let old = "void f() { }";
    let new = "void f() { } void g() { }";
    assert_eq!(classify_ast(old, new), AstClassification::Structural);
}

#[test]
fn structural_added_param() {
    let old = "void f(int x) { }";
    let new = "void f(int x, int y) { }";
    assert_eq!(classify_ast(old, new), AstClassification::Structural);
}

#[test]
fn structural_changed_type() {
    let old = "void f() { int x = 1; }";
    let new = "void f() { float x = 1; }";
    assert_eq!(classify_ast(old, new), AstClassification::Structural);
}

#[test]
fn structural_added_line() {
    let old = "void f() {\n    int x = 1;\n}";
    let new = "void f() {\n    int x = 1;\n    int y = 2;\n}";
    assert_eq!(classify_ast(old, new), AstClassification::Structural);
}

#[test]
fn identical_is_value_only_empty() {
    let src = "void f() { int x = 42; }";
    match classify_ast(src, src) {
        AstClassification::ValueOnly { changes } => {
            assert!(changes.is_empty());
        }
        other => panic!("expected empty ValueOnly, got {:?}", other),
    }
}

#[test]
fn mixed_value_and_structural_is_structural() {
    let old = "void f() { int x = 42; }";
    let new = "void f() { int x = 99; printf(\"hi\"); }";
    assert_eq!(classify_ast(old, new), AstClassification::Structural);
}

#[test]
fn multiline_realistic_edit() {
    let old = r#"#include "shared.h"

void core_on_load(void* state) {
    AppState* app = (AppState*)state;
    app->title = "HMR Demo";
    app->width = 800;
    app->height = 600;
    app->bg_r = 30;
    app->bg_g = 30;
    app->bg_b = 30;
}
"#;
    let new = r#"#include "shared.h"

void core_on_load(void* state) {
    AppState* app = (AppState*)state;
    app->title = "HMR Live";
    app->width = 900;
    app->height = 700;
    app->bg_r = 50;
    app->bg_g = 50;
    app->bg_b = 50;
}
"#;
    match classify_ast(old, new) {
        AstClassification::ValueOnly { changes } => {
            assert!(
                changes.len() >= 4,
                "should detect multiple value changes, got {}",
                changes.len()
            );
        }
        other => panic!("expected ValueOnly, got {:?}", other),
    }
}
