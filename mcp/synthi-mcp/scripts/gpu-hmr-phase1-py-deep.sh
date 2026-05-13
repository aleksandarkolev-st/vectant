#!/usr/bin/env bash
# ============================================================
#  GPU-HMR Phase 1 (Python) — in-depth test script
# ============================================================
#  Targets the AI-engine container (ai-backend/ai-engine/Dockerfile,
#  python:3.10-slim). No GPU required — these are CPU-only contract
#  tests for the no-shim healer + kernel splitter.
#
#  Recommended invocation:
#
#    docker run --rm \
#      -v "$PWD":/workspace -w /workspace/ai-backend/ai-engine \
#      python:3.10-slim \
#      bash -lc "pip install -q pytest pydantic && \
#                cd /workspace && \
#                bash mcp/synthi-mcp/scripts/gpu-hmr-phase1-py-deep.sh"
#
#  What it asserts (each row = one assertion):
#    P1py.1   verifier_gpu pytests pass
#    P1py.2   kernel_splitter pytests pass
#    P1py.3   GPU_SPLIT_PROMPT renders {{USER_CODE_BLOCK}}
#    P1py.4   GPU_SPLIT_PROMPT contains all 5 required filename markers
#    P1py.5   GPU_SPLIT_PROMPT contains the no-shim contract clause
#    P1py.6   verifier rejects every name in the SHIM_NAME_MATRIX (matrix
#             coverage — suffixes, prefixes, fuzzy SequenceMatcher)
#    P1py.7   verifier rejects a new `.cu` file in heal output
#    P1py.8   verifier rejects a new `__global__` named like an existing
#             kernel under Tier 2/3
#    P1py.9   verifier accepts a clean in-place patch
#    P1py.10  kernel_splitter parses a realistic synthetic response
#    P1py.11  kernel_splitter parser rejects malformed JSON
#    P1py.12  splitter result contains 5 file keys
#
#  Env:
#    SYNTHI_REPO_ROOT       repo root (default: pwd)
#    SYNTHI_LOG_DIR         (default: .gpu-hmr-phase1-py/)
#    SYNTHI_SKIP_PYTEST     skip the bundled pytests (default: 0)
# ============================================================

set -u

SYNTHI_REPO_ROOT="${SYNTHI_REPO_ROOT:-$(pwd)}"
SYNTHI_LOG_DIR="${SYNTHI_LOG_DIR:-${SYNTHI_REPO_ROOT}/.gpu-hmr-phase1-py}"
SYNTHI_SKIP_PYTEST="${SYNTHI_SKIP_PYTEST:-0}"
ENGINE="$SYNTHI_REPO_ROOT/ai-backend/ai-engine"

mkdir -p "$SYNTHI_LOG_DIR"

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

