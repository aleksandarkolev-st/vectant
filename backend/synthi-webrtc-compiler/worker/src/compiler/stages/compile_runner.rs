// ============================================================
// COMPILE RUNNER (ULTRAPLAN Phase 4)
// ============================================================
//
// Compiles the AI-synthesised `host_runner.cpp` (the per-project main()
// that dlopens libcore.so/libgui.so) into an executable. The compiled
// runner sits in the workspace's `build/` directory alongside the .so
// artifacts; for V1 it is a build product only — the live runtime path
// is still served by the shipped `runner` binary in `runtime/runner_bin.rs`.
// Wiring the compiled per-project runner into runtime spawn is a Phase 5+
// concern (it has implications for video streaming via Xvfb/GStreamer).
//
// Caching:
//   - content-addressable cache key = hash(host_runner content + flags)
//   - on cache hit, returns the existing path (no compile)
//   - on miss, runs the full compile + heal loop, then puts to cache
//
// BYOR mode:
//   - if `user_owned_runner` is true, the user authored the runner
//     themselves (sentinel `// SYNTHI_USER_RUNNER` on first non-blank
//     line). We still COMPILE it so they get build feedback, but we do
//     NOT regenerate it on AI splits — handler.rs enforces that side.
//
// Manifest fallback: when `compile_manifest` is None (pre-Phase-3 sidecar),
// uses `CompileManifest::sdl2_default()` for backward compatibility, same
// pattern as compile_core / compile_gui.

use crate::compiler::context::CompileContext;
use crate::compiler::error_parser::{parse_compiler_output, CompilerType};
use crate::compiler::stages::ai_utils::calculate_hash;
use crate::compiler::stages::compile_helpers::{
    compile_to_object_command, cpp_compile_command, link_object_to_exec_command,
    object_path_for_exec,
};
use crate::hmr::compile_manifest::CompileManifest;
use crate::hmr::incremental_cache::IncrementalCache;
use anyhow::{Context, Result};
use tokio::time::{timeout, Duration};

/// Standard filename for the AI-synthesised host runner source.
pub const HOST_RUNNER_FILENAME: &str = "host_runner.cpp";

/// Build the full ordered flag list compile_runner will hand to the C++
/// compiler for a given manifest. Pure function — no IO, no allocations
/// outside the returned Vec — so it's directly testable from integration
/// tests without standing up a CompileContext.
///
/// Differences vs `compile_core` / `compile_gui`:
///   - strips `-shared` and `-fPIC` from `common_flags` (the runner is
///     an executable, not a shared object — those flags break the link)
///   - uses `runner_link_flags` instead of `core_link_flags` /
///     `gui_link_flags` (typically `-lSDL2 -ldl`, `-lglfw -ldl`,
///     `-lfmod -ldl`, etc. — whatever the AI synthesised for the runner's
///     own dlopen + window-init dependencies)
///   - always appends `-ldl` (runner is the dlopen caller) and
///     `-rdynamic` (for runner→module dlsym back-references)
pub fn build_runner_flag_list(manifest: &CompileManifest) -> Vec<String> {
    let std_flag = format!("-std={}", manifest.std);
    let runner_compile_flags: Vec<String> = manifest
        .common_flags
        .iter()
        .filter(|f| f.as_str() != "-shared" && f.as_str() != "-fPIC")
        .cloned()
        .collect();

    let mut flags: Vec<String> = Vec::with_capacity(
        runner_compile_flags.len() + manifest.runner_link_flags.len() + 3,
    );
    flags.push(std_flag);
    flags.extend(runner_compile_flags);
    flags.extend(manifest.runner_link_flags.iter().cloned());
    flags.push("-ldl".to_string());
    flags.push("-rdynamic".to_string());
    flags
}

