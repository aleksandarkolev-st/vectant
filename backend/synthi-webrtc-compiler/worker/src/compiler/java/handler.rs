use anyhow::Result;

use crate::compiler::context::CompileContext;
use crate::compiler::java::compiler::compile_java;
use crate::compiler::java::runner::run_java;
use crate::infra::messages::CompileRequest;

/// Top-level handler for Java compile requests.
///
/// This completely bypasses the C++ pipeline (AI split, guardrails, g++, dlopen).
/// Instead it:
///   1. Compiles `.java` sources with `javac`
///   2. Launches the JVM as a child process
///   3. For GUI apps: reuses the Xvfb/GStreamer video pipeline
pub async fn handle_java_request(
    ctx: &CompileContext,
    mut req: CompileRequest,
    session_id: String,
) -> Result<serde_json::Value> {
    eprintln!("[Java] ╔══════════════════════════════════════════╗");
    eprintln!("[Java] ║  Java Pipeline — compile + run           ║");
    eprintln!("[Java] ╚══════════════════════════════════════════╝");

    // ── Auto-detect GUI mode from source imports ──────────────────
    // If the source references Swing, AWT, or JavaFX, force GUI mode so the
    // runner spawns Xvfb + GStreamer and streams to the in-app preview.
    if !req.is_gui {
        let has_gui_in = |s: &str| -> bool {
            s.contains("javax.swing") || s.contains("java.awt") || s.contains("javafx.")
        };
        let has_gui = has_gui_in(&req.source) || req.files.iter().any(|f| has_gui_in(&f.content));
        if has_gui {
            eprintln!("[Java] Auto-detected GUI imports (main or deps) — enabling GUI mode");
            req.is_gui = true;
        }
    }

    // Notify frontend
    let payload = serde_json::json!({
        "sessionId": &session_id,
        "type": "stderr",
        "line": "[Java] Compiling...\n",
    });
    let _ = ctx
        .log_dc
        .send_text(serde_json::to_string(&payload).unwrap_or_default())
        .await;

    // ── Phase 1: Compile ──────────────────────────────────────────
    let result = compile_java(ctx, &req, &session_id).await?;

    // ── Phase 2: Execute ──────────────────────────────────────────
    let payload = serde_json::json!({
        "sessionId": &session_id,
        "type": "stderr",
        "line": format!("[Java] Running {} ...\n", result.main_class),
    });
    let _ = ctx
        .log_dc
        .send_text(serde_json::to_string(&payload).unwrap_or_default())
        .await;

    run_java(
        ctx,
        &req,
        &result.classes_dir,
        &result.main_class,
        &session_id,
    )
    .await?;

    Ok(serde_json::json!({ "status": "ok" }))
}