run_step() {
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

# ── P1py.1  verifier_gpu pytests ────────────────────────────
phase1_pytest_verifier() {
  if [ "$SYNTHI_SKIP_PYTEST" = "1" ]; then record "P1py.1" skip "SYNTHI_SKIP_PYTEST=1"; return 0; fi
  run_step "P1py.1" "verifier_gpu pytests" \
    bash -lc "cd '$ENGINE' && python3 -m pytest tests/test_verifier_gpu.py -v --tb=short"
}

# ── P1py.2  kernel_splitter pytests ─────────────────────────
phase1_pytest_splitter() {
  if [ "$SYNTHI_SKIP_PYTEST" = "1" ]; then record "P1py.2" skip "SYNTHI_SKIP_PYTEST=1"; return 0; fi
  run_step "P1py.2" "kernel_splitter pytests" \
    bash -lc "cd '$ENGINE' && python3 -m pytest tests/test_kernel_splitter.py -v --tb=short"
}

# ── P1py.3 — P1py.5  Prompt template structural checks ──────
phase1_prompt_structure() {
  local out
  out="$(python3 - <<'PY'
import sys
sys.path.insert(0, "ai-backend/ai-engine")
from llm.prompts import GPU_SPLIT_PROMPT

checks = []
checks.append(("placeholder", "{{USER_CODE_BLOCK}}" in GPU_SPLIT_PROMPT))
required_files = ("shared.h", "core.cpp", "gui.cpp", "host_runner.cpp", "device.cu")
checks.append(("five_files", all(f in GPU_SPLIT_PROMPT for f in required_files)))
# No-shim contract clause — at least one of these canonical phrases.
clauses = ("no-shim", "no shim", "no_wrapper_kernel", "no_file_creation")
checks.append(("no_shim_clause", any(c.lower() in GPU_SPLIT_PROMPT.lower() for c in clauses)))
for name, ok in checks:
    print(f"{name}={'ok' if ok else 'fail'}")
PY
)"
  echo "$out" > "$SYNTHI_LOG_DIR/P1py.prompt.log"
  if echo "$out" | grep -q "placeholder=ok"; then
    record "P1py.3" pass "{{USER_CODE_BLOCK}} placeholder present"
  else
    record "P1py.3" fail "GPU_SPLIT_PROMPT missing {{USER_CODE_BLOCK}}"
  fi
  if echo "$out" | grep -q "five_files=ok"; then
    record "P1py.4" pass "all 5 filename markers found (shared.h/core.cpp/gui.cpp/host_runner.cpp/device.cu)"
  else
    record "P1py.4" fail "GPU_SPLIT_PROMPT missing one of shared.h/core.cpp/gui.cpp/host_runner.cpp/device.cu"
  fi
  if echo "$out" | grep -q "no_shim_clause=ok"; then
    record "P1py.5" pass "no-shim contract clause present"
  else
    record "P1py.5" fail "no canonical no-shim clause found in prompt"
  fi
}

# ── P1py.6 — P1py.9  Behavioural verifier checks ────────────
phase1_verifier_behavior() {
  local out
  out="$(python3 - <<'PY' 2>&1
import json, sys
sys.path.insert(0, "ai-backend/ai-engine")
from verifier_gpu import verify_heal_output

# Existing kernels in the project.
existing = ["vec_add", "reduce_sum", "gemm_naive"]
known_files = {"core.cpp", "gui.cpp", "shared.h", "host_runner.cpp", "device.cu"}

# Matrix of shim names that should ALL be rejected.
shim_matrix = [
    "vec_add_safe",        # suffix _safe
    "vec_add_v2",          # suffix _v2
    "vec_add_v3",          # suffix _v3
    "vec_add_fallback",    # suffix _fallback
    "vec_add_patched",     # suffix _patched
    "vec_add_wrapper",     # suffix _wrapper
    "safe_vec_add",        # prefix safe_
    "fixed_vec_add",       # prefix fixed_
    "wrap_vec_add",        # prefix wrap_
    "vec_add_v_two",       # fuzzy backstop — SequenceMatcher > 0.85
]

results = {"matrix": [], "new_file": None, "new_global": None, "clean": None}

EXISTING_DEVICE = (
    "__global__ void vec_add(const float* a, const float* b, float* c, int n) {}\n"
    "__global__ void reduce_sum(const float* x, float* out, int n) {}\n"
    "__global__ void gemm_naive(const float* a, const float* b, float* c, int n) {}\n"
)

# P1py.6 — matrix coverage
for shim in shim_matrix:
    out = verify_heal_output(
        tier="compile_hard",
        project_files=known_files,
        edits=[{
            "module": "device.cu",
            "operation": "edit",
            "content": f"__global__ void {shim}(float* x, int n) {{}}",
        }],
        existing_kernels=existing,
        existing_device_source=EXISTING_DEVICE,
    )
    results["matrix"].append({"shim": shim, "ok": out.ok, "rules": [v.rule for v in out.violations]})

# P1py.7 — new .cu file rejected
out = verify_heal_output(
    tier="compile_hard",
    project_files=known_files,
    edits=[{"module": "device_extra.cu", "operation": "create", "content": ""}],
    existing_kernels=existing,
    existing_device_source=EXISTING_DEVICE,
)
results["new_file"] = {"ok": out.ok, "rules": [v.rule for v in out.violations]}

# P1py.8 — Tier 2/3 signature change without host update rejected
out = verify_heal_output(
    tier="runtime",
    project_files=known_files,
    edits=[{
        "module": "device.cu",
        "operation": "edit",
        "content": "__global__ void gemm_naive(float* a, int n) {}",  # signature changed
    }],
    existing_kernels=existing,
    existing_device_source=EXISTING_DEVICE,
)
results["sig_changed_t3"] = {"ok": out.ok, "rules": [v.rule for v in out.violations]}

# P1py.9 — clean patch accepted (in-place edit, no symbol changes)
out = verify_heal_output(
    tier="compile_hard",
    project_files=known_files,
    edits=[{
        "module": "device.cu",
        "operation": "edit",
        "anchor": "c[i] = a[i] + b[i];",
        "content": "c[i] = a[i] + b[i];",
    }],
    existing_kernels=existing,
    existing_device_source=EXISTING_DEVICE,
)
results["clean"] = {"ok": out.ok, "rules": [v.rule for v in out.violations]}

print(json.dumps(results, indent=2))
PY
)"
  echo "$out" > "$SYNTHI_LOG_DIR/P1py.verifier.json"

  # P1py.6 — every matrix entry must report ok=false
  if python3 -c "
