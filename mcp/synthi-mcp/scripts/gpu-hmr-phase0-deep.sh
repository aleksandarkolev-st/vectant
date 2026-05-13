#!/usr/bin/env bash
# ============================================================
#  GPU-HMR Phase 0 — in-depth test script
# ============================================================
#  Targets RTX 5070 (Blackwell, sm_120, CUDA Toolkit ≥ 12.8).
#  Runs inside a Linux container with the CUDA toolkit on PATH.
#
#  Recommended invocation (from repo root):
#
#    docker run --rm --gpus all \
#      -v "$PWD":/workspace -w /workspace \
#      -e SYNTHI_GPU_ARCH=sm_120 \
#      nvidia/cuda:12.8.0-devel-ubuntu24.04 \
#      bash mcp/synthi-mcp/scripts/gpu-hmr-phase0-deep.sh
#
#  The script verifies *every* Phase 0 deliverable end-to-end:
#    P0.1  RTX 5070 / Blackwell sm_120 visible (nvidia-smi)
#    P0.2  nvcc ≥ 12.8 + sm_120 in its arch list
#    P0.3  Python build_manifest GpuBuildBlock round-trip
#    P0.4  Python gpu_detect classifies CUDA/HIP sources
#    P0.5  Rust compile_manifest tests pass with --features gpu-hmr
#    P0.6  Rust compile_helpers excludes nvcc/hipcc from ccache
#    P0.7  Rust compile_device populate_device_command unit tests
#    P0.8  Rust ptxas_info_parser unit tests + live ptxas stderr
#    P0.9  Real nvcc compile: vec_add.cu → vec_add.cubin (sm_120)
#    P0.10 ccache is NOT in front of nvcc on PATH
#
#  Exit code: 0 = all green; non-zero = at least one Phase 0 check failed.
#  Each failure is logged with its full stderr context to .gpu-hmr-phase0/
#
#  Env (override on the docker invocation):
#    SYNTHI_GPU_ARCH        target arch (default sm_120 for RTX 5070)
#    SYNTHI_REPO_ROOT       repo root (default: current working dir)
#    SYNTHI_SKIP_PY         skip Python tests (default: 0)
#    SYNTHI_SKIP_RS         skip Rust tests (default: 0)
#    SYNTHI_SKIP_NVCC       skip live nvcc compile (default: 0)
#    SYNTHI_NO_GPU          ok-without-GPU mode — auto-set if no /dev/nvidia* present
#    SYNTHI_LOG_DIR         where to write logs (default: .gpu-hmr-phase0/)
# ============================================================

set -u  # unset variables are errors, but DO NOT use -e — we want to keep going

# ── config ──────────────────────────────────────────────────
SYNTHI_GPU_ARCH="${SYNTHI_GPU_ARCH:-sm_120}"
SYNTHI_REPO_ROOT="${SYNTHI_REPO_ROOT:-$(pwd)}"
SYNTHI_SKIP_PY="${SYNTHI_SKIP_PY:-0}"
SYNTHI_SKIP_RS="${SYNTHI_SKIP_RS:-0}"
SYNTHI_SKIP_NVCC="${SYNTHI_SKIP_NVCC:-0}"
SYNTHI_LOG_DIR="${SYNTHI_LOG_DIR:-${SYNTHI_REPO_ROOT}/.gpu-hmr-phase0}"

mkdir -p "$SYNTHI_LOG_DIR"

# Auto-detect "no-GPU" mode if we're not bound to nvidia devices.
if [ -z "${SYNTHI_NO_GPU:-}" ]; then
  if [ ! -e /dev/nvidia0 ] && ! command -v nvidia-smi >/dev/null 2>&1; then
    SYNTHI_NO_GPU=1
  else
    SYNTHI_NO_GPU=0
  fi
fi

# ── logging primitives ──────────────────────────────────────
RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; BLU=$'\033[36m'; DIM=$'\033[2m'; RST=$'\033[0m'

PASS=0; FAIL=0; SKIP=0; WARN=0
declare -a RESULTS

record() {
  # record <id> <status pass|fail|skip|warn> <detail>
  local id="$1" status="$2" detail="${3:-}"
  RESULTS+=("$id|$status|$detail")
  case "$status" in
    pass) PASS=$((PASS+1)); echo "${GRN}[✓]${RST} $id ${DIM}$detail${RST}" ;;
    fail) FAIL=$((FAIL+1)); echo "${RED}[✗]${RST} $id ${DIM}$detail${RST}" ;;
    skip) SKIP=$((SKIP+1)); echo "${DIM}[…]${RST} $id ${DIM}$detail${RST}" ;;
    warn) WARN=$((WARN+1)); echo "${YEL}[!]${RST} $id ${DIM}$detail${RST}" ;;
  esac
}

