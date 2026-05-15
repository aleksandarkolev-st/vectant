#!/usr/bin/env bash
# GPU-HMR Phase 3 Rust deep-test script.
#
# Covers the runtime guardrails from docs/GPU_HMR_ULTRAPLAN.md:
# mixed reload planning, drain timeout fallback, driver checkpoint
# downgrade, runtime watchdog events, and fatal GPU fault recovery.

set -u

SYNTHI_REPO_ROOT="${SYNTHI_REPO_ROOT:-$(pwd)}"
SYNTHI_LOG_DIR="${SYNTHI_LOG_DIR:-${SYNTHI_REPO_ROOT}/.gpu-hmr-phase3-rs}"
SYNTHI_RS_RELEASE="${SYNTHI_RS_RELEASE:-0}"
SYNTHI_RS_OFFLINE="${SYNTHI_RS_OFFLINE:-0}"
SYNTHI_SKIP_FEAT_OFF="${SYNTHI_SKIP_FEAT_OFF:-0}"
WORKER="$SYNTHI_REPO_ROOT/backend/synthi-webrtc-compiler/worker"

mkdir -p "$SYNTHI_LOG_DIR"

CARGO_EXTRA=""
[ "$SYNTHI_RS_RELEASE" = "1" ] && CARGO_EXTRA="$CARGO_EXTRA --release"
[ "$SYNTHI_RS_OFFLINE" = "1" ] && CARGO_EXTRA="$CARGO_EXTRA --offline"

PASS=0
FAIL=0
SKIP=0
WARN=0
declare -a RESULTS

record() {
  local id="$1" status="$2" detail="${3:-}"
  RESULTS+=("$id|$status|$detail")
  case "$status" in
    pass) PASS=$((PASS+1)); echo "[PASS] $id $detail" ;;
    fail) FAIL=$((FAIL+1)); echo "[FAIL] $id $detail" ;;
    skip) SKIP=$((SKIP+1)); echo "[SKIP] $id $detail" ;;
    warn) WARN=$((WARN+1)); echo "[WARN] $id $detail" ;;
  esac
}

run_cargo() {
  local id="$1" desc="$2"; shift 2
  local log="$SYNTHI_LOG_DIR/$id.log"
  echo "== $id: $desc"
  if ( cd "$WORKER" && cargo "$@" $CARGO_EXTRA ) >"$log" 2>&1; then
    record "$id" pass "$desc"
    return 0
  fi
  local code=$?
  record "$id" fail "$desc (rc=$code; tail $log)"
  tail -n 35 "$log" | sed 's/^/    /'
  return "$code"
}

static_marker_check() {
  local id="$1" file="$2" pattern="$3" detail="$4"
  if grep -q "$pattern" "$file"; then
    record "$id" pass "$detail"
  else
    record "$id" fail "missing marker '$pattern' in $file"
    return 1
  fi
}

write_results() {
  {
    printf '{"pass":%d,"fail":%d,"warn":%d,"skip":%d,"results":[\n' "$PASS" "$FAIL" "$WARN" "$SKIP"
    local n="${#RESULTS[@]}"
    local i
    for i in "${!RESULTS[@]}"; do
      IFS='|' read -r rid rstatus rdetail <<< "${RESULTS[$i]}"
      local escaped
      escaped="$(printf '%s' "$rdetail" | sed 's/\\/\\\\/g; s/"/\\"/g')"
      local sep=","
      [ $((i+1)) -eq "$n" ] && sep=""
      printf '  {"id":"%s","status":"%s","detail":"%s"}%s\n' "$rid" "$rstatus" "$escaped" "$sep"
    done
    printf ']}\n'
  } > "$SYNTHI_LOG_DIR/results.json"
}

echo "========================================"
echo "GPU-HMR Phase 3 (Rust) deep-test"
echo "========================================"
echo "repo          : $SYNTHI_REPO_ROOT"
echo "worker        : $WORKER"
echo "log dir       : $SYNTHI_LOG_DIR"
echo "cargo extras  : ${CARGO_EXTRA:-(none)}"
echo ""

if ! command -v cargo >/dev/null 2>&1; then
  record "P3rs.pre" fail "cargo not on PATH"
  write_results
  exit 1
fi

run_cargo "P3rs.1" "cargo check --features gpu-hmr" \
  check --features gpu-hmr --lib

if [ "$SYNTHI_SKIP_FEAT_OFF" = "1" ]; then
  record "P3rs.2" skip "SYNTHI_SKIP_FEAT_OFF=1"
else
  run_cargo "P3rs.2" "cargo check with gpu-hmr off" \
    check --lib
fi

run_cargo "P3rs.3" "gpu_reload_orchestrator runtime policy tests" \
  test --features gpu-hmr --lib hmr::gpu_reload_orchestrator -- --nocapture

run_cargo "P3rs.4" "gpu_runtime_watchdog event tests" \
  test --features gpu-hmr --lib runtime::gpu_runtime_watchdog -- --nocapture

run_cargo "P3rs.5" "device_checkpoint_probe tier selection tests" \
  test --features gpu-hmr --lib hmr::device_checkpoint_probe -- --nocapture

run_cargo "P3rs.6" "gpu_module_adapter reload guardrail tests" \
  test --features gpu-hmr --lib hmr::gpu_module_adapter -- --nocapture

static_marker_check "P3rs.7a" "$WORKER/src/hmr/gpu_reload_orchestrator.rs" \
  "kernel-hang-detected" "drain timeout cold-restart marker is present"

static_marker_check "P3rs.7b" "$WORKER/src/hmr/gpu_reload_orchestrator.rs" \
  "context-invalidated" "fatal runtime fault cold-restart marker is present"

static_marker_check "P3rs.7c" "$WORKER/src/hmr/gpu_reload_orchestrator.rs" \
  "gpu_snapshot_telemetry" "snapshot telemetry marker is present"

static_marker_check "P3rs.7d" "$WORKER/src/hmr/device_checkpoint_probe.rs" \
  "tier=A unavailable; falling back to tier B" "checkpoint downgrade marker is present"

echo ""
echo "========================================"
echo "Summary"
echo "========================================"
echo "pass $PASS  fail $FAIL  warn $WARN  skip $SKIP"
echo "results json: $SYNTHI_LOG_DIR/results.json"

write_results

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
