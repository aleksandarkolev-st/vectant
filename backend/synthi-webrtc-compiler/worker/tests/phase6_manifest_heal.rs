// ============================================================
// Phase 6 (ULTRAPLAN) — manifest heal integration tests
// ============================================================
//
// Coverage:
//
//   hmr::undef_symbols::extract_undefined_symbols
//     - classic GCC `undefined reference to \`X'` (backtick-quote)
//     - ASCII single-quote `undefined reference to 'X'` form
//     - modern GCC `undefined reference to symbol 'X'` form
//     - clang macOS `Undefined symbols for architecture ... "_X"`
//     - underscore stripping on clang output (Mach-O ABI)
//     - dedup + first-seen ordering across mixed linker formats
//     - empty / compile-error-only stderr → empty result
//     - C++ mangled symbol names preserved verbatim
//     - multiple errors per line
//     - non-Linux ld formats (best-effort fallback)
//
//   UndefSymbol struct:
//     - constructable + hashable for Set dedup
//
// This file does NOT test perform_ai_heal_manifest or
// try_manifest_heal_retry end-to-end — those require a live ai-engine
// and a real CompileContext. The flag-rebuilding closures used inside
// those helpers ARE tested indirectly via the Phase 3/4/5 suites
// (build_runner_flag_list + compile_core/compile_gui shape assertions).
// Phase 7's corpus will cover the full runtime path once it's built.

use worker::hmr::undef_symbols::{extract_undefined_symbols, UndefSymbol};

// ============================================================
// GCC / g++ / ld — classic formats
// ============================================================

#[test]
fn gcc_classic_backtick_quote() {
    let stderr = r#"/usr/bin/ld: /tmp/ccABC.o: in function `main':
foo.cpp:(.text+0x10): undefined reference to `FMOD_System_Create'
collect2: error: ld returned 1 exit status
"#;
    let syms = extract_undefined_symbols(stderr);
    assert_eq!(syms.len(), 1);
    assert_eq!(syms[0].name, "FMOD_System_Create");
}

#[test]
fn gcc_ascii_single_quote_form() {
    // Some GCC locales emit `undefined reference to 'X'` with ASCII
    // single-quote pairs instead of backtick-single-quote.
    let stderr = "foo.cpp:(.text+0x10): undefined reference to 'SDL_Init'\n";
    let syms = extract_undefined_symbols(stderr);
    assert_eq!(syms.len(), 1);
    assert_eq!(syms[0].name, "SDL_Init");
}

#[test]
fn gcc_modern_symbol_prefix_form() {
    // Newer GCC uses `undefined reference to symbol 'X'`
    let stderr = "/usr/bin/ld: /tmp/cc.o: undefined reference to symbol 'glfwInit'\n";
    let syms = extract_undefined_symbols(stderr);
    assert_eq!(syms.len(), 1);
    assert_eq!(syms[0].name, "glfwInit");
}

#[test]
fn gcc_multiple_symbols_same_stderr_dedups_and_orders() {
    let stderr = r#"
/usr/bin/ld: foo.o: undefined reference to `SDL_Init'
/usr/bin/ld: foo.o: undefined reference to `SDL_Quit'
/usr/bin/ld: foo.o: undefined reference to `SDL_Init'
/usr/bin/ld: foo.o: undefined reference to `FMOD_System_Create'
"#;
    let syms = extract_undefined_symbols(stderr);
    // Order: SDL_Init, SDL_Quit, FMOD_System_Create (SDL_Init second
    // occurrence dedup'd)
    assert_eq!(syms.len(), 3);
    assert_eq!(syms[0].name, "SDL_Init");
    assert_eq!(syms[1].name, "SDL_Quit");
    assert_eq!(syms[2].name, "FMOD_System_Create");
}

#[test]
fn gcc_cpp_mangled_symbols_preserved_verbatim() {
    // C++ mangled names are kept as-is; the AI can visually demangle.
    let stderr = "/usr/bin/ld: foo.o: undefined reference to `_ZN4FMOD6System9setOutputENS_10OUTPUTTYPEE'\n";
    let syms = extract_undefined_symbols(stderr);
    assert_eq!(syms.len(), 1);
    assert_eq!(syms[0].name, "_ZN4FMOD6System9setOutputENS_10OUTPUTTYPEE");
}