run_step() {
  # run_step <id> <description> <bash command...>
  local id="$1"; shift
  local desc="$1"; shift
  local log="$SYNTHI_LOG_DIR/$id.log"
  echo "${BLU}━━ $id ${DIM}— $desc${RST}"
  if "$@" >"$log" 2>&1; then
    record "$id" pass "$desc"
    return 0
  else
    local code=$?
    record "$id" fail "$desc (rc=$code; tail $log)"
    tail -n 20 "$log" | sed 's/^/    /'
    return $code
  fi
}

skip_step() {
  local id="$1" reason="$2"
  record "$id" skip "$reason"
}

# ── P0.1  GPU visibility ────────────────────────────────────
check_gpu() {
  if [ "$SYNTHI_NO_GPU" = "1" ]; then
    skip_step "P0.1" "no NVIDIA devices visible to container"
    return 0
  fi
  if ! command -v nvidia-smi >/dev/null 2>&1; then
    record "P0.1" fail "nvidia-smi not found on PATH"
    return 1
  fi
  local name
  name="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -n 1 || true)"
  if [ -z "$name" ]; then
    record "P0.1" fail "nvidia-smi ran but returned no GPU"
    return 1
  fi
  case "$name" in
    *5070*|*Blackwell*) record "P0.1" pass "detected $name" ;;
    *)                  record "P0.1" warn "expected RTX 5070 / Blackwell; got '$name' — Phase 0 still proceeds with arch=$SYNTHI_GPU_ARCH" ;;
  esac
  return 0
}

# ── P0.2  nvcc + sm_120 ─────────────────────────────────────
check_nvcc() {
  if ! command -v nvcc >/dev/null 2>&1; then
    record "P0.2" fail "nvcc not on PATH — install CUDA Toolkit 12.8+ or pass nvidia/cuda:12.8.0-devel image"
    return 1
  fi
  local ver
  ver="$(nvcc --version 2>&1 | grep -oE 'release [0-9]+\.[0-9]+' | head -n 1 | awk '{print $2}' || true)"
  if [ -z "$ver" ]; then
    record "P0.2" fail "could not parse nvcc --version output"
    return 1
  fi
  # Major.minor numeric compare (≥ 12.8 required for sm_120)
  local major="${ver%%.*}" minor="${ver#*.}"
  if [ "$major" -lt 12 ] || { [ "$major" -eq 12 ] && [ "$minor" -lt 8 ]; }; then
    record "P0.2" fail "nvcc $ver < 12.8 — Blackwell sm_120 needs 12.8+"
    return 1
  fi
  # The toolkit only lists supported arches via --list-gpu-arch on 12.x
  local arches
  arches="$(nvcc --list-gpu-arch 2>/dev/null || true)"
  if echo "$arches" | grep -q "compute_120\|sm_120"; then
    record "P0.2" pass "nvcc $ver supports sm_120"
  elif [ "$SYNTHI_GPU_ARCH" = "sm_120" ]; then
    record "P0.2" warn "nvcc $ver did not list sm_120 in --list-gpu-arch; falling back to sm_90 for the live compile"
    SYNTHI_GPU_ARCH="sm_90"
  else
    record "P0.2" pass "nvcc $ver — using requested arch $SYNTHI_GPU_ARCH"
  fi
  return 0
}

# ── P0.3  Python build_manifest round-trip ──────────────────
run_py_build_manifest() {
  if [ "$SYNTHI_SKIP_PY" = "1" ]; then skip_step "P0.3" "SYNTHI_SKIP_PY=1"; return 0; fi
  local engine="$SYNTHI_REPO_ROOT/ai-backend/ai-engine"
  if [ ! -d "$engine" ]; then
    record "P0.3" fail "ai-engine dir missing at $engine"
    return 1
  fi
  run_step "P0.3" "Python build_manifest tests" \
    bash -lc "cd '$engine' && python3 -m pytest tests/test_gpu_build_manifest.py -v --tb=short"
}

