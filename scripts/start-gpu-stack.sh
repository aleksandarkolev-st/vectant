#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

build=0
pull=0
image="${SYNTHI_WORKER_GPU_IMAGE:-vectant-ade-worker-gpu:local}"

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
    --help|-h)
      cat <<'USAGE'
Usage: scripts/start-gpu-stack.sh [--pull] [--build] [--image IMAGE]

Starts the full Synthi stack with the GPU worker override that matches the
host: NVIDIA uses docker-compose.nvidia.yml; AMD WSL /dev/dxg uses
docker-compose.gpu-amd.yml.
USAGE
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

export SYNTHI_WORKER_GPU_IMAGE="$image"

has_nvidia() {
  command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1
}

has_amd_dxg() {
  [ -e /dev/dxg ]
}

if has_nvidia; then
  override="docker-compose.nvidia.yml"
  vendor="cuda"
elif has_amd_dxg; then
  override="docker-compose.gpu-amd.yml"
  vendor="rocm"
else
  echo "Warning: no NVIDIA GPU or /dev/dxg AMD bridge detected; using AMD override for skip-aware startup." >&2
  override="docker-compose.gpu-amd.yml"
  vendor="auto"
fi

echo "Using GPU override: $override"
echo "Detected vendor: $vendor"
echo "Worker image: $image"
if [ -n "${SYNTHI_GPU_ARCH:-}" ]; then
  echo "GPU arch hint: $SYNTHI_GPU_ARCH"
fi

compose=(docker compose -f docker-compose.yml -f "$override")
services=(redis postgres y-sweet collab-server signaling-server ai-engine ai-gateway frontend worker coturn mcp)

if [ "$pull" -eq 1 ]; then
  "${compose[@]}" pull worker
fi

if [ "$build" -eq 1 ]; then
  "${compose[@]}" build worker
fi

"${compose[@]}" up -d --force-recreate "${services[@]}"
"${compose[@]}" ps

cat <<'NEXT'

Run GPU HMR harness with:
  SYNTHI_GPU_VENDOR=auto SYNTHI_GPU_HMR=1 node mcp/synthi-mcp/scripts/gpu-hmr-test.mjs
NEXT