// ============================================================
// Clang / lld — macOS Undefined Symbols block
// ============================================================

#[test]
fn clang_macho_strips_leading_underscore() {
    let stderr = r#"Undefined symbols for architecture x86_64:
  "_FMOD_System_Create", referenced from:
      _main in foo.o
ld: symbol(s) not found for architecture x86_64
"#;
    let syms = extract_undefined_symbols(stderr);
    assert_eq!(syms.len(), 1);
    assert_eq!(syms[0].name, "FMOD_System_Create");
}

#[test]
fn clang_multiple_symbols_in_undefined_block() {
    let stderr = r#"Undefined symbols for architecture x86_64:
  "_glfwInit", referenced from:
      _main in foo.o
  "_glfwCreateWindow", referenced from:
      _main in foo.o
  "_glfwTerminate", referenced from:
      _main in foo.o
ld: symbol(s) not found for architecture x86_64
"#;
    let syms = extract_undefined_symbols(stderr);
    assert_eq!(syms.len(), 3);
    assert_eq!(syms[0].name, "glfwInit");
    assert_eq!(syms[1].name, "glfwCreateWindow");
    assert_eq!(syms[2].name, "glfwTerminate");
}

#[test]
fn mixed_gcc_and_clang_formats_in_same_stderr() {
    // Simulates a crossover / hybrid toolchain output.
    let stderr = r#"undefined reference to `glfwInit'
Undefined symbols for architecture x86_64:
  "_glfwTerminate", referenced from:
      _main in foo.o
"#;
    let syms = extract_undefined_symbols(stderr);
    assert_eq!(syms.len(), 2);
    assert_eq!(syms[0].name, "glfwInit");
    assert_eq!(syms[1].name, "glfwTerminate");
}

// ============================================================
// Negative cases
// ============================================================

#[test]
fn compile_error_without_link_failure_returns_empty() {
    let stderr = "foo.cpp:5:10: error: 'foo' was not declared in this scope\n";
    assert!(extract_undefined_symbols(stderr).is_empty());
}

#[test]
fn blank_input_returns_empty() {
    assert!(extract_undefined_symbols("").is_empty());
}

#[test]
fn whitespace_only_returns_empty() {
    assert!(extract_undefined_symbols("   \n\t\n  ").is_empty());
}

#[test]
fn warnings_only_returns_empty() {
    let stderr = "foo.cpp:5:10: warning: unused variable 'x'\n";
    assert!(extract_undefined_symbols(stderr).is_empty());
}

#[test]
fn pure_stdout_without_errors_returns_empty() {
    let stderr = "Compiled successfully.\nLinking.\nDone.\n";
    assert!(extract_undefined_symbols(stderr).is_empty());
}

// ============================================================
// Edge cases — malformed or unusual linker output
// ============================================================

#[test]
fn handles_line_with_no_quote_char_after_reference() {
    // Pathological: linker emits `undefined reference to foo` without
    // any quoting. Fallback should still capture the identifier.
    let stderr = "undefined reference to foo\n";
    let syms = extract_undefined_symbols(stderr);
    assert_eq!(syms.len(), 1);
    assert_eq!(syms[0].name, "foo");
}

