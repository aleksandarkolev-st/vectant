//! Workspace-wide dependency installer for LSP support.
//!
//! Scans the workspace (recursively) for known manifest files (package.json,
//! pom.xml, go.mod, Cargo.toml, …) and runs the appropriate package manager
//! for **every** one found.  This means a polyglot project with both a
//! `pom.xml` and a `package.json` at the root gets both `mvn` and `npm`
//! executed, and a monorepo with `frontend/package.json` and
//! `backend/requirements.txt` gets both installed too.
//!
//! **Build-system manifests** (CMakeLists.txt, Makefile, meson.build, Pipfile,
//! poetry.lock) are now also detected and handled.
//!
//! **Import-based fallback**: when NO manifests are found at all, the
//! `import_scanner` module is invoked to scan source files for
//! import/require/include patterns and install detected third-party packages.
//! This solves the "standalone file" problem (e.g. a single `main.py` with
//! `import flask` but no `requirements.txt`).
//!
//! The installer is best-effort: individual failures are logged but never
//! prevent the language server from starting.  A marker file
//! (`.synthi_deps_installed`) is written after the first successful run so
//! subsequent LSP connections skip the (potentially slow) install step
//! unless the workspace was re-downloaded.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tokio::process::Command;
use std::process::Stdio;

/// Directories we never descend into while scanning for manifests.
const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "__pycache__", "target", "build", "dist",
    ".gradle", ".idea", "bin", "obj", ".dart_tool", "_build", "deps",
    ".elixir_ls", ".jdtls-data", "zig-cache", ".next", "vendor",
    "zig-out", ".zig-cache", "coverage", ".nyc_output", ".tox",
    "venv", ".venv", "env", ".env", ".mypy_cache", ".pytest_cache",
];

/// Maximum directory depth to scan (prevents runaway recursion).
const MAX_DEPTH: usize = 4;

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/// Scan `workspace` for every known manifest file and install dependencies
/// for each one found.  Returns the number of successful installs.
///
/// `lang` is the LSP language being started (e.g. "python", "cpp").  When no
/// manifests are found, the import scanner uses this to detect third-party
/// imports from source files and install them.
///
/// This function is **idempotent**: it writes a `.synthi_deps_installed`
/// marker after the first run and becomes a no-op on subsequent calls
/// unless `force` is `true`.
pub async fn install_all_deps(workspace: &Path, lang: &str, force: bool) -> usize {
    let marker = workspace.join(".synthi_deps_installed");
    if !force && marker.exists() {
        println!("[LSP-DEPS] Dependencies already installed (marker exists), skipping manifest install.");

        // Even though manifests were already installed, the import scanner
        // tracks per-language markers.  A new language that wasn't covered
        // by the manifests still needs its third-party imports resolved.
        let manifests = scan_manifests(workspace);
        if manifests.is_empty() || !manifests_cover_lang(&manifests, lang) {
            println!("[LSP-DEPS] Running import scanner for uncovered lang='{}'.", lang);
            super::import_scanner::scan_and_install(workspace, lang, false).await;
        }
        return 0;
    }

    println!("[LSP-DEPS] Scanning workspace for manifest files...");
    let manifests = scan_manifests(workspace);
    if manifests.is_empty() {
        println!("[LSP-DEPS] No manifest files found — falling back to import scanner.");
        let _ = std::fs::write(&marker, "done-import-scan");
        // Delegate to the import scanner for standalone-file workspaces
        return super::import_scanner::scan_and_install(workspace, lang, force).await;
    }

    println!("[LSP-DEPS] Found {} manifest location(s):", manifests.len());
    for m in &manifests {
        println!("[LSP-DEPS]   {:?} in {}", m.kind, m.dir.display());
    }

    let mut ok_count = 0usize;
    // De-duplicate: don't run the same (kind, dir) twice.
    let mut seen = HashSet::new();

    for m in &manifests {
        let key = (m.kind, m.dir.clone());
        if !seen.insert(key) {
            continue;
        }
        match run_install(m).await {
            Ok(()) => {
                ok_count += 1;
                println!("[LSP-DEPS] ✓ {:?} in {}", m.kind, m.dir.display());
            }
            Err(e) => {
                eprintln!("[LSP-DEPS] ✗ {:?} in {}: {}", m.kind, m.dir.display(), e);
            }
        }
    }

    println!("[LSP-DEPS] Dependency install complete: {}/{} succeeded.", ok_count, manifests.len());

    // ── Standalone-file fallback for the CURRENT language ──────────
    // If the manifests we found don't cover the language being started,
    // a standalone file (e.g. a lone `main.py` with `import flask` in a
    // workspace that only has a `package.json` for JS) would get zero
    // dependency installation.  Run the import scanner for just that
    // language as a safety net.
    if !manifests_cover_lang(&manifests, lang) {
        println!("[LSP-DEPS] No manifest covers lang='{}' — running import scanner as supplement.", lang);
        let extra = super::import_scanner::scan_and_install(workspace, lang, false).await;
        ok_count += extra;
    }

    let _ = std::fs::write(&marker, format!("installed {} of {}", ok_count, manifests.len()));
    ok_count
}

