// ============================================================
// BACKEND SELECTOR (ULTRAPLAN Lightning Phase 10f)
// ============================================================
//
// Picks a `WindowBackend` for a given project at runtime startup.
// Layered fallback:
//
//   Layer 0 (PREFERRED): structured YAML frontmatter in the arch cache
//   Layer 1 (FALLBACK):  markdown `## Language & Framework` header regex
//   Layer 2 (FALLBACK):  link-flag substring scan
//   Layer 3 (FINAL):     PathCBackend (Phase 12, not yet shipped)
//
// Rev3 §10f — the structured field is the rev3 fix for rev2's
// fragile regex-based parsing. The AI is instructed to emit a
// YAML frontmatter block at the top of the arch cache:
//
//   <synthi_arch_cache>
//   ---
//   framework: glfw
//   framework_display: C++ with GLFW + OpenGL
//   hmr_mode_hint: swap
//   window_initial_width: 800
//   window_initial_height: 600
//   ---
//   # Architecture
//   ...
//
// Pre-rev3 sidecars don't have the YAML — the markdown regex (Layer 1)
// catches them. Pre-Phase-3 sidecars (no manifest at all) fall through
// to Layer 2 (link-flag scan) and finally Layer 3 (Path C).

#![allow(dead_code)]
// Selector is currently dead code — runner_bin.rs doesn't call it
// yet because the trait + backends aren't wired in. Phase 10g
// (runner_bin migration) makes this live.

use crate::runtime::backends::glfw_backend::GLFWBackend;
use crate::runtime::backends::raylib_backend::RaylibBackend;
use crate::runtime::backends::sdl2_backend::SDL2Backend;
use crate::runtime::backends::sfml_backend::SFMLBackend;
use crate::runtime::window_backend::WindowBackend;

/// Result of running the selector. Returns the chosen backend
/// boxed as a trait object plus the framework name we matched on
/// (for logging + StatusBar pill display).
pub struct SelectedBackend {
    pub backend: Box<dyn WindowBackend>,
    /// Human-readable display name, e.g. "C++ with GLFW + OpenGL".
    /// Used for the StatusBar pill in Phase 8 and for log lines.
    pub framework_display: String,
    /// Which selector layer matched. Useful for diagnosing why a
    /// project ended up on Path C vs an explicit backend.
    pub matched_layer: SelectorLayer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectorLayer {
    /// Matched via the YAML `framework:` field
    StructuredFrontmatter,
    /// Matched via `## Language & Framework` markdown header
    MarkdownHeader,
    /// Matched via substring scan of manifest link flags
    LinkFlagScan,
    /// No backend matched — fall through to PathCBackend (Phase 12)
    FallbackPathC,
}

/// Inputs the selector reads. The caller (runner_bin.rs at startup)
/// is responsible for sourcing these from the sidecar / manifest /
/// arch cache.
pub struct SelectorInputs<'a> {
    /// Free-form architecture cache markdown (with optional YAML
    /// frontmatter at the top). Empty string when the project has
    /// no arch cache (pre-Phase-1 projects).
    pub arch_cache: &'a str,
    /// All link flags from the manifest. Used for Layer 2 fallback.
    /// Empty slice when no manifest is present.
    pub link_flags: &'a [String],
}

