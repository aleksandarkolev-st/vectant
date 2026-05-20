use crate::compiler::builder::RebuildScope;
use crate::compiler::context::CompileContext;
use crate::compiler::error_parser::{parse_compiler_output, CompilerType};
use crate::compiler::stages::ai_utils::calculate_hash;
use crate::compiler::stages::compile_helpers::{
    compile_to_object_command, cpp_compile_command, link_object_to_so_command, object_path_for_so,
};
use crate::hmr::compile_manifest::{CompileManifest, ModuleKind};
use crate::hmr::incremental_cache::IncrementalCache;
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
    compile_manifest: Option<&CompileManifest>,
) -> Result<Option<String>> {
    let dir_path = &ctx.workspace_path;

    // ULTRAPLAN Phase 3: resolve the effective compile manifest.
    // If the AI-synthesised manifest is present (universal split prompt
    // path), use it to drive the g++ invocation. Otherwise fall back to
    // the hardcoded SDL2 shape, which matches the pre-Phase-3 behavior
    // exactly — so existing SDL2 projects compile identically whether or
    // not a manifest is in the sidecar.
    let owned_default_manifest;
    let effective_manifest: &CompileManifest = match compile_manifest {
        Some(m) => m,
        None => {
            owned_default_manifest = CompileManifest::sdl2_default();
            &owned_default_manifest
        }
    };
    let compiler_exe = effective_manifest.select_compiler(ModuleKind::Core);
    let std_flag = format!("-std={}", effective_manifest.std);

    // Skip core compilation if GUI-only rebuild (reuse existing core.so)
    if rebuild_scope == RebuildScope::Both || rebuild_scope == RebuildScope::CoreOnly {
        if let Some(core) = split_data.get("core") {
            let fname = core["filename"].as_str().unwrap_or("core.cpp");

            // Content is already processed by guardrails in the orchestration layer
            let content = processed_core;
            let source_path = dir_path.join(fname);
            if let Some(parent) = source_path.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            tokio::fs::write(&source_path, content).await?;

            // Calculate hash for caching
            let content_hash = calculate_hash(&content);

            // Build the effective flag list used both for compile AND for
            // the cache key. Includes manifest common_flags, std,
            // core_link_flags, and the hardcoded dlopen boilerplate
            // (-ldl -pthread -rdynamic). Keeping the cache key in sync with
            // the real args means different manifests don't collide in the
            // content-addressable cache.
            let mut effective_flag_strings: Vec<String> = Vec::with_capacity(
                effective_manifest.common_flags.len()
                    + effective_manifest.core_link_flags.len()
                    + 4,
            );
            effective_flag_strings.push(std_flag.clone());
            effective_flag_strings.extend(effective_manifest.common_flags.iter().cloned());
            effective_flag_strings.extend(effective_manifest.core_link_flags.iter().cloned());
            effective_flag_strings.push("-ldl".to_string());
            effective_flag_strings.push("-pthread".to_string());
            effective_flag_strings.push("-rdynamic".to_string());
            let effective_flag_refs: Vec<&str> =
                effective_flag_strings.iter().map(String::as_str).collect();

            let cache_key = IncrementalCache::cache_key(content, &effective_flag_refs, &[]);

            if let Some(cached_so) = ctx.incremental_cache.get(&cache_key).await {
                let path = cached_so.to_string_lossy().to_string();
                eprintln!("[Cache] HIT for core module (persistent cache)");
                return Ok::<_, anyhow::Error>(Some(path));
            } else {
                // Cache miss - need to compile
                let core_out = output_dir.join(format!("libcore_{}.{}", timestamp, ext));

                // ULTRAPLAN Phase 9b: split compile+link into two steps
                // so ccache (from Phase 9a) can cache the compile output
                // by preprocessed-source hash. Unchanged modules hit the
                // ccache store and skip the 300ms compile entirely; the
                // link step is cheap (~30ms) and runs unconditionally.
                //
                // Build the link-flag list once — reused by both the
                // initial link step and the fallback fused command if
                // the split compile step fails for any reason other
                // than the user's source being broken.
                let mut link_flags: Vec<String> =
                    Vec::with_capacity(effective_manifest.core_link_flags.len() + 3);
                link_flags.extend(effective_manifest.core_link_flags.iter().cloned());
                link_flags.push("-ldl".to_string());
                link_flags.push("-pthread".to_string()); // threaded adapters
                link_flags.push("-rdynamic".to_string());

                let core_obj = object_path_for_so(&core_out);

                // ULTRAPLAN Phase 9c — prepare a workspace-local PCH
                // before compiling. First hit generates `.synthi_pch.h` +
                // `.synthi_pch.h.gch` next to the source; subsequent
                // compiles in the same workspace (compile_gui, or a
                // second compile_core after an edit) hit the `exists()`
                // fast path and reuse the cached .gch for free.
                //
                // On any failure the helper returns None and we fall
                // through to non-PCH compile — no regression.
                let pch_include_name = crate::compiler::stages::pch::prepare_workspace_pch(
                    dir_path,
                    compiler_exe,
                    &std_flag,
                    &effective_manifest.common_flags,
                    content,
                )
                .await;
                let common_flags_with_pch: Vec<String> = {
                    let mut v = effective_manifest.common_flags.clone();
                    if let Some(ref name) = pch_include_name {
                        v.push("-include".to_string());
                        v.push(name.clone());
                    }
                    v
                };

                // Step 1: compile source → .o (ccache caches this)
                let mut compile_cmd = compile_to_object_command(
                    compiler_exe,
                    fname,
                    &core_obj,
                    &std_flag,
                    &common_flags_with_pch,
                    dir_path,
                );
                eprintln!(
                    "[CompileCore] Phase 9b split step 1/2 (compile): {:?}",
                    compile_cmd.as_std().get_args()
                );
                compile_cmd.kill_on_drop(true);
                let compile_child = compile_cmd
                    .spawn()
                    .context("Failed to spawn compile step")?;
                let compile_out = match timeout(
                    Duration::from_secs(30),
                    compile_child.wait_with_output(),
                )
                .await
                {
                    Ok(Ok(out)) => out,
                    Ok(Err(e)) => return Err(e.into()),
                    Err(_) => {
                        eprintln!("[CompileCore] compile step timed out");
                        anyhow::bail!("Core compile step timed out after 30s");
                    }
                };
                eprintln!(
                    "[CompileCore] compile step finished with status: {}",
                    compile_out.status
                );

                // If the compile step succeeded, run the link step.
                // If it failed, synthesize a combined `output` that the
                // heal loop below can process exactly as if the fused
                // command had failed — preserves all existing heal logic
                // without duplicating it across the split.
                let output = if compile_out.status.success() {
                    // Step 2: link .o → .so (no ccache, fast)
                    let mut link_cmd = link_object_to_so_command(
                        compiler_exe,
                        &core_obj,
                        &core_out,
                        &link_flags,
                        dir_path,
                    );
                    eprintln!(
                        "[CompileCore] Phase 9b split step 2/2 (link): {:?}",
                        link_cmd.as_std().get_args()
                    );
                    link_cmd.kill_on_drop(true);
                    let link_child = link_cmd.spawn().context("Failed to spawn link step")?;
                    match timeout(Duration::from_secs(30), link_child.wait_with_output()).await {
                        Ok(Ok(out)) => out,
                        Ok(Err(e)) => return Err(e.into()),
                        Err(_) => {
                            eprintln!("[CompileCore] link step timed out");
                            anyhow::bail!("Core link step timed out after 30s");
                        }
                    }
                } else {
                    // Compile step failed — synthesise the combined
                    // `output` so the heal loop downstream sees the same
                    // shape it has always seen. The heal loop may
                    // rewrite the source and retry with the fused
                    // command, which is fine — the split is just an
                    // optimization for the happy path.
                    compile_out
                };

                eprintln!("[CompileCore] overall status: {}", output.status);

                if !output.status.success() {
                    let stderr_str = String::from_utf8_lossy(&output.stderr).to_string();
                    eprintln!("[CompileCore] g++ FAILED:\n{}", stderr_str);

                    // ── ULTRAPLAN Phase 6: manifest heal (link errors) ──
                    // When stderr contains `undefined reference` errors, the
                    // problem is a missing link flag, not bad source. Ask the
                    // AI to update the manifest's link flags and retry once
                    // with the new flags. If the retry succeeds, we skip the
                    // source-heal loop entirely and proceed to cache.put.
                    // See ai_utils::try_manifest_heal_retry for the flow.
                    let manifest_healed =
                        crate::compiler::stages::ai_utils::try_manifest_heal_retry(
                            &stderr_str,
                            dir_path,
                            "core",
                            content,
                            |m| {
                                let mut cmd =
                                    cpp_compile_command(m.select_compiler(ModuleKind::Core));
                                cmd.arg(format!("-std={}", m.std));
                                for f in &m.common_flags {
                                    cmd.arg(f);
                                }
                                cmd.arg(fname).arg("-I.").arg("-o").arg(&core_out);
                                for f in &m.core_link_flags {
                                    cmd.arg(f);
                                }
                                cmd.arg("-ldl").arg("-pthread").arg("-rdynamic");
                                cmd.current_dir(dir_path);
                                cmd
                            },
                        )
                        .await
                        .is_some();

                    if manifest_healed {
                        eprintln!("[CompileCore] manifest heal SUCCEEDED — skipping source heal");
                        // Fall through to the post-compile path (cache.put + return).
                        // The retry command wrote to `core_out` already.
                    } else {
                        // ── AI Heal Loop: let the AI fix its own compile errors ──
                        let shared_for_heal = tokio::fs::read_to_string(
                            dir_path.join(
                                effective_manifest
                                    .module_file(ModuleKind::Shared)
                                    .unwrap_or("shared.h"),
                            ),
                        )
                        .await
                        .unwrap_or_default();
                        // Read the cached split architecture from the sidecar so the
                        // heal prompt has the same project-specific "Forbidden Patterns"
                        // context that diff_patch uses. Empty string falls back to
                        // the generic heal prompt.
                        let heal_arch_md: String = {
                            let sidecar = dir_path.join(".synthi_split_meta.json");
                            match tokio::fs::read_to_string(&sidecar).await {
                                Ok(raw) => serde_json::from_str::<serde_json::Value>(&raw)
                                    .ok()
                                    .and_then(|v| {
                                        v.get("architecture")
                                            .and_then(|a| a.as_str())
                                            .map(|s| s.to_string())
                                    })
                                    .unwrap_or_default(),
                                Err(_) => String::new(),
                            }
                        };
                        let heal_arch_hint: Option<&str> = if heal_arch_md.is_empty() {
                            None
                        } else {
                            Some(heal_arch_md.as_str())
                        };
                        let mut heal_content = content.to_string();
                        let mut heal_stderr = stderr_str.clone();
                        let mut healed = false;

                        for attempt in 0..2 {
                            eprintln!("[CompileCore] AI heal attempt {} for core", attempt + 1);
                            match crate::compiler::stages::ai_utils::perform_ai_heal(
                                "core",
                                &heal_content,
                                &heal_stderr,
                                &shared_for_heal,
                                heal_arch_hint,
                            )
                            .await
                            {
                                Ok(fixed) => {
                                    tokio::fs::write(dir_path.join(fname), &fixed).await?;
                                    let mut retry_compile_cmd = compile_to_object_command(
                                        compiler_exe,
                                        fname,
                                        &core_obj,
                                        &std_flag,
                                        &common_flags_with_pch,
                                        dir_path,
                                    );
                                    retry_compile_cmd.kill_on_drop(true);
                                    if let Ok(retry_child) = retry_compile_cmd.spawn() {
                                        if let Ok(Ok(retry_out)) = timeout(
                                            Duration::from_secs(30),
                                            retry_child.wait_with_output(),
                                        )
                                        .await
                                        {
                                            if retry_out.status.success() {
                                                let mut retry_link_cmd = link_object_to_so_command(
                                                    compiler_exe,
                                                    &core_obj,
                                                    &core_out,
                                                    &link_flags,
                                                    dir_path,
                                                );
                                                retry_link_cmd.kill_on_drop(true);
                                                if let Ok(link_child) = retry_link_cmd.spawn() {
                                                    if let Ok(Ok(link_out)) = timeout(
                                                        Duration::from_secs(30),
                                                        link_child.wait_with_output(),
                                                    )
                                                    .await
                                                    {
                                                        if link_out.status.success() {
                                                            eprintln!(
                                                            "[CompileCore] AI heal succeeded on attempt {}",
                                                            attempt + 1
                                                        );
                                                            healed = true;
                                                            break;
                                                        }
                                                        heal_stderr = String::from_utf8_lossy(
                                                            &link_out.stderr,
                                                        )
                                                        .to_string();
                                                    }
                                                }
                                            } else {
                                                heal_stderr =
                                                    String::from_utf8_lossy(&retry_out.stderr)
                                                        .to_string();
                                            }
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
                            let report = parse_compiler_output(
                                &heal_stderr,
                                "core",
                                CompilerType::Gcc,
                                true,
                            );
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
                            let _ = ctx
                                .log_dc
                                .send_text(serde_json::to_string(&diag_payload).unwrap_or_default())
                                .await;

                            let truncated = if heal_stderr.len() > 500 {
                                format!("{}…", &heal_stderr[..500])
                            } else {
                                heal_stderr.clone()
                            };
                            anyhow::bail!("Core compilation failed: {}", truncated);
                        }
                    } // end source-heal else-branch (Phase 6 manifest_healed=false)
                }

                let path = core_out.to_string_lossy().to_string();

                // ULTRAPLAN Lightning Phase 12 — stable symlink for per-project runner.
                // The AI-generated host_runner.cpp dlopen's `./libcore.so`, but
                // compile output is `libcore_<ts>.so`. Create a relative symlink
                // so the host_runner can find the latest .so without knowing
                // the timestamp. Remove any stale symlink first.
                if let (Some(parent), Some(file_name)) = (core_out.parent(), core_out.file_name()) {
                    let link_path = parent.join("libcore.so");
                    let _ = std::fs::remove_file(&link_path);
                    if let Err(e) = std::os::unix::fs::symlink(file_name, &link_path) {
                        eprintln!(
                            "[CompileCore] WARN: failed to create libcore.so → {:?} symlink: {}",
                            file_name, e
                        );
                    } else {
                        eprintln!(
                            "[CompileCore] stable symlink: {} -> {:?}",
                            link_path.display(),
                            file_name
                        );
                    }
                }

                // Update persistent cache
                if let Ok(so_data) = tokio::fs::read(&path).await {
                    let source_hash = content_hash;
                    // Hash the full effective flag list so that a manifest
                    // change (e.g. new link flags) invalidates the cached .so.
                    let flags_hash = calculate_hash(&effective_flag_strings.join(" "));
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
