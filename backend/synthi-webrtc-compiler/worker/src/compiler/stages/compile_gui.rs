use crate::compiler::builder::RebuildScope;
use crate::compiler::context::CompileContext;
use crate::compiler::serialization_utils::calculate_hash;
use crate::hmr::incremental_cache::IncrementalCache;
use crate::infra::utils::system_command;
use anyhow::{Context, Result};
use tokio::time::{timeout, Duration};

pub async fn compile_gui(
    ctx: &CompileContext,
    split_data: &serde_json::Value,
    processed_gui: &str, // Phase 1 content
    rebuild_scope: RebuildScope,
    core_lib_path: String,
    output_dir: &std::path::PathBuf,
    timestamp: i64,
    ext: &str,
    session_id: Option<String>,
    req_is_gui: bool, // req.is_gui
) -> Result<Option<String>> {
    let dir_path = &ctx.workspace_path;

    // Skip compilation entirely when the GUI source is empty or whitespace-only.
    // An empty .cpp compiles to a valid .so with no exported symbols, which the
    // runner's validator will reject ("Module 'gui' missing required symbols").
    if processed_gui.trim().is_empty() {
        eprintln!("[CompileGUI] Skipping – no GUI content");
        return Ok(None);
    }

    if split_data.get("gui").is_some() {
        // Only compile GUI if scope includes it
        if rebuild_scope == RebuildScope::Both || rebuild_scope == RebuildScope::GuiOnly {
            let fname = split_data
                .get("gui")
                .and_then(|s| s["filename"].as_str())
                .unwrap_or("gui.cpp");

            // Use the already-processed content from Phase 1 (guardrails already applied)
            let content = processed_gui.to_string();

            // ... (Additional GUI Guardrails should be applied here) ...

            // Hash content + core_lib_path dependency
            let _combined_hash = calculate_hash(&(content.clone(), &core_lib_path));

            let gui_cache_key =
                IncrementalCache::cache_key(&content, &["-shared", "-fPIC", "-lSDL2"], &[]);
            if let Some(cached_so) = ctx.incremental_cache.get(&gui_cache_key).await {
                let path = cached_so.to_string_lossy().to_string();
                eprintln!("[Cache] HIT for gui module (persistent cache)");
                return Ok(Some(path));
            } else {
                // Cache miss - need to compile
                tokio::fs::write(dir_path.join(fname), &content).await?;

                let gui_out = output_dir.join(format!("libgui_{}.{}", timestamp, ext));
                let mut cmd = system_command("g++");
                cmd.arg("-shared")
                    .arg("-fPIC")
                    .arg("-D_POSIX_C_SOURCE=199309L")
                    .arg("-g")
                    .arg("-gdwarf-4")
                    .arg("-fno-omit-frame-pointer")
                    .arg("-fdiagnostics-format=json")
                    .arg(fname)
                    .arg("-I.")
                    .arg("-o")
                    .arg(&gui_out)
                    .arg("-ldl")
                    .arg("-rdynamic");

                if req_is_gui {
                    cmd.arg("-lSDL2");
                }

                cmd.current_dir(dir_path);

                eprintln!(
                    "[CompileGUI] Executing g++ in {:?} args: {:?}",
                    dir_path,
                    cmd.as_std().get_args()
                );

                cmd.kill_on_drop(true);
                let child = cmd.spawn().context("Failed to spawn g++")?;

                let output_res = timeout(Duration::from_secs(30), child.wait_with_output()).await;

                let output = match output_res {
                    Ok(Ok(out)) => out,
                    Ok(Err(e)) => return Err(e.into()),
                    Err(_) => {
                        // child is dropped and killed due to kill_on_drop(true)
                        eprintln!("[CompileGUI] Timed out waiting for g++");
                        let payload = serde_json::json!({
                            "sessionId": session_id.clone(),
                            "status": "done",
                            "success": false,
                            "stage": "compile_gui",
                            "error": "Compilation timed out after 30s"
                        });
                        let _ = ctx
                            .log_dc
                            .send_text(serde_json::to_string(&payload).unwrap_or_default())
                            .await;
                        return Ok(None);
                    }
                };

                eprintln!("[CompileGUI] g++ finished with status: {}", output.status);

                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    eprintln!("[CompileGUI] g++ FAILED:\n{}", stderr);
                    let payload = serde_json::json!({
                        "sessionId": session_id.clone(),
                        "status": "done",
                        "success": false,
                        "stage": "compile_gui",
                        "error": stderr
                    });
                    let _ = ctx
                        .log_dc
                        .send_text(serde_json::to_string(&payload).unwrap_or_default())
                        .await;
                    return Ok(None);
                }

                let gui_lib_path = gui_out.to_string_lossy().to_string();

                // ... (Widget Compilation Logic omitted for brevity but should be here) ...

                return Ok(Some(gui_lib_path));
            }
        }
    } else {
        // Fallback: if AI produced no GUI module, emit a minimal stub
        if req_is_gui {
            // ... stub detection logic ...
        }
    }

    Ok(None)
}
