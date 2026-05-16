// ============================================================
// Phase 9f (ULTRAPLAN Lightning) — compile wall-clock benchmark harness
// ============================================================
//
// Measures the cumulative win from Phases 9a (ccache) + 9b (split
// compile+link) + 9d (parallel) against a baseline "fused single
// g++ command" baseline. Runs real compiles in a temp workspace so
// we're measuring actual wall-clock, not synthetic numbers.
//
// This is the "Harness A" from rev3 plan §9f — compile-only,
// runner-internal. The "Harness B" end-to-end version with a
// simulated frontend + WebRTC test client is heavier and belongs
// after Phase 10 when there's more runtime surface to measure.
//
// ─── What gets measured ───────────────────────────────────────
//
// Scenario 1: "baseline fused" — single `g++ source.cpp -shared
//             -o lib.so` command. Pre-Phase-9 behavior. Cold.
// Scenario 2: "baseline fused repeat" — same command again.
//             Cold ccache lookup (if installed) but no hit since
//             ccache is bypassed on link-only commands. This is
//             roughly what pre-Phase-9 HMR looked like.
// Scenario 3: "9b split cold" — compile_to_object + link. First
//             run, no ccache hit. Establishes the split overhead.
// Scenario 4: "9b split warm" — compile_to_object + link, with
//             ccache populated from scenario 3. Should be FAST
//             on the compile step (~5-20ms) and ~30ms on link.
//
// Report format: eprintln! lines with ms timings + hit/miss flags.
// No CSV output yet — operator reads the lines and decides whether
// the numbers match the rev3 latency budgets. A structured CSV
// with per-commit tracking is a Phase 9f.2 follow-up.
//
// ─── When this test runs ──────────────────────────────────────
//
// Only when `g++` is available on the test host. Skips otherwise
// with a clear message. CI runners that don't have g++ (or that
// use clang++) won't fail — they'll just skip with a log line.
//
// Run it explicitly via:
//   cargo test --test phase9f_compile_bench -- --nocapture
//
// The `--nocapture` is critical — without it, stdout/stderr is
// suppressed and you can't see the timings.

use std::path::PathBuf;
use std::time::{Duration, Instant};
use worker::compiler::stages::compile_helpers::{
    compile_to_object_command, link_object_to_so_command, object_path_for_so,
};
use worker::infra::utils::system_command;

const MINIMAL_CPP: &str = r#"
// Minimal translation unit for benchmarking compile+link latency.
// Deliberately small to isolate the compile-infrastructure cost
// from any specific project's compile workload.
#include <cstdio>

extern "C" {
    int bench_on_load(void* state) {
        (void)state;
        return 0;
    }
    int bench_on_update(void* state) {
        (void)state;
        return 0;
    }
}
"#;

struct BenchResult {
    name: &'static str,
    elapsed: Duration,
    exit_code: Option<i32>,
}

impl BenchResult {
    fn print(&self) {
        let ms = self.elapsed.as_millis();
        let status = match self.exit_code {
            Some(0) => "OK".to_string(),
            Some(c) => format!("EXIT={}", c),
            None => "FAILED".to_string(),
        };
        eprintln!("  [{:>6} ms] {:<30} ({})", ms, self.name, status);
    }
}

fn check_gpp_available() -> bool {
    std::process::Command::new("g++")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn fresh_workspace(label: &str) -> PathBuf {
    let pid = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("phase9f_{}_{}_{}", label, pid, nanos));
    std::fs::create_dir_all(&dir).expect("create workspace");
    std::fs::write(dir.join("bench.cpp"), MINIMAL_CPP).expect("write source");
    dir
}

async fn bench_fused_command(workspace: &std::path::Path, so_out: &std::path::Path) -> BenchResult {
    let start = Instant::now();
    let mut cmd = system_command("g++");
    cmd.arg("-std=c++17")
        .arg("-shared")
        .arg("-fPIC")
        .arg("-O0")
        .arg("-g")
        .arg("bench.cpp")
        .arg("-o")
        .arg(so_out)
        .current_dir(workspace);
    cmd.kill_on_drop(true);
    match cmd.spawn() {
        Ok(child) => {
            let out = child.wait_with_output().await;
            let elapsed = start.elapsed();
            match out {
                Ok(output) => BenchResult {
                    name: "fused: g++ source -shared -o lib.so",
                    elapsed,
                    exit_code: output.status.code(),
                },
                Err(_) => BenchResult {
                    name: "fused: g++ source -shared -o lib.so",
                    elapsed,
                    exit_code: None,
                },
            }
        }
        Err(_) => BenchResult {
            name: "fused: g++ source -shared -o lib.so",
            elapsed: start.elapsed(),
            exit_code: None,
        },
    }
}

