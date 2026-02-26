use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use tokio::time::{timeout, Duration};

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

    // Write the primary source (req.source) as the primary file
    let primary_path = workspace.join(&req.filename);
    // Ensure parent directories exist (e.g. src/com/example/)
    if let Some(parent) = primary_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(&primary_path, &req.source).await?;
    java_files.push(primary_path);

    // Write additional files from req.files
    for file in &req.files {
        if file.name.ends_with(".java") {
            let path = workspace.join(&file.name);
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
    // `src/com/example/HelloWorld.java` with `package com.example;`
    // has source root `src/`.  We derive this by stripping the package
    // path from the file's parent directory.
    let source_root = detect_source_root(&req.filename, source_content, workspace);
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
    let stdout_text = String::from_utf8_lossy(&output.stdout).to_string();

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
    let main_class = derive_main_class(&req.filename, &req.source);

    eprintln!("[JavaCompile] Success — main class: {}", main_class);

    Ok(JavaCompileResult {
        classes_dir,
        main_class,
        success: true,
    })
}

/// Derive the fully-qualified main class name from a filename and source code.
///
/// Parses the `package` declaration from the source to get the correct
/// fully-qualified name. Falls back to the simple class name if no package
/// declaration is found.
///
/// `("src/com/example/HelloWorld.java", "package com.example;...")` → `"com.example.HelloWorld"`
/// `("Main.java", "public class Main {...")` → `"Main"`
fn derive_main_class(filename: &str, source: &str) -> String {
    let simple_name = std::path::Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Main")
        .to_string();

    match extract_package(source) {
        Some(pkg) => format!("{}.{}", pkg, simple_name),
        None => simple_name,
    }
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
/// Given `filename = "src/com/example/HelloWorld.java"` and a source file
/// containing `package com.example;`, the package path is `com/example`.
/// Stripping that from the file's parent directory (`src/com/example`) gives
/// us the source root `src/`.
///
/// Falls back to the workspace root if detection fails or there's no package.
fn detect_source_root(filename: &str, source: &str, workspace: &Path) -> PathBuf {
    // Extract package name from source
    let package = extract_package(source);

    if let Some(pkg) = package {
        if !pkg.is_empty() {
            // Convert package to path: "com.example" → "com/example"
            let pkg_path = pkg.replace('.', "/");

            // The file's parent directory (relative to workspace)
            let file_parent = Path::new(filename).parent().unwrap_or(Path::new(""));
            let parent_str = file_parent.to_string_lossy().replace('\\', "/");

            // Strip the package path suffix from the parent directory
            // e.g. "src/com/example" - "com/example" = "src"
            if let Some(root) = parent_str.strip_suffix(&pkg_path) {
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
fn extract_package(source: &str) -> Option<String> {
    for line in source.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("package ") {
            if let Some(pkg) = rest.strip_suffix(';') {
                let pkg = pkg.trim();
                if !pkg.is_empty() {
                    return Some(pkg.to_string());
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