#[test]
fn ignores_lines_without_undefined_reference_phrase() {
    let stderr = r#"
/usr/bin/ld: warning: foo.o: requires GNU_PROPERTY_X86_FEATURE_1_IBT
foo.cpp: some compile warning
/usr/bin/ld: undefined reference to `SDL_Init'
"#;
    let syms = extract_undefined_symbols(stderr);
    assert_eq!(syms.len(), 1);
    assert_eq!(syms[0].name, "SDL_Init");
}

#[test]
fn handles_multiple_references_on_adjacent_lines() {
    // Realistic FMOD failure — the linker reports several missing
    // symbols back-to-back from a single module.
    let stderr = r#"/usr/bin/ld: /tmp/cc.o: in function `main':
foo.cpp:(.text+0x10): undefined reference to `FMOD_System_Create'
foo.cpp:(.text+0x20): undefined reference to `FMOD_System_Init'
foo.cpp:(.text+0x30): undefined reference to `FMOD_System_PlaySound'
foo.cpp:(.text+0x40): undefined reference to `FMOD_System_Release'
"#;
    let syms = extract_undefined_symbols(stderr);
    assert_eq!(syms.len(), 4);
    assert_eq!(syms[0].name, "FMOD_System_Create");
    assert_eq!(syms[1].name, "FMOD_System_Init");
    assert_eq!(syms[2].name, "FMOD_System_PlaySound");
    assert_eq!(syms[3].name, "FMOD_System_Release");
}

#[test]
fn handles_mixed_sdl_and_fmod_simultaneous_failures() {
    // The realistic Phase 6 heal target: a project uses two libraries
    // and the manifest has flags for one but not the other.
    let stderr = r#"
/usr/bin/ld: foo.o: undefined reference to `SDL_Init'
/usr/bin/ld: foo.o: undefined reference to `SDL_CreateWindow'
/usr/bin/ld: foo.o: undefined reference to `FMOD_System_Create'
/usr/bin/ld: foo.o: undefined reference to `FMOD_System_Init'
"#;
    let syms = extract_undefined_symbols(stderr);
    assert_eq!(syms.len(), 4);
    // Order preserved from stderr
    assert_eq!(syms[0].name, "SDL_Init");
    assert_eq!(syms[1].name, "SDL_CreateWindow");
    assert_eq!(syms[2].name, "FMOD_System_Create");
    assert_eq!(syms[3].name, "FMOD_System_Init");
}

// ============================================================
// UndefSymbol struct — dedup via HashSet
// ============================================================

#[test]
fn undef_symbol_is_constructable_and_hashable() {
    use std::collections::HashSet;
    let a = UndefSymbol::new("SDL_Init");
    let b = UndefSymbol::new("SDL_Init");
    let c = UndefSymbol::new("SDL_Quit");
    let mut set: HashSet<UndefSymbol> = HashSet::new();
    set.insert(a);
    set.insert(b);
    set.insert(c);
    assert_eq!(set.len(), 2, "duplicate names should dedup");
}

// ============================================================
// Anti-hardcoding guarantee: parser is library-agnostic
// ============================================================

#[test]
fn parser_does_not_match_random_identifier_called_library() {
    // The parser uses only syntactic shape (the `undefined reference`
    // phrase and quote characters). It must NOT special-case any
    // library name. Verify by passing a symbol with a random prefix
    // the parser has never seen before.
    let stderr = "/usr/bin/ld: undefined reference to `NOVEL_LIB_some_function_v2'\n";
    let syms = extract_undefined_symbols(stderr);
    assert_eq!(syms.len(), 1);
    assert_eq!(syms[0].name, "NOVEL_LIB_some_function_v2");
}

#[test]
fn parser_captures_symbols_with_numbers_and_underscores() {
    let stderr = r#"
undefined reference to `lib2023_init'
undefined reference to `_FOO_BAR_42'
undefined reference to `X9Y8Z7'
"#;
    let syms = extract_undefined_symbols(stderr);
    assert_eq!(syms.len(), 3);
    assert_eq!(syms[0].name, "lib2023_init");
    assert_eq!(syms[1].name, "_FOO_BAR_42");
    assert_eq!(syms[2].name, "X9Y8Z7");
}
