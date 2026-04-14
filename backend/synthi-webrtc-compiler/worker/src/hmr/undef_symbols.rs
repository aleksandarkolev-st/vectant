// ============================================================
// UNDEFINED SYMBOL PARSER (ULTRAPLAN Phase 6)
// ============================================================
//
// Generic, library-agnostic parser that extracts undefined-reference
// symbols from compiler/linker stderr. Used by the manifest heal loop
// to ask the AI which library the missing symbols belong to — without
// any hardcoded `SYMBOL_PREFIX_TO_FLAG` lookup table.
//
// The whole point of this module is that it knows NOTHING about
// libraries. It only knows the syntactic shape of "undefined reference"
// errors as emitted by GCC/g++ and clang. Symbol-to-library inference
// happens in the AI heal endpoint, not here.
//
// Supported formats (V1 — extend if other linkers crop up):
//
//   GCC / g++ / ld (Linux):
//     undefined reference to 'FMOD_System_Create'
//     /usr/bin/ld: foo.o:(.text+0x10): undefined reference to `glfwInit'
//     /usr/bin/ld: /tmp/ccXXX.o: in function `main':
//         foo.cpp:(.text+0x10): undefined reference to symbol 'SDL_Init'
//
//   clang / lld (macOS, sometimes Linux):
//     Undefined symbols for architecture x86_64:
//       "_FMOD_System_Create", referenced from:
//           _main in foo.o
//
// Both single quotes (`'X'`) and backticks (`` `X' ``) are accepted —
// GCC 13+ uses unicode quotes in some locales, GCC <13 uses ASCII
// backtick + single quote.
//
// Mach-O symbols on macOS get a leading underscore (`_FMOD_System_Create`).
// We strip that when extracting so the symbol matches the source-level
// identifier the AI will see in the user's code.

use std::collections::HashSet;

/// One symbol the linker reported as undefined. Kept as a struct (not
/// a bare String) so we can attach demangling, source location, etc.
/// later without breaking callers.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct UndefSymbol {
    /// Raw symbol name as it appeared in the linker error, with any
    /// Mach-O leading underscore stripped. Still C++-mangled if the
    /// source was C++ — the AI can demangle visually if needed.
    pub name: String,
}

impl UndefSymbol {
    pub fn new(name: impl Into<String>) -> Self {
        Self { name: name.into() }
    }
}

/// Parse compiler/linker stderr for undefined-reference errors.
///
/// Returns a deduplicated list in first-seen order. Returns empty when
/// no undefined references are present (e.g. the stderr is a regular
/// compile error, not a link error). Caller treats empty as "this is
/// not a manifest-heal-able error" and falls through to the existing
/// AI source heal loop.
///
/// LIBRARY-AGNOSTIC GUARANTEE: this function never matches against
/// known library names. It only matches the syntactic shape of
/// `undefined reference to <something>` and `Undefined symbols ...
/// "_<something>"`. Adding a new library tomorrow needs zero changes.
pub fn extract_undefined_symbols(stderr: &str) -> Vec<UndefSymbol> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<UndefSymbol> = Vec::new();

    for line in stderr.lines() {
        // GCC / g++ / ld: `undefined reference to 'X'` (also accept
        // backtick-single-quote pair, the older GCC quoting).
        if let Some(sym) = extract_gcc_form(line) {
            push_unique(&mut seen, &mut out, sym);
            continue;
        }
        // clang / lld: `"_X", referenced from:` indented under
        // `Undefined symbols for architecture ...`
        if let Some(sym) = extract_clang_form(line) {
            push_unique(&mut seen, &mut out, sym);
            continue;
        }
    }

    out
}

fn push_unique(seen: &mut HashSet<String>, out: &mut Vec<UndefSymbol>, name: String) {
    if name.is_empty() {
        return;
    }
    if seen.insert(name.clone()) {
        out.push(UndefSymbol::new(name));
    }
}

