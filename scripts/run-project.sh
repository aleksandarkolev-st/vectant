#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

build=0
pull=0
image="${SYNTHI_WORKER_GPU_IMAGE:-}"
validation="none"
slug=""
vendor="${SYNTHI_GPU_VENDOR:-auto}"
arch="${SYNTHI_GPU_ARCH:-}"
arch_source=""
source_manifest="${SYNTHI_GPU_AGENT_SOURCE_MANIFEST_PATH:-${SYNTHI_GPU_AGENT_DIRECT_SOURCE_MANIFEST_PATH:-}}"
source_root="${SYNTHI_GPU_AGENT_SOURCE_ROOT:-${SYNTHI_GPU_AGENT_DIRECT_SOURCE_ROOT:-}}"
source_entry="${SYNTHI_GPU_AGENT_SOURCE_ENTRY_PATH:-${SYNTHI_GPU_AGENT_DIRECT_SOURCE_ENTRY_PATH:-}}"
source_authority="${SYNTHI_GPU_AGENT_SOURCE_AUTHORITY:-${SYNTHI_GPU_AGENT_DIRECT_SOURCE_AUTHORITY:-}}"
source_commit="${SYNTHI_GPU_AGENT_SOURCE_COMMIT:-${SYNTHI_GPU_AGENT_DIRECT_SOURCE_COMMIT:-}}"

usage() {
  cat <<'USAGE'
Usage: scripts/run-project.sh [options]

Starts the Synthi GPU stack, then optionally runs a live GPU-HMR validation.

Options:
  --build                  Build the worker GPU image before starting.
  --pull                   Pull the configured worker GPU image before starting.
  --image IMAGE            Worker GPU image tag to use.
  --vendor auto|cuda|rocm  GPU target for validation scripts. Default: auto.
  --arch ARCH              Override GPU arch hint, e.g. gfx1201, sm_80, sm_120.
  --slug SLUG              Workspace slug for validation.
  --validate NAME          none | agent-split | dynamic | flow | flow-source-first | realistic-raytrace |
                           source-first-visual | source-first-cold-ai-split | vector.
                           Default: none.
  --source-manifest PATH   Source-tree manifest for either source-first validation mode.
  --source-root PATH       Source root for either source-first validation mode.
  --source-entry PATH      Entry path inside --source-root when it is not unambiguous.
  --source-commit OID      Full pinned Git commit for --source-root.
  --source-authority NAME  Source authority for --validate source-first-visual, e.g.
                           direct_local_git_repo_path, user_source_files, workspace_source_files.
  --help, -h               Show this help.

Recommended source-first visual validation:
  scripts/run-project.sh --build --validate flow-source-first

High-fidelity deterministic visual validation:
  scripts/run-project.sh --build --validate realistic-raytrace

Generic arbitrary source-first visual validation:
  scripts/run-project.sh --validate source-first-visual --source-root /path/to/project --source-commit FULL_GIT_OID --source-authority direct_local_git_repo_path

Real-user cold AI split without runtime acceptance claims:
  scripts/run-project.sh --validate source-first-cold-ai-split --source-root /path/to/project --source-commit FULL_GIT_OID --source-authority direct_local_git_repo_path

Use --vendor/--arch only when you want to override auto detection.

After startup:
  Frontend: http://localhost:3000
  Worker logs: docker compose logs -f worker
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --build)
      build=1
      ;;
    --pull)
      pull=1
      ;;
    --image)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--image requires a value" >&2
        exit 2
      fi
      image="$1"
      ;;
    --vendor)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--vendor requires auto, cuda, or rocm" >&2
        exit 2
      fi
      vendor="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
      ;;
    --arch)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--arch requires a value" >&2
        exit 2
      fi
      arch="$1"
      ;;
    --slug)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--slug requires a value" >&2
        exit 2
      fi
      slug="$1"
      ;;
    --validate)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--validate requires a value" >&2
        exit 2
      fi
      validation="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
      ;;
    --source-manifest)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--source-manifest requires a value" >&2
        exit 2
      fi
      source_manifest="$1"
      ;;
    --source-root)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--source-root requires a value" >&2
        exit 2
      fi
      source_root="$1"
      ;;
    --source-entry)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--source-entry requires a value" >&2
        exit 2
      fi
      source_entry="$1"
      ;;
    --source-commit)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--source-commit requires a full Git object id" >&2
        exit 2
      fi
      source_commit="$1"
      ;;
    --source-authority)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--source-authority requires a value" >&2
        exit 2
      fi
      source_authority="$1"
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