/// Returns `true` if at least one manifest is relevant to `lang`.
fn manifests_cover_lang(manifests: &[Manifest], lang: &str) -> bool {
    manifests.iter().any(|m| match lang {
        "python" | "py" => matches!(m.kind,
            ManifestKind::Pip | ManifestKind::PipEditable |
            ManifestKind::Pipfile | ManifestKind::Poetry | ManifestKind::Conda),
        "javascript" | "js" | "typescript" | "ts" | "svelte" => matches!(m.kind,
            ManifestKind::Npm | ManifestKind::Yarn | ManifestKind::Pnpm),
        "go" => matches!(m.kind, ManifestKind::GoMod),
        "rust" => matches!(m.kind, ManifestKind::Cargo),
        "java" | "kotlin" | "kt" => matches!(m.kind, ManifestKind::Maven | ManifestKind::Gradle),
        "csharp" | "cs" => matches!(m.kind, ManifestKind::Dotnet),
        "ruby" | "rb" => matches!(m.kind, ManifestKind::Gemfile),
        "php" => matches!(m.kind, ManifestKind::Composer),
        "dart" => matches!(m.kind, ManifestKind::DartPub),
        "elixir" | "ex" => matches!(m.kind, ManifestKind::MixExs),
        "cpp" | "c" => matches!(m.kind,
            ManifestKind::CMake | ManifestKind::Makefile | ManifestKind::Meson),
        _ => false,
    })
}

// ────────────────────────────────────────────────────────────────
// Manifest scanning
// ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ManifestKind {
    Npm,
    Yarn,
    Pnpm,
    Pip,
    PipEditable,
    Pipfile,
    Poetry,
    Conda,
    GoMod,
    Cargo,
    Maven,
    Gradle,
    Dotnet,
    Gemfile,
    Composer,
    DartPub,
    MixExs,
    CMake,
    Makefile,
    Meson,
}

pub struct Manifest {
    pub kind: ManifestKind,
    pub dir: PathBuf,
}

/// Walk the workspace up to `MAX_DEPTH` and collect every manifest found.
fn scan_manifests(root: &Path) -> Vec<Manifest> {
    let mut results = Vec::new();
    walk(root, 0, &mut results);
    results
}

fn walk(dir: &Path, depth: usize, out: &mut Vec<Manifest>) {
    if depth > MAX_DEPTH {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    // Track what we find in this directory so we can pick the right npm variant.
    let mut has_package_json = false;
    let mut has_package_lock = false;
    let mut has_yarn_lock = false;
    let mut has_pnpm_lock = false;

    let mut subdirs: Vec<PathBuf> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        if path.is_dir() {
            let lower = name_str.to_ascii_lowercase();
            if SKIP_DIRS.contains(&lower.as_str()) {
                continue;
            }
            subdirs.push(path);
            continue;
        }

        // Check for manifest files
        match name_str.as_ref() {
            "package.json"       => has_package_json = true,
            "package-lock.json"  => has_package_lock = true,
            "yarn.lock"          => has_yarn_lock = true,
            "pnpm-lock.yaml"     => has_pnpm_lock = true,
            "requirements.txt"   => out.push(Manifest { kind: ManifestKind::Pip, dir: dir.to_path_buf() }),
            "pyproject.toml"     => out.push(Manifest { kind: ManifestKind::PipEditable, dir: dir.to_path_buf() }),
            "setup.py"           => out.push(Manifest { kind: ManifestKind::PipEditable, dir: dir.to_path_buf() }),
            "Pipfile"            => out.push(Manifest { kind: ManifestKind::Pipfile, dir: dir.to_path_buf() }),
            "poetry.lock"        => out.push(Manifest { kind: ManifestKind::Poetry, dir: dir.to_path_buf() }),
            "environment.yml" | "environment.yaml"
                                 => out.push(Manifest { kind: ManifestKind::Conda, dir: dir.to_path_buf() }),
            "go.mod"             => out.push(Manifest { kind: ManifestKind::GoMod, dir: dir.to_path_buf() }),
            "Cargo.toml"         => out.push(Manifest { kind: ManifestKind::Cargo, dir: dir.to_path_buf() }),
            "pom.xml"            => out.push(Manifest { kind: ManifestKind::Maven, dir: dir.to_path_buf() }),
            "build.gradle" | "build.gradle.kts"
                                 => out.push(Manifest { kind: ManifestKind::Gradle, dir: dir.to_path_buf() }),
            "Gemfile"            => out.push(Manifest { kind: ManifestKind::Gemfile, dir: dir.to_path_buf() }),
            "composer.json"      => out.push(Manifest { kind: ManifestKind::Composer, dir: dir.to_path_buf() }),
            "pubspec.yaml"       => out.push(Manifest { kind: ManifestKind::DartPub, dir: dir.to_path_buf() }),
            "mix.exs"            => out.push(Manifest { kind: ManifestKind::MixExs, dir: dir.to_path_buf() }),
            "CMakeLists.txt"     => out.push(Manifest { kind: ManifestKind::CMake, dir: dir.to_path_buf() }),
            "meson.build"        => out.push(Manifest { kind: ManifestKind::Meson, dir: dir.to_path_buf() }),
            "Makefile" | "makefile" | "GNUmakefile"
                                 => out.push(Manifest { kind: ManifestKind::Makefile, dir: dir.to_path_buf() }),
            _ => {
                // .csproj / .sln
                if let Some(ext) = path.extension() {
                    if ext == "csproj" || ext == "sln" {
                        out.push(Manifest { kind: ManifestKind::Dotnet, dir: dir.to_path_buf() });
                    }
                }
            }
        }
    }

    // Decide npm flavour
    if has_package_json {
        let kind = if has_pnpm_lock {
            ManifestKind::Pnpm
        } else if has_yarn_lock {
            ManifestKind::Yarn
        } else {
            ManifestKind::Npm
        };
        out.push(Manifest { kind, dir: dir.to_path_buf() });
    }

    // Recurse into subdirectories
    for sub in subdirs {
        walk(&sub, depth + 1, out);
    }
}

