use crate::compiler::builder::RebuildScope;
use crate::compiler::context::CompileContext;
use crate::compiler::error_parser::{parse_compiler_output, CompilerType};
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
                        anyhow::bail!("GUI compilation timed out after 30s");
                    }
                };

                eprintln!("[CompileGUI] g++ finished with status: {}", output.status);

                if !output.status.success() {
                    let stderr_str = String::from_utf8_lossy(&output.stderr).to_string();
                    eprintln!("[CompileGUI] g++ FAILED:\n{}", stderr_str);

                    // ── AI Heal Loop ──
                    let shared_for_heal = tokio::fs::read_to_string(dir_path.join("shared.h")).await.unwrap_or_default();
                    // Read the cached split architecture from the sidecar so the
                    // heal prompt has the same project-specific "Forbidden Patterns"
                    // context that diff_patch uses.
                    let heal_arch_md: String = {
                        let sidecar = dir_path.join(".synthi_split_meta.json");
                        match tokio::fs::read_to_string(&sidecar).await {
                            Ok(raw) => serde_json::from_str::<serde_json::Value>(&raw)
                                .ok()
                                .and_then(|v| v.get("architecture").and_then(|a| a.as_str()).map(|s| s.to_string()))
                                .unwrap_or_default(),
                            Err(_) => String::new(),
                        }
                    };
                    let heal_arch_hint: Option<&str> = if heal_arch_md.is_empty() {
                        None
                    } else {
                        Some(heal_arch_md.as_str())
                    };
                    let mut heal_content = content.clone();
                    let mut heal_stderr = stderr_str.clone();
                    let mut healed = false;

                    for attempt in 0..2 {
                        eprintln!("[CompileGUI] AI heal attempt {} for gui", attempt + 1);
                        match crate::compiler::stages::ai_utils::perform_ai_heal(
                            "gui", &heal_content, &heal_stderr, &shared_for_heal, heal_arch_hint,
                        ).await {
                            Ok(fixed) => {
                                tokio::fs::write(dir_path.join(fname), &fixed).await?;
                                let mut retry_cmd = system_command("g++");
                                retry_cmd.arg("-shared").arg("-fPIC")
                                    .arg("-D_POSIX_C_SOURCE=199309L").arg("-g").arg("-gdwarf-4")
                                    .arg("-fno-omit-frame-pointer").arg("-fdiagnostics-format=json")
                                    .arg(fname).arg("-I.").arg("-o").arg(&gui_out)
                                    .arg("-ldl").arg("-rdynamic");
                                if req_is_gui { retry_cmd.arg("-lSDL2"); }
                                retry_cmd.current_dir(dir_path);
                                retry_cmd.kill_on_drop(true);
                                if let Ok(retry_child) = retry_cmd.spawn() {
                                    if let Ok(Ok(retry_out)) = timeout(Duration::from_secs(30), retry_child.wait_with_output()).await {
                                        if retry_out.status.success() {
                                            eprintln!("[CompileGUI] AI heal succeeded on attempt {}", attempt + 1);
                                            healed = true;
                                            break;
                                        }
                                        heal_stderr = String::from_utf8_lossy(&retry_out.stderr).to_string();
                                        heal_content = fixed;
                                    }
                                }
                            }
                            Err(e) => {
                                eprintln!("[CompileGUI] AI heal failed: {}", e);
                                break;
                            }
                        }
                    }

                    if !healed {
                        let report = parse_compiler_output(&heal_stderr, "gui", CompilerType::Gcc, true);
                        let diagnostics_json = report.to_json();
                        let diag_payload = serde_json::json!({
                            "sessionId": session_id.clone(),
                            "type": "compile-diagnostics",
                            "language": "cpp",
                            "diagnostics": serde_json::from_str::<serde_json::Value>(&diagnostics_json).unwrap_or_default(),
                            "error_count": report.error_count,
                            "warning_count": report.warning_count,
                            "stage": "compile_gui"
                        });
                        let _ = ctx.log_dc
                            .send_text(serde_json::to_string(&diag_payload).unwrap_or_default())
                            .await;

                        let truncated = if heal_stderr.len() > 500 {
                            format!("{}…", &heal_stderr[..500])
                        } else {
                            heal_stderr.clone()
                        };
                        anyhow::bail!("GUI compilation failed: {}", truncated);
                    }
                }

                let gui_lib_path = gui_out.to_string_lossy().to_string();

                // Update persistent cache on success
                if let Ok(so_data) = tokio::fs::read(&gui_lib_path).await {
                    let source_hash = calculate_hash(&content);
                    let flags_hash = calculate_hash(&"-shared-fPIC-lSDL2");
                    let headers_hash = 0u64;
                    let _ = ctx
                        .incremental_cache
                        .put(
                            gui_cache_key.clone(),
                            source_hash,
                            flags_hash,
                            headers_hash,
                            &so_data,
                        )
                        .await;
                }

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