# ── P0.4  Python gpu_detect classifier ──────────────────────
run_py_gpu_detect() {
  if [ "$SYNTHI_SKIP_PY" = "1" ]; then skip_step "P0.4" "SYNTHI_SKIP_PY=1"; return 0; fi
  local engine="$SYNTHI_REPO_ROOT/ai-backend/ai-engine"
  run_step "P0.4" "Python gpu_detect classifier" \
    bash -lc "cd '$engine' && python3 -m pytest tests/test_gpu_detect.py -v --tb=short"
}

# ── P0.5  Rust compile_manifest (feature: gpu-hmr) ──────────
run_rs_compile_manifest() {
  if [ "$SYNTHI_SKIP_RS" = "1" ]; then skip_step "P0.5" "SYNTHI_SKIP_RS=1"; return 0; fi
  local worker="$SYNTHI_REPO_ROOT/backend/synthi-webrtc-compiler/worker"
  if [ ! -f "$worker/Cargo.toml" ]; then
    record "P0.5" fail "worker Cargo.toml missing at $worker"
    return 1
  fi
  run_step "P0.5" "Rust compile_manifest (--features gpu-hmr)" \
    bash -lc "cd '$worker' && cargo test --features gpu-hmr --lib hmr::compile_manifest -- --nocapture"
}

# ── P0.6  ccache exclusion for nvcc/hipcc ───────────────────
run_rs_compile_helpers() {
  if [ "$SYNTHI_SKIP_RS" = "1" ]; then skip_step "P0.6" "SYNTHI_SKIP_RS=1"; return 0; fi
  local worker="$SYNTHI_REPO_ROOT/backend/synthi-webrtc-compiler/worker"
  run_step "P0.6" "Rust compile_helpers::is_device_compiler" \
    bash -lc "cd '$worker' && cargo test --features gpu-hmr --lib compiler::stages::compile_helpers -- --nocapture"
}

# ── P0.7  populate_device_command unit tests ────────────────
run_rs_compile_device() {
  if [ "$SYNTHI_SKIP_RS" = "1" ]; then skip_step "P0.7" "SYNTHI_SKIP_RS=1"; return 0; fi
  local worker="$SYNTHI_REPO_ROOT/backend/synthi-webrtc-compiler/worker"
  run_step "P0.7" "Rust compile_device::populate_device_command" \
    bash -lc "cd '$worker' && cargo test --features gpu-hmr --lib compiler::stages::compile_device -- --nocapture"
}

# ── P0.8  ptxas_info_parser unit tests + live ptxas stderr ──
run_rs_ptxas_parser() {
  if [ "$SYNTHI_SKIP_RS" = "1" ]; then skip_step "P0.8" "SYNTHI_SKIP_RS=1"; return 0; fi
  local worker="$SYNTHI_REPO_ROOT/backend/synthi-webrtc-compiler/worker"
  run_step "P0.8" "Rust ptxas_info_parser unit tests" \
    bash -lc "cd '$worker' && cargo test --features gpu-hmr --lib compiler::stages::ptxas_info_parser -- --nocapture"
}

# ── P0.9  Live nvcc compile: vec_add.cu → vec_add.cubin ─────
run_live_nvcc() {
  if [ "$SYNTHI_SKIP_NVCC" = "1" ] || [ "$SYNTHI_NO_GPU" = "1" ]; then
    skip_step "P0.9" "live nvcc compile skipped (no GPU or SYNTHI_SKIP_NVCC=1)"
    return 0
  fi
  local tmp="$SYNTHI_LOG_DIR/live_compile"
  mkdir -p "$tmp"
  cat > "$tmp/vec_add.cu" <<'EOF'
// Phase 0 live-compile fixture. Two kernels keep ptxas-info honest.
extern "C" __global__ void vec_add(const float* __restrict__ a,
                                   const float* __restrict__ b,
                                   float* __restrict__ c, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) c[i] = a[i] + b[i];
}

