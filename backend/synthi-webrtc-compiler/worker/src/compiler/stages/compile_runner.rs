// ============================================================
// COMPILE RUNNER (ULTRAPLAN Phase 4)
// ============================================================
//
// Compiles the AI-synthesised `host_runner.cpp` (the per-project main()
// that dlopens libcore.so/libgui.so) into an executable. The compiled
// runner sits in the workspace's `build/` directory alongside the .so
// artifacts. For non-GPU manifests the compiled runner can be handed to
// the runtime spawn path. For GPU manifests it is still intentionally a
// build/validation product only: handler.rs forces the live runtime back
// through the shipped `runner` binary so Synthi's GPU runtime boundary,
// device sidecar loader, HMR protocol, Xvfb/GStreamer capture, and
// WebRTC streaming stay intact.
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
// uses `CompileManifest::generic_fallback()` for manifest-less sidecars, same
// pattern as compile_core / compile_gui.

use crate::compiler::context::CompileContext;
use crate::compiler::error_parser::{parse_compiler_output, CompilerType};
use crate::compiler::stages::ai_utils::calculate_hash;
use crate::compiler::stages::compile_helpers::{
    compile_to_object_command, cpp_compile_command, filter_unresolved_manifest_library_flags,
    link_object_to_exec_command, object_path_for_exec,
};
use crate::hmr::compile_manifest::{CompileManifest, ModuleKind};
use crate::hmr::incremental_cache::IncrementalCache;
use anyhow::{Context, Result};
use tokio::time::{timeout, Duration};

/// Standard filename for the AI-synthesised host runner source.
pub const HOST_RUNNER_FILENAME: &str = "host_runner.cpp";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompileRunnerOptions {
    /// Whether compile_runner may call AI manifest/source heal after a failed
    /// runner compile. GPU sidecar compiles use the shipped runner at runtime,
    /// so their generated host runner is validation-only and should not spend
    /// AI calls trying to repair non-live link failures.
    pub allow_ai_heal: bool,
}

impl Default for CompileRunnerOptions {
    fn default() -> Self {
        Self {
            allow_ai_heal: true,
        }
    }
}

impl CompileRunnerOptions {
    pub fn for_manifest(manifest: Option<&CompileManifest>) -> Self {
        Self {
            allow_ai_heal: manifest.and_then(|m| m.gpu.as_ref()).is_none(),
        }
    }
}

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
///   - always appends `-ldl` (runner is the dlopen caller),
///     `-pthread` (Phase 12.5 — new host_runner template has a
///     stdin reader thread for hot-reload commands), and
///     `-rdynamic` (for runner→module dlsym back-references)
pub fn build_runner_flag_list(manifest: &CompileManifest) -> Vec<String> {
    let std_flag = format!("-std={}", manifest.std);
    let runner_compile_flags: Vec<String> = manifest
        .common_flags
        .iter()
        .filter(|f| f.as_str() != "-shared" && f.as_str() != "-fPIC")
        .cloned()
        .collect();

    let mut flags: Vec<String> =
        Vec::with_capacity(runner_compile_flags.len() + manifest.runner_link_flags.len() + 4);
    flags.push(std_flag);
    flags.extend(runner_compile_flags);
    flags.extend(manifest.runner_link_flags.iter().cloned());
    // Dedup-on-push: only add -ldl / -pthread / -rdynamic if the
    // manifest's runner_link_flags didn't already carry them. The
    // linker tolerates duplicates but logs look like "-ldl -ldl
    // -pthread -lpthread -rdynamic" otherwise, which confuses
    // operators reading compile diagnostics.
    push_if_absent(&mut flags, "-ldl");
    // -pthread and -lpthread are equivalent for the GNU linker;
    // treat either in the manifest as satisfying our -pthread
    // requirement to avoid the duplicate pair.
    if !flags.iter().any(|f| f == "-pthread" || f == "-lpthread") {
        flags.push("-pthread".to_string());
    }
    push_if_absent(&mut flags, "-rdynamic");
    flags
}