/// Extract the symbol from a GCC-style "undefined reference" line.
/// Accepts both `'X'` and `` `X' `` quoting (older GCC uses the
/// backtick-single-quote pair). Also accepts the verbose form
/// `undefined reference to symbol 'X'` from newer GCC.
fn extract_gcc_form(line: &str) -> Option<String> {
    let needle = "undefined reference to ";
    let pos = line.find(needle)?;
    let after = &line[pos + needle.len()..];

    // Optional `symbol ` prefix in newer GCC's form
    let after = after.strip_prefix("symbol ").unwrap_or(after);

    // Try ASCII single-quote pair: 'X'
    if let Some(stripped) = after.strip_prefix('\'') {
        if let Some(end) = stripped.find('\'') {
            return Some(stripped[..end].to_string());
        }
    }
    // Try backtick-single-quote pair: `X'  (older GCC)
    if let Some(stripped) = after.strip_prefix('`') {
        if let Some(end) = stripped.find('\'') {
            return Some(stripped[..end].to_string());
        }
    }
    // Fallback: take until end-of-line trimmed of trailing punctuation.
    // Useful when the linker emits a nonstandard quoting we haven't
    // explicitly matched. Better to capture the symbol than drop it.
    let trimmed = after
        .trim()
        .trim_end_matches(|c: char| c == '.' || c == ',' || c == ';' || c == ':');
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Extract the symbol from a clang/lld "Undefined symbols ..." block.
/// Matches lines of the form:
///     "_FMOD_System_Create", referenced from:
/// or:
///     "_main", referenced from: ...
/// The leading underscore is the Mach-O ABI convention; we strip it
/// so the result matches the source-level identifier the AI sees.
fn extract_clang_form(line: &str) -> Option<String> {
    let trimmed = line.trim();
    let stripped = trimmed.strip_prefix('"')?;
    let close = stripped.find('"')?;
    let raw = &stripped[..close];
    if raw.is_empty() {
        return None;
    }
    // Mach-O leading underscore — strip exactly one. C symbols on
    // Linux ELF don't have it; clang on Linux outputs the same form
    // without the underscore.
    let unprefixed = raw.strip_prefix('_').unwrap_or(raw);
    Some(unprefixed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_classic_gcc_undefined_reference() {
        let stderr = r#"/usr/bin/ld: /tmp/cc12345.o: in function `main':
foo.cpp:(.text+0x10): undefined reference to `FMOD_System_Create'
collect2: error: ld returned 1 exit status
"#;
        let syms = extract_undefined_symbols(stderr);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "FMOD_System_Create");
    }

    #[test]
    fn parses_modern_gcc_symbol_form() {
        let stderr =
            "/usr/bin/ld: /tmp/cc.o: undefined reference to symbol 'glfwInit'\n";
        let syms = extract_undefined_symbols(stderr);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "glfwInit");
    }

    #[test]
    fn dedupes_repeated_symbols() {
        let stderr = "undefined reference to `SDL_Init'\nundefined reference to `SDL_Init'\nundefined reference to `SDL_Quit'\n";
        let syms = extract_undefined_symbols(stderr);
        assert_eq!(syms.len(), 2);
        assert_eq!(syms[0].name, "SDL_Init");
        assert_eq!(syms[1].name, "SDL_Quit");
    }

    #[test]
    fn parses_clang_macho_form_strips_underscore() {
        let stderr = r#"Undefined symbols for architecture x86_64:
  "_FMOD_System_Create", referenced from:
      _main in foo.o
"#;
        let syms = extract_undefined_symbols(stderr);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "FMOD_System_Create");
    }

    #[test]
    fn returns_empty_on_compile_error_no_link_failure() {
        let stderr = "foo.cpp:5:10: error: 'foo' was not declared in this scope\n";
        assert!(extract_undefined_symbols(stderr).is_empty());
    }

    #[test]
    fn returns_empty_on_blank_input() {
        assert!(extract_undefined_symbols("").is_empty());
    }

    #[test]
    fn parses_mixed_gcc_and_clang_format_in_same_stderr() {
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
}