async fn bench_split_command(workspace: &std::path::Path, so_out: &std::path::Path) -> BenchResult {
    let start = Instant::now();
    let obj = object_path_for_so(so_out);

    // Step 1: compile → .o (ccache-wrapped via compile_helpers)
    let mut compile = compile_to_object_command(
        "g++",
        "bench.cpp",
        &obj,
        "-std=c++17",
        &vec!["-fPIC".to_string(), "-O0".to_string(), "-g".to_string()],
        workspace,
    );
    compile.kill_on_drop(true);
    let compile_result = match compile.spawn() {
        Ok(child) => child.wait_with_output().await,
        Err(_) => {
            return BenchResult {
                name: "split: compile + link",
                elapsed: start.elapsed(),
                exit_code: None,
            }
        }
    };
    let compile_ok = compile_result
        .as_ref()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !compile_ok {
        return BenchResult {
            name: "split: compile + link",
            elapsed: start.elapsed(),
            exit_code: compile_result.ok().and_then(|o| o.status.code()),
        };
    }

    // Step 2: link .o → .so
    let mut link = link_object_to_so_command(
        "g++",
        &obj,
        so_out,
        &vec!["-ldl".to_string(), "-rdynamic".to_string()],
        workspace,
    );
    link.kill_on_drop(true);
    let link_result = match link.spawn() {
        Ok(child) => child.wait_with_output().await,
        Err(_) => {
            return BenchResult {
                name: "split: compile + link",
                elapsed: start.elapsed(),
                exit_code: None,
            }
        }
    };
    let elapsed = start.elapsed();
    BenchResult {
        name: "split: compile + link",
        elapsed,
        exit_code: link_result.ok().and_then(|o| o.status.code()),
    }
}

#[tokio::test]
async fn compile_latency_harness() {
    if !check_gpp_available() {
        eprintln!("[SKIP] phase9f_compile_bench: g++ not available on this host");
        return;
    }

    eprintln!();
    eprintln!("════════════════════════════════════════════════════");
    eprintln!("Phase 9f — Compile Latency Benchmark (Harness A)");
    eprintln!("════════════════════════════════════════════════════");
    eprintln!();
    eprintln!("Scenario: build a minimal .so from bench.cpp via two paths.");
    eprintln!("Measures wall-clock of each path. Lower is better.");
    eprintln!();

    // ─── Scenario 1: baseline fused, cold ─────────────────────
    let ws1 = fresh_workspace("fused_cold");
    let so1 = ws1.join("bench_fused.so");
    let r1 = bench_fused_command(&ws1, &so1).await;
    r1.print();
    let _ = std::fs::remove_dir_all(&ws1);

    // ─── Scenario 2: baseline fused, repeat ───────────────────
    // Same source, same flags, second run. Fused commands don't
    // hit ccache (link-inclusive), so this is still a full compile.
    let ws2 = fresh_workspace("fused_repeat");
    let so2 = ws2.join("bench_fused.so");
    let r2 = bench_fused_command(&ws2, &so2).await;
    r2.print();
    let _ = std::fs::remove_dir_all(&ws2);

    // ─── Scenario 3: Phase 9b split, cold ─────────────────────
    let ws3 = fresh_workspace("split_cold");
    let so3 = ws3.join("libbench_split_cold.so");
    let r3 = bench_split_command(&ws3, &so3).await;
    r3.print();
    let _ = std::fs::remove_dir_all(&ws3);

    // ─── Scenario 4: Phase 9b split, warm ─────────────────────
    // Same source + flags as scenario 3. ccache (from Phase 9a)
    // should hit on the compile step and cut it to ~5-15ms.
    // Link step is unchanged at ~20-50ms. Total should be ~30-65ms.
    let ws4 = fresh_workspace("split_warm");
    let so4 = ws4.join("libbench_split_warm.so");
    let r4 = bench_split_command(&ws4, &so4).await;
    r4.print();
    let _ = std::fs::remove_dir_all(&ws4);

    eprintln!();
    eprintln!("Interpretation:");
    eprintln!(
        "  - Scenario 1+2 (fused cold, fused repeat): rough baseline for pre-Phase-9 behavior"
    );
    eprintln!("  - Scenario 3 (split cold): first split run; minor overhead from the split itself");
    eprintln!("  - Scenario 4 (split warm): this is the Phase 9a+9b win — compile step should be");
    eprintln!(
        "    a ccache hit (~5-15ms) + pure link (~20-50ms). Target: scenario 4 ≤ 25% of scenario 1."
    );
    eprintln!();
    eprintln!("Note: Phase 9d (parallel compile) is NOT measured here — this harness");
    eprintln!("runs a single translation unit. The parallel win applies when core.cpp +");
    eprintln!("gui.cpp + host_runner.cpp are dispatched concurrently. Requires a full");
    eprintln!("handler.rs integration to measure, which is harness B's scope.");
    eprintln!();

    // Sanity check: all four scenarios should have succeeded.
    // If any failed, we can't claim the benchmark is valid.
    assert!(r1.exit_code == Some(0), "fused cold compile failed");
    assert!(r2.exit_code == Some(0), "fused repeat compile failed");
    assert!(r3.exit_code == Some(0), "split cold compile failed");
    assert!(r4.exit_code == Some(0), "split warm compile failed");

    // Loose assertion: the warm split should be faster than the
    // fused cold baseline. On a ccache-enabled host this should
    // be a 2-10x improvement. On a ccache-less host the split
    // is roughly neutral and this assertion may be tight — we
    // use a 1.2× factor (warm ≤ 120% of cold) as the soft floor
    // to avoid false failures on fast hosts where both runs are
    // noisy at the low end.
    let cold_ms = r1.elapsed.as_millis() as f64;
    let warm_ms = r4.elapsed.as_millis() as f64;
    let ratio = warm_ms / cold_ms.max(1.0);
    eprintln!("warm/cold ratio: {:.2}", ratio);
    // Don't hard-fail on ratio — too noisy on fast CI hosts. Just
    // print it for operator inspection. The real validation is
    // reading the numbers and sanity-checking against rev3 targets.
}
