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

    // ── Step 3: Run javac ─────────────────────────────────────────
    let mut cmd = system_command("javac");
    cmd.arg("-d")
        .arg(&classes_dir)
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
    let main_class = derive_main_class(&req.filename);

    eprintln!("[JavaCompile] Success — main class: {}", main_class);

    Ok(JavaCompileResult {
        classes_dir,
        main_class,
        success: true,
    })
}

/// Derive the fully-qualified main class name from a filename.
/// `"Main.java"` → `"Main"`, `"com/example/App.java"` → `"com.example.App"`
fn derive_main_class(filename: &str) -> String {
    let stem = filename
        .strip_suffix(".java")
        .unwrap_or(filename);
    // Convert path separators to dots for package-qualified names
    stem.replace('/', ".").replace('\\', ".")
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
