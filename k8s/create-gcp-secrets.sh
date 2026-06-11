#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Synthi IDE — Create GCP Secret Manager Secrets
# ─────────────────────────────────────────────────────────────────────────────
#  Creates empty secrets in GCP Secret Manager. After running this script,
#  add secret values with:
#
#    echo -n 'your-value' | gcloud secrets versions add SECRET_NAME \
#      --data-file=- --project=overview-synti
#
#  The External Secrets Operator (k8s/external-secrets.yaml) syncs these
#  into the K8s Secret "synthi-secrets" automatically.
#
#  Usage:
#    chmod +x k8s/create-gcp-secrets.sh
#    ./k8s/create-gcp-secrets.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PROJECT_ID="overview-synti"

SECRETS=(
  synthi-database-url
  synthi-postgres-user
  synthi-postgres-password
  synthi-postgres-db
  synthi-auth-secret
  synthi-nextauth-secret
  synthi-google-client-id
  synthi-google-client-secret
  synthi-github-id
  synthi-github-secret
  synthi-gcp-client-email
  synthi-gcp-private-key
  synthi-cloudflare-turn-token-id
  synthi-cloudflare-turn-api-token
  synthi-runtime-id-secret
  synthi-google-ai-api-key
  synthi-openai-api-key
  synthi-ysweet-auth-key
)

echo "=== Creating ${#SECRETS[@]} secrets in GCP Secret Manager ==="
echo "Project: ${PROJECT_ID}"
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
