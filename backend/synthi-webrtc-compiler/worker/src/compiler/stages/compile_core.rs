use crate::compiler::builder::RebuildScope;
use crate::compiler::context::CompileContext;
use crate::compiler::error_parser::{parse_compiler_output, CompilerType};
use crate::compiler::stages::ai_utils::calculate_hash;
use crate::hmr::incremental_cache::IncrementalCache;
use crate::infra::utils::system_command;
use anyhow::{Context, Result};
use tokio::time::{timeout, Duration};

pub async fn compile_core(
    ctx: &CompileContext,
    split_data: &serde_json::Value,
    processed_core: &str, // Expect this to be ALREADY guardrailed
    rebuild_scope: RebuildScope,
    prev_core_path: Option<String>,
    output_dir: &std::path::PathBuf,
    timestamp: i64,
    ext: &str,
    session_id: Option<String>,
) -> Result<Option<String>> {
    let dir_path = &ctx.workspace_path;

    // Skip core compilation if GUI-only rebuild (reuse existing core.so)
    if rebuild_scope == RebuildScope::Both || rebuild_scope == RebuildScope::CoreOnly {
        if let Some(core) = split_data.get("core") {
            let fname = core["filename"].as_str().unwrap_or("core.cpp");

            // Content is already processed by guardrails in the orchestration layer
            let content = processed_core;

            // Calculate hash for caching
            let content_hash = calculate_hash(&content);

            // Try content-addressable cache first
            // Note: In a real scenario, we might want to include compiler flags in the key
            let cache_key = IncrementalCache::cache_key(content, &["-shared", "-fPIC"], &[]);

            if let Some(cached_so) = ctx.incremental_cache.get(&cache_key).await {
                let path = cached_so.to_string_lossy().to_string();
                eprintln!("[Cache] HIT for core module (persistent cache)");
                return Ok::<_, anyhow::Error>(Some(path));
            } else {
                // Cache miss - need to compile
                tokio::fs::write(dir_path.join(fname), content).await?;

                let core_out = output_dir.join(format!("libcore_{}.{}", timestamp, ext));
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
                    .arg(&core_out)
                    .arg("-ldl")
                    .arg("-pthread") // Required for threaded adapters
                    .arg("-rdynamic");
                cmd.current_dir(dir_path);

                eprintln!(
                    "[CompileCore] Executing g++ in {:?} args: {:?}",
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
                        eprintln!("[CompileCore] Timed out waiting for g++");
                        // Return Err so the pipeline sends a single authoritative
                        // {status:"done", success:false} with the real error text.
                        anyhow::bail!("Core compilation timed out after 30s");
                    }
                };

                eprintln!("[CompileCore] g++ finished with status: {}", output.status);

                if !output.status.success() {
                    let stderr_str = String::from_utf8_lossy(&output.stderr).to_string();
                    eprintln!("[CompileCore] g++ FAILED:\n{}", stderr_str);

                    // ── AI Heal Loop: let the AI fix its own compile errors ──
                    let shared_for_heal = tokio::fs::read_to_string(dir_path.join("shared.h")).await.unwrap_or_default();
                    let mut heal_content = content.to_string();
                    let mut heal_stderr = stderr_str.clone();
                    let mut healed = false;

                    for attempt in 0..2 {
                        eprintln!("[CompileCore] AI heal attempt {} for core", attempt + 1);
                        match crate::compiler::stages::ai_utils::perform_ai_heal(
                            "core", &heal_content, &heal_stderr, &shared_for_heal,
                        ).await {
                            Ok(fixed) => {
                                tokio::fs::write(dir_path.join(fname), &fixed).await?;
                                let mut retry_cmd = system_command("g++");
                                retry_cmd.arg("-shared").arg("-fPIC")
                                    .arg("-D_POSIX_C_SOURCE=199309L").arg("-g").arg("-gdwarf-4")
                                    .arg("-fno-omit-frame-pointer").arg("-fdiagnostics-format=json")
                                    .arg(fname).arg("-I.").arg("-o").arg(&core_out)
                                    .arg("-ldl").arg("-pthread").arg("-rdynamic");
                                retry_cmd.current_dir(dir_path);
                                retry_cmd.kill_on_drop(true);
                                if let Ok(retry_child) = retry_cmd.spawn() {
                                    if let Ok(Ok(retry_out)) = timeout(Duration::from_secs(30), retry_child.wait_with_output()).await {
                                        if retry_out.status.success() {
                                            eprintln!("[CompileCore] AI heal succeeded on attempt {}", attempt + 1);
                                            healed = true;
                                            break;
                                        }
                                        heal_stderr = String::from_utf8_lossy(&retry_out.stderr).to_string();
                                        heal_content = fixed;
                                    }
                                }
                            }
                            Err(e) => {
                                eprintln!("[CompileCore] AI heal failed: {}", e);
                                break;
                            }
                        }
                    }

                    if !healed {
                        // Send diagnostics and fail
                        let report = parse_compiler_output(&heal_stderr, "core", CompilerType::Gcc, true);
                        let diagnostics_json = report.to_json();
                        let diag_payload = serde_json::json!({
                            "sessionId": session_id.clone(),
                            "type": "compile-diagnostics",
                            "language": "cpp",
                            "diagnostics": serde_json::from_str::<serde_json::Value>(&diagnostics_json).unwrap_or_default(),
                            "error_count": report.error_count,
                            "warning_count": report.warning_count,
                            "stage": "compile_core"
                        });
                        let _ = ctx.log_dc
                            .send_text(serde_json::to_string(&diag_payload).unwrap_or_default())
                            .await;

                        let truncated = if heal_stderr.len() > 500 {
                            format!("{}…", &heal_stderr[..500])
                        } else {
                            heal_stderr.clone()
                        };
                        anyhow::bail!("Core compilation failed: {}", truncated);
                    }
                }

                let path = core_out.to_string_lossy().to_string();

                // Update persistent cache
                if let Ok(so_data) = tokio::fs::read(&path).await {
                    let source_hash = content_hash;
                    let flags_hash = calculate_hash(&"-shared-fPIC"); // Simplified flag hash
                    let headers_hash = 0u64; // Assuming headers didn't change for this scoped recompilation or are captured in content hash if included.
                                             // Ideally we'd hash shared.h too, but that affects content via guardrails anyway.
                    let _ = ctx
                        .incremental_cache
                        .put(
                            cache_key.clone(),
                            source_hash,
                            flags_hash,
                            headers_hash,
                            &so_data,
                        )
                        .await;
                }

                let mut cache = ctx.compile_cache.lock().await;
                cache.insert("core".to_string(), (content_hash, path.clone()));
                return Ok::<_, anyhow::Error>(Some(path));
            }
        }
    } else {
        // GUI-only rebuild or No changes: reuse existing core library path
        if let Some(ref existing_core) = prev_core_path {
            println!("Reusing existing core at {}", existing_core);
            return Ok(Some(existing_core.clone()));
        }
    }
    Ok(None)
}
