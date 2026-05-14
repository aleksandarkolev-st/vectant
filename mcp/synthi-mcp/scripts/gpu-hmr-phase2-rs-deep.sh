#!/usr/bin/env bash
# ============================================================
#  GPU-HMR Phase 2 (Rust) — in-depth deep-test script
# ============================================================
#  Exercises every Phase-2 Rust scaffold under
#  `worker/src/hmr/`:
#
#    gpu_driver_loader      (10 tests — dlopen / dlsym table,
#                            probe path, Send+Sync, partial-load
#                            error labels)
#    gpu_module_manager     (14 tests — load_standby /
#                            resolve_kernels / swap / unload
#                            via a stub GpuDriverSymbolTable)
#    gpu_shadow_arena       (15 tests — register / sync_to /
#                            sync_from / release, dtod direction
#                            correctness, total_bytes accounting)
#    gpu_dirty_bit          (12 tests — mark / clear / clear_all /
#                            forget / iter_dirty / stats)
#    gpu_stream_drain       ( 9 tests — drain_context /
#                            drain_stream, Synced / TimedOut /
#                            DriverError outcomes)
#    gpu_module_adapter     (18 tests — Phase 1 + Phase 2 wiring,
#                            driver_state_label, reload reason
#                            mentions driver state)
#
#  Phase 2 scaffolds are CPU-only path-wise — every driver call
#  goes through a typed symbol table that's filled in by either
#  a real `gpu_driver_loader::try_load` (when libcuda.so.1 is
#  on the host) or a stub table in tests. So this script runs
#  fine in any image with a Rust toolchain, no GPU needed for
#  the test body.
#
#  The driver probe assertion (P2rs.13) deliberately reflects
#  the *host* state: on the RTX 5070 box with the NVIDIA
#  driver installed it expects "loaded"; in a CUDA-toolkit-only
#  container without the driver it expects "unavailable". The
#  harness prints whichever path it took so you can confirm
#  intent at a glance.
#
#  Recommended invocations:
#
#  ── On the RTX 5070 host with the driver bind-mount ──────────
#    docker run --rm --gpus all \
#      -v "$PWD":/workspace -w /workspace \
#      nvidia/cuda:12.8.0-devel-ubuntu24.04 \
#      bash -lc 'apt-get update && apt-get install -y curl build-essential pkg-config libssl-dev \
#                && curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal \
#                && source $HOME/.cargo/env \
#                && bash mcp/synthi-mcp/scripts/gpu-hmr-phase2-rs-deep.sh'
#
#  ── In a no-GPU rust image (driver assertion takes the
#     unavailable path) ──────────────────────────────────────
#    docker run --rm -v "$PWD":/workspace -w /workspace \
#      rust:1.88-bookworm \
#      bash -lc 'apt-get update && apt-get install -y libgstreamer1.0-dev \
#                libgstreamer-plugins-base1.0-dev libx11-dev libxcb1-dev libsdl2-dev \
#                clang libclang-dev llvm-dev protobuf-compiler libprotobuf-dev pkg-config cmake \
#                && bash mcp/synthi-mcp/scripts/gpu-hmr-phase2-rs-deep.sh'
#
#  Env:
#    SYNTHI_REPO_ROOT      repo root (default: pwd)
#    SYNTHI_LOG_DIR        (default: .gpu-hmr-phase2-rs/)
#    SYNTHI_RS_RELEASE     pass --release to cargo (default: 0)
#    SYNTHI_RS_OFFLINE     pass --offline to cargo (default: 0)
#    SYNTHI_SKIP_FEAT_OFF  skip the gpu-hmr=off compile check (default: 0)
#    SYNTHI_EXPECT_DRIVER  override probe expectation:
#                            unset → use whichever the host yields
#                            "loaded" → fail if probe says unavailable
#                            "unavailable" → fail if probe says loaded
# ============================================================

set -u