case "$vendor" in
  auto|cuda|rocm) ;;
  *)
    echo "--vendor must be auto, cuda, or rocm" >&2
    exit 2
    ;;
esac

case "$validation" in
  none|agent-split|dynamic|flow|flow-source-first|realistic-raytrace|source-first-visual|source-first-cold-ai-split|vector) ;;
  *)
    echo "--validate must be none, agent-split, dynamic, flow, flow-source-first, realistic-raytrace, source-first-visual, source-first-cold-ai-split, or vector" >&2
    exit 2
    ;;
esac

if [[ "$validation" = "source-first-visual" || "$validation" = "source-first-cold-ai-split" ]] \
  && [ -z "$source_manifest" ] && [ -z "$source_root" ]; then
  echo "--validate $validation requires --source-manifest or --source-root" >&2
  exit 2
fi

if [ -n "$source_root" ] && [ -z "$source_manifest" ] && [ -z "$source_commit" ]; then
  echo "--source-root requires --source-commit with a full Git object id" >&2
  exit 2
fi

if [ -n "$source_commit" ] && [ -z "$source_root" ]; then
  echo "--source-commit requires --source-root" >&2
  exit 2
fi

if [ -n "$source_commit" ] && ! [[ "$source_commit" =~ ^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$ ]]; then
  echo "--source-commit must be a full 40- or 64-character Git object id" >&2
  exit 2
fi

if [ -n "$source_manifest" ] && [ -n "$source_commit" ]; then
  echo "--source-commit cannot override --source-manifest" >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required but was not found in PATH" >&2
  exit 1
fi

detect_host_vendor() {
  if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
    printf '%s\n' cuda
    return 0
  fi
  if [ -e /dev/dxg ] || command -v rocminfo >/dev/null 2>&1; then
    printf '%s\n' rocm
    return 0
  fi
  printf '%s\n' auto
}

detect_cuda_arch() {
  if ! command -v nvidia-smi >/dev/null 2>&1; then
    return 1
  fi
  local cap
  cap="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader,nounits 2>/dev/null | awk 'NF { print $1; exit }')"
  cap="${cap//$'\r'/}"
  cap="${cap//[[:space:]]/}"
  if [[ "$cap" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
    printf 'sm_%s\n' "${cap/./}"
    return 0
  fi
  return 1
}

detect_rocm_arch() {
  local gfx
  if command -v rocminfo >/dev/null 2>&1; then
    gfx="$(rocminfo 2>/dev/null | grep -m1 -o 'gfx[0-9][0-9a-z]*' || true)"
    if [ -n "$gfx" ]; then
      printf '%s\n' "$gfx"
      return 0
    fi
  fi
  if command -v rocm_agent_enumerator >/dev/null 2>&1; then
    gfx="$(rocm_agent_enumerator 2>/dev/null | grep -m1 -o 'gfx[0-9][0-9a-z]*' || true)"
    if [ -n "$gfx" ]; then
      printf '%s\n' "$gfx"
      return 0
    fi
  fi
  if command -v powershell.exe >/dev/null 2>&1; then
    local names
    names="$(powershell.exe -NoProfile -Command 'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name' 2>/dev/null | tr -d '\r' || true)"
    case "$names" in
      *"RX 9070"*|*"RX 9060"*)
        printf '%s\n' gfx1201
        return 0
        ;;
    esac
  fi
  return 1
}

auto_detect_arch() {
  local effective_vendor="$vendor"
  if [ "$effective_vendor" = "auto" ]; then
    effective_vendor="$(detect_host_vendor)"
  fi
  case "$effective_vendor" in
    cuda) detect_cuda_arch ;;
    rocm) detect_rocm_arch ;;
    *) return 1 ;;
  esac
}

start_args=()
if [ "$build" -eq 1 ]; then
  start_args+=(--build)
fi
if [ "$pull" -eq 1 ]; then
  start_args+=(--pull)
fi
if [ -n "$image" ]; then
  start_args+=(--image "$image")
fi

if [ -z "$arch" ] || [ "$arch" = "auto" ]; then
  detected_arch="$(auto_detect_arch || true)"
  if [ -n "$detected_arch" ]; then
    arch="$detected_arch"
    arch_source="auto-detected"
  else
    arch=""
    arch_source="auto-unresolved"
  fi
else
  arch_source="override"
fi

if [ -n "$arch" ]; then
  export SYNTHI_GPU_ARCH="$arch"