/// Run the selector. Always returns a SelectedBackend — never
/// fails. The fall-through path picks PathCBackend (when Phase 12
/// ships) or, until then, defaults to SDL2Backend with a clear
/// log line so the operator knows the selection was a guess.
///
/// V1 implementation note: PathCBackend isn't shipped yet, so the
/// FallbackPathC layer currently returns SDL2Backend with a log
/// warning. Phase 12 will replace this with a real PathCBackend.
pub fn select_backend(inputs: SelectorInputs) -> SelectedBackend {
    // Layer 0: structured frontmatter
    if let Some(structured) = parse_structured_frontmatter(inputs.arch_cache) {
        if let Some(backend) = dispatch_by_framework_enum(&structured.framework) {
            return SelectedBackend {
                backend,
                framework_display: structured
                    .framework_display
                    .unwrap_or_else(|| structured.framework.clone()),
                matched_layer: SelectorLayer::StructuredFrontmatter,
            };
        }
    }

    // Layer 1: markdown `## Language & Framework` header regex
    if let Some(framework_text) = extract_framework_from_markdown(inputs.arch_cache) {
        if let Some(backend) = dispatch_by_framework_substring(&framework_text) {
            return SelectedBackend {
                backend,
                framework_display: framework_text,
                matched_layer: SelectorLayer::MarkdownHeader,
            };
        }
    }

    // Layer 2: link-flag substring scan
    if let Some((backend, display)) = dispatch_by_link_flags(inputs.link_flags) {
        return SelectedBackend {
            backend,
            framework_display: display,
            matched_layer: SelectorLayer::LinkFlagScan,
        };
    }

    // Layer 3: Path C fallback. Phase 12 ships PathCBackend; until
    // then we default to SDL2 with a log warning.
    eprintln!(
        "[Selector] No backend matched arch cache or link flags — \
         falling back to SDL2Backend (Phase 12 PathCBackend not yet shipped)"
    );
    SelectedBackend {
        backend: Box::new(SDL2Backend::new()),
        framework_display: "SDL2 (selector fallback)".to_string(),
        matched_layer: SelectorLayer::FallbackPathC,
    }
}

// ────────────────────────────────────────────────────────────
// Layer 0: structured YAML frontmatter
// ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StructuredFrontmatter {
    pub framework: String,
    pub framework_display: Option<String>,
}

/// Parse the YAML frontmatter from the top of the arch cache. The
/// frontmatter is delimited by `---` lines, contains key: value
/// pairs. Only `framework` is required; `framework_display` is
/// optional. Other fields are ignored by this parser (they may be
/// read by other code paths).
///
/// Deliberately a small hand-written parser instead of pulling in
/// serde_yaml — the field set is tiny and we don't want a new
/// build-time dep just for a top-of-file YAML block.
pub fn parse_structured_frontmatter(arch_cache: &str) -> Option<StructuredFrontmatter> {
    let trimmed = arch_cache.trim_start();
    // Frontmatter must start at the top with `---`
    let after_first = trimmed.strip_prefix("---")?;
    let after_first = after_first.trim_start_matches('\n');
    // Find the closing `---` (newline + dashes + newline OR end)
    let close_idx = after_first.find("\n---")?;
    let body = &after_first[..close_idx];

    let mut framework: Option<String> = None;
    let mut framework_display: Option<String> = None;

    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = parse_yaml_pair(line) {
            match key {
                "framework" => framework = Some(value),
                "framework_display" => framework_display = Some(value),
                _ => {} // ignore unknown keys
            }
        }
    }

    framework.map(|f| StructuredFrontmatter {
        framework: f,
        framework_display,
    })
}

fn parse_yaml_pair(line: &str) -> Option<(&str, String)> {
    let colon_idx = line.find(':')?;
    let key = line[..colon_idx].trim();
    let value = line[colon_idx + 1..].trim();
    // Strip optional surrounding quotes
    let value = value
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap_or(value);
    let value = value
        .strip_prefix('\'')
        .and_then(|s| s.strip_suffix('\''))
        .unwrap_or(value);
    if key.is_empty() || value.is_empty() {
        return None;
    }
    Some((key, value.to_string()))
}

fn dispatch_by_framework_enum(framework: &str) -> Option<Box<dyn WindowBackend>> {
    let key = framework.trim().to_lowercase();
    match key.as_str() {
        "sdl2" | "sdl" => Some(Box::new(SDL2Backend::new())),
        "glfw" => Some(Box::new(GLFWBackend::new())),
        "raylib" => Some(Box::new(RaylibBackend::new())),
        "sfml" | "csfml" => Some(Box::new(SFMLBackend::new())),
        // Sokol is NOT in this list — it's handled via Phase 12
        // per-project runner (sokol is header-only, no .so to
        // dlopen). See HMR_LIGHTNING_ULTRAPLAN.md §5 rev4 note.
        _ => None,
    }
}