import json
d = json.load(open('$SYNTHI_LOG_DIR/P1py.verifier.json'))
bad = [r for r in d['matrix'] if r['ok']]
import sys
sys.exit(0 if not bad else 1)
print('accepted shims:', bad)
"; then
    record "P1py.6" pass "all shim-name matrix entries rejected (suffixes+prefixes+fuzzy)"
  else
    record "P1py.6" fail "some shim names were accepted — see $SYNTHI_LOG_DIR/P1py.verifier.json"
  fi

  # P1py.7
  if python3 -c "import json; d=json.load(open('$SYNTHI_LOG_DIR/P1py.verifier.json')); import sys; sys.exit(0 if not d['new_file']['ok'] else 1)"; then
    record "P1py.7" pass "new .cu file rejected by rule no_file_creation/no_extra_device_tu"
  else
    record "P1py.7" fail "verifier accepted a new .cu file"
  fi

  # P1py.8
  if python3 -c "import json; d=json.load(open('$SYNTHI_LOG_DIR/P1py.verifier.json')); import sys; sys.exit(0 if not d['sig_changed_t3']['ok'] else 1)"; then
    record "P1py.8" pass "signature change on tier=runtime without host update rejected"
  else
    record "P1py.8" fail "verifier let a tier-3 signature drift through"
  fi

  # P1py.9
  if python3 -c "import json; d=json.load(open('$SYNTHI_LOG_DIR/P1py.verifier.json')); import sys; sys.exit(0 if d['clean']['ok'] else 1)"; then
    record "P1py.9" pass "clean in-place patch accepted"
  else
    record "P1py.9" fail "verifier rejected a legitimate clean patch — see $SYNTHI_LOG_DIR/P1py.verifier.json"
  fi
}