// ────────────────────────────────────────────────────────────────
// Dependency install commands
// ────────────────────────────────────────────────────────────────

async fn run_install(m: &Manifest) -> Result<(), String> {
    let (program, args): (&str, Vec<&str>) = match m.kind {
        ManifestKind::Npm => {
            // Use `npm ci` if lockfile exists, else `npm install`
            if m.dir.join("package-lock.json").exists() {
                ("npm", vec!["ci", "--ignore-scripts"])
            } else {
                ("npm", vec!["install", "--ignore-scripts"])
            }
        }
        ManifestKind::Yarn => ("yarn", vec!["install", "--frozen-lockfile"]),
        ManifestKind::Pnpm => ("pnpm", vec!["install", "--frozen-lockfile"]),
        ManifestKind::Pip => (
            "pip",
            vec!["install", "-r", "requirements.txt", "--quiet", "--break-system-packages"],
        ),
        ManifestKind::PipEditable => (
            "pip",
            vec!["install", "-e", ".", "--quiet", "--break-system-packages"],
        ),
        ManifestKind::Pipfile => (
            "pipenv",
            vec!["install", "--deploy"],
        ),
        ManifestKind::Poetry => (
            "poetry",
            vec!["install", "--no-interaction"],
        ),
        ManifestKind::Conda => {
            // `conda env update` installs into the base env from environment.yml
            ("conda", vec!["env", "update", "--file", "environment.yml", "--prune", "-q"])
        }
        ManifestKind::GoMod => ("go", vec!["mod", "download"]),
        ManifestKind::Cargo => ("cargo", vec!["fetch"]),
        ManifestKind::Maven => ("mvn", vec!["dependency:resolve", "-q"]),
        ManifestKind::Gradle => {
            let wrapper = m.dir.join("gradlew");
            if wrapper.exists() {
                ("./gradlew", vec!["dependencies", "--quiet"])
            } else {
                ("gradle", vec!["dependencies", "--quiet"])
            }
        }
        ManifestKind::Dotnet => (
            "dotnet",
            vec!["restore", "--verbosity", "quiet"],
        ),
        ManifestKind::Gemfile => ("bundle", vec!["install", "--quiet"]),
        ManifestKind::Composer => (
            "composer",
            vec!["install", "--no-interaction", "--quiet"],
        ),
        ManifestKind::DartPub => ("dart", vec!["pub", "get"]),
        ManifestKind::MixExs => ("mix", vec!["deps.get"]),
        ManifestKind::CMake => {
            // Generate compile_commands.json for clangd, then build deps
            ("cmake", vec!["-B", "build", "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON", "."])
        }
        ManifestKind::Makefile => {
            // Use `bear` to generate compile_commands.json from Makefile
            // (if bear isn't installed, fall back to just running make)
            ("make", vec!["-j4"])
        }
        ManifestKind::Meson => {
            // Meson generates compile_commands.json by default in build dir
            ("meson", vec!["setup", "build"])
        }
    };

    println!("[LSP-DEPS] Running: {} {} (in {})", program, args.join(" "), m.dir.display());

    // Some tools are installed to non-standard paths (e.g. Dart SDK at
    // /opt/dart-sdk/bin or /usr/lib/dart/bin).  Extend PATH so the
    // package manager can find the binary even before the user's shell
    // profile has been sourced.
    let current_path = std::env::var("PATH").unwrap_or_default();
    let extended_path = match m.kind {
        ManifestKind::DartPub => format!("/opt/dart-sdk/bin:/usr/lib/dart/bin:{}", current_path),
        _ => current_path,
    };

    let status = Command::new(program)
        .args(&args)
        .current_dir(&m.dir)
        .env("PATH", &extended_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .status()
        .await
        .map_err(|e| format!("Failed to run {}: {}", program, e))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("{} exited with code {:?}", program, status.code()))
    }
}
