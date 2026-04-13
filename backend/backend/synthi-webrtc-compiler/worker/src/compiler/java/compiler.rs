use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use tokio::time::{timeout, Duration};
use regex::Regex;

use crate::compiler::context::CompileContext;
use crate::compiler::error_parser::{parse_javac_errors, DiagnosticEvent};
use crate::infra::messages::CompileRequest;
use crate::infra::utils::system_command;

/// Result of a Java compilation attempt.
pub struct JavaCompileResult {
    /// Directory containing compiled `.class` files.
    pub classes_dir: PathBuf,
    /// The main class name to execute (derived from the primary filename).
    pub main_class: String,
    /// Whether compilation succeeded.
    pub success: bool,
}

/// Compile Java source files using `javac`.
///
/// 1. Writes all `.java` files from the request into the workspace.
/// 2. Invokes `javac -d <classes_dir> <files>`.
/// 3. Parses errors and streams diagnostics to the frontend.
pub async fn compile_java(
    ctx: &CompileContext,
    req: &CompileRequest,
    session_id: &str,
) -> Result<JavaCompileResult> {
    let workspace = &ctx.workspace_path;
    let classes_dir = workspace.join("build").join("java_classes");

    // Ensure output directory exists
    tokio::fs::create_dir_all(&classes_dir).await?;

    // ── Step 1: Collect source files ──────────────────────────────
    let mut java_files: Vec<PathBuf> = Vec::new();

    // Determine the effective source content.  req.source should be the
    // current editor content, but in some edge cases it may arrive empty
    // (e.g. currentContent not yet captured).  Log diagnostics to help
    // trace such issues.
    let effective_source = req.source.clone();
    eprintln!(
        "[JavaCompile] req.filename={:?}, req.source.len={}, first_100={:?}",
        req.filename,
        effective_source.len(),
        &effective_source[..effective_source.len().min(100)]
    );

    // Extract package from the source so we can ensure the file lands
    // at the correct path on disk (Java requires directory structure to
    // match the package declaration).
    let source_package = extract_package(&effective_source);

    // Build the path where the primary file should be written.
    // If the filename already contains the package-relative directory
    // (e.g. "src/com/example/gui/HelloWorldGUI.java"), use it as-is.
    // Otherwise (e.g. bare "HelloWorldGUI.java"), reconstruct the path
    // from the package declaration so javac and java can find the class.
    let primary_path = {
        let raw_path = Path::new(&req.filename);
        let has_dir = raw_path.parent().map_or(false, |p| p != Path::new("") && p != Path::new("."));

        if has_dir {
            // Filename already includes a directory path — trust it.
            workspace.join(&req.filename)
        } else if let Some(ref pkg) = source_package {
            // Bare filename + package declaration → reconstruct path.
            // Place under the workspace root using the package as the
            // directory structure (no extra "src/" prefix — that would
            // be an assumption about project layout).
            let pkg_dir = pkg.replace('.', "/");
            let stem = raw_path.file_name().unwrap_or_default();
            let full_dir = workspace.join(&pkg_dir);
            eprintln!(
                "[JavaCompile] Reconstructing path: bare {:?} + package {:?} → {:?}",
                req.filename, pkg, full_dir.join(stem)
            );
            full_dir.join(stem)
        } else {
            // No directory, no package — just use the workspace root.
            workspace.join(&req.filename)
        }
    };

    // Ensure parent directories exist (e.g. com/example/gui/)
    if let Some(parent) = primary_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(&primary_path, &effective_source).await?;
    java_files.push(primary_path.clone());

    // Write additional files from req.files
    for file in &req.files {
        if file.name.ends_with(".java") {
            // Same logic: if the file name lacks directory structure but
            // has a package declaration, reconstruct the path.
            let file_pkg = extract_package(&file.content);
            let raw = Path::new(&file.name);
            let has_dir = raw.parent().map_or(false, |p| p != Path::new("") && p != Path::new("."));

            let path = if has_dir {
                workspace.join(&file.name)
            } else if let Some(ref pkg) = file_pkg {
                let pkg_dir = pkg.replace('.', "/");
                let stem = raw.file_name().unwrap_or_default();
                workspace.join(&pkg_dir).join(stem)
            } else {
                workspace.join(&file.name)
            };

            // Ensure parent directories exist for nested packages
            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            tokio::fs::write(&path, &file.content).await?;
            java_files.push(path);
        }
    }

    if java_files.is_empty() {
        anyhow::bail!("No .java files to compile");
    }

    // ── Step 2: Detect JavaFX and build flags ─────────────────────
    let source_content = &req.source;
    let needs_javafx = source_content.contains("javafx.")
        || source_content.contains("import javafx");

    // ── Step 2b: Detect source root for -sourcepath ───────────────
    // Java packages must match the directory structure. For example,
    // `com/example/HelloWorld.java` with `package com.example;`
    // has source root = workspace root (since the file is already at
    // the package-relative path).
    //
    // If the file was placed under `src/com/example/HelloWorld.java`,
    // the source root is `src/`.
    let source_root = detect_source_root_from_path(&primary_path, &source_package, workspace);
    eprintln!("[JavaCompile] Detected source root: {:?}", source_root);

    // ── Step 3: Run javac ─────────────────────────────────────────
    let mut cmd = system_command("javac");
    cmd.arg("-d")
        .arg(&classes_dir)
        .arg("-sourcepath")
        .arg(&source_root)
        .arg("-Xlint:all");

    // Auto-add JavaFX module path if needed
    if needs_javafx {
        // Standard OpenJFX location on Debian/Ubuntu (openjfx package)
        let javafx_lib = Path::new("/usr/share/openjfx/lib");
        if javafx_lib.exists() {
            cmd.arg("--module-path")
                .arg(javafx_lib)
                .arg("--add-modules")
                .arg("javafx.controls,javafx.fxml,javafx.swing,javafx.media");
        }
    }

    // Add all source files
    for f in &java_files {
        cmd.arg(f);
    }
    cmd.current_dir(workspace);

    eprintln!(
        "[JavaCompile] Running javac in {:?}, files: {:?}",
        workspace,
        java_files.iter().map(|p| p.file_name().unwrap_or_default()).collect::<Vec<_>>()
    );

    cmd.kill_on_drop(true);
    let child = cmd.spawn().context("Failed to spawn javac — is openjdk installed?")?;

    let output = match timeout(Duration::from_secs(30), child.wait_with_output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return Err(e.into()),
        Err(_) => {
            send_compile_status(ctx, session_id, false, "Compilation timed out after 30s").await;
            anyhow::bail!("javac timed out after 30s");
        }
    };

    let stderr_text = String::from_utf8_lossy(&output.stderr).to_string();
    let _stdout_text = String::from_utf8_lossy(&output.stdout).to_string();

    eprintln!("[JavaCompile] javac exit status: {}", output.status);
    if !stderr_text.is_empty() {
        eprintln!("[JavaCompile] stderr:\n{}", stderr_text);
    }

    // ── Step 4: Parse and emit diagnostics ────────────────────────
    if !stderr_text.is_empty() {
        let report = parse_javac_errors(&stderr_text, "java");
        let event = DiagnosticEvent::new("java", report).with_session(session_id);
        let _ = ctx
            .log_dc
            .send_text(event.to_json())
            .await;

        // Also stream raw stderr lines for the terminal panel
        for line in stderr_text.lines() {
            let payload = serde_json::json!({
                "sessionId": session_id,
                "type": "stderr",
                "line": line,
            });
            let _ = ctx
                .log_dc
                .send_text(serde_json::to_string(&payload).unwrap_or_default())
                .await;
        }
    }

    if !output.status.success() {
        send_compile_status(ctx, session_id, false, "javac compilation failed").await;
        anyhow::bail!("javac failed — see diagnostics");
    }

    // ── Step 5: Derive main class name ────────────────────────────
    // Use the package we already extracted (which handles BOM, etc.)
    // rather than re-parsing req.source.
    let main_class = {
        let simple_name = std::path::Path::new(&req.filename)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Main")
            .to_string();
        match &source_package {
            Some(pkg) => format!("{}.{}", pkg, simple_name),
            None => simple_name,
        }
    };

    eprintln!("[JavaCompile] Success — main class: {}", main_class);

    Ok(JavaCompileResult {
        classes_dir,
        main_class,
        success: true,
    })
}