# ── P1py.10 — P1py.12  Splitter parser behaviour ────────────
phase1_splitter_behavior() {
  local out
  out="$(python3 - <<'PY' 2>&1
import json, sys
sys.path.insert(0, "ai-backend/ai-engine")
from agents.kernel_splitter import parse_kernel_split_response, KernelSplitterError

# Synthetic well-formed response (mimics what Gemini would emit).
GOOD = """
<synthi_arch_cache>
# Architecture
This is the vector_add kernel split across 5 files.

<synthi_build_manifest>
{
  "language": "cpp",
  "compiler": "g++",
  "files": ["shared.h", "core.cpp", "gui.cpp", "host_runner.cpp", "device.cu"],
  "gpu": {
    "vendor": "cuda",
    "device_compiler": "nvcc",
    "arch": ["sm_120"],
    "device_flags": ["-O3", "-lineinfo"],
    "runtime_libs": ["cuda"],
    "snapshot_mode": "userspace",
    "fatbin_strategy": "sidecar_module"
  }
}
</synthi_build_manifest>

<synthi_kernel_hashes>
{"vec_add": "deadbeefcafe"}
</synthi_kernel_hashes>

<synthi_launch_graph>
[{"site": "core.cpp:42", "kernel": "vec_add", "stream": "default"}]
</synthi_launch_graph>
</synthi_arch_cache>

==== FILE: shared.h ====
#pragma once
extern "C" __global__ void vec_add(const float*, const float*, float*, int);

==== FILE: core.cpp ====
#include "shared.h"
void run(){}

==== FILE: gui.cpp ====
#include "shared.h"
void render(){}

==== FILE: host_runner.cpp ====
int main(){return 0;}

==== FILE: device.cu ====
#include "shared.h"
extern "C" __global__ void vec_add(const float*, const float*, float*, int){}
"""

# Test 1: clean parse
try:
    parsed = parse_kernel_split_response(GOOD)
    n_files = len(parsed.get("files", {}))
    has_manifest = parsed.get("manifest") is not None
    arch_present = bool(parsed.get("architecture_md", "").strip())
    has_hashes = "vec_add" in parsed.get("kernel_hashes", {})
    has_launch = any("vec_add" == r.get("kernel") for r in parsed.get("launch_graph", []))
    out = {"clean": {"n_files": n_files, "has_manifest": has_manifest, "arch_present": arch_present, "has_hashes": has_hashes, "has_launch": has_launch}}
except Exception as e:
    out = {"clean": {"error": f"{type(e).__name__}: {e}"}}

# Test 2: malformed JSON should fail
try:
    parse_kernel_split_response(GOOD.replace('"vec_add": "deadbeefcafe"', '"vec_add: deadbeefcafe'))
    out["malformed_rejected"] = False
except KernelSplitterError:
    out["malformed_rejected"] = True
except Exception as e:
    out["malformed_rejected"] = f"unexpected: {type(e).__name__}"

print(json.dumps(out, indent=2))
PY
)"
  echo "$out" > "$SYNTHI_LOG_DIR/P1py.splitter.json"

  # P1py.10
  if python3 -c "
import json,sys
d=json.load(open('$SYNTHI_LOG_DIR/P1py.splitter.json'))
c=d.get('clean',{})
ok = c.get('n_files')==5 and c.get('has_manifest') and c.get('arch_present')
sys.exit(0 if ok else 1)
"; then
    record "P1py.10" pass "splitter parsed synthetic response (5 files + manifest + arch)"
  else
    record "P1py.10" fail "splitter parser did not return expected shape — see $SYNTHI_LOG_DIR/P1py.splitter.json"
  fi

  # P1py.11
  if python3 -c "
import json,sys
d=json.load(open('$SYNTHI_LOG_DIR/P1py.splitter.json'))
sys.exit(0 if d.get('malformed_rejected') is True else 1)
"; then
    record "P1py.11" pass "splitter rejects malformed JSON via KernelSplitterError"
  else
    record "P1py.11" fail "splitter did not raise on malformed JSON"
  fi

  # P1py.12 — file count check (separate from P1py.10 for granular reporting)
  if python3 -c "
import json,sys
d=json.load(open('$SYNTHI_LOG_DIR/P1py.splitter.json'))
sys.exit(0 if d.get('clean',{}).get('n_files') == 5 else 1)
"; then
    record "P1py.12" pass "splitter returned exactly 5 file entries"
  else
    record "P1py.12" fail "splitter returned wrong file count"
  fi
}

# ── main ────────────────────────────────────────────────────
echo "${BLU}════════════════════════════════════════${RST}"
echo "${BLU}  GPU-HMR Phase 1 (Python) deep-test    ${RST}"
echo "${BLU}════════════════════════════════════════${RST}"
echo "  repo            : $SYNTHI_REPO_ROOT"
echo "  engine          : $ENGINE"
echo "  log dir         : $SYNTHI_LOG_DIR"
echo "  skip pytest     : $SYNTHI_SKIP_PYTEST"
echo ""

phase1_pytest_verifier
phase1_pytest_splitter
phase1_prompt_structure
phase1_verifier_behavior
phase1_splitter_behavior

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