SYNTHI_REPO_ROOT="${SYNTHI_REPO_ROOT:-$(pwd)}"
SYNTHI_LOG_DIR="${SYNTHI_LOG_DIR:-${SYNTHI_REPO_ROOT}/.gpu-hmr-phase2-rs}"
SYNTHI_RS_RELEASE="${SYNTHI_RS_RELEASE:-0}"
SYNTHI_RS_OFFLINE="${SYNTHI_RS_OFFLINE:-0}"
SYNTHI_SKIP_FEAT_OFF="${SYNTHI_SKIP_FEAT_OFF:-0}"
SYNTHI_EXPECT_DRIVER="${SYNTHI_EXPECT_DRIVER:-}"
WORKER="$SYNTHI_REPO_ROOT/backend/synthi-webrtc-compiler/worker"

mkdir -p "$SYNTHI_LOG_DIR"

CARGO_EXTRA=""
[ "$SYNTHI_RS_RELEASE" = "1" ] && CARGO_EXTRA="$CARGO_EXTRA --release"
[ "$SYNTHI_RS_OFFLINE" = "1" ] && CARGO_EXTRA="$CARGO_EXTRA --offline"

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; BLU=$'\033[36m'; DIM=$'\033[2m'; RST=$'\033[0m'
PASS=0; FAIL=0; SKIP=0; WARN=0
declare -a RESULTS

record() {
  local id="$1" status="$2" detail="${3:-}"
  RESULTS+=("$id|$status|$detail")
  case "$status" in
    pass) PASS=$((PASS+1)); echo "${GRN}[✓]${RST} $id ${DIM}$detail${RST}" ;;
    fail) FAIL=$((FAIL+1)); echo "${RED}[✗]${RST} $id ${DIM}$detail${RST}" ;;
    skip) SKIP=$((SKIP+1)); echo "${DIM}[…]${RST} $id ${DIM}$detail${RST}" ;;
    warn) WARN=$((WARN+1)); echo "${YEL}[!]${RST} $id ${DIM}$detail${RST}" ;;
  esac
}

run_cargo() {
  local id="$1" desc="$2"; shift 2
  local log="$SYNTHI_LOG_DIR/$id.log"
  echo "${BLU}━━ $id ${DIM}— $desc${RST}"
  if ( cd "$WORKER" && cargo "$@" $CARGO_EXTRA ) >"$log" 2>&1; then
    record "$id" pass "$desc"
    return 0
  else
    local code=$?
    record "$id" fail "$desc (rc=$code; tail $log)"
    tail -n 25 "$log" | sed 's/^/    /'
    return $code
  fi
}

# ── P2rs.0  All Phase-2 modules present + registered ───────────
phase2_files_present() {
  local missing=0
  for f in gpu_driver_loader gpu_module_manager gpu_shadow_arena gpu_dirty_bit gpu_stream_drain; do
    if [ ! -f "$WORKER/src/hmr/$f.rs" ]; then
      record "P2rs.0/$f" fail "missing $WORKER/src/hmr/$f.rs"
      missing=$((missing+1))
    fi
    if ! grep -q "pub mod $f" "$WORKER/src/hmr/mod.rs"; then
      record "P2rs.0/$f-mod" fail "$f not registered in hmr/mod.rs"
      missing=$((missing+1))
    fi
  done
  if [ $missing -eq 0 ]; then
    record "P2rs.0" pass "all 5 Phase-2 scaffolds present + registered"
  fi
}

# ── P2rs.1  cargo check --features gpu-hmr (whole worker compiles) ──
phase2_cargo_check() {
  run_cargo "P2rs.1" "cargo check --features gpu-hmr" \
    check --features gpu-hmr --lib
}

# ── P2rs.2  cargo check WITHOUT the feature still compiles ─────────
phase2_cargo_check_feature_off() {
  if [ "$SYNTHI_SKIP_FEAT_OFF" = "1" ]; then
    record "P2rs.2" skip "SYNTHI_SKIP_FEAT_OFF=1"
    return 0
  fi
  run_cargo "P2rs.2" "cargo check (default features — gpu-hmr off)" \
    check --lib
}