// ────────────────────────────────────────────────────────────
// Layer 1: markdown `## Language & Framework` header
// ────────────────────────────────────────────────────────────

/// Extract the body of the `## Language & Framework` section from
/// the arch cache markdown. Returns the trimmed body text or None.
///
/// Tolerant of whitespace variations:
///   - `## Language & Framework`
///   - `##  Language  &  Framework`
///   - `##\tLanguage\t&\tFramework`
///
/// NOT tolerant of header-level drift (e.g. `### Language & Framework`)
/// or word reordering (`## Framework & Language`). Layer 0's
/// structured field is the safer signal.
pub fn extract_framework_from_markdown(arch_cache: &str) -> Option<String> {
    let mut in_section = false;
    let mut body_lines: Vec<String> = Vec::new();
    for line in arch_cache.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("##") {
            // We're at a header. If we were already in the target
            // section, this header marks the end.
            if in_section {
                break;
            }
            // Check if this is the target header
            let header_body = trimmed.trim_start_matches('#').trim();
            let normalized = normalise_header_words(header_body);
            if normalized == "language & framework" {
                in_section = true;
            }
            continue;
        }
        if in_section {
            let line_trimmed = trimmed.trim();
            if !line_trimmed.is_empty() {
                body_lines.push(line_trimmed.to_string());
            }
        }
    }
    if body_lines.is_empty() {
        None
    } else {
        Some(body_lines.join(" "))
    }
}

fn normalise_header_words(s: &str) -> String {
    // Collapse whitespace runs into single spaces, lowercase
    s.split_whitespace()
        .map(|w| w.to_lowercase())
        .collect::<Vec<_>>()
        .join(" ")
}

fn dispatch_by_framework_substring(text: &str) -> Option<Box<dyn WindowBackend>> {
    let lower = text.to_lowercase();
    if lower.contains("sdl") {
        return Some(Box::new(SDL2Backend::new()));
    }
    if lower.contains("glfw") {
        return Some(Box::new(GLFWBackend::new()));
    }
    if lower.contains("raylib") {
        return Some(Box::new(RaylibBackend::new()));
    }
    if lower.contains("sfml") || lower.contains("csfml") {
        return Some(Box::new(SFMLBackend::new()));
    }
    None
}

// ────────────────────────────────────────────────────────────
// Layer 2: link-flag substring scan
// ────────────────────────────────────────────────────────────