/// Push `flag` onto `flags` only if an exact match isn't already
/// present. Used by the runner flag builders + heal retry paths so
/// manifest-supplied `-ldl` / `-rdynamic` / `-pthread` don't get
/// duplicated by the defensive unconditional appends.
fn push_if_absent(flags: &mut Vec<String>, flag: &str) {
    if !flags.iter().any(|f| f == flag) {
        flags.push(flag.to_string());
    }
}

/// Compile the host_runner.cpp into a per-project executable.
///
/// `host_runner_content`: the source code (already pulled out of the
///   AI split response or read from `host_runner.cpp` on disk).
/// `compile_manifest`: when present, drives compiler/std/common_flags/
///   runner_link_flags. When absent, uses a generic fallback with no
///   framework-specific link inference.
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
    options: CompileRunnerOptions,
) -> Result<Option<String>> {
    if host_runner_content.trim().is_empty() {
        eprintln!("[CompileRunner] Skipping – no host_runner content");
        return Ok(None);
    }

    let dir_path = &ctx.workspace_path;

    // Resolve the effective manifest. Missing manifests use a generic fallback
    // and do not infer framework-specific link flags.
    let owned_default_manifest;
    let effective_manifest: &CompileManifest = match compile_manifest {
        Some(m) => m,
        None => {
            owned_default_manifest = CompileManifest::generic_fallback();
            &owned_default_manifest
        }
    };
    let compiler_exe = effective_manifest.select_compiler(ModuleKind::HostRunner);
    let std_flag = format!("-std={}", effective_manifest.std);
    let source_filename = effective_manifest
        .module_files
        .host_runner
        .as_deref()
        .unwrap_or(HOST_RUNNER_FILENAME);

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

    let cache_key = IncrementalCache::cache_key(host_runner_content, &effective_flag_refs, &[]);

    // Runner binary is named `host_runner_<ts>` — no `lib` prefix, no
    // `.so` extension. Lives in the build/ directory like the other
    // artifacts so cleanup is uniform.
    let runner_out = output_dir.join(format!("host_runner_{}", timestamp));

    if let Some(cached_bin) = ctx.incremental_cache.get(&cache_key).await {
        // IncrementalCache is content-addressable storage for `.o` object
        // files (compile inputs to the linker) — it writes every entry as
        // `<key>.o` with default 0o644 perms. The host_runner case stores
        // a LINKED EXECUTABLE here, so returning the cached path directly
        // causes `exec()` to fail with EACCES (object files have no +x
        // bit, and the linker drives subsequent builds, not exec). Copy
        // the cached bytes to the timestamped `host_runner_<ts>` exec
        // path and set the execute bit before handing the path upstream.
        match tokio::fs::copy(&cached_bin, &runner_out).await {
            Ok(_) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if let Ok(md) = tokio::fs::metadata(&runner_out).await {
                        let mut perms = md.permissions();
                        perms.set_mode(perms.mode() | 0o111);
                        let _ = tokio::fs::set_permissions(&runner_out, perms).await;
                    }
                }
                eprintln!(
                    "[CompileRunner] Cache HIT (persistent cache) — materialised {} → {}",
                    cached_bin.display(),
                    runner_out.display()
                );
                return Ok(Some(runner_out.to_string_lossy().to_string()));
            }
            Err(e) => {
                eprintln!(
                    "[CompileRunner] Cache HIT but copy {} → {} failed ({}); falling through to recompile",
                    cached_bin.display(),
                    runner_out.display(),
                    e
                );
                // fall through to full compile+link path
            }
        }
    }

    // Cache miss — write the source file and compile.
    let source_path = dir_path.join(source_filename);
    if let Some(parent) = source_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(&source_path, host_runner_content).await?;

    // ULTRAPLAN Phase 9b: two-step split (see compile_core.rs for the
    // rationale). compile_runner produces an EXECUTABLE (not a .so),
    // so the link step uses `link_object_to_exec_command` instead of
    // the shared-library helper — no `-shared` flag.
    //
    // runner_compile_flags already has -shared/-fPIC stripped at the
    // top of this function (Phase 3 quirk: executables can't carry
    // those flags), so we pass it verbatim through the helper which
    // will strip -shared again as a no-op safety net.
    // ULTRAPLAN Lightning Phase 12.5 — add `-pthread` unconditionally.
    // The new host_runner.cpp template emitted by UNIVERSAL_SPLIT_PROMPT
    // has a stdin reader thread (std::thread / pthread_create) that
    // handles hot-reload commands. Without -pthread the link fails.
    // This is library-agnostic (pthread is the reloader, not the
    // rendering backend) so we add it for every per-project runner
    // regardless of what the manifest says.
    let mut link_flags: Vec<String> =
        Vec::with_capacity(effective_manifest.runner_link_flags.len() + 3);
    link_flags.extend(effective_manifest.runner_link_flags.iter().cloned());
    // Dedup-on-push — same shape as build_runner_flag_list.
    push_if_absent(&mut link_flags, "-ldl");
    if !link_flags
        .iter()
        .any(|f| f == "-pthread" || f == "-lpthread")
    {
        link_flags.push("-pthread".to_string());
    }
    push_if_absent(&mut link_flags, "-rdynamic");

    let runner_obj = object_path_for_exec(&runner_out);

    // Step 1: compile .cpp → .o (ccache caches this)
    let mut compile_cmd = compile_to_object_command(
        compiler_exe,
        source_filename,
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
    let compile_out = match timeout(Duration::from_secs(30), compile_child.wait_with_output()).await
    {
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
        if !options.allow_ai_heal {
            eprintln!("[CompileRunner] AI heal skipped for validation-only host runner compile");
            let report = parse_compiler_output(&stderr_str, "host_runner", CompilerType::Gcc, true);
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
                "ai_heal": "skipped_validation_only",
            });
            let _ = ctx
                .log_dc
                .send_text(serde_json::to_string(&diag_payload).unwrap_or_default())
                .await;

            let truncated = if stderr_str.len() > 500 {
                format!("{}...", &stderr_str[..500])
            } else {
                stderr_str
            };
            anyhow::bail!("Host runner compilation failed: {}", truncated);
        }

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
                let retry_compiler = m.select_compiler(ModuleKind::HostRunner);
                let mut cmd = cpp_compile_command(retry_compiler);
                cmd.arg(format!("-std={}", m.std));
                // Strip -shared / -fPIC (runner is an executable, not a .so)
                for f in &m.common_flags {
                    if f != "-shared" && f != "-fPIC" {
                        cmd.arg(f);
                    }
                }
                let healed_source_filename = m
                    .module_files
                    .host_runner
                    .as_deref()
                    .unwrap_or(source_filename);
                cmd.arg(healed_source_filename)
                    .arg("-I.")
                    .arg("-o")
                    .arg(&runner_out);
                let mut retry_link_flags = m.runner_link_flags.clone();
                push_if_absent(&mut retry_link_flags, "-ldl");
                if !retry_link_flags
                    .iter()
                    .any(|f| f == "-pthread" || f == "-lpthread")
                {
                    retry_link_flags.push("-pthread".to_string());
                }
                push_if_absent(&mut retry_link_flags, "-rdynamic");
                let filtered_link_flags = filter_unresolved_manifest_library_flags(
                    retry_compiler,
                    &retry_link_flags,
                    dir_path,
                );
                for f in filtered_link_flags {
                    cmd.arg(f);
                }
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
                        tokio::fs::write(&source_path, &fixed).await?;
                        let mut retry_cmd = cpp_compile_command(compiler_exe);
                        retry_cmd.arg(&std_flag);
                        for f in &runner_compile_flags {
                            retry_cmd.arg(f);
                        }
                        retry_cmd
                            .arg(source_filename)
                            .arg("-I.")
                            .arg("-o")
                            .arg(&runner_out);
                        let mut retry_link_flags = effective_manifest.runner_link_flags.clone();
                        push_if_absent(&mut retry_link_flags, "-ldl");
                        if !retry_link_flags
                            .iter()
                            .any(|f| f == "-pthread" || f == "-lpthread")
                        {
                            retry_link_flags.push("-pthread".to_string());
                        }
                        push_if_absent(&mut retry_link_flags, "-rdynamic");
                        let filtered_link_flags = filter_unresolved_manifest_library_flags(
                            compiler_exe,
                            &retry_link_flags,
                            dir_path,
                        );
                        for f in filtered_link_flags {
                            retry_cmd.arg(f);
                        }
                        retry_cmd.current_dir(dir_path);
                        retry_cmd.kill_on_drop(true);
                        if let Ok(retry_child) = retry_cmd.spawn() {
                            if let Ok(Ok(retry_out)) =
                                timeout(Duration::from_secs(30), retry_child.wait_with_output())
                                    .await
                            {
                                if retry_out.status.success() {
                                    eprintln!(
                                        "[CompileRunner] AI heal succeeded on attempt {}",
                                        attempt + 1
                                    );
                                    healed = true;
                                    break;
                                }
                                heal_stderr =
                                    String::from_utf8_lossy(&retry_out.stderr).to_string();
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
                let report =
                    parse_compiler_output(&heal_stderr, "host_runner", CompilerType::Gcc, true);
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

    // ULTRAPLAN Lightning Phase 12.6 — post-compile `nm` check.
    // Verify the compiled host_runner binary has the required dynamic
    // symbols (dlopen, dlsym) in its dependency graph. If `-ldl` was
    // silently dropped during the AI's manifest generation or the
    // heal loop trimmed it away, the binary COMPILES but segfaults
    // at runtime on the first dlopen call — a hard-to-debug failure
    // that this pre-flight check catches cheaply (~10ms vs ~minutes
    // of user confusion).
    //
    // We also check for `main` as a basic sanity that the link
    // produced a valid executable, and for `pthread_create` since
    // the Phase 12.5 stdin reader thread depends on it.
    //
    // Failure is a WARNING (eprintln), not a hard error, because
    // the check is best-effort and `nm -D` may not be installed in
    // every container image. The runner will still crash clearly
    // at runtime if the symbol is truly missing.
    {
        let nm_path = runner_out.to_string_lossy().to_string();
        match tokio::process::Command::new("nm")
            .arg("-D")
            .arg(&nm_path)
            .output()
            .await
        {
            Ok(output) if output.status.success() => {
                let symbols = String::from_utf8_lossy(&output.stdout);
                let required = ["dlopen", "dlsym", "pthread_create"];
                let mut missing: Vec<&str> = Vec::new();
                for sym in &required {
                    if !symbols.contains(sym) {
                        missing.push(sym);
                    }
                }
                if !missing.is_empty() {
                    eprintln!(
                        "[Phase 12.6] WARNING: host_runner binary missing required dynamic \
                         symbols: {:?}. The runner may crash at runtime. Check link flags \
                         (need -ldl -pthread).",
                        missing
                    );
                } else {
                    eprintln!(
                        "[Phase 12.6] nm check: all required symbols present (dlopen, dlsym, pthread_create)"
                    );
                }
            }
            Ok(output) => {
                eprintln!(
                    "[Phase 12.6] nm check: nm -D exited with {} (non-fatal, skipping check)",
                    output.status
                );
            }
            Err(e) => {
                eprintln!(
                    "[Phase 12.6] nm check: failed to run nm ({}) — skipping (nm may not be installed)",
                    e
                );
            }
        }
    }

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hmr::compile_manifest::{
        DeviceCompiler, DeviceVendor, FatbinStrategy, GpuBuildBlock, SnapshotMode,
    };

    #[test]
    fn compile_runner_ai_heal_policy_allows_host_only_projects() {
        let manifest = CompileManifest::generic_fallback();

        assert!(CompileRunnerOptions::for_manifest(Some(&manifest)).allow_ai_heal);
        assert!(CompileRunnerOptions::for_manifest(None).allow_ai_heal);
    }

    #[test]
    fn compile_runner_ai_heal_policy_skips_gpu_validation_runner() {
        let mut manifest = CompileManifest::generic_fallback();
        manifest.gpu = Some(GpuBuildBlock {
            vendor: DeviceVendor::Rocm,
            device_compiler: DeviceCompiler::Hipcc,
            arch: vec!["gfx90a".to_string()],
            device_flags: vec!["-O3".to_string()],
            runtime_libs: vec!["amdhip64".to_string()],
            snapshot_mode: SnapshotMode::Userspace,
            fatbin_strategy: FatbinStrategy::SidecarModule,
            device_roles: Vec::new(),
            device_link: Default::default(),
            generated_split_granularity: None,
        });

        assert!(!CompileRunnerOptions::for_manifest(Some(&manifest)).allow_ai_heal);
    }
}