# ── P2rs.3 — P2rs.8  Module-level unit tests ───────────────
phase2_module_tests() {
  run_cargo "P2rs.3" "gpu_driver_loader unit tests" \
    test --features gpu-hmr --lib hmr::gpu_driver_loader -- --nocapture

  run_cargo "P2rs.4" "gpu_module_manager unit tests" \
    test --features gpu-hmr --lib hmr::gpu_module_manager -- --nocapture

  run_cargo "P2rs.5" "gpu_shadow_arena unit tests" \
    test --features gpu-hmr --lib hmr::gpu_shadow_arena -- --nocapture

  run_cargo "P2rs.6" "gpu_dirty_bit unit tests" \
    test --features gpu-hmr --lib hmr::gpu_dirty_bit -- --nocapture

  run_cargo "P2rs.7" "gpu_stream_drain unit tests" \
    test --features gpu-hmr --lib hmr::gpu_stream_drain -- --nocapture

  run_cargo "P2rs.8" "gpu_module_adapter Phase 2 wiring tests" \
    test --features gpu-hmr --lib hmr::gpu_module_adapter -- --nocapture
}

# ── P2rs.9  Build artifact present after --features gpu-hmr ────────
phase2_build_artifact() {
  run_cargo "P2rs.9" "cargo build --features gpu-hmr (verify link)" \
    build --features gpu-hmr --lib
}

# ── P2rs.10 Compile-time Send+Sync sanity for every Phase-2 type ──
phase2_send_sync_check() {
  # Each Phase-2 module has its own `..._is_send_and_sync` test.
  # This step runs all six together so a single regression in
  # one type is obvious in the output.
  run_cargo "P2rs.10" "Send+Sync checks for all Phase-2 types" \
    test --features gpu-hmr --lib \
    -- --nocapture \
       hmr::gpu_driver_loader::tests::handle_is_send_and_sync \
       hmr::gpu_module_manager::tests::manager_is_send_and_sync \
       hmr::gpu_shadow_arena::tests::arena_is_send_and_sync \
       hmr::gpu_dirty_bit::tests::tracker_is_send_and_sync \
       hmr::gpu_stream_drain::tests::drain_helpers_are_send_safe \
       hmr::gpu_module_adapter::tests::adapter_is_send_and_sync
}

# ── P2rs.11 Adapter wiring — Phase-2 surfaces ────────────────────
phase2_adapter_wiring() {
  run_cargo "P2rs.11" "adapter driver_state_label + info extras" \
    test --features gpu-hmr --lib \
    -- --nocapture \
       hmr::gpu_module_adapter::tests::driver_state_label_pending_before_initialize \
       hmr::gpu_module_adapter::tests::driver_state_after_initialize_is_loaded_or_unavailable \
       hmr::gpu_module_adapter::tests::info_extra_surfaces_driver_state \
       hmr::gpu_module_adapter::tests::shutdown_drops_driver_handle \
       hmr::gpu_module_adapter::tests::reload_reason_mentions_driver_state
}

# ── P2rs.12 Symbol-table introspection sanity ────────────────────
phase2_symbol_table_pins() {
  # The CUDA driver memory functions use the _v2 suffix; the
  # easiest copy-paste regression is missing that. Pin both
  # vendors in a single step that you can spot in CI output.
  run_cargo "P2rs.12" "driver symbol table is versioned correctly" \
    test --features gpu-hmr --lib \
    -- --nocapture \
       hmr::gpu_driver_loader::tests::cuda_symbol_table_uses_versioned_mem_symbols \
       hmr::gpu_driver_loader::tests::rocm_symbol_table_uses_plain_hip_names \
       hmr::gpu_driver_loader::tests::cuda_symbol_table_first_three_are_init_path \
       hmr::gpu_driver_loader::tests::required_symbol_count_is_eleven_for_both_vendors
}