fn dispatch_by_link_flags(
    link_flags: &[String],
) -> Option<(Box<dyn WindowBackend>, String)> {
    for flag in link_flags {
        let lower = flag.to_lowercase();
        if lower.contains("sdl") {
            return Some((Box::new(SDL2Backend::new()), "SDL2 (link-flag)".to_string()));
        }
        if lower.contains("glfw") {
            return Some((Box::new(GLFWBackend::new()), "GLFW (link-flag)".to_string()));
        }
        if lower.contains("raylib") {
            return Some((
                Box::new(RaylibBackend::new()),
                "raylib (link-flag)".to_string(),
            ));
        }
        // csfml-* is the common link flag for projects using
        // CSFML bindings; `sfml` as a substring also covers users
        // who link against the SFML C++ libs directly (we'll still
        // pick the SFMLBackend which goes through CSFML at runtime).
        if lower.contains("csfml") || lower.contains("sfml") {
            return Some((
                Box::new(SFMLBackend::new()),
                "SFML (link-flag)".to_string(),
            ));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_frontmatter() {
        let cache = "---\nframework: glfw\nframework_display: C++ with GLFW\n---\n# Architecture\n";
        let parsed = parse_structured_frontmatter(cache).expect("frontmatter should parse");
        assert_eq!(parsed.framework, "glfw");
        assert_eq!(parsed.framework_display, Some("C++ with GLFW".to_string()));
    }

    #[test]
    fn parses_frontmatter_with_extra_fields() {
        let cache = "---\nframework: sdl2\nframework_display: C++ with SDL2\nhmr_mode_hint: swap\nwindow_initial_width: 800\n---\n";
        let parsed = parse_structured_frontmatter(cache).expect("frontmatter should parse");
        assert_eq!(parsed.framework, "sdl2");
        assert_eq!(parsed.framework_display, Some("C++ with SDL2".to_string()));
    }

    #[test]
    fn parses_frontmatter_with_quoted_values() {
        let cache = "---\nframework: \"glfw\"\nframework_display: 'C++ with GLFW'\n---\n";
        let parsed = parse_structured_frontmatter(cache).expect("should parse");
        assert_eq!(parsed.framework, "glfw");
        assert_eq!(parsed.framework_display, Some("C++ with GLFW".to_string()));
    }

    #[test]
    fn returns_none_when_no_frontmatter() {
        let cache = "# Architecture\n## Language & Framework\nC++ with SDL2\n";
        assert!(parse_structured_frontmatter(cache).is_none());
    }

    #[test]
    fn returns_none_when_frontmatter_has_no_framework() {
        let cache = "---\nother_field: value\n---\n";
        assert!(parse_structured_frontmatter(cache).is_none());
    }

    #[test]
    fn extract_framework_from_simple_markdown() {
        let cache = "# Architecture\n\n## Language & Framework\nC++ with GLFW + OpenGL\n";
        let extracted = extract_framework_from_markdown(cache).unwrap();
        assert!(extracted.contains("GLFW"));
    }

    #[test]
    fn extract_framework_handles_extra_whitespace() {
        let cache = "##  Language  &  Framework  \nC++ with SDL2\n";
        let extracted = extract_framework_from_markdown(cache).unwrap();
        assert!(extracted.contains("SDL2"));
    }

    #[test]
    fn extract_framework_stops_at_next_header() {
        let cache = "## Language & Framework\nC++ with SDL2\n## Module Contract\nshould not be in result\n";
        let extracted = extract_framework_from_markdown(cache).unwrap();
        assert!(extracted.contains("SDL2"));
        assert!(!extracted.contains("Module"));
    }

    #[test]
    fn extract_framework_returns_none_on_missing_header() {
        let cache = "# Architecture\n## Module Contract\nstuff\n";
        assert!(extract_framework_from_markdown(cache).is_none());
    }

    #[test]
    fn dispatch_by_framework_enum_recognises_known_keys() {
        assert!(dispatch_by_framework_enum("sdl2").is_some());
        assert!(dispatch_by_framework_enum("SDL2").is_some());
        assert!(dispatch_by_framework_enum("sdl").is_some());
        assert!(dispatch_by_framework_enum("glfw").is_some());
        assert!(dispatch_by_framework_enum("GLFW").is_some());
        // Phase 10c
        assert!(dispatch_by_framework_enum("raylib").is_some());
        assert!(dispatch_by_framework_enum("RAYLIB").is_some());
        // Phase 10e
        assert!(dispatch_by_framework_enum("sfml").is_some());
        assert!(dispatch_by_framework_enum("SFML").is_some());
        assert!(dispatch_by_framework_enum("csfml").is_some());
        // Sokol is explicitly NOT wired at Phase 10 — it goes
        // through Phase 12 per-project runner because it's a
        // header-only library with no .so to dlopen.
        assert!(dispatch_by_framework_enum("sokol").is_none());
        assert!(dispatch_by_framework_enum("unknown_lib").is_none());
    }

    #[test]
    fn dispatch_by_framework_substring_recognises_text() {
        assert!(dispatch_by_framework_substring("C++ with SDL2").is_some());
        assert!(dispatch_by_framework_substring("C++ with GLFW + OpenGL").is_some());
        // Phase 10c — raylib is now a real option
        assert!(dispatch_by_framework_substring("C++ with raylib").is_some());
        assert!(dispatch_by_framework_substring("C++ with raylib 5.0").is_some());
        // Phase 10e — SFML via CSFML bindings
        assert!(dispatch_by_framework_substring("C++ with SFML").is_some());
        assert!(dispatch_by_framework_substring("C++ with CSFML 2.6").is_some());
    }

    #[test]
    fn dispatch_by_link_flags_finds_raylib() {
        let flags = vec!["-lraylib".to_string(), "-ldl".to_string()];
        let result = dispatch_by_link_flags(&flags);
        assert!(result.is_some());
        let (backend, _) = result.unwrap();
        assert_eq!(backend.name(), "raylib");
    }

    #[test]
    fn dispatch_by_link_flags_finds_sfml() {
        // CSFML's actual link flags split across subsystems
        let flags = vec![
            "-lcsfml-graphics".to_string(),
            "-lcsfml-window".to_string(),
            "-lcsfml-system".to_string(),
        ];
        let result = dispatch_by_link_flags(&flags);
        assert!(result.is_some());
        let (backend, _) = result.unwrap();
        assert_eq!(backend.name(), "SFML");
    }

    #[test]
    fn dispatch_by_link_flags_finds_sfml_via_cpp_sfml_flags() {
        // A project that links the SFML C++ libs directly (e.g.
        // `-lsfml-graphics`) still routes through the SFMLBackend;
        // the backend uses CSFML under the hood at runtime.
        let flags = vec!["-lsfml-graphics".to_string()];
        let result = dispatch_by_link_flags(&flags);
        assert!(result.is_some());
        let (backend, _) = result.unwrap();
        assert_eq!(backend.name(), "SFML");
    }

    #[test]
    fn dispatch_by_link_flags_finds_sdl() {
        let flags = vec!["-lSDL2".to_string(), "-ldl".to_string()];
        let result = dispatch_by_link_flags(&flags);
        assert!(result.is_some());
    }

    #[test]
    fn dispatch_by_link_flags_finds_glfw() {
        let flags = vec!["-lglfw".to_string(), "-ldl".to_string()];
        let result = dispatch_by_link_flags(&flags);
        assert!(result.is_some());
    }

    #[test]
    fn dispatch_by_link_flags_finds_glfw_versioned() {
        // -lglfw3 is a real distro variant
        let flags = vec!["-lglfw3".to_string()];
        let result = dispatch_by_link_flags(&flags);
        assert!(result.is_some());
    }

    #[test]
    fn dispatch_by_link_flags_returns_none_for_unknown() {
        let flags = vec!["-lraylib".to_string()];
        let result = dispatch_by_link_flags(&flags);
        assert!(result.is_none());
    }

    #[test]
    fn select_backend_picks_layer_0_when_frontmatter_present() {
        let inputs = SelectorInputs {
            arch_cache: "---\nframework: glfw\nframework_display: C++ with GLFW\n---\n",
            link_flags: &[],
        };
        let selected = select_backend(inputs);
        assert_eq!(selected.matched_layer, SelectorLayer::StructuredFrontmatter);
        assert_eq!(selected.backend.name(), "GLFW");
        assert_eq!(selected.framework_display, "C++ with GLFW");
    }

    #[test]
    fn select_backend_falls_to_layer_1_when_no_frontmatter() {
        let inputs = SelectorInputs {
            arch_cache: "# Architecture\n## Language & Framework\nC++ with SDL2\n",
            link_flags: &[],
        };
        let selected = select_backend(inputs);
        assert_eq!(selected.matched_layer, SelectorLayer::MarkdownHeader);
        assert_eq!(selected.backend.name(), "SDL2");
    }

    #[test]
    fn select_backend_falls_to_layer_2_when_no_arch_cache() {
        let inputs = SelectorInputs {
            arch_cache: "",
            link_flags: &["-lglfw".to_string(), "-ldl".to_string()],
        };
        let selected = select_backend(inputs);
        assert_eq!(selected.matched_layer, SelectorLayer::LinkFlagScan);
        assert_eq!(selected.backend.name(), "GLFW");
    }

    #[test]
    fn select_backend_falls_to_path_c_when_nothing_matches() {
        let inputs = SelectorInputs {
            arch_cache: "",
            link_flags: &["-lsomething_unknown".to_string()],
        };
        let selected = select_backend(inputs);
        assert_eq!(selected.matched_layer, SelectorLayer::FallbackPathC);
    }
}