/// Compile the host_runner.cpp into a per-project executable.
///
/// `host_runner_content`: the source code (already pulled out of the
///   AI split response or read from `host_runner.cpp` on disk).
/// `compile_manifest`: when present, drives compiler/std/common_flags/
///   runner_link_flags. When absent, falls back to `sdl2_default()`.
///
/// Returns:
///   - `Ok(Some(path))` on success — absolute path to the compiled binary
///   - `Ok(None)` if `host_runner_content` is empty/whitespace-only
///   - `Err(_)` if compile (and the heal retry) fail
pub async fn compile_runner(
    ctx: &CompileContext,
    host_runner_content: &str,
    output_dir: &std::path::PathBuf,
    timestamp: i64,
    session_id: Option<String>,
    compile_manifest: Option<&CompileManifest>,
) -> Result<Option<String>> {
    if host_runner_content.trim().is_empty() {
        eprintln!("[CompileRunner] Skipping – no host_runner content");
        return Ok(None);
    }

    let dir_path = &ctx.workspace_path;

    // Resolve the effective manifest. Same pattern as compile_core.rs:
    // if the universal split prompt landed a manifest, use it; else fall
    // back to the SDL2 default which matches the legacy hardcoded shape.
    let owned_default_manifest;
    let effective_manifest: &CompileManifest = match compile_manifest {
        Some(m) => m,
        None => {
            owned_default_manifest = CompileManifest::sdl2_default();
            &owned_default_manifest
        }
    };
    let compiler_exe = effective_manifest.compiler.executable();
    let std_flag = format!("-std={}", effective_manifest.std);

    // Pure-function flag construction — see `build_runner_flag_list` for
    // the rules around stripping -shared/-fPIC and appending -ldl/-rdynamic.
    // Refactored out so integration tests can validate the flag shape
    // directly without needing a real CompileContext.
    let effective_flag_strings = build_runner_flag_list(effective_manifest);
    let effective_flag_refs: Vec<&str> =
        effective_flag_strings.iter().map(String::as_str).collect();
    // The `-shared` / `-fPIC` filter is owned by build_runner_flag_list,
    // but compile_runner needs the filtered list directly to populate its
    // tokio::process::Command (Command takes args one-by-one, not a slice).
    // Compute it once here to avoid duplicating the filter rule.
    let runner_compile_flags: Vec<String> = effective_manifest
        .common_flags
        .iter()
        .filter(|f| f.as_str() != "-shared" && f.as_str() != "-fPIC")
        .cloned()
        .collect();

    let cache_key = IncrementalCache::cache_key(
        host_runner_content,
        &effective_flag_refs,
        &[],
    );

    if let Some(cached_bin) = ctx.incremental_cache.get(&cache_key).await {
        let path = cached_bin.to_string_lossy().to_string();
        eprintln!("[CompileRunner] Cache HIT (persistent cache)");
        return Ok(Some(path));
    }

    // Cache miss — write the source file and compile.
    tokio::fs::write(dir_path.join(HOST_RUNNER_FILENAME), host_runner_content).await?;

    // Runner binary is named `host_runner_<ts>` — no `lib` prefix, no
    // `.so` extension. Lives in the build/ directory like the other
    // artifacts so cleanup is uniform.
    let runner_out = output_dir.join(format!("host_runner_{}", timestamp));

    // ULTRAPLAN Phase 9b: two-step split (see compile_core.rs for the
    // rationale). compile_runner produces an EXECUTABLE (not a .so),
    // so the link step uses `link_object_to_exec_command` instead of
    // the shared-library helper — no `-shared` flag.
    //
    // runner_compile_flags already has -shared/-fPIC stripped at the
    // top of this function (Phase 3 quirk: executables can't carry
    // those flags), so we pass it verbatim through the helper which
    // will strip -shared again as a no-op safety net.
    let mut link_flags: Vec<String> = Vec::with_capacity(
        effective_manifest.runner_link_flags.len() + 2,
    );
    link_flags.extend(effective_manifest.runner_link_flags.iter().cloned());
    link_flags.push("-ldl".to_string());
    link_flags.push("-rdynamic".to_string());

    let runner_obj = object_path_for_exec(&runner_out);

    // Step 1: compile .cpp → .o (ccache caches this)
    let mut compile_cmd = compile_to_object_command(
        compiler_exe,
        HOST_RUNNER_FILENAME,
        &runner_obj,
        &std_flag,
        &runner_compile_flags,
        dir_path,
    );
    eprintln!(
        "[CompileRunner] Phase 9b split step 1/2 (compile): {:?}",
        compile_cmd.as_std().get_args()
    );
    compile_cmd.kill_on_drop(true);
    let compile_child = compile_cmd
        .spawn()
        .context(format!("Failed to spawn {} compile step", compiler_exe))?;
    let compile_out = match timeout(Duration::from_secs(30), compile_child.wait_with_output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return Err(e.into()),
        Err(_) => {
            eprintln!("[CompileRunner] compile step timed out");
            anyhow::bail!("Runner compile step timed out after 30s");
        }
    };
    eprintln!(
        "[CompileRunner] compile step finished with status: {}",
        compile_out.status
    );

    // Step 2 (only if step 1 succeeded): link .o → executable.
    let output = if compile_out.status.success() {
        let mut link_cmd = link_object_to_exec_command(
            compiler_exe,
            &runner_obj,
            &runner_out,
            &link_flags,
            dir_path,
        );
        eprintln!(
            "[CompileRunner] Phase 9b split step 2/2 (link): {:?}",
            link_cmd.as_std().get_args()
        );
        link_cmd.kill_on_drop(true);
        let link_child = link_cmd
            .spawn()
            .context(format!("Failed to spawn {} link step", compiler_exe))?;
        match timeout(Duration::from_secs(30), link_child.wait_with_output()).await {
            Ok(Ok(out)) => out,
            Ok(Err(e)) => return Err(e.into()),
            Err(_) => {
                eprintln!("[CompileRunner] link step timed out");
                anyhow::bail!("Runner link step timed out after 30s");
            }
        }
    } else {
        compile_out
    };

    eprintln!(
        "[CompileRunner] {} overall status: {}",
        compiler_exe, output.status
    );

    if !output.status.success() {
        let stderr_str = String::from_utf8_lossy(&output.stderr).to_string();
        eprintln!("[CompileRunner] {} FAILED:\n{}", compiler_exe, stderr_str);

        // ── ULTRAPLAN Phase 6: manifest heal (link errors) ──
        // When stderr contains undefined-reference errors, the host_runner
        // is missing a -l flag for a library it references. Ask the AI to
        // update the manifest's runner_link_flags and retry once. This is
        // the stage that most commonly hits missing-flag errors because
        // the runner is the final executable link step — symbols from
        // libraries only get resolved here.
        let manifest_healed = crate::compiler::stages::ai_utils::try_manifest_heal_retry(
            &stderr_str,
            dir_path,
            "host_runner",
            host_runner_content,
            |m| {
                let mut cmd = cpp_compile_command(m.compiler.executable());
                cmd.arg(format!("-std={}", m.std));
                // Strip -shared / -fPIC (runner is an executable, not a .so)
                for f in &m.common_flags {
                    if f != "-shared" && f != "-fPIC" {
                        cmd.arg(f);
                    }
                }
                cmd.arg(HOST_RUNNER_FILENAME)
                    .arg("-I.")
                    .arg("-o")
                    .arg(&runner_out);
                for f in &m.runner_link_flags {
                    cmd.arg(f);
                }
                cmd.arg("-ldl").arg("-rdynamic");
                cmd.current_dir(dir_path);
                cmd
            },
        )
        .await
        .is_some();

        if manifest_healed {
            eprintln!("[CompileRunner] manifest heal SUCCEEDED — skipping source heal");
        } else {

        // ── AI Heal Loop ──
        // Same pattern as compile_core / compile_gui: feed the broken
        // runner + g++ errors back to the AI for a repair, retry once.
        // Unlike core/gui, we don't have a "shared.h" companion to send
        // the heal endpoint — we send an empty string. The architecture
        // cache from the sidecar is still injected so the heal prompt
        // has the project-specific context.
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
        let mut heal_content = host_runner_content.to_string();
        let mut heal_stderr = stderr_str.clone();
        let mut healed = false;

        for attempt in 0..2 {
            eprintln!(
                "[CompileRunner] AI heal attempt {} for host_runner",
                attempt + 1
            );
            match crate::compiler::stages::ai_utils::perform_ai_heal(
                "host_runner",
                &heal_content,
                &heal_stderr,
                "", // no shared.h companion for the runner
                heal_arch_hint,
            )
            .await
            {
                Ok(fixed) => {
                    tokio::fs::write(dir_path.join(HOST_RUNNER_FILENAME), &fixed).await?;
                    let mut retry_cmd = cpp_compile_command(compiler_exe);
                    retry_cmd.arg(&std_flag);
                    for f in &runner_compile_flags {
                        retry_cmd.arg(f);
                    }
                    retry_cmd
                        .arg(HOST_RUNNER_FILENAME)
                        .arg("-I.")
                        .arg("-o")
                        .arg(&runner_out);
                    for f in &effective_manifest.runner_link_flags {
                        retry_cmd.arg(f);
                    }
                    retry_cmd.arg("-ldl").arg("-rdynamic");
                    retry_cmd.current_dir(dir_path);
                    retry_cmd.kill_on_drop(true);
                    if let Ok(retry_child) = retry_cmd.spawn() {
                        if let Ok(Ok(retry_out)) =
                            timeout(Duration::from_secs(30), retry_child.wait_with_output()).await
                        {
                            if retry_out.status.success() {
                                eprintln!(
                                    "[CompileRunner] AI heal succeeded on attempt {}",
                                    attempt + 1
                                );
                                healed = true;
                                break;
                            }
                            heal_stderr = String::from_utf8_lossy(&retry_out.stderr).to_string();
                            heal_content = fixed;
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[CompileRunner] AI heal failed: {}", e);
                    break;
                }
            }
        }

        if !healed {
            // Send diagnostics and fail. Same flow as compile_core / compile_gui:
            // emit a `compile-diagnostics` payload tagged with stage so the
            // frontend can render it, then return Err so the upstream pipeline
            // sends a single authoritative {status:done, success:false}.
            let report = parse_compiler_output(
                &heal_stderr,
                "host_runner",
                CompilerType::Gcc,
                true,
            );
            let diagnostics_json = report.to_json();
            let diag_payload = serde_json::json!({
                "sessionId": session_id.clone(),
                "type": "compile-diagnostics",
                "language": "cpp",
                "diagnostics": serde_json::from_str::<serde_json::Value>(&diagnostics_json)
                    .unwrap_or_default(),
                "error_count": report.error_count,
                "warning_count": report.warning_count,
                "stage": "compile_runner",
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
            anyhow::bail!("Host runner compilation failed: {}", truncated);
        }
        } // end source-heal else-branch (Phase 6 manifest_healed=false)
    }

    let path = runner_out.to_string_lossy().to_string();

    // Update the persistent cache so subsequent identical builds are instant.
    if let Ok(bin_data) = tokio::fs::read(&path).await {
        let source_hash = calculate_hash(&host_runner_content);
        let flags_hash = calculate_hash(&effective_flag_strings.join(" "));
        let headers_hash = 0u64;
        let _ = ctx
            .incremental_cache
            .put(
                cache_key.clone(),
                source_hash,
                flags_hash,
                headers_hash,
                &bin_data,
            )
            .await;
    }

    Ok(Some(path))
}