# ── P2rs.13 Host probe — driver actually present? ────────────────
phase2_host_probe() {
  # Write a tiny throwaway probe binary that calls
  # gpu_driver_loader::probe and prints "loaded" / "unavailable".
  # We can't write a crate-internal example trivially, so reuse
  # cargo test with a print-only test.
  local probe_log="$SYNTHI_LOG_DIR/P2rs.13.probe.log"

  echo "${BLU}━━ P2rs.13 ${DIM}— host driver probe (reflects runtime)${RST}"
  if ( cd "$WORKER" && cargo test --features gpu-hmr --lib $CARGO_EXTRA \
        hmr::gpu_driver_loader::tests::probe_returns_unavailable_on_missing_driver \
        -- --nocapture ) >"$probe_log" 2>&1; then
    # The test itself accepts both outcomes; we now infer which
    # path was taken from worker.log earlier — but the test
    # doesn't print. Instead, ldconfig probe:
    local label="unknown"
    if ldconfig -p 2>/dev/null | grep -q 'libcuda\.so\.1'; then
      label="loaded"
    else
      label="unavailable"
    fi

    if [ -n "$SYNTHI_EXPECT_DRIVER" ] && [ "$label" != "$SYNTHI_EXPECT_DRIVER" ]; then
      record "P2rs.13" fail \
        "driver probe yielded '$label' but SYNTHI_EXPECT_DRIVER='$SYNTHI_EXPECT_DRIVER'"
      return 1
    fi
    record "P2rs.13" pass "host driver: $label"
  else
    record "P2rs.13" fail "probe test failed (tail $probe_log)"
    tail -n 25 "$probe_log" | sed 's/^/    /'
    return 1
  fi
}

# ── P2rs.14 Snapshot tier ↔ Phase-1 envelope check ────────────────
phase2_snapshot_envelope_still_intact() {
  # The Phase-1 envelope tests were the contract that the
  # Phase-2 work shouldn't regress. Re-run them so a stale
  # serde field rename surfaces here, not later.
  run_cargo "P2rs.14" "state_snapshot v2 envelope still roundtrips" \
    test --features gpu-hmr --lib hmr::state_snapshot::v2_tests -- --nocapture
}

# ── P2rs.15 device_snapshot still roundtrips ──────────────────────
phase2_device_snapshot_intact() {
  run_cargo "P2rs.15" "device_snapshot still roundtrips" \
    test --features gpu-hmr --lib hmr::device_snapshot -- --nocapture
}

# ── main ────────────────────────────────────────────────────
echo "${BLU}════════════════════════════════════════${RST}"
echo "${BLU}  GPU-HMR Phase 2 (Rust) deep-test      ${RST}"
echo "${BLU}════════════════════════════════════════${RST}"
echo "  repo            : $SYNTHI_REPO_ROOT"
echo "  worker          : $WORKER"
echo "  log dir         : $SYNTHI_LOG_DIR"
echo "  cargo extras    : ${CARGO_EXTRA:-(none)}"
echo "  skip feat-off   : $SYNTHI_SKIP_FEAT_OFF"
echo "  expect driver   : ${SYNTHI_EXPECT_DRIVER:-(auto)}"
echo ""

if ! command -v cargo >/dev/null 2>&1; then
  record "P2rs.pre" fail "cargo not on PATH — install Rust toolchain first"
  exit 1
fi

phase2_files_present
phase2_cargo_check
phase2_cargo_check_feature_off
phase2_module_tests
phase2_build_artifact
phase2_send_sync_check
phase2_adapter_wiring
phase2_symbol_table_pins
phase2_host_probe
phase2_snapshot_envelope_still_intact
phase2_device_snapshot_intact

echo ""
echo "${BLU}════════════════════════════════════════${RST}"
echo "  Summary"
echo "${BLU}════════════════════════════════════════${RST}"
echo "  ${GRN}pass${RST} $PASS    ${RED}fail${RST} $FAIL    ${YEL}warn${RST} $WARN    ${DIM}skip${RST} $SKIP"
echo ""

{
  printf '{"pass":%d,"fail":%d,"warn":%d,"skip":%d,"results":[\n' "$PASS" "$FAIL" "$WARN" "$SKIP"
  n="${#RESULTS[@]}"
  for i in "${!RESULTS[@]}"; do
    IFS='|' read -r rid rstatus rdetail <<< "${RESULTS[$i]}"
    rdetail_esc="$(printf '%s' "$rdetail" | sed 's/\\/\\\\/g; s/"/\\"/g')"
    if [ $((i+1)) -lt "$n" ]; then sep=","; else sep=""; fi
    printf '  {"id":"%s","status":"%s","detail":"%s"}%s\n' "$rid" "$rstatus" "$rdetail_esc" "$sep"
  done
  printf ']}\n'
} > "$SYNTHI_LOG_DIR/results.json"
echo "  results json    : $SYNTHI_LOG_DIR/results.json"

if [ "$FAIL" -gt 0 ]; then exit 1; fi
exit 0