fi
export SYNTHI_GPU_VENDOR="$vendor"
export SYNTHI_GPU_HMR=1

echo "==> Starting GPU stack"
if [ -n "$arch" ]; then
  echo "==> GPU arch hint: $arch ($arch_source)"
else
  echo "==> GPU arch hint: auto (not resolved before startup)"
fi
scripts/start-gpu-stack.sh "${start_args[@]}"

if [ "$validation" = "none" ]; then
  cat <<'NEXT'

Stack is up.
Frontend: http://localhost:3000
Run a validation later with, for example:
  cd mcp/synthi-mcp
  SYNTHI_GPU_HMR=1 SYNTHI_GPU_VENDOR=auto node scripts/gpu-hmr-agent-split-workspace-test.mjs
NEXT
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required for --validate but was not found in PATH" >&2
  exit 1
fi

if [ -z "$slug" ]; then
  ts="$(date +%Y%m%d%H%M%S)"
  case "$validation" in
    agent-split) slug="gpu-agent-split-${ts}" ;;
    dynamic) slug="gpu-dynamic-${ts}" ;;
    flow) slug="gpu-flow-${ts}" ;;
    flow-source-first) slug="gpu-flow-source-first-${ts}" ;;
    realistic-raytrace) slug="gpu-realistic-raytrace-${ts}" ;;
    source-first-visual) slug="gpu-source-first-visual-${ts}" ;;
    source-first-cold-ai-split) slug="gpu-source-first-cold-ai-split-${ts}" ;;
    vector) slug="gpu-vector-${ts}" ;;
  esac
fi

export SLUG="$slug"

echo
echo "==> Running validation: $validation"
echo "    slug: $SLUG"
echo "    vendor: $SYNTHI_GPU_VENDOR"
if [ -n "${SYNTHI_GPU_ARCH:-}" ]; then
  echo "    arch: $SYNTHI_GPU_ARCH"
fi
if [[ "$validation" = "source-first-visual" || "$validation" = "source-first-cold-ai-split" ]]; then
  if [ -n "$source_manifest" ]; then
    echo "    source manifest: $source_manifest"
  fi
  if [ -n "$source_root" ]; then
    echo "    source root: $source_root"
  fi
  if [ -n "$source_entry" ]; then
    echo "    source entry: $source_entry"
  fi
  if [ -n "$source_authority" ]; then
    echo "    source authority: $source_authority"
  fi
  if [ -n "$source_commit" ]; then
    echo "    source commit: $source_commit"
  fi
fi

cd "$repo_root/mcp/synthi-mcp"

case "$validation" in
  agent-split)
    node scripts/gpu-hmr-agent-split-workspace-test.mjs
    ;;
  dynamic)
    node scripts/gpu-hmr-dynamic-workspace-test.mjs
    ;;
  flow)
    export SYNTHI_GPU_HMR_FIXTURE=flow
    export ONLY_PHASES=FLOW
    node scripts/gpu-hmr-test.mjs
    ;;
  flow-source-first)
    node scripts/gpu-hmr-source-first-visual-proof.mjs --fixture flow
    ;;
  realistic-raytrace)
    node scripts/gpu-hmr-source-first-visual-proof.mjs --profile scripts/profiles/agent-realistic-raytrace-scene.json
    ;;
  source-first-visual|source-first-cold-ai-split)
    source_first_args=()
    if [ -n "$source_manifest" ]; then
      source_first_args+=(--source-manifest "$source_manifest")
    fi
    if [ -n "$source_root" ]; then
      source_first_args+=(--source-root "$source_root")
    fi
    if [ -n "$source_entry" ]; then
      source_first_args+=(--source-entry "$source_entry")
    fi
    if [ -n "$source_authority" ]; then
      source_first_args+=(--source-authority "$source_authority")
    fi
    if [ -n "$source_commit" ]; then
      source_first_args+=(--source-commit "$source_commit")
    fi
    if [ "$validation" = "source-first-cold-ai-split" ]; then
      source_first_args+=(--cold-ai-split-only)
    fi
    node scripts/gpu-hmr-source-first-visual-proof.mjs "${source_first_args[@]}"
    ;;
  vector)
    export SYNTHI_GPU_HMR_FIXTURE=vector
    export ONLY_PHASES=P0,P1,P2
    node scripts/gpu-hmr-test.mjs
    ;;
esac

cat <<NEXT

Validation complete.
Workspace: http://localhost:3000/workspace/$SLUG
Worker logs: cd "$repo_root" && docker compose logs -f worker
NEXT
