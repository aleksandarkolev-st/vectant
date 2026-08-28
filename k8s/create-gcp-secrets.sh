#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Synthi IDE — Create GCP Secret Manager Secrets
# ─────────────────────────────────────────────────────────────────────────────
#  Creates empty secrets in GCP Secret Manager. After running this script,
#  add secret values with:
#
#    echo -n 'your-value' | gcloud secrets versions add SECRET_NAME \
#      --data-file=- --project=vectant-proj
#
#  The External Secrets Operator (k8s/external-secrets.yaml) syncs these
#  into the K8s Secret "synthi-secrets" automatically.
#
#  Usage:
#    chmod +x k8s/create-gcp-secrets.sh
#    ./k8s/create-gcp-secrets.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-vectant-proj}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SECRET_MANIFESTS=(
  "${SCRIPT_DIR}/external-secrets.yaml"
  "${SCRIPT_DIR}/overlays/dojo-release-gate/dojo-release-external-secrets.yaml"
)

mapfile -t SECRETS < <(
  awk '
    /^[[:space:]]*remoteRef:[[:space:]]*$/ { in_remote_ref = 1; next }
    in_remote_ref && /^[[:space:]]*key:[[:space:]]*/ {
      value = $0
      sub(/^[[:space:]]*key:[[:space:]]*/, "", value)
      gsub(/["'\''"]/, "", value)
      if (value != "") print value
      in_remote_ref = 0
      next
    }
    /^[^[:space:]-]/ { in_remote_ref = 0 }
  ' "${SECRET_MANIFESTS[@]}" | sort -u
)

if [[ ${#SECRETS[@]} -eq 0 ]]; then
  echo "No Secret Manager remoteRef keys found in ExternalSecret manifests." >&2
  exit 1
fi

echo "=== Creating ${#SECRETS[@]} secrets in GCP Secret Manager ==="
echo "Project: ${PROJECT_ID}"
echo "Source manifests:"
printf "  %s\n" "${SECRET_MANIFESTS[@]}"
echo ""

for secret in "${SECRETS[@]}"; do
  if gcloud secrets describe "${secret}" --project="${PROJECT_ID}" &>/dev/null; then
    echo "  [exists]  ${secret}"
  else
    gcloud secrets create "${secret}" \
      --replication-policy="automatic" \
      --project="${PROJECT_ID}"
    echo "  [created] ${secret}"
  fi
done

echo ""
echo "=== Done ==="
echo ""
echo "Add secret values:"
echo "  echo -n 'VALUE' | gcloud secrets versions add SECRET_NAME --data-file=- --project=${PROJECT_ID}"
echo ""
echo "Example:"
echo "  echo -n 'postgresql://synthi:pass@127.0.0.1:5432/synthi' | \\"
echo "    gcloud secrets versions add synthi-database-url --data-file=- --project=${PROJECT_ID}"