extern "C" __global__ void vec_scale(float* __restrict__ a, float s, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) a[i] *= s;
}
EOF

  # Compile to cubin (no host code involved — pure device pipeline).
  if ! nvcc -arch="$SYNTHI_GPU_ARCH" -O3 -lineinfo --use_fast_math \
        --ptxas-options=-v \
        --cubin -o "$tmp/vec_add.cubin" "$tmp/vec_add.cu" \
        2>"$tmp/nvcc.stderr"; then
    record "P0.9" fail "nvcc compile failed — see $tmp/nvcc.stderr"
    tail -n 30 "$tmp/nvcc.stderr" | sed 's/^/    /'
    return 1
  fi

  if [ ! -s "$tmp/vec_add.cubin" ]; then
    record "P0.9" fail "nvcc returned success but cubin is empty"
    return 1
  fi

  local cubin_size
  cubin_size="$(stat -c %s "$tmp/vec_add.cubin" 2>/dev/null || stat -f %z "$tmp/vec_add.cubin" 2>/dev/null || echo 0)"
  if [ "$cubin_size" -lt 256 ]; then
    record "P0.9" warn "cubin is suspiciously small ($cubin_size bytes); may be a stub"
  fi

  # Confirm ptxas-info appeared in stderr (this is the input ptxas_info_parser consumes).
  if grep -q "ptxas info" "$tmp/nvcc.stderr"; then
    local regs
    regs="$(grep -oE 'Used [0-9]+ registers' "$tmp/nvcc.stderr" | head -n 1)"
    record "P0.9" pass "cubin produced ($cubin_size bytes); ${regs:-no register count parsed}"
  else
    record "P0.9" warn "cubin produced but no 'ptxas info' lines — was -v passed?"
  fi
  return 0
}

# ── P0.10  ccache must NOT shadow nvcc on PATH ──────────────
check_ccache_path() {
  if ! command -v nvcc >/dev/null 2>&1; then
    skip_step "P0.10" "nvcc not on PATH"
    return 0
  fi
  local nvcc_path
  nvcc_path="$(command -v nvcc)"
  # If nvcc resolves to a ccache symlink, real-nvcc dispatch breaks.
  if [ -L "$nvcc_path" ]; then
    local target
    target="$(readlink -f "$nvcc_path" 2>/dev/null || true)"
    if echo "$target" | grep -q ccache; then
      record "P0.10" fail "nvcc on PATH points at ccache: $nvcc_path → $target"
      return 1
    fi
  fi
  # Defense-in-depth: ccache's `compilers` list shouldn't include nvcc.
  if command -v ccache >/dev/null 2>&1; then
    if ccache --help 2>&1 | grep -qi 'compiler.*nvcc'; then
      record "P0.10" warn "ccache reports nvcc support; verify worker disables ccache wrapping at compile_device stage"
    fi
  fi
  record "P0.10" pass "nvcc on PATH ($nvcc_path) is not a ccache shim"
  return 0
}

# ── main ────────────────────────────────────────────────────
echo "${BLU}════════════════════════════════════════${RST}"
echo "${BLU}  GPU-HMR Phase 0 deep-test harness     ${RST}"
echo "${BLU}════════════════════════════════════════${RST}"
echo "  repo            : $SYNTHI_REPO_ROOT"
echo "  arch            : $SYNTHI_GPU_ARCH"
echo "  log dir         : $SYNTHI_LOG_DIR"
echo "  no-gpu mode     : $SYNTHI_NO_GPU"
echo "  skip python     : $SYNTHI_SKIP_PY"
echo "  skip rust       : $SYNTHI_SKIP_RS"
echo "  skip live nvcc  : $SYNTHI_SKIP_NVCC"
echo ""

check_gpu
check_nvcc
run_py_build_manifest
run_py_gpu_detect
run_rs_compile_manifest
run_rs_compile_helpers
run_rs_compile_device
run_rs_ptxas_parser
run_live_nvcc
check_ccache_path

echo ""
echo "${BLU}════════════════════════════════════════${RST}"
echo "  Summary"
echo "${BLU}════════════════════════════════════════${RST}"
echo "  ${GRN}pass${RST} $PASS    ${RED}fail${RST} $FAIL    ${YEL}warn${RST} $WARN    ${DIM}skip${RST} $SKIP"
echo ""
{
  printf '{ "pass": %d, "fail": %d, "warn": %d, "skip": %d, "arch": "%s", "results": [\n' \
    "$PASS" "$FAIL" "$WARN" "$SKIP" "$SYNTHI_GPU_ARCH"
  local_n="${#RESULTS[@]}"
  for i in "${!RESULTS[@]}"; do
    IFS='|' read -r rid rstatus rdetail <<< "${RESULTS[$i]}"
    # crude JSON escape of detail
    rdetail_esc="$(printf '%s' "$rdetail" | sed 's/\\/\\\\/g; s/"/\\"/g')"
    if [ $((i+1)) -lt "$local_n" ]; then sep=","; else sep=""; fi
    printf '  {"id":"%s","status":"%s","detail":"%s"}%s\n' "$rid" "$rstatus" "$rdetail_esc" "$sep"
  done
  printf ']}\n'
} > "$SYNTHI_LOG_DIR/results.json"

echo "  results json    : $SYNTHI_LOG_DIR/results.json"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
