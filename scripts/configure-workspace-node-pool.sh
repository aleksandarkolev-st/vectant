#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/configure-workspace-node-pool.sh [options]

Configure the GKE workspace runtime node pool.

Options:
  --project ID          GCP project ID. Default: vectant-proj
  --cluster NAME        GKE cluster name. Default: synthi-beta-cluster
  --zone ZONE           GKE cluster zone/location. Default: europe-west10-a
  --node-pool NAME      Workspace node pool name. Default: workspace-pool
  --machine-type TYPE   Workspace node machine type. Default: n2-standard-4
  --min-nodes COUNT     Autoscaling minimum nodes. Default: 0
  --max-nodes COUNT     Autoscaling maximum nodes. Default: 2
  -h, --help            Show this help

Environment:
  GCLOUD_BIN            gcloud executable path. Default: gcloud

Examples:
  scripts/configure-workspace-node-pool.sh
  scripts/configure-workspace-node-pool.sh --machine-type n2-standard-4 --max-nodes 2
EOF
}

PROJECT_ID="vectant-proj"
GKE_CLUSTER="synthi-beta-cluster"
GKE_ZONE="europe-west10-a"
NODE_POOL="workspace-pool"
MACHINE_TYPE="n2-standard-4"
MIN_NODES="0"
MAX_NODES="2"
GCLOUD_BIN="${GCLOUD_BIN:-gcloud}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      PROJECT_ID="${2:?--project requires a value}"
      shift 2
      ;;
    --cluster)
      GKE_CLUSTER="${2:?--cluster requires a value}"
      shift 2
      ;;
    --zone)
      GKE_ZONE="${2:?--zone requires a value}"
      shift 2
      ;;
    --node-pool)
      NODE_POOL="${2:?--node-pool requires a value}"
      shift 2
      ;;
    --machine-type)
      MACHINE_TYPE="${2:?--machine-type requires a value}"
      shift 2
      ;;
    --min-nodes)
      MIN_NODES="${2:?--min-nodes requires a value}"
      shift 2
      ;;
    --max-nodes)
      MAX_NODES="${2:?--max-nodes requires a value}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v "$GCLOUD_BIN" >/dev/null 2>&1; then
  echo "gcloud is required. Set GCLOUD_BIN if it is not on PATH." >&2
  exit 1
fi

echo "Configuring workspace node pool..."
echo "  project:      ${PROJECT_ID}"
echo "  cluster:      ${GKE_CLUSTER}"
echo "  location:     ${GKE_ZONE}"
echo "  node pool:    ${NODE_POOL}"
echo "  machine type: ${MACHINE_TYPE}"
echo "  autoscaling:  ${MIN_NODES}-${MAX_NODES}"

"$GCLOUD_BIN" container node-pools update "$NODE_POOL" \
  --project="$PROJECT_ID" \
  --cluster="$GKE_CLUSTER" \
  --zone="$GKE_ZONE" \
  --machine-type="$MACHINE_TYPE" \
  --enable-autoscaling \
  --min-nodes="$MIN_NODES" \
  --max-nodes="$MAX_NODES"
