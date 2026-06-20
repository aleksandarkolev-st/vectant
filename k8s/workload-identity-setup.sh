#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Synthi IDE — Workload Identity Setup
# ─────────────────────────────────────────────────────────────────────────────
#  Creates GCP service accounts and binds them to K8s service accounts via
#  Workload Identity. Run once per cluster setup.
#
#  Prerequisites:
#    - GKE cluster with Workload Identity enabled
#    - gcloud CLI authenticated with Owner/Editor role
#
#  Usage:
#    chmod +x k8s/workload-identity-setup.sh
#    ./k8s/workload-identity-setup.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PROJECT_ID="vectant-proj"
K8S_NAMESPACE="synthi"
WORKSPACE_BUCKET="vectant-synthi-cloud-storage"
KMS_LOCATION="${KMS_LOCATION:-europe-west10}"
DOJO_KMS_KEYRING="${DOJO_KMS_KEYRING:-synthi-dojo}"
DOJO_KMS_KEY="${DOJO_KMS_KEY:-dojo-proof-signing}"

echo "=== Synthi IDE — Workload Identity Setup ==="
echo "Project: ${PROJECT_ID}"
echo ""

# ── 1. Create GCP Service Accounts ────────────────────────────────────────

echo "Creating GCP service accounts..."

# SA for services that need GCS access (collab-server, y-sweet, worker)
gcloud iam service-accounts create synthi-gcs-sa \
  --display-name="Synthi GCS Access" \
  --project="${PROJECT_ID}" 2>/dev/null || echo "  synthi-gcs-sa already exists"

# SA for External Secrets Operator (Secret Manager access)
gcloud iam service-accounts create synthi-eso-sa \
  --display-name="Synthi External Secrets" \
  --project="${PROJECT_ID}" 2>/dev/null || echo "  synthi-eso-sa already exists"

# SA for Agent Dojo MCP host managed signing and hosted release checks
gcloud iam service-accounts create synthi-dojo-mcp-sa \
  --display-name="Synthi Dojo MCP Host" \
  --project="${PROJECT_ID}" 2>/dev/null || echo "  synthi-dojo-mcp-sa already exists"

echo ""

# ── 2. Grant IAM Roles ────────────────────────────────────────────────────

echo "Granting IAM roles..."

# GCS SA: Storage Object Admin on the workspace bucket
gsutil iam ch \
  "serviceAccount:synthi-gcs-sa@${PROJECT_ID}.iam.gserviceaccount.com:roles/storage.objectAdmin" \
  "gs://${WORKSPACE_BUCKET}"

echo "  synthi-gcs-sa → roles/storage.objectAdmin on gs://${WORKSPACE_BUCKET}"

# ESO SA: Secret Manager Secret Accessor
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:synthi-eso-sa@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" \
  --condition=None \
  --quiet

echo "  synthi-eso-sa → roles/secretmanager.secretAccessor"

# Dojo MCP host: sign with the managed proof-signing key and read release secrets.
gcloud kms keys add-iam-policy-binding "${DOJO_KMS_KEY}" \
  --location="${KMS_LOCATION}" \
  --keyring="${DOJO_KMS_KEYRING}" \
  --member="serviceAccount:synthi-dojo-mcp-sa@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/cloudkms.signerVerifier" \
  --quiet

echo "  synthi-dojo-mcp-sa → roles/cloudkms.signerVerifier on ${DOJO_KMS_KEYRING}/${DOJO_KMS_KEY}"
echo ""

# ── 3. Workload Identity Bindings ─────────────────────────────────────────
#  Bind K8s ServiceAccounts to GCP ServiceAccounts so pods can authenticate
#  as the GCP SA without static JSON keys.

echo "Creating Workload Identity bindings..."

# K8s service accounts annotated with synthi-gcs-sa.
for KSA in collab-server-sa frontend-sa y-sweet-sa workspace-runtime-sa; do
  gcloud iam service-accounts add-iam-policy-binding \
    "synthi-gcs-sa@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role="roles/iam.workloadIdentityUser" \
    --member="serviceAccount:${PROJECT_ID}.svc.id.goog[${K8S_NAMESPACE}/${KSA}]" \
    --quiet
  echo "  ${KSA} → synthi-gcs-sa"
done

# eso-service-account (K8s) → synthi-eso-sa (GCP)
gcloud iam service-accounts add-iam-policy-binding \
  "synthi-eso-sa@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:${PROJECT_ID}.svc.id.goog[${K8S_NAMESPACE}/eso-service-account]" \
  --quiet

echo "  eso-service-account → synthi-eso-sa"

# dojo-mcp-host-sa (K8s) → synthi-dojo-mcp-sa (GCP)
gcloud iam service-accounts add-iam-policy-binding \
  "synthi-dojo-mcp-sa@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:${PROJECT_ID}.svc.id.goog[${K8S_NAMESPACE}/dojo-mcp-host-sa]" \
  --quiet

echo "  dojo-mcp-host-sa → synthi-dojo-mcp-sa"
echo ""

# ── 4. Verify ────────────────────────────────────────────────────────────

echo "=== Verification ==="
echo "GCP service accounts:"
gcloud iam service-accounts list --project="${PROJECT_ID}" \
  --filter="email ~ synthi" --format="table(email, displayName)"
echo ""
echo "Done. Next steps:"
echo "  1. Apply K8s manifests:  kubectl apply -k k8s/"
echo "  2. Verify WI:  kubectl run test --rm -i --image=google/cloud-sdk:slim \\"
echo "       --serviceaccount=collab-server-sa -n synthi -- gcloud auth list"