/// Send a compile status message to the frontend.
async fn send_compile_status(ctx: &CompileContext, session_id: &str, success: bool, msg: &str) {
    let payload = serde_json::json!({
        "sessionId": session_id,
        "status": "done",
        "success": success,
        "stage": "compile_java",
        "error": if success { serde_json::Value::Null } else { serde_json::Value::String(msg.to_string()) },
    });
    let _ = ctx
        .log_dc
        .send_text(serde_json::to_string(&payload).unwrap_or_default())
        .await;
}

/// Detect the source root directory for javac's `-sourcepath`.
///
/// Given the ACTUAL path where the primary file was written on disk
/// and its package declaration, strip the package-relative suffix from
/// the path to find the source root.
///
/// Example: primary_path = `/tmp/ws/com/example/gui/Hello.java`,
///          package = `com.example.gui`
///          → source root = `/tmp/ws/`
///
/// Falls back to the workspace root if detection fails or there's no package.
fn detect_source_root_from_path(
    primary_path: &Path,
    package: &Option<String>,
    workspace: &Path,
) -> PathBuf {
    if let Some(pkg) = package {
        if !pkg.is_empty() {
            let pkg_path = pkg.replace('.', "/");

            // Strip workspace prefix to get relative path
            let file_parent = primary_path.parent().unwrap_or(Path::new(""));
            let parent_str = file_parent.to_string_lossy().replace('\\', "/");
            let ws_str = workspace.to_string_lossy().replace('\\', "/");

            // Get relative parent dir from workspace
            let relative = if parent_str.starts_with(&ws_str) {
                parent_str[ws_str.len()..].trim_start_matches('/').to_string()
            } else {
                parent_str.to_string()
            };

            // Strip the package path suffix
            // e.g. "src/com/example" - "com/example" = "src"
            // or   "com/example" - "com/example" = ""
            if let Some(root) = relative.strip_suffix(&pkg_path) {
                let root = root.trim_end_matches('/');
                if root.is_empty() {
                    return workspace.to_path_buf();
                }
                return workspace.join(root);
            }
        }
    }

    // No package or couldn't deduce — use workspace root
    workspace.to_path_buf()
}

/// Extract the package name from Java source code.
/// Returns `Some("com.example")` for `package com.example;`, or `None`.
///
/// Uses a regex to handle edge cases:
/// - UTF-8 BOM at start of file
/// - Multiple spaces between `package` keyword and name
/// - Leading/trailing whitespace
fn extract_package(source: &str) -> Option<String> {
    // Strip UTF-8 BOM if present
    let clean = source.strip_prefix('\u{FEFF}').unwrap_or(source);

    // Use regex for robust matching: `package <name>;`
    // This handles any amount of whitespace and tabs.
    lazy_static::lazy_static! {
        static ref PKG_RE: Regex =
            Regex::new(r"(?m)^\s*package\s+([a-zA-Z_][a-zA-Z0-9_.]*?)\s*;").unwrap();
    }

    // Only look at lines before the first import/class declaration
    for line in clean.lines() {
        let trimmed = line.trim();

        if let Some(caps) = PKG_RE.captures(line) {
            if let Some(m) = caps.get(1) {
                let pkg = m.as_str().to_string();
                if !pkg.is_empty() {
                    return Some(pkg);
                }
            }
        }

        // Package declaration must come before imports/class
        if trimmed.starts_with("import ")
            || trimmed.starts_with("public ")
            || trimmed.starts_with("class ")
        {
            break;
        }
    }
    None
}
